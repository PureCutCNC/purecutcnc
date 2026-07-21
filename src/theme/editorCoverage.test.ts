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
 * Theme-editor coverage guard (issue #341).
 *
 * Adding a themeable colour touches three places that must stay in step:
 * the palette field, its `tokens.ts` entry, and the group the editor renders
 * it under. Miss the token entry and the colour silently resolves to
 * `undefined` at runtime AND never appears in the Theme Editor — invisible in
 * both directions. These assertions make that impossible to merge.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { THEME_PALETTES } from './palette'
import { THEME_TOKENS, THEME_TOKEN_GROUPS, editableThemeTokens, themeTokenKeys } from './tokens'
import { BUILTIN_THEMES } from './registry'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const tokenKeys = new Set<string>(themeTokenKeys())

// --- Palette fields must be themeable ------------------------------------
// Every runtime palette field needs a token, or it cannot be edited and
// `themePaletteFromValues` resolves it to undefined.

for (const name of Object.keys(THEME_PALETTES.dark.canvas)) {
  assert(
    tokenKeys.has(`canvas.${name}`),
    `CanvasThemePalette.${name} has no "canvas.${name}" entry in tokens.ts — `
    + 'it would render as undefined and be missing from the Theme Editor',
  )
}

for (const name of Object.keys(THEME_PALETTES.dark.three)) {
  assert(
    tokenKeys.has(`three.${name}`),
    `ThreeThemePalette.${name} has no "three.${name}" entry in tokens.ts — `
    + 'it would render as undefined and be missing from the Theme Editor',
  )
}

// --- Tokens must have a home in the palette ------------------------------

for (const key of themeTokenKeys('canvas')) {
  const name = key.slice('canvas.'.length)
  assert(name in THEME_PALETTES.dark.canvas, `Token ${key} has no CanvasThemePalette field`)
}

for (const key of themeTokenKeys('three')) {
  const name = key.slice('three.'.length)
  assert(name in THEME_PALETTES.dark.three, `Token ${key} has no ThreeThemePalette field`)
}

// --- Both palette families must define the same fields -------------------

for (const family of ['canvas', 'three'] as const) {
  const dark = Object.keys(THEME_PALETTES.dark[family]).sort().join(',')
  const light = Object.keys(THEME_PALETTES.light[family]).sort().join(',')
  assert(dark === light, `dark and light ${family} palettes declare different fields`)
}

// --- Every token is reachable in the editor ------------------------------
// ThemeEditorDialog renders THEME_TOKEN_GROUPS and lists each group's tokens,
// so a token in an undeclared group would never be shown.

const groupIds = new Set(THEME_TOKEN_GROUPS.map((group) => group.id))
for (const token of THEME_TOKENS) {
  assert(
    groupIds.has(token.group),
    `Token ${token.key} is in group "${token.group}", which the Theme Editor does not render`,
  )
  assert(token.label.trim() !== '', `Token ${token.key} has an empty label`)
}

for (const group of THEME_TOKEN_GROUPS) {
  assert(
    editableThemeTokens().some((token) => token.group === group.id),
    `Theme Editor group "${group.id}" has no editable tokens and would render empty`,
  )
}

// --- Every token must actually be consumed -------------------------------
// A token nothing reads is a dead control: the user edits it in the Theme
// Editor and nothing changes. Such a token must either be wired up, or marked
// `deprecated` so it is hidden from the editor while still importing cleanly
// from themes saved by older builds.

const SRC = fileURLToPath(new URL('..', import.meta.url))

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walk(full, out)
      continue
    }
    if (/\.(ts|tsx|css)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry)) out.push(full)
  }
  return out
}

// The theme layer defines and plumbs tokens generically, so it never counts as
// a consumer — otherwise every token would look used by its own definition.
const consumers = walk(SRC)
  .filter((file) => !relative(SRC, file).startsWith('theme/'))
  .map((file) => readFileSync(file, 'utf8'))

function isConsumed(token: (typeof THEME_TOKENS)[number]): boolean {
  if (token.kind === 'css') return consumers.some((text) => text.includes(`var(--${token.key})`))
  const name = token.key.slice(token.key.indexOf('.') + 1)
  const pattern = new RegExp(`\\b${name}\\b`)
  return consumers.some((text) => pattern.test(text))
}

for (const token of THEME_TOKENS) {
  const consumed = isConsumed(token)
  if (token.deprecated === undefined) {
    assert(
      consumed,
      `Token ${token.key} is not read anywhere, so editing it in the Theme Editor does nothing. `
      + 'Wire it up, delete it, or mark it deprecated with a reason in tokens.ts.',
    )
  } else {
    assert(
      !consumed,
      `Token ${token.key} is marked deprecated but is still read — drop the deprecation note.`,
    )
  }
}

// --- Built-ins must resolve every token to a real value ------------------

for (const theme of BUILTIN_THEMES) {
  for (const key of themeTokenKeys()) {
    const value = theme.values[key]
    assert(
      typeof value === 'string' && value.trim() !== '',
      `Built-in theme "${theme.id}" has no value for token ${key}`,
    )
  }
}

const deprecatedCount = THEME_TOKENS.length - editableThemeTokens().length
console.log(
  `editorCoverage tests passed (${editableThemeTokens().length} editable tokens across `
  + `${THEME_TOKEN_GROUPS.length} groups, ${deprecatedCount} deprecated and hidden)`,
)
