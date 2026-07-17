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

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import { useLocalStorageState, writeToStorage } from '../hooks/useLocalStorageState'
import { themePaletteFromValues } from './registry'
import type { CustomThemeData, ResolvedThemeDefinition } from './registry'
import {
  CUSTOM_THEMES_STORAGE_KEY,
  customThemesCodec,
  legacyPreferenceForSelection,
  readThemeSelection,
  resolveActiveTheme,
  THEME_SELECTION_STORAGE_KEY,
  themeSelectionCodec,
  type ThemeSelection,
} from './selection'
import {
  applyResolvedThemeToRoot,
  getSystemPrefersDark,
  THEME_STORAGE_KEY,
  type ThemePreference,
} from './theme'
import { ThemeContext, type ThemeContextValue } from './themeContext'
import { themeTokenKeys } from './tokens'

const PALETTE_TOKEN_KEYS = themeTokenKeys().filter(
  (key) => key.startsWith('canvas.') || key.startsWith('three.'),
)

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Migrate the legacy dark|light|system preference once: the versioned
  // selection key wins when present, and the very first selection write
  // persists the migrated model.
  const [initialSelection] = useState(() =>
    readThemeSelection(typeof window === 'undefined' ? null : window.localStorage, THEME_STORAGE_KEY),
  )
  const [selection, setSelection] = useLocalStorageState<ThemeSelection>(
    THEME_SELECTION_STORAGE_KEY,
    initialSelection,
    { codec: themeSelectionCodec },
  )
  const [customThemes, setCustomThemes] = useLocalStorageState<CustomThemeData[]>(
    CUSTOM_THEMES_STORAGE_KEY,
    [],
    { codec: customThemesCodec },
  )
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark)
  const [preview, setPreviewState] = useState<ResolvedThemeDefinition | null>(null)

  const activeTheme = useMemo(
    () => resolveActiveTheme(selection, systemPrefersDark, customThemes),
    [selection, systemPrefersDark, customThemes],
  )
  const displayedTheme = preview ?? activeTheme

  // Theme application is presentation-only: it retags the root and swaps
  // custom properties/palette colors. No project, geometry, toolpath, or
  // simulation state is touched here.
  useLayoutEffect(() => {
    applyResolvedThemeToRoot(document.documentElement, selection.mode, displayedTheme)
  }, [selection.mode, displayedTheme])

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const syncSystemTheme = () => setSystemPrefersDark(query.matches)
    syncSystemTheme()
    query.addEventListener('change', syncSystemTheme)
    return () => query.removeEventListener('change', syncSystemTheme)
  }, [])

  // Keep the legacy preference key in sync so downgrading the app (or the
  // pre-React bootstrap of an older build) still lands on a sensible theme.
  useEffect(() => {
    const legacy = legacyPreferenceForSelection(selection, customThemes)
    writeToStorage<ThemePreference>(
      typeof window === 'undefined' ? null : window.localStorage,
      THEME_STORAGE_KEY,
      legacy,
      { serialize: (value) => value },
    )
  }, [selection, customThemes])

  // Canvas/3D/simulation redraw when their palette colors change — keyed by
  // value so editing a UI-only token never forces a viewport rebuild.
  const paletteKey = PALETTE_TOKEN_KEYS.map((key) => displayedTheme.values[key]).join('|')
  const palette = useMemo(
    () => themePaletteFromValues(displayedTheme.values),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paletteKey is the value-identity of displayedTheme.values' palette subset
    [paletteKey],
  )

  const setPreference = useCallback((preference: ThemePreference) => {
    setSelection((previous) => {
      if (preference === 'system') return { ...previous, mode: 'system' }
      return { ...previous, mode: 'fixed', fixedThemeId: preference }
    })
  }, [setSelection])

  const activateTheme = useCallback((themeId: string) => {
    setSelection((previous) => ({ ...previous, mode: 'fixed', fixedThemeId: themeId }))
  }, [setSelection])

  const saveCustomTheme = useCallback((theme: CustomThemeData) => {
    setCustomThemes((previous) => {
      const index = previous.findIndex((existing) => existing.id === theme.id)
      if (index === -1) return [...previous, theme]
      const next = [...previous]
      next[index] = theme
      return next
    })
  }, [setCustomThemes])

  const deleteCustomTheme = useCallback((themeId: string) => {
    if (preview?.id === themeId) return
    const target = customThemes.find((theme) => theme.id === themeId)
    if (!target) return
    setCustomThemes((previous) => previous.filter((theme) => theme.id !== themeId))
    setSelection((previous) => {
      const replace = (id: string) => (id === themeId ? target.baseThemeId : id)
      return {
        mode: previous.mode,
        fixedThemeId: replace(previous.fixedThemeId),
        systemLightThemeId: replace(previous.systemLightThemeId),
        systemDarkThemeId: replace(previous.systemDarkThemeId),
      }
    })
  }, [preview, customThemes, setCustomThemes, setSelection])

  const setPreview = useCallback((theme: ResolvedThemeDefinition | null) => {
    setPreviewState(theme)
  }, [])

  const preference: ThemePreference = selection.mode === 'system' ? 'system' : activeTheme.family

  const value = useMemo<ThemeContextValue>(
    () => ({
      preference,
      resolvedTheme: displayedTheme.family,
      setPreference,
      selection,
      setSelection,
      customThemes,
      activeTheme,
      displayedTheme,
      palette,
      systemPrefersDark,
      activateTheme,
      saveCustomTheme,
      deleteCustomTheme,
      setPreview,
      isPreviewing: preview !== null,
    }),
    [
      preference,
      displayedTheme,
      setPreference,
      selection,
      setSelection,
      customThemes,
      activeTheme,
      palette,
      systemPrefersDark,
      activateTheme,
      saveCustomTheme,
      deleteCustomTheme,
      setPreview,
      preview,
    ],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
