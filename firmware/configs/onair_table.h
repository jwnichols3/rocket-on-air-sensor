#pragma once
//
// The state table (D-31), as the panel holds it.
//
// The device does NOT own this vocabulary and does not persist it. It pulls
// `GET /config/states` into RAM (D-38) and renders whatever it is handed. Two
// consequences that are easy to get wrong:
//
//   1. An EMPTY table is not "no rows". It is "we have never successfully talked to the
//      server", which the panel must show as NO CONFIG - never as calm.
//   2. A key that is not in the table is not an error to swallow. It means the server
//      moved and this table is stale, so it draws conspicuously AND triggers a re-pull.
//
// Kept as a plain header rather than an external component because that is the whole of
// it: a struct, a lookup and a parser. D-40 records what an external component would buy
// (a device-served config page, an NVS-persisted table); that is #33, not this.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "esphome/components/json/json_util.h"
#include "esphome/core/preferences.h"

namespace onair {

struct Row {
  std::string id;
  std::string label;
  // The only field of the row the ladder left behind (D-32). Shape on the glass is keyed
  // on THIS, not on colour: a calm-looking row that is actually busy is the one failure
  // that matters, and luminance does not get a vote in it.
  bool busy;
  uint32_t color;
  uint32_t bgcolor;
};

using Table = std::vector<Row>;

/**
 * Everything the panel holds about the table, in one place.
 *
 * NOT ESPHome `globals:`, and that is forced rather than chosen. ESPHome emits an
 * `includes:` file AFTER the block that instantiates `GlobalsComponent<T>` for every
 * declared global, so a global whose C++ type comes from the include does not compile -
 * `'onair' was not declared in this scope`, measured on 2026.8.0. A function-local static
 * behind an inline accessor has one instance under the C++17 rules and needs no
 * declaration order at all.
 *
 * Nothing is lost: none of these were ever meant to be entities. What the operator can
 * see - version, row count, pull tallies - is published by the ConfigPull text sensor.
 */
struct Held {
  Table table;
  /// FALSE until a pull has succeeded. This is what NO CONFIG is keyed on, and it is
  /// never true with an empty table - see parse_table.
  bool have{false};
  std::string version;
  /// The ETag exactly as the server sent it, quotes included. Echoing the server's own
  /// bytes back is the only way to be sure a 304 means what it says.
  std::string etag;
  /// Request headers are `const char *`. These outlive the request; a c_str() taken from
  /// a temporary inside the templatable would dangle.
  std::string auth_header;
  std::string inm_header;
  uint32_t oks{0};
  uint32_t failures{0};
  /**
   * The server passphrase - held HERE and deliberately not in an ESPHome entity.
   *
   * D-38 said `mode: password` "masks the value in the JSON, so a passphrase entered on
   * the device is not readable from its own REST API". MEASURED ON 2026.8.0, THAT IS
   * FALSE. web_server.cpp:1421 masks only the `state` field; `set_json_value` then writes
   * the RAW string to `value` unconditionally, so
   *
   *     GET /text/ServerPassphrase
   *     {"id":"text/ServerPassphrase","value":"<the real passphrase>","state":"********"}
   *
   * Behind basic auth, but that is the DEVICE credential (D-17), and handing it the
   * SERVER credential (D-35) collapses the separation those two decisions exist to keep.
   * So the passphrase lives in a preference blob that no entity serialises, and the entity
   * that sets it is write-only.
   */
  std::string passphrase;
};

inline Held &held() {
  static Held instance;
  return instance;
}

/// Fixed-size because ESPHome preferences store PODs. 128 chars matches the entity's
/// max_length, plus a terminator we never rely on the caller to have written.
struct StoredSecret {
  char value[129];
};

inline esphome::ESPPreferenceObject &passphrase_pref() {
  // Constructed on first CALL, not at static-init: global_preferences is not ready until
  // the preferences component has set up, and on_boot is the earliest we touch this.
  static esphome::ESPPreferenceObject pref =
      esphome::global_preferences->make_preference<StoredSecret>(0x0A17A123);
  return pref;
}

/**
 * Loads the stored passphrase, falling back to the one compiled in from `!secret`.
 *
 * The fallback is what makes a fresh board work without someone typing into it, and the
 * stored value is what makes a rotation survive a reflash. Stored wins, deliberately: a
 * reflash must not silently put the old compiled-in credential back.
 */
inline void load_passphrase(const char *fallback) {
  StoredSecret stored{};
  if (passphrase_pref().load(&stored)) {
    stored.value[sizeof(stored.value) - 1] = '\0';
    held().passphrase = stored.value;
  }
  if (held().passphrase.empty() && fallback != nullptr)
    held().passphrase = fallback;
}

inline void set_passphrase(const std::string &value) {
  held().passphrase = value;
  StoredSecret stored{};
  strncpy(stored.value, value.c_str(), sizeof(stored.value) - 1);
  passphrase_pref().save(&stored);
  // Written through immediately: the next thing that happens after someone changes a
  // passphrase is usually a reboot to see whether it worked.
  esphome::global_preferences->sync();
}

/// The row for `key`, or nullptr. Nullptr is meaningful - see the header comment.
inline const Row *find(const Table &table, const std::string &key) {
  for (const auto &row : table) {
    if (row.id == key)
      return &row;
  }
  return nullptr;
}

/**
 * "#rrggbb" -> 0xRRGGBB. Returns `fallback` for anything it does not fully understand.
 *
 * Deliberately lenient and silent: colour is decoration on this build (the fitted panel
 * is 1-bit) and a malformed colour must never be the reason a whole table is rejected. A
 * row whose LABEL and BUSY parsed is a usable row.
 */
inline uint32_t parse_hex_color(const char *text, uint32_t fallback) {
  if (text == nullptr)
    return fallback;
  if (*text == '#')
    text++;
  uint32_t value = 0;
  int digits = 0;
  for (; text[digits] != '\0'; digits++) {
    char c = text[digits];
    uint32_t nibble;
    if (c >= '0' && c <= '9')
      nibble = c - '0';
    else if (c >= 'a' && c <= 'f')
      nibble = c - 'a' + 10;
    else if (c >= 'A' && c <= 'F')
      nibble = c - 'A' + 10;
    else
      return fallback;
    value = (value << 4) | nibble;
  }
  return digits == 6 ? value : fallback;
}

/**
 * Rec. 601 luma of an 0xRRGGBB colour, 0-255.
 *
 * The panel is 1-bit, so this is the only channel colour has into it: lit pixels stand in
 * for brightness. Used to pick between the two CALM shapes in the display lambda, and used
 * nowhere near a busy row - shape there is keyed on `busy`, because a dark red and a dark
 * green have near-identical luma and a false OFF is the one error that matters.
 */
inline uint8_t luminance(uint32_t rgb) {
  uint32_t r = (rgb >> 16) & 0xff, g = (rgb >> 8) & 0xff, b = rgb & 0xff;
  return (uint8_t) ((299u * r + 587u * g + 114u * b) / 1000u);
}

/// 0xRRGGBB -> "#rrggbb", so a held colour is readable over HTTP and a pull can be proven
/// from a shell rather than by looking at the glass.
inline std::string format_hex_color(uint32_t value) {
  char buf[8];
  snprintf(buf, sizeof(buf), "#%06x", (unsigned) (value & 0xffffffu));
  return std::string(buf);
}

/**
 * Parses a `GET /config/states` body.
 *
 * ALL-OR-NOTHING, deliberately: `out` and `version_out` are written only on success, so a
 * truncated or malformed response can never half-replace a working table. Returning false
 * means "keep what you have", which is always a safe answer here - the table changes a few
 * times a year and the panel is already showing something correct.
 *
 * An empty `states` array is a FAILURE, not an empty table. The server always seeds at
 * least the reserved `unknown` row, so zero rows means we misread the body.
 */
inline bool parse_table(const std::string &body, Table &out, std::string &version_out) {
  Table next;
  std::string version;
  bool ok = json::parse_json(body, [&](JsonObject root) -> bool {
    if (!root["states"].is<JsonArray>())
      return false;
    // The version is an integer on the wire and a string here only because it is compared
    // against a `text` entity the server writes (D-42's version nudge).
    version = std::to_string(root["version"].as<long>());
    for (JsonObject item : root["states"].as<JsonArray>()) {
      Row row;
      row.id = item["id"].as<std::string>();
      // A row with no id cannot be addressed by a state write, so it is not a row.
      if (row.id.empty())
        continue;
      row.label = item["label"].as<std::string>();
      // Falling back to the id keeps an unlabelled row renderable and diagnosable rather
      // than drawing an empty block, which reads as a broken panel.
      if (row.label.empty())
        row.label = row.id;
      row.busy = item["busy"].as<bool>();
      row.color = parse_hex_color(item["color"].as<const char *>(), 0xffffff);
      row.bgcolor = parse_hex_color(item["bgcolor"].as<const char *>(), 0x000000);
      next.push_back(row);
    }
    return !next.empty();
  });
  if (!ok)
    return false;
  out = std::move(next);
  version_out = version;
  return true;
}

}  // namespace onair
