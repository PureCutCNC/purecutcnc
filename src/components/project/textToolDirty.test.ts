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
 * the same words or "12.0" over a saved 12 is not an edit. A conversion of the
 * project's units rewrites the stored height, and the form follows that run, so
 * the same physical height is still not an edit. Creation has no saved state to
 * compare against and keeps its own behaviour.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/project/textToolDirty.test.ts
 */

import React from 'react'
import { parseHTML } from 'linkedom'
import type { Project } from '../../types/project'
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
const { newProject, defaultTool, rectProfile } = await import('../../types/project')
const { projectWithFeatures, resolvedFeature } = await import('../../test/projectFixtures')
const { convertLength } = await import('../../utils/units')
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

/** Id of the run the store-backed harness opens. */
const TEXT_RUN_ID = 'run'

/** A project that stores {@link saved} as a real text run. */
function storedRunProject(): Project {
  return projectWithFeatures({ ...newProject('Text form', 'mm'), tools: [defaultTool('mm', 1)] }, [
    {
      id: TEXT_RUN_ID, name: saved.text, kind: 'text', operation: saved.operation, visible: true, locked: false,
      z_top: 5, z_bottom: 0, folderId: null, stl: null,
      text: { text: saved.text, style: saved.style, fontId: saved.fontId, size: saved.size },
      sketch: { origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [], profile: rectProfile(0, 0, 40, 20) },
    },
  ])
}

/**
 * The dialog as Properties opens it: the run it edits is read back from the
 * store on every render, so converting the project rewrites the values the
 * dialog was handed.
 */
function StoredRunParent({ onClose, onConfirm }: { onClose: () => void; onConfirm: (config: TextToolConfig) => void }) {
  const project = useProjectStore((state) => state.project)
  const feature = resolvedFeature(project, TEXT_RUN_ID)
  const text = feature.text
  assert(text, 'the stored run has text')
  return React.createElement(TextToolDialog, {
    mode: 'edit',
    initial: { text: text.text, style: text.style, fontId: text.fontId, size: text.size, operation: feature.operation },
    onClose,
    onConfirm,
  })
}

/** Render the edit dialog over a stored run instead of a literal config. */
async function mountStoredRun(): Promise<Mounted> {
  useProjectStore.setState({
    project: storedRunProject(),
    history: { past: [], future: [], transactionStart: null },
  } as never)
  const confirmations: TextToolConfig[] = []
  let closed = false
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(I18nProvider, null, React.createElement(StoredRunParent, {
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

// ── A unit conversion is not an edit to the stored run ──────────────

{
  const dialog = await mountStoredRun()
  assert(Number(sizeField().value) === saved.size, 'the stored run reads its saved height')
  assert(applyButton().disabled, 'a stored run is not an edit')

  // "Convert" keeps the physical height and rewrites the stored number with
  // every other length in the project (issue #1112 F4). The dialog follows the
  // converted run, so the form still holds the values it would have saved.
  useProjectStore.getState().setUnits('inch', 'convert')
  await flush()
  const inches = convertLength(saved.size, 'mm', 'inch')
  assert(useProjectStore.getState().project.meta.units === 'inch', 'the project is in inches')
  assert(resolvedFeature(useProjectStore.getState().project, TEXT_RUN_ID).text?.size === inches,
    'the stored height converts with the project')
  assert(Number(sizeField().value) === inches, 'the dialog follows the converted height')
  assert(applyButton().disabled, 'a converted height is not an edit')

  // The form still works after the conversion: a real edit enables Apply.
  typeInto(sizeField(), '13')
  await flush()
  assert(!applyButton().disabled, 'a changed height after the conversion enables Apply')
  dialog.unmount()
}

// ── A unit conversion keeps what the form is still typing ──────────

{
  const dialog = await mountStoredRun()
  typeInto(textField(), 'Drill 4 mm')
  typeInto(sizeField(), '15')
  await flush()
  assert(!applyButton().disabled, 'the pending text and height are an edit')

  // Converting the project rewrites the stored height. The pending text and
  // height are the user's unsaved edit, so they move with the project instead
  // of being reset to the stored run (r4-4).
  useProjectStore.getState().setUnits('inch', 'convert')
  await flush()
  assert(useProjectStore.getState().project.meta.units === 'inch', 'the project is in inches')
  assert(textField().value === 'Drill 4 mm', 'the pending text survives the unit conversion')
  const convertedPending = convertLength(15, 'mm', 'inch')
  assert(Math.abs(Number(sizeField().value) - convertedPending) < 1e-9,
    'the pending height converts with the project instead of being dropped')
  assert(!applyButton().disabled, 'a converted pending edit is still an edit')

  applyButton().click()
  await flush()
  const written = dialog.confirmations[0]
  assert(written, 'Apply writes the pending edit')
  assert(written.text === 'Drill 4 mm', 'Apply writes the pending text')
  assert(written.size !== undefined && Math.abs(written.size - convertedPending) < 1e-9,
    'Apply writes the converted pending height')
  dialog.unmount()
}

// ── A unit reinterpret keeps the pending numbers as they are ────────

{
  const dialog = await mountStoredRun()
  typeInto(textField(), 'Drill 4 mm')
  typeInto(sizeField(), '15')
  await flush()

  // Reinterpreting keeps every number in the project, so the pending height
  // keeps its number too instead of being converted (r4-4).
  useProjectStore.getState().setUnits('inch', 'reinterpret')
  await flush()
  assert(useProjectStore.getState().project.meta.units === 'inch', 'the project is in inches')
  assert(textField().value === 'Drill 4 mm', 'the pending text survives a reinterpret')
  assert(Number(sizeField().value) === 15, 'a reinterpret keeps the pending height number')
  assert(!applyButton().disabled, 'the pending height is still an edit')
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
