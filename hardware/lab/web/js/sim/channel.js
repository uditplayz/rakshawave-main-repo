// 433 MHz radio channel between the virtual boards.
//
// Everything here is a physical quantity in SI units / dB:
//  - path loss: exact two-ray ground reflection (direct + ground-reflected wave,
//    complex Fresnel reflection coefficient of the road surface), or a
//    log-distance model with a measured exponent for built-up areas;
//  - slow fading: log-normal shadowing, spatially correlated (Gudmundson);
//  - fast fading: Rician (K factor per environment), one draw per frame;
//  - receiver noise: kTB + noise figure (SX1278 with LNA boost);
//  - LoRa demodulation: SNR limit per spreading factor from the SX1276/7/8
//    datasheet, co-channel capture needs the wanted frame 6 dB above the sum of
//    interferers;
//  - time on air: Semtech AN1200.13.
import { Rng, dB, lin } from './rng.js';

export const C = 299792458;
export const SNR_LIMIT_DB = { 6: -5, 7: -7.5, 8: -10, 9: -12.5, 10: -15, 11: -17.5, 12: -20 };
export const BW_TABLE = [7.8e3, 10.4e3, 15.6e3, 20.8e3, 31.25e3, 41.7e3, 62.5e3, 125e3, 250e3, 500e3];
export const CAPTURE_DB = 6;          // co-SF capture threshold
export const NOISE_FIGURE_DB = 7;     // SX1278 LF port, LNA boost on: gives -123 dBm at SF7/125k
export const ANTENNA_GAIN_DBI = 2.15; // quarter-wave whip on the SMA connector
export const FEEDER_LOSS_DB = 0.8;    // SMA + U.FL pigtail + PCB trace, each end

export const ENVIRONMENTS = {
  highway: { name: 'Highway, line of sight (two-ray ground reflection)', model: 'tworay', shadowSigma: 3, shadowDecorr: 25, k: 9, extraNoise: 0, eps: 15, sigma: 0.005 },
  suburban: { name: 'Suburban road (log-distance, n = 2.9)', model: 'logd', n: 2.9, shadowSigma: 6, shadowDecorr: 20, k: 3, extraNoise: 1 },
  urban: { name: 'Dense urban street (log-distance, n = 3.5)', model: 'logd', n: 3.5, shadowSigma: 8, shadowDecorr: 15, k: 0, extraNoise: 3 },
};

/** Semtech AN1200.13 time on air in seconds. */
export function timeOnAir({ sf, bw, cr = 1, preamble = 8, crc = true, implicit = false, ldro }, payloadBytes) {
  const tSym = Math.pow(2, sf) / bw;
  const de = ldro === undefined ? (tSym > 0.016 ? 1 : 0) : (ldro ? 1 : 0);
  const num = 8 * payloadBytes - 4 * sf + 28 + (crc ? 16 : 0) - (implicit ? 20 : 0);
  const nPayload = 8 + Math.max(Math.ceil(num / (4 * (sf - 2 * de))) * (cr + 4), 0);
  const tPreamble = (preamble + 4.25) * tSym;
  return { tSym, tPreamble, nPayload, total: tPreamble + nPayload * tSym };
}

export function noiseFloorDbm(bw, extra = 0) {
  return -174 + dB(bw) + NOISE_FIGURE_DB + extra;
}

/** Complex helpers for the two-ray model. */
const cmul = (a, b) => [a[0] * b[0] - a[1] * b[1], a[0] * b[1] + a[1] * b[0]];
const cdiv = (a, b) => { const d = b[0] * b[0] + b[1] * b[1]; return [(a[0] * b[0] + a[1] * b[1]) / d, (a[1] * b[0] - a[0] * b[1]) / d]; };
const csqrt = a => { const r = Math.hypot(a[0], a[1]); const re = Math.sqrt((r + a[0]) / 2); const im = Math.sign(a[1] || 1) * Math.sqrt((r - a[0]) / 2); return [re, im]; };

/**
 * Two-ray ground reflection loss (dB), vertical polarisation.
 * d: horizontal distance (m), ht/hr antenna heights (m), f (Hz),
 * eps/sigma: relative permittivity and conductivity (S/m) of the road.
 */
export function twoRayLossDb(d, ht, hr, f, eps = 15, sigma = 0.005) {
  const lambda = C / f;
  const k = 2 * Math.PI / lambda;
  const dLos = Math.hypot(d, ht - hr);
  const dRef = Math.hypot(d, ht + hr);
  const sinT = (ht + hr) / dRef;
  const cos2 = 1 - sinT * sinT;
  const er = [eps, -60 * lambda * sigma];             // complex permittivity
  const root = csqrt([er[0] - cos2, er[1]]);
  const erSin = [er[0] * sinT, er[1] * sinT];
  const gamma = cdiv([erSin[0] - root[0], erSin[1] - root[1]], [erSin[0] + root[0], erSin[1] + root[1]]);
  // E/E0 = (lambda/4pi) [ e^{-jk dLos}/dLos + Gamma e^{-jk dRef}/dRef ]
  const a = [Math.cos(-k * dLos) / dLos, Math.sin(-k * dLos) / dLos];
  const b = cmul(gamma, [Math.cos(-k * dRef) / dRef, Math.sin(-k * dRef) / dRef]);
  const sum = [a[0] + b[0], a[1] + b[1]];
  const mag = (lambda / (4 * Math.PI)) * Math.hypot(sum[0], sum[1]);
  return -20 * Math.log10(Math.max(mag, 1e-30));
}

export function freeSpaceLossDb(d, f) {
  return 20 * Math.log10(4 * Math.PI * Math.max(d, 0.01) * f / C);
}

export class Channel {
  constructor(seed = 433) {
    this.rng = new Rng(seed);
    this.env = 'highway';
    this.txs = [];            // every frame put on the air: see transmit()
    this.nextId = 1;
    this.shadow = new Map();  // link key -> {value, pa, pb}
    this.listeners = [];
  }

  get params() { return ENVIRONMENTS[this.env]; }

  setEnvironment(env) {
    if (!ENVIRONMENTS[env]) throw new Error('unknown environment ' + env);
    this.env = env;
    this.shadow.clear();
  }

  /** Mean path loss (dB) between two antenna positions {x, y, h} at frequency f. */
  pathLossDb(a, b, f) {
    const d = Math.max(Math.hypot(a.x - b.x, a.y - b.y), 0.05);
    const p = this.params;
    if (p.model === 'tworay') {
      // never less than free space at very short range (near field / reflections cancel out there)
      return Math.max(twoRayLossDb(d, a.h, b.h, f, p.eps, p.sigma), freeSpaceLossDb(Math.hypot(d, a.h - b.h), f) - 6);
    }
    const d0 = 1;
    return freeSpaceLossDb(d0, f) + 10 * p.n * Math.log10(Math.max(d, d0) / d0);
  }

  /** Correlated log-normal shadowing for the link a<->b (dB, positive = extra loss). */
  shadowDb(keyA, keyB, a, b) {
    const key = keyA < keyB ? keyA + '|' + keyB : keyB + '|' + keyA;
    const p = this.params;
    let s = this.shadow.get(key);
    if (!s) {
      s = { value: this.rng.gauss() * p.shadowSigma, pa: { ...a }, pb: { ...b } };
      this.shadow.set(key, s);
      return s.value;
    }
    const moved = Math.hypot(a.x - s.pa.x, a.y - s.pa.y) + Math.hypot(b.x - s.pb.x, b.y - s.pb.y);
    if (moved > 0.05) {
      const rho = Math.exp(-moved / p.shadowDecorr);
      s.value = rho * s.value + Math.sqrt(1 - rho * rho) * p.shadowSigma * this.rng.gauss();
      s.pa = { ...a };
      s.pb = { ...b };
    }
    return s.value;
  }

  /** Rician fast fading power gain in dB for one frame. */
  fadingDb() {
    const K = lin(this.params.k);
    const sLos = Math.sqrt(K / (K + 1));
    const sig = Math.sqrt(1 / (2 * (K + 1)));
    const re = sLos + sig * this.rng.gauss();
    const im = sig * this.rng.gauss();
    return dB(re * re + im * im);
  }

  /** Received power (dBm) of a transmission at an antenna. Mean (no fading) if fading=false. */
  receivedDbm(tx, rxNode, rxPos, fading = true) {
    const pl = this.pathLossDb(tx.pos, rxPos, tx.freq);
    const sh = this.shadowDb(tx.src, rxNode, tx.pos, rxPos);
    const fd = fading ? this.fadingDb() : 0;
    return tx.eirpDbm + ANTENNA_GAIN_DBI - FEEDER_LOSS_DB - pl - sh + fd + (rxPos.antennaLossDb ? -rxPos.antennaLossDb : 0);
  }

  /** Expected link quality without fading, for the map. */
  linkBudget(posA, posB, keyA, keyB, { freq, txDbm, sf, bw }) {
    const pl = this.pathLossDb(posA, posB, freq);
    const sh = keyA && keyB ? this.shadowDb(keyA, keyB, posA, posB) : 0;
    const rssi = txDbm + 2 * (ANTENNA_GAIN_DBI - FEEDER_LOSS_DB) - pl - sh - (posA.antennaLossDb || 0) - (posB.antennaLossDb || 0);
    const noise = noiseFloorDbm(bw, this.params.extraNoise);
    const snr = rssi - noise;
    return { distance: Math.hypot(posA.x - posB.x, posA.y - posB.y), pathLoss: pl, shadow: sh, rssi, snr, margin: snr - SNR_LIMIT_DB[sf] };
  }

  /** A radio starts a frame. Returns the transmission record (also kept in this.txs). */
  transmit(rec) {
    const tx = Object.assign({ id: this.nextId++, receptions: [] }, rec);
    this.txs.push(tx);
    for (const l of this.listeners) l({ type: 'tx', tx });
    return tx;
  }

  /** Transmissions overlapping [t0, t1] (seconds). */
  overlapping(t0, t1, exceptId) {
    return this.txs.filter(t => t.id !== exceptId && t.t0 < t1 && t.t1 > t0);
  }

  /** Drop frames older than `before` seconds (keeps memory bounded). */
  prune(before) {
    if (this.txs.length > 400) this.txs = this.txs.filter(t => t.t1 > before);
  }

  /**
   * Probability that a frame is lost for a given margin (dB) above the
   * demodulation limit. LoRa waterfall curves fall by about a decade per dB;
   * longer frames need slightly more margin for the same packet error rate.
   */
  static frameErrorProb(marginDb, payloadBytes) {
    const m = marginDb - 0.6 * Math.log2(Math.max(payloadBytes, 8) / 32);
    return 1 / (1 + Math.exp(2.3 * m));
  }

  emit(ev) { for (const l of this.listeners) l(ev); }
}
