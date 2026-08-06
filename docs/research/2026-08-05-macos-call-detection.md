# macOS call-detection mechanisms for the on-air-light sensor

The Mac-side component is a pure sensor: it must answer "in a call: yes/no" and PUT that
to an existing REST API every ~60s, with all debouncing/state-machine/light-driving logic
living server-side. The Mac itself is a locked-down, MDM-enrolled corporate laptop of
unknown exact posture (admin rights, endpoint agent behavior, and profile restrictions are
not confirmed - see Questions for Rocket). The dominant scoring constraint is **false OFF
is worse than false ON**: a mechanism that can silently miss an active call (process
renamed, log predicate drifted across an OS update, TCC prompt silently denied) is worse
than one that is a little trigger-happy about turning the light on. Every recommendation
below is biased toward ORing together multiple over-eager signals rather than trusting one
precise-but-brittle signal.

## Comparison table

| Mechanism | Reliability (join/leave vs launch; app vs browser distinguishability) | IT/permissions footprint | False-OFF risk | Implementation effort |
|---|---|---|---|---|
| `pgrep`/regex for Zoom's `CptHost` helper | Two independent prior-art tools use it as a general "in a Zoom meeting" proxy (not just screen-share), but no Zoom-authoritative doc confirms scope on macOS. Zoom app only; can't see Meet. Reflects meeting-active, not mic/cam-live specifically. | None. `pgrep`/`ps` process-name enumeration needs no TCC, no admin, no prompt. | Medium - depends on unconfirmed scope of CptHost (see Uncertain); also breaks silently if Zoom renames the helper in a future release. | Trivial. ~5-10 lines shell/Python, `pgrep "CptHost"` on a poll loop. |
| `log stream` camera-active predicate (`AVFCapture` / `AVCaptureSession_Tundra startRunning`/`stopRunning`) | Fires for ANY process using the camera (Zoom, Meet-in-browser, FaceTime, Photo Booth...). Can't distinguish which app or whether it's actually a meeting vs. a webcam test. Good false-OFF profile because it's app-agnostic. | No TCC prompt observed in any prior-art usage (all run unprivileged, no sudo). Runs as a foreground pipe or LaunchAgent. | Low for "is *a* call live," because it's hardware-truth, not app-heuristic. But it will miss audio-only calls with camera off. | Small but version-fragile: prior art needed 3 different predicate strings for Monterey/Sonoma/Tahoe. ~20-30 lines shell, must be re-verified per macOS upgrade. |
| `log stream` mic-active predicate | Plausible by analogy (coreaudiod/TCC subsystem logs mic client activity) but **no confirmed working predicate string found in prior art** for mic specifically (only camera predicates were confirmed in working scripts). | Same profile as camera predicate if it exists - no TCC prompt for the observing process, per prior art. | Unconfirmed - can't score reliably without a verified predicate. | Unknown effort - flagged Uncertain, not ready to build on without further spike/testing on the actual Mac. |
| AppleScript/JXA active-tab-title read (Chrome/Safari) | Distinguishes Meet specifically (tab title contains "Meet"), but only tells you a Meet tab is open/frontmost, not that mic/cam are live or that you've actually joined vs. sitting on the pre-join screen. | Triggers a one-time-per-app-pair Automation ("X wants access to control Y") TCC prompt. MDM can pre-approve via a PPPC profile (must be signed with a Developer ID) or, per the PPPC mechanism, likely also deny/lock it - an MDM-managed Mac could have this silently blocked. | High if Automation is denied/blocked by policy - the script gets no error the user necessarily notices, and the "in a call" signal just never arrives (an obvious permanent false-OFF). | Small, ~10-20 lines AppleScript/JXA, but fragile to browser UI changes and to the TCC prompt being dismissed/denied once. |
| Browser extension reporting Meet state | Best distinguishability (extension runs inside the Meet tab, can detect "joined" vs. "idle" precisely via DOM/WebRTC state). | On a Chrome-managed Mac, arbitrary/sideloaded extensions are commonly blocked (`ExtensionInstallBlocklist: *` + an allowlist) unless IT force-installs it (`ExtensionInstallForcelist`, requires MDM enrollment) or explicitly allowlists it. Entirely IT-dependent; Rocket likely cannot self-install this. | High if IT never allowlists/force-installs it - permanently unavailable, a silent false-OFF for the whole Meet path. | Small extension code, but effort is mostly organizational (getting IT to push the policy), not code. |
| Mic-in-use attribution to browser's own process (via log stream) | Confirms "the browser is using the mic," not "it's specifically a Meet tab" (any WebRTC page, voice-typing, etc. would also trigger). Given false-ON is tolerable, this directional imprecision is acceptable. | Same as generic mic/camera log-stream signal above (unconfirmed predicate). | Low for "browser is on a call," but can't isolate Meet from other tabs (false-ON territory, which this project explicitly tolerates). | Same effort/fragility as the camera/mic log-stream mechanisms, plus you'd need to correlate the log line's process name to the browser - not confirmed that camera log lines reliably carry process attribution. |
| Zoom local web server (port 19421, `zoommtg://` handler) | N/A - **dead**. This was a real 2019 mechanism (CVE-2019-13567/CVE-2019-13450) but Apple's MRT and Zoom's own patches removed the local ZoomOpener web server entirely; it should not exist on any current Zoom install. | N/A | N/A - not usable | N/A - do not build on this |
| Zoom Apps SDK (`@zoom/appssdk`, `zoomSdk.onRunningContextChange`) | Only usable by JavaScript running *inside* a Zoom App panel embedded in the Zoom client itself (requires registering a Zoom Marketplace app, OAuth, and the user opening that app panel inside the meeting). Not usable by an external background script on the Mac. | Heavy - Zoom developer account, app review/installation, and an in-meeting user action to open the panel. | High - it's not "always on"; nothing reports state unless the panel is open. | Not viable for a thin-client sensor. Ruled out. |
| Zoom local status file under `~/Library/Application Support/zoom.us/` | Not found. Unlike Microsoft Teams (`storage.json` with an `"InCall"` state, confirmed via brunerd.com), no equivalent Zoom file was located in any prior-art source. | Unknown | Unknown | Not viable without further discovery - flagged Uncertain |
| CoreMediaIO (camera) + CoreAudio (mic) native APIs in a compiled app (à la Repose) | Same hardware-truth reliability profile as the log-stream approach, but reading live device state directly via API rather than parsing log text - likely more robust to OS log-format drift. | Not confirmed whether any TCC prompt appears for a third-party app calling these APIs purely to check "is device busy," as opposed to capturing audio/video itself. | Likely low, same as log-stream camera approach, but Uncertain on permission cost. | Larger - requires a compiled Swift/Obj-C macOS app (Xcode project), not a quick shell/Node script; this is what Repose does, several source files. |
| Reverse-engineered CoreAudio HAL property listener + IOKit registry + `sample` (à la OverSight) | Can, per objective-see's own description, attribute *which process* is using mic/camera - the most precise attribution found in this research. | Uses private/undocumented techniques (Mach message inspection, IO registry walk, invoking the `sample` utility) rather than a stable public API; permission requirements not confirmed from primary source. | Uncertain - contingent on undocumented internals continuing to work across macOS versions. | Large and fragile - this is a mature open-source security tool, not a quick script; not a good fit for a "minimum code" thin client. |

## Per-mechanism notes

### 1. macOS mic/camera-in-use signals via unified log

**Claim:** A working `log stream` predicate for detecting camera activation on modern macOS
is `composedMessage contains "AVFCapture"`, filtering further for lines containing
`AVCaptureSession_Tundra startRunning` (camera on) / `stopRunning` (camera off).
**Source:** https://raw.githubusercontent.com/akburg/elgatokeylight/main/autolights_sonoma.sh and .../autolights_tahoe.sh (live production shell scripts driving Elgato lights from this exact predicate) **Accessed:** 2026-08-05

**Claim:** The predicate had to change across macOS versions - Monterey (12.x) used
`subsystem == "com.apple.UVCExtension" and composedMessage contains "Post PowerLog"`
instead of the newer `AVFCapture` predicate.
**Source:** https://github.com/akburg/elgatokeylight (README, via WebFetch) **Accessed:** 2026-08-05

**Claim:** A separate independent project uses `subsystem == "com.apple.UVCFamily" && (eventMessage CONTAINS[c] "start stream" || eventMessage CONTAINS[c] "stop stream")` as a webcam on/off predicate, corroborating that camera state is visible via unified log but that the exact subsystem/predicate string is not stable across sources either.
**Source:** https://github.com/MaxSchaefer/macos-log-stream **Accessed:** 2026-08-05

**Claim:** Running `log show`/`log stream` for ordinary (non-`<private>`-redacted) log content does not require sudo/root; redaction of private data happens at write time, and elevated privileges do not reveal already-redacted data, nor are they needed to read normal public log lines. This is consistent with every prior-art script found in this research running `log stream` unprivileged in production (no `sudo` in any of the fetched scripts).
**Source:** https://medium.com/@boberito/private-data-in-unified-logging-10-15-9eb2b4be5c40 ; corroborated by the akburg/elgatokeylight and MaxSchaefer/macos-log-stream scripts themselves using no `sudo`. **Accessed:** 2026-08-05

**Claim:** No prior-art source confirmed a specific, currently-working `log stream` predicate for *microphone* activation (as distinct from camera). Only camera predicates were found in working scripts.
**Source:** absence across all searches performed 2026-08-05; flagged explicitly in Uncertain below.

**Claim:** No official Apple API exists for a third-party background process to learn "device X is currently in use by some other app" without either (a) parsing the unified log, or (b) using private/reverse-engineered CoreAudio HAL property-listener + IOKit techniques (as OverSight does) to get process-level attribution. `AVCaptureDevice.wasConnectedNotification` and related public notifications concern device connect/disconnect, not busy/in-use state by another process.
**Source:** https://developer.apple.com/documentation/avfoundation/avcapturedevice (reviewed via search, no `wasInUse`-style notification found) and https://github.com/objective-see/OverSight (README describes needing to enumerate Mach message senders / IO registry / the `sample` utility to attribute webcam access to a process, implying no simple public "who's using it" API exists) **Accessed:** 2026-08-05

**Claim:** macOS itself (Control Center, macOS 13.3+) has a UI that shows which app is currently using the mic/camera (the field under the orange/green dot), but this is a system UI feature, not confirmed to be exposed via a documented public API to third-party scripts.
**Source:** https://happymacadmin.wordpress.com/2022/02/22/orange-is-the-new-mac/ ; general Apple Support description at https://support.apple.com/en-euro/guide/mac-help/mchl50f94f8f/mac **Accessed:** 2026-08-05

### 2. Zoom's CptHost process

**Claim:** `pgrep "CptHost"` is used by a Mac-scripting how-to as the exact detection command for "a Zoom meeting is active," in a set of parallel per-app process checks (Webex: `WebexAppLauncher`, GoToMeeting: `GoTo Helper (Plugin)`, Teams: reading `storage.json` for `"InCall"`).
**Source:** https://www.brunerd.com/blog/2022/03/07/respecting-focus-and-meeting-status-in-your-mac-scripts-aka-dont-be-a-jerk/ **Accessed:** 2026-08-05

**Claim:** An independent, actively-published Python tool's source code uses the exact regex `^CptHost$` as its default process-name match, with the inline comment: "Does a process matching the CptHost zoom process and owned by me exist? that's a reliable proxy for 'I am in a meeting'."
**Source:** https://raw.githubusercontent.com/darrenpmeyer/pyzoomproc/main/pyzoomproc/__main__.py (fetched directly, exact code quoted above) **Accessed:** 2026-08-05

**Claim:** `CptHost.app` is a real helper bundled inside `zoom.us.app/Contents/Frameworks/` on macOS (alongside other host helpers `caphost.app`, `airhost.app`, `aomhost.app`); a macOS support article notes a case-sensitivity issue that can arise if the folder is renamed from `CptHost.app` to lowercase, confirming this is the actual on-disk name on macOS (not just a Windows artifact).
**Source:** search-engine synthesis of https://recorder.easeus.com/screen-recording-resource/zoom-screen-sharing-not-working-mac.html and related results **Accessed:** 2026-08-05 (not independently re-fetched in full; treat this specific claim as medium-confidence)

**Claim:** `pgrep`/`ps`-based process-name enumeration requires no special permission or TCC consent on macOS; SIP restricts things like reading another process's memory, not listing process names. This is not from a single authoritative doc but is strongly corroborated behaviorally: every prior-art script found (pyzoomproc via `psutil.process_iter`, brunerd's `pgrep`) runs this check unprivileged, with no permission-prompt handling code anywhere in them.
**Source:** https://raw.githubusercontent.com/darrenpmeyer/pyzoomproc/main/pyzoomproc/__init__.py ; https://www.brunerd.com/blog/2022/03/07/respecting-focus-and-meeting-status-in-your-mac-scripts-aka-dont-be-a-jerk/ **Accessed:** 2026-08-05

**Claim (uncertain, flagged):** Windows-focused generic software-info sites describe `CptHost.exe` specifically as the "Zoom Sharing Host," implying a screen-share-specific role, which would conflict with the "general meeting proxy" framing used by both macOS prior-art tools above. No Zoom-authoritative source was found that states CptHost's exact scope on macOS (every meeting vs. screen-share-only). See Uncertain section - this is the single highest-impact open question for false-OFF risk in this whole mechanism.
**Source:** https://www.file.net/process/cpthost.exe.html (low-trust, Windows-generic; included only to show the conflicting claim exists) **Accessed:** 2026-08-05

### 3. Google Meet in a browser

**Claim:** AppleScript/JXA `tell application "X" to ...` triggers a TCC Automation ("wants access to control") prompt whenever a process sends Apple Events to a different process; StandardAdditions-only scripts (no cross-app `tell`) don't trigger it. The prompt is shown once per source/target application pair, then remembered.
**Source:** https://scriptingosx.com/2020/09/avoiding-applescript-security-and-privacy-requests/ **Accessed:** 2026-08-05

**Claim:** Organizations can pre-approve (grant) this Automation permission at scale via a Privacy Preferences Policy Control (PPPC) configuration profile delivered through MDM, but only for tools signed with a valid Apple Developer ID. PPPC profiles in general are described as letting admins "allow or restrict" the covered permissions - implying an MDM could just as plausibly be configured to deny/lock Automation as to pre-approve it, though no source directly confirmed a deny-by-policy example for this specific service.
**Source:** https://scriptingosx.com/2020/09/avoiding-applescript-security-and-privacy-requests/ ; https://www.hexnode.com/mobile-device-management/help/how-to-configure-a-privacy-preferences-policy-control-profile-for-macos-devices/ **Accessed:** 2026-08-05

**Claim:** Chrome's `ExtensionInstallForcelist` policy silently force-installs extensions users can't remove, but on macOS requires the Mac to be MDM-managed. Separately, `ExtensionInstallBlocklist` set to `*` combined with `ExtensionInstallAllowlist` locks users into an admin-curated extension set - meaning on a locked-down managed Chrome, a self-authored Meet-detector extension likely cannot be side-loaded by Rocket without IT explicitly allowlisting or force-installing it.
**Source:** https://chromeenterprise.google/policies/extension-install-forcelist/ ; https://chromeenterprise.google/policies/extension-install-blocklist/ ; https://chromeenterprise.google/intl/en_au/policies/extension-install-allowlist/ **Accessed:** 2026-08-05

### 4. Zoom-side local signals

**Claim:** Zoom's macOS client formerly ran a hidden local web server on `localhost:19421` (the "ZoomOpener daemon") to handle `zoommtg://` join links without a browser confirmation dialog; this was the basis of CVE-2019-13567/CVE-2019-13450, allowed webcam activation without consent, and was removed both by an Apple silent-update (MRT) and by Zoom's own patches. It should not exist on any current Zoom install and should not be built on.
**Source:** https://medium.com/bugbountywriteup/zoom-zero-day-4-million-webcams-maybe-an-rce-just-get-them-to-visit-your-website-ac75c83f4ef5 ; https://www.howtogeek.com/427964/how-to-see-if-zoom-is-running-a-secret-web-server-on-your-mac-and-remove-it/ **Accessed:** 2026-08-05

**Claim:** The Zoom Apps SDK (`@zoom/appssdk`) exposes `zoomSdk.onRunningContextChange` / a running-context concept (`inMeeting` etc.), but this JS API only runs inside a Zoom App panel embedded in the Zoom client (requires Marketplace app registration/OAuth and the user opening the panel in-meeting). It is not usable as a background "is Rocket in a meeting" oracle from outside the Zoom client.
**Source:** https://github.com/zoom/appssdk ; https://appssdk.zoom.us/classes/ZoomSdk.ZoomSdk.html ; https://developers.zoom.us/docs/zoom-apps/ **Accessed:** 2026-08-05

**Claim:** No Zoom-equivalent of Microsoft Teams' `~/Library/Application Support/Microsoft/Teams/storage.json` (which contains a plain `"InCall"` state string, per prior art) was found for Zoom. No local status file under `~/Library/Application Support/zoom.us/` reflecting live meeting state was located in this research.
**Source:** negative result across all searches performed 2026-08-05; the Teams file itself is confirmed via https://www.brunerd.com/blog/2022/03/07/respecting-focus-and-meeting-status-in-your-mac-scripts-aka-dont-be-a-jerk/

## Prior Art Inventory

- **akburg/elgatokeylight** - https://github.com/akburg/elgatokeylight - Bash scripts (`autolights.sh`, `autolights_sonoma.sh`, `autolights_tahoe.sh`) that pipe `log stream --predicate 'composedMessage contains "AVFCapture"'` and grep for `AVCaptureSession_Tundra startRunning`/`stopRunning`, then `curl` an Elgato Key Light's local HTTP API on/off. Three separate script variants exist for different macOS versions because the predicate drifted. Runs unprivileged, no sudo, no TCC handling visible.
- **darrenpmeyer/pyzoomproc** - https://github.com/darrenpmeyer/pyzoomproc - Python (`psutil`), polls every 5s for a process matching regex `^CptHost$` owned by the current user; runs `--onair`/`--offair` scripts on transition; ships a LaunchAgent plist for auto-start at login. Source confirms the exact detection primitive and includes the author's own framing ("reliable proxy for 'I am in a meeting'").
- **brunerd (blog, not a repo)** - https://www.brunerd.com/blog/2022/03/07/respecting-focus-and-meeting-status-in-your-mac-scripts-aka-dont-be-a-jerk/ - Shell function library: `pgrep "CptHost"` for Zoom, `ps auxww | grep "[(]WebexAppLauncher)"` for Webex, `pgrep "GoTo Helper (Plugin)"` for GoToMeeting, and parsing `~/Library/Application Support/Microsoft/Teams/storage.json` for `"InCall"` for Teams. Also documents Focus/DND detection (`~/Library/DoNotDisturb/DB/Assertions.json` on macOS 12+) and presentation-mode detection (`pmset -g assertions`).
- **objective-see/OverSight** - https://github.com/objective-see/OverSight - Signed macOS menu-bar app; monitors mic and webcam activation system-wide and attempts to attribute webcam access to a specific process using low-level techniques (Mach message senders, IO registry inspection, the `sample` utility) rather than a stable public "who's using the camera" API. Some users have scripted it to drive an on-air light (per search results), but exact scripting hook/permission requirements were not confirmed from the README alone.
- **fikrikarim/repose** - https://github.com/fikrikarim/repose - Native Swift macOS menu-bar break-reminder app; explicitly states it "checks the hardware directly. It uses CoreMediaIO to detect active cameras and CoreAudio for microphones," and that this works uniformly across Zoom/Meet/FaceTime/Teams/Slack huddles without app-specific logic. Good evidence that hardware-level camera/mic-busy detection is viable and app-agnostic, though it's a compiled app, not a quick script.
- **jkeefe/wfh-on-air-light** - https://github.com/jkeefe/wfh-on-air-light - Node.js project polling the third-party `node-camera-is-on` npm module every 5s to detect camera state, driving a Circuit Playground Express light. README does not disclose the module's internal mechanism (likely wraps a `log stream`-style check, not independently verified here).
- **sservaes/meetink** - https://github.com/sservaes/meetink - Local meeting transcriber; its `/watch` auto-record feature polls Calendar.app plus a "tightened browser URL regex" for conferencing-app detection and stops "within ~10s of the conferencing app going away." Confirms browser-URL-based polling as another viable, if imprecise, prior-art pattern, though full mechanism detail (exact regex, log predicate) was not retrievable from the README excerpt fetched.
- **No `vcrec` repository found.** Searched explicitly for `github.com/jwnichols3/vcrec` and for `vcrec` + "meeting detection" more broadly; no such repository (Rocket's own or otherwise) was located. Flagged in Uncertain - if this is expected to exist, it may be private, deleted, or misremembered.
- **oldjohngalt/ZoomStatus** - https://github.com/oldjohngalt/ZoomStatus - Found via search but is **Windows-only** (uses Windows UIAutomation against Zoom's window classes); not applicable to this macOS project. Included here only to record that it was checked and ruled out.

## Recommendation

**Primary:** OR together two cheap, TCC-free signals so a single point of failure can't cause a
false OFF:
1. `pgrep "CptHost"` (or the pyzoomproc regex `^CptHost$`) as the Zoom-specific signal.
2. `log stream --predicate 'composedMessage contains "AVFCapture"'` filtered for
   `AVCaptureSession_Tundra startRunning`/`stopRunning` as a generic "camera is live" proxy,
   which also catches Meet-in-browser (and FaceTime, and anything else using the camera -
   acceptable, since over-triggering is the tolerated failure mode here).

Report "in a call" if *either* fires; only report "not in a call" when *both* are quiet.
Both mechanisms need no admin rights, no TCC prompt, and no MDM cooperation, so they're the
most likely to actually work unmodified on a locked-down Mac Rocket doesn't control.

**Fallback/combo:** If Automation TCC for the browser turns out to already be granted (e.g.
Rocket already uses some AppleScript-driven browser automation and the one-time prompt is
long since accepted), add the AppleScript tab-title check as a *confirming* signal for
Meet specifically - use it to add confidence/logging, not as a mechanism the light depends
on, since it's the single most policy-fragile option (silently blockable by an MDM profile
with zero visible error). If IT can be persuaded to force-install or allowlist a small
browser extension, that becomes the most precise Meet signal available and should replace
the camera-proxy signal's imprecision for the Meet case specifically - but treat this as a
stretch goal contingent on IT cooperation, not a v1 dependency.

Do not build on: the Zoom local web server (dead/patched), the Zoom Apps SDK (wrong
usage model - requires an in-meeting user action), or a Zoom local status file (not found
to exist).

This design is directly shaped by the false-OFF-averse requirement: two independent,
low-permission, OS/hardware-level signals ORed together fail toward "light stays on a beat
too long," and neither depends on an IT-controlled policy that could silently and
permanently disable the sensor.

## Questions for Rocket

- What MDM product manages this Mac (Jamf/Kandji/Intune/other)? This determines whether a
  PPPC profile could pre-approve (or is already blocking) Automation TCC, and whether
  Chrome extension policy is locked down.
- Does the endpoint security agent alert on/block `log stream` usage, new LaunchAgents, or
  unsigned background scripts? A `log stream`-based sensor and a LaunchAgent for
  auto-start are both very "watchable" behaviors on a managed endpoint.
- Does Rocket have local admin rights on this Mac? (Affects whether a LaunchAgent vs.
  LaunchDaemon is even installable, and whether Homebrew/Node can be installed at all.)
- Is Chrome's (or Safari's) Automation TCC permission likely pre-blocked by a
  configuration profile on this Mac? Rocket is the only one who can check
  System Settings > Privacy & Security > Automation, or ask IT directly.
- Which browser does Rocket actually use for Google Meet - Chrome, Safari, Arc, something
  else? This changes which AppleScript dictionary/extension platform applies.
- Is Chrome on this Mac managed via Google Admin/Chrome Browser Cloud Management such that
  `ExtensionInstallBlocklist`/`Allowlist` policy is even in play, or is it unmanaged?

## Uncertain

- **Whether `CptHost` fires for every Zoom meeting or only during active screen sharing.**
  Two independent macOS prior-art tools (brunerd.com, darrenpmeyer/pyzoomproc) both treat
  it as a general "in a meeting" proxy and are presumably used daily by their authors, but
  no Zoom-authoritative source was found confirming this, and generic Windows-focused
  documentation describes `CptHost.exe` specifically as a "Sharing Host." This is the
  highest-impact open question for false-OFF risk in the whole report - worth a 5-minute
  manual test on Rocket's Mac (join a plain audio/video meeting with no screen share, run
  `pgrep CptHost`, see if it's present) before relying on it.
- **No confirmed working `log stream` predicate for microphone activation** (only camera
  predicates were found in working prior-art scripts). Don't build a mic-based signal
  without first spiking/testing a predicate on the actual Mac.
- **Whether running `log stream` triggers any TCC prompt or is flagged by an endpoint
  security agent on a fully locked-down, MDM-managed corporate Mac.** All prior-art
  evidence comes from scripts run on presumably unmanaged personal Macs; enterprise
  profiles or an EDR agent could behave differently and this was not testable from here.
- **Whether OverSight (or any AVFoundation/CoreMediaIO-based approach) requires its own
  special macOS permission** (Accessibility, Full Disk Access, or none) to observe another
  process's mic/camera use - not stated in the README, and no primary source confirming
  either way was found.
- **Whether any current Zoom version writes a local status file** analogous to Teams'
  `storage.json` - a negative result (nothing found), not a confirmed absence.
- **No repository named `vcrec` was found** under `jwnichols3` or elsewhere on GitHub via
  search. If Rocket expected this to exist as prior personal work, it may be private,
  unpushed, deleted, or under a different name.
- **Exact current macOS version's camera-detection predicate.** Confirmed predicates
  (`AVFCapture` for recent macOS per elgatokeylight's Sonoma/Tahoe scripts,
  `com.apple.UVCExtension`/"Post PowerLog" for Monterey) are already two generations of
  drift in a ~3-year window; whatever Rocket's Mac is running today should be verified
  directly rather than assumed from this report.

## Sources

- https://github.com/akburg/elgatokeylight - Accessed 2026-08-05
- https://raw.githubusercontent.com/akburg/elgatokeylight/main/autolights_sonoma.sh - Accessed 2026-08-05
- https://raw.githubusercontent.com/akburg/elgatokeylight/main/autolights_tahoe.sh - Accessed 2026-08-05
- https://github.com/MaxSchaefer/macos-log-stream - Accessed 2026-08-05
- https://www.brunerd.com/blog/2022/03/07/respecting-focus-and-meeting-status-in-your-mac-scripts-aka-dont-be-a-jerk/ - Accessed 2026-08-05
- https://github.com/darrenpmeyer/pyzoomproc - Accessed 2026-08-05
- https://raw.githubusercontent.com/darrenpmeyer/pyzoomproc/main/README.md - Accessed 2026-08-05
- https://raw.githubusercontent.com/darrenpmeyer/pyzoomproc/main/pyzoomproc/__init__.py - Accessed 2026-08-05
- https://raw.githubusercontent.com/darrenpmeyer/pyzoomproc/main/pyzoomproc/__main__.py - Accessed 2026-08-05
- https://github.com/objective-see/OverSight - Accessed 2026-08-05
- https://github.com/objective-see/OverSight/blob/main/README.md?plain=1 - Accessed 2026-08-05
- https://github.com/fikrikarim/repose - Accessed 2026-08-05
- https://raw.githubusercontent.com/fikrikarim/repose/main/README.md - Accessed 2026-08-05
- https://github.com/jkeefe/wfh-on-air-light - Accessed 2026-08-05
- https://github.com/sservaes/meetink - Accessed 2026-08-05
- https://raw.githubusercontent.com/sservaes/meetink/main/README.md - Accessed 2026-08-05
- https://github.com/oldjohngalt/ZoomStatus - Accessed 2026-08-05 (Windows-only, ruled out)
- https://scriptingosx.com/2020/09/avoiding-applescript-security-and-privacy-requests/ - Accessed 2026-08-05
- https://www.hexnode.com/mobile-device-management/help/how-to-configure-a-privacy-preferences-policy-control-profile-for-macos-devices/ - Accessed 2026-08-05
- https://derflounder.wordpress.com/2018/08/31/creating-privacy-preferences-policy-control-profiles-for-macos/ - Accessed 2026-08-05
- https://chromeenterprise.google/policies/extension-install-forcelist/ - Accessed 2026-08-05
- https://chromeenterprise.google/policies/extension-install-blocklist/ - Accessed 2026-08-05
- https://chromeenterprise.google/intl/en_au/policies/extension-install-allowlist/ - Accessed 2026-08-05
- https://medium.com/@boberito/private-data-in-unified-logging-10-15-9eb2b4be5c40 - Accessed 2026-08-05
- https://eclecticlight.co/2018/03/23/is-the-unified-log-private-or-a-vulnerability/ - Accessed 2026-08-05
- https://happymacadmin.wordpress.com/2022/02/22/orange-is-the-new-mac/ - Accessed 2026-08-05
- https://support.apple.com/en-euro/guide/mac-help/mchl50f94f8f/mac - Accessed 2026-08-05
- https://developer.apple.com/documentation/avfoundation/avcapturedevice - Accessed 2026-08-05
- https://gist.github.com/al45tair/73be245ab87a66a885742b98be91ac14 - Accessed 2026-08-05
- https://devforum.zoom.us/t/fall-back-mac-create-cpthost-app-failed/10184 - Accessed 2026-08-05
- https://www.file.net/process/cpthost.exe.html - Accessed 2026-08-05 (low-trust, Windows-generic; included to document a conflicting claim)
- https://recorder.easeus.com/screen-recording-resource/zoom-screen-sharing-not-working-mac.html - Accessed 2026-08-05 (via search synthesis; not independently re-fetched)
- https://github.com/zoom/appssdk - Accessed 2026-08-05
- https://appssdk.zoom.us/classes/ZoomSdk.ZoomSdk.html - Accessed 2026-08-05
- https://developers.zoom.us/docs/zoom-apps/ - Accessed 2026-08-05
- https://medium.com/bugbountywriteup/zoom-zero-day-4-million-webcams-maybe-an-rce-just-get-them-to-visit-your-website-ac75c83f4ef5 - Accessed 2026-08-05
- https://www.howtogeek.com/427964/how-to-see-if-zoom-is-running-a-secret-web-server-on-your-mac-and-remove-it/ - Accessed 2026-08-05
- https://gist.github.com/wbowling/13f9f90365c171806b9ffba2c841026b - Accessed 2026-08-05
