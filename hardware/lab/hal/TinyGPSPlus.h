// TinyGPSPlus (v1.0) API subset: GGA/RMC parsing with checksum validation and
// the same commit rules (a field updates only when the whole sentence checks out).
#pragma once
#include "Arduino.h"

#define _GPS_KMPH_PER_KNOT 1.852

class TinyGPSLocation {
 public:
  bool isValid() const { return valid; }
  bool isUpdated() const { return updated; }
  double lat() { updated = false; return latitude; }
  double lng() { updated = false; return longitude; }
  uint32_t age() const { return valid ? millis() - lastCommitTime : (uint32_t)-1; }
  bool valid = false, updated = false;
  double latitude = 0, longitude = 0;
  uint32_t lastCommitTime = 0;
};

class TinyGPSDecimal {
 public:
  bool isValid() const { return valid; }
  bool isUpdated() const { return updated; }
  int32_t value() { updated = false; return val; }
  bool valid = false, updated = false;
  int32_t val = 0;
};

class TinyGPSInteger {
 public:
  bool isValid() const { return valid; }
  uint32_t value() { return val; }
  bool valid = false;
  uint32_t val = 0;
};

class TinyGPSSpeed : public TinyGPSDecimal {
 public:
  double knots() { return value() / 100.0; }
  double kmph() { return _GPS_KMPH_PER_KNOT * value() / 100.0; }
  double mps() { return 0.51444444 * value() / 100.0; }
};

class TinyGPSCourse : public TinyGPSDecimal {
 public:
  double deg() { return value() / 100.0; }
};

class TinyGPSAltitude : public TinyGPSDecimal {
 public:
  double meters() { return value() / 100.0; }
};

class TinyGPSHDOP : public TinyGPSDecimal {
 public:
  double hdop() { return value() / 100.0; }
};

class TinyGPSPlus {
 public:
  bool encode(char c);
  TinyGPSLocation location;
  TinyGPSSpeed speed;
  TinyGPSCourse course;
  TinyGPSAltitude altitude;
  TinyGPSInteger satellites;
  TinyGPSHDOP hdop;
  uint32_t charsProcessed() const { return encodedCharCount; }
  uint32_t sentencesWithFix() const { return sentencesWithFixCount; }
  uint32_t failedChecksum() const { return failedChecksumCount; }
  uint32_t passedChecksum() const { return passedChecksumCount; }

 private:
  enum { SENTENCE_OTHER, SENTENCE_GGA, SENTENCE_RMC };
  bool endOfTerm();
  static int32_t parseDecimal(const char* t);
  static double parseDegrees(const char* t);
  char term[20];
  uint8_t termNumber = 0, termOffset = 0, curSentenceType = SENTENCE_OTHER;
  uint8_t parity = 0;
  bool isChecksumTerm = false, sentenceHasFix = false;
  double newLat = 0, newLng = 0;
  bool newLatSouth = false, newLngWest = false;
  int32_t newSpeed = 0, newCourse = 0, newAlt = 0, newHdop = 0;
  uint32_t newSats = 0;
  bool haveSpeed = false, haveCourse = false, haveAlt = false, haveHdop = false, haveSats = false, haveLoc = false;
  uint32_t encodedCharCount = 0, sentencesWithFixCount = 0, failedChecksumCount = 0, passedChecksumCount = 0;
};
