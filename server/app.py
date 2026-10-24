"""
RakshaWave realtime relay + PWA host.

Every phone that opens the site connects to ``/ws``.  When one phone reports a
hazard the server broadcasts it to all the others, the other phones validate
and confirm it, and once a quorum of nodes agrees the hazard is marked
*verified* and everyone is notified.  No database - state lives in memory.

Run locally:
    uvicorn server.app:app --host 0.0.0.0 --port 8000
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

log = logging.getLogger("rakshawave.realtime")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

UI_DIR = Path(__file__).resolve().parents[1] / "ui"
HAZARD_TTL_S = 15 * 60
MAX_MSG_BYTES = 4096
REPORT_COOLDOWN_S = 1.5

# How far ahead of the lead vehicle (km) a freshly reported hazard is placed.
AHEAD_KM = {"accident": 0.4, "fog": 2.7, "pothole": 4.1, "blocked": 1.6, "roadwork": 3.1, "landslide": 2.2}
TRUST_BY_NODES = {1: 38, 2: 81, 3: 94}
MAX_QUORUM = 3


class Client:
    def __init__(self, ws: WebSocket, device_id: str, unit: str, unit_id: str):
        self.ws, self.id, self.unit, self.unit_id = ws, device_id, unit, unit_id
        self.pos, self.speed = 0.0, 0.0
        self.last_report = 0.0

    def public(self) -> dict:
        return {"id": self.id, "unit": self.unit, "unitId": self.unit_id, "pos": self.pos, "speed": self.speed}


clients: dict[str, Client] = {}
hazards: dict[str, dict] = {}


def quorum() -> int:
    """Nodes that must agree: 3 when available, never fewer than 2."""
    return min(MAX_QUORUM, max(2, len(clients)))


def trust_for(h: dict) -> int:
    n = len(h["confirms"])
    return TRUST_BY_NODES.get(n, 97 if n > 3 else 38)


def public(h: dict) -> dict:
    return {
        "id": h["id"], "type": h["type"], "pos": h["pos"], "state": h["state"], "trust": h["trust"],
        "src": h["src"], "reporter": h["reporter"], "hops": h["hops"], "at": h["at"],
        "nodes": h["nodes"], "c": len(h["confirms"]), "q": quorum(),
    }


async def send(c: Client, msg: dict) -> None:
    try:
        await c.ws.send_text(json.dumps(msg))
    except Exception:
        pass


async def broadcast(msg: dict) -> None:
    await asyncio.gather(*(send(c, msg) for c in list(clients.values())))


async def broadcast_peers() -> None:
    await broadcast({"t": "peers", "list": [c.public() for c in clients.values()]})


def evaluate(h: dict) -> bool:
    """Re-check a hazard's state. Returns True if it changed."""
    if h["state"] != "verifying":
        return False
    before = (h["state"], h["trust"], len(h["confirms"]))
    h["trust"] = trust_for(h)
    if len(h["disputes"]) >= len(h["confirms"]):
        h["state"], h["trust"] = "rejected", 22
    elif len(h["confirms"]) >= quorum():
        h["state"] = "verified"
    return before != (h["state"], h["trust"], len(h["confirms"]))


async def handle(c: Client, m: dict) -> None:
    t = m.get("t")
    if t == "pos":
        c.pos, c.speed = float(m.get("pos", 0)), float(m.get("speed", 0))
    elif t == "ping":
        await send(c, {"t": "pong"})
    elif t == "report":
        kind = m.get("type")
        now = time.time()
        if kind not in AHEAD_KM or now - c.last_report < REPORT_COOLDOWN_S:
            return
        c.last_report = now
        lead = max(x.pos for x in clients.values())
        hid = uuid.uuid4().hex[:8]
        h = {
            "id": hid, "type": kind, "pos": round(lead + AHEAD_KM[kind], 3), "state": "verifying",
            "trust": TRUST_BY_NODES[1], "src": c.unit_id, "reporter": c.id, "hops": 1 + (len(clients) > 2),
            "at": int(now * 1000), "nodes": [[c.unit_id, "Reported"]], "confirms": {c.id}, "disputes": set(),
            "created": now,
        }
        evaluate(h)
        hazards[hid] = h
        log.info("report %s from %s (%d devices)", kind, c.unit, len(clients))
        await broadcast({"t": "hazard", "h": public(h)})
    elif t == "ack":
        h = hazards.get(m.get("id"))
        if not h or h["state"] != "verifying" or c.id in h["confirms"] or c.id in h["disputes"]:
            return
        if m.get("ok", True):
            h["confirms"].add(c.id)
            h["nodes"].append([c.unit_id, "Confirmed"])
        else:
            h["disputes"].add(c.id)
        evaluate(h)
        await broadcast({"t": "update", "h": public(h)})
        if h["state"] == "rejected":
            hazards.pop(h["id"], None)


async def reevaluate_all() -> None:
    for h in list(hazards.values()):
        if evaluate(h):
            await broadcast({"t": "update", "h": public(h)})


async def reaper() -> None:
    while True:
        await asyncio.sleep(20)
        cutoff = time.time() - HAZARD_TTL_S
        for hid in [k for k, h in hazards.items() if h["created"] < cutoff]:
            hazards.pop(hid, None)
            await broadcast({"t": "gone", "id": hid})
        await broadcast_peers()


@asynccontextmanager
async def lifespan(_: FastAPI):
    task = asyncio.create_task(reaper())
    yield
    task.cancel()


app = FastAPI(title="RakshaWave realtime", lifespan=lifespan)


@app.get("/api/health")
def health():
    return {"status": "ok", "devices": len(clients), "hazards": len(hazards)}


@app.websocket("/ws")
async def ws_endpoint(ws: WebSocket):
    await ws.accept()
    client: Client | None = None
    try:
        raw = await asyncio.wait_for(ws.receive_text(), timeout=10)
        hello = json.loads(raw)
        if hello.get("t") != "hello":
            await ws.close()
            return
        did = str(hello.get("id", ""))[:40] or uuid.uuid4().hex
        old = clients.pop(did, None)
        if old:  # same device reconnecting / second tab
            try:
                await old.ws.close()
            except Exception:
                pass
        client = Client(ws, did, str(hello.get("unit", "RW-Unit"))[:24], str(hello.get("unitId", "#RL-0000"))[:12])
        client.pos = float(hello.get("pos", 0))
        clients[did] = client
        log.info("+ %s (%d devices)", client.unit, len(clients))
        await send(client, {"t": "welcome", "hazards": [public(h) for h in hazards.values()], "peers": [c.public() for c in clients.values()]})
        await broadcast_peers()
        while True:
            raw = await ws.receive_text()
            if len(raw) > MAX_MSG_BYTES:
                continue
            try:
                await handle(client, json.loads(raw))
            except (ValueError, TypeError, KeyError):
                continue
    except (WebSocketDisconnect, asyncio.TimeoutError):
        pass
    except Exception:  # noqa: BLE001 - never let one socket kill the server
        log.exception("socket error")
    finally:
        if client and clients.get(client.id) is client:
            clients.pop(client.id, None)
            log.info("- %s (%d devices)", client.unit, len(clients))
            await broadcast_peers()
            await reevaluate_all()


@app.get("/sw.js", include_in_schema=False)
def service_worker():
    return FileResponse(UI_DIR / "sw.js", media_type="application/javascript", headers={"Cache-Control": "no-cache"})


@app.get("/manifest.webmanifest", include_in_schema=False)
def manifest():
    return FileResponse(UI_DIR / "manifest.webmanifest", media_type="application/manifest+json")


app.mount("/", StaticFiles(directory=str(UI_DIR), html=True), name="ui")
