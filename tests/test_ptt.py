import json

import numpy as np
import pytest

from software.voice import FRAME_BYTES, FRAME_SAMPLES, PttController, PttReceiver, PttState, PttTransmitter
from software.wimesh.lora_node import LoRaNode
from software.wimesh.mesh_network import MeshNetwork
from software.wimesh.protocol import LORA_MAX_FRAME_BYTES, VoicePacket, decode_packet

RATE = 8000


def speech_like(seconds: float) -> np.ndarray:
    t = np.arange(int(RATE * seconds)) / RATE
    return (6000 * np.sin(2 * np.pi * 220 * t) * (0.6 + 0.4 * np.sin(2 * np.pi * 2 * t))).astype(np.int16)


def talk(seconds: float = 3.0, vehicle_id: str = "VEH-A") -> list:
    sent: list = []
    tx = PttTransmitter(vehicle_id, sent.append)
    tx.start()
    tx.push_audio(speech_like(seconds))
    tx.stop()
    return sent


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def make_rx(**kw):
    out: list = []
    clock = Clock()
    rx = PttReceiver(lambda vid, pcm: out.append(pcm), clock=clock, **kw)
    return rx, out, clock


def test_voice_packet_round_trip_fits_a_lora_frame():
    pkt = talk(1.0)[0]
    raw = pkt.encode()

    assert len(raw) <= LORA_MAX_FRAME_BYTES
    back = decode_packet(raw)
    assert isinstance(back, VoicePacket)
    assert back.payload == pkt.payload and back.stream_id == pkt.stream_id and back.seq == pkt.seq
    assert back.is_expired() is False  # relative ttl was rebased
    assert json.loads(raw)["t"] == "VOICE"


def test_voice_is_not_relayed_by_default():
    assert talk(1.0)[0].can_relay() is False


def test_oversized_voice_packet_is_rejected():
    big = VoicePacket(vehicle_id="V", stream_id="abc123", seq=0, payload=bytes(200))
    with pytest.raises(ValueError):
        big.encode()


def test_transmit_chunks_and_final_marker():
    sent = talk(3.0)
    assert [p.seq for p in sent] == [0, 1, 2, 3]
    assert [p.last for p in sent] == [False, False, False, True]
    assert len({p.stream_id for p in sent}) == 1
    assert sum(len(p.payload) for p in sent) == 3 * RATE // FRAME_SAMPLES * FRAME_BYTES * 1  # 75 frames * 4 B


def test_receiver_plays_the_whole_transmission_in_order():
    rx, out, _ = make_rx()
    for pkt in talk(3.0):
        rx.handle(VoicePacket.decode(pkt.encode()))

    pcm = np.concatenate(out)
    assert len(pcm) == 3 * RATE
    assert np.abs(pcm).max() > 1000  # it is audio, not silence
    stat = rx.stats()[0]
    assert stat["complete"] and stat["lost_chunks"] == 0 and stat["played_s"] == 3.0


def test_out_of_order_chunks_are_reordered():
    rx, out, _ = make_rx()
    pkts = talk(3.0)
    for pkt in [pkts[1], pkts[0], pkts[3], pkts[2]]:
        rx.handle(pkt)

    assert len(np.concatenate(out)) == 3 * RATE
    assert rx.stats()[0]["lost_chunks"] == 0


def test_duplicates_are_ignored():
    rx, out, _ = make_rx()
    for pkt in talk(2.0) * 2:
        rx.handle(pkt)

    assert len(np.concatenate(out)) == 2 * RATE


def test_lost_chunk_is_concealed_after_the_jitter_wait():
    rx, out, clock = make_rx(jitter_s=1.0)
    pkts = talk(3.0)
    for pkt in [pkts[0], pkts[2], pkts[3]]:  # chunk 1 never arrives
        rx.handle(pkt)
    assert len(np.concatenate(out)) == int(0.8 * RATE)  # waiting for the gap to fill

    clock.t = 0.5
    rx.poll()
    assert len(np.concatenate(out)) == int(0.8 * RATE)  # still inside the jitter window

    clock.t = 1.5
    rx.poll()
    pcm = np.concatenate(out)
    assert len(pcm) == 3 * RATE  # gap filled with silence, the rest played
    assert not pcm[int(0.8 * RATE) : int(1.6 * RATE)].any()
    stat = rx.stats()[0]
    assert stat["lost_chunks"] == 1 and stat["complete"] is False and stat["ended"] is True


def test_stream_ends_when_the_final_chunk_is_lost():
    rx, out, clock = make_rx(idle_timeout_s=3.0)
    for pkt in talk(3.0)[:3]:
        rx.handle(pkt)
    assert rx.receiving() is True

    clock.t = 5.0
    assert rx.receiving() is False  # channel is free again


def test_talk_time_limit_stops_the_stream():
    sent: list = []
    tx = PttTransmitter("VEH-A", sent.append, max_talk_s=2.0)
    tx.start()
    keep_going = tx.push_audio(speech_like(3.0))

    assert keep_going is False and tx.active is False
    assert sent[-1].last is True


def test_half_duplex_press_is_refused_while_receiving():
    rx, out, _ = make_rx()
    sent: list = []
    ptt = PttController(PttTransmitter("VEH-B", sent.append), rx)
    ptt.on_voice(talk(3.0, "VEH-A")[0])  # someone else is mid-sentence

    assert ptt.state == PttState.RX
    assert ptt.press() is False
    assert sent == []


def test_incoming_audio_is_dropped_while_transmitting():
    rx, out, _ = make_rx()
    ptt = PttController(PttTransmitter("VEH-B", lambda p: None), rx)
    assert ptt.press() is True and ptt.state == PttState.TX
    ptt.on_voice(talk(1.0, "VEH-A")[0])

    assert out == [] and rx.streams == {}
    ptt.release()
    assert ptt.state == PttState.IDLE


def test_voice_travels_between_vehicles_on_the_mesh_bus():
    mesh = MeshNetwork()
    a, b = LoRaNode("VEH-A", mesh_bus=mesh), LoRaNode("VEH-B", mesh_bus=mesh)
    hazards: list = []
    b.on_receive(hazards.append)
    a.on_receive(lambda p: None)
    rx, out, _ = make_rx()
    b.on_voice(PttController(PttTransmitter("VEH-B", b.broadcast), rx).on_voice)

    tx = PttTransmitter("VEH-A", a.broadcast)
    tx.start()
    tx.push_audio(speech_like(2.0))
    tx.stop()

    assert len(np.concatenate(out)) == 2 * RATE
    assert hazards == []  # voice never reaches the hazard pipeline
    assert len(mesh.packet_log) == tx.packets_sent  # not relayed


def test_serial_modem_path_decodes_voice_lines():
    pkts = talk(1.0)
    lines = [p.encode() + b"\n" for p in pkts] + [b"MPU6050 ok\n", b"{not json\n"]

    class FakeSerial:
        def __init__(self):
            self.lines = list(lines)

        @property
        def in_waiting(self):
            return len(self.lines)

        def readline(self):
            return self.lines.pop(0)

    radio = LoRaNode("VEH-B", mesh_bus=MeshNetwork())
    radio._serial = FakeSerial()
    got: list = []
    radio.on_voice(got.append)
    radio.poll_serial()

    assert [p.seq for p in got] == [p.seq for p in pkts]
