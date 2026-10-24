"""Audio and button back ends for push-to-talk.

Hardware (Raspberry Pi 5 header, see the schematic):
    PTT button   GPIO17 to GND (internal pull-up)
    I2S mic      INMP441    GPIO18 BCLK, GPIO19 WS, GPIO20 DIN
    I2S speaker  MAX98357A  GPIO18 BCLK, GPIO19 LRC, GPIO21 DOUT

Back ends that need hardware (`sounddevice`, `gpiozero`) are imported lazily so
the rest of the stack, the tests and the simulator run without them. The sink
and source classes below work with plain numpy arrays and WAV files.
"""

from __future__ import annotations

import wave
from typing import Callable, Optional

import numpy as np

from software.voice.codec import SAMPLE_RATE


def resample_int(pcm: np.ndarray, src_rate: int, dst_rate: int = SAMPLE_RATE) -> np.ndarray:
    """Integer-ratio resampler (box filter down, linear up); enough for speech."""
    pcm = np.asarray(pcm)
    if src_rate == dst_rate:
        return pcm.astype(np.int16)
    if src_rate % dst_rate == 0:
        k = src_rate // dst_rate
        n = len(pcm) // k * k
        return pcm[:n].reshape(-1, k).astype(np.float32).mean(axis=1).astype(np.int16)
    if dst_rate % src_rate == 0:
        k = dst_rate // src_rate
        x = np.arange(len(pcm) * k) / k
        return np.interp(x, np.arange(len(pcm)), pcm.astype(np.float32)).astype(np.int16)
    raise ValueError(f"unsupported ratio {src_rate} -> {dst_rate}")


class WavSource:
    """Reads a mono 8 kHz (or integer-ratio) WAV file in `block`-sample chunks."""

    def __init__(self, path: str, block: int = 320 * 10):
        with wave.open(path, "rb") as w:
            if w.getsampwidth() != 2:
                raise ValueError("WAV must be 16-bit")
            ch, rate = w.getnchannels(), w.getframerate()
            data = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
        if ch > 1:
            data = data.reshape(-1, ch).mean(axis=1).astype(np.int16)
        self.pcm = resample_int(data, rate)
        self.block = block
        self._pos = 0

    def read(self) -> Optional[np.ndarray]:
        if self._pos >= len(self.pcm):
            return None
        chunk = self.pcm[self._pos : self._pos + self.block]
        self._pos += self.block
        return chunk


class WavSink:
    """Collects received audio and can write it to a WAV file."""

    def __init__(self):
        self.chunks: list[np.ndarray] = []

    def __call__(self, vehicle_id: str, pcm: np.ndarray) -> None:
        self.chunks.append(np.asarray(pcm, dtype=np.int16))

    @property
    def pcm(self) -> np.ndarray:
        return np.concatenate(self.chunks) if self.chunks else np.zeros(0, dtype=np.int16)

    def save(self, path: str) -> None:
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(SAMPLE_RATE)
            w.writeframes(self.pcm.tobytes())


class SoundDeviceMic:  # pragma: no cover - needs audio hardware
    """Microphone via sounddevice; resamples from the device rate to 8 kHz."""

    def __init__(self, device=None, device_rate: int = 48000, block_s: float = 0.2):
        import sounddevice as sd  # type: ignore

        self._rate = device_rate
        self._stream = sd.InputStream(samplerate=device_rate, channels=1, dtype="int16", device=device,
                                      blocksize=int(device_rate * block_s))

    def start(self) -> None:
        self._stream.start()

    def stop(self) -> None:
        self._stream.stop()

    def read(self) -> np.ndarray:
        data, _overflow = self._stream.read(self._stream.blocksize)
        return resample_int(data[:, 0], self._rate)


class SoundDeviceSpeaker:  # pragma: no cover - needs audio hardware
    def __init__(self, device=None, device_rate: int = 48000):
        import sounddevice as sd  # type: ignore

        self._rate = device_rate
        self._stream = sd.OutputStream(samplerate=device_rate, channels=1, dtype="int16", device=device)
        self._stream.start()

    def __call__(self, vehicle_id: str, pcm: np.ndarray) -> None:
        self._stream.write(resample_int(pcm, SAMPLE_RATE, self._rate).reshape(-1, 1))


class GpioButton:  # pragma: no cover - needs a Raspberry Pi
    """Push button on a GPIO (default GPIO17, wired to GND)."""

    def __init__(self, on_press: Callable[[], None], on_release: Callable[[], None], pin: int = 17):
        from gpiozero import Button  # type: ignore

        self._button = Button(pin, pull_up=True, bounce_time=0.03)
        self._button.when_pressed = on_press
        self._button.when_released = on_release
