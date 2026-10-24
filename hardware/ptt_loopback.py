"""
Hear what push-to-talk sounds like without any hardware.

    python hardware/ptt_loopback.py in.wav out.wav [--loss 0.1]

Reads a 16-bit WAV (mono or stereo, 8 kHz or 16/24/32/48 kHz), runs it through the real
transmit path (Codec2 700C, 0.8 s VoicePackets), drops a fraction of the packets like a lossy
radio, and plays the result back through the real receive path (re-order, silence for gaps).
Open out.wav in any player. Speech, not music: Codec2 is a speech codec.
"""

from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from software.voice import PttReceiver, PttTransmitter  # noqa: E402
from software.voice.audio import WavSink, WavSource  # noqa: E402
from software.wimesh.protocol import VoicePacket  # noqa: E402


class Clock:
    t = 0.0

    def __call__(self):
        return self.t


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("src")
    ap.add_argument("dst")
    ap.add_argument("--loss", type=float, default=0.0, help="fraction of packets lost, 0..1")
    ap.add_argument("--seed", type=int, default=1)
    args = ap.parse_args()

    pcm = WavSource(args.src, block=10**9).pcm
    packets: list[VoicePacket] = []
    tx = PttTransmitter("VEH-A", packets.append, max_talk_s=10**6)
    tx.start()
    tx.push_audio(pcm)
    tx.stop()

    rng = random.Random(args.seed)
    clock, sink = Clock(), WavSink()
    rx = PttReceiver(sink, clock=clock)
    kept = 0
    for pkt in packets:
        if rng.random() < args.loss and not pkt.last:
            continue
        rx.handle(VoicePacket.decode(pkt.encode()))  # through the real wire format
        kept += 1
    clock.t += 10  # let the jitter window expire so gaps are filled with silence
    rx.poll()
    sink.save(args.dst)

    st = rx.stats()[0]
    print(f"{len(pcm) / 8000:.1f} s in -> {len(packets)} packets ({kept} delivered, {st['lost_chunks']} concealed) "
          f"-> {st['played_s']} s out: {args.dst}")


if __name__ == "__main__":
    main()
