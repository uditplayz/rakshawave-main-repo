"""
Live digital twin backend: drives the REAL firmware inside the Wokwi simulator (through
`wokwi-cli mcp`) and exposes its state to the 3D page.

    browser 3D page  <->  app.py /api/twin/*  <->  Twin  <->  wokwi-cli mcp  <->  Wokwi (ESP32-C3 firmware,
                                                                MPU6050, SSD1306, SX1278 + GPS chips)

Everything the page shows comes from the simulation: LED and buzzer from the real pin levels, the OLED from
a real screenshot, packets from the real serial port. Push-to-talk audio is encoded by the real PTT code, sent
to the firmware as VoicePacket lines, and also played to a simulated second vehicle through the radio model.
"""

from __future__ import annotations

import asyncio
import base64
import json
import os
import re
import threading
import time
from pathlib import Path
from typing import Optional

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
WOKWI = Path.home() / ".wokwi" / "bin" / ("wokwi-cli.exe" if os.name == "nt" else "wokwi-cli")


class Twin:
    def __init__(self):
        self.loop = asyncio.new_event_loop()
        threading.Thread(target=self.loop.run_forever, daemon=True).start()
        self.lock = threading.Lock()
        self.session = None
        self._task: Optional[asyncio.Future] = None
        self._stop: Optional[asyncio.Event] = None
        self.reset_state()
        # push-to-talk
        self._ptt_tx = None
        self._ptt_thread: Optional[threading.Thread] = None
        self._ptt_live = threading.Event()
        self.remote_distance = 400.0
        self._remote_pos = 0

    # ---------------------------------------------------------------- state
    def reset_state(self):
        with self.lock:
            self.st = dict(running=False, starting=False, error=None, nanos=0, buzzer_on=False, led_on=False,
                           oled_seq=0, oled_png=None, serial=[], events=[], packets=[], mesh=None, accel_z=1.0,
                           ptt=False, remote_distance=400.0, started_at=None)
            self._serial_buf = ""
            self._event_id = 0
            self._last_fuse_id = None

    def snapshot(self, have_oled: int = -1) -> dict:
        with self.lock:
            s = {k: v for k, v in self.st.items() if k != "oled_png"}
            s["serial"] = s["serial"][-60:]
            s["events"] = s["events"][-30:]
            s["packets"] = s["packets"][-8:]
            s["oled_png"] = self.st["oled_png"] if self.st["oled_seq"] != have_oled else None
            return s

    def _event(self, kind: str, **kw):
        with self.lock:
            self._event_id += 1
            self.st["events"].append(dict(id=self._event_id, kind=kind, t=time.time(), **kw))

    # ---------------------------------------------------------------- lifecycle
    def start(self, token: Optional[str]) -> dict:
        if self._task and not self._task.done():
            return {"ok": True, "already": True}
        if not WOKWI.exists():
            return {"ok": False, "error": f"wokwi-cli not found at {WOKWI}"}
        token = token or os.environ.get("WOKWI_CLI_TOKEN")
        if not token:
            return {"ok": False, "error": "no Wokwi token (set WOKWI_CLI_TOKEN or type it into the page)"}
        if not (ROOT / ".pio/build/esp32-c3-devkitm-1/firmware.elf").exists():
            return {"ok": False, "error": "firmware not built: run `pio run` (Tests tab, Build firmware)"}
        self.reset_state()
        self.st["starting"] = True
        self._stop = asyncio.run_coroutine_threadsafe(self._make_event(), self.loop).result()
        self._task = asyncio.run_coroutine_threadsafe(self._session(token), self.loop)
        return {"ok": True}

    async def _make_event(self):
        return asyncio.Event()

    def stop(self) -> dict:
        self.ptt(False)
        if self._stop is not None:
            self.loop.call_soon_threadsafe(self._stop.set)
        return {"ok": True}

    async def _session(self, token: str):
        from mcp import ClientSession, StdioServerParameters
        from mcp.client.stdio import stdio_client

        env = dict(os.environ, WOKWI_CLI_TOKEN=token)
        params = StdioServerParameters(command=str(WOKWI), args=["mcp", "-q", str(ROOT)], env=env)
        try:
            async with stdio_client(params) as (r, w):
                async with ClientSession(r, w) as sess:
                    await sess.initialize()
                    self.session = sess
                    res = await sess.call_tool("wokwi_start_simulation", {})
                    text = _text(res)
                    if "started" not in text.lower():
                        raise RuntimeError(text[:300])
                    with self.lock:
                        self.st.update(running=True, starting=False, started_at=time.time())
                    await self._poll(sess)
                    try:
                        await sess.call_tool("wokwi_stop_simulation", {})
                    except Exception:  # noqa: BLE001
                        pass
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                self.st["error"] = f"{type(exc).__name__}: {exc}"[:300]
        finally:
            self.session = None
            with self.lock:
                self.st.update(running=False, starting=False)

    async def _poll(self, sess):
        cycle = 0
        while not self._stop.is_set():
            try:
                res = await sess.call_tool("wokwi_read_serial", {"clear": True})
                self._feed_serial(_text(res))
                if cycle % 3 == 0:
                    st = json.loads(_text(await sess.call_tool("wokwi_get_status", {})) or "{}")
                    with self.lock:
                        self.st["nanos"] = st.get("nanos", 0)
                for pin, key in (("9", "buzzer_on"), ("10", "led_on")):
                    r = _text(await sess.call_tool("wokwi_read_pin", {"partId": "esp", "pin": pin}))
                    with self.lock:
                        self.st[key] = "false" in r.split(":")[1] if ":" in r else False  # active low
                if cycle % 2 == 0 or self.st["buzzer_on"] or self.st["led_on"] or self.st["ptt"]:
                    await self._screenshot(sess)
            except Exception as exc:  # noqa: BLE001
                with self.lock:
                    self.st["error"] = f"{type(exc).__name__}: {exc}"[:300]
                await asyncio.sleep(1)
            cycle += 1
            await asyncio.sleep(0.05)

    async def _screenshot(self, sess):
        res = await sess.call_tool("wokwi_take_screenshot", {"partId": "oled"})
        m = re.search(r"base64\):\s*([A-Za-z0-9+/=]+)", _text(res))
        if m:
            with self.lock:
                if m.group(1) != self.st["oled_png"]:
                    self.st["oled_png"] = m.group(1)
                    self.st["oled_seq"] += 1

    # ---------------------------------------------------------------- serial parsing
    def _feed_serial(self, text: str):
        text = text.replace("No serial output", "")
        if not text:
            return
        self._serial_buf += text
        *lines, self._serial_buf = self._serial_buf.replace("\r", "").split("\n")
        for line in lines:
            line = line.strip()
            if not line:
                continue
            with self.lock:
                self.st["serial"].append(line)
                self.st["serial"] = self.st["serial"][-300:]
            if line.startswith("{") and '"t":"HAZARD_ALERT"' in line:
                try:
                    pkt = json.loads(line)
                except ValueError:
                    continue
                with self.lock:
                    self.st["packets"].append(pkt)
                self._event("hazard_tx", packet_id=pkt.get("id"))
                threading.Thread(target=self._fuse, args=(line,), daemon=True).start()

    def _fuse(self, line: str):
        """Feed the packet the firmware really sent to the Pi-side stack (vision + fusion + mesh)."""
        try:
            from software import mcp_bridge as bridge

            if bridge._bench.last_vision is None:
                bridge.run_vision_detector("pothole")
            res = bridge.fuse_and_ingest_esp32_serial(line, 0.88)
            self._publish_mesh(res)
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                self.st["mesh"] = {"error": f"{type(exc).__name__}: {exc}"}

    def _publish_mesh(self, res: dict | None = None):
        from software import mcp_bridge as bridge

        state = bridge.get_mesh_state()
        with self.lock:
            self.st["mesh"] = dict(
                fused=(res or {}).get("fusion", {}).get("fused_confidence"),
                verified=(res or {}).get("verified"),
                clusters=state["clusters"], emergencies=state["emergency_events"],
                transmissions=state["total_transmissions"], airtime_s=state["total_airtime_s"])

    # ---------------------------------------------------------------- commands
    def _call(self, name: str, args: dict, timeout: float = 10.0):
        if self.session is None:
            raise RuntimeError("simulation is not running")
        return asyncio.run_coroutine_threadsafe(self.session.call_tool(name, args), self.loop).result(timeout)

    def set_accel(self, g: float) -> dict:
        g = max(0.0, min(8.0, float(g)))
        self._call("wokwi_set_control", {"partId": "imu", "control": "accelZ", "value": g})
        with self.lock:
            self.st["accel_z"] = g
        return {"ok": True, "accel_z": g}

    def hit(self, g: float = 3.0, ms: int = 350) -> dict:
        """A pothole hit: a short spike on the MPU6050, then back to 1 g."""
        def run():
            try:
                self.set_accel(g)
                time.sleep(ms / 1000)
                self.set_accel(1.0)
            except Exception as exc:  # noqa: BLE001
                with self.lock:
                    self.st["error"] = str(exc)[:300]
        threading.Thread(target=run, daemon=True).start()
        return {"ok": True}

    def write_serial(self, text: str) -> dict:
        self._call("wokwi_write_serial", {"text": text})
        return {"ok": True}

    def peer(self) -> dict:
        from software import mcp_bridge as bridge

        pk = self.st["packets"][-1] if self.st["packets"] else None
        lat, lon = (pk["lat"], pk["lon"]) if pk else (18.5204, 73.8567)
        res = bridge.simulate_corroborating_peer("VEH-002", "pothole", lat, lon, 12)
        self._publish_mesh()
        self._event("peer")
        return {"ok": True, "clusters": res["clusters"], "emergencies": res["emergencies"]}

    def set_remote_distance(self, metres: float) -> dict:
        self.remote_distance = max(10.0, min(5000.0, float(metres)))
        with self.lock:
            self.st["remote_distance"] = self.remote_distance
        return {"ok": True}

    # ---------------------------------------------------------------- push to talk
    def _ptt_send(self, pkt):
        """One VoicePacket: real wire format to the firmware, and over the radio model to VEH-REMOTE."""
        from software import mcp_bridge as bridge

        self.write_serial(pkt.encode().decode() + "\n")
        self._event("voice_tx", seq=pkt.seq, last=pkt.last, bytes=len(pkt.encode()))
        try:
            lat, lon = 18.5204, 73.8567
            bench = bridge._bench
            bench.node("VEH-PI-01", lat, lon)
            bench.node("VEH-REMOTE", lat + self.remote_distance / 111_320.0, lon)
            bench.nodes["VEH-PI-01"].broadcast(pkt)
        except Exception as exc:  # noqa: BLE001
            with self.lock:
                self.st["error"] = f"radio model: {exc}"[:300]

    def ptt(self, press: bool, source: str = "synth") -> dict:
        from software.voice import PttTransmitter

        if press:
            if self._ptt_live.is_set():
                return {"ok": True}
            if self.session is None:
                return {"ok": False, "error": "start the simulation first"}
            from software import mcp_bridge as bridge

            bridge._bench.node("VEH-PI-01", 18.5204, 73.8567)
            bridge._bench.node("VEH-REMOTE", 18.5204 + self.remote_distance / 111_320.0, 73.8567)
            self._remote_pos = len(bridge._bench.heard["VEH-REMOTE"])
            self._ptt_tx = PttTransmitter("VEH-PI-01", self._ptt_send, max_talk_s=30)
            self._ptt_tx.start()
            self._ptt_live.set()
            with self.lock:
                self.st["ptt"] = True
            if source == "synth":
                self._ptt_thread = threading.Thread(target=self._synth_talk, daemon=True)
                self._ptt_thread.start()
            return {"ok": True}
        if self._ptt_live.is_set():
            self._ptt_live.clear()
            tx = self._ptt_tx
            if self._ptt_thread:
                self._ptt_thread.join(timeout=1.5)
            if tx and tx.active:
                tx.stop()
            with self.lock:
                self.st["ptt"] = False
        return {"ok": True}

    def ptt_audio(self, pcm: np.ndarray) -> dict:
        tx = self._ptt_tx
        if not self._ptt_live.is_set() or tx is None or not tx.active:
            return {"ok": False}
        if not tx.push_audio(pcm):  # talk limit reached
            self._ptt_live.clear()
            with self.lock:
                self.st["ptt"] = False
        return {"ok": True}

    def _synth_talk(self):
        speech = test_speech(20.0)
        pos = 0
        while self._ptt_live.is_set() and self._ptt_tx and self._ptt_tx.active:
            block = speech[pos:pos + 1600]
            pos = (pos + 1600) % (len(speech) - 1600)
            if not self._ptt_tx.push_audio(block):
                self._ptt_live.clear()
                with self.lock:
                    self.st["ptt"] = False
                break
            time.sleep(0.2)

    def remote_audio(self, since: int) -> dict:
        """PCM that the simulated second vehicle has played so far (after loss and concealment)."""
        from software import mcp_bridge as bridge

        bridge._bench.ptt.get("VEH-REMOTE") and bridge._bench.ptt["VEH-REMOTE"].rx.poll()
        chunks = bridge._bench.heard.get("VEH-REMOTE", [])
        start = max(since, self._remote_pos)
        new = chunks[start:]
        return dict(next=len(chunks), rate=8000,
                    chunks=[base64.b64encode(np.asarray(c, dtype="<i2").tobytes()).decode() for c in new])


def test_speech(seconds: float) -> np.ndarray:
    """Speech-like test signal: a wandering 140 Hz voice with harmonics and a syllable-rate envelope."""
    t = np.arange(int(8000 * seconds)) / 8000
    f0 = 140 + 40 * np.sin(2 * np.pi * 0.7 * t)
    phase = 2 * np.pi * np.cumsum(f0) / 8000
    env = 0.55 + 0.45 * np.sin(2 * np.pi * 3.1 * t) ** 2
    sig = sum(np.sin(k * phase) / k for k in range(1, 9))
    return (3500 * sig * env).astype(np.int16)


def _text(res) -> str:
    return " ".join(getattr(c, "text", "") for c in res.content if getattr(c, "type", "") == "text")


TWIN = Twin()
