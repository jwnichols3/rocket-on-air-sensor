# The design envelope for a page served by the on-air ESP32

Research for the `/onair` and `/onair/config` UI variations. Everything below is either read
out of the installed ESPHome 2026.8.0 source, read out of `firmware/configs/`, or **measured
against the live panel at `10.42.12.77`** on 2026-08-26. Numbers marked MEASURED are from
that device, not from a datasheet.

Two facts set everything else:

1. **There is no chunked response and no runtime compression.** A dynamic page is built into
   one contiguous `std::string` in heap and written out whole. Its size is a single `malloc`
   on a device where a failed `malloc` is `abort()`.
2. **A static asset can live in flash, pre-gzipped at build time, and cost ~0 heap.** ESPHome
   itself does exactly this for its own dashboard. This is the escape hatch, and it is the
   single most useful thing in this document.

So there are two budgets, not one, and they are three orders of magnitude apart. Put
everything you can into the second.

---

## Design envelope

### Byte budget

| Pool | What goes in it | Budget | Hard ceiling | Basis |
|---|---|---|---|---|
| **A. Dynamic HTML** (heap, uncompressed, per request) | markup the firmware generates: status values, row forms, banners | **≤ 4 KB fixed chrome + ≤ 900 B per row** | **24 KB peak page** | MEASURED; see Q2 |
| A1. of which: inline `<style>` | | **0 B - move it to pool B** | 2 KB if you truly must inline | MEASURED 1,890 B today = 71% of the status page |
| A2. of which: inline `<script>` | | **0 B - move it to pool B** | 512 B for a boot shim only | same reason |
| **B. Static assets** (flash, gzipped, cached forever) | all CSS, all JS, SVG, fonts-as-data | **≤ 32 KB gzipped total** | 64 KB gz | Q3, Q7. ESPHome's own local dashboard blob is 24.7 KB gz; WLED ships 69 KB gz |
| B1. of which: CSS | | **≤ 8 KB gz** (~25 KB raw) | | WLED's `index.css` is 10.3 KB gz |
| B2. of which: JS | | **≤ 16 KB gz** (~50 KB raw) | | see Q4 |
| **C. Network concurrency** | simultaneous HTTP connections the page opens | **1** | 4 | MEASURED; the 6th connection costs ~1 s |

Reference points, all MEASURED on the live device today:

| | bytes |
|---|---|
| `GET /onair` whole response body | 2,655 |
| ...of which inline CSS | 1,890 |
| `GET /onair/config`, 5-row table | 6,840 |
| ...fixed chrome | 3,148 |
| ...per row form | 738 avg (730-751) |
| worst case at `MAX_ROWS_RENDERED = 24` | ~20,860 |
| contiguous heap the config page reserves per render | ~24,700 |

The 24 KB hard ceiling is not a style preference. `config_page()` calls
`h.reserve(h.size() + 3000 + MAX_ROWS_RENDERED * 900)`
(`firmware/configs/onair_page.h:453`), which is one contiguous allocation. ESP-IDF builds
C++ with exceptions off, so if that allocation fails the panel calls `abort()`, reboots, and
the light goes out mid-call. Growing the per-row markup grows that allocation 24x.

### ALLOWED

- **All CSS in one flash-served, gzipped, immutable-cached stylesheet.** This is strictly
  better than inlining on every axis: less heap, fewer bytes on the wire, cached after the
  first load. See Q3 for the exact mechanism.
- **All JS in one flash-served, gzipped, immutable-cached script**, same mechanism.
- **Hand-written vanilla JS, up to ~8 KB raw.** Plenty for live colour preview, client-side
  luminance readout, dirty-field tracking, and a single `fetch()` save. See Q4.
- **Modern CSS with no polyfill and no cost**: grid, flexbox, custom properties, `:has()`,
  container queries, `color-mix()`, `accent-color`, `prefers-color-scheme`,
  `@media (hover: hover)`, logical properties, `clamp()`, nesting.
- **Zero-JS interactive HTML**: `<details>/<summary>`, `<dialog>` (with `showModal()`, one
  line of JS), `<fieldset>/<legend>`, `<input type=color>`, `<input type=range>`,
  `<output>`, native validation (`required`, `pattern`, `maxlength`), `inputmode`,
  `autocomplete`, `<progress>`, `<meter>`.
- **`<svg>` inline in the static CSS/JS, or as a `data:` URI in it.** Free once it is in
  pool B.
- **A single `fetch()` at a time**, for save-without-reload. Serialise strictly.
- **`prefers-color-scheme` with both branches.** Costs a few hundred bytes in pool B.

### FORBIDDEN

- **No CDN, no external anything.** No `<script src="https://...">`, no Google Fonts, no
  external stylesheet, no remote image. The panel is on a LAN and has no internet guarantee;
  the operator's browser may be on a segment that cannot reach the internet at all. Anything
  not served by the device does not exist. (Note: ESPHome's own stock dashboard at `/`
  violates this - it is 174 bytes that `<script src>`s `https://oi.esphome.io/v2/www.js`.
  MEASURED. That is a known wart of the stock page, not a precedent to copy.)
- **No React, no Vue, no Svelte, no Angular.** Not primarily a size problem - see Q4 for why
  the real objection is the build step.
- **No Alpine, no htmx, no petite-vue either.** Sizes are survivable (7-19 KB gz); the
  objection is that this UI is two forms and a status readout.
- **No brotli.** ESPHome will emit `Content-Encoding: br` if you ask for it, and **Firefox
  refuses to decode `br` over plain HTTP**. This device is plain HTTP by D-17. gzip only.
- **No parallel `fetch()`.** More than 4 in flight and connection 6 waits ~1 s for a TCP SYN
  retransmit. MEASURED. One at a time.
- **No polling faster than every 2 s**, and prefer no polling at all.
- **No SSE / EventSource / WebSocket from these pages.** Each one permanently occupies one of
  only ~5 connection slots, and the operator may already have ESPHome's dashboard open in
  another tab holding one.
- **No unbounded lists.** Anything that scales with the pulled table must respect
  `MAX_ROWS_RENDERED` and must say so when it truncates.
- **No web fonts.** `system-ui` stack only. A woff2 is 15-30 KB of pool B for nothing.
- **No `<input type=color>` as the only colour control.** It cannot represent "blank".
  See the trap in Q5.
- **No new inline `<style>` or `<script>` blocks in the generated HTML.** Every byte there is
  paid on every request, out of the scarce pool.
- **No status code other than 200/204/400/401/404/409/422.** Anything else is silently
  rewritten to 500 by the shim. Already documented at `onair_page.h:648`; still true, verified
  at `web_server_idf.cpp:335-364`.

---

## Q1. Transport and response model

**There is no chunked-response API in this build.** Read
`firmware/.venv/lib/python3.13/site-packages/esphome/components/web_server_idf/web_server_idf.h`.
On ESP32 with `framework: esp-idf`, `web_server_base.h:10` includes
`web_server_idf/web_server_idf.h` - ESPAsyncWebServer is only reached through the `#else`
branch at `web_server_base.h:8-13`. The complete response surface an `AsyncWebHandler` can
reach:

| API | Line | What it does |
|---|---|---|
| `request->send(int, const char*, const char*)` | `web_server_idf.h:140` | `httpd_resp_send` with `HTTPD_RESP_USE_STRLEN`. No copy. **This is what `onair_page.h` uses.** |
| `beginResponse(code, type)` | `:149` | empty body |
| `beginResponse(code, type, const std::string&)` | `:155` | **copies** the string into the response object |
| `beginResponse(code, type, const uint8_t*, size_t)` | `:161` | `AsyncWebServerResponseProgmem` - **points at flash, copies nothing** |
| `beginResponseStream(type)` | `:168` | `AsyncResponseStream` |
| `response->addHeader(name, value)` | `:50` | `httpd_resp_set_hdr` (`web_server_idf.cpp:664`) |

Specifically checked and **absent**: `beginChunkedResponse`, `beginResponse_P` (ESP8266-only,
see `web_server.cpp:436`), any `AsyncWebServerResponse` subclass with a fill-callback, any
`httpd_resp_send_chunk` wrapper.

`AsyncResponseStream` looks like streaming and is not. `web_server_idf.h:79-94`: it is a
`std::string content_` with `print()`/`printf()` appending to it, flushed in one
`httpd_resp_send` at `:137`. **Using it instead of building a string yourself buys nothing
and costs one extra heap copy.** Do not switch to it thinking it streams.

ESP-IDF's own `httpd_resp_send_chunk()` exists and is reachable - `AsyncWebServerRequest` has
`operator httpd_req_t*()` at `:188`, so a handler could bypass the shim entirely and chunk by
hand. That is a real option if a future page must exceed the pool-A budget, but it is new
unsupported territory (chunked encoding, no `Content-Length`, manual termination with a
zero-length chunk) and it is not needed if assets move to flash. Flagged, not recommended.

**Other transport facts that constrain design:**

- Status codes are mapped through a `switch` at `web_server_idf.cpp:335-364`. Only
  200/204/400/401/404/409/422 survive; `default: status = HTTPD_500`. No 202, no 303, no 304.
- `httpd_resp_set_hdr` **stores the pointer, it does not copy** ([ESP-IDF docs](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/protocols/esp_http_server.html):
  "Make sure that the lifetime of the field value strings are valid till send function is
  called"). Any header you add must be a string literal or otherwise outlive the send. A
  `std::string` local passed as `.c_str()` is a use-after-free.
- `max_resp_headers = 8`. `init_response_` already spends Content-Type, Accept-Ranges and
  `Access-Control-Allow-Origin` (added at `web_server_base.h`, in `init()`). ~5 slots free.
- **Every response carries `Access-Control-Allow-Origin: *`.** MEASURED. `/onair` is open, so
  any web page the operator visits can read the panel's status cross-origin. Not a new
  finding and not in scope here, but do not put anything on `/onair` you would not publish.
  `/onair/config` is unaffected: no `Access-Control-Allow-Credentials`, so a cross-origin read
  of the authenticated page still fails.
- **No `Content-Security-Policy` header is set.** MEASURED. So inline `<style>`, inline
  `<script>` and `new Function()` all work. This is not permission to use them - it just means
  CSP is not the reason to avoid them.

---

## Q2. Memory envelope

### Confirming the existing comment

`onair_page.h:444-452` reasons: ~800 bytes of markup per row, a table near the pull's 8 kB
ceiling is ~60-80 rows, an unbounded page reaches ~50 kB, a geometric realloc then needs
~96 kB contiguous, and a failed allocation is `abort()`.

**The reasoning is correct and the numbers are close.** Corrections from measurement:

- Per row is **738 bytes**, not ~800. MEASURED: five row forms on the live config page at
  739 / 730 / 751 / 739 / 733 bytes. The `900` in the `reserve()` call is therefore a
  ~22% safety margin, which is the right side to err on.
- Fixed chrome is **3,148 bytes**, so the `3000` in the same call is very slightly under. The
  900-per-row margin covers it (24 x 162 = 3,888 bytes of slack). Not a bug, worth knowing.
- Worst case rendered page: 3,148 + 24 x 738 = **~20.9 KB**, against a **~24.7 KB** reserve.

The `abort()` claim is the important one and it holds: ESP-IDF sets `-fno-exceptions`, so
`std::string::reserve` failing calls `std::__throw_length_error` -> `abort()`. On a device
whose job is driving a light during a call, that is a reboot at the worst possible moment.

### What is actually available

MEASURED lower bound: the live device serves `/onair/config` today, which means it
**successfully allocates ~24.7 KB contiguous** while WiFi, lwIP, the httpd task, the SSE
machinery, the 8 kB config-pull buffer and the SH1106 framebuffer are all resident. So
`largest_free_block >= 24.7 KB` under normal load. That is a floor, not a ceiling - I could
not measure the actual figure without adding the `debug:` component and reflashing (see Open
uncertainties).

The esp32dev has ~320 KB DRAM total and no PSRAM. After ESP-IDF + WiFi + lwIP, free heap on a
loaded ESPHome node is typically in the low-100s of KB, but **total free heap is the wrong
number**: [ESP-IDF's own guidance](https://docs.espressif.com/projects/esp-idf/en/latest/esp32/api-reference/system/mem_alloc.html)
is that "because of heap fragmentation it is probably not possible to allocate a single block
of memory equal to the total free size", and directs you to
`heap_caps_get_largest_free_block()`. This device fragments continuously: every config pull
allocates and frees an 8 kB buffer (`elegoo-esp32.yaml:362`), every page render allocates and
frees a ~25 kB string, and the SSE deferred queue churns. The largest free block on an ESP32
in this shape is routinely well under half the total free heap and shrinks with uptime.

**Budget:** the safe number is the one the device already survives. **24 KB peak for a
dynamic page**, which is where `MAX_ROWS_RENDERED` already puts it. Do not raise it. If a
redesign needs more markup per row, lower `MAX_ROWS_RENDERED` to keep the product under
~24 KB.

Two further constraints on handler code, not on markup:

- **The httpd task stack is 4,352 bytes** (`HTTPD_DEFAULT_CONFIG()` gives 4096,
  `web_server_idf.cpp:144` adds 256). No large stack buffers in a handler. The existing
  `char buf[64]` pattern is right.
- `request->send(200, type, body.c_str())` does **not** copy the body. Switching to
  `beginResponse(code, type, body)` would double peak heap, because
  `AsyncWebServerResponseContent` copies (`web_server_idf.h:69-70`). Keep the current call.

---

## Q3. Serving static assets from flash - yes, and this is the answer

**Mechanism, verified in source.** `AsyncWebServerResponseProgmem` (`web_server_idf.h:96-107`)
holds a `const uint8_t*` and a size and hands them straight to `httpd_resp_send`. Nothing is
copied into heap. ESPHome uses it for its own dashboard at `web_server.cpp:432-444`:

```cpp
AsyncWebServerResponse *response = request->beginResponse(200, "text/html", INDEX_GZ, sizeof(INDEX_GZ));
response->addHeader(ESPHOME_F("Content-Encoding"), ESPHOME_F("gzip"));
request->send(response);
```

and for user assets at `web_server.cpp:520-546` (`/0.css`, `/0.js`), same three lines.

So a handler registered by `install_pages()` can do:

```cpp
class Asset : public AsyncWebHandler {
  bool canHandle(AsyncWebServerRequest *r) const override {
    char b[AsyncWebServerRequest::URL_BUF_SIZE];
    return r->url_to(b) == "/onair.css";
  }
  void handleRequest(AsyncWebServerRequest *r) override {
    auto *res = r->beginResponse(200, "text/css", ONAIR_CSS_GZ, sizeof(ONAIR_CSS_GZ));
    res->addHeader("Content-Encoding", "gzip");                       // string literals:
    res->addHeader("Cache-Control", "public, max-age=31536000, immutable");  // set_hdr does not copy
    r->send(res);
  }
};
// registered next to the status page, which is open:
base->add_handler_without_auth(&css_handler);
```

`add_handler_without_auth` is required, not optional: `/onair` is an open page, so a
stylesheet behind basic auth would either 401 or raise a credential prompt for a subresource
on a page that is supposed to need none.

**Do not use ESPHome's built-in `css_include:` / `js_include:` for this.** They do work -
`web_server/__init__.py:425-434` reads the file at build time and `add_resource_as_progmem`
(`:354-366`) gzips it and emits `constexpr uint8_t ESPHOME_WEBSERVER_CSS_INCLUDE[...] PROGMEM`.
But the handler lives on the `WebServer` component, which is registered with
`this->base_->add_handler(this)` at `web_server.cpp:388` - **with** auth. So `/0.css` and
`/0.js` are authenticated and unusable from the open `/onair`. (Also confirmed empirically:
`GET /0.css` on the live device returns an empty reply, because the option is not configured.)

**Producing the blob.** `add_resource_as_progmem` is a 12-line function; the same thing as a
committed generated header is:

```
python3 -c "import gzip,sys;d=gzip.compress(open(sys.argv[1],'rb').read(),9); \
  print('constexpr uint8_t ONAIR_CSS_GZ[%d] PROGMEM = {%s};'%(len(d),','.join(map(str,d))))" \
  onair.css > onair_assets.h
```

`includes:` in `elegoo-esp32.yaml:17-19` copies headers verbatim, so a generated
`onair_assets.h` alongside `onair_table.h` is all it takes. The generator should be wired into
`npm run verify` so the header cannot drift from its source.

**No runtime compression.** MEASURED: `GET /onair` with `Accept-Encoding: gzip, deflate, br`
returns the same 2,655 uncompressed bytes and no `Content-Encoding` header. There is no
deflate in the shim and nothing negotiates. Compression is a **build-time** property of a
flash blob only. Dynamic HTML is always sent raw, which is exactly why pool A is scarce and
pool B is not.

**gzip, not brotli.** ESPHome offers `compression: br` (`web_server/__init__.py:286`) and it
is smaller (measured on the ESPHome v3 blob: 67,966 br vs 77,827 gz). It is unusable here:
Firefox does not decode `Content-Encoding: br` over plain HTTP and does not advertise it
([Mozilla bug 1241655](https://bugzilla.mozilla.org/show_bug.cgi?id=1241655),
[Chromium intent](https://groups.google.com/a/chromium.org/g/blink-dev/c/JufzX024oy0/m/LWEC-FJ7AwAJ)) -
both browsers restricted `br` to secure origins deliberately. Chrome tolerates an unrequested
`br` body; Firefox shows garbage. D-17 pins this transport to plain HTTP. **gzip only.**

---

## Q4. JavaScript: what is realistic

All sizes MEASURED by downloading the real published bundle and running `gzip -9` /
`brotli -q 11` on 2026-08-26.

| Library | minified | gzip | brotli |
|---|---|---|---|
| react 18 | 10,751 | 4,278 | 3,763 |
| react-dom 18 | 131,835 | **42,903** | 37,180 |
| vue 3 runtime (global prod) | 107,671 | **40,701** | 36,506 |
| alpine.js 3 | 54,447 | 19,436 | 17,601 |
| htmx 2 | 51,238 | 16,589 | 14,996 |
| petite-vue 0.4.1 | 16,901 | 7,079 | 6,513 |
| preact 10 | 11,322 | 4,841 | 4,402 |
| preact hooks | 3,800 | 1,600 | 1,443 |

**Can React/Vue/Svelte run? Technically yes; do not.** React + ReactDOM is 47 KB gz and Vue 3
runtime is 41 KB gz. Both would *fit* in flash - they are smaller than WLED's UI. The
disqualifying problems are not bytes:

- **No CDN.** Every byte must be embedded in the firmware image and served by the device. That
  means the framework is now part of the flash budget and part of the OTA image, and every
  version bump is a reflash of the panel that is driving the light.
- **A build step this repo does not have.** `firmware/` is ESPHome under `uv`; `npm run verify`
  runs `esphome config`, which does not even compile the C++ headers. JSX or SFCs would add a
  bundler, a `node_modules`, and a second source of truth for the page, all to render two
  forms. Svelte is worse: it is a compiler, so there is no no-build path at all.
- **The page is server-rendered already.** `config_page()` produces the exact markup. A
  framework would mean either re-rendering the same thing client-side from a new JSON endpoint
  (a second representation of the row model, which is the bug factory D-42 just finished
  removing from the state payload) or hydrating server HTML, which is the most complex option
  of the three.

**Small libraries.** petite-vue at 7.1 KB gz is the only one that is nearly free, and alpine
(19.4 KB) / htmx (16.6 KB) are affordable in pool B. They are still the wrong call: alpine and
petite-vue put behaviour in HTML attributes, so the firmware's C++ string-building code becomes
the place where a reactive template lives - harder to read than either plain HTML or plain JS.
htmx's model (server returns HTML fragments) is a genuine fit for the three-outcome `submit()`
banner, but it wants status codes and `HX-*` headers, and this shim rewrites everything outside
200/204/400/401/404/409/422 to 500. Not worth 16.6 KB.

**What ~2-8 KB of hand-written vanilla JS buys**, all comfortably inside 8 KB raw / ~2.5 KB gz:

- **Live colour preview.** Pair each `#rrggbb` text input with `<input type=color>`, sync both
  ways, paint a swatch. ~25 lines.
- **Client-side luminance readout - the highest-value item on this list.** The panel is 1-bit;
  `luminance(bgcolor) >= 128` picks the heavy double frame over the open ring
  (`onair_table.h:291-294`, applied at `:610`). Today `config_page()` explains this in a
  paragraph of prose (`onair_page.h:418-420`). JS can just *show* it. The formula to mirror,
  exactly:
  ```js
  const lum = (r,g,b) => Math.floor((299*r + 587*g + 114*b) / 1000);  // >= 128 -> CALM HEAVY
  ```
  Integer division, `Math.floor`, and the same 299/587/114 weights - any drift here makes the
  preview lie.
- **Dirty-field tracking.** Enable Save only when something changed; mark which fields differ
  from the server default. ~20 lines.
- **Collapse/expand: zero JS.** `<details>/<summary>` per row.
- **Save without a reload.** One `fetch()` POST of the form, read the returned status
  (200 = applied, 400 = failed) and render the banner in place. Must be strictly serialised -
  see Q6. Note the existing `origin_is_ours()` CSRF check (`onair_page.h:519-533`) passes for a
  same-origin `fetch()`: the browser sends `Origin` naming the device, and the comparison is
  against `Host`. A `fetch()` from the page works; one from anywhere else does not. Nothing to
  change.
- **`prefers-reduced-motion` guard**, if anything animates.

---

## Q5. HTML/CSS features that are free

Audience is a current desktop/mobile browser on the LAN. All of the following are Baseline
"widely available" and need no polyfill and no fallback:

| Feature | Free? | Note |
|---|---|---|
| CSS grid, flexbox | yes | already used - `dl{display:grid}` at `onair_page.h:186` |
| CSS custom properties | yes | worth adopting; a token block is ~300 B in pool B and removes every repeated hex literal |
| `:has()` | yes | Baseline since Firefox 121, Dec 2023 |
| container queries | yes | Baseline since Firefox 110, Feb 2023. Cheap, but for a `max-width:44rem` single column a media query is smaller |
| `<details>/<summary>` | yes | zero JS. `::details-content` and `name=` (accordion) are newer - check before relying |
| `<dialog>` | yes | Baseline 2022. Needs one line of JS (`showModal()`); `::backdrop` is free |
| `<input type=color>` | yes | **see trap below** |
| `<input type=range>` | yes | styling the track/thumb cross-browser costs ~400-600 B of CSS. `accent-color` instead is ~20 B |
| `color-mix()` | yes | Baseline 2023. Very cheap way to derive hover/border tints from one token |
| `accent-color` | yes | Baseline 2022. One declaration themes every checkbox, radio and range |
| `prefers-color-scheme` | yes | today the page hardcodes `color-scheme:dark` (`:176`). A light branch costs ~400 B in pool B |
| `<fieldset>/<legend>` | yes | default border/padding reset is ~80 B |
| native validation (`required`, `pattern`, `maxlength`) | yes | already used - `pattern="#[0-9a-fA-F]{6}"` at `:366`. `:invalid`/`:user-invalid` styling is free |
| `inputmode`, `autocomplete`, `enterkeyhint` | yes | attributes only |
| `<output>`, `<progress>`, `<meter>` | yes | `<output>` is the right element for a luminance readout |
| logical properties, `clamp()`, `min()`/`max()`, CSS nesting | yes | nesting is Baseline since 2023 and shrinks the stylesheet |

Things that cost meaningful bytes and should be justified:

- Custom `<input type=range>` track styling: ~400-600 B for `-webkit-slider-*` +
  `-moz-range-*`. Use `accent-color` unless the design genuinely needs it.
- A full light+dark token set: ~400-700 B. Worth it in pool B, never in pool A.
- Any icon set. Inline the two or three SVG paths you actually need.

### The `<input type=color>` trap

**`<input type=color>` cannot represent "blank", and blank is load-bearing here.** The overlay
model is: an empty field means *follow the server*, and the server's value is shown as the
placeholder (`colour_field`, `onair_page.h:358-372`; `handle_action` only sets `has_color` when
the trimmed value is non-empty, `:594-609`). A colour input always has a value - default
`#000000` - so wiring one straight to `name="color"` would silently post black as an override
on every save, for every row, forever. That is precisely the "silent fallback would store black
and look like a bug in the panel" failure that `parse_hex_color_strict` exists to prevent
(`:66-83`).

Any design using `<input type=color>` **must** pair it with an explicit "override / follow
server" control - a checkbox, a `<details>` disclosure, or a Clear button - and must not submit
the colour field when the control says "follow". This is the single most likely way a
good-looking redesign breaks the firmware's contract.

---

## Q6. The single-task hazard

**Handlers run on one httpd task.** `AsyncWebServer::begin()` (`web_server_idf.cpp:137-175`)
calls `httpd_start()` with `HTTPD_DEFAULT_CONFIG()`, modifying only `stack_size` (+256),
`server_port`, `uri_match_fn`, `lru_purge_enable = true` and `close_fn`. So the ESP-IDF
defaults stand ([esp_http_server.h:53-80](https://github.com/espressif/esp-idf/blob/release/v5.3/components/esp_http_server/include/esp_http_server.h)):

| field | value |
|---|---|
| `max_open_sockets` | 7 |
| `backlog_conn` | **5** |
| `stack_size` | 4096 (+256 = 4352) |
| `task_priority` | `tskIDLE_PRIORITY + 5` |
| `core_id` | `tskNO_AFFINITY` |
| `max_uri_handlers` | 8 |
| `max_resp_headers` | 8 |
| `recv_wait_timeout` / `send_wait_timeout` | 5 s / 5 s |
| `lru_purge_enable` | **true** (ESPHome overrides the `false` default) |

**MEASURED on the live device**, `curl` fan-out against `/onair`:

| in flight | result |
|---|---|
| 1 (x5 serial) | 39-45 ms each |
| 4 | all 4 in 74-78 ms |
| 8 | 5 in 74-93 ms, **3 at ~1.08 s** |
| 12 | 5 in 86-95 ms, 5 at ~1.05-1.11 s, 2 at ~2.05-2.09 s |

Exactly five connections clear per wave, and the overflow lands on ~1 s and ~2 s boundaries -
the TCP SYN retransmit schedule. `backlog_conn = 5` is the binding limit, not
`max_open_sockets = 7`. **So: 5 concurrent connections, and the 6th costs a full second.**

**What that means for the page:**

- **5 parallel `fetch()` calls is the exact edge of the cliff.** Five would work; the browser's
  own connection for a navigation or a favicon pushes you over. Budget **1 in flight, 4
  absolute maximum**, and serialise.
- Requests are also **serialised in service**, not just in accept: the 4-concurrent run took
  ~77 ms wall for what is ~40 ms serially, and the 8-concurrent run shows the same stepping.
  Parallelism buys you nothing even below the limit.
- **A POST to `/onair/config` blocks the entire web server for up to 2 seconds.** `submit()`
  (`onair_page.h:131-167`) hands the command to the main loop and spins
  `for (int i = 0; i < 200; i++) vTaskDelay(pdMS_TO_TICKS(10))`. During that window the device
  serves **no HTTP at all** - including the on-air server's `PresenceKey` write that drives the
  light. The file says so at `:127-130`. Any design that fires several saves at once (a
  "Save all rows" button, an autosave-on-change field) multiplies that: 5 rows x 2 s = 10 s of
  a dead web server. **Do not build save-on-change. Do not build save-all.**
- `lru_purge_enable = true` means socket exhaustion closes the *oldest* connection rather than
  erroring. A long-lived SSE stream is therefore not just a wasted slot, it is a slot that gets
  killed under load and reconnects, costing another.
- Handler stack is 4,352 bytes. Deep recursion or big locals will overflow it silently.

---

## Q7. Existing precedent

**ESPHome's own dashboard.** Two modes, both in this install:

- Default (what this device runs, `web_server: version: 2` with no `local:`): the device serves
  **174 bytes** of HTML that `<script src>`s `https://oi.esphome.io/v2/www.js`. MEASURED body:
  ```html
  <!DOCTYPE html><html><head><meta charset=UTF-8><link rel=icon href=data:></head><body><esp-app></esp-app><script src="https://oi.esphome.io/v2/www.js"></script></body></html>
  ```
  That bundle is **37,259 bytes raw / 12,653 gz** (v2) and **77,692 / 25,922** (v3). MEASURED
  by fetching them. It is a Lit/web-components app and **it does not work without internet**.
- `local: true`: the whole app is embedded as a PROGMEM blob. Counted in the installed source:
  `server_index_v2.h` holds **24,714 bytes** of gzipped `INDEX_GZ`; `server_index_v3.h` holds
  **77,827 gz** or **67,966 br** (both arrays present, one compiled in). Served by the exact
  three-line pattern in Q3.

So ESPHome's own answer to "how do I ship a UI from an ESP32" is: **one gzipped blob in flash,
served with `Content-Encoding`.** Not chunked, not templated, not streamed.

**WLED.** The UI is a `wled00/data/` directory of plain `.htm`/`.css`/`.js`, gzipped by
`npm run build` into `wled00/html_*.h` PROGMEM arrays (build artifacts, not committed -
[WLED wiki](https://github.com/wled/WLED/wiki/Add-own-functionality)). MEASURED by fetching
`wled00/data/` from `main` and gzipping:

| file | raw | gz |
|---|---|---|
| index.htm | 19,396 | 4,930 |
| index.css | 31,275 | 10,320 |
| index.js | 120,784 | 37,620 |
| common.js | 14,962 | 6,312 |
| iro.js (colour picker) | 28,248 | 9,986 |
| **total** | **214,665** | **69,168** |

215 KB of source, 69 KB in flash. **Zero frameworks.** `index.js` is 121 KB of hand-written
vanilla JS; the only library is `iro.js`, a standalone colour picker with no framework
dependency. A [2020 issue](https://github.com/wled/WLED/issues/1127) proposing webpack found it
saved 1,476 bytes of the final array and concluded the win was smaller still after gzip.

**Tasmota.** Same conclusion, stated as policy:
"[the web files (.css, .js, *.html) currently require less than 30 kB, with the browser bearing
the main load](https://github.com/arendst/Tasmota/discussions/22851)", and the driving concern
is flash size on 1 MB ESP8266 parts. Vanilla, no framework, SPA that pulls values via commands
after load.

**The consistent conclusion across all three:** put the UI in flash, gzip it at build time,
cache it hard, write it by hand, and keep the device's dynamic output small. That is exactly
the two-pool budget at the top of this document.

---

## Open uncertainties

1. **Actual free heap and largest free block on this device.** Not measured. I have a hard
   floor of **>= 24.7 KB contiguous** (the config page's `reserve()` succeeds on hardware) and
   no ceiling. Getting the real number needs the `debug:` component and a reflash:
   ```yaml
   debug:
     update_interval: 30s
   sensor:
     - platform: debug
       free: {name: "Heap Free"}
       block: {name: "Heap Largest Block"}
       fragmentation: {name: "Heap Fragmentation"}
   ```
   then `curl -u rocket:ESP32 http://10.42.12.77/sensor/Heap%20Largest%20Block`. Worth doing
   once if any variation wants to argue for a bigger pool A. Until then the 24 KB budget is the
   number the device is already proven to survive, and I would not exceed it on an estimate.
2. **Flash headroom for pool B.** Not measured. `npm run firmware:compile` prints
   `Flash: [=== ] NN.N% (used X bytes from Y bytes)` and takes a few minutes. An ESPHome
   esp-idf build with WiFi, web_server, http_request, json and a display is typically
   1.0-1.4 MB against a ~1.9 MB OTA app slot, so 32 KB of gzipped assets should be
   comfortable - but "should be" is an estimate, and adding assets also grows every OTA
   transfer. Confirm before committing to the upper end of the pool-B budget.
3. **Hand-rolled `httpd_resp_send_chunk()` through `operator httpd_req_t*()`.** Reachable in
   principle (`web_server_idf.h:188`), never tried in this codebase, and it bypasses
   `init_response_` so the status/header/DefaultHeaders path would have to be reimplemented.
   Only relevant if a future page must exceed 24 KB of *dynamic* markup; moving assets to
   flash should make that unnecessary.
4. **Whether the generated-asset header should be committed or built.** `includes:` copies
   files verbatim, so a committed `onair_assets.h` works today. A build step wired into
   `npm run verify` would prevent drift between `onair.css` and its generated blob. Not
   researched further - it is an implementation decision, not a constraint.
5. **`<details name=...>` accordion grouping and `::details-content`.** Newer than the rest of
   the Q5 table; I did not verify their Baseline status. Plain `<details>` is unquestionably
   safe. Check before relying on the accordion behaviour specifically.
6. **Behaviour when the ESPHome dashboard's SSE stream is open.** I measured concurrency with
   no browser attached. With `/` open in a tab, `/events` holds one socket permanently, so the
   effective limit is 4, not 5. Not re-measured with a live SSE client.
