// RakshaWave Hardware Lab: wires the emulated boards (sim/) to the 3D view,
// the field map and the inspector panels.
import { World } from './sim/world.js';
import { MODE_NAME, IRQ } from './sim/sx1278.js';
import { ENVIRONMENTS, timeOnAir, SNR_LIMIT_DB } from './sim/channel.js';
import { buildBoard, updateBoard, emitWave, flashRx, makeEnvironment } from './ui/board3d.js';
import { FieldMap, phyOf, fmtDist } from './ui/map.js';
import { enuToLatLon } from './sim/gps.js';
import { RAIL_V } from './sim/power.js';

const T = window.THREE;
const $ = s => document.querySelector(s);
const PALETTE = ['#3cb4d6', '#f59e0b', '#a78bfa', '#34d399', '#f472b6', '#f87171'];
const IMPACT_THRESHOLD_G = 1.8;   // firmware constant (main.ino)

const state = { world: null, module: null, boards: new Map(), selected: null, running: true, speed: 1, sound: false, lifted: false, pendingTx: [], pendingRx: [], beacon: null };

// ----------------------------------------------------------------- boot
async function loadFirmware() {
  const url = 'firmware.wasm';
  try { return await WebAssembly.compileStreaming(fetch(url)); }
  catch { return WebAssembly.compile(await (await fetch(url)).arrayBuffer()); }
}

const SCENARIOS = {
  pair: { nodes: [{ x: 1000, lane: 0 }, { x: 1600, lane: 1 }], features: [{ kind: 'pothole', x: 1060, y: 0.74, width: 0.7, length: 1.0, depth: 0.12 }, { kind: 'bump', x: 1250, length: 3.7, height: 0.1 }] },
  chain: { nodes: [{ x: 300, lane: 0 }, { x: 2500, lane: 1 }, { x: 4700, lane: 0 }], features: [] },
  convoy: { nodes: [{ x: 400, lane: 0, speed: 60 }, { x: 440, lane: 0, speed: 60 }, { x: 480, lane: 1, speed: 60 }, { x: 520, lane: 0, speed: 60 }], features: [] },
  bench: { nodes: [{ x: 1000, lane: 0, antenna: 'bench' }, { x: 1000.25, lane: 0, antenna: 'bench' }], features: [] },
};

async function loadScenario(name) {
  for (const ui of state.boards.values()) scene.remove(ui.root);
  state.boards.clear();
  if (state.beacon) { clearInterval(state.beacon.timer); state.beacon = null; }
  const world = new World({ seed: 433, roughness: $('#rough').value });
  world.channel.setEnvironment($('#env').value);
  state.world = world;
  state.pendingTx = []; state.pendingRx = [];
  const sc = SCENARIOS[name];
  for (const f of sc.features) world.road.addFeature(f);
  for (const n of sc.nodes) await addNode(n);
  world.listeners.push(onChannel);
  map.world = world;
  map.frames = []; map.marks = [];
  map.fitted = false;
  select(world.devices[0]);
  frameCamera('all');
  $('#meshlog').innerHTML = '';
}

async function addNode(opts = {}) {
  const w = state.world;
  if (w.devices.length >= 6) return toast('Six boards is the limit of this lab page.', 'warn');
  const x = opts.x ?? (w.devices.length ? Math.max(...w.devices.map(d => d.vehicle.x)) + 400 : 1000);
  const dev = await w.addDevice(state.module, Object.assign({}, opts, { x: Math.min(x, w.road.length - 50), speed: (opts.speed || 0) / 3.6 }));
  dev.vehicle.setSpeed(opts.speed || 0);
  dev.color = PALETTE[(w.devices.length - 1) % PALETTE.length];
  dev.listeners.push(onDeviceEvent);
  const ui = buildBoard(dev, dev.color);
  scene.add(ui.root);
  state.boards.set(dev.id, ui);
  layoutBoards();
  renderChips();
  return dev;
}

function layoutBoards() {
  const devs = state.world.devices;
  devs.forEach((d, i) => state.boards.get(d.id).root.position.set((i - (devs.length - 1) / 2) * 135, 0, 0));
}

// ----------------------------------------------------------------- 3D scene
const cv = $('#cv3d');
const renderer = new T.WebGLRenderer({ canvas: cv, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputEncoding = T.sRGBEncoding;
renderer.toneMapping = T.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = T.PCFSoftShadowMap;
const scene = new T.Scene();
scene.background = new T.Color(0x0b1016);
scene.environment = makeEnvironment(renderer);
const camera = new T.PerspectiveCamera(36, 1, 1, 5000);
const controls = new T.OrbitControls(camera, cv);
controls.enableDamping = true; controls.dampingFactor = 0.08;
controls.maxPolarAngle = Math.PI * 0.49;
controls.minDistance = 40; controls.maxDistance = 1400;
scene.add(new T.HemisphereLight(0xdfeaff, 0x1a2028, 0.55));
const key = new T.DirectionalLight(0xffffff, 1.15);
key.position.set(120, 260, 160); key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
Object.assign(key.shadow.camera, { left: -450, right: 450, top: 260, bottom: -260, near: 10, far: 900 });
key.shadow.bias = -0.0004;
scene.add(key);
const rim = new T.DirectionalLight(0x8fc6ff, 0.45); rim.position.set(-220, 120, -200); scene.add(rim);
// anti-static mat on a bench
const bench = new T.Mesh(new T.BoxGeometry(2400, 20, 900), new T.MeshStandardMaterial({ color: 0x0d1217, roughness: 0.92, envMapIntensity: 0.05 }));
bench.position.set(0, -10, 0); bench.receiveShadow = true; scene.add(bench);
const matMesh = new T.Mesh(new T.BoxGeometry(980, 1, 340), new T.MeshStandardMaterial({ color: 0x15222a, roughness: 0.97, envMapIntensity: 0.05 }));
matMesh.position.set(0, 0.5, 10); matMesh.receiveShadow = true; scene.add(matMesh);
const grid = new T.GridHelper(980, 49, 0x1f3542, 0x1b2d38); grid.position.set(0, 1.05, 10); grid.scale.z = 340 / 980; scene.add(grid);

function resize() {
  const r = $('#stage').getBoundingClientRect();
  renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(1, r.height);
  camera.updateProjectionMatrix();
  map.resize();
}

function frameCamera(kind) {
  const sel = state.selected && state.boards.get(state.selected.id);
  if (kind === 'focus' && sel) {
    const p = sel.root.position;
    controls.target.set(p.x, 14, p.z + 6);
    camera.position.set(p.x + 45, 95, p.z + 105);
  } else if (kind === 'top') {
    const p = sel ? sel.root.position : new T.Vector3();
    controls.target.set(p.x, 0, p.z);
    camera.position.set(p.x, 230, p.z + 1);
  } else {
    const n = state.world.devices.length;
    controls.target.set(0, 22, 12);
    camera.position.set(20, 95 + n * 28, 120 + n * 62);
  }
}

// picking: buttons and parts
const ray = new T.Raycaster();
const ndc = new T.Vector2();
let pressed = null;
function pick(e) {
  const r = cv.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const all = [];
  for (const ui of state.boards.values()) all.push(...ui.pickables);
  const hit = ray.intersectObjects(all, false)[0];
  if (!hit) return null;
  let o = hit.object, ui = null;
  for (let p = o; p; p = p.parent) if (p.userData.dev) { ui = state.boards.get(p.userData.dev.id); break; }
  if (!ui) return null;
  for (const [name, b] of Object.entries(ui.buttons)) if (o === b.hit || o === b.cap) return { ui, button: name };
  let part = null;
  for (let p = o; p && !part; p = p.parent) part = p.userData.part;
  return { ui, part };
}
cv.addEventListener('pointerdown', e => {
  const h = pick(e);
  if (!h) return;
  if (state.selected !== h.ui.dev) select(h.ui.dev);
  if (h.button) { controls.enabled = false; pressed = { dev: h.ui.dev, name: h.button }; pressButton(h.ui.dev, h.button, true); }
  else if (h.part) showPart(h.ui.dev, h.part, e);
});
window.addEventListener('pointerup', () => {
  if (pressed) { pressButton(pressed.dev, pressed.name, false); pressed = null; }
  controls.enabled = true;
});
cv.addEventListener('pointermove', e => {
  const h = pick(e);
  cv.style.cursor = h && (h.button || h.part) ? 'pointer' : 'default';
});

function pressButton(dev, name, down) {
  if (name === 'boot') { dev.buttons.boot = down; return; }
  if (name === 'reset') {
    dev.buttons.reset = down;
    if (down) { dev.state = 'halted'; dev.log('--- EN held low (RST button) ---'); }
    else dev.resetChip();
    return;
  }
  if (name === 'ptt') {
    dev.pttDown = down;
    if (down) toast(`${dev.name}: PTT pressed. SW1 is wired to the Raspberry Pi's GPIO17; the Pi (and its audio) is not emulated, so the ESP32 does not see this button.`, 'warn');
  }
}

const PART_INFO = {
  hat: ['RakshaWave V2V HAT rev 1.2', 'Raspberry Pi HAT outline (65 × 56.5 mm, four M2.5 holes, 40-pin header). The KiCad PCB is not routed yet; part positions here are a plausible arrangement.'],
  esp32: ['U4 · ESP32-C3-DevKitM-1', 'Runs firmware/esp32/main.ino compiled to WebAssembly, with virtual time.'],
  lora: ['U1 · Ai-Thinker Ra-01 (SX1278)', '433 MHz LoRa modem on SPI (SCK IO18, MISO IO19, MOSI IO7, NSS IO4, RST IO0, DIO0 IO8).'],
  imu: ['U3 · MPU-6050', 'Accelerometer + gyro on I²C 0x68 (SDA IO5, SCL IO6). ±4 g, ±500 °/s, 21 Hz low-pass as set by the firmware.'],
  oled: ['U5 · 0.91" OLED (SSD1306, 128 × 32)', 'I²C 0x3C. The picture is rebuilt from the I²C traffic.'],
  gps: ['U2 · GPS (RXM-GPS-FM class)', 'NMEA at 9600 baud into IO2 (UART1).'],
  buzzer: ['BZ1 · active buzzer', 'Between 3V3 and IO9 (active low). IO9 is also the BOOT strap pin, so pressing BOOT sounds it.'],
  led: ['D1 · red LED + R5 330 Ω', 'Between 3V3 and IO10 (active low), about 4 mA.'],
  battery: ['J1 · LiFePO4 18650 cell', 'Charged by U6 MCP73123 (a LiFePO4 charger, 3.6 V), regulated by U7 TPS63001 buck-boost to 3.3 V.'],
  antenna: ['LoRa antenna (SMA)', 'Quarter-wave whip, 2.15 dBi. Board inside the cabin: about 5 dB car-body loss.'],
};
function partLive(dev, part) {
  const sx = dev.sx, g = dev.gps.last, m = dev.mpu.latest;
  switch (part) {
    case 'esp32': return `State ${dev.state.toUpperCase()} · ID ${dev.firmwareId}<br>Uptime ${dev.bootT !== undefined ? (dev.t - dev.bootT).toFixed(1) : '0'} s · loop() ${(dev.lastLoopDur * 1000).toFixed(1)} ms`;
    case 'lora': return `${MODE_NAME[sx.mode]} · ${(sx.freq / 1e6).toFixed(3)} MHz · SF${sx.sf} · ${(sx.bw / 1e3)} kHz · ${sx.txDbm.toFixed(0)} dBm<br>TX ${sx.stats.tx} · RX ok ${sx.stats.rxOk} · CRC err ${sx.stats.rxCrc}`;
    case 'imu': return `a = (${m.accel.map(v => v.toFixed(2)).join(', ')}) g<br>ω = (${m.gyro.map(v => v.toFixed(1)).join(', ')}) °/s · ${m.temp.toFixed(1)} °C`;
    case 'oled': return `${dev.oled.lit ? 'on' : 'off'} · contrast 0x${dev.oled.contrast.toString(16)} · ${(dev.oledFraction * 100).toFixed(1)} % pixels lit`;
    case 'gps': return g ? `${g.fix ? 'FIX' : 'no fix'} · ${g.sats} sats · HDOP ${g.hdop.toFixed(2)}<br>${g.lat.toFixed(6)}, ${g.lon.toFixed(6)} · error ${g.errM.toFixed(1)} m` : 'warming up';
    case 'buzzer': return dev.buzzerOn() ? 'SOUNDING' : 'silent';
    case 'led': return dev.ledOn() ? 'ON' : 'off';
    case 'battery': return `${dev.power.battery.voltage().toFixed(3)} V · ${(dev.power.battery.soc * 100).toFixed(1)} % · ${dev.power.battery.ibat.toFixed(1)} mA`;
    default: return '';
  }
}
function showPart(dev, part, e) {
  const info = PART_INFO[part];
  if (!info) return;
  const tip = $('#tip');
  const r = $('#stage').getBoundingClientRect();
  tip.style.left = Math.min(r.width - 290, e.clientX - r.left + 14) + 'px';
  tip.style.top = Math.min(r.height - 140, e.clientY - r.top + 10) + 'px';
  tip.style.display = 'block';
  tip.dataset.part = part;
  tip.dataset.dev = dev.id;
  tip.innerHTML = `<b>${info[0]}</b> <span class="mute">· ${dev.name}</span><div class="note">${info[1]}</div><div class="note" id="tiplive">${partLive(dev, part)}</div>`;
  clearTimeout(showPart.timer);
  showPart.timer = setTimeout(() => (tip.style.display = 'none'), 7000);
}

// ----------------------------------------------------------------- map
const map = new FieldMap($('#map'), null, { onSelect: d => select(d), colorOf: d => d.color || '#888' });

// ----------------------------------------------------------------- events
function packetInfo(tx) {
  try {
    const j = JSON.parse(new TextDecoder().decode(tx.payload));
    return j;
  } catch { return null; }
}

function onChannel(ev) {
  map.onChannel(ev);
  if (ev.type === 'tx') state.pendingTx.push(ev.tx);
  if (ev.type === 'rx') {
    state.pendingRx.push(ev);
    addLogRow(ev);
  }
}

function onDeviceEvent(ev) {
  if (ev.type === 'console' && ev.dev === state.selected) consoleDirty = true;
}

function addLogRow(ev) {
  const rxDev = state.world.device(ev.rx);
  const j = packetInfo(ev.tx);
  const tr = document.createElement('tr');
  const res = ev.ok ? '<span class="ok">received</span>' : `<span class="bad">${ev.reason}</span>`;
  tr.innerHTML = `<td class="n">${ev.t.toFixed(3)}</td><td>${ev.tx.srcName} → ${rxDev ? rxDev.name : ev.rx}</td><td class="n">${j?.hop ?? '–'}</td><td class="n">${ev.rssi !== undefined ? ev.rssi.toFixed(1) : ''}</td><td class="n">${ev.snr !== undefined ? ev.snr.toFixed(1) : ''}</td><td title="${ev.reason}">${res}</td>`;
  const tb = $('#meshlog');
  tb.prepend(tr);
  while (tb.children.length > 200) tb.lastChild.remove();
}

let toastCount = 0;
function toast(html, kind = '') {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.innerHTML = html;
  $('#toasts').append(el);
  toastCount++;
  setTimeout(() => el.remove(), 6000);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
}

function vehicleEvents() {
  for (const d of state.world.devices) {
    for (const ev of d.vehicle.events.splice(0)) {
      if (ev.type !== 'stopped') continue;
      const crashed = state.world.devices.filter(o => o !== d && o.vehicle.crashedAt !== undefined && o.vehicle.lane === d.vehicle.lane && o.vehicle.x > d.vehicle.x);
      const gap = crashed.length ? Math.min(...crashed.map(o => o.vehicle.x - d.vehicle.x)) - 4.4 : null;
      toast(`<b>${d.name}</b>'s driver heard the buzzer at ${(ev.v0 * 3.6).toFixed(0)} km/h and stopped ${ev.distance.toFixed(0)} m later` +
        (gap !== null ? ` · <b>${gap > 0 ? gap.toFixed(0) + ' m short of' : 'into'}</b> the crashed car ahead` : ''), gap !== null && gap <= 0 ? 'bad' : 'ok');
    }
  }
}

function processVisualEvents(now) {
  vehicleEvents();
  for (const tx of state.pendingTx) {
    if (now < tx.t0) continue;
    const ui = state.boards.get(tx.src);
    if (!tx.lastWave || now - tx.lastWave > 0.22) { if (now <= tx.t1 && ui) emitWave(ui, 0x48c6ff); tx.lastWave = now; }
    if (!tx.announced) {
      tx.announced = true;
      const j = packetInfo(tx);
      if (j) toast(`<b>${tx.srcName}</b> transmits ${j.t || 'frame'}${j.hz ? ' · ' + j.hz : ''} · hop ${j.hop ?? 0} · ${tx.payload.length} B · <b>${(tx.toa * 1000).toFixed(0)} ms</b> on air at SF${tx.sf}`);
    }
  }
  state.pendingTx = state.pendingTx.filter(tx => now <= tx.t1);
  for (const ev of state.pendingRx) {
    if (now < ev.t) continue;
    const ui = state.boards.get(ev.rx);
    if (ui) flashRx(ui, ev.ok);
    const rx = state.world.device(ev.rx);
    const j = packetInfo(ev.tx);
    if (ev.ok) toast(`<b>${rx?.name}</b> received ${j?.t || 'frame'} from ${ev.tx.srcName}${j ? ` (${j.veh}, hop ${j.hop})` : ''} · ${ev.regRssi} dBm · SNR ${ev.snr.toFixed(1)} dB · ${fmtDist(Math.abs((rx?.vehicle.x ?? 0) - ev.tx.pos.x))}`, 'ok');
    else toast(`<b>${rx?.name}</b> lost a frame from ${ev.tx.srcName}: ${ev.reason}`, 'bad');
    ev.done = true;
  }
  state.pendingRx = state.pendingRx.filter(ev => !ev.done);
}

// ----------------------------------------------------------------- sidebar
function renderChips() {
  const box = $('#nodes');
  box.innerHTML = '';
  for (const d of state.world.devices) {
    const c = document.createElement('div');
    c.className = 'chip' + (d === state.selected ? ' sel' : '');
    c.innerHTML = `<i style="background:${d.color}"></i>${d.name} <span class="mute">${d.firmwareId}</span>`;
    c.onclick = () => select(d);
    box.append(c);
  }
}

function select(dev) {
  state.selected = dev;
  map.selected = dev;
  renderChips();
  buildNodePane();
  consoleDirty = true;
}

let consoleDirty = true;
const imuTraces = new Map();   // device id -> [{t, d}] of the last 10 s
const traceOf = d => imuTraces.get(d.id) || [];

function buildNodePane() {
  const d = state.selected;
  if (!d) return;
  const p = $('#p-node');
  p.innerHTML = `
  <div class="box"><h3>${d.name} · board</h3>
    <div class="kv" id="nstat"></div>
    <div class="row" style="margin-top:8px">
      <button class="g hold" id="bRst" title="EN pin: holds the ESP32 in reset while pressed">RST</button>
      <button class="g hold" id="bBoot" title="IO9 strap: hold while pressing RST for download mode">BOOT</button>
      <button class="g hold" id="bPtt" title="SW1, wired to the Pi's GPIO17">PTT</button>
      <button id="bPwr" class="${d.on ? 'on' : 'r'}">${d.on ? 'Power: ON' : 'Power: OFF'}</button>
      <button class="g" id="bDel" title="Remove this node">Remove</button>
    </div>
  </div>
  <div class="box"><h3>Vehicle</h3>
    <label class="l">Speed: <b id="spdv">${(d.vehicle.vTarget * 3.6).toFixed(0)}</b> km/h (now <span id="spdnow"></span>)</label>
    <input type="range" id="spd" min="0" max="120" step="5" value="${Math.round(d.vehicle.vTarget * 3.6)}">
    <div class="row"><label class="l"><input type="checkbox" id="react" ${d.driverReacts ? 'checked' : ''}> Driver brakes when the buzzer sounds (${d.vehicle.p.reaction} s reaction, ${d.vehicle.p.bEmergency} m/s²)</label></div>
    <div class="row"><label class="l">Lane</label><select id="lane">${[0, 1, 2].map(l => `<option value="${l}" ${d.vehicle.lane === l ? 'selected' : ''}>${['left', 'middle', 'right'][l]}</option>`).join('')}</select>
      <label class="l">Antenna</label><select id="ant"><option value="dash">on the dashboard (in cabin)</option><option value="roof">roof mount, outside</option><option value="bench">bench, no car</option></select></div>
  </div>
  <div class="box"><h3>Make something happen</h3>
    <div class="row"><button id="ePot">Pothole ahead</button><select id="potD"><option value="0.05">5 cm deep</option><option value="0.08">8 cm</option><option value="0.12" selected>12 cm</option><option value="0.15">15 cm</option></select><select id="potL"><option value="0.5">0.5 m long</option><option value="1.0" selected>1.0 m</option><option value="1.5">1.5 m</option></select></div>
    <div class="row"><button id="eBump">Speed bump ahead</button><button class="r" id="eCrash">Crash into barrier</button><button class="g" id="eKnock">Jolt the board (3 g)</button></div>
    <p class="note" id="ehint"></p>
  </div>
  <div class="box"><h3>Fault injection</h3>
    <div class="row"><label><input type="checkbox" id="fOled" ${d.oled.connected ? '' : 'checked'}> OLED unplugged</label><label><input type="checkbox" id="fImu" ${d.mpu.connected ? '' : 'checked'}> MPU-6050 unplugged</label></div>
    <div class="row"><label><input type="checkbox" id="fAnt" ${d.loraAntennaOff ? 'checked' : ''}> LoRa antenna off</label><label><input type="checkbox" id="fGps" ${d.gps.skyBlocked ? 'checked' : ''}> GPS antenna covered</label><label><input type="checkbox" id="fLora" ${d.sx.connected ? '' : 'checked'}> Ra-01 not responding</label></div>
    <p class="note">Faults act on the hardware; press RST to see how the firmware's start-up checks react.</p>
  </div>`;
  $('#ant').value = d.antenna;
  const hold = (id, name) => {
    const b = $(id);
    b.onpointerdown = () => pressButton(d, name, true);
    b.onpointerup = b.onpointerleave = () => { if (name === 'reset' ? d.buttons.reset : name === 'boot' ? d.buttons.boot : d.pttDown) pressButton(d, name, false); };
  };
  hold('#bRst', 'reset'); hold('#bBoot', 'boot'); hold('#bPtt', 'ptt');
  $('#bPwr').onclick = async () => {
    if (d.on) d.powerOff(); else await d.powerOn(state.module, state.world.t);
    buildNodePane();
  };
  $('#bDel').onclick = () => {
    if (state.world.devices.length <= 1) return;
    const ui = state.boards.get(d.id);
    scene.remove(ui.root);
    state.boards.delete(d.id);
    state.world.removeDevice(d);
    layoutBoards();
    select(state.world.devices[0]);
  };
  $('#spd').oninput = e => { d.vehicle.setSpeed(+e.target.value); $('#spdv').textContent = e.target.value; };
  $('#lane').onchange = e => d.vehicle.setLane(+e.target.value);
  $('#react').onchange = e => { d.driverReacts = e.target.checked; };
  $('#ant').onchange = e => { d.antenna = e.target.value; };
  $('#ePot').onclick = () => roadEvent(d, 'pothole');
  $('#eBump').onclick = () => roadEvent(d, 'bump');
  $('#eCrash').onclick = () => {
    const peak = d.vehicle.crash();
    if (peak === null) return toast(`${d.name} is not moving: set a speed first.`, 'warn');
    toast(`<b>${d.name}</b> hits a barrier at ${(d.vehicle.v * 3.6).toFixed(0)} km/h: ${peak.toFixed(1)} g peak deceleration (90 ms half-sine pulse). The MPU-6050 is set to ±4 g and will saturate.`, 'bad');
  };
  $('#eKnock').onclick = () => { d.mpu.tap(d.t, 3, 40); toast(`${d.name}: the board is jolted by hand (3 g, 40 ms). A sharper 6 ms knock would only reach about 0.8 g after the MPU-6050's 21 Hz filter.`); };
  $('#fOled').onchange = e => { d.oled.connected = !e.target.checked; };
  $('#fImu').onchange = e => { d.mpu.connected = !e.target.checked; };
  $('#fAnt').onchange = e => { d.loraAntennaOff = e.target.checked; };
  $('#fGps').onchange = e => { d.gps.skyBlocked = e.target.checked; };
  $('#fLora').onchange = e => { d.sx.connected = !e.target.checked; };
}

function roadEvent(d, kind) {
  const v = d.vehicle;
  if (v.vTarget < 1) { v.setSpeed(40); $('#spd').value = 40; $('#spdv').textContent = 40; }
  const ahead = Math.max(25, v.v * 2.5);
  const x = (v.x + ahead) % state.world.road.length;
  if (kind === 'pothole') {
    const depth = +$('#potD').value, length = +$('#potL').value;
    state.world.road.addFeature({ kind: 'pothole', x, y: v.y + v.p.track / 2, width: 0.7, length, depth });
    toast(`Pothole ${(depth * 100).toFixed(0)} cm deep, ${length} m long, ${ahead.toFixed(0)} m ahead of ${d.name}, in its left wheel track.`);
  } else {
    state.world.road.addFeature({ kind: 'bump', x, length: 3.7, height: 0.1 });
    toast(`Speed bump (10 cm × 3.7 m) ${ahead.toFixed(0)} m ahead of ${d.name}.`);
  }
}

function updateNodePane() {
  const d = state.selected;
  const s = $('#nstat');
  if (!d || !s) return;
  const up = d.bootT !== undefined && d.state === 'running' ? (d.t - d.bootT).toFixed(1) + ' s' : '–';
  const st = { running: '<span class="pill ok">RUNNING</span>', rom: '<span class="pill warn">BOOTING</span>', download: '<span class="pill warn">DOWNLOAD MODE</span>', halted: '<span class="pill bad">IN RESET</span>', off: '<span class="pill mute">OFF</span>' }[d.state] || d.state;
  const g = d.gps.last;
  s.innerHTML = `<span>State</span><span>${st}</span><span>Firmware ID (from MAC)</span><span>${d.firmwareId}</span>
    <span>MAC</span><span>${d.mac.map(b => b.toString(16).padStart(2, '0')).join(':')}</span>
    <span>Uptime · loop()</span><span>${up} · ${(d.lastLoopDur * 1000).toFixed(1)} ms</span>
    <span>LED D1 · buzzer</span><span>${d.ledOn() ? '<b class="bad">ON</b>' : 'off'} · ${d.buzzerOn() ? '<b class="bad">ON</b>' : 'off'}</span>
    <span>GPS</span><span>${g ? (g.fix ? `fix, ${g.sats} sats, HDOP ${g.hdop.toFixed(2)}` : 'searching') : '–'}</span>
    <span>Road position</span><span>${fmtDist(d.vehicle.x)} · lane ${d.vehicle.lane}</span>`;
  const sn = $('#spdnow');
  if (sn) sn.textContent = (d.vehicle.v * 3.6).toFixed(1) + ' km/h';
  const tr = traceOf(d);
  const pk = tr.length ? Math.max(...tr.map(p => p.d)) : 0;
  const eh = $('#ehint');
  if (eh) eh.innerHTML = `Peak |a| − 1 g in the last 10 s: <b>${pk.toFixed(2)} g</b>. The firmware sends an alert at ≥ ${IMPACT_THRESHOLD_G} g (or ≥ 150 °/s).`;
}

function renderConsole() {
  const d = state.selected;
  if (!d || !consoleDirty) return;
  consoleDirty = false;
  const pre = $('#console');
  const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 30;
  pre.innerHTML = d.console.slice(-250).map(c => {
    const cls = c.text.startsWith('{') ? 'js' : c.text.startsWith('RX ') || c.text.startsWith('RELAY') ? 'rx' : /^(ESP-ROM|Build|rst:|SPIWP|mode:|load:|entry|waiting)/.test(c.text) ? 'rom' : '';
    return `<span class="ts">${c.t.toFixed(3).padStart(9)} </span><span class="${cls}">${esc(c.text)}</span>`;
  }).join('\n');
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

function renderRadio() {
  const d = state.selected;
  if (!d) return;
  const sx = d.sx;
  const irq = sx.regs[0x12];
  const flags = Object.entries(IRQ).filter(([, m]) => irq & m).map(([k]) => k).join(' ') || '–';
  const lp = sx.lastPacket;
  const toa = timeOnAir(sx.phy(), 200).total;
  const rows = state.world.devices.filter(o => o !== d && o.on).map(o => {
    const lb = state.world.channel.linkBudget(d.antennaPos(d.t), o.antennaPos(o.t), d.id, o.id, phyOf(d));
    const cls = lb.margin > 6 ? 'ok' : lb.margin > 0 ? 'warn' : 'bad';
    return `<tr><td>${o.name}</td><td class="n">${fmtDist(lb.distance)}</td><td class="n">${lb.pathLoss.toFixed(1)}</td><td class="n">${lb.rssi.toFixed(1)}</td><td class="n">${lb.snr.toFixed(1)}</td><td class="n ${cls}">${lb.margin.toFixed(1)}</td></tr>`;
  }).join('');
  $('#p-radio').innerHTML = `
  <div class="box"><h3>SX1278 registers (live)</h3><div class="kv">
    <span>RegOpMode</span><span>0x${(sx.regs[1]).toString(16).padStart(2, '0')} · ${sx.lora ? 'LoRa' : 'FSK'} ${MODE_NAME[sx.mode]}</span>
    <span>Frequency (RegFrf)</span><span>${(sx.freq / 1e6).toFixed(4)} MHz</span>
    <span>SF · BW · CR</span><span>SF${sx.sf} · ${sx.bw / 1e3} kHz · 4/${sx.cr + 4}</span>
    <span>Preamble · sync · CRC</span><span>${sx.preamble} · 0x${sx.regs[0x39].toString(16)} · ${sx.crcOn ? 'on' : 'OFF'}</span>
    <span>PA</span><span>${sx.paBoost ? 'PA_BOOST' : 'RFO'} ${sx.txDbm.toFixed(0)} dBm · OCP 0x${sx.regs[0x0b].toString(16)}</span>
    <span>LNA · AGC</span><span>${sx.lnaBoost ? 'boost' : 'normal'} · ${(sx.regs[0x26] & 4) ? 'auto' : 'manual'}</span>
    <span>RegIrqFlags</span><span>0x${irq.toString(16).padStart(2, '0')} ${flags}</span>
    <span>Crystal error</span><span>${sx.ppm.toFixed(2)} ppm</span>
    <span>Time on air, 200 B</span><span>${(toa * 1000).toFixed(1)} ms</span>
    <span>Supply current</span><span>${sx.currentMa().toFixed(2)} mA</span>
  </div></div>
  <div class="box"><h3>Counters · last frame</h3><div class="kv">
    <span>Frames sent</span><span>${sx.stats.tx}</span><span>Received OK</span><span>${sx.stats.rxOk}</span>
    <span>CRC errors</span><span>${sx.stats.rxCrc}</span><span>RX single timeouts</span><span>${sx.stats.rxTimeout}</span>
    <span>Last frame</span><span>${lp ? `${lp.len} B from ${lp.from} at ${lp.t.toFixed(3)} s` : '–'}</span>
    <span>Packet RSSI · SNR</span><span>${lp ? `${lp.rssi} dBm · ${lp.snr.toFixed(2)} dB` : '–'}</span>
    <span>Frequency error</span><span>${lp ? `${(lp.fErr / 1e3).toFixed(2)} kHz` : '–'}</span>
  </div></div>
  <div class="box"><h3>Links (mean, no fading) · ${ENVIRONMENTS[state.world.channel.env].name}</h3>
    <table><thead><tr><th>to</th><th>distance</th><th>path loss</th><th>RSSI</th><th>SNR</th><th>margin</th></tr></thead><tbody>${rows || '<tr><td colspan=6 class="mute">no other node</td></tr>'}</tbody></table>
    <p class="note">Margin = SNR above the SX1278 demodulation limit at SF${sx.sf} (${SNR_LIMIT_DB[sx.sf]} dB). Noise floor −174 dBm/Hz + 10·log(BW) + 7 dB.</p>
  </div>`;
}

function renderImu() {
  const d = state.selected;
  if (!d) return;
  const cvp = $('#imuplot');
  const r = cvp.getBoundingClientRect();
  if (!r.width) return;
  const dpr = Math.min(devicePixelRatio, 2);
  cvp.width = r.width * dpr; cvp.height = r.height * dpr;
  const g = cvp.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const W = r.width, H = r.height;
  const now = d.t, span = 10;
  const imuTrace = traceOf(d);
  const ymax = Math.max(2.2, ...imuTrace.map(p => p.d + 0.2));
  const X = t => W - (now - t) / span * W, Y = v => H - 14 - v / ymax * (H - 24);
  g.strokeStyle = '#1c2733'; g.fillStyle = '#56677a'; g.font = '10px system-ui';
  for (let v = 0; v <= ymax; v += ymax > 6 ? 2 : 0.5) { g.beginPath(); g.moveTo(0, Y(v)); g.lineTo(W, Y(v)); g.stroke(); g.fillText(v.toFixed(1) + ' g', 3, Y(v) - 2); }
  g.strokeStyle = '#ff6b72'; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(0, Y(IMPACT_THRESHOLD_G)); g.lineTo(W, Y(IMPACT_THRESHOLD_G)); g.stroke(); g.setLineDash([]);
  g.fillStyle = '#ff6b72'; g.fillText(`firmware threshold ${IMPACT_THRESHOLD_G} g`, W - 140, Y(IMPACT_THRESHOLD_G) - 3);
  g.strokeStyle = '#3cb4d6'; g.lineWidth = 1.4; g.beginPath();
  imuTrace.forEach((p, i) => (i ? g.lineTo(X(p.t), Y(p.d)) : g.moveTo(X(p.t), Y(p.d))));
  g.stroke();
  const m = d.mpu.latest;
  $('#imukv').innerHTML = `<span>Accel (g)</span><span>${m.accel.map(v => v.toFixed(3)).join('  ')}</span><span>Gyro (°/s)</span><span>${m.gyro.map(v => v.toFixed(2)).join('  ')}</span>
    <span>|a| − 1 g now</span><span>${Math.abs(Math.hypot(...m.accel) - 1).toFixed(3)}</span><span>Range · DLPF</span><span>±${[2, 4, 8, 16][(d.mpu.regs[0x1c] >> 3) & 3]} g · ${[260, 184, 94, 44, 21, 10, 5, 260][d.mpu.regs[0x1a] & 7]} Hz</span>
    <span>Mount</span><span>dashboard, 0.75 m ahead of the CG</span>`;
  $('#imunote').innerHTML = `Values are the MPU-6050's output registers after its low-pass filter, i.e. what <code>mpu.getEvent()</code> returns to the firmware. With the board on the dashboard (sprung mass), a 12 cm pothole at 40 km/h gives about 1.2 g, below the firmware's ${IMPACT_THRESHOLD_G} g threshold; a crash gives far more.`;
}

function sampleImu() {
  for (const d of state.world.devices) {
    let tr = imuTraces.get(d.id);
    if (!tr) imuTraces.set(d.id, (tr = []));
    for (const p of d.mpu.trace) tr.push(p);
    d.mpu.trace = [];
    let k = 0;
    while (k < tr.length && tr[k].t < d.t - 10) k++;
    if (k) tr.splice(0, k);
  }
}

function renderPower() {
  const d = state.selected;
  if (!d) return;
  const p = d.power, b = p.battery;
  const parts = d.currents();
  const total = Object.values(parts).reduce((a, v) => a + v, 0);
  const names = { esp32: 'ESP32-C3', powerLed: 'DevKit power LED', lora: 'SX1278 (Ra-01)', gps: 'GPS', imu: 'MPU-6050', oled: 'OLED', buzzer: 'Buzzer', led: 'LED D1' };
  const max = Math.max(130, total);
  const rows = Object.entries(parts).map(([k, v]) => `<tr><td>${names[k]}</td><td style="width:45%"><div class="bar" style="width:${(v / max * 100).toFixed(1)}%;${k === 'lora' && d.sx.mode === 3 ? 'background:var(--fail)' : ''}"></div></td><td class="n">${v.toFixed(2)} mA</td></tr>`).join('');
  const txE = d.sx.currentMa();
  void txE;
  const tx200 = timeOnAir(d.sx.phy(), 200).total;
  $('#p-power').innerHTML = `
  <div class="box"><h3>3.3 V rail · now</h3><table>${rows}<tr><th>Total</th><td></td><td class="n"><b>${total.toFixed(1)} mA</b></td></tr></table>
    <p class="note">${(total * RAIL_V).toFixed(0)} mW on the rail. A 200-byte alert keeps the PA at 87 mA for ${(tx200 * 1000).toFixed(0)} ms: ${(87 * tx200 / 3.6).toFixed(1)} µAh.</p></div>
  <div class="box"><h3>Battery · TPS63001</h3><div class="kv">
    <span>Cell</span><span>LiFePO4 18650, ${b.capacityMah} mAh</span>
    <span>Voltage</span><span>${b.voltage().toFixed(3)} V</span>
    <span>State of charge</span><span>${(b.soc * 100).toFixed(2)} %</span>
    <span>Battery current</span><span>${b.ibat.toFixed(1)} mA</span>
    <span>Used since power-on</span><span>${p.chargeMah.toFixed(3)} mAh · ${p.energyJ.toFixed(1)} J</span>
    <span>Runtime at this load</span><span>${p.runtimeHours(b.ibat).toFixed(1)} h</span>
  </div><p class="note">The schematic's charger (MCP73123) terminates at 3.6 V, which suits LiFePO4. A Li-ion cell, as the README says, would only be charged to about half its capacity.</p></div>`;
}

// ----------------------------------------------------------------- serial / Pi
function piPacket(d, extra = {}) {
  const g = d.gps.last;
  const ll = g ? { lat: g.lat, lon: g.lon } : enuToLatLon(d.vehicle.x, d.vehicle.y);
  return JSON.stringify(Object.assign({ id: Math.random().toString(16).slice(2, 10), t: 'HAZARD_ALERT', veh: 'PI-' + d.firmwareId.slice(3), hz: 'pothole', c: 0.91, lat: +ll.lat.toFixed(6), lon: +ll.lon.toFixed(6), spd: +(d.vehicle.v * 3.6).toFixed(1), hop: 0, mh: 5, ttl: 30.0, oid: null, ts: 0 }, extra));
}
$('#ssend').onclick = () => { const d = state.selected; const v = $('#sline').value.trim(); if (d && v) { d.sendSerial(v); $('#sline').value = ''; } };
$('#sline').onkeydown = e => { if (e.key === 'Enter') $('#ssend').click(); };
$('#piHazard').onclick = () => { const d = state.selected; if (d) d.sendSerial(piPacket(d)); };
$('#piBeacon').onclick = () => {
  if (state.beacon) { clearInterval(state.beacon.timer); state.beacon = null; $('#piBeacon').textContent = 'Pi: heartbeat every 2 s'; return; }
  const d = state.selected;
  state.beacon = { dev: d, timer: setInterval(() => d.on && d.sendSerial(piPacket(d, { t: 'HEARTBEAT', hz: 'none', c: 1.0 })), 2000 / state.speed) };
  $('#piBeacon').textContent = `Stop heartbeat (${d.name})`;
};

// ----------------------------------------------------------------- audio (buzzer)
let audio = null;
function buzzerSound(on) {
  if (!state.sound) on = false;
  if (!audio && on) {
    const ac = new AudioContext();
    const osc = ac.createOscillator(); osc.type = 'square'; osc.frequency.value = 2300;
    const gain = ac.createGain(); gain.gain.value = 0;
    osc.connect(gain).connect(ac.destination); osc.start();
    audio = { ac, gain };
  }
  if (audio) audio.gain.gain.setTargetAtTime(on ? 0.035 : 0, audio.ac.currentTime, 0.01);
}

// ----------------------------------------------------------------- labels over the boards
const labelEls = new Map();
function updateLabels() {
  const r = $('#stage').getBoundingClientRect();
  const v = new T.Vector3();
  for (const [id, ui] of state.boards) {
    let el = labelEls.get(id);
    if (!el) { el = document.createElement('div'); el.className = 'blabel'; $('#labels').append(el); labelEls.set(id, el); }
    const d = ui.dev;
    // under the front edge of the board
    v.set(0, 0, 44); ui.root.localToWorld(v);
    v.project(camera);
    el.style.display = v.z < 1 ? 'block' : 'none';
    el.style.left = ((v.x + 1) / 2 * r.width) + 'px';
    el.style.top = ((1 - v.y) / 2 * r.height) + 'px';
    el.style.borderColor = d.color;
    el.innerHTML = `<b style="color:${d.color}">${d.name}</b> <small>${d.firmwareId}</small><br><small>${MODE_NAME[d.sx.mode]} · ${(d.vehicle.v * 3.6).toFixed(0)} km/h · ${fmtDist(d.vehicle.x)}</small>`;
  }
  for (const [id, el] of labelEls) if (!state.boards.has(id)) { el.remove(); labelEls.delete(id); }
}

// ----------------------------------------------------------------- main loop
let lastWall = performance.now();
let lastPanel = 0;
let rtfAvg = 1;
function frame(wall) {
  requestAnimationFrame(frame);
  const dtWall = Math.min(0.1, (wall - lastWall) / 1000);
  lastWall = wall;
  const w = state.world;
  if (!w) return;
  if (state.running) {
    const target = w.t + dtWall * state.speed;
    const reached = w.runUntil(target, 22);
    if (reached < target - 0.25) w.t = reached + 0.25;   // the CPU cannot keep up: slow the world down instead of piling up
    rtfAvg = rtfAvg * 0.95 + 0.05 * (dtWall > 0 ? Math.min(state.speed, (reached - (frame.lastReached ?? reached)) / dtWall) : state.speed);
    frame.lastReached = reached;
  }
  const now = w.t;
  processVisualEvents(now);
  sampleImu();
  for (const ui of state.boards.values()) {
    updateBoard(ui, now, dtWall);
    ui.devkit.position.y += ((state.lifted ? 28 : 0) - ui.devkit.position.y) * Math.min(1, dtWall * 6);
  }
  buzzerSound(w.devices.some(d => d.buzzerOn()));
  controls.update();
  renderer.render(scene, camera);
  updateLabels();
  map.draw(now);
  $('#clock').textContent = now.toFixed(3);
  $('#rtf').textContent = '×' + rtfAvg.toFixed(2);
  if (wall - lastPanel > 180) {
    lastPanel = wall;
    const tab = document.querySelector('.tab.sel').dataset.tab;
    if (tab === 'node') updateNodePane();
    if (tab === 'serial') renderConsole();
    if (tab === 'radio') renderRadio();
    if (tab === 'imu') renderImu();
    if (tab === 'power') renderPower();
    const tip = $('#tip');
    if (tip.style.display === 'block') { const d = w.device(tip.dataset.dev); const live = $('#tiplive'); if (d && live) live.innerHTML = partLive(d, tip.dataset.part); }
  }
}

// ----------------------------------------------------------------- header controls
document.querySelectorAll('.tab').forEach(t => (t.onclick = () => {
  document.querySelectorAll('.tab').forEach(x => x.classList.toggle('sel', x === t));
  document.querySelectorAll('.pane').forEach(p => p.classList.toggle('sel', p.id === 'p-' + t.dataset.tab));
  consoleDirty = true;
}));
$('#play').onclick = () => { state.running = !state.running; $('#play').textContent = state.running ? '❚❚ Pause' : '▶ Run'; };
$('#speed').onchange = e => { state.speed = +e.target.value; };
$('#sound').onclick = () => { state.sound = !state.sound; $('#sound').textContent = state.sound ? '🔊' : '🔈'; $('#sound').classList.toggle('on', state.sound); };
$('#env').onchange = e => state.world.channel.setEnvironment(e.target.value);
$('#rough').onchange = e => state.world.road.setRoughness(e.target.value);
$('#add').onclick = async () => { const d = await addNode({ lane: 1 }); select(d); map.fitted = false; };
$('#scenario').onchange = e => loadScenario(e.target.value);
$('#about').onclick = () => $('#aboutDlg').showModal();
$('#aboutClose').onclick = () => $('#aboutDlg').close();
$('#lift').onclick = () => { state.lifted = !state.lifted; $('#lift').textContent = state.lifted ? 'Lower DevKit' : 'Lift DevKit'; };
document.querySelectorAll('[data-view]').forEach(b => (b.onclick = () => frameCamera(b.dataset.view)));
window.addEventListener('resize', resize);
window.addEventListener('keydown', e => { if (e.target.tagName !== 'INPUT' && e.code === 'Space') { e.preventDefault(); $('#play').click(); } });

(async () => {
  try {
    state.module = await loadFirmware();
  } catch (err) {
    $('#loading').textContent = 'Could not load firmware.wasm: ' + err.message + ' (serve this folder over HTTP, e.g. python -m http.server)';
    return;
  }
  resize();
  await loadScenario('pair');
  $('#loading').remove();
  window.lab = state;   // for the console / tests
  requestAnimationFrame(frame);
})();
