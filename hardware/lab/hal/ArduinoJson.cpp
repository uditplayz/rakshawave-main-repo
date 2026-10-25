#include "ArduinoJson.h"

// ---------------------------------------------------------------- writer
static void writeString(String& out, const char* s) {
  out += '"';
  for (; *s; s++) {
    char c = *s;
    switch (c) {
      case '"': out += "\\\""; break;
      case '\\': out += "\\\\"; break;
      case '\b': out += "\\b"; break;
      case '\f': out += "\\f"; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out += c;
    }
  }
  out += '"';
}

// ArduinoJson 6 FloatParts / TextFormatter::writeFloat for double.
static void writeFloat(String& out, double value) {
  if (isnan(value)) { out += "NaN"; return; }
  if (isinf(value)) { out += value > 0 ? "Infinity" : "-Infinity"; return; }
  if (value < 0.0) { out += '-'; value = -value; }
  int16_t exponent = 0;
  if (value >= 1e7) {
    while (value >= 10) { value /= 10; exponent++; }
  } else if (value > 0 && value <= 1e-5) {
    while (value < 1) { value *= 10; exponent--; }
  }
  uint32_t maxDecimalPart = 1000000000;
  int8_t decimalPlaces = 9;
  uint32_t integral = (uint32_t)value;
  for (uint32_t tmp = integral; tmp >= 10; tmp /= 10) { maxDecimalPart /= 10; decimalPlaces--; }
  double remainder = (value - (double)integral) * (double)maxDecimalPart;
  uint32_t decimal = (uint32_t)remainder;
  remainder = remainder - (double)decimal;
  decimal += (uint32_t)(remainder * 2);
  if (decimal >= maxDecimalPart) {
    decimal = 0;
    integral++;
    if (exponent && integral >= 10) { exponent++; integral = 1; }
  }
  while (decimal % 10 == 0 && decimalPlaces > 0) { decimal /= 10; decimalPlaces--; }
  char b[24];
  snprintf(b, sizeof b, "%lu", (unsigned long)integral);
  out += b;
  if (decimalPlaces) {
    snprintf(b, sizeof b, ".%0*lu", (int)decimalPlaces, (unsigned long)decimal);
    out += b;
  }
  if (exponent) {
    snprintf(b, sizeof b, "e%d", exponent);
    out += b;
  }
}

size_t serializeJson(JsonDocument& doc, String& out) {
  out = "";
  out += '{';
  JsonDocument::Member* m = doc.members();
  for (size_t k = 0; k < doc.size(); k++) {
    if (k) out += ',';
    writeString(out, m[k].key.c_str());
    out += ':';
    const JsonValue& v = m[k].v;
    char b[24];
    switch (v.type) {
      case JsonValue::Null: out += "null"; break;
      case JsonValue::Bool: out += v.i ? "true" : "false"; break;
      case JsonValue::Int: snprintf(b, sizeof b, "%lld", (long long)v.i); out += b; break;
      case JsonValue::Float: writeFloat(out, v.f); break;
      case JsonValue::Str: writeString(out, v.s.c_str()); break;
      case JsonValue::Raw: out += v.s; break;
    }
  }
  out += '}';
  return out.length();
}

size_t serializeJson(JsonDocument& doc, char* buf, size_t size) {
  String s;
  serializeJson(doc, s);
  if (!size) return 0;
  size_t n = s.length() < size - 1 ? s.length() : size - 1;
  memcpy(buf, s.c_str(), n);
  buf[n] = 0;
  return n;
}

// ---------------------------------------------------------------- reader
namespace {
struct Reader {
  const char* p;
  void ws() { while (*p == ' ' || *p == '\t' || *p == '\r' || *p == '\n') p++; }
  static void utf8(String& out, uint32_t cp) {
    if (cp < 0x80) out += (char)cp;
    else if (cp < 0x800) { out += (char)(0xC0 | (cp >> 6)); out += (char)(0x80 | (cp & 0x3F)); }
    else { out += (char)(0xE0 | (cp >> 12)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
  }
  DeserializationError::Code str(String& out) {
    if (*p != '"') return DeserializationError::InvalidInput;
    p++;
    while (*p != '"') {
      if (!*p) return DeserializationError::IncompleteInput;
      if (*p == '\\') {
        p++;
        switch (*p) {
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case '/': out += '/'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case 'n': out += '\n'; break;
          case 'r': out += '\r'; break;
          case 't': out += '\t'; break;
          case 'u': {
            uint32_t cp = 0;
            for (int k = 0; k < 4; k++) {
              char c = *++p;
              if (!c) return DeserializationError::IncompleteInput;
              cp = cp * 16 + (c >= 'a' ? c - 'a' + 10 : c >= 'A' ? c - 'A' + 10 : c - '0');
            }
            utf8(out, cp);
            break;
          }
          case 0: return DeserializationError::IncompleteInput;
          default: return DeserializationError::InvalidInput;
        }
        p++;
      } else {
        out += *p++;
      }
    }
    p++;
    return DeserializationError::Ok;
  }
  // nested arrays/objects are kept as raw text
  DeserializationError::Code raw(String& out) {
    int depth = 0;
    const char* start = p;
    bool inStr = false;
    for (; *p; p++) {
      if (inStr) {
        if (*p == '\\' && p[1]) p++;
        else if (*p == '"') inStr = false;
        continue;
      }
      if (*p == '"') inStr = true;
      else if (*p == '[' || *p == '{') depth++;
      else if (*p == ']' || *p == '}') {
        if (--depth == 0) { p++; out.concat(start, p - start); return DeserializationError::Ok; }
      }
    }
    return DeserializationError::IncompleteInput;
  }
};
}  // namespace

DeserializationError deserializeJson(JsonDocument& doc, const char* input) {
  doc.clear();
  Reader r{input};
  r.ws();
  if (!*r.p) return DeserializationError::EmptyInput;
  if (*r.p != '{') return DeserializationError::InvalidInput;
  r.p++;
  r.ws();
  if (*r.p == '}') return DeserializationError::Ok;
  for (;;) {
    r.ws();
    String key;
    DeserializationError::Code e = r.str(key);
    if (e) return e;
    r.ws();
    if (*r.p != ':') return *r.p ? DeserializationError::InvalidInput : DeserializationError::IncompleteInput;
    r.p++;
    r.ws();
    JsonValue v;
    if (*r.p == '"') {
      e = r.str(v.s);
      if (e) return e;
      v.type = JsonValue::Str;
    } else if (*r.p == '{' || *r.p == '[') {
      e = r.raw(v.s);
      if (e) return e;
      v.type = JsonValue::Raw;
    } else if (!strncmp(r.p, "true", 4)) { v.type = JsonValue::Bool; v.i = 1; r.p += 4; }
    else if (!strncmp(r.p, "false", 5)) { v.type = JsonValue::Bool; v.i = 0; r.p += 5; }
    else if (!strncmp(r.p, "null", 4)) { v.type = JsonValue::Null; r.p += 4; }
    else if (*r.p == '-' || (*r.p >= '0' && *r.p <= '9')) {
      const char* s = r.p;
      bool isFloat = false;
      if (*r.p == '-') r.p++;
      while ((*r.p >= '0' && *r.p <= '9') || *r.p == '.' || *r.p == 'e' || *r.p == 'E' || *r.p == '+' || *r.p == '-') {
        if (*r.p == '.' || *r.p == 'e' || *r.p == 'E') isFloat = true;
        r.p++;
      }
      String num;
      num.concat(s, r.p - s);
      if (isFloat) { v.type = JsonValue::Float; v.f = strtod(num.c_str(), nullptr); }
      else { v.type = JsonValue::Int; v.i = strtoll(num.c_str(), nullptr, 10); }
    } else {
      return *r.p ? DeserializationError::InvalidInput : DeserializationError::IncompleteInput;
    }
    // input is read-only (String): keys and strings are copied into the pool
    JsonDocument::Member* m = doc.find(key.c_str());
    if (!m) m = doc.add(key.c_str(), true);
    if (!m) return DeserializationError::NoMemory;
    if ((v.type == JsonValue::Str || v.type == JsonValue::Raw) && !doc.reserveString(v.s.c_str())) return DeserializationError::NoMemory;
    m->v = v;
    r.ws();
    if (*r.p == ',') { r.p++; continue; }
    if (*r.p == '}') return DeserializationError::Ok;
    return *r.p ? DeserializationError::InvalidInput : DeserializationError::IncompleteInput;
  }
}
