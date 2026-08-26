#pragma once
// Host shim, and the ONE place this harness deliberately does not reproduce behaviour.
//
// parse_table() is compiled but never exercised here: reproducing ArduinoJson would mean
// testing this shim's parser rather than the device's. JSON parsing is also the one thing on
// this device with a continuous real-world signal - text_sensor/ConfigPull reports
// version:rows:ok:failed:overrides on every pull, so a parser regression is visible within
// seconds of a flash. The HTML has no such signal, which is why the tests are aimed there.
//
// parse_json returns false, so any test that reached it would fail loudly rather than pass
// on a fake. Nothing here should be read as "parse_table is covered".
#include <functional>
#include <string>

class JsonArray;

class JsonValue {
 public:
  template<typename T> bool is() const { return false; }
  template<typename T> T as() const { return T{}; }
};

class JsonObject {
 public:
  JsonValue operator[](const char *) const { return JsonValue{}; }
};

class JsonArray {
 public:
  const JsonObject *begin() const { return nullptr; }
  const JsonObject *end() const { return nullptr; }
};

template<> inline long JsonValue::as<long>() const { return 0; }
template<> inline bool JsonValue::as<bool>() const { return false; }
template<> inline std::string JsonValue::as<std::string>() const { return std::string(); }
template<> inline const char *JsonValue::as<const char *>() const { return ""; }
template<> inline JsonArray JsonValue::as<JsonArray>() const { return JsonArray{}; }

namespace json {
inline bool parse_json(const std::string &, const std::function<bool(JsonObject)> &) { return false; }
}  // namespace json
