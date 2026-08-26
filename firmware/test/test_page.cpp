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
  onair::held().last_write_ms = esphome::g_millis;
  onair::held().cmd = onair::Command{};
  onair::held().last = onair::LastResult{};
}

static std::string get_config(const std::string &open = "") {
  return onair::config_page("", onair::Submitted::APPLIED, open);
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
  std::string h = get_config();
  // The row line prints the shape word next to the luminance.
  CHECK_MSG(has(h, "hatch"), "the unknown row must say hatch");
  CHECK_MSG(!has(h, "<span class=\"shape\">block <s>26</s>"),
            "the unknown row must NOT be described as a solid block");

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
  h = get_config();
  CHECK_MSG(has(h, "frame 167"), "interruptible draws the heavy double frame at 167");
  CHECK_MSG(has(h, "ring 73"), "available draws the open ring at 73");
  CHECK_MSG(has(h, "block <s>71</s>"),
            "on-air is busy, so its luminance is struck through - colour gets no vote there");

  begin("an override that crosses 128 changes the shape the page reports");
  seed_table();
  onair::Override o;
  o.id = "interruptible";
  o.has_bgcolor = true;
  o.bgcolor = 0x3b5bdb;  // 96, under the line
  onair::held().overlay.push_back(o);
  h = get_config();
  CHECK_MSG(has(h, "ring 96"), "the override flips interruptible from frame to ring");
  CHECK_MSG(!has(h, "frame 167"), "and the server's 167 is no longer what this panel draws");
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
                  value == "refresh" || value == "appearance",
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
  // The banner text differs ("appearance saved" is consumed), so compare the list only.
  CHECK_MSG(a2.substr(a2.find("<div class=\"list\"")) == b2.substr(b2.find("<div class=\"list\"")),
            "a skin must cost nothing in the scarce pool - the markup below the chrome is identical");
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
  CHECK_MSG(has(h, "dormant"), "an override that stopped applying without saying so is silent rot");
  CHECK(has(h, "focus-mode"));
  CHECK(has(h, "applies to nothing"));

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
  CHECK(has(h, "NO CONFIG"));
  CHECK(!has(h, "class=\"list\""));

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
  begin("the five-row page stays well under what it replaced");
  seed_table();
  size_t five = get_config().size();
  CHECK_MSG(five < 4000, "5 rows was 6,840 B before #50; measured " + std::to_string(five));

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
  printf("        [budget] 5 rows %zu B, %zu rows %zu B, editor open %zu B\n", five,
         onair::MAX_ROWS_RENDERED, full, get_config("row00").size());
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

  // The branch that matters most: stale evidence for a CALM row must never read as calm.
  seed_table();
  onair::held().key = "available";
  esphome::g_millis += onair::STALE_MS + 1000;
  std::string stale = onair::status_page();
  CHECK_MSG(has(stale, "NO DATA"), "a stale calm row is NO DATA - THE BUSY RULE (D-32)");
  CHECK_MSG(!has(stale, "Not busy."), "and it must not still be describing itself as calm");
  esphome::g_millis -= onair::STALE_MS + 1000;
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

  printf("\n%d checks, %d failed\n", g_checks, g_failures);
  return g_failures == 0 ? 0 : 1;
}
