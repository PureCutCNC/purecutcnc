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
  readStoredCustomThemes,
  readThemeSelection,
  resolveActiveTheme,
} from './selection'
import { applyResolvedThemeToRoot, getSystemPrefersDark, THEME_STORAGE_KEY } from './theme'

/**
 * Applies the persisted theme selection — including custom-theme overrides
 * kept in namespaced local storage — before React renders, preventing an
 * incorrect-theme flash. Any storage failure falls back to built-in Dark.
 */
export function bootstrapTheme(): void {
  if (typeof document === 'undefined') return

  const storage = typeof window === 'undefined' ? null : window.localStorage
  const selection = readThemeSelection(storage, THEME_STORAGE_KEY)
  const customThemes = readStoredCustomThemes(storage)
  const resolved = resolveActiveTheme(selection, getSystemPrefersDark(), customThemes)
  applyResolvedThemeToRoot(document.documentElement, selection.mode, resolved)
}
