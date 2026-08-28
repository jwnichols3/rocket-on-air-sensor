#pragma once
//
// The device-served pages (#33).
//
// Two handlers on the web server ESPHome already runs, on port 80:
//
//   GET  /onair          open. What the panel is showing, and why.
//   GET  /onair/config   behind the device basic auth (D-56). The local presentation
//   POST /onair/config   overlay: edit, clear, and pull the profile now.
//
// NOT a second listener and not a second credential. `add_handler()` puts a handler behind
// web_server's own AuthMiddlewareHandler, so "login" here is the browser's credential
// prompt raised by following the Configure link - which is deliberate, and cheaper than
// correct: a styled login form means this component owning a session and a cookie, which
// brings D-23's CSRF objection back onto a device that has no CSRF defences.
//
// EVERY HANDLER HERE RUNS ON esp-idf's httpd TASK, not the ESPHome main loop. That is the
// single fact that shapes this file: reads take held().lock, and writes are staged for the
// main loop and waited on. Nothing here touches an ESPHome component API directly.

#include <freertos/FreeRTOS.h>
#include <freertos/task.h>

#include <string>

#include "esphome/components/web_server_base/web_server_base.h"
#include "esphome/core/log.h"

#include "onair_assets.h"
#include "onair_table.h"

namespace onair {

inline constexpr const char *HTML_TYPE = "text/html; charset=utf-8";

/// How many rows the config page will draw. See config_page for why there is a limit at all.
/// Well above any table a person maintains by hand, well below what exhausts the heap.
inline constexpr size_t MAX_ROWS_RENDERED = 24;

inline std::string html_escape(const std::string &in) {
  std::string out;
  out.reserve(in.size() + 16);
  for (char c : in) {
    switch (c) {
      case '&':
        out += "&amp;";
        break;
      case '<':
        out += "&lt;";
        break;
      case '>':
        out += "&gt;";
        break;
      case '"':
        out += "&quot;";
        break;
      case '\'':
        out += "&#39;";
        break;
      default:
        out += c;
    }
  }
  return out;
}

/**
 * Strict, unlike parse_hex_color.
 *
 * The lenient one exists for a SERVER payload, where a colour we cannot read must never be
 * the reason a whole table is rejected. A colour TYPED BY A PERSON is the opposite case: a
 * silent fallback would store black and look like a bug in the panel.
 */
inline bool parse_hex_color_strict(const std::string &text, uint32_t &out) {
  if (text.size() != 7 || text[0] != '#')
    return false;
  // parse_hex_color cannot return this - a colour is 24 bits - so it works as "no".
  const uint32_t SENTINEL = 0xff000000u;
  uint32_t value = parse_hex_color(text.c_str(), SENTINEL);
  if (value == SENTINEL)
    return false;
  out = value;
  return true;
}

inline std::string trim(const std::string &in) {
  size_t b = in.find_first_not_of(" \t\r\n");
  if (b == std::string::npos)
    return std::string();
  size_t e = in.find_last_not_of(" \t\r\n");
  return in.substr(b, e - b + 1);
}

inline std::string param(AsyncWebServerRequest *request, const char *name) {
  AsyncWebParameter *p = request->getParam(name);
  return p == nullptr ? std::string() : p->value();
}

/**
 * Hands a command to the main loop and waits for the verdict.
 *
 * Blocks the HTTP task, never the main loop - which is the right way round: the loop that
 * repaints the display does not stop for a browser. 3 s is far beyond the ~16 ms a loop
 * iteration takes, so reaching the timeout means something is wedged, and saying so beats
 * a page that reports a success it did not observe.
 */
/// What submit() actually observed. Three outcomes, not two - see below.
enum class Submitted { APPLIED, FAILED, PENDING };

/**
 * Hands a command to the main loop and waits, briefly, for the verdict.
 *
 * THREE OUTCOMES, because two were a lie. The earlier version waited 3 s and, on expiry,
 * told the operator the change had not been applied - while leaving it staged, so the main
 * loop applied and PERSISTED it moments later. The page stated the opposite of what
 * happened, and the operator, seeing the old values, would post again.
 *
 * The 3 s was not an unlucky number, it was the wrong model: it was sized against "the
 * ~16 ms a loop iteration takes", but the same firmware parks the main loop for up to 5 s
 * inside `http_request.get` on every config pull. So the budget expired in a HEALTHY case -
 * a slow server - not only a wedged one.
 *
 * Now: wait 2 s, which covers every case where the loop is free. On expiry, if the loop has
 * not TAKEN the command yet, cancel it atomically and say so - that answer is true. If it
 * has been taken, the change is in flight and cannot honestly be called either way, so say
 * THAT and let the next render report the outcome from `held().last`.
 *
 * The shorter wait also matters on its own: esp-idf dispatches every request from one httpd
 * task, so for as long as this blocks, the device serves no HTTP at all - including the
 * server's state writes.
 */
inline Submitted submit(Command c, std::string &note) {
  {
    esphome::LockGuard guard(held().lock);
    if (held().cmd.armed) {
      note = "another change is still being applied - try again";
      return Submitted::FAILED;
    }
    c.armed = true;
    c.taken = false;
    c.done = false;
    c.ok = false;
    c.note.clear();
    held().cmd = c;
  }
  for (int i = 0; i < 200; i++) {
    vTaskDelay(pdMS_TO_TICKS(10));
    esphome::LockGuard guard(held().lock);
    if (held().cmd.done) {
      note = held().cmd.note;
      return held().cmd.ok ? Submitted::APPLIED : Submitted::FAILED;
    }
  }
  esphome::LockGuard guard(held().lock);
  if (held().cmd.done) {
    note = held().cmd.note;
    return held().cmd.ok ? Submitted::APPLIED : Submitted::FAILED;
  }
  if (!held().cmd.taken) {
    // Never started. Cancelling is safe, and "not applied" is then TRUE.
    held().cmd.armed = false;
    note = "the panel was busy - nothing was changed. Try again.";
    return Submitted::FAILED;
  }
  // In flight. We do not know the outcome and will not guess at it.
  note = "the panel is busy applying this - reload in a moment to see the result";
  return Submitted::PENDING;
}

// ---- shared chrome -----------------------------------------------------------------

/**
 * The chrome. NO INLINE <style>, and that is the point (D-69).
 *
 * Measured before this change: 1,890 of GET /onair's 2,655 bytes - 71% - was its own
 * <style> block, re-sent and re-allocated in heap on every request. It is now a gzipped
 * flash blob served by AsyncWebServerResponseProgmem, which copies nothing.
 *
 * `--ip` and `--db` are set ONCE here rather than repeated inside every glass, which saves
 * roughly 30 bytes a glass - at 24 glasses that more than pays for the emitter itself.
 */
inline void page_head(std::string &h, const char *title, const std::string &ip,
                      const std::string &db) {
  Appearance look;
  {
    esphome::LockGuard guard(held().lock);
    look = held().appearance;
  }
  h += "<!doctype html><html lang=\"en\" data-skin=\"";
  h += skin_name(look.skin);
  h += "\" data-mode=\"";
  h += mode_name(look.mode);
  h += "\"><head><meta charset=\"utf-8\">"
       "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">"
       "<link rel=\"stylesheet\" href=\"/onair.css\"><title>";
  h += title;
  // The two custom properties the glass's diagnostics band reads. Quoted because they land
  // inside a CSS content: value.
  h += "</title></head><body style=\"--ip:'";
  h += html_escape(ip);
  h += "';--db:'";
  h += html_escape(db);
  h += "'\"><main>";
}

/**
 * One glass, at the firmware's own coordinates. About 62 bytes, one append, and NO
 * per-shape branching here.
 *
 * THIS IS THE CORRECTNESS MECHANISM (D-71). `Shape`'s enum values ARE the `data-shape`
 * numbers - which is why branch 5 is skipped - so this writes through the integer
 * `compute_view()` itself computed. The page therefore never DECIDES a shape and cannot
 * disagree with the glass. Every prototype that re-derived the shape drew `unknown` as a
 * solid BUSY block; `compute_view()` short-circuits that key to NO_DATA before the busy
 * test, and the one design that wrote the enum through got it right without trying.
 */
inline void glass(std::string &h, Shape shape, const std::string &label, bool small = false) {
  h += small ? "<span class=\"gw sm\"><i class=\"g\" data-shape=\"" : "<span class=\"gw\"><i class=\"g\" data-shape=\"";
  h += std::to_string((unsigned) shape);
  h += "\"><b";
  // label_font(): 30px at <= 8 characters, 14px above - and the CSS applies it on the BUSY
  // and CALM HEAVY branches ONLY, because CALM LIGHT hardcodes id(status_text) at 11px
  // unconditionally (elegoo-esp32.yaml:661).
  if (label.size() <= 8)
    h += " class=\"lg\"";
  h += ">";
  // NO DATA and NO CONFIG draw their own words; the row's label never reaches them.
  if (shape == Shape::NO_DATA)
    h += "NO DATA";
  else if (shape == Shape::NO_CONFIG)
    h += "NO CONFIG";
  else
    h += html_escape(label);
  h += "</b><s></s></i></span>";
}

inline void page_foot(std::string &h) { h += "</main></body></html>"; }

inline std::string ago(uint32_t last_contact_ms) {
  if (last_contact_ms == 0)
    return "never, since this panel booted";
  uint32_t secs = (esphome::millis() - last_contact_ms) / 1000;
  char buf[48];
  if (secs < 120) {
    snprintf(buf, sizeof(buf), "%u s ago", (unsigned) secs);
  } else {
    snprintf(buf, sizeof(buf), "%u min ago", (unsigned) (secs / 60));
  }
  return std::string(buf);
}

// ---- the status view, open ----------------------------------------------------------

/**
 * Everything the status page needs, copied out under one lock.
 *
 * Copied rather than read field by field: the page must describe ONE moment. A pull that
 * landed halfway through rendering would otherwise produce a page reporting the new
 * version against the old row count, which is a bug report waiting to happen.
 */
struct Snapshot {
  View view;
  bool have{false};
  std::string version;
  std::string host;
  size_t rows{0};
  uint32_t oks{0};
  uint32_t failures{0};
  size_t overrides{0};
  uint32_t last_contact_ms{0};
  /// For the glass's diagnostics band, which the status page also draws.
  std::string ip;
  std::string db;
};

inline Snapshot snapshot() {
  Snapshot s;
  esphome::LockGuard guard(held().lock);
  s.view = compute_view(held().key, held().last_contact_ms, held().lost_ms, held().no_data_ms);
  s.have = held().have;
  s.version = held().version;
  s.rows = held().table.size();
  s.oks = held().oks;
  s.failures = held().failures;
  s.overrides = held().overlay.size();
  s.last_contact_ms = held().last_contact_ms;
  s.ip = held().ip;
  s.db = held().db;
  return s;
}

inline std::string status_page() {
  Snapshot s = snapshot();
  const char *tone = "calm";
  if (s.view.shape == Shape::BUSY)
    tone = "warn";
  else if (s.view.shape == Shape::NO_CONFIG || s.view.shape == Shape::NO_DATA ||
           s.view.shape == Shape::UNKNOWN_KEY)
    tone = "bad";

  std::string h;
  page_head(h, "On-Air panel", s.ip, s.db);
  h += "<h1>On-Air panel</h1>";

  // THE HEADLINE IS compute_view's ANSWER, not a rephrasing of it. Same function the
  // display lambda calls, so this page cannot be calm about something the glass is not.
  h += "<p class=\"shapeword ";
  h += tone;
  h += "\">";
  if (s.view.shape == Shape::BUSY || s.view.shape == Shape::CALM_HEAVY ||
      s.view.shape == Shape::CALM_LIGHT) {
    h += html_escape(s.view.eff.row.label);
  } else {
    h += shape_name(s.view.shape);
  }
  h += "</p><p class=\"sub\">";
  switch (s.view.shape) {
    case Shape::NO_CONFIG:
      h += "No profile has ever arrived. The panel does not know this system's vocabulary, "
           "so it is not entitled to say anything about it.";
      break;
    case Shape::UNKNOWN_KEY:
      h += "The server named a state this profile does not contain, so the panel is stale. "
           "A pull has been triggered.";
      break;
    case Shape::NO_DATA:
      h += "The server has not answered for long enough that the panel has given up on the "
           "state entirely. It is not claiming anything.";
      break;
    default:
      h += s.view.eff.row.busy ? "Busy. The light is on." : "Not busy.";
      // CONDITION 2 (D-91), said in words. The picture alone cannot tell "the state is
      // calm" from "the last thing I heard was calm, a while ago", and that difference is
      // the entire safety argument.
      if (s.view.unrefreshed)
        h += " <strong>The server is not answering, so this is the last state it reported, "
             "not a current reading.</strong>";
      if (s.view.eff.any_override())
        h += " <span class=\"badge\">changed here</span>";
      break;
  }
  h += "</p><dl>";

  auto row = [&h](const char *k, const std::string &v) {
    h += "<dt>";
    h += k;
    h += "</dt><dd>";
    h += v;
    h += "</dd>";
  };

  row("State key", s.view.key.empty() ? std::string("<em>none</em>")
                                      : "<code>" + html_escape(s.view.key) + "</code>");
  row("Busy", s.view.eff.known ? (s.view.eff.row.busy ? "yes" : "no")
                               : "unknown - assumed yes");
  // The panel's own connection, which is what every threshold is measured from now (D-91).
  // "Last state write" used to be here; it was the WRITE's age, which no longer decides
  // anything, and reporting it beside a NO DATA verdict it did not cause was misleading.
  row("Last heard from the server",
      ago(s.last_contact_ms) + (s.view.unrefreshed ? " - NOT REFRESHING" : ""));
  {
    char buf[64];
    if (s.have) {
      snprintf(buf, sizeof(buf), "v%s, %u rows", s.version.c_str(), (unsigned) s.rows);
      row("Profile", buf);
    } else {
      row("Profile", "none held");
    }
    snprintf(buf, sizeof(buf), "%u ok / %u failed", (unsigned) s.oks, (unsigned) s.failures);
    row("Config pulls", buf);
  }
  {
    std::string over;
    char buf[48];
    snprintf(buf, sizeof(buf), "%u row(s) locally", (unsigned) s.overrides);
    over = buf;
    if (s.view.eff.any_override()) {
      over += "; on this row: ";
      bool first = true;
      const char *names[3] = {"label", "text colour", "background"};
      bool set[3] = {s.view.eff.label_over, s.view.eff.color_over, s.view.eff.bgcolor_over};
      for (int i = 0; i < 3; i++) {
        if (!set[i])
          continue;
        if (!first)
          over += ", ";
        over += names[i];
        first = false;
      }
    }
    row("Overrides", over);
  }
  h += "</dl>";
  h += "<p><a class=\"btn\" href=\"/onair/config\">Configure</a></p>";
  h += "<p class=\"m\">Read-only. Nothing on this page changes anything, and no "
       "credential of any kind appears on it. "
       "<a href=\"/?esphome=1\">ESPHome dashboard</a></p>";
  page_foot(h);
  return h;
}

// ---- the configuration view, authenticated -------------------------------------------

/// One editable colour: the picker that CANNOT post, and the text input that does.
///
/// The picker carries NO `name`, so it is structurally incapable of being serialised - with
/// scripting on or off. That is necessary and NOT sufficient; the guarded mirror in
/// onair.js is the other half, because a picker seeded with the server's value and mirrored
/// unconditionally would pin that value as an override the moment anyone opened it (D-71).
inline void colour_field(std::string &h, const char *name, const char *caption,
                         bool overridden, uint32_t value, uint32_t server_value) {
  std::string server = format_hex_color(server_value);
  h += "<div class=\"f\"><label>";
  h += caption;
  h += " <span class=\"pill\"></span></label><div class=\"row2\">";
  h += "<input type=\"color\" value=\"";
  h += overridden ? format_hex_color(value) : server;
  h += "\" aria-label=\"pick ";
  h += caption;
  h += "\"><input name=\"";
  h += name;
  h += "\" maxlength=\"7\" pattern=\"#[0-9a-fA-F]{6}\" spellcheck=\"false\" placeholder=\"";
  h += server;
  h += "\" value=\"";
  if (overridden)
    h += format_hex_color(value);
  h += "\"><button type=\"button\" class=\"ghost\" data-follow=\"";
  h += name;
  h += "\">Follow</button></div></div>";
}

/// One LINE in the list. A row is a line, not a form - which is the whole reason this
/// design was affordable: per-row markup is paid MAX_ROWS_RENDERED times out of the scarce
/// pool, and everything structural lives in the flash-served stylesheet instead.
inline void render_row_line(std::string &h, const Row &pulled, const Override *o,
                            const std::string &open_id) {
  Effective e = effective(pulled.id);
  bool overridden = (o != nullptr && !o->empty());

  // THE SHAPE/LUMINANCE COLUMN IS GONE, and it is not a cut for space alone.
  //
  // It printed things like `ring 73` and `block 71` - the shape a 1-BIT panel would pick and
  // the luminance it picked it by. That choice only ever existed because the 128x64 board has
  // no colour and must tell two calm rows apart by lit-pixel count; the colour panel on the
  // desk draws the operator's own colours and collapses both to one picture. With that board
  // out of service the column described a screen nobody is looking at, in vocabulary nobody
  // outside this repo shares. Rocket's word for it was that he could not tell what it meant.
  //
  // It paid for the plainer English elsewhere: 47 B a row, 235 B at five rows.
  h += "<div class=\"r";
  if (overridden)
    h += " ov";
  h += "\"><span class=\"chip\" style=\"color:";
  h += format_hex_color(e.row.color);
  h += ";background:";
  h += format_hex_color(e.row.bgcolor);
  h += "\">";
  h += html_escape(e.row.label);
  h += "</span><span class=\"id\"><code>";
  h += html_escape(pulled.id);
  h += "</code>";
  if (overridden)
    h += "<span class=\"badge loc\">changed here</span>";
  h += "</span><span class=\"busy";
  h += pulled.busy ? " y\">busy" : "\">calm";
  h += "</span>";

  if (open_id != pulled.id) {
    h += "<a class=\"btn\" href=\"/onair/config?edit=";
    h += html_escape(pulled.id);
    h += "\">Edit</a>";
  } else {
    h += "<a class=\"btn\" href=\"/onair/config\">Close</a>";
  }
  h += "</div>";
}

/// THE EDITOR, emitted ONCE for whichever row is open - not five times, and not 24 times.
inline void render_editor(std::string &h, const Row &pulled, const Override *o) {
  Effective e = effective(pulled.id);
  bool is_unknown = (pulled.id == "unknown");

  Shape shape;
  if (is_unknown)
    shape = Shape::NO_DATA;
  else if (e.row.busy)
    shape = Shape::BUSY;
  else
    shape = luminance(e.row.bgcolor) >= 128 ? Shape::CALM_HEAVY : Shape::CALM_LIGHT;

  h += "<form class=\"ed\" method=\"post\" action=\"/onair/config\" data-id=\"";
  h += html_escape(pulled.id);
  h += "\" data-busy=\"";
  h += pulled.busy ? "1" : "0";
  h += "\" data-sbg=\"";
  h += format_hex_color(pulled.bgcolor);
  h += "\"><input type=\"hidden\" name=\"id\" value=\"";
  h += html_escape(pulled.id);
  h += "\">";

  h += "<div class=\"ed-top\"><code>";
  h += html_escape(pulled.id);
  h += "</code><span class=\"m\">busy: ";
  h += pulled.busy ? "yes" : "no";
  h += " - the server's, and not editable here</span></div>";

  h += "<div class=\"ed-grid\"><div>";
  h += "<div class=\"f\"><label>Label <span class=\"pill\"></span></label><div class=\"row2\">"
       "<input name=\"label\" maxlength=\"64\" placeholder=\"";
  h += html_escape(pulled.label);
  h += "\" value=\"";
  if (o != nullptr && o->has_label)
    h += html_escape(o->label);
  h += "\"><button type=\"button\" class=\"ghost\" data-follow=\"label\">Follow</button></div></div>";

  colour_field(h, "color", "Text colour", o != nullptr && o->has_color,
               o != nullptr ? o->color : 0, pulled.color);
  colour_field(h, "bgcolor", "Background", o != nullptr && o->has_bgcolor,
               o != nullptr ? o->bgcolor : 0, pulled.bgcolor);

  // Save keeps native validation; CLEAR carries formnovalidate. A half-typed hex must never
  // block the one control that puts the row back (D-71).
  h += "<button name=\"action\" value=\"save\">Save</button> "
       "<button class=\"ghost\" name=\"action\" value=\"clear\" formnovalidate>Follow server</button>";
  h += "</div><div>";

  glass(h, shape, e.row.label);
  h += "<div class=\"lum\"><div class=\"track\"><span class=\"mark\" style=\"left:";
  char pct[16];
  snprintf(pct, sizeof(pct), "%.1f", (double) luminance(e.row.bgcolor) / 255.0 * 100.0);
  h += pct;
  h += "%\"></span></div><span class=\"cap\">background luminance ";
  h += std::to_string((unsigned) luminance(e.row.bgcolor));
  if (is_unknown || e.row.busy)
    h += " - not consulted on this row</span></div>";
  else
    h += " - the line is 128</span></div>";
  h += "<p class=\"flip\" hidden></p>";

  // The server's own picture, beside this panel's, when an override moved the shape. One
  // extra glass, only on a row that actually flipped.
  if (!is_unknown && !e.row.busy && o != nullptr && o->has_bgcolor) {
    Shape was = luminance(pulled.bgcolor) >= 128 ? Shape::CALM_HEAVY : Shape::CALM_LIGHT;
    if (was != shape) {
      h += "<p class=\"cap\">the server's own picture - lum ";
      h += std::to_string((unsigned) luminance(pulled.bgcolor));
      h += "</p>";
      glass(h, was, pulled.label, true);
    }
  }
  h += "</div></div></form>";
}

/// The appearance switcher (D-70). No JavaScript: two selects and a submit.
inline void render_appearance(std::string &h) {
  Appearance look;
  {
    esphome::LockGuard guard(held().lock);
    look = held().appearance;
  }
  auto opt = [&h](const char *value, const char *caption, bool selected) {
    h += "<option value=\"";
    h += value;
    h += selected ? "\" selected>" : "\">";
    h += caption;
    h += "</option>";
  };
  h += "<form method=\"post\" action=\"/onair/config\" class=\"bar\">"
       "<input type=\"hidden\" name=\"action\" value=\"appearance\">"
       "<strong>Pages</strong>"
       "<select name=\"skin\" aria-label=\"skin\">";
  opt("table", "Simple table", look.skin == Skin::TABLE);
  opt("colorful", "Colourful", look.skin == Skin::COLORFUL);
  opt("technical", "Technical", look.skin == Skin::TECHNICAL);
  h += "</select><select name=\"mode\" aria-label=\"mode\">";
  opt("dark", "Dark", look.mode == Mode::DARK);
  opt("light", "Light", look.mode == Mode::LIGHT);
  h += "</select><button>Apply</button>"
       "<span class=\"m\">Changes how this web page looks. Does not change the panel "
       "screen.</span></form>";
}

/// The glass switcher (#70). The COMPANION to render_appearance, and the pairing is the
/// point: two bars, labelled Pages and Glass, is what makes D-70's distinction visible
/// instead of a sentence somebody has to read. A clock cannot ride in `Appearance` - that
/// struct is documented as how the served pages look and has no path to the display lambda.
///
/// No JavaScript, matching the bar above: two radios and a submit.
inline void render_glass(std::string &h) {
  bool on;
  std::string now;
  {
    esphome::LockGuard guard(held().lock);
    on = held().clock_on;
    now = held().clock;
  }
  h += "<form method=\"post\" action=\"/onair/config\" class=\"bar\">"
       "<input type=\"hidden\" name=\"action\" value=\"glass\">"
       "<strong>Clock</strong>"
       "<label><input type=\"radio\" name=\"clock\" value=\"off\"";
  if (!on)
    h += " checked";
  h += "> Off</label><label><input type=\"radio\" name=\"clock\" value=\"on\"";
  if (on)
    h += " checked";
  h += "> On</label><button>Apply</button><span class=\"m\">";
  // THREE outcomes and not two, because "on but the panel has never been told the time"
  // is its own state and is the one worth naming. From across the room it looks exactly
  // like a clock that is merely wrong, and the fix is somewhere else entirely - this panel
  // takes its time from an NTP server over the network and can simply never reach one.
  if (!on) {
    h += "Off. The panel draws no clock.";
  } else if (now.empty() || now == CLOCK_UNSET) {
    h += "On, but this panel has not been told the time yet - it needs to reach an NTP "
         "server. It is drawing <code>";
    h += CLOCK_UNSET;
    h += "</code> rather than guessing.";
  } else {
    h += "Showing <strong>";
    h += html_escape(now);
    h += "</strong> in the panel's diagnostics strip.";
  }
  h += "</span></form>";
}

/// The bench (#87). A BETA section, said so on the page, because it does things to the glass
/// that nothing else here does and the operator should know which bar is which.
///
/// One form, several submit buttons. The clicked button's name/value is what gets posted, so
/// six options cost six buttons and no JavaScript - the same no-JS rule the two bars above it
/// follow.
inline void render_bench(std::string &h) {
  int level;
  {
    esphome::LockGuard guard(held().lock);
    level = held().bench_level;
  }
  h += "<form method=\"post\" action=\"/onair/config\" class=\"bar\">"
       "<input type=\"hidden\" name=\"action\" value=\"bench\">"
       "<strong>Beta</strong>";
  // TWO CONTROLS, because the experiment they existed for is finished. 100/25/5% and the
  // black overpaint were there to answer "what does darkening this panel actually look like",
  // Rocket answered it by pressing Off - the whole screen goes dark - and an instrument that
  // has reported its measurement should stop occupying the screen. The LEVELS survive
  // underneath because night mode will need them; only the buttons are gone.
  if (level == 0)
    h += "<button name=\"bench\" value=\"clear\">Turn the screen back on</button>";
  else
    h += "<button name=\"bench\" value=\"0\">Turn the screen off</button>";
  h += "<span class=\"m\">";
  if (level == 0)
    h += "Comes back on by itself within two minutes, or at once if a call starts.";
  else
    h += "Turns the panel screen off so you can see it dark. It comes back by itself.";
  h += "</span></form>";
}

/// Everything you set once and then leave alone, in one place and below the table.
inline void render_settings(std::string &h, bool show_bench) {
  h += "<h2>Panel settings</h2>";
  render_glass(h);
  render_appearance(h);
  // The Beta bar is off the default page for the byte budget, but an ACTIVE override always
  // renders: a hidden control holding the screen dark is the trap this whole thing avoids.
  if (show_bench || bench_active())
    render_bench(h);
}

inline std::string config_page(const std::string &banner, Submitted outcome,
                               const std::string &open_id, bool show_bench = false) {
  Table table;
  Overlay overlay;
  bool have;
  std::string version, ip, db;
  {
    esphome::LockGuard guard(held().lock);
    table = held().table;
    overlay = held().overlay;
    have = held().have;
    version = held().version;
    ip = held().ip;
    db = held().db;
  }

  // C's counting pass, which is also the largest single heap win on this page: one loop
  // over <= 24 entries hands reserve() an EXACT size instead of a worst-case guess.
  size_t rows = table.size() > MAX_ROWS_RENDERED ? MAX_ROWS_RENDERED : table.size();
  size_t overridden = 0;
  for (const auto &o : overlay) {
    if (have && find(table, o.id) != nullptr)
      overridden++;
  }

  std::string h;
  h.reserve(2600 + rows * 420 + (open_id.empty() ? 0 : 2200));

  page_head(h, "On-Air panel - configuration", ip, db);
  h += "<h1>Panel configuration</h1>";

  if (!banner.empty()) {
    h += "<p class=\"banner ";
    h += outcome == Submitted::APPLIED ? "ok" : (outcome == Submitted::PENDING ? "pending" : "err");
    h += "\">";
    h += html_escape(banner);
    // C's wording, and the only one in the bench that says the page BODY is unconfirmed
    // rather than presenting it as current fact while telling you to reload.
    if (outcome == Submitted::PENDING)
      h += " Nothing below is confirmed until you <a href=\"/onair/config\">Reload</a>.";
    h += "</p>";
  }

  h += "<p class=\"m\">The server decides which states exist. Here you set the word and "
       "colours this panel shows for each one. Clear a field to go back to the "
       "server's.</p>";

  // SETTINGS MOVED BELOW THE TABLE (#88). The state table is what this page is opened FOR;
  // the settings under it are set once and then never touched. Putting them first meant
  // scrolling past a skin picker to reach the reason you came. Rocket's words: "arrange the
  // form logically".
  // ONLY WHEN ASKED FOR, OR WHEN IT IS HOLDING THE GLASS.
  //
  // Not shyness - arithmetic. This bar cost 4228 B on the five-row page against a 4000 B
  // ceiling and the budget test caught it, and that ceiling is real: a failed reserve() under
  // -fno-exceptions is abort(), which reboots the panel driving the light. A beta instrument
  // should not tax every page load of the thing it exists to measure.
  //
  // The `|| bench_active()` half is the part that matters. An override must ALWAYS be visible
  // and always one click from released, however the operator reached the page - a hidden
  // control holding the glass dark is exactly the trap this feature is built to avoid.

  h += "<div class=\"bar\"><span class=\"m\">";
  if (have) {
    h += "Profile v" + html_escape(version) + " - " + std::to_string((unsigned) table.size()) +
         " rows - <strong>" + std::to_string((unsigned) overridden) + " of " +
         std::to_string((unsigned) table.size()) + "</strong> overridden on this panel";
  } else {
    h += "No profile has ever arrived";
  }
  h += "</span><span class=\"sp\"></span>"
       "<form method=\"post\" action=\"/onair/config\" style=\"display:inline\">"
       "<button name=\"action\" value=\"refresh\">Refresh profile from server</button></form>";
  if (!overlay.empty()) {
    // C's undo: first-class, named for what it does, and outlined red per the house style.
    h += "<form method=\"post\" action=\"/onair/config\" style=\"display:inline\">"
         "<button class=\"danger\" name=\"action\" value=\"clearall\">"
         "Clear all overrides - put this panel back</button></form>";
  }
  h += "</div>";

  // NO EARLY RETURN. It used to bail out here, which took the settings below with it - so
  // the one situation where you most want to check the panel's settings was the one where
  // the page refused to show them.
  if (!have) {
    h += "<p class=\"banner err\">This panel has not received the list of states from the "
         "server, so there is nothing to change yet. Check the server address and password "
         "on the ESPHome dashboard, then press Refresh.</p>";
    render_settings(h, show_bench);
    page_foot(h);
    return h;
  }

  h += "<div class=\"list\"><div class=\"hd\"><span>Shows on the panel</span>"
       "<span>State id</span><span>Means a call is live</span></div>";

  size_t drawn = 0;
  for (const auto &r : table) {
    if (drawn++ >= MAX_ROWS_RENDERED)
      break;
    const Override *o = nullptr;
    for (const auto &candidate : overlay) {
      if (candidate.id == r.id) {
        o = &candidate;
        break;
      }
    }
    render_row_line(h, r, o, open_id);
    if (open_id == r.id)
      render_editor(h, r, o);
  }

  // A row the server has since removed. KEPT AND SHOWN, not quietly dropped: an override
  // that stopped applying without saying so is exactly the silent rot this page prevents.
  for (const auto &o : overlay) {
    if (find(table, o.id) != nullptr)
      continue;
    h += "<div class=\"r\"><span class=\"chip\" style=\"opacity:.5\">";
    h += html_escape(o.has_label ? o.label : o.id);
    h += "</span><span class=\"id\"><code>";
    h += html_escape(o.id);
    h += "</code></span><span class=\"busy\">not in the server list</span>"
         "<form method=\"post\" action=\"/onair/config\" style=\"display:inline\">"
         "<input type=\"hidden\" name=\"id\" value=\"";
    h += html_escape(o.id);
    h += "\"><button class=\"ghost\" name=\"action\" value=\"clear\" formnovalidate>Clear"
         "</button></form></div>";
  }
  h += "</div>";

  if (table.size() > MAX_ROWS_RENDERED) {
    h += "<p class=\"banner err\">This profile has " + std::to_string((unsigned) table.size()) +
         " rows and this page shows the first " + std::to_string((unsigned) MAX_ROWS_RENDERED) +
         ". The rest are still pulled and still render on the panel - they just cannot be "
         "edited here. Edit them in the admin console instead.</p>";
  }

  render_settings(h, show_bench);

  h += "<p class=\"m\"><a href=\"/onair\">Status</a> &middot; "
       "<a href=\"/onair/config?bench=1\">Beta</a> &middot; "
       "<a href=\"/?esphome=1\">ESPHome dashboard, for the server address and "
       "password</a></p>";
  h += "<script src=\"/onair.js\"></script>";
  page_foot(h);
  return h;
}

/**
 * Validates a POST and stages it.
 *
 * THE ORIGIN CHECK IS A CSRF DEFENCE, and it is needed because HTTP Basic is not one. A
 * browser that has authenticated to this device attaches the credential to ANY request it
 * makes to it, including a form POST from a page on another site. D-23 raised exactly this
 * objection about cookies; basic auth has the same property.
 *
 * A cross-origin form POST carries an `Origin` header naming the attacker's site, and a
 * same-origin one either omits it or names this device. So: reject any POST whose Origin is
 * present and is not us. This is the same reasoning D-24 applies on the server, and it costs
 * one header read - no token, no session, no state.
 */
inline bool origin_is_ours(AsyncWebServerRequest *request) {
  esphome::optional<std::string> origin = request->get_header("Origin");
  if (!origin.has_value() || origin.value().empty())
    return true;  // A curl client, or a same-origin GET-like post. Nothing to spoof with.
  esphome::optional<std::string> host = request->get_header("Host");
  if (!host.has_value() || host.value().empty())
    return false;
  // Origin is scheme://host[:port]; compare the authority against the Host we were reached
  // on, which is what the browser would have used for a same-origin request.
  const std::string &o = origin.value();
  size_t sep = o.find("://");
  if (sep == std::string::npos)
    return false;
  return o.substr(sep + 3) == host.value();
}

/// Validates a POST and stages it.
inline Submitted handle_action(AsyncWebServerRequest *request, std::string &note) {
  if (!origin_is_ours(request)) {
    note = "refused: this request came from another site";
    return Submitted::FAILED;
  }
  std::string action = param(request, "action");
  Command c;

  if (action == "refresh") {
    c.kind = Command::REFRESH;
    return submit(c, note);
  }
  if (action == "clearall") {
    c.kind = Command::CLEAR_ALL;
    return submit(c, note);
  }
  // D-70. The one additive exception to the contract D-68 froze; everything else there is
  // unchanged. Placed before the id checks because an appearance carries no row id.
  //
  // REFUSED rather than defaulted on an unrecognised value. Quietly storing "technical"
  // when the caller asked for something else, and reporting success, is how a setting
  // silently does nothing.
  if (action == "appearance") {
    if (!parse_skin(param(request, "skin"), c.skin)) {
      note = "that is not a skin this panel has";
      return Submitted::FAILED;
    }
    if (!parse_mode(param(request, "mode"), c.mode)) {
      note = "mode must be dark or light";
      return Submitted::FAILED;
    }
    c.kind = Command::APPEARANCE;
    return submit(c, note);
  }
  // #70. Also before the id checks - a glass setting carries no row id either. REFUSED
  // rather than defaulted on an unrecognised value, for render_appearance's reason: quietly
  // storing "off" when the caller asked for something else, and reporting success, is how a
  // setting silently does nothing.
  if (action == "glass") {
    std::string clock = param(request, "clock");
    if (clock != "on" && clock != "off") {
      note = "the clock must be on or off";
      return Submitted::FAILED;
    }
    c.show_clock = clock == "on";
    c.kind = Command::GLASS;
    return submit(c, note);
  }

  // #87. Before the id checks with the other two - a bench press carries no row id either.
  if (action == "bench") {
    std::string want = param(request, "bench");
    if (want == "clear") {
      c.bench_level = BENCH_NONE;
    } else if (want == "0" || want == "5" || want == "25" || want == "100") {
      // The levels outlive their buttons because night mode will need one. Only 0 and clear
      // are reachable from the page today - see render_bench.
      c.bench_level = atoi(want.c_str());
    } else {
      note = "that is not a bench option this panel has";
      return Submitted::FAILED;
    }
    c.kind = Command::BENCH;
    return submit(c, note);
  }

  c.id = trim(param(request, "id"));
  if (c.id.empty() || c.id.size() > 32) {
    note = "that row id is not one this panel can address";
    return Submitted::FAILED;
  }

  if (action == "clear") {
    c.kind = Command::CLEAR;
    return submit(c, note);
  }
  if (action != "save") {
    note = "unknown action";
    return Submitted::FAILED;
  }

  // REFUSED RATHER THAN IGNORED. Dropping a `busy` field silently would let a caller
  // believe it had been applied, and the whole point of the overlay's shape is that busy
  // is not negotiable here.
  if (request->hasParam("busy")) {
    note = "busy is the server's - it cannot be set from this panel";
    return Submitted::FAILED;
  }

  {
    esphome::LockGuard guard(held().lock);
    if (!held().have || find(held().table, c.id) == nullptr) {
      note = "no such row in the server's profile - rows are not added locally";
      return Submitted::FAILED;
    }
  }

  c.kind = Command::SAVE;
  std::string label = trim(param(request, "label"));
  if (!label.empty()) {
    if (label.size() > 64) {
      note = "a label is at most 64 characters";
      return Submitted::FAILED;
    }
    c.has_label = true;
    c.label = label;
  }
  std::string color = trim(param(request, "color"));
  if (!color.empty()) {
    if (!parse_hex_color_strict(color, c.color)) {
      note = "text colour must look like #rrggbb";
      return Submitted::FAILED;
    }
    c.has_color = true;
  }
  std::string bgcolor = trim(param(request, "bgcolor"));
  if (!bgcolor.empty()) {
    if (!parse_hex_color_strict(bgcolor, c.bgcolor)) {
      note = "background must look like #rrggbb";
      return Submitted::FAILED;
    }
    c.has_bgcolor = true;
  }
  return submit(c, note);
}

/**
 * A gzipped blob in flash (D-69).
 *
 * `beginResponse(code, type, const uint8_t *, size_t)` builds an
 * AsyncWebServerResponseProgmem, which points at flash and copies NOTHING into heap - which
 * is the whole reason the stylesheet moved out of the generated HTML. ESPHome serves its
 * own dashboard exactly this way.
 *
 * Registered WITHOUT auth, and that is required rather than lax: `/onair` is deliberately
 * open (D-57), so a stylesheet behind the device credential would make the open page raise
 * a credential prompt for its own subresource. This is also why ESPHome's built-in
 * `css_include:` cannot be used - its handler is registered with auth.
 *
 * The blob is public, non-secret presentation. There is nothing in it worth a credential.
 */
class Asset : public AsyncWebHandler {
 public:
  Asset(const char *path, const char *type, const uint8_t *body, size_t len)
      : path_(path), type_(type), body_(body), len_(len) {}

  bool canHandle(AsyncWebServerRequest *request) const override {
    char buf[AsyncWebServerRequest::URL_BUF_SIZE];
    return request->url_to(buf) == this->path_;
  }

  void handleRequest(AsyncWebServerRequest *request) override {
    AsyncWebServerResponse *response = request->beginResponse(200, this->type_, this->body_, this->len_);
    response->addHeader("Content-Encoding", "gzip");
    // Immutable: the content only ever changes with a reflash, and a reflash is not
    // something a cache can straddle. This is what makes the asset free after the first hit.
    response->addHeader("Cache-Control", "public, max-age=31536000, immutable");
    request->send(response);
  }

 protected:
  const char *path_;
  const char *type_;
  const uint8_t *body_;
  size_t len_;
};

/**
 * One class, two instances. The status page is registered WITHOUT auth and the config page
 * WITH it, which is the only difference between them that matters.
 */
class Page : public AsyncWebHandler {
 public:
  explicit Page(bool config) : config_(config) {}

  bool canHandle(AsyncWebServerRequest *request) const override {
    char buf[AsyncWebServerRequest::URL_BUF_SIZE];
    StringRef url = request->url_to(buf);
    return this->config_ ? url == "/onair/config" : url == "/onair";
  }

  void handleRequest(AsyncWebServerRequest *request) override {
    if (!this->config_) {
      std::string body = status_page();
      request->send(200, HTML_TYPE, body.c_str());
      return;
    }
    std::string note;
    Submitted outcome = Submitted::APPLIED;
    if (request->method() == HTTP_POST) {
      outcome = handle_action(request, note);
    } else {
      // A plain GET reports the outcome of a command that finished after its own request
      // had to stop waiting. Consumed, so it is shown once and does not haunt every reload.
      esphome::LockGuard guard(held().lock);
      if (held().last.present) {
        note = held().last.note;
        outcome = held().last.ok ? Submitted::APPLIED : Submitted::FAILED;
        held().last.present = false;
      }
    }
    // `getParam` falls through to the query string, so ?edit=<id> needs no new plumbing.
    std::string open_id = trim(param(request, "edit"));
    if (open_id.size() > 32)
      open_id.clear();
    std::string body = config_page(note, outcome, open_id, param(request, "bench") == "1");
    // PENDING wants 202, and this transport cannot say it: ESPHome's init_response_ maps
    // only 200/204/400/401/404/409/422 and sends 500 for anything else (measured on
    // 2026.8.0). A 500 would be a worse lie than a 200, because it claims the request
    // failed when it may well be landing. So 200, and the amber banner carries the truth.
    int status = outcome == Submitted::FAILED ? 400 : 200;
    request->send(status, HTML_TYPE, body.c_str());
  }

 protected:
  bool config_;
};

/**
 * `/` redirects to `/onair`, so the one URL a person actually types reaches the panel's own
 * page instead of ESPHome's entity list behind a credential prompt (#56).
 *
 * ORDER IS THE ENTIRE MECHANISM. `AsyncWebServer::request_handler_()` walks its handlers in
 * REGISTRATION order and the first `canHandle()` that says yes wins - and ESPHome's own
 * `WebServer::canHandle()` answers true for "/" (web_server.cpp:2339, 2026.8.0). So this
 * handler wins only if it is registered BEFORE web_server's, which is why it is installed
 * from its own early on_boot instead of alongside the other pages. See
 * install_root_redirect().
 *
 * Registered WITHOUT auth, and that is the point rather than a convenience: a redirect that
 * fires only after a password prompt is worse than no redirect, because it teaches that the
 * prompt is expected.
 */
class Root : public AsyncWebHandler {
 public:
  bool canHandle(AsyncWebServerRequest *request) const override {
    char buf[AsyncWebServerRequest::URL_BUF_SIZE];
    if (request->url_to(buf) != "/")
      return false;
    // THE DASHBOARD'S SURVIVING PATH. Declining here does not 404 - it lets the request fall
    // through to the next handler that claims "/", which is ESPHome's own, still behind
    // ESPHome's auth exactly as before. The OTA and log views live there and have no other
    // URL, so a redirect that swallowed "/" outright would trade one lost page for another.
    //
    // THE `=1` IS REQUIRED, and that is measured rather than assumed: this shipped once
    // reading a bare `/?esphome` and the live panel redirected anyway. Underneath,
    // `query_has_key()` calls ESP-IDF's `httpd_query_key_value()`, which parses `key=value`
    // pairs and does not see a valueless key at all. So the hatch is spelt `/?esphome=1`,
    // both pages link to exactly that, and a bare `/?esphome` simply redirects.
    return !request->hasArg("esphome");
  }

  void handleRequest(AsyncWebServerRequest *request) override { request->redirect("/onair"); }
};

/**
 * Installs ONLY the root redirect, and MUST be called from an on_boot priority above
 * web_server's setup priority (`setup_priority::WIFI - 1`, i.e. 249). Called at LATE with
 * the other pages it would register second and lose "/" in silence - the redirect would
 * simply never fire, and the symptom would be indistinguishable from not having built it.
 *
 * Registering this early is safe even though the server does not exist yet:
 * `add_handler_without_auth()` appends to `WebServerBase::handlers_`, and `init()` - which
 * web_server calls at 249 - copies that vector into the running server in order. Either way
 * this handler lands ahead of web_server's own.
 *
 * `global_web_server_base` is assigned in main.cpp's `setup()` before `App.setup()` runs, so
 * it is already non-null at every component priority.
 */
inline void install_root_redirect() {
  static Root root_handler;
  auto *base = esphome::web_server_base::global_web_server_base;
  if (base == nullptr) {
    ESP_LOGE("onair", "no web server base - / does NOT redirect to /onair");
    return;
  }
  base->add_handler_without_auth(&root_handler);
  ESP_LOGI("onair", "device pages: / redirects to /onair (/?esphome=1 keeps the ESPHome dashboard)");
}

/// Registers both pages. Call from on_boot at a priority that runs after web_server's
/// setup - handlers added after init() are attached to the running server immediately.
inline void install_pages() {
  static Page status_handler(false);
  static Page config_handler(true);
  auto *base = esphome::web_server_base::global_web_server_base;
  if (base == nullptr) {
    ESP_LOGE("onair", "no web server base - the device pages are NOT served");
    return;
  }
  static Asset css_handler("/onair.css", "text/css", ONAIR_CSS_GZ, sizeof(ONAIR_CSS_GZ));
  static Asset js_handler("/onair.js", "text/javascript", ONAIR_JS_GZ, sizeof(ONAIR_JS_GZ));
  base->add_handler_without_auth(&status_handler);
  base->add_handler_without_auth(&css_handler);
  base->add_handler_without_auth(&js_handler);
  base->add_handler(&config_handler);
  ESP_LOGI("onair", "device pages: /onair (open), /onair/config (device basic auth), "
                    "/onair.css + /onair.js (%u + %u bytes gzipped, from flash)",
           (unsigned) sizeof(ONAIR_CSS_GZ), (unsigned) sizeof(ONAIR_JS_GZ));
}

}  // namespace onair
