# Hardware lab: the real firmware on emulated boards, in a LoRa mesh

`hardware/lab/` runs several RakshaWave boards in one browser page. Each board runs the actual firmware
(`firmware/esp32/main.ino`, compiled unmodified to WebAssembly). Every chip around the ESP32 is emulated at
register level from its datasheet, and the boards can only reach each other through a modelled 433 MHz radio
channel. Nothing in the page is scripted: an alert happens because the firmware read the accelerometer
registers, and a board hears it because the frame survived the channel.

```
python hardware/gui/app.py                  # then open http://127.0.0.1:8765/lab/
# or, without Python dependencies:
cd hardware/lab/web && python -m http.server 8000      # http://127.0.0.1:8000
```

It needs no internet, no Wokwi token and no build step (`hardware/lab/web/firmware.wasm` is committed).
Any static web host can serve `hardware/lab/web/`.

## How it is built

```
firmware/esp32/main.ino ──(zig c++ -target wasm32-wasi, hardware/lab/hal/build.sh)──► web/firmware.wasm
        │ Arduino API: pins, Wire, SPI, Serial, millis/delay      (hardware/lab/hal/*.h, *.cpp)
        ▼
  HAL imports (JavaScript, web/js/sim/device.js)
        ├─ SPI ─► SX1278 register model (sx1278.js) ─┐
        ├─ I²C ─► MPU-6050 (mpu6050.js) ◄── 7-DOF car on an ISO 8608 road (vehicle.js)
        ├─ I²C ─► SSD1306 (ssd1306.js) ─► OLED texture on the 3D board
        ├─ UART1 ◄ GPS NMEA at 9600 baud (gps.js)    │
        ├─ UART0 ◄► "Raspberry Pi" serial (Serial tab)│
        └─ pins: LED IO10, buzzer IO9 + BOOT, RST/EN  │
                                                     ▼
                         433 MHz channel (channel.js) shared by all boards (world.js)
```

The libraries the firmware includes (sandeepmistry LoRa, Adafruit MPU6050 / SSD1306 / GFX, TinyGPSPlus,
ArduinoJson 6) could not be downloaded in this environment, so `hardware/lab/hal/` re-implements their
APIs with the same register traffic: `LoRa.cpp` follows the library register for register, the SSD1306
driver sends the same command list and 32-byte GDDRAM chunks, the GFX text uses Adafruit's original 5x7 font
(`glcdfont.h`, BSD licence). ArduinoJson keeps its observable behaviour: fixed capacity (members that do not
fit are dropped), floats stored as double and printed with up to 9 decimals (`0.85f` prints `0.850000024`).

### Time

Each board has its own clock, with its own crystal error (±10 ppm), FreeRTOS tick phase (`delay()` wakes on a
1 kHz tick, as `vTaskDelay` does) and power-on moment, so boards drift apart as real ones do. Bus transfers and `delay()` cost what they cost on the ESP32-C3: I²C at 100 or
400 kHz (the OLED driver switches to 400 kHz for `display()`), SPI at 8 MHz, UART0 at 115200 with a 128-byte
FIFO (`Serial.println` blocks when it is full), UART1 at 9600, and `LoRa.endPacket()` blocks for the frame's
full time on air. The board furthest behind always runs next. `firmware.wasm` is post-processed with Binaryen's asyncify, so
the firmware can be suspended inside `delay()` / `yield()` (including the busy-wait for TX done and the
listen-before-talk wait): no board runs more than 2 ms ahead of the others. A radio only decides receptions up
to the slowest other board's clock, so collisions and half-duplex losses come out exact.
The page runs in real time (about 70x faster than real time headless).

### What each model contains

| Part | Modelled |
|---|---|
| SX1278 / Ra-01 | LoRa register page, 256-byte FIFO and its pointers, SLEEP/STDBY/TX/RX single/RX continuous with start-up times, RX single symbol timeout, IRQ flags, DIO0 = RxDone/TxDone, packet RSSI/SNR/FEI registers in datasheet units, PA_BOOST/RFO output power, ±10 ppm crystal per module, supply currents (TX 87 mA at 17 dBm, RX 11.5 mA) |
| Channel | Exact two-ray ground reflection (complex Fresnel coefficient, antennas 1.1 m), or log-distance n = 2.9 / 3.5; Gudmundson-correlated shadowing; Rician fading per frame; noise kTB + 7 dB NF (-116 dBm at 125 kHz); SNR limit per SF (-7.5 dB at SF7); 6 dB co-channel capture; collisions; half duplex; 5 dB car-body loss for an antenna inside the cabin; Semtech AN1200.13 time on air (242 B at SF7 = 379 ms) |
| MPU-6050 | Registers, device reset, WHO_AM_I, full-scale ranges with 16-bit saturation, DLPF (21 Hz as set by the firmware) at 1 kHz, noise 400 µg/√Hz and 0.005 °/s/√Hz, per-part offsets and scale errors |
| Car and road | 7-DOF ride model (heave, pitch, roll, four wheel hops), bump stops, tyres that lift off, rolling-circle tyre envelope; ISO 8608 class A–D roughness; potholes with sharp edges; 10 cm × 3.7 m speed bumps; crash = half-sine deceleration pulse (90 ms); the board sits on the dashboard 0.75 m ahead of the centre of gravity |
| SSD1306 | Command decoder with parameters, page/horizontal/vertical addressing, segment remap, COM scan direction, multiplex, charge pump (dark without it), contrast, inversion |
| GPS | GGA, GSA, RMC, VTG every second with checksums, bytes timed at 9600 baud into a 256-byte UART buffer, 2.5 m CEP Gauss-Markov error, time to first fix |
| Power | Per-part currents from datasheets, TPS63001 efficiency, LiFePO4 18650 (1500 mAh) |
| ESP32-C3 | ROM boot messages, BOOT strap (IO9) download mode, EN reset (other chips keep their state), MAC per board |

## Using it

- **Scenarios**: two cars 600 m apart; a relay chain (3 cars, 2.2 km apart: the ends cannot hear each other);
  a convoy of four at 60 km/h (crash the front car: the drivers behind brake 1.2 s after their buzzer sounds,
  at 7 m/s², and the page reports where each car stopped); two boards on a desk.
- **Make something happen** (Node tab): drive (speed slider), *Pothole ahead*, *Speed bump ahead*,
  *Crash into barrier*, *Jolt the board*. Watch the IMU tab: it plots what `mpu.getEvent()` returns against
  the firmware's 1.8 g threshold.
- **Board buttons**: click RST, BOOT and PTT on the 3D boards or in the Node tab. Hold BOOT while releasing RST
  for the ROM download mode (it also sounds the buzzer: IO9 is shared).
- **Serial tab**: the USB console of the selected board, and an input that plays the Raspberry Pi: any JSON
  line is sent over LoRa by the firmware (lines over 255 bytes are refused, as on the board).
- **Radio tab**: live SX1278 registers, counters, and the link budget to every other board.
- **Field map**: drag a car to change the distance; the arcs show the mean link budget; each frame is drawn
  for its real time on air and marked at each receiver with what happened (✓ or ✗ with the reason in the
  Mesh log).
- **Fault injection**: unplug the OLED, the MPU-6050, the LoRa antenna, cover the GPS antenna, or stop the
  Ra-01 answering, then press RST to see the firmware's start-up checks.

## Tests and measurements

`node --test hardware/lab/test/` (also run by `pytest` through `tests/test_lab.py` when Node.js is installed):
boot and IDs, OLED picture from I²C, alert received and relayed, two-hop delivery across a gap no single link
covers, Pi line sent over LoRa, oversize line refused, voice never relayed, out-of-range silence, unplugged
IMU, download mode, vehicle physics, overlapping frames.

`node hardware/lab/test/measure.mjs` (real firmware, 60 frames per point, antennas in the cabin):

| environment | distance | frames delivered |
|---|---|---|
| highway (two-ray) | 300 m – 1.5 km | 100 % |
| highway | 2.0 km | 98 % |
| highway | 2.5 km | 85 % |
| highway | 3.0 km | 0 % |
| suburban (n = 2.9) | 200 – 600 m | 100 % |
| suburban | 800 m – 1.0 km | 98 % |

Impact to alert decoded at the next car: **345 ms** (one hop); at a car 4.4 km away via a relay: **763 ms**.

## Findings the lab produced (and what was changed)

1. **Blind gaps in reception.** The firmware polled `LoRa.parsePacket()`, which puts the SX1278 in RX *single*
   mode; it times out after 100 symbols (102 ms) and is only re-armed on the next `loop()`, up to ~12 ms later.
   A frame whose preamble falls in that gap is lost: 1 of 400 frames at 300 m with random send times (more if a
   sender's timing happens to line up with the receiver's loop). Fixed in the firmware: continuous RX
   (`LoRa.receive()`) and DIO0 (IO8, already wired) polled for RxDone, so the radio never stops listening
   (0 of 400).
2. **No mesh without a Pi.** The ESP32 printed received packets but never relayed them, and every board
   had the same ID (`VEH-ESP32-01`). The firmware now takes its ID from the ESP32's MAC (`RW-xxxxxx`) and
   relays hazard packets itself: duplicate suppression (last 32 IDs), hop count, TTL reduced by the time spent
   on air and in the node, a backoff in slots of one frame time weighted by RSSI so the farthest node relays
   first, and cancellation as soon as another node's relay is heard. Voice is still never relayed. `LoRaNode` on the Pi no longer relays packets
   that come from a serial modem (the ESP32 already did).
3. **CRC was off.** With the library's default a corrupted frame is delivered as data. The firmware now sets
   SF7 / 125 kHz / 4/5 / preamble 8 / sync 0x12 / 17 dBm explicitly and enables CRC.
4. **The 1.8 g impact threshold does not fire on potholes with the board on the dashboard.** The board sits on
   the sprung mass, so the suspension filters the hit: a 12 cm × 1 m pothole at 40 km/h gives about 1.2 g at
   the MPU-6050 after its 21 Hz filter, an 8 cm one 0.3–0.8 g, a speed bump about 0.7 g, a rough (ISO C)
   road up to 0.3 g. A crash gives 20 g or more. As set, the IMU path is a crash detector; pothole alerts have
   to come from the camera (Pi) or need a lower threshold plus a check that rejects speed bumps. Not changed:
   that is a design decision. (A sharp 6 ms knock on the board also only reaches about 0.8 g after the filter.)
5. **No alert in the first 3 s after boot**: `lastBroadcastMs` starts at 0, so the 3 s cooldown also runs from
   power-on. Harmless, not changed.
6. **Charger vs cell**: U6 is an MCP73123, a LiFePO4 charger (3.6 V). The README says Li-ion; a Li-ion cell
   would only be charged to about half its capacity. The lab models a LiFePO4 cell.
7. **Relays collided** (found in the convoy, in this session's first version of the relay): without
   listen-before-talk, nodes whose backoff expired during another node's 318 ms relay transmitted on top of it.
   The firmware now senses the channel (`LoRa.rssi()` above -105 dBm = busy) before every transmission; a relay
   that finds the channel busy is rescheduled with a random backoff, so it first hears the other relay and
   cancels. Four cars at 40 m spacing: one relay, no lost frames (four seeds).
8. Alert packets are about 200 bytes (ArduinoJson prints `"c":0.850000024`), so a frame takes 318 ms on air
   at SF7 and the PA draws 87 mA meanwhile (7.7 µAh per alert).

## Limits (read before claiming anything)

- This is an emulation, not a measurement. Models are as good as their datasheet values and the channel
  statistics; real range depends on the antenna, its mounting and the terrain. Use the lab to test the
  firmware's logic and timing and to see trends; confirm range and thresholds with two real boards.
- The Raspberry Pi side (camera, Python stack, push-to-talk audio) is not emulated; PTT is drawn but wired to
  the Pi, so it does nothing here.
- The library re-implementations follow the real ones but are not the original code; the firmware has not been
  compiled for the ESP32 in this session (PlatformIO's registry was not reachable). Build it with `pio run`
  before flashing.
- The KiCad PCB has no layout yet, so where the parts sit on the 3D HAT is a plausible arrangement; the part
  sizes are the real ones.
- Rebuilding `firmware.wasm` needs Zig (`pip install ziglang`) and Binaryen's `wasm-opt` (`npm install binaryen`),
  then `hardware/lab/hal/build.sh`.
- Driver behaviour (1.2 s reaction, 7 m/s² braking) is a textbook assumption, not part of the hardware.
