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
  applyResolvedThemeToRoot,
  readThemePreference,
  resolveThemePreference,
  THEME_STORAGE_KEY,
  themePreferenceCodec,
  type ThemeRoot,
} from './theme'
import { THEME_PALETTES } from './palette'
import { resolveBuiltinTheme, resolveCustomTheme } from './registry'

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

function makeRoot(): ThemeRoot & { properties: Map<string, string> } {
  const properties = new Map<string, string>()
  return {
    dataset: {},
    properties,
    style: {
      colorScheme: '',
      setProperty: (name: string, value: string) => { properties.set(name, value) },
      removeProperty: (name: string) => { properties.delete(name) },
    },
  }
}

const root = makeRoot()
applyResolvedThemeToRoot(root, 'system', resolveBuiltinTheme('light'))
assert(root.dataset.theme === 'light', 'resolved family is written to data-theme')
assert(root.dataset.themePreference === 'system', 'selection mode is exposed for diagnostics')
assert(root.dataset.themeId === 'light', 'active theme id is exposed for diagnostics')
assert(root.style.colorScheme === 'light', 'native controls receive the resolved color scheme')
assert(root.properties.size === 0, 'built-in themes apply no inline overrides')

const customized = resolveCustomTheme({
  schemaVersion: 1,
  id: 'custom-test',
  name: 'Test',
  family: 'dark',
  baseThemeId: 'dark',
  overrides: { accent: '#ff8800' },
})
applyResolvedThemeToRoot(root, 'fixed', customized)
assert(root.dataset.theme === 'dark', 'custom theme applies its family')
assert(root.dataset.themePreference === 'dark', 'fixed mode reports the family for diagnostics')
assert(root.dataset.themeId === 'custom-test', 'custom theme id is exposed')
assert(root.properties.get('--accent') === '#ff8800', 'override lands as an inline custom property')
assert(root.properties.size === 1, 'only changed tokens are applied inline')

applyResolvedThemeToRoot(root, 'fixed', resolveBuiltinTheme('dark'))
assert(root.properties.size === 0, 'switching back to a built-in clears stale inline overrides')

assert(THEME_PALETTES.dark.canvas.background !== THEME_PALETTES.light.canvas.background, 'canvas palettes differ')
assert(THEME_PALETTES.dark.three.background !== THEME_PALETTES.light.three.background, 'Three palettes differ')

console.log('theme tests passed')
