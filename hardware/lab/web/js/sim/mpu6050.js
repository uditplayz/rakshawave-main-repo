// InvenSense MPU-6050 at I2C address 0x68, register level.
//
// The chip samples at 1 kHz internally. Each sample takes the specific force
// and angular rate at the board (from the vehicle model), adds the datasheet
// noise densities and this part's offsets, runs it through the digital low
// pass filter selected by CONFIG.DLPF_CFG, and is quantised to 16 bits with the
// selected full-scale range (saturating, like the real ADC).
import { Rng } from './rng.js';

const ACCEL_LSB = [16384, 8192, 4096, 2048];
const GYRO_LSB = [131, 65.5, 32.8, 16.4];
const DLPF_ACCEL_HZ = [260, 184, 94, 44, 21, 10, 5, 260];
const DLPF_GYRO_HZ = [256, 188, 98, 42, 20, 10, 5, 256];
const ACCEL_NOISE_G = 400e-6;   // g/sqrt(Hz)
const GYRO_NOISE_DPS = 0.005;   // deg/s/sqrt(Hz)
export const MPU_CURRENT_MA = { on: 3.9, sleep: 0.005 };

class Biquad {
  constructor() { this.set(260, 1000); this.x1 = this.x2 = this.y1 = this.y2 = null; }
  set(fc, fs) {
    if (this.fc === fc) return;
    this.fc = fc;
    const k = Math.tan(Math.PI * Math.min(fc, 0.45 * fs) / fs), q = Math.SQRT1_2;
    const norm = 1 / (1 + k / q + k * k);
    this.b0 = k * k * norm; this.b1 = 2 * this.b0; this.b2 = this.b0;
    this.a1 = 2 * (k * k - 1) * norm; this.a2 = (1 - k / q + k * k) * norm;
  }
  step(x) {
    if (this.x1 === null) { this.x1 = this.x2 = this.y1 = this.y2 = x; }
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}

const RESET_REGS = () => { const r = new Uint8Array(128); r[0x6b] = 0x40; r[0x75] = 0x68; return r; };

export class MPU6050 {
  constructor(dev, seed) {
    this.dev = dev;
    this.addr = 0x68;
    this.connected = true;
    const rng = new Rng(seed);
    this.rng = rng;
    // this part's errors, inside the datasheet limits
    this.accelOffset = [rng.gauss() * 0.025, rng.gauss() * 0.025, rng.gauss() * 0.035];
    this.gyroOffset = [rng.gauss() * 4, rng.gauss() * 4, rng.gauss() * 4];
    this.scaleErr = [1 + rng.gauss() * 0.01, 1 + rng.gauss() * 0.01, 1 + rng.gauss() * 0.01];
    this.taps = [];
    this.trace = [];
    this.powerOnReset();
  }

  powerOnReset() {
    this.regs = RESET_REGS();
    this.ptr = 0;
    this.lastTick = null;
    this.resetUntil = 0;
    this.filters = Array.from({ length: 6 }, () => new Biquad());
    this.latest = { accel: [0, 0, 1], gyro: [0, 0, 0], temp: 30 };
  }

  get asleep() { return !!(this.regs[0x6b] & 0x40); }
  currentMa() { return !this.connected ? 0 : this.asleep ? MPU_CURRENT_MA.sleep : MPU_CURRENT_MA.on; }

  /** A tap on the board: half-sine of `g` peak for `ms` (adds to Z and X). */
  tap(t, g = 3, ms = 6) { this.taps.push({ t0: t, t1: t + ms / 1000, g }); }

  tapAt(t) {
    let a = 0;
    for (const k of this.taps) if (t >= k.t0 && t < k.t1) a += k.g * Math.sin(Math.PI * (t - k.t0) / (k.t1 - k.t0));
    if (this.taps.length && this.taps[0].t1 < t - 1) this.taps.shift();
    return a;
  }

  /** Run the internal 1 kHz sampler up to time t (s). */
  sampleTo(t) {
    const tick = Math.floor(t * 1000);
    if (this.lastTick === null) this.lastTick = tick - 1;
    if (tick - this.lastTick > 2000) this.lastTick = tick - 2000;  // long sleep: only the last 2 s matter for the filter
    const cfg = this.regs[0x1a] & 7;
    for (let i = 0; i < 3; i++) { this.filters[i].set(DLPF_ACCEL_HZ[cfg], 1000); this.filters[3 + i].set(DLPF_GYRO_HZ[cfg], 1000); }
    const sa = ACCEL_NOISE_G * Math.sqrt(500), sg = GYRO_NOISE_DPS * Math.sqrt(500);
    for (let k = this.lastTick + 1; k <= tick; k++) {
      const tk = k / 1000;
      const m = this.dev.motionAt(tk);   // {f: [gx, gy, gz] specific force in g, w: [dps x3]}
      const tap = this.tapAt(tk);
      const a = [m.f[0] + tap * 0.4, m.f[1], m.f[2] + tap];
      for (let i = 0; i < 3; i++) {
        const va = a[i] * this.scaleErr[i] + this.accelOffset[i] + sa * this.rng.gauss();
        const vg = m.w[i] + this.gyroOffset[i] + sg * this.rng.gauss();
        this.latest.accel[i] = this.filters[i].step(va);
        this.latest.gyro[i] = this.filters[3 + i].step(vg);
      }
      this.latest.temp = 31.5 + 0.3 * Math.sin(tk / 60);
      // |a| - 1 g as the firmware will compute it (saturated at the full-scale range), max per 5 ms, for the UI plot
      const fs = [2, 4, 8, 16][(this.regs[0x1c] >> 3) & 3];
      const dd = Math.abs(Math.hypot(...this.latest.accel.map(v => Math.max(-fs, Math.min(fs, v)))) - 1);
      if (!this.bucket || k - this.bucket.k >= 5) {
        this.bucket = { k, t: tk, d: dd };
        this.trace.push(this.bucket);
        if (this.trace.length > 2400) this.trace.splice(0, 1200);
      } else if (dd > this.bucket.d) this.bucket.d = dd;
    }
    this.lastTick = tick;
    // data registers update only while awake
    if (this.asleep) return;
    const afs = (this.regs[0x1c] >> 3) & 3, gfs = (this.regs[0x1b] >> 3) & 3;
    const q = v => { const r = Math.round(v); return Math.max(-32768, Math.min(32767, r)) & 0xffff; };
    const put = (addr, raw) => { this.regs[addr] = raw >> 8; this.regs[addr + 1] = raw & 0xff; };
    for (let i = 0; i < 3; i++) {
      put(0x3b + 2 * i, q(this.latest.accel[i] * ACCEL_LSB[afs]));
      put(0x43 + 2 * i, q(this.latest.gyro[i] * GYRO_LSB[gfs]));
    }
    put(0x41, q((this.latest.temp - 36.53) * 340));
  }

  // ------------------------------------------------------------- I2C
  i2cWrite(bytes, t) {
    if (!this.connected) return false;
    if (!bytes.length) return true;
    this.ptr = bytes[0] & 0x7f;
    for (let i = 1; i < bytes.length; i++) {
      this.writeReg(this.ptr, bytes[i], t);
      this.ptr = (this.ptr + 1) & 0x7f;
    }
    return true;
  }

  i2cRead(n, t) {
    if (!this.connected) return null;
    this.sampleTo(t);
    if (this.resetUntil && t >= this.resetUntil) { this.regs[0x6b] &= 0x7f; this.resetUntil = 0; }
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) { out[i] = this.regs[this.ptr]; this.ptr = (this.ptr + 1) & 0x7f; }
    return out;
  }

  writeReg(a, v, t) {
    switch (a) {
      case 0x75: return;  // WHO_AM_I is read-only
      case 0x6b:
        if (v & 0x80) {
          // DEVICE_RESET: all registers back to defaults; the bit clears itself
          const keep = this.lastTick;
          this.regs = RESET_REGS();
          this.regs[0x6b] = 0xc0;
          this.resetUntil = t + 0.0005;
          this.lastTick = keep;
          return;
        }
        this.regs[a] = v;
        return;
      case 0x68: return;  // SIGNAL_PATH_RESET: filters restart
      default: this.regs[a] = v;
    }
  }
}
