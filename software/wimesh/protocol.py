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

import base64
import json
import time
import uuid
from dataclasses import dataclass, field, asdict
from enum import Enum
from typing import Optional

from software.config import WiMeshConfig, settings


# Values below this (~11.6 days as epoch seconds) are not Unix timestamps:
# they are relative TTLs / device uptime from clockless nodes (the ESP32).
_EPOCH_THRESHOLD_S = 1_000_000


class PacketType(str, Enum):
    HAZARD_ALERT = "HAZARD_ALERT"       # a vehicle reporting a verified hazard
    CORROBORATION = "CORROBORATION"     # a vehicle confirming a nearby vehicle's alert
    HEARTBEAT = "HEARTBEAT"             # lightweight presence/position beacon
    EMERGENCY = "EMERGENCY"             # escalated alert -> emergency response
    VOICE = "VOICE"                     # push-to-talk voice chunk (see VoicePacket)


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
        now = time.time()
        # The ESP32 has no wall clock: it sends "ttl" as relative seconds-to-live
        # and "ts" as uptime. Anything below the epoch threshold is rebased to now.
        ttl = payload["ttl"]
        if ttl < _EPOCH_THRESHOLD_S:
            ttl = now + ttl
        created_at = payload["ts"]
        if created_at < _EPOCH_THRESHOLD_S:
            created_at = now
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
            ttl_expires_at=ttl,
            origin_event_id=payload.get("oid"),
            created_at=created_at,
        )

    def to_dict(self) -> dict:
        d = asdict(self)
        d["packet_type"] = self.packet_type.value
        return d


# LoRa frames carry at most 255 bytes; VoicePacket.encode() enforces it.
LORA_MAX_FRAME_BYTES = 255
VOICE_TTL_S = 10.0
# Push-to-talk is local: relaying voice would eat the shared airtime of every
# node in range, so it is not relayed unless a caller opts in.
VOICE_DEFAULT_MAX_HOPS = 0


@dataclass
class VoicePacket:
    """One chunk of a push-to-talk transmission (Codec2 frames).

    Same relay/dedupe interface as HazardAlertPacket (`packet_id`,
    `vehicle_id`, `hop_count`, `can_relay()`, `relayed()`), so LoRaNode and
    the mesh bus handle it unchanged."""

    vehicle_id: str
    stream_id: str          # one per key-down, groups the chunks of one transmission
    seq: int                # chunk index within the stream, from 0
    payload: bytes          # whole Codec2 frames
    last: bool = False      # key released: stream ends after this chunk
    codec: str = "700C"
    hop_count: int = 0
    max_hops: int = VOICE_DEFAULT_MAX_HOPS
    ttl_expires_at: float = field(default_factory=lambda: time.time() + VOICE_TTL_S)
    packet_type: PacketType = PacketType.VOICE

    @property
    def packet_id(self) -> str:
        return f"{self.stream_id}-{self.seq}"

    def is_expired(self) -> bool:
        return time.time() > self.ttl_expires_at

    def can_relay(self) -> bool:
        return not self.is_expired() and self.hop_count < self.max_hops

    def relayed(self) -> "VoicePacket":
        clone = VoicePacket(**{k: getattr(self, k) for k in self.__dataclass_fields__})
        clone.hop_count += 1
        return clone

    def encode(self) -> bytes:
        payload = {
            "t": PacketType.VOICE.value,
            "veh": self.vehicle_id,
            "sid": self.stream_id,
            "q": self.seq,
            "e": 1 if self.last else 0,
            "c": self.codec,
            "d": base64.b64encode(self.payload).decode("ascii"),
            "hop": self.hop_count,
            "mh": self.max_hops,
            "ttl": VOICE_TTL_S,  # relative, like the ESP32's packets
        }
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        if len(raw) > LORA_MAX_FRAME_BYTES:
            raise ValueError(f"voice packet is {len(raw)} bytes, LoRa frame limit is {LORA_MAX_FRAME_BYTES}")
        return raw

    @classmethod
    def decode(cls, raw: bytes) -> "VoicePacket":
        payload = json.loads(raw.decode("utf-8"))
        if payload["t"] != PacketType.VOICE.value:
            raise ValueError("not a VOICE packet")
        ttl = payload["ttl"]
        if ttl < _EPOCH_THRESHOLD_S:
            ttl = time.time() + ttl
        return cls(
            vehicle_id=payload["veh"],
            stream_id=payload["sid"],
            seq=payload["q"],
            payload=base64.b64decode(payload["d"]),
            last=bool(payload["e"]),
            codec=payload["c"],
            hop_count=payload["hop"],
            max_hops=payload["mh"],
            ttl_expires_at=ttl,
        )

    def to_dict(self) -> dict:
        return {
            "packet_id": self.packet_id,
            "packet_type": PacketType.VOICE.value,
            "vehicle_id": self.vehicle_id,
            "stream_id": self.stream_id,
            "seq": self.seq,
            "last": self.last,
            "codec": self.codec,
            "bytes": len(self.payload),
            "hop_count": self.hop_count,
        }


def decode_packet(raw: bytes):
    """Decode one wire line into a HazardAlertPacket or a VoicePacket."""
    if json.loads(raw.decode("utf-8")).get("t") == PacketType.VOICE.value:
        return VoicePacket.decode(raw)
    return HazardAlertPacket.decode(raw)
