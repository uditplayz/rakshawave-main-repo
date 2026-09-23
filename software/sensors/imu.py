"""
MPU6050 IMU interface — "CONFIRM: Impact / vibration validation" stage.

Reads accelerometer + gyroscope over I2C when the real sensor is present
(Raspberry Pi / any Linux SBC with smbus2). Falls back to a lightweight
physics-flavoured simulator everywhere else (dev laptops, CI, the
software demo) so the rest of the pipeline can always be exercised.
"""

from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field
from typing import Optional

from software.config import IMUConfig, settings

# MPU6050 register map (only what we need).
_PWR_MGMT_1 = 0x6B
_ACCEL_XOUT_H = 0x3B
_GYRO_XOUT_H = 0x43
_ACCEL_SCALE = 16384.0  # LSB/g at +-2g full scale
_GYRO_SCALE = 131.0  # LSB/(deg/s) at +-250 dps full scale
_G = 9.80665


@dataclass
class IMUSample:
    accel_g: tuple[float, float, float]  # (ax, ay, az) in g
    gyro_dps: tuple[float, float, float]  # (gx, gy, gz) in deg/s
    timestamp: float = field(default_factory=time.time)

    @property
    def accel_magnitude_g(self) -> float:
        return math.sqrt(sum(a * a for a in self.accel_g))

    @property
    def gyro_magnitude_dps(self) -> float:
        return math.sqrt(sum(g * g for g in self.gyro_dps))

    def is_impact(self, cfg: Optional[IMUConfig] = None) -> bool:
        cfg = cfg or settings.imu
        # Subtract the resting 1g of gravity before comparing to threshold.
        delta_g = abs(self.accel_magnitude_g - 1.0)
        return delta_g >= cfg.impact_threshold_g or self.gyro_magnitude_dps >= cfg.gyro_threshold_dps

    def to_dict(self) -> dict:
        return {
            "accel_g": [round(v, 3) for v in self.accel_g],
            "gyro_dps": [round(v, 2) for v in self.gyro_dps],
            "accel_magnitude_g": round(self.accel_magnitude_g, 3),
            "timestamp": self.timestamp,
        }


class IMUReader:
    """Reads MPU6050 samples; auto-falls-back to simulation."""

    def __init__(self, config: Optional[IMUConfig] = None, force_simulation: bool = False):
        self.cfg = config or settings.imu
        self._bus = None
        self.simulated = force_simulation

        if not force_simulation:
            try:
                import smbus2  # type: ignore

                self._bus = smbus2.SMBus(self.cfg.i2c_bus)
                self._bus.write_byte_data(self.cfg.i2c_addr, _PWR_MGMT_1, 0)  # wake up
            except Exception:
                self._bus = None
                self.simulated = True

    def read(self) -> IMUSample:
        if self._bus is not None:
            return self._read_hardware()
        return self._read_simulated()

    # -- hardware -------------------------------------------------------
    def _read_word(self, reg: int) -> int:
        high = self._bus.read_byte_data(self.cfg.i2c_addr, reg)
        low = self._bus.read_byte_data(self.cfg.i2c_addr, reg + 1)
        value = (high << 8) + low
        return value - 65536 if value >= 0x8000 else value

    def _read_hardware(self) -> IMUSample:
        ax = self._read_word(_ACCEL_XOUT_H) / _ACCEL_SCALE
        ay = self._read_word(_ACCEL_XOUT_H + 2) / _ACCEL_SCALE
        az = self._read_word(_ACCEL_XOUT_H + 4) / _ACCEL_SCALE
        gx = self._read_word(_GYRO_XOUT_H) / _GYRO_SCALE
        gy = self._read_word(_GYRO_XOUT_H + 2) / _GYRO_SCALE
        gz = self._read_word(_GYRO_XOUT_H + 4) / _GYRO_SCALE
        return IMUSample(accel_g=(ax, ay, az), gyro_dps=(gx, gy, gz))

    # -- simulation -------------------------------------------------------
    def _read_simulated(self, impact_probability: float = 0.03) -> IMUSample:
        """Mostly quiet road noise, with occasional simulated impacts —
        good enough to demo the sensor-fusion + mesh pipeline end to end
        without physical hardware attached."""
        if random.random() < impact_probability:
            spike = random.uniform(2.0, 4.5)
            accel = (random.uniform(-1, 1) * spike, random.uniform(-1, 1) * spike, 1.0 + spike)
            gyro = (random.uniform(-200, 200), random.uniform(-200, 200), random.uniform(-50, 50))
        else:
            accel = (random.uniform(-0.05, 0.05), random.uniform(-0.05, 0.05), 1.0 + random.uniform(-0.03, 0.03))
            gyro = (random.uniform(-3, 3), random.uniform(-3, 3), random.uniform(-3, 3))
        return IMUSample(accel_g=accel, gyro_dps=gyro)
