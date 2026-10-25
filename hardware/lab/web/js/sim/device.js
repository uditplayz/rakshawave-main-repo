// One RakshaWave board: ESP32-C3 running the real firmware (WebAssembly build
// of firmware/esp32/main.ino) wired to the peripheral models exactly as in the
// schematic. The ESP32's clock is virtual: every bus transfer and delay()
// costs the time it takes on the real chip, so the firmware sees realistic
// timing (I2C at 100/400 kHz, SPI at 8 MHz, UARTs at their baud rates, LoRa
// frames that block for their full time on air).
import { Rng } from './rng.js';
import { SX1278, IRQ } from './sx1278.js';
import { MPU6050 } from './mpu6050.js';
import { SSD1306 } from './ssd1306.js';
import { GpsModule } from './gps.js';
import { Vehicle } from './vehicle.js';
import { PowerModel, ESP32C3_ACTIVE_MA, POWER_LED_MA, LED_MA, BUZZER_MA } from './power.js';

// Board wiring (v2v 1.2 schematic, firmware header).
export const PINS = { SDA: 5, SCL: 6, SCK: 18, MISO: 19, MOSI: 7, NSS: 4, RST: 0, DIO0: 8, GPS_RX: 2, GPS_TX: 1, BUZZER: 9, LED: 10 };
const ROM_BANNER = boot => [
  'ESP-ROM:esp32c3-api1-20210207',
  'Build:Feb  7 2021',
  `rst:0x1 (POWERON),boot:${boot ? '0x4 (DOWNLOAD(USB/UART0/1))' : '0xc (SPI_FAST_FLASH_BOOT)'}`,
].concat(boot ? ['waiting for download'] : ['SPIWP:0xee', 'mode:DIO, clock div:1', 'load:0x3fcd5820,len:0x458', 'load:0x403cc710,len:0x814', 'load:0x403ce710,len:0x2880', 'entry 0x403cc710']);

const I2C_OVERHEAD_S = 25e-6;   // ESP-IDF i2c driver per transaction
const QUANTUM_S = 0.002;        // a board may run at most this far ahead of the slowest other board
const ASYNC_STACK = 16384;      // bytes for the asyncify call-stack image
const SPI_OVERHEAD_S = 1.2e-6;  // Arduino SPI.transfer per byte
const HAL_CALL_S = 0.2e-6;      // a few dozen instructions at 160 MHz

export class Device {
  constructor(world, { id, name, seed, x = 0, lane = 0, speed = 0, antenna = 'dash' }) {
    this.world = world;
    this.id = id;
    this.name = name;
    this.rng = new Rng(seed);
    this.mac = [0x34, 0x85, 0x18, this.rng.u32() & 0xff, this.rng.u32() & 0xff, this.rng.u32() & 0xff];
    this.firmwareId = 'RW-' + this.mac.slice(3).map(b => b.toString(16).toUpperCase().padStart(2, '0')).join('');
    this.vehicle = new Vehicle(world.road, { x, lane, speed });
    this.antenna = antenna;
    this.driverReacts = true;    // the driver brakes when the buzzer sounds
    this.sx = new SX1278(this);
    this.mpu = new MPU6050(this, seed * 7 + 1);
    this.oled = new SSD1306(this);
    this.gps = new GpsModule(this, seed * 13 + 5);
    this.power = new PowerModel();
    this.t = 0;
    this.on = false;
    this.state = 'off';          // off | rom | running | download | halted
    this.console = [];           // [{t, text}]
    this.consoleLine = '';
    this.listeners = [];
    this.buttons = { boot: false, reset: false };
    this.pinLog = [];            // [{t, pin, v}] LED / buzzer edges
    this.loops = 0;
    this.lastLoopDur = 0;
    this.maxLoopDur = 0;
    this.uart0Rx = [];           // bytes from the "Raspberry Pi" (typed lines)
    this.uart0Busy = 0;
    this.uart1Rx = [];
    this.uart1Overflow = 0;
    this.uartCfg = {};
    this.i2c = { hz: 100000, sda: -1, scl: -1 };
    this.spi = { hz: 1e6, ok: false };
    this.imu = { last: null };
    this.oledFraction = 0;
    this.oledVersion = -1;
    this.lastPowerT = 0;
    // timing spread between real boards: FreeRTOS tick phase and the 40 MHz crystal (+-10 ppm)
    this.tickPhase = this.rng.uniform() * 1e-3;
    this.clockPpm = this.rng.range(-10, 10);
  }

  // ------------------------------------------------------------- geometry
  antennaPos(t) {
    const v = this.vehicle;
    const roof = this.antenna === 'roof';
    // in the cabin the car body costs ~5 dB at 433 MHz; an unplugged whip leaves only the SMA jack (~30 dB worse)
    return { x: v.xAt(t) + v.p.mount.x, y: v.y + v.p.mount.y, h: roof ? 1.55 : 1.1, antennaLossDb: (roof ? 0 : 5) + (this.loraAntennaOff ? 30 : 0) };
  }
  velocityAt(t) { return { x: this.vehicle.speedAt(t), y: 0 }; }
  motionAt(t) { return this.vehicle.motionAt(t); }

  // ------------------------------------------------------------- power / reset
  async powerOn(module, t) {
    this.module = module;
    this.t = Math.max(this.t, t);
    this.lastPowerT = this.t;
    this.on = true;
    this.sx.powerOnReset();
    this.mpu.powerOnReset();
    this.oled.powerOnReset();
    this.gps.powerOn(this.t);
    await this.boot();
  }

  powerOff() {
    this.on = false;
    this.state = 'off';
    this.instance = null;
    this.pins = {};
    this.log('--- power off ---');
  }

  /** EN pin pulse (RST button): only the ESP32 restarts; the other chips keep their state. */
  async resetChip() {
    if (!this.on) return;
    this.sx.process(this.t);
    await this.boot();
  }

  async boot() {
    this.pins = {};
    this.instance = null;
    this.booted = false;
    this.uartCfg = {};
    this.uart1Rx = [];
    this.i2c = { hz: 100000, sda: -1, scl: -1 };
    const download = this.buttons.boot;   // IO9 strap sampled at reset
    for (const l of ROM_BANNER(download)) this.log(l);
    if (download) { this.state = 'download'; return; }
    this.state = 'rom';
    this.romUntil = this.t + 0.29 + this.rng.uniform() * 0.04;   // ROM + 2nd-stage bootloader + app image load
    const imports = { hal: this.halImports() };
    const { instance } = await WebAssembly.instantiate(this.module, imports).then(r => (r.instance ? r : { instance: r }));
    this.instance = instance;
    this.ex = instance.exports;
    this.mem = instance.exports.memory;
    this.suspendedIn = null;
    this.unwinding = this.rewinding = false;
    // firmware.wasm is built with Binaryen asyncify: delay() and yield() can suspend the
    // firmware mid-function so the boards interleave in time (see runSlice)
    this.canSuspend = !!this.ex.asyncify_start_unwind;
    if (this.canSuspend) { this.ex._initialize(); this.initialized = true; this.asyncData = this.ex.malloc(8 + ASYNC_STACK); }
  }

  log(text) {
    const e = { t: this.t, text };
    this.console.push(e);
    if (this.console.length > 600) this.console.splice(0, 200);
    for (const l of this.listeners) l({ type: 'console', dev: this, e });
  }

  // ------------------------------------------------------------- execution
  /** Run one step of the firmware: setup() the first time, loop() after that. */
  runSlice(targetT) {
    if (!this.on || this.state === 'download' || this.state === 'halted' || this.state === 'off') {
      this.advance(Math.max(0, targetT - this.t));
      return;
    }
    if (this.state === 'rom') {
      if (!this.instance || this.t < this.romUntil) { this.advance(Math.max(0, Math.min(targetT, this.romUntil) - this.t) || 1e-4); return; }
      this.state = 'setup';
      if (!this.initialized) this.ex._initialize();
      this.bootT = this.t;
    }
    this.yieldAt = Math.min(targetT, this.world.horizon(this) + QUANTUM_S);
    const entry = this.state === 'setup' ? 'fw_setup' : 'fw_loop';
    if (entry === 'fw_loop' && !this.suspendedIn) this.loopStart = this.t;
    let done;
    try {
      done = this.call(entry);
    } catch (err) {
      this.state = 'halted';
      this.suspendedIn = null;
      this.log(`Guru Meditation Error: ${err.message}`);
      return;
    }
    if (!done) return;
    if (entry === 'fw_setup') { this.state = 'running'; return; }
    this.loops++;
    this.lastLoopDur = this.t - this.loopStart;
    if (this.lastLoopDur > this.maxLoopDur) this.maxLoopDur = this.lastLoopDur;
  }

  /** Run (or resume) an exported firmware function. False if it suspended in delay(). */
  call(name) {
    const ex = this.ex;
    if (this.suspendedIn) {
      name = this.suspendedIn;
      ex.asyncify_start_rewind(this.asyncData);
      this.rewinding = true;
    }
    ex[name]();
    if (this.unwinding) {
      ex.asyncify_stop_unwind();
      this.unwinding = false;
      this.suspendedIn = name;
      return false;
    }
    this.suspendedIn = null;
    return true;
  }

  advance(dt) {
    this.t += dt;
    this.integratePower();
  }

  currents() {
    if (this.oled.version !== this.oledVersion) { this.oledVersion = this.oled.version; this.oledFraction = this.oled.litFraction(); }
    const p = this.pins || {};
    const run = this.on && this.state !== 'off' && this.state !== 'halted';
    return {
      esp32: run ? ESP32C3_ACTIVE_MA : 0,
      powerLed: this.on ? POWER_LED_MA : 0,
      lora: this.on ? this.sx.currentMa() : 0,
      gps: this.on ? this.gps.currentMa() : 0,
      imu: this.on ? this.mpu.currentMa() : 0,
      oled: this.on ? this.oled.currentMa(this.oledFraction) : 0,
      buzzer: this.on && this.buzzerOn() ? BUZZER_MA : 0,
      led: this.on && this.ledOn() ? LED_MA : 0,
    };
  }

  integratePower() {
    const dt = this.t - this.lastPowerT;
    if (dt < 0.002 && dt >= 0) return;
    this.lastPowerT = this.t;
    if (this.on) this.power.integrate(dt, this.currents());
  }

  // pins as seen on the board (both outputs are active low)
  pinLevel(pin) {
    const p = this.pins?.[pin];
    if (pin === PINS.BUZZER && this.buttons.boot) return 0;   // BOOT shorts IO9 to GND
    if (!p || p.mode !== 3) return 1;                         // input: pulled up (buzzer coil / LED to 3V3)
    return p.v;
  }
  ledOn() { return this.on && this.pinLevel(PINS.LED) === 0 && this.pins?.[PINS.LED]?.mode === 3; }
  buzzerOn() { return this.on && this.pinLevel(PINS.BUZZER) === 0; }

  // ------------------------------------------------------------- HAL
  halImports() {
    const dev = this;
    const u8 = (ptr, len) => new Uint8Array(dev.mem.buffer, ptr, len);
    const cost = s => dev.advance(s);
    return {
      now_us: () => { cost(HAL_CALL_S); return (dev.t - dev.bootT) * 1e6 * (1 + dev.clockPpm * 1e-6); },
      delay_us: us => {
        if (dev.rewinding) { dev.ex.asyncify_stop_rewind(); dev.rewinding = false; return; }  // resumed: the time was already spent
        if (us >= 1000) {
          // delay(ms) is vTaskDelay(ms ticks): the task wakes on the ms-th 1 kHz tick from now
          const n = Math.round(us / 1000);
          const k = Math.ceil((dev.t - dev.tickPhase) / 1e-3 + 1e-9);
          cost(dev.tickPhase + (k + n - 1) * 1e-3 - dev.t);
        } else {
          cost(us / 1e6);   // delayMicroseconds / yield: busy wait
        }
        if (dev.canSuspend && dev.t >= dev.yieldAt) {
          const h = new Int32Array(dev.mem.buffer, dev.asyncData, 2);
          h[0] = dev.asyncData + 8;
          h[1] = dev.asyncData + 8 + ASYNC_STACK;
          dev.ex.asyncify_start_unwind(dev.asyncData);
          dev.unwinding = true;
        }
      },
      pin_mode: (pin, mode) => { cost(HAL_CALL_S); dev.pins[pin] = Object.assign(dev.pins[pin] || { v: 1 }, { mode }); },
      pin_write: (pin, v) => {
        cost(HAL_CALL_S);
        const p = dev.pins[pin] || (dev.pins[pin] = { mode: 3, v: 1 });
        const old = p.v;
        p.v = v ? 1 : 0;
        if (pin === PINS.NSS) dev.sx.setNss(p.v, dev.t);
        if (pin === PINS.RST) dev.sx.setReset(p.v, dev.t);
        if (pin === PINS.BUZZER && old === 1 && p.v === 0 && dev.driverReacts) dev.vehicle.driverWarned(dev.t);
        if ((pin === PINS.LED || pin === PINS.BUZZER) && old !== p.v) {
          dev.pinLog.push({ t: dev.t, pin, v: p.v });
          if (dev.pinLog.length > 300) dev.pinLog.splice(0, 100);
          for (const l of dev.listeners) l({ type: 'pin', dev, pin, v: p.v });
        }
      },
      pin_read: pin => {
        cost(HAL_CALL_S);
        if (pin === PINS.DIO0) { dev.sx.process(dev.t); return (dev.sx.regs[0x12] & (IRQ.RX_DONE | IRQ.TX_DONE)) ? 1 : 0; }
        return dev.pinLevel(pin);
      },
      uart_begin: (port, baud, rx, tx) => {
        cost(HAL_CALL_S);
        dev.uartCfg[port] = { baud, rx, tx };
        if (port === 1 && (rx !== PINS.GPS_RX)) dev.log(`[lab] UART1 RX on IO${rx}: the GPS TX line is wired to IO${PINS.GPS_RX}, no data will arrive`);
      },
      uart_avail: port => {
        cost(HAL_CALL_S);
        if (port === 1) { dev.pullGps(); return dev.uart1Rx.length; }
        return dev.uart0Rx.filter(b => b.t <= dev.t).length;
      },
      uart_read: port => {
        cost(HAL_CALL_S);
        if (port === 1) { dev.pullGps(); return dev.uart1Rx.length ? dev.uart1Rx.shift() : -1; }
        const i = dev.uart0Rx.findIndex(b => b.t <= dev.t);
        return i < 0 ? -1 : dev.uart0Rx.splice(i, 1)[0].b;
      },
      uart_peek: port => {
        if (port === 1) { dev.pullGps(); return dev.uart1Rx.length ? dev.uart1Rx[0] : -1; }
        const b = dev.uart0Rx.find(b => b.t <= dev.t);
        return b ? b.b : -1;
      },
      uart_write: (port, ptr, len) => {
        const bytes = u8(ptr, len);
        if (port !== 0) { cost(HAL_CALL_S); return; }
        // 115200 8N1 with a 128-byte hardware FIFO: Serial.print blocks once it is full
        const tb = 10 / 115200;
        const start = Math.max(dev.t, dev.uart0Busy);
        dev.uart0Busy = start + len * tb;
        const backlog = dev.uart0Busy - dev.t - 128 * tb;
        cost(HAL_CALL_S + Math.max(0, backlog));
        for (const b of bytes) {
          if (b === 10) { dev.log(dev.consoleLine); dev.consoleLine = ''; }
          else if (b !== 13) dev.consoleLine += String.fromCharCode(b);
        }
      },
      i2c_begin: (sda, scl, hz) => { cost(HAL_CALL_S); dev.i2c = { sda, scl, hz: hz || 100000 }; },
      i2c_clock: hz => { dev.i2c.hz = hz; },
      i2c_tx: (addr, ptr, len, stop) => {
        const bits = (1 + len) * 9 + (stop ? 2 : 1);
        cost(bits / dev.i2c.hz + I2C_OVERHEAD_S);
        const target = dev.i2cTarget(addr);
        if (!target) return 2;
        const ok = target.i2cWrite(u8(ptr, len).slice(), dev.t);
        return ok ? 0 : 2;
      },
      i2c_rx: (addr, ptr, len, stop) => {
        const bits = (1 + len) * 9 + (stop ? 2 : 1);
        cost(bits / dev.i2c.hz + I2C_OVERHEAD_S);
        const target = dev.i2cTarget(addr);
        if (!target) return 0;
        const data = target.i2cRead(len, dev.t);
        if (!data) return 0;
        u8(ptr, len).set(data);
        return len;
      },
      spi_begin: (sck, miso, mosi, ss) => {
        cost(HAL_CALL_S);
        dev.spi.ok = sck === PINS.SCK && miso === PINS.MISO && mosi === PINS.MOSI;
        if (!dev.spi.ok) dev.log(`[lab] SPI on SCK${sck}/MISO${miso}/MOSI${mosi} does not match the board wiring`);
      },
      spi_clock: hz => { dev.spi.hz = hz; },
      spi_xfer: v => {
        cost(8 / dev.spi.hz + SPI_OVERHEAD_S);
        return dev.spi.ok ? dev.sx.xfer(v, dev.t) : 0xff;
      },
      rand32: () => dev.rng.u32(),
      mac_lo: () => (dev.mac[0] | dev.mac[1] << 8 | dev.mac[2] << 16 | dev.mac[3] << 24) >>> 0,
      mac_hi: () => dev.mac[4] | dev.mac[5] << 8,
    };
  }

  i2cTarget(addr) {
    if (this.i2c.sda !== PINS.SDA || this.i2c.scl !== PINS.SCL) return null;
    if (addr === this.mpu.addr && this.mpu.connected) return this.mpu;
    if (addr === this.oled.addr && this.oled.connected) return this.oled;
    return null;
  }

  pullGps() {
    if (this.uartCfg[1]?.rx !== PINS.GPS_RX) return;
    for (const b of this.gps.take(this.t)) {
      if (this.uart1Rx.length >= 256) { this.uart1Overflow++; continue; }  // arduino-esp32 default RX buffer
      this.uart1Rx.push(b);
    }
  }

  /** A line from the Raspberry Pi over USB (115200 baud). */
  sendSerial(line) {
    const tb = 10 / 115200;
    let t = Math.max(this.t, this.uart0Rx.length ? this.uart0Rx[this.uart0Rx.length - 1].t : 0);
    for (const ch of line + '\n') { t += tb; this.uart0Rx.push({ t, b: ch.charCodeAt(0) & 0xff }); }
  }
}
