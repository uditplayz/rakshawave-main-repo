// Seeded random numbers, so a scenario replays the same way.
export class Rng {
  constructor(seed = 1) { this.s = seed >>> 0 || 1; this._spare = null; }
  u32() {
    // mulberry32
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }
  uniform() { return this.u32() / 4294967296; }
  range(a, b) { return a + (b - a) * this.uniform(); }
  gauss() {
    if (this._spare !== null) { const v = this._spare; this._spare = null; return v; }
    let u, v, s;
    do { u = this.uniform() * 2 - 1; v = this.uniform() * 2 - 1; s = u * u + v * v; } while (s >= 1 || s === 0);
    const m = Math.sqrt(-2 * Math.log(s) / s);
    this._spare = v * m;
    return u * m;
  }
}

export const dB = x => 10 * Math.log10(x);
export const lin = d => Math.pow(10, d / 10);
