# The menu bar plugin

`onair.5s.sh` is an ordinary script that prints text. SwiftBar runs it every 5 seconds and
draws stdout. #18, D-26, D-63.

## Setting it up, entirely from the command line

No GUI click is needed. Verified on macOS with SwiftBar from Homebrew:

```sh
ln -s "$PWD/deploy/swiftbar/onair.5s.sh" ~/SwiftBarPlugins/onair.5s.sh
defaults write com.ameba.SwiftBar PluginDirectory -string "$HOME/SwiftBarPlugins"
defaults write com.ameba.SwiftBar MakePluginExecutable -bool true
open -b com.ameba.SwiftBar
open -g "swiftbar://refreshallplugins"      # -g so it does not steal focus
```

### Why this works, and why it might not have

**`PluginDirectory` is a plain path string, not a security-scoped bookmark.** That is the
only reason `defaults write` is sufficient, and it is not a safe assumption for a Mac app in
general - a sandboxed app would need a bookmark that only a real file picker can mint.
SwiftBar's Homebrew build is **not sandboxed** (`codesign -d --entitlements -` shows no
`com.apple.security.app-sandbox`), and its `PreferencesStore.swift` declares
`pluginDirectoryPath` as a plain `String?`.

**There is no first-run-wizard suppression key, and none is needed.** The folder picker only
appears when `PluginDirectory` is unset, so writing it *before* the first launch is what
suppresses it.

**Choose `~/SwiftBarPlugins`, not `~/Documents`.** Pointing SwiftBar at `~/Documents`
triggers a TCC privacy prompt - that is TCC, not sandboxing, and it is why the first attempt
at this needed a click. `~/SwiftBarPlugins` is not TCC-protected.

### Proving it actually loaded the plugin, rather than merely starting

Three independent signals, strongest last:

```sh
defaults read com.ameba.SwiftBar | grep NSStatusItem   # SwiftBar writes one per plugin,
                                                       # against the RESOLVED symlink target
ps -o pid,ppid,command | grep onair.5s.sh              # SwiftBar's pid is the parent
```

and the rendered menu bar title read live over the Accessibility API, which should equal the
plugin's own first line (`bash deploy/swiftbar/onair.5s.sh | head -1`).

## Launch at login is the one thing the CLI cannot do

`defaults write` cannot set it. SwiftBar uses the `LaunchAtLogin` package over
**SMAppService**, and SMAppService registration must be performed by the app's own process -
the binary links `ServiceManagement.framework` and carries `LaunchAtLogin__hasMigrated`.

**SwiftBar menu -> Preferences -> General -> "Launch at login".** One click.

A `~/Library/LaunchAgents/com.ameba.SwiftBar.plist` with `RunAtLoad` would also work and is
fully scriptable, and is **deliberately not what this repo does**: it is a second mechanism
sitting alongside SwiftBar's own toggle, and the two can disagree. It is also a persistent
system-level configuration change, which belongs to the machine's owner rather than to a
setup script.

## The `swiftbar://` URL scheme

Confirmed on the installed build (`plutil -extract CFBundleURLTypes` on its Info.plist gives
`CFBundleURLSchemes: ["swiftbar"]`). Hosts, from the project README:

| Host | Parameters |
|---|---|
| `refreshallplugins` | - |
| `refreshplugin` | `name` / `plugin` / `index` |
| `enableplugin`, `disableplugin`, `toggleplugin` | `name` |
| `addplugin` | `src` |
| `notify` | `name`, `title`, `subtitle`, `body`, `href`, `silent` |
| `setephemeralplugin` | `name`, `content`, `exitafter` |

The plugin id is the **file name**. Use `open -g` so refreshing does not steal focus.

`swiftbar://refreshplugin?name=onair.5s.sh` is the way to push an immediate update rather
than waiting out the 5 second cycle - useful after a state write if something ever wants the
menu bar to react instantly.

## What the plugin shows

**The menu bar carries a drawn ON AIR sign, not words** (D-76, #51). It is 32x11 points - a
64x22 PNG whose `pHYs` chunk declares 144 DPI, so AppKit reads it as a 2x representation at
half the point size. The script draws it from scratch every run; a PNG is a zlib stream in
four length-prefixed chunks and the encoder is twenty lines of stdlib.

| Picture | Means |
|---|---|
| **Lit**, in a row's own `color` on its own `bgcolor` | that row is the current state |
| **Unlit**, grey outline | `NO DATA` - unknown, or evidence too old to support a calm claim |
| **Unlit**, amber outline | the on-air service is not answering |

The colours are **the operator's own**, read from `GET /config/states` and matched to the
row by id (D-77). Change a row's colours in the admin console and the menu bar follows; there
is no second palette to drift from the first.

**Unlit is reserved for "not a state".** That is THE BUSY RULE (D-32) expressed as a picture,
and it is stronger than a coloured marker would be: an outline cannot be read as any
configured state, whatever colours the operator picked for it. The unlit sign is the normal
resting state when nothing has written state recently. The menu bar is a renderer like any
other (D-63), so it says the same thing the ESP32 glass says.

**There is no hover text on the menu bar, and there cannot be.** SwiftBar assigns `tooltip`
to `NSMenuItem` - dropdown rows - and never to the status item's button; `button?.toolTip`
does not appear in `MenuBarItem.swift`. The state in words is the **first row of the
dropdown** instead, one click away, coloured to match the sign.

## Where to change or test the state

| Page | URL | What it is |
|---|---|---|
| Admin console | `http://127.0.0.1:8484/` | Set the state, edit the row table and its colours |
| Public display | `http://127.0.0.1:8484/display` | A dumb full-screen tally. Point a kiosk at it |
| Panel status | `http://<light>/onair` | What the ESP32 itself believes, open |
| Panel settings | `http://<light>/onair/config` | The device's own table editor, behind device basic auth (D-57) |

Every one of them is in the plugin's dropdown, so the menu bar is the way in. The service
binds all interfaces by default, so the two console URLs also answer on the Mac's LAN
address - loopback is only waived from the passphrase (D-24); from any other host the
passphrase is required.
