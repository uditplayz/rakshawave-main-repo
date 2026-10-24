"""
End-to-end hardware-in-the-loop run:

  1. boot the Wokwi twin (ESP32-C3 + MPU6050 + SSD1306 + SX1278 + GPS chip),
     inject a 3.0 g pothole spike, check buzzer/LED pins and the OLED
     (tests/wokwi/hil.test.yaml)
  2. take the JSON packet the ESP32 printed on USB serial
  3. fuse it with a synthetic camera frame, broadcast it over the radio model,
     add VEH-002 12 m away and check clustering / dedup / emergency

Usage (WOKWI_CLI_TOKEN must be set; wokwi-cli on PATH or ~/.wokwi/bin):
    python hardware/run_hil.py
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from software import mcp_bridge as bridge  # noqa: E402
from software.wimesh.protocol import VoicePacket  # noqa: E402

SERIAL_LOG = ROOT / "hardware" / "wokwi_serial.log"
checks: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    checks.append((name, ok, detail))
    print(f"[{'PASS' if ok else 'FAIL'}] {name}" + (f" - {detail}" if detail else ""))


def find_wokwi() -> str | None:
    return shutil.which("wokwi-cli") or next(
        (str(p) for p in [Path.home() / ".wokwi" / "bin" / "wokwi-cli.exe", Path.home() / ".wokwi" / "bin" / "wokwi-cli"] if p.exists()),
        None,
    )


def run_wokwi() -> str:
    exe = find_wokwi()
    if not exe or not os.environ.get("WOKWI_CLI_TOKEN"):
        print("wokwi-cli or WOKWI_CLI_TOKEN missing; using the last captured serial log")
        return SERIAL_LOG.read_text() if SERIAL_LOG.exists() else ""
    proc = subprocess.run(
        [exe, "--timeout", "40000", "--scenario", "tests/wokwi/hil.test.yaml",
         "--serial-log-file", str(SERIAL_LOG), "."],
        cwd=ROOT, capture_output=True, text=True,
    )
    check("Wokwi scenario (boot, spike, buzzer/LED pins, OLED)", proc.returncode == 0,
          "scenario completed" if proc.returncode == 0 else (proc.stdout + proc.stderr)[-400:])
    return SERIAL_LOG.read_text()


def run_ptt() -> None:
    """Push-to-talk: the Pi writes a VoicePacket line to the ESP32 modem, then a full Pi-side talk."""
    sample = (ROOT / "hardware" / "ptt_sample_line.txt").read_bytes().strip()
    exe = find_wokwi()
    if exe and os.environ.get("WOKWI_CLI_TOKEN"):
        proc = subprocess.run([exe, "--timeout", "30000", "--scenario", "tests/wokwi/ptt.test.yaml", "."],
                              cwd=ROOT, capture_output=True, text=True)
        check("Wokwi PTT scenario (voice TX silent, long line refused, hazard still alerts)", proc.returncode == 0,
              "scenario completed" if proc.returncode == 0 else (proc.stdout + proc.stderr)[-400:])
        m = re.search(r"\[sx1278\] TX #1 (\d+) bytes: (\{.*\})", proc.stdout)
        ok = bool(m) and m.group(2).encode() == sample and int(m.group(1)) == len(sample)
        check("ESP32 put the voice chunk on LoRa byte for byte", ok, f"{m.group(1)} bytes" if m else "no TX seen")
        if ok:
            pkt = VoicePacket.decode(m.group(2).encode())
            check("Transmitted voice frame decodes (Codec2 700C, fits 255 B)", pkt.codec == "700C" and len(sample) <= 255,
                  f"{len(pkt.payload)} B of speech = {len(pkt.payload) // 4 * 40} ms")
    bridge.reset_bench()
    bridge.simulate_corroborating_peer("VEH-NEAR", "pothole", 18.5204, 73.8567, 300)
    talk = bridge.ptt_talk("VEH-A", 18.5204, 73.8567, seconds=3.0)
    near = talk["listeners"]["VEH-NEAR"]
    check("PTT: 3 s of speech reaches a vehicle 300 m away intact", near["complete"] and near["audible"],
          f"{talk['packets']} packets, {talk['airtime_s']} s airtime, played {near['played_s']} s")
    check("PTT: airtime is below real time (can keep up with live speech)", talk["airtime_s"] < talk["talked_s"],
          f"{talk['airtime_s']} s airtime for {talk['talked_s']} s of speech")


def main() -> int:
    # The CLI's serial log can drop the CR/LF the firmware prints, so match on the whole text.
    text = run_wokwi()
    for needle, label in [("OLED ok", "OLED init (SSD1306 @0x3C)"), ("MPU6050 ok", "MPU6050 init (@0x68)"),
                          ("LoRa ok", "LoRa.begin(433E6) via SX1278 chip")]:
        check(label, needle in text)

    packets = re.findall(r'\{"id":[^{}]*"t":"HAZARD_ALERT"[^{}]*\}', text)
    check("ESP32 emitted a bare JSON HAZARD_ALERT line", bool(packets), f"{len(packets)} packet(s)")
    if not packets:
        return 1
    raw = packets[0]
    pkt = json.loads(raw)
    check("GPS fix used (Pune, speed from $GPRMC)", abs(pkt["lat"] - 18.5204) < 1e-3 and pkt["spd"] > 40,
          f"lat={pkt['lat']:.4f} lon={pkt['lon']:.4f} spd={pkt['spd']:.1f} km/h conf={pkt['c']}")
    check("TTL is relative (ESP32 has no wall clock)", pkt["ttl"] < 1_000_000, f"ttl={pkt['ttl']}")

    bridge.reset_bench()
    vision = bridge.run_vision_detector("pothole")
    check("Vision: synthetic pothole detected", vision["detected"] and vision["hazard_type"] == "pothole",
          f"conf={vision['confidence']} circularity={vision['circularity']} darkness={vision['darkness_score']}")

    fused = bridge.fuse_and_ingest_esp32_serial(raw, vision["confidence"])
    check("Fusion verifies and broadcasts once", fused.get("verified") and fused["broadcast"]["transmissions"] == 1,
          f"fused={fused['fusion']['fused_confidence']}")

    peer = bridge.simulate_corroborating_peer("VEH-002", "pothole", pkt["lat"], pkt["lon"], 12)
    cluster = peer["clusters"][0]
    check("VEH-002 12 m away escalates CL-0001 (>=2 vehicles, 40 m)",
          cluster["cluster_id"] == "CL-0001" and cluster["escalated"], f"vehicles={cluster['corroborating_vehicles']}")

    state = bridge.get_mesh_state()
    check("Dedup: no broadcast storm, hops <= 5",
          all(p["storm_free"] for p in state["packets"].values()) and state["max_hop_observed"] <= 5,
          f"{state['total_transmissions']} tx, {state['total_airtime_s']} s airtime, max hop {state['max_hop_observed']}")
    check("Corroborated pothole is a trusted cluster but NOT an EMERGENCY (routine road damage)",
          len(state["emergency_events"]) == 0 and not state["emergency_broadcasts"],
          f"{len(state['emergency_events'])} EMERGENCY")

    # Control case: two vehicles reporting debris (collision-type hazard) must escalate.
    bridge.reset_bench()
    bridge.simulate_corroborating_peer("VEH-001", "debris", pkt["lat"], pkt["lon"], 0)
    ctl = bridge.simulate_corroborating_peer("VEH-002", "debris", pkt["lat"], pkt["lon"], 12)
    check("Control: corroborated debris raises an EMERGENCY broadcast",
          len(ctl["emergencies"]) == 1 and len(bridge.get_mesh_state()["emergency_broadcasts"]) == 1)

    run_ptt()

    failed = [c for c in checks if not c[1]]
    print(f"\n{len(checks) - len(failed)}/{len(checks)} checks passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
