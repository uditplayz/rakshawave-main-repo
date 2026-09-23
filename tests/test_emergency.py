from software.core.emergency import EmergencyResponder
from software.wimesh.mesh_network import HazardClusterVerifier
from software.wimesh.protocol import HazardAlertPacket


def make_packet(vehicle_id, confidence=0.9, hazard_type="pothole"):
    return HazardAlertPacket.new_alert(
        vehicle_id=vehicle_id,
        hazard_type=hazard_type,
        confidence=confidence,
        latitude=18.5204,
        longitude=73.8567,
        speed_kmh=30.0,
    )


def test_escalated_cluster_with_impact_triggers_emergency():
    verifier = HazardClusterVerifier()
    broadcasts = []
    responder = EmergencyResponder(broadcast_fn=broadcasts.append)
    fired = []
    responder.on_emergency(fired.append)

    cluster = verifier.ingest(make_packet("VEH-001"))
    responder.evaluate(cluster, impact_confirmed=True)
    assert fired == []  # not escalated yet (only 1 vehicle)

    cluster = verifier.ingest(make_packet("VEH-002"))
    event = responder.evaluate(cluster, impact_confirmed=True)

    assert event is not None
    assert len(fired) == 1
    assert len(broadcasts) == 1
    assert broadcasts[0].vehicle_id == "MESH-COORDINATOR"


def test_escalated_cluster_without_impact_or_collision_type_is_not_emergency():
    verifier = HazardClusterVerifier()
    responder = EmergencyResponder()

    verifier.ingest(make_packet("VEH-001", hazard_type="crack"))
    cluster = verifier.ingest(make_packet("VEH-002", hazard_type="crack"))

    event = responder.evaluate(cluster, impact_confirmed=False)

    assert event is None


def test_emergency_is_only_fired_once_per_cluster():
    verifier = HazardClusterVerifier()
    responder = EmergencyResponder()
    fired = []
    responder.on_emergency(fired.append)

    verifier.ingest(make_packet("VEH-001"))
    cluster = verifier.ingest(make_packet("VEH-002"))

    responder.evaluate(cluster, impact_confirmed=True)
    responder.evaluate(cluster, impact_confirmed=True)

    assert len(fired) == 1
