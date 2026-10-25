// Semtech SX1278 (Ai-Thinker Ra-01) LoRa transceiver, register level.
//
// The firmware drives it over SPI exactly as on the board (sandeepmistry LoRa
// library). Modelled: the LoRa register page, the 256-byte FIFO with its
// pointers, the operating modes and their timing (TX for the full time on air,
// RX single with the symbol timeout, RX continuous), IRQ flags, packet RSSI /
// SNR / frequency-error registers in the datasheet's units, the reset pin, and
// the crystal tolerance of each module. Reception is decided by the channel
// model (channel.js) from the real geometry and timing of every frame on air.
import { Channel, BW_TABLE, SNR_LIMIT_DB, CAPTURE_DB, ANTENNA_GAIN_DBI, FEEDER_LOSS_DB, timeOnAir, noiseFloorDbm } from './channel.js';
import { dB, lin } from './rng.js';

const R = {
  FIFO: 0x00, OP_MODE: 0x01, FRF_MSB: 0x06, FRF_MID: 0x07, FRF_LSB: 0x08, PA_CONFIG: 0x09, OCP: 0x0b, LNA: 0x0c,
  FIFO_ADDR_PTR: 0x0d, FIFO_TX_BASE: 0x0e, FIFO_RX_BASE: 0x0f, FIFO_RX_CURRENT: 0x10, IRQ_FLAGS_MASK: 0x11, IRQ_FLAGS: 0x12,
  RX_NB_BYTES: 0x13, MODEM_STAT: 0x18, PKT_SNR: 0x19, PKT_RSSI: 0x1a, RSSI: 0x1b, MODEM_CONFIG_1: 0x1d, MODEM_CONFIG_2: 0x1e,
  SYMB_TIMEOUT_LSB: 0x1f, PREAMBLE_MSB: 0x20, PREAMBLE_LSB: 0x21, PAYLOAD_LENGTH: 0x22, MODEM_CONFIG_3: 0x26,
  FEI_MSB: 0x28, FEI_MID: 0x29, FEI_LSB: 0x2a, RSSI_WIDEBAND: 0x2c, FIFO_RX_BYTE_ADDR: 0x25, INVERTIQ: 0x33, SYNC_WORD: 0x39,
  DIO_MAPPING_1: 0x40, VERSION: 0x42, PA_DAC: 0x4d,
};
export const SX_REG = R;

export const MODE = { SLEEP: 0, STDBY: 1, FSTX: 2, TX: 3, FSRX: 4, RX_CONT: 5, RX_SINGLE: 6, CAD: 7 };
export const MODE_NAME = ['SLEEP', 'STDBY', 'FSTX', 'TX', 'FSRX', 'RX_CONT', 'RX_SINGLE', 'CAD'];
export const IRQ = { RX_TIMEOUT: 0x80, RX_DONE: 0x40, CRC_ERROR: 0x20, VALID_HEADER: 0x10, TX_DONE: 0x08, CAD_DONE: 0x04, FHSS: 0x02, CAD_DETECTED: 0x01 };

// Datasheet supply currents (mA), SX1276/77/78 rev 7, band 3 (433 MHz).
export const SX_CURRENT = { sleep: 0.0002, standby: 1.6, fs: 6.0, rx: 11.5 };
function txCurrentMa(dbm, paBoost) {
  if (!paBoost) return dbm >= 13 ? 29 : 20;
  const pts = [[2, 24], [7, 33], [10, 40], [13, 55], [17, 87], [20, 120]];
  if (dbm <= pts[0][0]) return pts[0][1];
  for (let i = 1; i < pts.length; i++) {
    if (dbm <= pts[i][0]) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i];
      return y0 + (y1 - y0) * (dbm - x0) / (x1 - x0);
    }
  }
  return 120;
}

const DEFAULTS = (() => {
  const r = new Uint8Array(0x80);
  Object.entries({
    0x01: 0x09, 0x06: 0x6c, 0x07: 0x80, 0x08: 0x00, 0x09: 0x4f, 0x0a: 0x09, 0x0b: 0x2b, 0x0c: 0x20, 0x0e: 0x80,
    0x1d: 0x72, 0x1e: 0x70, 0x1f: 0x64, 0x20: 0x00, 0x21: 0x08, 0x22: 0x01, 0x23: 0xff, 0x26: 0x00, 0x31: 0xc3,
    0x33: 0x27, 0x37: 0x0a, 0x39: 0x12, 0x3b: 0x1d, 0x40: 0x00, 0x42: 0x12, 0x4d: 0x84,
  }).forEach(([a, v]) => (r[+a] = v));
  return r;
})();

export class SX1278 {
  /**
   * dev: the owning Device (gives world, id, rng, position, crystal ppm).
   */
  constructor(dev) {
    this.dev = dev;
    this.connected = true;       // fault injection: module unplugged
    this.ppm = dev.rng.range(-10, 10);
    this.powerOnReset();
  }

  powerOnReset() {
    this.regs = DEFAULTS.slice();
    this.fifo = new Uint8Array(256);
    this.inReset = false;
    this.nss = 1;
    this.spi = null;
    this.mode = MODE.STDBY;
    this.lora = false;
    this.modeSince = 0;
    this.history = [];           // [{t, mode, lora}] for the mesh log
    this.tx = null;              // active transmission record
    this.lock = null;            // frame being received
    this.rxArmedAt = 0;
    this.rxDeadline = Infinity;
    this.rxScannedTo = 0;
    this.lastPacket = null;
    this.stats = { tx: 0, rxOk: 0, rxCrc: 0, rxTimeout: 0, rxAbort: 0 };
  }

  get world() { return this.dev.world; }
  get channel() { return this.dev.world.channel; }

  // ------------------------------------------------------------- config helpers
  get freq() { return (((this.regs[R.FRF_MSB] << 16) | (this.regs[R.FRF_MID] << 8) | this.regs[R.FRF_LSB]) * 32e6) / 524288; }
  get sf() { return Math.min(12, Math.max(6, this.regs[R.MODEM_CONFIG_2] >> 4)); }
  get bw() { return BW_TABLE[Math.min(9, this.regs[R.MODEM_CONFIG_1] >> 4)]; }
  get cr() { return (this.regs[R.MODEM_CONFIG_1] >> 1) & 7; }
  get implicit() { return !!(this.regs[R.MODEM_CONFIG_1] & 1); }
  get crcOn() { return !!(this.regs[R.MODEM_CONFIG_2] & 0x04); }
  get preamble() { return (this.regs[R.PREAMBLE_MSB] << 8) | this.regs[R.PREAMBLE_LSB]; }
  get ldro() { return !!(this.regs[R.MODEM_CONFIG_3] & 0x08); }
  get tSym() { return Math.pow(2, this.sf) / this.bw; }
  get symbTimeout() { return ((this.regs[R.MODEM_CONFIG_2] & 3) << 8) | this.regs[R.SYMB_TIMEOUT_LSB]; }
  get paBoost() { return !!(this.regs[R.PA_CONFIG] & 0x80); }
  get txDbm() {
    const out = this.regs[R.PA_CONFIG] & 0x0f;
    if (this.paBoost) return (this.regs[R.PA_DAC] & 7) === 7 ? 20 - (15 - out) : 17 - (15 - out);
    const pmax = 10.8 + 0.6 * ((this.regs[R.PA_CONFIG] >> 4) & 7);
    return pmax - (15 - out);
  }
  get lnaBoost() { return (this.regs[R.LNA] & 3) === 3; }
  phy() {
    return { freq: this.freq, sf: this.sf, bw: this.bw, cr: this.cr, crc: this.crcOn, implicit: this.implicit,
             preamble: this.preamble, ldro: this.ldro, sync: this.regs[R.SYNC_WORD], iq: this.regs[R.INVERTIQ] === 0x66 };
  }

  /** Supply current (mA) in the present state. */
  currentMa() {
    if (this.inReset) return 0.0002;
    switch (this.mode) {
      case MODE.SLEEP: return SX_CURRENT.sleep;
      case MODE.STDBY: return SX_CURRENT.standby;
      case MODE.TX: return txCurrentMa(this.txDbm, this.paBoost);
      case MODE.RX_CONT: case MODE.RX_SINGLE: case MODE.CAD: return SX_CURRENT.rx - (this.lnaBoost ? 0 : 0.9);
      default: return SX_CURRENT.fs;
    }
  }

  // ------------------------------------------------------------- pins / SPI
  setReset(level, t) {
    if (!level && !this.inReset) { this.process(t); this.abortActivity(t, 'reset'); this.inReset = true; }
    else if (level && this.inReset) { this.powerOnReset(); this.setModeInternal(MODE.STDBY, false, t); }
  }

  setNss(level, t) {
    if (this.nss === level) return;
    this.nss = level;
    this.spi = level ? null : { first: true, addr: 0, write: false };
    if (!level) this.process(t);
  }

  xfer(v, t) {
    if (!this.connected || this.inReset || this.nss || !this.spi) return 0x00;
    const s = this.spi;
    if (s.first) {
      s.first = false;
      s.addr = v & 0x7f;
      s.write = !!(v & 0x80);
      return 0x00;
    }
    let out = 0;
    if (s.write) this.writeReg(s.addr, v, t);
    else out = this.readReg(s.addr, t);
    if (s.addr !== R.FIFO) s.addr = (s.addr + 1) & 0x7f;
    return out;
  }

  readReg(a, t) {
    this.process(t);
    switch (a) {
      case R.FIFO: {
        const v = this.fifo[this.regs[R.FIFO_ADDR_PTR]];
        this.regs[R.FIFO_ADDR_PTR] = (this.regs[R.FIFO_ADDR_PTR] + 1) & 0xff;
        return v;
      }
      case R.OP_MODE: return (this.lora ? 0x80 : 0) | (this.regs[R.OP_MODE] & 0x78) | this.mode;
      case R.RSSI: return this.currentRssiReg(t);
      case R.RSSI_WIDEBAND: return this.dev.rng.u32() & 0xff;
      case R.MODEM_STAT: return this.lock ? 0x0b : (this.mode === MODE.RX_CONT || this.mode === MODE.RX_SINGLE ? 0x00 : 0x10);
      default: return this.regs[a];
    }
  }

  writeReg(a, v, t) {
    this.process(t);
    switch (a) {
      case R.FIFO:
        this.fifo[this.regs[R.FIFO_ADDR_PTR]] = v;
        this.regs[R.FIFO_ADDR_PTR] = (this.regs[R.FIFO_ADDR_PTR] + 1) & 0xff;
        return;
      case R.OP_MODE: {
        const newMode = v & 7;
        // LongRangeMode only changes in (or into) sleep, as the datasheet requires
        const lora = (this.mode === MODE.SLEEP || newMode === MODE.SLEEP) ? !!(v & 0x80) : this.lora;
        this.regs[R.OP_MODE] = v;
        this.setModeInternal(newMode, lora, t);
        return;
      }
      case R.IRQ_FLAGS: this.regs[R.IRQ_FLAGS] &= ~v; return;
      case R.VERSION: case R.RX_NB_BYTES: case R.PKT_RSSI: case R.PKT_SNR: case R.RSSI: case R.FIFO_RX_CURRENT:
      case R.MODEM_STAT: case R.FEI_MSB: case R.FEI_MID: case R.FEI_LSB: case R.RSSI_WIDEBAND:
        return; // read-only
      default: this.regs[a] = v;
    }
  }

  // ------------------------------------------------------------- modes
  setModeInternal(mode, lora, t) {
    // a frame that was complete before this write is received, not aborted
    if (this.lock && this.lock.tx.t1 <= t && (this.mode === MODE.RX_CONT || this.mode === MODE.RX_SINGLE)) this.finishFrame();
    const prev = this.mode;
    if (prev === MODE.TX && mode !== MODE.TX && this.tx) this.abortActivity(t, 'tx-aborted');
    if ((prev === MODE.RX_CONT || prev === MODE.RX_SINGLE) && mode !== prev && this.lock) this.abortActivity(t, 'rx-aborted');
    this.mode = mode;
    this.lora = lora;
    this.modeSince = t;
    this.history.push({ t, mode, lora });
    if (this.history.length > 400) this.history.splice(0, 200);
    if (!lora) return;
    if (mode === MODE.TX && prev !== MODE.TX) this.startTx(t, prev);
    if ((mode === MODE.RX_CONT || mode === MODE.RX_SINGLE) && mode !== prev) {
      this.rxArmedAt = t + (prev === MODE.SLEEP ? 250e-6 : 71e-6);  // oscillator / PLL start-up (TS_OSC, TS_RE)
      this.rxScannedTo = this.rxArmedAt;
      this.rxDeadline = mode === MODE.RX_SINGLE ? this.rxArmedAt + this.symbTimeout * this.tSym : Infinity;
      this.lock = null;
    }
  }

  modeAt(t) {
    let m = { mode: MODE.STDBY, lora: true };
    for (const h of this.history) { if (h.t <= t) m = h; else break; }
    return m;
  }

  abortActivity(t, why) {
    if (this.tx && why !== 'rx-aborted') {
      this.tx.t1 = Math.min(this.tx.t1, t);
      this.tx.aborted = true;
      this.tx = null;
    }
    if (this.lock && why !== 'tx-aborted') {
      this.stats.rxAbort++;
      this.channel.emit({ type: 'rx', t, rx: this.dev.id, tx: this.lock.tx, ok: false, reason: 'receiver left RX mode mid-frame', rssi: this.lock.s });
      this.lock.tx.receptions.push({ rx: this.dev.id, ok: false, reason: 'aborted' });
      this.lock = null;
    }
  }

  startTx(t, prev) {
    const len = this.regs[R.PAYLOAD_LENGTH];
    const base = this.regs[R.FIFO_TX_BASE];
    const payload = new Uint8Array(len);
    for (let i = 0; i < len; i++) payload[i] = this.fifo[(base + i) & 0xff];
    const phy = this.phy();
    const toa = timeOnAir(phy, len);
    const t0 = t + (prev === MODE.SLEEP ? 250e-6 : 0) + 60e-6;  // TS_TR: PLL lock + PA ramp
    this.stats.tx++;
    const pos = this.dev.antennaPos(t0);
    this.tx = this.channel.transmit(Object.assign(phy, {
      src: this.dev.id, srcName: this.dev.name, t0, t1: t0 + toa.total, toa: toa.total, tSym: toa.tSym,
      payload, eirpDbm: this.txDbm + ANTENNA_GAIN_DBI - FEEDER_LOSS_DB - (pos.antennaLossDb || 0), txDbm: this.txDbm, ppm: this.ppm, pos,
    }));
  }

  // ------------------------------------------------------------- time
  /** Advance the modem to device time t (s). Reception never runs past the world's horizon. */
  process(t) {
    if (this.inReset || !this.lora) return;
    if (this.mode === MODE.TX && this.tx && t >= this.tx.t1) {
      this.regs[R.IRQ_FLAGS] |= IRQ.TX_DONE;
      const done = this.tx.t1;
      this.tx = null;
      this.mode = MODE.STDBY;
      this.modeSince = done;
      this.history.push({ t: done, mode: MODE.STDBY, lora: true });
    }
    if (this.mode !== MODE.RX_CONT && this.mode !== MODE.RX_SINGLE) return;
    const H = Math.min(t, this.world.horizon(this.dev));
    for (let guard = 0; guard < 64; guard++) {
      if (this.lock) {
        if (this.lock.tx.t1 > H) return;
        this.finishFrame();
        if (this.mode !== MODE.RX_CONT) return;
        continue;
      }
      const next = this.nextDetectable(H);
      if (this.mode === MODE.RX_SINGLE && (!next || next.at > this.rxDeadline) && this.rxDeadline <= H) {
        this.regs[R.IRQ_FLAGS] |= IRQ.RX_TIMEOUT;
        this.stats.rxTimeout++;
        this.mode = MODE.STDBY;
        this.modeSince = this.rxDeadline;
        this.history.push({ t: this.rxDeadline, mode: MODE.STDBY, lora: true });
        return;
      }
      if (!next) { this.rxScannedTo = Math.max(this.rxScannedTo, H); return; }
      this.rxScannedTo = next.at;
      if (this.tryDetect(next.tx, next.at)) continue;
    }
  }

  compatible(tx) {
    const p = this.phy();
    return tx.sf === p.sf && tx.bw === p.bw && tx.sync === p.sync && tx.iq === p.iq &&
      Math.abs(tx.freq * (1 + tx.ppm * 1e-6) - p.freq * (1 + this.ppm * 1e-6)) < p.bw / 4;
  }

  /** Earliest frame whose preamble this receiver can catch after rxScannedTo. */
  nextDetectable(H) {
    let best = null;
    const tSym = this.tSym;
    for (const tx of this.channel.txs) {
      if (tx.src === this.dev.id || tx.t1 <= this.rxArmedAt || tx.t0 > H) continue;
      if (tx.receptions.some(r => r.rx === this.dev.id)) continue;
      // preamble detection needs ~5 symbols; arriving later than (preamble - 3) symbols in is too late
      const start = Math.max(tx.t0, this.rxArmedAt);
      if (start > tx.t0 + (tx.preamble - 3) * tx.tSym) continue;
      const at = start + 5 * tSym;
      if (at <= this.rxScannedTo || at > H) continue;
      if (!this.compatible(tx)) continue;
      if (!best || at < best.at) best = { tx, at };
    }
    return best;
  }

  tryDetect(tx, at) {
    const me = this.dev.antennaPos(tx.t0);
    const s = this.channel.receivedDbm(tx, this.dev.id, me, true);
    const n = noiseFloorDbm(this.bw, this.channel.params.extraNoise);
    let iSum = 0;
    for (const o of this.channel.overlapping(tx.t0, at, tx.id)) {
      if (o.src === this.dev.id) continue;
      iSum += lin(this.channel.receivedDbm(o, this.dev.id, me, true));
    }
    const sinr = s - dB(lin(n) + iSum);
    const margin = sinr - SNR_LIMIT_DB[this.sf] + 1.5;    // the preamble correlator works slightly below the payload limit
    const p = Channel.frameErrorProb(margin, 8);
    if (this.dev.rng.uniform() < p) {
      tx.receptions.push({ rx: this.dev.id, ok: false, reason: 'preamble not detected', rssi: s, snr: s - n });
      this.channel.emit({ type: 'rx', t: at, rx: this.dev.id, tx, ok: false, reason: 'preamble not detected (signal too weak)', rssi: s, snr: s - n });
      return false;
    }
    this.lock = { tx, s, n, at };
    return true;
  }

  finishFrame() {
    const { tx, s, n } = this.lock;
    this.lock = null;
    const me = this.dev.antennaPos(tx.t0);
    let iSum = 0;
    const interferers = [];
    for (const o of this.channel.overlapping(tx.t0, tx.t1, tx.id)) {
      if (o.src === this.dev.id) continue;
      const overlap = Math.min(o.t1, tx.t1) - Math.max(o.t0, tx.t0);
      if (overlap < tx.tSym) continue;  // under one symbol: absorbed by the coding
      const p = this.channel.receivedDbm(o, this.dev.id, me, true);
      iSum += lin(p);
      interferers.push({ id: o.id, src: o.src, dbm: p });
    }
    const snr = s - n;
    let margin = snr - SNR_LIMIT_DB[this.sf];
    if (iSum > 0) margin = Math.min(margin, s - dB(iSum) - CAPTURE_DB);
    const len = tx.payload.length;
    const u = this.dev.rng.uniform();
    const headerLost = !tx.implicit && u < Channel.frameErrorProb(margin + 2.5, 8);
    const corrupted = tx.aborted || u < Channel.frameErrorProb(margin, len);
    const at = tx.t1;
    let reason = 'ok';
    if (tx.aborted) reason = 'transmitter stopped mid-frame';
    else if (corrupted) reason = interferers.length ? `collision with ${interferers.length} frame(s)` : 'bit errors (low SNR)';

    if (headerLost) {
      tx.receptions.push({ rx: this.dev.id, ok: false, reason: 'header lost: ' + reason, rssi: s, snr });
      this.channel.emit({ type: 'rx', t: at, rx: this.dev.id, tx, ok: false, reason: 'header lost: ' + reason, rssi: s, snr, interferers });
      if (this.mode === MODE.RX_SINGLE) {
        this.regs[R.IRQ_FLAGS] |= IRQ.RX_TIMEOUT;
        this.mode = MODE.STDBY;
        this.history.push({ t: at, mode: MODE.STDBY, lora: true });
      } else {
        this.rxArmedAt = at;
        this.rxScannedTo = at;
      }
      return;
    }

    // payload into the FIFO at the RX base address, as the modem does
    const base = this.regs[R.FIFO_RX_BASE];
    const bytes = tx.payload.slice();
    if (corrupted) {
      const flips = 1 + Math.floor(this.dev.rng.uniform() * 6);
      for (let k = 0; k < flips; k++) bytes[Math.floor(this.dev.rng.uniform() * bytes.length)] ^= 1 << Math.floor(this.dev.rng.uniform() * 8);
    }
    for (let i = 0; i < bytes.length; i++) this.fifo[(base + i) & 0xff] = bytes[i];
    this.regs[R.RX_NB_BYTES] = bytes.length;
    this.regs[R.FIFO_RX_CURRENT] = base;
    this.regs[R.FIFO_RX_BYTE_ADDR] = (base + bytes.length) & 0xff;

    const reportedSnr = Math.min(12.5, snr + this.dev.rng.gauss() * 0.4);
    const total = dB(lin(s) + lin(n) + iSum);
    this.regs[R.PKT_SNR] = Math.max(-128, Math.min(127, Math.round(reportedSnr * 4))) & 0xff;
    this.regs[R.PKT_RSSI] = Math.max(0, Math.min(255, Math.round(total + 164)));
    const fErr = tx.freq * (tx.ppm - this.ppm) * 1e-6;
    let fei = Math.round(fErr / ((Math.pow(2, 24) / 32e6) * (this.bw / 500e3))) & 0xfffff;
    this.regs[R.FEI_MSB] = (fei >> 16) & 0x0f;
    this.regs[R.FEI_MID] = (fei >> 8) & 0xff;
    this.regs[R.FEI_LSB] = fei & 0xff;

    const crcFail = corrupted && tx.crc;
    this.regs[R.IRQ_FLAGS] |= IRQ.RX_DONE | IRQ.VALID_HEADER | (crcFail ? IRQ.CRC_ERROR : 0);
    if (crcFail) this.stats.rxCrc++; else this.stats.rxOk++;
    const ok = !corrupted;
    const pktRssi = this.regs[R.PKT_RSSI] - 164;
    this.lastPacket = { t: at, len: bytes.length, rssi: pktRssi, snr: (this.regs[R.PKT_SNR] << 24 >> 24) / 4, ok, crcFail, from: tx.srcName, fErr };
    tx.receptions.push({ rx: this.dev.id, ok, reason, rssi: s, snr, crcFail });
    this.channel.emit({ type: 'rx', t: at, rx: this.dev.id, tx, ok, crcFail, reason: ok ? 'received' : (crcFail ? 'CRC error: ' : 'delivered corrupted (CRC off): ') + reason, rssi: s, snr, regRssi: pktRssi, interferers });

    if (this.mode === MODE.RX_SINGLE) {
      this.mode = MODE.STDBY;
      this.history.push({ t: at, mode: MODE.STDBY, lora: true });
    } else {
      this.rxArmedAt = at;
      this.rxScannedTo = at;
    }
  }

  currentRssiReg(t) {
    if (this.mode !== MODE.RX_CONT && this.mode !== MODE.RX_SINGLE) return this.regs[R.RSSI];
    const me = this.dev.antennaPos(t);
    let p = lin(noiseFloorDbm(this.bw, this.channel.params.extraNoise));
    for (const o of this.channel.txs) {
      if (o.t0 <= t && o.t1 > t && o.src !== this.dev.id) p += lin(this.channel.receivedDbm(o, this.dev.id, me, false));
    }
    const v = Math.max(0, Math.min(255, Math.round(dB(p) + 164 + this.dev.rng.gauss())));
    this.regs[R.RSSI] = v;
    return v;
  }
}
