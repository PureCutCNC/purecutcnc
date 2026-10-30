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
 * The Turn profile field explains itself (issue #1112 rt2-b items 16 and 17):
 * the hint appears exactly while nothing qualifies, Refresh is hidden while None
 * is selected, and the picture carries a translated label.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/canvas/rotaryPanelProfile.test.ts
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
// without this every controlled field would fall back to the legacy change
// path and take no edits at all — a silently inert test.
if (!('oninput' in (document as unknown as object))) {
  Object.defineProperty(document, 'oninput', { value: null, writable: true, configurable: true })
}
globals.React = React

const { useProjectStore } = await import('../../store/projectStore')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { RotarySolidPanel } = await import('./RotarySolidPanel')
const { RotaryPatternPanel } = await import('./RotaryPatternPanel')
const { CannedShapeEditPanel } = await import('./CannedShapeEditPanel')
const { createRoot } = await import('react-dom/client')
const { defaultTool, newProject, roundStock } = await import('../../types/project')
const { squareStock } = await import('../../types/barStock')
type Project = import('../../types/project').Project
type Stock = import('../../types/project').Stock
const { bundledMachines } = await import('../../machine/registry')
const { validateMachineDefinition } = await import('../../engine/gcode/types')
const { projectWithFeatures } = await import('../../test/projectFixtures')
const { switchWorkspaceFace } = await import('../../store/workspaceFace')

const store = () => useProjectStore.getState()

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20))
}

async function waitFor(predicate: () => boolean, message: string, timeoutMs = 3000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(message)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const dom = window as unknown as {
  Event: new (type: string, init?: { bubbles?: boolean }) => object
  HTMLInputElement: { prototype: { value: string } }
}

function field(id: string): HTMLInputElement {
  const input = document.body.querySelector(`#${id}`)
  assert.ok(input, `the panel shows #${id}`)
  return input as unknown as HTMLInputElement
}

/**
 * The canvas renderer for the open create session: the same shape
 * `CanvasCreationPanel` dispatches, so the panel is mounted exactly as the app
 * mounts it.
 */
/** The panel only reads these for positioning; the harness has no canvas. */
const NO_CONTAINER = { current: null } as React.RefObject<HTMLElement | null>
const NO_CANVAS = { current: null } as React.RefObject<HTMLElement | null>

function PanelHost() {
  const pendingAdd = useProjectStore((state) => state.pendingAdd)
  const cancelPendingAdd = useProjectStore((state) => state.cancelPendingAdd)
  if (pendingAdd?.shape === 'rotary-solid') {
    return React.createElement(RotarySolidPanel, { kind: pendingAdd.kind, onClose: cancelPendingAdd })
  }
  if (pendingAdd?.shape === 'rotary-pattern') {
    return React.createElement(RotaryPatternPanel, { kind: pendingAdd.kind, onClose: cancelPendingAdd })
  }
  // Properties arms a `canned-edit` session; the edit panel dispatches the four
  // rotary kinds to their own panels, the same way the app does.
  if (pendingAdd?.shape === 'canned-edit') {
    return React.createElement(CannedShapeEditPanel, {
      key: pendingAdd.session,
      pending: pendingAdd,
      containerRef: NO_CONTAINER,
      canvasRef: NO_CANVAS,
      clearTransientCanvasState: () => undefined,
    })
  }
  return null
}

let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null

function mountHost(): void {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(I18nProvider, null, React.createElement(PanelHost)))
  mounted = { root, host }
}

function unmountHost(): void {
  if (!mounted) return
  store().cancelPendingAdd()
  mounted.root.unmount()
  mounted.host.remove()
  mounted = null
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
  } finally {
    unmountHost()
  }
}

interface Fixture {
  name: string
  stock: Stock
  units: 'mm' | 'inch'
}

/** A round bar and a square blank, in both unit systems. */
function fixtures(): Fixture[] {
  return [
    { name: 'mm round bar', stock: roundStock(40, 200, 'x', { x: 10, y: 30 }), units: 'mm' },
    { name: 'mm square blank', stock: squareStock(25, 120, 'x'), units: 'mm' },
    { name: 'inch round bar', stock: roundStock(1.5, 8, 'x', { x: 0.5, y: 1 }), units: 'inch' },
    { name: 'mm Y bar', stock: roundStock(30, 160, 'y', { x: 20, y: 20 }), units: 'mm' },
  ]
}

/** True for bar stock, so the machine's rotary axis can be read from it. */
function isBarFixture(stock: Stock): stock is Extract<Stock, { axis: 'x' | 'y' }> {
  return stock.shape === 'round' || stock.shape === 'square'
}

function rotaryProject(fixture: Fixture): Project {
  const base = newProject('Rotary panel', fixture.units)
  base.meta.projectType = 'rotary'
  base.stock = fixture.stock
  const machine = validateMachineDefinition({
    ...structuredClone(bundledMachines()[0]),
    id: 'rotary-panel',
    rotary: {
      about: isBarFixture(fixture.stock) ? fixture.stock.axis : 'x',
      drive: 'own',
      reversed: false,
      inverseTimeFeed: { on: 'G93', off: 'G94' },
    },
  })
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = [{ ...defaultTool(fixture.units, 1), id: 'ball', type: 'ball_endmill', diameter: 4 }]
  return projectWithFeatures(base, [])
}

// ---------------------------------------------------------------------------
// Items 16 and 17: the profile picker explains itself.
// ---------------------------------------------------------------------------

/** A drawn half profile on Top, the shape the picker lists. */
function withHalfProfile(fixture: Fixture): Project {
  const project = rotaryProject(fixture)
  return projectWithFeatures(project, [{
    id: 'f-half-profile',
    name: 'Half profile',
    kind: 'spline',
    folderId: null,
    sketch: {
      profile: {
        start: { x: 30, y: 50 },
        segments: [
          { type: 'line', to: { x: 60, y: 40 } },
          { type: 'line', to: { x: 60, y: 50 } },
        ],
        closed: false,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'construction',
    authoringFace: 'top',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }])
}

async function openTurnPanel(project: Project): Promise<void> {
  store().loadProject(project)
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  mountHost()
  store().startAddRotarySolidPlacement('turn')
  await waitFor(() => document.body.querySelector('.rotary-solid-panel') !== null, 'the Turn panel opens')
}

await scenario('the empty profile list shows the drawing hint, and Refresh stays hidden for None', async () => {
  const fixture = fixtures()[0]!
  await openTurnPanel(rotaryProject(fixture))

  const hint = document.body.querySelector('.rotary-panel__profile-empty')
  assert.ok(hint, 'the hint is shown when no shape qualifies')
  assert.match(hint.textContent ?? '', /Draw a half profile/)
  assert.equal(document.body.querySelectorAll('.rotary-panel__profile-refresh').length, 0, 'Refresh is hidden while None is selected')
  // Item 17: the picture and its explanation are beside the picker.
  const figure = document.body.querySelector('.rotary-panel__profile-figure')
  assert.ok(figure, 'the Turn form shows the profile picture')
  const label = figure.querySelector('svg')?.getAttribute('aria-label') ?? ''
  assert.match(label, /half profile/i, 'the picture has a translated label')
  assert.doesNotMatch(label, /^dialogs\./, 'the label is not a raw catalog key')
  assert.ok((figure.querySelector('figcaption')?.textContent ?? '').length > 0, 'the picture carries the explanation')
})

await scenario('a qualifying shape removes the hint, and picking it shows Refresh', async () => {
  const fixture = fixtures()[0]!
  await openTurnPanel(withHalfProfile(fixture))

  assert.equal(document.body.querySelectorAll('.rotary-panel__profile-empty').length, 0, 'a candidate hides the hint')
  assert.equal(document.body.querySelectorAll('.rotary-panel__profile-refresh').length, 0, 'None still hides Refresh')

  const trigger = document.body.querySelector('.rotary-panel__profile .ui-select__trigger')
  assert.ok(trigger, 'the picker is rendered')
  ;(trigger as unknown as HTMLButtonElement).click()
  await flush()
  const option = Array.from(document.body.querySelectorAll('.rotary-panel__profile .ui-select__option'))
    .find((candidate) => (candidate.textContent ?? '').trim() === 'Half profile')
  assert.ok(option, 'the picker lists the drawn half profile')
  option.dispatchEvent(new dom.Event('pointerdown', { bubbles: true }) as unknown as Event)
  await flush()

  const refresh = document.body.querySelector('.rotary-panel__profile-refresh') as HTMLButtonElement | null
  assert.ok(refresh, 'a picked shape shows Refresh')
  assert.equal(refresh.disabled, false, 'Refresh can re-read a live source')
  // The copied profile owns the extent, so the numbers are read-only.
  assert.equal(field('rotary-solid-start').disabled, true, 'the profile sets the start')
  assert.equal(field('rotary-solid-diameter').disabled, true, 'the profile sets the diameter')
  assert.equal(document.body.querySelectorAll('.rotary-panel__profile-empty').length, 0, 'the hint stays away')
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) process.exitCode = 1
