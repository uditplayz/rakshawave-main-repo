#include "Adafruit_GFX.h"
#include "glcdfont.h"

void Adafruit_GFX::drawChar(int16_t x, int16_t y, unsigned char c, uint16_t color, uint16_t bg, uint8_t size_x, uint8_t size_y) {
  if ((x >= _width) || (y >= _height) || ((x + 6 * size_x - 1) < 0) || ((y + 8 * size_y - 1) < 0)) return;
  if (!_cp437 && (c >= 176)) c++;  // Handle 'classic' charset behavior
  for (int8_t i = 0; i < 5; i++) {
    uint8_t line = pgm_read_byte(&font[c * 5 + i]);
    for (int8_t j = 0; j < 8; j++, line >>= 1) {
      if (line & 1) {
        if (size_x == 1 && size_y == 1) drawPixel(x + i, y + j, color);
        else fillRect(x + i * size_x, y + j * size_y, size_x, size_y, color);
      } else if (bg != color) {
        if (size_x == 1 && size_y == 1) drawPixel(x + i, y + j, bg);
        else fillRect(x + i * size_x, y + j * size_y, size_x, size_y, bg);
      }
    }
  }
  if (bg != color) {
    if (size_x == 1 && size_y == 1) for (int8_t j = 0; j < 8; j++) drawPixel(x + 5, y + j, bg);
    else fillRect(x + 5 * size_x, y, size_x, 8 * size_y, bg);
  }
}

size_t Adafruit_GFX::write(uint8_t c) {
  if (c == '\n') {
    cursor_x = 0;
    cursor_y += textsize_y * 8;
  } else if (c != '\r') {
    if (wrap && ((cursor_x + textsize_x * 6) > _width)) {
      cursor_x = 0;
      cursor_y += textsize_y * 8;
    }
    drawChar(cursor_x, cursor_y, c, textcolor, textbgcolor, textsize_x, textsize_y);
    cursor_x += textsize_x * 6;
  }
  return 1;
}
