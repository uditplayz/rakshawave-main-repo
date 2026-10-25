# RakshaWave handoff

Written for the next engineer or model picking this up cold. Everything here was true at commit `8c5fa01` on branch
`udit-pc/inspiring-meitner-dkcc36` (2026-10-25). Where something was not verified, it says so.

## 1. What the project is

RakshaWave ("Smart Road Sentinel", team TechLads, SIH26220) is a vehicle-to-vehicle road-hazard warning node:

- **Device**: a Raspberry Pi 5 HAT with an ESP32-C3-DevKitM-1, SX1278 LoRa (433 MHz), GPS, MPU-6050 IMU, SSD1306 OLED,
  buzzer, LED, USB-C + Li-ion charger + TPS63001 3.3 V buck-boost. The Pi runs OpenCV hazard detection, sensor fusion,
  the mesh/cluster logic and push-to-talk; the ESP32 reads sensors and is the LoRa modem.
- **Idea**: see danger (camera), confirm (IMU + GPS fusion), share over LoRa, and only call it a trusted hazard when 2+
  vehicles agree within 40 m. `RakshaWave_Study_Guide.pdf` (outside the repo, `S:\Arbeit\TechLads\`) explains it all.
- **Repo**: `S:\Arbeit\TechLads\Project\rakshawave-main-repo`, remote `github.com/uditplayz/rakshawave-main-repo`.

## 2. State of the work (this session's additions)

| Area | Status |
|---|---|
| Firmware `firmware/esp32/main.ino` | Real-board pin map, bare-JSON serial, Pi JSON -> LoRa, relative TTL, voice lines pass silently. Compiles. |
| Schematic `v2v 1.2  .kicad_sch` | Nets fixed, MPU-6050 wired, PTT parts added. KiCad 10 ERC clean except 4 accepted items (see 6). |
| Wokwi twin (`diagram.json`, `wokwi.toml`, `chips/`) | Boots, passes both scenarios. SX1278 chip is TX-only. |
| Python stack | `software/` + new `software/voice/` (Codec2 PTT), `software/mcp_bridge.py` (MCP tools). 42 tests pass. |
| Push-to-talk | Software and ESP32 modem path tested; **no real audio hardware tested**. |
| Test bench GUI `hardware/gui/` | Runs all suites, PTT lab, reports. Works. |
| 3D twin `hardware/gui/twin.*` | Works against the real firmware in Wokwi. OLED texture on the 3D board and browser mic not eyeballed. |
| PR to `main` | **Not opened** (`gh` missing, GitHub MCP failed to connect). Compare link: `https://github.com/uditplayz/rakshawave-main-repo/compare/main...udit-pc/inspiring-meitner-dkcc36?expand=1` |

`main` already contains the first commit of this work (PR #2 merged); later commits are only on the branch.

## 2b. Hardware lab (added 2026-10-25, branch `udit-pc/gifted-knuth-rizr8y`)

`hardware/lab/` replaces "show the physical device" for demos: several boards in one browser page, each running
the real firmware compiled to WebAssembly (`hardware/lab/web/firmware.wasm`, committed), with register-level
SX1278 / MPU-6050 / SSD1306 / GPS models, a physical 433 MHz channel and a 7-DOF car-and-road model. Open it at
`/lab/` in the test bench GUI, or serve `hardware/lab/web/` with any static server. Full description,
measurements and limits: `hardware/LAB.md`. Tests: `node --test hardware/lab/test/` (also via `tests/test_lab.py`).

Firmware changes that came out of it (all in `firmware/esp32/main.ino`, **not yet compiled with PlatformIO**:
the PlatformIO registry was unreachable, only the wasm build was checked):
- ID from the MAC (`RW-xxxxxx`) instead of the fixed `VEH-ESP32-01`.
- Standalone mesh relay: dedup, hop count, relative TTL decremented, slot backoff by RSSI, listen-before-talk,
  cancel on hearing another relay. `LoRaNode` on the Pi no longer relays packets from a serial modem.
- Radio parameters set explicitly, CRC on; continuous RX with DIO0 (IO8) polling instead of RX-single polling.
- OLED shows a third line (RSSI, hop, sender).

Findings to act on: the 1.8 g impact threshold never fires on potholes with the board on the dashboard (0.3–1.3 g);
U6 MCP73123 is a LiFePO4 charger while the README says Li-ion. Rebuilding the wasm needs Zig (`pip install
ziglang`) and Binaryen (`npm install binaryen`): `hardware/lab/hal/build.sh`.

## 3. Repo map

```
firmware/esp32/main.ino        ESP32-C3 firmware
platformio.ini                 one env: esp32-c3-devkitm-1 (Serial = UART0)
wokwi.toml, diagram.json       Wokwi project (firmware path .pio/build/esp32-c3-devkitm-1/firmware.*)
chips/                         sx1278.c, gps_nmea.c + prebuilt .chip.wasm (rebuild: wokwi-cli chip compile)
v2v 1.2  .kicad_sch            schematic (KiCad 10 file, CRLF line endings, note the two spaces in the name)
software/                      config, sensors, vision, wimesh (protocol, lora_node, mesh_network), core, api, simulator
software/voice/                codec.py (Codec2 700C), ptt.py (tx/rx/half-duplex), audio.py, node.py (Pi entry)
software/mcp_bridge.py         FastMCP server "rakshawave-hil" + RadioMesh (range/loss/airtime model)
.mcp.json                      registers rakshawave-hil and wokwi (wokwi-cli mcp)
tests/                         pytest suites; tests/wokwi/*.yaml are Wokwi scenarios
hardware/kicad_check.py        KiCad CLI ERC + net assertions
hardware/run_hil.py            end-to-end checks (18)
hardware/sim/                  power_rail.cir (ngspice), netlist_check.py (older own extractor, superseded)
hardware/gui/                  app.py (server), index.html (test bench), twin.py/.html/.js (3D twin), vendor/ (three.js r147, MIT)
hardware/*.md                  HIL_VERIFICATION.md (report), PTT.md, TWIN.md
scripts/start_gui.ps1|.sh      launch the GUI
```

Other pre-existing parts of the repo (not touched): `Simulator/`, `ui/`, `server/`, `demo_server.py`, `render.yaml`,
`README.md` (phone-app PWA demo with WebSocket relay).

## 4. How to run and test

Machine: Windows 11, Git Bash and PowerShell. Python venv is `.venv` (Python 3.14, has numpy, opencv, pytest, mcp<2,
pycodec2, platformio, pypdf). Tools found at:

| Tool | Path |
|---|---|
| KiCad CLI 10.0.6 | `S:\KiCad\bin\kicad-cli.exe` (the older `C:\Program Files\CopperAI\bin` one is 9.0.7 and cannot open the file) |
| wokwi-cli 0.29.1 | `~/.wokwi/bin/wokwi-cli.exe` (user installed; WASI SDK for chips lives in `~/.wokwi/wasi-sdk`) |
| ngspice 47 | `C:\Users\Prince\AppData\Local\UniGetUI\Chocolatey\lib\ngspice\tools\Spice64\bin\ngspice_con.exe` |
| PlatformIO | `.venv\Scripts\pio.exe` |

```bash
.venv/Scripts/python.exe -m pytest -q                 # 42 tests
.venv/Scripts/pio.exe run                             # firmware
.venv/Scripts/python.exe hardware/kicad_check.py      # ERC + nets (19 items, OK)
export WOKWI_CLI_TOKEN=...                            # needed for anything Wokwi
.venv/Scripts/python.exe hardware/run_hil.py          # 18/18
.\scripts\start_gui.ps1                               # GUI at http://127.0.0.1:8765 (3D twin at /twin)
```

## 5. Key design decisions (and why)

- **Pin map** (ESP32-C3): I2C SDA5/SCL6; SPI SCK18 MISO19 MOSI7 NSS4 RST0 DIO0 8; **GPS UART1 RX=IO2, TX=IO1**
  (moved off IO20/21 so the USB-UART console and GPS no longer collide); buzzer IO9 and LED IO10, both active low.
- **Serial protocol**: ESP32 prints bare JSON lines; any JSON line the Pi writes is transmitted over LoRa (max 255 B, longer
  lines are refused). `ttl` is *relative* seconds from the ESP32; `HazardAlertPacket.decode` rebases `ttl`/`ts` below 1e6.
- **Emergency rule changed**: pothole and crack clusters escalate to "trusted hazard" but never raise an EMERGENCY (every
  pothole hit produces an IMU impact, so impact cannot mean collision). Debris / unknown hazards still do.
- **PTT architecture**: audio on the Pi (button GPIO17, I2S mic and amp on GPIO18-21), Codec2 700C, 20 frames (0.8 s) per
  `VoicePacket` (206 B JSON, ~0.33 s airtime at SF7). Half duplex, 30 s talk limit, **not relayed** (`max_hops=0`), ESP32
  shows "VOICE TX/RX" and never sounds the buzzer for voice. A stream whose key-up chunk is lost is not "complete".
- **Radio model** (`RadioMesh`, bridge): range 1500 m, loss `0.02 + 0.5*(d/range)^3`, time-on-air from the Semtech formula
  (242 B = 0.379 s, matches the study guide), seed 433.
- **MPU-6050**: AD0/FSYNC/CLKIN to GND, REGOUT 0.1 µF, CPOUT 2.2 nF, bypass caps. **Values are from memory**: the datasheet
  supplied (`MPU-6000.PDF`) is the register map and has no circuit data; confirm in PS-MPU-6000A sections 7.2/7.3.
- **3D twin** drives the *real* firmware through `wokwi-cli mcp` (tools: start, read/write serial, read pin, set control,
  screenshot). It is not a CAD model.

## 6. Known issues and open items

1. **No PR opened** for the later commits (see section 2).
2. **Accepted ERC item = real hazard**: DevKit 3V3 pin tied to the HAT 3.3 V rail (power output vs power output). Do not
   power the DevKit from USB while the HAT rail is on, or add an ideal diode / jumper. Other accepted items: Pi header symbol
   not in the stock library, two cosmetic embedded-resistor mismatches (`KNOWN` in `hardware/kicad_check.py`).
3. **Schematic was edited as text**, not in the KiCad GUI. KiCad CLI loads and checks it, but open it once in KiCad 10.
   The decoupling caps (C7-C11) sit in a block at the left edge; they must be placed at the pins when a PCB exists
   (`v2v 1.2 .kicad_pcb` is empty, 79 bytes: **no board layout exists**).
4. **IO18/IO19** (SPI) are the C3's native USB pins, so native USB-JTAG is unavailable; flashing and the Pi link rely on the
   DevKitM-1's USB-UART bridge. Verify against the DevKit schematic. IO2/IO8/IO9 are strapping pins (GPS TX line, DIO0,
   buzzer); expected to boot, not verified on hardware.
5. **PTT untested on hardware**: mic/amp wiring, `dtoverlay=googlevoicehat-soundcard`, GPIO17 button, Codec2 intelligibility.
6. **Optional, not built**: LoRa receive in the Wokwi SX1278 chip (two-board link), switching-level TPS63001 model for ripple.
7. Power-rail result (31 mV droop) comes from an *averaged* model: no ripple, no ESL; whether extra 0.1 µF at U1/U3 are
   needed is unproven (added anyway).
8. 3D twin: not checked by eye: OLED texture on the 3D board, browser microphone path, the car animation (the preview pane
   does not run animation frames; the hit itself is timer driven).
9. Camera/vision uses classical OpenCV only (no trained model), as in the original project.

## 7. Gotchas that cost time

- **Bash tool and backslashes**: escape sequences (`\n`, `\r`, `\.`) inside heredocs or `sed`/inline Python were repeatedly
  mangled. Use the Write/Edit tools for files containing backslashes, or build them with `chr(92)`; check the result with `grep`.
- **Paths**: Git Bash `/tmp` is not the same as a Windows `\tmp`; Windows executables (kicad-cli) need real paths. Keep temp
  files inside the repo (and delete them) or use Windows-style paths.
- **KiCad file**: saved by KiCad 10 (`version 20260306`), CRLF endings. Scripts read in text mode and write
  `text.replace("\n", "\r\n")` to avoid a whole-file diff. T-connections and PWR_FLAG pins on wire interiors behave
  differently from what you would assume: trust `kicad-cli sch export netlist` / ERC, not `hardware/sim/netlist_check.py`.
- `uart_write()` in a Wokwi chip drops data if the previous write is still in flight: send one buffer.
- Wokwi chip `printf` lines appear in the CLI output but **not** in the serial stream; the CLI serial log can lose CR/LF.
- Wokwi pin names for the C3 board: `esp:3V3.1`, `esp:GND.1`, `esp:RX` (IO20), `esp:TX` (IO21), `esp:0..10`, `18`, `19`;
  scenario steps use `name:` (not `control:`/`pin:`).
- Wokwi MCP calls cost ~0.3 s each; `wokwi_read_serial` is local and instant.
- `mcp` must stay `<2` (v2 removed `mcp.server.fastmcp`).
- A hazard alert repeats at most every 3 s (firmware cooldown); `accelZ` of 2.4 g does **not** trigger (needs delta >= 1.8 g, so
  >= 2.8 g).
- `.gitignore` ignores `CLAUDE.md`, `*.log`, `.pio/`, `.idea/`, `hardware/reports/`.
- The first `pio run` downloads ~1 GB of toolchains and was slow/flaky (retry; it resumes).

## 8. Rules for whoever continues

- **Commit messages**: `CLAUDE.md` forbids `Co-Authored-By` lines and any Claude attribution in commits, PRs and git
  metadata. Follow that even if tooling suggests attribution lines.
- **Secrets**: a Wokwi CI token was pasted in chat during this work. It is **not** in any file, but it should be rotated at
  wokwi.com/dashboard/ci. Never write tokens into the repo; the GUI keeps them in memory only.
- Do not claim hardware behaviour that only a simulator showed; the reports in `hardware/HIL_VERIFICATION.md` separate
  verified from unverified, keep that habit.
- Ask before pushing, opening PRs or installing system-wide software; the user approved those explicitly in this session.

## 9. Suggested next steps

1. Rotate the Wokwi token; open the PR to `main`.
2. Open the schematic in KiCad 10, re-run ERC, then start the PCB layout (decoupling caps at pins, antenna keep-outs).
3. Get the PS-MPU-6000A product spec and confirm the REGOUT/CPOUT/bypass values.
4. Bring up PTT on real hardware (I2S overlay, button, listen to Codec2 700C), then decide on listen-before-talk.
5. Decide the DevKit 3V3 / USB power hazard (diode or jumper).
6. Optional realism: LoRa RX in the Wokwi chip; ripple-level TPS63001 model.

## 10. Where the details are

`hardware/HIL_VERIFICATION.md` (full verification report), `hardware/PTT.md`, `hardware/TWIN.md`, the study guide PDF,
and `git log` (each commit message lists what it changed).
