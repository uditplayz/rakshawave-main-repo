"""
Minimal KiCad 8/9 .kicad_sch connectivity extractor (wires, junctions,
local labels, power symbols) used to verify the schematic fixes without
needing kicad-cli.

    python hardware/sim/netlist_check.py "v2v 1.2  .kicad_sch" [--net NAME ...]
"""

from __future__ import annotations

import math
import re
import sys
from collections import defaultdict
from pathlib import Path

_TOKEN = re.compile(r'"((?:[^"\\]|\\.)*)"|([()])|([^\s()"]+)')


def parse(text: str):
    stack: list[list] = [[]]
    for m in _TOKEN.finditer(text):
        if m.group(2) == "(":
            stack.append([])
        elif m.group(2) == ")":
            done = stack.pop()
            stack[-1].append(done)
        else:
            stack[-1].append(m.group(1) if m.group(1) is not None else m.group(3))
    return stack[0][0]


def kids(node, name):
    return [c for c in node if isinstance(c, list) and c and c[0] == name]


def kid(node, name):
    r = kids(node, name)
    return r[0] if r else None


def prop(node, key):
    for p in kids(node, "property"):
        if p[1] == key:
            return p[2]
    return None


def _key(x: float, y: float):
    return (round(x, 2), round(y, 2))


def extract(path: str):
    root = parse(Path(path).read_text(encoding="utf-8"))
    libs = {}
    for s in kid(root, "lib_symbols")[1:]:
        if isinstance(s, list) and s[0] == "symbol":
            pins = []
            for sub in [s] + kids(s, "symbol"):
                for p in kids(sub, "pin"):
                    if kid(p, "hide") and kid(p, "hide")[1:] == ["yes"]:
                        hidden = True
                    else:
                        hidden = "hide" in p
                    at = kid(p, "at")
                    pins.append((kid(p, "number")[1], kid(p, "name")[1], float(at[1]), float(at[2]), hidden, p[1]))
            libs[s[1]] = pins

    parent: dict = {}

    def find(a):
        parent.setdefault(a, a)
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a, b):
        parent[find(a)] = find(b)

    for w in kids(root, "wire"):
        pts = kid(w, "pts")
        xy = [_key(float(p[1]), float(p[2])) for p in kids(pts, "xy")]
        union(xy[0], xy[1])
    for j in kids(root, "junction"):
        at = kid(j, "at")
        find(_key(float(at[1]), float(at[2])))
    # wire endpoints landing mid-wire are joined only via junctions in KiCad,
    # so no T-detection here on purpose.

    names: list[tuple] = []  # (point, netname)
    for l in kids(root, "label") + kids(root, "global_label"):
        at = kid(l, "at")
        names.append((_key(float(at[1]), float(at[2])), l[1]))

    pin_at: dict = defaultdict(list)  # point -> [(ref, pinno, pinname)]
    for s in kids(root, "symbol"):
        lib = kid(s, "lib_id")[1]
        at = kid(s, "at")
        x, y, rot = float(at[1]), float(at[2]), float(at[3]) if len(at) > 3 else 0.0
        mirror = kid(s, "mirror")
        ref = prop(s, "Reference")
        for inst in kids(s, "instances"):
            for pr in kids(inst, "project"):
                for pa in kids(pr, "path"):
                    r = kid(pa, "reference")
                    if r:
                        ref = r[1]
        val = prop(s, "Value")
        for num, pname, px, py, hidden, ptype in libs.get(lib, []):
            if lib.startswith("power:") or hidden:
                if not lib.startswith("power:"):
                    continue
            if mirror:
                if mirror[1] == "x":
                    py = -py
                else:
                    px = -px
            a = math.radians(rot)
            rx = px * math.cos(a) - py * math.sin(a)
            ry = px * math.sin(a) + py * math.cos(a)
            pt = _key(x + rx, y - ry)
            find(pt)
            if lib.startswith("power:"):
                if lib != "power:PWR_FLAG":
                    names.append((pt, val))
            else:
                pin_at[pt].append((ref, num, pname))

    for pt, nm in names:
        union(pt, ("NET", nm))

    nets: dict = defaultdict(list)
    for pt, pins in pin_at.items():
        for ref, num, pname in pins:
            nets[find(pt)].append(f"{ref}.{num}({pname})")
    labelled: dict = {}
    for pt, nm in names:
        labelled[find(pt)] = nm
    result = {}
    for root_id, pins in nets.items():
        nm = labelled.get(root_id) or ("unnamed:" + sorted(pins)[0])
        result.setdefault(nm, []).extend(pins)
    return {k: sorted(v) for k, v in result.items()}


if __name__ == "__main__":
    args = sys.argv[1:]
    want = []
    if "--net" in args:
        i = args.index("--net")
        want = args[i + 1:]
        args = args[:i]
    nets = extract(args[0])
    for name in sorted(nets):
        if want and name not in want:
            continue
        pins = nets[name]
        if not want and len(pins) < 2 and not name.startswith("+") and name != "GND":
            print(f"[single] {name}: {pins}")
            continue
        print(f"{name}: {' '.join(pins)}")
