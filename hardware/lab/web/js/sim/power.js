// Power path of one board: battery -> TPS63001 buck-boost -> 3.3 V rail.
//
// The schematic charges the cell with an MCP73123, which is a LiFePO4 charger
// (3.6 V termination), so the cell is modelled as an 18650 LiFePO4, 1500 mAh.
// Loads on the 3.3 V rail are summed from each part's present state.
export const RAIL_V = 3.3;
export const ESP32C3_ACTIVE_MA = 24;     // 160 MHz, radio off (datasheet "modem-sleep" range 20-28 mA)
export const POWER_LED_MA = 1.0;         // DevKitM-1 red power LED
export const LED_MA = (3.3 - 1.9) / 330 * 1000;   // D1 (red) with R5 = 330 ohm
export const BUZZER_MA = 30;             // active 3 V magnetic buzzer

const OCV = [[0, 2.5], [0.03, 2.9], [0.08, 3.15], [0.2, 3.24], [0.4, 3.27], [0.6, 3.29], [0.8, 3.32], [0.92, 3.34], [0.98, 3.4], [1, 3.55]];

export class Battery {
  constructor({ capacityMah = 1500, soc = 0.92, rInt = 0.06 } = {}) {
    this.capacityMah = capacityMah;
    this.soc = soc;
    this.rInt = rInt;
    this.ibat = 0;
    this.connected = true;
  }
  ocv() {
    for (let i = 1; i < OCV.length; i++) {
      if (this.soc <= OCV[i][0]) {
        const [x0, y0] = OCV[i - 1], [x1, y1] = OCV[i];
        return y0 + (y1 - y0) * (this.soc - x0) / (x1 - x0);
      }
    }
    return OCV[OCV.length - 1][1];
  }
  voltage() { return this.ocv() - this.ibat / 1000 * this.rInt; }
}

/** TPS63001 efficiency at Vin ~3.3 V, Vout 3.3 V (datasheet efficiency curves, power-save mode on). */
export function bbEfficiency(ioutMa) {
  return Math.max(0.5, 0.92 - 0.12 * Math.exp(-ioutMa / 12));
}

export class PowerModel {
  constructor() {
    this.battery = new Battery();
    this.railMa = 0;
    this.breakdown = {};
    this.energyJ = 0;
    this.chargeMah = 0;
  }

  /** Integrate dt seconds at the given per-part currents (mA, on the 3.3 V rail). */
  integrate(dt, parts) {
    let rail = 0;
    for (const k in parts) rail += parts[k];
    this.railMa = rail;
    this.breakdown = parts;
    const vb = Math.max(2.0, this.battery.voltage());
    const ibat = rail * RAIL_V / (bbEfficiency(rail) * vb) + 0.05;   // + 50 uA quiescent
    this.battery.ibat = ibat;
    if (dt > 0) {
      this.battery.soc = Math.max(0, this.battery.soc - ibat * dt / 3600 / this.battery.capacityMah);
      this.chargeMah += ibat * dt / 3600;
      this.energyJ += ibat / 1000 * vb * dt;
    }
  }

  runtimeHours(avgMa) {
    return this.battery.soc * this.battery.capacityMah / Math.max(avgMa, 0.01);
  }
}
