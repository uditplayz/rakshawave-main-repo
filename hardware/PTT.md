# Push-to-talk voice (PTT)

Half-duplex voice between nearby vehicles over the same 433 MHz LoRa link as the hazard alerts.
The Raspberry Pi does the audio; the ESP32-C3 is only the LoRa modem.

```
 mic (I2S) -> Pi: Codec2 700C -> VoicePacket JSON line -> USB serial -> ESP32 -> SX1278 -> air
 air -> SX1278 -> ESP32 -> USB serial -> Pi: re-order, conceal gaps, Codec2 decode -> amp (I2S) -> speaker
```

## Hardware (schematic: `v2v 1.2  .kicad_sch`)

| Part | Connects to | Notes |
|---|---|---|
| SW1 push button | Pi GPIO17 (`PTT_BTN`) to GND | internal pull-up, 30 ms software debounce |
| J3 I2S MEMS mic module (INMP441 type) | BCLK GPIO18, WS GPIO19, SD GPIO20 (`I2S_MIC_DIN`), VDD `+3.3V`, L/R and GND | header order is this board's, wire the module by pin name |
| J4 I2S class-D amp module (MAX98357A type) | BCLK GPIO18, LRC GPIO19, DIN GPIO21 (`I2S_SPK_DOUT`), VIN `+5V_PI`, GND | speaker goes on the module; SD and GAIN left open (module defaults) |

The Pi header pins are the standard I2S pins, so one overlay drives both modules.
On the Pi (Raspberry Pi OS), in `/boot/firmware/config.txt`:

```
dtoverlay=googlevoicehat-soundcard
```

Not tried on real hardware: confirm the overlay works with your mic/amp modules.

## Software

```bash
pip install pycodec2 sounddevice gpiozero     # Linux also needs: sudo apt install libcodec2-dev libportaudio2
python -m software.voice.node --port /dev/ttyUSB1 --vehicle-id VEH-001
```

| Piece | File |
|---|---|
| Codec2 700C wrapper | `software/voice/codec.py` |
| Transmitter, receiver (re-order + loss concealment), half-duplex controller | `software/voice/ptt.py` |
| Mic, speaker, GPIO button, WAV back ends | `software/voice/audio.py` |
| Pi entry point (button + mic + speaker + ESP32 serial) | `software/voice/node.py` |
| Wire format | `VoicePacket` in `software/wimesh/protocol.py` |
| Modem path in firmware | `isVoiceLine()` etc. in `firmware/esp32/main.ino` |
| MCP tools | `ptt_talk`, `ptt_state` in `software/mcp_bridge.py` |

Rules the code enforces:

- **Half duplex.** Pressing the key while another vehicle is talking is refused (channel busy); audio that arrives while you
  talk is dropped.
- **Talk limit.** 30 s per key-down; the stream is ended at the limit.
- **Not relayed.** Voice chunks have `max_hops = 0`, so they never eat the airtime of vehicles out of range. Hazard alerts
  are unchanged and still relay up to 5 hops.
- **Never an alarm.** The ESP32 does not drive the buzzer or LED for voice, only the OLED ("VOICE TX" / "VOICE RX").
- **One frame fits one LoRa packet.** 20 Codec2 frames (0.8 s) -> 80 B of speech -> 206 B JSON line (limit 255). The
  firmware refuses longer lines rather than truncating them.
- **Loss handling.** Chunks are re-ordered by sequence number; a missing chunk is replaced by silence after a 1 s wait, and
  a stream whose final chunk is lost ends after 3 s.

## Link budget (SF7, 125 kHz, CR 4/5)

| | |
|---|---|
| Codec2 700C | 4 B per 40 ms = 100 B/s of speech |
| One chunk | 206 B on the wire, 0.33 s of airtime for 0.8 s of speech |
| One talker | about 41 % of the channel |

So it keeps up with live speech, but a second simultaneous talker would not fit, hence half duplex. Check your local
rules on 433 MHz duty cycle before field use.

## What is tested

- `pytest tests/test_ptt.py`: packet size and round trip, chunking, re-order, duplicates, loss concealment, lost final
  chunk, talk limit, half duplex both ways, mesh delivery, serial modem decoding.
- `ptt_talk` on the radio model: in range (complete, audible), out of range (nothing received), not relayed.
- Wokwi `tests/wokwi/ptt.test.yaml`: a real voice line written to the ESP32 is transmitted unchanged, the buzzer and LED
  stay silent, the OLED shows "VOICE TX", an over-long line is refused, a hazard line still alerts.

## What is not tested

- Real microphone, speaker, I2S wiring and the Pi GPIO button (no hardware here).
- Voice receive on the ESP32 in simulation: the Wokwi SX1278 chip models transmit only.
- Intelligibility: Codec2 700C is robotic and sensitive to noise; listen to it on the real mic before relying on it.
