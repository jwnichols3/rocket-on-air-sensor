# Bitfocus Companion v5: sideloading a module, and whether presets can regenerate at runtime

2026-08-23. Research for issue #21 (map #19). Not a build.

## Summary

1. **Sideloading works, and there are two distinct paths.** A `.tgz` built by
   `companion-module-build` can be imported through the running Companion's **Modules >
   import module package** button - that is a *supported, documented, first-class* path
   explicitly intended for "a module which is internal to your company or organisation".
   Separately there is a **developer modules path** (`--extra-module-path`, driven by the
   launcher's "developer mode" setting) with chokidar file-watching and automatic
   connection restart - that one is a debug affordance. Both survive restart. The imported
   `.tgz` also survives a Companion upgrade (it lands outside the per-release config dir);
   the dev path survives upgrade only because the launcher setting persists. **No upstream
   submission is required for either.** There is one gate in v5: custom-module import is
   refused unless the browser client is on the local machine (or
   `--enable-restricted-modules` is set).
2. **Presets are NOT static at module load. They can be regenerated at runtime, and this
   is explicitly designed for.** `setPresetDefinitions()` (and the action/feedback/variable
   equivalents) can be called any number of times after `init()`; Companion diffs the new
   set against the previous one and pushes a JSON patch to the UI. **But** - and this is the
   real constraint - **a preset dragged onto a button is a one-time copy, not a live link.**
   Regenerating presets refreshes the *palette*; it does not touch buttons already placed.
3. **The existing `generic-websocket` wiring survives the transport but not the semantics.**
   `GET /events/ws` (D-11), the `?token=` auth, the JSON-path feedback and the
   `lastDataReceived` staleness variable all keep working unchanged. What breaks is
   everything keyed to the three-rung ladder: the `intended` on/off projection, the
   `$(genericwebsocket:intended) == "on"` expression, the `level == "interruptible"` amber
   feedback, and the five hardcoded action routes (`/on`, `/off`, `/available`,
   `/interruptible`, `/dnd`).

**Version ground truth.** Companion stable is **v5.0.4**, published 2026-08-23T17:09Z;
v5.0.0 was 2026-07-12. Source: `https://api.github.com/repos/bitfocus/companion/releases`
(accessed 2026-08-23). **Rocket's machine currently has Companion 4.1.4 installed**
(`/Applications/Companion.app/Contents/Info.plist`, `CFBundleShortVersionString = 4.1.4`;
`Contents/Resources/BUILD` = `4.1.4+8492-stable-4cb4314544`) and it appears never to have
been run - no config directory exists. **Upgrading to 5.0.x is a prerequisite for anything
below.**

Unless stated otherwise, every source claim below was read from a
`git clone --branch v5.0.4 https://github.com/bitfocus/companion` checkout, from
`npm pack @companion-module/base@2.1.3`, or from `npm pack @companion-module/tools@3.0.2`,
all accessed 2026-08-23.

---

## Q1 - Sideloading a module into a running Companion v5

### Path A: import a `.tgz` module package (supported)

This is the path to use. Companion's own shipped user guide describes it:

> The 'import module package' button lets you import a module package. This should be a
> `.tgz` file produced by building a single module, most likely distributed by the module
> author. With this, you can now easily import a test build of a module, **or a module
> which is internal to your company or organisation**.

- Source: `docs/user-guide/3_config/modules.md` line 25, at tag `v5.0.4`. (Verbatim the
  same sentence appears in the 4.1.4 build's shipped `docs.zip` as `6_modules/list.md`,
  so this affordance is not new in v5.)

Context for *why* this exists at all: modules stopped being bundled with Companion as of
4.0.

> Modules used to be built-in to Companion, but starting with 4.0 (connections) and 4.3
> (surfaces) they are downloadable plugins that can be updated independently of Companion
> itself.
> - Source: `docs/user-guide/3_config/modules.md` line 7, tag `v5.0.4`.

The sibling button is **import offline module bundle**, for bulk-installing the versioned
offline bundle from the Bitfocus site - not what we want, but it is the reason the import
UI exists in that panel.

**Server side of the import.** `companion/lib/Instance/InstalledModulesManager.ts`,
`installModuleTar` tRPC procedure: base64 tarball in, gunzip (cap
`MAX_DECOMPRESSED_MODULE_TAR_SIZE` = 100 MB), extract and parse
`companion/manifest.json`, require `manifestJson.version` to parse as semver, then unpack
to `<modulesDir>/<id>-<version>/`. It refuses to overwrite an existing `id-version`
directory - **bump the manifest version on every re-import, or uninstall first.**

**The one gate in v5.** Before any of that:

```ts
#isCustomModuleImportAllowed(ctx: TrpcContext): boolean {
    return this.#appInfo.options.enableRestrictedModules || ctx.isLocalClient()
}
```

with the rejection message *"Importing custom modules is only allowed from the local
machine."* plus a pointer to `--enable-restricted-modules` /
`COMPANION_ENABLE_RESTRICTED_MODULES` (`companion/lib/main.ts` reads both).
- Source: `companion/lib/Instance/InstalledModulesManager.ts` lines ~60-67, ~133-135,
  ~246-296; `companion/lib/main.ts` lines ~226-253.

The default matters and is easy to misread. `shared-lib/lib/LaunchOptions.ts` declares
`enableRestrictedModules` with `default: true` but carries this comment:

> Defaults to true for headless installs (this tool): importing modules is a common,
> expected workflow there. **The desktop app's own default stays false** -
> `registerLaunchOptions` does not pass boolean defaults to commander, so this only affects
> config-tool output.

and the option's own help text ends *"Local clients can always import"*. So on Rocket's Mac
desktop app the effective rule is: **import from the browser on the Companion machine, and
it just works; import from another machine on the LAN, and it is refused.** No flag needed.

There is **no signing, no checksum and no allowlist** on a locally-imported `.tgz`. (Store
downloads *are* checksummed - `bufferChecksum !== versionInfo.tarSha` in the same file -
but that check is on the store path only.) The security model is "you must be sitting at
the machine".

**Where it lands, and whether it survives upgrade.** `companion/lib/main.ts`:

```ts
modulesDirs: {
    [ModuleInstanceType.Connection]: path.join(rootConfigDir, 'modules'), // Naming for backwards compatibility
    [ModuleInstanceType.Surface]: path.join(rootConfigDir, 'surfaces'),
},
```

Note `rootConfigDir`, **not** `configDir`. `configDir` is `rootConfigDir/v5.0` - the
per-release subdirectory, taken from `ConfigReleaseDirs` in `shared-lib/lib/Paths.ts`
(which ends `..., 'v4.2', 'v4.3', 'v5.0'`). Because modules live one level *above* the
release subdirectory, **an imported module is not duplicated or discarded when Companion
upgrades to a new release folder.** On macOS `rootConfigDir` is `~/companion` if that
directory already exists, otherwise `envPaths('companion').config`
(`~/Library/Preferences/companion-nodejs` on macOS).
- Source: `companion/lib/main.ts` lines ~125-150, ~232-236; `shared-lib/lib/Paths.ts`.

**Compatibility across a Companion upgrade is a separate question**, and it is gated - see
"API version compatibility" below.

### Path B: developer modules path (a debug affordance)

Rocket's recollection ("a feature added in Companion 4") is close: the mechanism predates
v5 and is unchanged in it. It is documented, but as a developer tool rather than a
deployment mechanism:

> **Extra module path / developer modules** — point Companion at a folder of local modules
> to load, in addition to the installed ones. **This is mainly used by module developers**;
> the folder is watched and modules are automatically restarted when they change.
> - Source: `docs/user-guide/1_getting-started/server-configuration.md` lines 82-87, under
>   a heading literally called "Paths & developer options", tag `v5.0.4`.

In the launcher UI it sits in the settings window under a **Developer** section: *"enable
developer modules and point Companion at a local modules folder. If you're a module
developer you'll want this"*
(`docs/user-guide/1_getting-started/start-the-server.md` lines 26-28). The generated CLI
reference lists it as `extraModulePath`, *"An additional directory to search for
**in-development** modules to be loaded from"*
(`docs/user-guide/1_getting-started/config-reference.generated.md` line 111).

The Electron launcher stores two settings, `enable_developer` (default `false`) and
`dev_modules_path` (default `''`), and when developer mode is on it passes
`--extra-module-path=<dev_modules_path>` to the Companion child process:

```js
uiConfig.get('enable_developer') ? `--extra-module-path=${uiConfig.get('dev_modules_path')}` : undefined,
```

It also runs a `chokidar` watcher over `**/*.{mjs,js,cjs,json}` in that directory
(`ignored: ['**/node_modules/**']`), debounced 100 ms, sending
`{ messageType: 'reload-extra-module', fullpath }` per changed top-level module folder.
Toggling developer mode on forces an app restart (`doRestartApp = true`).
- Source: `launcher/main.js` at tag `v5.0.4`, lines 135-136, 311-360, 541, 587-597, 988.
  (The identical code is present in the locally installed 4.1.4 build - verified by
  `strings` over `/Applications/Companion.app/Contents/Resources/app.asar`.)

Companion's side: `companion/lib/Instance/Modules.ts` `initModules(extraModulePath)`
scans the directory and registers each find as `moduleInfo.devModule` with
`versionId: 'dev'` - i.e. a **separate version channel alongside store-installed
versions**, not an overwrite. `reloadExtraModule(fullpath)` re-scans one folder, replaces
the entry, and calls `reloadUsesOfModule(..., 'dev')` to restart any connection pinned to
the dev version. If the folder stops parsing as a module, the dev entry is *removed* and
dependents are restarted.
- Source: `companion/lib/Instance/Modules.ts` lines 209-235, 270-315.

This survives restarts (the launcher setting persists) but it is plainly a debug
affordance: it is behind a "developer mode" toggle in the launcher, it hot-reloads on
file change, and Companion's own repo ships a `module-local-dev/` directory whose
`.gitignore` is `*` / `!package.json` / `!.gitignore`, wired up by
`companion/package.json`'s `dev:inner` script:
`tsx ../tools/dev.mts --extra-module-path=../module-local-dev`.
- Source: `module-local-dev/.gitignore`, `companion/package.json` at `v5.0.4`.

### What a module needs on disk

`companion/lib/Instance/ModuleScanner.ts` is the whole contract:

- **Required:** `<moduleDir>/companion/manifest.json`. Nothing else is checked before
  parsing. A directory without it is silently skipped ("Ignoring ... as it is not a new
  module").
- **Optional:** `<moduleDir>/companion/HELP.md` (served at
  `/int/help/module/connection/<id>/<version>/HELP.md`).
- **Optional dev-only:** a `DEBUG-PACKAGED` marker file plus a `pkg/` directory - if both
  exist, Companion loads `pkg/` instead of the source tree.
- **Packaged-vs-source detection:** if the module's own `package.json` does *not* declare
  `@companion-module/base` in `dependencies` or `devDependencies`, Companion treats it as
  a self-contained packaged build and trusts its manifest `apiVersion`. A source checkout
  declares it, so it is treated as unpackaged and needs its `node_modules` present.
- **Version must parse as semver** (`semver.parse(versionId, { loose: true })`).
- Two manifest generations are accepted side by side: legacy (no `type` field, validated
  by `@companion-module/base-old`) and v2 (`type: "connection"`, validated by
  `@companion-module/base/manifest`).

Required manifest fields, from `@companion-module/base@2.1.3`'s generated
`ModuleManifest` type (`generated/manifest.d.ts`, mirrored by
`assets/manifest.schema.json`): `type` (`"connection"`), `id`, `name`, `shortname`,
`description`, `version`, `license` (SPDX), `repository`, `bugs`, `maintainers[]`,
`legacyIds[]`, `runtime`, `manufacturer`, `products[]` (min 1), `keywords[]`. Optional:
`isPrerelease`, `bonjourQueries`.

`runtime` is `{ type: "node22" | "node26", api: "nodejs-ipc", apiVersion: string,
entrypoint: string, permissions?: { "worker-threads"?, "child-process"?,
"native-addons"?, filesystem?, "insecure-algorithms"? } }`.

### Building the `.tgz`

`@companion-module/tools@3.0.2` (published 2026-06-19) exposes bins
`companion-module-build`, `companion-module-check`, `companion-surface-build`,
`companion-surface-check`. `companion-module-build`
(`dist/scripts/lib/build-util.js`) reads `./companion/manifest.json`, wipes `pkg/`,
esbuild-bundles to `pkg/<sanitized-id>/`, then **rewrites the manifest**:

```js
manifestJson.runtime.entrypoint = '../main.js'
manifestJson.version           = srcPackageJson.version   // version comes from package.json, not the manifest
manifestJson.runtime.api       = 'nodejs-ipc'
manifestJson.runtime.apiVersion = frameworkPackageJson.version  // the installed @companion-module/base version
```

validates it (`validateManifest(manifestJson, false)` - strict), installs any needed
native deps, and tars `pkg/` to `<id>-<version>.tgz`. That file is exactly what "import
module package" consumes.

Practical consequence: **the module's version comes from its `package.json`**, and
Companion refuses to import an `id-version` that already exists on disk, so the
sideload loop is `bump package.json version -> companion-module-build -> import`.

### API version compatibility (this is the upgrade risk)

`shared-lib/lib/ModuleApiVersionCheck.ts` at `v5.0.4`:

```ts
export const MODULE_BASE_VERSIONS = [
	'1.14.0',
	'2.1.0',
	'2.1.2-nightly-main-20260722-105828-99d8e81', // DEV version
]
...
const validModuleApiRange = new semver.Range(`~0.6 || ${moduleBaseRules.join(' || ')}`)
```

where each entry expands to `major - major.minor.x`. So Companion 5.0.4 accepts a module
declaring `runtime.apiVersion` in `~0.6 || 1 - 1.14.x || 2 - 2.1.x`. An incompatible
version is filtered out of the selectable versions entirely
(`companion/lib/Instance/ModuleInfo.ts` line 39) and refused at launch
(`ProcessManager.ts` line 785).

`@companion-module/base` latest is **2.1.3** (published 2026-08-12); `2.2.0-nightly` also
exists on the `nightly` dist-tag and would **not** be accepted by 5.0.4. Source:
`https://registry.npmjs.org/@companion-module/base` (accessed 2026-08-23).

Two child-handler generations exist: `>=2.0.0-0` uses `ChildHandlerNew`, older uses
`ChildHandlerLegacy` (`companion/lib/Instance/Connection/ApiVersions.ts`,
`doesModuleUseNewChildHandler`). This is how a base-1.12 module such as
`generic-websocket` still runs under v5.

**Recommendation:** pin `@companion-module/base` to `~2.1.x` and expect to re-check this
list on every Companion minor upgrade. It is a hand-maintained array, not an open range.

---

## Q2 - Presets, variables, feedbacks, and dynamic regeneration

### The API surface (`@companion-module/base@2.1.3`, `dist/module-api/base.d.ts`)

```ts
abstract class InstanceBase<TManifest extends InstanceTypes = InstanceTypes> {
  abstract init(config: TManifest['config'], isFirstInit: boolean, secrets: TManifest['secrets']): Promise<void>
  abstract destroy(): Promise<void>
  abstract configUpdated(config: TManifest['config'], secrets: TManifest['secrets']): Promise<void>
  abstract getConfigFields(): SomeCompanionConfigField[]

  setActionDefinitions(actions: CompanionActionDefinitions<TManifest['actions']>): void
  setFeedbackDefinitions(feedbacks: CompanionFeedbackDefinitions<TManifest['feedbacks']>): void
  setPresetDefinitions(structure: CompanionPresetSection<TManifest>[], presets: CompanionPresetDefinitions<TManifest>): void
  setCompositeElementDefinitions(compositeElements: ...): void
  setVariableDefinitions(variables: CompanionVariableDefinitions<TManifest['variables']>): void
  setVariableValues(values: Partial<TManifest['variables']>): void
  getVariableValue<T extends string>(variableId: T): TManifest['variables'][T] | undefined
  checkAllFeedbacks(): void
  checkFeedbacks(feedbackType: StringKeys<TManifest['feedbacks']>, ...more): void
  checkFeedbacksById(...feedbackIds: string[]): void
  updateStatus(status: InstanceStatus, message?: string | null): void
}
```

`TManifest` (`InstanceTypes`) is a **TypeScript-only** generic - "This is optional, but
allows you to have better type safety in various places". Nothing about actions,
feedbacks or variables is declared in `companion/manifest.json`; the manifest schema has
no such fields. All definitions are supplied at runtime through the setters.

Three v2-vs-v1 breaking changes worth knowing before writing any code:
- `setPresetDefinitions` now takes **two** arguments (a `structure` array of sections, and
  a flat `presets` record), not a single object.
- `setVariableDefinitions` now takes an **object keyed by variable id**, not an array.
  `base.js` throws explicitly: `if (Array.isArray(variables)) throw new Error('Variable
  definitions should be an object, not an array')`.
- `init`/`configUpdated` gained a `secrets` argument, separate from `config`.

### Can presets be regenerated at runtime? YES - definitively

None of the setters are init-only. Companion's host side treats each call as a full
replacement plus a diff, which only makes sense if repeated calls are expected.

`companion/lib/Instance/Definitions.ts`,
`#updateVariablePrefixesAndStoreDefinitions` (the tail of `setPresetDefinitions`):

```ts
this.#presetDefinitions[connectionId] = structuredClone(presets)
const lastPresetDefinitions = this.#uiPresetDefinitions[connectionId]
this.#uiPresetDefinitions[connectionId] = structuredClone(uiDefinitions)

this.emit('updatePresets', connectionId)

if (this.#events.listenerCount('presets') > 0) {
    if (!lastPresetDefinitions) {
        this.#events.emit('presets', { type: 'add', connectionId, definitions: uiDefinitions })
    } else {
        const diff = jsonPatch.compare(lastPresetDefinitions, uiDefinitions)
        if (diff && diff.length > 0) {
            this.#events.emit('presets', { type: 'patch', connectionId, patch: diff })
        }
    }
}
```

The same shape appears in `setActionDefinitions` (lines 420-444) and
`setFeedbackDefinitions` (449-473) using `diffObjects`, and in
`companion/lib/Variables/InstanceDefinitions.ts` `setVariableDefinitions` (81-109).

Companion also validates the new preset set on every call and warns about dangling
references: *"Presets for connection `<label>` reference feedback definitions that do not
exist: ..."* - so when regenerating from a state table, **regenerate feedbacks first (or
in the same tick), then presets.**

Companion additionally re-renders the *preview* buttons in the Presets tab on every
update: `ControlButtonPreset.#updatePresetDefinition` listens for the change and calls
`convertPresetToPreviewControlModel` -> `#applyPresetModel`
(`companion/lib/Controls/ControlTypes/Button/Preset.ts` lines ~194-215).

**So the answer to Rocket's question is yes** - the presets *palette* refreshes live from
server state with no user action and no Companion restart.

### THE HARD CONSTRAINT: a placed preset is a copy, not a live link

This is the thing that must be recorded. Companion's own user guide:

> Presets are ready made buttons with text, actions and feedback so you don't need to
> spend time making everything from scratch. They can be drag and dropped onto your button
> layout. ... **Once you have placed a preset, it is editable just like a manually defined
> button.**
>
>
> :::note
> Presets are pre-made by the module author, you can't create your own. You can build your
> own library of presets on other pages, which can be exported and reimported instead.
> :::
> - Source: `docs/user-guide/3_config/buttons/creating/index.md` lines 11-39, tag `v5.0.4`
>   (the emphasised sentence is line 17).

The code agrees. Drag-and-drop calls the `importPreset` tRPC procedure, which does
`convertPresetToControlModel(connectionId, presetId, variableValues)` and then
`controlsController.importControl(location, model)` - a one-shot materialisation into an
ordinary button control
(`companion/lib/Controls/ControlsTrpcRouter.ts` lines 25-43). The `@companion-module/base`
type for a layered preset says the same thing about its drawing elements: *"The drawing
elements for this preset, **this will be copied to the button**"*
(`dist/module-api/preset/definition-graphics.d.ts`).

Only the live *preview* control in the Presets panel re-renders on regeneration; buttons
on the grid do not.

**Design consequence for On-Air v2.** Rocket's stated goal - *"pre-configured buttons
which I can drag on there, which automatically refresh based on the server's
configuration"* - splits in two:

- **"automatically refresh"** applies to the **palette**. When the user edits the state
  table on the admin UI, the module re-fetches and re-emits, and the Presets tab in
  Companion updates immediately with a preset per state. That part works.
- **It does not apply to a button already on the Stream Deck.** A button placed from a
  "Set state: dnd" preset keeps pointing at `dnd` even after the user renames or deletes
  that state.

Two mitigations, both worth designing for:
1. **Make the placed button's behaviour data-driven rather than identity-driven.** A
   preset whose action option is a `textinput` with `useVariables: true`, or whose feedback
   compares against a module variable, keeps working across a state-table edit because the
   *value* is resolved at press/evaluate time rather than baked in. Only presets that
   hardcode a state id go stale.
2. **Make stale references visible.** A module can detect that a placed action/feedback
   references an unknown state (its own `subscribe`/callback sees the option value) and
   surface it via `updateStatus(InstanceStatus.BadConfig, ...)` or a feedback that
   evaluates to an "unknown state" style.

### Preset structure (v2), and the template group

`setPresetDefinitions(structure, presets)` - `structure` is
`CompanionPresetSection[]`, each `{ id, name, description?, keywords?, definitions }`
where `definitions` is either a plain array of preset-id strings or an array of
`CompanionPresetGroup`. A group is one of:

- `CompanionPresetGroupSimple` - `{ type: 'simple', id, name, presets: string[] }`
- `CompanionPresetGroupTemplate` - **directly relevant here**:

```ts
/**
 * A preset which generates a series of buttons from a matrix of values
 * Tip: This allows you to avoid generating repetitive presets which vary just by a few simple values
 */
export interface CompanionPresetGroupTemplate<...> extends CompanionPresetGroupBase<'template'> {
    presetId: CompanionPresetReference          // the template preset
    templateVariableName: string                // the local variable to substitute
    templateValues: { name?: string; value: CompanionVariableValue }[]
    commonVariableValues?: CompanionVariableValues
}
```

- Source: `dist/module-api/preset/structure.d.ts`.

That is close to a purpose-built fit for "one preset per row of an arbitrary state table":
declare one template preset ("Set state to $(state)") and feed `templateValues` from the
server's table. It still has to be re-emitted when the table changes - it is a compact way
to *express* N presets in one call, not a live binding.

Presets come in two flavours: `simple` (a `CompanionButtonStyleProps` style block, the
classic form) and `layered` (`CompanionLayeredButtonPresetDefinition`: `elements`,
`canvas`, `feedbacks` with per-element `styleOverrides`, `steps`, `localVariables`).
Both let a preset embed Companion's *internal* actions/feedbacks alongside the module's
own (`WithInternalActions` / `WithInternalFeedbacks`, plus `internal:actionGroup`,
`internal:logicIf`, `internal:logicWhile` building blocks).

### Feedbacks over an arbitrary, user-defined set of states

Nothing forces a fixed enum. Options are re-declared on every
`setFeedbackDefinitions` call, so a `dropdown` option's `choices` array can simply be
rebuilt from the state table:

```ts
export interface CompanionInputFieldDropdown<...> extends CompanionInputFieldBase<TKey> {
    type: 'dropdown'
    choices: DropdownChoice<TChoiceId>[]
    default: TChoiceId
    allowCustom?: boolean   // "Allow custom values to be defined by the user. Note: These will always come through as strings"
    regex?: string
    minChoicesForSearch?: number
}
```

- Source: `dist/module-api/input.d.ts` lines 208-223.

Three usable shapes, in increasing robustness against table edits:
- **dropdown with regenerated `choices`** - best UX, but a stored option value that no
  longer matches any choice is a dangling reference on already-placed buttons.
- **dropdown with `allowCustom: true`** - same UX plus an escape hatch.
- **`textinput` with `useVariables`** - the state id is resolved at evaluate time, so the
  button follows a variable rather than a baked-in id. Least brittle for placed buttons.
  Note the type's own comment: *"Even if this is false, users can toggle this field to
  expression mode to use variables"* (`dist/module-api/input.d.ts` lines 175-179) - so any
  `textinput` option is already variable-capable from the user's side.

`checkFeedbacks('<id>')` / `checkAllFeedbacks()` force re-evaluation when server state
arrives.

### Config UI (`getConfigFields()`)

`SomeCompanionConfigField` is the union of `static-text`, `colour`, `textinput`,
`dropdown`, `multidropdown`, `number`, `checkbox`, `bonjour-device` and **`secret-text`**,
each intersected with `{ width: number }` (a 12-column grid).
- Source: `dist/module-api/config.d.ts`.

For the passphrase there is a real secret field type in v5:

```ts
export interface CompanionInputFieldSecret<TKey extends string = string> extends CompanionInputFieldBase<TKey> {
    type: 'secret-text'
    default?: string
    minLength?: number
    regex?: string
}
```

- Source: `dist/module-api/input.d.ts` lines 378-394.

Secrets are carried separately from config throughout the v2 API: `init(config,
isFirstInit, secrets)` and `configUpdated(config, secrets)`. So the On-Air module's config
is `textinput` host + `number` port + **`secret-text` passphrase**, with the passphrase
landing in `secrets`, not `config`. `bonjour-device` is also available if the server ever
advertises over mDNS.

`configUpdated` is where a re-fetch of the state table belongs: change the host or the
passphrase and the module should re-connect and re-emit all four definition sets.

### Variables

`setVariableDefinitions` takes `{ [variableId]: { name: string } }`; values go through
`setVariableValues({ id: value })`. `CompanionVariableValue = JsonValue | undefined`.
Companion prunes to `{ name, description }` and rejects a small banned-name set.
Consumers reference them as `$(connectionlabel:variableId)` - Companion rewrites the
label prefix automatically when a connection is renamed
(`updateVariablePrefixesForLabel` in `Definitions.ts`).

By default **a variable must be defined before its value is accepted**; there is an
`instanceOptions.disableVariableValidation` escape hatch, documented as *"It is not
recommended to set this, unless you know what you are doing"*
(`dist/module-api/base.d.ts` lines 15-29). For a dynamic state table this means: call
`setVariableDefinitions` with the new set **before** `setVariableValues`.

### Upgrade scripts

`addUpgradeScript` / `dist/module-api/upgrade.d.ts` exists for migrating *stored*
action/feedback option values across module versions. Relevant if a state-id rename ever
needs to be propagated into already-placed buttons - it is the only mechanism that
rewrites existing controls, and it runs on module version change, not on server config
change. It cannot help with a table the user edits at runtime.

---

## Q3 - What of the existing Companion wiring survives the arbitrary state table

Current wiring (`docs/companion-setup.md`, D-11): `generic-http` for actions against
`POST /on` and `POST /off`; `generic-websocket` pointed at
`ws://<host>:8484/events/ws?token=<ONAIR_TOKEN>` with **Feedback JSON Path** `intended`
and a button feedback `$(genericwebsocket:intended) == "on"`, plus an optional second
feedback on `level == "interruptible"`.

`generic-websocket` is still **v2.3.1** and still depends on `@companion-module/base
~1.12.0` (source:
`https://raw.githubusercontent.com/bitfocus/companion-module-generic-websocket/master/package.json`,
accessed 2026-08-23). That is inside Companion 5.0.4's accepted range
(`1 - 1.14.x`) and runs through `ChildHandlerLegacy`, so **the module itself is fine
under v5** - it just has to be installed from the module store now rather than being
bundled.

### Survives unchanged

| Thing | Why |
|---|---|
| `GET /events/ws` itself | Transport-level. `src/server.ts` upgrade handler is state-model agnostic - it path-matches `/events/ws`, checks the token, and hands off. |
| Hand-rolled `src/ws.ts` bridge | Frames JSON; knows nothing about `level`. |
| `?token=` on the WS upgrade | `generic-websocket` still has no auth-header config field, so the query param stays the only option. D-7's `ONAIR_TOKEN` becoming a UI-configurable passphrase changes *where the value comes from*, not the mechanism. |
| Push-on-change | Both call sites push the same payload as `GET /status`: `broadcastAndSend` in `src/server.ts` on every write, and the supervisor's `onChange` in `src/app.ts`. Both do `hub.broadcast(body)` then `wsBridge.broadcast(body)`. |
| Snapshot-on-connect and the 15 s re-send | `ws.handleUpgrade(req, socket, () => statusBody(deps), head)`, plus a per-socket `setInterval(..., 15_000)` in `src/ws.ts` that re-sends the whole snapshot. Note this is a full status re-send, not a protocol ping - which is what keeps `generic-websocket`'s `lastDataReceived` fresh. |
| `lastDataReceived` staleness variable | Module-side, payload-independent. |
| The **shape** of the JSON-path feedback | `generic-websocket` copies any simple JSON path (e.g. `level`) into a named variable. Flat keys keep working. |
| The `generic-http` action pattern | POST to a URL with an optional `Authorization` header. Only the URLs change. |

### Breaks

| Thing | Why |
|---|---|
| **Feedback JSON Path `intended`** | `intended` exists only as the D-18 ladder projection `level === 'available' ? 'off' : 'on'` (`src/state.ts` `levelToOnOff`, applied in `statusBody`). D-18 is superseded by the arbitrary state table; an unordered table has no on/off collapse, so `intended` has no definition to compute. Its stated justification in D-18 was literally "so Bitfocus Companion (D-11) ... keeps working" - that justification is now the thing under review. |
| `$(genericwebsocket:intended) == "on"` | Same. |
| `$(genericwebsocket:level) == "interruptible"` amber feedback | `interruptible` is a ladder rung name, not a guaranteed row of a user-defined table. |
| **The five hardcoded action routes** | `src/server.ts` `ROUTES` declares `/on`, `/off`, `/available`, `/interruptible`, `/dnd`, and `PATH_LEVEL` maps them to the three rungs. Under an arbitrary table these cannot be enumerated at build time. The generic-http actions in `docs/companion-setup.md` point at `/on` and `/off` directly. |
| Any feedback keyed to ordering | `higher()` / `RANK` and hold-as-floor (D-19) presuppose a ladder. |

### What that implies for the server contract

This is the part that matters for map #19, since #21 is upstream of the API-contract work:

1. **One state-setting route that takes the state id as data**, not five routes that
   encode it in the path - e.g. `PUT /state {"level":"<id>"}` (which already exists in
   `ROUTES`) or `POST /state/<id>`. Both a `generic-http` action and a custom module can
   drive that; only the second is enumerable at build time.
2. **A machine-readable state table endpoint** (e.g. `GET /config/states`, or the table
   embedded in `GET /status`), because that is the thing the custom module polls or
   subscribes to in order to regenerate presets, feedback dropdown choices, and variables.
   Without it, Q2's answer is unusable.
3. **The state table should reach the module over the same WebSocket**, or the module has
   to poll. `/events/ws` currently broadcasts only `statusBody`. Either add a `states`
   array to that payload, or add a second message type. A message-typed envelope would be a
   breaking change for `generic-websocket`'s flat JSON-path feedback - worth deciding
   deliberately.
4. **Decide `intended`'s fate explicitly.** It is currently kept on the wire *and* on disk
   as rollback insurance (`PersistedState`). If it survives as a user-designated "any of
   these states counts as busy" flag, phase-1 `generic-websocket` wiring keeps working with
   no changes at all - a genuinely cheap way to keep the zero-code path alive while the
   module is built. If it is dropped, `docs/companion-setup.md` needs a rewrite and that
   path degrades to "compare `level` against a literal state id".
5. **Stable state ids.** Because a placed Companion button stores the id it was created
   with, and nothing rewrites it, the state table wants an immutable `id` separate from a
   user-editable display `name`. This is the single most load-bearing consequence of Q2's
   constraint on the server design.

---

## Uncertain / not verified

- **Nothing here was tested against a running Companion 5.** The installed app is 4.1.4
  and has never been launched (no config dir). Every claim above is from source, shipped
  docs, or package metadata. The end-to-end sideload-and-regenerate loop should be smoke-
  tested before the module is specced.
- The exact macOS `rootConfigDir` in practice depends on whether `~/companion` exists;
  `envPaths('companion').config` was not resolved empirically.
- Whether the v5 "Manage modules" panel presents the `dev` version channel as a selectable
  version for a connection, and whether a connection defaults to it, was inferred from
  `Modules.ts` (`versionId: 'dev'`, `reloadUsesOfModule(..., 'dev')`) rather than read from
  the UI code.
- No upstream v5 module was located that calls `setPresetDefinitions` repeatedly at
  runtime. The conclusion rests on the host-side diff/patch implementation, which is
  unambiguous, not on precedent.
- `MODULE_BASE_VERSIONS` was read at tag `v5.0.4`; it is a hand-maintained array and will
  differ on other patch releases.

## Sources

Read from a local checkout of `https://github.com/bitfocus/companion` at tag **v5.0.4**
(accessed 2026-08-23):
`launcher/main.js`, `companion/lib/main.ts`, `companion/package.json`,
`companion/lib/Instance/Modules.ts`, `companion/lib/Instance/ModuleScanner.ts`,
`companion/lib/Instance/InstalledModulesManager.ts`, `companion/lib/Instance/Definitions.ts`,
`companion/lib/Instance/ModuleInfo.ts`, `companion/lib/Instance/ProcessManager.ts`,
`companion/lib/Instance/Connection/ApiVersions.ts`,
`companion/lib/Variables/InstanceDefinitions.ts`,
`companion/lib/Controls/ControlsTrpcRouter.ts`,
`companion/lib/Controls/ControlTypes/Button/Preset.ts`,
`shared-lib/lib/Paths.ts`, `shared-lib/lib/ModuleApiVersionCheck.ts`,
`shared-lib/lib/LaunchOptions.ts`, `module-local-dev/.gitignore`,
`docs/user-guide/3_config/modules.md`,
`docs/user-guide/3_config/buttons/creating/index.md`,
`docs/user-guide/1_getting-started/server-configuration.md`,
`docs/user-guide/1_getting-started/start-the-server.md`,
`docs/user-guide/1_getting-started/config-reference.generated.md`.

Read from `npm pack @companion-module/base@2.1.3` (published 2026-08-12; accessed
2026-08-23): `dist/module-api/base.{d.ts,js}`, `dist/module-api/config.d.ts`,
`dist/module-api/input.d.ts`, `dist/module-api/variable.d.ts`,
`dist/module-api/preset/structure.d.ts`, `dist/module-api/preset/definition.d.ts`,
`dist/module-api/preset/definition-graphics.d.ts`, `dist/host-api/context.d.ts`,
`generated/manifest.d.ts`, `assets/manifest.schema.json`, `package.json`.

Read from `npm pack @companion-module/tools@3.0.2` (published 2026-06-19; accessed
2026-08-23): `dist/scripts/lib/build-util.js`, `package.json`.

Read from the locally installed `/Applications/Companion.app` (**4.1.4**,
`BUILD = 4.1.4+8492-stable-4cb4314544`; accessed 2026-08-23):
`Contents/Info.plist`, `Contents/Resources/BUILD`,
`Contents/Resources/app.asar` (via `strings`),
`Contents/Resources/docs.zip` -> `6_modules.md`, `6_modules/list.md`,
`6_modules/manage.md`, `3_config/buttons/creating.md`.

Registry / API:
- `https://api.github.com/repos/bitfocus/companion/releases` (accessed 2026-08-23)
- `https://registry.npmjs.org/@companion-module/base` (accessed 2026-08-23)
- `https://registry.npmjs.org/@companion-module/tools` (accessed 2026-08-23)
- `https://raw.githubusercontent.com/bitfocus/companion-module-generic-websocket/master/package.json` (accessed 2026-08-23)
- `https://raw.githubusercontent.com/bitfocus/companion-module-generic-websocket/master/companion/HELP.md` (accessed 2026-08-23)

This repo: `CONTEXT.md` (D-5, D-7, D-11, D-17, D-18, D-19, D-23),
`docs/companion-setup.md`, `docs/research/2026-08-05-companion-integration.md`,
`docs/2026-08-23-onair-v2-wayfinder-brief.md`, `src/server.ts`, `src/ws.ts`, `src/state.ts`.
