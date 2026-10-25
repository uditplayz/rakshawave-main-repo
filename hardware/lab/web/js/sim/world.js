// The lab: boards on vehicles on a road, sharing one 433 MHz channel.
//
// Scheduling: every board has its own clock. The board that is furthest
// behind always runs next (one loop() at a time), and a radio only decides
// what it received up to the slowest other board's clock, so no board can
// miss a frame that another board started "in its past". Frames, collisions
// and timing are therefore exact even though the boards run one after another
// on one JavaScript thread.
import { Channel } from './channel.js';
import { Road } from './vehicle.js';
import { Device } from './device.js';

export class World {
  constructor({ seed = 433, roughness = 'B' } = {}) {
    this.seed = seed;
    this.channel = new Channel(seed);
    this.road = new Road(seed + 1, { roughness });
    this.devices = [];
    this.t = 0;                 // world (target) time, s
    this.nextSeed = seed * 31 + 7;
    this.log = [];              // mesh / packet events for the UI
    this.channel.listeners.push(ev => this.onChannel(ev));
    this.listeners = [];
  }

  async addDevice(module, opts = {}) {
    const n = this.devices.length + 1;
    const dev = new Device(this, Object.assign({ id: 'D' + n, name: 'Node ' + String.fromCharCode(64 + n), seed: (this.nextSeed += 101) }, opts));
    dev.t = this.t;
    dev.vehicle.advanceTo(this.t);
    this.devices.push(dev);
    // boards are never switched on at the same microsecond
    await dev.powerOn(module, this.t + dev.rng.uniform() * 0.2);
    return dev;
  }

  removeDevice(dev) {
    dev.powerOff();
    this.devices = this.devices.filter(d => d !== dev);
  }

  /** Earliest time any other running board could still put a frame on the air. */
  horizon(dev) {
    let h = Infinity;
    for (const d of this.devices) if (d !== dev && d.on && d.t < h) h = d.t;
    return h;
  }

  /**
   * Advance every board to world time `target`. Stops early if `budgetMs` of
   * wall time is used (the UI then shows the real-time factor dropping).
   */
  runUntil(target, budgetMs = 30) {
    this.t = Math.max(this.t, target);
    const start = (typeof performance !== 'undefined' ? performance : Date).now();
    for (;;) {
      let next = null;
      for (const d of this.devices) if (d.t < target && (!next || d.t < next.t)) next = d;
      if (!next) break;
      next.runSlice(target);
      if ((typeof performance !== 'undefined' ? performance : Date).now() - start > budgetMs) break;
    }
    const tMin = Math.min(...this.devices.map(d => d.t), target);
    for (const d of this.devices) d.vehicle.advanceTo(tMin);
    this.channel.prune(tMin - 10);
    return tMin;
  }

  onChannel(ev) {
    const entry = Object.assign({ wall: Date.now() }, ev);
    this.log.push(entry);
    if (this.log.length > 500) this.log.splice(0, 200);
    for (const l of this.listeners) l(entry);
  }

  device(id) { return this.devices.find(d => d.id === id); }
}
