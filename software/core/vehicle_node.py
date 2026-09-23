"""
VehicleNode — wires DETECT -> CONFIRM -> LOCATE -> VERIFY -> SHARE -> WARN
into a single per-vehicle runtime loop, exactly matching the "Technical
Approach" slide's pipeline.

Each vehicle runs one `VehicleNode`. It owns:
  * a `HazardDetector`   (camera / OpenCV)          -> DETECT
  * an `IMUReader`       (MPU6050)                  -> CONFIRM
  * a `GPSReader`        (GPS module)                -> LOCATE
  * a `SensorFusion`     (cross-verification)         -> VERIFY
  * a `LoRaNode`         (WiMesh broadcast/receive)    -> SHARE / WARN

`step()` runs one iteration of the loop and is what both the live
hardware entrypoint (`main.py`, not shown — swap in a cv2.VideoCapture)
and the simulator/API server call repeatedly.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Callable, List, Optional

import numpy as np

from software.sensors.fusion import FusedHazardEvent, SensorFusion
from software.sensors.gps import GPSFix, GPSReader
from software.sensors.imu import IMUReader
from software.vision.hazard_detector import HazardDetection, HazardDetector
from software.wimesh.lora_node import LoRaNode
from software.wimesh.mesh_network import MeshNetwork
from software.wimesh.protocol import HazardAlertPacket

logger = logging.getLogger("rakshawave.vehicle_node")


@dataclass
class VehicleNode:
    vehicle_id: str
    mesh_bus: Optional[MeshNetwork] = None

    detector: HazardDetector = field(init=False)
    imu: IMUReader = field(init=False)
    gps: GPSReader = field(init=False)
    fusion: SensorFusion = field(init=False)
    radio: LoRaNode = field(init=False)

    received_packets: List[HazardAlertPacket] = field(default_factory=list, init=False)
    _on_alert: Optional[Callable[[FusedHazardEvent], None]] = field(default=None, init=False)

    def __post_init__(self):
        self.detector = HazardDetector()
        self.imu = IMUReader()
        self.gps = GPSReader()
        self.fusion = SensorFusion(vehicle_id=self.vehicle_id)
        self.radio = LoRaNode(vehicle_id=self.vehicle_id, mesh_bus=self.mesh_bus)
        self.radio.on_receive(self._handle_incoming_packet)

    # ------------------------------------------------------------------
    def on_alert(self, callback: Callable[[FusedHazardEvent], None]) -> None:
        """Fires whenever THIS vehicle verifies + broadcasts a hazard."""
        self._on_alert = callback

    def _handle_incoming_packet(self, packet: HazardAlertPacket) -> None:
        self.received_packets.append(packet)
        # Keep the buffer bounded for long-running demos.
        if len(self.received_packets) > 200:
            self.received_packets = self.received_packets[-200:]

    # ------------------------------------------------------------------
    def step(self, frame: Optional[np.ndarray] = None) -> Optional[FusedHazardEvent]:
        """Run one DETECT->CONFIRM->LOCATE->VERIFY->SHARE cycle.

        `frame` is an optional BGR image (from a live camera or a demo
        clip). If omitted, the vision stage is skipped for this tick —
        useful when driving the loop purely off simulated IMU/GPS data.
        """
        gps_fix: GPSFix = self.gps.read()
        imu_sample = self.imu.read()
        self.fusion.observe_imu(imu_sample)

        detections: List[HazardDetection] = []
        if frame is not None:
            detections = self.detector.process_frame(frame)
            for det in detections:
                self.fusion.observe_vision(det)

        event = self.fusion.fuse(gps_fix)
        if event is None:
            return None

        if event.is_verified:
            self._broadcast(event)
            if self._on_alert:
                self._on_alert(event)
        else:
            logger.debug("Discarded unverified hazard: %s", event.to_dict())

        return event

    def _broadcast(self, event: FusedHazardEvent) -> None:
        packet = HazardAlertPacket.new_alert(
            vehicle_id=self.vehicle_id,
            hazard_type=event.hazard_type,
            confidence=event.fused_confidence,
            latitude=event.gps.latitude,
            longitude=event.gps.longitude,
            speed_kmh=event.gps.speed_kmh,
            origin_event_id=event.event_id,
        )
        self.radio.broadcast(packet)
        logger.info("Broadcast hazard alert: %s", packet.to_dict())
