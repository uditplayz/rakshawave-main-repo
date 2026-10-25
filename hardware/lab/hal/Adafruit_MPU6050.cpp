#include "Adafruit_MPU6050.h"

bool Adafruit_MPU6050::readRegs(uint8_t reg, uint8_t* buf, size_t n) {
  wire_->beginTransmission(addr_);
  wire_->write(reg);
  if (wire_->endTransmission(false) != 0) return false;  // repeated start
  if (wire_->requestFrom((uint16_t)addr_, n, true) != n) return false;
  for (size_t i = 0; i < n; i++) buf[i] = (uint8_t)wire_->read();
  return true;
}

bool Adafruit_MPU6050::writeReg(uint8_t reg, uint8_t v) {
  wire_->beginTransmission(addr_);
  wire_->write(reg);
  wire_->write(v);
  return wire_->endTransmission() == 0;
}

bool Adafruit_MPU6050::begin(uint8_t i2c_addr, TwoWire* wire, int32_t sensorID) {
  wire_ = wire;
  addr_ = i2c_addr;
  sensorID_ = sensorID;
  wire_->begin();
  wire_->beginTransmission(addr_);  // Adafruit_I2CDevice::detected()
  if (wire_->endTransmission() != 0) return false;
  if (readReg(MPU6050_WHO_AM_I) != MPU6050_DEVICE_ID) return false;
  reset();
  setSampleRateDivisor(0);
  setFilterBandwidth(MPU6050_BAND_260_HZ);
  setGyroRange(MPU6050_RANGE_500_DEG);
  setAccelerometerRange(MPU6050_RANGE_2_G);
  writeReg(MPU6050_PWR_MGMT_1, 0x01);  // clock: PLL with X gyro reference
  delay(100);
  return true;
}

void Adafruit_MPU6050::reset() {
  writeReg(MPU6050_PWR_MGMT_1, readReg(MPU6050_PWR_MGMT_1) | 0x80);
  while (readReg(MPU6050_PWR_MGMT_1) & 0x80) delay(1);
  delay(100);
  writeReg(MPU6050_SIGNAL_PATH_RESET, 0x7);
  delay(100);
}

bool Adafruit_MPU6050::getEvent(sensors_event_t* accel, sensors_event_t* gyro, sensors_event_t* temp) {
  uint8_t b[14];
  if (!readRegs(MPU6050_ACCEL_OUT, b, 14)) return false;
  int16_t rawAccX = b[0] << 8 | b[1], rawAccY = b[2] << 8 | b[3], rawAccZ = b[4] << 8 | b[5];
  int16_t rawTemp = b[6] << 8 | b[7];
  int16_t rawGyroX = b[8] << 8 | b[9], rawGyroY = b[10] << 8 | b[11], rawGyroZ = b[12] << 8 | b[13];

  float accel_scale = 1;
  switch (getAccelerometerRange()) {
    case MPU6050_RANGE_16_G: accel_scale = 2048; break;
    case MPU6050_RANGE_8_G: accel_scale = 4096; break;
    case MPU6050_RANGE_4_G: accel_scale = 8192; break;
    case MPU6050_RANGE_2_G: accel_scale = 16384; break;
  }
  float gyro_scale = 1;
  switch (getGyroRange()) {
    case MPU6050_RANGE_250_DEG: gyro_scale = 131; break;
    case MPU6050_RANGE_500_DEG: gyro_scale = 65.5; break;
    case MPU6050_RANGE_1000_DEG: gyro_scale = 32.8; break;
    case MPU6050_RANGE_2000_DEG: gyro_scale = 16.4; break;
  }
  int32_t ts = (int32_t)millis();
  memset(accel, 0, sizeof(*accel));
  memset(gyro, 0, sizeof(*gyro));
  memset(temp, 0, sizeof(*temp));
  accel->sensor_id = gyro->sensor_id = temp->sensor_id = sensorID_;
  accel->timestamp = gyro->timestamp = temp->timestamp = ts;
  accel->acceleration.x = rawAccX / accel_scale * SENSORS_GRAVITY_STANDARD;
  accel->acceleration.y = rawAccY / accel_scale * SENSORS_GRAVITY_STANDARD;
  accel->acceleration.z = rawAccZ / accel_scale * SENSORS_GRAVITY_STANDARD;
  gyro->gyro.x = rawGyroX / gyro_scale * SENSORS_DPS_TO_RADS;
  gyro->gyro.y = rawGyroY / gyro_scale * SENSORS_DPS_TO_RADS;
  gyro->gyro.z = rawGyroZ / gyro_scale * SENSORS_DPS_TO_RADS;
  temp->temperature = (rawTemp / 340.0) + 36.53;
  return true;
}
