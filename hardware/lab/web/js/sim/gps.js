// GPS receiver module (Linx RXM-GPS-FM class): NMEA 0183 at 9600 baud, 1 Hz.
//
// Every second it emits GGA, GSA, RMC and VTG for the antenna's true position
// plus a Gauss-Markov position error (2.5 m CEP, 30 s correlation), with real
// checksums. Bytes leave the module at the UART bit rate (10 bits per byte),
// so the ESP32 sees them trickle in exactly as on the wire. Time to first fix
// depends on the start type.
import { Rng } from './rng.js';

export const GPS_CURRENT_MA = { acquisition: 25, tracking: 20 };
export const ORIGIN = { lat: 28.4595, lon: 77.0266 };  // NH-48 near Gurugram
const M_PER_DEG_LAT = 111320;

function nmeaChecksum(body) {
  let c = 0;
  for (let i = 0; i < body.length; i++) c ^= body.charCodeAt(i);
  return c.toString(16).toUpperCase().padStart(2, '0');
}
const sentence = body => `$${body}*${nmeaChecksum(body)}\r\n`;

function fmtLat(lat) {
  const a = Math.abs(lat), d = Math.floor(a), m = (a - d) * 60;
  return [String(d).padStart(2, '0') + m.toFixed(4).padStart(7, '0'), lat >= 0 ? 'N' : 'S'];
}
function fmtLon(lon) {
  const a = Math.abs(lon), d = Math.floor(a), m = (a - d) * 60;
  return [String(d).padStart(3, '0') + m.toFixed(4).padStart(7, '0'), lon >= 0 ? 'E' : 'W'];
}

export function enuToLatLon(x, y) {
  return { lat: ORIGIN.lat + y / M_PER_DEG_LAT, lon: ORIGIN.lon + x / (M_PER_DEG_LAT * Math.cos(ORIGIN.lat * Math.PI / 180)) };
}
export function latLonToEnu(lat, lon) {
  return { x: (lon - ORIGIN.lon) * M_PER_DEG_LAT * Math.cos(ORIGIN.lat * Math.PI / 180), y: (lat - ORIGIN.lat) * M_PER_DEG_LAT };
}

export class GpsModule {
  constructor(dev, seed, { ttff = 1.0 } = {}) {
    this.dev = dev;
    this.rng = new Rng(seed);
    this.ttff = ttff;           // s from power-on to first fix (hot start ~1 s, cold ~35 s)
    this.baud = 9600;
    this.connected = true;
    this.skyBlocked = false;    // fault injection: antenna covered / disconnected
    this.powerOn(0);
  }

  powerOn(t) {
    this.tOn = t;
    this.err = [this.rng.gauss() * 1.6, this.rng.gauss() * 1.6];
    this.errT = t;
    this.nextEpoch = t + 0.25 + this.rng.uniform() * 0.5;
    this.queue = [];            // [{t, byte}] bytes on the wire, in time order
    this.fix = false;
    this.sats = 0;
    this.hdop = 99.99;
    this.last = null;
  }

  currentMa() { return this.connected ? (this.fix ? GPS_CURRENT_MA.tracking : GPS_CURRENT_MA.acquisition) : 0; }

  /** Generate wire bytes up to time t. */
  run(t) {
    while (this.nextEpoch <= t) {
      this.emitEpoch(this.nextEpoch);
      this.nextEpoch += 1.0;
    }
  }

  emitEpoch(te) {
    const pos = this.dev.antennaPos(te);
    const vel = this.dev.velocityAt(te);
    // Gauss-Markov error
    const dt = te - this.errT, tau = 30, sigma = 2.1;
    const rho = Math.exp(-dt / tau);
    for (let i = 0; i < 2; i++) this.err[i] = rho * this.err[i] + Math.sqrt(1 - rho * rho) * sigma * this.rng.gauss();
    this.errT = te;
    this.fix = !this.skyBlocked && te - this.tOn >= this.ttff;
    this.sats = this.fix ? 9 + Math.round(1.5 + 1.2 * Math.sin(te / 97)) : Math.min(3, Math.floor((te - this.tOn) / 4));
    this.hdop = this.fix ? Math.max(0.7, 0.95 + 0.15 * Math.sin(te / 53) + 0.05 * this.rng.gauss()) : 99.99;
    const ll = enuToLatLon(pos.x + this.err[0], pos.y + this.err[1]);
    const speedKn = Math.hypot(vel.x, vel.y) * 1.943844 * (this.fix ? 1 : 0) + (this.fix ? Math.abs(this.rng.gauss()) * 0.05 : 0);
    const course = ((Math.atan2(vel.x, vel.y) * 180 / Math.PI) + 360) % 360;
    const utc = new Date(Date.UTC(2026, 9, 25, 6, 0, 0) + te * 1000);
    const hh = String(utc.getUTCHours()).padStart(2, '0'), mm = String(utc.getUTCMinutes()).padStart(2, '0');
    const ss = String(utc.getUTCSeconds()).padStart(2, '0') + '.000';
    const date = String(utc.getUTCDate()).padStart(2, '0') + String(utc.getUTCMonth() + 1).padStart(2, '0') + String(utc.getUTCFullYear() % 100).padStart(2, '0');
    const [la, ns] = fmtLat(ll.lat), [lo, ew] = fmtLon(ll.lon);
    const alt = (217.0 + pos.h).toFixed(1);
    let out = '';
    if (this.fix) {
      out += sentence(`GPGGA,${hh}${mm}${ss},${la},${ns},${lo},${ew},1,${String(this.sats).padStart(2, '0')},${this.hdop.toFixed(2)},${alt},M,-35.4,M,,`);
      out += sentence(`GPGSA,A,3,03,06,09,12,17,19,22,25,28,,,,${(this.hdop * 1.6).toFixed(2)},${this.hdop.toFixed(2)},${(this.hdop * 1.3).toFixed(2)}`);
      out += sentence(`GPRMC,${hh}${mm}${ss},A,${la},${ns},${lo},${ew},${speedKn.toFixed(2)},${course.toFixed(2)},${date},,,A`);
      out += sentence(`GPVTG,${course.toFixed(2)},T,,M,${speedKn.toFixed(2)},N,${(speedKn * 1.852).toFixed(2)},K,A`);
    } else {
      out += sentence(`GPGGA,${hh}${mm}${ss},,,,,0,${String(this.sats).padStart(2, '0')},,,,,,,`);
      out += sentence('GPGSA,A,1,,,,,,,,,,,,,,,');
      out += sentence(`GPRMC,${hh}${mm}${ss},V,,,,,,,${date},,,N`);
      out += sentence('GPVTG,,,,,,,,,N');
    }
    this.last = { t: te, fix: this.fix, sats: this.sats, hdop: this.hdop, lat: ll.lat, lon: ll.lon, speedKmh: speedKn * 1.852, errM: Math.hypot(this.err[0], this.err[1]) };
    const tByte = 10 / this.baud;
    let tw = Math.max(te, this.queue.length ? this.queue[this.queue.length - 1].t + tByte : te);
    for (let i = 0; i < out.length; i++) { this.queue.push({ t: tw, b: out.charCodeAt(i) }); tw += tByte; }
  }

  /** Bytes that have finished arriving on the ESP32's RX pin by time t. */
  take(t) {
    if (!this.connected) return [];
    this.run(t);
    let n = 0;
    while (n < this.queue.length && this.queue[n].t + 10 / this.baud <= t) n++;
    return this.queue.splice(0, n).map(q => q.b);
  }
}
