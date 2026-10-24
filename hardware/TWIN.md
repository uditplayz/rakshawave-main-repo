# 3D twin

An interactive 3D model of the device in the browser, driven by the **real firmware** running in the Wokwi simulator.

```
python hardware/gui/app.py        # then open the "3D Twin" link, or http://127.0.0.1:8765/twin
```

Needs a built firmware (`pio run`), `wokwi-cli` and a Wokwi token (environment variable `WOKWI_CLI_TOKEN`, or typed
into the page; not stored). Press **Start**.

## What is real, what is drawn

| On screen | Comes from |
|---|---|
| LED and buzzer (glow, sound rings) | the real levels of ESP32 pins IO10 and IO9, read through `wokwi-cli mcp` |
| OLED texture | a real screenshot of the simulated SSD1306 |
| Serial panel, LoRa waves | the real serial output; a wave leaves the antenna for every hazard or voice frame |
| Accel arrow, "Drive over pothole" | sets the simulated MPU6050 `accelZ` (3.0 g for 350 ms for a hit) |
| Fusion result, hazard cluster, second vehicle | the Pi-side Python stack (`software/mcp_bridge.py`) fed with the packet the firmware really sent |
| Push to talk | real Codec2/VoicePacket code; every frame is written to the firmware over serial, and also played to a simulated listener through the radio model with loss and concealment, so you hear it |
| 3D shapes, the car, the road | drawn procedurally; sizes follow the real boards but this is not a CAD model |

## Using it

- **Drive over pothole**: the car drives over the pothole, then the spike goes into the simulator; the firmware raises the alert.
- **accelZ slider**: set the simulated accelerometer by hand (alert at 2.8 g or more; hazard alerts repeat at most every 3 s).
- **2nd vehicle +12 m**: adds a corroborating report; the cluster turns VERIFIED (a pothole never raises an EMERGENCY).
- **HOLD TO TALK** (button, the red button on the 3D board, or Space): test speech or your microphone goes out; move the
  distance slider to put the listener out of range.
- **Exploded view** slider and the view buttons; click a part for its schematic reference and role.

## Limits

- The simulation talks to Wokwi's servers, so it needs internet and takes about 0.3 s per control action; LED and buzzer
  are sampled about once a second, so a very short blink can be missed on screen (the Tests tab checks the pins exactly).
- A browser tab in the background pauses animation; the pothole hit is timer driven so it still happens.
- The ESP32 firmware never receives voice in this setup (the simulated LoRa chip only transmits); the listener is the
  Python radio model.
