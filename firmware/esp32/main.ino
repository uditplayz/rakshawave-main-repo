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
    ESP32 -> Pi : one bare JSON packet per line (also for packets heard on LoRa)
    Pi -> ESP32 : one JSON packet per line; the ESP32 transmits it over LoRa

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

#define OLED_ADDR    0x3C
#define OLED_WIDTH    128
#define OLED_HEIGHT    32

// ---- Thresholds (mirrors software/config.py) --------------------------------
const char* VEHICLE_ID          = "VEH-ESP32-01";
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

void showText(const char* line1, const char* line2) {
  if (!oledOk) return;
  oled.clearDisplay();
  oled.setTextColor(SSD1306_WHITE);
  oled.setTextSize(1);
  oled.setCursor(0, 0);
  oled.println(line1);
  oled.setCursor(0, 16);
  oled.println(line2);
  oled.display();
}

void alertOn(const char* title, const char* hazardType) {
  digitalWrite(BUZZER_PIN, LOW);  // active low
  digitalWrite(LED_PIN, LOW);     // active low
  alertOffAtMs = millis() + ALERT_DURATION_MS;
  showText(title, hazardType);
}

void alertOff() {
  digitalWrite(BUZZER_PIN, HIGH);
  digitalWrite(LED_PIN, HIGH);
  showText("RakshaWave", "monitoring");
}

void setup() {
  Serial.begin(115200);

  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(LED_PIN, OUTPUT);
  digitalWrite(BUZZER_PIN, HIGH);
  digitalWrite(LED_PIN, HIGH);

  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);

  oledOk = oled.begin(SSD1306_SWITCHCAPVCC, OLED_ADDR);
  Serial.println(oledOk ? "OLED ok" : "OLED not found - check wiring.");
  showText("RakshaWave", "booting...");

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
    Serial.println("LoRa ok");
  }

  serialLine.reserve(SERIAL_LINE_MAX);
  Serial.println("RakshaWave node online.");
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

void loraSend(const String &payload) {
  LoRa.beginPacket();
  LoRa.print(payload);
  LoRa.endPacket();
}

void broadcastHazardAlert(float confidence, float lat, float lon, float speedKmh) {
  StaticJsonDocument<256> doc;
  doc["id"]  = String(millis()) + "-" + VEHICLE_ID;
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

  loraSend(payload);
  Serial.println(payload);            // bare JSON line for LoRaNode.poll_serial()
  alertOn("ALERT SENT", "unknown_hazard");
}

// A full JSON line arrived from the Raspberry Pi: put it on the air.
void handleSerialLine(const String &line) {
  if (line.length() == 0 || line[0] != '{') return;

  StaticJsonDocument<384> doc;
  const char* hz = "hazard";
  if (deserializeJson(doc, line) == DeserializationError::Ok) {
    hz = doc["hz"] | "hazard";
  }
  loraSend(line);
  alertOn("PI -> LORA", hz);
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

void pollLora() {
  int packetSize = LoRa.parsePacket();
  if (!packetSize) return;

  String received;
  while (LoRa.available()) {
    received += (char)LoRa.read();
  }
  Serial.println(received);  // bare JSON, no prefix (LoRaNode.poll_serial decodes it)

  StaticJsonDocument<384> doc;
  const char* hz = "hazard";
  if (deserializeJson(doc, received) == DeserializationError::Ok) {
    hz = doc["hz"] | "hazard";
  }
  alertOn("ALERT HEARD", hz);
  // A full gateway node would relay per protocol.py's hop-count / TTL rules.
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

  if (alertOffAtMs != 0 && (long)(millis() - alertOffAtMs) >= 0) {
    alertOffAtMs = 0;
    alertOff();
  }

  delay(10);
}
