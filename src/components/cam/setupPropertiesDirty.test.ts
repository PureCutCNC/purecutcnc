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
 * Enter. A unit change under the dialog is not an edit either: the form reads
 * the same physical reference back after a conversion, and the numbers the form
 * would write after a reinterpret. The intervening-edit guard keeps working
 * alongside all of it.
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

function approx(left: number, right: number): boolean {
  return Math.abs(left - right) < 1e-9
}

function sameNumbers(actual: number[], expected: number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => approx(value, expected[index]))
}

/** The one point the Bottom setup's saved reference registers. */
function savedReferencePoint(): { x: number; y: number } {
  const [reference] = bottomSetup().registration
  assert(reference && reference.target.type === 'point', 'the Bottom setup stores a point reference')
  return reference.target.point
}

/** The numbers the dialog's saved-reference list shows, in order. */
function registrationNumbers(): number[] {
  const row = document.body.querySelector('.setup-registration li span')
  assert(row, 'the dialog lists the saved reference')
  return ((row.textContent ?? '').match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number)
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

// ── A unit conversion is not an edit to a saved reference ───────────

{
  // "Convert" keeps the physical point and rewrites the stored numbers, so a
  // form that follows it has still changed nothing it would write.
  const millimetres: RegistrationReference[] = [
    { id: 'registration-1', kind: 'dowel', target: { type: 'point', point: { x: 25.4, y: 12.7 } } },
  ]
  const dialog = await mountDialog('setup-bottom', { registration: millimetres })
  assert(saveButton().disabled, 'a saved reference is not an edit')
  assert(sameNumbers(registrationNumbers(), [25.4, 12.7]), 'the saved reference reads in the project’s millimetres')

  store().setUnits('inch', 'convert')
  await flush()
  assert(store().project.meta.units === 'inch', 'the project is in inches')
  const converted = savedReferencePoint()
  assert(approx(converted.x, 1) && approx(converted.y, 0.5), 'the stored reference converts with the project')
  assert(sameNumbers(registrationNumbers(), [1, 0.5]), 'the dialog follows the converted reference')
  assert(saveButton().disabled, 'a converted reference is not an edit')
  assert(!document.body.querySelector('[role="alert"]'), 'a unit conversion is not an edit to the setup')

  // The form still works after the conversion: a real edit enables Save.
  typeInto(fieldInput('Name'), 'Back machining')
  await flush()
  assert(!saveButton().disabled, 'an edit after the conversion enables Save')
  dialog.unmount()
}

// ── A unit reinterpret keeps the numbers, and is not an edit either ─

{
  // "Reinterpret" keeps the numbers and changes only the unit they mean, so
  // nothing the dialog writes has changed (issue #1112 F4).
  const millimetres: RegistrationReference[] = [
    { id: 'registration-1', kind: 'dowel', target: { type: 'point', point: { x: 25.4, y: 12.7 } } },
  ]
  const dialog = await mountDialog('setup-bottom', { registration: millimetres })
  assert(saveButton().disabled, 'the form starts unchanged')

  store().setUnits('inch', 'reinterpret')
  await flush()
  assert(store().project.meta.units === 'inch', 'the project is in inches')
  const kept = savedReferencePoint()
  assert(approx(kept.x, 25.4) && approx(kept.y, 12.7), 'reinterpret keeps the stored numbers')
  assert(sameNumbers(registrationNumbers(), [25.4, 12.7]), 'the form still shows the same reference')
  assert(saveButton().disabled, 'a unit toggle with the same values keeps Save disabled')
  assert(!document.body.querySelector('[role="alert"]'), 'a unit toggle is not an edit to the setup')

  // The form still works after the toggle: a real edit enables Save.
  const name = fieldInput('Name')
  typeInto(name, 'Back machining')
  await flush()
  assert(!saveButton().disabled, 'an edit after the unit toggle enables Save')
  dialog.unmount()
}

// ── A unit toggle converts pending edits instead of dropping them ───

{
  const millimetres: RegistrationReference[] = [
    { id: 'registration-1', kind: 'dowel', target: { type: 'point', point: { x: 25.4, y: 12.7 } } },
  ]
  const dialog = await mountDialog('setup-bottom', { registration: millimetres })
  // Replace the saved reference with one twice as far from the corner. It is
  // the user's unsaved edit, so a unit switch has to move it with the project.
  await rebuildReference(50.8, 25.4)
  assert(!saveButton().disabled, 'the rebuilt reference is an edit')

  store().setUnits('inch', 'convert')
  await flush()
  assert(store().project.meta.units === 'inch', 'the project is in inches')
  const pending = registrationNumbers()
  assert(pending.length === 2 && approx(pending[0], 2) && approx(pending[1], 1),
    'the pending reference converts with the project instead of being dropped')
  assert(!saveButton().disabled, 'a converted pending edit is still an edit')
  assert(!document.body.querySelector('[role="alert"]'), 'converting a pending edit is not an intervening edit')

  // Toggling back converts the same pending reference back, not a stale one.
  store().setUnits('mm', 'convert')
  await flush()
  const back = registrationNumbers()
  assert(back.length === 2 && approx(back[0], 50.8) && approx(back[1], 25.4),
    'toggling units again converts the pending reference back')

  // And Save writes the converted pending edit, not the saved one.
  store().setUnits('inch', 'convert')
  await flush()
  saveButton().click()
  await flush()
  const [written] = bottomSetup().registration
  assert(written && written.target.type === 'point', 'the stored reference is a point')
  assert(approx(written.target.point.x, 2) && approx(written.target.point.y, 1), 'Save writes the converted pending reference')
  dialog.unmount()
}

// ── A unit reinterpret keeps pending numbers as they are ────────────

{
  const millimetres: RegistrationReference[] = [
    { id: 'registration-1', kind: 'dowel', target: { type: 'point', point: { x: 25.4, y: 12.7 } } },
  ]
  const dialog = await mountDialog('setup-bottom', { registration: millimetres })
  await rebuildReference(50.8, 25.4)
  assert(!saveButton().disabled, 'the rebuilt reference is an edit')

  // "Reinterpret" keeps every number in the project, so it must keep the
  // pending numbers too: converting them would move the point the user typed.
  store().setUnits('inch', 'reinterpret')
  await flush()
  assert(store().project.meta.units === 'inch', 'the project is in inches')
  const kept = registrationNumbers()
  assert(kept.length === 2 && approx(kept[0], 50.8) && approx(kept[1], 25.4), 'a reinterpret keeps the pending numbers')
  assert(!saveButton().disabled, 'the pending reference is still an edit')
  dialog.unmount()
}

// ── A unit toggle keeps the stale-form protection ───────────────────

{
  const dialog = await mountDialog('setup-bottom')
  const name = fieldInput('Name')
  typeInto(name, 'Back machining')
  await flush()
  assert(!saveButton().disabled, 'the draft differs, so Save is offered')
  // Another path changed the stored setup after the dialog opened.
  store().renameSetup('setup-bottom', 'Renamed elsewhere')
  await flush()
  assert(document.body.querySelector('[role="alert"]'), 'an external rename blocks Save')
  assert(saveButton().disabled, 'the stale dialog cannot save over the newer setup')

  // Reinterpreting the units rewrites nothing the dialog writes, and must not
  // clear the warning the external rename raised (r4-4).
  store().setUnits('inch', 'reinterpret')
  await flush()
  assert(store().project.meta.units === 'inch', 'the project is in inches')
  assert(bottomSetup().name === 'Renamed elsewhere', 'the rename is still stored')
  assert(document.body.querySelector('[role="alert"]'), 'a reinterpret does not clear the stale warning')
  assert(saveButton().disabled, 'a reinterpret cannot re-enable Save over the external rename')
  saveButton().click()
  await flush()
  assert(bottomSetup().name === 'Renamed elsewhere', 'clicking Save over the external rename writes nothing')
  assert(!dialog.closed(), 'the dialog stays open to be reopened')

  // A real conversion under the dialog keeps blocking too.
  store().setUnits('mm', 'convert')
  await flush()
  assert(store().project.meta.units === 'mm', 'the project is back in millimetres')
  assert(document.body.querySelector('[role="alert"]'), 'a conversion does not clear the stale warning either')
  assert(saveButton().disabled, 'a conversion cannot re-enable Save over the external rename')
  saveButton().click()
  await flush()
  assert(bottomSetup().name === 'Renamed elsewhere', 'the conversion writes nothing over the rename')
  assert(!dialog.closed(), 'the stale dialog is still open')
  dialog.unmount()
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
