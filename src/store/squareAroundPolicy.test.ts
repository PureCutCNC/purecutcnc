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
 * - judging a text run by the creation target instead of the sheet rule
 *   (`refusesSquareAroundText` in `pendingAddSlice.ts`, rt2-c review finding 1)
 *   → the text arming and stale-completion refusals fail under the region and
 *   construction targets, and the round-bar control still passes;
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
 *   feature's own face → the "Around sources under Top" refusals fail;
 * - removing the copy guard in `completePendingMove` / the rotate·mirror
 *   `keepOriginals` branches (issue #1016 C2-U1G) → the move-copy and
 *   transform-copy refusals fail (the manager's copy bypass probe exits 1);
 * - removing the resulting-row face checks in `expandTextFeature`,
 *   `completeFeatureDistribution` and `applyNest` (issue #1016 C2-U1G) → the
 *   text, distribution and nest refusals fail;
 * - substituting the nest input's part ids — or the selected rows — for the
 *   actual copied rows in `applyNest` (issue #1016 C2-U1I) → the asymmetric
 *   mixed-face nests fail: the Top-copy nest is wrongly refused (input ids),
 *   and the unselected Around copy is wrongly admitted (selection ids);
 * - judging any of those copy guards by `activeFace` instead of the created
 *   row's own face → the "under Top" copy refusals fail;
 * - removing the split guard in `applyProfileBreak` (issue #1016 C2-U1H) → the
 *   square Around segment-delete and point-disconnect refusals fail;
 * - judging that split guard by `activeFace` instead of the source row's own
 *   face → the "split under Top" refusals fail.
 *
 * Run with: npx tsx src/store/squareAroundPolicy.test.ts
 */

import assert from 'node:assert/strict'
import { DEFAULT_SETUP_ID, defaultTool, newProject, rectProfile, roundStock } from '../types/project'
import { isSquareStock, squareStock } from '../types/barStock'
import type { Project, SketchFeature, Stock, Tool } from '../types/project'
import { defaultGearCreationParams } from '../sketch/gearProfile'
import { projectWithFeatures, resolvedFeature } from '../test/projectFixtures'
import { applyNestToProject } from './helpers/nestApply'
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
import { defaultTextToolConfig } from '../text'

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

/** A skeleton text run, the source `expandTextFeature` explodes into glyph rows. */
function textFeature(id: string, authoringFace: 'top' | 'around'): SketchFeature {
  return {
    id,
    name: id,
    kind: 'text',
    folderId: null,
    text: { text: 'AB', style: 'skeleton', fontId: 'simple_stroke', size: 10 },
    sketch: {
      profile: rectProfile(0, 0, 10, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    authoringFace,
    z_top: 40,
    z_bottom: authoringFace === 'around' ? 35 : 0,
    visible: true,
    locked: false,
  }
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

// ── 1. A square blank creates a canned Turn model ─────────────

log('Testing the square Turn model and one undo, both axes and units...')

for (const spec of SPECS) {
  const label = `${spec.axis}/${spec.units}`
  store().loadProject(projectWithFeatures(squareProject(spec), []))
  assert.ok(isSquareStock(store().project.stock), `${label}: the fixture is a square blank`)
  assert.equal(aroundUnavailableReason(store().project), null, `${label}: the Around face is workflow-available`)
  assert.equal(aroundSketchAuthoringAvailable(store().project), false, `${label}: but its sheet stays round-only`)
  assert.equal(switchWorkspaceFace('around'), true, `${label}: the workspace enters Around`)
  assert.equal(activeSetup(store().project).id, provisionalSetupId('around'), `${label}: on the provisional setup`)

  const stockBefore = structuredClone(store().project.stock)
  const start = spec.length * 0.1
  const length = spec.length * 0.3
  const pastBefore = store().history.past.length

  // The dialog's numbers are measured from the chuck end; creation is one
  // canned model and no operation (issue #1112 G).
  const result = store().addRotarySolid({
    kind: 'turn',
    diameter: spec.side * 0.6,
    start,
    length,
  })
  assert.ok(result.ok, `${label}: the canned Turn model is created (${result.ok ? '' : result.reason})`)
  if (!result.ok) throw new Error('unreachable')

  const after = store().project
  assert.deepEqual(after.stock, stockBefore, `${label}: the square blank is byte-identical`)
  assert.equal(after.features.length, 1, `${label}: exactly one model row`)
  assert.equal(after.operations.length, 0, `${label}: creation adds no operation`)
  assert.equal(after.featureFolders.length, 0, `${label}: and no folder`)
  assert.equal(after.featureDefinitions[after.features[0].definitionId].canned?.kind, 'turn', `${label}: the parameters are stored`)
  assert.equal(store().history.past.length, pastBefore + 1, `${label}: exactly one history step`)

  store().undo()
  const undone = store().project
  assert.equal(undone.features.length, 0, `${label}: one undo removes the model`)
  assert.equal(undone.operations.length, 0, `${label}: and no operation exists`)
  assert.deepEqual(undone.stock, stockBefore, `${label}: the blank never changed`)
  assert.equal(activeFace(undone), 'around', `${label}: the workspace stays on Around`)

  store().redo()
  assert.equal(store().project.features.length, 1, `${label}: redo restores the model`)
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

// A text run keeps the sheet rule itself, not the creation target's exemption
// (rt2-c review finding 1): `createTextFeatureAt` stamps the run's own
// `add`/`subtract` operation on it however it was armed, and `placePendingTextAt`
// writes its row directly instead of through `addFeature`, so a region or
// construction target must not arm a cutting run on the square sheet.
assert.equal(activeFace(store().project), 'around', 'the square blank is still on the Around sheet')
for (const target of ['feature', 'line', 'region', 'construction'] as const) {
  store().setCreationTarget(target)
  const beforeText = snapshot()
  store().startAddTextPlacement(defaultTextToolConfig('mm'))
  assert.equal(store().pendingAdd, null, `arming text under the ${target} target is refused on the square Around sheet`)
  assertUntouched(beforeText, `${target} text arming`)
}

// The same run armed on a round bar is refused when it completes after the blank
// became square — under every target, including the two that never cut.
for (const target of ['feature', 'line', 'region', 'construction'] as const) {
  store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [feature('top-rect', 'top')]))
  assert.equal(switchWorkspaceFace('around'), true, `${target}: the round bar enters Around`)
  store().setCreationTarget(target)
  store().startAddTextPlacement(defaultTextToolConfig('mm'))
  assert.ok(store().pendingAdd, `${target}: the round bar arms the text tool`)
  store().setStockShape('square')
  assert.ok(isSquareStock(store().project.stock), `${target}: the blank is now square`)
  assert.equal(activeFace(store().project), 'around', `${target}: the workspace stays on the Around sheet`)
  const beforeTextCompletion = snapshot()
  assert.deepEqual(store().placePendingTextAt({ x: 20, y: 10 }), [], `${target}: the run creates no row on the square sheet`)
  assertUntouched(beforeTextCompletion, `${target} stale text completion`)
}

// Control: on a round bar the same target is not a refusal, so the assertions
// above are about the square sheet and not about text under a region target.
{
  store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [feature('top-rect', 'top')]))
  assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the text control')
  store().setCreationTarget('region')
  store().startAddTextPlacement(defaultTextToolConfig('mm'))
  const [textId] = store().placePendingTextAt({ x: 20, y: 10 })
  assert.ok(textId, 'the round bar authors a text run under the region target')
  const textInstance = store().project.features.find((entry) => entry.id === textId)
  assert.ok(textInstance, 'the run is a stored row')
  assert.equal(textInstance.authoringFace, 'around', 'authored on the Around face')
  assert.notEqual(
    resolvedFeature(store().project, textId).operation,
    'region',
    'and its own operation cuts, which is why the target is no exemption',
  )
}

// `loadProject` keeps the creation target, and the gear assertions below read
// it, so leave it where the rest of this file expects to find it.
store().setCreationTarget('feature')

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
    pendingFeatureDistribution: state.pendingFeatureDistribution,
    pendingNest: state.pendingNest,
    nestSearching: state.nestSearching,
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
  assert.equal(state.pendingFeatureDistribution, before.pendingFeatureDistribution, `${label}: pending distribution unchanged`)
  assert.equal(state.pendingNest, before.pendingNest, `${label}: pending nest unchanged`)
  assert.equal(state.nestSearching, before.nestSearching, `${label}: nest searching unchanged`)
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
  // A gear is one canned feature with its bore as a hole (issue #1112 E), not a
  // gear + bore group.
  assert.equal(groupedIds.length, 1, `${label}: a round-bar gear with a bore is one canned feature`)
  const grouped = store().project.features.find((candidate) => candidate.id === groupedIds[0])
  assert.ok(grouped, `${label}: the gear row exists`)
  assert.equal(grouped.folderId, null, `${label}: the gear is not put in a folder`)
  assert.equal(
    store().project.featureDefinitions[grouped.definitionId]?.canned?.kind,
    'gear',
    `${label}: the gear keeps its parameters`,
  )
  assert.equal(store().history.past.length, pastBefore + 1, `${label}: the gear with a bore is one undo step`)
  store().undo()
  assert.equal(store().project.features.length, 2, `${label}: undo removes the gear`)
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
assert.equal(topGearIds.length, 1, 'a Top gear with a bore succeeds on the square blank as one canned feature')
assert.equal(store().history.past.length, pastBefore + 1, 'with exactly one undo step')

// ── 6. The remaining copy creation boundaries (U1G) ────────────
//
// `completePendingMove` in copy mode, `completePendingTransform` with
// `keepOriginals`, `expandTextFeature`, `completeFeatureDistribution` and
// `applyNest` all build rows that inherit their source's authoring face and
// insert them without passing through `addFeature`. Each is a square-blank
// Around creation boundary: the copy is refused atomically, judged by the rows
// about to be created rather than the workspace face, while ordinary in-place
// editing, Top/STL copying, move-only nests and round-bar authoring stay
// allowed (issue #1016 C2-U1G).

log('Testing the remaining copy creation boundaries on a square blank...')

function armCopyMove(...ids: string[]): void {
  store().selectFeatures(ids)
  store().startCopyFeature(ids[0])
  store().setPendingMoveFrom({ x: 0, y: 0 })
}

function groupedAroundProject(spec: Spec): Project {
  const base = roundProject(spec)
  base.featureFolders.push({ id: 'gf', name: 'Pair', collapsed: false, section: 'features', grouped: true })
  return projectWithFeatures(base, [
    { ...rectFeature('a', 20, 'around'), folderId: 'gf' },
    { ...rectFeature('b', 25, 'around'), folderId: 'gf' },
  ])
}

// 6a. completePendingMove, feature copy: reference and independent copy modes,
// a whole grouped-folder copy, both axes and both units, plus a request armed
// directly on the square blank's Around sheet.
for (const spec of SPECS) {
  const label = `move-copy ${spec.axis}/${spec.units}`
  store().loadProject(projectWithFeatures(roundProject(spec), [rectFeature('a', 20, 'around')]))
  assert.equal(switchWorkspaceFace('around'), true, `${label}: the round bar enters Around`)
  armCopyMove('a')
  store().setStockShape('square')
  assert.ok(isSquareStock(store().project.stock), `${label}: the blank is now square`)
  before = fullSnapshot()
  store().completePendingMove({ x: 10, y: 0 })
  assertRefused(before, label)
  store().cancelPendingMove()
}

store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [rectFeature('a', 20, 'around')]))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the independent copy')
store().selectFeatures(['a'])
store().startCopyFeature('a', 'independent')
store().setPendingMoveFrom({ x: 0, y: 0 })
store().setStockShape('square')
before = fullSnapshot()
store().completePendingMove({ x: 10, y: 0 })
assertRefused(before, 'independent move-copy')
store().cancelPendingMove()

store().loadProject(groupedAroundProject(SPECS[0]))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the grouped copy')
armCopyMove('a', 'b')
store().setStockShape('square')
before = fullSnapshot()
store().completePendingMove({ x: 10, y: 0 })
assertRefused(before, 'grouped-folder move-copy')
store().cancelPendingMove()

// A request armed on the square blank itself (not stale from the round bar) is
// refused the same way.
store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [rectFeature('a', 20, 'around')]))
assert.equal(switchWorkspaceFace('around'), true, 'the square blank enters Around')
armCopyMove('a')
before = fullSnapshot()
store().completePendingMove({ x: 10, y: 0 })
assertRefused(before, 'live square move-copy')

// 6b. completePendingTransform with keepOriginals: rotate and mirror copies,
// multi-copy rotate and the grouped-folder copy, judged after the workspace
// moves to Top as well.
for (const mode of ['rotate', 'mirror'] as const) {
  for (const spec of SPECS) {
    const label = `${mode}-copy ${spec.axis}/${spec.units}`
    store().loadProject(projectWithFeatures(roundProject(spec), [rectFeature('a', 20, 'around')]))
    assert.equal(switchWorkspaceFace('around'), true, `${label}: the round bar enters Around`)
    store().selectFeatures(['a'])
    if (mode === 'rotate') store().startRotateFeature('a')
    else store().startMirrorFeature('a')
    store().setPendingTransformReferenceStart({ x: 0, y: 0 })
    store().setPendingTransformReferenceEnd({ x: 10, y: 0 })
    store().setPendingTransformKeepOriginals(true)
    store().setStockShape('square')
    before = fullSnapshot()
    if (mode === 'rotate') store().completePendingTransform({ x: 0, y: 10 }, 2)
    else store().completePendingTransform({ x: 0, y: 10 })
    assertRefused(before, label)
  }
}

store().loadProject(groupedAroundProject(SPECS[0]))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the grouped rotate copy')
store().selectFeatures(['a', 'b'])
store().startRotateFeature('a')
store().setPendingTransformReferenceStart({ x: 0, y: 0 })
store().setPendingTransformReferenceEnd({ x: 10, y: 0 })
store().setPendingTransformKeepOriginals(true)
store().setStockShape('square')
before = fullSnapshot()
store().completePendingTransform({ x: 0, y: 10 })
assertRefused(before, 'grouped rotate-copy')

store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [rectFeature('a', 20, 'around')]))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the Top-workspace copy')
store().selectFeatures(['a'])
store().startRotateFeature('a')
store().setPendingTransformReferenceStart({ x: 0, y: 0 })
store().setPendingTransformReferenceEnd({ x: 10, y: 0 })
store().setPendingTransformKeepOriginals(true)
store().setStockShape('square')
store().setActiveSetup(DEFAULT_SETUP_ID)
assert.equal(activeFace(store().project), 'top', 'the workspace is now Top')
before = fullSnapshot()
store().completePendingTransform({ x: 0, y: 10 })
assertRefused(before, 'rotate-copy under Top')

// 6c. expandTextFeature: the glyph rows copy the text row's authoring face, so
// the expansion is refused before folders, definitions, rows, selection or
// history are written — including while the workspace is Top.
store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [textFeature('text-1', 'around')]))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the text run')
store().setStockShape('square')
before = fullSnapshot()
store().expandTextFeature('text-1')
assertRefused(before, 'Around text expansion')

store().setActiveSetup(DEFAULT_SETUP_ID)
assert.equal(activeFace(store().project), 'top', 'the workspace is Top for the text run too')
before = fullSnapshot()
store().expandTextFeature('text-1')
assertRefused(before, 'Around text expansion under Top')

// 6d. completeFeatureDistribution: every mode and both copy modes, refused
// before the source placement moves, the pending request clears, or the
// history/selection write. The guide row is an ordinary Around sibling.
function configureDistribution(mode: 'grid' | 'radial' | 'path'): void {
  if (mode === 'grid') {
    store().updateFeatureDistribution({ mode: 'grid', rows: 1, columns: 3, spacingX: 20, spacingY: 0, startScale: 100, endScale: 60 })
    return
  }
  if (mode === 'radial') {
    store().updateFeatureDistribution({ mode: 'radial', center: { x: 60, y: 20 }, copyCount: 3, sweepDegrees: 360, orientation: 'follow', startScale: 100, endScale: 80 })
    store().setFeatureDistributionPickTarget('radial-center')
    store().setFeatureDistributionRadialCenter({ x: 60, y: 20 })
    return
  }
  store().updateFeatureDistribution({ mode: 'path', copyCount: 3, startOffset: 0, endOffset: 0, orientation: 'follow', startScale: 100, endScale: 100 })
  store().setFeatureDistributionGuide('g')
}

function distributionFixture(spec: Spec, copyMode: 'reference' | 'independent'): Project {
  const base = roundProject(spec)
  base.meta = { ...base.meta, copyMode }
  return projectWithFeatures(base, [
    rectFeature('a', 20, 'around'),
    rectFeature('g', 40, 'around'),
  ])
}

for (const copyMode of ['reference', 'independent'] as const) {
  const specs = copyMode === 'reference' ? SPECS : [SPECS[0], SPECS[3]]
  for (const mode of ['grid', 'radial', 'path'] as const) {
    for (const spec of specs) {
      const label = `${copyMode} ${mode} distribution ${spec.axis}/${spec.units}`
      store().loadProject(distributionFixture(spec, copyMode))
      assert.equal(switchWorkspaceFace('around'), true, `${label}: the round bar enters Around`)
      store().selectFeatures(['a'])
      store().startFeatureDistribution(mode)
      configureDistribution(mode)
      store().setStockShape('square')
      before = fullSnapshot()
      const refusedIds = store().completeFeatureDistribution()
      assert.deepEqual(refusedIds, [], `${label}: the distribution is refused`)
      assertRefused(before, label)
      store().cancelFeatureDistribution()
    }
  }
}

// 6e. applyNest: the whole result is rejected when any actual copied row would
// be Around-authored, including a contained member that was never selected.
function nestPlacement(copyIndex: number, x: number) {
  return { partId: '0', copyIndex, rotation: 0, translation: { x, y: 0 } }
}

store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [
  rectFeature('a', 20, 'around'),
  rectFeature('b', 25, 'around'),
]))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the nest')
store().selectFeatures(['a'])
store().startNest()
store().setStockShape('square')
before = fullSnapshot()
const containedNestId = store().applyNest({
  parts: [{ featureIds: ['a', 'b'], quantity: 2 }],
  placements: [nestPlacement(0, 0), nestPlacement(1, 60)],
  settings: { rotations: [0], minimumGap: 2, keepOriginals: false },
})
assert.equal(containedNestId, null, 'the nest with an Around copy is rejected entirely')
assertRefused(before, 'contained Around nest')
store().cancelNest()

// 6f. The guard must judge the rows the nest actually copies, not the ids its
// input carries or the rows that happen to be selected (issue #1016 C2-U1I).
// A nest input names every part's sources explicitly, so a moved Around source
// appears there even though no Around row is created; and a Top-only selection
// can still receive an Around copy from a part the user never selected. The
// fixtures are asymmetric — one part moves, the other copies — so neither the
// input ids nor the selection can stand in for `result.copyIds`.
function nestPlacementFor(partId: string, copyIndex: number, x: number) {
  return { partId, copyIndex, rotation: 0, translation: { x, y: 0 } }
}

/** A square blank carrying a retained Around row and a Top row. */
function asymmetricSquareProject(spec: Spec): Project {
  return projectWithFeatures(roundProject(spec), [
    rectFeature('around-src', 20, 'around'),
    rectFeature('top-src', 60, 'top'),
  ])
}

const ASYMMETRIC_SPECS = [SPECS[0], SPECS[3]]

log('Testing the asymmetric mixed-face nest copies...')

/** Load the mixed-face blank and prove the Around row survived the conversion. */
function loadAsymmetric(spec: Spec, label: string): void {
  store().loadProject(asymmetricSquareProject(spec))
  store().setStockShape('square')
  assert.ok(isSquareStock(store().project.stock), `${label}: the blank is square`)
  assert.equal(
    store().project.features.filter((row) => row.authoringFace === 'around').length,
    1,
    `${label}: the Around source is retained`,
  )
}

for (const spec of ASYMMETRIC_SPECS) {
  const label = `asymmetric Top-copy nest ${spec.axis}/${spec.units}`
  loadAsymmetric(spec, label)
  store().selectFeatures(['top-src'])
  store().startNest()
  assert.deepEqual(store().selection.selectedFeatureIds, ['top-src'], `${label}: only the Top row is selected`)
  assert.deepEqual(store().pendingNest?.sourceIds, ['top-src'], `${label}: the nest is armed on that selection`)

  const projectBefore = structuredClone(store().project)
  const pastBeforeNest = store().history.past.length
  // Part 0 (Around) moves in place through its copyIndex 0, creating no row.
  // Part 1 (Top) moves through its copyIndex 0 and is copied at copyIndex 1, so
  // the only actual copy is a Top row. The part ids are distinct on purpose.
  const nested = store().applyNest({
    parts: [
      { featureIds: ['around-src'], quantity: 1 },
      { featureIds: ['top-src'], quantity: 2 },
    ],
    placements: [
      nestPlacementFor('0', 0, 100),
      nestPlacementFor('1', 0, 0),
      nestPlacementFor('1', 1, 150),
    ],
    settings: { rotations: [0], minimumGap: 2, keepOriginals: false },
  })
  assert.ok(nested, `${label}: the nest whose only copy is Top is applied`)
  assert.equal(store().history.past.length, pastBeforeNest + 1, `${label}: it is one undo step`)

  const applied = store().project
  assert.equal(applied.features.length, 3, `${label}: two sources plus exactly one copy`)
  assert.equal(
    applied.features.filter((row) => row.authoringFace === 'around').length,
    1,
    `${label}: the Around source only moved, no Around row was created`,
  )
  const record = applied.nests?.[0] ?? null
  assert.ok(record, `${label}: the nest is recorded`)
  assert.equal(record.copyIds.length, 1, `${label}: exactly one row is copied`)
  const copy = applied.features.find((row) => row.id === record.copyIds[0])
  assert.ok(copy, `${label}: the copy exists`)
  assert.equal(copy.authoringFace, 'top', `${label}: the copied row is the Top source's`)
  assert.deepEqual(copy.transform, { a: 1, b: 0, c: 0, d: 1, e: 150, f: 0 }, `${label}: the copy sits at its own part's placement`)
  assert.deepEqual(
    record.movedOriginals.map((entry) => entry.featureId).sort(),
    ['around-src', 'top-src'],
    `${label}: both sources moved in place, neither became a copy`,
  )
  assert.deepEqual(
    applied.features.find((row) => row.id === 'around-src')?.transform,
    { a: 1, b: 0, c: 0, d: 1, e: 100, f: 0 },
    `${label}: the Around part moved by its copyIndex 0 placement`,
  )
  assert.deepEqual(
    applied.features.find((row) => row.id === 'top-src')?.transform,
    { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    `${label}: the Top part moved by its copyIndex 0 placement`,
  )

  const appliedState = structuredClone(applied)
  store().undo()
  assert.deepEqual(store().project, projectBefore, `${label}: one undo restores the whole project and both source transforms`)
  assert.equal(store().project.nests?.length ?? 0, 0, `${label}: undo drops the nest record`)
  store().redo()
  assert.deepEqual(store().project, appliedState, `${label}: redo restores both source transforms and the Top copy`)
}

for (const spec of ASYMMETRIC_SPECS) {
  const label = `asymmetric Around-copy nest ${spec.axis}/${spec.units}`
  loadAsymmetric(spec, label)
  store().selectFeatures(['top-src'])
  store().startNest()
  assert.deepEqual(store().selection.selectedFeatureIds, ['top-src'], `${label}: only the Top row is selected`)
  assert.deepEqual(store().pendingNest?.sourceIds, ['top-src'], `${label}: the nest is armed on that selection`)

  // Part 0 (Top) moves in place; part 1 (Around) moves and is copied, so the
  // one actual copy is an Around row the selection never names.
  const input = {
    parts: [
      { featureIds: ['top-src'], quantity: 1 },
      { featureIds: ['around-src'], quantity: 2 },
    ],
    placements: [
      nestPlacementFor('0', 0, 0),
      nestPlacementFor('1', 0, 0),
      nestPlacementFor('1', 1, 150),
    ],
    settings: { rotations: [0], minimumGap: 2, keepOriginals: false },
  }

  // The pure helper proves the input is realizable: both explicit parts resolve
  // and it would create exactly the unselected Around copy — so a `null` from
  // the store is the guard's refusal, not an early missing-part rejection.
  const preview = applyNestToProject(store().project, input)
  assert.ok(preview, `${label}: the input resolves both parts`)
  assert.equal(preview.copyIds.length, 1, `${label}: it would create exactly one copy`)
  const previewCopy = preview.project.features.find((row) => row.id === preview.copyIds[0])
  assert.ok(previewCopy, `${label}: the preview copy exists`)
  assert.equal(previewCopy.authoringFace, 'around', `${label}: and it is the unselected Around row`)

  const projectBefore = structuredClone(store().project)
  before = fullSnapshot()
  const refused = store().applyNest(input)
  assert.equal(refused, null, `${label}: the whole nest is refused for its unselected Around copy`)
  assertRefused(before, label)
  assert.equal(store().project.features.length, 2, `${label}: the Top source did not move and no copy appeared`)
  assert.equal(store().project.featureFolders.length, projectBefore.featureFolders.length, `${label}: no nest folder was added`)
  assert.equal(store().project.nests?.length ?? 0, 0, `${label}: no partial nest record`)
  assert.deepEqual(store().selection.selectedFeatureIds, ['top-src'], `${label}: the Top selection is untouched`)
  assert.deepEqual(store().pendingNest?.sourceIds, ['top-src'], `${label}: the armed nest is still pending`)
}

// ── 7. The copy boundaries' allowed controls ──────────────────

log('Testing the allowed in-place edits, Top/STL copies, distributions and nests...')

// In-place move/rotate/mirror/resize of an existing Around row on a square
// blank creates no row and stays allowed, each with one undo step.
store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [rectFeature('a', 20, 'around')]))
assert.equal(switchWorkspaceFace('around'), true, 'the square blank enters Around for in-place edits')
store().selectFeatures(['a'])

pastBefore = store().history.past.length
store().startMoveFeature('a')
store().setPendingMoveFrom({ x: 0, y: 0 })
store().completePendingMove({ x: 5, y: 0 })
assert.equal(store().project.features.length, 1, 'an in-place move adds no row')
assert.equal(store().history.past.length, pastBefore + 1, 'an in-place move is one undo step')
store().undo()

store().selectFeatures(['a'])
pastBefore = store().history.past.length
store().startRotateFeature('a')
store().setPendingTransformReferenceStart({ x: 0, y: 0 })
store().setPendingTransformReferenceEnd({ x: 10, y: 0 })
store().completePendingTransform({ x: 0, y: 10 })
assert.equal(store().project.features.length, 1, 'an in-place rotate adds no row')
assert.equal(store().history.past.length, pastBefore + 1, 'an in-place rotate is one undo step')
store().undo()

store().selectFeatures(['a'])
pastBefore = store().history.past.length
store().startMirrorFeature('a')
store().setPendingTransformReferenceStart({ x: 0, y: 0 })
store().setPendingTransformReferenceEnd({ x: 10, y: 0 })
store().completePendingTransform({ x: 0, y: 10 })
assert.equal(store().project.features.length, 1, 'an in-place mirror adds no row')
assert.equal(store().history.past.length, pastBefore + 1, 'an in-place mirror is one undo step')
store().undo()

store().selectFeatures(['a'])
pastBefore = store().history.past.length
store().startResizeFeature('a')
store().setPendingTransformReferenceStart({ x: 0, y: 0 })
store().setPendingTransformReferenceEnd({ x: 10, y: 0 })
store().completePendingTransform({ x: 20, y: 10 })
assert.equal(store().project.features.length, 1, 'an in-place resize adds no row')
assert.equal(store().history.past.length, pastBefore + 1, 'an in-place resize is one undo step')
store().undo()

// Round-bar Around copies still work, and the copy keeps the Around face.
store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [rectFeature('a', 20, 'around')]))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the allowed copy')
armCopyMove('a')
pastBefore = store().history.past.length
store().completePendingMove({ x: 10, y: 0 })
assert.equal(store().project.features.length, 2, 'a round-bar Around copy is created')
assert.equal(
  store().project.features.find((candidate) => candidate.id !== 'a')?.authoringFace,
  'around',
  'and keeps the Around face',
)
assert.equal(store().history.past.length, pastBefore + 1, 'the round-bar copy is one undo step')
store().undo()
assert.equal(store().project.features.length, 1, 'undo removes the round-bar copy')

// Square Top copying, including a model/STL row, stays allowed.
function stlFeature(id: string, authoringFace: 'top' | 'around'): SketchFeature {
  return { ...feature(id, authoringFace), kind: 'stl' }
}

store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [
  rectFeature('top-a', 20, 'top'),
  stlFeature('stl-a', 'top'),
]))
assert.equal(activeFace(store().project), 'top', 'the square blank starts on Top')
armCopyMove('top-a')
pastBefore = store().history.past.length
store().completePendingMove({ x: 10, y: 0 })
assert.equal(store().project.features.length, 3, 'a Top copy is created on the square blank')
assert.equal(store().history.past.length, pastBefore + 1, 'the Top copy is one undo step')

armCopyMove('stl-a')
pastBefore = store().history.past.length
store().completePendingMove({ x: 10, y: 0 })
assert.equal(store().project.features.length, 4, 'a model/STL copy is created on the square blank')
assert.equal(
  store().project.features.filter((candidate) => candidate.authoringFace === 'top').length,
  4,
  'every row stays on Top',
)
assert.equal(store().history.past.length, pastBefore + 1, 'the model/STL copy is one undo step')

// Round-bar Around text expansion and square-blank Top text expansion still work.
store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [textFeature('text-1', 'around')]))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the text expansion')
store().setActiveSetup(DEFAULT_SETUP_ID)
const textRowsBefore = store().project.features.length
pastBefore = store().history.past.length
store().expandTextFeature('text-1')
assert.ok(store().project.features.length > textRowsBefore, 'round-bar Around text expands')
assert.equal(store().history.past.length, pastBefore + 1, 'the text expansion is one undo step')

store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [textFeature('text-1', 'top')]))
const topTextRowsBefore = store().project.features.length
pastBefore = store().history.past.length
store().expandTextFeature('text-1')
assert.ok(store().project.features.length > topTextRowsBefore, 'square-blank Top text expands')
assert.equal(store().history.past.length, pastBefore + 1, 'the Top text expansion is one undo step')

// Round-bar Around distribution and square-blank Top distribution still commit.
store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [rectFeature('a', 20, 'around')]))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the distribution')
store().selectFeatures(['a'])
store().startFeatureDistribution('grid')
store().updateFeatureDistribution({ mode: 'grid', rows: 1, columns: 2, spacingX: 20, spacingY: 0, startScale: 100, endScale: 100 })
pastBefore = store().history.past.length
const roundDistributionIds = store().completeFeatureDistribution()
assert.ok(roundDistributionIds.length > 0, 'a round-bar Around distribution is created')
assert.equal(store().history.past.length, pastBefore + 1, 'the round-bar distribution is one undo step')
store().undo()

store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [rectFeature('top-a', 20, 'top')]))
store().selectFeatures(['top-a'])
store().startFeatureDistribution('grid')
store().updateFeatureDistribution({ mode: 'grid', rows: 1, columns: 2, spacingX: 20, spacingY: 0, startScale: 100, endScale: 100 })
pastBefore = store().history.past.length
const topDistributionIds = store().completeFeatureDistribution()
assert.ok(topDistributionIds.length > 0, 'a square-blank Top distribution is created')
assert.equal(store().history.past.length, pastBefore + 1, 'the Top distribution is one undo step')

// A move-only nest (no copied row) stays allowed on a square blank's Around
// sheet, and a nest that copies Top rows stays allowed too.
store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [rectFeature('a', 20, 'around')]))
assert.equal(switchWorkspaceFace('around'), true, 'the square blank enters Around for the move-only nest')
store().selectFeatures(['a'])
store().startNest()
pastBefore = store().history.past.length
const moveOnlyNestId = store().applyNest({
  parts: [{ featureIds: ['a'], quantity: 1 }],
  placements: [nestPlacement(0, 50)],
  settings: { rotations: [0], minimumGap: 2, keepOriginals: false },
})
assert.ok(moveOnlyNestId, 'a move-only nest is applied')
assert.equal(store().project.features.length, 1, 'a move-only nest adds no row')
assert.equal(store().history.past.length, pastBefore + 1, 'a move-only nest is one undo step')
store().undo()

store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [rectFeature('top-a', 20, 'top')]))
store().selectFeatures(['top-a'])
store().startNest()
pastBefore = store().history.past.length
const topNestId = store().applyNest({
  parts: [{ featureIds: ['top-a'], quantity: 2 }],
  placements: [nestPlacement(0, 0), nestPlacement(1, 60)],
  settings: { rotations: [0], minimumGap: 2, keepOriginals: true },
})
assert.ok(topNestId, 'a Top nest is applied on the square blank')
assert.equal(store().project.features.length, 3, 'the Top nest adds both kept-original copies')
assert.equal(store().history.past.length, pastBefore + 1, 'the Top nest is one undo step')

// A round-bar Around nest still copies.
store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [rectFeature('a', 20, 'around')]))
assert.equal(switchWorkspaceFace('around'), true, 'the round bar enters Around for the nest copy')
store().selectFeatures(['a'])
store().startNest()
pastBefore = store().history.past.length
const roundNestId = store().applyNest({
  parts: [{ featureIds: ['a'], quantity: 2 }],
  placements: [nestPlacement(0, 0), nestPlacement(1, 60)],
  settings: { rotations: [0], minimumGap: 2, keepOriginals: true },
})
assert.ok(roundNestId, 'a round-bar Around nest is applied')
assert.equal(store().project.features.length, 3, 'the round-bar nest adds both kept-original Around copies')
assert.equal(store().history.past.length, pastBefore + 1, 'the round-bar nest is one undo step')

// ── 8. The atomic Around split boundary (U1H) ─────────────────
//
// `applyProfileBreak` sits behind `deleteFeatureSegment` and
// `disconnectFeaturePoint`. It resolves the break into the edited profile plus
// an optional split half, and a split inserts a derived row that inherits the
// source's authoring face without passing through `addFeature`. On a square
// blank that new row would be an Around row, so the whole edit is refused
// before `createDerivedFeature` — judged by the source row's own face, so a
// Top workspace cannot bypass it. A break that stays in place (a closed
// outline opened, an end segment removed) creates no row and remains allowed
// (issue #1016 C2-U1H).

log('Testing the atomic split refusal on a square blank Around sheet...')

/** An open polyline whose interior break would split it into two rows. */
function openFaceFeature(id: string, authoringFace: 'top' | 'around'): SketchFeature {
  const base = feature(id, authoringFace)
  return {
    ...base,
    kind: 'polygon',
    operation: 'add',
    sketch: {
      ...base.sketch,
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 10, y: 0 } },
          { type: 'line', to: { x: 20, y: 0 } },
          { type: 'line', to: { x: 30, y: 0 } },
        ],
        closed: false,
      },
    },
  }
}

/** The interior break of `openFaceFeature` through each of the two entrypoints. */
function breakFeature(id: string, entry: 'delete' | 'disconnect'): void {
  if (entry === 'delete') store().deleteFeatureSegment(id, 1)
  else store().disconnectFeaturePoint(id, 1)
}

// Both entrypoints, both axes and both units: a split started on a round bar
// and completed after the blank became square is refused whole — the original
// profile, definitions, tree, folders, operations, selection, all pending
// requests, full history and dirtiness keep their identity.
for (const spec of SPECS) {
  for (const entry of ['delete', 'disconnect'] as const) {
    const label = `${entry} split ${spec.axis}/${spec.units}`
    store().loadProject(projectWithFeatures(roundProject(spec), [openFaceFeature('a', 'around')]))
    assert.equal(switchWorkspaceFace('around'), true, `${label}: the round bar enters Around`)
    store().setStockShape('square')
    assert.ok(isSquareStock(store().project.stock), `${label}: the blank is now square`)
    before = fullSnapshot()
    breakFeature('a', entry)
    assertRefused(before, label)
  }
}

// A split armed directly on the square blank's Around sheet is refused the
// same way, with a pending edit request present whose identity must survive.
store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [openFaceFeature('a', 'around')]))
assert.equal(switchWorkspaceFace('around'), true, 'the square blank enters Around')
store().startMoveFeature('a')
assert.ok(store().pendingMove, 'a pending move is armed')
before = fullSnapshot()
store().deleteFeatureSegment('a', 1)
assertRefused(before, 'live square split')
store().cancelPendingMove()

// The guard reads the source row's own face, not the workspace face: the same
// Around source stays refused after `setActiveSetup` moves the workspace Top.
for (const entry of ['delete', 'disconnect'] as const) {
  const label = `${entry} split under Top`
  store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [openFaceFeature('a', 'around')]))
  assert.equal(switchWorkspaceFace('around'), true, `${label}: the round bar enters Around`)
  store().setStockShape('square')
  store().setActiveSetup(DEFAULT_SETUP_ID)
  assert.equal(activeFace(store().project), 'top', `${label}: the workspace is now Top`)
  before = fullSnapshot()
  breakFeature('a', entry)
  assertRefused(before, label)
}

// A refusal inside an open history transaction keeps `transactionStart` too.
store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [openFaceFeature('a', 'around')]))
assert.equal(switchWorkspaceFace('around'), true, 'the square blank enters Around for the transaction')
store().beginHistoryTransaction()
assert.ok(store().history.transactionStart, 'a history transaction is open')
before = fullSnapshot()
store().deleteFeatureSegment('a', 1)
assertRefused(before, 'split inside a history transaction')
store().cancelHistoryTransaction()

// And it leaves a non-empty redo future untouched as well.
store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [
  openFaceFeature('a', 'around'),
  rectFeature('b', 50, 'around'),
]))
assert.equal(switchWorkspaceFace('around'), true, 'the square blank enters Around with a redo future')
store().deleteFeatureSegment('b', 1)
store().undo()
assert.ok(store().history.future.length > 0, 'undo leaves a redo future')
before = fullSnapshot()
store().deleteFeatureSegment('a', 1)
assertRefused(before, 'split with a redo future')

log('Testing the allowed in-place breaks and the Top/Round splits...')

// Square Around: opening a closed outline is an in-place edit, so it creates no
// row and stays allowed through both entrypoints.
for (const entry of ['delete', 'disconnect'] as const) {
  const label = `${entry} open closed Around outline`
  store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [rectFeature('a', 20, 'around')]))
  assert.equal(switchWorkspaceFace('around'), true, `${label}: the square blank enters Around`)
  pastBefore = store().history.past.length
  if (entry === 'delete') store().deleteFeatureSegment('a', 1)
  else store().disconnectFeaturePoint('a', 1)
  assert.equal(store().project.features.length, 1, `${label}: opening a closed outline adds no row`)
  assert.equal(resolvedFeature(store().project, 'a').sketch.profile.closed, false, `${label}: the outline is open`)
  assert.equal(store().project.features[0]?.authoringFace, 'around', `${label}: and stays on Around`)
  assert.equal(store().history.past.length, pastBefore + 1, `${label}: it is one undo step`)
  store().undo()
  assert.equal(store().project.features.length, 1, `${label}: undo restores the single row`)
}

// Removing an end segment of an open outline also stays in place.
for (const segmentIndex of [0, 2]) {
  const label = `end segment ${segmentIndex}`
  store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [openFaceFeature('a', 'around')]))
  assert.equal(switchWorkspaceFace('around'), true, `${label}: the square blank enters Around`)
  pastBefore = store().history.past.length
  store().deleteFeatureSegment('a', segmentIndex)
  assert.equal(store().project.features.length, 1, `${label}: an end segment adds no row`)
  assert.equal(resolvedFeature(store().project, 'a').sketch.profile.segments.length, 2, `${label}: the outline shortens`)
  assert.equal(store().history.past.length, pastBefore + 1, `${label}: it is one undo step`)
  store().undo()
}

// Square Top and Round Around splits still create the derived row: two rows on
// the source face, in exactly one undo/redo step.
for (const context of ['square-top', 'round-around'] as const) {
  for (const entry of ['delete', 'disconnect'] as const) {
    const label = `${entry} ${context} split`
    const face = context === 'square-top' ? 'top' : 'around'
    if (context === 'square-top') {
      store().loadProject(projectWithFeatures(squareProject(SPECS[0]), [openFaceFeature('a', 'top')]))
      assert.equal(activeFace(store().project), 'top', `${label}: the square blank starts on Top`)
    } else {
      store().loadProject(projectWithFeatures(roundProject(SPECS[0]), [openFaceFeature('a', 'around')]))
      assert.equal(switchWorkspaceFace('around'), true, `${label}: the round bar enters Around`)
    }
    pastBefore = store().history.past.length
    breakFeature('a', entry)
    assert.equal(store().project.features.length, 2, `${label}: the split creates the second row`)
    for (const row of store().project.features) {
      assert.equal(row.authoringFace, face, `${label}: ${row.id} keeps the source face`)
    }
    assert.equal(store().history.past.length, pastBefore + 1, `${label}: the split is one undo step`)
    store().undo()
    assert.equal(store().project.features.length, 1, `${label}: one undo removes the second row`)
    store().redo()
    assert.equal(store().project.features.length, 2, `${label}: redo restores both rows`)
  }
}

log('squareAroundPolicy: all assertions passed.')
