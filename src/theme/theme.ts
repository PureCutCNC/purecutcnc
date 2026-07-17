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

import type { StorageCodec } from '../hooks/useLocalStorageState'
import { cssOverridesFromValues, type ResolvedThemeDefinition } from './registry'
import { themeTokenKeys } from './tokens'

export const THEME_STORAGE_KEY = 'purecutcnc.appearance.theme'
export const THEME_PREFERENCES = ['dark', 'light', 'system'] as const

export type ThemePreference = (typeof THEME_PREFERENCES)[number]
export type ResolvedTheme = Exclude<ThemePreference, 'system'>

export const themePreferenceCodec: StorageCodec<ThemePreference> = {
  serialize: (value) => value,
  deserialize: (raw) => {
    if (isThemePreference(raw)) return raw
    throw new Error(`Unsupported theme preference: ${raw}`)
  },
}

export function isThemePreference(value: string): value is ThemePreference {
  return THEME_PREFERENCES.some((preference) => preference === value)
}

export function resolveThemePreference(
  preference: ThemePreference,
  systemPrefersDark: boolean,
): ResolvedTheme {
  if (preference === 'system') return systemPrefersDark ? 'dark' : 'light'
  return preference
}

export interface ThemeRoot {
  dataset: {
    theme?: string
    themePreference?: string
    themeId?: string
  }
  style: {
    colorScheme: string
    setProperty(name: string, value: string): void
    removeProperty(name: string): void
  }
}

export function readThemePreference(
  storage: Pick<Storage, 'getItem'> | null,
): ThemePreference {
  if (!storage) return 'dark'
  try {
    const stored = storage.getItem(THEME_STORAGE_KEY)
    return stored && isThemePreference(stored) ? stored : 'dark'
  } catch {
    return 'dark'
  }
}

/**
 * Apply a resolved theme to the document root: the family drives the static
 * CSS block via `data-theme` and native controls via `color-scheme`, while
 * tokens that differ from the family built-in are set as inline custom
 * properties. Previous inline tokens are always cleared first, so switching
 * or cancelling a preview can never leave stale colors behind.
 */
export function applyResolvedThemeToRoot(
  root: ThemeRoot,
  mode: 'fixed' | 'system',
  resolved: ResolvedThemeDefinition,
): void {
  root.dataset.theme = resolved.family
  root.dataset.themePreference = mode === 'system' ? 'system' : resolved.family
  root.dataset.themeId = resolved.id
  root.style.colorScheme = resolved.family

  for (const key of themeTokenKeys('css')) {
    root.style.removeProperty(`--${key}`)
  }
  for (const [property, value] of Object.entries(cssOverridesFromValues(resolved.values, resolved.family))) {
    root.style.setProperty(property, value)
  }
}

export function getSystemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}
