"""
WiMesh packet protocol — the wire format broadcast over LoRa for V2V
hazard alerts and multi-hop relay.

Design goals (from the "Research and References" slide — WiMesh /
Ashraf et al. 2021, decentralized mesh networking for resource-
constrained settings):
  * Small, fixed-shape JSON payload — fits comfortably in a LoRa frame
    (<255 bytes) even after encoding.
  * Infrastructure-independent: every field needed to route, dedupe and
    verify an alert travels with the packet itself.
  * Multi-hop friendly: a hop counter + TTL prevent infinite relay
    loops on a mesh with no central coordinator.
"""

from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional

from software.config import WiMeshConfig, settings


class PacketType(str, Enum):
    HAZARD_ALERT = "HAZARD_ALERT"       # a vehicle reporting a verified hazard
    CORROBORATION = "CORROBORATION"     # a vehicle confirming a nearby vehicle's alert
    HEARTBEAT = "HEARTBEAT"             # lightweight presence/position beacon
    EMERGENCY = "EMERGENCY"             # escalated alert -> emergency response


@dataclass
class HazardAlertPacket:
    """One WiMesh packet on the wire."""

    packet_id: str
    packet_type: PacketType
    vehicle_id: str
    hazard_type: str
    confidence: float
    latitude: float
    longitude: float
    speed_kmh: float
    hop_count: int = 0
    max_hops: int = settings.wimesh.max_hops
    ttl_expires_at: float = field(default_factory=lambda: time.time() + settings.wimesh.ttl_s)
    origin_event_id: Optional[str] = None
    created_at: float = field(default_factory=time.time)

    @classmethod
    def new_alert(
        cls,
        vehicle_id: str,
        hazard_type: str,
        confidence: float,
        latitude: float,
        longitude: float,
        speed_kmh: float,
        origin_event_id: Optional[str] = None,
        packet_type: PacketType = PacketType.HAZARD_ALERT,
        config: Optional[WiMeshConfig] = None,
    ) -> "HazardAlertPacket":
        cfg = config or settings.wimesh
        return cls(
            packet_id=str(uuid.uuid4()),
            packet_type=packet_type,
            vehicle_id=vehicle_id,
            hazard_type=hazard_type,
            confidence=confidence,
            latitude=latitude,
            longitude=longitude,
            speed_kmh=speed_kmh,
            hop_count=0,
            max_hops=cfg.max_hops,
            ttl_expires_at=time.time() + cfg.ttl_s,
            origin_event_id=origin_event_id,
        )

    # -- lifecycle --------------------------------------------------------
    def is_expired(self) -> bool:
        return time.time() > self.ttl_expires_at

    def can_relay(self) -> bool:
        return not self.is_expired() and self.hop_count < self.max_hops

    def relayed(self) -> "HazardAlertPacket":
        """Return a copy with hop_count incremented, ready to re-broadcast."""
        clone = HazardAlertPacket(**asdict(self))
        clone.packet_type = PacketType(clone.packet_type)
        clone.hop_count += 1
        return clone

    # -- wire encode/decode ------------------------------------------------
    def encode(self) -> bytes:
        """Compact JSON on the wire — LoRa payloads are small, so keys
        are kept short-ish and floats rounded."""
        payload = {
            "id": self.packet_id,
            "t": self.packet_type.value,
            "veh": self.vehicle_id,
            "hz": self.hazard_type,
            "c": round(self.confidence, 3),
            "lat": round(self.latitude, 6),
            "lon": round(self.longitude, 6),
            "spd": round(self.speed_kmh, 1),
            "hop": self.hop_count,
            "mh": self.max_hops,
            "ttl": round(self.ttl_expires_at, 1),
            "oid": self.origin_event_id,
            "ts": round(self.created_at, 3),
        }
        return json.dumps(payload, separators=(",", ":")).encode("utf-8")

    @classmethod
    def decode(cls, raw: bytes) -> "HazardAlertPacket":
        payload = json.loads(raw.decode("utf-8"))
        return cls(
            packet_id=payload["id"],
            packet_type=PacketType(payload["t"]),
            vehicle_id=payload["veh"],
            hazard_type=payload["hz"],
            confidence=payload["c"],
            latitude=payload["lat"],
            longitude=payload["lon"],
            speed_kmh=payload["spd"],
            hop_count=payload["hop"],
            max_hops=payload["mh"],
            ttl_expires_at=payload["ttl"],
            origin_event_id=payload.get("oid"),
            created_at=payload["ts"],
        )

    def to_dict(self) -> dict:
        d = asdict(self)
        d["packet_type"] = self.packet_type.value
        return d
