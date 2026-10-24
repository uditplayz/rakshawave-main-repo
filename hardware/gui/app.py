"""
RakshaWave test bench GUI: run every check from a browser, watch live logs, try push-to-talk
with your own microphone, and keep HTML reports.

    python hardware/gui/app.py            # opens http://127.0.0.1:8765

Standard library only (plus numpy and the project's own modules). The Wokwi token is taken from
WOKWI_CLI_TOKEN or typed into the page; it is held in memory for the run and never written to disk.
"""

from __future__ import annotations

import base64
import glob
import html
import json
import os
import random
import re
import shutil
import subprocess
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "hardware"))

HERE = Path(__file__).resolve().parent
REPORTS = ROOT / "hardware" / "reports"
PORT = int(os.environ.get("RW_GUI_PORT", "8765"))


# ------------------------------------------------------------------ tools
def find_tool(name: str, extra=()) -> str | None:
    cands = [shutil.which(name), *extra]
    for pat in extra:
        cands.extend(glob.glob(str(pat)))
    for c in cands:
        if c and Path(c).exists():
            return str(c)
    return None


def tools() -> dict:
    py_dir = Path(sys.executable).parent
    home = Path.home()
    out = {
        "python": sys.executable,
        "pio": find_tool("pio", [py_dir / "pio.exe", py_dir / "pio"]),
        "wokwi-cli": find_tool("wokwi-cli", [home / ".wokwi/bin/wokwi-cli.exe", home / ".wokwi/bin/wokwi-cli"]),
        "ngspice": find_tool("ngspice_con", [
            home / "AppData/Local/UniGetUI/Chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe",
            "C:/ProgramData/chocolatey/lib/ngspice/tools/Spice64/bin/ngspice_con.exe",
        ]) or find_tool("ngspice"),
    }
    try:
        import kicad_check  # type: ignore
        out["kicad-cli"] = kicad_check.find_cli()
    except SystemExit:
        out["kicad-cli"] = None
    return out


# ------------------------------------------------------------------ suites
def suites() -> dict:
    t = tools()
    py = t["python"]
    return {
        "build": dict(title="Build firmware", desc="PlatformIO build of the ESP32-C3 firmware", needs=["pio"],
                      cmd=[t["pio"] or "pio", "run"], parser="build", timeout=900),
        "unit": dict(title="Unit tests", desc="pytest: protocol, mesh, emergency rule, PTT, MCP bridge", needs=[],
                     cmd=[py, "-m", "pytest", "-v", "--tb=short", "-p", "no:cacheprovider"], parser="pytest", timeout=300),
        "kicad": dict(title="KiCad ERC and nets", desc="kicad-cli ERC plus the nets that matter", needs=["kicad-cli"],
                      cmd=[py, "hardware/kicad_check.py"], parser="tagged", timeout=300),
        "spice": dict(title="Power rail (ngspice)", desc="3.3 V rail droop on a 155 mA LoRa/buzzer step, 3 battery corners",
                      needs=["ngspice"], cmd=[t["ngspice"] or "ngspice", "-b", "hardware/sim/power_rail.cir"],
                      parser="spice", timeout=300),
        "hazard": dict(title="Wokwi: hazard alert", desc="Boot the twin, inject a 3 g pothole, check buzzer/LED/OLED",
                       needs=["wokwi-cli", "token"],
                       cmd=[t["wokwi-cli"] or "wokwi-cli", "--timeout", "40000", "--scenario", "tests/wokwi/hil.test.yaml",
                            "--serial-log-file", "hardware/wokwi_serial.log", "."], parser="wokwi", timeout=120),
        "ptt": dict(title="Wokwi: push-to-talk modem", desc="Voice chunk goes out over LoRa silently; long line refused",
                    needs=["wokwi-cli", "token"],
                    cmd=[t["wokwi-cli"] or "wokwi-cli", "--timeout", "30000", "--scenario", "tests/wokwi/ptt.test.yaml", "."],
                    parser="wokwi", timeout=120),
        "hil": dict(title="End to end (HIL)", desc="Wokwi + vision + fusion + mesh + clusters + PTT", needs=["wokwi-cli", "token"],
                    cmd=[py, "hardware/run_hil.py"], parser="tagged", timeout=400),
    }


ORDER = ["build", "unit", "kicad", "spice", "hazard", "ptt", "hil"]


# ------------------------------------------------------------------ parsers
def parse_pytest(text: str):
    checks = []
    for m in re.finditer(r"^(tests[/\\]\S+?)::(\S+) (PASSED|FAILED|ERROR|SKIPPED|XFAIL|XPASS)", text, re.M):
        checks.append(dict(name=f"{Path(m.group(1)).stem}: {m.group(2)}", status="pass" if m.group(3) in ("PASSED", "XPASS") else
                           "info" if m.group(3) in ("SKIPPED", "XFAIL") else "fail", detail=""))
    return checks, {}


def parse_tagged(text: str):
    checks = []
    for m in re.finditer(r"^\[(PASS|FAIL|accepted|ERROR|WARNING)\]\s*(.*)$", text, re.M):
        tag, rest = m.groups()
        name, _, detail = rest.partition(" - ")
        if tag in ("accepted",):
            name, _, detail = rest.partition(" -- ")
        checks.append(dict(name=name.strip(), status={"PASS": "pass", "FAIL": "fail", "ERROR": "fail", "accepted": "info",
                                                      "WARNING": "warn"}[tag], detail=detail.strip()))
    return checks, {}


def parse_wokwi(text: str):
    checks = []
    for m in re.finditer(r"\] (Expected text matched: .*|expect-pin .*|delay \d+ms|take-screenshot.*|Scenario completed successfully)$",
                         text, re.M):
        step = m.group(1)
        if step.startswith("delay"):
            continue
        checks.append(dict(name=step if not step.startswith("Expected") else "serial: " + step[len("Expected text matched: "):],
                           status="pass", detail=""))
    for m in re.finditer(r"^Error: (.*)$", text, re.M):
        checks.append(dict(name="Scenario error", status="fail", detail=m.group(1)[:300]))
    tx = re.findall(r"\[sx1278\] TX #(\d+) (\d+) bytes", text)
    for n, size in tx:
        checks.append(dict(name=f"LoRa TX #{n}: {size} bytes on air", status="info", detail=""))
    return checks, {}


def parse_build(text: str):
    checks = []
    for label, pat in (("RAM", r"RAM:.*?\(used (\d+) bytes from (\d+) bytes\)"), ("Flash", r"Flash:.*?\(used (\d+) bytes from (\d+) bytes\)")):
        m = re.search(pat, text)
        if m:
            checks.append(dict(name=f"{label} use", status="info", detail=f"{int(m.group(1)) // 1024} KiB of {int(m.group(2)) // 1024} KiB"))
    ok = "[SUCCESS]" in text
    checks.append(dict(name="Firmware compiles", status="pass" if ok else "fail", detail=""))
    return checks, {}


def parse_spice(text: str):
    corners = []
    cur = None
    for line in text.splitlines():
        m = re.match(r"^(4\.2|3\.6|3\.0) = ", line)
        if m:
            cur = {"vbat": float(m.group(1))}
            corners.append(cur)
            continue
        m = re.match(r"^(vout_min|vout_end|vina_min|vbat_min) = ([-+0-9.eE]+)\s*$", line)
        if m and cur is not None and m.group(1) not in cur:
            cur[m.group(1)] = float(m.group(2))
    checks = []
    for c in corners:
        if "vout_min" not in c:
            continue
        droop_mv = (3.3 - c["vout_min"]) * 1000
        checks.append(dict(name=f"+3.3 V rail at Vbat {c['vbat']:.1f} V stays above the 3.0 V ESP32-C3 minimum",
                           status="pass" if c["vout_min"] >= 3.0 else "fail",
                           detail=f"min {c['vout_min']:.3f} V (droop {droop_mv:.0f} mV), recovers to {c.get('vout_end', 0):.3f} V; "
                                  f"VINA min {c.get('vina_min', 0):.3f} V"))
    if not checks:
        checks.append(dict(name="ngspice produced results", status="fail", detail="no corner results in the output"))
    return checks, {"corners": corners}


PARSERS = dict(pytest=parse_pytest, tagged=parse_tagged, wokwi=parse_wokwi, spice=parse_spice, build=parse_build)


# ------------------------------------------------------------------ runner
class Run:
    def __init__(self, ids):
        self.id = time.strftime("%Y%m%d-%H%M%S")
        self.ids = ids
        self.state = "running"
        self.lines: list[str] = []
        self.started = time.time()
        self.results: dict[str, dict] = {i: dict(id=i, title=suites()[i]["title"], status="queued", checks=[], duration=0.0) for i in ids}
        self.report_url = None

    def log(self, line: str) -> None:
        self.lines.append(line)


RUN_LOCK = threading.Lock()
RUNS: dict[str, Run] = {}


def execute(run: Run, token: str | None) -> None:
    env = dict(os.environ, PYTHONIOENCODING="utf-8", PYTHONUNBUFFERED="1")
    if token:
        env["WOKWI_CLI_TOKEN"] = token
    env["PATH"] = str(Path.home() / ".wokwi" / "bin") + os.pathsep + env.get("PATH", "")
    spec = suites()
    avail = tools()
    try:
        for sid in run.ids:
            res, s = run.results[sid], spec[sid]
            missing = [n for n in s["needs"] if (n == "token" and not env.get("WOKWI_CLI_TOKEN")) or (n != "token" and not avail.get(n))]
            if missing:
                res.update(status="skipped", checks=[dict(name="Skipped", status="warn", detail="missing: " + ", ".join(missing))])
                run.log(f"== {s['title']}: skipped (missing {', '.join(missing)})")
                continue
            res["status"] = "running"
            run.log(f"== {s['title']}")
            t0 = time.time()
            out: list[str] = []
            try:
                proc = subprocess.Popen(s["cmd"], cwd=ROOT, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                        text=True, encoding="utf-8", errors="replace")
                timer = threading.Timer(s["timeout"], proc.kill)
                timer.start()
                for line in proc.stdout:
                    line = line.rstrip("\r\n")
                    out.append(line)
                    run.log(line)
                proc.wait()
                timer.cancel()
                code = proc.returncode
            except OSError as exc:
                out.append(str(exc))
                run.log(str(exc))
                code = -1
            text = "\n".join(out)
            checks, extra = PARSERS[s["parser"]](text)
            failed = any(c["status"] == "fail" for c in checks)
            ok = code == 0 and not failed
            if code != 0 and not failed:
                checks.append(dict(name=f"Process exit code {code}", status="fail", detail=text[-300:]))
            res.update(status="pass" if ok else "fail", checks=checks, duration=round(time.time() - t0, 1), extra=extra,
                       log=text[-60000:], returncode=code)
            run.log(f"-- {s['title']}: {'PASS' if ok else 'FAIL'} ({res['duration']} s)")
    finally:
        run.state = "done"
        write_report(run)
        run.log("== report saved")


def start_run(ids, token):
    if not RUN_LOCK.acquire(blocking=False):
        return None
    run = Run(ids)
    RUNS[run.id] = run

    def go():
        try:
            execute(run, token)
        finally:
            RUN_LOCK.release()

    threading.Thread(target=go, daemon=True).start()
    return run


# ------------------------------------------------------------------ reports
def b64_file(p: Path) -> str:
    return base64.b64encode(p.read_bytes()).decode() if p.exists() else ""


def write_report(run: Run) -> None:
    d = REPORTS / run.id
    d.mkdir(parents=True, exist_ok=True)
    results = list(run.results.values())
    n_pass = sum(1 for r in results if r["status"] == "pass")
    n_fail = sum(1 for r in results if r["status"] == "fail")
    summary = dict(id=run.id, started=time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(run.started)),
                   duration=round(time.time() - run.started, 1), passed=n_pass, failed=n_fail,
                   skipped=sum(1 for r in results if r["status"] == "skipped"), suites=results)
    (d / "result.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    rows = []
    for r in results:
        checks = "".join(
            f"<tr class='{c['status']}'><td>{html.escape(c['status'].upper())}</td><td>{html.escape(c['name'])}</td>"
            f"<td>{html.escape(c['detail'])}</td></tr>" for c in r["checks"])
        extra = ""
        if r.get("extra", {}).get("corners"):
            extra = "<table><tr><th>Vbat</th><th>+3.3V min</th><th>+3.3V after</th><th>VINA min</th><th>BAT+ min</th></tr>" + "".join(
                f"<tr><td>{c['vbat']} V</td><td>{c.get('vout_min', 0):.3f}</td><td>{c.get('vout_end', 0):.3f}</td>"
                f"<td>{c.get('vina_min', 0):.3f}</td><td>{c.get('vbat_min', 0):.3f}</td></tr>" for c in r["extra"]["corners"]) + "</table>"
        rows.append(
            f"<section><h2>{html.escape(r['title'])} <span class='b {r['status']}'>{r['status'].upper()}</span>"
            f"<small>{r['duration']} s</small></h2>{extra}<table>{checks}</table>"
            f"<details><summary>Full log</summary><pre>{html.escape(r.get('log', ''))}</pre></details></section>")
    imgs = "".join(
        f"<figure><img src='data:image/png;base64,{b64_file(ROOT / 'hardware' / f)}'><figcaption>{cap}</figcaption></figure>"
        for f, cap in (("oled_alert.png", "OLED during a hazard alert"), ("oled_voice.png", "OLED during a voice transmission"))
        if (ROOT / "hardware" / f).exists())
    page = f"""<!doctype html><meta charset=utf-8><title>RakshaWave test report {run.id}</title>
<style>body{{font:14px system-ui;max-width:980px;margin:2rem auto;padding:0 1rem;color:#1b2430}}
table{{border-collapse:collapse;width:100%;margin:.5rem 0}}td,th{{border-bottom:1px solid #dde3ea;padding:4px 8px;text-align:left;vertical-align:top}}
.pass td:first-child,.b.pass{{color:#0a7a3d}}.fail td:first-child,.b.fail{{color:#c0262d}}.warn td:first-child,.b.skipped{{color:#a86a00}}.info td:first-child{{color:#5a6b7d}}
.b{{font-size:12px;margin-left:8px}}small{{color:#6b7a8c;font-weight:400;margin-left:8px}}pre{{background:#f3f5f8;padding:8px;overflow:auto;max-height:340px;font-size:12px}}
figure{{display:inline-block;margin:0 12px 12px 0}}img{{width:384px;image-rendering:pixelated;border:1px solid #ccd}}</style>
<h1>RakshaWave test report</h1><p>Run {run.id}, started {summary['started']}, took {summary['duration']} s.<br>
<b>{n_pass} suites passed, {n_fail} failed, {summary['skipped']} skipped.</b></p>{''.join(rows)}<h2>Simulated OLED</h2>{imgs}"""
    (d / "report.html").write_text(page, encoding="utf-8")
    run.report_url = f"/reports/{run.id}/report.html"


def list_reports():
    out = []
    for d in sorted(REPORTS.glob("*/result.json"), reverse=True)[:50]:
        try:
            j = json.loads(d.read_text(encoding="utf-8"))
            out.append({k: j[k] for k in ("id", "started", "duration", "passed", "failed", "skipped")} | {
                "url": f"/reports/{j['id']}/report.html", "json": f"/reports/{j['id']}/result.json"})
        except (OSError, ValueError, KeyError):
            continue
    return out


# ------------------------------------------------------------------ PTT lab
def _pcm_from_b64(b: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(b), dtype="<i2").astype(np.int16)


def _pcm_to_b64(p: np.ndarray) -> str:
    return base64.b64encode(np.asarray(p, dtype="<i2").tobytes()).decode()


def ptt_loopback(pcm: np.ndarray, loss: float, seed: int) -> dict:
    from software.mcp_bridge import lora_airtime_s
    from software.voice import PttReceiver, PttTransmitter
    from software.wimesh.protocol import VoicePacket

    packets: list = []
    tx = PttTransmitter("VEH-A", packets.append, max_talk_s=10**6)
    tx.start()
    tx.push_audio(pcm)
    tx.stop()
    rng = random.Random(seed)
    clock = [0.0]
    chunks: list = []
    rx = PttReceiver(lambda _v, p: chunks.append(p), clock=lambda: clock[0])
    rows = []
    for pkt in packets:
        raw = pkt.encode()
        dropped = rng.random() < loss and not pkt.last
        rows.append(dict(seq=pkt.seq, bytes=len(raw), speech_ms=len(pkt.payload) // 4 * 40,
                         airtime_s=round(lora_airtime_s(len(raw)), 3), delivered=not dropped, last=pkt.last))
        if not dropped:
            rx.handle(VoicePacket.decode(raw))
    for _ in range(20):
        clock[0] += 1.0
        rx.poll()
    out = np.concatenate(chunks) if chunks else np.zeros(0, dtype=np.int16)
    st = rx.stats()[0] if rx.stats() else {}
    air = sum(r["airtime_s"] for r in rows)
    talked = len(pcm) / 8000
    return dict(packets=rows, in_pcm=_pcm_to_b64(pcm), out_pcm=_pcm_to_b64(out), rate=8000,
                talked_s=round(talked, 2), airtime_s=round(air, 2), duty=round(air / talked, 2) if talked else 0,
                lost=st.get("lost_chunks", 0), complete=bool(st.get("complete")), played_s=st.get("played_s", 0))


def ptt_radio(distances: list[float], seconds: float) -> dict:
    from software import mcp_bridge as bridge

    bridge.reset_bench()
    lat, lon = 18.5204, 73.8567
    probs = {}
    for i, d in enumerate(distances, 1):
        vid = f"VEH-L{i}"
        bridge._bench.node(vid, lat + d / 111_320.0, lon)
        probs[vid] = dict(distance_m=d, loss=round(bridge._bench.mesh.loss_probability(d), 3))
    res = bridge.ptt_talk("VEH-A", lat, lon, seconds=seconds)
    for vid, info in res.get("listeners", {}).items():
        info.update(probs.get(vid, {}))
    return res


# ------------------------------------------------------------------ HTTP
MIME = {".html": "text/html; charset=utf-8", ".json": "application/json", ".png": "image/png", ".pdf": "application/pdf",
        ".log": "text/plain; charset=utf-8", ".txt": "text/plain; charset=utf-8", ".yaml": "text/plain; charset=utf-8",
        ".js": "text/javascript", ".css": "text/css", ".toml": "text/plain; charset=utf-8"}
FILES_OK = ("hardware/", "tests/wokwi/", "diagram.json", "wokwi.toml", "platformio.ini")


class Handler(BaseHTTPRequestHandler):
    server_version = "RakshaWaveGUI"

    def log_message(self, fmt, *args):  # quiet
        pass

    def _send(self, code, body: bytes, ctype="application/json"):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, obj, code=200):
        self._send(code, json.dumps(obj).encode())

    def _body(self):
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def _file(self, rel: str):
        p = (ROOT / rel).resolve()
        if ROOT not in p.parents and p != ROOT or not p.is_file() or not any(rel.replace("\\", "/").startswith(a) for a in FILES_OK):
            return self._send(404, b"not found", "text/plain")
        self._send(200, p.read_bytes(), MIME.get(p.suffix.lower(), "application/octet-stream"))

    def do_GET(self):
        u = urlparse(self.path)
        path, q = u.path, parse_qs(u.query)
        if path in ("/", "/index.html"):
            return self._send(200, (HERE / "index.html").read_bytes(), MIME[".html"])
        if path == "/api/status":
            s = suites()
            t = tools()
            return self._json(dict(
                tools={k: bool(v) for k, v in t.items()}, token=bool(os.environ.get("WOKWI_CLI_TOKEN")),
                suites=[dict(id=i, title=s[i]["title"], desc=s[i]["desc"], needs=s[i]["needs"]) for i in ORDER],
                busy=RUN_LOCK.locked(), root=str(ROOT)))
        if path.startswith("/api/run/"):
            run = RUNS.get(path.rsplit("/", 1)[1])
            if not run:
                return self._json({"error": "unknown run"}, 404)
            since = int(q.get("since", ["0"])[0])
            return self._json(dict(id=run.id, state=run.state, lines=run.lines[since:], next=len(run.lines),
                                   suites=[{k: v for k, v in r.items() if k not in ("log",)} for r in run.results.values()],
                                   report=run.report_url))
        if path == "/api/reports":
            return self._json(list_reports())
        if path == "/api/diagram":
            return self._send(200, (ROOT / "diagram.json").read_bytes())
        if path.startswith("/reports/"):
            return self._file("hardware" + path)
        if path.startswith("/files/"):
            return self._file(path[len("/files/"):])
        self._send(404, b"not found", "text/plain")

    def do_POST(self):
        path = urlparse(self.path).path
        try:
            body = self._body()
            if path == "/api/run":
                ids = [i for i in body.get("suites", []) if i in suites()] or ORDER
                run = start_run(ids, (body.get("token") or "").strip() or None)
                return self._json({"error": "a run is already in progress"}, 409) if run is None else self._json({"id": run.id})
            if path == "/api/ptt/loopback":
                pcm = _pcm_from_b64(body["pcm"]) if body.get("pcm") else _test_speech(float(body.get("seconds", 4)))
                return self._json(ptt_loopback(pcm, float(body.get("loss", 0)), int(body.get("seed", 1))))
            if path == "/api/ptt/radio":
                return self._json(ptt_radio([float(x) for x in body.get("distances", [300])], float(body.get("seconds", 3))))
            if path == "/api/schematic":
                import kicad_check  # type: ignore
                subprocess.run([kicad_check.find_cli(), "sch", "export", "pdf", "-o", str(ROOT / "hardware" / "schematic.pdf"),
                                str(kicad_check.SCH)], check=True, capture_output=True)
                return self._json({"ok": True})
            self._send(404, b"not found", "text/plain")
        except Exception as exc:  # noqa: BLE001 - report to the page
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)


def _test_speech(seconds: float) -> np.ndarray:
    t = np.arange(int(8000 * seconds)) / 8000
    f0 = 140 + 40 * np.sin(2 * np.pi * 0.7 * t)
    phase = 2 * np.pi * np.cumsum(f0) / 8000
    env = 0.55 + 0.45 * np.sin(2 * np.pi * 3.1 * t) ** 2
    sig = sum(np.sin(k * phase) / k for k in range(1, 9))
    return (3500 * sig * env).astype(np.int16)


def main() -> None:
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    url = f"http://127.0.0.1:{PORT}"
    print(f"RakshaWave test bench at {url}  (Ctrl+C to stop)")
    if "--no-browser" not in sys.argv:
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
