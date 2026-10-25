#!/usr/bin/env bash
# Build firmware/esp32/main.ino (unmodified) for the virtual lab:
#   hardware/lab/web/firmware.wasm
# Needs the Zig toolchain (clang + wasi-libc + libc++):  pip install ziglang
# and Binaryen's wasm-opt (npm install binaryen, or set WASM_OPT)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
ZIG="${ZIG:-python3 -m ziglang}"
OUT="$HERE/../web/firmware.wasm"
SRC=(core.cpp LoRa.cpp Adafruit_MPU6050.cpp Adafruit_GFX.cpp Adafruit_SSD1306.cpp TinyGPSPlus.cpp ArduinoJson.cpp)
cd "$HERE"
$ZIG c++ -target wasm32-wasi -mexec-model=reactor -O2 -std=gnu++17 \
  -fno-exceptions -fno-rtti -Wall -Wno-unused-function -Wno-nullability-completeness \
  -I"$HERE" -include Arduino.h \
  -x c++ "$ROOT/firmware/esp32/main.ino" -x none "${SRC[@]}" \
  -Wl,--strip-all -Wl,--export=malloc -Wl,--export=free -Wl,-z,stack-size=65536 \
  -o "$OUT"
# Binaryen asyncify: lets the lab suspend the firmware inside delay()/yield() so the
# boards interleave in virtual time (npm package "binaryen" provides wasm-opt)
WASM_OPT="${WASM_OPT:-npx --yes -p binaryen@123 wasm-opt}"
$WASM_OPT "$OUT" --all-features --asyncify --pass-arg=asyncify-imports@hal.delay_us -O2 -o "$OUT"
echo "built $OUT ($(wc -c < "$OUT") bytes)"
