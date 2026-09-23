"""
Central configuration for the RakshaWave Smart Road Sentinel node.

All thresholds here map directly to the pitch-deck numbers (SIH26220 —
"Smart Road Sentinel"): sensor-fusion confirmation window, hazard
confidence thresholds, LoRa/WiMesh parameters, and vehicle-clustering
distance for multi-vehicle verification (false-alert mitigation).
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field


def _env_float(name: str, default: float) -> float:
    return float(os.getenv(name, default))


def _env_int(name: str, default: int) -> int:
    return int(os.getenv(name, default))


@dataclass(frozen=True)
class VisionConfig:
    """OpenCV hazard-detection tuning."""

    # Minimum contour area (px^2) to be considered a candidate pothole.
    min_contour_area: int = _env_int("RW_MIN_CONTOUR_AREA", 900)
    # Canny edge thresholds.
    canny_low: int = _env_int("RW_CANNY_LOW", 40)
    canny_high: int = _env_int("RW_CANNY_HIGH", 120)
    # Aspect-ratio / circularity bounds used to reject non-pothole blobs.
    min_circularity: float = _env_float("RW_MIN_CIRCULARITY", 0.35)
    # Confidence below this is discarded before it ever reaches fusion.
    min_confidence: float = _env_float("RW_VISION_MIN_CONF", 0.45)
    frame_width: int = _env_int("RW_FRAME_WIDTH", 640)
    frame_height: int = _env_int("RW_FRAME_HEIGHT", 480)


@dataclass(frozen=True)
class IMUConfig:
    """MPU6050 impact / vibration validation."""

    i2c_bus: int = _env_int("RW_IMU_I2C_BUS", 1)
    i2c_addr: int = int(os.getenv("RW_IMU_I2C_ADDR", "0x68"), 16)
    sample_rate_hz: int = _env_int("RW_IMU_SAMPLE_RATE", 100)
    # g-force delta above which we call it a real impact, not road noise.
    impact_threshold_g: float = _env_float("RW_IMPACT_THRESHOLD_G", 1.8)
    # Gyro delta (deg/s) used to catch skids / sudden swerves.
    gyro_threshold_dps: float = _env_float("RW_GYRO_THRESHOLD_DPS", 150.0)


@dataclass(frozen=True)
class GPSConfig:
    """NEO-6M/NEO-M8N style GPS module."""

    serial_port: str = os.getenv("RW_GPS_PORT", "/dev/ttyUSB0")
    baud_rate: int = _env_int("RW_GPS_BAUD", 9600)
    # Below this HDOP the fix is considered unreliable (weak-signal
    # mitigation called out in the "Feasibility & Viability" slide).
    max_hdop: float = _env_float("RW_GPS_MAX_HDOP", 3.5)


@dataclass(frozen=True)
class FusionConfig:
    """Sensor-fusion / event confirmation."""

    # "10-second confirmation window with thresholds" from the deck.
    confirmation_window_s: float = _env_float("RW_CONFIRM_WINDOW_S", 10.0)
    # Weighted contribution of each sensing modality to the fused score.
    vision_weight: float = _env_float("RW_W_VISION", 0.45)
    imu_weight: float = _env_float("RW_W_IMU", 0.35)
    gps_weight: float = _env_float("RW_W_GPS", 0.20)
    # A fused score at/above this becomes a verified hazard event.
    verified_threshold: float = _env_float("RW_VERIFIED_THRESHOLD", 0.60)


@dataclass(frozen=True)
class WiMeshConfig:
    """LoRa V2V broadcast / mesh networking (WiMesh-inspired, Ashraf et al. 2021)."""

    serial_port: str = os.getenv("RW_LORA_PORT", "/dev/ttyUSB1")
    baud_rate: int = _env_int("RW_LORA_BAUD", 9600)
    frequency_mhz: float = _env_float("RW_LORA_FREQ_MHZ", 433.0)
    # Max hop count for multi-hop, infrastructure-independent relay.
    max_hops: int = _env_int("RW_MAX_HOPS", 5)
    ttl_s: float = _env_float("RW_PACKET_TTL_S", 30.0)
    # Distance (metres) within which two reports are clustered as the
    # same real-world hazard for "Multi-Vehicle Verification".
    cluster_radius_m: float = _env_float("RW_CLUSTER_RADIUS_M", 40.0)
    # Independent corroborating reports required before an alert is
    # broadcast as HIGH confidence (reduces false alerts from potholes /
    # speed breakers triggering a single vehicle).
    min_corroborations: int = _env_int("RW_MIN_CORROBORATIONS", 2)


@dataclass(frozen=True)
class NetworkConfig:
    api_host: str = os.getenv("RW_API_HOST", "0.0.0.0")
    api_port: int = _env_int("RW_API_PORT", 8000)


@dataclass(frozen=True)
class Settings:
    vehicle_id: str = os.getenv("RW_VEHICLE_ID", "VEH-001")
    vision: VisionConfig = field(default_factory=VisionConfig)
    imu: IMUConfig = field(default_factory=IMUConfig)
    gps: GPSConfig = field(default_factory=GPSConfig)
    fusion: FusionConfig = field(default_factory=FusionConfig)
    wimesh: WiMeshConfig = field(default_factory=WiMeshConfig)
    network: NetworkConfig = field(default_factory=NetworkConfig)


settings = Settings()
