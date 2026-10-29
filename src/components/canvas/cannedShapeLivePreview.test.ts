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
 * Canned shapes update live while their parameters are edited (issue #1112 F1).
 *
 * Frank: "while editing a canned operation's parameters its shape does not get
 * updated. I did not test all of them but rounded rect for example does not do
 * it. please check all other ones."
 *
 * Every editor keeps a local draft, so the only way to see whether the sketch
 * and the 3D view follow a field is to drive the real editor and read the
 * project. For each canned kind this renders the editor that Properties opens
 * and changes every numeric field in it, asserting that the geometry the views
 * read changed, that a refused value changed nothing, and that closing without
 * Apply puts the stored shape back byte-for-byte.
 *
 * Run with:
 *   NODE_OPTIONS=--no-experimental-global-navigator npx tsx src/components/canvas/cannedShapeLivePreview.test.ts
 */

import React from 'react'
import { parseHTML } from 'linkedom'
import type { Project } from '../../types/project'
import type { GearCreationParams } from '../../sketch/gearProfile'
import type { PendingAddTool } from '../../store/types'

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
// without this every controlled field in the panel would fall back to the legacy
// change path and take no edits at all — a silently inert test.
if (!('oninput' in (document as unknown as object))) {
  Object.defineProperty(document, 'oninput', { value: null, writable: true, configurable: true })
}
// Components use the automatic JSX runtime; the tsx runner transpiles this file
// with the classic one, which expects a global `React`.
globals.React = React

const { useProjectStore } = await import('../../store/projectStore')
const { newProject, defaultTool, roundStock } = await import('../../types/project')
const { createRoot } = await import('react-dom/client')
const { I18nProvider } = await import('../../i18n/I18nProvider')
const { CannedShapeEditPanel } = await import('./CannedShapeEditPanel')
const { RotarySolidDialog } = await import('../layout/toolbar/RotarySolidDialog')
const { RotaryPatternDialog } = await import('../layout/toolbar/RotaryPatternDialog')
const { getCannedShapeEditor, resolveCannedShapeProfiles } = await import('../../cannedShapes')
const { resolveFeatureInstance, resolvedProjectFeatures } = await import('../../store/helpers/resolveFeatures')
const { defaultGearCreationParams } = await import('../../sketch/gearProfile')
const { ELLIPSE_EDITOR_REQUEST } = await import('../../cannedShapes/generators/ellipse')
const { SLOT_EDITOR_REQUEST } = await import('../../cannedShapes/generators/slot')
const { NGON_EDITOR_REQUEST } = await import('../../cannedShapes/generators/ngon')
const { ROUND_RECT_EDITOR_REQUEST } = await import('../../cannedShapes/generators/roundRect')
const { CHAMFER_RECT_EDITOR_REQUEST } = await import('../../cannedShapes/generators/chamferRect')
const { bundledMachines } = await import('../../machine/registry')
const { validateMachineDefinition } = await import('../../engine/gcode/types')
const { projectWithFeatures } = await import('../../test/projectFixtures')
const { switchWorkspaceFace } = await import('../../store/workspaceFace')
const { rotarySolidCannedData } = await import('../../store/helpers/rotarySolids')
const { rotarySolidFrame } = await import('../../cannedShapes/generators/rotarySolidParams')

let passCount = 0
let failCount = 0
const failures: string[] = []

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function store() {
  return useProjectStore.getState()
}

function project(): Project {
  return store().project
}

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

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passCount += 1
    console.log(`✓ ${name}`)
  } catch (error) {
    failCount += 1
    failures.push(`${name}: ${(error as Error).message}`)
    console.error(`✗ ${name}`)
    console.error(`  ${(error as Error).stack ?? (error as Error).message}`)
  }
}

// ── Reading what the views read ─────────────────────────────────────

function fingerprint(value: unknown): string {
  const text = JSON.stringify(value)
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${(hash >>> 0).toString(16)}/${text.length}`
}

/**
 * The geometry a redraw resolves for this row right now: the generated outlines
 * for a sketch kind, the regenerated mesh asset for a model kind (which is what
 * the 3D view and every toolpath consumer read).
 */
function previewGeometry(featureId: string): string {
  const current = project()
  const feature = resolveFeatureInstance(current, featureId)
  if (!feature?.canned) return 'no-canned'
  const assetId = current.featureDefinitions[feature.definitionId]?.stl?.meshAssetId
  if (assetId) {
    const asset = current.modelAssets?.[assetId]
    return asset
      ? `mesh ${asset.vertexCount}v/${asset.triangleCount}t ${fingerprint(asset.positions)}`
      : 'mesh missing'
  }
  const profiles = resolveCannedShapeProfiles(feature)
  return `outlines ${profiles.length} ${fingerprint(profiles)}`
}

/** The one row of this canned kind, resolved so its definition-owned data is visible. */
function featureIdForKind(kind: string): string {
  const found = resolvedProjectFeatures(project()).find((row) => row.canned?.kind === kind)
  assert(found, `the ${kind} feature was created`)
  return found.id
}

/** The instance span the tree and every Z reader show for this row. */
function spanFingerprint(featureId: string): string {
  const row = project().features.find((feature) => feature.id === featureId)
  assert(row, 'the edited row exists')
  return `${row.z_bottom}..${row.z_top}`
}

function definitionJson(featureId: string): string {
  const current = project()
  const instance = current.features.find((row) => row.id === featureId)
  assert(instance, 'the edited row exists')
  return JSON.stringify(current.featureDefinitions[instance.definitionId])
}

function historyLength(): number {
  return store().history.past.length
}

// ── Driving a rendered editor ───────────────────────────────────────

const dom = window as unknown as {
  Event: new (type: string, init?: { bubbles?: boolean }) => object
  HTMLInputElement: { prototype: { value: string } }
  HTMLSelectElement: { prototype: { value: string } }
}

/** Set a field the way typing does: value first, then the event React listens for. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set
  assert(setter, 'linkedom has an input value setter')
  setter.call(input, value)
  input.dispatchEvent(new dom.Event('input', { bubbles: true }) as unknown as Event)
}

/**
 * linkedom's `HTMLSelectElement.value` is a getter with no setter, so the way to
 * move a select is to select the option, exactly as a click would.
 */
function setSelectValue(select: HTMLSelectElement, value: string): void {
  const option = Array.from(select.querySelectorAll('option'))
    .find((candidate) => candidate.getAttribute('value') === value)
  assert(option, `the select has the ${value} option`)
  ;(option as unknown as { selected: boolean }).selected = true
  select.dispatchEvent(new dom.Event('change', { bubbles: true }) as unknown as Event)
}

interface Mounted {
  host: HTMLElement
  unmount: () => void
}

function mount(element: React.ReactElement): Mounted {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  root.render(React.createElement(I18nProvider, null, element))
  return {
    host,
    unmount: () => {
      root.unmount()
      host.remove()
    },
  }
}

function panelElement(pending: Extract<PendingAddTool, { shape: 'canned-edit' }>): React.ReactElement {
  return React.createElement(CannedShapeEditPanel, {
    pending,
    containerRef: { current: null },
    canvasRef: { current: null },
    clearTransientCanvasState: () => {},
  })
}

function buttonByLabel(label: string): HTMLButtonElement {
  const button = Array.from(document.body.querySelectorAll('button'))
    .find((candidate) => candidate.getAttribute('aria-label') === label)
  assert(button, `the panel has a ${label} action`)
  return button as unknown as HTMLButtonElement
}

// ── Projects ────────────────────────────────────────────────────────

function resetStore(next?: Project): void {
  useProjectStore.setState({
    project: next ?? newProject(),
    creationTarget: 'feature',
    selection: {
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedTabIds: [],
      selectedClampIds: [],
      selectedNode: null,
      mode: 'feature' as const,
      sketchEditTool: null,
      activeControl: null,
      hoveredFeatureId: null,
    },
    history: { past: [], future: [], transactionStart: null },
    sketchEditSession: null,
    pendingConstraint: null,
    pendingTransform: null,
    pendingOffset: null,
    pendingAdd: null,
  } as never)
}

function flatProject(kind: string): string {
  resetStore()
  switch (kind) {
    case 'ellipse':
      store().addEllipseFeature('Ellipse', 40, 30, 30, 20, 5)
      break
    case 'slot':
      store().addSlotFeature('Slot', { x: 0, y: 0 }, { x: 60, y: 0 }, 10, 5)
      break
    case 'ngon':
      store().addNgonFeature('Polygon', 20, 20, 6, 20, 0, 5)
      break
    case 'roundrect':
      store().addRoundRectFeature('Rounded rect', 0, 0, 60, 30, 6, 5)
      break
    case 'chamferrect':
      store().addChamferRectFeature('Chamfered rect', 0, 0, 60, 30, 6, 5)
      break
    default:
      throw new Error(`unknown flat kind ${kind}`)
  }
  return featureIdForKind(kind)
}

/** A round bar with a rotary machine, on the Around face. */
function rotaryProject(): Project {
  const base = newProject('Live preview', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(40, 200, 'x', { x: 10, y: 30 })
  const machine = validateMachineDefinition({
    ...structuredClone(bundledMachines()[0]),
    id: 'live-preview',
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = [{ ...defaultTool('mm', 1), id: 'ball', type: 'ball_endmill', diameter: 4 }]
  return projectWithFeatures(base, [])
}

/** Load the rotary project and create one canned rotary feature. */
function rotaryFeature(kind: 'thread' | 'flutes' | 'turn' | 'polygon'): string {
  resetStore(rotaryProject())
  assert(switchWorkspaceFace('around'), 'the workspace enters Around')
  if (kind === 'thread') {
    const created = store().addRotaryPattern({
      kind: 'thread',
      start: 5,
      length: 20,
      pitch: 2,
      starts: 1,
      hand: 'right',
      depth: 1,
    })
    assert(created.ok, 'the thread is created')
  } else if (kind === 'flutes') {
    const created = store().addRotaryPattern({
      kind: 'flutes',
      start: 5,
      length: 20,
      count: 4,
      twist: 0,
      depth: 1,
    })
    assert(created.ok, 'the flutes are created')
  } else if (kind === 'turn') {
    const created = store().addRotarySolid({ kind: 'turn', start: 0, length: 40, diameter: 20 })
    assert(created.ok, 'the turn is created')
  } else {
    const created = store().addRotarySolid({
      kind: 'polygon',
      start: 10,
      length: 20,
      sides: 6,
      acrossFlats: 15,
      rotationDeg: 0,
    })
    assert(created.ok, 'the polygon is created')
  }
  return featureIdForKind(kind)
}

// ── The flat shapes and the gear, in the canvas side panel ──────────

interface FlatCase {
  kind: string
  request: { fields: ReadonlyArray<{ key: string }> }
  /** One new value per field, in the request's order. */
  values: string[]
}

const FLAT_CASES: FlatCase[] = [
  { kind: 'ellipse', request: ELLIPSE_EDITOR_REQUEST, values: ['40', '25'] },
  { kind: 'slot', request: SLOT_EDITOR_REQUEST, values: ['70', '14'] },
  { kind: 'ngon', request: NGON_EDITOR_REQUEST, values: ['8', '25', '15'] },
  { kind: 'roundrect', request: ROUND_RECT_EDITOR_REQUEST, values: ['70', '36', '9'] },
  { kind: 'chamferrect', request: CHAMFER_RECT_EDITOR_REQUEST, values: ['70', '36', '9'] },
]

async function openPanel(featureId: string, kind: string): Promise<Mounted> {
  const opener = getCannedShapeEditor(kind)
  assert(opener, `${kind} has an editor`)
  opener(featureId)
  const pending = store().pendingAdd
  assert(pending?.shape === 'canned-edit', 'the panel session is armed')
  const mounted = mount(panelElement(pending))
  await waitFor(() => document.body.querySelector('.canvas-workflow-panel--creation') !== null, 'the panel renders')
  return mounted
}

function panelInputs(): HTMLInputElement[] {
  return Array.from(
    document.body.querySelectorAll('.canvas-workflow-panel--creation input'),
  ) as unknown as HTMLInputElement[]
}

for (const flatCase of FLAT_CASES) {
  await scenario(`${flatCase.kind}: every field previews live and Cancel restores the stored shape`, async () => {
    const featureId = flatProject(flatCase.kind)
    const storedDefinition = definitionJson(featureId)
    const storedHistory = historyLength()
    const mounted = await openPanel(featureId, flatCase.kind)
    try {
      const inputs = await (async () => {
        await waitFor(() => panelInputs().length === flatCase.request.fields.length, 'every field renders')
        return panelInputs()
      })()
      let previous = previewGeometry(featureId)
      for (let index = 0; index < inputs.length; index += 1) {
        const field = flatCase.request.fields[index]
        const value = flatCase.values[index]
        setInputValue(inputs[index], value)
        await flush()
        const next = previewGeometry(featureId)
        assert(next !== previous, `${flatCase.kind}.${field.key}: the preview did not change`)
        previous = next
        const stored = resolveFeatureInstance(project(), featureId)?.canned
        assert(
          stored?.params[field.key] === Number(value),
          `${flatCase.kind}.${field.key}: the project holds ${String(stored?.params[field.key])}, expected ${value}`,
        )
        assert(historyLength() === storedHistory, `${flatCase.kind}.${field.key}: a preview is not an undo step`)
      }
    } finally {
      // Closing the editor is what Cancel (and Escape) does before the canvas
      // unmounts the panel.
      store().cancelPendingAdd()
      mounted.unmount()
    }
    await flush()
    assert(definitionJson(featureId) === storedDefinition, `${flatCase.kind}: Cancel restored the stored definition`)
    assert(historyLength() === storedHistory, `${flatCase.kind}: Cancel left the undo history alone`)
  })
}

await scenario('a value the generator refuses keeps the last valid preview and shows its error', async () => {
  const featureId = flatProject('roundrect')
  const mounted = await openPanel(featureId, 'roundrect')
  try {
    await waitFor(() => panelInputs().length === 3, 'three fields render')
    const inputs = panelInputs()
    setInputValue(inputs[0], '70')
    await flush()
    const valid = previewGeometry(featureId)
    assert(valid !== '', 'the valid draft previewed')

    setInputValue(inputs[0], '0')
    await flush()
    assert(previewGeometry(featureId) === valid, 'a refused width kept the last valid preview')
    assert(document.body.querySelector('[role="alert"]') !== null, 'the panel shows its invalid-value message')

    setInputValue(inputs[0], '80')
    await flush()
    assert(previewGeometry(featureId) !== valid, 'a valid value resumes the preview')
  } finally {
    store().cancelPendingAdd()
    mounted.unmount()
  }
})

await scenario('Save is one undo step and one undo restores the stored shape', async () => {
  const featureId = flatProject('roundrect')
  const storedDefinition = definitionJson(featureId)
  const storedHistory = historyLength()
  const mounted = await openPanel(featureId, 'roundrect')
  await waitFor(() => panelInputs().length === 3, 'three fields render')
  const inputs = panelInputs()
  setInputValue(inputs[0], '70')
  setInputValue(inputs[2], '9')
  await flush()
  assert(previewGeometry(featureId) !== 'no-canned', 'the draft previewed before Save')

  buttonByLabel('Save').click()
  await waitFor(() => historyLength() === storedHistory + 1, 'Save is one undo step')
  mounted.unmount()
  await flush()

  store().undo()
  await flush()
  assert(definitionJson(featureId) === storedDefinition, 'one undo restored the stored definition')
})

await scenario('a unit switch during a preview is not rolled back by Cancel', async () => {
  // A live preview holds an open history transaction, and a unit switch joins
  // it. Cancelling the edit must put the shape back in the new units instead of
  // silently reverting the switch — the one way a long-lived preview can collide
  // with another project change.
  resetStore(newProject('Unit switch', 'mm'))
  store().addRoundRectFeature('Rounded rect', 0, 0, 60, 30, 6, 5)
  const featureId = featureIdForKind('roundrect')
  const mounted = await openPanel(featureId, 'roundrect')
  await waitFor(() => panelInputs().length === 3, 'three fields render')
  setInputValue(panelInputs()[0], '70')
  await flush()
  assert(
    resolveFeatureInstance(project(), featureId)?.canned?.params.width === 70,
    'the preview is live in mm before the switch',
  )

  store().setUnits('inch', 'convert')
  await flush()
  assert(project().meta.units === 'inch', 'the project switched to inches')
  store().cancelPendingAdd()
  mounted.unmount()
  await flush()

  assert(project().meta.units === 'inch', 'Cancel did not revert the unit switch')
  const width = resolveFeatureInstance(project(), featureId)?.canned?.params.width
  assert(typeof width === 'number', 'the shape still has its stored width')
  assert(
    Math.abs((width as number) - 60 / 25.4) < 1e-9,
    `Cancel restored the 60 mm width as ${String(width)} in, expected ${60 / 25.4}`,
  )
})

await scenario('the gear previews every numeric field live and Cancel restores it', async () => {
  resetStore()
  const params: GearCreationParams = {
    ...defaultGearCreationParams(30),
    crestForm: 'rounded',
  }
  store().addGearFeature('Gear', { x: 40, y: 30 }, 30, params, 5)
  const featureId = featureIdForKind('gear')
  const storedDefinition = definitionJson(featureId)
  const storedHistory = historyLength()
  const mounted = await openPanel(featureId, 'gear')
  try {
    // Size, teeth, whole depth, pressure angle, root fillet, crest radius, bore.
    await waitFor(() => panelInputs().length === 7, 'the seven numeric gear fields render')
    const inputs = panelInputs()
    const values = ['34', '22', '7.5', '14', '1.2', '1', '6']
    let previous = previewGeometry(featureId)
    for (let index = 0; index < inputs.length; index += 1) {
      setInputValue(inputs[index], values[index])
      await flush()
      const next = previewGeometry(featureId)
      assert(next !== previous, `gear field ${index} (${inputs[index].value}) did not change the preview`)
      previous = next
      assert(historyLength() === storedHistory, `gear field ${index}: a preview is not an undo step`)
    }
    assert(resolveFeatureInstance(project(), featureId)?.canned?.params.boreDiameter === 6, 'the bore reached the project')

    // The three option fields commit through their own `onChange`, and the same
    // preview follows them.
    const optionValues: Array<[index: number, value: string]> = [[0, 'straight'], [1, 'flat'], [2, 'flat']]
    for (const [index, value] of optionValues) {
      const selects = Array.from(
        document.body.querySelectorAll('.canvas-workflow-panel--creation select'),
      ) as unknown as HTMLSelectElement[]
      assert(selects.length === 3, 'the gear renders its three option fields')
      setSelectValue(selects[index], value)
      await flush()
      const next = previewGeometry(featureId)
      assert(next !== previous, `gear option ${index} (${value}) did not change the preview`)
      previous = next
    }
  } finally {
    store().cancelPendingAdd()
    mounted.unmount()
  }
  await flush()
  assert(definitionJson(featureId) === storedDefinition, 'Cancel restored the stored gear definition')
  assert(historyLength() === storedHistory, 'Cancel left the gear undo history alone')
})

// ── Thread, Flutes, Turn and Polygon, in their own dialogs ──────────

interface DialogCase {
  kind: 'thread' | 'flutes' | 'turn' | 'polygon'
  /**
   * Input ids in the order they are changed, with the value to type and what
   * the field must move in the preview. Depth is the one number that is not part
   * of a Thread/Flutes sheet line: it is how deep the line cuts, so it moves the
   * row's Z span instead of its geometry (the builder draws the line on the
   * surface and the depth decides where the cut enters it).
   */
  fields: Array<{ id: string; value: string; changes: 'geometry' | 'span' }>
}

const DIALOG_CASES: DialogCase[] = [
  {
    kind: 'thread',
    fields: [
      { id: 'rotary-start', value: '8', changes: 'geometry' },
      { id: 'rotary-length', value: '24', changes: 'geometry' },
      { id: 'rotary-pitch', value: '2.5', changes: 'geometry' },
      { id: 'rotary-starts', value: '2', changes: 'geometry' },
      { id: 'rotary-depth', value: '1.2', changes: 'span' },
    ],
  },
  {
    kind: 'flutes',
    fields: [
      { id: 'rotary-start', value: '8', changes: 'geometry' },
      { id: 'rotary-length', value: '24', changes: 'geometry' },
      { id: 'rotary-count', value: '6', changes: 'geometry' },
      { id: 'rotary-twist', value: '10', changes: 'geometry' },
      { id: 'rotary-depth', value: '1.2', changes: 'span' },
    ],
  },
  {
    kind: 'turn',
    fields: [
      { id: 'rotary-solid-start', value: '5', changes: 'geometry' },
      { id: 'rotary-solid-length', value: '30', changes: 'geometry' },
      { id: 'rotary-solid-diameter', value: '12', changes: 'geometry' },
    ],
  },
  {
    kind: 'polygon',
    fields: [
      { id: 'rotary-solid-start', value: '12', changes: 'geometry' },
      { id: 'rotary-solid-length', value: '24', changes: 'geometry' },
      { id: 'rotary-solid-sides', value: '8', changes: 'geometry' },
      { id: 'rotary-solid-across-flats', value: '12', changes: 'geometry' },
      { id: 'rotary-solid-rotation', value: '15', changes: 'geometry' },
    ],
  },
]

async function openDialog(kind: DialogCase['kind'], featureId: string): Promise<{ mounted: Mounted; closed: () => boolean }> {
  let closed = false
  const onClose = () => { closed = true }
  const element = kind === 'thread' || kind === 'flutes'
    ? React.createElement(RotaryPatternDialog, { kind, featureId, onClose })
    : React.createElement(RotarySolidDialog, { kind: kind === 'turn' ? 'turn' : 'polygon', featureId, onClose })
  const mounted = mount(element)
  await waitFor(() => document.body.querySelector('.dialog') !== null, 'the dialog renders')
  return { mounted, closed: () => closed }
}

for (const dialogCase of DIALOG_CASES) {
  await scenario(`${dialogCase.kind}: every field previews live and closing restores the stored feature`, async () => {
    const featureId = rotaryFeature(dialogCase.kind)
    const storedDefinition = definitionJson(featureId)
    const storedHistory = historyLength()
    const storedFeatures = JSON.stringify(project().features.map((row) => ({ id: row.id, z_top: row.z_top, z_bottom: row.z_bottom })))
    const { mounted } = await openDialog(dialogCase.kind, featureId)
    try {
      const geometryBefore = previewGeometry(featureId)
      let spanBefore = spanFingerprint(featureId)
      let previousGeometry = geometryBefore
      for (const field of dialogCase.fields) {
        const input = document.body.querySelector(`#${field.id}`) as unknown as HTMLInputElement | null
        assert(input, `the dialog has #${field.id}`)
        setInputValue(input, field.value)
        await flush()
        const geometry = previewGeometry(featureId)
        const span = spanFingerprint(featureId)
        if (field.changes === 'span') {
          assert(span !== spanBefore, `${dialogCase.kind} #${field.id}: the previewed Z span did not change`)
        } else {
          assert(geometry !== previousGeometry, `${dialogCase.kind} #${field.id}: the previewed geometry did not change`)
        }
        previousGeometry = geometry
        spanBefore = span
        assert(historyLength() === storedHistory, `${dialogCase.kind} #${field.id}: a preview is not an undo step`)
      }
    } finally {
      mounted.unmount()
    }
    await flush()
    assert(definitionJson(featureId) === storedDefinition, `${dialogCase.kind}: closing restored the stored definition`)
    assert(
      JSON.stringify(project().features.map((row) => ({ id: row.id, z_top: row.z_top, z_bottom: row.z_bottom }))) === storedFeatures,
      `${dialogCase.kind}: closing restored the instance spans`,
    )
    assert(historyLength() === storedHistory, `${dialogCase.kind}: closing left the undo history alone`)
  })
}

await scenario('a Turn edit applied from the dialog is one undo step', async () => {
  const featureId = rotaryFeature('turn')
  const storedDefinition = definitionJson(featureId)
  const storedHistory = historyLength()
  const { mounted, closed } = await openDialog('turn', featureId)
  const diameter = document.body.querySelector('#rotary-solid-diameter') as unknown as HTMLInputElement
  assert(diameter, 'the diameter field renders')
  setInputValue(diameter, '12')
  await flush()
  assert(previewGeometry(featureId).startsWith('mesh'), 'the Turn preview is a rebuilt mesh')

  const apply = document.body.querySelector('.rotary-dialog__create') as unknown as HTMLButtonElement | null
  assert(apply, 'the dialog has an Apply action')
  assert(apply.disabled === false, 'Apply is enabled')
  apply.click()
  await waitFor(() => closed(), 'Apply closes the dialog')
  mounted.unmount()
  await waitFor(() => historyLength() === storedHistory + 1, 'Apply is one undo step')

  store().undo()
  await flush()
  assert(definitionJson(featureId) === storedDefinition, 'one undo restored the stored Turn')
})

// A model's parameter edit must reach the linked copy that shares its
// definition through the Z span, exactly as an Apply from the dialog does.
await scenario('a live Turn edit keeps the linked copy aligned and Cancel puts both back', async () => {
  const featureId = rotaryFeature('turn')
  const row = project().features.find((feature) => feature.id === featureId)
  assert(row, 'the Turn row exists')
  store().loadProject({
    ...project(),
    features: [row, { ...row, id: 'linked', name: 'Linked copy', z_bottom: -30, z_top: 10 }],
  })
  const storedDefinition = definitionJson(featureId)
  const storedSpans = JSON.stringify(project().features.map((feature) => [feature.id, feature.z_bottom, feature.z_top]))
  const { mounted } = await openDialog('turn', featureId)
  const diameter = document.body.querySelector('#rotary-solid-diameter') as unknown as HTMLInputElement
  setInputValue(diameter, '10')
  await flush()
  const linked = project().features.find((feature) => feature.id === 'linked')
  assert(linked, 'the linked copy survives the preview')
  assert(
    JSON.stringify(project().features.map((feature) => [feature.id, feature.z_bottom, feature.z_top])) !== storedSpans,
    'the live edit moved the spans of the shared definition',
  )
  mounted.unmount()
  await flush()
  assert(definitionJson(featureId) === storedDefinition, 'closing restored the shared definition')
  assert(
    JSON.stringify(project().features.map((feature) => [feature.id, feature.z_bottom, feature.z_top])) === storedSpans,
    'closing restored both instance spans',
  )
})

// The Turn dialog builds its canned data from the frame snapshot, the same
// builder the store action uses, so a preview and an Apply cannot drift.
await scenario('a preview writes the same parameters the Apply path builds', async () => {
  const featureId = rotaryFeature('turn')
  const { mounted } = await openDialog('turn', featureId)
  const diameter = document.body.querySelector('#rotary-solid-diameter') as unknown as HTMLInputElement
  setInputValue(diameter, '10')
  await flush()
  const frame = rotarySolidFrame(project())
  assert(frame, 'the bar frame resolves')
  const expected = rotarySolidCannedData(frame, { kind: 'turn', start: 0, length: 40, diameter: 10 }, project().meta.units)
  assert(expected, 'the expected parameter set builds')
  const stored = resolveFeatureInstance(project(), featureId)?.canned
  assert(
    JSON.stringify(stored?.params) === JSON.stringify(expected.params),
    'the previewed parameters are the Apply path parameters',
  )
  mounted.unmount()
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) {
  console.error('\n' + failures.join('\n'))
  process.exitCode = 1
}
