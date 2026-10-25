// Arduino-ESP32 SPIClass API over the virtual SPI bus (see Arduino.h).
#pragma once
#include "Arduino.h"

#define SPI_MODE0 0x00
#define MSBFIRST 1

class SPISettings {
 public:
  SPISettings(uint32_t clock = 1000000, uint8_t bitOrder = MSBFIRST, uint8_t dataMode = SPI_MODE0)
      : clock_(clock), bitOrder_(bitOrder), dataMode_(dataMode) {}
  uint32_t clock_;
  uint8_t bitOrder_, dataMode_;
};

class SPIClass {
 public:
  void begin(int8_t sck = -1, int8_t miso = -1, int8_t mosi = -1, int8_t ss = -1) {
    if (sck >= 0) { sck_ = sck; miso_ = miso; mosi_ = mosi; ss_ = ss; }
    hal_spi_begin(sck_, miso_, mosi_, ss_);
  }
  void end() {}
  void beginTransaction(SPISettings s) { hal_spi_clock((int)s.clock_); }
  void endTransaction() {}
  uint8_t transfer(uint8_t v) { return (uint8_t)hal_spi_xfer(v); }

 private:
  int8_t sck_ = 4, miso_ = 5, mosi_ = 6, ss_ = 7;  // ESP32-C3 core defaults
};

extern SPIClass SPI;
