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

inline void page_head(std::string &h, const char *title) {
  h += "<!doctype html><html lang=\"en\"><head><meta charset=\"utf-8\">"
       "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>";
  h += title;
  h += "</title><style>"
       ":root{color-scheme:dark}"
       "body{margin:0;padding:1.2rem;background:#0f1113;color:#e8eaed;"
       "font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}"
       "main{max-width:44rem;margin:0 auto}"
       "h1{font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:#8b959e;margin:0 0 1rem}"
       "h2{font-size:1rem;margin:0 0 .6rem}"
       "code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.92em}"
       ".shape{font-size:2.1rem;font-weight:700;letter-spacing:.02em;margin:.2rem 0 .1rem}"
       ".sub{margin:0 0 1.2rem;color:#aab4bd;font-size:1.05rem}"
       ".warn{color:#ffca6b}.bad{color:#ff8f8f}.calm{color:#8fd6a3}"
       "dl{display:grid;grid-template-columns:auto 1fr;gap:.35rem 1rem;margin:0 0 1.4rem}"
       "dt{color:#8b959e}dd{margin:0}"
       "a.btn,button{font:inherit;background:#1d2126;color:#e8eaed;border:1px solid #333a41;"
       "border-radius:6px;padding:.45rem .9rem;cursor:pointer;text-decoration:none;display:inline-block}"
       "button:hover,a.btn:hover{background:#262c33}"
       "button.ghost{background:none;color:#aab4bd}"
       "form.row{border:1px solid #262c33;border-radius:8px;padding:.9rem 1rem;margin:0 0 .9rem}"
       "label{display:block;margin:0 0 .55rem;color:#8b959e;font-size:.85rem}"
       "input{display:block;width:100%;box-sizing:border-box;margin-top:.2rem;font:inherit;"
       "background:#0b0d0f;color:#e8eaed;border:1px solid #333a41;border-radius:5px;padding:.4rem .55rem}"
       ".badge{font-size:.7rem;letter-spacing:.1em;text-transform:uppercase;border:1px solid #444d55;"
       "border-radius:99px;padding:.05rem .5rem;color:#aab4bd;vertical-align:middle}"
       ".note{color:#8b959e;font-size:.85rem;margin:.4rem 0}"
       ".banner{border-radius:6px;padding:.6rem .9rem;margin:0 0 1rem;border:1px solid}"
       ".banner.ok{border-color:#2f6b45;color:#8fd6a3}"
       ".banner.err{border-color:#7a3b3b;color:#ff8f8f}"
       ".banner.pending{border-color:#7a6a3b;color:#e8ca8f}"
       ".swatch{display:inline-block;width:.8rem;height:.8rem;border-radius:3px;"
       "border:1px solid #555;vertical-align:-1px;margin-right:.25rem}"
       "</style></head><body><main>";
}

inline void page_foot(std::string &h) { h += "</main></body></html>"; }

inline std::string ago(uint32_t last_write_ms) {
  if (last_write_ms == 0)
    return "never, since this panel booted";
  uint32_t secs = (esphome::millis() - last_write_ms) / 1000;
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
  uint32_t last_write_ms{0};
};

inline Snapshot snapshot() {
  Snapshot s;
  esphome::LockGuard guard(held().lock);
  s.view = compute_view(held().key, held().last_write_ms);
  s.have = held().have;
  s.version = held().version;
  s.rows = held().table.size();
  s.oks = held().oks;
  s.failures = held().failures;
  s.overrides = held().overlay.size();
  s.last_write_ms = held().last_write_ms;
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
  page_head(h, "On-Air panel");
  h += "<h1>On-Air panel</h1>";

  // THE HEADLINE IS compute_view's ANSWER, not a rephrasing of it. Same function the
  // display lambda calls, so this page cannot be calm about something the glass is not.
  h += "<p class=\"shape ";
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
      h += "No fresh evidence for a calm state, so the panel refuses to claim one.";
      break;
    default:
      h += s.view.eff.row.busy ? "Busy. The light is on." : "Not busy.";
      if (s.view.eff.any_override())
        h += " <span class=\"badge\">local override</span>";
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
  row("Last state write", ago(s.last_write_ms) + (s.view.stale ? " (stale)" : ""));
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
  h += "<p class=\"note\">Read-only. Nothing on this page changes anything, and no "
       "credential of any kind appears on it.</p>";
  page_foot(h);
  return h;
}

// ---- the configuration view, authenticated -------------------------------------------

inline void colour_field(std::string &h, const char *name, const char *caption,
                         bool overridden, uint32_t value, uint32_t server_value) {
  h += "<label>";
  h += caption;
  if (overridden)
    h += " <span class=\"badge\">override</span>";
  h += "<input name=\"";
  h += name;
  h += "\" maxlength=\"7\" pattern=\"#[0-9a-fA-F]{6}\" placeholder=\"";
  h += format_hex_color(server_value);
  h += "\" value=\"";
  if (overridden)
    h += format_hex_color(value);
  h += "\"></label>";
}

inline void render_row_form(std::string &h, const Row &pulled, const Override *o) {
  h += "<form class=\"row\" method=\"post\" action=\"/onair/config\">";
  h += "<input type=\"hidden\" name=\"id\" value=\"" + html_escape(pulled.id) + "\">";
  h += "<h2><code>" + html_escape(pulled.id) + "</code> <span class=\"badge\">";
  h += pulled.busy ? "busy" : "calm";
  h += "</span></h2>";

  bool has_label = o != nullptr && o->has_label;
  h += "<label>Label";
  if (has_label)
    h += " <span class=\"badge\">override</span>";
  h += "<input name=\"label\" maxlength=\"64\" placeholder=\"" + html_escape(pulled.label) +
       "\" value=\"" + (has_label ? html_escape(o->label) : std::string()) + "\"></label>";

  colour_field(h, "color", "Text colour", o != nullptr && o->has_color,
               o != nullptr ? o->color : 0, pulled.color);
  colour_field(h, "bgcolor", "Background", o != nullptr && o->has_bgcolor,
               o != nullptr ? o->bgcolor : 0, pulled.bgcolor);

  h += "<p class=\"note\">Blank follows the server (shown greyed). <code>busy</code> is the "
       "server's and is not editable here.</p>";
  h += "<button name=\"action\" value=\"save\">Save</button> ";
  h += "<button class=\"ghost\" name=\"action\" value=\"clear\">Clear this row</button>";
  h += "</form>";
}

inline std::string config_page(const std::string &banner, Submitted outcome) {
  std::string h;
  page_head(h, "On-Air panel - configuration");
  h += "<h1>Panel configuration</h1>";
  if (!banner.empty()) {
    h += "<p class=\"banner ";
    h += outcome == Submitted::APPLIED ? "ok" : (outcome == Submitted::PENDING ? "pending" : "err");
    h += "\">";
    h += html_escape(banner);
    if (outcome == Submitted::PENDING)
      h += " <a href=\"/onair/config\">Reload</a>";
    h += "</p>";
  }

  h += "<p class=\"note\">Local edits are <strong>presentation only</strong> and apply to "
       "this panel alone. Whether a row is busy is always the server's, and so is which "
       "rows exist. The panel keeps pulling the profile, so a row the server adds later "
       "arrives with the server's own look and needs nothing done to it.</p>";
  h += "<p class=\"note\">Background brightness picks the calm SHAPE on this 1-bit panel: "
       "luminance 128 or over draws the heavy double frame, under it the open ring. An "
       "edit across that line changes the picture. That is a consequence, not a bug.</p>";

  h += "<form method=\"post\" action=\"/onair/config\" style=\"margin:0 0 1.2rem\">"
       "<button name=\"action\" value=\"refresh\">Refresh profile from server</button></form>";

  Table table;
  Overlay overlay;
  bool have;
  std::string version;
  {
    esphome::LockGuard guard(held().lock);
    table = held().table;
    overlay = held().overlay;
    have = held().have;
    version = held().version;
  }

  if (!have) {
    h += "<p class=\"banner err\">NO CONFIG - no profile has ever arrived, so there is "
         "nothing to override yet. Check the server host, port and passphrase on the "
         "ESPHome dashboard, then press Refresh.</p>";
  } else {
    h += "<p class=\"note\">Profile v" + html_escape(version) + ", " +
         std::to_string((unsigned) table.size()) + " rows.</p>";
    // BOUNDED, and it says so when it bounds. The page is built into one contiguous
    // std::string and sent whole (HTTPD_RESP_USE_STRLEN), and each row costs ~800 bytes of
    // markup. A table near the pull's 8 kB ceiling is ~60-80 rows, so an unbounded page can
    // reach ~50 kB and a geometric realloc needs ~96 kB contiguous - on a device where the
    // largest free block is routinely less. ESP-IDF builds C++ with exceptions off, so a
    // failed allocation is abort(), which reboots the panel that is driving the light.
    //
    // Reserved up front to avoid the doubling entirely, and capped. Silent truncation would
    // be worse than the cap: an operator would think a row had vanished.
    h.reserve(h.size() + 3000 + MAX_ROWS_RENDERED * 900);
    size_t drawn = 0;
    for (const auto &r : table) {
      if (drawn++ >= MAX_ROWS_RENDERED) {
        h += "<p class=\"banner err\">This profile has " + std::to_string((unsigned) table.size()) +
             " rows and this page shows the first " + std::to_string((unsigned) MAX_ROWS_RENDERED) +
             ". The rest are still pulled and still render on the panel - they just cannot be "
             "edited here. Edit them in the admin console instead.</p>";
        break;
      }
      const Override *o = nullptr;
      for (const auto &candidate : overlay) {
        if (candidate.id == r.id) {
          o = &candidate;
          break;
        }
      }
      render_row_form(h, r, o);
    }
  }

  // A row the server has since removed. KEPT AND SHOWN, not quietly dropped: an override
  // that stopped applying without saying so is exactly the silent rot this page exists to
  // prevent. It costs one line and it is the only way anyone finds out.
  std::string dormant;
  for (const auto &o : overlay) {
    if (have && find(table, o.id) != nullptr)
      continue;
    dormant += "<form class=\"row\" method=\"post\" action=\"/onair/config\">"
               "<input type=\"hidden\" name=\"id\" value=\"" + html_escape(o.id) + "\">"
               "<h2><code>" + html_escape(o.id) + "</code> <span class=\"badge\">dormant</span></h2>"
               "<p class=\"note\">This override is stored, but the server's profile has no "
               "such row, so it applies to nothing.</p>"
               "<button class=\"ghost\" name=\"action\" value=\"clear\">Clear this row</button></form>";
  }
  if (!dormant.empty()) {
    h += "<h1 style=\"margin-top:1.6rem\">Dormant overrides</h1>";
    h += dormant;
  }

  if (!overlay.empty()) {
    h += "<form method=\"post\" action=\"/onair/config\" style=\"margin-top:1.2rem\">"
         "<button class=\"ghost\" name=\"action\" value=\"clearall\">Clear all overrides</button>"
         "</form>";
  }
  h += "<p class=\"note\" style=\"margin-top:1.6rem\">The server passphrase is not shown "
       "here and cannot be read back from this device at all (D-55). Set it on the ESPHome "
       "dashboard, where the field is write-only. "
       "<a href=\"/onair\">Back to status</a> &middot; <a href=\"/\">ESPHome dashboard</a></p>";
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
    std::string body = config_page(note, outcome);
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
  base->add_handler_without_auth(&status_handler);
  base->add_handler(&config_handler);
  ESP_LOGI("onair", "device pages: /onair (open), /onair/config (device basic auth)");
}

}  // namespace onair
