/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import type { CustomThemeData } from './registry'
import {
  activeThemeIdForSelection,
  CUSTOM_THEMES_STORAGE_KEY,
  DEFAULT_THEME_SELECTION,
  legacyPreferenceForSelection,
  readStoredCustomThemes,
  readThemeSelection,
  resolveActiveTheme,
  sanitizeStoredCustomThemes,
  selectionFromLegacyPreference,
  selectionWithThemeRemoved,
  THEME_SELECTION_STORAGE_KEY,
  themeSelectionCodec,
  type ThemeSelection,
} from './selection'
import { THEME_STORAGE_KEY } from './theme'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const customDark: CustomThemeData = {
  schemaVersion: 1,
  id: 'custom-night',
  name: 'Night Shift',
  family: 'dark',
  baseThemeId: 'dark',
  overrides: { accent: '#ff8800' },
}

const customLight: CustomThemeData = {
  schemaVersion: 1,
  id: 'custom-paper',
  name: 'Paper',
  family: 'light',
  baseThemeId: 'light',
  overrides: {},
}

function storageOf(entries: Record<string, string>): Pick<Storage, 'getItem'> {
  return { getItem: (key: string) => (key in entries ? entries[key] : null) }
}

// --- Codec ------------------------------------------------------------------

const roundTripped = themeSelectionCodec.deserialize(
  themeSelectionCodec.serialize({
    mode: 'system',
    fixedThemeId: 'custom-night',
    systemLightThemeId: 'custom-paper',
    systemDarkThemeId: 'custom-night',
  }),
)
assert(roundTripped.mode === 'system' && roundTripped.systemLightThemeId === 'custom-paper', 'selection codec round-trips')

let codecThrew = false
try {
  themeSelectionCodec.deserialize('{"mode":"nope"}')
} catch {
  codecThrew = true
}
assert(codecThrew, 'invalid selection payload throws (falls back to default upstream)')

// --- Legacy migration --------------------------------------------------------

assert(selectionFromLegacyPreference('dark').mode === 'fixed', 'legacy dark migrates to fixed mode')
assert(selectionFromLegacyPreference('light').fixedThemeId === 'light', 'legacy light migrates to the light theme')
assert(selectionFromLegacyPreference('system').mode === 'system', 'legacy system migrates to system mode')
assert(selectionFromLegacyPreference('system').systemLightThemeId === 'light', 'legacy system uses the default pair')

assert(
  readThemeSelection(storageOf({ [THEME_STORAGE_KEY]: 'light' }), THEME_STORAGE_KEY).fixedThemeId === 'light',
  'legacy preference is migrated on read',
)
const v2Wins = readThemeSelection(
  storageOf({
    [THEME_STORAGE_KEY]: 'light',
    [THEME_SELECTION_STORAGE_KEY]: JSON.stringify({
      mode: 'fixed',
      fixedThemeId: 'custom-night',
      systemLightThemeId: 'light',
      systemDarkThemeId: 'dark',
    }),
  }),
  THEME_STORAGE_KEY,
)
assert(v2Wins.fixedThemeId === 'custom-night', 'versioned selection wins over legacy preference')
assert(
  readThemeSelection(storageOf({ [THEME_SELECTION_STORAGE_KEY]: 'garbage' }), THEME_STORAGE_KEY).fixedThemeId
    === DEFAULT_THEME_SELECTION.fixedThemeId,
  'corrupt selection falls back to the default',
)
assert(readThemeSelection(null, THEME_STORAGE_KEY).mode === 'fixed', 'missing storage falls back to the default')
assert(
  readThemeSelection({ getItem: () => { throw new Error('disabled') } }, THEME_STORAGE_KEY).fixedThemeId === 'dark',
  'storage errors fall back to the default',
)

// --- Legacy write-back --------------------------------------------------------

assert(
  legacyPreferenceForSelection({ ...DEFAULT_THEME_SELECTION, fixedThemeId: 'custom-night' }, [customDark]) === 'dark',
  'fixed custom dark-family theme writes back as legacy dark',
)
assert(
  legacyPreferenceForSelection({ ...DEFAULT_THEME_SELECTION, fixedThemeId: 'custom-paper' }, [customLight]) === 'light',
  'fixed custom light-family theme writes back as legacy light',
)
assert(
  legacyPreferenceForSelection({ ...DEFAULT_THEME_SELECTION, mode: 'system' }, []) === 'system',
  'system mode writes back as legacy system',
)

// --- Active theme resolution ---------------------------------------------------

const pairSelection: ThemeSelection = {
  mode: 'system',
  fixedThemeId: 'dark',
  systemLightThemeId: 'custom-paper',
  systemDarkThemeId: 'custom-night',
}
assert(activeThemeIdForSelection(pairSelection, true) === 'custom-night', 'system+dark picks the dark slot')
assert(activeThemeIdForSelection(pairSelection, false) === 'custom-paper', 'system+light picks the light slot')
assert(
  activeThemeIdForSelection({ ...pairSelection, mode: 'fixed' }, true) === 'dark',
  'fixed mode ignores the system scheme',
)

const resolvedPairDark = resolveActiveTheme(pairSelection, true, [customDark, customLight])
assert(resolvedPairDark.id === 'custom-night' && resolvedPairDark.values.accent === '#ff8800', 'system pair resolves the custom dark theme')
const resolvedPairLight = resolveActiveTheme(pairSelection, false, [customDark, customLight])
assert(resolvedPairLight.id === 'custom-paper' && resolvedPairLight.family === 'light', 'system pair resolves the custom light theme')

const staleDark = resolveActiveTheme(pairSelection, true, [customLight])
assert(staleDark.id === 'dark', 'a stale dark-slot id falls back to built-in dark')
const staleLight = resolveActiveTheme(pairSelection, false, [customDark])
assert(staleLight.id === 'light', 'a stale light-slot id falls back to built-in light')

// --- Deletion fallback -----------------------------------------------------------

const afterDelete = selectionWithThemeRemoved(pairSelection, 'custom-night', 'dark')
assert(afterDelete.systemDarkThemeId === 'dark', 'deleting a theme rewrites the dark slot to its base')
assert(afterDelete.systemLightThemeId === 'custom-paper', 'unrelated slots are untouched')
const fixedDelete = selectionWithThemeRemoved(
  { ...DEFAULT_THEME_SELECTION, fixedThemeId: 'custom-night' },
  'custom-night',
  'dark',
)
assert(fixedDelete.fixedThemeId === 'dark', 'deleting the active fixed theme falls back to its base')

// --- Stored custom themes ----------------------------------------------------------

const sanitized = sanitizeStoredCustomThemes([
  customDark,
  { ...customDark },
  { ...customLight, overrides: { 'not-a-token': '#fff' } },
  { ...customLight, id: 'dark' },
  customLight,
  'garbage',
])
assert(sanitized.length === 2, 'invalid, duplicate, and builtin-shadowing entries are dropped')
assert(sanitized[0].id === 'custom-night' && sanitized[1].id === 'custom-paper', 'valid entries survive in order')

assert(
  readStoredCustomThemes(storageOf({ [CUSTOM_THEMES_STORAGE_KEY]: 'not json' })).length === 0,
  'corrupt custom theme storage yields an empty list',
)
assert(
  readStoredCustomThemes(storageOf({ [CUSTOM_THEMES_STORAGE_KEY]: JSON.stringify([customDark]) }))[0].id === 'custom-night',
  'stored custom themes load',
)

console.log('selection tests passed')
