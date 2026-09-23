"""Pydantic response models for the RakshaWave API."""

from __future__ import annotations

from typing import List, Optional

from pydantic import BaseModel


class VehicleState(BaseModel):
    vehicle_id: str
    lat: float
    lon: float
    speed_kmh: float
    course_deg: float
    last_update: float


class HazardEventOut(BaseModel):
    event_id: str
    vehicle_id: str
    hazard_type: str
    fused_confidence: float
    verified: bool
    lat: float
    lon: float
    created_at: float


class ClusterOut(BaseModel):
    cluster_id: str
    hazard_type: str
    lat: float
    lon: float
    report_count: int
    corroborating_vehicles: List[str]
    max_confidence: float
    escalated: bool
    first_seen: float
    last_seen: float


class EmergencyOut(BaseModel):
    cluster_id: str
    hazard_type: str
    lat: float
    lon: float
    corroborating_vehicles: List[str]


class FleetSnapshot(BaseModel):
    vehicles: List[VehicleState]
    recent_events: List[HazardEventOut]
    clusters: List[ClusterOut]
    emergencies: List[EmergencyOut]
    stats: dict
