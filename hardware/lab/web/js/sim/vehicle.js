// Road and vehicle dynamics: what the MPU-6050 on the dashboard actually feels.
//
// Road: ISO 8608 random roughness (left and right wheel tracks) plus discrete
// features (potholes with sharp edges, speed bumps). A tyre cannot follow an
// edge that is sharper than its own radius, so the wheel input is the
// envelope of a rolling circle over the profile.
//
// Vehicle: 7-DOF full-car ride model (body heave, pitch, roll and four wheel
// hops), linear suspension with bump stops, tyres that can leave the ground.
// Integrated at 2 kHz. The board's specific force and angular rate come from
// rigid-body kinematics at its mounting point.
import { Rng } from './rng.js';

export const G = 9.80665;
const ISO_CLASS = { A: 16e-6, B: 64e-6, C: 256e-6, D: 1024e-6 };

export class Road {
  constructor(seed = 8608, { length = 5000, roughness = 'B' } = {}) {
    this.length = length;
    this.dx = 0.05;
    this.lanes = [0, 3.5, 7.0];            // lane centre lines (m), traffic in +x
    this.features = [];                    // potholes / bumps
    this.seed = seed;
    this.setRoughness(roughness);
  }

  setRoughness(cls) {
    this.roughness = cls;
    const rng = new Rng(this.seed);
    const n = Math.floor(this.length / this.dx) + 2;
    this.left = new Float32Array(n);
    this.right = new Float32Array(n);
    const gd0 = ISO_CLASS[cls] || ISO_CLASS.B, n0 = 0.1;
    const N = 110, nMin = 0.011, nMax = 2.83;
    for (const track of [this.left, this.right]) {
      for (let k = 0; k < N; k++) {
        const nk = nMin * Math.pow(nMax / nMin, (k + 0.5) / N);
        const dn = nk * Math.log(nMax / nMin) / N;
        const amp = Math.sqrt(2 * gd0 * Math.pow(nk / n0, -2) * dn);
        const ph = rng.uniform() * 2 * Math.PI, w = 2 * Math.PI * nk * this.dx;
        // sin recurrence: fast and exact enough over the length
        let s0 = Math.sin(ph - w), s1 = Math.sin(ph);
        const c = 2 * Math.cos(w);
        for (let i = 0; i < n; i++) { track[i] += amp * s1; const s2 = c * s1 - s0; s0 = s1; s1 = s2; }
      }
    }
  }

  addFeature(f) {
    const feat = Object.assign({ id: (this.features.at(-1)?.id || 0) + 1 }, f);
    this.features.push(feat);
    return feat;
  }

  removeFeature(id) { this.features = this.features.filter(f => f.id !== id); }

  /** Surface height (m) at (x, y). */
  height(x, y, track) {
    const xr = ((x % this.length) + this.length) % this.length;
    const i = Math.floor(xr / this.dx), fr = xr / this.dx - i;
    const arr = track === 'left' ? this.left : this.right;
    let h = arr[i] * (1 - fr) + arr[i + 1] * fr;
    for (const f of this.features) {
      const dx = xr - f.x;
      if (f.kind === 'bump') {
        if (dx >= 0 && dx <= f.length) h += f.height * Math.pow(Math.sin(Math.PI * dx / f.length), 2);
      } else if (Math.abs(y - f.y) < f.width / 2 && dx >= 0 && dx <= f.length) {
        // pothole: near-vertical walls (2 cm chamfer)
        const e = Math.min(dx, f.length - dx);
        h -= f.depth * Math.min(1, e / 0.02);
      }
    }
    return h;
  }

  near(x, y, reach) {
    const xr = ((x % this.length) + this.length) % this.length;
    return this.features.some(f => xr > f.x - reach && xr < f.x + f.length + reach && (f.kind === 'bump' || Math.abs(y - f.y) < f.width / 2 + 0.15));
  }

  /** Vertical input to the wheel centre: envelope of a rolling circle of radius R. */
  wheelInput(x, y, track, R) {
    if (!this.near(x, y, R)) return this.height(x, y, track);
    let best = -Infinity;
    for (let u = -R; u <= R + 1e-9; u += 0.01) {
      const v = this.height(x + u, y, track) + Math.sqrt(Math.max(0, R * R - u * u)) - R;
      if (v > best) best = v;
    }
    return best;
  }
}

// Compact sedan, per-corner values.
export const CAR = {
  M: 1050, Iyy: 1400, Ixx: 450, a: 1.05, b: 1.43, track: 1.48,
  ks: [20000, 20000, 18000, 18000], cs: [1500, 1500, 1300, 1300], mu: [35, 35, 30, 30],
  kt: 190000, ct: 100, R: 0.29, travel: 0.08, kStop: 250000,
  mount: { x: 0.75, y: 0.2, z: 0.45 },   // the board on the dashboard, from the centre of gravity
  aMax: 2.5, bMax: 4.5, bEmergency: 7.0,   // m/s^2; full ABS stop on dry asphalt is 7-8
  reaction: 1.2,                         // s, driver reaction to an expected warning
};

export class Vehicle {
  constructor(road, { x = 0, lane = 0, speed = 0 } = {}) {
    this.road = road;
    this.p = CAR;
    this.lane = lane;
    this.x = x;
    this.y = road.lanes[lane];
    this.v = speed;
    this.vTarget = speed;
    this.aLong = 0;
    this.t = 0;
    this.dt = 0.0005;
    const p = this.p;
    this.cx = [p.a, p.a, -p.b, -p.b];
    this.cy = [p.track / 2, -p.track / 2, p.track / 2, -p.track / 2];
    this.tracks = ['left', 'right', 'left', 'right'];
    const wf = p.M * p.b / (p.a + p.b) / 2, wr = p.M * p.a / (p.a + p.b) / 2;
    this.fStatic = [(wf + p.mu[0]) * G, (wf + p.mu[1]) * G, (wr + p.mu[2]) * G, (wr + p.mu[3]) * G];
    this.s = { z: 0, zd: 0, th: 0, thd: 0, ph: 0, phd: 0, zu: [0, 0, 0, 0], zud: [0, 0, 0, 0], zdd: 0, thdd: 0, phdd: 0 };
    this.zr = null;
    this.history = [];      // [{t, x, v}] every 10 ms, for other boards asking about the past
    this.lastHist = -1;
    this.events = [];
    this.maxDrop = 0;
  }

  setSpeed(kmh) { this.vTarget = Math.max(0, kmh / 3.6); this.emergency = false; this.brakeAt = null; }

  /** The driver hears the buzzer and brakes hard after their reaction time. */
  driverWarned(t) {
    if (this.v < 1 || this.brakeAt != null || this.emergency || this.crashPulse) return;
    this.brakeAt = t + this.p.reaction;
    this.warnedAt = t;
  }
  teleport(x) { this.x = x; this.zr = null; this.history = []; this.lastHist = -1; }
  setLane(l) { this.lane = l; this.y = this.road.lanes[l]; this.zr = null; }

  settled() {
    const s = this.s;
    return this.v === 0 && this.vTarget === 0 && !this.crashPulse && Math.abs(s.zd) < 1e-5 && Math.abs(s.thd) < 1e-5 && Math.abs(s.phd) < 1e-5 && s.zud.every(v => Math.abs(v) < 1e-5);
  }

  /** Put the car at rest on the road under it (no start-up transient). */
  settleOn(zr) {
    const s = this.s;
    for (let i = 0; i < 4; i++) { s.zu[i] = zr[i]; s.zud[i] = 0; }
    s.z = zr.reduce((a, b) => a + b, 0) / 4;
    s.th = ((zr[0] + zr[1]) / 2 - (zr[2] + zr[3]) / 2) / (this.p.a + this.p.b);
    s.ph = ((zr[0] + zr[2]) / 2 - (zr[1] + zr[3]) / 2) / this.p.track;
    s.zd = s.thd = s.phd = 0;
    this.zr = zr;
  }

  /**
   * Frontal collision: the car stops in `pulse` seconds with a half-sine
   * deceleration (crash-test pulse shape), peak = pi * v / (2 * pulse).
   */
  crash(pulse = 0.09) {
    if (this.v < 0.5) return null;
    this.crashPulse = { t0: this.t, T: pulse, v0: this.v };
    this.crashedAt = this.t;
    this.vTarget = 0;
    return Math.PI * this.v / (2 * pulse) / G;
  }

  inputs() {
    return this.cx.map((cx, i) => this.road.wheelInput(this.x + cx, this.y + this.cy[i], this.tracks[i], this.p.R));
  }

  step() {
    const p = this.p, s = this.s, dt = this.dt;
    // longitudinal: first-order speed controller with traction / brake limits
    const dv = this.vTarget - this.v;
    if (this.crashPulse) {
      const c = this.crashPulse, u = (this.t - c.t0) / c.T;
      if (u >= 1) { this.crashPulse = null; this.aLong = 0; this.v = 0; }
      else { this.aLong = -Math.PI * c.v0 / (2 * c.T) * Math.sin(Math.PI * u); this.v = Math.max(0, this.v + this.aLong * dt); }
    } else {
      if (this.brakeAt != null && this.t >= this.brakeAt) {
        this.brakeAt = null;
        this.emergency = true;
        this.vTarget = 0;
        this.brakeFrom = { x: this.x, v: this.v, t: this.t };
      }
      this.aLong = Math.max(-(this.emergency ? p.bEmergency : p.bMax), Math.min(p.aMax, dv * (this.emergency ? 50 : 1.2)));
      if (Math.abs(dv) < 0.01) { this.aLong = 0; this.v = this.vTarget; }
      this.v = Math.max(0, this.v + this.aLong * dt);
      if (this.emergency && this.v === 0 && this.brakeFrom) {
        this.events.push({ type: 'stopped', t: this.t, v0: this.brakeFrom.v, distance: this.x - this.brakeFrom.x + this.brakeFrom.v * p.reaction, reaction: p.reaction });
        this.brakeFrom = null;
      }
    }
    this.x += this.v * dt;
    if (this.x > this.road.length) { this.x -= this.road.length; this.zr = null; }

    const zr = this.inputs();
    if (!this.zr) this.settleOn(zr);
    const zrPrev = this.zr;
    this.zr = zr;
    const Fs = [0, 0, 0, 0];
    for (let i = 0; i < 4; i++) {
      const zc = s.z + this.cx[i] * s.th + this.cy[i] * s.ph;
      const zcd = s.zd + this.cx[i] * s.thd + this.cy[i] * s.phd;
      const defl = s.zu[i] - zc;
      let f = p.ks[i] * defl + p.cs[i] * (s.zud[i] - zcd);
      if (Math.abs(defl) > p.travel) f += p.kStop * (defl - Math.sign(defl) * p.travel);
      Fs[i] = f;
      const zrd = (zr[i] - zrPrev[i]) / dt;
      let ft = p.kt * (zr[i] - s.zu[i]) + p.ct * (zrd - s.zud[i]);
      if (ft < -this.fStatic[i]) ft = -this.fStatic[i];   // tyre leaves the road
      const zudd = (ft - f) / p.mu[i];
      s.zud[i] += zudd * dt;
      s.zu[i] += s.zud[i] * dt;
      if (zr[i] < -0.01 && -zr[i] > this.maxDrop) this.maxDrop = -zr[i];
    }
    let sum = 0, mp = 0, mr = 0;
    for (let i = 0; i < 4; i++) { sum += Fs[i]; mp += Fs[i] * this.cx[i]; mr += Fs[i] * this.cy[i]; }
    s.zdd = sum / p.M; s.thdd = mp / p.Iyy; s.phdd = mr / p.Ixx;
    s.zd += s.zdd * dt; s.z += s.zd * dt;
    s.thd += s.thdd * dt; s.th += s.thd * dt;
    s.phd += s.phdd * dt; s.ph += s.phd * dt;
    this.t += dt;
  }

  advanceTo(t) {
    if (t <= this.t) return;
    if (this.settled() && !this.road.near(this.x, this.y, 2)) {
      this.t = t;   // nothing moves: skip the integration
      this.record(true);
      return;
    }
    while (this.t + this.dt <= t) {
      this.step();
      this.record(false);
    }
  }

  record(force) {
    const k = Math.floor(this.t * 100);
    if (k === this.lastHist && !force) return;
    this.lastHist = k;
    this.history.push({ t: this.t, x: this.x, v: this.v });
    if (this.history.length > 3000) this.history.splice(0, 1000);
  }

  /** Longitudinal position at time t (s); integrates forward if needed. */
  xAt(t) {
    if (t >= this.t) { this.advanceTo(t); return this.x; }
    const h = this.history;
    if (!h.length || t <= h[0].t) return h.length ? h[0].x : this.x;
    let lo = 0, hi = h.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (h[m].t <= t) lo = m; else hi = m; }
    const a = h[lo], b = h[hi];
    let dx = b.x - a.x;
    if (dx < -this.road.length / 2) dx += this.road.length;   // lap wrap
    const f = (t - a.t) / Math.max(1e-9, b.t - a.t);
    return (a.x + dx * f) % this.road.length;
  }

  speedAt(t) {
    if (t >= this.t) { this.advanceTo(t); return this.v; }
    const h = this.history;
    for (let i = h.length - 1; i >= 0; i--) if (h[i].t <= t) return h[i].v;
    return this.v;
  }

  /** Board motion at time t: specific force (g) and angular rate (deg/s) in the board frame. */
  motionAt(t) {
    this.advanceTo(t);
    const s = this.s, m = this.p.mount;
    const az = s.zdd + m.x * s.thdd + m.y * s.phdd;
    const ax = this.aLong - m.z * s.thdd;
    const ay = -m.z * s.phdd;
    const r2d = 180 / Math.PI;
    return {
      f: [(ax + G * Math.sin(s.th)) / G, (ay + G * Math.sin(s.ph)) / G, (az + G * Math.cos(s.th) * Math.cos(s.ph)) / G],
      w: [s.phd * r2d, -s.thd * r2d, 0],
    };
  }
}
