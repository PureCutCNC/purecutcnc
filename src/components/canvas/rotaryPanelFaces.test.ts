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
 * Turn and Polygon are created from Top and Bottom as well as Around (issue #1112
 * rt2-b item 20), on round and square bars, and a block still refuses.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/canvas/rotaryPanelFaces.test.ts
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
const { RotarySolidActions } = await import('../layout/toolbar/RotarySolidActions')
const { createRoot } = await import('react-dom/client')
const { defaultStock, defaultTool, getProfileBounds, newProject, roundStock } = await import('../../types/project')
const { squareStock } = await import('../../types/barStock')
type Project = import('../../types/project').Project
type Stock = import('../../types/project').Stock
const { bundledMachines } = await import('../../machine/registry')
const { validateMachineDefinition } = await import('../../engine/gcode/types')
const { projectWithFeatures } = await import('../../test/projectFixtures')
const { switchWorkspaceFace } = await import('../../store/workspaceFace')
const { planRotarySolid } = await import('../../store/helpers/rotarySolids')

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

/** Set a field the way typing does: value first, then the event React listens for. */
function setInputValue(field: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set
  assert.ok(setter, 'linkedom has an input value setter')
  setter.call(field, value)
  field.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
}

function field(id: string): HTMLInputElement {
  const input = document.body.querySelector(`#${id}`)
  assert.ok(input, `the panel shows #${id}`)
  return input as unknown as HTMLInputElement
}

function createButton(): HTMLButtonElement {
  const button = document.body.querySelector('.rotary-panel__create') as unknown as HTMLButtonElement | null
  assert.ok(button, 'the panel has a Create action')
  return button
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

/** Everything about a created canned row a second creation must reproduce. */
function modelSignature(featureId: string) {
  const project = store().project
  const feature = project.features.find((row) => row.id === featureId)
  assert.ok(feature, 'the created feature is stored')
  const definition = project.featureDefinitions[feature.definitionId]
  assert.ok(definition, 'the created definition is stored')
  const asset = definition.stl?.meshAssetId ? project.modelAssets[definition.stl.meshAssetId] : undefined
  return {
    canned: definition.canned,
    authoringFace: feature.authoringFace,
    kind: definition.kind,
    mesh: asset
      ? { vertexCount: asset.vertexCount, bounds: asset.bounds }
      : null,
    treeIndex: project.featureTree.findIndex((entry) => entry.type === 'feature' && entry.featureId === featureId),
    historyEntries: store().history.past.length,
    span: { z_top: Number(feature.z_top), z_bottom: Number(feature.z_bottom) },
  }
}

/** The bar's own numbers, so one fixture matrix works in mm and inch alike. */
function isBarFixture(stock: Stock): stock is Extract<Stock, { axis: 'x' | 'y' }> {
  return stock.shape === 'round' || stock.shape === 'square'
}

function barOf(fixture: Fixture): { thickness: number; length: number } {
  const bounds = getProfileBounds(fixture.stock.profile)
  return {
    thickness: fixture.stock.thickness,
    length: isBarFixture(fixture.stock) && fixture.stock.axis === 'y'
      ? bounds.maxY - bounds.minY
      : bounds.maxX - bounds.minX,
  }
}

/** The one feature creation added, or null. */
function createdFeatureId(before: Set<string>): string {
  const created = store().project.features.find((feature) => !before.has(feature.id))
  assert.ok(created, 'creation added one feature')
  return created.id
}

function featureIds(): Set<string> {
  return new Set(store().project.features.map((feature) => feature.id))
}

/** Open the canvas with Around, Top or Bottom active. */
function loadOn(fixture: Fixture, face: 'around' | 'top' | 'bottom'): void {
  store().loadProject(rotaryProject(fixture))
  assert.equal(switchWorkspaceFace(face), true, `the workspace enters ${face}`)
}

// ---------------------------------------------------------------------------
// Item 20: Turn and Polygon from Top and Bottom, on both bar shapes.
// ---------------------------------------------------------------------------

await scenario('Turn and Polygon created on Top or Bottom are the Around model', async () => {
  const reference = new Map<string, unknown>()
  for (const fixture of fixtures()) {
    for (const kind of ['turn', 'polygon'] as const) {
      const bar = barOf(fixture)
      const fields = kind === 'turn'
        ? { start: String(bar.length * 0.1), length: String(bar.length * 0.5), diameter: String(bar.thickness * 0.5) }
        : {
            start: String(bar.length * 0.05),
            length: String(bar.length * 0.5),
            sides: '6',
            'across-flats': String(bar.thickness * 0.5),
            rotation: '0',
          }
      for (const face of ['around', 'top', 'bottom'] as const) {
        // Created through the panel, on the face itself: that is item 20.
        loadOn(fixture, face)
        mountHost()
        store().startAddRotarySolidPlacement(kind)
        await waitFor(() => document.body.querySelector('#rotary-solid-start') !== null, `the panel opens on ${face}`)
        const before = featureIds()
        for (const [name, value] of Object.entries(fields)) {
          setInputValue(field(`rotary-solid-${name}`), value)
        }
        await flush()
        assert.equal(createButton().disabled, false, `${fixture.name}/${kind}: the form offers Create on ${face}`)
        createButton().click()
        await waitFor(() => store().project.features.length === before.size + 1, `${fixture.name}/${kind} is created on ${face}`)
        const signature = modelSignature(createdFeatureId(before))
        assert.notEqual(signature.mesh, null, `${fixture.name}/${kind} on ${face} has a mesh`)
        if (face === 'around') reference.set(`${fixture.name}/${kind}`, signature)
        else assert.deepEqual(signature, reference.get(`${fixture.name}/${kind}`), `${fixture.name}/${kind} made on ${face} is the Around model`)
        unmountHost()
      }
    }
  }
})

await scenario('the Turn/Polygon entries are offered on every face of a bar project', async () => {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(I18nProvider, null, React.createElement(RotarySolidActions)))
  const count = () => document.body.querySelectorAll('[data-command^="rotary-"]').length

  loadOn(fixtures()[0]!, 'around')
  await flush()
  assert.equal(count(), 2, 'Around offers Turn and Polygon')
  assert.equal(switchWorkspaceFace('top'), true, 'the workspace goes to Top')
  await flush()
  assert.equal(count(), 2, 'Top offers Turn and Polygon too')
  assert.equal(switchWorkspaceFace('bottom'), true, 'the workspace goes to Bottom')
  await flush()
  assert.equal(count(), 2, 'Bottom offers Turn and Polygon too')

  // A block is not a bar: the entries are absent and the store arms nothing.
  const block = rotaryProject(fixtures()[0]!)
  store().loadProject({ ...block, stock: defaultStock(60, 40, 20, 'mm') })
  await flush()
  assert.equal(count(), 0, 'a block offers neither entry')
  assert.equal(store().startAddRotarySolidPlacement('turn'), undefined, 'arming is a no-op')
  assert.equal(store().pendingAdd, null, 'a block arms no rotary session')
  root.unmount()
  host.remove()
})

await scenario('a block stock refuses a Turn and a Polygon', async () => {
  const fixture = fixtures()[0]!
  const project = rotaryProject(fixture)
  const block = { ...project, stock: { ...project.stock, shape: 'block' as const } }
  assert.deepEqual(planRotarySolid(block, store().selection, { kind: 'turn', start: 0, length: 10, diameter: 10 }),
    { ok: false, reason: 'notOnBar' }, 'a Turn is refused on a block')
  assert.deepEqual(planRotarySolid(block, store().selection, { kind: 'polygon', start: 0, length: 10, sides: 6, acrossFlats: 10 }),
    { ok: false, reason: 'notOnBar' }, 'a Polygon is refused on a block')
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) process.exitCode = 1
