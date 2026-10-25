// Field view: the road seen from above (distance along the road to scale,
// lanes widened so they can be read), the vehicles carrying the boards, road
// features, and the radio links with their link budget. Every frame on the air
// is drawn as a dot travelling along the link for its real time on air, then
// marked at each receiver with what really happened to it.
import { SNR_LIMIT_DB } from '../sim/channel.js';

const LANE_PX = 22;

export class FieldMap {
  constructor(canvas, world, { onSelect, onChange, colorOf }) {
    this.cv = canvas;
    this.g = canvas.getContext('2d');
    this.world = world;
    this.onSelect = onSelect;
    this.onChange = onChange;
    this.colorOf = colorOf;
    this.cx = 1300;          // view centre along the road (m)
    this.mpp = 6;            // metres per pixel
    this.selected = null;
    this.frames = [];        // frames in flight / recently finished
    this.marks = [];         // reception marks
    this.fitted = false;
    this.bind();
  }

  resize() {
    const r = this.cv.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    this.cv.width = Math.max(1, r.width * dpr);
    this.cv.height = Math.max(1, r.height * dpr);
    this.W = r.width; this.H = r.height; this.dpr = dpr;
  }

  fit() {
    const xs = this.world.devices.map(d => d.vehicle.x);
    if (!xs.length || !this.W) return;
    const lo = Math.min(...xs), hi = Math.max(...xs);
    this.cx = (lo + hi) / 2;
    this.mpp = Math.max(0.5, (hi - lo + 300) / (this.W - 80));
    this.fitted = true;
  }

  get roadTop() { return this.H - 3 * LANE_PX - 26; }
  sx(x) { return this.W / 2 + (x - this.cx) / this.mpp; }
  wx(px) { return this.cx + (px - this.W / 2) * this.mpp; }
  laneY(l) { return this.roadTop + (2 - l) * LANE_PX + LANE_PX / 2; }

  bind() {
    let drag = null;
    const pos = e => { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    this.cv.addEventListener('pointerdown', e => {
      const p = pos(e);
      const hit = this.hitVehicle(p);
      if (hit) { drag = { dev: hit, dx: this.sx(hit.vehicle.x) - p.x }; this.onSelect(hit); }
      else drag = { pan: true, x0: p.x, cx0: this.cx };
      this.cv.setPointerCapture(e.pointerId);
    });
    this.cv.addEventListener('pointermove', e => {
      const p = pos(e);
      this.hover = this.hitVehicle(p);
      this.cv.style.cursor = this.hover ? 'grab' : 'default';
      if (!drag) return;
      if (drag.pan) { this.cx = drag.cx0 - (p.x - drag.x0) * this.mpp; return; }
      const x = Math.max(0, Math.min(this.world.road.length - 5, this.wx(p.x + drag.dx)));
      drag.dev.vehicle.teleport(x);
      const lane = Math.max(0, Math.min(2, Math.round(2 - (p.y - this.roadTop - LANE_PX / 2) / LANE_PX)));
      if (p.y > this.roadTop - 10 && lane !== drag.dev.vehicle.lane) drag.dev.vehicle.setLane(lane);
      this.onChange?.();
    });
    const up = () => { drag = null; };
    this.cv.addEventListener('pointerup', up);
    this.cv.addEventListener('pointercancel', up);
    this.cv.addEventListener('wheel', e => {
      e.preventDefault();
      const p = pos(e);
      const wx = this.wx(p.x);
      this.mpp = Math.max(0.05, Math.min(40, this.mpp * Math.exp(e.deltaY * 0.0015)));
      this.cx = wx - (p.x - this.W / 2) * this.mpp;
    }, { passive: false });
  }

  hitVehicle(p) {
    for (const d of this.world.devices) {
      const x = this.sx(d.vehicle.x), y = this.laneY(d.vehicle.lane);
      if (Math.abs(p.x - x) < 16 && Math.abs(p.y - y) < 11) return d;
    }
    return null;
  }

  onChannel(ev) {
    if (ev.type === 'tx') this.frames.push({ tx: ev.tx });
    if (ev.type === 'rx') this.marks.push({ ev, born: ev.t });
    if (this.frames.length > 60) this.frames.splice(0, 20);
    if (this.marks.length > 120) this.marks.splice(0, 40);
  }

  draw(now) {
    const g = this.g, W = this.W, H = this.H;
    if (!W) return;
    if (!this.fitted) this.fit();
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = getComputedStyle(this.cv).getPropertyValue('--map-bg') || '#0c1117';
    g.fillRect(0, 0, W, H);
    const top = this.roadTop;
    // ground and road
    g.fillStyle = '#16211a'; g.fillRect(0, top - 14, W, 3 * LANE_PX + 28);
    g.fillStyle = '#2a2f36'; g.fillRect(0, top, W, 3 * LANE_PX);
    g.strokeStyle = '#e8e2c8'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(0, top + 0.5); g.lineTo(W, top + 0.5); g.moveTo(0, top + 3 * LANE_PX - 0.5); g.lineTo(W, top + 3 * LANE_PX - 0.5); g.stroke();
    g.setLineDash([12, 14]); g.strokeStyle = '#cfcfcf88'; g.lineWidth = 1;
    for (let l = 1; l < 3; l++) { g.beginPath(); g.moveTo(0, top + l * LANE_PX); g.lineTo(W, top + l * LANE_PX); g.stroke(); }
    g.setLineDash([]);
    // distance scale
    const step = niceStep(this.mpp * 110);
    g.fillStyle = '#8b9aab'; g.font = '11px system-ui, sans-serif'; g.textAlign = 'center';
    for (let x = Math.ceil(this.wx(0) / step) * step; x < this.wx(W); x += step) {
      const px = this.sx(x);
      g.fillRect(px, top + 3 * LANE_PX, 1, 5);
      g.fillText(x >= 1000 ? (x / 1000).toFixed(step < 1000 ? 1 : 0) + ' km' : Math.round(x) + ' m', px, top + 3 * LANE_PX + 17);
    }
    // road features
    for (const f of this.world.road.features) {
      const px = this.sx(f.x), w = Math.max(3, f.length / this.mpp);
      if (f.kind === 'bump') { g.fillStyle = '#e0b43c'; g.fillRect(px, top, w, 3 * LANE_PX); }
      else {
        const lane = this.world.road.lanes.reduce((b, y, i) => (Math.abs(y - f.y) < Math.abs(this.world.road.lanes[b] - f.y) ? i : b), 0);
        const off = (f.y - this.world.road.lanes[lane]) / 3.5 * LANE_PX;
        g.fillStyle = '#05070a'; g.strokeStyle = '#7a5c3a';
        g.beginPath(); g.ellipse(px + w / 2, this.laneY(lane) - off, Math.max(3, w / 2), 4, 0, 0, 7); g.fill(); g.stroke();
      }
    }
    // coverage of the selected node along the road
    const sel = this.selected;
    if (sel && sel.on) {
      const phy = phyOf(sel);
      const a = sel.antennaPos(sel.t);
      for (let px = 0; px < W; px += 4) {
        const x = this.wx(px);
        const lb = this.world.channel.linkBudget(a, { x, y: a.y, h: a.h, antennaLossDb: a.antennaLossDb }, null, null, phy);
        const m = lb.snr - SNR_LIMIT_DB[phy.sf];
        g.fillStyle = m > 6 ? '#1f9d5533' : m > 0 ? '#d9a21b33' : '#00000000';
        g.fillRect(px, top - 12, 4, 8);
      }
      g.fillStyle = '#8b9aab'; g.font = '10px system-ui'; g.textAlign = 'left'; g.fillText(`strip above the road: where ${sel.name} is expected to be heard (green ≥ 6 dB margin, amber 0-6 dB)`, 8, 14);
    }
    // links (arcs) between every pair
    const devs = this.world.devices.filter(d => d.on);
    for (let i = 0; i < devs.length; i++) for (let j = i + 1; j < devs.length; j++) this.drawLink(devs[i], devs[j], devs[i] === sel || devs[j] === sel || devs.length === 2);
    // frames in flight
    for (const f of this.frames) this.drawFrame(f, now);
    // vehicles
    for (const d of this.world.devices) {
      const x = this.sx(d.vehicle.x), y = this.laneY(d.vehicle.lane);
      const c = this.colorOf(d);
      g.fillStyle = c; g.strokeStyle = d === sel ? '#ffffff' : '#00000088'; g.lineWidth = d === sel ? 2 : 1;
      if (d.ledOn()) { g.fillStyle = '#ff3b2f55'; roundRect(g, x - 17, y - 11, 34, 22, 7); g.fill(); }
      g.fillStyle = c;
      roundRect(g, x - 13, y - 7, 26, 14, 4); g.fill(); g.stroke();
      g.fillStyle = '#0b0f14aa'; g.fillRect(x + 5, y - 5, 4, 10);
      g.fillStyle = '#0b1016'; g.font = '700 11px system-ui'; g.textAlign = 'center';
      g.fillText(d.name.replace('Node ', ''), x - 3, y + 4);
      g.font = '10px system-ui'; g.fillStyle = '#8b9aab';
      g.fillText(`${(d.vehicle.v * 3.6).toFixed(0)} km/h`, x, y + 20 > top + 3 * LANE_PX ? top + 3 * LANE_PX + 29 : y + 20);
    }
    // reception marks
    for (const m of this.marks) {
      const age = now - m.born;
      if (age < 0 || age > 3) continue;
      const d = this.world.device(m.ev.rx);
      if (!d) continue;
      const x = this.sx(d.vehicle.x), y = this.laneY(d.vehicle.lane) - 18;
      g.globalAlpha = Math.max(0, 1 - age / 3);
      g.fillStyle = m.ev.ok ? '#3ccf7e' : '#ff6b72';
      g.font = '700 12px system-ui'; g.textAlign = 'center';
      g.fillText(m.ev.ok ? '✓' : '✗', x + 16, y);
      g.globalAlpha = 1;
    }
  }

  drawLink(a, b, labelled) {
    const g = this.g;
    const pa = a.antennaPos(a.t), pb = b.antennaPos(b.t);
    const lb = this.world.channel.linkBudget(pa, pb, a.id, b.id, phyOf(a));
    const x1 = this.sx(a.vehicle.x), x2 = this.sx(b.vehicle.x);
    const y = this.roadTop - 8;
    const mid = (x1 + x2) / 2, r = Math.abs(x2 - x1) / 2;
    const h = Math.min(this.roadTop - 30, Math.max(18, r * 0.55));
    const col = lb.margin > 6 ? '#3ccf7e' : lb.margin > 0 ? '#e5a63c' : '#ff6b72';
    g.strokeStyle = col; g.lineWidth = 1.5; g.globalAlpha = 0.85;
    if (lb.margin <= 0) g.setLineDash([5, 5]);
    g.beginPath(); g.moveTo(x1, y); g.bezierCurveTo(x1, y - h, x2, y - h, x2, y); g.stroke();
    g.setLineDash([]); g.globalAlpha = 1;
    if (!labelled) return;
    const lx = mid, ly = y - h * 0.75 - 4;
    const txt = `${fmtDist(lb.distance)} · ${lb.rssi.toFixed(0)} dBm · SNR ${lb.snr.toFixed(1)} dB`;
    g.font = '11px system-ui'; g.textAlign = 'center';
    const w = g.measureText(txt).width + 10;
    g.fillStyle = '#0b0f14dd'; roundRect(g, lx - w / 2, ly - 12, w, 17, 4); g.fill();
    g.fillStyle = col; g.fillText(txt, lx, ly);
    void r;
  }

  drawFrame(f, now) {
    const tx = f.tx;
    if (now < tx.t0 || now > tx.t1 + 0.6) return;
    const src = this.world.device(tx.src);
    if (!src) return;
    const g = this.g;
    const x1 = this.sx(src.vehicle.x), y = this.roadTop - 8;
    const k = Math.min(1, (now - tx.t0) / (tx.t1 - tx.t0));
    // expanding ring at the sender while the frame is on the air
    if (now <= tx.t1) {
      g.strokeStyle = this.colorOf(src); g.lineWidth = 2; g.globalAlpha = 0.9 - 0.6 * k;
      g.beginPath(); g.arc(x1, this.laneY(src.vehicle.lane), 10 + 26 * ((now * 3) % 1), 0, 7); g.stroke(); g.globalAlpha = 1;
    }
    for (const d of this.world.devices) {
      if (d === src || !d.on) continue;
      const x2 = this.sx(d.vehicle.x);
      const h = Math.min(this.roadTop - 30, Math.max(18, Math.abs(x2 - x1) / 2 * 0.55));
      const p = bez(x1, y, x1, y - h, x2, y - h, x2, y, k);
      g.fillStyle = this.colorOf(src);
      g.beginPath(); g.arc(p[0], p[1], 4.5, 0, 7); g.fill();
      g.fillStyle = '#ffffff'; g.beginPath(); g.arc(p[0], p[1], 1.8, 0, 7); g.fill();
    }
  }
}

export function phyOf(dev) {
  const sx = dev.sx;
  return { freq: sx.freq || 433e6, txDbm: sx.txDbm || 17, sf: sx.sf || 7, bw: sx.bw || 125e3 };
}

function bez(x0, y0, x1, y1, x2, y2, x3, y3, t) {
  const u = 1 - t;
  return [u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3];
}
function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  for (const m of [1, 2, 5, 10]) if (m * p >= x) return m * p;
  return 10 * p;
}
export function fmtDist(m) { return m >= 1000 ? (m / 1000).toFixed(2) + ' km' : m.toFixed(0) + ' m'; }
function roundRect(g, x, y, w, h, r) {
  g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath();
}
