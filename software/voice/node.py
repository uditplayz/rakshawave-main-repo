"""Push-to-talk node for the Raspberry Pi: button + mic + speaker + ESP32 LoRa modem.

    python -m software.voice.node                 # real hardware
    python -m software.voice.node --port COM5     # pick the ESP32 serial port

The ESP32 is only the LoRa modem for voice: every VoicePacket line written to its
USB serial port is transmitted, every LoRa voice frame it hears is printed back.
"""

from __future__ import annotations

import argparse
import threading
import time

from software.config import settings
from software.voice.audio import GpioButton, SoundDeviceMic, SoundDeviceSpeaker
from software.voice.ptt import PttController, PttReceiver, PttTransmitter
from software.wimesh.lora_node import LoRaNode


def main() -> None:  # pragma: no cover - needs hardware
    ap = argparse.ArgumentParser()
    ap.add_argument("--vehicle-id", default=settings.vehicle_id)
    ap.add_argument("--port", default=settings.wimesh.serial_port)
    args = ap.parse_args()

    from dataclasses import replace

    radio = LoRaNode(args.vehicle_id, config=replace(settings.wimesh, serial_port=args.port))
    if radio.simulated:
        raise SystemExit(f"could not open the ESP32 serial port {args.port}")

    speaker = SoundDeviceSpeaker()
    mic = SoundDeviceMic()
    ptt = PttController(PttTransmitter(args.vehicle_id, radio.broadcast), PttReceiver(speaker))
    radio.on_voice(ptt.on_voice)

    keyed = threading.Event()

    def press():
        if ptt.press():
            keyed.set()
            mic.start()
            print("PTT: transmitting")
        else:
            print("PTT: channel busy")

    def release():
        if keyed.is_set():
            keyed.clear()
            mic.stop()
            ptt.release()
            print("PTT: released")

    GpioButton(press, release)
    print(f"PTT ready on {args.port} as {args.vehicle_id}; hold the button to talk")
    while True:
        radio.poll_serial()
        ptt.rx.poll()
        if keyed.is_set():
            ptt.audio(mic.read())
        else:
            time.sleep(0.02)


if __name__ == "__main__":
    main()
