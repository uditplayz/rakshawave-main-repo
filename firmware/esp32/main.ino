/*
  RakshaWave — Smart Road Sentinel
  ESP32-C3 firmware (pin map matches "v2v 1.2  .kicad_sch")

  Hardware blocks:
    - MPU6050 IMU          -> impact / vibration sensing (I2C 0x68)
    - SSD1306 0.91" OLED   -> hazard type readout (I2C 0x3C, 128x32)
    - GPS (RXM-GPS-FM)     -> location & speed tracking (UART, NMEA, 9600)
    - LoRa SX1278 (Ra-01)  -> V2V WiMesh broadcast (SPI)
    - Buzzer + LED         -> driver alert (both active LOW)
    - Raspberry Pi 5       -> OpenCV stage; talks JSON lines over USB serial

  Pin map (ESP32-C3-DevKitM-1, U4):
    I2C   SDA=IO5  SCL=IO6
    SPI   SCK=IO18 MISO=IO19 MOSI=IO7 NSS=IO4  RST=IO0 DIO0=IO8
    GPS   RX=IO2   TX=IO1   (UART1; IO20/IO21 stay free for the USB-UART console)
    Buzzer=IO9 (active low)   LED=IO10 (active low)

  USB serial protocol (matches software/wimesh/protocol.py + LoRaNode):
    ESP32 -> Pi : one bare JSON packet per line (also for packets heard on LoRa,
                  each preceded by a non-JSON "RX rssi=.. snr=.." line)
    Pi -> ESP32 : one JSON packet per line; the ESP32 transmits it over LoRa

  WiMesh relay: the ESP32 relays hazard packets on its own (hop count, TTL,
  duplicate suppression, RSSI-weighted backoff), so a mesh works with or
  without a Raspberry Pi attached. Voice is never relayed.

  Radio: 433 MHz, SF7, BW 125 kHz, CR 4/5, 8-symbol preamble, CRC on,
  sync word 0x12, +17 dBm on PA_BOOST.

  The "ttl" field is relative seconds-to-live (< 1e6); protocol.py converts
  it to an absolute expiry on decode.

  Libraries: Adafruit MPU6050, Adafruit SSD1306 (+GFX), TinyGPSPlus,
             LoRa (sandeepmistry), ArduinoJson.
*/

#include <Arduino.h>
#include <Wire.h>
#include <SPI.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <Adafruit_GFX.h>
#include <Adafruit_SSD1306.h>
#include <TinyGPSPlus.h>
#include <LoRa.h>
#include <ArduinoJson.h>

// ---- Pin configuration (see header) ----------------------------------------
#define I2C_SDA_PIN     5
#define I2C_SCL_PIN     6
#define LORA_SCK_PIN   18
#define LORA_MISO_PIN  19
#define LORA_MOSI_PIN   7
#define LORA_SS_PIN     4
#define LORA_RST_PIN    0
#define LORA_DIO0_PIN   8
#define GPS_RX_PIN      2   // from GPS TX; idle-high also keeps the IO2 strap high
#define GPS_TX_PIN      1
#define BUZZER_PIN      9
#define LED_PIN        10
#define LORA_FREQ_HZ  433E6
#define LORA_SF           7
#define LORA_BW_HZ    125E3
#define LORA_CR_DEN       5
#define LORA_PREAMBLE     8
#define LORA_TX_DBM      17

#define OLED_ADDR    0x3C
#define OLED_WIDTH    128
#define OLED_HEIGHT    32

// ---- Thresholds (mirrors software/config.py) --------------------------------
char VEHICLE_ID[12];                     // "RW-xxxxxx" from the factory MAC (unique per board)
const float IMPACT_THRESHOLD_G  = 1.8;
const float GYRO_THRESHOLD_DPS  = 150.0;
const float GPS_MAX_HDOP        = 3.5;
const uint8_t MAX_HOPS          = 5;
const float PACKET_TTL_S        = 30.0;  // relative; see protocol.py

Adafruit_MPU6050 mpu;
Adafruit_SSD1306 oled(OLED_WIDTH, OLED_HEIGHT, &Wire, -1);
TinyGPSPlus gps;
HardwareSerial GPSSerial(1);

bool mpuOk = false;
bool oledOk = false;

unsigned long lastBroadcastMs = 0;
const unsigned long BROADCAST_COOLDOWN_MS = 3000;

// Alert output (buzzer + LED, both active low) is switched off by loop().
unsigned long alertOffAtMs = 0;
const unsigned long ALERT_DURATION_MS = 1500;

String serialLine;
const size_t SERIAL_LINE_MAX = 400;
const size_t LORA_MAX_FRAME = 255;  // SX127x FIFO / LoRa payload limit

void showText(const char* line1, const char* line2, const char* line3) {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.println(line1);
  oled.setCursor(0, line3 ? 12 : 16);
  oled.println(line2);
  if (line3) {
    oled.setCursor(0, 24);
    oled.println(line3);
  }
  oled.display();
}

void showIdle() {
  showText("RakshaWave", "monitoring", VEHICLE_ID);
}

void alertOn(const char* title, const char* hazardType, const char* detail) {
  digitalWrite(BUZZER_PIN, LOW);  // active low
  digitalWrite(LED_PIN, LOW);     // active low
  alertOffAtMs = millis() + ALERT_DURATION_MS;
  showText(title, hazardType, detail);
}

void alertOff() {
  digitalWrite(BUZZER_PIN, HIGH);
  digitalWrite(LED_PIN, HIGH);
  showIdle();
}

// Push-to-talk voice chunks are not hazards: no buzzer, no LED, just a note on
// the OLED. (The Pi's voice node does the audio; this board is only the modem.)
bool isVoiceLine(const String &line) {
  return line.indexOf("\"t\":\"VOICE\"") >= 0;
}

unsigned long voiceNoteOffAtMs = 0;
const unsigned long VOICE_NOTE_MS = 1200;

void voiceNote(const char* title) {
  voiceNoteOffAtMs = millis() + VOICE_NOTE_MS;
  if (alertOffAtMs == 0) showText(title, "push-to-talk", nullptr);  // never cover a hazard alert
}

void setup() {
  uint64_t mac = ESP.getEfuseMac();  // byte 0 is the first MAC octet
  snprintf(VEHICLE_ID, sizeof(VEHICLE_ID), "RW-%02X%02X%02X",
           (uint8_t)(mac >> 24), (uint8_t)(mac >> 32), (uint8_t)(mac >> 40));

  Serial.setRxBufferSize(1024);  // a blocking LoRa TX must not overflow the Pi's next line
  Serial.begin(115200);

  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  pinMode(LORA_DIO0_PIN, INPUT);  // RxDone from the SX1278
  digitalWrite(BUZZER_PIN, HIGH);
  digitalWrite(LED_PIN, HIGH);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);

  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  Serial.println(oledOk ? "OLED ok" : "OLED not found - check wiring.");
  showText("RakshaWave", "booting...", nullptr);

  mpuOk = mpu.begin(0x68, &Wire);
  if (!mpuOk) {
    Serial.println("MPU6050 not found - check wiring.");
  } else {
    Serial.println("MPU6050 ok");
    mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  }

  GPSSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  SPI.begin(LORA_SCK_PIN, LORA_MISO_PIN, LORA_MOSI_PIN, LORA_SS_PIN);
  LoRa.setPins(LORA_SS_PIN, LORA_RST_PIN, LORA_DIO0_PIN);
  if (!LoRa.begin(LORA_FREQ_HZ)) {
    Serial.println("LoRa init failed - check wiring.");
  } else {
    LoRa.setSpreadingFactor(LORA_SF);
    LoRa.setSignalBandwidth(LORA_BW_HZ);
    LoRa.setCodingRate4(LORA_CR_DEN);
    LoRa.setPreambleLength(LORA_PREAMBLE);
    LoRa.setSyncWord(0x12);
    LoRa.enableCrc();               // without it a corrupted frame is delivered as data
    LoRa.setTxPower(LORA_TX_DBM);
    LoRa.receive();                 // continuous RX: see pollLora()
    Serial.println("LoRa ok");
  }

  serialLine.reserve(SERIAL_LINE_MAX);
  randomSeed(LoRa.random() ^ (uint32_t)mac);
  Serial.print("RakshaWave node online. id=");
  Serial.println(VEHICLE_ID);
  alertOff();
}

bool readImpact(float &magnitudeG, float &gyroDps) {
  if (!mpuOk) {
    magnitudeG = 1.0;
    gyroDps = 0.0;
    return false;
  }
  sensors_event_t a, g, temp;
  mpu.getEvent(&a, &g, &temp);

  // Convert m/s^2 -> g, subtract resting gravity.
  float ax = a.acceleration.x / 9.80665;
  float ay = a.acceleration.y / 9.80665;
  float az = a.acceleration.z / 9.80665;
  magnitudeG = sqrt(ax * ax + ay * ay + az * az);

  float gx = g.gyro.x * 57.2958; // rad/s -> deg/s
  float gy = g.gyro.y * 57.2958;
  float gz = g.gyro.z * 57.2958;
  gyroDps = sqrt(gx * gx + gy * gy + gz * gz);

  float deltaG = fabs(magnitudeG - 1.0);
  return (deltaG >= IMPACT_THRESHOLD_G) || (gyroDps >= GYRO_THRESHOLD_DPS);
}

// Listen before talk: wait (up to ~0.5 s) while another frame is on the air.
// Frames weaker than the threshold are under the noise and cannot be sensed.
const int LBT_THRESHOLD_DBM = -105;

void loraSend(const String &payload) {
  for (int i = 0; i < 100 && LoRa.rssi() > LBT_THRESHOLD_DBM; i++) delay(5);
  LoRa.beginPacket();
  LoRa.print(payload);
  LoRa.endPacket();               // blocks for the time on air
  LoRa.receive();                 // back to listening
}

// Semtech AN1200.13 time on air for the settings above (explicit header, CRC on).
float loraAirtimeMs(size_t payloadBytes) {
  const float tSym = (float)(1 << LORA_SF) / (LORA_BW_HZ / 1000.0);  // ms
  const int de = tSym > 16.0 ? 1 : 0;                                 // low data rate optimise
  float n = (8.0 * payloadBytes - 4.0 * LORA_SF + 28 + 16) / (4.0 * (LORA_SF - 2 * de));
  int nPayload = 8 + max((int)ceil(n) * (LORA_CR_DEN), 0);
  return (LORA_PREAMBLE + 4.25) * tSym + nPayload * tSym;
}

// ---- WiMesh relay -----------------------------------------------------------
// Every node rebroadcasts a hazard packet once (hop + 1, TTL reduced by the
// time it spent in the air and in this node). The wait is counted in slots of
// one frame time: nodes that heard it weakly (far away) take the first slot,
// strong (near) ones later slots, so a relay is usually on the air and heard by
// the others before their own turn. Hearing one copy relayed cancels ours
// (counter-based flooding suppression); listen-before-talk covers the rest.
const uint8_t SEEN_IDS = 32;
String seenIds[SEEN_IDS];
uint8_t seenNext = 0;

bool alreadySeen(const String &id) {
  for (uint8_t i = 0; i < SEEN_IDS; i++) {
    if (seenIds[i] == id) return true;
  }
  return false;
}

void rememberId(const String &id) {
  seenIds[seenNext] = id;
  seenNext = (seenNext + 1) % SEEN_IDS;
}

struct PendingRelay {
  bool active;
  String id;
  String payload;
  unsigned long heardAtMs;
  unsigned long dueAtMs;
  uint8_t duplicatesHeard;
};
PendingRelay relay = {false, "", "", 0, 0, 0};
const uint8_t RELAY_SUPPRESS_AFTER = 1;

void scheduleRelay(JsonDocument &doc, const String &id, int rssi, size_t frameBytes) {
  int hop = doc["hop"] | 0;
  int maxHops = doc["mh"] | (int)MAX_HOPS;
  float ttl = doc["ttl"] | PACKET_TTL_S;
  if (hop >= maxHops || relay.active) return;

  // TTL is relative: subtract the frame's own air time now, the hold time at send.
  ttl -= loraAirtimeMs(frameBytes) / 1000.0;
  if (ttl <= 0) return;
  doc["hop"] = hop + 1;
  doc["ttl"] = ttl;

  relay.active = true;
  relay.id = id;
  relay.payload = "";
  serializeJson(doc, relay.payload);
  relay.heardAtMs = millis();
  unsigned long slotMs = (unsigned long)loraAirtimeMs(relay.payload.length()) + 40;
  int slot = constrain((rssi + 125) / 12, 0, 4);
  relay.dueAtMs = millis() + 10 + slot * slotMs + random(0, 60);
  relay.duplicatesHeard = 0;
}

void serviceRelay() {
  if (!relay.active || (long)(millis() - relay.dueAtMs) < 0) return;
  if (relay.duplicatesHeard >= RELAY_SUPPRESS_AFTER) {
    relay.active = false;
    return;
  }
  if (LoRa.rssi() > LBT_THRESHOLD_DBM) {
    // Channel busy: retry after a random backoff. The frame on the air may be
    // another node's relay of this packet, which pollLora() will count first.
    relay.dueAtMs = millis() + random(20, 120);
    return;
  }
  relay.active = false;

  StaticJsonDocument<384> doc;
  if (deserializeJson(doc, relay.payload) != DeserializationError::Ok) return;
  float ttl = doc["ttl"].as<float>() - (millis() - relay.heardAtMs) / 1000.0;
  if (ttl <= 0) return;
  doc["ttl"] = round(ttl * 10.0) / 10.0;
  String out;
  serializeJson(doc, out);
  if (out.length() > LORA_MAX_FRAME) return;
  loraSend(out);
  Serial.print("RELAY hop=");
  Serial.println(doc["hop"].as<int>());
}

void broadcastHazardAlert(float confidence, float lat, float lon, float speedKmh) {
  StaticJsonDocument<256> doc;
  String id = String(millis()) + "-" + VEHICLE_ID;
  doc["id"]  = id;
  doc["t"]   = "HAZARD_ALERT";
  doc["veh"] = VEHICLE_ID;
  doc["hz"]  = "unknown_hazard";      // camera stage runs on the companion board
  doc["c"]   = confidence;
  doc["lat"] = lat;
  doc["lon"] = lon;
  doc["spd"] = speedKmh;
  doc["hop"] = 0;
  doc["mh"]  = MAX_HOPS;
  doc["ttl"] = PACKET_TTL_S;          // relative seconds-to-live
  doc["oid"] = nullptr;
  doc["ts"]  = millis() / 1000.0;     // uptime; protocol.py restamps on decode

  String payload;
  serializeJson(doc, payload);

  rememberId(id);                     // our own packet coming back is not news
  loraSend(payload);
  Serial.println(payload);            // bare JSON line for LoRaNode.poll_serial()
  alertOn("ALERT SENT", "unknown_hazard", VEHICLE_ID);
}

// A full JSON line arrived from the Raspberry Pi: put it on the air.
void handleSerialLine(const String &line) {
  if (line.length() == 0 || line[0] != '{') return;
  if (line.length() > LORA_MAX_FRAME) {
    Serial.println("ERR line too long for a LoRa frame");
    return;
  }
  if (isVoiceLine(line)) {
    loraSend(line);
    voiceNote("VOICE TX");
    return;
  }

  StaticJsonDocument<384> doc;
  const char* hz = "hazard";
  if (deserializeJson(doc, line) == DeserializationError::Ok) {
    hz = doc["hz"] | "hazard";
  }
  loraSend(line);
  alertOn("PI -> LORA", hz, nullptr);
}

void pollUsbSerial() {
  while (Serial.available() > 0) {
    char c = (char)Serial.read();
    if (c == '\r') continue;
    if (c == '\n') {
      handleSerialLine(serialLine);
      serialLine = "";
    } else if (serialLine.length() < SERIAL_LINE_MAX) {
      serialLine += c;
    } else {
      serialLine = "";  // overlong line: drop it
    }
  }
}

// The radio stays in continuous RX and raises DIO0 (IO8) on RxDone. Polling
// parsePacket() alone would use RX single mode, which times out every 100
// symbols and is only re-armed on the next loop(): a frame starting in that
// gap is lost.
void pollLora() {
  if (digitalRead(LORA_DIO0_PIN) == LOW) return;
  int packetSize = LoRa.parsePacket();   // also clears the IRQ flags
  String received;
  while (packetSize && LoRa.available()) {
    received += (char)LoRa.read();
  }
  int rssi = LoRa.packetRssi();
  float snr = LoRa.packetSnr();
  LoRa.receive();                        // re-arm before the slow work below
  if (!packetSize) return;               // CRC error: dropped by the library

  if (isVoiceLine(received)) {
    Serial.println(received);
    voiceNote("VOICE RX");
    return;
  }

  StaticJsonDocument<384> doc;
  if (deserializeJson(doc, received) != DeserializationError::Ok) {
    Serial.println("RX dropped: not a WiMesh packet");
    return;
  }
  String id = doc["id"] | "";
  const char* veh = doc["veh"] | "";
  int hop = doc["hop"] | 0;

  if (alreadySeen(id) || strcmp(veh, VEHICLE_ID) == 0) {
    // Someone relayed a packet we already have: it counts against our own relay.
    if (relay.active && relay.id == id) relay.duplicatesHeard++;
    return;
  }
  rememberId(id);

  Serial.print("RX rssi=");
  Serial.print(rssi);
  Serial.print(" snr=");
  Serial.print(snr, 1);
  Serial.print(" hop=");
  Serial.println(hop);
  Serial.println(received);  // bare JSON, no prefix (LoRaNode.poll_serial decodes it)

  char detail[22];
  snprintf(detail, sizeof(detail), "%ddBm hop%d %s", rssi, hop, veh);
  alertOn("ALERT HEARD", doc["hz"] | "hazard", detail);
  scheduleRelay(doc, id, rssi, received.length());
}

void loop() {
  while (GPSSerial.available() > 0) {
    gps.encode(GPSSerial.read());
  }

  float magnitudeG, gyroDps;
  bool impact = readImpact(magnitudeG, gyroDps);

  if (impact && gps.location.isValid() && (millis() - lastBroadcastMs) > BROADCAST_COOLDOWN_MS) {
    bool reliableFix = gps.hdop.isValid() ? (gps.hdop.hdop() <= GPS_MAX_HDOP) : false;
    float confidence = reliableFix ? 0.85 : 0.5; // IMU-only confirmation confidence

    broadcastHazardAlert(
      confidence,
      gps.location.lat(),
      gps.location.lng(),
      gps.speed.isValid() ? gps.speed.kmph() : 0.0
    );

    lastBroadcastMs = millis();
  }

  pollUsbSerial();
  pollLora();
  serviceRelay();

  if (alertOffAtMs != 0 && (long)(millis() - alertOffAtMs) >= 0) {
    alertOffAtMs = 0;
    alertOff();
  } else if (voiceNoteOffAtMs != 0 && alertOffAtMs == 0 && (long)(millis() - voiceNoteOffAtMs) >= 0) {
    voiceNoteOffAtMs = 0;
    showIdle();
  }

  delay(10);
}
