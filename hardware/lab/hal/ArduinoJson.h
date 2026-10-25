// ArduinoJson 6 API subset for flat JSON objects (the WiMesh packets).
//
// Behaviour that matters on the real board is kept: the document has a fixed
// capacity (16-byte slots plus copied strings, with deduplication) and silently
// drops members that do not fit; floats are stored as double and printed with
// up to 9 significant decimals (so 0.85f prints as 0.850000024); "x | default"
// returns the default when the stored type does not match.
#pragma once
#include "Arduino.h"

class DeserializationError {
 public:
  enum Code { Ok, EmptyInput, IncompleteInput, InvalidInput, NoMemory, TooDeep };
  DeserializationError(Code c = Ok) : code_(c) {}
  bool operator==(Code c) const { return code_ == c; }
  bool operator!=(Code c) const { return code_ != c; }
  explicit operator bool() const { return code_ != Ok; }
  Code code() const { return code_; }
  const char* c_str() const {
    static const char* names[] = {"Ok", "EmptyInput", "IncompleteInput", "InvalidInput", "NoMemory", "TooDeep"};
    return names[code_];
  }

 private:
  Code code_;
};

struct JsonValue {
  enum Type { Null, Bool, Int, Float, Str, Raw } type = Null;
  int64_t i = 0;
  double f = 0;
  String s;
};

class JsonDocument;
class MemberProxy;

#define ARDUINOJSON_SLOT_SIZE 16
#define ARDUINOJSON_MAX_MEMBERS 32

class JsonDocument {
 public:
  explicit JsonDocument(size_t capacity) : capacity_(capacity) {}
  MemberProxy operator[](const char* key);
  void clear() { n_ = 0; used_ = 0; pool_ = ""; }
  size_t memoryUsage() const { return used_; }
  size_t capacity() const { return capacity_; }
  bool overflowed() const { return overflowed_; }
  size_t size() const { return n_; }

  // internal
  struct Member { String key; JsonValue v; };
  Member* find(const char* key) {
    for (size_t k = 0; k < n_; k++) if (members_[k].key == key) return &members_[k];
    return nullptr;
  }
  Member* add(const char* key, bool copyKey) {
    size_t cost = ARDUINOJSON_SLOT_SIZE + (copyKey ? stringCost(key) : 0);
    if (n_ >= ARDUINOJSON_MAX_MEMBERS || used_ + cost > capacity_) { overflowed_ = true; return nullptr; }
    used_ += cost;
    members_[n_].key = key;
    members_[n_].v = JsonValue();
    return &members_[n_++];
  }
  bool reserveString(const char* s) {
    size_t cost = stringCost(s);
    if (used_ + cost > capacity_) { overflowed_ = true; return false; }
    used_ += cost;
    if (cost) { pool_ += s; pool_ += '\x01'; }
    return true;
  }
  Member* members() { return members_; }

 private:
  size_t stringCost(const char* s) {
    String needle(s);
    needle += '\x01';
    if (pool_.length() && (pool_.startsWith(needle.c_str()) || pool_.indexOf((String("\x01") + needle).c_str()) >= 0)) return 0;
    return strlen(s) + 1;
  }
  size_t capacity_;
  size_t used_ = 0;
  size_t n_ = 0;
  bool overflowed_ = false;
  String pool_;
  Member members_[ARDUINOJSON_MAX_MEMBERS];
};

template <size_t N>
class StaticJsonDocument : public JsonDocument {
 public:
  StaticJsonDocument() : JsonDocument(N) {}
};

class MemberProxy {
 public:
  MemberProxy(JsonDocument* d, const char* key) : d_(d), key_(key) {}

  MemberProxy& operator=(const char* v) { return setStr(v, false); }          // literal: stored by pointer
  MemberProxy& operator=(char* v) { return setStr(v, true); }                 // mutable buffer: copied
  MemberProxy& operator=(const String& v) { return setStr(v.c_str(), true); } // copied
  MemberProxy& operator=(bool v) { JsonValue x; x.type = JsonValue::Bool; x.i = v; return set(x); }
  MemberProxy& operator=(int v) { return setInt(v); }
  MemberProxy& operator=(unsigned int v) { return setInt(v); }
  MemberProxy& operator=(long v) { return setInt(v); }
  MemberProxy& operator=(unsigned long v) { return setInt(v); }
  MemberProxy& operator=(long long v) { return setInt(v); }
  MemberProxy& operator=(float v) { return setFloat(v); }
  MemberProxy& operator=(double v) { return setFloat(v); }
  MemberProxy& operator=(decltype(nullptr)) { JsonValue x; return set(x); }

  template <typename T> T as() const;
  bool isNull() const { const JsonValue* v = get(); return !v || v->type == JsonValue::Null; }

  const char* operator|(const char* def) const { const JsonValue* v = get(); return v && v->type == JsonValue::Str ? v->s.c_str() : def; }
  int operator|(int def) const { const JsonValue* v = get(); return v && v->type == JsonValue::Int ? (int)v->i : def; }
  long operator|(long def) const { const JsonValue* v = get(); return v && v->type == JsonValue::Int ? (long)v->i : def; }
  bool operator|(bool def) const { const JsonValue* v = get(); return v && v->type == JsonValue::Bool ? v->i != 0 : def; }
  float operator|(float def) const { const JsonValue* v = get(); return v && (v->type == JsonValue::Int || v->type == JsonValue::Float) ? (float)num(*v) : def; }
  double operator|(double def) const { const JsonValue* v = get(); return v && (v->type == JsonValue::Int || v->type == JsonValue::Float) ? num(*v) : def; }

 private:
  static double num(const JsonValue& v) { return v.type == JsonValue::Int ? (double)v.i : v.f; }
  const JsonValue* get() const { JsonDocument::Member* m = d_->find(key_); return m ? &m->v : nullptr; }
  MemberProxy& set(const JsonValue& x) {
    JsonDocument::Member* m = d_->find(key_);
    if (!m) m = d_->add(key_, false);
    if (m) m->v = x;
    return *this;
  }
  MemberProxy& setStr(const char* s, bool copy) {
    if (!s) { JsonValue x; return set(x); }
    if (copy) {
      // the slot must exist before the string is charged, as in ArduinoJson
      JsonDocument::Member* m = d_->find(key_);
      if (!m) m = d_->add(key_, false);
      if (!m || !d_->reserveString(s)) return *this;
    }
    JsonValue x;
    x.type = JsonValue::Str;
    x.s = s;
    return set(x);
  }
  MemberProxy& setInt(long long v) { JsonValue x; x.type = JsonValue::Int; x.i = v; return set(x); }
  MemberProxy& setFloat(double v) { JsonValue x; x.type = JsonValue::Float; x.f = v; return set(x); }
  JsonDocument* d_;
  const char* key_;
};

template <> inline int MemberProxy::as<int>() const { const JsonValue* v = get(); if (!v) return 0; return v->type == JsonValue::Int ? (int)v->i : v->type == JsonValue::Float ? (int)v->f : v->type == JsonValue::Bool ? (int)v->i : 0; }
template <> inline long MemberProxy::as<long>() const { return as<int>(); }
template <> inline float MemberProxy::as<float>() const { const JsonValue* v = get(); return v && (v->type == JsonValue::Int || v->type == JsonValue::Float) ? (float)num(*v) : 0.0f; }
template <> inline double MemberProxy::as<double>() const { const JsonValue* v = get(); return v && (v->type == JsonValue::Int || v->type == JsonValue::Float) ? num(*v) : 0.0; }
template <> inline bool MemberProxy::as<bool>() const { const JsonValue* v = get(); return v && v->type == JsonValue::Bool && v->i; }
template <> inline const char* MemberProxy::as<const char*>() const { const JsonValue* v = get(); return v && v->type == JsonValue::Str ? v->s.c_str() : nullptr; }
template <> inline String MemberProxy::as<String>() const { const JsonValue* v = get(); return v && v->type == JsonValue::Str ? v->s : String(); }

inline MemberProxy JsonDocument::operator[](const char* key) { return MemberProxy(this, key); }

size_t serializeJson(JsonDocument& doc, String& out);
size_t serializeJson(JsonDocument& doc, char* buf, size_t size);
DeserializationError deserializeJson(JsonDocument& doc, const char* input);
inline DeserializationError deserializeJson(JsonDocument& doc, const String& input) { return deserializeJson(doc, input.c_str()); }
