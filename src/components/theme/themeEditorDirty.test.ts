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
 * The theme editor only offers Apply when the theme really differs from the one
 * it opened on (issue #1112 F4).
 *
 * Apply saves the custom theme, so an untouched editor used to record an
 * unchanged custom theme. This drives the real dialog: unchanged is disabled,
 * a renamed theme enables it, typing the name back disables it again, a colour
 * edit enables it, and a per-field reset back to the base disables it — while
 * the contrast gate still blocks a theme that fails its checks.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/theme/themeEditorDirty.test.ts
 */

import React from 'react'
import { parseHTML } from 'linkedom'

const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
globals.window = window
globals.document = document
globals.HTMLElement = window.HTMLElement
globals.Element = window.Element
globals.Node = window.Node
if (typeof globals.navigator === 'undefined') {
  globals.navigator = { language: 'en', languages: ['en'], userAgent: 'node', platform: '' }
}
// React decides once, when it first imports, whether an `input` event can drive
// `onChange` (`'oninput' in document`). linkedom's document has no `oninput`, so
// without this every controlled field would fall back to the legacy change path
// and take no edits at all — a silently inert test.
if (!('oninput' in (document as unknown as object))) {
  Object.defineProperty(document, 'oninput', { value: null, writable: true, configurable: true })
}
globals.React = React

const { createRoot } = await import('react-dom/client')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { ThemeContext } = await import('../../theme/themeContext')
const { ThemeEditorDialog } = await import('./ThemeEditorDialog')
const registry = await import('../../theme/registry')
type CustomThemeData = import('../../theme/registry').CustomThemeData
const { formHasChanges } = await import('../common/formDraft')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

const dom = window as unknown as {
  Event: new (type: string, init?: { bubbles?: boolean }) => object
  HTMLInputElement: { prototype: { value: string } }
}

/** A saved custom dark theme: the built-in values with one colour overridden. */
const savedTheme: CustomThemeData = {
  schemaVersion: registry.CUSTOM_THEME_SCHEMA_VERSION,
  id: 'custom-dark',
  name: 'My workshop',
  family: 'dark',
  baseThemeId: 'dark',
  overrides: { 'canvas.background': '#101418' },
}

interface Mounted {
  applied: () => number
  unmount: () => void
}

async function mountEditor(): Promise<Mounted> {
  const applied: unknown[] = []
  const previews: unknown[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  // Only the preview channel is used by the editor; the rest of the provider's
  // value is irrelevant here and would need storage and a media query.
  const themeValue = {
    setPreview: (theme: unknown) => { previews.push(theme) },
  } as unknown as React.ContextType<typeof ThemeContext>
  root.render(React.createElement(I18nProvider, null, React.createElement(ThemeContext.Provider, { value: themeValue },
    React.createElement(ThemeEditorDialog, {
      theme: savedTheme,
      onApply: (theme: unknown) => { applied.push(theme) },
      onClose: () => undefined,
    }),
  )))
  await flush()
  return {
    applied: () => applied.length,
    unmount: () => {
      root.unmount()
      host.remove()
    },
  }
}

function applyButton(): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button'))
    .find((candidate) => (candidate.textContent ?? '').trim() === 'Apply theme')
  assert(button, 'the editor has an Apply theme button')
  return button as unknown as HTMLButtonElement
}

function nameField(): HTMLInputElement {
  const field = document.body.querySelector('#theme-editor-name-input')
  assert(field, 'the editor has a name field')
  return field as unknown as HTMLInputElement
}

/** The text half of the colour row whose label starts with `label`. */
function colorField(label: string): { text: HTMLInputElement; reset: HTMLButtonElement } {
  const row = Array.from(document.body.querySelectorAll('.theme-editor-row'))
    .find((candidate) => (candidate.querySelector('.theme-editor-row__label')?.textContent ?? '').trim() === label)
  assert(row, `the editor has a ${label} colour row`)
  const text = row.querySelector('input.theme-editor-row__value')
  const reset = row.querySelector('button.theme-editor-row__reset')
  assert(text && reset, `the ${label} row has a value field and a reset`)
  return { text: text as unknown as HTMLInputElement, reset: reset as unknown as HTMLButtonElement }
}

/** Set a field the way typing does: value first, then the event React listens for. */
function typeInto(field: HTMLInputElement, value: string): void {
  if (!field.getAttribute('type')) field.setAttribute('type', 'text')
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set
  assert(setter, 'linkedom has an input value setter')
  setter.call(field, value)
  field.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
}

// ── Unchanged → disabled ────────────────────────────────────────────

{
  const dialog = await mountEditor()
  assert(applyButton().disabled, 'an untouched theme has Apply disabled')
  applyButton().click()
  await flush()
  assert(dialog.applied() === 0, 'clicking a disabled Apply writes nothing')
  dialog.unmount()
}

// ── A renamed theme enables it, the saved name disables it ──────────

{
  const dialog = await mountEditor()
  typeInto(nameField(), 'My workshop 2')
  await flush()
  assert(!applyButton().disabled, 'a changed name enables Apply')

  typeInto(nameField(), '  My workshop  ')
  await flush()
  assert(applyButton().disabled, 'the saved name, padded, disables Apply again')
  dialog.unmount()
}

// ── A colour edit, and resetting it back to the base ────────────────

{
  const dialog = await mountEditor()
  const { text, reset } = colorField('Canvas background')
  typeInto(text, '#202830')
  await flush()
  assert(!applyButton().disabled, 'a changed colour enables Apply')

  // Undoing the change by hand is not the same as resetting to the base: the
  // saved theme carries an override for this token, so clearing it is a change.
  reset.click()
  await flush()
  assert(!applyButton().disabled, 'dropping the saved override is a change')

  // Restoring the saved value leaves nothing to save.
  typeInto(text, '#101418')
  await flush()
  assert(applyButton().disabled, 'the saved colour disables Apply again')
  dialog.unmount()
}

// ── An enabled Apply writes the theme ───────────────────────────────

{
  const dialog = await mountEditor()
  typeInto(nameField(), 'My workshop 2')
  await flush()
  applyButton().click()
  await flush()
  assert(dialog.applied() === 1, 'an enabled Apply writes once')
  dialog.unmount()
}

// ── A blocked theme still cannot be applied ─────────────────────────

{
  const dialog = await mountEditor()
  const { text } = colorField('Danger text')
  // Danger text on the panel colour it sits on: unreadable, which the gate blocks.
  typeInto(text, '#0f151d')
  await flush()
  assert(applyButton().disabled, 'a theme failing the contrast checks cannot be applied')
  dialog.unmount()
}

// ── The comparison itself ───────────────────────────────────────────

assert(
  !formHasChanges(savedTheme, { ...savedTheme, overrides: { 'canvas.background': '#101418' } }),
  'a rebuilt overrides object is not a change',
)

console.log('theme editor Apply gate tests passed')
