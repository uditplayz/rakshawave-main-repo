"""
Multi-vehicle fleet simulator.

Runs several `VehicleNode`s on one shared `MeshNetwork` bus so the full
pipeline — DETECT/CONFIRM/LOCATE/VERIFY/SHARE/WARN, multi-vehicle
clustering, and emergency escalation — can be demoed end to end
without any camera, IMU, GPS or LoRa hardware attached. This is what
powers the live dashboard (`ui/index.html`) and is also usable
stand-alone from the CLI (`python -m software.simulator.simulate_fleet`).

Each simulated vehicle drives a small GPS loop offset from the others
and occasionally "sees" a synthetic hazard detection, which flows
through the exact same `VehicleNode.step()` used by real hardware.
"""

from __future__ import annotations

import logging
import random
import time
from dataclasses import dataclass, field
from typing import Dict, List, Optional

from software.config import settings
from software.core.emergency import EmergencyEvent, EmergencyResponder
from software.core.vehicle_node import VehicleNode
from software.sensors.fusion import FusedHazardEvent
from software.sensors.gps import GPSFix
from software.vision.hazard_detector import HazardDetection, HazardType
from software.wimesh.mesh_network import HazardCluster, HazardClusterVerifier, MeshNetwork
from software.wimesh.protocol import HazardAlertPacket

logger = logging.getLogger("rakshawave.simulator")

_HAZARD_TYPES = [HazardType.POTHOLE, HazardType.CRACK, HazardType.DEBRIS]

# A handful of fixed "hazard hotspots" near the demo GPS origin so that
# multiple independent vehicles plausibly drive past & corroborate the
# same real-world hazard (this is what exercises GPS clustering).
_HOTSPOTS = [
    (18.5204, 73.8567, HazardType.POTHOLE),
    (18.5220, 73.8590, HazardType.DEBRIS),
    (18.5188, 73.8541, HazardType.POTHOLE),
]


@dataclass
class FleetSimulator:
    vehicle_ids: List[str] = field(default_factory=lambda: [f"VEH-{i:03d}" for i in range(1, 6)])
    hazard_probability: float = 0.12

    mesh: MeshNetwork = field(default_factory=MeshNetwork, init=False)
    verifier: HazardClusterVerifier = field(default_factory=HazardClusterVerifier, init=False)
    responder: EmergencyResponder = field(init=False)
    nodes: Dict[str, VehicleNode] = field(default_factory=dict, init=False)

    recent_events: List[FusedHazardEvent] = field(default_factory=list, init=False)
    emergencies: List[EmergencyEvent] = field(default_factory=list, init=False)
    tick_count: int = field(default=0, init=False)

    def __post_init__(self):
        self.responder = EmergencyResponder(broadcast_fn=self._coordinator_broadcast)
        self.responder.on_emergency(self._on_emergency)

        for i, vid in enumerate(self.vehicle_ids):
            node = VehicleNode(vehicle_id=vid, mesh_bus=self.mesh)
            # Spread each simulated vehicle's GPS loop out so they are
            # near-but-not-identical, like real traffic.
            node.gps._sim_t = i * 37.0
            node.gps._state["latitude"] += (i - len(self.vehicle_ids) / 2) * 0.0006
            node.on_alert(self._on_vehicle_alert)
            self.nodes[vid] = node

        # Every vehicle also "overhears" every broadcast for clustering,
        # mirroring a roadside/coordinator node listening to the mesh.
        self.mesh.subscribe("MESH-COORDINATOR", self._on_mesh_packet)

    # ------------------------------------------------------------------
    def tick(self) -> None:
        """Advance the whole fleet by one simulated timestep."""
        self.tick_count += 1
        for vid, node in self.nodes.items():
            self._maybe_inject_hazard(node)
            node.step(frame=None)

    def _maybe_inject_hazard(self, node: VehicleNode) -> None:
        if random.random() >= self.hazard_probability:
            return

        gps = node.gps.read()
        # Bias towards a real hotspot near the vehicle so clusters form.
        hotspot = min(
            _HOTSPOTS,
            key=lambda h: (h[0] - gps.latitude) ** 2 + (h[1] - gps.longitude) ** 2,
        )
        lat, lon, hazard_type = hotspot
        jitter = 0.00015
        detection = HazardDetection(
            hazard_type=hazard_type,
            confidence=round(random.uniform(0.55, 0.95), 2),
            bbox=(random.randint(0, 500), random.randint(0, 300), 60, 40),
            area_px=float(random.randint(900, 4000)),
            circularity=round(random.uniform(0.3, 0.9), 2),
        )
        node.fusion.observe_vision(detection)

        # Nudge this tick's GPS reading toward the hotspot so the
        # reported coordinates cluster geographically.
        node.gps._state["latitude"] = lat + random.uniform(-jitter, jitter)
        node.gps._state["longitude"] = lon + random.uniform(-jitter, jitter)

        # ~60% chance the vision hit is corroborated by an IMU impact.
        if random.random() < 0.6:
            from software.sensors.imu import IMUSample

            node.fusion.observe_imu(
                IMUSample(accel_g=(0.5, 0.5, 2.5), gyro_dps=(50, 50, 20))
            )

    # ------------------------------------------------------------------
    def _on_vehicle_alert(self, event: FusedHazardEvent) -> None:
        self.recent_events.append(event)
        self.recent_events = self.recent_events[-100:]

    def _on_mesh_packet(self, packet: HazardAlertPacket) -> None:
        cluster = self.verifier.ingest(packet)
        impact_hint = packet.confidence >= 0.8
        self.responder.evaluate(cluster, impact_confirmed=impact_hint)

    def _coordinator_broadcast(self, packet: HazardAlertPacket) -> None:
        self.mesh.publish("MESH-COORDINATOR", packet)

    def _on_emergency(self, event: EmergencyEvent) -> None:
        self.emergencies.append(event)
        self.emergencies = self.emergencies[-50:]
        logger.warning("EMERGENCY: %s", event.to_dict())

    # ------------------------------------------------------------------
    def snapshot(self) -> dict:
        vehicles = []
        for vid, node in self.nodes.items():
            fix = node.gps._state  # last known state dict
            vehicles.append(
                {
                    "vehicle_id": vid,
                    "lat": round(fix["latitude"], 6),
                    "lon": round(fix["longitude"], 6),
                    "speed_kmh": round(fix["speed_kmh"], 1),
                    "course_deg": round(fix.get("course_deg", 0.0), 1),
                    "last_update": time.time(),
                }
            )

        return {
            "vehicles": vehicles,
            "recent_events": [e.to_dict() for e in self.recent_events[-30:]],
            "clusters": [c.to_dict() for c in self.verifier.active_clusters()],
            "emergencies": [e.to_dict() for e in self.emergencies],
            "stats": {
                "tick_count": self.tick_count,
                "packets_on_air": len(self.mesh.packet_log),
                "active_vehicles": len(self.nodes),
                "verified_events": sum(1 for e in self.recent_events if e.is_verified),
            },
        }


def run_cli_demo(ticks: int = 60, interval_s: float = 1.0) -> None:  # pragma: no cover
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(message)s")
    sim = FleetSimulator()
    for _ in range(ticks):
        sim.tick()
        time.sleep(interval_s)
    logger.info("Final snapshot: %s", sim.snapshot()["stats"])


if __name__ == "__main__":  # pragma: no cover
    run_cli_demo()
