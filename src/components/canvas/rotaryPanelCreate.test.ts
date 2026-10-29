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
 * The four rotary kinds create and edit through the canvas panel (issue #1112
 * rt2-b item 18): what the panel writes is compared with what the store action
 * writes for the equivalent input, on a fixture matrix, for creation and edit.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/canvas/rotaryPanelCreate.test.ts
 */


import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
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
const { defaultTool, getProfileBounds, newProject, roundStock } = await import('../../types/project')
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

/**
 * The signature fields a creation and an edit can share: the history depth is
 * the session's own bookkeeping (an edit follows the creation it changes), and
 * the instance span is re-fitted through the store's resolver on the edit path,
 * so it is compared to a micron rather than bit for bit.
 */
function comparableSignature(signature: ReturnType<typeof modelSignature>) {
  const { historyEntries: _history, span, ...rest } = signature
  return {
    ...rest,
    span: {
      z_top: Math.round(span.z_top * 1e4) / 1e4,
      z_bottom: Math.round(span.z_bottom * 1e4) / 1e4,
    },
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
// Item 18: creation through the panel writes what the store action writes.
// ---------------------------------------------------------------------------



interface SolidCase {
  name: string
  kind: 'turn' | 'polygon'
  /** The typed fields and the equivalent store input for one fixture's bar. */
  forBar: (bar: { thickness: number; length: number }) => {
    fields: Record<string, string>
    input: Record<string, number | string>
  }
}

const SOLID_CASES: SolidCase[] = [
  {
    name: 'Turn',
    kind: 'turn',
    forBar: ({ thickness, length }) => {
      const start = length * 0.1
      const band = length * 0.5
      const diameter = thickness * 0.5
      return {
        fields: { start: String(start), length: String(band), diameter: String(diameter) },
        input: { kind: 'turn', start, length: band, diameter },
      }
    },
  },
  {
    name: 'Polygon',
    kind: 'polygon',
    forBar: ({ thickness, length }) => {
      const start = length * 0.05
      const band = length * 0.5
      const acrossFlats = thickness * 0.4
      return {
        fields: {
          start: String(start),
          length: String(band),
          sides: '8',
          'across-flats': String(acrossFlats),
          rotation: '22.5',
        },
        input: { kind: 'polygon', start, length: band, sides: 8, acrossFlats, rotationDeg: 22.5 },
      }
    },
  },
]

for (const testCase of SOLID_CASES) {
  await scenario(`${testCase.name} created in the panel stores the definition the action stores`, async () => {
    for (const fixture of fixtures()) {
      const { fields, input } = testCase.forBar(barOf(fixture))
      loadOn(fixture, 'around')
      mountHost()
      store().startAddRotarySolidPlacement(testCase.kind)
      await waitFor(() => document.body.querySelector('#rotary-solid-start') !== null, 'the panel opens')

      const before = featureIds()
      for (const [name, value] of Object.entries(fields)) {
        setInputValue(field(`rotary-solid-${name}`), value)
      }
      await flush()
      assert.equal(createButton().disabled, false, `${fixture.name}: the filled form offers Create`)
      createButton().click()
      await waitFor(() => store().project.features.length === before.size + 1, `${fixture.name}: the panel created one feature`)
      const fromPanel = modelSignature(createdFeatureId(before))

      // The same project, the same input, straight through the store action.
      loadOn(fixture, 'around')
      const directBefore = featureIds()
      const direct = store().addRotarySolid(input as never)
      assert.ok(direct.ok, `${fixture.name}: the store action creates the model`)
      const fromAction = modelSignature(createdFeatureId(directBefore))

      assert.deepEqual(fromPanel, fromAction, `${fixture.name}: the panel and the action store the same ${testCase.name}`)
      unmountHost()
    }
  })
}

for (const kind of ['thread', 'flutes'] as const) {
  await scenario(`${kind} created in the panel stores the definition the action stores`, async () => {
    // Thread and Flutes are round-bar Around geometry; mm and inch cover the
    // one field the panel transforms (inch threads per inch → physical pitch).
    for (const fixture of fixtures().filter((entry) => entry.stock.shape === 'round' && entry.stock.axis === 'x')) {
      const bar = barOf(fixture)
      const band = bar.length * 0.5
      const depth = bar.thickness * 0.05
      const typedPitch = fixture.units === 'inch' ? 20 : 2
      const fields = kind === 'thread'
        ? { start: '0', length: String(band), pitch: String(typedPitch), starts: '2', depth: String(depth) }
        : { length: String(band), count: '3', twist: '2', depth: String(depth) }
      const input = kind === 'thread'
        ? {
            kind,
            start: 0,
            length: band,
            pitch: fixture.units === 'inch' ? 1 / typedPitch : typedPitch,
            starts: 2,
            hand: 'left',
            depth,
          }
        : { kind, start: 0, length: band, count: 3, twist: -2, depth }

      loadOn(fixture, 'around')
      mountHost()
      store().startAddRotaryPatternPlacement(kind)
      await waitFor(() => document.body.querySelector('.rotary-pattern-panel') !== null, 'the panel opens')

      const before = featureIds()
      for (const [name, value] of Object.entries(fields)) {
        setInputValue(field(`rotary-${name}`), value)
      }
      // Left is the physical hand in both cases; the field keeps the magnitude.
      const trigger = document.body.querySelector('.rotary-panel__direction .ui-select__trigger')
      assert.ok(trigger, 'the panel shows the Direction picker')
      ;(trigger as unknown as HTMLButtonElement).click()
      await flush()
      const option = Array.from(document.body.querySelectorAll('.rotary-panel__direction .ui-select__option'))
        .find((candidate) => (candidate.textContent ?? '').trim() === 'Left-hand')
      assert.ok(option, 'the Direction picker offers Left-hand')
      option.dispatchEvent(new dom.Event('pointerdown', { bubbles: true }) as unknown as Event)
      await flush()
      assert.equal(createButton().disabled, false, `${fixture.name}: the filled form offers Create`)
      createButton().click()
      await waitFor(() => store().project.features.length === before.size + 1, `${fixture.name}: the panel created one feature`)
      const fromPanel = modelSignature(createdFeatureId(before))

      loadOn(fixture, 'around')
      const directBefore = featureIds()
      const direct = store().addRotaryPattern(input as never)
      assert.ok(direct.ok, `${fixture.name}: the store action creates the feature`)
      const fromAction = modelSignature(createdFeatureId(directBefore))

      assert.deepEqual(fromPanel, fromAction, `${fixture.name}: the panel and the action store the same ${kind}`)
      unmountHost()
    }
  })
}


// ---------------------------------------------------------------------------
// Item 18: an edit through the panel writes what a creation with the same
// numbers writes, so the moved form still stores the same definition.
// ---------------------------------------------------------------------------

interface EditCase {
  kind: 'turn' | 'polygon' | 'thread' | 'flutes'
  create: Record<string, number | string>
  /** The stored payload a creation with the edited numbers must produce. */
  edited: Record<string, number | string>
  fields: Record<string, string>
}

const EDIT_CASES: EditCase[] = [
  {
    kind: 'turn',
    create: { kind: 'turn', start: 0, length: 40, diameter: 20 },
    edited: { kind: 'turn', start: 8, length: 24, diameter: 16 },
    fields: { start: '8', length: '24', diameter: '16' },
  },
  {
    kind: 'polygon',
    create: { kind: 'polygon', start: 0, length: 40, sides: 6, acrossFlats: 20, rotationDeg: 0 },
    edited: { kind: 'polygon', start: 6, length: 20, sides: 8, acrossFlats: 16, rotationDeg: 15 },
    fields: { start: '6', length: '20', sides: '8', 'across-flats': '16', rotation: '15' },
  },
  {
    kind: 'thread',
    create: { kind: 'thread', start: 0, length: 40, pitch: 2, starts: 1, hand: 'right', depth: 1 },
    edited: { kind: 'thread', start: 4, length: 24, pitch: 2.5, starts: 2, hand: 'right', depth: 1.2 },
    fields: { start: '4', length: '24', pitch: '2.5', starts: '2', depth: '1.2' },
  },
  {
    kind: 'flutes',
    create: { kind: 'flutes', start: 0, length: 40, count: 4, twist: 0, depth: 1 },
    edited: { kind: 'flutes', start: 0, length: 24, count: 6, twist: 3, depth: 1.2 },
    fields: { length: '24', count: '6', twist: '3', depth: '1.2' },
  },
]

for (const editCase of EDIT_CASES) {
  await scenario(`${editCase.kind}: a panel edit stores what a creation with those numbers stores`, async () => {
    const fixture = fixtures()[0]!
    // One row created straight through the store action, then edited through
    // the real panel Properties opens.
    loadOn(fixture, 'around')
    const created = editCase.kind === 'turn' || editCase.kind === 'polygon'
      ? store().addRotarySolid(editCase.create as never)
      : store().addRotaryPattern(editCase.create as never)
    assert.ok(created.ok, `${editCase.kind}: the starting row is created`)
    const featureId = created.featureId

    mountHost()
    store().beginCannedShapeEdit(featureId)
    await waitFor(() => document.body.querySelector('.canvas-workflow-panel--rotary') !== null, `${editCase.kind}: the edit panel opens`)
    for (const [name, value] of Object.entries(editCase.fields)) {
      setInputValue(field(`rotary${editCase.kind === 'turn' || editCase.kind === 'polygon' ? '-solid' : ''}-${name}`), value)
    }
    await flush()
    assert.equal(createButton().disabled, false, `${editCase.kind}: the changed form offers Save`)
    createButton().click()
    await waitFor(() => store().pendingAdd === null, `${editCase.kind}: Save closes the edit panel`)
    const editedSignature = comparableSignature(modelSignature(featureId))
    unmountHost()

    // The same numbers, created fresh: the definition must be identical.
    loadOn(fixture, 'around')
    const before = featureIds()
    const direct = editCase.kind === 'turn' || editCase.kind === 'polygon'
      ? store().addRotarySolid(editCase.edited as never)
      : store().addRotaryPattern(editCase.edited as never)
    assert.ok(direct.ok, `${editCase.kind}: the equivalent creation succeeds`)
    const createdSignature = comparableSignature(modelSignature(createdFeatureId(before)))

    assert.deepEqual(editedSignature, createdSignature, `${editCase.kind}: the edit stored the same definition a creation stores`)
  })
}


// A store-level or panel-level test cannot see whether the canvas creation
// panel actually renders these two panels for their pending sessions, and the
// app's only route to them is that dispatch. Read the shell's source, the same
// way `gearEditorWiring.test.ts` guards the sketch-edit wiring.
await scenario('the canvas creation panel renders both rotary panels for their sessions', async () => {
  const source = readFileSync(new URL('./CanvasCreationPanel.tsx', import.meta.url), 'utf8')
  assert.ok(source.includes("pendingAdd?.shape === 'rotary-solid'"), 'the solid session reaches its panel')
  assert.ok(source.includes('<RotarySolidPanel'), 'the solid panel is rendered')
  assert.ok(source.includes("pendingAdd?.shape === 'rotary-pattern'"), 'the pattern session reaches its panel')
  assert.ok(source.includes('<RotaryPatternPanel'), 'the pattern panel is rendered')
  // Both are rendered with the canvas plumbing, so the panel can position
  // itself and closing returns the keyboard to the canvas.
  assert.ok(source.includes('containerRef={containerRef}'), 'the panel is given the canvas container')
  assert.ok(source.includes('canvasRef={canvasRef}'), 'the panel is given the canvas')
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) process.exitCode = 1
