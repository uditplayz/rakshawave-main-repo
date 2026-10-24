"""
MCP bridge: exposes the RakshaWave Raspberry Pi stack (OpenCV hazard
detector, sensor fusion, LoRa node, mesh, cluster verifier, emergency
responder) to Claude Code as callable tools, so the Wokwi ESP32-C3 twin and
the Python stack can be driven end to end.

Register with:
    claude mcp add -s project rakshawave-hil -- python -m software.mcp_bridge

Tools
    run_vision_detector            camera stage (real image or synthetic frame)
    fuse_and_ingest_esp32_serial   ESP32 JSON line + vision -> fusion -> mesh
    simulate_corroborating_peer    second vehicle reporting the same hazard
    get_mesh_state                 packets, hops, clusters, EMERGENCY broadcasts
    add_relay_nodes / reset_bench  helpers for multi-hop and repeatable runs

The air interface is a `RadioMesh`: the in-process `MeshNetwork` bus plus a
433 MHz range / packet-loss model (Haversine distance, 0.38 s SF7 airtime
per transmission).
"""

from __future__ import annotations

import json
import math
import random
import time
from dataclasses import replace
from pathlib import Path
from typing import Any, Dict, List, Optional

import cv2
import numpy as np

from software.core.emergency import EmergencyEvent, EmergencyResponder
from software.sensors.fusion import SensorFusion
from software.sensors.gps import GPSFix
from software.sensors.imu import IMUSample
from software.vision.hazard_detector import HazardDetection, HazardDetector, HazardType
from software.wimesh.lora_node import LoRaNode
from software.wimesh.mesh_network import HazardClusterVerifier, MeshNetwork, _haversine_m
from software.wimesh.protocol import HazardAlertPacket, PacketType

# ---- radio model ------------------------------------------------------------
RADIO_RANGE_M = 1500.0       # 433 MHz LoRa, SF7/125 kHz, roadside line of sight
AIRTIME_S = 0.38             # per transmission (SF7 frame used in the pitch deck)
LOSS_FLOOR = 0.02            # packet loss next to the transmitter
LOSS_AT_EDGE = 0.50          # extra loss at the edge of the range (cubic ramp)
RNG_SEED = 433
COORDINATOR_ID = "MESH-COORDINATOR"
# Same rule software/simulator/simulate_fleet.py uses to hint "IMU impact".
IMPACT_HINT_CONFIDENCE = 0.8
METERS_PER_DEG_LAT = 111_320.0


class RadioMesh(MeshNetwork):
    """MeshNetwork with positions, a range/loss model and a tx log."""

    def __init__(self, range_m: float = RADIO_RANGE_M, seed: int = RNG_SEED):
        super().__init__()
        self.range_m = range_m
        self.positions: Dict[str, tuple[float, float]] = {}
        self._rng = random.Random(seed)
        self.tx_log: List[dict] = []

    def loss_probability(self, distance_m: float) -> float:
        if distance_m > self.range_m:
            return 1.0
        return LOSS_FLOOR + LOSS_AT_EDGE * (distance_m / self.range_m) ** 3

    def publish(self, sender_id: str, packet: HazardAlertPacket) -> None:
        self.packet_log.append(packet)
        entry = {
            "seq": len(self.tx_log) + 1,
            "sender": sender_id,
            "packet_id": packet.packet_id,
            "type": PacketType(packet.packet_type).value,
            "hop": packet.hop_count,
            "airtime_s": AIRTIME_S,
            "delivered": [],
            "dropped": [],
        }
        self.tx_log.append(entry)
        src = self.positions.get(sender_id)
        for vehicle_id, callback in list(self._subscribers.items()):
            if vehicle_id == sender_id:
                continue
            dst = self.positions.get(vehicle_id)
            if src is not None and dst is not None:
                dist = _haversine_m(src[0], src[1], dst[0], dst[1])
                if self._rng.random() < self.loss_probability(dist):
                    why = "out_of_range" if dist > self.range_m else "packet_loss"
                    entry["dropped"].append({"to": vehicle_id, "distance_m": round(dist, 1), "why": why})
                    continue
                entry["delivered"].append({"to": vehicle_id, "distance_m": round(dist, 1)})
            else:
                entry["delivered"].append({"to": vehicle_id, "distance_m": None})
            callback(packet)


class Bench:
    """All mutable state for one HIL session."""

    def __init__(self):
        self.mesh = RadioMesh()
        self.nodes: Dict[str, LoRaNode] = {}
        self.verifier = HazardClusterVerifier()
        self.responder = EmergencyResponder(broadcast_fn=self._coordinator_broadcast)
        self.emergencies: List[EmergencyEvent] = []
        self.responder.on_emergency(self.emergencies.append)
        self.last_vision: Optional[HazardDetection] = None
        self.fusion_events: List[dict] = []
        self.mesh.subscribe(COORDINATOR_ID, self._coordinator_receive)

    def _coordinator_broadcast(self, packet: HazardAlertPacket) -> None:
        self.mesh.publish(COORDINATOR_ID, packet)

    def _coordinator_receive(self, packet: HazardAlertPacket) -> None:
        if packet.vehicle_id == COORDINATOR_ID:
            return
        if PacketType(packet.packet_type) not in (PacketType.HAZARD_ALERT, PacketType.CORROBORATION):
            return
        cluster = self.verifier.ingest(packet)
        impact_hint = packet.confidence >= IMPACT_HINT_CONFIDENCE
        self.responder.evaluate(cluster, impact_confirmed=impact_hint)

    def ensure_coordinator(self, lat: float, lon: float) -> None:
        # Roadside coordinator ~100 m up the road from the first hazard.
        self.mesh.positions.setdefault(COORDINATOR_ID, (lat + 100.0 / METERS_PER_DEG_LAT, lon))

    def node(self, vehicle_id: str, lat: float, lon: float) -> LoRaNode:
        self.mesh.positions[vehicle_id] = (lat, lon)
        if vehicle_id not in self.nodes:
            node = LoRaNode(vehicle_id=vehicle_id, mesh_bus=self.mesh)
            node.on_receive(lambda _p: None)
            self.nodes[vehicle_id] = node
        return self.nodes[vehicle_id]


_bench = Bench()


def _reset() -> Bench:
    global _bench
    _bench = Bench()
    return _bench


# ---- vision helpers ---------------------------------------------------------
def synth_frame(kind: str, seed: int = 7) -> np.ndarray:
    """640x480 BGR road frame with one synthetic hazard."""
    rng = np.random.default_rng(seed)
    # Smooth gradient + faint grain: equalizeHist amplifies noise into edges, so keep it tiny.
    gradient = np.tile(np.linspace(108, 120, 480, dtype=np.float32)[:, None], (1, 640))
    base = (gradient + rng.normal(0, 0.4, (480, 640))).clip(0, 255).astype(np.uint8)
    frame = cv2.cvtColor(base, cv2.COLOR_GRAY2BGR)
    if kind == "pothole":
        cv2.ellipse(frame, (320, 300), (95, 65), 0, 0, 360, (28, 28, 28), -1)
        cv2.ellipse(frame, (320, 300), (95, 65), 0, 0, 360, (70, 70, 70), 4)
    elif kind == "crack":
        pts = np.array([[40, 250], [200, 262], [340, 244], [480, 258], [600, 246]], np.int32)
        cv2.polylines(frame, [pts], False, (25, 25, 25), 7)
    elif kind == "debris":
        # Jagged, spiky outline (low circularity) so the classifier calls it debris.
        pts = np.array(
            [[250, 300], [285, 250], [300, 295], [335, 225], [350, 292], [400, 240], [390, 300],
             [440, 305], [385, 322], [405, 370], [340, 335], [300, 380], [292, 330], [240, 345]],
            np.int32,
        )
        cv2.fillPoly(frame, [pts], (175, 175, 180))
    else:
        raise ValueError(f"unknown synthetic type {kind!r} (pothole | crack | debris)")
    return cv2.GaussianBlur(frame, (3, 3), 0)


def _darkness_score(frame: np.ndarray, bbox: tuple) -> float:
    """Same darkness cue HazardDetector uses (equalised grey, bbox mean)."""
    cfg = HazardDetector().cfg
    gray = cv2.equalizeHist(cv2.cvtColor(cv2.resize(frame, (cfg.frame_width, cfg.frame_height)), cv2.COLOR_BGR2GRAY))
    x, y, w, h = bbox
    roi = gray[y : y + h, x : x + w]
    return round(1.0 - float(np.mean(roi)) / 255.0, 3) if roi.size else 0.0


# ---- tool implementations (plain functions, also unit-testable) ----------------
def run_vision_detector(image_path_or_synthetic_type: str) -> dict:
    """Run HazardDetector.process_frame() on a road image file or on a
    synthesised 640x480 frame ("pothole", "crack" or "debris")."""
    src = image_path_or_synthetic_type
    if Path(src).is_file():
        frame = cv2.imread(src)
        if frame is None:
            return {"ok": False, "error": f"could not decode image {src!r}"}
        source = f"file:{src}"
    else:
        try:
            frame = synth_frame(src.strip().lower())
        except ValueError as exc:
            return {"ok": False, "error": str(exc)}
        source = f"synthetic:{src.strip().lower()}"

    detections = HazardDetector().process_frame(frame)
    if not detections:
        _bench.last_vision = None
        return {"ok": True, "source": source, "detected": False, "detections": []}

    top = detections[0]
    _bench.last_vision = top
    darkness = _darkness_score(frame, top.bbox)
    return {
        "ok": True,
        "source": source,
        "detected": True,
        "hazard_type": top.hazard_type.value,
        "confidence": round(top.confidence, 3),
        "circularity": round(top.circularity, 3),
        "darkness_score": darkness,
        "bbox": list(top.bbox),
        "area_px": round(top.area_px, 1),
        "detection_count": len(detections),
    }


def _extract_json_line(raw: str) -> str:
    for line in raw.replace("\r", "\n").split("\n"):
        line = line.strip()
        if line.startswith("{"):
            return line
    raise ValueError("no JSON object line found in serial capture")


def fuse_and_ingest_esp32_serial(raw_serial_json: str, vision_confidence: float) -> dict:
    """Pair an ESP32-C3 serial packet with the Pi's vision detection, fuse,
    broadcast over the radio model and feed cluster verification + emergency
    evaluation."""
    try:
        packet = HazardAlertPacket.decode(_extract_json_line(raw_serial_json).encode("utf-8"))
    except Exception as exc:  # noqa: BLE001 - report any parse problem to the caller
        return {"ok": False, "error": f"bad ESP32 packet: {exc}"}

    bench = _bench
    bench.ensure_coordinator(packet.latitude, packet.longitude)
    node = bench.node(packet.vehicle_id, packet.latitude, packet.longitude)

    last = bench.last_vision
    detection = HazardDetection(
        hazard_type=last.hazard_type if last else HazardType.POTHOLE,
        confidence=float(vision_confidence),
        bbox=last.bbox if last else (0, 0, 0, 0),
        area_px=last.area_px if last else 0.0,
        circularity=last.circularity if last else 0.0,
    )
    # The firmware only emits an alert after its own IMU threshold fired, so
    # the IMU stage is represented by a sample just past the impact threshold.
    imu = IMUSample(accel_g=(0.0, 0.0, 1.0 + 1.8 + 0.01), gyro_dps=(0.0, 0.0, 0.0))
    # Firmware confidence 0.85 means "reliable GPS fix" (HDOP <= 3.5), 0.5 means not.
    reliable = packet.confidence >= 0.85
    gps = GPSFix(
        latitude=packet.latitude,
        longitude=packet.longitude,
        speed_kmh=packet.speed_kmh,
        course_deg=0.0,
        hdop=1.1 if reliable else 5.0,
        satellites=8 if reliable else 3,
    )

    fusion = SensorFusion(vehicle_id=packet.vehicle_id)
    fusion.observe_imu(imu)
    fusion.observe_vision(detection)
    event = fusion.fuse(gps)
    result: Dict[str, Any] = {"ok": True, "esp32_packet": packet.to_dict()}
    if event is None:
        result.update(verified=False, reason="fusion produced no event")
        return result

    result["fusion"] = event.to_dict()
    result["verified"] = event.is_verified
    if not event.is_verified:
        result["reason"] = "fused confidence below verified threshold; nothing broadcast"
        return result

    out = replace(
        packet,
        hazard_type=event.hazard_type,
        confidence=event.fused_confidence,
        origin_event_id=event.event_id,
    )
    tx_before = len(bench.mesh.tx_log)
    node.broadcast(out)
    result["broadcast"] = {
        "packet_id": out.packet_id,
        "hazard_type": out.hazard_type,
        "confidence": round(out.confidence, 3),
        "transmissions": len(bench.mesh.tx_log) - tx_before,
    }
    result["clusters"] = [c.to_dict() for c in bench.verifier.clusters]
    result["emergencies"] = [e.to_dict() for e in bench.emergencies]
    return result


def simulate_corroborating_peer(vehicle_id: str, hazard_type: str, lat: float, lon: float, offset_m: float) -> dict:
    """A second vehicle reports `hazard_type` `offset_m` metres north of
    (lat, lon). Exercises the 40 m / 2-vehicle escalation rule."""
    bench = _bench
    peer_lat = lat + offset_m / METERS_PER_DEG_LAT
    peer_lon = lon
    bench.ensure_coordinator(lat, lon)
    node = bench.node(vehicle_id, peer_lat, peer_lon)

    packet = HazardAlertPacket.new_alert(
        vehicle_id=vehicle_id,
        hazard_type=hazard_type,
        confidence=0.85,
        latitude=peer_lat,
        longitude=peer_lon,
        speed_kmh=40.0,
    )
    tx_before = len(bench.mesh.tx_log)
    node.broadcast(packet)
    return {
        "ok": True,
        "peer": vehicle_id,
        "packet_id": packet.packet_id,
        "offset_m": offset_m,
        "distance_to_reported_m": round(_haversine_m(lat, lon, peer_lat, peer_lon), 2),
        "transmissions": len(bench.mesh.tx_log) - tx_before,
        "clusters": [c.to_dict() for c in bench.verifier.clusters],
        "emergencies": [e.to_dict() for e in bench.emergencies],
    }


def add_relay_nodes(count: int, spacing_m: float, from_lat: float, from_lon: float) -> dict:
    """Place `count` relay-only vehicles in a line heading north from a point,
    `spacing_m` apart, to exercise multi-hop relay and the 5-hop cap."""
    placed = []
    for i in range(1, count + 1):
        vid = f"REL-{i:02d}"
        lat = from_lat + (i * spacing_m) / METERS_PER_DEG_LAT
        _bench.node(vid, lat, from_lon)
        placed.append({"id": vid, "lat": round(lat, 6), "lon": from_lon})
    return {"ok": True, "relays": placed}


def reset_bench() -> dict:
    _reset()
    return {"ok": True}


def get_mesh_state() -> dict:
    """Full snapshot: seen packet ids, hop counts, tx/airtime, clusters, EMERGENCY."""
    bench = _bench
    per_packet: Dict[str, dict] = {}
    for tx in bench.mesh.tx_log:
        p = per_packet.setdefault(
            tx["packet_id"], {"type": tx["type"], "transmissions": 0, "max_hop": 0, "hops": {}, "senders": []}
        )
        p["transmissions"] += 1
        p["max_hop"] = max(p["max_hop"], tx["hop"])
        p["hops"][str(tx["hop"])] = p["hops"].get(str(tx["hop"]), 0) + 1
        p["senders"].append(tx["sender"])

    receivers = len(bench.nodes) + 1  # vehicles + coordinator
    for p in per_packet.values():
        # With seen-id dedupe each node relays a given packet at most once.
        p["storm_free"] = p["transmissions"] <= receivers + 1

    max_hops = HazardAlertPacket.new_alert("x", "x", 0, 0, 0, 0).max_hops
    return {
        "radio": {"range_m": bench.mesh.range_m, "airtime_s_per_tx": AIRTIME_S, "max_hops": max_hops},
        "positions": {k: [round(v[0], 6), round(v[1], 6)] for k, v in bench.mesh.positions.items()},
        "seen_packet_ids": {vid: list(n._seen_packet_ids.keys()) for vid, n in bench.nodes.items()},
        "packets": per_packet,
        "max_hop_observed": max((p["max_hop"] for p in per_packet.values()), default=0),
        "total_transmissions": len(bench.mesh.tx_log),
        "total_airtime_s": round(len(bench.mesh.tx_log) * AIRTIME_S, 2),
        "tx_log": bench.mesh.tx_log,
        "clusters": [c.to_dict() for c in bench.verifier.clusters],
        "emergency_events": [e.to_dict() for e in bench.emergencies],
        "emergency_broadcasts": [
            p.to_dict() for p in bench.mesh.packet_log if PacketType(p.packet_type) == PacketType.EMERGENCY
        ],
        "generated_at": time.time(),
    }


# ---- MCP server ------------------------------------------------------------
def build_server():
    from mcp.server.fastmcp import FastMCP

    server = FastMCP("rakshawave-hil")
    for fn in (
        run_vision_detector,
        fuse_and_ingest_esp32_serial,
        simulate_corroborating_peer,
        get_mesh_state,
        add_relay_nodes,
        reset_bench,
    ):
        server.tool()(fn)
    return server


if __name__ == "__main__":
    build_server().run()
