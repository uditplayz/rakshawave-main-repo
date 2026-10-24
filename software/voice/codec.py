"""Codec2 700C wrapper.

700C packs 40 ms of 8 kHz speech into 4 bytes (about 800 bps once byte aligned),
which is what makes voice fit a SF7 LoRa link at all. No fallback codec is
provided on purpose: anything wider than Codec2 would not fit the radio, so a
silent substitute would hide a real failure.

Install: `pip install pycodec2` (needs libcodec2 on Linux: `apt install libcodec2-dev`).
"""

from __future__ import annotations

import numpy as np

SAMPLE_RATE = 8000
MODE = 700  # Codec2 700C
FRAME_SAMPLES = 320
FRAME_BYTES = 4
FRAME_MS = FRAME_SAMPLES * 1000 // SAMPLE_RATE  # 40


class VoiceCodec:
    def __init__(self):
        try:
            import pycodec2  # type: ignore
        except ImportError as exc:  # pragma: no cover - environment dependent
            raise ImportError("push-to-talk needs the Codec2 binding: pip install pycodec2") from exc
        self._c2 = pycodec2.Codec2(MODE)
        if self._c2.samples_per_frame() != FRAME_SAMPLES or self._c2.bytes_per_frame() != FRAME_BYTES:
            raise RuntimeError("unexpected Codec2 700C frame size")

    def encode(self, pcm: np.ndarray) -> bytes:
        """int16 mono 8 kHz samples -> Codec2 frames (a partial last frame is zero padded)."""
        pcm = np.asarray(pcm, dtype=np.int16)
        rem = len(pcm) % FRAME_SAMPLES
        if rem:
            pcm = np.concatenate([pcm, np.zeros(FRAME_SAMPLES - rem, dtype=np.int16)])
        return b"".join(bytes(self._c2.encode(pcm[i : i + FRAME_SAMPLES])) for i in range(0, len(pcm), FRAME_SAMPLES))

    def decode(self, data: bytes) -> np.ndarray:
        """Codec2 frames -> int16 samples (trailing partial frame bytes are ignored)."""
        n = len(data) // FRAME_BYTES
        if n == 0:
            return np.zeros(0, dtype=np.int16)
        return np.concatenate(
            [np.asarray(self._c2.decode(data[i * FRAME_BYTES : (i + 1) * FRAME_BYTES]), dtype=np.int16) for i in range(n)]
        )
