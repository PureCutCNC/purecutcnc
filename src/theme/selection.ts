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

/**
 * Theme selection model: which theme is active in fixed mode, and which
 * light/dark pair System mode follows. Persisted in namespaced local storage
 * as application preferences (never in `.camj` project data). The legacy
 * `dark | light | system` preference from the first appearance release is
 * migrated on read and kept in sync on write so older builds stay usable.
 */

import type { StorageCodec } from '../hooks/useLocalStorageState'
import {
  isBuiltinThemeId,
  resolveThemeById,
  validateCustomTheme,
  type CustomThemeData,
  type ResolvedThemeDefinition,
} from './registry'
import { isThemePreference, type ThemePreference } from './theme'

export const THEME_SELECTION_STORAGE_KEY = 'purecutcnc.appearance.themeSelection'
export const CUSTOM_THEMES_STORAGE_KEY = 'purecutcnc.appearance.customThemes'

export type ThemeSelectionMode = 'fixed' | 'system'

/**
 * One record holds the fixed choice and the System pair so switching modes
 * never forgets the other configuration.
 */
export interface ThemeSelection {
  mode: ThemeSelectionMode
  fixedThemeId: string
  systemLightThemeId: string
  systemDarkThemeId: string
}

export const DEFAULT_THEME_SELECTION: ThemeSelection = {
  mode: 'fixed',
  fixedThemeId: 'dark',
  systemLightThemeId: 'light',
  systemDarkThemeId: 'dark',
}

function isValidSelection(value: unknown): value is ThemeSelection {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return (
    (record.mode === 'fixed' || record.mode === 'system')
    && typeof record.fixedThemeId === 'string' && record.fixedThemeId !== ''
    && typeof record.systemLightThemeId === 'string' && record.systemLightThemeId !== ''
    && typeof record.systemDarkThemeId === 'string' && record.systemDarkThemeId !== ''
  )
}

export const themeSelectionCodec: StorageCodec<ThemeSelection> = {
  serialize: (value) => JSON.stringify(value),
  deserialize: (raw) => {
    const parsed: unknown = JSON.parse(raw)
    if (isValidSelection(parsed)) {
      return {
        mode: parsed.mode,
        fixedThemeId: parsed.fixedThemeId,
        systemLightThemeId: parsed.systemLightThemeId,
        systemDarkThemeId: parsed.systemDarkThemeId,
      }
    }
    throw new Error('Unsupported theme selection payload')
  },
}

export function selectionFromLegacyPreference(preference: ThemePreference): ThemeSelection {
  if (preference === 'system') return { ...DEFAULT_THEME_SELECTION, mode: 'system' }
  return { ...DEFAULT_THEME_SELECTION, mode: 'fixed', fixedThemeId: preference }
}

/**
 * The closest legacy `dark | light | system` value for a selection, written
 * back to the original storage key so downgrading the app keeps a sensible
 * appearance.
 */
export function legacyPreferenceForSelection(
  selection: ThemeSelection,
  customThemes: readonly CustomThemeData[],
): ThemePreference {
  if (selection.mode === 'system') return 'system'
  return resolveThemeById(selection.fixedThemeId, customThemes).family
}

/**
 * Read the persisted selection: the versioned key wins, a legacy preference
 * migrates, and anything unreadable falls back to the default (Dark).
 */
export function readThemeSelection(
  storage: Pick<Storage, 'getItem'> | null,
  legacyStorageKey: string,
): ThemeSelection {
  if (!storage) return DEFAULT_THEME_SELECTION
  try {
    const stored = storage.getItem(THEME_SELECTION_STORAGE_KEY)
    if (stored !== null) return themeSelectionCodec.deserialize(stored)
  } catch {
    // Fall through to legacy migration.
  }
  try {
    const legacy = storage.getItem(legacyStorageKey)
    if (legacy !== null && isThemePreference(legacy)) return selectionFromLegacyPreference(legacy)
  } catch {
    // Storage unavailable — use the default.
  }
  return DEFAULT_THEME_SELECTION
}

/**
 * Parse the stored custom theme list. Invalid entries and duplicate IDs are
 * dropped individually so one corrupt record can never take down the whole
 * theme system.
 */
export function sanitizeStoredCustomThemes(raw: unknown): CustomThemeData[] {
  if (!Array.isArray(raw)) return []
  const themes: CustomThemeData[] = []
  const seen = new Set<string>()
  for (const entry of raw) {
    const validated = validateCustomTheme(entry)
    if (validated.ok !== undefined && !seen.has(validated.ok.id) && !isBuiltinThemeId(validated.ok.id)) {
      seen.add(validated.ok.id)
      themes.push(validated.ok)
    }
  }
  return themes
}

export const customThemesCodec: StorageCodec<CustomThemeData[]> = {
  serialize: (value) => JSON.stringify(value),
  deserialize: (raw) => sanitizeStoredCustomThemes(JSON.parse(raw)),
}

export function readStoredCustomThemes(storage: Pick<Storage, 'getItem'> | null): CustomThemeData[] {
  if (!storage) return []
  try {
    const stored = storage.getItem(CUSTOM_THEMES_STORAGE_KEY)
    if (stored === null) return []
    return customThemesCodec.deserialize(stored)
  } catch {
    return []
  }
}

/** The theme ID the selection activates for the current system scheme. */
export function activeThemeIdForSelection(selection: ThemeSelection, systemPrefersDark: boolean): string {
  if (selection.mode === 'system') {
    return systemPrefersDark ? selection.systemDarkThemeId : selection.systemLightThemeId
  }
  return selection.fixedThemeId
}

/**
 * Resolve the active theme for a selection. A stale ID (e.g. a custom theme
 * removed from storage out-of-band) falls back to the built-in matching the
 * slot's family so System mode keeps following the OS scheme.
 */
export function resolveActiveTheme(
  selection: ThemeSelection,
  systemPrefersDark: boolean,
  customThemes: readonly CustomThemeData[],
): ResolvedThemeDefinition {
  const id = activeThemeIdForSelection(selection, systemPrefersDark)
  const fallbackFamily = selection.mode === 'system'
    ? (systemPrefersDark ? 'dark' : 'light')
    : 'dark'
  return resolveThemeById(id, customThemes, fallbackFamily)
}

/**
 * Rewrite a selection after a custom theme is deleted: every slot referencing
 * the deleted theme explicitly falls back to that theme's base built-in.
 */
export function selectionWithThemeRemoved(
  selection: ThemeSelection,
  removedThemeId: string,
  baseThemeId: string,
): ThemeSelection {
  const replace = (id: string) => (id === removedThemeId ? baseThemeId : id)
  return {
    mode: selection.mode,
    fixedThemeId: replace(selection.fixedThemeId),
    systemLightThemeId: replace(selection.systemLightThemeId),
    systemDarkThemeId: replace(selection.systemDarkThemeId),
  }
}
