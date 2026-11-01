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
 * A canned ellipse's radius-handle drag session (issue #1112 slices w3e-a,
 * rt7-g).
 *
 * Run with: npx tsx src/components/canvas/cannedRadiusDrag.test.ts
 *
 * The load-bearing properties:
 *   1. Handles exist only while that ellipse's Edit panel is open. A plain
 *      selection draws none and cannot start a drag (Frank, round 7).
 *   2. A drag writes the panel's field text — the same edit path a keystroke
 *      takes — and never the project, so the panel's live preview, Save and
 *      Cancel decide what happens to the shape.
 *   3. The fields and the handles are one value in both directions: typing a
 *      radius moves its handle, and dragging moves the field.
 *   4. The handle follows the same snap gate a dragged circle control does, and
 *      a rotated placement still maps the pointer onto the ellipse's own axis.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { newProject, type Point, type Project } from '../../types/project'
import { useProjectStore } from '../../store/projectStore'
import type { ProjectStore } from '../../store/types'
import { resolveFeatureInstance, resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { ELLIPSE_RADIUS_MIN, ellipseRadiusHandlePoint } from '../../cannedShapes/ellipseHandles'
import { closeCannedEditDraft, getCannedEditDraft, openCannedEditDraft, setCannedEditDraftField } from './cannedEditDraft'
import {
  beginCannedRadiusDrag,
  cannedEditHandleParams,
  moveCannedRadiusDrag,
  publishCannedRadiusDrag,
  updateCannedRadiusDrag,
  type CannedRadiusDragState,
} from './cannedRadiusDrag'

/** Apply a sequence of pointer positions, as the drag handler does move by move. */
function dragTo(state: CannedRadiusDragState, ...points: Point[]): CannedRadiusDragState {
  return points.reduce((current, point) => updateCannedRadiusDrag(current, point), state)
}

function near(actual: number, expected: number, label: string): void {
  assert(Math.abs(actual - expected) < 1e-6, `${label}: expected ${expected}, got ${actual}`)
}

function resetStore(project?: Project): void {
  useProjectStore.setState({
    project: project ?? newProject(),
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
  } as unknown as Partial<ProjectStore>)
}

function store(): ProjectStore {
  return useProjectStore.getState()
}

function storedParams(featureId: string): { rx: number; ry: number } {
  const canned = resolveFeatureInstance(store().project, featureId)?.canned
  assert.ok(canned, `feature ${featureId} is canned`)
  return canned.params as { rx: number; ry: number }
}

resetStore()
store().addEllipseFeature('Ellipse', 50, 50, 30, 20, 5)
const ellipse = resolvedProjectFeatures(store().project)[0]
assert.ok(ellipse, 'the fixture created an ellipse')
const storedParameters = storedParams(ellipse.id)
const undoSteps = store().history.past.length

// ── 1. A plain selection has no handles and cannot drag ────────────────

assert.equal(getCannedEditDraft(), null, 'no editor is open on a plain selection')
assert.equal(
  cannedEditHandleParams(ellipse, null, null),
  null,
  'a plain selection draws no radius handles',
)
assert.equal(
  beginCannedRadiusDrag(ellipse, 0, null),
  null,
  'a press where a handle would be starts no drag on a plain selection',
)

// A session for another row, or for another kind, is not this ellipse's editor.
openCannedEditDraft('f-other', 'ellipse', { rx: '30', ry: '20' })
assert.equal(
  beginCannedRadiusDrag(ellipse, 0, getCannedEditDraft()),
  null,
  'another row being edited does not give this ellipse handles',
)
openCannedEditDraft(ellipse.id, 'ngon', { sides: '6', size: '10', rotation: '0' })
assert.equal(
  beginCannedRadiusDrag(ellipse, 0, getCannedEditDraft()),
  null,
  'a non-ellipse editor has no radius handles',
)
closeCannedEditDraft()

// ── 2. In Edit ellipse mode the fields place the handles ───────────────

openCannedEditDraft(ellipse.id, 'ellipse', { rx: '30', ry: '20' })
const opened = getCannedEditDraft()
assert.ok(opened, 'the Edit ellipse session is open')
const drawParams = cannedEditHandleParams(ellipse, opened, null)
assert.ok(drawParams, 'the edited ellipse draws its handles')
near(drawParams.rx, 30, 'the handles sit on the stored rx')
near(drawParams.ry, 20, 'the handles sit on the stored ry')

// Typing a radius moves its handle: the fields are the handle placement.
setCannedEditDraftField(ellipse.id, 'ry', '45')
const typedParams = cannedEditHandleParams(ellipse, getCannedEditDraft(), null)
assert.ok(typedParams, 'a typed value keeps the handles on screen')
near(typedParams.ry, 45, 'a typed ry moves the Y handle')
near(typedParams.rx, 30, 'typing ry leaves the X handle alone')

// A field the generator refuses keeps the stored placement, which is what the
// panel's preview keeps drawing.
setCannedEditDraftField(ellipse.id, 'ry', '')
const refusedParams = cannedEditHandleParams(ellipse, getCannedEditDraft(), null)
assert.ok(refusedParams, 'a refused field keeps the handles on screen')
near(refusedParams.ry, 20, 'a refused field leaves the handle on the stored ry')
setCannedEditDraftField(ellipse.id, 'ry', '20')

// ── 3. Dragging writes the panel's field, not the project ──────────────

const start = beginCannedRadiusDrag(ellipse, 0, getCannedEditDraft())
assert.ok(start, 'the edited ellipse starts an X drag')
assert.equal(start.axis, 'rx', 'index 0 is the local X radius')
assert.equal(beginCannedRadiusDrag(ellipse, 2, getCannedEditDraft()), null, 'a third handle does not exist')
assert.equal(beginCannedRadiusDrag(ellipse, -1, getCannedEditDraft()), null, 'a negative handle does not exist')

const preview = dragTo(start, { x: 70, y: 50 }, { x: 90, y: 50 }, { x: 120, y: 50 })
near(preview.params.rx, 70, 'the last pointer position is the preview radius')
near(preview.params.ry, 20, 'the preview never touches the other radius')
assert.deepEqual(preview.transform, start.transform, 'the placement is fixed for the drag')
assert.deepEqual(storedParams(ellipse.id), storedParameters, 'no pointer move writes to the project')
assert.equal(store().history.past.length, undoSteps, 'no pointer move adds an undo step')

assert.equal(publishCannedRadiusDrag(preview), true, 'the drag publishes a changed field')
assert.equal(getCannedEditDraft()?.values.rx, '70', 'the drag writes the panel’s rx field')
assert.equal(getCannedEditDraft()?.values.ry, '20', 'the drag never rewrites the other field')
assert.deepEqual(storedParams(ellipse.id), storedParameters, 'publishing writes no project parameters')
assert.equal(store().history.past.length, undoSteps, 'the drag is not an undo step before Save')

// The handles now follow the field the drag wrote.
const draggedParams = cannedEditHandleParams(ellipse, getCannedEditDraft(), null)
assert.ok(draggedParams, 'the dragged ellipse keeps its handles')
near(draggedParams.rx, 70, 'the X handle follows the dragged field')

// Field precision: the text and the handle are one value, at four decimals.
const fractional = updateCannedRadiusDrag(start, { x: 83.333333, y: 50 })
near(fractional.params.rx, 33.3333, 'the dragged radius lands on field precision')
publishCannedRadiusDrag(fractional)
assert.equal(getCannedEditDraft()?.values.rx, '33.3333', 'the field text is the same rounded radius')

// The minimum keeps the ellipse from collapsing through its centre.
const collapsed = updateCannedRadiusDrag(start, { x: 50, y: 50 })
near(collapsed.params.rx, ELLIPSE_RADIUS_MIN, 'a pull to the centre stops at the minimum radius')

// ── 4. The handle obeys the circle's snap gate and the axis lock ───────

const noLock = (point: Point): Point => point
assert.equal(
  moveCannedRadiusDrag(start, null, { x: 80, y: 50 }, noLock),
  start,
  'a required snap that did not resolve leaves the radius exactly where it is',
)
assert.equal(
  moveCannedRadiusDrag(start, null, { x: 120, y: 90 }, noLock),
  start,
  'the snap gate ignores the drag origin',
)
const gatedMove = moveCannedRadiusDrag(start, { x: 75, y: 50 }, { x: 80, y: 50 }, noLock)
near(gatedMove.params.rx, 25, 'a resolved snap point still moves the handle')
near(gatedMove.params.ry, 20, 'the gate never touches the other radius')
const lockY = (point: Point, reference: Point): Point => ({ x: reference.x, y: point.y })
const lockedMove = moveCannedRadiusDrag(start, { x: 95, y: 70 }, { x: 80, y: 50 }, lockY)
near(lockedMove.params.rx, 30, 'the drag axis lock is applied to the gated point')

// ── 5. A rotated placement keeps the drag on the ellipse's own axis ────

const angle = Math.PI / 6
const rotated = {
  ...ellipse,
  id: 'f-rotated',
  transform: {
    a: Math.cos(angle),
    b: Math.sin(angle),
    c: -Math.sin(angle),
    d: Math.cos(angle),
    e: 100,
    f: 80,
  },
}
openCannedEditDraft(rotated.id, 'ellipse', { rx: '30', ry: '20' })
const rotatedStart = beginCannedRadiusDrag(rotated, 0, getCannedEditDraft())
assert.ok(rotatedStart, 'the rotated ellipse starts an X drag')
// The placed X handle, pulled out to a radius of 60 in the same direction.
const placedHandle = ellipseRadiusHandlePoint({ rx: 60, ry: 20 }, 'rx', rotated.transform)
const rotatedMove = updateCannedRadiusDrag(rotatedStart, placedHandle)
near(rotatedMove.params.rx, 60, 'the rotated drag reads the radius along the placed X axis')
near(rotatedMove.params.ry, 20, 'a rotated drag never touches the other radius')
publishCannedRadiusDrag(rotatedMove)
assert.equal(getCannedEditDraft()?.values.rx, '60', 'the rotated drag writes the field too')
closeCannedEditDraft()

// ── 6. Closing the editor takes the handles away again ─────────────────

assert.equal(getCannedEditDraft(), null, 'closing the panel ends the session')
assert.equal(cannedEditHandleParams(ellipse, null, null), null, 'the closed panel draws no handles')
assert.equal(beginCannedRadiusDrag(ellipse, 0, null), null, 'and nothing can be dragged')
assert.deepEqual(storedParams(ellipse.id), storedParameters, 'the whole session wrote no parameters')

// The old release -> updateFeature write is gone, so the drag cannot bypass the
// panel's Save/Cancel handling. Pinned because that write is exactly what the
// reviewed bug was, and no radius-drag unit can observe its absence otherwise.
const hookSource = readFileSync(new URL('./useCannedRadiusDrag.ts', import.meta.url), 'utf8')
assert(!hookSource.includes('updateFeature'), 'the radius drag hook has no direct project write')
const blockSource = readFileSync(new URL('./cannedRadiusDrag.ts', import.meta.url), 'utf8')
assert(!blockSource.includes('useProjectStore'), 'the radius drag module imports no store')

const gesturesSource = readFileSync(new URL('./usePointerGestures.ts', import.meta.url), 'utf8')
assert(
  gesturesSource.includes('cannedRadius.update(constrainedPoint,'),
  'the pointer handler routes the snap-gated point into the radius drag',
)
assert(
  !gesturesSource.includes('constrainedPoint ?? snapped'),
  'the radius drag never falls back to the raw snapped pointer',
)
assert(
  gesturesSource.includes("pendingAddRef.current?.shape === 'canned-edit'"),
  'the press may grab a handle while the Edit panel occupies pendingAdd',
)

console.log('✓ ellipse radius drag: edit-mode-only handles, field writes, snap gate, rotated frame')
