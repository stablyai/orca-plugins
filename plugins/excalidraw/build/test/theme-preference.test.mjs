import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  effectiveTheme,
  onThemePreferenceStored,
  readThemePreference,
  storeThemePreference
} from '../src/theme-preference.js'

function memoryStorage() {
  const items = new Map()
  return {
    getItem: (key) => (items.has(key) ? items.get(key) : null),
    setItem: (key, value) => items.set(key, String(value)),
    removeItem: (key) => items.delete(key)
  }
}

test('follows Orca until a theme is picked', () => {
  const storage = memoryStorage()
  assert.equal(readThemePreference(storage), 'system')
  assert.equal(effectiveTheme('system', 'dark'), 'dark')
  assert.equal(effectiveTheme('system', 'light'), 'light')
})

test('a picked theme is kept and overrides Orca', () => {
  const storage = memoryStorage()
  storeThemePreference('light', storage)
  assert.equal(readThemePreference(storage), 'light')
  assert.equal(effectiveTheme('light', 'dark'), 'light')
  storeThemePreference('dark', storage)
  assert.equal(effectiveTheme(readThemePreference(storage), 'light'), 'dark')
  storeThemePreference('system', storage)
  assert.equal(readThemePreference(storage), 'system')
})

test('ignores unknown values and storage that throws', () => {
  const storage = memoryStorage()
  storeThemePreference('sepia', storage)
  assert.equal(readThemePreference(storage), 'system')
  storage.setItem('orca-excalidraw-theme', 'sepia')
  assert.equal(readThemePreference(storage), 'system')
  const broken = {
    getItem() {
      throw new Error('denied')
    },
    setItem() {
      throw new Error('denied')
    }
  }
  assert.equal(readThemePreference(broken), 'system')
  assert.doesNotThrow(() => storeThemePreference('dark', broken))
})

test('hears the preference another tab stored', () => {
  const target = new EventTarget()
  const storage = memoryStorage()
  const previous = globalThis.localStorage
  globalThis.localStorage = storage
  try {
    const heard = []
    const stop = onThemePreferenceStored((preference) => heard.push(preference), target)
    storage.setItem('orca-excalidraw-theme', 'dark')
    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'orca-excalidraw-theme' }))
    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'orca-excalidraw-library' }))
    stop()
    target.dispatchEvent(Object.assign(new Event('storage'), { key: 'orca-excalidraw-theme' }))
    assert.deepEqual(heard, ['dark'])
  } finally {
    globalThis.localStorage = previous
  }
})
