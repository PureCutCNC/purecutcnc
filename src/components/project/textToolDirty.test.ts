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
 * Reopening an existing text run only offers Apply when the form differs from
 * it (issue #1112 F4).
 *
 * The dialog Properties opens for an existing run writes the same feature
 * again, so an unchanged Apply was an undo step that changed nothing. The
 * comparison normalises the way Save stores the values — the text collapses to
 * one line and the height parses from the typed string — so a line break between
 * the same words or "12.0" over a saved 12 is not an edit. An inch project
 * compares the same way: the height is the number the project holds, so a value
 * that is only equivalent across units is still an edit. Creation has no saved
 * state to compare against and keeps its own behaviour.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/project/textToolDirty.test.ts
 */

import React from 'react'
import { parseHTML } from 'linkedom'
import type { TextToolConfig } from '../../text'

const { window, document } = parseHTML('<!doctype html><html><body></body></html>')
const globals = globalThis as unknown as Record<string, unknown>
globals.window = window
globals.document = document
globals.HTMLElement = window.HTMLElement
globals.Element = window.Element
globals.Node = window.Node
globals.HTMLSelectElement = window.HTMLSelectElement
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

const { useProjectStore } = await import('../../store/projectStore')
const { newProject, defaultTool } = await import('../../types/project')
const { createRoot } = await import('react-dom/client')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { TextToolDialog } = await import('./TextToolDialog')

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

const dom = window as unknown as {
  Event: new (type: string, init?: { bubbles?: boolean }) => object
  HTMLSelectElement: { prototype: { value: string } }
}

interface Mounted {
  confirmations: TextToolConfig[]
  closed: () => boolean
  unmount: () => void
}

/** Render the dialog the way Properties opens it for an existing run. */
async function mountEdit(initial: TextToolConfig, units: 'mm' | 'inch' = 'mm'): Promise<Mounted> {
  return mountDialog('edit', initial, units)
}

/** Render the dialog the toolbar opens to place new text. */
async function mountCreate(): Promise<Mounted> {
  return mountDialog('create', undefined)
}

async function mountDialog(
  mode: 'create' | 'edit',
  initial: TextToolConfig | undefined,
  units: 'mm' | 'inch' = 'mm',
): Promise<Mounted> {
  useProjectStore.setState({
    project: { ...newProject('Text form', units), tools: [defaultTool(units, 1)] },
    history: { past: [], future: [], transactionStart: null },
  } as never)
  const confirmations: TextToolConfig[] = []
  let closed = false
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(I18nProvider, null, React.createElement(TextToolDialog, {
    mode,
    initial,
    onClose: () => { closed = true },
    onConfirm: (config: TextToolConfig) => { confirmations.push(config) },
  })))
  await flush()
  return {
    confirmations,
    closed: () => closed,
    unmount: () => {
      root.unmount()
      host.remove()
    },
  }
}

function buttonByText(label: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button'))
    .find((candidate) => (candidate.textContent ?? '').trim() === label)
  assert(button, `the dialog has a ${label} button`)
  return button as unknown as HTMLButtonElement
}

function applyButton(): HTMLButtonElement {
  return buttonByText('Apply')
}

function textField(): HTMLTextAreaElement {
  const field = document.body.querySelector('textarea')
  assert(field, 'the dialog has a text field')
  return field as unknown as HTMLTextAreaElement
}

function sizeField(): HTMLInputElement {
  const field = document.body.querySelector('#text-tool-size')
  assert(field, 'the dialog has a height field')
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

function openSelect(currentLabel: string): void {
  const selects = Array.from(document.body.querySelectorAll('.ui-select'))
  const select = selects.find((candidate) => (candidate.querySelector('.ui-select__trigger .ui-select__label')?.textContent ?? '').trim() === currentLabel)
  assert(select, `the dialog has a select reading ${currentLabel}`)
  ;(select.querySelector('.ui-select__trigger') as unknown as HTMLButtonElement).click()
}

/** The dialog's own Select opens a listbox; pick an entry the way a pointer does. */
async function chooseOption(currentLabel: string, nextLabel: string): Promise<void> {
  openSelect(currentLabel)
  await flush()
  const option = Array.from(document.body.querySelectorAll('.ui-select__option'))
    .find((candidate) => (candidate.textContent ?? '').trim() === nextLabel)
  assert(option, `the open select offers ${nextLabel}`)
  option.dispatchEvent(new dom.Event('pointerdown', { bubbles: true }) as unknown as Event)
  await flush()
}

const saved: TextToolConfig = {
  text: 'Drill 3 mm',
  style: 'skeleton',
  fontId: 'simple_stroke',
  size: 12,
  operation: 'subtract',
  layout: null,
}

/** The same run in a project whose units are inches: 12 mm is 0.4724… in. */
const savedInInches: TextToolConfig = { ...saved, size: 12 / 25.4 }

// ── Unchanged → disabled ────────────────────────────────────────────

{
  const dialog = await mountEdit(saved)
  assert(applyButton().disabled, 'an untouched run has Apply disabled')
  dialog.unmount()
}

// ── One field changed → enabled, typed back → disabled ──────────────

{
  const dialog = await mountEdit(saved)
  typeInto(textField(), 'Drill 4 mm')
  await flush()
  assert(!applyButton().disabled, 'changed text enables Apply')

  // The save collapses the text to one line and trims it, so neither a line
  // break between the same words nor surrounding spaces is an edit.
  typeInto(textField(), '  Drill\n3 mm  ')
  await flush()
  assert(applyButton().disabled, 'the same text written differently is not an edit')

  typeInto(sizeField(), '12.0')
  await flush()
  assert(applyButton().disabled, 'a height typed with the same value is not an edit')

  typeInto(sizeField(), '13')
  await flush()
  assert(!applyButton().disabled, 'a changed height enables Apply')
  typeInto(sizeField(), '12')
  await flush()
  assert(applyButton().disabled, 'the saved height disables Apply again')

  await chooseOption('Subtract', 'Add')
  assert(!applyButton().disabled, 'a changed operation enables Apply')
  await chooseOption('Add', 'Subtract')
  assert(applyButton().disabled, 'the saved operation disables Apply again')
  dialog.unmount()
}

// ── The same rules hold in an inch project ──────────────────────────

{
  const dialog = await mountEdit(savedInInches, 'inch')
  assert(applyButton().disabled, 'an untouched run in an inch project has Apply disabled')

  typeInto(textField(), 'Drill 4 mm')
  await flush()
  assert(!applyButton().disabled, 'changed text enables Apply in an inch project')

  typeInto(textField(), 'Drill 3 mm')
  await flush()
  assert(applyButton().disabled, 'the saved text disables Apply again in an inch project')

  // The stored height is the number the project holds, in its own units: the
  // same physical size written as millimetres is a different run.
  typeInto(sizeField(), '12')
  await flush()
  assert(!applyButton().disabled, 'a value that is only equivalent across units is an edit')

  typeInto(sizeField(), String(savedInInches.size))
  await flush()
  assert(applyButton().disabled, 'the saved inch height disables Apply again')
  dialog.unmount()
}

// ── Disabled Apply is never reached; an enabled one writes ──────────

{
  const dialog = await mountEdit(saved)
  applyButton().click()
  await flush()
  assert(dialog.confirmations.length === 0, 'clicking a disabled Apply writes nothing')
  assert(!dialog.closed(), 'clicking a disabled Apply does not close the dialog')

  typeInto(textField(), '  Drill\n4 mm  ')
  await flush()
  applyButton().click()
  await flush()
  const written = dialog.confirmations[0]
  assert(written, 'an enabled Apply writes once')
  assert(written.text === 'Drill 4 mm', 'the saved text is one line with no surrounding spaces')
  assert(written.size === 12, 'the saved height is the parsed number')
  assert(written.operation === 'subtract', 'the stored operation is kept')
  dialog.unmount()
}

// ── Creation keeps its own behaviour ───────────────────────────────

{
  const dialog = await mountCreate()
  assert(!buttonByText('Place text').disabled, 'placing new text is not gated on a change')

  // Creation has no saved state, but it still refuses text it cannot place: the
  // button stays enabled and the click writes nothing.
  typeInto(textField(), '   ')
  await flush()
  buttonByText('Place text').click()
  await flush()
  assert(dialog.confirmations.length === 0, 'empty text places nothing')
  dialog.unmount()
}

console.log('text tool Apply gate tests passed')
