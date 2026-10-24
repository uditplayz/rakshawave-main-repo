# RakshaWave

**See danger. Verify it. Warn every vehicle.**

AI-powered road-hazard detection with secure, trust-scored vehicle-to-vehicle (V2V) alerts over LoRa. Every vehicle becomes both a sensor and a warning system, and it keeps working with no cellular network.

---

## Why this matters

- **India, 2023: ~4.8 lakh road crashes and ~1.72 lakh deaths.**
- In fog and on hill roads, drivers may see only **~90 m** ahead. A crash, pothole or debris is often invisible until it is too late to react.
- Vehicles have **no direct way to warn each other**, so one crash can set off a chain-reaction pile-up.
- Rural and highway stretches often have **weak or no cellular coverage**, which delays app-based warnings.
- **Fake or false alerts are as dangerous as no alerts**, because drivers stop trusting the system.

> Safety should not depend on what one vehicle sees.

## What RakshaWave does

A low-cost, retrofit-friendly node in each vehicle runs this pipeline:

| # | Stage | How |
|---|---|---|
| 1 | **DETECT** | A forward camera plus OpenCV flags potholes, cracks and debris |
| 2 | **CONFIRM** | The MPU6050 IMU checks for a real impact or vibration signature, so a shadow isn't mistaken for a pothole |
| 3 | **LOCATE** | GPS provides position, speed and fix quality |
| 4 | **VERIFY** | Vision, IMU and GPS are fused into one confidence score, and nearby vehicles cross-check the hazard |
| 5 | **SHARE** | A compact alert is broadcast over a 433 MHz LoRa mesh, with no internet, SIM or towers needed |
| 6 | **WARN** | The buzzer and OLED alert the driver. Hazards confirmed by several vehicles are escalated to emergency response |

```
CAMERA + IMU + GPS ──► EDGE AI ──► FUSION + TRUST SCORE ──► PEER CHECK ──► LoRa V2V MESH ──► DRIVER ALERT / EMERGENCY
     DETECT            ANALYZE          VERIFY                  VERIFY         BROADCAST          WARN
```

**Simulation result:** in our 50-vehicle, 6-lane foggy-expressway simulation, an `ACCIDENT_ALERT` from the crashed vehicle reached nearby vehicles in **~0.3–0.4 s**, and those vehicles changed lanes to avoid it. *(This is simulated, not yet field-tested.)*

---

## Hardware

Our custom PCB (designed in KiCad, files in the repo root) is a **Raspberry Pi 5 add-on board (HAT)**. It can also run standalone on the ESP32-C3.

| Block | Part | Interface | Role |
|---|---|---|---|
| MCU | ESP32-C3-DevKitM-1 | — | Edge processing and system control |
| LoRa radio | Ai-Thinker Ra-01 (SX1278, 433 MHz) | SPI | V2V mesh communication |
| GPS | GPS module | UART | Location and speed |
| IMU | MPU6050 | I²C | Impact and vibration sensing |
| Display | 0.91″ OLED | I²C | In-cab alert display |
| Alerts | Buzzer + LED | GPIO | Audible and visual driver warning |
| Power | Li-ion battery → 3.3 V buck-boost, USB-C charging | — | Portable, retrofit power |
| Host (optional) | Raspberry Pi 5 via 40-pin header | GPIO | AI camera and full software stack |
| Antennas | 2× SMA | — | LoRa + GPS |

**Unit cost (parts list):** ~₹15,000

The ESP32 firmware (`firmware/esp32/main.ino`) sends the **same JSON packet format** as `software/wimesh/protocol.py`, so the Python stack can decode packets from real hardware with no translation layer.

---

## Software architecture

| Stage | Module | What it does |
|---|---|---|
| **DETECT** | `software/vision/hazard_detector.py` | Classical OpenCV pipeline (edge detection plus contour shape, circularity and darkness scoring) that classifies potholes, cracks and debris. No model download is needed for the demo. A `model_path` hook lets you swap in an ONNX/YOLO model later. |
| **CONFIRM** | `software/sensors/imu.py` | Reads the MPU6050 over I²C and flags an impact when the acceleration change is ≥ 1.8 g or the gyro rate is ≥ 150°/s. Falls back to a simulator if no sensor is attached. |
| **LOCATE** | `software/sensors/gps.py` | Parses NMEA GGA/RMC sentences. A fix is marked unreliable when HDOP > 3.5 or fewer than 4 satellites are visible. Falls back to a simulator if no GPS is attached. |
| **VERIFY** | `software/sensors/fusion.py` | Weighted fusion (vision 0.45, IMU 0.35, GPS 0.20) over a rolling **10-second confirmation window**. Only fused scores at or above the threshold in `config.py` become verified events. |
| **SHARE** | `software/wimesh/protocol.py` + `lora_node.py` | Packs a compact JSON `HazardAlertPacket` that fits one LoRa frame. Relays it up to **5 hops** with a **30 s TTL** and **per-node packet-ID dedup**, so the mesh never floods itself. |
| **WARN** | `software/wimesh/mesh_network.py` | Clusters reports by hazard type and GPS proximity (**40 m radius**). A hazard escalates only after **≥ 2 independent vehicles** confirm it. |
| **EMERGENCY** | `software/core/emergency.py` | An escalated cluster with a confirmed IMU impact (or a collision-type hazard) triggers a GPS-tagged `EMERGENCY` packet and notifies registered listeners, such as the dashboard. |

All thresholds live in **`software/config.py`**.

---

## False-alert and security mitigations

| Challenge | Mitigation | Where |
|---|---|---|
| Fake or false alerts | Weighted multi-sensor fusion plus a confidence threshold | `SensorFusion` in `sensors/fusion.py` |
| Single-vehicle misreads | Needs ≥ 2 independent vehicles within 40 m before escalating | `HazardClusterVerifier` in `mesh_network.py` |
| Spam and mesh flooding | Hop limit (5), TTL (30 s), per-node packet-ID dedup | `LoRaNode` in `wimesh/lora_node.py` |
| GPS errors and weak signal | HDOP and satellite-count check lowers the GPS weight | `GPSFix.is_reliable()` in `sensors/gps.py` |
| Sensor or hardware failure | Graceful fallback to a simulator instead of crashing | `IMUReader`, `GPSReader` |

---

## Quick start (no hardware needed)

Every sensor automatically falls back to a realistic simulator. The full pipeline (simulated vehicles, detection, fusion, mesh relay, multi-vehicle verification and emergency escalation) runs on any machine with **Python 3.10+**.

```bash
git clone https://github.com/uditplayz/rakshawave-main-repo.git
cd rakshawave-main-repo

python3 -m venv .venv && source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

uvicorn software.api.server:app --reload --port 8000
```

Or use the one-command demo script:

```bash
./scripts/run_demo.sh        # macOS / Linux
.\scripts\run_demo.ps1       # Windows PowerShell
```

Open **http://localhost:8000** for the live dashboard, which shows vehicles on a map, hazard markers, a real-time alert feed, confirmed clusters and an emergency panel.

### REST API

```bash
curl localhost:8000/api/fleet         # full snapshot: vehicles, events, clusters, emergencies
curl localhost:8000/api/events        # recent verified hazard alerts
curl localhost:8000/api/clusters      # hazards confirmed by multiple vehicles
curl localhost:8000/api/emergencies   # escalated, collision-confirmed events
```

The WebSocket at `ws://localhost:8000/ws/fleet` pushes a live snapshot on every simulation tick.

### Run the vision module on your own footage

```python
import cv2
from software.vision.hazard_detector import HazardDetector, annotate_frame

detector = HazardDetector()
frame = cv2.imread("road_sample.jpg")
detections = detector.process_frame(frame)
cv2.imwrite("annotated.jpg", annotate_frame(frame, detections))
```

### CLI fleet simulator

```bash
python -m software.simulator.simulate_fleet
```

### Tests

```bash
pytest    # unit tests for fusion, WiMesh protocol, mesh clustering, emergency escalation
```

---

## Live phone-to-phone demo (PWA)

Open the site on two phones; a hazard reported on one shows up on the other in real time,
gets verified by the connected phones (quorum of up to 3 nodes), and then alerts the driver.

```bash
pip install -r server/requirements.txt
uvicorn server.app:app --host 0.0.0.0 --port 8000
```

**Get a public HTTPS URL** (needed so phones can reach it and to "Add to Home Screen"):

| Option | How |
|---|---|
| Quick, no account | `cloudflared tunnel --url http://localhost:8000` (or `ngrok http 8000`) and open the printed `https://...` URL on both phones |
| Hosted | Push to GitHub, then Render > New > Blueprint (uses `render.yaml`). Free instances sleep after idle, so open the URL once before the demo |

**Test:** open the URL on phone A and B, finish pairing on each, then on A tap Report > Fog.
B shows "Verifying 1/2" then a Dense-fog banner. Report an Accident for the full-screen critical alert.
Settings > Demo shows the live device count. `Simulator/index.html` is the offline two-phone simulator.

---

## Repository layout

```
.
├── software/
│   ├── config.py              # all tunable thresholds
│   ├── vision/hazard_detector.py
│   ├── sensors/{imu,gps,fusion}.py
│   ├── wimesh/{protocol,lora_node,mesh_network}.py
│   ├── core/{vehicle_node,emergency}.py
│   ├── simulator/simulate_fleet.py
│   └── api/server.py          # FastAPI REST + WebSocket
├── ui/                        # RakshaWave PWA (index.html, manifest, service worker, icons)
├── server/app.py              # realtime relay: WebSocket hazard sharing + serves the PWA
├── Simulator/index.html       # offline two-phone simulator (scripted scenarios, no server)
├── render.yaml                # one-click hosting blueprint (Render)
├── firmware/esp32/main.ino    # ESP32-C3 + MPU6050 + GPS + LoRa firmware
├── tests/                     # pytest unit tests
├── v2v 1.2.kicad_*            # KiCad schematic + PCB (Pi 5 HAT)
├── scripts/run_demo.{sh,ps1}  # one-command demo
└── requirements.txt
```

---

## Impact

- **Drivers:** warned about hazards beyond their line of sight, with time to react.
- **Accident victims:** the IMU detects the impact and nearby vehicles get a GPS-tagged SOS automatically.
- **Road authorities:** verified pothole and crash data for repairs and hotspot mapping.
- **Fleet operators:** fewer false alarms and live safety events for each vehicle.
- **Target:** cutting road deaths by even 1% would save **~1,700 lives a year**.

---

## Roadmap

- [ ] **Field trial on 2–3 vehicles** → fleet pilot → NHAI / smart-city ITS integration
- [ ] Replace the classical CV pipeline with a trained pothole model (ONNX/YOLO) via `HazardDetector(model_path=...)`
- [ ] Measure real LoRa range and end-to-end alert latency on hardware
- [ ] Hardware-in-the-loop tests with the MPU6050, GPS and SX1278 rig
- [ ] Packet signing and anti-replay (timestamp + nonce) for the security layer
- [ ] Per-device rate limiting
- [ ] Hazard-history database for road-authority analytics
- [ ] Mobile app or in-vehicle heads-up display (HUD) on the same WebSocket feed

---

## Research & references

- **OpenCV**: open-source computer-vision library used for real-time edge- and contour-based hazard detection.
- **WiMesh** (Ashraf et al., *Wireless Networks*, Springer, 2021): decentralized, infrastructure-independent multi-hop mesh networking. It is the design basis for `software/wimesh/`. [doi:10.1007/s11276-021-02621-2](https://link.springer.com/article/10.1007/s11276-021-02621-2)
- **US DOT V2V communications report:** https://rosap.ntl.bts.gov/view/dot/27999
- Related open-source projects:
  - [LoRa V2V accident detection](https://github.com/Bharanidharan-G/Smart-Vehicle-to-Vehicle-Communication-for-Accident-Detection-Using-LoRa)
  - [V2V collision avoidance over CAN](https://github.com/VipraK830/Vehicle-To-Vehicle-Communication-Using-CAN-for-Collision-Avoidance)
  - [Vehicle accident detection system](https://github.com/tulasisowmya/Vehicle-Accident-Detection-System)
  - [V2V communication prototype](https://github.com/devansh-labs/Vehicle-to-Vehicle-Communication)

---

<sub>Built by **Team TechLads**.</sub>
