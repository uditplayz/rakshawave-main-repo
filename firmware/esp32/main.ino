/*
  RakshaWave — Smart Road Sentinel
  ESP32 firmware skeleton

  Hardware blocks (from the SIH26220 pitch deck):
    - AI Camera            -> pothole / hazard frame capture (streamed to
                               the companion board / Raspberry Pi running
                               software/vision/hazard_detector.py over
                               serial or Wi-Fi, since ESP32 alone is too
                               constrained for OpenCV inference)
    - MPU6050 IMU          -> impact / vibration sensing (I2C)
    - GPS module (NEO-6M)  -> location & speed tracking (UART, NMEA)
    - LoRa module (SX1278) -> V2V WiMesh broadcast (SPI)
    - ESP32                -> data processing & system control

  This sketch reads the IMU + GPS, runs the same impact-threshold /
  HDOP-reliability logic as software/sensors/imu.py and
  software/sensors/gps.py, and packs a HAZARD_ALERT packet whose JSON
  shape matches software/wimesh/protocol.py exactly, so a Python
  gateway node (running the full software stack) can decode it
  transparently over serial or via the LoRa receive side.

  Libraries used (install via Arduino Library Manager):
    - Adafruit MPU6050 + Adafruit Unified Sensor
    - TinyGPSPlus
    - LoRa (sandeepmistry/arduino-LoRa)
    - ArduinoJson
*/

#include <Wire.h>
#include <Adafruit_MPU6050.h>
#include <Adafruit_Sensor.h>
#include <TinyGPSPlus.h>
#include <SPI.h>
#include <LoRa.h>
#include <ArduinoJson.h>

// ---- Pin configuration -----------------------------------------------
#define GPS_RX_PIN     16
#define GPS_TX_PIN     17
#define LORA_SS_PIN     5
#define LORA_RST_PIN   14
#define LORA_DIO0_PIN   2
#define LORA_FREQ_HZ  433E6

// ---- Thresholds (mirrors software/config.py) --------------------------
const char* VEHICLE_ID          = "VEH-ESP32-01";
const float IMPACT_THRESHOLD_G  = 1.8;
const float GYRO_THRESHOLD_DPS  = 150.0;
const float GPS_MAX_HDOP        = 3.5;
const uint8_t MAX_HOPS          = 5;

Adafruit_MPU6050 mpu;
TinyGPSPlus gps;
HardwareSerial GPSSerial(1);

unsigned long lastBroadcastMs = 0;
const unsigned long BROADCAST_COOLDOWN_MS = 3000;

void setup() {
  Serial.begin(115200);
  Wire.begin();

  if (!mpu.begin()) {
    Serial.println("MPU6050 not found — check wiring.");
  } else {
    mpu.setAccelerometerRange(MPU6050_RANGE_4_G);
    mpu.setGyroRange(MPU6050_RANGE_500_DEG);
    mpu.setFilterBandwidth(MPU6050_BAND_21_HZ);
  }

  GPSSerial.begin(9600, SERIAL_8N1, GPS_RX_PIN, GPS_TX_PIN);

  LoRa.setPins(LORA_SS_PIN, LORA_RST_PIN, LORA_DIO0_PIN);
  if (!LoRa.begin(LORA_FREQ_HZ)) {
    Serial.println("LoRa init failed — check wiring.");
  }

  Serial.println("RakshaWave node online.");
}

bool readImpact(float &magnitudeG, float &gyroDps) {
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
  doc["ttl"] = (millis() / 1000.0) + 30.0;
  doc["oid"] = nullptr;
  doc["ts"]  = millis() / 1000.0;

  String payload;
  serializeJson(doc, payload);

  LoRa.beginPacket();
  LoRa.print(payload);
  LoRa.endPacket();

  Serial.println(payload); // also emit over USB serial for the software stack
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

  // Listen for relayed / nearby vehicle alerts.
  int packetSize = LoRa.parsePacket();
  if (packetSize) {
    String received;
    while (LoRa.available()) {
      received += (char)LoRa.read();
    }
    Serial.print("RX: ");
    Serial.println(received);
    // A full gateway node would decode + relay per protocol.py's
    // hop-count / TTL rules here.
  }

  delay(50);
}
