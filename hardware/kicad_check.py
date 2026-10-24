"""
KiCad CLI checks for the schematic: ERC plus the nets KiCad itself extracts.

    python hardware/kicad_check.py                 # ERC + required-net assertions
    python hardware/kicad_check.py --diff OTHER    # nets that differ from another schematic

The schematic is saved by KiCad 10, so the CLI must be 10.x (KICAD_CLI overrides the lookup).
Violations listed in KNOWN are accepted on purpose, each with the reason.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "sim"))
import netlist_check as sexp  # noqa: E402  (only its S-expression parser is used)

ROOT = Path(__file__).resolve().parents[1]
SCH = ROOT / "v2v 1.2  .kicad_sch"

# (ERC type, text that must appear in the item description) -> why it is accepted
KNOWN = {
    ("lib_symbol_issues", "Raspberry_Pi_5_Model_B"): "Pi header symbol is a project-local symbol, not in the stock library",
    ("lib_symbol_mismatch", "[R]"): "embedded resistor symbol differs from the stock 10.0 copy only cosmetically",
    ("pin_to_pin", "U4 Pin 2 [3V3"): (
        "the DevKit 3V3 pin (its LDO output) is fed from the HAT 3.3 V rail on purpose; "
        "do not power the DevKit from USB while the HAT rail is on"
    ),
}

# nets that must exist after the fixes: name -> pins that must all be on it
REQUIRED = {
    "+3.3V": ["U7.1", "U7.10", "U4.2", "U3.13", "U3.8", "U1.3", "U5.2", "R5.1", "BZ1.1", "C7.1", "C8.1", "C11.1", "J3.1"],
    "/BAT+": ["J1.1", "U7.5", "U7.6", "U6.3", "C4.2"],
    "GND": ["U3.9", "U3.11", "U3.1", "C9.2", "C10.2", "SW1.2", "J3.5", "J3.6", "J4.7", "U8.9"],
    "/PTT_BTN": ["U8.11", "SW1.1"],
    "/I2S_BCLK": ["U8.12", "J3.2", "J4.3"],
    "/I2S_LRCLK": ["U8.35", "J3.3", "J4.4"],
    "/I2S_MIC_DIN": ["U8.38", "J3.4"],
    "/I2S_SPK_DOUT": ["U8.40", "J4.2"],
    "/+5V_PI": ["U8.2", "U8.4", "J4.1"],
    "/MPU_REGOUT": ["U3.10", "C9.1"],
    "/MPU_CPOUT": ["U3.20", "C10.1"],
}
JOINED = [("U4.4", "U2.4"), ("U4.10", "U2.5")]      # GPS TX -> IO2 (RX), GPS RX <- IO1 (TX)
SEPARATE = [("U4.28", "U2.4"), ("U4.29", "U2.5")]    # IO20/IO21 stay free for the USB-UART console


def find_cli() -> str:
    cands = [os.environ.get("KICAD_CLI"), shutil.which("kicad-cli")]
    for base in ("S:/KiCad", "C:/Program Files/KiCad/10.0", "C:/Program Files/KiCad/10.0.6"):
        cands.append(f"{base}/bin/kicad-cli.exe")
    for c in cands:
        if c and Path(c).exists():
            return c
    raise SystemExit("kicad-cli not found (install KiCad 10 or set KICAD_CLI)")


def run_erc(sch: Path):
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "erc.json"
        subprocess.run([find_cli(), "sch", "erc", "--severity-all", "--format", "json", "-o", str(out), str(sch)],
                       check=True, capture_output=True)
        data = json.loads(out.read_text(encoding="utf-8"))
    for sheet in data.get("sheets", []):
        for v in sheet.get("violations", []):
            yield v["type"], v["severity"], " | ".join(i["description"] for i in v.get("items", []))


def nets(sch: Path) -> dict:
    with tempfile.TemporaryDirectory() as d:
        out = Path(d) / "k.net"
        subprocess.run([find_cli(), "sch", "export", "netlist", "--format", "kicadsexpr", "-o", str(out), str(sch)],
                       check=True, capture_output=True)
        root = sexp.parse(out.read_text(encoding="utf-8"))
    res = {}
    for net in sexp.kids(sexp.kid(root, "nets"), "net"):
        res[sexp.kid(net, "name")[1]] = frozenset(
            f"{sexp.kid(nd, 'ref')[1]}.{sexp.kid(nd, 'pin')[1]}" for nd in sexp.kids(net, "node"))
    return res


def main() -> int:
    if "--diff" in sys.argv:
        other = Path(sys.argv[sys.argv.index("--diff") + 1])
        a = {v for v in nets(SCH).values() if len(v) > 1}
        b = {v for v in nets(other).values() if len(v) > 1}
        print("only in", SCH.name, [sorted(x)[:8] for x in a - b])
        print("only in", other.name, [sorted(x)[:8] for x in b - a])
        return 0

    print(f"kicad-cli {subprocess.run([find_cli(), 'version'], capture_output=True, text=True).stdout.strip()}")
    bad = 0
    for typ, sev, desc in run_erc(SCH):
        why = next((w for (t, s), w in KNOWN.items() if t == typ and s in desc), None)
        if why:
            print(f"[accepted] {typ}: {desc[:90]} -- {why}")
        else:
            bad += 1
            print(f"[{sev.upper()}] {typ}: {desc[:140]}")

    n = nets(SCH)
    for name, pins in REQUIRED.items():
        have = n.get(name, frozenset())
        missing = [p for p in pins if p not in have]
        print(f"[{'FAIL' if missing else 'PASS'}] net {name}" + (f" missing {missing}" if missing else f" ({len(have)} pins)"))
        bad += bool(missing)
    for a, b in JOINED:
        ok = any(a in v and b in v for v in n.values())
        print(f"[{'PASS' if ok else 'FAIL'}] {a} and {b} are on the same net")
        bad += not ok
    for a, b in SEPARATE:
        joined = any(a in v and b in v for v in n.values())
        print(f"[{'FAIL' if joined else 'PASS'}] {a} and {b} are on different nets")
        bad += joined
    print(f"\n{'OK' if not bad else str(bad) + ' problem(s)'}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
