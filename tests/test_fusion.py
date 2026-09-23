import time

from software.sensors.fusion import SensorFusion
from software.sensors.gps import GPSFix
from software.sensors.imu import IMUSample
from software.vision.hazard_detector import HazardDetection, HazardType


def make_gps(reliable=True):
    return GPSFix(
        latitude=18.5204,
        longitude=73.8567,
        speed_kmh=32.0,
        course_deg=90.0,
        hdop=1.0 if reliable else 9.0,
        satellites=8 if reliable else 2,
    )


def make_detection(confidence=0.8):
    return HazardDetection(
        hazard_type=HazardType.POTHOLE,
        confidence=confidence,
        bbox=(10, 10, 40, 40),
        area_px=1600,
        circularity=0.7,
    )


def test_vision_plus_impact_is_verified():
    fusion = SensorFusion(vehicle_id="VEH-TEST")
    fusion.observe_vision(make_detection(0.8))
    fusion.observe_imu(IMUSample(accel_g=(1, 1, 3), gyro_dps=(200, 0, 0)))

    event = fusion.fuse(make_gps(reliable=True))

    assert event is not None
    assert event.impact_confirmed is True
    assert event.is_verified is True


def test_vision_only_is_not_necessarily_verified():
    fusion = SensorFusion(vehicle_id="VEH-TEST")
    fusion.observe_vision(make_detection(0.5))
    # No IMU impact observed.

    event = fusion.fuse(make_gps(reliable=True))

    assert event is not None
    assert event.impact_confirmed is False
    assert event.fused_confidence < 0.8


def test_no_vision_detection_returns_none():
    fusion = SensorFusion(vehicle_id="VEH-TEST")
    fusion.observe_imu(IMUSample(accel_g=(1, 1, 3), gyro_dps=(200, 0, 0)))

    event = fusion.fuse(make_gps())

    assert event is None


def test_stale_detection_outside_confirmation_window_is_dropped():
    fusion = SensorFusion(vehicle_id="VEH-TEST")
    fusion.observe_vision(make_detection(0.9))
    fusion._pending_vision = (fusion._pending_vision[0], time.time() - 999)

    event = fusion.fuse(make_gps())

    assert event is None
