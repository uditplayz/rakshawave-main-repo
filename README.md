# RakshaWave

**Smart India Hackathon 2026 — Problem Statement ID: SIH26220**
Student Innovation — *Creating intelligent devices to improve communication in vehicle safety*
Theme: **Smart Vehicles** · Category: **Software/Hardware** · Team: **TechLads**

> AI-powered road hazard detection and vehicle-to-vehicle (V2V) safety alerts.
> Every vehicle becomes a sensor **and** a warning system.

---

## The problem

- Potholes and crashes go unnoticed until a driver is already on top of them.
- Manual hazard reporting is slow, inconsistent, and full of false alarms.
- Rural and highway stretches often have poor/no network coverage, delaying warnings.

## The solution

A low-cost, retrofit-friendly device per vehicle that:

1. **Detects** road hazards from a forward-facing camera using computer vision (OpenCV).
2. **Confirms** the hazard with an IMU (impact/vibration signature), so a pothole isn't
   confused with a shadow or a wet patch.
3. **Locates** the vehicle via GPS (position, speed, heading).
4. **Verifies** by fusing all three signals into one confidence score.
5. **Shares** the verified alert over a long-range, infrastructure-independent LoRa mesh
   (**WiMesh** — inspired by Ashraf et al., 2021) so nearby vehicles are warned even with
   zero cellular signal.
6. **Warns** approaching vehicles in real time, and **escalates to emergency response**
   once multiple independent vehicles corroborate the same hazard location.

```
ROAD CAMERA + IMU + GPS -> AI HAZARD DETECTION -> LOCAL LoRa ALERT -> NEARBY VEHICLES -> EMERGENCY RESPONSE
        DETECT               CONFIRM / LOCATE          VERIFY / SHARE            WARN
```

---

## Repository layout

```
rakshawave-2/
├── software/
│   ├── config.py              # all tunable thresholds (mirrors the pitch-deck numbers)
│   ├── vision/
│   │   └── hazard_detector.py # OpenCV pothole/crack/debris detection (DETECT)
│   ├── sensors/
│   │   ├── imu.py             # MPU6050 impact/vibration reader (CONFIRM)
│   │   ├── gps.py             # NMEA GPS reader — location & speed (LOCATE)
│   │   └── fusion.py          # cross-sensor verification, 10s confirmation window (VERIFY)
│   ├── wimesh/
│   │   ├── protocol.py        # HazardAlertPacket wire format (JSON over LoRa)
│   │   ├── lora_node.py       # radio transport: real serial LoRa module, or simulated bus
│   │   └── mesh_network.py    # multi-hop relay + multi-vehicle GPS clustering (SHARE/WARN)
│   ├── core/
│   │   ├── vehicle_node.py    # wires one vehicle's full DETECT→...→SHARE pipeline
│   │   └── emergency.py       # escalates corroborated hazards to EMERGENCY packets
│   ├── simulator/
│   │   └── simulate_fleet.py  # multi-vehicle simulation (no hardware required)
│   └── api/
│       └── server.py          # FastAPI backend: REST + WebSocket for the dashboard
├── ui/
│   └── index.html             # live dashboard — map, alerts feed, clusters, emergencies
├── firmware/
│   └── esp32/main.ino         # ESP32 + MPU6050 + GPS + LoRa firmware skeleton
├── tests/                     # pytest unit tests for fusion, protocol, mesh, emergency
├── v2v 1.2.kicad_*             # KiCad hardware design files (PCB/schematic) for the V2V node
├── scripts/run_demo.sh        # one-command local demo
└── requirements.txt
```

---

## Technical approach

| Stage | Component | What it does |
|---|---|---|
| **DETECT** | `software/vision/hazard_detector.py` | Classical OpenCV pipeline (edge detection, contour shape/circularity/darkness scoring) classifies potholes, cracks and debris — no trained-model download needed to run the demo. A `model_path` hook lets you swap in a trained ONNX/YOLO model later without touching any other module. |
| **CONFIRM** | `software/sensors/imu.py` | Reads an MPU6050 over I2C; flags an impact when acceleration delta ≥ 1.8g or gyro rate ≥ 150°/s. Falls back to a physics-flavoured simulator when no sensor is attached. |
| **LOCATE** | `software/sensors/gps.py` | Parses NMEA GGA/RMC sentences for position, speed, HDOP and satellite count; flags unreliable fixes (HDOP > 3.5 or < 4 satellites). Falls back to a simulated GPS loop otherwise. |
| **VERIFY** | `software/sensors/fusion.py` | Weighted fusion (vision 0.45 / IMU 0.35 / GPS 0.20) inside a rolling **10-second confirmation window**; only fused scores ≥ 0.60 become verified events — this is what filters out a lone camera glitch. |
| **SHARE** | `software/wimesh/protocol.py` + `lora_node.py` | Packs a compact JSON `HazardAlertPacket` (fits a LoRa frame), broadcasts it, and relays it up to 5 hops with a 30s TTL and **packet-id dedup** so a mesh doesn't flood itself. |
| **WARN / mitigate false alerts** | `software/wimesh/mesh_network.py` | Clusters incoming reports by hazard type + GPS proximity (40 m radius). A cluster only escalates once ≥ 2 independent vehicles corroborate it — this is the "10-sec confirmation window with thresholds" / "GPS clustering" mitigation from the feasibility slide. |
| **EMERGENCY RESPONSE** | `software/core/emergency.py` | Once a cluster is escalated *and* an IMU impact was confirmed (or the hazard type looks collision-like), an `EMERGENCY` packet is broadcast and any registered listener (e.g. a dashboard alert or a call to local authorities) fires — carrying GPS coordinates for faster response. |

### Hardware blocks (see `firmware/esp32/main.ino` and the KiCad files)

| Block | Role |
|---|---|
| AI Camera | Pothole & hazard frame capture |
| MPU6050 IMU | Impact & vibration sensing |
| GPS module (NEO-6M) | Location & speed tracking |
| LoRa module (SX1278, 433 MHz) | V2V mesh communication |
| ESP32 / Raspberry Pi | Data processing & system control |

The ESP32 sketch reads the IMU/GPS and emits the **exact same JSON packet shape** as
`software/wimesh/protocol.py`, so a Python gateway running the full software stack can
decode real hardware packets with zero translation layer.

---

## Running the software demo

No camera, IMU, GPS, or LoRa hardware is required — every sensor module auto-falls-back
to a realistic simulator when the physical device isn't present, so the full pipeline
(5 simulated vehicles, hazard detection, sensor fusion, mesh relay, multi-vehicle
verification, emergency escalation) runs on any machine with Python 3.10+.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt

# Option A — one command (venv + install + run):
./scripts/run_demo.sh

# Option B — manual:
uvicorn software.api.server:app --reload --port 8000
```

Then open **http://localhost:8000** for the live dashboard (map with vehicle positions,
hazard markers, a real-time alert feed, corroborated hazard clusters, and an emergency
panel), or hit the REST API directly:

```bash
curl localhost:8000/api/fleet         # full snapshot: vehicles, events, clusters, emergencies
curl localhost:8000/api/events        # recent verified hazard alerts
curl localhost:8000/api/clusters      # multi-vehicle-corroborated hazard clusters
curl localhost:8000/api/emergencies   # escalated, collision-confirmed events
```

A WebSocket at `ws://localhost:8000/ws/fleet` pushes a fresh snapshot every simulated
tick — that's what drives the dashboard live.

### Running just the vision module on your own footage

```python
import cv2
from software.vision.hazard_detector import HazardDetector, annotate_frame

detector = HazardDetector()
frame = cv2.imread("road_sample.jpg")
detections = detector.process_frame(frame)
cv2.imwrite("annotated.jpg", annotate_frame(frame, detections))
```

### Running the CLI fleet simulator standalone

```bash
python -m software.simulator.simulate_fleet
```

### Tests

```bash
pytest        # 12 unit tests covering fusion, WiMesh protocol, mesh clustering, emergency escalation
```

---

## Feasibility & mitigations implemented in code

| Challenge (from the pitch deck) | Mitigation | Where |
|---|---|---|
| False alerts (potholes/speed breakers triggering alarms) | Multi-vehicle GPS clustering — needs ≥2 independent corroborating vehicles before escalation | `HazardClusterVerifier` in `mesh_network.py` |
| GPS errors / weak signal | HDOP + satellite-count reliability check feeds a lower confidence weight into fusion | `GPSFix.is_reliable()` in `sensors/gps.py` |
| LoRa range / RF interference, mesh flooding | Hop-count limit (5), TTL (30s), and **packet-id dedup per node** so a fully-connected mesh doesn't regenerate duplicate relays | `LoRaNode` in `wimesh/lora_node.py` |
| Power & hardware reliability | Sensor modules degrade gracefully (auto-simulation fallback) rather than crashing the node when a sensor read fails | `IMUReader`, `GPSReader` |
| Adaptive confirmation | 10-second rolling confirmation window between vision + IMU signals before a hazard is even considered "fused" | `SensorFusion` in `sensors/fusion.py` |

---

## Research & references

- **OpenCV** — open-source computer-vision library used for real-time image processing,
  edge/contour-based hazard detection.
- **WiMesh — Leveraging Mesh Networks** (Ashraf et al., 2021) — decentralized,
  infrastructure-independent multi-hop mesh communication for resource-constrained,
  disaster/low-connectivity settings; the design basis for `software/wimesh/`.
- Related GitHub projects referenced during research: vehicle accident detection systems,
  V2V communication over CAN, and LoRa-based vehicle-to-vehicle accident-detection
  communication (see the deck's Research & References slide for full links).

---

## Roadmap

- [ ] Swap the classical CV pipeline for a trained pothole-detection model (ONNX/YOLO) via
      `HazardDetector(model_path=...)`.
- [ ] Real serial-port integration tests against a physical MPU6050 / NEO-6M / SX1278 rig.
- [ ] Persist hazard history to a database for road-authority hotspot analytics.
- [ ] Mobile app / in-vehicle HUD consuming the same WebSocket feed as the dashboard.
