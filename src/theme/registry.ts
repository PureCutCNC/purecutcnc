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
 * Versioned theme registry. Built-in themes are complete, code-owned,
 * immutable definitions; a custom theme stores only a base built-in ID plus
 * allowlisted token overrides, and is resolved to a complete palette here.
 *
 * The `css`-kind values of the built-ins mirror the `:root` blocks in
 * `src/index.css` (enforced by a structural test); `canvas`/`three` values
 * come from `THEME_PALETTES`. A future curated theme is a new declarative
 * definition in this file — never a component-specific CSS branch.
 */

import { normalizeColorValue, parseColor } from './color'
import { THEME_PALETTES, type ThemePalette } from './palette'
import { isThemeTokenKey, themeTokenKeys, type ThemeTokenKey } from './tokens'

export type ThemeFamily = 'dark' | 'light'

export const BUILTIN_THEME_IDS = ['dark', 'light'] as const
export type BuiltinThemeId = (typeof BUILTIN_THEME_IDS)[number]

export function isBuiltinThemeId(id: string): id is BuiltinThemeId {
  return BUILTIN_THEME_IDS.some((builtin) => builtin === id)
}

/** Complete token → color value map for one theme. */
export type ThemeValues = Record<ThemeTokenKey, string>

export interface BuiltinThemeDefinition {
  id: BuiltinThemeId
  name: string
  detail: string
  family: ThemeFamily
  values: ThemeValues
}

function threeHex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`
}

function paletteValues(family: ThemeFamily): Record<string, string> {
  const palette = THEME_PALETTES[family]
  return {
    'canvas.background': palette.canvas.background,
    'canvas.gridMajor': palette.canvas.gridMajor,
    'canvas.gridMinor': palette.canvas.gridMinor,
    'canvas.labelBackground': palette.canvas.labelBackground,
    'canvas.labelText': palette.canvas.labelText,
    'canvas.mutedGeometry': palette.canvas.mutedGeometry,
    'canvas.veil': palette.canvas.veil,
    'three.background': threeHex(palette.three.background),
    'three.gridMinorCenter': threeHex(palette.three.gridMinorCenter),
    'three.gridMinor': threeHex(palette.three.gridMinor),
    'three.gridMajorCenter': threeHex(palette.three.gridMajorCenter),
    'three.gridMajor': threeHex(palette.three.gridMajor),
  }
}

/**
 * Built-in `css` token values. These must stay byte-identical to the
 * `:root` / `:root[data-theme='light']` declarations in `src/index.css`;
 * `registry.test.ts` parses that file and fails on any drift.
 */
const DARK_CSS_VALUES: Record<string, string> = {
  bg: '#0a1016',
  'bg-elev-1': '#101821',
  'bg-elev-2': '#16222d',
  line: '#2a3a49',
  'line-strong': '#3c5265',
  text: '#d8e4ef',
  'text-dim': '#94aabc',
  'status-text': '#d8e4ef',
  'status-text-muted': '#aebfcd',
  accent: '#dca56a',
  'accent-strong': '#eab982',
  add: '#6abb81',
  cut: '#5a8fcc',
  'surface-app': '#0a1016',
  'surface-canvas': '#0f151d',
  'surface-panel': '#0f1820',
  'surface-subtle': '#0d141c',
  'surface-raised': 'rgba(16, 24, 33, 0.94)',
  'surface-popover': 'rgba(12, 18, 26, 0.96)',
  'surface-translucent': 'rgba(10, 18, 27, 0.85)',
  'surface-input': 'rgba(7, 12, 17, 0.72)',
  'surface-hover': 'rgba(255, 255, 255, 0.06)',
  'surface-control-top': '#2a3a4c',
  'surface-control-bottom': '#17232f',
  'surface-button-top': '#24374a',
  'surface-button-bottom': '#13202c',
  'surface-sheen': 'rgba(255, 255, 255, 0.04)',
  'surface-sheen-soft': 'rgba(255, 255, 255, 0.03)',
  'surface-sheen-mid': 'rgba(255, 255, 255, 0.05)',
  'surface-sheen-strong': 'rgba(255, 255, 255, 0.08)',
  'surface-inset': 'rgba(0, 0, 0, 0.28)',
  shadow: 'rgba(0, 0, 0, 0.35)',
  'shadow-strong': 'rgba(0, 0, 0, 0.45)',
  'accent-soft': 'rgba(220, 165, 106, 0.12)',
  'surface-active-top': '#3d4f61',
  'surface-active-bottom': '#202d3a',
  'on-accent': '#fff',
  'danger-text': '#f0bbb6',
  'warning-text': '#f7b86a',
  'role-line': '#5a8fcc',
  'role-line-text': '#8fb6f4',
  'role-region': '#9966cc',
  'role-region-text': '#c4a6e0',
  'role-construction': '#8a9aab',
  'role-construction-text': '#a9b6c4',
}

const LIGHT_CSS_VALUES: Record<string, string> = {
  bg: '#eee8dd',
  'bg-elev-1': '#f8f4ec',
  'bg-elev-2': '#e5ddcf',
  line: '#c9bdab',
  'line-strong': '#a99a84',
  text: '#253039',
  'text-dim': '#657078',
  'status-text': '#253039',
  'status-text-muted': '#4f5a61',
  accent: '#a66126',
  'accent-strong': '#874717',
  add: '#39794d',
  cut: '#356f9d',
  'surface-app': '#eee8dd',
  'surface-canvas': '#f6f1e7',
  'surface-panel': '#f9f5ed',
  'surface-subtle': '#e9e1d4',
  'surface-raised': 'rgba(252, 249, 242, 0.97)',
  'surface-popover': 'rgba(252, 249, 242, 0.98)',
  'surface-translucent': 'rgba(247, 243, 235, 0.94)',
  'surface-input': 'rgba(255, 252, 247, 0.94)',
  'surface-hover': 'rgba(88, 70, 46, 0.08)',
  'surface-control-top': '#fdfaf4',
  'surface-control-bottom': '#e5dccd',
  'surface-button-top': '#f8f3e9',
  'surface-button-bottom': '#ddd3c3',
  'surface-sheen': 'rgba(255, 255, 255, 0.54)',
  'surface-sheen-soft': 'rgba(255, 255, 255, 0.34)',
  'surface-sheen-mid': 'rgba(255, 255, 255, 0.46)',
  'surface-sheen-strong': 'rgba(255, 255, 255, 0.72)',
  'surface-inset': 'rgba(69, 54, 36, 0.13)',
  shadow: 'rgba(55, 43, 28, 0.18)',
  'shadow-strong': 'rgba(55, 43, 28, 0.24)',
  'accent-soft': 'rgba(166, 97, 38, 0.12)',
  'surface-active-top': '#ead6bf',
  'surface-active-bottom': '#cbb293',
  'on-accent': '#fffaf3',
  'danger-text': '#91443e',
  'warning-text': '#8b4c17',
  'role-line': '#356f9d',
  'role-line-text': '#285d87',
  'role-region': '#7947a5',
  'role-region-text': '#673b8c',
  'role-construction': '#60778b',
  'role-construction-text': '#4e6477',
}

function completeValues(family: ThemeFamily, cssValues: Record<string, string>): ThemeValues {
  const merged: Record<string, string> = { ...cssValues, ...paletteValues(family) }
  const values = {} as Record<ThemeTokenKey, string>
  for (const key of themeTokenKeys()) {
    const value = merged[key]
    if (value === undefined) throw new Error(`Built-in ${family} theme is missing token: ${key}`)
    values[key] = value
  }
  return values
}

export const BUILTIN_THEMES: readonly BuiltinThemeDefinition[] = [
  {
    id: 'dark',
    name: 'Dark',
    detail: 'Low-light workshop',
    family: 'dark',
    values: completeValues('dark', DARK_CSS_VALUES),
  },
  {
    id: 'light',
    name: 'Light',
    detail: 'Drafting paper',
    family: 'light',
    values: completeValues('light', LIGHT_CSS_VALUES),
  },
] as const

export function builtinTheme(id: BuiltinThemeId): BuiltinThemeDefinition {
  const theme = BUILTIN_THEMES.find((definition) => definition.id === id)
  if (!theme) throw new Error(`Unknown built-in theme: ${id}`)
  return theme
}

export const CUSTOM_THEME_SCHEMA_VERSION = 1

/** A user-created theme: application-local preference data, never project data. */
export interface CustomThemeData {
  schemaVersion: typeof CUSTOM_THEME_SCHEMA_VERSION
  id: string
  name: string
  family: ThemeFamily
  baseThemeId: BuiltinThemeId
  overrides: Partial<Record<ThemeTokenKey, string>>
}

export type ThemeValidationResult =
  | { ok: CustomThemeData; error?: undefined }
  | { ok?: undefined; error: string }

export const THEME_NAME_MAX_LENGTH = 60

const ALLOWED_CUSTOM_THEME_KEYS = new Set([
  'schemaVersion',
  'id',
  'name',
  'family',
  'baseThemeId',
  'overrides',
])

/**
 * Validate untrusted custom-theme data (storage, import). Unknown tokens,
 * invalid color values, unknown properties, and incompatible schema versions
 * are rejected with a readable message. Color values are normalized so stored
 * data stays canonical.
 */
export function validateCustomTheme(input: unknown): ThemeValidationResult {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { error: 'Theme must be a JSON object.' }
  }
  const record = input as Record<string, unknown>

  for (const key of Object.keys(record)) {
    if (!ALLOWED_CUSTOM_THEME_KEYS.has(key)) {
      return { error: `Unknown theme property: "${key}".` }
    }
  }

  if (record.schemaVersion !== CUSTOM_THEME_SCHEMA_VERSION) {
    return {
      error: `Unsupported theme schema version: ${String(record.schemaVersion)}. This app supports version ${CUSTOM_THEME_SCHEMA_VERSION}.`,
    }
  }
  if (typeof record.id !== 'string' || record.id.trim() === '') {
    return { error: 'Theme is missing a valid "id".' }
  }
  const name = typeof record.name === 'string' ? record.name.trim() : ''
  if (name === '') {
    return { error: 'Theme is missing a display "name".' }
  }
  if (name.length > THEME_NAME_MAX_LENGTH) {
    return { error: `Theme name is longer than ${THEME_NAME_MAX_LENGTH} characters.` }
  }
  if (record.family !== 'dark' && record.family !== 'light') {
    return { error: 'Theme "family" must be "dark" or "light".' }
  }
  if (typeof record.baseThemeId !== 'string' || !isBuiltinThemeId(record.baseThemeId)) {
    return { error: `Theme "baseThemeId" must be a built-in theme (${BUILTIN_THEME_IDS.join(', ')}).` }
  }
  if (typeof record.overrides !== 'object' || record.overrides === null || Array.isArray(record.overrides)) {
    return { error: 'Theme "overrides" must be an object of token colors.' }
  }

  const overrides: Partial<Record<ThemeTokenKey, string>> = {}
  for (const [key, value] of Object.entries(record.overrides as Record<string, unknown>)) {
    if (!isThemeTokenKey(key)) {
      return { error: `Unknown theme token: "${key}". Only allowlisted semantic colors can be themed.` }
    }
    if (typeof value !== 'string') {
      return { error: `Token "${key}" must be a color string.` }
    }
    const normalized = normalizeColorValue(value)
    if (normalized === null) {
      return { error: `Token "${key}" has an invalid color value: "${value}". Use hex or rgb()/rgba().` }
    }
    overrides[key] = normalized
  }

  return {
    ok: {
      schemaVersion: CUSTOM_THEME_SCHEMA_VERSION,
      id: record.id.trim(),
      name,
      family: record.family,
      baseThemeId: record.baseThemeId,
      overrides,
    },
  }
}

/** A theme resolved to its complete runtime palette. */
export interface ResolvedThemeDefinition {
  id: string
  name: string
  family: ThemeFamily
  builtin: boolean
  baseThemeId: BuiltinThemeId
  values: ThemeValues
  overriddenKeys: ThemeTokenKey[]
}

export function resolveBuiltinTheme(id: BuiltinThemeId): ResolvedThemeDefinition {
  const definition = builtinTheme(id)
  return {
    id: definition.id,
    name: definition.name,
    family: definition.family,
    builtin: true,
    baseThemeId: definition.id,
    values: { ...definition.values },
    overriddenKeys: [],
  }
}

export function resolveCustomTheme(custom: CustomThemeData): ResolvedThemeDefinition {
  const base = builtinTheme(custom.baseThemeId)
  const values = { ...base.values }
  const overriddenKeys: ThemeTokenKey[] = []
  for (const key of themeTokenKeys()) {
    const override = custom.overrides[key]
    if (override !== undefined && override !== base.values[key]) {
      values[key] = override
      overriddenKeys.push(key)
    }
  }
  return {
    id: custom.id,
    name: custom.name,
    family: custom.family,
    builtin: false,
    baseThemeId: custom.baseThemeId,
    values,
    overriddenKeys,
  }
}

/**
 * Resolve any theme ID to a complete palette. Unknown IDs (e.g. a deleted
 * custom theme referenced by a stale preference) fall back to the built-in
 * of the requested fallback family so the app always has a readable theme.
 */
export function resolveThemeById(
  id: string,
  customThemes: readonly CustomThemeData[],
  fallbackFamily: ThemeFamily = 'dark',
): ResolvedThemeDefinition {
  if (isBuiltinThemeId(id)) return resolveBuiltinTheme(id)
  const custom = customThemes.find((theme) => theme.id === id)
  if (custom) return resolveCustomTheme(custom)
  return resolveBuiltinTheme(fallbackFamily)
}

/** Convert a complete value map into the runtime canvas/Three palette shape. */
export function themePaletteFromValues(values: ThemeValues): ThemePalette {
  const threeNumber = (key: ThemeTokenKey): number => {
    const parsed = parseColor(values[key])
    if (!parsed) return 0
    return (parsed.r << 16) | (parsed.g << 8) | parsed.b
  }
  return {
    canvas: {
      background: values['canvas.background'],
      gridMajor: values['canvas.gridMajor'],
      gridMinor: values['canvas.gridMinor'],
      labelBackground: values['canvas.labelBackground'],
      labelText: values['canvas.labelText'],
      mutedGeometry: values['canvas.mutedGeometry'],
      veil: values['canvas.veil'],
    },
    three: {
      background: threeNumber('three.background'),
      gridMinorCenter: threeNumber('three.gridMinorCenter'),
      gridMinor: threeNumber('three.gridMinor'),
      gridMajorCenter: threeNumber('three.gridMajorCenter'),
      gridMajor: threeNumber('three.gridMajor'),
    },
  }
}

/**
 * The `--*` custom properties a resolved theme needs inline on the root,
 * on top of the family's static CSS block: exactly the `css`-kind values
 * that differ from the family built-in.
 */
export function cssOverridesFromValues(values: ThemeValues, family: ThemeFamily): Record<string, string> {
  const base = builtinTheme(family).values
  const overrides: Record<string, string> = {}
  for (const key of themeTokenKeys('css')) {
    if (values[key] !== base[key]) overrides[`--${key}`] = values[key]
  }
  return overrides
}

export function createCustomThemeId(): string {
  const cryptoApi = typeof globalThis.crypto !== 'undefined' ? globalThis.crypto : undefined
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return `custom-${cryptoApi.randomUUID()}`
  }
  return `custom-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

/** A unique "Name copy"/"Name copy 2" style name for a duplicated theme. */
export function duplicateThemeName(sourceName: string, existingNames: readonly string[]): string {
  const taken = new Set(existingNames.map((name) => name.toLowerCase()))
  const base = `${sourceName} copy`.slice(0, THEME_NAME_MAX_LENGTH)
  if (!taken.has(base.toLowerCase())) return base
  for (let n = 2; ; n += 1) {
    const suffix = ` ${n}`
    const candidate = `${sourceName} copy`.slice(0, THEME_NAME_MAX_LENGTH - suffix.length) + suffix
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

/** Duplicate any resolved theme into a new editable custom theme. */
export function duplicateThemeAsCustom(
  source: ResolvedThemeDefinition,
  existingNames: readonly string[],
): CustomThemeData {
  const base = builtinTheme(source.baseThemeId)
  const overrides: Partial<Record<ThemeTokenKey, string>> = {}
  for (const key of themeTokenKeys()) {
    if (source.values[key] !== base.values[key]) overrides[key] = source.values[key]
  }
  return {
    schemaVersion: CUSTOM_THEME_SCHEMA_VERSION,
    id: createCustomThemeId(),
    name: duplicateThemeName(source.name, existingNames),
    family: source.family,
    baseThemeId: source.baseThemeId,
    overrides,
  }
}

export const THEME_EXPORT_FORMAT = 'purecutcnc-theme'

interface ThemeExportEnvelope {
  format: typeof THEME_EXPORT_FORMAT
  schemaVersion: typeof CUSTOM_THEME_SCHEMA_VERSION
  theme: CustomThemeData
}

export function serializeThemeExport(theme: CustomThemeData): string {
  const envelope: ThemeExportEnvelope = {
    format: THEME_EXPORT_FORMAT,
    schemaVersion: CUSTOM_THEME_SCHEMA_VERSION,
    theme,
  }
  return JSON.stringify(envelope, null, 2)
}

/**
 * Parse and validate an imported theme JSON file. The imported theme keeps
 * its colors but always receives a fresh local ID so it can never collide
 * with an existing theme.
 */
export function parseThemeImport(json: string): ThemeValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { error: 'Not a valid JSON file.' }
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { error: 'Theme file must contain a JSON object.' }
  }
  const record = parsed as Record<string, unknown>
  if (record.format !== THEME_EXPORT_FORMAT) {
    return { error: `Not a PureCutCNC theme file (missing "format": "${THEME_EXPORT_FORMAT}").` }
  }
  if (record.schemaVersion !== CUSTOM_THEME_SCHEMA_VERSION) {
    return {
      error: `Unsupported theme schema version: ${String(record.schemaVersion)}. This app supports version ${CUSTOM_THEME_SCHEMA_VERSION}.`,
    }
  }
  const validated = validateCustomTheme(record.theme)
  if (validated.error !== undefined) return validated
  return { ok: { ...validated.ok, id: createCustomThemeId() } }
}
