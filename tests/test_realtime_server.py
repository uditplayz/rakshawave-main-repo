"""Two virtual phones talk through the realtime relay (server/app.py)."""
import pytest
from fastapi.testclient import TestClient

from server import app as srv


@pytest.fixture()
def client():
    srv.clients.clear()
    srv.hazards.clear()
    srv.REPORT_COOLDOWN_S = 0
    with TestClient(srv.app) as c:
        yield c


def _join(c, did, unit):
    ws = c.websocket_connect("/ws")
    s = ws.__enter__()
    s.send_json({"t": "hello", "id": did, "unit": unit, "unitId": "#RL-" + did, "pos": 0})
    assert s.receive_json()["t"] == "welcome"
    return ws, s


def _next(s, kind):
    for _ in range(20):
        m = s.receive_json()
        if m["t"] == kind:
            return m
    raise AssertionError(f"no {kind} message")


def test_report_reaches_peer_and_is_verified(client):
    wa, a = _join(client, "A", "RW-Unit 07")
    wb, b = _join(client, "B", "RW-Unit 12")
    a.send_json({"t": "report", "type": "fog"})
    got = _next(b, "hazard")["h"]
    assert got["type"] == "fog" and got["state"] == "verifying" and got["reporter"] == "A"
    b.send_json({"t": "ack", "id": got["id"], "ok": True})
    upd = _next(a, "update")["h"]
    assert upd["state"] == "verified" and upd["c"] == 2 and upd["trust"] >= 80
    wa.__exit__(None, None, None)
    wb.__exit__(None, None, None)


def test_disputed_report_is_rejected(client):
    wa, a = _join(client, "A", "RW-Unit 07")
    wb, b = _join(client, "B", "RW-Unit 12")
    a.send_json({"t": "report", "type": "accident"})
    hid = _next(b, "hazard")["h"]["id"]
    b.send_json({"t": "ack", "id": hid, "ok": False})
    assert _next(a, "update")["h"]["state"] == "rejected"
    assert hid not in srv.hazards
    wa.__exit__(None, None, None)
    wb.__exit__(None, None, None)


def test_unknown_hazard_type_ignored_and_health(client):
    wa, a = _join(client, "A", "RW-Unit 07")
    a.send_json({"t": "report", "type": "meteor"})
    a.send_json({"t": "ping"})
    assert _next(a, "pong")["t"] == "pong"
    assert not srv.hazards
    assert client.get("/api/health").json()["devices"] == 1
    wa.__exit__(None, None, None)
