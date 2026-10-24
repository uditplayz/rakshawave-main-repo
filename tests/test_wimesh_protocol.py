from software.wimesh.protocol import HazardAlertPacket, PacketType
from software.wimesh.mesh_network import HazardClusterVerifier, MeshNetwork


def make_packet(vehicle_id="VEH-001", lat=18.5204, lon=73.8567, confidence=0.8):
    return HazardAlertPacket.new_alert(
        vehicle_id=vehicle_id,
        hazard_type="pothole",
        confidence=confidence,
        latitude=lat,
        longitude=lon,
        speed_kmh=30.0,
    )


def test_packet_round_trips_through_encode_decode():
    packet = make_packet()
    decoded = HazardAlertPacket.decode(packet.encode())

    assert decoded.packet_id == packet.packet_id
    assert decoded.vehicle_id == packet.vehicle_id
    assert decoded.hazard_type == packet.hazard_type
    assert abs(decoded.latitude - packet.latitude) < 1e-6


def test_relay_increments_hop_and_respects_max_hops():
    packet = make_packet()
    assert packet.hop_count == 0
    assert packet.can_relay() is True

    relayed = packet.relayed()
    assert relayed.hop_count == 1
    assert relayed.packet_id == packet.packet_id  # same logical alert

    packet.hop_count = packet.max_hops
    assert packet.can_relay() is False


def test_mesh_network_does_not_echo_to_sender():
    mesh = MeshNetwork()
    received = []
    mesh.subscribe("VEH-002", lambda p: received.append(p))
    mesh.subscribe("VEH-001", lambda p: received.append(("self", p)))  # would fail if echoed

    packet = make_packet(vehicle_id="VEH-001")
    mesh.publish("VEH-001", packet)

    assert len(received) == 1
    assert received[0].vehicle_id == "VEH-001"


def test_cluster_verifier_escalates_after_min_corroborations():
    verifier = HazardClusterVerifier()
    escalated = []
    verifier.on_escalate(lambda c: escalated.append(c))

    p1 = make_packet(vehicle_id="VEH-001")
    p2 = make_packet(vehicle_id="VEH-002")  # same location -> same cluster

    cluster1 = verifier.ingest(p1)
    assert cluster1.escalated is False
    assert len(escalated) == 0

    cluster2 = verifier.ingest(p2)
    assert cluster2.cluster_id == cluster1.cluster_id
    assert cluster2.escalated is True
    assert len(escalated) == 1


def test_cluster_verifier_keeps_distant_reports_separate():
    verifier = HazardClusterVerifier()

    near = make_packet(vehicle_id="VEH-001", lat=18.5204, lon=73.8567)
    far = make_packet(vehicle_id="VEH-002", lat=18.60, lon=73.95)  # >> cluster_radius_m away

    c1 = verifier.ingest(near)
    c2 = verifier.ingest(far)

    assert c1.cluster_id != c2.cluster_id


ESP32_LINE = (
    b'{"id":"123456-VEH-ESP32-01","t":"HAZARD_ALERT","veh":"VEH-ESP32-01","hz":"unknown_hazard",'
    b'"c":0.85,"lat":18.5204,"lon":73.8567,"spd":42.0,"hop":0,"mh":5,"ttl":30.0,"oid":null,"ts":123.456}'
)


def test_esp32_relative_ttl_is_rebased_to_wall_clock():
    import time

    before = time.time()
    packet = HazardAlertPacket.decode(ESP32_LINE)

    assert packet.is_expired() is False
    assert before + 29.0 <= packet.ttl_expires_at <= time.time() + 30.0
    assert packet.created_at >= before  # uptime "ts" is restamped
    assert packet.can_relay() is True


def test_absolute_epoch_ttl_is_left_untouched():
    packet = make_packet()
    decoded = HazardAlertPacket.decode(packet.encode())

    assert abs(decoded.ttl_expires_at - packet.ttl_expires_at) < 0.1
