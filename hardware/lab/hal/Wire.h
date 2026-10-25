// Arduino-ESP32 TwoWire API over the virtual I2C bus (see Arduino.h).
#pragma once
#include "Arduino.h"

#define I2C_BUFFER_LENGTH 128

class TwoWire : public Stream {
 public:
  bool begin(int sda = -1, int scl = -1, uint32_t frequency = 0) {
    if (sda >= 0) { sda_ = sda; scl_ = scl; }
    if (frequency) hz_ = frequency;
    hal_i2c_begin(sda_, scl_, (int)hz_);
    return true;
  }
  bool setClock(uint32_t hz) { hz_ = hz; hal_i2c_clock((int)hz); return true; }
  uint32_t getClock() { return hz_; }
  void beginTransmission(uint16_t address) { addr_ = address; txLen_ = 0; }
  void beginTransmission(int address) { beginTransmission((uint16_t)address); }
  uint8_t endTransmission(bool sendStop = true) {
    int r = hal_i2c_tx(addr_, tx_, txLen_, sendStop);
    txLen_ = 0;
    return (uint8_t)r;  // 0 ok, 2 address NACK, 3 data NACK
  }
  size_t requestFrom(uint16_t address, size_t size, bool sendStop = true) {
    if (size > I2C_BUFFER_LENGTH) size = I2C_BUFFER_LENGTH;
    rxLen_ = hal_i2c_rx(address, rx_, (int)size, sendStop);
    rxPos_ = 0;
    return rxLen_;
  }
  uint8_t requestFrom(uint8_t address, uint8_t size, uint8_t sendStop) { return (uint8_t)requestFrom((uint16_t)address, (size_t)size, (bool)sendStop); }
  uint8_t requestFrom(int address, int size) { return (uint8_t)requestFrom((uint16_t)address, (size_t)size, true); }
  size_t write(uint8_t c) override {
    if (txLen_ >= I2C_BUFFER_LENGTH) return 0;
    tx_[txLen_++] = c;
    return 1;
  }
  size_t write(const uint8_t* b, size_t n) override {
    size_t k = 0;
    while (k < n && write(b[k])) k++;
    return k;
  }
  using Print::write;
  int available() override { return (int)(rxLen_ - rxPos_); }
  int read() override { return rxPos_ < rxLen_ ? rx_[rxPos_++] : -1; }
  int peek() override { return rxPos_ < rxLen_ ? rx_[rxPos_] : -1; }

 private:
  int sda_ = 8, scl_ = 9;  // ESP32-C3 core defaults; the firmware passes 5/6
  uint32_t hz_ = 100000;
  uint16_t addr_ = 0;
  uint8_t tx_[I2C_BUFFER_LENGTH];
  uint8_t rx_[I2C_BUFFER_LENGTH];
  size_t txLen_ = 0, rxLen_ = 0, rxPos_ = 0;
};

extern TwoWire Wire;
