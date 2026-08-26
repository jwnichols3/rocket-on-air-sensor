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

The first line is the menu bar title. `NO DATA` in amber is the normal resting state when
nothing has written state recently: THE BUSY RULE (D-32) refuses to claim a calm state on
stale evidence, and the menu bar is a renderer like any other (D-63), so it says the same
thing the ESP32 glass says.
