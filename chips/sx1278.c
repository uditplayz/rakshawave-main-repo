// Wokwi custom chip: minimal SX1278 (Ai-Thinker Ra-01) SPI register model.
//
// Just enough of the chip for sandeepmistry/Arduino-LoRa to run unmodified:
//   * REG_VERSION (0x42) reads 0x12, so LoRa.begin(433E6) succeeds
//   * a plain 128-byte register file (writes read back)
//   * FIFO (0x00) with auto-incrementing pointer (0x0D)
//   * writing OP_MODE = TX (0x83) latches the FIFO as a transmitted frame,
//     prints it to the simulator console and raises IRQ TX_DONE (0x08) so
//     LoRa.endPacket() returns; IRQ_FLAGS is write-1-to-clear
// RX is not modelled (parsePacket() always sees "no packet").
//
// SPI framing: byte 0 = address (bit7 = write), then data bytes while NSS is
// low (burst; address auto-increments except for the FIFO register).
// The chip is driven one byte at a time so a read response can be prepared
// after the address byte has arrived.

#include "wokwi-api.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

#define REG_FIFO            0x00
#define REG_OP_MODE         0x01
#define REG_FIFO_ADDR_PTR   0x0D
#define REG_IRQ_FLAGS       0x12
#define REG_PAYLOAD_LENGTH  0x22
#define REG_VERSION         0x42

#define MODE_MASK           0x07
#define MODE_STDBY          0x01
#define MODE_TX             0x03
#define IRQ_TX_DONE         0x08

typedef enum { ST_IDLE, ST_ADDR, ST_DATA } state_t;

typedef struct {
  pin_t nss, rst, dio0;
  spi_dev_t spi;
  uint8_t regs[128];
  uint8_t fifo[256];
  state_t state;
  uint8_t addr;
  bool write;
  uint8_t byte;          // SPI exchange buffer (1 byte)
  uint32_t tx_frames;
} chip_state_t;

static void reset_chip(chip_state_t *c) {
  memset(c->regs, 0, sizeof(c->regs));
  c->regs[REG_OP_MODE] = MODE_STDBY;
  c->regs[REG_VERSION] = 0x12;
}

static void start_byte(chip_state_t *c, uint8_t miso) {
  c->byte = miso;
  spi_start(c->spi, &c->byte, 1);
}

static uint8_t reg_read(chip_state_t *c, uint8_t a) {
  if (a == REG_FIFO) return c->fifo[c->regs[REG_FIFO_ADDR_PTR]++];
  return c->regs[a & 0x7F];
}

static void tx_frame(chip_state_t *c) {
  uint8_t len = c->regs[REG_PAYLOAD_LENGTH];
  char text[257];
  uint8_t base = 0;
  for (int i = 0; i < len; i++) {
    uint8_t b = c->fifo[(uint8_t)(base + i)];
    text[i] = (b >= 32 && b < 127) ? (char)b : '.';
  }
  text[len] = 0;
  c->tx_frames++;
  printf("[sx1278] TX #%u %u bytes: %s\n", (unsigned)c->tx_frames, (unsigned)len, text);
  c->regs[REG_IRQ_FLAGS] |= IRQ_TX_DONE;
  c->regs[REG_OP_MODE] = (c->regs[REG_OP_MODE] & ~MODE_MASK) | MODE_STDBY;
  pin_write(c->dio0, HIGH);
}

static void reg_write(chip_state_t *c, uint8_t a, uint8_t v) {
  a &= 0x7F;
  if (a == REG_FIFO) {
    c->fifo[c->regs[REG_FIFO_ADDR_PTR]++] = v;
    return;
  }
  if (a == REG_IRQ_FLAGS) {            // write 1 to clear
    c->regs[a] &= (uint8_t)~v;
    if (!(c->regs[a] & IRQ_TX_DONE)) pin_write(c->dio0, LOW);
    return;
  }
  if (a == REG_VERSION) return;        // read-only
  c->regs[a] = v;
  if (a == REG_OP_MODE && (v & MODE_MASK) == MODE_TX) tx_frame(c);
}

static void on_spi_done(void *user, uint8_t *buffer, uint32_t count) {
  chip_state_t *c = (chip_state_t *)user;
  if (pin_read(c->nss) == HIGH) { c->state = ST_IDLE; return; }

  if (c->state == ST_ADDR) {
    c->addr = buffer[0] & 0x7F;
    c->write = (buffer[0] & 0x80) != 0;
    c->state = ST_DATA;
    start_byte(c, c->write ? 0x00 : reg_read(c, c->addr));
    if (!c->write && c->addr != REG_FIFO) c->addr++;
    return;
  }
  if (c->state == ST_DATA) {
    if (c->write) {
      reg_write(c, c->addr, buffer[0]);
      if (c->addr != REG_FIFO) c->addr++;
      start_byte(c, 0x00);
    } else {
      start_byte(c, reg_read(c, c->addr));
      if (c->addr != REG_FIFO) c->addr++;
    }
  }
}

static void on_nss_change(void *user, pin_t pin, uint32_t value) {
  chip_state_t *c = (chip_state_t *)user;
  if (value == LOW) {
    c->state = ST_ADDR;
    start_byte(c, 0x00);
  } else {
    c->state = ST_IDLE;
    spi_stop(c->spi);
  }
}

static void on_rst_change(void *user, pin_t pin, uint32_t value) {
  chip_state_t *c = (chip_state_t *)user;
  if (value == LOW) reset_chip(c);
}

void chip_init(void) {
  chip_state_t *c = malloc(sizeof(chip_state_t));
  memset(c, 0, sizeof(*c));
  reset_chip(c);

  c->nss = pin_init("NSS", INPUT_PULLUP);
  c->rst = pin_init("RST", INPUT_PULLUP);
  c->dio0 = pin_init("DIO0", OUTPUT_LOW);

  const pin_watch_config_t nss_watch = {
    .edge = BOTH, .pin_change = on_nss_change, .user_data = c,
  };
  pin_watch(c->nss, &nss_watch);
  const pin_watch_config_t rst_watch = {
    .edge = FALLING, .pin_change = on_rst_change, .user_data = c,
  };
  pin_watch(c->rst, &rst_watch);

  spi_config_t spi_cfg = {
    .sck = pin_init("SCK", INPUT),
    .miso = pin_init("MISO", INPUT),
    .mosi = pin_init("MOSI", INPUT),
    .mode = 0,
    .done = on_spi_done,
    .user_data = c,
  };
  c->spi = spi_init(&spi_cfg);

  printf("[sx1278] ready, version 0x12\n");
}
