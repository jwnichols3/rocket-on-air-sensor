# Web UI (`/ui`) Design - control panel + API console

Approved by Rocket 2026-08-06 ("make it so"). Dark-theme local web UI served by the
on-air API that both drives the system and exercises every endpoint.

## Serving

- `GET /ui` on the existing service; one self-contained HTML page (inline CSS/JS, no
  external resources, no build step) exported as `UI_HTML` from `src/ui.ts` - the
  exact pattern of `src/display.ts`.
- Auth: `?token=` accepted on the GET like the other read endpoints. The page itself
  holds a token (localStorage) used as `Authorization: Bearer` on writes and appended
  `?token=` on the SSE stream.
- Zero production dependencies (repo standard, D-11 territory).

## Layout (single scrolling column, ~720px max width, sticky header)

1. **Header**: `on-air` wordmark; live state pill (red "ON AIR" / dim "OFF AIR");
   SSE connection dot (green live / amber reconnecting); `age Ns` ticking client-side;
   token input (collapsed/unobtrusive when unset), persisted to localStorage.
2. **Controls card**: two large buttons, ON (red) and OFF (neutral). Writes send
   `?source=webui`. Button pressed-state follows the SSE stream, not the click - the
   UI shows what the server confirmed, never optimistic state.
3. **Message card**: text input (maxlength 200 + live counter), Set and Clear
   buttons, current message rendered.
4. **Live events card**: newest-first feed of SSE `status` events - local time,
   intended, source, message - capped at 100 rows (oldest dropped).
5. **API console card**: one row per endpoint: `GET /status`, `PUT /state`
   (editable JSON textarea prefilled with `{"onAir": true, "source": "webui"}`),
   `POST /on`, `POST /off`, `PUT /message` (uses the JSON textarea pattern,
   prefilled `{"text": "BE QUIET"}`), `DELETE /message`. Each row: Send button,
   response pane (HTTP status color-coded - 2xx green, 4xx amber, network error
   red - plus pretty-printed JSON body), and a copy-as-curl button producing a
   paste-ready curl command (including the bearer header when a token is set).

## Behavior rules

- One `EventSource` drives the pill, status fields, and event feed; same 45s
  silence watchdog + reconnect as `/display`; DISCONNECTED banner across the top
  while unhealthy.
- Errors are shown, never swallowed: failed console requests render the actual
  status/body or the network error text in that row's response pane.
- The page holds no server state; render is a function of the last SSE payload +
  per-row response data.

## Visual character (dark theme)

- Near-black background, elevated card surfaces, one red accent reserved for
  ON-AIR/danger semantics (matches `/display`), muted neutrals elsewhere,
  monospace for JSON/curl, generous spacing, visible focus states. No external
  fonts or icons - system stack.

## Implementation shape

- `src/ui.ts`: exported `UI_HTML` template string (the whole page).
- `src/server.ts`: `'/ui': ['GET']` in ROUTES + a serve branch identical in shape
  to `/display`.
- `docs/api-contract.md`: one short `GET /ui` entry.
- README: one line.

## Testing

- Suite: `/ui` returns 200 `text/html`, contains load-bearing markers (EventSource
  wiring, watchdog constant, all six console endpoints), token-gated like other GETs
  (`?token=` works, wrong token 401).
- Client JS is not executed by the suite: a live Chrome pass (click every control,
  exercise console rows incl. a 400, screenshot) happens before merge - the
  established pattern for this repo's pages.

## Out of scope

Multi-page navigation, detector/kiosk configuration, auth management, mobile-first
layout (it should merely not break on small screens).
