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
 * A rotary form is dropped when its physical context changes (issue #1112).
 *
 * Playwright cannot be run in this worker, so this pins the failing step of
 * `aroundSketch.smoke.spec.ts` — "a solid form is dropped when the bar, units,
 * document or face behind it change" — at the dialog-state level instead: the
 * real hosts are mounted over the real store, and the same store actions the
 * spec drives (resize the bar, convert units, replace the document, move the
 * machine origin, switch face) must close the rendered form. The pre-slice-G
 * dialog keyed on these and the slice-G rewrite silently dropped the origin,
 * which is the step that failed (#1016 C2-U2F, #1112 G/F).
 *
 * Thread/Flutes is covered too, because slice F had the same hole: its host
 * only closed on a face change, so a form filled against one bar could post
 * numbers measured against another.
 *
 * Run with: npx tsx src/components/layout/toolbar/rotaryDialogContext.test.ts
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
// Components use the automatic JSX runtime; the tsx runner transpiles this file
// with the classic one, which expects a global `React`.
globals.React = React

const { useProjectStore } = await import('../../../store/projectStore')
const { I18nProvider } = await import('../../../i18n/I18nProvider')
const { RotarySolidDialogHost } = await import('./RotarySolidDialog')
const { RotaryPatternDialogHost } = await import('./RotaryPatternDialog')
const { openRotarySolidCreate, openRotarySolidEdit, closeRotarySolidDialog } = await import('./rotarySolidDialogState')
const { openRotaryPatternCreate, openRotaryPatternEdit, closeRotaryPatternDialog } = await import('./rotaryPatternDialogState')
const { rotaryDialogContextKey } = await import('./rotaryDialogContext')
const { createRoot } = await import('react-dom/client')
const { defaultTool, defaultTopSetup, newProject, roundStock } = await import('../../../types/project')
const { bundledMachines } = await import('../../../machine/registry')
const { validateMachineDefinition } = await import('../../../engine/gcode/types')
const { projectWithFeatures } = await import('../../../test/projectFixtures')
const { switchWorkspaceFace } = await import('../../../store/workspaceFace')
const { originAfterStockEdit, resizeRoundStock } = await import('../../../store/helpers/stockShape')

const store = () => useProjectStore.getState()

function rotaryProject(): ReturnType<typeof newProject> {
  const base = newProject('Dialog context', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(40, 200, 'x', { x: 10, y: 30 })
  const machine = validateMachineDefinition({
    ...structuredClone(bundledMachines()[0]),
    id: 'around-context',
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = [{ ...defaultTool('mm', 1), id: 'ball', type: 'ball_endmill', diameter: 4 }]
  return projectWithFeatures(base, [])
}

/** Load the fixture and enter Around, the state both creation dialogs need. */
function loadAroundProject(): ReturnType<typeof newProject> {
  const project = rotaryProject()
  store().loadProject(project)
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  return project
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 2000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** Drive one controlled dialog input the way a user typing does. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter, 'the DOM exposes the native value setter')
  setter!.call(input, value)
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

function solidDialog(): Element | null {
  return document.querySelector('#rotary-solid-dialog-title')
}

function patternDialog(): Element | null {
  return document.querySelector('#rotary-dialog-title')
}

interface Mounted {
  root: ReturnType<typeof createRoot>
  host: HTMLElement
}

/** The two real hosts, over the real store, mounted once per scenario. */
function mountHosts(): Mounted {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(
    I18nProvider,
    null,
    React.createElement(RotarySolidDialogHost),
    React.createElement(RotaryPatternDialogHost),
  ))
  return { root, host }
}

function unmount({ root, host }: Mounted): void {
  closeRotarySolidDialog()
  closeRotaryPatternDialog()
  root.unmount()
  host.remove()
}

/** Resize the live bar exactly as the Properties panel does. */
function editBar(change: { diameter?: number; length?: number; axis?: 'x' | 'y' }): void {
  const stock = store().project.stock
  if (stock.shape !== 'round') throw new Error('the fixture is not a round bar')
  const resized = resizeRoundStock(stock, change)
  store().setStockAndOrigin(resized, originAfterStockEdit(store().project.origin, stock, resized))
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

// ---------------------------------------------------------------------------
// The key itself: one trigger per scenario, so a regression names its field.
// ---------------------------------------------------------------------------

await scenario('the context key changes with the document session', async () => {
  const project = rotaryProject()
  assert.notEqual(rotaryDialogContextKey(project, 0), rotaryDialogContextKey(project, 1))
})

await scenario('the context key changes with the units', async () => {
  const project = rotaryProject()
  assert.notEqual(
    rotaryDialogContextKey(project, 0),
    rotaryDialogContextKey({ ...project, meta: { ...project.meta, units: 'inch' } }, 0),
  )
})

await scenario('the context key changes with the workflow type', async () => {
  const project = rotaryProject()
  assert.notEqual(
    rotaryDialogContextKey(project, 0),
    rotaryDialogContextKey({ ...project, meta: { ...project.meta, projectType: 'milling' } }, 0),
  )
})

await scenario('the context key changes with the bar shape, axis, diameter and box', async () => {
  const project = rotaryProject()
  const key = rotaryDialogContextKey(project, 0)
  assert.notEqual(
    key,
    rotaryDialogContextKey({ ...project, stock: { ...project.stock, shape: 'square', axis: 'x' } }, 0),
  )
  assert.notEqual(
    key,
    rotaryDialogContextKey({ ...project, stock: roundStock(40, 200, 'y', { x: 10, y: 30 }) }, 0),
  )
  assert.notEqual(
    key,
    rotaryDialogContextKey({ ...project, stock: roundStock(30, 200, 'x', { x: 10, y: 30 }) }, 0),
  )
  assert.notEqual(
    key,
    rotaryDialogContextKey({ ...project, stock: roundStock(40, 100, 'x', { x: 10, y: 30 }) }, 0),
  )
})

await scenario('the context key changes with each machine-origin coordinate', async () => {
  const project = rotaryProject()
  const key = rotaryDialogContextKey(project, 0)
  for (const axis of ['x', 'y', 'z'] as const) {
    assert.notEqual(
      key,
      rotaryDialogContextKey({
        ...project,
        origin: { ...project.origin, [axis]: project.origin[axis] + 5 },
      }, 0),
    )
  }
})

await scenario('the context key changes with the active setup', async () => {
  const project = rotaryProject()
  const around = {
    ...defaultTopSetup(),
    id: 'around',
    name: 'Around',
    kind: 'around' as const,
    orientation: { axis: 'x' as const, angleDeg: 0 },
  }
  const withAround = {
    ...project,
    setups: [...project.setups, around],
    activeSetupId: around.id,
  }
  assert.notEqual(rotaryDialogContextKey(project, 0), rotaryDialogContextKey(withAround, 0))
  // A rotated setup re-maps the bar's axes, so it is a context change too.
  assert.notEqual(
    rotaryDialogContextKey(withAround, 0),
    rotaryDialogContextKey({
      ...withAround,
      setups: [project.setups[0]!, { ...around, orientation: { axis: 'x', angleDeg: 90 } }],
    }, 0),
  )
})

await scenario('the context key ignores changes a form is not measured against', async () => {
  const project = rotaryProject()
  const key = rotaryDialogContextKey(project, 0)
  assert.equal(
    key,
    rotaryDialogContextKey({
      ...project,
      meta: { ...project.meta, name: 'renamed', modified: new Date(0).toISOString() },
    }, 0),
  )
})

// ---------------------------------------------------------------------------
// The real host: the rendered Turn/Polygon form drops on every trigger.
// ---------------------------------------------------------------------------

await scenario('a Turn/Polygon create form drops when the face changes', async () => {
  loadAroundProject()
  const mounted = mountHosts()
  try {
    openRotarySolidCreate('polygon')
    await waitFor(() => solidDialog() !== null, 'the polygon dialog opens')
    assert.equal(switchWorkspaceFace('top'), true, 'the workspace leaves Around')
    await waitFor(() => solidDialog() === null, 'the face change closes the dialog')
  } finally {
    unmount(mounted)
  }
})

await scenario('a Turn/Polygon create form drops when the units change', async () => {
  loadAroundProject()
  const mounted = mountHosts()
  try {
    openRotarySolidCreate('polygon')
    await waitFor(() => solidDialog() !== null, 'the polygon dialog opens')
    store().setUnits('inch', 'convert')
    await waitFor(() => solidDialog() === null, 'the units conversion closes the dialog')
  } finally {
    unmount(mounted)
  }
})

await scenario('a Turn/Polygon create form drops when the document is replaced', async () => {
  loadAroundProject()
  const mounted = mountHosts()
  try {
    openRotarySolidCreate('polygon')
    await waitFor(() => solidDialog() !== null, 'the polygon dialog opens')
    store().loadProject(rotaryProject())
    await waitFor(() => solidDialog() === null, 'the document load closes the dialog')
  } finally {
    unmount(mounted)
  }
})

await scenario('a Turn/Polygon create form drops when the bar moves', async () => {
  loadAroundProject()
  const mounted = mountHosts()
  try {
    openRotarySolidCreate('polygon')
    await waitFor(() => solidDialog() !== null, 'the polygon dialog opens')
    editBar({ axis: 'y' })
    await waitFor(() => solidDialog() === null, 'the bar-axis change closes the dialog')
  } finally {
    unmount(mounted)
  }
})

await scenario('a Turn/Polygon create form drops when the bar is resized', async () => {
  loadAroundProject()
  const mounted = mountHosts()
  try {
    openRotarySolidCreate('polygon')
    await waitFor(() => solidDialog() !== null, 'the polygon dialog opens')
    editBar({ diameter: 30 })
    await waitFor(() => solidDialog() === null, 'the diameter change closes the dialog')
  } finally {
    unmount(mounted)
  }
})

await scenario('a Turn/Polygon create form drops when the bar is shortened', async () => {
  loadAroundProject()
  const mounted = mountHosts()
  try {
    openRotarySolidCreate('polygon')
    await waitFor(() => solidDialog() !== null, 'the polygon dialog opens')
    editBar({ length: 100 })
    await waitFor(() => solidDialog() === null, 'the bar-length change closes the dialog')
  } finally {
    unmount(mounted)
  }
})

await scenario('a Turn/Polygon create form drops when the machine origin changes', async () => {
  loadAroundProject()
  const mounted = mountHosts()
  try {
    openRotarySolidCreate('polygon')
    await waitFor(() => solidDialog() !== null, 'the polygon dialog opens')
    const origin = store().project.origin
    store().setOrigin({ ...origin, x: origin.x + 5 })
    await waitFor(() => solidDialog() === null, 'the origin change closes the dialog')
  } finally {
    unmount(mounted)
  }
})

await scenario('a Turn/Polygon Edit form drops when the context changes, and opens off-Around', async () => {
  const project = loadAroundProject()
  const created = store().addRotarySolid({ kind: 'turn', start: 0, length: 40, diameter: 20 })
  assert.ok(created.ok, 'the Turn is created')
  if (!created.ok) return
  // Properties offers Edit on any face: opening it on Top must not close it.
  assert.equal(switchWorkspaceFace('top'), true, 'the workspace goes to Top')
  const mounted = mountHosts()
  try {
    openRotarySolidEdit('turn', created.featureId)
    await waitFor(() => solidDialog() !== null, 'the Edit dialog opens on Top')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.notEqual(solidDialog(), null, 'the Edit dialog survives opening off-Around')
    const origin = store().project.origin
    store().setOrigin({ ...origin, y: origin.y + 5 })
    await waitFor(() => solidDialog() === null, 'the origin change closes the Edit dialog')
    // The model and its definition are untouched by the dropped form.
    assert.equal(store().project.features.length, project.features.length + 1)
  } finally {
    unmount(mounted)
  }
})

// ---------------------------------------------------------------------------
// The real host: Thread/Flutes follows the same rule (slice F).
// ---------------------------------------------------------------------------

await scenario('a Thread/Flutes create form drops when the machine origin changes', async () => {
  loadAroundProject()
  const mounted = mountHosts()
  try {
    openRotaryPatternCreate('thread')
    await waitFor(() => patternDialog() !== null, 'the thread dialog opens')
    const origin = store().project.origin
    store().setOrigin({ ...origin, x: origin.x + 5 })
    await waitFor(() => patternDialog() === null, 'the origin change closes the dialog')
  } finally {
    unmount(mounted)
  }
})

await scenario('a Thread/Flutes create form drops when the units change', async () => {
  loadAroundProject()
  const mounted = mountHosts()
  try {
    openRotaryPatternCreate('thread')
    await waitFor(() => patternDialog() !== null, 'the thread dialog opens')
    store().setUnits('inch', 'convert')
    await waitFor(() => patternDialog() === null, 'the units conversion closes the dialog')
  } finally {
    unmount(mounted)
  }
})

await scenario('a Thread/Flutes create form drops when the bar is resized', async () => {
  loadAroundProject()
  const mounted = mountHosts()
  try {
    openRotaryPatternCreate('flutes')
    await waitFor(() => patternDialog() !== null, 'the flutes dialog opens')
    editBar({ diameter: 30 })
    await waitFor(() => patternDialog() === null, 'the diameter change closes the dialog')
  } finally {
    unmount(mounted)
  }
})

await scenario('a Thread/Flutes create form drops when the document is replaced', async () => {
  loadAroundProject()
  const mounted = mountHosts()
  try {
    openRotaryPatternCreate('flutes')
    await waitFor(() => patternDialog() !== null, 'the flutes dialog opens')
    store().loadProject(rotaryProject())
    await waitFor(() => patternDialog() === null, 'the document load closes the dialog')
  } finally {
    unmount(mounted)
  }
})

await scenario('a Thread/Flutes Edit form drops when the context changes, and opens off-Around', async () => {
  const project = loadAroundProject()
  const created = store().addRotaryPattern({ kind: 'thread', start: 20, length: 60, pitch: 2, depth: 1 })
  assert.ok(created.ok, 'the thread is created')
  if (!created.ok) return
  // Properties offers Edit on any face: opening it on Top must not close it.
  assert.equal(switchWorkspaceFace('top'), true, 'the workspace goes to Top')
  const mounted = mountHosts()
  try {
    openRotaryPatternEdit('thread', created.featureId)
    await waitFor(() => patternDialog() !== null, 'the Thread Edit dialog opens on Top')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.notEqual(patternDialog(), null, 'the Thread Edit dialog survives opening off-Around')
    const origin = store().project.origin
    store().setOrigin({ ...origin, y: origin.y + 5 })
    await waitFor(() => patternDialog() === null, 'the origin change closes the Thread Edit dialog')
    // The stored feature is untouched by the dropped form.
    assert.equal(store().project.features.length, project.features.length + 1)
  } finally {
    unmount(mounted)
  }
})

await scenario('a mounted rotary form ignores an unrelated store update and an in-dialog parameter edit', async () => {
  loadAroundProject()
  const mounted = mountHosts()
  try {
    openRotaryPatternCreate('thread')
    await waitFor(() => patternDialog() !== null, 'the thread dialog opens')

    // A store update that is not part of the physical context must not close a
    // half-filled form.
    store().setProjectName('Renamed while typing')
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.notEqual(patternDialog(), null, 'an unrelated project-name change keeps the dialog open')

    // Typing a parameter is dialog-local state, not a context change either.
    const start = document.querySelector('#rotary-start') as HTMLInputElement | null
    assert.ok(start, 'the thread dialog shows its start field')
    if (start) setInputValue(start, '12')
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.notEqual(patternDialog(), null, 'editing a parameter inside the dialog keeps it open')
    assert.equal(
      (document.querySelector('#rotary-start') as HTMLInputElement | null)?.value,
      '12',
      'the dialog holds the edited parameter',
    )
  } finally {
    unmount(mounted)
  }
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) process.exitCode = 1
