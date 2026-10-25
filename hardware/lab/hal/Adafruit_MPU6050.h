// Adafruit_MPU6050 (v2.x) API. Same register traffic as the real driver
// (Adafruit_BusIO register reads/writes over I2C).
#pragma once
#include "Arduino.h"
#include "Wire.h"
#include "Adafruit_Sensor.h"

#define MPU6050_I2CADDR_DEFAULT 0x68
#define MPU6050_DEVICE_ID 0x68
#define MPU6050_SMPLRT_DIV 0x19
#define MPU6050_CONFIG 0x1A
#define MPU6050_GYRO_CONFIG 0x1B
#define MPU6050_ACCEL_CONFIG 0x1C
#define MPU6050_SIGNAL_PATH_RESET 0x68
#define MPU6050_PWR_MGMT_1 0x6B
#define MPU6050_WHO_AM_I 0x75
#define MPU6050_ACCEL_OUT 0x3B

typedef enum {
  MPU6050_RANGE_2_G = 0b00,
  MPU6050_RANGE_4_G = 0b01,
  MPU6050_RANGE_8_G = 0b10,
  MPU6050_RANGE_16_G = 0b11,
} mpu6050_accel_range_t;

typedef enum {
  MPU6050_RANGE_250_DEG,
  MPU6050_RANGE_500_DEG,
  MPU6050_RANGE_1000_DEG,
  MPU6050_RANGE_2000_DEG,
} mpu6050_gyro_range_t;

typedef enum {
  MPU6050_BAND_260_HZ,
  MPU6050_BAND_184_HZ,
  MPU6050_BAND_94_HZ,
  MPU6050_BAND_44_HZ,
  MPU6050_BAND_21_HZ,
  MPU6050_BAND_10_HZ,
  MPU6050_BAND_5_HZ,
} mpu6050_bandwidth_t;

class Adafruit_MPU6050 {
 public:
  bool begin(uint8_t i2c_addr = MPU6050_I2CADDR_DEFAULT, TwoWire* wire = &Wire, int32_t sensorID = 0);
  bool getEvent(sensors_event_t* accel, sensors_event_t* gyro, sensors_event_t* temp);
  void setAccelerometerRange(mpu6050_accel_range_t r) { writeBits(MPU6050_ACCEL_CONFIG, r, 2, 3); }
  mpu6050_accel_range_t getAccelerometerRange() { return (mpu6050_accel_range_t)readBits(MPU6050_ACCEL_CONFIG, 2, 3); }
  void setGyroRange(mpu6050_gyro_range_t r) { writeBits(MPU6050_GYRO_CONFIG, r, 2, 3); }
  mpu6050_gyro_range_t getGyroRange() { return (mpu6050_gyro_range_t)readBits(MPU6050_GYRO_CONFIG, 2, 3); }
  void setFilterBandwidth(mpu6050_bandwidth_t b) { writeBits(MPU6050_CONFIG, b, 3, 0); }
  mpu6050_bandwidth_t getFilterBandwidth() { return (mpu6050_bandwidth_t)readBits(MPU6050_CONFIG, 3, 0); }
  void setSampleRateDivisor(uint8_t d) { writeReg(MPU6050_SMPLRT_DIV, d); }
  void reset();

 private:
  bool readRegs(uint8_t reg, uint8_t* buf, size_t n);
  bool writeReg(uint8_t reg, uint8_t v);
  uint8_t readReg(uint8_t reg) { uint8_t v = 0; readRegs(reg, &v, 1); return v; }
  uint8_t readBits(uint8_t reg, uint8_t bits, uint8_t shift) { return (readReg(reg) >> shift) & ((1 << bits) - 1); }
  void writeBits(uint8_t reg, uint8_t value, uint8_t bits, uint8_t shift) {
    uint8_t mask = ((1 << bits) - 1) << shift;
    writeReg(reg, (readReg(reg) & ~mask) | ((value << shift) & mask));
  }
  TwoWire* wire_ = nullptr;
  uint8_t addr_ = MPU6050_I2CADDR_DEFAULT;
  int32_t sensorID_ = 0;
};
