/* 3D models of the RakshaWave boards (no enclosure). 1 unit = 1 mm.
 *
 * Part sizes follow the real parts (Raspberry Pi HAT outline 65 x 56.5 mm with
 * its mounting holes and 40-pin header, ESP32-C3-DevKitM-1 48.3 x 25.4 mm,
 * ESP32-C3-MINI-1 13.2 x 16.6 mm, Ai-Thinker Ra-01 17 x 16 mm, 0.91" OLED
 * module 38 x 12 mm, 12 mm buzzer, 6 mm tactile switch, QFN-24 MPU-6050...).
 * The KiCad PCB has no layout yet, so where the parts sit on the HAT is a
 * plausible arrangement, not a copy of a routed board.
 *
 * Everything that changes (OLED pixels, LED, buzzer, radio activity, buttons)
 * is driven from the emulated hardware every frame.
 */
const T = window.THREE;
// hex colours below are sRGB (as written in datasheets and CSS)
if (T.ColorManagement) T.ColorManagement.legacyMode = false;

const HAT_W = 65, HAT_D = 56.5, PCB_T = 1.6;
const COLORS = {
  mask: 0x0b5a3c, maskEdge: 0x2e5b3e, devkitMask: 0x15171b, gold: 0xd4a94a, silver: 0xc9ccd1, black: 0x16181c,
  silk: '#f2f4f2', copper: '#2f8a5c',
};

const mat = {};
function M(name, color, o = {}) {
  const key = name + color;
  // dielectrics only pick up a little of the studio reflections, metals all of it
  if (!mat[key]) mat[key] = new T.MeshStandardMaterial(Object.assign({ color, roughness: 0.55, metalness: 0.05, envMapIntensity: (o.metalness || 0) >= 0.5 ? 1 : 0.3 }, o));
  return mat[key];
}
const GOLD = () => M('gold', COLORS.gold, { roughness: 0.28, metalness: 1 });
const SILVER = () => M('silver', COLORS.silver, { roughness: 0.32, metalness: 1 });
const BLACK = () => M('black', COLORS.black, { roughness: 0.6 });
const PLASTIC = c => M('plastic', c, { roughness: 0.5 });

function mesh(geo, material, parent, x = 0, y = 0, z = 0) {
  const m = new T.Mesh(geo, material);
  m.position.set(x, y, z);
  m.castShadow = true;
  m.receiveShadow = true;
  parent.add(m);
  return m;
}
// boxes are placed by their top-view centre (x, z) in HAT coordinates and their bottom y
function box(parent, w, h, d, material, x, yBottom, z) {
  return mesh(new T.BoxGeometry(w, h, d), material, parent, x, yBottom + h / 2, z);
}
function cyl(parent, r, h, material, x, yBottom, z, seg = 28, rTop) {
  return mesh(new T.CylinderGeometry(rTop ?? r, r, h, seg), material, parent, x, yBottom + h / 2, z);
}

function canvasTex(w, h, draw, opts = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new T.CanvasTexture(c);
  t.encoding = T.sRGBEncoding;
  t.anisotropy = 8;
  if (opts.nearest) { t.magFilter = T.NearestFilter; t.minFilter = T.LinearFilter; }
  return t;
}

function labelTop(parent, w, d, x, y, z, draw, px = 24) {
  const tex = canvasTex(Math.round(w * px), Math.round(d * px), draw);
  const m = new T.Mesh(new T.PlaneGeometry(w, d), new T.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.6, metalness: 0, envMapIntensity: 0.3 }));
  m.rotation.x = -Math.PI / 2;
  m.position.set(x, y + 0.01, z);
  parent.add(m);
  return m;
}

// ---------------------------------------------------------------- HAT top artwork
const PADS = [];   // [x, z, r] copper pads printed on the texture (drawn under the parts)
function hatTexture(name) {
  const S = 20;
  return canvasTex(HAT_W * S, HAT_D * S, (g, W, H) => {
    g.fillStyle = '#0d5f40'; g.fillRect(0, 0, W, H);
    // copper pour hint + traces
    g.strokeStyle = 'rgba(70,170,110,0.55)'; g.lineCap = 'round';
    const tr = (pts, w = 0.25) => { g.lineWidth = w * S; g.beginPath(); pts.forEach(([x, z], i) => (i ? g.lineTo(x * S, z * S) : g.moveTo(x * S, z * S))); g.stroke(); };
    // I2C bus (SDA/SCL) from the DevKit to the IMU and the OLED header
    tr([[24, 31.2], [24, 24], [12, 24], [8, 16], [8, 13]]); tr([[26.5, 31.2], [26.5, 23], [14, 23], [10, 15], [10, 13]]);
    tr([[24, 24], [3.3, 24], [3.3, 22]]); tr([[26.5, 23], [4.5, 23], [4.5, 21]]);
    // SPI to the Ra-01
    for (let i = 0; i < 4; i++) tr([[34 + i * 2.54, 31.2], [34 + i * 2.54, 27 - i], [44 + i, 27 - i], [47, 20 - i * 2]]);
    // buzzer / LED / PTT
    tr([[16.5, 31.2], [16.5, 18.5], [18, 15]]); tr([[19, 31.2], [19, 19.5], [31, 19.5], [31, 15]]);
    tr([[39.5, 15], [39.5, 21], [52, 21], [52, 5]]);
    // power: USB-C -> charger -> buck-boost -> 3V3
    tr([[7, 40], [12, 38], [16, 42], [21, 42]], 0.6); tr([[21, 42], [30, 45]], 0.6); tr([[3, 48], [12, 38]], 0.6);
    // GPS UART
    tr([[29, 31.2], [29, 37], [34, 40]]);
    // Pi header fan-out
    for (let i = 0; i < 6; i++) tr([[9.6 + i * 2.54 * 3, 6], [9.6 + i * 2.54 * 3, 8.5], [12 + i * 6, 15.5]], 0.2);
    // vias
    g.fillStyle = 'rgba(200,180,110,0.9)';
    for (const [x, z] of [[12, 24], [14, 23], [44, 27], [45, 26], [46, 25], [47, 24], [31, 19.5], [52, 21], [29, 37], [16, 42], [36, 14], [42, 7.5], [20, 27], [60, 33]]) {
      g.beginPath(); g.arc(x * S, z * S, 0.45 * S, 0, 7); g.fill();
      g.fillStyle = '#1b2a22'; g.beginPath(); g.arc(x * S, z * S, 0.2 * S, 0, 7); g.fill(); g.fillStyle = 'rgba(200,180,110,0.9)';
    }
    // silkscreen
    g.fillStyle = COLORS.silk; g.strokeStyle = COLORS.silk;
    const text = (s, x, z, size = 1.3, align = 'left', rot = 0) => {
      g.save(); g.translate(x * S, z * S); g.rotate(rot); g.font = `600 ${size * S}px "Segoe UI", Arial, sans-serif`; g.textAlign = align; g.textBaseline = 'middle'; g.fillText(s, 0, 0); g.restore();
    };
    const rect = (x, z, w, d) => { g.lineWidth = 0.15 * S; g.strokeRect(x * S, z * S, w * S, d * S); };
    rect(1.5, 17.6, 39.3, 13.4); text('U5  OLED 0.91" 128x32', 21, 31.9, 1.1, 'center');
    rect(5.6, 8.6, 4.8, 4.8); text('U3', 11.2, 9.2, 1.1); text('MPU-6050', 8, 14.6, 0.9, 'center');
    g.beginPath(); g.arc(21 * S, 11.7 * S, 6.3 * S, 0, 7); g.lineWidth = 0.15 * S; g.stroke(); text('BZ1', 21, 3.9 + 1.2, 0.9, 'center'); text('+', 24.5, 7.5, 1.4, 'center');
    text('D1', 33.3, 9, 1); text('R5', 33.3, 13.6, 1); text('330R', 31, 15.6, 0.8, 'center');
    rect(36.4, 7.9, 6.2, 6.2); text('SW1 PTT', 39.5, 16.2, 1.1, 'center');
    rect(46, 6.1, 18, 17); text('U1  Ra-01  433 MHz', 55, 24.4, 1, 'center');
    text('LORA', 63.6, 30.6, 1, 'right'); text('GPS', 1.2, 21.3, 1, 'left');
    text('J3 I2S MIC', 58.5, 29.4, 0.9, 'center'); text('J4 I2S AMP', 62.4, 48.2, 0.8, 'center', -Math.PI / 2);
    text('J1 BATT', 1, 44.2, 0.85); text('+', 6.1, 47, 1.1); text('J2 USB-C', 1, 34.2, 0.85);
    text('RakshaWave V2V node · HAT v1.2 · TechLads', 32.5, 7.2, 1.0, 'center');
    text(name, 46.5, 27.2, 1.05, 'left');
    // header outline + pin 1 marker
    rect(7.1, 0.9, 50.8, 5.2); g.beginPath(); g.arc(6.2 * S, 2.2 * S, 0.35 * S, 0, 7); g.fill();
    // mounting hole keep-outs
    for (const [x, z] of [[3.5, 3.5], [61.5, 3.5], [3.5, 52.5], [61.5, 52.5]]) { g.beginPath(); g.arc(x * S, z * S, 3.1 * S, 0, 7); g.lineWidth = 0.12 * S; g.stroke(); }
    // gold pads for the parts that sit on the HAT (drawn, parts are added as meshes)
    g.fillStyle = '#d6ae55';
    for (let i = 0; i < 6; i++) g.fillRect((5.6 + i * 0.8) * S, 8.1 * S, 0.35 * S, 0.5 * S);
    for (const [x, z, w, d] of PADS) g.fillRect((x - w / 2) * S, (z - d / 2) * S, w * S, d * S);
  });
}

function roundedRectShape(w, d, r) {
  const s = new T.Shape();
  s.moveTo(-w / 2 + r, -d / 2);
  s.lineTo(w / 2 - r, -d / 2); s.quadraticCurveTo(w / 2, -d / 2, w / 2, -d / 2 + r);
  s.lineTo(w / 2, d / 2 - r); s.quadraticCurveTo(w / 2, d / 2, w / 2 - r, d / 2);
  s.lineTo(-w / 2 + r, d / 2); s.quadraticCurveTo(-w / 2, d / 2, -w / 2, d / 2 - r);
  s.lineTo(-w / 2, -d / 2 + r); s.quadraticCurveTo(-w / 2, -d / 2, -w / 2 + r, -d / 2);
  return s;
}

// ---------------------------------------------------------------- parts
function smdCap(parent, x, z, rot = 0, color = 0xb89a6a) {
  const g = new T.Group(); g.position.set(x, 0, z); g.rotation.y = rot; parent.add(g);
  box(g, 1.6, 0.8, 0.8, M('cap', color, { roughness: 0.7 }), 0, 0, 0);
  box(g, 0.3, 0.82, 0.82, SILVER(), -0.65, 0, 0); box(g, 0.3, 0.82, 0.82, SILVER(), 0.65, 0, 0);
  return g;
}

function qfn(parent, size, h, x, z, lines, y = 0) {
  box(parent, size, h, size, M('qfn', 0x1d1f22, { roughness: 0.45 }), x, y, z);
  labelTop(parent, size, size, x, y + h, z, (g, W, H) => {
    g.fillStyle = '#9aa0a6'; g.font = `${H * 0.2}px Arial`; g.textAlign = 'center'; g.textBaseline = 'middle';
    lines.forEach((l, i) => g.fillText(l, W / 2, H * (0.38 + i * 0.26)));
    g.beginPath(); g.arc(W * 0.14, H * 0.14, W * 0.05, 0, 7); g.fill();
  }, 40);
}

function tactSmall(parent, x, y, z, label) {
  const g = new T.Group(); g.position.set(x, y, z); parent.add(g);
  box(g, 3.9, 1.2, 2.9, SILVER(), 0, 0, 0);
  const cap = cyl(g, 0.9, 0.9, BLACK(), 0, 1.2, 0, 20);
  const hit = mesh(new T.BoxGeometry(6, 4, 5), new T.MeshBasicMaterial({ visible: false }), g, 0, 1.5, 0);
  return { group: g, cap, hit, restY: cap.position.y, travel: 0.35, label };
}

function header(parent, n, x0, z0, dir, yBottom, h = 8.5, female = true) {
  const len = n * 2.54;
  const along = dir === 'x';
  const body = female ? h : 2.5;   // a male pin header is a 2.5 mm plastic strip with 6 mm pins above it
  box(parent, along ? len : 2.5, body, along ? 2.5 : len, BLACK(), x0 + (along ? len / 2 - 1.27 : 0), yBottom, z0 + (along ? 0 : len / 2 - 1.27));
  for (let i = 0; i < n; i++) {
    const px = x0 + (along ? i * 2.54 : 0), pz = z0 + (along ? 0 : i * 2.54);
    if (female) box(parent, 0.9, 0.05, 0.9, M('hole', 0x050505), px, yBottom + h, pz);
    else box(parent, 0.64, 6, 0.64, GOLD(), px, yBottom + body - 0.5, pz);
  }
}

function antenna(parent, x, y, z, dirX, len, name) {
  // edge-mount SMA jack (gold) + rubber-duck whip with a hinge, pointing up
  const g = new T.Group(); g.position.set(x, y, z); parent.add(g);
  const sma = mesh(new T.CylinderGeometry(2.1, 2.1, 7, 6), GOLD(), g, dirX * 3.5, 0, 0); sma.rotation.z = Math.PI / 2;
  const sma2 = mesh(new T.CylinderGeometry(3.2, 3.2, 2.2, 6), GOLD(), g, dirX * 2.0, 0, 0); sma2.rotation.z = Math.PI / 2;
  box(g, 3.2, 6.4, 6.4, GOLD(), -dirX * 0.4, -3.2, 0);
  if (len <= 0) return { group: g, tip: new T.Vector3(dirX * 7, 0, 0), tipMesh: sma };
  const knuckle = mesh(new T.SphereGeometry(3.4, 20, 14), M('duck', 0x202225, { roughness: 0.65 }), g, dirX * 9.5, 0, 0);
  const whip = cyl(g, 3.2, len, M('duck', 0x202225, { roughness: 0.65 }), dirX * 9.5, 0, 0, 24, 2.0);
  const tip = mesh(new T.SphereGeometry(2.0, 16, 10), M('duck', 0x202225, { roughness: 0.65 }), g, dirX * 9.5, len, 0);
  const ring = cyl(g, 3.25, 1.2, M('ring', name === 'gps' ? 0x2b6cb0 : 0xc0392b, { roughness: 0.4 }), dirX * 9.5, 8, 0, 24);
  void knuckle; void whip; void ring;
  return { group: g, tip: new T.Vector3(dirX * 9.5, len, 0), tipMesh: tip };
}

function oledTexture() {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 128;
  const t = new T.CanvasTexture(c);
  t.encoding = T.sRGBEncoding;
  t.magFilter = T.LinearFilter;
  return { canvas: c, tex: t, ctx: c.getContext('2d'), version: -1 };
}

export function drawOled(o, oled) {
  const g = o.ctx, W = o.canvas.width, H = o.canvas.height, sx = W / 128, sy = H / 32;
  g.fillStyle = '#05070a'; g.fillRect(0, 0, W, H);
  if (!oled.lit) return;
  const b = 0.45 + 0.55 * (oled.contrast / 255);
  g.fillStyle = `rgba(150,225,255,${b})`;
  g.shadowColor = 'rgba(120,210,255,0.9)'; g.shadowBlur = 6;
  for (let y = 0; y < 32; y++) for (let x = 0; x < 128; x++) if (oled.pixel(x, y)) g.fillRect(x * sx + 0.4, y * sy + 0.4, sx - 0.8, sy - 0.8);
  g.shadowBlur = 0;
}

// ---------------------------------------------------------------- the board
export function buildBoard(dev, color) {
  const root = new T.Group();
  root.userData.dev = dev;
  const B = new T.Group();           // HAT coordinates: x right, z towards the viewer, origin at the HAT's top-left
  B.position.set(-HAT_W / 2, 11, -HAT_D / 2);
  root.add(B);
  const ui = { root, buttons: {}, dev, antennas: {}, waves: [], pulses: [] };

  // HAT PCB with rounded corners and drilled mounting holes
  const shape = roundedRectShape(HAT_W, HAT_D, 3);
  for (const [x, z] of [[3.5, 3.5], [61.5, 3.5], [3.5, 52.5], [61.5, 52.5]]) {
    const h = new T.Path(); h.absarc(x - HAT_W / 2, -(z - HAT_D / 2), 1.375, 0, Math.PI * 2, true); shape.holes.push(h);
  }
  const pcbGeo = new T.ExtrudeGeometry(shape, { depth: PCB_T, bevelEnabled: false, curveSegments: 10 });
  pcbGeo.rotateX(-Math.PI / 2);
  // planar UVs from x/z for the top artwork
  const pos = pcbGeo.attributes.position, uv = pcbGeo.attributes.uv;
  for (let i = 0; i < pos.count; i++) uv.setXY(i, (pos.getX(i) + HAT_W / 2) / HAT_W, 1 - (pos.getZ(i) + HAT_D / 2) / HAT_D);
  const top = new T.MeshStandardMaterial({ map: hatTexture(dev.name), roughness: 0.38, metalness: 0.05, envMapIntensity: 0.45 });
  const pcb = new T.Mesh(pcbGeo, [top, M('fr4', 0x2c4a34, { roughness: 0.8 })]);
  pcb.position.set(HAT_W / 2, -PCB_T, HAT_D / 2);
  pcb.castShadow = pcb.receiveShadow = true;
  B.add(pcb);
  pcb.userData.part = 'hat';
  ui.pcb = pcb;

  // plated mounting rings, brass standoffs and screws
  for (const [x, z] of [[3.5, 3.5], [61.5, 3.5], [3.5, 52.5], [61.5, 52.5]]) {
    const ring = mesh(new T.RingGeometry(1.4, 3.0, 28), GOLD(), B, x, 0.02, z); ring.rotation.x = -Math.PI / 2;
    cyl(B, 2.5, 11, M('brass', 0xb8923a, { metalness: 1, roughness: 0.35 }), x, -PCB_T - 11, z, 6);
    cyl(B, 2.4, 1.6, SILVER(), x, 0, z, 24);
  }
  // 40-pin header: plated holes on top, female socket underneath (for the Pi)
  for (let i = 0; i < 20; i++) for (const zz of [2.23, 4.77]) {
    const r = mesh(new T.RingGeometry(0.5, 0.85, 16), GOLD(), B, 8.37 + i * 2.54, 0.02, zz); r.rotation.x = -Math.PI / 2;
  }
  box(B, 50.8, 8.5, 5.1, BLACK(), 32.5, -PCB_T - 8.5, 3.5);

  // ---- U4 ESP32-C3-DevKitM-1 on two 1x15 sockets (8.5 mm)
  const DK = { x0: 6.5, z0: 30.8, L: 48.3, W: 25.4, y: 8.5 };
  ui.devkit = new T.Group(); B.add(ui.devkit);
  const dk = ui.devkit;
  header(B, 15, 13.0, 31.95, 'x', 0, DK.y);
  header(B, 15, 13.0, 54.25, 'x', 0, DK.y);
  const dkTop = DK.y + PCB_T;
  box(dk, DK.L, PCB_T, DK.W, M('dkmask', COLORS.devkitMask, { roughness: 0.45 }), DK.x0 + DK.L / 2, DK.y, DK.z0 + DK.W / 2);
  labelTop(dk, DK.L, DK.W, DK.x0 + DK.L / 2, dkTop, DK.z0 + DK.W / 2, (g, W, H) => {
    const s = W / DK.L;
    g.fillStyle = '#e8e8e8'; g.font = `600 ${1.15 * s}px Arial`;
    g.fillText('ESP32-C3-DevKitM-1', 13 * s, 12.5 * s);
    g.font = `${0.9 * s}px Arial`;
    const top = ['GND', '3V3', '3V3', 'RST', 'GND', 'IO4', 'IO5', 'IO6', 'IO7', 'GND', 'IO8', 'IO9', '5V', '5V', 'GND'];
    const bot = ['GND', 'TX', 'RX', 'GND', 'IO10', 'IO20', 'IO21', 'GND', 'IO18', 'IO19', 'GND', 'IO3', 'IO2', 'IO1', 'IO0'];
    top.forEach((l, i) => g.fillText(l, (6.2 + i * 2.54) * s, 3.4 * s));
    bot.forEach((l, i) => g.fillText(l, (6.2 + i * 2.54) * s, 22.9 * s));
    g.fillText('BOOT', 9.6 * s, 6.4 * s); g.fillText('RST', 9.6 * s, 20.6 * s);
    g.fillStyle = '#d6ae55';
    for (let i = 0; i < 15; i++) for (const z of [1.15, 24.25]) { g.beginPath(); g.arc((6.5 + i * 2.54) * s, z * s, 0.8 * s, 0, 7); g.fill(); }
  }, 22);
  // gold pins on top of the DevKit
  for (let i = 0; i < 15; i++) for (const z of [31.95, 54.25]) box(dk, 0.64, 1.8, 0.64, GOLD(), 13.0 + i * 2.54, dkTop - 0.2, z);
  // ESP32-C3-MINI-1 module: PCB, shield, PCB antenna
  const MX = 38.2, MZ = 36.9;
  box(dk, 16.6, 0.8, 13.2, M('minipcb', 0x1f2a44, { roughness: 0.5 }), MX + 8.3, dkTop, MZ + 6.6);
  const shield = box(dk, 12.4, 1.6, 11.6, SILVER(), MX + 6.4, dkTop + 0.8, MZ + 6.6);
  shield.userData.part = 'esp32';
  labelTop(dk, 12.4, 11.6, MX + 6.4, dkTop + 2.4, MZ + 6.6, (g, W, H) => {
    g.fillStyle = '#4b5563'; g.textAlign = 'center';
    g.font = `700 ${H * 0.12}px Arial`; g.fillText('ESPRESSIF', W / 2, H * 0.24);
    g.font = `600 ${H * 0.1}px Arial`; g.fillText('ESP32-C3-MINI-1', W / 2, H * 0.44);
    g.font = `${H * 0.075}px Arial`; g.fillText('FCC ID: 2AC7Z-ESPC3MINI1', W / 2, H * 0.62); g.fillText('M4N4 · 4MB flash', W / 2, H * 0.76);
  }, 30);
  labelTop(dk, 3.8, 12.6, MX + 14.6, dkTop + 0.8, MZ + 6.6, (g, W, H) => {
    g.strokeStyle = '#c9a84e'; g.lineWidth = W * 0.06; g.beginPath();
    let up = true;
    for (let z = H * 0.1; z < H * 0.9; z += H * 0.08) { g.moveTo(W * 0.2, z); g.lineTo(W * 0.8, z); up = !up; }
    g.stroke();
  }, 30);
  // micro-USB, regulator, USB-UART bridge, LEDs
  box(dk, 5.8, 2.9, 7.6, SILVER(), DK.x0 + 2.4, dkTop, DK.z0 + 12.7);
  box(dk, 6.5, 1.6, 3.5, BLACK(), 24, dkTop, 37.6);
  box(dk, 3.0, 0.2, 1.6, SILVER(), 24, dkTop + 1.6, 36.3);
  qfn(dk, 4, 0.9, 29.5, 46, ['CP2102N'], dkTop);
  box(dk, 2, 0.8, 2, PLASTIC(0xf4f4f4), 21, dkTop, 47.5);
  ui.powerLed = box(dk, 1.6, 0.6, 0.8, new T.MeshStandardMaterial({ color: 0x551111, emissive: 0x000000 }), 19, dkTop, 35.6);
  ui.buttons.boot = tactSmall(dk, 13.5, dkTop, 34.3, 'BOOT');
  ui.buttons.reset = tactSmall(dk, 13.5, dkTop, 52.4, 'RST');
  for (let i = 0; i < 6; i++) smdCap(dk, 33 + i * 1.2, 33.5, Math.PI / 2, 0xa8875a);

  // ---- parts under the DevKit (visible from the side, or with the DevKit lifted)
  const gps = box(B, 15, 2.2, 13, SILVER(), 34, 0, 43.5); gps.userData.part = 'gps';
  labelTop(B, 15, 13, 34, 2.2, 43.5, (g, W, H) => { g.fillStyle = '#374151'; g.textAlign = 'center'; g.font = `700 ${H * 0.14}px Arial`; g.fillText('LINX', W / 2, H * 0.32); g.font = `600 ${H * 0.12}px Arial`; g.fillText('RXM-GPS-FM', W / 2, H * 0.55); g.font = `${H * 0.09}px Arial`; g.fillText('U2', W / 2, H * 0.78); }, 26);
  qfn(B, 3, 0.9, 16, 42, ['63001'], 0);
  box(B, 4, 2, 4, M('ind', 0x3a3d42, { roughness: 0.7 }), 21, 0, 42);
  qfn(B, 3, 0.9, 12, 38, ['73123'], 0);
  [[16, 46], [18.5, 46], [21, 46], [23.5, 46], [13, 41.5]].forEach(([x, z]) => smdCap(B, x, z));
  // USB-C receptacle (J2) and battery connector (J1, JST-PH)
  box(B, 7.3, 3.2, 8.9, SILVER(), 3.65, 0, 40);
  box(B, 0.4, 2.2, 7.2, M('usbin', 0x111111), 0.2, 0.5, 40);
  box(B, 4.5, 6, 6, PLASTIC(0xf1efe6), 2.7, 0, 48.2);

  // ---- upper band
  // U5 OLED module on a 4-pin header, glass + live picture
  const O = { x0: 2, z0: 18.3, L: 38, W: 12, y: 6 };
  for (let i = 0; i < 4; i++) box(B, 0.64, O.y + 2, 0.64, GOLD(), O.x0 + 1.3, 0, O.z0 + 2.2 + i * 2.54);
  box(B, 2.5, 2.5, 10.2, BLACK(), O.x0 + 1.3, 0, O.z0 + 6);
  const oledPcb = box(B, O.L, 1.2, O.W, M('oledpcb', 0x16336b, { roughness: 0.5 }), O.x0 + O.L / 2, O.y, O.z0 + O.W / 2);
  oledPcb.userData.part = 'oled';
  labelTop(B, 6, O.W, O.x0 + 3.6, O.y + 1.2, O.z0 + O.W / 2, (g, W, H) => {
    g.fillStyle = '#e5e7eb'; g.font = `${H * 0.085}px Arial`;
    ['GND', 'VCC', 'SCL', 'SDA'].forEach((l, i) => g.fillText(l, W * 0.42, H * (0.22 + i * 0.212)));
  }, 30);
  const glass = box(B, 30, 1.0, 11.4, M('glass', 0x0b0d10, { roughness: 0.08, metalness: 0.2 }), O.x0 + 22.5, O.y + 1.2, O.z0 + O.W / 2);
  glass.userData.part = 'oled';
  box(B, 2.4, 0.3, 9, M('fpc', 0xc98b2a, { roughness: 0.5 }), O.x0 + 37, O.y + 1.2, O.z0 + O.W / 2);
  ui.oled = oledTexture();
  const scr = new T.Mesh(new T.PlaneGeometry(22.38, 5.58), new T.MeshBasicMaterial({ map: ui.oled.tex, toneMapped: false }));
  scr.rotation.x = -Math.PI / 2;
  scr.position.set(O.x0 + 22.0, O.y + 2.23, O.z0 + O.W / 2 - 0.6);
  B.add(scr);
  scr.userData.part = 'oled';
  ui.oledScreen = scr;

  // U3 MPU-6050 (QFN-24, 4 x 4 mm) with its capacitors
  qfn(B, 4, 0.9, 8, 11, ['MPU-6050', 'C4K1'], 0);
  const imuHit = mesh(new T.BoxGeometry(6, 3, 6), new T.MeshBasicMaterial({ visible: false }), B, 8, 1, 11); imuHit.userData.part = 'imu';
  [[4.2, 9], [4.2, 13], [11.8, 9], [11.8, 13], [8, 15.2]].forEach(([x, z], i) => smdCap(B, x, z, i < 4 ? Math.PI / 2 : 0, 0xa8875a));
  ui.imuChip = imuHit;

  // BZ1 buzzer (12 mm)
  const bz = new T.Group(); bz.position.set(21, 0, 11.7); B.add(bz);
  cyl(bz, 6, 9.5, M('buzz', 0x121316, { roughness: 0.75 }), 0, 0, 0, 40);
  const bzTop = mesh(new T.RingGeometry(0.9, 6, 40), M('buzztop', 0x1b1c20, { roughness: 0.9 }), bz, 0, 9.52, 0); bzTop.rotation.x = -Math.PI / 2;
  cyl(bz, 0.9, 0.2, M('hole', 0x050505), 0, 9.4, 0, 20);
  labelTop(bz, 7, 2.6, 0, 9.55, 3.2, (g, W, H) => { g.fillStyle = '#9ca3af'; g.textAlign = 'center'; g.font = `${H * 0.55}px Arial`; g.fillText('+ 3V', W / 2, H * 0.7); }, 30);
  bz.children.forEach(c => (c.userData.part = 'buzzer'));
  ui.buzzer = bz;

  // D1 red LED (3 mm) + R5
  const ledMat = new T.MeshStandardMaterial({ color: 0x8a1010, roughness: 0.2, transparent: true, opacity: 0.92, emissive: 0x000000 });
  const led = new T.Group(); led.position.set(31, 0, 9); B.add(led);
  cyl(led, 1.6, 1, ledMat, 0, 0.3, 0, 24);
  cyl(led, 1.5, 3.2, ledMat, 0, 1.3, 0, 24);
  mesh(new T.SphereGeometry(1.5, 24, 12, 0, Math.PI * 2, 0, Math.PI / 2), ledMat, led, 0, 4.5, 0);
  led.children.forEach(c => (c.userData.part = 'led'));
  ui.ledMat = ledMat;
  ui.ledLight = new T.PointLight(0xff2a1a, 0, 60, 2); ui.ledLight.position.set(31, 6, 9); B.add(ui.ledLight);
  const r5 = box(B, 2, 0.5, 1.25, BLACK(), 31, 0, 13.5);
  labelTop(B, 1.2, 0.8, 31, 0.5, 13.5, (g, W, H) => { g.fillStyle = '#ddd'; g.textAlign = 'center'; g.font = `${H * 0.7}px Arial`; g.fillText('331', W / 2, H * 0.8); }, 40);
  void r5;

  // SW1 PTT, 6 x 6 mm tactile switch with a red round cap
  const sw = new T.Group(); sw.position.set(39.5, 0, 11); B.add(sw);
  box(sw, 6, 3.4, 6, BLACK(), 0, 0, 0);
  box(sw, 6.1, 0.3, 6.1, SILVER(), 0, 3.4, 0);
  for (const [dx, dz] of [[-3.3, -2.25], [3.3, -2.25], [-3.3, 2.25], [3.3, 2.25]]) box(sw, 0.8, 0.6, 0.7, SILVER(), dx, 0, dz);
  const pttCap = cyl(sw, 1.9, 2.4, M('ptt', 0xd23a2a, { roughness: 0.35 }), 0, 3.7, 0, 32);
  const pttHit = mesh(new T.BoxGeometry(8, 8, 8), new T.MeshBasicMaterial({ visible: false }), sw, 0, 3, 0);
  ui.buttons.ptt = { group: sw, cap: pttCap, hit: pttHit, restY: pttCap.position.y, travel: 0.25, label: 'PTT' };

  // U1 Ai-Thinker Ra-01 (17 x 16 mm) with castellations, shield and IPEX
  const RX = 46.5, RZ = 6.6;
  box(B, 17, 0.8, 16, M('rapcb', 0x1f3b75, { roughness: 0.5 }), RX + 8.5, 0, RZ + 8);
  for (let i = 0; i < 8; i++) for (const x of [RX + 0.25, RX + 16.75]) box(B, 0.55, 0.82, 1.0, GOLD(), x, 0, RZ + 1.4 + i * 1.9);
  const raShield = box(B, 15.4, 1.7, 13.2, SILVER(), RX + 8.5, 0.8, RZ + 7.2);
  raShield.userData.part = 'lora';
  labelTop(B, 15.4, 13.2, RX + 8.5, 2.5, RZ + 7.2, (g, W, H) => {
    g.fillStyle = '#374151'; g.textAlign = 'center';
    g.font = `700 ${H * 0.13}px Arial`; g.fillText('Ai-Thinker', W / 2, H * 0.27);
    g.font = `800 ${H * 0.2}px Arial`; g.fillText('Ra-01', W / 2, H * 0.5);
    g.font = `600 ${H * 0.1}px Arial`; g.fillText('SX1278 · 410-525 MHz', W / 2, H * 0.68); g.fillText('LoRa', W / 2, H * 0.84);
  }, 26);
  cyl(B, 1.0, 1.2, GOLD(), RX + 15.2, 0.8, RZ + 14.6, 16);
  // pigtail from the IPEX to the edge SMA
  const curve = new T.CubicBezierCurve3(new T.Vector3(RX + 15.2, 2.2, RZ + 14.6), new T.Vector3(RX + 17, 6, RZ + 18), new T.Vector3(62, 5, 26), new T.Vector3(63.5, 0.8, 27.5));
  mesh(new T.TubeGeometry(curve, 24, 0.55, 8), M('coax', 0x2a2a2a, { roughness: 0.6 }), B);
  ui.antennas.lora = antenna(B, 65, 0.8, 27.5, 1, 105, 'lora');
  ui.antennas.lora.tipMesh.userData.part = 'antenna';
  // GPS SMA on the left edge and an active patch antenna on its cable
  ui.antennas.gps = antenna(B, 0, 0.8, 24, -1, 0, 'gps');
  const gc = new T.CatmullRomCurve3([new T.Vector3(-7, 0.8, 24), new T.Vector3(-14, -2, 20), new T.Vector3(-20, -10, 6), new T.Vector3(-24, -11.5, -6)]);
  mesh(new T.TubeGeometry(gc, 30, 1.0, 8), M('coax', 0x2a2a2a, { roughness: 0.6 }), B);
  const puck = box(B, 26, 8, 26, M('puck', 0x15171a, { roughness: 0.8 }), -30, -11.9, -16);
  labelTop(B, 20, 20, -30, -3.9, -16, (g, W, H) => { g.fillStyle = '#9ca3af'; g.textAlign = 'center'; g.font = `700 ${H * 0.2}px Arial`; g.fillText('GPS', W / 2, H * 0.45); g.font = `${H * 0.09}px Arial`; g.fillText('active patch 28 dB', W / 2, H * 0.66); }, 16);
  puck.userData.part = 'gps';

  // J3 / J4 I2S headers
  header(B, 6, 58.5, 31.5, 'z', 0, 8.5, false);
  header(B, 7, 62.4, 31.5, 'z', 0, 8.5, false);

  // 18650 LiFePO4 cell in a holder, wired to J1
  const cell = new T.Group(); cell.position.set(-12, -11.9, 70); root.add(cell);
  box(cell, 77, 3, 21, BLACK(), 0, 0, 0);
  const tube = mesh(new T.CylinderGeometry(9, 9, 65, 40), M('cellwrap', 0x1747a6, { roughness: 0.35, envMapIntensity: 0.5 }), cell, 0, 11, 0); tube.rotation.z = Math.PI / 2;
  const capP = mesh(new T.CylinderGeometry(3.5, 3.5, 1.5, 24), SILVER(), cell, 33.2, 11, 0); capP.rotation.z = Math.PI / 2;
  labelTop(cell, 50, 14, 0, 20, 0, (g, W, H) => { g.fillStyle = '#f8fafc'; g.textAlign = 'center'; g.font = `700 ${H * 0.28}px Arial`; g.fillText('LiFePO4 18650', W / 2, H * 0.42); g.font = `${H * 0.2}px Arial`; g.fillText('3.2 V  1500 mAh', W / 2, H * 0.78); }, 16);
  cell.children.forEach(c => (c.userData.part = 'battery'));
  const w1 = new T.CatmullRomCurve3([new T.Vector3(-37, 1.5, 75), new T.Vector3(-45, 4, 50), new T.Vector3(-36, 8, 25), new T.Vector3(-31.5, 13, 20)]);
  const w2 = new T.CatmullRomCurve3([new T.Vector3(25, 1.5, 75), new T.Vector3(10, 6, 60), new T.Vector3(-30, 10, 30), new T.Vector3(-31.5, 13, 21.5)]);
  mesh(new T.TubeGeometry(w1, 30, 0.6, 8), M('wire', 0x111111), root);
  mesh(new T.TubeGeometry(w2, 30, 0.6, 8), M('wire', 0xb91c1c), root);

  // radio activity rings at the antenna tip
  ui.waveMat = c => new T.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.5, side: T.DoubleSide, depthWrite: false, blending: T.AdditiveBlending });
  ui.B = B;
  ui.color = color;

  // pick targets
  ui.pickables = [];
  root.traverse(o => { if (o.isMesh) ui.pickables.push(o); });
  return ui;
}

// ---------------------------------------------------------------- live update
export function updateBoard(ui, now, dt) {
  const dev = ui.dev;
  // OLED picture
  if (ui.oled.version !== dev.oled.version || ui.oled.lit !== dev.oled.lit) {
    ui.oled.version = dev.oled.version; ui.oled.lit = dev.oled.lit;
    drawOled(ui.oled, dev.oled);
    ui.oled.tex.needsUpdate = true;
  }
  // LED D1 and DevKit power LED
  const ledOn = dev.ledOn();
  ui.ledMat.emissive.setHex(ledOn ? 0xff2a10 : 0x000000);
  ui.ledMat.emissiveIntensity = ledOn ? 2.2 : 0;
  ui.ledLight.intensity = ledOn ? 1.6 : 0;
  ui.powerLed.material.emissive.setHex(dev.on ? 0xff2020 : 0);
  ui.powerLed.material.emissiveIntensity = dev.on ? 1.5 : 0;
  // buzzer: vibrate
  const bz = dev.buzzerOn();
  ui.buzzer.position.y = bz ? Math.sin(now * 900) * 0.08 : 0;
  // buttons
  for (const k of Object.keys(ui.buttons)) {
    const b = ui.buttons[k];
    const pressed = k === 'ptt' ? !!dev.pttDown : !!dev.buttons[k];
    b.cap.position.y += ((pressed ? b.restY - b.travel : b.restY) - b.cap.position.y) * Math.min(1, dt * 30);
  }
  // radio waves
  for (const w of ui.waves) {
    w.age += dt;
    const k = w.age / w.life;
    w.mesh.scale.set(1 + k * 22, 1 + k * 22, 1);
    w.mesh.material.opacity = Math.max(0, 0.8 * (1 - k));
  }
  for (const w of ui.waves.filter(w => w.age >= w.life)) { w.mesh.parent.remove(w.mesh); w.mesh.geometry.dispose(); }
  ui.waves = ui.waves.filter(w => w.age < w.life);
  const tipMat = ui.antennas.lora.tipMesh.material;
  if (ui.rxFlash > 0) { ui.rxFlash -= dt; tipMat.emissive?.setHex(ui.rxColor); tipMat.emissiveIntensity = 1.5; }
  else if (tipMat.emissive) tipMat.emissive.setHex(0);
}

export function emitWave(ui, color = 0x48c6ff) {
  // a thin horizontal ring spreading from the whip while the frame is on the air
  const a = ui.antennas.lora;
  const m = new T.Mesh(new T.TorusGeometry(3, 0.18, 6, 48), ui.waveMat(color));
  m.rotation.x = Math.PI / 2;
  m.position.copy(a.tip).add(a.group.position);
  m.position.y -= 30;
  ui.B.add(m);
  ui.waves.push({ mesh: m, age: 0, life: 1.1 });
}

export function flashRx(ui, ok) {
  // the tip shares a material with the whip; give it its own once
  const tip = ui.antennas.lora.tipMesh;
  if (!tip.userData.ownMat) { tip.material = tip.material.clone(); tip.userData.ownMat = true; }
  ui.rxFlash = 0.5;
  ui.rxColor = ok ? 0x22ff88 : 0xff3344;
}

export function makeEnvironment(renderer) {
  // a small "photo studio" so the metal parts have something to reflect
  const env = new T.Scene();
  const room = new T.Mesh(new T.BoxGeometry(10, 6, 10), new T.MeshBasicMaterial({ color: 0x6b7480, side: T.BackSide }));
  env.add(room);
  const panel = (w, h, x, y, z, c, ry = 0, rx = 0) => { const m = new T.Mesh(new T.PlaneGeometry(w, h), new T.MeshBasicMaterial({ color: c, side: T.DoubleSide })); m.position.set(x, y, z); m.rotation.set(rx, ry, 0); env.add(m); };
  panel(8, 3, 0, 2.9, 0, 0xffffff, 0, Math.PI / 2);
  panel(5, 3, -4.9, 1.2, 0, 0xd8e8ff, Math.PI / 2);
  panel(5, 3, 4.9, 1.4, 1, 0xfff3dc, -Math.PI / 2);
  panel(7, 2, 0, 1, -4.9, 0xb8cde0);
  panel(10, 10, 0, -2.9, 0, 0x2a3038, 0, Math.PI / 2);
  const pm = new T.PMREMGenerator(renderer);
  const rt = pm.fromScene(env, 0.04);
  return rt.texture;
}
