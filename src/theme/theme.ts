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

interface ThemeRoot {
  dataset: {
    theme?: string
    themePreference?: string
  }
  style: {
    colorScheme: string
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

export function applyThemeToRoot(
  root: ThemeRoot,
  preference: ThemePreference,
  resolvedTheme: ResolvedTheme,
): void {
  root.dataset.theme = resolvedTheme
  root.dataset.themePreference = preference
  root.style.colorScheme = resolvedTheme
}

export function getSystemPrefersDark(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-color-scheme: dark)').matches
}

/** Applies the stored preference before React renders, preventing a theme flash. */
export function bootstrapTheme(): ThemePreference {
  if (typeof document === 'undefined') return 'dark'

  const storage = typeof window === 'undefined' ? null : window.localStorage
  const preference = readThemePreference(storage)
  const resolvedTheme = resolveThemePreference(preference, getSystemPrefersDark())
  applyThemeToRoot(document.documentElement, preference, resolvedTheme)
  return preference
}
