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

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  BUILTIN_THEMES,
  builtinTheme,
  cssOverridesFromValues,
  duplicateThemeAsCustom,
  duplicateThemeName,
  parseThemeImport,
  resolveBuiltinTheme,
  resolveCustomTheme,
  resolveThemeById,
  serializeThemeExport,
  themePaletteFromValues,
  validateCustomTheme,
  type CustomThemeData,
} from './registry'
import { themeTokenKeys } from './tokens'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// --- CSS ↔ registry sync -------------------------------------------------
// The built-in `css` values must stay byte-identical to src/index.css so the
// registry (editor base values, contrast checks) and the stylesheet cannot
// drift apart.

const indexCss = readFileSync(fileURLToPath(new URL('../index.css', import.meta.url)), 'utf8')

function cssBlockTokens(source: string, selector: string): Map<string, string> {
  const start = source.indexOf(selector)
  assert(start >= 0, `stylesheet contains "${selector}"`)
  const open = source.indexOf('{', start)
  const close = source.indexOf('}', open)
  const body = source.slice(open + 1, close)
  const tokens = new Map<string, string>()
  for (const match of body.matchAll(/--([a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    tokens.set(match[1], match[2].trim())
  }
  return tokens
}

const cssBlocks = {
  dark: cssBlockTokens(indexCss, ':root {'),
  light: cssBlockTokens(indexCss, ":root[data-theme='light']"),
}

for (const definition of BUILTIN_THEMES) {
  const block = cssBlocks[definition.family]
  const cssKeys = themeTokenKeys('css')
  assert(
    block.size === cssKeys.length,
    `index.css ${definition.family} block has ${block.size} tokens, registry allowlists ${cssKeys.length} — update both together`,
  )
  for (const key of cssKeys) {
    const cssValue = block.get(key)
    assert(cssValue !== undefined, `index.css ${definition.family} block defines --${key}`)
    assert(
      cssValue === definition.values[key],
      `--${key} matches for ${definition.id}: css "${cssValue}" vs registry "${definition.values[key]}"`,
    )
  }
}

// --- Built-in registry ----------------------------------------------------

assert(BUILTIN_THEMES.length === 2, 'two built-in themes are registered')
assert(builtinTheme('dark').family === 'dark' && builtinTheme('light').family === 'light', 'families are stable')
for (const definition of BUILTIN_THEMES) {
  for (const key of themeTokenKeys()) {
    assert(definition.values[key] !== undefined, `${definition.id} defines ${key}`)
  }
}
const resolvedDark = resolveBuiltinTheme('dark')
assert(resolvedDark.builtin && resolvedDark.overriddenKeys.length === 0, 'built-in resolves with no overrides')

// --- Palette conversion ---------------------------------------------------

const palette = themePaletteFromValues(resolvedDark.values)
assert(palette.three.background === 0x141820, 'three background converts to the historical number')
assert(palette.three.gridMajor === 0x51657a, 'three grid converts to the historical number')
assert(palette.canvas.background === '#0f151d', 'canvas background carries through')
assert(palette.canvas.veil === 'rgba(8, 12, 18, 0.5)', 'canvas alpha values carry through')

// --- Custom theme validation ----------------------------------------------

const validCustom: CustomThemeData = {
  schemaVersion: 1,
  id: 'custom-test-1',
  name: 'Workshop Amber',
  family: 'dark',
  baseThemeId: 'dark',
  overrides: { accent: '#ff8800', 'canvas.background': '#101418' },
}

assert(validateCustomTheme(validCustom).ok !== undefined, 'valid custom theme is accepted')
assert(validateCustomTheme(null).error !== undefined, 'null rejected')
assert(validateCustomTheme([]).error !== undefined, 'array rejected')
assert(
  validateCustomTheme({ ...validCustom, schemaVersion: 99 }).error!.includes('schema version'),
  'incompatible schema version is rejected with a readable error',
)
assert(
  validateCustomTheme({ ...validCustom, overrides: { 'not-a-token': '#fff' } }).error!.includes('Unknown theme token'),
  'unknown token is rejected',
)
assert(
  validateCustomTheme({ ...validCustom, overrides: { accent: 'javascript:alert(1)' } }).error!.includes('invalid color'),
  'non-color value is rejected',
)
assert(
  validateCustomTheme({ ...validCustom, overrides: { accent: 'url(http://x)' } }).error !== undefined,
  'css functions are rejected',
)
assert(
  validateCustomTheme({ ...validCustom, extraCss: '.panel { display: none }' }).error!.includes('Unknown theme property'),
  'arbitrary extra properties are rejected',
)
assert(
  validateCustomTheme({ ...validCustom, family: 'sepia' }).error !== undefined,
  'unknown family is rejected',
)
assert(
  validateCustomTheme({ ...validCustom, baseThemeId: 'custom-other' }).error !== undefined,
  'custom base theme id is rejected',
)
assert(
  validateCustomTheme({ ...validCustom, name: 'x'.repeat(100) }).error !== undefined,
  'over-long names are rejected',
)
const normalized = validateCustomTheme({ ...validCustom, overrides: { accent: 'rgb(255, 136, 0)' } })
assert(normalized.ok!.overrides.accent === '#ff8800', 'override colors are normalized on load')

// --- Resolution -----------------------------------------------------------

const resolvedCustom = resolveCustomTheme(validCustom)
assert(resolvedCustom.values.accent === '#ff8800', 'override wins over base value')
assert(resolvedCustom.values.text === builtinTheme('dark').values.text, 'unset tokens inherit the base')
assert(resolvedCustom.overriddenKeys.length === 2, 'overridden keys are tracked')
assert(resolvedCustom.baseThemeId === 'dark' && !resolvedCustom.builtin, 'custom resolution keeps identity')

const sameAsBase = resolveCustomTheme({ ...validCustom, overrides: { accent: builtinTheme('dark').values.accent } })
assert(sameAsBase.overriddenKeys.length === 0, 'override equal to base does not count as overridden')

assert(resolveThemeById('light', []).id === 'light', 'built-in id resolves')
assert(resolveThemeById('custom-test-1', [validCustom]).values.accent === '#ff8800', 'custom id resolves')
assert(resolveThemeById('missing-id', [], 'light').id === 'light', 'unknown id falls back to the requested family')

// --- CSS override projection ----------------------------------------------

const overrides = cssOverridesFromValues(resolvedCustom.values, resolvedCustom.family)
assert(overrides['--accent'] === '#ff8800', 'changed css token is projected as a custom property')
assert(Object.keys(overrides).length === 1, 'canvas/three overrides do not leak into css projection')
assert(
  Object.keys(cssOverridesFromValues(resolvedDark.values, 'dark')).length === 0,
  'built-in projects no inline overrides',
)

// --- Duplication ----------------------------------------------------------

assert(duplicateThemeName('Dark', ['Dark']) === 'Dark copy', 'first duplicate gets "copy"')
assert(duplicateThemeName('Dark', ['Dark', 'Dark copy']) === 'Dark copy 2', 'second duplicate counts up')
const duplicated = duplicateThemeAsCustom(resolvedCustom, ['Workshop Amber'])
assert(duplicated.id !== resolvedCustom.id, 'duplicate gets a fresh id')
assert(duplicated.overrides.accent === '#ff8800', 'duplicate keeps effective overrides')
assert(duplicated.baseThemeId === 'dark', 'duplicate keeps the built-in base')
const duplicatedBuiltin = duplicateThemeAsCustom(resolveBuiltinTheme('light'), [])
assert(duplicatedBuiltin.baseThemeId === 'light' && Object.keys(duplicatedBuiltin.overrides).length === 0,
  'duplicating a built-in starts from a clean override set')

// --- Import / export ------------------------------------------------------

const exported = serializeThemeExport(validCustom)
const reimported = parseThemeImport(exported)
assert(reimported.ok !== undefined, 'exported theme re-imports')
assert(reimported.ok!.name === 'Workshop Amber', 'import keeps the name')
assert(reimported.ok!.id !== validCustom.id, 'import always assigns a fresh id')
assert(reimported.ok!.overrides.accent === '#ff8800', 'import keeps overrides')

assert(parseThemeImport('not json').error !== undefined, 'non-JSON import is rejected')
assert(parseThemeImport('{"foo": 1}').error!.includes('format'), 'missing format marker is rejected')
assert(
  parseThemeImport(JSON.stringify({ format: 'purecutcnc-theme', schemaVersion: 2, theme: validCustom }))
    .error!.includes('schema version'),
  'newer schema version is rejected with a readable error',
)
assert(
  parseThemeImport(JSON.stringify({
    format: 'purecutcnc-theme',
    schemaVersion: 1,
    theme: { ...validCustom, overrides: { accent: 'expression(alert(1))' } },
  })).error !== undefined,
  'imports with invalid colors are rejected',
)

console.log('registry tests passed')
