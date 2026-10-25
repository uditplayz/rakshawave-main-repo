// Measurements with the real firmware in the lab (prints a Markdown table).
//   node hardware/lab/test/measure.mjs [firmware.wasm]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { World } from '../web/js/sim/world.js';
import { Rng } from '../web/js/sim/rng.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const wasm = process.argv[2] || path.join(here, '../web/firmware.wasm');
const module = await WebAssembly.compile(fs.readFileSync(wasm));
const run = (w, u) => { while (w.t < u - 1e-9) w.runUntil(Math.min(u, w.t + 0.05), 1e9); };
const beacon = (i, d) => `{"id":"b${i}-${d}","t":"HEARTBEAT","veh":"PI","hz":"none","c":1,"lat":28.46,"lon":77.03,"spd":0,"hop":5,"mh":5,"ttl":30,"oid":null,"ts":0}`;

async function delivery(distance, env, n = 60) {
  const w = new World({ seed: 7 + distance });
  w.channel.setEnvironment(env);
  const a = await w.addDevice(module, { x: 200 });
  const b = await w.addDevice(module, { x: 200 + distance, lane: 1 });
  run(w, 2);
  let t = 2;
  const rng = new Rng(distance);
  for (let i = 0; i < n; i++) {
    // random spacing so the frames sample every phase of the receiver's loop
    t += 0.9 + rng.uniform() * 0.5;
    a.sendSerial(beacon(i, distance));
    run(w, t);
  }
  run(w, t + 1);
  const got = new Set(b.console.map(c => c.text).filter(l => l.startsWith('{"id":"b')).map(l => JSON.parse(l).id));
  return got.size / n;
}

async function latency() {
  const w = new World({ seed: 11 });
  const devs = [];
  for (const x of [300, 2500, 4700]) devs.push(await w.addDevice(module, { x, lane: devs.length % 2 }));
  run(w, 4);
  const t0 = devs[0].t;
  devs[0].mpu.tap(t0, 3, 40);
  run(w, 8);
  const firstRx = id => w.log.find(e => e.type === 'rx' && e.ok && e.rx === id)?.t;
  return { impact: t0, hop1: firstRx(devs[1].id) - t0, hop2: firstRx(devs[2].id) - t0 };
}

const rows = [];
for (const env of ['highway', 'suburban']) {
  for (const d of env === 'highway' ? [300, 1000, 1500, 2000, 2500, 3000] : [200, 400, 600, 800, 1000]) {
    rows.push(`| ${env} | ${d} m | ${(100 * await delivery(d, env)).toFixed(0)} % |`);
  }
}
console.log('| environment | distance | frames delivered (60 sent) |\n|---|---|---|\n' + rows.join('\n'));
const l = await latency();
console.log(`\nImpact to alert decoded: 1 hop ${(l.hop1 * 1000).toFixed(0)} ms, 2 hops (via relay) ${(l.hop2 * 1000).toFixed(0)} ms`);
