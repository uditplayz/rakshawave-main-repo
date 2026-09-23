"""
GPS module interface — "LOCATE: Location & speed tracking" stage.

Parses standard NMEA-0183 sentences (GPGGA for fix/HDOP, GPRMC for
speed/course) from a serial GPS module (e.g. NEO-6M). No third-party
NMEA parser dependency — the sentence subset we need is small and
parsing it directly keeps the footprint light for constrained boards.

Falls back to a simulated GPS track (a small loop) when no serial GPS
is attached, mirroring the IMU module's dev-friendly design.
"""

from __future__ import annotations

import math
import random
import time
from dataclasses import dataclass, field
from typing import Optional

from software.config import GPSConfig, settings


@dataclass
class GPSFix:
    latitude: float
    longitude: float
    speed_kmh: float
    course_deg: float
    hdop: float
    satellites: int
    timestamp: float = field(default_factory=time.time)

    def is_reliable(self, cfg: Optional[GPSConfig] = None) -> bool:
        cfg = cfg or settings.gps
        return self.hdop <= cfg.max_hdop and self.satellites >= 4

    def distance_m(self, other: "GPSFix") -> float:
        """Haversine distance in metres — used for multi-vehicle
        hazard clustering in the WiMesh layer."""
        r = 6_371_000
        phi1, phi2 = math.radians(self.latitude), math.radians(other.latitude)
        dphi = math.radians(other.latitude - self.latitude)
        dlambda = math.radians(other.longitude - self.longitude)
        a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2) ** 2
        return 2 * r * math.asin(min(1.0, math.sqrt(a)))

    def to_dict(self) -> dict:
        return {
            "lat": round(self.latitude, 6),
            "lon": round(self.longitude, 6),
            "speed_kmh": round(self.speed_kmh, 1),
            "course_deg": round(self.course_deg, 1),
            "hdop": round(self.hdop, 2),
            "satellites": self.satellites,
            "timestamp": self.timestamp,
        }


def _nmea_to_decimal(raw: str, hemisphere: str) -> float:
    if not raw:
        return 0.0
    degrees_len = 2 if hemisphere in ("N", "S") else 3
    degrees = float(raw[:degrees_len])
    minutes = float(raw[degrees_len:])
    decimal = degrees + minutes / 60.0
    return -decimal if hemisphere in ("S", "W") else decimal


def parse_nmea_sentence(sentence: str, state: dict) -> None:
    """Mutates `state` in place with fields parsed from one NMEA line."""
    if not sentence.startswith("$"):
        return
    fields = sentence.strip().split(",")
    msg_type = fields[0][-3:]

    try:
        if msg_type == "GGA" and len(fields) >= 10:
            state["latitude"] = _nmea_to_decimal(fields[2], fields[3])
            state["longitude"] = _nmea_to_decimal(fields[4], fields[5])
            state["satellites"] = int(fields[7]) if fields[7] else 0
            state["hdop"] = float(fields[8]) if fields[8] else 99.0
        elif msg_type == "RMC" and len(fields) >= 8:
            state["latitude"] = _nmea_to_decimal(fields[3], fields[4])
            state["longitude"] = _nmea_to_decimal(fields[5], fields[6])
            state["speed_kmh"] = float(fields[7]) * 1.852 if fields[7] else 0.0  # knots -> km/h
            state["course_deg"] = float(fields[8]) if len(fields) > 8 and fields[8] else 0.0
    except (ValueError, IndexError):
        return


class GPSReader:
    """Reads GPS fixes from a serial NMEA stream, or simulates one."""

    def __init__(self, config: Optional[GPSConfig] = None, force_simulation: bool = False):
        self.cfg = config or settings.gps
        self._serial = None
        self.simulated = force_simulation
        self._state: dict = {
            "latitude": 18.5204,  # Pune, India — matches the deck's NIBM reference area
            "longitude": 73.8567,
            "speed_kmh": 0.0,
            "course_deg": 0.0,
            "hdop": 1.0,
            "satellites": 8,
        }
        self._sim_t = 0.0

        if not force_simulation:
            try:
                import serial  # type: ignore

                self._serial = serial.Serial(self.cfg.serial_port, self.cfg.baud_rate, timeout=1)
            except Exception:
                self._serial = None
                self.simulated = True

    def read(self) -> GPSFix:
        if self._serial is not None:
            return self._read_hardware()
        return self._read_simulated()

    def _read_hardware(self) -> GPSFix:
        # Drain a handful of lines looking for a fresh GGA+RMC pair;
        # bail out to the last-known state if nothing new arrives.
        for _ in range(10):
            line = self._serial.readline().decode("ascii", errors="ignore")
            if line:
                parse_nmea_sentence(line, self._state)
        return GPSFix(**self._state, timestamp=time.time())

    def _read_simulated(self) -> GPSFix:
        """Simulated vehicle driving a small loop, ~30-45 km/h, with
        light GPS jitter — enough to demo location + speed tracking and
        hazard-cluster distance math."""
        self._sim_t += 1.0
        radius_deg = 0.0009
        angle = self._sim_t * 0.05
        self._state["latitude"] = 18.5204 + radius_deg * math.sin(angle)
        self._state["longitude"] = 73.8567 + radius_deg * math.cos(angle)
        self._state["speed_kmh"] = 30 + 15 * math.sin(angle / 2) + random.uniform(-1, 1)
        self._state["course_deg"] = (math.degrees(angle) + 90) % 360
        self._state["hdop"] = round(random.uniform(0.8, 1.6), 2)
        self._state["satellites"] = random.randint(6, 12)
        return GPSFix(**self._state, timestamp=time.time())
