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
 *   square blank → the round→square disabled-retained assertion fails.
 *
 * Run with: npx tsx src/store/squareAroundPolicy.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, getStockBounds, newProject, rectProfile, roundStock } from '../types/project'
import { isSquareStock, squareStock } from '../types/barStock'
import type { Project, SketchFeature, Stock, Tool } from '../types/project'
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

log('squareAroundPolicy: all assertions passed.')
