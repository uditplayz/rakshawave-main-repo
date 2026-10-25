#include "TinyGPSPlus.h"

static int fromHex(char a) {
  if (a >= 'A' && a <= 'F') return a - 'A' + 10;
  if (a >= 'a' && a <= 'f') return a - 'a' + 10;
  return a - '0';
}

bool TinyGPSPlus::encode(char c) {
  ++encodedCharCount;
  switch (c) {
    case ',':
      parity ^= (uint8_t)c;
      // fallthrough
    case '\r':
    case '\n':
    case '*': {
      bool isValidSentence = false;
      if (termOffset < sizeof(term)) {
        term[termOffset] = 0;
        isValidSentence = endOfTerm();
      }
      ++termNumber;
      termOffset = 0;
      isChecksumTerm = c == '*';
      return isValidSentence;
    }
    case '$':
      termNumber = termOffset = 0;
      parity = 0;
      curSentenceType = SENTENCE_OTHER;
      isChecksumTerm = false;
      sentenceHasFix = false;
      haveSpeed = haveCourse = haveAlt = haveHdop = haveSats = haveLoc = false;
      return false;
    default:
      if (termOffset < sizeof(term) - 1) term[termOffset++] = c;
      if (!isChecksumTerm) parity ^= c;
      return false;
  }
}

int32_t TinyGPSPlus::parseDecimal(const char* t) {
  bool negative = *t == '-';
  if (negative) ++t;
  int32_t ret = 100 * (int32_t)atol(t);
  while (*t >= '0' && *t <= '9') ++t;
  if (*t == '.') {
    if (t[1] >= '0' && t[1] <= '9') {
      ret += 10 * (t[1] - '0');
      if (t[2] >= '0' && t[2] <= '9') ret += t[2] - '0';
    }
  }
  return negative ? -ret : ret;
}

double TinyGPSPlus::parseDegrees(const char* t) {
  uint32_t leftOfDecimal = (uint32_t)atol(t);
  uint16_t minutes = (uint16_t)(leftOfDecimal % 100);
  uint32_t multiplier = 10000000UL;
  uint32_t tenMillionthsOfMinutes = minutes * multiplier;
  uint16_t deg = (uint16_t)(leftOfDecimal / 100);
  while (*t >= '0' && *t <= '9') ++t;
  if (*t == '.') {
    while ((*++t >= '0' && *t <= '9') && multiplier > 1) {
      multiplier /= 10;
      tenMillionthsOfMinutes += (*t - '0') * multiplier;
    }
  }
  uint32_t billionths = ((5 * tenMillionthsOfMinutes + 1) / 3);
  return deg + billionths / 1000000000.0;
}

bool TinyGPSPlus::endOfTerm() {
  if (isChecksumTerm) {
    uint8_t checksum = 16 * fromHex(term[0]) + fromHex(term[1]);
    if (checksum == parity) {
      passedChecksumCount++;
      if (sentenceHasFix) ++sentencesWithFixCount;
      uint32_t now = millis();
      if (curSentenceType == SENTENCE_RMC || curSentenceType == SENTENCE_GGA) {
        if (sentenceHasFix && haveLoc) {
          location.latitude = newLatSouth ? -newLat : newLat;
          location.longitude = newLngWest ? -newLng : newLng;
          location.valid = location.updated = true;
          location.lastCommitTime = now;
        }
      }
      if (curSentenceType == SENTENCE_RMC) {
        if (sentenceHasFix && haveSpeed) { speed.val = newSpeed; speed.valid = speed.updated = true; }
        if (sentenceHasFix && haveCourse) { course.val = newCourse; course.valid = course.updated = true; }
      }
      if (curSentenceType == SENTENCE_GGA) {
        if (sentenceHasFix && haveAlt) { altitude.val = newAlt; altitude.valid = altitude.updated = true; }
        if (haveSats) { satellites.val = newSats; satellites.valid = true; }
        if (haveHdop) { hdop.val = newHdop; hdop.valid = hdop.updated = true; }
      }
      return true;
    }
    ++failedChecksumCount;
    return false;
  }

  if (termNumber == 0) {
    // Talker ID is ignored: GP, GN, GL... all count.
    if (strlen(term) == 5 && !strcmp(term + 2, "GGA")) curSentenceType = SENTENCE_GGA;
    else if (strlen(term) == 5 && !strcmp(term + 2, "RMC")) curSentenceType = SENTENCE_RMC;
    else curSentenceType = SENTENCE_OTHER;
    return false;
  }
  if (curSentenceType == SENTENCE_OTHER || !term[0]) return false;

  if (curSentenceType == SENTENCE_RMC) {
    switch (termNumber) {
      case 2: sentenceHasFix = term[0] == 'A'; break;
      case 3: newLat = parseDegrees(term); haveLoc = true; break;
      case 4: newLatSouth = term[0] == 'S'; break;
      case 5: newLng = parseDegrees(term); break;
      case 6: newLngWest = term[0] == 'W'; break;
      case 7: newSpeed = parseDecimal(term); haveSpeed = true; break;
      case 8: newCourse = parseDecimal(term); haveCourse = true; break;
    }
  } else {
    switch (termNumber) {
      case 2: newLat = parseDegrees(term); haveLoc = true; break;
      case 3: newLatSouth = term[0] == 'S'; break;
      case 4: newLng = parseDegrees(term); break;
      case 5: newLngWest = term[0] == 'W'; break;
      case 6: sentenceHasFix = term[0] > '0'; break;
      case 7: newSats = (uint32_t)atol(term); haveSats = true; break;
      case 8: newHdop = parseDecimal(term); haveHdop = true; break;
      case 9: newAlt = parseDecimal(term); haveAlt = true; break;
    }
  }
  return false;
}
