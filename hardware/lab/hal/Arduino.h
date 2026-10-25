// Arduino-ESP32 core API for the RakshaWave virtual lab.
//
// The firmware (firmware/esp32/main.ino) is compiled unmodified against this
// header for WebAssembly. Every pin, UART, I2C and SPI access is forwarded to
// the JavaScript peripheral models (hardware/lab/web/js/), which emulate the
// chips at register level. Time is the device's own virtual clock: bus
// transfers and delay() advance it by what they take on the real ESP32-C3.
#pragma once

#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <math.h>
#include <algorithm>

#define HAL_IMPORT(name) extern "C" __attribute__((import_module("hal"), import_name(#name)))

HAL_IMPORT(now_us) double hal_now_us(void);
HAL_IMPORT(delay_us) void hal_delay_us(double us);
HAL_IMPORT(pin_mode) void hal_pin_mode(int pin, int mode);
HAL_IMPORT(pin_write) void hal_pin_write(int pin, int value);
HAL_IMPORT(pin_read) int hal_pin_read(int pin);
HAL_IMPORT(uart_begin) void hal_uart_begin(int port, int baud, int rx, int tx);
HAL_IMPORT(uart_avail) int hal_uart_avail(int port);
HAL_IMPORT(uart_read) int hal_uart_read(int port);
HAL_IMPORT(uart_peek) int hal_uart_peek(int port);
HAL_IMPORT(uart_write) void hal_uart_write(int port, const uint8_t* data, int len);
HAL_IMPORT(i2c_begin) void hal_i2c_begin(int sda, int scl, int hz);
HAL_IMPORT(i2c_clock) void hal_i2c_clock(int hz);
HAL_IMPORT(i2c_tx) int hal_i2c_tx(int addr, const uint8_t* data, int len, int stop);
HAL_IMPORT(i2c_rx) int hal_i2c_rx(int addr, uint8_t* data, int len, int stop);
HAL_IMPORT(spi_begin) void hal_spi_begin(int sck, int miso, int mosi, int ss);
HAL_IMPORT(spi_clock) void hal_spi_clock(int hz);
HAL_IMPORT(spi_xfer) int hal_spi_xfer(int value);
HAL_IMPORT(rand32) uint32_t hal_rand32(void);
HAL_IMPORT(mac_lo) uint32_t hal_mac_lo(void);
HAL_IMPORT(mac_hi) uint32_t hal_mac_hi(void);

typedef bool boolean;
typedef uint8_t byte;

#define HIGH 0x1
#define LOW 0x0
#define INPUT 0x01
#define OUTPUT 0x03
#define PULLUP 0x04
#define INPUT_PULLUP 0x05
#define SERIAL_8N1 0x800001c
#define PI 3.1415926535897932384626433832795
#define DEG_TO_RAD 0.017453292519943295769236907684886
#define RAD_TO_DEG 57.295779513082320876798154814105
#define PROGMEM
#define pgm_read_byte(addr) (*(const unsigned char*)(addr))
#define F(s) (s)
#define constrain(amt, low, high) ((amt) < (low) ? (low) : ((amt) > (high) ? (high) : (amt)))
#define bitRead(value, bit) (((value) >> (bit)) & 0x01)
#define bitSet(value, bit) ((value) |= (1UL << (bit)))
#define bitClear(value, bit) ((value) &= ~(1UL << (bit)))
#define bitWrite(value, bit, bitvalue) ((bitvalue) ? bitSet(value, bit) : bitClear(value, bit))
using std::max;
using std::min;

inline unsigned long micros() { return (unsigned long)(uint32_t)(uint64_t)hal_now_us(); }
inline unsigned long millis() { return (unsigned long)(uint32_t)(uint64_t)(hal_now_us() / 1000.0); }
inline void delay(uint32_t ms) { hal_delay_us(ms * 1000.0); }
inline void delayMicroseconds(uint32_t us) { hal_delay_us(us); }
// FreeRTOS yield on a single-core C3 with no other ready task: a scheduler tick.
inline void yield() { hal_delay_us(1.0); }
inline void pinMode(uint8_t pin, uint8_t mode) { hal_pin_mode(pin, mode); }
inline void digitalWrite(uint8_t pin, uint8_t val) { hal_pin_write(pin, val); }
inline int digitalRead(uint8_t pin) { return hal_pin_read(pin); }

inline void randomSeed(unsigned long) {}  // esp_random() is a hardware RNG; seeding is ignored
inline long random(long howbig) { return howbig <= 0 ? 0 : (long)(hal_rand32() % (uint32_t)howbig); }
inline long random(long lo, long hi) { return lo >= hi ? lo : lo + random(hi - lo); }

class EspClass {
 public:
  uint64_t getEfuseMac() { return ((uint64_t)hal_mac_hi() << 32) | hal_mac_lo(); }
};
extern EspClass ESP;

// ---------------------------------------------------------------- String
class String {
 public:
  String(const char* s = "") { assign(s ? s : "", s ? strlen(s) : 0); }
  String(const String& o) { assign(o.buf_, o.len_); }
  String(char c) { char b[2] = {c, 0}; assign(b, 1); }
  String(int v, unsigned char base = 10) { fromLong(v, base); }
  String(unsigned int v, unsigned char base = 10) { fromULong(v, base); }
  String(long v, unsigned char base = 10) { fromLong(v, base); }
  String(unsigned long v, unsigned char base = 10) { fromULong(v, base); }
  String(float v, unsigned int decimals = 2) { fromDouble(v, decimals); }
  String(double v, unsigned int decimals = 2) { fromDouble(v, decimals); }
  ~String() { free(buf_); }

  String& operator=(const String& o) { if (this != &o) assign(o.buf_, o.len_); return *this; }
  String& operator=(const char* s) { assign(s ? s : "", s ? strlen(s) : 0); return *this; }

  bool reserve(unsigned int size) { grow(size); return true; }
  unsigned int length() const { return len_; }
  const char* c_str() const { return buf_ ? buf_ : ""; }
  char charAt(unsigned int i) const { return i < len_ ? buf_[i] : 0; }
  char operator[](unsigned int i) const { return charAt(i); }

  bool concat(const char* s, unsigned int n) { grow(len_ + n); memcpy(buf_ + len_, s, n); len_ += n; buf_[len_] = 0; return true; }
  bool concat(const String& s) { return concat(s.c_str(), s.len_); }
  bool concat(const char* s) { return s ? concat(s, strlen(s)) : false; }
  bool concat(char c) { return concat(&c, 1); }
  String& operator+=(const String& s) { concat(s); return *this; }
  String& operator+=(const char* s) { concat(s); return *this; }
  String& operator+=(char c) { concat(c); return *this; }
  String& operator+=(int v) { concat(String(v)); return *this; }
  String& operator+=(unsigned long v) { concat(String(v)); return *this; }

  bool operator==(const String& o) const { return len_ == o.len_ && memcmp(c_str(), o.c_str(), len_) == 0; }
  bool operator==(const char* s) const { return strcmp(c_str(), s ? s : "") == 0; }
  bool operator!=(const String& o) const { return !(*this == o); }
  bool operator!=(const char* s) const { return !(*this == s); }
  bool equals(const String& o) const { return *this == o; }

  int indexOf(char c, unsigned int from = 0) const {
    for (unsigned int i = from; i < len_; i++) if (buf_[i] == c) return (int)i;
    return -1;
  }
  int indexOf(const char* s, unsigned int from = 0) const {
    if (from >= len_ && len_ != 0) return -1;
    const char* p = strstr(c_str() + from, s);
    return p ? (int)(p - c_str()) : -1;
  }
  int indexOf(const String& s, unsigned int from = 0) const { return indexOf(s.c_str(), from); }
  bool startsWith(const char* s) const { return strncmp(c_str(), s, strlen(s)) == 0; }
  String substring(unsigned int from, unsigned int to = 0xFFFFFFFF) const {
    if (to > len_) to = len_;
    if (from > to) from = to;
    String r;
    r.assign(c_str() + from, to - from);
    return r;
  }
  long toInt() const { return atol(c_str()); }
  float toFloat() const { return (float)atof(c_str()); }
  double toDouble() const { return atof(c_str()); }
  void trim() {
    unsigned int a = 0, b = len_;
    while (a < b && (buf_[a] == ' ' || buf_[a] == '\t' || buf_[a] == '\r' || buf_[a] == '\n')) a++;
    while (b > a && (buf_[b - 1] == ' ' || buf_[b - 1] == '\t' || buf_[b - 1] == '\r' || buf_[b - 1] == '\n')) b--;
    String t = substring(a, b);
    *this = t;
  }

 private:
  char* buf_ = nullptr;
  unsigned int len_ = 0, cap_ = 0;
  void grow(unsigned int need) {
    if (buf_ && need <= cap_) return;
    unsigned int c = cap_ ? cap_ : 16;
    while (c < need) c *= 2;
    char* nb = (char*)realloc(buf_, c + 1);
    if (!buf_) nb[0] = 0;
    buf_ = nb;
    cap_ = c;
  }
  void assign(const char* s, unsigned int n) {
    grow(n);
    memmove(buf_, s, n);
    len_ = n;
    buf_[n] = 0;
  }
  void fromLong(long v, unsigned char base) {
    char b[34];
    if (base == 10) snprintf(b, sizeof b, "%ld", v); else { ltoa_(v < 0 ? -(unsigned long)v : v, b, base, v < 0); }
    assign(b, strlen(b));
  }
  void fromULong(unsigned long v, unsigned char base) {
    char b[34];
    if (base == 10) snprintf(b, sizeof b, "%lu", v); else ltoa_(v, b, base, false);
    assign(b, strlen(b));
  }
  static void ltoa_(unsigned long v, char* b, unsigned char base, bool neg) {
    char t[34]; int i = 0;
    do { int d = v % base; t[i++] = d < 10 ? '0' + d : 'A' + d - 10; v /= base; } while (v);
    int j = 0;
    if (neg) b[j++] = '-';
    while (i) b[j++] = t[--i];
    b[j] = 0;
  }
  void fromDouble(double v, unsigned int decimals) {
    char b[48];
    snprintf(b, sizeof b, "%.*f", decimals, v);
    assign(b, strlen(b));
  }
};

inline String operator+(const String& a, const String& b) { String r(a); r.concat(b); return r; }
inline String operator+(const String& a, const char* b) { String r(a); r.concat(b); return r; }
inline String operator+(const char* a, const String& b) { String r(a); r.concat(b); return r; }
inline String operator+(const String& a, char b) { String r(a); r.concat(b); return r; }

// ---------------------------------------------------------------- Print / Stream
class Print {
 public:
  virtual ~Print() {}
  virtual size_t write(uint8_t c) = 0;
  virtual size_t write(const uint8_t* buffer, size_t size) {
    size_t n = 0;
    while (size--) n += write(*buffer++);
    return n;
  }
  size_t write(const char* s) { return s ? write((const uint8_t*)s, strlen(s)) : 0; }
  size_t print(const char* s) { return write(s); }
  size_t print(const String& s) { return write((const uint8_t*)s.c_str(), s.length()); }
  size_t print(char c) { return write((uint8_t)c); }
  size_t print(int v, int base = 10) { return print(String((long)v, base)); }
  size_t print(unsigned int v, int base = 10) { return print(String((unsigned long)v, base)); }
  size_t print(long v, int base = 10) { return print(String(v, base)); }
  size_t print(unsigned long v, int base = 10) { return print(String(v, base)); }
  size_t print(double v, int digits = 2) { return print(String(v, (unsigned)digits)); }
  size_t println() { return write((const uint8_t*)"\r\n", 2); }
  template <typename T> size_t println(const T& v) { size_t n = print(v); return n + println(); }
  template <typename T> size_t println(const T& v, int f) { size_t n = print(v, f); return n + println(); }
  size_t printf(const char* fmt, ...) __attribute__((format(printf, 2, 3)));
};

class Stream : public Print {
 public:
  virtual int available() = 0;
  virtual int read() = 0;
  virtual int peek() = 0;
  virtual void flush() {}
};

class HardwareSerial : public Stream {
 public:
  explicit HardwareSerial(int port) : port_(port) {}
  void begin(unsigned long baud, uint32_t config = SERIAL_8N1, int8_t rxPin = -1, int8_t txPin = -1) {
    (void)config;
    hal_uart_begin(port_, (int)baud, rxPin, txPin);
  }
  size_t setRxBufferSize(size_t n) { return n; }  // the JS UART model buffers 1 KiB like the firmware asks
  int available() override { return hal_uart_avail(port_); }
  int read() override { return hal_uart_read(port_); }
  int peek() override { return hal_uart_peek(port_); }
  size_t write(uint8_t c) override { hal_uart_write(port_, &c, 1); return 1; }
  size_t write(const uint8_t* b, size_t n) override { hal_uart_write(port_, b, (int)n); return n; }
  using Print::write;
  operator bool() const { return true; }

 private:
  int port_;
};

extern HardwareSerial Serial;

void setup();
void loop();
