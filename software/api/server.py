"""
RakshaWave backend API.

Runs the fleet simulator on a background loop and exposes it over:
  * REST  — GET /api/fleet, /api/events, /api/clusters, /api/emergencies
  * WS    — /ws/fleet  — pushes a fresh snapshot every tick for the
            live dashboard (ui/index.html)

Run with:
    uvicorn software.api.server:app --reload --port 8000
or:
    python -m software.api.server
"""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from software.config import settings
from software.simulator.simulate_fleet import FleetSimulator

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("rakshawave.api")

TICK_INTERVAL_S = 1.0
UI_DIR = Path(__file__).resolve().parents[2] / "ui"

simulator = FleetSimulator()
_ws_clients: set[WebSocket] = set()


async def _simulation_loop():
    while True:
        simulator.tick()
        snapshot = simulator.snapshot()
        dead = set()
        for ws in _ws_clients:
            try:
                await ws.send_json(snapshot)
            except Exception:
                dead.add(ws)
        _ws_clients.difference_update(dead)
        await asyncio.sleep(TICK_INTERVAL_S)


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(_simulation_loop())
    logger.info("RakshaWave fleet simulator started (%d vehicles).", len(simulator.vehicle_ids))
    yield
    task.cancel()


app = FastAPI(title="RakshaWave — Smart Road Sentinel API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/api/health")
def health():
    return {"status": "ok", "vehicle_count": len(simulator.vehicle_ids)}


@app.get("/api/fleet")
def fleet_snapshot():
    return simulator.snapshot()


@app.get("/api/events")
def recent_events():
    return [e.to_dict() for e in simulator.recent_events[-50:]]


@app.get("/api/clusters")
def clusters():
    return [c.to_dict() for c in simulator.verifier.active_clusters()]


@app.get("/api/emergencies")
def emergencies():
    return [e.to_dict() for e in simulator.emergencies]


@app.websocket("/ws/fleet")
async def ws_fleet(websocket: WebSocket):
    await websocket.accept()
    _ws_clients.add(websocket)
    try:
        await websocket.send_json(simulator.snapshot())
        while True:
            # Keep the connection open; client doesn't need to send
            # anything, but we drain to detect disconnects promptly.
            await websocket.receive_text()
    except WebSocketDisconnect:
        pass
    finally:
        _ws_clients.discard(websocket)


@app.get("/")
def index():
    return FileResponse(UI_DIR / "index.html")


if UI_DIR.exists():
    app.mount("/ui", StaticFiles(directory=str(UI_DIR), html=True), name="ui")


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run(
        "software.api.server:app",
        host=settings.network.api_host,
        port=settings.network.api_port,
        reload=False,
    )
