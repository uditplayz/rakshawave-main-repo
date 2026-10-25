// Adafruit_GFX text subset with the classic 5x7 font (glcdfont.h, the original
// Adafruit file). Text layout follows Adafruit_GFX::write()/drawChar().
#pragma once
#include "Arduino.h"

class Adafruit_GFX : public Print {
 public:
  Adafruit_GFX(int16_t w, int16_t h) : WIDTH(w), HEIGHT(h), _width(w), _height(h) {}
  virtual void drawPixel(int16_t x, int16_t y, uint16_t color) = 0;
  void setCursor(int16_t x, int16_t y) { cursor_x = x; cursor_y = y; }
  void setTextColor(uint16_t c) { textcolor = textbgcolor = c; }
  void setTextColor(uint16_t c, uint16_t bg) { textcolor = c; textbgcolor = bg; }
  void setTextSize(uint8_t s) { textsize_x = textsize_y = s > 0 ? s : 1; }
  void setTextWrap(bool w) { wrap = w; }
  void cp437(bool x = true) { _cp437 = x; }
  int16_t width() const { return _width; }
  int16_t height() const { return _height; }
  int16_t getCursorX() const { return cursor_x; }
  int16_t getCursorY() const { return cursor_y; }
  void fillRect(int16_t x, int16_t y, int16_t w, int16_t h, uint16_t color) {
    for (int16_t i = x; i < x + w; i++)
      for (int16_t j = y; j < y + h; j++) drawPixel(i, j, color);
  }
  void drawChar(int16_t x, int16_t y, unsigned char c, uint16_t color, uint16_t bg, uint8_t size_x, uint8_t size_y);
  size_t write(uint8_t c) override;
  using Print::write;

 protected:
  const int16_t WIDTH, HEIGHT;
  int16_t _width, _height;
  int16_t cursor_x = 0, cursor_y = 0;
  uint16_t textcolor = 0xFFFF, textbgcolor = 0xFFFF;
  uint8_t textsize_x = 1, textsize_y = 1;
  bool wrap = true, _cp437 = false;
};
