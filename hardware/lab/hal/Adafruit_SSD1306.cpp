#include "Adafruit_SSD1306.h"

#define WIRE_MAX 32  // Adafruit_SSD1306 chunk size for non-AVR Wire buffers
#define SSD1306_MEMORYMODE 0x20
#define SSD1306_COLUMNADDR 0x21
#define SSD1306_PAGEADDR 0x22
#define SSD1306_SETCONTRAST 0x81
#define SSD1306_CHARGEPUMP 0x8D
#define SSD1306_SEGREMAP 0xA0
#define SSD1306_DISPLAYALLON_RESUME 0xA4
#define SSD1306_NORMALDISPLAY 0xA6
#define SSD1306_INVERTDISPLAY 0xA7
#define SSD1306_SETMULTIPLEX 0xA8
#define SSD1306_DISPLAYOFF 0xAE
#define SSD1306_DISPLAYON 0xAF
#define SSD1306_COMSCANDEC 0xC8
#define SSD1306_SETDISPLAYOFFSET 0xD3
#define SSD1306_SETDISPLAYCLOCKDIV 0xD5
#define SSD1306_SETPRECHARGE 0xD9
#define SSD1306_SETCOMPINS 0xDA
#define SSD1306_SETVCOMDETECT 0xDB
#define SSD1306_SETSTARTLINE 0x40
#define SSD1306_DEACTIVATE_SCROLL 0x2E

void Adafruit_SSD1306::command1(uint8_t c) {
  wire->beginTransmission(i2caddr);
  wire->write((uint8_t)0x00);
  wire->write(c);
  wire->endTransmission();
}

void Adafruit_SSD1306::ssd1306_command(uint8_t c) {
  wire->setClock(wireClk);
  command1(c);
  wire->setClock(restoreClk);
}

void Adafruit_SSD1306::commandList(const uint8_t* c, uint8_t n) {
  wire->beginTransmission(i2caddr);
  wire->write((uint8_t)0x00);
  uint16_t bytesOut = 1;
  while (n--) {
    if (bytesOut >= WIRE_MAX) {
      wire->endTransmission();
      wire->beginTransmission(i2caddr);
      wire->write((uint8_t)0x00);
      bytesOut = 1;
    }
    wire->write(*c++);
    bytesOut++;
  }
  wire->endTransmission();
}

bool Adafruit_SSD1306::begin(uint8_t vcs, uint8_t addr, bool reset, bool periphBegin) {
  if (!buffer && !(buffer = (uint8_t*)malloc(WIDTH * ((HEIGHT + 7) / 8)))) return false;
  clearDisplay();
  vccstate = vcs;
  i2caddr = addr ? addr : ((HEIGHT == 32) ? 0x3C : 0x3D);
  if (periphBegin) wire->begin();
  (void)reset;  // rst_pin is -1 on this board: no reset line

  wire->setClock(wireClk);
  static const uint8_t init1[] = {SSD1306_DISPLAYOFF, SSD1306_SETDISPLAYCLOCKDIV, 0x80, SSD1306_SETMULTIPLEX};
  commandList(init1, sizeof(init1));
  command1(HEIGHT - 1);
  static const uint8_t init2[] = {SSD1306_SETDISPLAYOFFSET, 0x0, SSD1306_SETSTARTLINE | 0x0, SSD1306_CHARGEPUMP};
  commandList(init2, sizeof(init2));
  command1((vccstate == SSD1306_EXTERNALVCC) ? 0x10 : 0x14);
  static const uint8_t init3[] = {SSD1306_MEMORYMODE, 0x00, SSD1306_SEGREMAP | 0x1, SSD1306_COMSCANDEC};
  commandList(init3, sizeof(init3));
  uint8_t comPins = 0x02;
  contrast = 0x8F;
  if ((WIDTH == 128) && (HEIGHT == 64)) { comPins = 0x12; contrast = (vccstate == SSD1306_EXTERNALVCC) ? 0x9F : 0xCF; }
  command1(SSD1306_SETCOMPINS);
  command1(comPins);
  command1(SSD1306_SETCONTRAST);
  command1(contrast);
  command1(SSD1306_SETPRECHARGE);
  command1((vccstate == SSD1306_EXTERNALVCC) ? 0x22 : 0xF1);
  static const uint8_t init5[] = {SSD1306_SETVCOMDETECT, 0x40, SSD1306_DISPLAYALLON_RESUME, SSD1306_NORMALDISPLAY, SSD1306_DEACTIVATE_SCROLL, SSD1306_DISPLAYON};
  commandList(init5, sizeof(init5));
  wire->setClock(restoreClk);
  return true;  // like the real driver: no ACK check in I2C mode
}

void Adafruit_SSD1306::drawPixel(int16_t x, int16_t y, uint16_t color) {
  if ((x < 0) || (x >= width()) || (y < 0) || (y >= height())) return;
  switch (color) {
    case SSD1306_WHITE: buffer[x + (y / 8) * WIDTH] |= (1 << (y & 7)); break;
    case SSD1306_BLACK: buffer[x + (y / 8) * WIDTH] &= ~(1 << (y & 7)); break;
    case SSD1306_INVERSE: buffer[x + (y / 8) * WIDTH] ^= (1 << (y & 7)); break;
  }
}

void Adafruit_SSD1306::display() {
  wire->setClock(wireClk);
  static const uint8_t dlist1[] = {SSD1306_PAGEADDR, 0, 0xFF, SSD1306_COLUMNADDR, 0};
  commandList(dlist1, sizeof(dlist1));
  command1(WIDTH - 1);
  uint16_t count = WIDTH * ((HEIGHT + 7) / 8);
  uint8_t* ptr = buffer;
  wire->beginTransmission(i2caddr);
  wire->write((uint8_t)0x40);
  uint16_t bytesOut = 1;
  while (count--) {
    if (bytesOut >= WIRE_MAX) {
      wire->endTransmission();
      wire->beginTransmission(i2caddr);
      wire->write((uint8_t)0x40);
      bytesOut = 1;
    }
    wire->write(*ptr++);
    bytesOut++;
  }
  wire->endTransmission();
  wire->setClock(restoreClk);
}

void Adafruit_SSD1306::invertDisplay(bool i) {
  wire->setClock(wireClk);
  command1(i ? SSD1306_INVERTDISPLAY : SSD1306_NORMALDISPLAY);
  wire->setClock(restoreClk);
}

void Adafruit_SSD1306::dim(bool dim) {
  wire->setClock(wireClk);
  command1(SSD1306_SETCONTRAST);
  command1(dim ? 0 : contrast);
  wire->setClock(restoreClk);
}
