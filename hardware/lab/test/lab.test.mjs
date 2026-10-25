// Headless tests of the hardware lab: the real firmware (firmware.wasm) on
// emulated boards. Run:  node --test hardware/lab/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../web/js/sim/world.js';
import { timeOnAir, twoRayLossDb, noiseFloorDbm } from '../web/js/sim/channel.js';
import { Road, Vehicle } from '../web/js/sim/vehicle.js';
import { MPU6050 } from '../web/js/sim/mpu6050.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const module = await WebAssembly.compile(fs.readFileSync(path.join(here, '../web/firmware.wasm')));

async function lab(nodes, opts = {}) {
  const w = new World(opts);
  if (opts.env) w.channel.setEnvironment(opts.env);
  for (const n of nodes) await w.addDevice(module, n);
  return w;
}
function run(w, until) {
  while (w.t < until - 1e-9) w.runUntil(Math.min(until, w.t + 0.05), 1e9);
}
const lines = d => d.console.map(c => c.text);
const has = (d, s) => lines(d).some(l => l.includes(s));
const json = d => lines(d).filter(l => l.startsWith('{')).map(l => JSON.parse(l));

test('Semtech time on air and the link budget constants', () => {
  assert.equal(timeOnAir({ sf: 7, bw: 125e3, cr: 1, preamble: 8, crc: true }, 242).total.toFixed(4), '0.3791');
  assert.equal(Math.round(noiseFloorDbm(125e3)), -116);
  // beyond the crossover distance, two-ray tends to 40 log d - 20 log(ht hr)
  const d = 3000, ht = 1.1;
  assert.ok(Math.abs(twoRayLossDb(d, ht, ht, 433e6) - (40 * Math.log10(d) - 20 * Math.log10(ht * ht))) < 2.5);
});

test('boards boot the real firmware and take their ID from the MAC', async () => {
  const w = await lab([{ x: 1000 }, { x: 1300, lane: 1 }]);
  run(w, 2);
  for (const d of w.devices) {
    for (const s of ['OLED ok', 'MPU6050 ok', 'LoRa ok', 'RakshaWave node online. id=' + d.firmwareId]) assert.ok(has(d, s), `${d.name}: ${s}`);
    assert.match(d.firmwareId, /^RW-[0-9A-F]{6}$/);
    assert.equal(d.sx.sf, 7);
    assert.equal(d.sx.crcOn, true);
    assert.equal(d.sx.txDbm, 17);
    assert.equal(d.mpu.regs[0x1c] >> 3 & 3, 1, 'accelerometer at +-4 g');
    assert.equal(d.mpu.regs[0x1a] & 7, 4, 'DLPF 21 Hz');
  }
  assert.notEqual(w.devices[0].firmwareId, w.devices[1].firmwareId);
});

test('the OLED picture is rebuilt from the I2C traffic', async () => {
  const w = await lab([{ x: 1000 }]);
  run(w, 1.5);
  const o = w.devices[0].oled;
  assert.ok(o.lit);
  // first character is 'R' from the Adafruit 5x7 font: columns 0x7F 0x09 0x19 0x29 0x46
  const cols = [0, 1, 2, 3, 4].map(x => { let b = 0; for (let y = 0; y < 8; y++) b |= o.pixel(x, y) << y; return b; });
  assert.deepEqual(cols, [0x7f, 0x09, 0x19, 0x29, 0x46]);
});

test('a knock on the board raises an alert that the other board receives and relays', async () => {
  const w = await lab([{ x: 1000 }, { x: 1500, lane: 1 }]);
  run(w, 4);
  const [a, b] = w.devices;
  a.mpu.tap(a.t, 3, 40);
  run(w, 6);
  const sent = json(a).find(p => p.t === 'HAZARD_ALERT');
  assert.ok(sent, 'A printed its alert');
  assert.equal(sent.veh, a.firmwareId);
  assert.ok(a.pinLog.some(e => e.pin === 10 && e.v === 0), 'LED D1 switched on');
  const heard = json(b).find(p => p.id === sent.id);
  assert.ok(heard, 'B received it over the air');
  assert.equal(heard.hop, 0);
  assert.ok(has(b, 'RELAY hop=1'), 'B relayed it');
  const relayed = w.channel.txs.find(t => t.src === b.id);
  assert.ok(relayed, 'B put the relay on the air');
  const rp = JSON.parse(new TextDecoder().decode(relayed.payload));
  assert.equal(rp.hop, 1);
  // TTL is relative: reduced by the frame's air time (0.32 s) and the relay's hold time (backoff slots)
  assert.ok(rp.ttl <= 29.7 && rp.ttl > 27, `TTL reduced by air time and hold time (${rp.ttl})`);
});

test('multi-hop: a car out of range gets the alert through the one in the middle', async () => {
  const w = await lab([{ x: 300 }, { x: 2500, lane: 1 }, { x: 4700 }]);
  const [a, b, c] = w.devices;
  const direct = w.channel.linkBudget(a.antennaPos(0), c.antennaPos(0), null, null, { freq: 433e6, txDbm: 17, sf: 7, bw: 125e3 });
  assert.ok(direct.margin < -3, `A-C is out of range (margin ${direct.margin.toFixed(1)} dB)`);
  run(w, 4);
  a.mpu.tap(a.t, 3, 40);
  run(w, 7);
  const sent = json(a).find(p => p.t === 'HAZARD_ALERT');
  assert.ok(sent);
  assert.ok(!w.log.some(e => e.type === 'rx' && e.tx.src === a.id && e.rx === c.id && e.ok), 'C never decoded A directly');
  const atC = json(c).find(p => p.id === sent.id);
  assert.ok(atC, 'C got it');
  assert.equal(atC.hop, 1);
  assert.ok(json(b).some(p => p.id === sent.id && p.hop === 0));
});

test('a JSON line from the Pi goes out over LoRa; an oversize line is refused', async () => {
  const w = await lab([{ x: 1000 }, { x: 1200, lane: 1 }]);
  run(w, 2);
  const [a, b] = w.devices;
  a.sendSerial('{"id":"pi-1","t":"HAZARD_ALERT","veh":"VEH-PI-01","hz":"debris","c":0.9,"lat":28.46,"lon":77.03,"spd":30,"hop":0,"mh":5,"ttl":30,"oid":null,"ts":1}');
  run(w, 3.5);
  assert.ok(json(b).some(p => p.id === 'pi-1' && p.hz === 'debris'));
  a.sendSerial('{"t":"HAZARD_ALERT","pad":"' + 'x'.repeat(300) + '"}');
  run(w, 4.5);
  assert.ok(has(a, 'ERR line too long for a LoRa frame'));
});

test('push-to-talk voice frames are sent but never relayed', async () => {
  const w = await lab([{ x: 1000 }, { x: 1200, lane: 1 }]);
  run(w, 2);
  const [a, b] = w.devices;
  const voice = fs.readFileSync(path.join(here, '../../ptt_sample_line.txt'), 'utf8').trim();
  a.sendSerial(voice);
  run(w, 4);
  assert.ok(lines(b).some(l => l.includes('"t":"VOICE"')));
  assert.equal(w.channel.txs.filter(t => t.src === b.id).length, 0, 'B did not relay voice');
});

test('out of range: nothing is decoded 4.7 km away in a dense urban street', async () => {
  const w = await lab([{ x: 200 }, { x: 4900, lane: 1 }], { env: 'urban' });
  run(w, 4);   // the firmware ignores impacts in its first 3 s (alert cooldown starts at boot)
  w.devices[0].mpu.tap(w.devices[0].t, 3, 40);
  run(w, 6);
  assert.ok(json(w.devices[0]).some(p => p.t === 'HAZARD_ALERT'));
  assert.equal(json(w.devices[1]).length, 0);
});

test('fault injection: an unplugged MPU-6050 is reported after reset', async () => {
  const w = await lab([{ x: 1000 }]);
  run(w, 1.5);
  const d = w.devices[0];
  d.mpu.connected = false;
  await d.resetChip();
  run(w, 3);
  assert.ok(has(d, 'MPU6050 not found - check wiring.'));
});

test('BOOT held during reset enters the ROM download mode', async () => {
  const w = await lab([{ x: 1000 }]);
  run(w, 1);
  const d = w.devices[0];
  d.buttons.boot = true;
  await d.resetChip();
  run(w, 2);
  assert.equal(d.state, 'download');
  assert.ok(has(d, 'waiting for download'));
  assert.equal(d.buzzerOn(), true, 'BOOT pulls IO9 low, which also sounds the buzzer');
});

test('vehicle physics: dashboard IMU sees ~1 g for a deep pothole, ~20 g in a crash', () => {
  const road = new Road(2, { roughness: 'B' });
  road.addFeature({ kind: 'pothole', x: 100, y: 0.74, width: 0.7, length: 1.0, depth: 0.12 });
  const v = new Vehicle(road, { x: 70, speed: 40 / 3.6 });
  const mpu = new MPU6050({ motionAt: t => v.motionAt(t) }, 9);
  Object.assign(mpu.regs, { 0x6b: 1, 0x1a: 4, 0x1c: 1 << 3 });
  let peak = 0;
  for (let t = 0.001; t < 5; t += 0.001) { mpu.sampleTo(t); if (v.x > 97 && v.x < 110) peak = Math.max(peak, Math.abs(Math.hypot(...mpu.latest.accel) - 1)); }
  assert.ok(peak > 0.6 && peak < 1.8, `pothole peak ${peak.toFixed(2)} g`);
  const v2 = new Vehicle(road, { x: 10, speed: 50 / 3.6 });
  v2.advanceTo(0.5);
  const g = v2.crash();
  assert.ok(g > 20 && g < 30, `crash ${g.toFixed(1)} g`);
});

test('two frames on top of each other: capture or collision, decided by the power difference', async () => {
  const w = await lab([{ x: 1000 }, { x: 1150, lane: 1 }, { x: 1400 }]);
  run(w, 2);
  const [a, b, c] = w.devices;
  // A (150 m from B) and C (250 m from B) transmit at the same moment
  const line = id => `{"id":"${id}","t":"HAZARD_ALERT","veh":"PI","hz":"x","c":1,"lat":0,"lon":0,"spd":0,"hop":5,"mh":5,"ttl":30,"oid":null,"ts":0}`;
  a.sendSerial(line('from-a'));
  c.sendSerial(line('from-c'));
  run(w, 3.5);
  const atB = w.log.filter(e => e.type === 'rx' && e.rx === b.id);
  assert.ok(atB.length >= 1);
  const ok = atB.filter(e => e.ok);
  assert.ok(ok.length <= 1, 'B cannot decode both overlapping frames');
});
