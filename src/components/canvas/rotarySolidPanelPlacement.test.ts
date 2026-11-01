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
 * Turn/Polygon Save keeps each instance's placement (issue #1112 G review).
 *
 * The bug this pins was in the editor itself, not the store: its apply handler
 * wrote the regenerated mesh's raw Z bounds onto the edited instance, so a
 * parameter edit reset its placement (and its `stl.scale`) while linked copies
 * kept theirs. Rendering the real panel is the only way to catch a
 * reintroduced explicit `z_bottom`/`z_top` patch; a store-level test that only
 * calls `updateFeature({ canned })` cannot see it.
 *
 * Run with: npx tsx src/components/canvas/rotarySolidPanelPlacement.test.ts
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
// Components use the automatic JSX runtime; the tsx runner transpiles this file
// with the classic one, which expects a global `React`.
globals.React = React

const { useProjectStore } = await import('../../store/projectStore')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { RotarySolidPanel } = await import('./RotarySolidPanel')
const { createRoot } = await import('react-dom/client')
const { defaultTool, newProject, roundStock } = await import('../../types/project')
const { bundledMachines } = await import('../../machine/registry')
const { validateMachineDefinition } = await import('../../engine/gcode/types')
const { projectWithFeatures } = await import('../../test/projectFixtures')
const { switchWorkspaceFace } = await import('../../store/workspaceFace')

const store = () => useProjectStore.getState()

function near(actual: number, expected: number, label: string, tolerance = 5e-3): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Set a field the way typing does: value first, then the event React listens for. */
function setInputValue(field: HTMLInputElement, value: string): void {
  const prototype = Object.getPrototypeOf(field) as { value: string }
  const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set
  assert.ok(setter, 'linkedom has an input value setter')
  setter.call(field, value)
  field.dispatchEvent(new (window as unknown as {
    Event: new (type: string, init?: { bubbles?: boolean }) => object
  }).Event('input', { bubbles: true }) as unknown as Event)
}

function rotaryProject(): ReturnType<typeof newProject> {
  const base = newProject('Dialog placement', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(40, 200, 'x', { x: 10, y: 30 })
  const machine = validateMachineDefinition({
    ...structuredClone(bundledMachines()[0]),
    id: 'around-dialog',
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = [{ ...defaultTool('mm', 1), id: 'ball', type: 'ball_endmill', diameter: 4 }]
  return projectWithFeatures(base, [])
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

await scenario('Apply keeps a scaled, Z-moved instance and its linked copy in place', async () => {
  store().loadProject(rotaryProject())
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  const created = store().addRotarySolid({ kind: 'turn', start: 0, length: 40, diameter: 20 })
  assert.ok(created.ok, 'the Turn is created')
  if (!created.ok) return
  const model = store().project.features[0]!
  const definition = store().project.featureDefinitions[model.definitionId]!
  assert.ok(definition.stl)

  // A scaled model moved down: centre 10, scaled height 20 × 2.
  store().updateFeature(model.id, { stl: { ...definition.stl, scale: 2 } })
  store().updateFeature(model.id, { z_bottom: -10, z_top: 30 })
  const scaled = store().project.features[0]!
  // A linked copy shares the definition but not its placement: centre -10.
  store().loadProject({
    ...store().project,
    features: [scaled, { ...scaled, id: 'linked', name: 'Linked copy', z_bottom: -30, z_top: 10 }],
  })
  assert.equal(switchWorkspaceFace('around'), true, 'Around survives the load')

  // A stored Turn of diameter 20 that the panel's form will edit down to 10.
  // The store update places both rows correctly; Apply then rewrites the
  // parameters, which is where the editor used to pin the raw mesh bounds and
  // undo that placement. The edit is typed into the form because Apply is
  // disabled while the form still holds the stored parameters (issue #1112 F4).
  const storedCanned = store().project.featureDefinitions[model.definitionId]?.canned
  assert.equal(storedCanned?.params.diameter, 20, 'the stored Turn has the created diameter')

  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  let closed = false
  root.render(React.createElement(
    I18nProvider,
    null,
    React.createElement(RotarySolidPanel, {
      kind: 'turn',
      featureId: model.id,
      onClose: () => { closed = true },
    }),
  ))

  await waitFor(() => document.querySelector('#rotary-solid-diameter') !== null, 'the edit panel renders')
  const diameter = document.querySelector('#rotary-solid-diameter') as HTMLInputElement
  assert.equal(diameter.value, '20', 'the panel shows the stored diameter')
  setInputValue(diameter, '10')
  await new Promise((resolve) => setTimeout(resolve, 20))

  const apply = document.querySelector('.rotary-panel__create') as HTMLButtonElement | null
  assert.ok(apply, 'the panel has a Save action')
  assert.equal(apply.disabled, false, 'Save is enabled')
  apply.click()
  await waitFor(() => closed, 'Save closes the panel')

  const project = store().project
  const edited = project.features.find((feature) => feature.id === model.id)
  const linked = project.features.find((feature) => feature.id === 'linked')
  assert.ok(edited && linked, 'both rows survive the edit')
  // New diameter 10 at scale 2 is a 20-high span around each row's own centre.
  near(Number(edited.z_bottom), 0, 'the edited row keeps its centre')
  near(Number(edited.z_top), 20, 'the edited row takes the scaled height')
  near(Number(linked.z_bottom), -20, 'the linked copy keeps its own centre')
  near(Number(linked.z_top), 0, 'the linked copy follows the new height')
  assert.equal(
    project.featureDefinitions[edited.definitionId]?.stl?.scale,
    2,
    'the user scale survives the parameter edit',
  )

  const saved = store().saveProject()
  store().openProjectFromText(saved, null)
  const after = store().project.features.find((feature) => feature.id === model.id)
  const afterLinked = store().project.features.find((feature) => feature.id === 'linked')
  assert.ok(after && afterLinked, 'both rows survive save/load')
  near(Number(after.z_bottom), 0, 'save/load keeps the edited placement')
  near(Number(after.z_top), 20, 'save/load keeps the edited height')
  near(Number(afterLinked.z_bottom), -20, 'save/load keeps the linked placement')
  near(Number(afterLinked.z_top), 0, 'save/load keeps the linked height')

  root.unmount()
  host.remove()
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) process.exitCode = 1
