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
// Kept as a plain header rather than an external component. It started as a struct, a
// lookup and a parser (#43); #33 added the local presentation OVERLAY, the effective-row
// computation both renderers share, and the NVS record that persists it. D-40's remaining
// external-component argument was the device-served page, and that is `onair_page.h`,
// which registers handlers on the web server ESPHome already runs.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "esphome/components/json/json_util.h"
#include "esphome/core/hal.h"
#include "esphome/core/helpers.h"
#include "esphome/core/log.h"
#include "esphome/core/preferences.h"

namespace onair {

struct Row {
  std::string id;
  std::string label;
  // The only field of the row the ladder left behind (D-32). Shape on the glass is keyed
  // on THIS, not on colour: a calm-looking row that is actually busy is the one failure
  // that matters, and luminance does not get a vote in it.
  //
  // Defaulted TRUE, not left uninitialised: a default-constructed Row is what a lookup
  // miss produces, and of the two guesses only the calm one can be a false OFF.
  bool busy{true};
  uint32_t color;
  uint32_t bgcolor;
};

using Table = std::vector<Row>;

/**
 * A LOCAL PRESENTATION OVERRIDE for one row (#33).
 *
 * Sparse and an OVERLAY, never a copy of the table. The device holds what it pulled and,
 * separately, this: a handful of `row id -> {label?, color?, bgcolor?}` entries applied at
 * lookup. `effective()` below is the only place the two ever meet.
 *
 * `busy` IS ABSENT FROM THIS STRUCT ON PURPOSE, and that is a stronger statement than
 * rejecting it would be. It drives THE BUSY RULE on the glass (D-32): an override that
 * could set a busy row calm would draw a calm shape while the server believed the row was
 * busy - a false OFF, the one failure this system exists to prevent. A field the struct
 * does not have cannot be set by a malformed POST, a corrupted NVS record, or an edit to
 * the page six months from now that forgot why the check was there.
 *
 * Row MEMBERSHIP is the server's for the same kind of reason, if a milder one: the server
 * is what addresses a state, so a row that existed only here could never be selected and
 * the control would do nothing.
 */
struct Override {
  std::string id;
  std::string label;
  uint32_t color{0};
  uint32_t bgcolor{0};
  bool has_label{false};
  bool has_color{false};
  bool has_bgcolor{false};
  bool empty() const { return !this->has_label && !this->has_color && !this->has_bgcolor; }
};

using Overlay = std::vector<Override>;

/// Not a resource limit - the whole record is under a kilobyte. It is the size of a table
/// somebody edits by hand, and a bound is what lets the NVS record be a fixed-size POD.
inline constexpr size_t MAX_OVERRIDES = 8;

/**
 * One page action, staged by the HTTP task and applied by the main loop.
 *
 * NOT applied where it arrives. esp-idf runs web handlers on the httpd task, and both
 * things a save touches - the overlay and ESPHome's NVS pending-save list - are main-loop
 * structures. So the handler validates, stages, and then blocks on `done`, which is the
 * correct task to make wait: the loop that drives the display never stops for a browser.
 */
struct Command {
  enum Kind : uint8_t { NONE = 0, SAVE, CLEAR, CLEAR_ALL, REFRESH };
  Kind kind{NONE};
  std::string id;
  std::string label;
  uint32_t color{0};
  uint32_t bgcolor{0};
  // "not present" means "no override for this field", which is how a blanked input clears
  // one. Validated on the HTTP side before staging, so the main loop applies values it
  // does not have to re-check.
  bool has_label{false};
  bool has_color{false};
  bool has_bgcolor{false};
  bool armed{false};
  /// TRUE once the main loop has taken a copy and is applying it. The HTTP side uses this
  /// to tell "not started yet" from "in flight": only the first can be safely cancelled.
  bool taken{false};
  bool done{false};
  bool ok{false};
  std::string note;
};

/**
 * The outcome of the LAST command to finish, kept so a page render can report it.
 *
 * Needed because the HTTP side cannot always wait for the answer. The main loop can be
 * parked for up to 5 s inside `http_request.get` (the config pull), during which `pump()`
 * does not run - so a page action that arrives at the wrong moment cannot be confirmed
 * inside any budget the httpd task can reasonably block for. Reporting THAT honestly, and
 * showing the real outcome on the next render, beats guessing either way.
 */
struct LastResult {
  bool present{false};
  bool ok{false};
  std::string note;
};

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

  /// The local presentation overlay (#33). Persisted, unlike the table - see save_overlay.
  Overlay overlay;
  /// Mirrors of the two entity values the device-served page needs. The page runs on the
  /// httpd task and cannot reach an ESPHome `id()`; the main loop publishes them here.
  std::string key;
  uint32_t last_write_ms{0};
  /// Staged page action, and the one-shot flag that asks the main loop to run the pull.
  Command cmd;
  LastResult last;
  bool refresh_requested{false};
  /**
   * Guards `table`, `overlay`, `cmd` and the two mirrors against the HTTP task.
   *
   * Everything that MUTATES any of them runs on the main loop. The device-served page
   * READS them from esp-idf's httpd task, which is a different task, and `table = next`
   * on a successful pull is a vector move that would pull the strings out from under a
   * concurrent reader. Main-loop-only readers - the display lambda, the text sensors - do
   * not take it, because they cannot race with the main loop.
   */
  esphome::Mutex lock;
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


// ---- the local presentation overlay (#33) -----------------------------------------
//
// The table is pulled and RAM-only; the overlay is typed by a person and persisted. Those
// are opposite lifetimes on purpose, and the invariant that matters is that persisting one
// did not persist the other: a boot with no successful pull still shows NO CONFIG, overlay
// or not, because an overlay is not a vocabulary.

/// Fixed-size POD because ESPHome preferences store PODs. `id` is D-31's 32 characters and
/// `label` the server's 64, each plus a terminator we never rely on the writer to have set.
struct StoredOverride {
  char id[33];
  char label[65];
  uint32_t color;
  uint32_t bgcolor;
  /// bit 0 label, bit 1 color, bit 2 bgcolor. There is no bit for `busy` - see Override.
  uint8_t flags;
};

struct StoredOverlay {
  uint16_t magic;
  uint8_t count;
  StoredOverride rows[MAX_OVERRIDES];
};

/// Bumped if the record layout changes. A blob written by different firmware decodes at
/// fixed offsets into plausible nonsense, so it is refused rather than trusted.
inline constexpr uint16_t OVERLAY_MAGIC = 0x3301;

inline esphome::ESPPreferenceObject &overlay_pref() {
  // First CALL, not static-init: global_preferences is not ready until the preferences
  // component has set up. Same reasoning as passphrase_pref().
  static esphome::ESPPreferenceObject pref =
      esphome::global_preferences->make_preference<StoredOverlay>(0x0A17B233);
  return pref;
}

inline Override *find_override(const std::string &id) {
  for (auto &o : held().overlay) {
    if (o.id == id)
      return &o;
  }
  return nullptr;
}

inline void erase_override(const std::string &id) {
  for (size_t i = 0; i < held().overlay.size(); i++) {
    if (held().overlay[i].id == id) {
      held().overlay.erase(held().overlay.begin() + i);
      return;
    }
  }
}

inline void encode_overlay(StoredOverlay &out) {
  memset(&out, 0, sizeof(out));
  out.magic = OVERLAY_MAGIC;
  for (const auto &o : held().overlay) {
    if (out.count >= MAX_OVERRIDES)
      break;
    StoredOverride &row = out.rows[out.count];
    strncpy(row.id, o.id.c_str(), sizeof(row.id) - 1);
    if (o.has_label)
      strncpy(row.label, o.label.c_str(), sizeof(row.label) - 1);
    row.color = o.color;
    row.bgcolor = o.bgcolor;
    row.flags = (uint8_t) ((o.has_label ? 1 : 0) | (o.has_color ? 2 : 0) | (o.has_bgcolor ? 4 : 0));
    out.count++;
  }
}

/// Reads the stored overlay back into `held()`. A record this firmware does not recognise
/// leaves the overlay empty, which is the safe answer: no override is a working panel.
inline void load_overlay() {
  StoredOverlay stored{};
  if (!overlay_pref().load(&stored))
    return;
  if (stored.magic != OVERLAY_MAGIC || stored.count > MAX_OVERRIDES) {
    ESP_LOGW("onair", "overlay record not recognised (magic %04x, count %u) - ignoring",
             stored.magic, (unsigned) stored.count);
    return;
  }
  Overlay next;
  for (uint8_t i = 0; i < stored.count; i++) {
    StoredOverride &row = stored.rows[i];
    row.id[sizeof(row.id) - 1] = '\0';
    row.label[sizeof(row.label) - 1] = '\0';
    Override o;
    o.id = row.id;
    if (o.id.empty())
      continue;
    o.has_label = (row.flags & 1) != 0;
    o.has_color = (row.flags & 2) != 0;
    o.has_bgcolor = (row.flags & 4) != 0;
    o.label = row.label;
    o.color = row.color;
    o.bgcolor = row.bgcolor;
    if (o.empty())
      continue;
    next.push_back(o);
  }
  ESP_LOGI("onair", "overlay: %u local override(s) restored", (unsigned) next.size());
  held().overlay = std::move(next);
}

/**
 * Writes the overlay to NVS and PROVES it landed. Never assumes.
 *
 * Two reasons this is not a fire-and-forget save. Espressif warn that a blob write can
 * fail on page fragmentation with space apparently free. And ESPHome's `save()` only
 * QUEUES - the nvs_set_blob happens in `sync()`, so a save that returned true has not
 * necessarily written anything yet.
 *
 * The authority here is the READ-BACK, not sync()'s return value: sync() flushes every
 * pending preference and answers false if ANY of them failed, which could be somebody
 * else's. It clears the pending-save cache on the way out, so the load that follows is a
 * real flash read rather than the copy we just handed it.
 */
inline bool save_overlay(std::string &note) {
  StoredOverlay wanted{};
  encode_overlay(wanted);
  if (!overlay_pref().save(&wanted)) {
    note = "the panel could not queue the write";
    return false;
  }
  bool synced = esphome::global_preferences->sync();
  StoredOverlay got{};
  bool read_back = overlay_pref().load(&got) && memcmp(&wanted, &got, sizeof(wanted)) == 0;
  if (!read_back) {
    note = synced ? "NVS read back something other than what was written"
                  : "NVS reported a failed write";
    ESP_LOGE("onair", "overlay save failed: %s", note.c_str());
    return false;
  }
  if (!synced) {
    // Ours is on flash and verified; something else in the same flush was not. Worth a
    // log and not worth a red banner on a page about presentation.
    ESP_LOGW("onair", "overlay saved and verified, but another preference failed to sync");
  }
  note = "saved";
  return true;
}

/// What a lookup produces once the overlay has had its say.
struct Effective {
  bool known{false};
  Row row{};
  bool label_over{false};
  bool color_over{false};
  bool bgcolor_over{false};
  bool any_override() const { return this->label_over || this->color_over || this->bgcolor_over; }
};

/**
 * The row as it should be SEEN: the pulled row, plus the local overlay.
 *
 * ONE implementation, deliberately. The glass and the device-served status page both come
 * through here, because a status page that disagreed with the panel standing next to it
 * would be worse than no status page at all. `busy` is copied straight off the pulled row
 * and the overlay has no field that could reach it.
 */
inline Effective effective(const std::string &key) {
  Effective e;
  const Row *base = held().have ? find(held().table, key) : nullptr;
  if (base == nullptr)
    return e;
  e.known = true;
  e.row = *base;
  const Override *o = find_override(key);
  if (o == nullptr)
    return e;
  if (o->has_label) {
    e.row.label = o->label;
    e.label_over = true;
  }
  if (o->has_color) {
    e.row.color = o->color;
    e.color_over = true;
  }
  if (o->has_bgcolor) {
    e.row.bgcolor = o->bgcolor;
    e.bgcolor_over = true;
  }
  return e;
}

/**
 * What the panel draws. These numbers ARE the Render sensor's branch numbers (D-22.1,
 * D-54) and have to stay that way; 5 is skipped because it named a rung in the ladder
 * build and nothing has used it since.
 */
enum class Shape : int {
  BUSY = 0,
  CALM_HEAVY = 1,
  CALM_LIGHT = 2,
  NO_DATA = 3,
  UNKNOWN_KEY = 4,
  NO_CONFIG = 6,
};

inline const char *shape_name(Shape shape) {
  switch (shape) {
    case Shape::CALM_HEAVY:
      return "CALM HEAVY";
    case Shape::CALM_LIGHT:
      return "CALM LIGHT";
    case Shape::NO_DATA:
      return "NO DATA";
    case Shape::UNKNOWN_KEY:
      return "UNKNOWN KEY";
    case Shape::NO_CONFIG:
      return "NO CONFIG";
    default:
      return "BUSY";
  }
}

inline constexpr uint32_t STALE_MS = 90000;

struct View {
  Shape shape{Shape::BUSY};
  Effective eff;
  std::string key;
  bool stale{true};
};

/**
 * The whole rendering decision, in one function, for both renderers.
 *
 * Moved out of the display lambda by #33 rather than copied into the page: the page has to
 * be able to say NO CONFIG, UNKNOWN KEY and NO DATA for exactly the reasons the glass says
 * them, and the only way to guarantee that permanently is for there to be one decision.
 */
inline View compute_view(const std::string &key, uint32_t last_write_ms) {
  View v;
  v.key = key;
  v.eff = effective(key);
  // 0 means "nothing written since boot" - on_boot zeroes it precisely so a restored
  // entity value cannot read as fresh.
  v.stale = (last_write_ms == 0) || (esphome::millis() - last_write_ms > STALE_MS);
  if (!held().have) {
    v.shape = Shape::NO_CONFIG;
    return v;
  }
  if (!v.eff.known) {
    v.shape = Shape::UNKNOWN_KEY;
    return v;
  }
  // THE BUSY RULE (D-32). A calm row is the only claim that can be a false OFF, so a stale
  // one is refused and drawn as NO DATA. `unknown` is the reserved landing row and never
  // renders as anything.
  if (key == "unknown" || (v.stale && !v.eff.row.busy)) {
    v.shape = Shape::NO_DATA;
    return v;
  }
  if (v.eff.row.busy) {
    v.shape = Shape::BUSY;
    return v;
  }
  // Colour, on a 1-bit panel, picks between the two CALM shapes - and only there. A dark
  // red and a dark green have near-identical luma, so it gets no vote near a busy row.
  v.shape = luminance(v.eff.row.bgcolor) >= 128 ? Shape::CALM_HEAVY : Shape::CALM_LIGHT;
  return v;
}

// ---- the main-loop side of the device-served page ---------------------------------

/// Replaces the held table. The ONLY writer of `table`, and it takes the lock because the
/// page reads it from another task.
inline void install_table(Table &next, const std::string &version, const std::string &etag) {
  esphome::LockGuard guard(held().lock);
  held().table = std::move(next);
  held().version = version;
  held().etag = etag;
  held().have = true;
  held().oks++;
}

/// Mirrors the two entity values the page needs into `held()`. Main loop only.
inline void publish_context(const std::string &key, uint32_t last_write_ms) {
  esphome::LockGuard guard(held().lock);
  held().key = key;
  held().last_write_ms = last_write_ms;
}

/// Applies a staged command. Main loop only; the lock is held only across the mutation,
/// never across the NVS write, which no other task touches.
inline void apply_command(const Command &c, bool &ok, std::string &note) {
  ok = true;
  switch (c.kind) {
    case Command::REFRESH:
      held().refresh_requested = true;
      note = "asked the server for the current profile";
      return;
    case Command::CLEAR_ALL: {
      esphome::LockGuard guard(held().lock);
      held().overlay.clear();
      break;
    }
    case Command::CLEAR: {
      esphome::LockGuard guard(held().lock);
      erase_override(c.id);
      break;
    }
    case Command::SAVE: {
      esphome::LockGuard guard(held().lock);
      if (!c.has_label && !c.has_color && !c.has_bgcolor) {
        // Every field blank is how a row goes back to following the server. It is the
        // same outcome as Clear, reached by editing rather than by pressing.
        erase_override(c.id);
        break;
      }
      Override *o = find_override(c.id);
      if (o == nullptr) {
        if (held().overlay.size() >= MAX_OVERRIDES) {
          ok = false;
          note = "no room for another override - clear one first";
          return;
        }
        held().overlay.push_back(Override{});
        o = &held().overlay.back();
        o->id = c.id;
      }
      o->has_label = c.has_label;
      o->label = c.label;
      o->has_color = c.has_color;
      o->color = c.color;
      o->has_bgcolor = c.has_bgcolor;
      o->bgcolor = c.bgcolor;
      break;
    }
    default:
      ok = false;
      note = "nothing to do";
      return;
  }
  ok = save_overlay(note);
}

/// Drains one staged command. Called from a short interval on the main loop.
inline void pump() {
  Command local;
  {
    esphome::LockGuard guard(held().lock);
    if (!held().cmd.armed)
      return;
    // Marked BEFORE the lock is dropped. Between here and the store below the command is
    // in flight and the HTTP side must not cancel it; `armed` alone cannot express that,
    // which is how a timed-out request could report failure for a change that then landed.
    held().cmd.taken = true;
    local = held().cmd;
  }
  bool ok = true;
  std::string note;
  apply_command(local, ok, note);
  esphome::LockGuard guard(held().lock);
  held().cmd.armed = false;
  held().cmd.taken = false;
  held().cmd.ok = ok;
  held().cmd.note = note;
  held().cmd.done = true;
  // Kept for the next page render, which is the only way the operator hears about a
  // command that finished after their request had to give up waiting.
  held().last.present = true;
  held().last.ok = ok;
  held().last.note = note;
}

/// One-shot: true once per Refresh press on the page. Main loop only.
inline bool take_refresh_request() {
  if (!held().refresh_requested)
    return false;
  held().refresh_requested = false;
  return true;
}

}  // namespace onair
