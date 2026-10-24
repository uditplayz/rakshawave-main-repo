# RakshaWave HIL verification report

What was actually executed, what was not, and what the checks found. Nothing
below is claimed as verified unless the "Evidence" column says it ran.

## Status by layer

| Layer | Status | Evidence |
|---|---|---|
| KiCad nets (BAT+, +3.3V, U7 EN, LED resistor) | Fixed, verified by netlist extraction | `python hardware/sim/netlist_check.py "v2v 1.2  .kicad_sch"` |
| Firmware pin map / serial protocol / TTL | Compiles for ESP32-C3 and runs in Wokwi on the real-board pin map (UART0 console) | `pio run`, Wokwi scenario |
| Wokwi twin (ESP32-C3, MPU6050, SSD1306, SX1278 + GPS custom chips, buzzer, LED) | **Boots and passes** `tests/wokwi/hil.test.yaml` | `hardware/run_hil.py`, `hardware/oled_alert.png` |
| Power rail transient | Simulated in ngspice 47 | `hardware/sim/power_rail.cir`, `power_rail_results.txt` |
| Python stack as MCP server | Built, 42 tests pass | `software/mcp_bridge.py`, `tests/test_mcp_bridge.py` |
| Full HIL chain (Wokwi -> bridge -> mesh) | 18/18 checks pass | `python hardware/run_hil.py` |
| KiCad ERC + KiCad-extracted nets | Clean apart from 4 accepted items | `python hardware/kicad_check.py` (KiCad 10.0.6 CLI) |
| Push-to-talk voice | Software + modem path tested; audio hardware untested | `hardware/PTT.md`, `tests/test_ptt.py`, `tests/wokwi/ptt.test.yaml` |
| `ltspice-mcp` server | **Not installed** | unverified package; ngspice driven directly |

## 1. Schematic (`v2v 1.2  .kicad_sch`)

Before: `+3V3` (U7 VOUT/FB, C5, C6) and `+3.3V` (all loads) were separate
nets, `Bat+` (J1) was separate from `BAT+`, U7 `EN` was floating, and the
buzzer + / LED anode net was not tied to any supply.

After (checked with the extractor):

- `+3.3V`: U7.VOUT/FB, C5, C6, U1, U2, U3, U4.3V3, U5, BZ1.+, R5.1
- `BAT+`: J1.1, C4, R4, U7.VIN, **U7.EN**
- `D1.A` -> `R5` (330 R, new) -> `+3.3V`; `D1.K` -> U4.IO10; `BZ1.-` -> U4.IO9

Second pass (pin clash and MPU6050), also checked by net extraction:

- GPS moved off IO20/IO21 to IO2 (RX, from GPS TX) / IO1 (TX); IO20/IO21 now
  carry only the USB-UART console and are marked no-connect. IO2 is a strapping
  pin: the GPS TX line idles high, which keeps it high at reset.
- U3 `AD0`, `FSYNC`, `CLKIN` -> GND (address 0x68, unused inputs).
- U3 `REGOUT` -> C9 0.1 uF, `CPOUT` -> C10 2.2 nF (net labels `MPU_REGOUT`,
  `MPU_CPOUT`); C7/C8 0.1 uF on U3 `VDD`/`VLOGIC`; C11 0.1 uF on U1 (Ra-01) `VDD`.
  The caps sit in a block at the left edge of the sheet; **place them at the
  pins when the PCB is laid out.** The values are the usual MPU-6050 typical-circuit
  values from memory: the datasheet could not be fetched here, so check section 7.2/7.3
  of the InvenSense PS-MPU-6000A before fabrication. The PDF supplied later (RM-MPU-6000A-00 rev 4.2) is the
  *register map*; it has no circuit or capacitor information, so the values are still unverified.

## 2. Pin map as implemented

| Function | Pins |
|---|---|
| I2C (MPU6050 0x68, SSD1306 0x3C) | SDA IO5, SCL IO6 |
| SPI (SX1278) | SCK IO18, MISO IO19, MOSI IO7, NSS IO4, RST IO0, DIO0 IO8 |
| GPS UART1, 9600 | RX IO2 (from GPS TX), TX IO1 |
| Console / Pi link (USB-UART bridge) | UART0 on IO20/IO21, no longer shared with the GPS |
| Buzzer / LED (active low) | IO9 / IO10 |

Serial protocol: bare JSON lines out (no `RX: ` prefix); JSON lines in are
transmitted over LoRa; `ttl` is relative seconds (30) and
`HazardAlertPacket.decode` rebases `ttl`/`ts` values below 1e6 to wall-clock.

## 3. Power rail (ngspice, averaged TPS63001 model)

135 mA base, +155 mA step (LoRa TX burst + buzzer/LED) at 2 ms, 1 us rise,
Rbat 80 mR, C2 4.7 uF + C4 10 uF in, 2 x 10 uF out derated to 60 %.

| Vbat | +3.3V min | overshoot on release | VINA (after R4/C3) min | BAT+ min |
|---|---|---|---|---|
| 4.2 V | 3.269 V | 3.331 V | 4.149 V | 4.179 V |
| 3.6 V | 3.269 V | 3.331 V | 3.546 V | 3.575 V |
| 3.0 V | 3.269 V | 3.331 V | 2.941 V | 2.970 V |

- **+3.3V droop is about 31 mV (0.9 %)**, the same in every corner because
  the output loop is modelled identically. That is far inside the 3.0 V
  minimum of the ESP32-C3 and the 3.46 V maximum of the MPU6050.
- The filtered VINA pin sits 59 mV below BAT+ at the 3.0 V corner (R4 x I_VINA,
  with an assumed 0.3 mA VINA current; check the TPS63001 datasheet).
- Limits of this model: no switching ripple, no inductor saturation, no RHP
  zero, no ESL/trace inductance. It cannot show the nanosecond-scale edge
  of a PA turn-on, which is what local 0.1 uF caps at U1/U3 are for. So the
  answer to "do we need extra 0.1 uF at U1 and U3?" is **yes as standard
  practice (place one at each supply pin), but this simulation neither proves
  nor disproves the need**. Also see the MPU6050 note below.

## 4. Python HIL flow (rakshawave-hil)

Run with a real ESP32-format packet and a synthetic 640x480 pothole frame:

- Vision: pothole, confidence 0.881, circularity 0.860, darkness 0.819
- Fusion: fused 0.946 (vision 0.881, IMU confirmed, GPS reliable) -> verified
- Broadcast: 1 transmission, packet id preserved across hops
- VEH-002 reports 12 m away -> `CL-0001` escalates at 2 vehicles (radius 40 m);
  a peer 60 m away makes a separate, non-escalated cluster
- Dedup: over an 8-relay chain 1 km apart (range 1.5 km) the packet reaches
  hop 5 and stops; exactly one transmission per hop, no storm

## 5. Remaining hardware notes

1. **IO18/IO19** are the C3's native USB D-/D+ pins and are used for SPI, so
   native USB-JTAG is unavailable; flashing and the Pi link use the USB-UART
   bridge on IO20/IO21 (the DevKitM-1's CP2102N). Check this against the
   DevKitM-1 schematic before relying on it.
2. **IO9 / IO8 / IO2 are strapping pins** (buzzer, LoRa DIO0, GPS TX line). The
   active-low buzzer and the idle-high GPS line should boot normally, but verify.
3. The ESP32 `5V` pin (U4.13) and RST are unconnected; the HAT only brings 5 V
   and GND from the Pi header.

## 6. Findings in the request itself

- "2.4 g Z spike ... `|mag - 1.0| >= 1.8 g`" is inconsistent: 2.4 g gives 1.4 g
  of delta and will not trigger the firmware. The Wokwi scenario uses 3.0 g.
  The MPU is set to +/-4 g, so spikes above 4 g clip.
- `EmergencyResponder` used to raise an EMERGENCY for a corroborated pothole
  (the simulator's "confidence >= 0.8 means impact" hint). Every pothole hit
  produces an IMU impact, so that signal cannot tell a collision from road
  damage. **Changed:** pothole and crack clusters still escalate to a trusted
  hazard but never raise an EMERGENCY; debris / unknown hazards still do.
  Tests cover both, and `run_hil.py` runs a debris control case.
- `uv tool install ltspice-mcp` / `Cognitohazard/ltspice-mcp` could not be
  verified as a real, trustworthy package, so it was not installed.
- The Wokwi CLI was installed by you (`~/.wokwi/bin`); the `curl | sh` installer
  was not run by this work. The Wokwi MCP server is registered in `.mcp.json`
  via `wokwi-cli mcp` and reads `WOKWI_CLI_TOKEN` from the environment.

## 6b. Wokwi twin notes

- The twin runs the real-board build: `Serial` is UART0 through
  `$serialMonitor`, GPS on IO1/IO2. The earlier USB-Serial/JTAG workaround and
  the `wokwi` PlatformIO env are gone.
- The SX1278 chip only models TX (FIFO + TX_DONE). It prints each frame as
  `[chip-sx1278] [sx1278] TX #n ...` in the CLI output; that line is not part of
  the serial stream, so scenarios wait on the ESP32's own JSON line instead.
- `uart_write()` drops data while a previous write is in flight, so the GPS
  chip sends GGA + RMC as one buffer (otherwise speed stayed 0).
- The CLI's serial log can lose the CR/LF the firmware prints, so
  `run_hil.py` extracts the packet with a regex.
- The alert's `hz` is `unknown_hazard` (IMU only); the pothole type comes from
  the Pi's vision stage during fusion.
- Not done (optional): LoRa receive in the SX1278 chip / two-board link, and a
  switching-level TPS63001 model for ripple.

## 6c. KiCad CLI check

`python hardware/kicad_check.py` runs ERC and exports the netlist with `kicad-cli` (10.x, the version that saved the file),
then asserts the nets that matter (rails, GPS on IO1/IO2, MPU pins, PTT and I2S nets). The first run found 59 violations;
the fixes were no-connect flags on unused Pi header pins, PWR_FLAGs on `GND`, `BAT+`, `+5V_PI` and the filtered `VINA`
net, grid alignment of the decoupling block, and removal of a dead wire branch left from the old LED wiring (the KiCad
net lists before and after are identical). Accepted on purpose, listed in `KNOWN`:

- **U4 3V3 / U7 VOUT power-output conflict**: the DevKit's 3V3 pin is fed from the HAT rail. This is a real hazard: do not
  power the DevKit from USB (its LDO would fight the HAT regulator) while the HAT rail is on, or add an ideal-diode/jumper.
- Pi header symbol not in the stock library, and two cosmetic embedded-resistor mismatches.

Also found while checking the supplied datasheet: nothing in it contradicts the pin wiring, but it cannot confirm the
capacitor values.

## 7. Reproduce

```bash
python -m pytest -q
python hardware/kicad_check.py        # KiCad ERC + nets (needs KiCad 10 CLI)
ngspice -b hardware/sim/power_rail.cir

pio run                               # builds .pio/build/esp32-c3-devkitm-1/firmware.{bin,elf}
export WOKWI_CLI_TOKEN=...            # from wokwi.com/dashboard/ci
python hardware/run_hil.py            # boots Wokwi, then drives the Python stack
# chips are prebuilt; to rebuild:
wokwi-cli chip compile chips/sx1278.c   -o chips/sx1278.chip.wasm
wokwi-cli chip compile chips/gps_nmea.c -o chips/gps_nmea.chip.wasm
```
