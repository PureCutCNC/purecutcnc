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
 * and changes every field in it — the typed numbers, a Thread/Flute's
 * Right/Left hand and a Turn's copied profile included — asserting that the
 * geometry the views read changed, that a refused value changed nothing, that
 * Save/Apply is exactly one undo step, and that closing without Apply puts the
 * stored shape back byte-for-byte.
 *
 * Closing must put back **only the shape**: a change the user made elsewhere
 * while an editor was open (a bar resize, a rename) survives it. Closing a
 * preview used to restore the whole history snapshot and take that change with
 * it (#1112 F1 review), which is why both kinds of test live here.
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
const { GearParameterPanel } = await import('./GearParameterPanel')
const { RotarySolidPanel } = await import('./RotarySolidPanel')
const { RotaryPatternPanel } = await import('./RotaryPatternPanel')
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
const { getCannedEditDraft } = await import('./cannedEditDraft')
const {
  beginCannedRadiusDrag,
  cannedEditHandleParams,
  publishCannedRadiusDrag,
  updateCannedRadiusDrag,
} = await import('./cannedRadiusDrag')

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

/**
 * The shared `Select` is a button plus a listbox, so it is driven the way a
 * pointer drives it: open the trigger, then press the option by its label. The
 * rotary dialogs' Direction field and the Turn's profile picker are the two
 * parameters that are not typed into a number field.
 */
async function chooseSelectOption(container: ParentNode, label: string): Promise<void> {
  const trigger = container.querySelector('.ui-select__trigger') as unknown as HTMLButtonElement | null
  assert(trigger, 'the select renders its trigger')
  trigger.click()
  await flush()
  const option = Array.from(container.querySelectorAll('.ui-select__option'))
    .find((candidate) => (candidate.textContent ?? '').trim() === label)
  assert(option, `the select offers "${label}"`)
  option.dispatchEvent(new dom.Event('pointerdown', { bubbles: true }) as unknown as Event)
  await flush()
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

/**
 * The creation panel's gear fields as the canvas mounts them: subscribed to the
 * live pending session, so a draft change re-renders the panel (and its warning)
 * the way the real side panel does. The scenarios that read only the store can
 * pass a snapshot instead; this one asserts what the user sees.
 */
function CreationGearPanel(): React.ReactElement | null {
  const pendingAdd = useProjectStore((state) => state.pendingAdd)
  const setPendingGearParams = useProjectStore((state) => state.setPendingGearParams)
  if (!pendingAdd || pendingAdd.shape !== 'gear') return null
  return React.createElement(GearParameterPanel, {
    pendingAdd,
    units: 'mm',
    setPendingGearParams,
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

// Save on every kind, not just the rounded rectangle: the draft -> project ->
// one-undo-step path is the same code for all of them, and a kind that slipped
// out of it would otherwise pass by not being looked at.
for (const flatCase of FLAT_CASES) {
  await scenario(`${flatCase.kind}: Save is one undo step and one undo restores the stored shape`, async () => {
    const featureId = flatProject(flatCase.kind)
    const storedDefinition = definitionJson(featureId)
    const storedHistory = historyLength()
    const mounted = await openPanel(featureId, flatCase.kind)
    try {
      await waitFor(() => panelInputs().length === flatCase.request.fields.length, 'every field renders')
      const inputs = panelInputs()
      setInputValue(inputs[0], flatCase.values[0])
      if (inputs.length > 1) setInputValue(inputs[inputs.length - 1], flatCase.values[flatCase.values.length - 1])
      await flush()
      const previewed = previewGeometry(featureId)
      assert(previewed !== '', 'the draft previewed before Save')

      buttonByLabel('Save').click()
      await waitFor(() => historyLength() === storedHistory + 1, 'Save is one undo step')
      await waitFor(() => store().pendingAdd === null, 'Save closes the panel session')
      assert(previewGeometry(featureId) === previewed, 'Save kept the previewed shape')
    } finally {
      mounted.unmount()
    }
    await flush()

    store().undo()
    await flush()
    assert(definitionJson(featureId) === storedDefinition, 'one undo restored the stored definition')
  })
}

// A canned ellipse's radius handles belong to this panel (issue #1112 rt7-g):
// the canvas drag is a field edit, but a *held* one — the panel and the canvas
// follow the pointer while the project keeps its stored parameters until Save,
// so a dragged radius is never a project change before the user commits it
// (issue #1112 rt7-g review).
await scenario('Edit ellipse: a dragged radius is held in the panel until Save', async () => {
  const featureId = flatProject('ellipse')
  const storedDefinition = definitionJson(featureId)
  const storedHistory = historyLength()
  const mounted = await openPanel(featureId, 'ellipse')
  try {
    await waitFor(() => panelInputs().length === 2, 'the two radius fields render')

    const feature = resolveFeatureInstance(project(), featureId)
    assert(feature, 'the edited ellipse resolves')
    const drag = beginCannedRadiusDrag(feature, 0, getCannedEditDraft())
    assert(drag, 'the open panel lets the X handle start a drag')
    // The fixture ellipse sits at (40, 30), so a pointer at x = 85 asks for rx 45.
    const moved = updateCannedRadiusDrag(drag, { x: 85, y: 30 })
    publishCannedRadiusDrag(moved)
    await flush()

    assert(panelInputs()[0].value === '45', `the X field holds the dragged radius, got ${panelInputs()[0].value}`)
    assert(panelInputs()[1].value === '20', 'the drag left the Y field alone')
    // The one requirement the reviewed escape broke: a drag writes the panel,
    // never the project. The canvas preview reads the same draft the handles do
    // (`cannedRadiusDrag.test.ts` runs that draw pass).
    assert(definitionJson(featureId) === storedDefinition, 'a dragged radius leaves the stored ellipse untouched until Save')
    assert(cannedEditHandleParams(feature, getCannedEditDraft(), null)?.rx === 45, 'the canvas draws the dragged radius from the panel draft')
    assert(cannedEditHandleParams(feature, getCannedEditDraft(), moved)?.rx === 45, 'while moving, the drag itself places the handle')
    assert(historyLength() === storedHistory, 'a dragged radius is not an undo step before Save')

    buttonByLabel('Save').click()
    await waitFor(() => historyLength() === storedHistory + 1, 'Save is one undo step')
    await waitFor(() => store().pendingAdd === null, 'Save closes the panel session')
    const saved = resolveFeatureInstance(project(), featureId)?.canned?.params
    assert(saved?.rx === 45, `Save stored the dragged radius, got ${String(saved?.rx)}`)
  } finally {
    mounted.unmount()
  }
  await flush()

  store().undo()
  await flush()
  assert(definitionJson(featureId) === storedDefinition, 'one undo restored the ellipse the session opened on')
})

await scenario('Edit ellipse: Cancel discards a dragged radius like a typed one', async () => {
  const featureId = flatProject('ellipse')
  const storedDefinition = definitionJson(featureId)
  const storedHistory = historyLength()
  const mounted = await openPanel(featureId, 'ellipse')
  try {
    await waitFor(() => panelInputs().length === 2, 'the two radius fields render')
    const feature = resolveFeatureInstance(project(), featureId)
    assert(feature, 'the edited ellipse resolves')
    const drag = beginCannedRadiusDrag(feature, 1, getCannedEditDraft())
    assert(drag, 'the open panel lets the Y handle start a drag')
    publishCannedRadiusDrag(updateCannedRadiusDrag(drag, { x: 40, y: 60 }))
    await flush()
    assert(panelInputs()[1].value === '30', `the Y field holds the dragged radius, got ${panelInputs()[1].value}`)
    assert(definitionJson(featureId) === storedDefinition, 'the dragged radius was held out of the project')
  } finally {
    // Cancel/Escape closes the session, which drops the held preview.
    store().cancelPendingAdd()
    mounted.unmount()
  }
  await flush()
  assert(definitionJson(featureId) === storedDefinition, 'Cancel left the stored ellipse alone')
  assert(historyLength() === storedHistory, 'Cancel left the undo history alone')
})

await scenario('Edit ellipse: a typed radius moves its handle', async () => {
  const featureId = flatProject('ellipse')
  const mounted = await openPanel(featureId, 'ellipse')
  try {
    await waitFor(() => panelInputs().length === 2, 'the two radius fields render')
    setInputValue(panelInputs()[1], '60')
    await flush()
    const feature = resolveFeatureInstance(project(), featureId)
    assert(feature, 'the edited ellipse resolves')
    const handles = cannedEditHandleParams(feature, getCannedEditDraft(), null)
    assert(handles, 'the open panel draws the ellipse’s handles')
    assert(handles.ry === 60, `the typed ry placed the Y handle, got ${String(handles.ry)}`)
    assert(handles.rx === 30, 'typing ry left the X handle alone')
  } finally {
    store().cancelPendingAdd()
    mounted.unmount()
  }
})


// A disabled Save is the panel's own refusal, so the field that produced it is
// allowed to be a value the creation clamp would have hidden (issue #1112 F1).
await scenario('a gear value the validator refuses keeps the last valid preview and reports it', async () => {
  resetStore()
  store().addGearFeature('Gear', { x: 40, y: 30 }, 30, {
    ...defaultGearCreationParams(30),
    crestForm: 'rounded',
  }, 5)
  const featureId = featureIdForKind('gear')
  const storedHistory = historyLength()
  const storedTeeth = resolveFeatureInstance(project(), featureId)?.canned?.params.teeth
  assert(typeof storedTeeth === 'number', 'the gear stores its tooth count')
  const mounted = await openPanel(featureId, 'gear')
  try {
    await waitFor(() => panelInputs().length === 7, 'the seven numeric gear fields render')
    const teeth = panelInputs()[1]
    const valid = previewGeometry(featureId)

    // One tooth is below the gear's minimum. Normalizing the draft first would
    // quietly clamp it to six and draw a six-tooth gear with no error.
    setInputValue(teeth, '1')
    await flush()
    assert(previewGeometry(featureId) === valid, 'a refused tooth count kept the last valid preview')
    assert(document.body.querySelector('[role="alert"]') !== null, 'the panel reports the refused value')
    assert(
      resolveFeatureInstance(project(), featureId)?.canned?.params.teeth === storedTeeth,
      'the project kept the stored tooth count',
    )
    assert(historyLength() === storedHistory, 'a refused value is not an undo step')
    assert(
      (buttonByLabel('Save') as unknown as { disabled?: boolean }).disabled === true,
      'Save is refused while the draft is invalid',
    )

    setInputValue(teeth, '22')
    await flush()
    assert(previewGeometry(featureId) !== valid, 'a valid value resumes the preview')
    assert(
      (buttonByLabel('Save') as unknown as { disabled?: boolean }).disabled !== true,
      'Save is offered again for a valid draft',
    )
  } finally {
    store().cancelPendingAdd()
    mounted.unmount()
  }
})

// Clearing a field is a draft value like any other: the text the user typed is
// kept and the validator sees it. Dropping unusable text used to leave the
// previous number in the draft, so clearing a field drew nothing new, reported
// nothing and left Save enabled (issue #1112 H1 review).
await scenario('a cleared or unreadable gear field is kept as a draft and reported', async () => {
  resetStore()
  store().addGearFeature('Gear', { x: 40, y: 30 }, 30, {
    ...defaultGearCreationParams(30),
    crestForm: 'rounded',
  }, 5)
  const featureId = featureIdForKind('gear')
  const storedDefinition = definitionJson(featureId)
  const storedHistory = historyLength()
  const mounted = await openPanel(featureId, 'gear')
  const saveDisabled = (): boolean =>
    (buttonByLabel('Save') as unknown as { disabled?: boolean }).disabled === true
  try {
    await waitFor(() => panelInputs().length === 7, 'the seven numeric gear fields render')
    const [size, teeth] = panelInputs()
    // Two draft paths: a parameter, and the outside radius the panel keeps as
    // its own text. The restores differ so each resumption moves the preview.
    const cases = [
      { field: 'tooth count', input: teeth, text: '', restore: '20' },
      { field: 'tooth count', input: teeth, text: 'two', restore: '22' },
      { field: 'outside radius', input: size, text: '', restore: '34' },
    ]
    let lastValid = previewGeometry(featureId)
    // What the last usable draft wrote: a preview is a real project write, so
    // each case is compared against the definition as it stands, not the stored
    // one that Cancel has to put back at the end.
    let writable = definitionJson(featureId)
    for (const { field, input, text, restore } of cases) {
      setInputValue(input, text)
      await flush()
      assert(input.value === text, `the ${field} keeps "${text}" as typed (it reads "${input.value}")`)
      assert(previewGeometry(featureId) === lastValid, `an unusable ${field} kept the last valid preview`)
      assert(
        document.body.querySelector('[role="alert"]') !== null,
        `the panel reports the unusable ${field}`,
      )
      assert(saveDisabled(), `Save is refused while the ${field} reads "${text}"`)
      assert(historyLength() === storedHistory, `an unusable ${field} is not an undo step`)
      assert(definitionJson(featureId) === writable, `an unusable ${field} wrote nothing`)

      // Leaving the field must not replace the text with a number nobody typed.
      // React dispatches `onBlur` from `focusout`.
      input.dispatchEvent(new dom.Event('focusout', { bubbles: true }) as unknown as Event)
      await flush()
      assert(
        input.value === text,
        `blurring the ${field} kept "${text}" as typed (it reads "${input.value}")`,
      )
      assert(saveDisabled(), 'the refusal survives leaving the field')
      assert(
        document.body.querySelector('[role="alert"]') !== null,
        'the message survives leaving the field',
      )

      setInputValue(input, restore)
      await flush()
      const resumed = previewGeometry(featureId)
      assert(resumed !== lastValid, `a usable ${field} resumes the preview`)
      assert(!saveDisabled(), 'Save is offered again for a usable draft')
      assert(
        document.body.querySelector('[role="alert"]') === null,
        'the message clears for a usable draft',
      )
      lastValid = resumed
      writable = definitionJson(featureId)
    }
  } finally {
    store().cancelPendingAdd()
    mounted.unmount()
  }
  await flush()
  assert(definitionJson(featureId) === storedDefinition, 'Cancel restored the stored gear definition')
  assert(historyLength() === storedHistory, 'Cancel left the gear undo history alone')
})

// The other half of item 12: in the Edit panel the bore is the *first* field
// touched. Blank is the rendering of a stored zero, so the first usable value
// typed there has to reach the preview by itself — no earlier field, and no
// blur, to carry it (issue #1112 R2 item 12).
await scenario('Edit gear: the first typed bore value previews at once', async () => {
  resetStore()
  store().addGearFeature('Gear', { x: 40, y: 30 }, 30, {
    ...defaultGearCreationParams(30),
    crestForm: 'rounded',
  }, 5)
  const featureId = featureIdForKind('gear')
  const storedHistory = historyLength()
  const mounted = await openPanel(featureId, 'gear')
  const saveDisabled = (): boolean =>
    (buttonByLabel('Save') as unknown as { disabled?: boolean }).disabled === true
  try {
    await waitFor(() => panelInputs().length === 7, 'the seven numeric gear fields render')
    const bore = panelInputs()[panelInputs().length - 1]
    assert(bore.value === '', `a zero bore renders blank (it reads "${bore.value}")`)
    const noBore = previewGeometry(featureId)

    setInputValue(bore, '6')
    await flush()
    const withBore = previewGeometry(featureId)
    assert(withBore !== noBore, 'the first typed bore changed the previewed shape')
    assert(
      resolveFeatureInstance(project(), featureId)?.canned?.params.boreDiameter === 6,
      'the typed bore reached the stored draft',
    )
    assert(!saveDisabled(), 'a valid bore is Save-able')
    assert(document.body.querySelector('[role="alert"]') === null, 'a valid bore reports no error')
    assert(historyLength() === storedHistory, 'the first bore preview is not an undo step')
  } finally {
    store().cancelPendingAdd()
    mounted.unmount()
  }
})

// A zero bore is shown as a blank field, so its blank is the rendering of the
// stored zero, not text the user deleted. Leaving that field untouched used to
// send the blank through the unusable-text path and disable Save on a draft
// with nothing wrong with it (issue #1112 R3-1 review).
await scenario('an untouched blank bore is a valid draft, a cleared one is not', async () => {
  resetStore()
  store().addGearFeature('Gear', { x: 40, y: 30 }, 30, {
    ...defaultGearCreationParams(30),
    crestForm: 'rounded',
  }, 5)
  const featureId = featureIdForKind('gear')
  const storedHistory = historyLength()
  const mounted = await openPanel(featureId, 'gear')
  const saveDisabled = (): boolean =>
    (buttonByLabel('Save') as unknown as { disabled?: boolean }).disabled === true
  const draftBore = (): number | null => {
    const value = resolveFeatureInstance(project(), featureId)?.canned?.params.boreDiameter
    return typeof value === 'number' ? value : null
  }
  try {
    await waitFor(() => panelInputs().length === 7, 'the seven numeric gear fields render')
    const [, teeth] = panelInputs()
    // Bore is the last of the seven numeric fields.
    const bore = panelInputs()[panelInputs().length - 1]
    assert(bore.value === '', `a zero bore renders blank (it reads "${bore.value}")`)

    // A valid edit that has nothing to do with the bore.
    setInputValue(teeth, '22')
    await flush()
    const edited = previewGeometry(featureId)
    assert(draftBore() === 0, 'the gear still has no bore')
    assert(!saveDisabled(), 'the valid tooth count is Save-able')

    // Clicking into the bore and leaving it again is what a user does while
    // reading the panel. React dispatches `onBlur` from `focusout`.
    bore.dispatchEvent(new dom.Event('focusout', { bubbles: true }) as unknown as Event)
    await flush()
    assert(bore.value === '', `the untouched bore still renders blank (it reads "${bore.value}")`)
    assert(!saveDisabled(), 'leaving the untouched blank bore kept Save enabled')
    assert(document.body.querySelector('[role="alert"]') === null, 'the blank bore reported no error')
    assert(previewGeometry(featureId) === edited, 'the untouched bore left the preview alone')
    assert(draftBore() === 0, 'the untouched bore stayed zero')
    assert(historyLength() === storedHistory, 'the untouched bore is not an undo step')

    // Blank is valid only because it renders the zero: text the user actually
    // removes is still the unusable draft a cleared field always was, or the
    // blank-field refusal would be gone for this field alone.
    setInputValue(bore, '6')
    await flush()
    assert(previewGeometry(featureId) !== edited, 'a typed bore previews')
    assert(draftBore() === 6, 'the typed bore reached the draft')
    assert(!saveDisabled(), 'a typed bore is Save-able')

    setInputValue(bore, '')
    await flush()
    assert(saveDisabled(), 'a bore the user cleared is refused')
    assert(document.body.querySelector('[role="alert"]') !== null, 'the cleared bore is reported')
  } finally {
    store().cancelPendingAdd()
    mounted.unmount()
  }
})

// A field the browser changed without dispatching an `input` event (an
// autofill, a paste the browser handles on its own) holds text the draft never
// saw. The blur validates what is on screen, so neither unreadable text nor a
// blank field can pass for the draft's older number (#1112 R3-1 review).
await scenario('blurring a gear field with text the draft never saw is refused', async () => {
  resetStore()
  store().addGearFeature('Gear', { x: 40, y: 30 }, 30, {
    ...defaultGearCreationParams(30),
    crestForm: 'rounded',
  }, 5)
  const featureId = featureIdForKind('gear')
  const mounted = await openPanel(featureId, 'gear')
  const saveDisabled = (): boolean =>
    (buttonByLabel('Save') as unknown as { disabled?: boolean }).disabled === true
  try {
    await waitFor(() => panelInputs().length === 7, 'the seven numeric gear fields render')
    const [, teeth] = panelInputs()
    setInputValue(teeth, '22')
    await flush()
    const previewed = previewGeometry(featureId)
    assert(!saveDisabled(), 'the typed tooth count is Save-able')

    const setter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, 'value')?.set
    assert(setter, 'linkedom has an input value setter')
    // No `input` event either time: the draft holds 22 while the field reads the
    // text, so the blur is the only thing that can notice the disagreement.
    for (const text of ['two', '']) {
      setInputValue(teeth, '22')
      await flush()
      assert(!saveDisabled(), 'each round starts from the valid draft')
      setter.call(teeth, text)
      teeth.dispatchEvent(new dom.Event('focusout', { bubbles: true }) as unknown as Event)
      await flush()
      assert(saveDisabled(), `Save is refused for "${text}", which the draft never saw`)
      assert(
        document.body.querySelector('[role="alert"]') !== null,
        `"${text}" is reported instead of silently keeping the draft's 22`,
      )
      assert(previewGeometry(featureId) === previewed, 'the last valid preview is kept')
    }
  } finally {
    store().cancelPendingAdd()
    mounted.unmount()
  }
})

// The gear's Save path goes through the same preview commit as the flats.
await scenario('gear: Save is one undo step and one undo restores the stored gear', async () => {
  resetStore()
  store().addGearFeature('Gear', { x: 40, y: 30 }, 30, {
    ...defaultGearCreationParams(30),
    crestForm: 'rounded',
  }, 5)
  const featureId = featureIdForKind('gear')
  const storedDefinition = definitionJson(featureId)
  const storedHistory = historyLength()
  const mounted = await openPanel(featureId, 'gear')
  try {
    await waitFor(() => panelInputs().length === 7, 'the seven numeric gear fields render')
    setInputValue(panelInputs()[1], '22')
    await flush()
    const previewed = previewGeometry(featureId)
    buttonByLabel('Save').click()
    await waitFor(() => historyLength() === storedHistory + 1, 'Save is one undo step')
    await waitFor(() => store().pendingAdd === null, 'Save closes the panel session')
    assert(previewGeometry(featureId) === previewed, 'Save kept the previewed gear')
  } finally {
    mounted.unmount()
  }
  await flush()

  store().undo()
  await flush()
  assert(definitionJson(featureId) === storedDefinition, 'one undo restored the stored gear')
})

// A gear being *created* previews its bore as the first value is typed
// (issue #1112 R2 item 12). A zero bore renders as a blank field, so the value
// typed into it is the only signal the canvas draft gets: the creation panel
// commits on blur for every other field, which left the previewed gear without
// its hole until the field was left — and never at all, since the pending-gear
// preview had no bore to draw (`previewPrimitives.test.ts` covers that half).
await scenario('creating a gear: the first bore value reaches the draft as it is typed', async () => {
  resetStore()
  const store = () => useProjectStore.getState()
  store().startAddGearPlacement()
  store().setPendingAddAnchor({ x: 40, y: 30 })
  store().setPendingGearRadiusAt({ x: 70, y: 30 })
  const pending = store().pendingAdd
  assert(pending?.shape === 'gear', 'the creation session is armed')
  const draftBore = (): number | null => {
    const current = store().pendingAdd
    return current && current.shape === 'gear' ? current.params.boreDiameter : null
  }
  const mounted = mount(React.createElement(GearParameterPanel, {
    pendingAdd: pending,
    units: 'mm',
    setPendingGearParams: (patch) => store().setPendingGearParams(patch),
  }))
  try {
    // Creation's default gear: teeth, whole depth, pressure angle, root fillet
    // and bore (the outside radius comes from the canvas drag until an Edit
    // panel is open).
    // The creation panel is the gear fields alone here (the side panel wraps
    // them in the canvas), so read every input it renders.
    const creationInputs = (): HTMLInputElement[] =>
      Array.from(document.body.querySelectorAll('input')) as unknown as HTMLInputElement[]
    await waitFor(() => creationInputs().length === 5, 'the five creation numeric fields render')
    const bore = creationInputs()[creationInputs().length - 1]
    assert(bore.value === '', `a zero bore renders blank (it reads "${bore.value}")`)
    assert(draftBore() === 0, 'the draft starts with no bore')

    setInputValue(bore, '6')
    await flush()
    assert(draftBore() === 6, `the typed bore reached the draft without leaving the field (it reads ${String(draftBore())})`)
    assert(String(bore.value) === '6', 'the field keeps what was typed')

    // A half-typed value keeps the last usable number rather than dropping the
    // bore mid-keystroke; the blur commit settles the field.
    setInputValue(bore, '')
    await flush()
    assert(draftBore() === 6, 'a blank field keeps the last bore until the field is left')
    setInputValue(bore, '6')
    await flush()
    bore.dispatchEvent(new dom.Event('focusout', { bubbles: true }) as unknown as Event)
    await flush()
    assert(draftBore() === 6, 'leaving the field keeps the typed bore')
    setInputValue(bore, '8')
    await flush()
    assert(draftBore() === 8, 'a later edit follows the field too')
  } finally {
    store().cancelPendingAdd()
    mounted.unmount()
  }
})

// Clearing a bore that had a value is a refusal, not a silent zero (issue #1112
// R2 item 12, correction round 1). The creation panel committed the blank
// through `Number('') === 0`, so the hole disappeared with nothing reported and
// Create still made the gear; the store's creation clamp then turned even the
// refusal back into a valid zero. A blank field means "no bore" only while the
// draft already is zero — the untouched field the R3-1 review fixed — and over a
// value it is the validator's refusal, exactly as the Edit panel answers.
await scenario('creating a gear: clearing a bore that had a value is refused', async () => {
  resetStore()
  const store = () => useProjectStore.getState()
  store().startAddGearPlacement()
  store().setPendingAddAnchor({ x: 40, y: 30 })
  store().setPendingGearRadiusAt({ x: 70, y: 30 })
  const draftBore = (): number => {
    const current = store().pendingAdd
    assert(current?.shape === 'gear', 'the creation session is armed')
    return current.params.boreDiameter
  }
  const creationInputs = (): HTMLInputElement[] =>
    Array.from(document.body.querySelectorAll('input')) as unknown as HTMLInputElement[]
  const bore = (): HTMLInputElement => creationInputs()[creationInputs().length - 1] as HTMLInputElement
  const warning = (): string | null =>
    document.body.querySelector('.sketch-banner-warning')?.textContent ?? null
  const leaveBore = (): void => {
    bore().dispatchEvent(new dom.Event('focusout', { bubbles: true }) as unknown as Event)
  }
  const mounted = mount(React.createElement(CreationGearPanel))
  try {
    await waitFor(() => creationInputs().length === 5, 'the five creation numeric fields render')
    assert(bore().value === '', `a zero bore renders blank (it reads "${bore().value}")`)

    // The untouched blank is how a zero bore renders, so leaving it must stay
    // valid and stay blank (no "0" typed in, no error).
    leaveBore()
    await flush()
    assert(draftBore() === 0, 'an untouched blank bore stays zero')
    assert(bore().value === '', 'the untouched blank bore stays blank')
    assert(warning() === null, 'the untouched blank bore reports nothing')

    setInputValue(bore(), '6')
    await flush()
    leaveBore()
    await flush()
    assert(draftBore() === 6, 'a typed bore is kept')
    assert(warning() === null, 'a valid bore reports nothing')

    // The repro: clear the value and leave the field.
    setInputValue(bore(), '')
    await flush()
    assert(draftBore() === 6, 'the blank field holds the last bore while it is typed in')
    leaveBore()
    await flush()
    assert(Number.isNaN(draftBore()), `the cleared bore is refused (it reads ${String(draftBore())})`)
    assert(bore().value === '', 'the refused field stays as the user left it')
    const message = warning()
    assert(message !== null && /bore/i.test(message), `the cleared bore is reported (it says ${String(message)})`)

    // Refused means refused: Create writes nothing rather than a gear with no
    // hole.
    const featuresBefore = project().features.length
    assert(store().completePendingGear().length === 0, 'Create refuses the cleared-bore gear')
    assert(project().features.length === featuresBefore, 'the refused Create wrote nothing')

    // The refusal belongs to the field, not to the session: typing a bore again
    // clears it and Create works.
    setInputValue(bore(), '8')
    await flush()
    assert(draftBore() === 8, 'a typed bore replaces the refusal')
    assert(warning() === null, 'the warning goes when the bore is usable again')
    assert(store().completePendingGear().length === 1, 'the recovered gear is created')
  } finally {
    store().cancelPendingAdd()
    mounted.unmount()
  }
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

// A preview must not be able to throw away work the user did elsewhere while an
// editor was open. The host closes a rotary dialog as soon as the bar changes,
// so a stock resize made with a preview live is the ordinary way this happens:
// closing the dialog used to restore the whole transaction snapshot and take
// the resize with it (issue #1112 F1 review).
await scenario('closing a preview keeps a change made elsewhere in the project', async () => {
  const featureId = rotaryFeature('turn')
  const storedDefinition = definitionJson(featureId)
  const storedStock = JSON.stringify(project().stock)
  const storedHistory = historyLength()
  const { mounted } = await openEditor('turn', featureId)
  const diameter = document.body.querySelector('#rotary-solid-diameter') as unknown as HTMLInputElement
  assert(diameter, 'the diameter field renders')
  setInputValue(diameter, '12')
  await flush()
  assert(previewGeometry(featureId) !== '', 'the diameter previewed live')

  const resized = roundStock(50, 200, 'x', { x: 10, y: 30 })
  store().setStock(resized)
  await flush()
  assert(JSON.stringify(project().stock) === JSON.stringify(resized), 'the stock resize reached the project')

  mounted.unmount()
  await flush()
  assert(
    JSON.stringify(project().stock) === JSON.stringify(resized),
    'closing the editor kept the stock resize',
  )
  assert(definitionJson(featureId) === storedDefinition, 'closing the editor restored the stored Turn')
  assert(
    historyLength() === storedHistory + 1,
    'the session is one undo step, so the change stays undoable',
  )

  store().undo()
  await flush()
  assert(JSON.stringify(project().stock) === storedStock, 'one undo put the stock back')
  assert(definitionJson(featureId) === storedDefinition, 'one undo left the stored Turn in place')
})

// A Thread preview also moves the row's Z span. Restoring the parameters must
// put the span back through the store's own resolver, not by a second guess.
await scenario('closing a thread preview keeps an unrelated rename and restores the span', async () => {
  const featureId = rotaryFeature('thread')
  const storedDefinition = definitionJson(featureId)
  const storedSpan = spanFingerprint(featureId)
  const storedHistory = historyLength()
  const { mounted } = await openEditor('thread', featureId)
  const depth = document.body.querySelector('#rotary-depth') as unknown as HTMLInputElement
  assert(depth, 'the depth field renders')
  setInputValue(depth, '1.2')
  await flush()
  assert(spanFingerprint(featureId) !== storedSpan, 'the depth previewed a new span')

  store().updateFeature(featureId, { name: 'Renamed thread' })
  await flush()
  mounted.unmount()
  await flush()
  assert(
    project().features.find((row) => row.id === featureId)?.name === 'Renamed thread',
    'closing kept the rename',
  )
  assert(definitionJson(featureId) === storedDefinition, 'closing restored the stored Thread')
  assert(spanFingerprint(featureId) === storedSpan, 'closing restored the stored span')
  assert(historyLength() === storedHistory + 1, 'the session is one undo step')

  store().undo()
  await flush()
  assert(
    project().features.find((row) => row.id === featureId)?.name.startsWith('Thread'),
    'one undo put the rename back',
  )
  assert(definitionJson(featureId) === storedDefinition, 'one undo left the stored Thread in place')
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

// ── Thread, Flutes, Turn and Polygon, in their own canvas panels ──────────

interface PanelCase {
  kind: 'thread' | 'flutes' | 'turn' | 'polygon'
  /**
   * Input ids in the order they are changed, with the value to type and what
   * the field must move in the preview. Depth is the one number that is not part
   * of a Thread/Flutes sheet line: it is how deep the line cuts, so it moves the
   * row's Z span instead of its geometry (the builder draws the line on the
   * surface and the depth decides where the cut enters it).
   */
  fields: Array<{ id: string; value: string; changes: 'geometry' | 'span' }>
  /**
   * The Right/Left hand, which is a parameter like any other: it signs the
   * helix of a Thread and the twist of a Flute, so the drawn lines must follow
   * it. `stored` is the parameter the dialog's draft must write.
   */
  direction?: { label: string; stored: [key: string, value: string | number] }
}

const PANEL_CASES: PanelCase[] = [
  {
    kind: 'thread',
    fields: [
      { id: 'rotary-start', value: '8', changes: 'geometry' },
      { id: 'rotary-length', value: '24', changes: 'geometry' },
      { id: 'rotary-pitch', value: '2.5', changes: 'geometry' },
      { id: 'rotary-starts', value: '2', changes: 'geometry' },
      { id: 'rotary-depth', value: '1.2', changes: 'span' },
    ],
    direction: { label: 'Left-hand', stored: ['hand', 'left'] },
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
    // The field is a magnitude, so the stored twist is the negated 10 typed above.
    direction: { label: 'Left-hand', stored: ['twist', -10] },
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

async function openEditor(kind: PanelCase['kind'], featureId: string): Promise<{ mounted: Mounted; closed: () => boolean }> {
  let closed = false
  const onClose = () => { closed = true }
  const element = kind === 'thread' || kind === 'flutes'
    ? React.createElement(RotaryPatternPanel, { kind, featureId, onClose })
    : React.createElement(RotarySolidPanel, { kind, featureId, onClose })
  const mounted = mount(element)
  await waitFor(() => document.body.querySelector('.canvas-workflow-panel--rotary') !== null, 'the panel renders')
  return { mounted, closed: () => closed }
}

for (const panelCase of PANEL_CASES) {
  await scenario(`${panelCase.kind}: every field previews live and closing restores the stored feature`, async () => {
    const featureId = rotaryFeature(panelCase.kind)
    const storedDefinition = definitionJson(featureId)
    const storedHistory = historyLength()
    const storedFeatures = JSON.stringify(project().features.map((row) => ({ id: row.id, z_top: row.z_top, z_bottom: row.z_bottom })))
    const { mounted } = await openEditor(panelCase.kind, featureId)
    try {
      const geometryBefore = previewGeometry(featureId)
      let spanBefore = spanFingerprint(featureId)
      let previousGeometry = geometryBefore
      for (const field of panelCase.fields) {
        const input = document.body.querySelector(`#${field.id}`) as unknown as HTMLInputElement | null
        assert(input, `the dialog has #${field.id}`)
        setInputValue(input, field.value)
        await flush()
        const geometry = previewGeometry(featureId)
        const span = spanFingerprint(featureId)
        if (field.changes === 'span') {
          assert(span !== spanBefore, `${panelCase.kind} #${field.id}: the previewed Z span did not change`)
        } else {
          assert(geometry !== previousGeometry, `${panelCase.kind} #${field.id}: the previewed geometry did not change`)
        }
        previousGeometry = geometry
        spanBefore = span
        assert(historyLength() === storedHistory, `${panelCase.kind} #${field.id}: a preview is not an undo step`)
      }
      if (panelCase.direction) {
        const directionGroup = document.body.querySelector('.rotary-panel__direction')
        assert(directionGroup, `${panelCase.kind} renders its direction field`)
        await chooseSelectOption(directionGroup, panelCase.direction.label)
        const geometry = previewGeometry(featureId)
        assert(
          geometry !== previousGeometry,
          `${panelCase.kind} direction: the previewed geometry did not change`,
        )
        previousGeometry = geometry
        const [key, expected] = panelCase.direction.stored
        const storedParams = resolveFeatureInstance(project(), featureId)?.canned?.params
        assert(
          storedParams?.[key] === expected,
          `${panelCase.kind} direction: the draft stored ${key}=${String(storedParams?.[key])}, expected ${String(expected)}`,
        )
        assert(historyLength() === storedHistory, `${panelCase.kind} direction: a preview is not an undo step`)
      }
    } finally {
      mounted.unmount()
    }
    await flush()
    assert(definitionJson(featureId) === storedDefinition, `${panelCase.kind}: closing restored the stored definition`)
    assert(
      JSON.stringify(project().features.map((row) => ({ id: row.id, z_top: row.z_top, z_bottom: row.z_bottom }))) === storedFeatures,
      `${panelCase.kind}: closing restored the instance spans`,
    )
    assert(historyLength() === storedHistory, `${panelCase.kind}: closing left the undo history alone`)
  })
}

// Save from every panel, not just the Turn: an editor whose Save skips the
// preview commit would otherwise leave the shape as a normal undo entry.
for (const panelCase of PANEL_CASES) {
  await scenario(`${panelCase.kind}: Save is one undo step and one undo restores the stored feature`, async () => {
    const featureId = rotaryFeature(panelCase.kind)
    const storedDefinition = definitionJson(featureId)
    const storedHistory = historyLength()
    const storedSpans = JSON.stringify(project().features.map((row) => [row.id, row.z_bottom, row.z_top]))
    const { mounted, closed } = await openEditor(panelCase.kind, featureId)
    try {
      for (const field of panelCase.fields) {
        const input = document.body.querySelector(`#${field.id}`) as unknown as HTMLInputElement | null
        assert(input, `the dialog has #${field.id}`)
        setInputValue(input, field.value)
      }
      await flush()
      const previewed = previewGeometry(featureId)
      assert(previewed !== '', 'the draft previewed before Save')

      const apply = document.body.querySelector('.rotary-panel__create') as unknown as HTMLButtonElement | null
      assert(apply, 'the panel has a Save action')
      assert(apply.disabled === false, 'Save is enabled')
      apply.click()
      await waitFor(() => closed(), 'Save closes the panel')
      await waitFor(() => historyLength() === storedHistory + 1, 'Save is one undo step')
      assert(previewGeometry(featureId) === previewed, 'Save kept the previewed shape')
    } finally {
      mounted.unmount()
    }
    await flush()

    store().undo()
    await flush()
    assert(definitionJson(featureId) === storedDefinition, 'one undo restored the stored feature')
    assert(
      JSON.stringify(project().features.map((row) => [row.id, row.z_bottom, row.z_top])) === storedSpans,
      'one undo restored the instance spans',
    )
  })
}

// A drawn outline on Top is the bar's side view, so a Turn can copy it as its
// own profile. Picking one changes the draft's shape like any other field
// (issue #1112 H, live preview in F1).
await scenario('a Turn profile pick previews live and closing restores the stored Turn', async () => {
  const featureId = rotaryFeature('turn')
  const sourceId = (() => {
    assert(switchWorkspaceFace('top'), 'the workspace enters Top')
    // Inside one half of the bar, clear of both the centreline and the surface:
    // along 20..80, radius 8..16 from the bar's centreline at y = 50.
    store().addRectFeature('Side profile', 20, 34, 60, 8, 5)
    assert(switchWorkspaceFace('around'), 'the workspace returns to Around')
    const row = project().features.find((feature) => feature.name === 'Side profile')
    assert(row, 'the profile source was drawn')
    return row.id
  })()
  const storedDefinition = definitionJson(featureId)
  const storedHistory = historyLength()
  const cylinder = previewGeometry(featureId)
  const { mounted } = await openEditor('turn', featureId)
  try {
    const picker = document.body.querySelector('.rotary-panel__profile')
    assert(picker, 'the Turn panel renders its profile picker')
    await chooseSelectOption(picker, 'Side profile')
    const profiled = previewGeometry(featureId)
    assert(profiled !== cylinder, 'picking a profile changed the previewed mesh')
    const stored = resolveFeatureInstance(project(), featureId)?.canned?.params
    assert(
      JSON.stringify(stored?.profile ?? null).includes(sourceId),
      'the previewed profile names the feature it was copied from',
    )
    assert(historyLength() === storedHistory, 'a profile pick is not an undo step')

    await chooseSelectOption(picker, 'None — one plain diameter')
    assert(previewGeometry(featureId) !== profiled, 'clearing the pick changed the previewed mesh')
  } finally {
    mounted.unmount()
  }
  await flush()
  assert(definitionJson(featureId) === storedDefinition, 'closing restored the stored Turn')
  assert(historyLength() === storedHistory, 'closing left the undo history alone')
})

// A model's parameter edit must reach the linked copy that shares its
// definition through the Z span, exactly as a Save from the panel does.
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
  const { mounted } = await openEditor('turn', featureId)
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

// The Turn panel builds its canned data from the frame snapshot, the same
// builder the store action uses, so a preview and an Apply cannot drift.
await scenario('a preview writes the same parameters the Apply path builds', async () => {
  const featureId = rotaryFeature('turn')
  const { mounted } = await openEditor('turn', featureId)
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
