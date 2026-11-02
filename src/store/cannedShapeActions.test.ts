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
 * Resize, Rotate and Mirror of a canned rotary shape (issue #1112 rt7-f).
 *
 * Frank: "the rotate, resize, mirror should probably not be allowed in the
 * context menu (resize should point to the edit, others not allowed)". The
 * reasons are the context menu's business — it shows them, disabled
 * (`components/feature-tree/featureContextMenu.test.ts`), and the toolbar and
 * the tool rail read the same rule through the command predicates
 * (`commands/sketchCommands.test.ts`). This file pins the rule itself and the
 * one funnel every entry point goes through: the store's three start actions.
 *
 * A canned rotary shape stores its size and orientation in its parameters — a
 * Thread's Depth, a Turn's start/length/diameter — so none of the three
 * transforms can express it. A plain feature and a non-rotary canned kind (an
 * ellipse) keep today's behaviour, and a Move keeps working: it is the bar edit
 * the four kinds do have.
 *
 * Run with: npx tsx src/store/cannedShapeActions.test.ts
 *
 * Named mutations:
 * - dropping the refusal from `startResizeFeature` → the resize case starts a
 *   pending transform and its "refused" assertion fails;
 * - dropping it from `startRotateFeature`/`startMirrorFeature` → the same for
 *   those two;
 * - refusing every canned kind in `cannedShapeTransformRefusal` (instead of the
 *   four rotary ones) → the ellipse case loses its transforms;
 * - refusing every selection that merely contains a canned shape → the mixed
 *   plain+Turn case still refuses, but the plain-only case fails;
 * - keying the refusal on the primary row alone → the plain-primary + Turn
 *   case starts a transform that would only reach the Turn.
 */

import assert from 'node:assert/strict'
import {
  defaultTool,
  newProject,
  rectProfile,
  roundStock,
  type Project,
  type SketchFeature,
  type Tool,
} from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { bundledMachines } from '../machine/registry'
import { validateMachineDefinition } from '../engine/gcode/types'
import { switchWorkspaceFace } from './workspaceFace'
import { useProjectStore } from './projectStore'
import {
  cannedShapeTransformRefusal,
  hasRotaryCannedFeature,
  isRotaryCannedFeature,
  isRotaryCannedMoveSelection,
} from './helpers/cannedShapeActions'

const store = () => useProjectStore.getState()

/** A plain rectangle, the feature every selection keeps working. */
function plainRow(id: string, overrides: Partial<SketchFeature> = {}): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(20, 4, 10, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    // Authored on the face these tests work on: a Top-authored row is a ghost on
    // Around, and the store's ghost guard keeps ghosts out of a selection.
    authoringFace: 'around' as const,
    z_top: 10,
    z_bottom: 4,
    visible: true,
    locked: false,
    ...overrides,
  }
}

/** A non-rotary canned kind, the one that keeps today's transforms. */
function ellipseRow(id: string): SketchFeature {
  return plainRow(id, {
    name: id,
    canned: { kind: 'ellipse', params: {} },
  })
}

function rotaryProject(features: SketchFeature[] = []): Project {
  const base = newProject('Canned shape actions', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(25, 120, 'x', { x: 0, y: 0 })
  const machine = validateMachineDefinition({
    ...structuredClone(bundledMachines()[0]),
    id: 'canned-actions',
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = [{ ...defaultTool('mm', 1), id: 'ball', type: 'ball_endmill', diameter: 3 } as Tool]
  return projectWithFeatures(base, features)
}

function load(features: SketchFeature[] = []): void {
  store().loadProject(rotaryProject(features))
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
}

function addTurn(start: number, length: number, diameter: number): string {
  const result = store().addRotarySolid({ kind: 'turn', start, length, diameter })
  if (!result.ok) throw new Error(`Turn refused: ${result.reason}`)
  return result.featureId
}

function addPattern(kind: 'thread' | 'flutes', start: number, length: number): string {
  const result = kind === 'thread'
    ? store().addRotaryPattern({ kind, start, length, pitch: 2, depth: 1 })
    : store().addRotaryPattern({ kind, start, length, count: 4, twist: 0, depth: 1 })
  if (!result.ok) throw new Error(`${kind} refused: ${result.reason}`)
  return result.featureId
}

// ── the rule ────────────────────────────────────────────────
//
// One home for "is this a rotary canned shape" and "what does a transform make
// of it", read by the menu, the commands and the store.

assert(isRotaryCannedFeature({ canned: { kind: 'turn', params: {} } }), 'a Turn is a rotary canned shape')
assert(isRotaryCannedFeature({ canned: { kind: 'polygon', params: {} } }), 'a Polygon is one too')
assert(isRotaryCannedFeature({ canned: { kind: 'thread', params: {} } }), 'and a Thread')
assert(isRotaryCannedFeature({ canned: { kind: 'flutes', params: {} } }), 'and Flutes')
assert(!isRotaryCannedFeature({ canned: { kind: 'ellipse', params: {} } }), 'an ellipse is not: its outline is a plain profile')
assert(!isRotaryCannedFeature({ canned: null }), 'a plain feature is not')
assert(!isRotaryCannedFeature(null), 'and nothing is not')

const rotaryRows = [
  { canned: { kind: 'turn', params: {} } },
  { canned: { kind: 'ellipse', params: {} } },
]
assert(hasRotaryCannedFeature(rotaryRows), 'a selection containing a rotary shape is found')
assert(!hasRotaryCannedFeature([{ canned: { kind: 'ellipse', params: {} } }]), 'an ellipse-only selection is not')

assert(
  isRotaryCannedMoveSelection({ stock: roundStock(25, 120, 'x') }, [{ canned: { kind: 'thread', params: {} } }]),
  'a move of the four kinds on a bar is the band move',
)
assert(
  !isRotaryCannedMoveSelection({ stock: roundStock(25, 120, 'x') }, rotaryRows),
  'a selection holding an ellipse keeps the generic 2D move',
)
assert(
  !isRotaryCannedMoveSelection({ stock: roundStock(25, 120, 'x') }, []),
  'an empty selection is no move at all',
)
assert(
  !isRotaryCannedMoveSelection(
    { stock: { ...roundStock(25, 120, 'x'), shape: 'block' } as Project['stock'] },
    [{ canned: { kind: 'turn', params: {} } }],
  ),
  'a block has no bar axis to move along',
)

const resize = cannedShapeTransformRefusal(rotaryRows, 'resize')
assert(resize?.reason === 'useEditor', `Resize points at the editor, got ${JSON.stringify(resize)}`)
assert(resize?.shapeKey === 'canned.turn.name', `and names the rotary shape, got ${JSON.stringify(resize)}`)
assert(cannedShapeTransformRefusal(rotaryRows, 'rotate')?.reason === 'expand', 'Rotate says expand first')
assert(cannedShapeTransformRefusal(rotaryRows, 'mirror')?.reason === 'expand', 'Mirror says expand first')
assert(
  cannedShapeTransformRefusal([{ canned: { kind: 'ellipse', params: {} } }], 'rotate') === null,
  'an ellipse keeps its transforms',
)
assert(cannedShapeTransformRefusal([plainRow('plain')], 'resize') === null, 'a plain feature keeps its resize')

// ── the store funnel every entry point goes through ─────────

const startTransform = (mode: 'resize' | 'rotate' | 'mirror', featureId: string): void => {
  if (mode === 'resize') store().startResizeFeature(featureId)
  else if (mode === 'rotate') store().startRotateFeature(featureId)
  else store().startMirrorFeature(featureId)
}

for (const kind of ['turn', 'thread'] as const) {
  for (const mode of ['resize', 'rotate', 'mirror'] as const) {
    load()
    const id = kind === 'turn' ? addTurn(20, 10, 12) : addPattern('thread', 20, 10)
    store().selectFeatures([id])
    const historyBefore = store().history.past.length
    startTransform(mode, id)
    assert.equal(store().pendingTransform, null,
      `${kind}: ${mode} is refused, so no pending transform is armed`)
    assert.equal(store().history.past.length, historyBefore,
      `${kind}: a refused ${mode} writes no history`)
  }
}

// The same actions still run for a plain feature and for an ellipse: the
// refusal is about the shape, not a blanket freeze.
load([plainRow('plain')])
store().selectFeatures(['plain'])
store().startRotateFeature('plain')
assert.equal(store().pendingTransform?.mode, 'rotate', 'a plain feature still rotates')
store().cancelPendingTransform()
store().startResizeFeature('plain')
assert.equal(store().pendingTransform?.mode, 'resize', 'and still resizes')
store().cancelPendingTransform()
store().startMirrorFeature('plain')
assert.equal(store().pendingTransform?.mode, 'mirror', 'and still mirrors')
store().cancelPendingTransform()

load([ellipseRow('ellipse')])
store().selectFeatures(['ellipse'])
store().startResizeFeature('ellipse')
assert.equal(store().pendingTransform?.mode, 'resize', 'a non-rotary canned kind still resizes')
store().cancelPendingTransform()
store().startRotateFeature('ellipse')
assert.equal(store().pendingTransform?.mode, 'rotate', 'and still rotates')
store().cancelPendingTransform()

// The refusal follows the whole selection: a plain primary with a Turn beside
// it would drag the Turn through a transform it cannot express.
load([plainRow('plain')])
const mixedTurn = addTurn(20, 10, 12)
store().selectFeatures(['plain', mixedTurn])
assert.deepEqual(store().selection.selectedFeatureIds, ['plain', mixedTurn],
  'both rows are selected, so the transform would reach the Turn')
store().startRotateFeature('plain')
assert.equal(store().pendingTransform, null,
  'Rotate is refused when the selection holds a Turn, even with a plain primary')

// Move is the one action the four kinds keep: the floor is that it still starts.
store().selectFeatures([mixedTurn])
store().startMoveFeature(mixedTurn)
assert.equal(store().pendingMove?.mode, 'move', 'Move still starts for a rotary canned shape')
assert.deepEqual(store().pendingMove?.entityIds, [mixedTurn], 'and holds the row it was started for')

console.log('cannedShapeActions.test.ts passed')
