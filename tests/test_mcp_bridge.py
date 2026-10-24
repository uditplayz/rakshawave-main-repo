import pytest

from software import mcp_bridge as bridge

ESP32_LINE = (
    '{"id":"123456-VEH-ESP32-01","t":"HAZARD_ALERT","veh":"VEH-ESP32-01","hz":"unknown_hazard",'
    '"c":0.85,"lat":18.5204,"lon":73.8567,"spd":41.7,"hop":0,"mh":5,"ttl":30.0,"oid":null,"ts":123.456}'
)


@pytest.fixture(autouse=True)
def fresh_bench():
    bridge.reset_bench()
    yield
    bridge.reset_bench()


def test_synthetic_pothole_is_detected():
    result = bridge.run_vision_detector("pothole")
    assert result["detected"] and result["hazard_type"] == "pothole"
    assert 0.45 <= result["confidence"] <= 1.0
    assert result["circularity"] > 0.35


def test_unknown_synthetic_type_is_an_error():
    assert bridge.run_vision_detector("nonsense")["ok"] is False


def test_esp32_packet_is_fused_and_broadcast_once():
    bridge.run_vision_detector("pothole")
    result = bridge.fuse_and_ingest_esp32_serial("MPU6050 ok\n" + ESP32_LINE, 0.88)

    assert result["verified"] is True
    assert result["broadcast"]["hazard_type"] == "pothole"
    assert result["broadcast"]["transmissions"] == 1
    assert result["clusters"][0]["escalated"] is False  # one vehicle is never enough


def test_low_vision_confidence_is_not_broadcast():
    result = bridge.fuse_and_ingest_esp32_serial(ESP32_LINE.replace('"c":0.85', '"c":0.5'), 0.0)
    assert result["verified"] is False
    assert "broadcast" not in result


def test_peer_12m_away_escalates_cluster_within_40m():
    bridge.run_vision_detector("pothole")
    bridge.fuse_and_ingest_esp32_serial(ESP32_LINE, 0.88)
    peer = bridge.simulate_corroborating_peer("VEH-002", "pothole", 18.5204, 73.8567, 12)

    assert peer["distance_to_reported_m"] == pytest.approx(12, abs=0.1)
    cluster = peer["clusters"][0]
    assert cluster["cluster_id"] == "CL-0001"
    assert cluster["escalated"] is True
    assert cluster["corroborating_vehicles"] == ["VEH-002", "VEH-ESP32-01"]


def test_peer_beyond_40m_does_not_join_the_cluster():
    bridge.run_vision_detector("pothole")
    bridge.fuse_and_ingest_esp32_serial(ESP32_LINE, 0.88)
    peer = bridge.simulate_corroborating_peer("VEH-002", "pothole", 18.5204, 73.8567, 60)

    assert len(peer["clusters"]) == 2
    assert all(not c["escalated"] for c in peer["clusters"])


def test_dedup_and_hop_cap_across_a_relay_chain():
    bridge.add_relay_nodes(8, 1000, 18.5204, 73.8567)
    bridge.fuse_and_ingest_esp32_serial(ESP32_LINE, 0.88)
    state = bridge.get_mesh_state()

    packet = state["packets"]["123456-VEH-ESP32-01"]
    assert state["max_hop_observed"] == 5
    assert all(count == 1 for count in packet["hops"].values())  # one transmission per hop
    assert packet["storm_free"] is True


def test_mcp_server_registers_all_tools():
    import asyncio

    tools = asyncio.run(bridge.build_server().list_tools())
    names = {t.name for t in tools}
    assert {"run_vision_detector", "fuse_and_ingest_esp32_serial", "simulate_corroborating_peer", "get_mesh_state"} <= names


def test_corroborated_pothole_escalates_cluster_but_not_emergency():
    bridge.run_vision_detector("pothole")
    bridge.fuse_and_ingest_esp32_serial(ESP32_LINE, 0.88)
    peer = bridge.simulate_corroborating_peer("VEH-002", "pothole", 18.5204, 73.8567, 12)

    assert peer["clusters"][0]["escalated"] is True
    assert peer["emergencies"] == []
    assert bridge.get_mesh_state()["emergency_broadcasts"] == []


def test_corroborated_debris_raises_emergency_broadcast():
    bridge.simulate_corroborating_peer("VEH-001", "debris", 18.5204, 73.8567, 0)
    peer = bridge.simulate_corroborating_peer("VEH-002", "debris", 18.5204, 73.8567, 12)

    assert len(peer["emergencies"]) == 1
    assert len(bridge.get_mesh_state()["emergency_broadcasts"]) == 1


def test_ptt_reaches_a_vehicle_in_range_and_not_one_out_of_range():
    bridge.simulate_corroborating_peer("VEH-NEAR", "pothole", 18.5204, 73.8567, 300)  # registers a listener ~300 m away
    bridge.simulate_corroborating_peer("VEH-FAR", "pothole", 18.5204, 73.8567, 9000)  # far outside the 1.5 km range
    result = bridge.ptt_talk("VEH-A", 18.5204, 73.8567, seconds=3.0)

    assert result["ok"] and result["packets"] == 4
    assert result["max_frame_bytes"] <= 255
    near, far = result["listeners"]["VEH-NEAR"], result["listeners"]["VEH-FAR"]
    assert near["complete"] and near["audible"] and near["played_s"] == 3.0
    assert far["received_chunks"] == 0 and far["audible"] is False
    # voice is local: it was not relayed, so no extra transmissions
    assert len([x for x in bridge.get_mesh_state()["tx_log"] if x["type"] == "VOICE"]) == 4


def test_ptt_rejects_a_bad_source_and_leaves_the_key_up():
    result = bridge.ptt_talk("VEH-A", 18.5204, 73.8567, source="no-such-file.wav")
    assert result["ok"] is False
    assert bridge.ptt_state()["VEH-A"]["state"] == "idle"


def test_mcp_server_exposes_ptt_tools():
    import asyncio

    names = {t.name for t in asyncio.run(bridge.build_server().list_tools())}
    assert {"ptt_talk", "ptt_state"} <= names
