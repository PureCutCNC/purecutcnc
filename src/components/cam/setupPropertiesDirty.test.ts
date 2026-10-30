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
 * The setup properties dialog only offers Save when the form really differs
 * from the saved setup (issue #1112 F4).
 *
 * Frank: "in the face properties (CAM panel), save button does nothing when
 * there are no changes in the form (but it can still be clicked). we should
 * grey it out if there are no changes."
 *
 * This drives the real dialog: unchanged is disabled, one changed field enables
 * it, typing the value back disables it again (including a whitespace-only name
 * difference, which the store trims away), a field the face does not store does
 * not enable it, and Save is never reached while disabled — by click or by
 * Enter. An inch project compares the same way: a reference is compared as the
 * numbers the project holds, so a value that is only equivalent across units is
 * still an edit. The intervening-edit guard keeps working alongside all of it.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/cam/setupPropertiesDirty.test.ts
 */

import React from 'react'
import { parseHTML } from 'linkedom'
import type { MachiningSetup, Project, RegistrationReference } from '../../types/project'

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
// Components use the automatic JSX runtime; the tsx runner transpiles this file
// with the classic one, which expects a global `React`.
globals.React = React

const { useProjectStore } = await import('../../store/projectStore')
const { newProject, defaultTopSetup } = await import('../../types/project')
const { createRoot } = await import('react-dom/client')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { SetupPropertiesDialog } = await import('./SetupPropertiesDialog')

const store = () => useProjectStore.getState()

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

/** A Bottom setup in a two-setup project, which is the face with every field. */
function bottomProject(units: 'mm' | 'inch' = 'mm', registration: RegistrationReference[] = []): Project {
  const project = newProject('Setup form', units)
  const bottom: MachiningSetup = {
    id: 'setup-bottom',
    name: 'Bottom',
    orientation: { axis: 'x', angleDeg: 180 },
    indexing: 'manual',
    registration,
    notes: '',
    operationIds: [],
  }
  project.setups = [defaultTopSetup(), bottom]
  project.activeSetupId = bottom.id
  return project
}

/** Load a project and render the dialog on one of its setups. */
async function mountDialog(
  setupId: string,
  options: { units?: 'mm' | 'inch'; registration?: RegistrationReference[] } = {},
): Promise<{
  closed: () => boolean
  unmount: () => void
}> {
  const project = bottomProject(options.units ?? 'mm', options.registration ?? [])
  useProjectStore.setState({
    project,
    history: { past: [], future: [], transactionStart: null },
    selection: { selectedFeatureIds: [], selectedFeatureId: null, selectedTabIds: [], selectedClampIds: [], selectedNode: null, mode: 'feature', sketchEditTool: null, activeControl: null, hoveredFeatureId: null },
  } as never)
  const setup = project.setups.find((entry) => entry.id === setupId)
  assert(setup, `the project has the ${setupId} setup`)
  let closed = false
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(I18nProvider, null, React.createElement(SetupPropertiesDialog, {
    setup,
    onClose: () => { closed = true },
  })))
  await flush()
  return {
    closed: () => closed,
    unmount: () => {
      root.unmount()
      host.remove()
    },
  }
}

function saveButton(): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button'))
    .find((candidate) => (candidate.textContent ?? '').trim() === 'Save setup')
  assert(button, 'the dialog has a Save setup button')
  return button as unknown as HTMLButtonElement
}

function fieldInput(label: string): HTMLInputElement | HTMLTextAreaElement {
  const wrapper = Array.from(document.body.querySelectorAll('label'))
    .find((candidate) => (candidate.textContent ?? '').trim().startsWith(label))
  assert(wrapper, `the dialog has a ${label} field`)
  const field = wrapper.querySelector('input, textarea')
  assert(field, `the ${label} field has an input`)
  return field as unknown as HTMLInputElement | HTMLTextAreaElement
}

function labelledSelect(label: string): HTMLSelectElement {
  const wrapper = Array.from(document.body.querySelectorAll('label'))
    .find((candidate) => (candidate.textContent ?? '').trim().startsWith(label))
  assert(wrapper, `the dialog has a ${label} select`)
  const select = wrapper.querySelector('select')
  assert(select, `the ${label} field has a select`)
  return select as unknown as HTMLSelectElement
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

/**
 * Type into a number field the way a browser reports it: linkedom has no
 * `valueAsNumber`, and the registration editor reads it (`valueAsNumber` is
 * NaN for a field that holds no number), so the element reports it here too.
 */
function typeNumberInto(field: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  Object.defineProperty(field, 'valueAsNumber', {
    get: () => Number((field as HTMLInputElement).value),
    configurable: true,
  })
  typeInto(field, value)
}

/** A key press as the browser reports it: handlers switch on `event.key`. */
function pressKey(target: EventTarget, key: string): void {
  const event = new dom.Event('keydown', { bubbles: true }) as unknown as { key?: string }
  Object.defineProperty(event, 'key', { value: key, configurable: true })
  target.dispatchEvent(event as unknown as Event)
}

/** linkedom's select value is a getter with no setter, so select the option. */
function choose(select: HTMLSelectElement, value: string): void {
  const option = Array.from(select.querySelectorAll('option'))
    .find((candidate) => candidate.getAttribute('value') === value)
  assert(option, `the select has the ${value} option`)
  ;(option as unknown as { selected: boolean }).selected = true
  select.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event)
}

function bottomSetup(): MachiningSetup {
  const setup = store().project.setups.find((entry) => entry.id === 'setup-bottom')
  assert(setup, 'the Bottom setup is still stored')
  return setup
}

// ── Unchanged → disabled ────────────────────────────────────────────

{
  const dialog = await mountDialog('setup-bottom')
  assert(saveButton().disabled, 'an untouched form has Save disabled')
  dialog.unmount()
}

// ── One field changed → enabled, typed back → disabled ──────────────

{
  const dialog = await mountDialog('setup-bottom')
  const name = fieldInput('Name')
  typeInto(name, 'Back machining')
  await flush()
  assert(!saveButton().disabled, 'a changed name enables Save')

  typeInto(name, 'Bottom')
  await flush()
  assert(saveButton().disabled, 'typing the saved name back disables Save again')

  // `updateSetup` trims the name, so whitespace alone is not a stored change.
  typeInto(name, '  Bottom  ')
  await flush()
  assert(saveButton().disabled, 'a whitespace-only name difference is not a change')

  typeInto(name, 'Bottom')
  const notes = fieldInput('Operator notes')
  typeInto(notes, 'Seat on fixture pins')
  await flush()
  assert(!saveButton().disabled, 'changed notes enable Save')
  typeInto(notes, '')
  await flush()
  assert(saveButton().disabled, 'cleared notes disable Save again')

  const flip = labelledSelect('Flip about')
  choose(flip, 'y')
  await flush()
  assert(!saveButton().disabled, 'a changed flip axis enables Save')
  choose(flip, 'x')
  await flush()
  assert(saveButton().disabled, 'the saved flip axis disables Save again')
  dialog.unmount()
}

// ── A registration reference added and removed ──────────────────────

{
  const dialog = await mountDialog('setup-bottom')
  choose(labelledSelect('Reference target'), 'point')
  await flush()
  const add = Array.from(document.body.querySelectorAll('button'))
    .find((candidate) => (candidate.textContent ?? '').trim() === 'Add reference')
  assert(add, 'the registration editor offers Add reference')
  add.click()
  await flush()
  assert(!saveButton().disabled, 'an added reference enables Save')

  const remove = document.body.querySelector('.setup-registration li button')
  assert(remove, 'the added reference can be removed')
  ;(remove as unknown as HTMLButtonElement).click()
  await flush()
  assert(bottomSetup().registration.length === 0, 'removing the reference stores nothing')
  assert(saveButton().disabled, 'a removed reference leaves nothing to save')
  dialog.unmount()
}

// ── Disabled Save is never reached ──────────────────────────────────

{
  const dialog = await mountDialog('setup-bottom')
  const before = JSON.stringify(bottomSetup())
  saveButton().click()
  await flush()
  assert(!dialog.closed(), 'clicking a disabled Save does not close the dialog')
  assert(JSON.stringify(bottomSetup()) === before, 'clicking a disabled Save writes nothing')

  // There is no form around the fields, so Enter cannot submit one either: it
  // must neither save nor close while there is nothing to save. The key press
  // is a real Enter, so a handler that saves on Enter is caught here rather
  // than passing a keyless event that no handler matches.
  const name = fieldInput('Name')
  pressKey(name, 'Enter')
  await flush()
  assert(!dialog.closed(), 'Enter with an unchanged form does not close the dialog')
  assert(JSON.stringify(bottomSetup()) === before, 'Enter with an unchanged form writes nothing')

  // The same key must not be a hidden save path once the form has an edit: this
  // dialog saves from its button alone.
  typeInto(name, 'Back machining')
  await flush()
  pressKey(name, 'Enter')
  await flush()
  assert(!dialog.closed(), 'Enter never submits this dialog')
  assert(bottomSetup().name === 'Bottom', 'Enter never writes the dialog')
  dialog.unmount()
}

// ── The same rules hold in an inch project ──────────────────────────

{
  const dialog = await mountDialog('setup-bottom', { units: 'inch' })
  assert(saveButton().disabled, 'an untouched form in an inch project has Save disabled')

  const name = fieldInput('Name')
  typeInto(name, 'Back machining')
  await flush()
  assert(!saveButton().disabled, 'a changed name enables Save in an inch project')

  typeInto(name, 'Bottom')
  const notes = fieldInput('Operator notes')
  typeInto(notes, 'Seat on fixture pins')
  await flush()
  assert(!saveButton().disabled, 'changed notes enable Save in an inch project')
  typeInto(notes, '')
  await flush()
  assert(saveButton().disabled, 'cleared notes disable Save again in an inch project')
  dialog.unmount()
}

// ── A registration point is compared in the project's own units ─────

/** Drop the saved reference and rebuild it from the add form, as a user would. */
async function rebuildReference(x: number, y: number): Promise<void> {
  const remove = document.body.querySelector('.setup-registration li button')
  assert(remove, 'the saved reference can be removed')
  ;(remove as unknown as HTMLButtonElement).click()
  await flush()

  choose(labelledSelect('Reference target'), 'point')
  await flush()
  typeNumberInto(fieldInput('X'), String(x))
  typeNumberInto(fieldInput('Y'), String(y))
  await flush()
  const add = Array.from(document.body.querySelectorAll('button'))
    .find((candidate) => (candidate.textContent ?? '').trim() === 'Add reference')
  assert(add, 'the registration editor offers Add reference')
  add.click()
  await flush()
}

{
  // The same physical point, written the way each project stores it.
  const millimetres: RegistrationReference[] = [
    { id: 'registration-1', kind: 'dowel', target: { type: 'point', point: { x: 25.4, y: 12.7 } } },
  ]
  const inches: RegistrationReference[] = [
    { id: 'registration-1', kind: 'dowel', target: { type: 'point', point: { x: 1, y: 0.5 } } },
  ]

  const metric = await mountDialog('setup-bottom', { registration: millimetres })
  assert(saveButton().disabled, 'a saved reference in millimetres is not a change')
  await rebuildReference(25.4, 12.7)
  assert(saveButton().disabled, 'rebuilding the same millimetre reference leaves nothing to save')
  metric.unmount()

  const imperial = await mountDialog('setup-bottom', { units: 'inch', registration: inches })
  assert(saveButton().disabled, 'the same point saved in inches is not a change either')
  await rebuildReference(1, 0.5)
  assert(saveButton().disabled, 'rebuilding the same inch reference leaves nothing to save')

  // 25.4 inches is not the saved one inch: the comparison is in project units,
  // not an equivalent physical length.
  await rebuildReference(25.4, 12.7)
  assert(!saveButton().disabled, 'a value that is only equivalent across units is still an edit')
  imperial.unmount()
}

// ── An enabled Save writes the edit and closes ──────────────────────

{
  const dialog = await mountDialog('setup-bottom')
  typeInto(fieldInput('Name'), 'Back machining')
  await flush()
  saveButton().click()
  await flush()
  assert(dialog.closed(), 'Save closes the dialog')
  assert(bottomSetup().name === 'Back machining', 'Save stores the edited name')
  dialog.unmount()
}

// ── An intervening edit still blocks Save ───────────────────────────

{
  const dialog = await mountDialog('setup-bottom')
  const name = fieldInput('Name')
  typeInto(name, 'Back machining')
  await flush()
  assert(!saveButton().disabled, 'the draft differs, so Save is offered')
  // Another path changed the stored setup after the dialog opened.
  store().renameSetup('setup-bottom', 'Renamed elsewhere')
  await flush()
  const alert = document.body.querySelector('[role="alert"]')
  assert(alert, 'the dialog says the setup changed underneath it')
  assert(saveButton().disabled, 'a stale dialog cannot save over the newer setup')
  saveButton().click()
  await flush()
  assert(bottomSetup().name === 'Renamed elsewhere', 'the newer stored name survives')
  assert(!dialog.closed(), 'the dialog stays open to be reopened')
  dialog.unmount()
}

console.log('setup properties Save gate tests passed')
