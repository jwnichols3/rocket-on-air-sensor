// The bundle receives this constant from build.mjs. Source execution deliberately reports
// no released identity, rather than guessing from a checkout that may have moved.
export const MODULE_BUILD_INFO = Object.freeze(
  typeof __ONAIR_MODULE_BUILD__ === 'undefined'
    ? { version: 'unbuilt', commit: null, dirty: null, builtAt: null }
    : __ONAIR_MODULE_BUILD__,
)
