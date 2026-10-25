"""Push-to-talk over LoRa: transmitter, receiver and the half-duplex controller.

Flow
    key down  -> PttTransmitter.start()   new stream id
    mic audio -> push_audio(pcm)          Codec2 frames buffered, one VoicePacket per
                                          `frames_per_packet` frames (default 20 = 0.8 s)
    key up    -> stop()                   remaining frames + a final chunk (last=True)

    LoRaNode -> PttReceiver.handle(pkt)   re-orders by seq, conceals lost chunks with
                                          silence after a short jitter wait, plays in order

Budget at SF7 / 125 kHz: 20 frames = 80 B of speech -> ~200 B JSON frame -> ~0.35 s
of airtime per 0.8 s of speech, so one talker uses roughly 45 % of the channel.
That is why PTT is half duplex, limited to `max_talk_s`, and never relayed by default.
"""

from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Dict, List, Optional

import numpy as np

from software.voice.codec import FRAME_BYTES, FRAME_SAMPLES, SAMPLE_RATE, VoiceCodec
from software.wimesh.protocol import VoicePacket

DEFAULT_FRAMES_PER_PACKET = 20
MAX_TALK_S = 30.0


class PttState(str, Enum):
    IDLE = "idle"
    TX = "tx"
    RX = "rx"


class PttTransmitter:
    def __init__(
        self,
        vehicle_id: str,
        send: Callable[[VoicePacket], None],
        codec: Optional[VoiceCodec] = None,
        frames_per_packet: int = DEFAULT_FRAMES_PER_PACKET,
        max_talk_s: float = MAX_TALK_S,
        max_hops: Optional[int] = None,
    ):
        self.vehicle_id = vehicle_id
        self._send = send
        self.codec = codec or VoiceCodec()
        self.frames_per_packet = frames_per_packet
        self.max_talk_s = max_talk_s
        self._max_hops = max_hops
        self._stream_id: Optional[str] = None
        self._seq = 0
        self._pcm = np.zeros(0, dtype=np.int16)
        self._pending = b""
        self._samples_encoded = 0
        self.packets_sent = 0

    @property
    def active(self) -> bool:
        return self._stream_id is not None

    def start(self) -> str:
        if self.active:
            raise RuntimeError("already transmitting")
        self._stream_id = uuid.uuid4().hex[:6]
        self._seq = 0
        self._pcm = np.zeros(0, dtype=np.int16)
        self._pending = b""
        self._samples_encoded = 0
        return self._stream_id

    def push_audio(self, pcm: np.ndarray) -> bool:
        """Feed microphone samples. Returns False once the talk-time limit ends the stream."""
        if not self.active:
            raise RuntimeError("push_audio() before start()")
        self._pcm = np.concatenate([self._pcm, np.asarray(pcm, dtype=np.int16)])
        whole = len(self._pcm) // FRAME_SAMPLES * FRAME_SAMPLES
        if whole:
            self._pending += self.codec.encode(self._pcm[:whole])
            self._samples_encoded += whole
            self._pcm = self._pcm[whole:]
        chunk = self.frames_per_packet * FRAME_BYTES
        while len(self._pending) >= chunk:
            self._emit(self._pending[:chunk], last=False)
            self._pending = self._pending[chunk:]
        if self._samples_encoded / SAMPLE_RATE >= self.max_talk_s:
            self.stop()
            return False
        return True

    def stop(self) -> None:
        if not self.active:
            return
        tail = self._pending
        if len(self._pcm):
            tail += self.codec.encode(self._pcm)
        self._emit(tail, last=True)
        self._stream_id = None
        self._pending = b""
        self._pcm = np.zeros(0, dtype=np.int16)

    def _emit(self, payload: bytes, last: bool) -> None:
        kwargs = {} if self._max_hops is None else {"max_hops": self._max_hops}
        pkt = VoicePacket(
            vehicle_id=self.vehicle_id, stream_id=self._stream_id, seq=self._seq, payload=payload, last=last, **kwargs
        )
        pkt.encode()  # fail early if it would not fit a LoRa frame
        self._seq += 1
        self.packets_sent += 1
        self._send(pkt)


@dataclass
class _Stream:
    vehicle_id: str
    next_seq: int = 0
    chunks: Dict[int, VoicePacket] = field(default_factory=dict)
    last_seq: Optional[int] = None
    chunk_samples: int = DEFAULT_FRAMES_PER_PACKET * FRAME_SAMPLES
    gap_since: Optional[float] = None
    updated: float = 0.0
    played_samples: int = 0
    lost_chunks: int = 0
    received_chunks: int = 0
    done: bool = False
    timed_out: bool = False  # ended because the key-up chunk never arrived


class PttReceiver:
    """Re-orders and plays voice chunks. `clock` is injectable for tests."""

    def __init__(
        self,
        sink: Callable[[str, np.ndarray], None],
        codec: Optional[VoiceCodec] = None,
        jitter_s: float = 1.0,
        idle_timeout_s: float = 3.0,
        clock: Callable[[], float] = time.monotonic,
    ):
        self._sink = sink
        self.codec = codec or VoiceCodec()
        self.jitter_s = jitter_s
        self.idle_timeout_s = idle_timeout_s
        self._clock = clock
        self.streams: Dict[str, _Stream] = {}

    def receiving(self) -> bool:
        """True while a stream from someone else is in progress (channel busy)."""
        self.poll()
        return any(not s.done for s in self.streams.values())

    def handle(self, pkt: VoicePacket) -> None:
        st = self.streams.setdefault(pkt.stream_id, _Stream(vehicle_id=pkt.vehicle_id))
        if st.done or pkt.seq < st.next_seq or pkt.seq in st.chunks:
            return  # duplicate / too late
        st.chunks[pkt.seq] = pkt
        st.received_chunks += 1
        st.updated = self._clock()
        if not pkt.last and len(pkt.payload) >= FRAME_BYTES:
            st.chunk_samples = len(pkt.payload) // FRAME_BYTES * FRAME_SAMPLES
        if pkt.last:
            st.last_seq = pkt.seq
        self._drain(pkt.stream_id)

    def poll(self) -> None:
        """Call periodically: gives up on gaps after the jitter wait and ends idle streams."""
        now = self._clock()
        for sid, st in list(self.streams.items()):
            if st.done:
                continue
            if st.chunks and st.next_seq not in st.chunks:
                if st.gap_since is None:
                    st.gap_since = now
                if now - st.gap_since >= self.jitter_s:
                    self._conceal(sid)
            elif now - st.updated >= self.idle_timeout_s:
                st.done = True  # the last chunk (key-up) was lost: end the stream
                st.timed_out = True

    # -- internals ---------------------------------------------------------------
    def _drain(self, sid: str) -> None:
        st = self.streams[sid]
        while st.next_seq in st.chunks:
            pkt = st.chunks.pop(st.next_seq)
            pcm = self.codec.decode(pkt.payload)
            st.played_samples += len(pcm)
            st.next_seq += 1
            st.gap_since = None
            if len(pcm):
                self._sink(st.vehicle_id, pcm)
            if st.last_seq is not None and pkt.seq == st.last_seq:
                st.done = True
                return

    def _conceal(self, sid: str) -> None:
        st = self.streams[sid]
        silence = np.zeros(st.chunk_samples, dtype=np.int16)
        st.lost_chunks += 1
        st.played_samples += len(silence)
        st.next_seq += 1
        st.gap_since = None
        self._sink(st.vehicle_id, silence)
        self._drain(sid)
        if not st.done and st.chunks and st.next_seq not in st.chunks:
            st.gap_since = self._clock()

    def stats(self) -> List[dict]:
        return [
            {
                "stream_id": sid,
                "from": st.vehicle_id,
                "received_chunks": st.received_chunks,
                "lost_chunks": st.lost_chunks,
                "played_s": round(st.played_samples / SAMPLE_RATE, 2),
                "complete": st.done and st.lost_chunks == 0 and not st.timed_out,
                "ended": st.done,
            }
            for sid, st in self.streams.items()
        ]


class PttController:
    """Half-duplex push-to-talk: one button, one radio, one speaker.

    press()   -> start transmitting, unless someone else is talking (channel busy)
    audio()   -> feed mic samples while the key is down
    release() -> end the transmission
    """

    def __init__(self, transmitter: PttTransmitter, receiver: PttReceiver):
        self.tx = transmitter
        self.rx = receiver

    @property
    def state(self) -> PttState:
        if self.tx.active:
            return PttState.TX
        return PttState.RX if self.rx.receiving() else PttState.IDLE

    def press(self) -> bool:
        if self.state != PttState.IDLE:
            return False  # busy: do not talk over the other vehicle
        self.tx.start()
        return True

    def audio(self, pcm: np.ndarray) -> bool:
        return self.tx.active and self.tx.push_audio(pcm)

    def release(self) -> None:
        self.tx.stop()

    def on_voice(self, pkt: VoicePacket) -> None:
        if self.tx.active:
            return  # half duplex: we are talking, drop incoming audio
        self.rx.handle(pkt)
