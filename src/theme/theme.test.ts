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
  applyThemeToRoot,
  readThemePreference,
  resolveThemePreference,
  THEME_STORAGE_KEY,
  themePreferenceCodec,
} from './theme'
import { THEME_PALETTES } from './palette'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

assert(resolveThemePreference('dark', false) === 'dark', 'dark stays dark')
assert(resolveThemePreference('light', true) === 'light', 'light stays light')
assert(resolveThemePreference('system', true) === 'dark', 'system follows dark media')
assert(resolveThemePreference('system', false) === 'light', 'system follows light media')

const storage = {
  getItem: (key: string) => key === THEME_STORAGE_KEY ? 'system' : null,
}
assert(readThemePreference(storage) === 'system', 'stored system preference is restored')
assert(readThemePreference({ getItem: () => 'unknown' }) === 'dark', 'invalid preference falls back')
assert(readThemePreference({ getItem: () => { throw new Error('disabled') } }) === 'dark', 'storage errors fall back')
assert(themePreferenceCodec.deserialize(themePreferenceCodec.serialize('light')) === 'light', 'codec round-trips')

const root: {
  dataset: { theme?: string; themePreference?: string }
  style: { colorScheme: string }
} = { dataset: {}, style: { colorScheme: '' } }
applyThemeToRoot(root, 'system', 'light')
assert(root.dataset.theme === 'light', 'resolved theme is written to data-theme')
assert(root.dataset.themePreference === 'system', 'preference is exposed for diagnostics')
assert(root.style.colorScheme === 'light', 'native controls receive the resolved color scheme')

assert(THEME_PALETTES.dark.canvas.background !== THEME_PALETTES.light.canvas.background, 'canvas palettes differ')
assert(THEME_PALETTES.dark.three.background !== THEME_PALETTES.light.three.background, 'Three palettes differ')

console.log('theme tests passed')
