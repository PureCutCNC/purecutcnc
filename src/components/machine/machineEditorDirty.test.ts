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
 * The machine definition editor only offers Save when the definition really
 * differs from the one it opened on (issue #1112 F4).
 *
 * Save writes the whole definition and re-selects the machine, so an untouched
 * dialog used to record an undo step that changed nothing. This drives the real
 * dialog: unchanged is disabled, a focused-form field enables it, typing the
 * value back disables it again, an Advanced-JSON edit that only reformats the
 * same definition is not an edit, and a real JSON edit is. Save is never
 * reached while disabled.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/machine/machineEditorDirty.test.ts
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

const { bundledMachines } = await import('../../machine/registry')
const { validateDef } = await import('./machineDefinitionForm')
const { createRoot } = await import('react-dom/client')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { MachineDefinitionEditorDialog } = await import('./MachineDefinitionEditorDialog')
const { formHasChanges } = await import('../common/formDraft')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

const dom = window as unknown as {
  Event: new (type: string, init?: { bubbles?: boolean }) => object
}

/** The GRBL router, parsed the way both the dialog and its Save path read one. */
function grblDefinition() {
  const definition = validateDef(JSON.parse(JSON.stringify(bundledMachines().find((entry) => entry.id === 'grbl')))).ok
  assert(definition, 'the bundled GRBL machine validates')
  return definition
}

interface Mounted {
  saved: () => number
  unmount: () => void
}

async function mountEditor(): Promise<Mounted> {
  const saved: unknown[] = []
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(I18nProvider, null, React.createElement(MachineDefinitionEditorDialog, {
    definition: grblDefinition(),
    onSave: (definition: unknown) => { saved.push(definition) },
    onClose: () => {},
  })))
  await flush()
  return {
    saved: () => saved.length,
    unmount: () => {
      root.unmount()
      host.remove()
    },
  }
}

function saveButton(): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button'))
    .find((candidate) => (candidate.textContent ?? '').trim() === 'Save')
  assert(button, 'the editor has a Save button')
  return button as unknown as HTMLButtonElement
}

function labelledInput(label: string): HTMLInputElement {
  const wrapper = Array.from(document.body.querySelectorAll('label'))
    .find((candidate) => (candidate.querySelector('.machine-editor-label')?.textContent ?? '').trim() === label)
  assert(wrapper, `the editor has a ${label} field`)
  const field = wrapper.querySelector('input, textarea')
  assert(field, `the ${label} field has an input`)
  return field as unknown as HTMLInputElement
}

/** Set a field the way typing does: value first, then the event React listens for. */
function typeInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  // A browser reports `type` as "text" for an input written without one, and
  // React only treats a text input it recognises as a change source. linkedom
  // reports no type at all, so state the default the browser would report.
  if (field.tagName === 'INPUT' && !field.getAttribute('type')) field.setAttribute('type', 'text')
  const prototype = Object.getPrototypeOf(field) as { value: string }
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  assert(setter, 'linkedom has an input value setter')
  setter.call(field, value)
  field.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
}

/** Open the collapsed Advanced section, whose JSON editor is its only child. */
async function openAdvanced(): Promise<HTMLTextAreaElement> {
  const header = Array.from(document.body.querySelectorAll('button'))
    .find((candidate) => (candidate.textContent ?? '').trim() === 'Advanced (raw JSON)')
  assert(header, 'the editor has an Advanced section')
  ;(header as unknown as HTMLButtonElement).click()
  await flush()
  const field = document.body.querySelector('textarea.machine-editor-json')
  assert(field, 'the Advanced section opened its JSON editor')
  return field as unknown as HTMLTextAreaElement
}

// ── Unchanged → disabled ────────────────────────────────────────────

{
  const dialog = await mountEditor()
  assert(saveButton().disabled, 'an untouched definition has Save disabled')
  saveButton().click()
  await flush()
  assert(dialog.saved() === 0, 'clicking a disabled Save writes nothing')
  dialog.unmount()
}

// ── A focused-form edit enables it, typed back disables it ──────────

{
  const dialog = await mountEditor()
  const name = labelledInput('Name')
  typeInto(name, 'GRBL 1.1 custom')
  await flush()
  assert(!saveButton().disabled, 'a changed name enables Save')

  typeInto(name, 'GRBL 1.1')
  await flush()
  assert(saveButton().disabled, 'typing the saved name back disables Save again')

  const extension = labelledInput('File extension')
  typeInto(extension, 'gcode')
  await flush()
  assert(!saveButton().disabled, 'a changed file extension enables Save')
  typeInto(extension, 'nc')
  await flush()
  assert(saveButton().disabled, 'the saved file extension disables Save again')
  dialog.unmount()
}

// ── The Advanced JSON editor is compared by value, not by text ──────

{
  const dialog = await mountEditor()
  const definition = grblDefinition()
  const json = await openAdvanced()
  // The same definition, reformatted: Save would write identically.
  typeInto(json, JSON.stringify(definition, null, 4))
  await flush()
  assert(saveButton().disabled, 'reformatting the same definition is not an edit')

  // A real edit anywhere in the definition is.
  typeInto(json, JSON.stringify({
    ...definition,
    program: { ...definition.program, footer: [...definition.program.footer, 'M30'] },
  }, null, 2))
  await flush()
  assert(!saveButton().disabled, 'a changed definition in the JSON editor enables Save')

  // A raw edit that is invalid JSON still blocks Save.
  typeInto(json, '{ not json')
  await flush()
  assert(saveButton().disabled, 'invalid JSON blocks Save')

  typeInto(json, JSON.stringify(definition, null, 2))
  await flush()
  assert(saveButton().disabled, 'restoring the JSON disables Save again')
  dialog.unmount()
}

// ── An enabled Save writes the edit ─────────────────────────────────

{
  const dialog = await mountEditor()
  typeInto(labelledInput('Name'), 'GRBL 1.1 custom')
  await flush()
  assert(!saveButton().disabled, 'the edited definition is offered for saving')
  saveButton().click()
  await flush()
  assert(dialog.saved() === 1, 'an enabled Save writes once')
  dialog.unmount()
}

// ── The comparison itself ───────────────────────────────────────────

assert(
  formHasChanges(grblDefinition(), grblDefinition()) === false,
  'parsing the same definition twice is not a change',
)

console.log('machine editor Save gate tests passed')
