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
