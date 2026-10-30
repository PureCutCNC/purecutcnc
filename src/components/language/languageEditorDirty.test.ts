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
 * The custom-language editor only offers Apply when the pack really differs
 * from the one it opened on (issue #1112 F4).
 *
 * Apply stores the pack and closes the manager, so an untouched editor used to
 * rewrite a saved language as an empty edit. This drives the real dialog: an
 * unchanged pack is disabled, a renamed pack or a retranslated key enables it,
 * typing the saved values back (including padded with spaces) disables it
 * again, and the placeholder-parity gate still blocks Apply.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/language/languageEditorDirty.test.ts
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
const { LanguageEditorDialog } = await import('./LanguageEditorDialog')
const { CUSTOM_LANGUAGE_SCHEMA_VERSION } = await import('../../i18n/registry')
type CustomLanguageData = import('../../i18n/registry').CustomLanguageData
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
  HTMLTextAreaElement: { prototype: { value: string } }
}

/** A saved pack: German-sounding, with one translated key and no placeholders. */
const savedLanguage: CustomLanguageData = {
  schemaVersion: CUSTOM_LANGUAGE_SCHEMA_VERSION,
  id: 'custom-de',
  name: 'Deutsch (Werkstatt)',
  languageTag: 'de-DE',
  baseLocaleId: 'en',
  overrides: { 'dialogs.common.cancel': 'Abbrechen' },
}

interface Mounted {
  applied: () => number
  unmount: () => void
}

async function mountEditor(): Promise<Mounted> {
  const applied: unknown[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(I18nProvider, null, React.createElement(LanguageEditorDialog, {
    language: savedLanguage,
    onApply: (language: unknown) => { applied.push(language) },
    onClose: () => undefined,
  })))
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
    .find((candidate) => (candidate.textContent ?? '').trim() === 'Apply')
  assert(button, 'the editor has an Apply button')
  return button as unknown as HTMLButtonElement
}

function nameField(): HTMLInputElement {
  const field = Array.from(document.body.querySelectorAll('label.language-editor-field'))
    .find((label) => (label.textContent ?? '').startsWith('Language name'))
  assert(field, 'the editor has a name field')
  const input = field.querySelector('input')
  assert(input, 'the name field has an input')
  return input as unknown as HTMLInputElement
}

function tagField(): HTMLInputElement {
  const field = Array.from(document.body.querySelectorAll('label.language-editor-field'))
    .find((label) => (label.textContent ?? '').startsWith('BCP-47 language tag'))
  assert(field, 'the editor has a language tag field')
  const input = field.querySelector('input')
  assert(input, 'the tag field has an input')
  return input as unknown as HTMLInputElement
}

/** Set a field the way typing does: value first, then the event React listens for. */
function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  if (field.tagName === 'INPUT' && !field.getAttribute('type')) field.setAttribute('type', 'text')
  const prototype = field.tagName === 'TEXTAREA' ? dom.HTMLTextAreaElement.prototype : dom.HTMLInputElement.prototype
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  assert(setter, 'linkedom has a value setter')
  setter.call(field, value)
  field.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
}

/**
 * Bring one key's row on screen. A search string opens its section with only
 * the matching rows rendered, which is also how a translator reaches a key.
 */
async function openRow(key: string): Promise<HTMLTextAreaElement> {
  const search = document.body.querySelector('input.language-editor-search')
  assert(search, 'the editor has a search field')
  typeInto(search as unknown as HTMLInputElement, key)
  await flush()
  const field = document.body.querySelector(`textarea[aria-label="${key}"]`)
  assert(field, `the editor shows the ${key} row`)
  return field as unknown as HTMLTextAreaElement
}

// ── Unchanged → disabled ────────────────────────────────────────────

{
  const dialog = await mountEditor()
  assert(applyButton().disabled, 'an untouched pack has Apply disabled')
  applyButton().click()
  await flush()
  assert(dialog.applied() === 0, 'clicking a disabled Apply writes nothing')
  dialog.unmount()
}

// ── A renamed pack enables it, the saved name disables it ───────────

{
  const dialog = await mountEditor()
  typeInto(nameField(), 'Deutsch (Werkstatt 2)')
  await flush()
  assert(!applyButton().disabled, 'a changed name enables Apply')

  typeInto(nameField(), '  Deutsch (Werkstatt)  ')
  await flush()
  assert(applyButton().disabled, 'the saved name, padded, disables Apply again')
  dialog.unmount()
}

// ── A changed language tag ─────────────────────────────────────────

{
  const dialog = await mountEditor()
  typeInto(tagField(), 'de-AT')
  await flush()
  assert(!applyButton().disabled, 'a changed language tag enables Apply')

  typeInto(tagField(), 'de-DE')
  await flush()
  assert(applyButton().disabled, 'the saved language tag disables Apply again')
  dialog.unmount()
}

// ── A retranslated key, and putting the saved text back ────────────

{
  const dialog = await mountEditor()
  const row = await openRow('dialogs.common.cancel')
  typeInto(row, 'Abbrechen!')
  await flush()
  assert(!applyButton().disabled, 'a changed translation enables Apply')

  // The reset clears the override, which is a change while one is saved.
  const reset = document.body.querySelector('textarea[aria-label="dialogs.common.cancel"]')
    ?.closest('.language-editor-row__edit')?.querySelector('button.language-editor-row__reset')
  assert(reset, 'the row has a reset action')
  ;(reset as unknown as HTMLButtonElement).click()
  await flush()
  assert(!applyButton().disabled, 'dropping the saved translation is a change')

  // Typing the saved text back leaves nothing to save.
  typeInto(document.body.querySelector('textarea[aria-label="dialogs.common.cancel"]') as unknown as HTMLTextAreaElement, 'Abbrechen')
  await flush()
  assert(applyButton().disabled, 'the saved translation disables Apply again')
  dialog.unmount()
}

// ── The placeholder gate still blocks Apply ────────────────────────

{
  const dialog = await mountEditor()
  const row = await openRow('langEditor.progress')
  typeInto(row, 'Übersetzt: kaputt')
  await flush()
  assert(applyButton().disabled, 'a translation that drops its placeholders cannot be applied')
  dialog.unmount()
}

// ── An enabled Apply writes the pack ──────────────────────────────

{
  const dialog = await mountEditor()
  typeInto(nameField(), 'Deutsch (Werkstatt 2)')
  await flush()
  applyButton().click()
  await flush()
  assert(dialog.applied() === 1, 'an enabled Apply writes once')
  dialog.unmount()
}

// ── The comparison itself ──────────────────────────────────────────

assert(
  !formHasChanges(savedLanguage, { ...savedLanguage, overrides: { 'dialogs.common.cancel': 'Abbrechen' } }),
  'a rebuilt overrides object is not a change',
)

console.log('language editor Apply gate tests passed')
