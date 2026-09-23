"""
LoRa radio transport — "SHARE: Long-range V2V broadcast via LoRa".

Wraps a serial-attached LoRa module (e.g. SX1278/RA-02 on ESP32/
Raspberry Pi, in AT-command or transparent UART mode) for sending and
receiving raw `HazardAlertPacket` bytes. When no radio is attached
(dev machine, CI, the web demo) it transparently falls back to an
in-process `MeshNetwork` bus (see `mesh_network.py`) so the exact same
node code runs on real hardware or in simulation.
"""

from __future__ import annotations

import time
from collections import OrderedDict
from typing import Callable, Optional

from software.config import WiMeshConfig, settings
from software.wimesh.protocol import HazardAlertPacket

# How many recently-seen packet_ids each node remembers, purely to stop
# flood-relay storms on a densely connected mesh (every node hearing
# every other node, as in the simulator). A real sparse LoRa mesh needs
# this exact same guard for the same reason: without it, a broadcast
# domain where N nodes all relay everything they hear regenerates
# O(N!) duplicate transmissions before TTL/hop-count catches up.
_SEEN_CACHE_SIZE = 500


class LoRaNode:
    """One vehicle's LoRa V2V radio interface."""

    def __init__(self, vehicle_id: str, config: Optional[WiMeshConfig] = None, mesh_bus: Optional["MeshNetwork"] = None):
        self.vehicle_id = vehicle_id
        self.cfg = config or settings.wimesh
        self._serial = None
        self._bus = mesh_bus  # in-process simulation bus
        self._on_receive: Optional[Callable[[HazardAlertPacket], None]] = None
        self._seen_packet_ids: "OrderedDict[str, float]" = OrderedDict()

        if mesh_bus is None:
            try:
                import serial  # type: ignore

                self._serial = serial.Serial(self.cfg.serial_port, self.cfg.baud_rate, timeout=0.2)
            except Exception:
                self._serial = None  # caller should supply a mesh_bus for simulation

    @property
    def simulated(self) -> bool:
        return self._serial is None

    def on_receive(self, callback: Callable[[HazardAlertPacket], None]) -> None:
        """Register a callback invoked for every packet received (real
        radio or simulated bus alike)."""
        self._on_receive = callback
        if self._bus is not None:
            self._bus.subscribe(self.vehicle_id, self._handle_incoming)

    def broadcast(self, packet: HazardAlertPacket) -> None:
        """Send a packet over the air (or onto the simulated bus)."""
        if self._serial is not None:
            self._serial.write(packet.encode() + b"\n")
            return
        if self._bus is not None:
            self._bus.publish(self.vehicle_id, packet)
            return
        raise RuntimeError(
            "LoRaNode has neither a serial radio nor a mesh_bus — pass "
            "mesh_bus=MeshNetwork() for simulation, or connect a LoRa module."
        )

    def poll_serial(self) -> None:
        """For real hardware: call periodically to drain the UART
        buffer and dispatch any received packets. No-op in simulation
        mode (the bus delivers packets via callback instead)."""
        if self._serial is None:
            return
        while self._serial.in_waiting:
            line = self._serial.readline()
            if not line:
                break
            try:
                packet = HazardAlertPacket.decode(line)
            except Exception:
                continue
            self._handle_incoming(packet)

    def _already_seen(self, packet_id: str) -> bool:
        return packet_id in self._seen_packet_ids

    def _remember(self, packet_id: str) -> None:
        self._seen_packet_ids[packet_id] = time.time()
        self._seen_packet_ids.move_to_end(packet_id)
        while len(self._seen_packet_ids) > _SEEN_CACHE_SIZE:
            self._seen_packet_ids.popitem(last=False)

    def _handle_incoming(self, packet: HazardAlertPacket) -> None:
        if packet.vehicle_id == self.vehicle_id:
            return  # ignore our own broadcasts

        # Dedupe: the same logical alert keeps its packet_id across every
        # hop, so a node that has already processed/relayed it once must
        # not do so again — that's what turns a flood into a storm.
        first_time_seen = not self._already_seen(packet.packet_id)
        self._remember(packet.packet_id)

        if first_time_seen and self._on_receive:
            self._on_receive(packet)

        # Multi-hop relay: forward on only the first time we see it, and
        # only if it still has hops/TTL budget left.
        if first_time_seen and packet.can_relay():
            self.broadcast(packet.relayed())
