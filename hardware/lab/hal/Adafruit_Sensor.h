// Adafruit Unified Sensor types used by Adafruit_MPU6050.
#pragma once
#include "Arduino.h"

#define SENSORS_GRAVITY_STANDARD (9.80665F)
#define SENSORS_DPS_TO_RADS (0.017453293F)

typedef struct {
  union {
    float v[3];
    struct { float x, y, z; };
  };
} sensors_vec_t;

typedef struct {
  int32_t version;
  int32_t sensor_id;
  int32_t type;
  int32_t reserved0;
  int32_t timestamp;
  union {
    float data[4];
    sensors_vec_t acceleration;
    sensors_vec_t gyro;
    float temperature;
  };
} sensors_event_t;
