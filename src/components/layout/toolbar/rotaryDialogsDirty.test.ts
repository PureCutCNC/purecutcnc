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
 * The rotary edit dialogs only offer Apply when the form really differs from
 * the stored shape (issue #1112 F4).
 *
 * Editing a stored Thread/Flutes or Turn/Polygon rewrites its parameters, and
 * the live preview (F1) already wrote the draft, so an Apply with nothing
 * changed was a second, empty undo step. This drives the real dialogs: an
 * untouched edit is disabled, one changed field enables it, typing the value
 * back disables it again, and creation — which has no stored shape to compare
 * against — keeps its own behaviour. The comparison is on the parsed field
 * values, so "5.0" over a saved 5 is not an edit and the hand of a straight
 * flute (whose stored twist is 0 either way) is not one either.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/layout/toolbar/rotaryDialogsDirty.test.ts
 */

import assert from 'node:assert/strict'
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
// without this a typed field would take no edit at all — a silently inert test.
if (!('oninput' in (document as unknown as object))) {
  Object.defineProperty(document, 'oninput', { value: null, writable: true, configurable: true })
}
globals.React = React

const { useProjectStore } = await import('../../../store/projectStore')
const { I18nProvider } = await import('../../../i18n/I18nProvider')
const { RotaryPatternDialog } = await import('./RotaryPatternDialog')
const { RotarySolidDialog } = await import('./RotarySolidDialog')
const { createRoot } = await import('react-dom/client')
const { defaultTool, newProject, roundStock } = await import('../../../types/project')
const { projectWithFeatures } = await import('../../../test/projectFixtures')
const { bundledMachines } = await import('../../../machine/registry')
const { validateMachineDefinition } = await import('../../../engine/gcode/types')
const { switchWorkspaceFace } = await import('../../../store/workspaceFace')

const store = () => useProjectStore.getState()

const dom = window as unknown as {
  Event: new (type: string, init?: { bubbles?: boolean }) => object
  HTMLInputElement: { prototype: { value: string } }
}

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(message)
    await flush()
  }
}

/** A rotary project with a round bar and a rotary machine: Around is available. */
function rotaryProject(): ReturnType<typeof newProject> {
  const base = newProject('Rotary gate', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(40, 200, 'x', { x: 10, y: 30 })
  const machine = validateMachineDefinition({
    ...structuredClone(bundledMachines()[0]),
    id: 'rotary-gate',
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = [{ ...defaultTool('mm', 1), id: 'ball', type: 'ball_endmill', diameter: 4 }]
  return projectWithFeatures(base, [])
}

interface Mounted {
  closed: () => boolean
  unmount: () => void
}

function mount(element: React.ReactElement): Mounted {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  let closed = false
  root.render(React.createElement(I18nProvider, null, React.cloneElement(
    element as React.ReactElement<{ onClose: () => void }>,
    { onClose: () => { closed = true } },
  )))
  return {
    closed: () => closed,
    unmount: () => {
      root.unmount()
      host.remove()
    },
  }
}

/** Set a field the way typing does: value first, then the event React listens for. */
function typeInto(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter, 'linkedom has an input value setter')
  setter.call(field, value)
  field.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
}

function field(id: string): HTMLInputElement {
  const input = document.body.querySelector(`#${id}`)
  assert.ok(input, `the dialog has #${id}`)
  return input as unknown as HTMLInputElement
}

function applyButton(): HTMLButtonElement {
  const button = document.body.querySelector('.rotary-dialog__create') as unknown as HTMLButtonElement | null
  assert.ok(button, 'the dialog has an Apply action')
  return button
}

/** The stored canned parameters of a feature, as the dialog would write them. */
function storedParams(featureId: string): Record<string, number> {
  const feature = store().project.features.find((row) => row.id === featureId)
  assert.ok(feature, 'the edited feature is stored')
  const canned = store().project.featureDefinitions[feature.definitionId]?.canned
  assert.ok(canned, 'the edited feature stores canned parameters')
  return canned.params as unknown as Record<string, number>
}

/** Move the shared Select to another entry, the way a pointer does. */
async function chooseOption(label: string): Promise<void> {
  const group = document.body.querySelector('.rotary-dialog__direction')
  assert.ok(group, 'the dialog has a direction field')
  ;(group.querySelector('.ui-select__trigger') as unknown as HTMLButtonElement).click()
  await flush()
  const option = Array.from(group.querySelectorAll('.ui-select__option'))
    .find((candidate) => (candidate.textContent ?? '').trim() === label)
  assert.ok(option, `the direction select offers ${label}`)
  option.dispatchEvent(new dom.Event('pointerdown', { bubbles: true }) as unknown as Event)
  await flush()
}

let passCount = 0
let failCount = 0

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passCount += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    failCount += 1
    console.error(`✗ ${name}`)
    console.error(`  ${(error as Error).stack ?? (error as Error).message}`)
  }
}

/** Load the project and make Around the active face, so the dialogs can render. */
function loadProject(): void {
  store().loadProject(rotaryProject())
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
}

await scenario('an untouched Turn edit offers no Apply, and a changed field does', async () => {
  loadProject()
  const created = store().addRotarySolid({ kind: 'turn', start: 0, length: 40, diameter: 20 })
  assert.ok(created.ok, 'the Turn is created')
  const before = JSON.stringify(storedParams(created.featureId))

  const mounted = mount(React.createElement(RotarySolidDialog, { kind: 'turn', featureId: created.featureId, onClose: () => undefined }))
  await waitFor(() => document.querySelector('#rotary-solid-diameter') !== null, 'the edit dialog renders')
  assert.equal(applyButton().disabled, true, 'an untouched Turn has Apply disabled')

  applyButton().click()
  await flush()
  assert.equal(mounted.closed(), false, 'clicking a disabled Apply does not close the dialog')
  assert.equal(JSON.stringify(storedParams(created.featureId)), before, 'clicking a disabled Apply writes nothing')

  typeInto(field('rotary-solid-diameter'), '12')
  await flush()
  assert.equal(applyButton().disabled, false, 'a changed diameter enables Apply')

  typeInto(field('rotary-solid-diameter'), '20')
  await flush()
  assert.equal(applyButton().disabled, true, 'the stored diameter disables Apply again')
  mounted.unmount()
})

await scenario('an enabled Turn Apply writes the typed diameter and closes', async () => {
  loadProject()
  const created = store().addRotarySolid({ kind: 'turn', start: 0, length: 40, diameter: 20 })
  assert.ok(created.ok, 'the Turn is created')

  const mounted = mount(React.createElement(RotarySolidDialog, { kind: 'turn', featureId: created.featureId, onClose: () => undefined }))
  await waitFor(() => document.querySelector('#rotary-solid-diameter') !== null, 'the edit dialog renders')
  typeInto(field('rotary-solid-diameter'), '12')
  await flush()
  applyButton().click()
  await waitFor(() => mounted.closed(), 'Apply closes the dialog')
  assert.equal(storedParams(created.featureId).diameter, 12, 'Apply stored the typed diameter')
  mounted.unmount()
})

await scenario('a polygon edit compares its side count', async () => {
  loadProject()
  const created = store().addRotarySolid({ kind: 'polygon', start: 0, length: 40, sides: 6, acrossFlats: 20 })
  assert.ok(created.ok, 'the polygon is created')

  const mounted = mount(React.createElement(RotarySolidDialog, { kind: 'polygon', featureId: created.featureId, onClose: () => undefined }))
  await waitFor(() => document.querySelector('#rotary-solid-sides') !== null, 'the edit dialog renders')
  assert.equal(applyButton().disabled, true, 'an untouched polygon has Apply disabled')

  typeInto(field('rotary-solid-sides'), '8')
  await flush()
  assert.equal(applyButton().disabled, false, 'a changed side count enables Apply')

  typeInto(field('rotary-solid-sides'), '6')
  await flush()
  assert.equal(applyButton().disabled, true, 'the stored side count disables Apply again')
  mounted.unmount()
})

await scenario('an untouched Thread edit offers no Apply, and a re-typed number is not an edit', async () => {
  loadProject()
  const created = store().addRotaryPattern({ kind: 'thread', start: 5, length: 20, pitch: 2, depth: 1 })
  assert.ok(created.ok, 'the thread is created')

  const mounted = mount(React.createElement(RotaryPatternDialog, { kind: 'thread', featureId: created.featureId, onClose: () => undefined }))
  await waitFor(() => document.querySelector('#rotary-pitch') !== null, 'the edit dialog renders')
  assert.equal(applyButton().disabled, true, 'an untouched thread has Apply disabled')

  // The same number written with a decimal is not a changed value.
  typeInto(field('rotary-start'), '5.0')
  await flush()
  assert.equal(applyButton().disabled, true, 'a re-typed number is not an edit')

  typeInto(field('rotary-pitch'), '2.5')
  await flush()
  assert.equal(applyButton().disabled, false, 'a changed pitch enables Apply')

  typeInto(field('rotary-pitch'), '2')
  await flush()
  assert.equal(applyButton().disabled, true, 'the stored pitch disables Apply again')
  mounted.unmount()
})

await scenario('a Flutes edit ignores a hand that cannot change a straight flute', async () => {
  loadProject()
  const created = store().addRotaryPattern({ kind: 'flutes', start: 5, length: 20, count: 4, twist: 0, depth: 1 })
  assert.ok(created.ok, 'the flutes are created')

  const mounted = mount(React.createElement(RotaryPatternDialog, { kind: 'flutes', featureId: created.featureId, onClose: () => undefined }))
  await waitFor(() => document.querySelector('#rotary-twist') !== null, 'the edit dialog renders')
  assert.equal(applyButton().disabled, true, 'an untouched flute has Apply disabled')

  // A straight flute is straight in either hand: the stored twist is 0 both ways.
  await chooseOption('Left-hand')
  assert.equal(applyButton().disabled, true, 'the hand of a straight flute is not an edit')

  typeInto(field('rotary-twist'), '1')
  await flush()
  assert.equal(applyButton().disabled, false, 'a twist in the left hand enables Apply')

  await chooseOption('Right-hand')
  assert.equal(applyButton().disabled, false, 'the other hand of a twisted flute is still an edit')
  mounted.unmount()
})

await scenario('creation keeps its own Apply: no stored shape to compare against', async () => {
  loadProject()

  const solid = mount(React.createElement(RotarySolidDialog, { kind: 'turn', onClose: () => undefined }))
  await waitFor(() => document.querySelector('#rotary-solid-diameter') !== null, 'the create dialog renders')
  assert.equal(applyButton().disabled, false, 'creating a Turn offers Apply without an edit')
  solid.unmount()

  const pattern = mount(React.createElement(RotaryPatternDialog, { kind: 'thread', onClose: () => undefined }))
  await waitFor(() => document.querySelector('#rotary-pitch') !== null, 'the create dialog renders')
  assert.equal(applyButton().disabled, false, 'creating a thread offers Apply without an edit')
  pattern.unmount()
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) process.exitCode = 1
