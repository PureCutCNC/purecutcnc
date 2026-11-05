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
 * The machine editor's Zero A line (#1103 slice ca-h, part 3).
 *
 * The line is persisted and validated, but the editor used to preserve it
 * without offering a control — so the only way to configure it was the raw
 * JSON tab (#1152 correction round 1, finding 5). This drives the real dialog:
 * a rotary machine shows the named field, typing a line enables Save and
 * reaches the definition the dialog holds, and an untouched machine still has
 * no such key.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/machine/machineEditorZeroA.test.ts
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
// and take no edits at all.
if (!('oninput' in (document as unknown as object))) {
  Object.defineProperty(document, 'oninput', { value: null, writable: true, configurable: true })
}
globals.React = React

const { bundledMachines } = await import('../../machine/registry')
const { validateDef } = await import('./machineDefinitionForm')
const { createRoot } = await import('react-dom/client')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { MachineDefinitionEditorDialog } = await import('./MachineDefinitionEditorDialog')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

const dom = window as unknown as {
  Event: new (type: string, init?: { bubbles?: boolean }) => object
}

const ZERO_A = 'G10 L20 P1 A0'

/** A G-code router with a rotary axis; the Zero A section only appears there. */
function rotaryDefinition(zeroA?: string) {
  const grbl = validateDef(JSON.parse(JSON.stringify(bundledMachines().find((entry) => entry.id === 'grbl')))).ok
  assert(grbl, 'the bundled GRBL machine validates')
  const definition = validateDef({
    ...JSON.parse(JSON.stringify(grbl)),
    rotary: {
      about: 'x',
      drive: 'own',
      reversed: false,
      inverseTimeFeed: { on: 'G93', off: 'G94' },
      ...(zeroA === undefined ? {} : { zeroA }),
    },
  }).ok
  assert(definition, 'the rotary GRBL machine validates')
  return definition
}

interface Mounted {
  host: HTMLElement
  /** The definition Save wrote, or null before it was pressed. */
  saved: () => Record<string, unknown> | null
  unmount: () => void
}

async function mountEditor(definition: ReturnType<typeof rotaryDefinition>): Promise<Mounted> {
  let written: Record<string, unknown> | null = null
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(I18nProvider, null, React.createElement(MachineDefinitionEditorDialog, {
    definition,
    onSave: (saved: unknown) => { written = saved as Record<string, unknown> },
    onClose: () => {},
  })))
  await flush()
  return {
    host,
    saved: () => written,
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

/** The Zero A field, found the way the operator finds it: by its test id. */
function zeroAInput(): HTMLInputElement {
  const field = document.body.querySelector('[data-testid="machine-rotary-zero-a"]')
  assert(field, 'the rotary section offers the Zero A line field')
  return field as unknown as HTMLInputElement
}

function typeInto(field: HTMLInputElement, value: string): void {
  if (!field.getAttribute('type')) field.setAttribute('type', 'text')
  const prototype = Object.getPrototypeOf(field) as { value: string }
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  assert(setter, 'linkedom has an input value setter')
  setter.call(field, value)
  field.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
}

// ── A rotary machine offers the line; typed, it reaches the definition ──

{
  const dialog = await mountEditor(rotaryDefinition())
  try {
    assert(saveButton().disabled, 'an untouched machine has Save disabled')
    const field = zeroAInput()
    assert(field.value === '', 'the Zero A field starts empty')
    assert(field.getAttribute('placeholder') === ZERO_A, 'it shows the G10 L20 form as its placeholder')

    typeInto(field, ZERO_A)
    await flush()
    assert(!saveButton().disabled, 'typing a Zero A line enables Save')
    saveButton().click()
    await flush()
    const saved = dialog.saved()
    assert(saved !== null, 'Save writes the edited definition')
    assert(
      (saved.rotary as { zeroA?: string } | undefined)?.zeroA === ZERO_A,
      `the typed line reaches the saved definition (got ${JSON.stringify(saved.rotary)})`,
    )
  } finally {
    dialog.unmount()
  }
}

// ── A saved line is shown, and clearing it drops the key ───────────

{
  const dialog = await mountEditor(rotaryDefinition(ZERO_A))
  try {
    const field = zeroAInput()
    assert(field.value === ZERO_A, 'a saved Zero A line is shown in the field')
    assert(saveButton().disabled, 'and an untouched machine has Save disabled')

    typeInto(field, '')
    await flush()
    assert(!saveButton().disabled, 'clearing the field is an edit')
    saveButton().click()
    await flush()
    const saved = dialog.saved()
    assert(saved !== null, 'Save writes the cleared definition')
    assert(
      !('zeroA' in ((saved.rotary as Record<string, unknown> | undefined) ?? {})),
      `clearing the field removes the key (got ${JSON.stringify(saved.rotary)})`,
    )
  } finally {
    dialog.unmount()
  }
}

console.log('machine editor Zero A field tests passed')
