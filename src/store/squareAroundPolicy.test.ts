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
 * The square-blank Around workflow policy through the real store (issue #1016
 * C2-U1).
 *
 * A real square blank enters the Around face and the generated-model workflow
 * (C2-B) lands there — including on a provisional setup and with no machine
 * selected. Every other authoring path onto that sheet is refused atomically:
 * a direct 2D feature, an armed placement, a stale completion, an import, a
 * paste and canned Thread/Flutes. Converting the blank round→square→round
 * keeps every feature and operation byte-identical and only changes which
 * operations count as part of the job.
 *
 * Mutations checked one at a time against these assertions:
 * - the workflow guard used as the sketch permission (i.e.
 *   `aroundSketchAuthoringAvailable` answered from `aroundUnavailableReason`)
 *   → the direct-feature / completion / import / paste / Thread refusals fail;
 * - `defaultSetupForFace` defaulting a square blank's Around axis to `'x'` →
 *   the Y-axis realization and axis assertions fail;
 * - `operationCutsInProject` letting a non-rotary Around operation count on a
 *   square blank → the round→square disabled-retained assertion fails;
 * - removing the derived-create guard in `offsetSelectedFeatures` /
 *   `mergeSelectedFeatures` / `cutSelectedFeatures` or in the offset/cut/join
 *   completions (issue #1016 C2-U1F) → the square derived refusals fail;
 * - removing the gear guard in `createAddGearFeatureAction` → the gear
 *   refusals (both branches) fail;
 * - judging the derived-create guard by `activeFace` instead of the resulting
 *   feature's own face → the "Around sources under Top" refusals fail.
 *
 * Run with: npx tsx src/store/squareAroundPolicy.test.ts
 */

import assert from 'node:assert/strict'
import { DEFAULT_SETUP_ID, defaultTool, getStockBounds, newProject, rectProfile, roundStock } from '../types/project'
import { isSquareStock, squareStock } from '../types/barStock'
import type { Project, SketchFeature, Stock, Tool } from '../types/project'
import { defaultGearCreationParams } from '../sketch/gearProfile'
import { projectWithFeatures } from '../test/projectFixtures'
import { useProjectStore } from './projectStore'
import { switchWorkspaceFace } from './workspaceFace'
import {
  activeFace,
  activeSetup,
  aroundSketchAuthoringAvailable,
  aroundUnavailableReason,
} from './helpers/activeFace'
import { provisionalSetupId } from './helpers/provisionalSetup'
import { operationCutsInProject } from './helpers/projectType'
import { pasteClipboardFeatures, selectedVisibleClipboardFeatures } from '../platform/featureClipboard'

const store = () => useProjectStore.getState()

function log(message: string): void {
  console.log(message)
}

interface Spec {
  axis: 'x' | 'y'
  units: 'mm' | 'inch'
  at: { x: number; y: number }
  side: number
  length: number
}

const SPECS: readonly Spec[] = [
  { axis: 'x', units: 'mm', at: { x: 10, y: 30 }, side: 40, length: 200 },
  { axis: 'y', units: 'mm', at: { x: 10, y: 30 }, side: 40, length: 200 },
  { axis: 'x', units: 'inch', at: { x: 3, y: 5 }, side: 1.5, length: 8 },
  { axis: 'y', units: 'inch', at: { x: 3, y: 5 }, side: 1.5, length: 8 },
]

function cutter(units: 'mm' | 'inch'): Tool {
  return {
    ...defaultTool(units, 1),
    id: 'ball',
    name: 'ball',
    units,
    type: 'ball_endmill',
    diameter: units === 'mm' ? 4 : 0.1875,
    defaultStepover: 0.4,
    defaultStepdown: units === 'mm' ? 1 : 0.04,
    defaultFeed: units === 'mm' ? 600 : 24,
    defaultPlungeFeed: units === 'mm' ? 200 : 8,
  }
}

function feature(id: string, authoringFace: 'top' | 'around'): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: { profile: rectProfile(20, 10, 10, 8), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    authoringFace,
    z_top: 40,
    z_bottom: authoringFace === 'around' ? 35 : 0,
    visible: true,
    locked: false,
  }
}

/** A rotary square blank with no machine selected and no Around setup yet. */
function squareProject(spec: Spec): Project {
  const base = newProject(`Square ${spec.axis} ${spec.units}`, spec.units)
  base.meta.projectType = 'rotary'
  base.stock = squareStock(spec.side, spec.length, spec.axis, spec.at)
  base.meta.machineDefinitions = []
  base.meta.selectedMachineId = null
  base.tools = [cutter(spec.units)]
  return base
}

/** A rotary round bar with no machine selected and no Around setup yet. */
function roundProject(spec: Spec): Project {
  const base = newProject(`Round ${spec.axis} ${spec.units}`, spec.units)
  base.meta.projectType = 'rotary'
  base.stock = roundStock(spec.side, spec.length, spec.axis, spec.at)
  base.meta.machineDefinitions = []
  base.meta.selectedMachineId = null
  base.tools = [cutter(spec.units)]
  return base
}

/** A closed rect draft authored on `face`, overlapping its sibling at `x`. */
function rectFeature(
  id: string,
  x: number,
  authoringFace: 'top' | 'around',
  operation: SketchFeature['operation'] = 'subtract',
): SketchFeature {
  const base = feature(id, authoringFace)
  return {
    ...base,
    operation,
    sketch: { ...base.sketch, profile: rectProfile(x, 10, 10, 8) },
  }
}

/** Gear creation params with an explicit bore, so both action branches are reachable. */
function gearParams(boreDiameter: number) {
  return { ...defaultGearCreationParams(8), boreDiameter }
}

interface Snapshot {
  project: Project
  selection: unknown
  dirty: boolean
  past: number
}

function snapshot(): Snapshot {
  const state = store()
  return { project: state.project, selection: state.selection, dirty: state.dirty, past: state.history.past.length }
}

function assertUntouched(before: Snapshot, label: string): void {
  const state = store()
  assert.equal(state.project, before.project, `${label}: no project mutation`)
  assert.equal(state.selection, before.selection, `${label}: no selection mutation`)
  assert.equal(state.dirty, before.dirty, `${label}: no dirtiness mutation`)
  assert.equal(state.history.past.length, before.past, `${label}: no history entry`)
}

// ── 1. A square blank realizes the generated-model workflow ────

log('Testing no-machine square realization and one undo, both axes and units...')

for (const spec of SPECS) {
  const label = `${spec.axis}/${spec.units}`
  store().loadProject(projectWithFeatures(squareProject(spec), []))
  assert.ok(isSquareStock(store().project.stock), `${label}: the fixture is a square blank`)
  assert.equal(aroundUnavailableReason(store().project), null, `${label}: the Around face is workflow-available`)
  assert.equal(aroundSketchAuthoringAvailable(store().project), false, `${label}: but its sheet stays round-only`)
  assert.equal(switchWorkspaceFace('around'), true, `${label}: the workspace enters Around`)
  assert.equal(activeSetup(store().project).id, provisionalSetupId('around'), `${label}: on the provisional setup`)

  const stockBefore = structuredClone(store().project.stock)
  const bounds = getStockBounds(store().project.stock)
  const alongMin = spec.axis === 'x' ? bounds.minX : bounds.minY
  const alongStart = alongMin + spec.length * 0.1
  const alongEnd = alongStart + spec.length * 0.3
  const pastBefore = store().history.past.length

  const result = store().addRotarySolid({
    kind: 'square-to-round',
    diameter: spec.side * 0.6,
    alongStart,
    alongEnd,
    toolRef: 'ball',
  })
  assert.ok(result.ok, `${label}: the generated model is created (${result.ok ? '' : result.reason})`)
  if (!result.ok) throw new Error('unreachable')

  const after = store().project
  assert.deepEqual(after.stock, stockBefore, `${label}: the square blank is byte-identical`)
  const realised = activeSetup(after)
  assert.notEqual(realised.id, provisionalSetupId('around'), `${label}: the provisional setup became real`)
  assert.equal(realised.kind, 'around', `${label}: and is an Around setup`)
  assert.equal(realised.orientation.axis, spec.axis, `${label}: on the blank's own axis`)
  assert.equal(after.operations.length, 2, `${label}: rough and finish exist`)
  for (const operation of after.operations) {
    assert.equal(operation.setupId, realised.id, `${label}: both operations join the realised setup`)
  }
  assert.equal(store().history.past.length, pastBefore + 1, `${label}: exactly one history step`)

  store().undo()
  const undone = store().project
  assert.equal(undone.setups.some((setup) => setup.kind === 'around'), false, `${label}: one undo removes the realised setup`)
  assert.equal(undone.operations.length, 0, `${label}: and both operations`)
  assert.equal(undone.features.length, 0, `${label}: and the model`)
  assert.deepEqual(undone.stock, stockBefore, `${label}: the blank never changed`)
  assert.equal(activeFace(undone), 'around', `${label}: the workspace stays on Around`)

  store().redo()
  assert.equal(store().project.operations.length, 2, `${label}: redo restores the generated pair`)
}

// ── 2. Every other Around authoring path is refused ────────────

log('Testing the direct-feature, completion, import, paste and Thread refusals...')

store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [feature('top-rect', 'top')]))
assert.equal(switchWorkspaceFace('around'), true)
assert.equal(activeFace(store().project), 'around', 'the workspace is on the square Around sheet')

// Arming a drawing tool changes nothing.
store().startAddRectPlacement()
assert.equal(store().pendingAdd, null, 'arming a rectangle on the square Around sheet is refused')

// A direct 2D feature is refused with no project, selection, dirtiness or
// history change.
const beforeFeature = snapshot()
store().addFeature(feature('around-rect', 'around'))
assertUntouched(beforeFeature, 'direct addFeature')
store().addRectFeature('Around rect', 20, 10, 10, 8, 2)
assertUntouched(beforeFeature, 'addRectFeature')

// A stale request started on a round bar and completed after the blank became
// square is refused atomically.
store().loadProject(projectWithFeatures(
  { ...squareProject(SPECS[0]), stock: roundStock(40, 200, 'x', { x: 10, y: 30 }) },
  [feature('top-rect', 'top')],
))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around')
store().startAddRectPlacement()
assert.ok(store().pendingAdd, 'the round bar arms the rectangle')
store().setPendingAddAnchor({ x: 30, y: 20 })
store().setStockShape('square')
assert.ok(isSquareStock(store().project.stock), 'the blank is now square')
const beforeCompletion = snapshot()
store().placePendingAddAt({ x: 45, y: 32 })
assertUntouched(beforeCompletion, 'stale completion')

// An import is refused and creates nothing.
const beforeImport = snapshot()
const imported = store().importShapes({
  fileName: 'part.dxf',
  sourceType: 'dxf',
  shapes: [{ name: 'Rect', sourceType: 'dxf', layerName: '0', profile: rectProfile(0, 0, 10, 10) }],
})
assert.deepEqual(imported, [], 'an import on the square Around sheet returns nothing')
assertUntouched(beforeImport, 'importShapes')

// A paste is refused before its history transaction opens.
const clipboard = selectedVisibleClipboardFeatures(store().project, ['top-rect'])
assert.ok(clipboard.length > 0, 'the Top feature is copyable')
const beforePaste = snapshot()
assert.deepEqual(pasteClipboardFeatures(store(), clipboard, { x: 0, y: 0 }), [], 'a paste onto the square Around sheet returns nothing')
assertUntouched(beforePaste, 'pasteClipboardFeatures')

// Canned Thread/Flutes keep their C1 refusal.
const beforeThread = snapshot()
const thread = store().addRotaryPattern({ kind: 'thread', start: 20, length: 40, pitch: 2, depth: 1 })
assert.equal(thread.ok, false, 'Thread on a square blank is refused')
if (thread.ok) throw new Error('unreachable')
assert.equal(thread.reason, 'aroundUnavailable', 'with the Around-unavailable reason')
assert.equal(thread.detail, 'needsRoundBar', 'and the compatibility detail string')
assertUntouched(beforeThread, 'addRotaryPattern')

// ── 3. Round → square → round keeps everything, disables cuts ──

log('Testing round -> square -> round retention...')

const roundBase = newProject('Round', 'mm')
roundBase.meta.projectType = 'rotary'
roundBase.stock = roundStock(40, 200, 'x', { x: 10, y: 30 })
roundBase.tools = [cutter('mm')]
roundBase.setups.push({
  ...roundBase.setups[0],
  id: 'round-around',
  name: 'Around',
  kind: 'around',
  orientation: { axis: 'x', angleDeg: 0 },
})
roundBase.activeSetupId = 'round-around'
store().loadProject(projectWithFeatures(roundBase, []))
store().addFeature(feature('around-rect', 'around'))
store().addOperation('follow_line', 'rough', { source: 'features', featureIds: ['around-rect'] })
const roundSaved: Stock = structuredClone(store().project.stock)
const geometryBefore = structuredClone(store().project.features)
const operationsBefore = store().project.operations.map((operation) => ({ id: operation.id, kind: operation.kind, setupId: operation.setupId }))

for (const operation of store().project.operations) {
  assert.equal(operationCutsInProject(store().project, operation), true, 'on a round bar the Around operation cuts')
}

store().setStockShape('square')
assert.ok(isSquareStock(store().project.stock), 'the blank is square')
assert.deepEqual(store().project.features, geometryBefore, 'every Around feature is retained byte-identical')
assert.deepEqual(
  store().project.operations.map((operation) => ({ id: operation.id, kind: operation.kind, setupId: operation.setupId })),
  operationsBefore,
  'every operation is retained, only its eligibility changes',
)
for (const operation of store().project.operations) {
  assert.equal(operationCutsInProject(store().project, operation), false, 'a non-rotary Around operation is disabled on the square blank')
}
assert.equal(switchWorkspaceFace('around'), true, 'the square blank keeps the Around face')

store().setStockShape('round')
assert.ok(!isSquareStock(store().project.stock), 'the blank is round again')
assert.deepEqual(store().project.stock, roundSaved, 'the round box is restored exactly')
assert.deepEqual(store().project.features, geometryBefore, 'the geometry survived the round trip exactly')
for (const operation of store().project.operations) {
  assert.equal(operationCutsInProject(store().project, operation), true, 'the Around operation cuts again')
}

// ── 4. Derived-create and gear boundaries (U1F) ────────────────

log('Testing the derived-create and gear refusals on a square blank...')

/**
 * Identity snapshot of everything a refusal must leave alone: the whole
 * project (features, definitions, assets, tree, folders, operations, setups,
 * stock), selection, dirtiness, the history object (past/future/
 * transactionStart) and every pending request. Reference equality is the
 * strongest form of "unchanged" available.
 */
function fullSnapshot() {
  const state = store()
  return {
    project: state.project,
    selection: state.selection,
    pendingAdd: state.pendingAdd,
    pendingMove: state.pendingMove,
    pendingTransform: state.pendingTransform,
    pendingOffset: state.pendingOffset,
    pendingShapeAction: state.pendingShapeAction,
    dirty: state.dirty,
    history: state.history,
  }
}

function assertRefused(before: ReturnType<typeof fullSnapshot>, label: string): void {
  const state = store()
  assert.equal(state.project, before.project, `${label}: project identity unchanged`)
  assert.equal(state.selection, before.selection, `${label}: selection identity unchanged`)
  assert.equal(state.pendingAdd, before.pendingAdd, `${label}: pending add unchanged`)
  assert.equal(state.pendingMove, before.pendingMove, `${label}: pending move unchanged`)
  assert.equal(state.pendingTransform, before.pendingTransform, `${label}: pending transform unchanged`)
  assert.equal(state.pendingOffset, before.pendingOffset, `${label}: pending offset unchanged`)
  assert.equal(state.pendingShapeAction, before.pendingShapeAction, `${label}: pending shape action unchanged`)
  assert.equal(state.dirty, before.dirty, `${label}: dirtiness unchanged`)
  assert.equal(state.history, before.history, `${label}: history past/future/transaction unchanged`)
}

// Both axes and both unit systems: the refusals must not depend on the blank's
// axis or the project's units.
let before: ReturnType<typeof fullSnapshot>
for (const spec of SPECS) {
  const label = `${spec.axis}/${spec.units}`

  // A stale offset request armed on the round bar, completed after the blank
  // became square, is refused and stays pending.
  store().loadProject(projectWithFeatures(roundProject(spec), [
    rectFeature('a', 20, 'around'),
    rectFeature('b', 25, 'around'),
  ]))
  assert.equal(switchWorkspaceFace('around'), true, `${label}: the round bar enters Around`)
  store().selectFeatures(['a', 'b'])
  store().startOffsetSelectedFeatures()
  assert.ok(store().pendingOffset, `${label}: the offset request is armed on the round bar`)
  store().setStockShape('square')
  assert.ok(isSquareStock(store().project.stock), `${label}: the blank is now square`)
  before = fullSnapshot()
  assert.deepEqual(store().completePendingOffset(1), [], `${label}: the stale offset completion is refused`)
  assertRefused(before, `${label}: stale pending offset`)

  // The direct derived paths preserve the source's Around face and insert
  // without passing through `addFeature`, so each is refused after conversion.
  store().selectFeatures(['a', 'b'])
  before = fullSnapshot()
  assert.deepEqual(store().offsetSelectedFeatures(1), [], `${label}: direct offset is refused`)
  assertRefused(before, `${label}: direct offset`)
  assert.deepEqual(store().mergeSelectedFeatures(true), [], `${label}: direct join is refused`)
  assertRefused(before, `${label}: direct join`)
  assert.deepEqual(store().cutSelectedFeatures(true), [], `${label}: direct cut is refused`)
  assertRefused(before, `${label}: direct cut`)

  // Both gear branches (without and with a bore) are refused before any
  // insertion, so the non-bore branch cannot fabricate a success id.
  before = fullSnapshot()
  assert.deepEqual(
    store().addGearFeature('Gear', { x: 30, y: 20 }, 8, gearParams(0), 2),
    [],
    `${label}: a gear without a bore is refused`,
  )
  assertRefused(before, `${label}: gear without bore`)
  assert.deepEqual(
    store().addGearFeature('Gear', { x: 30, y: 20 }, 8, gearParams(2), 2),
    [],
    `${label}: a gear with a bore is refused`,
  )
  assertRefused(before, `${label}: gear with bore`)
}

// A pending cut and a pending join armed on the round bar are refused the same
// way: the cut is refused before its direct set, the join before the initial
// `selectFeatures` and the pending clear (see `completePendingShapeAction`).
log('Testing the stale pending cut and join refusals...')

store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [
  rectFeature('a', 20, 'around'),
  rectFeature('b', 25, 'around'),
]))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the cut')
store().selectFeatures(['a'])
store().startCutSelectedFeatures()
const cutAction = store().pendingShapeAction
assert.equal(cutAction?.kind, 'cut', 'a cut request is armed')
if (cutAction?.kind !== 'cut') throw new Error('unreachable')
assert.equal(cutAction.phase, 'targets', 'the single cutter opens on target selection')
store().selectFeature('b', true)
const cutActionWithTarget = store().pendingShapeAction
if (cutActionWithTarget?.kind !== 'cut') throw new Error('unreachable')
assert.deepEqual(cutActionWithTarget.targetIds, ['b'], 'the target is chosen before conversion')
store().setStockShape('square')
before = fullSnapshot()
assert.deepEqual(store().completePendingShapeAction(), [], 'the stale cut completion is refused')
assertRefused(before, 'stale pending cut')
store().cancelPendingShapeAction()

store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [
  rectFeature('a', 20, 'around', 'subtract'),
  rectFeature('b', 25, 'around', 'add'),
]))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the join')
store().selectFeatures(['a', 'b'])
store().startJoinSelectedFeatures()
const joinAction = store().pendingShapeAction
assert.equal(joinAction?.kind, 'join', 'a join request is armed (mixed operations keep the panel)')
if (joinAction?.kind !== 'join') throw new Error('unreachable')
assert.equal(joinAction.entityIds.length, 2, 'with both members')
store().setStockShape('square')
before = fullSnapshot()
assert.deepEqual(store().completePendingShapeAction(), [], 'the stale join completion is refused')
assertRefused(before, 'stale pending join')
store().cancelPendingShapeAction()

// The guard reads the resulting feature's own face, not the workspace face.
// A direct edit cannot be reached from the other face — the ghost guard drops
// an off-face member from the selection (#945) — but a pending request keeps
// its entity ids across a workspace move, and `setActiveSetup` is the store's
// own contract (the UI's `switchWorkspaceFace` refuses while an edit is live,
// this call does not). Judging by `activeFace` there would let the Around rows
// through.
log('Testing that an Around source is still refused from a Top workspace...')

store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [
  rectFeature('a', 20, 'around'),
  rectFeature('b', 25, 'around'),
]))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the stale offset')
store().selectFeatures(['a', 'b'])
store().startOffsetSelectedFeatures()
assert.ok(store().pendingOffset, 'the offset request is armed')
store().setStockShape('square')
store().setActiveSetup(DEFAULT_SETUP_ID)
assert.equal(activeFace(store().project), 'top', 'the workspace is now Top')
before = fullSnapshot()
assert.deepEqual(store().completePendingOffset(1), [], 'the Around offset completion is refused from Top')
assertRefused(before, 'Around pending offset under Top')
store().cancelPendingOffset()

store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [
  rectFeature('a', 20, 'around', 'subtract'),
  rectFeature('b', 25, 'around', 'add'),
]))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the stale join')
store().selectFeatures(['a', 'b'])
store().startJoinSelectedFeatures()
assert.equal(store().pendingShapeAction?.kind, 'join', 'the join request is armed')
store().setStockShape('square')
store().setActiveSetup(DEFAULT_SETUP_ID)
assert.equal(activeFace(store().project), 'top', 'the workspace is Top for the join too')
before = fullSnapshot()
assert.deepEqual(store().completePendingShapeAction(), [], 'the Around join completion is refused from Top')
assertRefused(before, 'Around pending join under Top')
store().cancelPendingShapeAction()

// A mixed-face selection is not reachable through the store: the workspace
// ghost guard drops the off-face member (#945), so a derived result always
// lands on the face its own sources were selected on. The anchor rule in
// `mergeSelectedFeatures` is what keeps a same-face Around union refused.
log('Testing that a mixed-face selection is not selectable...')

store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [
  rectFeature('top-rect', 20, 'top'),
  rectFeature('around-rect', 25, 'around'),
]))
assert.equal(activeFace(store().project), 'top', 'the workspace starts on Top')
store().selectFeatures(['top-rect', 'around-rect'])
assert.deepEqual(
  store().selection.selectedFeatureIds,
  ['top-rect'],
  'the off-face Around member is a ghost and cannot be selected from Top',
)

// ── 5. The allowed controls ───────────────────────────────────

log('Testing the allowed round-bar Around and square Top controls...')

let pastBefore: number

// Round Around: the same derived and gear authoring still works, with one undo
// per creation.
for (const spec of [SPECS[0], SPECS[3]]) {
  const label = `control ${spec.axis}/${spec.units}`
  store().loadProject(projectWithFeatures(roundProject(spec), [
    rectFeature('a', 20, 'around'),
    rectFeature('b', 25, 'around'),
  ]))
  assert.equal(switchWorkspaceFace('around'), true, `${label}: the round bar enters Around`)

  store().selectFeatures(['a', 'b'])
  pastBefore = store().history.past.length
  const offsetIds = store().offsetSelectedFeatures(1)
  assert.ok(offsetIds.length > 0, `${label}: a round-bar offset is created`)
  assert.equal(
    store().project.features.find((candidate) => candidate.id === offsetIds[0])?.authoringFace,
    'around',
    `${label}: the offset keeps the Around face`,
  )
  assert.equal(store().history.past.length, pastBefore + 1, `${label}: the offset is one undo step`)
  store().undo()
  assert.equal(store().project.features.length, 2, `${label}: undo removes the offset`)

  store().selectFeatures(['a', 'b'])
  pastBefore = store().history.past.length
  const joinIds = store().mergeSelectedFeatures(true)
  assert.ok(joinIds.length > 0, `${label}: a round-bar join is created`)
  assert.equal(store().history.past.length, pastBefore + 1, `${label}: the join is one undo step`)
  store().undo()
  assert.equal(store().project.features.length, 2, `${label}: undo removes the join`)

  pastBefore = store().history.past.length
  const gearIds = store().addGearFeature('Gear', { x: 30, y: 20 }, 8, gearParams(0), 2)
  assert.equal(gearIds.length, 1, `${label}: a round-bar gear without a bore is created`)
  assert.equal(store().history.past.length, pastBefore + 1, `${label}: the gear is one undo step`)
  store().undo()
  assert.equal(store().project.features.length, 2, `${label}: undo removes the gear`)

  pastBefore = store().history.past.length
  const groupedIds = store().addGearFeature('Gear', { x: 30, y: 20 }, 8, gearParams(2), 2)
  assert.equal(groupedIds.length, 2, `${label}: a round-bar gear with a bore is created as a group`)
  const grouped = store().project.features.find((candidate) => candidate.id === groupedIds[0])
  assert.ok(grouped && grouped.folderId !== null, `${label}: the grouped gear lands in a folder`)
  assert.equal(store().history.past.length, pastBefore + 1, `${label}: the grouped gear is one undo step`)
  store().undo()
  assert.equal(store().project.features.length, 2, `${label}: undo removes the grouped gear`)
}

// Square Top: ordinary Top authoring stays available on the square blank.
store().loadProject(projectWithFeatures(squareProject(SPECS[0]), []))
assert.equal(activeFace(store().project), 'top', 'the square blank starts on Top')
pastBefore = store().history.past.length
store().addFeature(rectFeature('top-a', 20, 'top'))
store().addFeature(rectFeature('top-b', 25, 'top'))
assert.equal(store().project.features.length, 2, 'ordinary Top features are authored on the square blank')
assert.equal(store().history.past.length, pastBefore + 2, 'each in its own undo step')

store().selectFeatures(['top-a', 'top-b'])
pastBefore = store().history.past.length
const topOffsetIds = store().offsetSelectedFeatures(1)
assert.ok(topOffsetIds.length > 0, 'a Top-anchored offset succeeds on the square blank')
assert.equal(
  store().project.features.find((candidate) => candidate.id === topOffsetIds[0])?.authoringFace,
  'top',
  'and lands on Top',
)
assert.equal(store().history.past.length, pastBefore + 1, 'with exactly one undo step')

pastBefore = store().history.past.length
const topGearIds = store().addGearFeature('Gear', { x: 60, y: 20 }, 8, gearParams(2), 2)
assert.equal(topGearIds.length, 2, 'a Top gear with a bore succeeds on the square blank')
assert.equal(store().history.past.length, pastBefore + 1, 'with exactly one undo step')

log('squareAroundPolicy: all assertions passed.')
