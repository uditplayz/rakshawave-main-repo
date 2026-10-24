/* RakshaWave 3D twin. 1 unit = 1 cm. Everything that changes comes from /api/twin/state (the real firmware in Wokwi). */
(() => {
const $ = s => document.querySelector(s);
const api = (p, body) => fetch(p, body === undefined ? {} : {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body || {})}).then(r => r.json());

/* ------------------------------------------------------------------ scene */
const cv = $('#cv');
const renderer = new THREE.WebGLRenderer({canvas: cv, antialias: true});
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputEncoding = THREE.sRGBEncoding;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0d1218);
scene.fog = new THREE.Fog(0x0d1218, 60, 160);
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 400);
const controls = new THREE.OrbitControls(camera, cv);
controls.enableDamping = true; controls.dampingFactor = 0.08;

scene.add(new THREE.HemisphereLight(0xcfe6ff, 0x20262e, 0.85));
const sun = new THREE.DirectionalLight(0xffffff, 1.1);
sun.position.set(14, 24, 12); sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
Object.assign(sun.shadow.camera, {left: -22, right: 22, top: 22, bottom: -22, near: 1, far: 80});
scene.add(sun);
const fill = new THREE.DirectionalLight(0x7fb8ff, 0.35); fill.position.set(-12, 8, -10); scene.add(fill);

const M = (color, o = {}) => { const {seg, r2, mat, ...rest} = o; return new THREE.MeshStandardMaterial(Object.assign({color, roughness: 0.55, metalness: 0.1}, rest)); };
const parts = {};          // id -> {group, info, anchor}
const pickables = [];

function box(parent, w, h, d, color, x = 0, y = 0, z = 0, o = {}) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), o.mat || M(color, o));
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
}
function cyl(parent, r, h, color, x = 0, y = 0, z = 0, o = {}) {
  const m = new THREE.Mesh(new THREE.CylinderGeometry(o.r2 ?? r, r, h, o.seg || 28), o.mat || M(color, o));
  m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; parent.add(m); return m;
}
function part(id, name, ref, info, x, y, z, anchorY = 1.2) {
  const g = new THREE.Group(); g.position.set(x, y, z); g.userData = {id, name, ref, info, baseY: y, base: new THREE.Vector3(x, y, z)};
  g.userData.anchor = new THREE.Vector3(0, anchorY, 0);
  parts[id] = g; return g;
}
function pickable(mesh, id) { mesh.userData.part = id; pickables.push(mesh); }

/* ------------------------------------------------------------------ desk */
const desk = new THREE.Mesh(new THREE.BoxGeometry(60, 0.8, 36), M(0x1b232d, {roughness: 0.9}));
desk.position.set(0, -0.5, 0); desk.receiveShadow = true; scene.add(desk);
const mat = new THREE.Mesh(new THREE.BoxGeometry(34, 0.05, 22), M(0x232e3b, {roughness: 0.95}));
mat.position.set(0, -0.08, 0); mat.receiveShadow = true; scene.add(mat);

/* ------------------------------------------------------------------ the device */
const device = new THREE.Group(); scene.add(device);
const Y_HAT = 1.35;

// Raspberry Pi 5
const pi = part('pi', 'Raspberry Pi 5', 'U8', 'Runs the Python stack: OpenCV vision, sensor fusion, mesh, cluster verifier, and the push-to-talk node (Codec2 + I2S audio). Plugs into the HAT through the 40-pin header.', 0, 0.45, 0);
device.add(pi);
box(pi, 8.5, 0.16, 5.6, 0x0b6b3a, 0, 0, 0, {roughness: 0.45});
box(pi, 1.6, 0.35, 1.6, 0xb7bec6, -0.9, 0.25, 0.4, {metalness: 0.8, roughness: 0.3});           // SoC heat spreader
box(pi, 2.2, 1.3, 1.7, 0xc9ced4, 3.5, 0.72, -1.7, {metalness: 0.8, roughness: 0.35});           // Ethernet
box(pi, 1.5, 1.5, 1.5, 0xaab2bb, 3.6, 0.8, 0.4, {metalness: 0.8, roughness: 0.35});             // USB
box(pi, 1.5, 1.5, 1.5, 0x8aa2d6, 3.6, 0.8, 2.0, {metalness: 0.8, roughness: 0.35});             // USB 3
box(pi, 5.2, 0.85, 0.5, 0x15181c, -0.4, 0.5, -2.5);                                              // 40-pin header
for (let i = 0; i < 20; i++) { box(pi, 0.1, 0.5, 0.1, 0xd9b44a, -2.9 + i * 0.27, 1.05, -2.62, {metalness: 1, roughness: 0.25}); box(pi, 0.1, 0.5, 0.1, 0xd9b44a, -2.9 + i * 0.27, 1.05, -2.38, {metalness: 1, roughness: 0.25}); }

// HAT PCB and standoffs
const hat = part('hat', 'RakshaWave HAT (v2v 1.2)', 'PCB', 'Power (USB-C, charger, TPS63001 buck-boost to 3.3 V) plus the ESP32-C3 sensor/radio brain. Schematic: v2v 1.2 .kicad_sch.', 0, 0, 0);
hat.userData.baseY = 0; device.add(hat);
const hatBoard = box(hat, 7.0, 0.16, 5.6, 0x12324a, -0.75, Y_HAT, 0, {roughness: 0.4});
[[-4.0, -2.5], [2.5, -2.5], [-4.0, 2.5], [2.5, 2.5]].forEach(([x, z]) => cyl(hat, 0.15, 1.2, 0xd9b44a, x, Y_HAT - 0.7, z, {metalness: 1, roughness: 0.3, seg: 12}));
const T = Y_HAT + 0.08;   // top of the HAT

// ESP32-C3 DevKitM-1
const esp = part('esp', 'ESP32-C3-DevKitM-1', 'U4', 'RISC-V microcontroller board running the real firmware (here: inside the Wokwi simulator). Reads the MPU6050 and GPS, drives the buzzer, LED and OLED, and is the LoRa modem for hazard alerts and push-to-talk.', -1.7, T, -1.3);
hat.add(esp);
box(esp, 5.1, 0.12, 2.5, 0x1c1f26, 0, 0.06, 0, {roughness: 0.35});
box(esp, 1.9, 0.28, 1.5, 0xc7ccd2, -1.3, 0.2, 0, {metalness: 0.85, roughness: 0.3});
box(esp, 0.9, 0.04, 1.1, 0x3d3320, -2.3, 0.14, 0);
box(esp, 4.7, 0.25, 0.22, 0x101215, 0.3, 0.2, -1.05); box(esp, 4.7, 0.25, 0.22, 0x101215, 0.3, 0.2, 1.05);
box(esp, 0.8, 0.3, 0.8, 0xc7ccd2, 2.35, 0.22, 0, {metalness: 0.8, roughness: 0.3});
const espLed = box(esp, 0.18, 0.08, 0.18, 0x3ccf7e, 1.0, 0.16, 0.3, {emissive: 0x3ccf7e, emissiveIntensity: 1.2});
esp.userData.anchor.set(0, 0.7, 0);

// LoRa Ra-01 + antenna
const lora = part('lora', 'Ai-Thinker Ra-01 (SX1278)', 'U1', 'LoRa 433 MHz radio on SPI (SCK IO18, MISO IO19, MOSI IO7, NSS IO4, RST IO0, DIO0 IO8). Carries hazard alerts and push-to-talk voice frames.', 1.5, T, -1.3);
hat.add(lora);
box(lora, 1.7, 0.16, 1.6, 0x0d2a44, 0, 0.08, 0);
box(lora, 1.2, 0.25, 1.1, 0xc7ccd2, 0, 0.26, 0, {metalness: 0.85, roughness: 0.3});
const sma = cyl(lora, 0.28, 0.5, 0xd9b44a, 0.5, 0.3, -1.0, {metalness: 1, roughness: 0.25, seg: 6});
const antenna = cyl(lora, 0.13, 3.4, 0xf2f4f7, 0.5, 2.2, -1.0, {roughness: 0.4});
const antTip = new THREE.Object3D(); antTip.position.set(0.5, 3.9, -1.0); lora.add(antTip);
lora.userData.anchor.set(0.5, 4.2, -1.0);

// GPS
const gps = part('gps', 'GPS module (RXM-GPS-FM)', 'U2', 'NMEA over UART at 9600 baud: GPS TX to IO2, GPS RX from IO1. In the simulation a custom chip sends GGA and RMC for Pune (8 satellites, HDOP 1.1).', 1.9, T, 1.0);
hat.add(gps);
box(gps, 1.7, 0.14, 1.7, 0x161a1f, 0, 0.07, 0);
box(gps, 1.25, 0.4, 1.25, 0xd8c79b, 0, 0.34, 0, {roughness: 0.6});
box(gps, 1.1, 0.05, 1.1, 0xb59a5b, 0, 0.56, 0, {metalness: 0.7, roughness: 0.4});
const gpsLed = box(gps, 0.16, 0.08, 0.16, 0x3ccf7e, 0.65, 0.16, -0.65, {emissive: 0x3ccf7e, emissiveIntensity: 1});

// MPU6050
const imu = part('imu', 'MPU-6050 IMU', 'U3', 'Accelerometer and gyro on I2C 0x68 (SDA IO5, SCL IO6). The firmware raises an alert when |magnitude - 1 g| is 1.8 g or more. AD0, FSYNC and CLKIN are tied to ground; REGOUT and CPOUT have their capacitors.', -3.3, T, 2.0);
hat.add(imu);
box(imu, 2.0, 0.12, 1.6, 0x4a2c82, 0, 0.06, 0, {roughness: 0.4});
box(imu, 0.5, 0.12, 0.5, 0x101215, 0, 0.18, 0);
imu.userData.axes = new THREE.Group(); imu.add(imu.userData.axes);
const arrow = new THREE.ArrowHelper(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0.3, 0), 1.2, 0xffd166, 0.35, 0.22);
imu.userData.axes.add(arrow);

// OLED
const oled = part('oled', 'SSD1306 OLED 0.91"', 'U5', 'I2C 0x3C. Shows the hazard type on alerts and "VOICE TX / VOICE RX" for push-to-talk. The picture on this screen is the real screenshot from the simulator.', -1.9, T, 0.5);
hat.add(oled);
box(oled, 3.0, 0.12, 1.15, 0x101418, 0, 0.06, 0);
const oledCanvas = document.createElement('canvas'); oledCanvas.width = 128; oledCanvas.height = 32;
const octx = oledCanvas.getContext('2d'); octx.fillStyle = '#000'; octx.fillRect(0, 0, 128, 32);
octx.fillStyle = '#7fe0ff'; octx.font = '10px monospace'; octx.fillText('simulation off', 6, 18);
const oledTex = new THREE.CanvasTexture(oledCanvas); oledTex.magFilter = THREE.NearestFilter; oledTex.minFilter = THREE.NearestFilter; oledTex.encoding = THREE.sRGBEncoding;
const oledScreen = new THREE.Mesh(new THREE.PlaneGeometry(2.56, 0.64), new THREE.MeshBasicMaterial({map: oledTex}));
oledScreen.rotation.x = -Math.PI / 2; oledScreen.position.set(0, 0.125, 0); oled.add(oledScreen);

// Buzzer
const buzzer = part('buzzer', 'Buzzer', 'BZ1', 'Active buzzer on IO9, switched to ground (active low). Sounds on every hazard alert, sent or heard, but never for voice frames.', -1.6, T, 2.0);
hat.add(buzzer);
cyl(buzzer, 0.62, 0.8, 0x17191d, 0, 0.4, 0, {roughness: 0.4});
cyl(buzzer, 0.12, 0.02, 0x000000, 0, 0.81, 0, {seg: 12});
buzzer.userData.anchor.set(0, 1.3, 0);

// LED
const ledPart = part('led', 'Red LED + 330 R', 'D1 / R5', 'IO10 sinks current through the LED (active low); the anode goes to +3.3 V through R5 = 330 ohm. Lit together with the buzzer on hazard alerts.', -0.4, T, 2.0);
hat.add(ledPart);
cyl(ledPart, 0.28, 0.14, 0x7a1d1d, 0, 0.07, 0);
const ledDomeMat = new THREE.MeshStandardMaterial({color: 0x6a0f10, emissive: 0xff2a2a, emissiveIntensity: 0.05, roughness: 0.2, transparent: true, opacity: 0.92});
const ledDome = new THREE.Mesh(new THREE.SphereGeometry(0.26, 24, 16, 0, Math.PI * 2, 0, Math.PI / 2), ledDomeMat); ledDome.position.y = 0.14; ledPart.add(ledDome);
const ledLight = new THREE.PointLight(0xff3030, 0, 9); ledLight.position.set(0, 0.7, 0); ledPart.add(ledLight);
ledPart.userData.anchor.set(0, 0.9, 0);

// PTT button
const ptt = part('ptt', 'Push-to-talk button', 'SW1', 'Hold to talk. Wired from Pi GPIO17 to ground (software pull-up). Audio from the microphone is encoded with Codec2 700C and sent to the ESP32 as VoicePacket lines.', 0.6, T, 0.8);
hat.add(ptt);
box(ptt, 1.3, 0.28, 1.3, 0x1b1d22, 0, 0.14, 0);
const pttCap = cyl(ptt, 0.46, 0.32, 0xd93a3a, 0, 0.42, 0, {roughness: 0.3});
pickable(pttCap, 'ptt');
ptt.userData.anchor.set(0, 1.1, 0);

// I2S mic + amp modules
const mic = part('mic', 'I2S MEMS microphone (INMP441 type)', 'J3', 'I2S mic on the Pi header: BCLK GPIO18, WS GPIO19, data GPIO20, 3.3 V, L/R tied to ground.', 0.9, T, 2.15, 1.0);
hat.add(mic);
box(mic, 1.3, 0.1, 0.9, 0x1b3a8c, 0, 0.05, 0);
cyl(mic, 0.22, 0.12, 0xc7ccd2, 0, 0.16, 0, {metalness: 0.9, roughness: 0.3});
const micGlow = new THREE.Mesh(new THREE.SphereGeometry(0.14, 12, 8), new THREE.MeshBasicMaterial({color: 0x3cb4d6, transparent: true, opacity: 0})); micGlow.position.y = 0.3; mic.add(micGlow);
const amp = part('amp', 'I2S amplifier (MAX98357A type)', 'J4', 'Class-D amplifier on the same I2S bus: BCLK GPIO18, LRC GPIO19, data in GPIO21, 5 V from the Pi. Drives the speaker.', 2.2, T, 2.05, 1.0);
hat.add(amp);
box(amp, 1.5, 0.1, 1.0, 0x8a1f6b, 0, 0.05, 0);
box(amp, 0.5, 0.12, 0.5, 0x101215, 0, 0.16, 0);

// power: USB-C, TPS63001, inductor
const usb = part('usbc', 'USB-C power', 'J2', 'USB-C power input with 5.1 k CC resistors; feeds the MCP73123 charger.', 2.65, T, -2.45);
hat.add(usb);
box(usb, 0.95, 0.38, 0.95, 0xc9ced4, 0, 0.19, 0, {metalness: 0.85, roughness: 0.3});
const tps = part('tps', 'TPS63001 buck-boost + L1', 'U7 / L1', 'Battery (3.0-4.2 V) to a fixed 3.3 V rail. Simulated in ngspice: the rail dips about 31 mV on a 155 mA LoRa + buzzer step.', 2.45, T, -0.35);
hat.add(tps);
box(tps, 0.55, 0.14, 0.55, 0x101215, 0, 0.07, 0); box(tps, 0.7, 0.42, 0.7, 0x2a2d33, -0.1, 0.21, 0.75, {roughness: 0.6});

// battery on the desk with a cable to the HAT
const battery = part('battery', 'Li-ion cell', 'J1', 'Single Li-ion/LiFePO4 cell on J1 (BAT+). The HAT charges it from USB-C.', -9.5, 0.4, 0.5, 1.4);
box(battery, 4.2, 0.7, 5.2, 0x1d4ed8, 0, 0, 0, {roughness: 0.55}); box(battery, 4.2, 0.72, 1.0, 0xdde3ea, 0, 0, 2.1, {roughness: 0.5});
scene.add(battery);
const cable = (a, b, color) => {
  const mid = a.clone().lerp(b, 0.5); mid.y += 1.4;
  const m = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3([a, mid, b]), 24, 0.07, 8), M(color, {roughness: 0.6}));
  m.castShadow = true; scene.add(m);
};
cable(new THREE.Vector3(-7.4, 0.5, 0.5), new THREE.Vector3(-4.1, T + 0.2, 0.2), 0xd33);

// speaker on the desk, listener side
const speaker = part('speaker', 'Speaker (listening vehicle)', 'LS', 'What the second vehicle plays after the radio link: loss, re-ordering and concealment included.', 11.5, 0.9, 1.5, 2.4);
cyl(speaker, 1.9, 1.7, 0x15181c, 0, 0, 0, {roughness: 0.5});
const cone = cyl(speaker, 1.5, 0.15, 0x2b3038, 0, 0.88, 0, {r2: 0.55, seg: 40, roughness: 0.8}); cone.rotation.x = 0;
const speakerRing = new THREE.Mesh(new THREE.TorusGeometry(1.7, 0.08, 8, 40), new THREE.MeshBasicMaterial({color: 0x3ccf7e, transparent: true, opacity: 0}));
speakerRing.rotation.x = Math.PI / 2; speakerRing.position.y = 0.9; speaker.add(speakerRing);
scene.add(speaker);
const remoteTag = makeSprite('VEH-REMOTE', '#3ccf7e'); remoteTag.position.set(11.5, 3.8, 1.5); scene.add(remoteTag);
cable(new THREE.Vector3(9.6, 0.4, 1.5), new THREE.Vector3(4.6, 0.5, 2.0), 0x888);

// register parts and mesh picking
Object.values(parts).forEach(g => {
  g.traverse(o => { if (o.isMesh && !o.userData.part) { o.userData.part = g.userData.id; pickables.push(o); } });
});
device.userData.homeY = 0;

/* ------------------------------------------------------------------ road diorama (z = 60) */
const road = new THREE.Group(); road.position.set(0, 0, 60); scene.add(road);
const asphalt = new THREE.Mesh(new THREE.BoxGeometry(70, 0.3, 11), M(0x2a2f36, {roughness: 0.95})); asphalt.position.y = -0.15; asphalt.receiveShadow = true; road.add(asphalt);
const grass = new THREE.Mesh(new THREE.BoxGeometry(70, 0.2, 30), M(0x1c3a2a, {roughness: 1})); grass.position.set(0, -0.3, 0); grass.receiveShadow = true; road.add(grass);
for (let x = -32; x < 33; x += 5) box(road, 2.4, 0.02, 0.2, 0xe8e8e8, x, 0.02, 0);
const pothole = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.2, 0.2, 32), M(0x07090c, {roughness: 1})); pothole.position.set(3, 0.0, -1.5); road.add(pothole);
const potholeRim = new THREE.Mesh(new THREE.TorusGeometry(1.55, 0.1, 8, 36), M(0x444a52, {roughness: 1})); potholeRim.rotation.x = Math.PI / 2; potholeRim.position.set(3, 0.05, -1.5); road.add(potholeRim);

function buildCar(color) {
  const g = new THREE.Group();
  box(g, 4.6, 0.9, 2.1, color, 0, 0.9, 0, {roughness: 0.35, metalness: 0.4});
  box(g, 2.4, 0.8, 1.9, 0x9fb7cc, -0.2, 1.7, 0, {roughness: 0.15, metalness: 0.3, transparent: true, opacity: 0.75});
  [[-1.5, -1.1], [1.5, -1.1], [-1.5, 1.1], [1.5, 1.1]].forEach(([x, z]) => { const w = cyl(g, 0.45, 0.35, 0x111111, x, 0.45, z, {roughness: 0.9}); w.rotation.x = Math.PI / 2; });
  return g;
}
const car = buildCar(0x2f7bd6); car.position.set(-26, 0, 1.5); road.add(car);
const dash = new THREE.Group(); dash.position.set(0.4, 2.15, 0); car.add(dash);
box(dash, 0.9, 0.25, 0.6, 0x12324a, 0, 0, 0);
const carLedMat = new THREE.MeshStandardMaterial({color: 0x6a0f10, emissive: 0xff2a2a, emissiveIntensity: 0.05});
const carLed = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), carLedMat); carLed.position.set(0, 0.2, 0.15); dash.add(carLed);
cyl(dash, 0.04, 0.8, 0xf2f4f7, -0.3, 0.45, -0.2);
const carLight = new THREE.PointLight(0xff3030, 0, 12); carLight.position.set(0, 1, 0); dash.add(carLight);
const car2 = buildCar(0xd6a02f); car2.position.set(-38, 0, 1.5); road.add(car2);
const car2Mark = makeSprite('VEH-002', '#e5a63c'); car2Mark.position.set(0, 3.6, 0); car2.add(car2Mark);
car2.visible = false;
const clusterRing = new THREE.Mesh(new THREE.TorusGeometry(2.3, 0.08, 8, 48), new THREE.MeshBasicMaterial({color: 0xe5a63c, transparent: true, opacity: 0}));
clusterRing.rotation.x = Math.PI / 2; clusterRing.position.set(3, 0.1, -1.5); road.add(clusterRing);
let clusterTag = makeSprite('no hazard yet', '#8b9aab'); clusterTag.position.set(3, 4.6, -1.5); road.add(clusterTag);

function makeSprite(text, color) {
  const c = document.createElement('canvas'); c.width = 512; c.height = 96;
  const g = c.getContext('2d'); g.fillStyle = '#000a'; g.strokeStyle = color; g.lineWidth = 4;
  g.beginPath(); g.roundRect ? g.roundRect(6, 6, 500, 84, 18) : g.rect(6, 6, 500, 84); g.fill(); g.stroke();
  g.fillStyle = '#fff'; g.font = 'bold 30px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 256, 50);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({map: new THREE.CanvasTexture(c), transparent: true, depthTest: false}));
  s.scale.set(6.4, 1.2, 1); s.userData = {text, color}; return s;
}
function setSprite(sp, text, color) {
  if (sp.userData.text === text && sp.userData.color === color) return;
  const n = makeSprite(text, color); sp.material.map.dispose(); sp.material.map = n.material.map; sp.userData = {text, color};
}

/* ------------------------------------------------------------------ waves, rings */
const fx = [];
function wave(origin, color, parentSpace = scene, maxR = 14, life = 1.6) {
  const m = new THREE.Mesh(new THREE.SphereGeometry(1, 28, 16), new THREE.MeshBasicMaterial({color, transparent: true, opacity: 0.35, wireframe: true, depthWrite: false}));
  const p = new THREE.Vector3(); origin.getWorldPosition(p); m.position.copy(p); scene.add(m); fx.push({m, t: 0, life, maxR});
}
function ring(obj, color, life = 1.0, r0 = 0.7, r1 = 3) {
  const m = new THREE.Mesh(new THREE.TorusGeometry(1, 0.03, 6, 40), new THREE.MeshBasicMaterial({color, transparent: true, opacity: 0.8}));
  const p = new THREE.Vector3(); obj.getWorldPosition(p); m.position.copy(p); m.position.y += 0.9; m.rotation.x = Math.PI / 2; scene.add(m); fx.push({m, t: 0, life, ring: true, r0, r1});
}
function stepFx(dt) {
  for (let i = fx.length - 1; i >= 0; i--) {
    const f = fx[i]; f.t += dt; const k = f.t / f.life;
    if (k >= 1) { scene.remove(f.m); f.m.geometry.dispose(); f.m.material.dispose(); fx.splice(i, 1); continue; }
    if (f.ring) f.m.scale.setScalar(f.r0 + (f.r1 - f.r0) * k); else f.m.scale.setScalar(0.6 + f.maxR * k);
    f.m.material.opacity = (f.ring ? 0.8 : 0.35) * (1 - k);
  }
}

/* ------------------------------------------------------------------ camera presets */
const views = {
  device: {pos: [6.5, 8.2, 10.5], target: [-0.6, 1.6, 0.2]},
  top: {pos: [-0.8, 24, 3], target: [-0.8, 0, 0.3]},
  road: {pos: [-6, 15, 84], target: [-2, 0.5, 60]},
};
let camAnim = null;
function setView(name) {
  if (name === 'orbit') return;
  const v = views[name]; camAnim = {t: 0, fromP: camera.position.clone(), fromT: controls.target.clone(), toP: new THREE.Vector3(...v.pos), toT: new THREE.Vector3(...v.target)};
  document.querySelectorAll('#views button').forEach(b => b.style.opacity = b.dataset.view === name ? 1 : 0.6);
}
document.querySelectorAll('#views button').forEach(b => b.onclick = () => setView(b.dataset.view));
camera.position.set(...views.device.pos); controls.target.set(...views.device.target);

function resize() {
  const r = $('#stage').getBoundingClientRect(); renderer.setSize(r.width, r.height, false);
  camera.aspect = r.width / Math.max(r.height, 1); camera.updateProjectionMatrix();
}
addEventListener('resize', resize); new ResizeObserver(resize).observe($('#stage')); resize();

/* ------------------------------------------------------------------ labels, picking */
const labelBox = $('#labels'), labelEls = {};
['esp', 'lora', 'gps', 'imu', 'oled', 'buzzer', 'led', 'ptt', 'mic', 'amp', 'usbc', 'tps', 'pi', 'battery', 'speaker'].forEach(id => {
  const d = document.createElement('div'); d.className = 'lbl'; d.textContent = parts[id].userData.name.replace(/ \(.*$/, '').replace('Raspberry Pi 5', 'Pi 5'); labelBox.appendChild(d); labelEls[id] = d;
});
const tmp = new THREE.Vector3();
function updateLabels() {
  const show = $('#showLabels').checked, r = $('#stage').getBoundingClientRect();
  for (const id in labelEls) {
    const g = parts[id], el = labelEls[id];
    const near = (id === 'battery' || id === 'speaker') ? true : camera.position.z < 40;
    if (!show || !near) { el.style.display = 'none'; continue; }
    tmp.copy(g.userData.anchor); g.localToWorld(tmp); tmp.project(camera);
    if (tmp.z > 1) { el.style.display = 'none'; continue; }
    el.style.display = ''; el.style.left = ((tmp.x * 0.5 + 0.5) * r.width) + 'px'; el.style.top = ((-tmp.y * 0.5 + 0.5) * r.height) + 'px';
  }
}
const ray = new THREE.Raycaster(), ptr = new THREE.Vector2();
let selected = null, pttHeldByCanvas = false;
function pickAt(e) {
  const r = cv.getBoundingClientRect(); ptr.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ptr, camera); const hit = ray.intersectObjects(pickables, false)[0]; return hit ? hit.object.userData.part : null;
}
cv.addEventListener('pointerdown', e => {
  const id = pickAt(e);
  if (id === 'ptt' && !$('#ptt').disabled) { controls.enabled = false; pttHeldByCanvas = true; pttDown(); e.preventDefault(); }
});
addEventListener('pointerup', () => { if (pttHeldByCanvas) { pttHeldByCanvas = false; controls.enabled = true; pttUp(); } });
cv.addEventListener('pointermove', e => {
  const tip = $('#tip'), id = pickAt(e);
  if (!id) { tip.style.display = 'none'; cv.style.cursor = 'default'; return; }
  const r = $('#stage').getBoundingClientRect(); tip.textContent = parts[id].userData.name + ' (' + parts[id].userData.ref + ')';
  tip.style.display = 'block'; tip.style.left = (e.clientX - r.left + 12) + 'px'; tip.style.top = (e.clientY - r.top + 12) + 'px'; cv.style.cursor = id === 'ptt' ? 'pointer' : 'help';
});
let downAt = null;
cv.addEventListener('pointerdown', e => downAt = [e.clientX, e.clientY]);
cv.addEventListener('pointerup', e => {
  if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
  const id = pickAt(e); selected = id; const p = $('#pick');
  if (!id) { p.style.display = 'none'; return; }
  const u = parts[id].userData; p.style.display = 'block'; p.innerHTML = `<b>${u.name}</b> <span style="color:#8b9aab">${u.ref}</span><br>${u.info}`;
});

/* ------------------------------------------------------------------ live state */
let live = {running: false}, lastOledSeq = -1, seenEvent = 0, jolt = 0, pttOn = false, glow = {led: 0, buzz: 0};
const oled2d = $('#oled2d').getContext('2d'); oled2d.imageSmoothingEnabled = false;
let audioCtx = null, audioNext = 0, audioSince = 0;

function drawOled(b64) {
  const img = new Image();
  img.onload = () => {
    octx.imageSmoothingEnabled = false; octx.clearRect(0, 0, 128, 32); octx.drawImage(img, 0, 0, 128, 32); oledTex.needsUpdate = true;
    oled2d.clearRect(0, 0, 128, 64); oled2d.drawImage(img, 0, 0, 128, 64);
  };
  img.src = 'data:image/png;base64,' + b64;
}
function applyState(s) {
  live = s;
  const link = $('#link');
  link.className = 'pill ' + (s.running ? 'on' : s.starting ? 'warn' : 'off'); link.textContent = s.running ? 'live: real firmware in Wokwi' : s.starting ? 'starting simulation…' : 'simulation off';
  $('#clock').textContent = s.running ? `sim time ${(s.nanos / 1e9).toFixed(1)} s` : '';
  $('#err').textContent = s.error || '';
  const run = s.running;
  ['stop', 'hit', 'peer', 'accel', 'piAlert', 'ptt'].forEach(id => $('#' + id).disabled = !run);
  $('#start').disabled = run || s.starting;
  $('#tLed').textContent = s.led_on ? 'ON (pin low)' : 'off'; $('#tLed').className = s.led_on ? 'on' : 'off';
  $('#tBz').textContent = s.buzzer_on ? 'ON (pin low)' : 'off'; $('#tBz').className = s.buzzer_on ? 'on' : 'off';
  $('#tNanos').textContent = run ? (s.nanos / 1e9).toFixed(1) + ' s' : '-';
  const pk = s.packets[s.packets.length - 1];
  $('#tPkt').textContent = pk ? `${pk.hz}, conf ${pk.c.toFixed(2)}, ${pk.lat.toFixed(4)}N ${pk.lon.toFixed(4)}E, ${pk.spd.toFixed(1)} km/h` : 'none yet';
  const m = s.mesh;
  $('#tFuse').textContent = m && m.fused != null ? `fused ${m.fused} ${m.verified ? '(verified)' : '(rejected)'}` : m && m.error ? m.error : '-';
  const cl = m && m.clusters && m.clusters[0];
  $('#tCl').textContent = cl ? `${cl.cluster_id}: ${cl.corroborating_vehicles.length} vehicle(s), ${cl.escalated ? 'ESCALATED' : 'unverified'}${m.emergencies.length ? ', EMERGENCY' : ''}` : '-';
  $('#serial').textContent = s.serial.slice(-30).join('\n') || '-'; $('#serial').scrollTop = 1e6;
  if (s.oled_png) { drawOled(s.oled_png); }
  lastOledSeq = s.oled_seq;
  setSprite(clusterTag, cl ? (cl.escalated ? `${cl.cluster_id}: ${cl.corroborating_vehicles.length} vehicles, VERIFIED` : `${cl.cluster_id}: 1 vehicle, unverified`) : 'no hazard yet', cl ? (cl.escalated ? '#ff6b72' : '#e5a63c') : '#8b9aab');
  clusterRing.userData.level = cl ? (cl.escalated ? 2 : 1) : 0;
  car2.visible = !!(cl && cl.corroborating_vehicles.length > 1);
  pttOn = !!s.ptt; $('#ptt').classList.toggle('live', pttOn);
  s.events.filter(e => e.id > seenEvent).forEach(e => {
    seenEvent = Math.max(seenEvent, e.id);
    if (e.kind === 'hazard_tx') { wave(antTip, 0xffb454); wave(carLed, 0xffb454, scene, 18, 2.2); }
    if (e.kind === 'voice_tx') { wave(antTip, 0x3cb4d6, scene, 10, 1.1); }
  });
}
let polling = false;
async function tick() {
  if (polling) return; polling = true;
  try { applyState(await api('/api/twin/state?oled=' + lastOledSeq)); } catch (e) { /* server restarting */ }
  polling = false;
}
setInterval(tick, 300); tick();

/* ------------------------------------------------------------------ listener audio */
async function pullAudio() {
  if (!live.running && !pttOn) return;
  try {
    const r = await api('/api/twin/audio?since=' + audioSince); audioSince = r.next;
    if (!audioCtx || $('#mute').checked) { if (r.chunks.length) speakerPulse = 1; return; }
    r.chunks.forEach(b => {
      const raw = atob(b), u = new Uint8Array(raw.length); for (let i = 0; i < raw.length; i++) u[i] = raw.charCodeAt(i);
      const pcm = new Int16Array(u.buffer), f = new Float32Array(pcm.length); for (let i = 0; i < pcm.length; i++) f[i] = pcm[i] / 32768;
      const buf = audioCtx.createBuffer(1, f.length, r.rate); buf.copyToChannel(f, 0);
      const src = audioCtx.createBufferSource(); src.buffer = buf; src.connect(audioCtx.destination);
      const t = Math.max(audioCtx.currentTime + 0.05, audioNext); src.start(t); audioNext = t + buf.duration; speakerPulse = Math.max(speakerPulse, 1);
    });
  } catch (e) { /* ignore */ }
}
let speakerPulse = 0;
setInterval(pullAudio, 350);

/* ------------------------------------------------------------------ controls */
$('#start').onclick = async () => {
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume();
  $('#err').textContent = ''; audioSince = 0; seenEvent = 0;
  const r = await api('/api/twin/start', {token: $('#token').value}); if (r.ok === false) $('#err').textContent = r.error;
};
$('#stop').onclick = () => api('/api/twin/stop', {});
let carRun = null;
function doHit(run) { if (!run || run.hit) return; run.hit = true; jolt = 1; api('/api/twin/hit', {g: 3.0}); }
$('#hit').onclick = () => {
  const run = {t: 0, hit: false}; carRun = run; car.position.x = -26; setView('road');
  setTimeout(() => doHit(run), 2900);   // timer as well as the frame loop: a hidden tab does not run animation frames
};
$('#peer').onclick = async () => { await api('/api/twin/peer', {}); };
let accelBusy = false;
$('#accel').oninput = async e => {
  $('#gVal').textContent = (+e.target.value).toFixed(1); if (accelBusy) return; accelBusy = true;
  await api('/api/twin/accel', {value: +e.target.value}); accelBusy = false;
};
$('#piAlert').onclick = () => api('/api/twin/serial', {text: JSON.stringify({id: 'pi-' + Date.now(), t: 'HAZARD_ALERT', veh: 'VEH-PI-01', hz: 'debris', c: 0.9, lat: 18.5204, lon: 73.8567, spd: 30, hop: 0, mh: 5, ttl: 30, oid: null, ts: 1}) + '\n'});
$('#dist').oninput = e => { $('#dVal').textContent = e.target.value; api('/api/twin/remote', {distance: +e.target.value}); };
$('#explode').oninput = () => {};

/* push to talk */
let micRec = null;
async function startMic() {
  const stream = await navigator.mediaDevices.getUserMedia({audio: {echoCancellation: false, noiseSuppression: false}});
  const ctx = new AudioContext(), src = ctx.createMediaStreamSource(stream), proc = ctx.createScriptProcessor(4096, 1, 1); let acc = [], t0 = performance.now();
  proc.onaudioprocess = e => {
    acc.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    if (performance.now() - t0 > 250) {
      const n = acc.reduce((a, c) => a + c.length, 0), all = new Float32Array(n); let o = 0; acc.forEach(c => { all.set(c, o); o += c.length; }); acc = []; t0 = performance.now();
      const out = new Int16Array(Math.floor(n * 8000 / ctx.sampleRate)), r = ctx.sampleRate / 8000;
      for (let i = 0; i < out.length; i++) { let a = Math.floor(i * r), b = Math.max(a + 1, Math.floor((i + 1) * r)), s = 0; for (let k = a; k < b && k < n; k++) s += all[k]; out[i] = Math.max(-1, Math.min(1, s / (b - a))) * 32767; }
      const u8 = new Uint8Array(out.buffer); let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
      api('/api/twin/ptt_audio', {pcm: btoa(s)});
    }
  };
  src.connect(proc); proc.connect(ctx.destination); micRec = {stream, ctx, proc, src};
}
function stopMic() { if (!micRec) return; micRec.proc.disconnect(); micRec.src.disconnect(); micRec.stream.getTracks().forEach(t => t.stop()); micRec.ctx.close(); micRec = null; }
let pttActive = false;
async function pttDown() {
  if (pttActive || !live.running) return; pttActive = true;
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)(); audioCtx.resume();
  let source = 'synth';
  if ($('#useMic').checked) { try { await startMic(); source = 'mic'; } catch (e) { $('#pttInfo').textContent = 'microphone unavailable, using test speech'; } }
  const r = await api('/api/twin/ptt', {press: true, source}); $('#pttInfo').textContent = r.ok === false ? r.error : 'transmitting ' + (source === 'mic' ? 'your microphone' : 'test speech');
}
async function pttUp() {
  if (!pttActive) return; pttActive = false; stopMic();
  await api('/api/twin/ptt', {press: false}); $('#pttInfo').textContent = 'released; the listener hears it after the radio link';
}
const pb = $('#ptt');
pb.addEventListener('pointerdown', e => { pb.setPointerCapture(e.pointerId); pttDown(); });
pb.addEventListener('pointerup', pttUp); pb.addEventListener('pointercancel', pttUp);
addEventListener('keydown', e => { if (e.code === 'Space' && !e.repeat && !/INPUT|TEXTAREA/.test(document.activeElement.tagName)) { e.preventDefault(); pttDown(); } });
addEventListener('keyup', e => { if (e.code === 'Space') pttUp(); });

/* ------------------------------------------------------------------ animation loop */
const clock = new THREE.Clock(); let last = 0;
function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05), t = clock.elapsedTime;
  if (camAnim) { camAnim.t = Math.min(1, camAnim.t + dt / 1.1); const k = camAnim.t * camAnim.t * (3 - 2 * camAnim.t);
    camera.position.lerpVectors(camAnim.fromP, camAnim.toP, k); controls.target.lerpVectors(camAnim.fromT, camAnim.toT, k); if (camAnim.t >= 1) camAnim = null; }
  controls.update();

  // exploded view
  const ex = +$('#explode').value;
  hat.position.y = ex * 5.5; pi.position.y = pi.userData.base.y - ex * 1.2;
  [[esp, 1.4], [lora, 1.6], [gps, 1.2], [imu, 1.0], [oled, 1.5], [buzzer, 1.1], [ledPart, 1.1], [ptt, 1.3], [mic, 1.4], [amp, 1.4], [usb, 0.9], [tps, 0.8]].forEach(([g, k]) => { g.position.y = g.userData.base.y + ex * k * 3.2; });

  // real LED / buzzer
  glow.led += ((live.led_on ? 1 : 0) - glow.led) * Math.min(1, dt * 18);
  ledDomeMat.emissiveIntensity = 0.05 + glow.led * 3.2; ledLight.intensity = glow.led * 3.2;
  carLedMat.emissiveIntensity = 0.05 + glow.led * 3.2; carLight.intensity = glow.led * 5;
  espLed.material.emissiveIntensity = live.running ? 0.8 + 0.5 * Math.sin(t * 6) : 0.05;
  gpsLed.material.emissiveIntensity = live.running ? 0.6 + 0.6 * (Math.sin(t * 2) > 0 ? 1 : 0) : 0.05;
  if (live.buzzer_on) { glow.buzz += dt; if (glow.buzz > 0.28) { glow.buzz = 0; ring(buzzer, 0xffd166, 0.9, 0.6, 3.2); } buzzer.rotation.z = Math.sin(t * 90) * 0.02; } else { glow.buzz = 0.28; buzzer.rotation.z = 0; }

  // IMU arrow follows the real accelZ
  const g = live.accel_z ?? 1; arrow.setLength(0.3 + g * 0.9, 0.35, 0.22); arrow.setColor(g >= 2.8 ? 0xff6b72 : 0xffd166);

  // PTT: button press, mic glow, waves
  pttCap.position.y = pttOn ? 0.3 : 0.42;
  micGlow.material.opacity = pttOn ? 0.5 + 0.5 * Math.sin(t * 20) : 0; if (pttOn && Math.floor(t * 4) !== Math.floor((t - dt) * 4)) ring(mic, 0x3cb4d6, 0.9, 0.3, 1.8);
  speakerPulse = Math.max(0, speakerPulse - dt * 1.6); speakerRing.material.opacity = speakerPulse * 0.8; speakerRing.scale.setScalar(1 + (1 - speakerPulse) * 0.25); cone.position.y = 0.88 + Math.sin(t * 60) * 0.03 * speakerPulse;

  // jolt (pothole)
  if (jolt > 0) { jolt = Math.max(0, jolt - dt * 2.6); device.position.y = Math.sin(jolt * 14) * jolt * 0.45; } else device.position.y = 0;

  // road: the car drives over the pothole, then the real accelZ spike is injected
  if (carRun) {
    carRun.t += dt; car.position.x = -26 + carRun.t * 10.5; car.position.y = 0;
    const dx = car.position.x - 3.4; if (Math.abs(dx) < 2) { car.position.y = Math.sin((dx + 2) / 4 * Math.PI) * 0.35; car.rotation.z = Math.sin(dx * 1.6) * 0.06; if (dx > -0.5) doHit(carRun); } else car.rotation.z = 0;
    if (car.position.x > 24) { carRun = null; car.position.x = -26; }
  }
  const lvl = clusterRing.userData.level || 0; clusterRing.material.opacity = lvl ? 0.55 + 0.35 * Math.sin(t * 4) : 0; clusterRing.material.color.set(lvl === 2 ? 0xff6b72 : 0xe5a63c);
  if (car2.visible) car2.position.x = Math.min(-1.5, car2.position.x + dt * 9) ; else car2.position.x = -38;

  stepFx(dt); updateLabels(); renderer.render(scene, camera);
}
animate();
window.__twin = {scene, camera, controls, parts, setView, views, render: () => { controls.update(); updateLabels(); renderer.render(scene, camera); }};
})();
