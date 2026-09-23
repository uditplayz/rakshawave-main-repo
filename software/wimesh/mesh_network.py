"""
In-process WiMesh simulation bus + multi-vehicle hazard verification.

Two responsibilities live here:

1. `MeshNetwork` — a lightweight pub/sub bus standing in for the radio
   air interface when no physical LoRa modules are attached. Every
   `LoRaNode` sharing a `MeshNetwork` instance can broadcast/receive
   exactly as it would over the air, which is what lets
   `software/simulator/simulate_fleet.py` and the API server demo the
   full multi-vehicle pipeline on a single machine.

2. `HazardClusterVerifier` — the "MITIGATION: Multi-Vehicle
   Verification — confirm hazard using GPS clustering" step from the
   Feasibility & Viability slide. A single vehicle's report stays
   LOW/MEDIUM confidence; once `min_corroborations` independent
   vehicles report a hazard within `cluster_radius_m` of each other,
   the cluster is escalated to HIGH confidence and (optionally) an
   EMERGENCY packet.
"""

from __future__ import annotations

import math
import time
from dataclasses import dataclass, field
from typing import Callable, Dict, List, Optional

from software.config import WiMeshConfig, settings
from software.wimesh.protocol import HazardAlertPacket, PacketType


class MeshNetwork:
    """Simple broadcast bus: every subscriber except the sender gets
    every published packet — mirroring a LoRa broadcast domain."""

    def __init__(self):
        self._subscribers: Dict[str, Callable[[HazardAlertPacket], None]] = {}
        self.packet_log: List[HazardAlertPacket] = []

    def subscribe(self, vehicle_id: str, callback: Callable[[HazardAlertPacket], None]) -> None:
        self._subscribers[vehicle_id] = callback

    def publish(self, sender_id: str, packet: HazardAlertPacket) -> None:
        self.packet_log.append(packet)
        for vehicle_id, callback in self._subscribers.items():
            if vehicle_id == sender_id:
                continue
            callback(packet)


@dataclass
class HazardCluster:
    cluster_id: str
    hazard_type: str
    latitude: float
    longitude: float
    reports: List[HazardAlertPacket] = field(default_factory=list)
    first_seen: float = field(default_factory=time.time)
    last_seen: float = field(default_factory=time.time)
    escalated: bool = False

    @property
    def vehicle_ids(self) -> set:
        return {r.vehicle_id for r in self.reports}

    @property
    def max_confidence(self) -> float:
        return max((r.confidence for r in self.reports), default=0.0)

    def to_dict(self) -> dict:
        return {
            "cluster_id": self.cluster_id,
            "hazard_type": self.hazard_type,
            "lat": round(self.latitude, 6),
            "lon": round(self.longitude, 6),
            "report_count": len(self.reports),
            "corroborating_vehicles": sorted(self.vehicle_ids),
            "max_confidence": round(self.max_confidence, 3),
            "escalated": self.escalated,
            "first_seen": self.first_seen,
            "last_seen": self.last_seen,
        }


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    r = 6_371_000
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


class HazardClusterVerifier:
    """Groups incoming HAZARD_ALERT / CORROBORATION packets from many
    vehicles into geo-clusters and decides when a cluster has enough
    independent corroboration to be trusted (false-alert mitigation)."""

    def __init__(self, config: Optional[WiMeshConfig] = None):
        self.cfg = config or settings.wimesh
        self.clusters: List[HazardCluster] = []
        self._on_escalate: Optional[Callable[[HazardCluster], None]] = None

    def on_escalate(self, callback: Callable[[HazardCluster], None]) -> None:
        self._on_escalate = callback

    def ingest(self, packet: HazardAlertPacket) -> HazardCluster:
        cluster = self._find_or_create_cluster(packet)
        if packet.packet_id not in {r.packet_id for r in cluster.reports}:
            cluster.reports.append(packet)
        cluster.last_seen = time.time()

        if not cluster.escalated and len(cluster.vehicle_ids) >= self.cfg.min_corroborations:
            cluster.escalated = True
            if self._on_escalate:
                self._on_escalate(cluster)

        return cluster

    def _find_or_create_cluster(self, packet: HazardAlertPacket) -> HazardCluster:
        for cluster in self.clusters:
            if cluster.hazard_type != packet.hazard_type:
                continue
            dist = _haversine_m(cluster.latitude, cluster.longitude, packet.latitude, packet.longitude)
            if dist <= self.cfg.cluster_radius_m:
                return cluster

        cluster = HazardCluster(
            cluster_id=f"CL-{len(self.clusters) + 1:04d}",
            hazard_type=packet.hazard_type,
            latitude=packet.latitude,
            longitude=packet.longitude,
        )
        self.clusters.append(cluster)
        return cluster

    def active_clusters(self, max_age_s: float = 300.0) -> List[HazardCluster]:
        now = time.time()
        return [c for c in self.clusters if now - c.last_seen <= max_age_s]
