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

import { createContext, useContext, type Dispatch, type SetStateAction } from 'react'
import type { ThemePalette } from './palette'
import type { CustomThemeData, ResolvedThemeDefinition } from './registry'
import type { ThemeSelection } from './selection'
import type { ResolvedTheme, ThemePreference } from './theme'

export interface ThemeContextValue {
  /** Legacy quick-preference view of the selection (`system` or the active family). */
  preference: ThemePreference
  /** Family of the theme currently displayed (preview-aware). */
  resolvedTheme: ResolvedTheme
  /** Quick selector: `dark`/`light` activate the built-ins, `system` follows the OS pair. */
  setPreference: (preference: ThemePreference) => void

  /** Full selection model (fixed theme + System pair). */
  selection: ThemeSelection
  setSelection: Dispatch<SetStateAction<ThemeSelection>>
  /** Locally saved custom themes. */
  customThemes: CustomThemeData[]
  /** The saved active theme (ignores any preview). */
  activeTheme: ResolvedThemeDefinition
  /** The theme currently displayed: an in-flight preview, or the active theme. */
  displayedTheme: ResolvedThemeDefinition
  /** Canvas/Three palette of the displayed theme. */
  palette: ThemePalette
  systemPrefersDark: boolean

  /** Activate a theme as the fixed selection. */
  activateTheme: (themeId: string) => void
  /** Insert or update a custom theme by id. */
  saveCustomTheme: (theme: CustomThemeData) => void
  /**
   * Delete a custom theme. Any selection slot referencing it explicitly
   * falls back to the theme's base built-in. Ignored while that theme is
   * being previewed (close the editor first).
   */
  deleteCustomTheme: (themeId: string) => void
  /**
   * Show a theme without persisting anything. Pass `null` to restore the
   * active theme. Preview state never touches storage, so reload/cancel
   * always returns to the last saved theme.
   */
  setPreview: (theme: ResolvedThemeDefinition | null) => void
  isPreviewing: boolean
}

export const ThemeContext = createContext<ThemeContextValue | null>(null)

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext)
  if (!value) throw new Error('useTheme must be used inside ThemeProvider')
  return value
}
