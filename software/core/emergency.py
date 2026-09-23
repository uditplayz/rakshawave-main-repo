"""
Emergency response escalation — final stage of the pipeline
(NEARBY VEHICLES -> EMERGENCY RESPONSE).

When a hazard cluster is corroborated by enough independent vehicles
*and* an IMU impact was confirmed (i.e. this looks like an actual
collision, not just a pothole everyone is reporting), the event is
escalated to an EMERGENCY packet carrying GPS location for faster
emergency response — the "Automatic accident detection + GPS -> Faster
emergency response, saved lives" line from the Impact & Benefits slide.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Callable, List, Optional

from software.wimesh.mesh_network import HazardCluster
from software.wimesh.protocol import HazardAlertPacket, PacketType

logger = logging.getLogger("rakshawave.emergency")

# Hazard types that, when corroborated, represent a potential collision
# rather than routine road-surface damage.
COLLISION_HAZARD_TYPES = {"unknown_hazard", "debris"}


@dataclass
class EmergencyEvent:
    cluster_id: str
    hazard_type: str
    latitude: float
    longitude: float
    corroborating_vehicles: List[str]

    def to_dict(self) -> dict:
        return {
            "cluster_id": self.cluster_id,
            "hazard_type": self.hazard_type,
            "lat": round(self.latitude, 6),
            "lon": round(self.longitude, 6),
            "corroborating_vehicles": self.corroborating_vehicles,
        }


class EmergencyResponder:
    """Watches escalated hazard clusters and raises EmergencyEvents for
    ones that look like a confirmed collision, dispatching an EMERGENCY
    WiMesh packet so it propagates ahead of/around the incident."""

    def __init__(self, broadcast_fn: Optional[Callable[[HazardAlertPacket], None]] = None):
        self._broadcast_fn = broadcast_fn
        self._notified_clusters: set[str] = set()
        self._listeners: List[Callable[[EmergencyEvent], None]] = []

    def on_emergency(self, callback: Callable[[EmergencyEvent], None]) -> None:
        self._listeners.append(callback)

    def evaluate(self, cluster: HazardCluster, impact_confirmed: bool = False) -> Optional[EmergencyEvent]:
        if cluster.cluster_id in self._notified_clusters:
            return None
        if not cluster.escalated:
            return None
        if not (impact_confirmed or cluster.hazard_type in COLLISION_HAZARD_TYPES):
            return None

        self._notified_clusters.add(cluster.cluster_id)
        event = EmergencyEvent(
            cluster_id=cluster.cluster_id,
            hazard_type=cluster.hazard_type,
            latitude=cluster.latitude,
            longitude=cluster.longitude,
            corroborating_vehicles=sorted(cluster.vehicle_ids),
        )

        logger.warning("EMERGENCY escalation: %s", event.to_dict())

        if self._broadcast_fn:
            packet = HazardAlertPacket.new_alert(
                vehicle_id="MESH-COORDINATOR",
                hazard_type=cluster.hazard_type,
                confidence=cluster.max_confidence,
                latitude=cluster.latitude,
                longitude=cluster.longitude,
                speed_kmh=0.0,
                origin_event_id=cluster.cluster_id,
                packet_type=PacketType.EMERGENCY,
            )
            self._broadcast_fn(packet)

        for listener in self._listeners:
            listener(event)

        return event
