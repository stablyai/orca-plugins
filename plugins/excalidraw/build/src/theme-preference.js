// The canvas theme the person picked: 'light', 'dark', or 'system' to follow Orca's theme. Kept in
// localStorage like the library, so every drawing (and every open tab) shares it. No Excalidraw
// import, so its tests run in Node.

const KEY = 'orca-excalidraw-theme'
const PREFERENCES = ['light', 'dark', 'system']

/** The stored preference; 'system' when there is none or it cannot be read. */
export function readThemePreference(storage = globalThis.localStorage) {
  try {
    const saved = storage?.getItem(KEY)
    return PREFERENCES.includes(saved) ? saved : 'system'
  } catch {
    return 'system'
  }
}

export function storeThemePreference(preference, storage = globalThis.localStorage) {
  if (!PREFERENCES.includes(preference)) {
    return
  }
  try {
    if (preference === 'system') {
      storage?.removeItem(KEY)
    } else {
      storage?.setItem(KEY, preference)
    }
  } catch {
    // Why: the pick still applies to this tab; it only isn't remembered.
  }
}

/** The theme the canvas shows: the picked one, or Orca's when the pick is 'system'. */
export const effectiveTheme = (preference, orcaTheme) => (preference === 'system' ? orcaTheme : preference)

/** Calls `onChange` with the preference another tab of this plugin stored. */
export function onThemePreferenceStored(onChange, target = globalThis.window) {
  const listener = (event) => {
    if (event.key === KEY || event.key === null) {
      onChange(readThemePreference())
    }
  }
  target.addEventListener('storage', listener)
  return () => target.removeEventListener('storage', listener)
}
