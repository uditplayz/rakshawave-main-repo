// Adafruit_SSD1306 (v2.5) API, I2C variant. begin() and display() send the
// same command list and GDDRAM chunks as the real driver, so the SSD1306 model
// in the lab rebuilds the picture from the I2C traffic alone.
#pragma once
#include "Adafruit_GFX.h"
#include "Wire.h"

#define SSD1306_BLACK 0
#define SSD1306_WHITE 1
#define SSD1306_INVERSE 2
#define BLACK SSD1306_BLACK
#define WHITE SSD1306_WHITE
#define SSD1306_EXTERNALVCC 0x01
#define SSD1306_SWITCHCAPVCC 0x02

class Adafruit_SSD1306 : public Adafruit_GFX {
 public:
  Adafruit_SSD1306(uint8_t w, uint8_t h, TwoWire* twi = &Wire, int8_t rst_pin = -1,
                   uint32_t clkDuring = 400000UL, uint32_t clkAfter = 100000UL)
      : Adafruit_GFX(w, h), wire(twi), rstPin(rst_pin), wireClk(clkDuring), restoreClk(clkAfter) {}
  ~Adafruit_SSD1306() { free(buffer); }
  bool begin(uint8_t switchvcc = SSD1306_SWITCHCAPVCC, uint8_t i2caddr = 0, bool reset = true, bool periphBegin = true);
  void display();
  void clearDisplay() { memset(buffer, 0, WIDTH * ((HEIGHT + 7) / 8)); }
  void invertDisplay(bool i);
  void dim(bool dim);
  void drawPixel(int16_t x, int16_t y, uint16_t color) override;
  void ssd1306_command(uint8_t c);

 private:
  void command1(uint8_t c);
  void commandList(const uint8_t* c, uint8_t n);
  TwoWire* wire;
  uint8_t* buffer = nullptr;
  int8_t i2caddr = 0x3C, vccstate = SSD1306_SWITCHCAPVCC, rstPin;
  uint32_t wireClk, restoreClk;
  uint8_t contrast = 0x8F;
};
