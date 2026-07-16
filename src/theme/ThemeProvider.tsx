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

import { useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { useLocalStorageState } from '../hooks/useLocalStorageState'
import {
  applyThemeToRoot,
  getSystemPrefersDark,
  resolveThemePreference,
  THEME_STORAGE_KEY,
  themePreferenceCodec,
  type ThemePreference,
} from './theme'
import { ThemeContext, type ThemeContextValue } from './themeContext'

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useLocalStorageState<ThemePreference>(
    THEME_STORAGE_KEY,
    'dark',
    { codec: themePreferenceCodec },
  )
  const [systemPrefersDark, setSystemPrefersDark] = useState(getSystemPrefersDark)
  const resolvedTheme = resolveThemePreference(preference, systemPrefersDark)

  useLayoutEffect(() => {
    applyThemeToRoot(document.documentElement, preference, resolvedTheme)
  }, [preference, resolvedTheme])

  useEffect(() => {
    if (preference !== 'system' || typeof window.matchMedia !== 'function') return

    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const syncSystemTheme = () => setSystemPrefersDark(query.matches)
    syncSystemTheme()
    query.addEventListener('change', syncSystemTheme)
    return () => query.removeEventListener('change', syncSystemTheme)
  }, [preference])

  const value = useMemo<ThemeContextValue>(
    () => ({ preference, resolvedTheme, setPreference }),
    [preference, resolvedTheme, setPreference],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}
