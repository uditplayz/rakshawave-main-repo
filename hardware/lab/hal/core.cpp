// Globals of the Arduino core and the entry points the JS device calls.
#include <stdarg.h>
#include "Arduino.h"
#include "Wire.h"
#include "SPI.h"

HardwareSerial Serial(0);
TwoWire Wire;
SPIClass SPI;
EspClass ESP;

size_t Print::printf(const char* fmt, ...) {
  char b[256];
  va_list ap;
  va_start(ap, fmt);
  int n = vsnprintf(b, sizeof b, fmt, ap);
  va_end(ap);
  if (n < 0) return 0;
  return write((const uint8_t*)b, (size_t)(n < (int)sizeof b ? n : (int)sizeof b - 1));
}

extern "C" __attribute__((export_name("fw_setup"))) void fw_setup() { setup(); }
extern "C" __attribute__((export_name("fw_loop"))) void fw_loop() { loop(); }
