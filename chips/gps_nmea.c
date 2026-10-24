// Wokwi custom chip: RXM-GPS-FM style GPS, 9600 baud NMEA 0183.
//
// Sends a $GPGGA and a $GPRMC sentence every second, fixed at Pune
// (18.5204 N, 73.8567 E) with 8 satellites and HDOP 1.1. Wire the chip's TX
// to the ESP32-C3 RX (IO20); the chip RX (ESP32 IO21) is ignored.

#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
  uart_dev_t uart;
  uint32_t seconds;
} chip_state_t;

static unsigned nmea_checksum(const char *body) {
  unsigned cs = 0;
  while (*body) cs ^= (unsigned char)*body++;
  return cs;
}

// uart_write() refuses new data while a previous write is still being sent,
// so both sentences go out as ONE buffer.
static int append_sentence(char *dst, size_t cap, const char *body) {
  return snprintf(dst, cap, "$%s*%02X%c%c", body, nmea_checksum(body), 13, 10);  // CR LF
}

static void on_tick(void *user) {
  chip_state_t *c = (chip_state_t *)user;
  uint32_t t = 12 * 3600 + c->seconds++;   // 12:00:00 UTC, counting up
  unsigned hh = (unsigned)(t / 3600 % 24), mm = (unsigned)(t / 60 % 60), ss = (unsigned)(t % 60);
  char body[110];
  static char out[300];
  int n = 0;

  snprintf(body, sizeof(body),
           "GPGGA,%02u%02u%02u.00,1831.2240,N,07351.4020,E,1,08,1.1,560.0,M,-34.0,M,,", hh, mm, ss);
  n += append_sentence(out + n, sizeof(out) - n, body);

  snprintf(body, sizeof(body),
           "GPRMC,%02u%02u%02u.00,A,1831.2240,N,07351.4020,E,22.5,090.0,010126,,,A", hh, mm, ss);
  n += append_sentence(out + n, sizeof(out) - n, body);

  uart_write(c->uart, (uint8_t *)out, (uint32_t)n);
}

void chip_init(void) {
  chip_state_t *c = malloc(sizeof(chip_state_t));
  memset(c, 0, sizeof(*c));

  const uart_config_t uart_cfg = {
    .tx = pin_init("TX", INPUT),
    .rx = pin_init("RX", INPUT),
    .baud_rate = 9600,
    .rx_data = NULL,
    .write_done = NULL,
    .user_data = c,
  };
  c->uart = uart_init(&uart_cfg);

  const timer_config_t timer_cfg = {.callback = on_tick, .user_data = c};
  timer_t timer = timer_init(&timer_cfg);
  timer_start(timer, 1000000, true);   // every 1000 ms
}
