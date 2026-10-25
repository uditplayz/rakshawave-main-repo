"""The hardware lab (hardware/lab): real firmware on emulated boards.

The lab's own suite is JavaScript (node --test); this runs it from pytest when
Node.js is installed, and checks the Pi-side contract that changed with it.
"""

import shutil
import subprocess
from pathlib import Path

import pytest

from software.wimesh.lora_node import LoRaNode
from software.wimesh.mesh_network import MeshNetwork
from software.wimesh.protocol import HazardAlertPacket

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js not installed")
def test_lab_suite_passes():
    r = subprocess.run(["node", "--test", str(ROOT / "hardware/lab/test/lab.test.mjs")],
                       capture_output=True, text=True, timeout=600)
    assert r.returncode == 0, r.stdout[-4000:] + r.stderr[-2000:]


def test_serial_modem_relays_so_the_pi_does_not():
    packet = HazardAlertPacket.new_alert("VEH-A", "pothole", 0.9, 28.46, 77.03, 40.0)

    class FakeSerial:
        def __init__(self):
            self.lines = [packet.encode() + b"\n"]
            self.written = []

        @property
        def in_waiting(self):
            return len(self.lines)

        def readline(self):
            return self.lines.pop(0)

        def write(self, b):
            self.written.append(b)

    radio = LoRaNode("VEH-B", mesh_bus=MeshNetwork())
    radio._serial = FakeSerial()
    got = []
    radio.on_receive(got.append)
    radio.poll_serial()

    assert [p.packet_id for p in got] == [packet.packet_id]
    assert radio._serial.written == []  # the ESP32 firmware already relayed it
