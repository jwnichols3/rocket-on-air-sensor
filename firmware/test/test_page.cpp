// Tests for the HTML the panel generates, and for the POST contract behind it (#50).
//
// WHY THIS EXISTS. `npm run verify` runs `esphome config`, which validates YAML and never
// looks at onair_page.h. `firmware:compile` compiles it and asserts nothing about its
// output. Before this file, nothing anywhere tested the generated HTML - and shipping #50
// put three defects on a live device that a green compile and 311 passing tests could not
// see. Two were cosmetic. The third class - a page that quietly stops honouring
// "empty means follow the server" - would not be cosmetic at all, and would be invisible in
// a screenshot.
//
// WHAT IT DOES NOT COVER, stated so nobody reads more into a green run than is there:
//   - parse_table(). The JSON shim is a stub; see json_util.h for why.
//   - the display lambda. It lives in YAML and needs the panel.
//   - anything about concurrency. One thread here; the device has two.
//   - the CSS and the JavaScript. Those are the browser suite's job - `npm run test:browser`.

#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>

#include "onair_page.h"
#include "onair_table.h"

// ---- definitions for the shim's extern symbols -------------------------------------
// After the includes, because the types come from them. These are the only globals the
// harness owns; everything else lives in onair::held(), exactly as on the device.
namespace esphome {
uint32_t g_millis = 1000;
PrefStore g_prefs;
static ESPPreferences s_prefs;
ESPPreferences *global_preferences = &s_prefs;
namespace web_server_base {
static WebServerBase s_base;
WebServerBase *global_web_server_base = &s_base;
}  // namespace web_server_base
}  // namespace esphome

/// Null until main() points it at onair::pump. See shim/freertos/task.h for why that is the
/// interesting knob in this harness.
void (*g_task_yield_hook)() = nullptr;

// ---- a very small test runner --------------------------------------------------------
static int g_checks = 0, g_failures = 0;
static const char *g_case = "";

static void fail(const char *expr, const char *file, int line, const std::string &detail) {
  g_failures++;
  printf("  FAIL  %s\n        %s:%d  %s\n", g_case, file, line, expr);
  if (!detail.empty())
    printf("        %s\n", detail.c_str());
}

#define CHECK(cond)                                                     \
  do {                                                                  \
    g_checks++;                                                         \
    if (!(cond))                                                        \
      fail(#cond, __FILE__, __LINE__, "");                              \
  } while (0)

#define CHECK_MSG(cond, detail)                                         \
  do {                                                                  \
    g_checks++;                                                         \
    if (!(cond))                                                        \
      fail(#cond, __FILE__, __LINE__, (detail));                        \
  } while (0)

static bool has(const std::string &haystack, const std::string &needle) {
  return haystack.find(needle) != std::string::npos;
}

static size_t count_of(const std::string &haystack, const std::string &needle) {
  size_t n = 0, at = 0;
  while ((at = haystack.find(needle, at)) != std::string::npos) {
    n++;
    at += needle.size();
  }
  return n;
}

static void begin(const char *name) {
  g_case = name;
  printf("- %s\n", name);
}

// ---- fixtures --------------------------------------------------------------------------
//
// The five real rows from the live server (profile v11), so a test that passes here is a
// test about the table an operator actually has.
static void seed_table() {
  esphome::g_prefs.reset();
  onair::held().table = {
      {"available", "AVAILABLE", false, 0xffffff, 0x0b6e2e},
      {"on-air", "ON AIR", true, 0xffffff, 0xc1121f},
      {"interruptible", "INTERRUPTIBLE", false, 0x1a1a1a, 0xe8a317},
      {"recording", "RECORDING", true, 0xffffff, 0x6a0dad},
      {"unknown", "NO DATA", true, 0xff00ff, 0x1a1a1a},
  };
  onair::held().have = true;
  onair::held().version = "11";
  onair::held().overlay.clear();
  onair::held().appearance = onair::Appearance{};
  onair::held().key = "available";
  onair::held().ip = "10.42.12.77";
  onair::held().db = "-53dBm";
  onair::held().last_contact_ms = esphome::g_millis;
  onair::held().lost_ms = onair::CONNECTION_LOST_MS;
  onair::held().no_data_ms = onair::NO_DATA_MS;
  onair::held().cmd = onair::Command{};
  onair::held().last = onair::LastResult{};
}

static std::string get_config(const std::string &open = "") {
  return onair::config_page("", onair::Submitted::APPLIED, open, false);
}

/// The page as `?bench=1` serves it. Separate from get_config() on purpose: the Pool A budget
/// measures the page an operator actually loads, and the bench bar is not on it (#87).
static std::string get_config_bench() {
  return onair::config_page("", onair::Submitted::APPLIED, "", true);
}

/// Drives a real POST through Page::handleRequest and returns the request, so a test can
/// read both the status and the body.
static AsyncWebServerRequest post(const std::vector<std::pair<std::string, std::string>> &fields,
                                  const char *origin = nullptr) {
  AsyncWebServerRequest req(HTTP_POST, "/onair/config");
  for (const auto &f : fields)
    req.set_param(f.first, f.second);
  if (origin != nullptr) {
    req.set_header("Origin", origin);
    req.set_header("Host", "10.42.12.77");
  }
  onair::Page handler(true);
  handler.handleRequest(&req);
  return req;
}

// =========================================================================================
// 1. THE FOLLOW-THE-SERVER CONTRACT
//
// The invariant most likely to rot silently, and the reason this file exists. A row with no
// override must emit an EMPTY value attribute; the server's value belongs in the
// PLACEHOLDER. Get this backwards and every row looks right in a screenshot while the next
// save pins the server's current colours as permanent local overrides.
// =========================================================================================
static void test_follow_the_server() {
  begin("a row with no override emits empty values, not the server's");
  seed_table();
  std::string h = get_config("interruptible");

  CHECK_MSG(has(h, "name=\"label\" maxlength=\"64\" placeholder=\"INTERRUPTIBLE\" value=\"\""),
            "the server's label must be the placeholder and the value must be empty");
  CHECK_MSG(has(h, "name=\"color\" maxlength=\"7\" pattern=\"#[0-9a-fA-F]{6}\" spellcheck=\"false\" "
                   "placeholder=\"#1a1a1a\" value=\"\""),
            "text colour: server value in placeholder, value empty");
  CHECK_MSG(has(h, "placeholder=\"#e8a317\" value=\"\""), "background: server value in placeholder, value empty");

  begin("an overridden row emits the override as the value, server still the placeholder");
  seed_table();
  onair::Override o;
  o.id = "interruptible";
  o.has_bgcolor = true;
  o.bgcolor = 0x3b5bdb;
  onair::held().overlay.push_back(o);
  h = get_config("interruptible");
  CHECK_MSG(has(h, "placeholder=\"#e8a317\" value=\"#3b5bdb\""),
            "the override is the value and the server's is still the placeholder");

  begin("a blank save clears the override rather than storing black");
  seed_table();
  onair::held().overlay.push_back(o);
  CHECK(onair::find_override("interruptible") != nullptr);
  AsyncWebServerRequest req = post({{"action", "save"}, {"id", "interruptible"},
                                    {"label", ""}, {"color", ""}, {"bgcolor", ""}});
  CHECK_MSG(onair::find_override("interruptible") == nullptr,
            "every field blank is how a row goes back to following the server");
  CHECK(req.status == 200);
}

// =========================================================================================
// 2. THE SHAPE THE GLASS WILL DRAW
//
// The page must never show a picture the panel cannot produce. `unknown` is the case three
// of the four #50 prototypes got wrong: compute_view() short-circuits on the KEY, before the
// busy test, so it is always NO_DATA and never the solid BUSY block.
// =========================================================================================
static void test_shapes() {
  begin("unknown renders NO_DATA, never BUSY - it short-circuits on the key");
  seed_table();
  CHECK(onair::compute_view("unknown", esphome::g_millis).shape == onair::Shape::NO_DATA);
  // Asserted on compute_view directly now, not on page HTML. The page used to print this
  // shape in a column; that column described a 1-bit board that is out of service and is
  // gone. The RULE it was checking is not - the glass still branches on this.
  std::string h = get_config();
  CHECK_MSG(onair::compute_view("unknown", esphome::g_millis).shape != onair::Shape::BUSY,
            "the unknown row must never be a solid block");

  begin("the emitter writes the firmware's own enum integer, so the page cannot disagree");
  seed_table();
  h = get_config("on-air");
  CHECK_MSG(has(h, "data-shape=\"0\""), "on-air is busy: Shape::BUSY == 0");
  CHECK((int) onair::Shape::BUSY == 0);
  CHECK((int) onair::Shape::CALM_HEAVY == 1);
  CHECK((int) onair::Shape::CALM_LIGHT == 2);
  CHECK((int) onair::Shape::NO_DATA == 3);

  begin("luminance picks the calm shape at exactly 128, and only on calm rows");
  seed_table();
  // #e8a317 is 167 -> heavy. #0b6e2e is 73 -> light. Both from the live table.
  CHECK(onair::luminance(0xe8a317) == 167);
  CHECK(onair::luminance(0x0b6e2e) == 73);
  CHECK(onair::luminance(0x3b5bdb) == 96);
  // The boundary, and the only place a `>` instead of `>=` would ever show. The Rec.601
  // coefficients sum to exactly 1000, so #808080 is exactly 128.
  CHECK(onair::luminance(0x7f7f7f) == 127);
  CHECK(onair::luminance(0x808080) == 128);
  // Through the real compute_view, not a helper, so the >= is tested where it lives.
  onair::held().table[0].bgcolor = 0x808080;
  CHECK_MSG(onair::compute_view("available", esphome::g_millis).shape == onair::Shape::CALM_HEAVY,
            "128 is ON the line and must draw the heavy frame");
  onair::held().table[0].bgcolor = 0x7f7f7f;
  CHECK(onair::compute_view("available", esphome::g_millis).shape == onair::Shape::CALM_LIGHT);
  seed_table();
  // Asserted through compute_view, which is what the GLASS branches on. The page used to
  // print these and no longer does; the rule outlived its column.
  CHECK_MSG(onair::compute_view("interruptible", esphome::g_millis).shape ==
                onair::Shape::CALM_HEAVY,
            "interruptible draws the heavy shape at 167");
  CHECK_MSG(onair::compute_view("available", esphome::g_millis).shape == onair::Shape::CALM_LIGHT,
            "available draws the light shape at 73");
  CHECK_MSG(onair::compute_view("on-air", esphome::g_millis).shape == onair::Shape::BUSY,
            "on-air is busy, so colour gets no vote at all - luminance 71 is not consulted");

  begin("an override that crosses 128 changes the shape the page reports");
  seed_table();
  onair::Override o;
  o.id = "interruptible";
  o.has_bgcolor = true;
  o.bgcolor = 0x3b5bdb;  // 96, under the line
  onair::held().overlay.push_back(o);
  // Through effective(), which is what BOTH the glass and the page resolve a row with. The
  // page no longer prints the shape, but a local colour override must still change the shape
  // the panel would draw, and that is the fact worth protecting.
  onair::Effective eff = onair::effective("interruptible");
  CHECK_MSG(onair::luminance(eff.row.bgcolor) == 96, "the override's colour is what resolves");
  CHECK_MSG(onair::luminance(eff.row.bgcolor) < 128,
            "so this row crosses from heavy to light, and the server's 167 no longer decides");
  onair::held().overlay.clear();
}

// =========================================================================================
// 3. WHAT MUST NEVER APPEAR IN THE MARKUP
// =========================================================================================
static void test_forbidden_markup() {
  begin("no form anywhere carries a field named busy");
  seed_table();
  onair::Override o;
  o.id = "gone-from-server";
  o.has_label = true;
  o.label = "DORMANT";
  onair::held().overlay.push_back(o);
  std::string h = get_config("interruptible");
  CHECK_MSG(!has(h, "name=\"busy\""),
            "handle_action REFUSES a POST carrying busy, so emitting one would break the save");

  begin("no colour picker carries a name, so it cannot post #000000");
  // The whole D-68 trap. A named <input type=color> has no empty state and defaults to
  // black, so it would turn "follow the server" into "override to black" on the next save.
  size_t pickers = count_of(h, "<input type=\"color\"");
  CHECK_MSG(pickers > 0, "the editor should offer pickers at all");
  size_t at = 0;
  while ((at = h.find("<input type=\"color\"", at)) != std::string::npos) {
    size_t end = h.find('>', at);
    std::string tag = h.substr(at, end - at);
    CHECK_MSG(!has(tag, "name="), "a colour picker must never carry a name: " + tag);
    at = end;
  }

  begin("no external request of any kind");
  // The operator's browser may be on a segment with no route to the internet.
  CHECK(!has(h, "http://"));
  CHECK(!has(h, "https://"));
  CHECK(!has(h, "//fonts."));
  CHECK(!has(h, "@import"));

  begin("no inline style or script block - every byte there is heap, every request");
  CHECK_MSG(!has(h, "<style"), "CSS belongs in the flash asset (D-69)");
  CHECK_MSG(count_of(h, "<script") == 1 && has(h, "<script src=\"/onair.js\"></script>"),
            "exactly one script tag, and it is a reference to the flash asset");

  begin("every action value is one the handler recognises");
  at = 0;
  while ((at = h.find("name=\"action\" value=\"", at)) != std::string::npos) {
    size_t vs = at + strlen("name=\"action\" value=\"");
    std::string value = h.substr(vs, h.find('"', vs) - vs);
    CHECK_MSG(value == "save" || value == "clear" || value == "clearall" ||
                  value == "refresh" || value == "appearance" || value == "glass" ||
                  value == "bench",
              "unrecognised action silently does nothing: " + value);
    at = vs;
  }
}

// =========================================================================================
// 4. ESCAPING. The label is 1-64 free-form characters from the server.
// =========================================================================================
static void test_escaping() {
  begin("a hostile label cannot break out of an attribute or inject a tag");
  seed_table();
  onair::held().table[0].label = "\"><script>alert(1)</script>";
  onair::held().table[0].id = "a<b>&c";
  std::string h = get_config();
  CHECK_MSG(!has(h, "<script>alert"), "the label must not become a tag");
  CHECK(has(h, "&lt;script&gt;"));
  CHECK(has(h, "&quot;&gt;"));
  CHECK_MSG(has(h, "a&lt;b&gt;&amp;c"), "the id is escaped too - it reaches an href and a value");

  begin("escaping survives into the editor's value attribute");
  seed_table();
  onair::Override o;
  o.id = "available";
  o.has_label = true;
  o.label = "\" onmouseover=\"x";
  onair::held().overlay.push_back(o);
  h = get_config("available");
  CHECK(!has(h, "onmouseover=\"x"));
  CHECK(has(h, "&quot; onmouseover=&quot;x"));
}

// =========================================================================================
// 5. THE POST CONTRACT
// =========================================================================================
static void test_post_contract() {
  begin("a POST carrying busy is refused outright, not silently ignored");
  seed_table();
  AsyncWebServerRequest req = post({{"action", "save"}, {"id", "available"}, {"busy", "false"}});
  CHECK(req.status == 400);
  CHECK_MSG(has(req.body, "busy is the server&#39;s"), "and it says why");
  CHECK(onair::find_override("available") == nullptr);

  begin("a cross-origin POST is refused - HTTP Basic is not a CSRF defence");
  seed_table();
  req = post({{"action", "clearall"}}, "http://evil.example");
  CHECK(req.status == 400);
  CHECK(has(req.body, "came from another site"));

  begin("a same-origin POST is allowed");
  seed_table();
  req = post({{"action", "refresh"}}, "http://10.42.12.77");
  CHECK(req.status == 200);

  begin("a row the server does not have cannot be overridden");
  seed_table();
  req = post({{"action", "save"}, {"id", "invented"}, {"label", "NOPE"}});
  CHECK(req.status == 400);
  CHECK(has(req.body, "rows are not added locally"));

  begin("a malformed colour is refused rather than silently stored as black");
  seed_table();
  req = post({{"action", "save"}, {"id", "available"}, {"bgcolor", "6a0dad"}});  // no #
  CHECK(req.status == 400);
  CHECK(has(req.body, "must look like #rrggbb"));
  CHECK(onair::find_override("available") == nullptr);

  begin("a good save round-trips and persists");
  seed_table();
  req = post({{"action", "save"}, {"id", "available"}, {"label", "FREE"}});
  CHECK(req.status == 200);
  onair::Override *o = onair::find_override("available");
  CHECK(o != nullptr && o->has_label && o->label == "FREE");
  CHECK_MSG(!o->has_color && !o->has_bgcolor, "an unset field must not become an override");
  onair::held().overlay.clear();
  onair::load_overlay();
  o = onair::find_override("available");
  CHECK_MSG(o != nullptr && o->label == "FREE", "and it survives a reboot");

  begin("a save that does not reach NVS reports failure instead of claiming success");
  seed_table();
  esphome::g_prefs.fail_sync = true;
  req = post({{"action", "save"}, {"id", "available"}, {"label", "FREE"}});
  CHECK_MSG(req.status == 400, "the read-back check must catch a sync that did not land");
  esphome::g_prefs.fail_sync = false;
}

// =========================================================================================
// 6. THE APPEARANCE (D-70)
// =========================================================================================
static void test_appearance() {
  begin("the default is dark, and technical");
  seed_table();
  std::string h = get_config();
  CHECK(has(h, "data-skin=\"technical\" data-mode=\"dark\""));

  begin("a skin change persists and reaches the root element");
  seed_table();
  AsyncWebServerRequest req = post({{"action", "appearance"}, {"skin", "colorful"}, {"mode", "light"}});
  CHECK(req.status == 200);
  CHECK(has(get_config(), "data-skin=\"colorful\" data-mode=\"light\""));
  onair::held().appearance = onair::Appearance{};
  onair::load_appearance();
  CHECK_MSG(onair::held().appearance.skin == onair::Skin::COLORFUL, "and survives a reboot");
  CHECK(onair::held().appearance.mode == onair::Mode::LIGHT);

  begin("an unknown skin is refused and leaves the stored one alone");
  seed_table();
  post({{"action", "appearance"}, {"skin", "technical"}, {"mode", "dark"}});
  AsyncWebServerRequest bad = post({{"action", "appearance"}, {"skin", "neon"}, {"mode", "dark"}});
  CHECK(bad.status == 400);
  CHECK(has(bad.body, "not a skin this panel has"));
  CHECK_MSG(onair::held().appearance.skin == onair::Skin::TECHNICAL, "the refused value was not stored");

  begin("an unknown mode is refused too");
  AsyncWebServerRequest badmode = post({{"action", "appearance"}, {"skin", "table"}, {"mode", "sepia"}});
  CHECK(badmode.status == 400);
  CHECK(has(badmode.body, "dark or light"));

  begin("a corrupt appearance record falls back to the default rather than an empty attribute");
  seed_table();
  onair::StoredAppearance rubbish{};
  rubbish.magic = 0xdead;
  rubbish.skin = 99;
  rubbish.mode = 42;
  onair::appearance_pref().save(&rubbish);
  esphome::global_preferences->sync();
  onair::held().appearance = onair::Appearance{};
  onair::load_appearance();
  CHECK(onair::held().appearance.skin == onair::Skin::TECHNICAL);
  CHECK(has(get_config(), "data-skin=\"technical\""));

  begin("markup is byte-identical across skins except the attribute itself");
  seed_table();
  post({{"action", "appearance"}, {"skin", "table"}, {"mode", "dark"}});
  std::string a = get_config("interruptible");
  post({{"action", "appearance"}, {"skin", "colorful"}, {"mode", "dark"}});
  std::string b = get_config("interruptible");
  std::string a2 = a, b2 = b;
  a2.replace(a2.find("data-skin=\"table\""), strlen("data-skin=\"table\""), "X");
  b2.replace(b2.find("data-skin=\"colorful\""), strlen("data-skin=\"colorful\""), "X");
  // The banner text differs ("appearance saved" is consumed) and the settings block below the
  // table legitimately differs (it holds the selected="" that IS the setting), so the window
  // is the table itself - the expensive part, and the part a skin must not touch.
  auto table_of = [](const std::string &page) {
    size_t from = page.find("<div class=\"list\"");
    size_t to = page.find("<h2>Panel settings</h2>");
    return page.substr(from, to - from);
  };
  CHECK_MSG(table_of(a2) == table_of(b2),
            "a skin must cost nothing in the scarce pool - the table markup is identical");
}

// =========================================================================================
// 7. THE ROW CAP, DORMANT OVERRIDES, AND THE BANNERS
// =========================================================================================
static void test_bounds_and_banners() {
  begin("the row cap announces itself rather than truncating silently");
  seed_table();
  onair::held().table.clear();
  for (int i = 0; i < 30; i++) {
    char id[16];
    snprintf(id, sizeof(id), "row%02d", i);
    onair::held().table.push_back({id, "LABEL", false, 0xffffff, 0x0b6e2e});
  }
  std::string h = get_config();
  CHECK(count_of(h, "class=\"r\"") + count_of(h, "class=\"r ov\"") == onair::MAX_ROWS_RENDERED);
  CHECK_MSG(has(h, "shows the first 24"), "an operator must never think a row vanished");
  CHECK(has(h, "This profile has 30 rows"));

  begin("a dormant override stays visible");
  seed_table();
  onair::Override o;
  o.id = "focus-mode";
  o.has_label = true;
  o.label = "DEEP WORK";
  onair::held().overlay.push_back(o);
  h = get_config();
  CHECK_MSG(has(h, "not in the server list"),
            "an override that stopped applying without saying so is silent rot");
  CHECK(has(h, "focus-mode"));
  CHECK_MSG(has(h, "Clear"), "and it can still be cleared");

  begin("PENDING says the page body is unconfirmed, not merely 'reload'");
  seed_table();
  h = onair::config_page("the panel is busy applying this", onair::Submitted::PENDING, "");
  CHECK(has(h, "banner pending"));
  CHECK_MSG(has(h, "Nothing below is confirmed until you"),
            "PENDING must not present the body as current fact");

  begin("NO CONFIG is its own page, and offers nothing to edit");
  seed_table();
  onair::held().have = false;
  onair::held().table.clear();
  h = get_config();
  CHECK_MSG(has(h, "has not received the list of states"),
            "it must say what is wrong in words, not in this repo's shorthand");
  CHECK_MSG(!has(h, "class=\"list\""), "and offer nothing to edit");
  CHECK_MSG(has(h, "<h2>Panel settings</h2>"),
            "but the settings must SURVIVE it - a panel with no table is exactly when you "
            "want to check its settings, and this page used to return before showing them");

  begin("the clear controls carry formnovalidate");
  // A half-typed hex must never block the one control that puts a row back.
  seed_table();
  h = get_config("available");
  CHECK(has(h, "value=\"clear\" formnovalidate"));
}

// =========================================================================================
// 8. THE POOL A BUDGET
//
// The reason B won. A regression here is not cosmetic: a failed reserve() under
// -fno-exceptions is abort(), which reboots the panel driving the light.
// =========================================================================================
static void test_byte_budget() {
  // EVERY STATE THE DEVICE CAN ACTUALLY SERVE, not just the clean one.
  //
  // This gate used to measure `seed_table()` alone - and seed_table() CLEARS THE OVERLAY, so
  // the one page it checked was the cheapest page that exists. The states that actually blow
  // the fence (rows changed here, a banner, the screen held) were never on it, and the suite
  // stayed green while the real page went over. A budget test that cannot see the expensive
  // case is worse than none: it reports safety it has not measured.
  struct Case { const char *name; size_t bytes; };
  std::vector<Case> cases;

  auto override_row = [](const char *id, const char *label) {
    onair::Override o;
    o.id = id;
    o.has_label = true;
    o.label = label;
    onair::held().overlay.push_back(o);
  };

  seed_table();
  cases.push_back({"default", get_config().size()});

  seed_table();
  override_row("available", "FREE NOW");
  cases.push_back({"one row changed here", get_config().size()});

  seed_table();
  override_row("available", "FREE NOW");
  override_row("on-air", "ON A CALL");
  override_row("interruptible", "KNOCK FIRST");
  override_row("recording", "RECORDING NOW");
  override_row("unknown", "NOT SURE");
  cases.push_back({"every row changed here", get_config().size()});

  seed_table();
  override_row("available", "FREE NOW");
  override_row("on-air", "ON A CALL");
  override_row("interruptible", "KNOCK FIRST");
  override_row("recording", "RECORDING NOW");
  override_row("unknown", "NOT SURE");
  onair::held().bench_level = 0;
  cases.push_back({"every row changed + screen held", get_config().size()});
  cases.push_back({"...and a banner on top",
                   onair::config_page("Screen turned off.", onair::Submitted::APPLIED, "", true)
                       .size()});
  onair::held().bench_level = onair::BENCH_NONE;

  // A row the server has since deleted is still rendered, deliberately (an override that
  // stopped applying without saying so is silent rot), and it is the widest row there is.
  seed_table();
  override_row("deleted-row-with-a-long-id", "A LABEL THAT IS LONG");
  cases.push_back({"a dormant override for a deleted row", get_config().size()});

  begin("EVERY five-row page the device can serve stays under the fence");
  for (const auto &c : cases)
    CHECK_MSG(c.bytes < 4000,
              std::string(c.name) + " = " + std::to_string(c.bytes) + " B");
  printf("        [budget]");
  for (const auto &c : cases)
    printf(" %s=%zu", c.name, c.bytes);
  printf("\n");

  begin("per-row cost stays near 420 bytes at the cap");
  seed_table();
  onair::held().table.clear();
  for (int i = 0; i < (int) onair::MAX_ROWS_RENDERED; i++) {
    char id[16];
    snprintf(id, sizeof(id), "row%02d", i);
    onair::held().table.push_back({id, "SOME LABEL", false, 0xffffff, 0x0b6e2e});
  }
  size_t full = get_config().size();
  CHECK_MSG(full < 16000, "24 rows was ~20,860 B before #50; measured " + std::to_string(full));
  CHECK_MSG(full < 24000, "and must stay under the reserve() the device is proven to survive");
  printf("        [budget] %zu rows %zu B, editor open %zu B\n", onair::MAX_ROWS_RENDERED,
         full, get_config("row00").size());
  seed_table();
}

// =========================================================================================
// 8b. THE STATUS PAGE
//
// Added after it regressed. D-72 moved the stylesheet out of the generated HTML and the
// status page kept emitting class names the new stylesheet does not define, so `NO DATA` -
// the one word that page exists to say - rendered SMALLER than its own body text. #50 said
// in as many words that the status page must be re-checked if page_head() changed under it.
// Nothing enforced that, so now something does: every class this page emits must have a rule.
// =========================================================================================
static void test_status_page() {
  begin("every class the status page emits exists in the stylesheet");
  seed_table();
  std::string h = onair::status_page();
  // Read the real stylesheet rather than a copy of the class list, so adding a class to the
  // page without adding a rule fails here instead of on the glass.
  FILE *f = fopen("../assets/onair.css", "rb");
  CHECK_MSG(f != nullptr, "cannot open firmware/assets/onair.css");
  if (f == nullptr)
    return;
  std::string css;
  char buf[4096];
  size_t n;
  while ((n = fread(buf, 1, sizeof(buf), f)) > 0)
    css.append(buf, n);
  fclose(f);

  size_t at = 0;
  size_t seen = 0;
  while ((at = h.find("class=\"", at)) != std::string::npos) {
    size_t vs = at + strlen("class=\"");
    std::string value = h.substr(vs, h.find('"', vs) - vs);
    at = vs;
    // A class attribute can hold several; check each.
    size_t start = 0;
    while (start < value.size()) {
      size_t sp = value.find(' ', start);
      std::string one = value.substr(start, sp == std::string::npos ? std::string::npos : sp - start);
      start = (sp == std::string::npos) ? value.size() : sp + 1;
      if (one.empty())
        continue;
      seen++;
      CHECK_MSG(has(css, "." + one), "the status page emits class \"" + one + "\" and no rule defines it");
    }
  }
  CHECK_MSG(seen > 0, "the status page should carry classes at all");

  begin("the status word is the page's headline, not a table column");
  CHECK_MSG(has(h, "class=\"shapeword "),
            "NO DATA must use .shapeword (2rem) and not .shape, which is the row-line column");
  CHECK(!has(h, "class=\"shape "));

  begin("the status page shows no credential and offers no control that changes anything");
  CHECK_MSG(!has(h, "<form"), "it is read-only by design (D-57)");
  CHECK(!has(h, "password"));
  CHECK(!has(h, "passphrase"));

  begin("it links its own stylesheet, and carries no inline style");
  CHECK(has(h, "<link rel=\"stylesheet\" href=\"/onair.css\">"));
  CHECK(!has(h, "<style"));

  begin("it reports the same shape the glass is showing");
  // Both call compute_view(). A status page that could be calm about something the panel
  // was not would be worse than no status page.
  // For a row it DRAWS, the headline is that row's label - the shape name appears only on
  // the off-nominal branches, which is right: an operator reads the panel by its words.
  seed_table();
  onair::held().key = "on-air";
  std::string busy = onair::status_page();
  CHECK_MSG(has(busy, "ON AIR"), "a rendered row is headlined by its own label");
  CHECK_MSG(has(busy, "Busy. The light is on."), "and the sub-line says what that means");

  seed_table();
  onair::held().key = "unknown";
  CHECK_MSG(has(onair::status_page(), "NO DATA"),
            "unknown short-circuits to NO_DATA here exactly as it does on the glass");

  // THE THREE CONDITIONS (D-91), on the page, from the same compute_view the glass uses.
  //
  // What changed: a CALM row on an old WRITE used to be NO DATA outright. It is not any
  // more, because the server latches state and the age of a write stopped meaning
  // anything. What replaced it is a judgement about THIS PANEL'S CONNECTION.

  begin("condition 1 - the server is answering: the row is drawn plainly, no mark");
  seed_table();
  onair::held().key = "available";
  std::string live = onair::status_page();
  CHECK_MSG(has(live, "Not busy."), "a calm row on a live link is simply calm");
  CHECK_MSG(!has(live, "NOT REFRESHING"), "and carries no mark");
  CHECK_MSG(!has(live, "NO DATA"), "and is certainly not NO DATA");

  begin("condition 1 survives an OLD state that the server is still serving");
  // The headline. The last write is routinely hours old and the server latches it; this
  // is the exact case that used to paint NO DATA on a completely healthy system.
  seed_table();
  onair::held().last_contact_ms = esphome::g_millis;
  esphome::g_millis += 4 * 60 * 60 * 1000u;              // four hours pass...
  onair::held().last_contact_ms = esphome::g_millis;     // ...and the server answered just now
  std::string old_write = onair::status_page();
  CHECK_MSG(has(old_write, "Not busy."), "an old write on a live link is still the state");
  CHECK_MSG(!has(old_write, "NO DATA"), "age is not evidence of anything (D-91)");
  seed_table();

  begin("condition 2 - contact lost: the row is HELD, and says it is not being refreshed");
  seed_table();
  onair::held().key = "available";
  esphome::g_millis += onair::CONNECTION_LOST_MS + 1000;
  std::string marked = onair::status_page();
  CHECK_MSG(has(marked, "AVAILABLE"), "it does not go blank - the last known row is still drawn");
  CHECK_MSG(!has(marked, "NO DATA"), "and it does not give up ten minutes early");
  CHECK_MSG(has(marked, "not a current reading"),
            "a held calm row MUST say it is not being refreshed - this is the false-OFF guard");
  esphome::g_millis -= onair::CONNECTION_LOST_MS + 1000;

  begin("condition 2 covers a BUSY row identically - no per-row branch (D-92)");
  seed_table();
  onair::held().key = "on-air";
  esphome::g_millis += onair::CONNECTION_LOST_MS + 1000;
  std::string busy_marked = onair::status_page();
  CHECK_MSG(has(busy_marked, "not a current reading"), "a busy row is marked the same way");
  CHECK_MSG(!has(busy_marked, "NO DATA"), "and is held just as long");
  esphome::g_millis -= onair::CONNECTION_LOST_MS + 1000;

  begin("29 minutes is still condition 2 - the thresholds are not chained");
  seed_table();
  onair::held().key = "available";
  esphome::g_millis += 29 * 60 * 1000u;
  CHECK(!has(onair::status_page(), "NO DATA"));
  esphome::g_millis -= 29 * 60 * 1000u;

  begin("condition 3 - past thirty minutes the panel gives the state up entirely");
  seed_table();
  onair::held().key = "available";
  esphome::g_millis += onair::NO_DATA_MS + 1000;
  std::string gone = onair::status_page();
  CHECK_MSG(has(gone, "NO DATA"), "past the second threshold there is no claim left to make");
  CHECK_MSG(!has(gone, "Not busy."), "and it must not still be describing itself as calm");
  esphome::g_millis -= onair::NO_DATA_MS + 1000;

  begin("the thresholds are CONFIGURATION - the page follows the live values, not the defaults");
  // A page compiled against the defaults while the glass runs configured values would be
  // two renderers disagreeing about the same panel, which is what D-86 exists to prevent.
  seed_table();
  onair::held().key = "available";
  onair::held().lost_ms = 5000;
  onair::held().no_data_ms = 10000;
  esphome::g_millis += 6000;
  CHECK_MSG(has(onair::status_page(), "not a current reading"),
            "a 5s connection-lost setting must mark at 6s, not wait for the compiled 60s");
  esphome::g_millis += 5000;
  CHECK_MSG(has(onair::status_page(), "NO DATA"),
            "and a 10s no-data setting must give up at 11s");
  esphome::g_millis -= 11000;
  seed_table();

  begin("NEVER having heard from the server is the largest gap, not a gap of zero");
  seed_table();
  onair::held().key = "available";
  onair::held().last_contact_ms = 0;
  CHECK_MSG(has(onair::status_page(), "NO DATA"),
            "a restored entity value with nobody behind it must never read as calm");
  seed_table();
}

// =========================================================================================
// 9. REGISTRATION: what is open and what is behind the credential
// =========================================================================================
static void test_registration() {
  begin("the status page and both assets are registered WITHOUT auth; config WITH it");
  esphome::web_server_base::global_web_server_base->with_auth.clear();
  esphome::web_server_base::global_web_server_base->without_auth.clear();
  onair::install_pages();
  CHECK_MSG(esphome::web_server_base::global_web_server_base->without_auth.size() == 3,
            "/onair, /onair.css and /onair.js must all be reachable with no credential - "
            "a stylesheet behind auth makes the open page prompt for its own subresource");
  CHECK(esphome::web_server_base::global_web_server_base->with_auth.size() == 1);

  begin("the assets are served from flash, gzipped and immutable");
  AsyncWebServerRequest req(HTTP_GET, "/onair.css");
  bool served = false;
  for (auto *handler : esphome::web_server_base::global_web_server_base->without_auth) {
    if (handler->canHandle(&req)) {
      handler->handleRequest(&req);
      served = true;
      break;
    }
  }
  CHECK(served);
  CHECK_MSG(req.sent_progmem, "must use the progmem response - it copies nothing into heap");
  CHECK(req.headers["Content-Encoding"] == "gzip");
  CHECK(has(req.headers["Cache-Control"], "immutable"));
  CHECK_MSG(req.body.size() >= 2 && (uint8_t) req.body[0] == 0x1f && (uint8_t) req.body[1] == 0x8b,
            "the blob really is gzip - magic 1f 8b");

  begin("the root redirect is registered WITHOUT auth, and on its own");
  esphome::web_server_base::global_web_server_base->with_auth.clear();
  esphome::web_server_base::global_web_server_base->without_auth.clear();
  onair::install_root_redirect();
  CHECK_MSG(esphome::web_server_base::global_web_server_base->without_auth.size() == 1 &&
                esphome::web_server_base::global_web_server_base->with_auth.empty(),
            "a redirect that fires only after a password prompt teaches that the prompt is "
            "expected - which is the defect, not the fix (#56)");
  AsyncWebHandler *root = esphome::web_server_base::global_web_server_base->without_auth[0];

  begin("GET / answers 302 to /onair");
  AsyncWebServerRequest slash(HTTP_GET, "/");
  CHECK(root->canHandle(&slash));
  root->handleRequest(&slash);
  CHECK(slash.status == 302);
  CHECK_MSG(slash.headers["Location"] == "/onair", "the bare IP must land on the panel's own page");

  begin("GET /?esphome=1 DECLINES, so the ESPHome dashboard keeps a path");
  AsyncWebServerRequest hatch(HTTP_GET, "/");
  hatch.set_param("esphome", "1");
  CHECK_MSG(!root->canHandle(&hatch),
            "declining lets the request fall through to web_server's own handler - the OTA "
            "and log views have no other URL");

  begin("a VALUELESS /?esphome still redirects - the =1 is load-bearing");
  AsyncWebServerRequest bare(HTTP_GET, "/");
  bare.set_arg("esphome");
  CHECK_MSG(root->canHandle(&bare),
            "httpd_query_key_value() parses key=value and cannot see a bare key. Measured on "
            "the live panel, which redirected /?esphome after this shipped reading hasArg");

  begin("the root handler claims nothing but /");
  AsyncWebServerRequest status_url(HTTP_GET, "/onair");
  AsyncWebServerRequest config_url(HTTP_GET, "/onair/config");
  AsyncWebServerRequest css_url(HTTP_GET, "/onair.css");
  CHECK(!root->canHandle(&status_url));
  CHECK(!root->canHandle(&config_url));
  CHECK(!root->canHandle(&css_url));

  begin("neither page links to the bare root any more - that link now bounces");
  seed_table();
  std::string sp = onair::status_page();
  std::string cp = onair::config_page("", onair::Submitted::APPLIED, "");
  CHECK_MSG(has(sp, "href=\"/?esphome=1\""), "the page the bare IP lands on must offer the dashboard");
  CHECK(has(cp, "href=\"/?esphome=1\""));
  CHECK_MSG(!has(sp, "href=\"/\"") && !has(cp, "href=\"/\""),
            "a link to / would redirect straight back here");
}

// =========================================================================================
// 10. THE STAGING MODEL (D-64)
// =========================================================================================
static void test_staging() {
  begin("with the main loop running, a command is APPLIED");
  seed_table();
  g_task_yield_hook = onair::pump;
  std::string note;
  onair::Command c;
  c.kind = onair::Command::REFRESH;
  CHECK(onair::submit(c, note) == onair::Submitted::APPLIED);

  begin("with the main loop parked, it is PENDING - never a false failure");
  // This is the D-64 case exactly: the loop can be parked up to 5 s inside http_request.get,
  // and an earlier version reported failure while leaving the command staged, so it was
  // applied and persisted moments later while the page said the opposite.
  seed_table();
  g_task_yield_hook = nullptr;
  onair::Command c2;
  c2.kind = onair::Command::REFRESH;
  onair::Submitted outcome = onair::submit(c2, note);
  CHECK_MSG(outcome == onair::Submitted::PENDING || outcome == onair::Submitted::FAILED,
            "a parked loop must not be reported as success");
  if (outcome == onair::Submitted::FAILED)
    CHECK_MSG(!onair::held().cmd.armed, "if it says FAILED it must have unstaged the command");
  g_task_yield_hook = onair::pump;
  onair::held().cmd = onair::Command{};
}

// =========================================================================================
// #70. THE GLASS BAR - the clock toggle on the config page
// =========================================================================================
static void test_glass_bar() {
  begin("the two bars are labelled, so pages-vs-glass is visible and not just written down");
  seed_table();
  std::string h = get_config();
  CHECK(has(h, "<strong>Pages</strong>"));
  CHECK(has(h, "<strong>Clock</strong>"));
  CHECK_MSG(h.find("<strong>Clock</strong>") < h.find("<strong>Pages</strong>"),
            "the panel's own setting comes before the one that only changes this website");
  CHECK_MSG(h.find("<div class=\"list\"") < h.find("<h2>Panel settings</h2>"),
            "and the state table comes before both - it is what the page is opened for");

  begin("the bar shows the CURRENT state, so it cannot lie about what the panel is doing");
  seed_table();
  onair::publish_context("available", 1000, "10.42.14.239", "-52dBm", 60000, 1800000, true,
                         "5:48 PM");
  h = get_config();
  CHECK(has(h, "value=\"on\" checked"));
  CHECK(!has(h, "value=\"off\" checked"));
  CHECK_MSG(has(h, "Showing <strong>5:48 PM</strong>"), "and says what is on the glass");

  begin("off is off, and says so rather than showing a stale time");
  onair::publish_context("available", 1000, "10.42.14.239", "-52dBm", 60000, 1800000, false,
                         "5:48 PM");
  h = get_config();
  CHECK(has(h, "value=\"off\" checked"));
  CHECK(!has(h, "value=\"on\" checked"));
  CHECK(!has(h, "5:48 PM"));

  begin("ON WITH NO TIME is its own message - the state that looks like a wrong clock");
  onair::publish_context("available", 1000, "10.42.14.239", "-52dBm", 60000, 1800000, true,
                         onair::CLOCK_UNSET);
  h = get_config();
  CHECK_MSG(has(h, "has not been told the time"), "it must name the cause, which is the network");
  CHECK(has(h, "NTP"));

  begin("a toggle reaches the main loop as a REQUEST, and only once");
  seed_table();
  AsyncWebServerRequest req = post({{"action", "glass"}, {"clock", "on"}});
  CHECK(req.status == 200);
  bool want = false;
  CHECK_MSG(onair::take_clock_request(want), "the page must have asked for something");
  CHECK(want == true);
  CHECK_MSG(!onair::take_clock_request(want), "and it is one-shot - a repeat would fight the switch");

  begin("off round-trips the same way, which a bool-only request could not express");
  seed_table();
  req = post({{"action", "glass"}, {"clock", "off"}});
  CHECK(req.status == 200);
  want = true;
  CHECK(onair::take_clock_request(want));
  CHECK_MSG(want == false, "\"requested off\" must not read as \"nothing requested\"");

  begin("an unrecognised value is REFUSED, never defaulted to off");
  seed_table();
  req = post({{"action", "glass"}, {"clock", "maybe"}});
  CHECK(req.status == 400);
  CHECK(has(req.body, "must be on or off"));
  CHECK_MSG(!onair::take_clock_request(want), "a refused POST must stage nothing at all");

  begin("a missing value is refused too - an empty radio set is not consent");
  seed_table();
  req = post({{"action", "glass"}});
  CHECK(req.status == 400);
  CHECK(!onair::take_clock_request(want));

  begin("the glass bar is behind the same CSRF check as everything else");
  seed_table();
  req = post({{"action", "glass"}, {"clock", "on"}}, "http://evil.example");
  CHECK(req.status == 400);
  CHECK(has(req.body, "came from another site"));
  CHECK_MSG(!onair::take_clock_request(want), "and nothing was staged");

  // Leave the mirror as the rest of the suite expects to find it.
  onair::publish_context("available", 1000, "10.42.14.239", "-52dBm", 60000, 1800000);
}

// ---- #69: the wall clock's string --------------------------------------------------
//
// Worth a test at all because a display lambda cannot have one. The whole point of putting
// this in onair_table.h rather than in each board file is that the format becomes something
// the host can check - the same argument that put compute_view() there.
static void test_clock() {
  begin("no time yet is drawn as an unknown, not as a blank and never as 1970");
  CHECK(onair::format_clock(false, 0, 0) == "--:--");
  CHECK_MSG(onair::format_clock(false, 17, 30) == "--:--",
            "an invalid clock must ignore its numbers rather than dress them up");

  begin("12-hour, no leading zero on the hour, always two digits on the minute");
  CHECK(onair::format_clock(true, 17, 30) == "5:30 PM");
  CHECK(onair::format_clock(true, 9, 5) == "9:05 AM");

  begin("both ends of the 12-hour wrap, which is where this arithmetic goes wrong");
  CHECK_MSG(onair::format_clock(true, 0, 0) == "12:00 AM", "midnight is 12 AM, not 0 AM");
  CHECK_MSG(onair::format_clock(true, 12, 0) == "12:00 PM", "noon is 12 PM, not 0 PM");
  CHECK(onair::format_clock(true, 11, 59) == "11:59 AM");
  CHECK(onair::format_clock(true, 23, 59) == "11:59 PM");

  begin("the string fits the buffer it is built in");
  CHECK(onair::format_clock(true, 23, 59).size() < 12);
}

// =========================================================================================
// #87. THE BENCH - an operator-held override of the glass, and how it lets go
// =========================================================================================
static void test_bench() {
  auto clear_bench = []() {
    onair::held().bench_level = onair::BENCH_NONE;
  };

  begin("nothing is overridden until someone asks");
  seed_table();
  clear_bench();
  CHECK(!onair::bench_active());
  CHECK(has(get_config_bench(), "Turn the screen off"));

  begin("the bar is off the default page, but always one click away");
  seed_table();
  clear_bench();
  CHECK_MSG(!has(get_config(), "value=\"bench\""), "a beta tool must not tax every page load");
  CHECK_MSG(has(get_config(), "/onair/config?bench=1"), "but it has to be reachable");

  begin("AN ACTIVE OVERRIDE IS VISIBLE WITHOUT THE QUERY PARAM - never a hidden control");
  seed_table();
  onair::held().bench_level = 0;
  CHECK_MSG(has(get_config(), "value=\"bench\""),
            "a bar holding the glass dark must appear however the page was reached");
  CHECK(has(get_config(), "Turn the screen back on"));
  clear_bench();

  begin("turning the screen off takes the glass, and the button then offers the way back");
  seed_table();
  AsyncWebServerRequest req = post({{"action", "bench"}, {"bench", "0"}});
  CHECK(req.status == 200);
  CHECK(onair::held().bench_level == 0);
  CHECK(onair::bench_active());
  CHECK_MSG(has(get_config_bench(), "Turn the screen back on"),
            "a screen that is off must offer the way back, not the way further in");
  CHECK(!has(get_config_bench(), "Turn the screen off"));

  begin("clear puts everything back");
  seed_table();
  req = post({{"action", "bench"}, {"bench", "clear"}});
  CHECK(req.status == 200);
  CHECK(onair::held().bench_level == onair::BENCH_NONE);
  CHECK(!onair::bench_active());

  begin("an unrecognised option is refused, never rounded to a level that exists");
  seed_table();
  req = post({{"action", "bench"}, {"bench", "42"}});
  CHECK(req.status == 400);
  CHECK(has(req.body, "not a bench option"));
  CHECK(!onair::bench_active());

  begin("A BUSY ROW TAKES THE GLASS BACK AT ONCE - the rule that makes this safe");
  seed_table();
  esphome::g_millis = 1000;
  req = post({{"action", "bench"}, {"bench", "0"}});
  CHECK(req.status == 200);
  CHECK(onair::bench_active());
  CHECK_MSG(!onair::bench_expire(false), "a calm row must not disturb a test in progress");
  CHECK(onair::bench_active());
  CHECK_MSG(onair::bench_expire(true), "a busy row must release it immediately");
  CHECK_MSG(!onair::bench_active(), "and the glass must be back");
  CHECK_MSG(!onair::bench_expire(true), "releasing twice must not report a second release");

  begin("and it lets go on its own, so a closed laptop cannot leave the glass dark");
  seed_table();
  esphome::g_millis = 1000;
  req = post({{"action", "bench"}, {"bench", "0"}});
  CHECK(req.status == 200);
  esphome::g_millis = 1000 + onair::BENCH_HOLD_MS - 1;
  CHECK_MSG(!onair::bench_expire(false), "not one millisecond early");
  esphome::g_millis = 1000 + onair::BENCH_HOLD_MS;
  CHECK_MSG(onair::bench_expire(false), "and not one late");
  CHECK(!onair::bench_active());

  begin("the hold survives the millis() wrap instead of releasing every override at once");
  seed_table();
  esphome::g_millis = 0xFFFFFFFFu - 1000;
  req = post({{"action", "bench"}, {"bench", "25"}});
  CHECK(req.status == 200);
  esphome::g_millis = 0xFFFFFFFFu - 1000 + (onair::BENCH_HOLD_MS / 2);  // wrapped, still early
  CHECK_MSG(!onair::bench_expire(false), "a wrapped clock must not look like a timeout");
  esphome::g_millis = 0xFFFFFFFFu - 1000 + onair::BENCH_HOLD_MS;
  CHECK(onair::bench_expire(false));

  begin("the bench is behind the same CSRF check as every other bar");
  seed_table();
  req = post({{"action", "bench"}, {"bench", "0"}}, "http://evil.example");
  CHECK(req.status == 400);
  CHECK(has(req.body, "came from another site"));
  CHECK(!onair::bench_active());

  clear_bench();
  esphome::g_millis = 1000;
}

// =========================================================================================
// #78. THE NIGHT SCHEDULE - the wrap, and every refusal
// =========================================================================================
static onair::NightInput night_ok(uint16_t now) {
  onair::NightInput in;
  in.enabled = true; in.clock_valid = true;
  in.now_min = now; in.sleep_min = 23 * 60; in.wake_min = 7 * 60;
  in.busy = false; in.real_row = true; in.heard_from_server = true; in.woken = false;
  return in;
}

static void test_night() {
  begin("the window WRAPS midnight, which is where this arithmetic goes wrong");
  CHECK(onair::in_night_window(23 * 60, 23 * 60, 7 * 60));       // 23:00 exactly, inclusive
  CHECK(onair::in_night_window(23 * 60 + 30, 23 * 60, 7 * 60));
  CHECK(onair::in_night_window(0, 23 * 60, 7 * 60));             // midnight
  CHECK(onair::in_night_window(3 * 60, 23 * 60, 7 * 60));
  CHECK(onair::in_night_window(6 * 60 + 59, 23 * 60, 7 * 60));
  CHECK_MSG(!onair::in_night_window(7 * 60, 23 * 60, 7 * 60), "07:00 is awake, exclusive end");
  CHECK(!onair::in_night_window(12 * 60, 23 * 60, 7 * 60));
  CHECK_MSG(!onair::in_night_window(22 * 60 + 59, 23 * 60, 7 * 60), "one minute before is awake");

  begin("a window that does not wrap still works");
  CHECK(!onair::in_night_window(0 * 60, 1 * 60, 5 * 60));
  CHECK(onair::in_night_window(1 * 60, 1 * 60, 5 * 60));
  CHECK(onair::in_night_window(4 * 60 + 59, 1 * 60, 5 * 60));
  CHECK(!onair::in_night_window(5 * 60, 1 * 60, 5 * 60));

  begin("EQUAL ENDPOINTS ARE NEVER DARK - the wrap branch would read as every minute of the day");
  for (uint16_t m = 0; m < 1440; m += 97)
    CHECK(!onair::in_night_window(m, 23 * 60, 23 * 60));

  begin("inside the window with everything healthy, the panel goes dark");
  CHECK(onair::night_should_darken(night_ok(2 * 60)));
  CHECK(!onair::night_should_darken(night_ok(12 * 60)));

  begin("IT REFUSES MID-CALL, and that refusal is the one that is not negotiable");
  onair::NightInput in = night_ok(2 * 60);
  in.busy = true;
  CHECK_MSG(!onair::night_should_darken(in), "a busy row must never be dark, at any hour");

  begin("it refuses when it has never been told the time - there is no RTC on this board");
  in = night_ok(2 * 60);
  in.clock_valid = false;
  CHECK(!onair::night_should_darken(in));

  begin("it refuses when the panel cannot say what is happening");
  in = night_ok(2 * 60);
  in.real_row = false;
  CHECK_MSG(!onair::night_should_darken(in), "dark plus unknown is indistinguishable from unplugged");
  in = night_ok(2 * 60);
  in.heard_from_server = false;
  CHECK(!onair::night_should_darken(in));

  begin("a panel already woken by a state change stays awake for the rest of the window");
  in = night_ok(2 * 60);
  in.woken = true;
  CHECK(!onair::night_should_darken(in));

  begin("disabled is disabled, whatever the hour");
  in = night_ok(2 * 60);
  in.enabled = false;
  CHECK(!onair::night_should_darken(in));

  // ------------------------------------------------ the manual sleep (Companion, #91)

  begin("a MANUAL sleep darkens the panel outside the window");
  in = night_ok(12 * 60);            // the middle of the afternoon
  CHECK_MSG(!onair::night_should_darken(in), "sanity: the schedule alone would not darken here");
  in.manual = true;
  CHECK(onair::night_should_darken(in));

  begin("a manual sleep needs neither the schedule enabled nor a clock");
  in = night_ok(12 * 60);
  in.manual = true;
  in.enabled = false;
  CHECK_MSG(onair::night_should_darken(in), "it is not the schedule, so the schedule switch is not its gate");
  in = night_ok(12 * 60);
  in.manual = true;
  in.clock_valid = false;
  CHECK_MSG(onair::night_should_darken(in), "it acts on a press, not on a guess about the time");

  begin("A MANUAL SLEEP STILL REFUSES MID-CALL - a press does not outrank the invariant");
  in = night_ok(12 * 60);
  in.manual = true;
  in.busy = true;
  CHECK_MSG(!onair::night_should_darken(in), "a busy row must never be dark, however it was asked");
  // And at night too, where the schedule would also have refused - both gates, one answer.
  in = night_ok(2 * 60);
  in.manual = true;
  in.busy = true;
  CHECK(!onair::night_should_darken(in));

  begin("a manual sleep refuses when the panel cannot say what is happening");
  in = night_ok(12 * 60);
  in.manual = true;
  in.real_row = false;
  CHECK_MSG(!onair::night_should_darken(in), "dark plus unknown is indistinguishable from unplugged");
  in = night_ok(12 * 60);
  in.manual = true;
  in.heard_from_server = false;
  CHECK(!onair::night_should_darken(in));

  begin("a manual sleep IGNORES the woken latch - the row moving is not a change of mind");
  in = night_ok(2 * 60);
  in.manual = true;
  in.woken = true;
  CHECK_MSG(onair::night_should_darken(in), "woken wakes the SCHEDULE; a person's press outlives it");

  begin("moving the two shared refusals to the top did not change the schedule's answers");
  // The reorder is only safe if every scheduled case reads exactly as it did before, so
  // walk the whole day at the shipped 23:00-07:00 with a manual sleep explicitly off.
  for (uint16_t m = 0; m < 1440; m += 13) {
    in = night_ok(m);
    CHECK_MSG(onair::night_should_darken(in) == onair::in_night_window(m, 23 * 60, 7 * 60),
              "the schedule's verdict moved at some minute of the day");
  }

  begin("the operator at the page beats the schedule, both ways");
  onair::held().bench_level = onair::BENCH_NONE;
  onair::held().night_dark = true;
  CHECK_MSG(onair::effective_backlight() == 0, "the schedule darkens when nothing overrides it");
  onair::held().bench_level = 100;
  CHECK_MSG(onair::effective_backlight() == 100, "someone at the page can light a dark panel");
  onair::held().bench_level = 0;
  onair::held().night_dark = false;
  CHECK_MSG(onair::effective_backlight() == 0, "and can darken a lit one");
  onair::held().bench_level = onair::BENCH_NONE;
  CHECK(onair::effective_backlight() == 100);
}

int main() {
  printf("onair page tests\n\n");
  g_task_yield_hook = onair::pump;

  test_follow_the_server();
  test_shapes();
  test_forbidden_markup();
  test_escaping();
  test_post_contract();
  test_appearance();
  test_bounds_and_banners();
  test_byte_budget();
  test_status_page();
  test_registration();
  test_staging();
  test_clock();
  test_glass_bar();
  test_bench();
  test_night();

  printf("\n%d checks, %d failed\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
