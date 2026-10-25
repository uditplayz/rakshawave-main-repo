// Solomon SSD1306 OLED controller (0.91" 128x32 module, I2C 0x3C).
//
// Rebuilds the picture from the I2C byte stream alone: control bytes,
// command decoding with parameters, horizontal/vertical/page addressing into
// the 128x64 GDDRAM, segment remap / COM scan direction, multiplex ratio,
// display on/off, charge pump, contrast and inversion.
const PARAMS = { 0x81: 1, 0x20: 1, 0x21: 2, 0x22: 2, 0xa8: 1, 0xd3: 1, 0xd5: 1, 0xd9: 1, 0xda: 1, 0xdb: 1, 0x8d: 1,
  0x26: 6, 0x27: 6, 0x29: 5, 0x2a: 5, 0xa3: 2 };

export class SSD1306 {
  constructor(dev) {
    this.dev = dev;
    this.addr = 0x3c;
    this.connected = true;
    this.powerOnReset();
  }

  powerOnReset() {
    this.ram = new Uint8Array(128 * 8);
    this.on = false;
    this.chargePump = false;
    this.contrast = 0x7f;
    this.invert = false;
    this.allOn = false;
    this.segRemap = false;
    this.comScanDec = false;
    this.mux = 63;
    this.offset = 0;
    this.startLine = 0;
    this.memMode = 2;   // page addressing after reset
    this.colStart = 0; this.colEnd = 127; this.pageStart = 0; this.pageEnd = 7;
    this.col = 0; this.page = 0;
    this.cmd = null;    // command waiting for parameters
    this.version = 0;   // bumps whenever the visible picture may have changed
  }

  get lit() { return this.on && this.chargePump; }

  i2cWrite(bytes) {
    if (!this.connected) return false;
    let i = 0;
    while (i < bytes.length) {
      const ctrl = bytes[i++];
      const co = ctrl & 0x80, data = ctrl & 0x40;
      if (co) {          // one byte, then another control byte
        if (i < bytes.length) data ? this.data(bytes[i++]) : this.command(bytes[i++]);
        continue;
      }
      while (i < bytes.length) data ? this.data(bytes[i++]) : this.command(bytes[i++]);
    }
    this.version++;
    return true;
  }

  i2cRead(n) { return this.connected ? new Uint8Array(n).fill(this.on ? 0x03 : 0x43) : null; }  // status byte

  command(b) {
    if (this.cmd) {
      this.cmd.args.push(b);
      if (this.cmd.args.length < this.cmd.need) return;
      const { op, args } = this.cmd;
      this.cmd = null;
      switch (op) {
        case 0x81: this.contrast = args[0]; break;
        case 0x20: this.memMode = args[0] & 3; break;
        case 0x21: this.colStart = args[0] & 127; this.colEnd = args[1] & 127; this.col = this.colStart; break;
        case 0x22: this.pageStart = args[0] & 7; this.pageEnd = args[1] & 7; this.page = this.pageStart; break;
        case 0xa8: this.mux = Math.max(15, args[0] & 63); break;
        case 0xd3: this.offset = args[0] & 63; break;
        case 0x8d: this.chargePump = (args[0] & 0x04) !== 0; break;
      }
      return;
    }
    if (PARAMS[b]) { this.cmd = { op: b, need: PARAMS[b], args: [] }; return; }
    if (b >= 0x40 && b <= 0x7f) { this.startLine = b & 63; return; }
    if (b >= 0xb0 && b <= 0xb7) { this.page = b & 7; return; }
    if (b <= 0x0f) { this.col = (this.col & 0xf0) | b; return; }
    if (b >= 0x10 && b <= 0x1f) { this.col = (this.col & 0x0f) | ((b & 7) << 4); return; }
    switch (b) {
      case 0xae: this.on = false; break;
      case 0xaf: this.on = true; break;
      case 0xa0: this.segRemap = false; break;
      case 0xa1: this.segRemap = true; break;
      case 0xc0: this.comScanDec = false; break;
      case 0xc8: this.comScanDec = true; break;
      case 0xa6: this.invert = false; break;
      case 0xa7: this.invert = true; break;
      case 0xa4: this.allOn = false; break;
      case 0xa5: this.allOn = true; break;
    }
  }

  data(b) {
    this.ram[this.page * 128 + this.col] = b;
    if (this.memMode === 0) {          // horizontal
      if (++this.col > this.colEnd) { this.col = this.colStart; if (++this.page > this.pageEnd) this.page = this.pageStart; }
    } else if (this.memMode === 1) {   // vertical
      if (++this.page > this.pageEnd) { this.page = this.pageStart; if (++this.col > this.colEnd) this.col = this.colStart; }
    } else {                           // page
      if (++this.col > 127) this.col = 127;
    }
  }

  /** Pixel as seen on the glass of the 128x32 module (x right, y down). */
  pixel(x, y) {
    if (!this.lit) return 0;
    if (this.allOn) return 1;
    const rows = this.mux + 1;
    if (y >= rows) return 0;
    // the module's panel is mounted so A1 + C8 (Adafruit's init) shows upright
    const col = this.segRemap ? x : 127 - x;
    const com = this.comScanDec ? y : rows - 1 - y;
    const row = (com + this.startLine + this.offset) & 63;
    const v = (this.ram[(row >> 3) * 128 + col] >> (row & 7)) & 1;
    return this.invert ? v ^ 1 : v;
  }

  litFraction() {
    if (!this.lit) return 0;
    let n = 0;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 128; x++) n += this.pixel(x, y);
    return n / 4096;
  }

  /** Datasheet-style estimate: logic + charge pump, plus segment current per lit pixel. */
  currentMa(fraction) {
    if (!this.connected) return 0;
    if (!this.on) return 0.01;
    return 0.6 + (this.chargePump ? 0.4 : 0) + fraction * 22 * (0.3 + 0.7 * this.contrast / 255);
  }
}
