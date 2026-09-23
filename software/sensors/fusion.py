"""
Sensor fusion — "VERIFY: Cross-verify all sensor input" stage.

Combines the vision hazard detector's confidence with the IMU impact
signal and GPS fix reliability into one fused hazard event. This is the
"AI + IMU + GPS + LoRa = Safer Roads" step from the deck: a hazard is
only escalated to the WiMesh layer once it clears the fused-confidence
threshold, which is what keeps single false positives (e.g. a camera
glare mis-read as a pothole) from becoming broadcast alerts.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

from software.config import FusionConfig, settings
from software.sensors.gps import GPSFix
from software.sensors.imu import IMUSample
from software.vision.hazard_detector import HazardDetection


@dataclass
class FusedHazardEvent:
    """A single-vehicle, sensor-verified hazard — ready to hand to the
    WiMesh layer for V2V broadcast and multi-vehicle corroboration."""

    event_id: str
    vehicle_id: str
    hazard_type: str
    fused_confidence: float
    vision_confidence: float
    impact_confirmed: bool
    gps: GPSFix
    created_at: float = field(default_factory=time.time)

    @property
    def is_verified(self) -> bool:
        cfg = settings.fusion
        return self.fused_confidence >= cfg.verified_threshold

    def to_dict(self) -> dict:
        return {
            "event_id": self.event_id,
            "vehicle_id": self.vehicle_id,
            "hazard_type": self.hazard_type,
            "fused_confidence": round(self.fused_confidence, 3),
            "vision_confidence": round(self.vision_confidence, 3),
            "impact_confirmed": self.impact_confirmed,
            "verified": self.is_verified,
            "gps": self.gps.to_dict(),
            "created_at": self.created_at,
        }


class SensorFusion:
    """Stateless-per-call fusion of one vision detection + the current
    IMU/GPS readings, with a rolling confirmation window so that a
    weak vision hit only counts if it is corroborated by an impact
    (or vice-versa) within `confirmation_window_s`."""

    def __init__(self, vehicle_id: str, config: Optional[FusionConfig] = None):
        self.vehicle_id = vehicle_id
        self.cfg = config or settings.fusion
        self._pending_impact: Optional[tuple[IMUSample, float]] = None  # (sample, seen_at)
        self._pending_vision: Optional[tuple[HazardDetection, float]] = None

    def observe_imu(self, sample: IMUSample) -> None:
        if sample.is_impact():
            self._pending_impact = (sample, time.time())

    def observe_vision(self, detection: HazardDetection) -> None:
        self._pending_vision = (detection, time.time())

    def _within_window(self, seen_at: float) -> bool:
        return (time.time() - seen_at) <= self.cfg.confirmation_window_s

    def fuse(self, gps: GPSFix) -> Optional[FusedHazardEvent]:
        """Call once per detection cycle. Returns a FusedHazardEvent if
        there's an active vision detection (confirmed or not — callers
        should check `.is_verified` / `.fused_confidence`), else None."""
        if self._pending_vision is None:
            return None

        detection, vision_seen_at = self._pending_vision
        if not self._within_window(vision_seen_at):
            self._pending_vision = None
            return None

        impact_confirmed = False
        if self._pending_impact is not None:
            _, impact_seen_at = self._pending_impact
            if self._within_window(impact_seen_at):
                impact_confirmed = True
            else:
                self._pending_impact = None

        gps_score = 1.0 if gps.is_reliable() else 0.4

        fused = (
            self.cfg.vision_weight * detection.confidence
            + self.cfg.imu_weight * (1.0 if impact_confirmed else 0.15)
            + self.cfg.gps_weight * gps_score
        )
        fused = max(0.0, min(fused, 1.0))

        event = FusedHazardEvent(
            event_id=str(uuid.uuid4()),
            vehicle_id=self.vehicle_id,
            hazard_type=detection.hazard_type.value,
            fused_confidence=fused,
            vision_confidence=detection.confidence,
            impact_confirmed=impact_confirmed,
            gps=gps,
        )

        # Consume the vision detection once fused so we don't re-emit
        # the same hazard every cycle within the confirmation window.
        self._pending_vision = None
        return event
