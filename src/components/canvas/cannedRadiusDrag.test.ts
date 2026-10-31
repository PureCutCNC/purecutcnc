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
 * A canned ellipse's radius-handle drag session (issue #1112 slice w3e-a).
 *
 * Run with: npx tsx src/components/canvas/cannedRadiusDrag.test.ts
 *
 * The load-bearing properties:
 *   1. A drag starts only on a canned ellipse's own handle, never on another
 *      kind or a handle index that does not exist.
 *   2. Every pointer move previews new parameters for the dragged feature only;
 *      nothing is stored until the release.
 *   3. The release is exactly one write, so the gesture is one undo step — and
 *      through `updateFeature` it is the same normalize/apply path the
 *      Edit-ellipse panel uses, so linked copies and the summary follow.
 */

import assert from 'node:assert/strict'
import { newProject, type CannedShapeData, type Point, type Project } from '../../types/project'
import { useProjectStore } from '../../store/projectStore'
import type { ProjectStore } from '../../store/types'
import { resolveFeatureInstance, resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { translateMatrix } from '../../store/helpers/instanceTransforms'
import {
  beginCannedRadiusDrag,
  cannedRadiusDrawParams,
  commitCannedRadiusDrag,
  updateCannedRadiusDrag,
  type CannedRadiusDragState,
} from './cannedRadiusDrag'

/** Apply a sequence of pointer positions, as the drag handler does move by move. */
function dragTo(state: CannedRadiusDragState, ...points: Point[]): CannedRadiusDragState {
  return points.reduce((current, point) => updateCannedRadiusDrag(current, point), state)
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

// ── 1. What a drag can start on ────────────────────────────────────────

resetStore()
store().addEllipseFeature('Ellipse', 50, 50, 30, 20, 5)
const ellipse = resolvedProjectFeatures(store().project)[0]
assert.ok(ellipse, 'the fixture created an ellipse')

const xDrag = beginCannedRadiusDrag(ellipse, 0)
assert.ok(xDrag, 'a handle index starts a drag')
assert.equal(xDrag.axis, 'rx', 'index 0 is the local X radius')
const yDrag = beginCannedRadiusDrag(ellipse, 1)
assert.ok(yDrag, 'the second handle index starts a drag')
assert.equal(yDrag.axis, 'ry', 'index 1 is the local Y radius')
assert.equal(beginCannedRadiusDrag(ellipse, 2), null, 'a third handle does not exist')
assert.equal(beginCannedRadiusDrag(ellipse, -1), null, 'a negative handle does not exist')
assert.equal(
  beginCannedRadiusDrag({ ...ellipse, canned: { kind: 'ngon', params: { sides: 6, size: 10, rotation: 0 } } }, 0),
  null,
  'another canned kind has no ellipse handles',
)
assert.equal(
  beginCannedRadiusDrag({ ...ellipse, canned: null }, 0),
  null,
  'a plain feature has no ellipse handles',
)
assert.equal(
  beginCannedRadiusDrag({ ...ellipse, canned: { kind: 'ellipse', params: { rx: 0, ry: 20 } } }, 0),
  null,
  'parameters the generator refuses cannot be dragged',
)

// ── 2. Pointer moves preview, and only the dragged feature ─────────────

const start = beginCannedRadiusDrag(ellipse, 0)
assert.ok(start, 'the drag starts')
const preview = dragTo(start, { x: 70, y: 50 }, { x: 90, y: 50 }, { x: 120, y: 50 })
assert.equal(preview.params.rx, 70, 'the last pointer position is the preview radius')
assert.equal(preview.params.ry, 20, 'the preview never touches the other radius')
assert.deepEqual(preview.transform, start.transform, 'the placement is fixed for the drag')
assert.deepEqual(storedParams(ellipse.id), { rx: 30, ry: 20 }, 'no pointer move writes to the project')

// The preview belongs to its own feature; another ellipse draws its own.
const otherEllipse = { ...ellipse, id: 'f-other' }
assert.deepEqual(cannedRadiusDrawParams(ellipse, preview), preview.params, 'the dragged ellipse draws its preview')
assert.equal(cannedRadiusDrawParams(otherEllipse, preview)?.rx, 30, 'another ellipse keeps its stored radius')
assert.equal(
  cannedRadiusDrawParams({ ...ellipse, canned: { kind: 'ngon', params: { sides: 6, size: 10, rotation: 0 } } }, null),
  null,
  'only an ellipse has radius handles to draw',
)

// ── 3. The release is exactly one write ────────────────────────────────

const writes: Array<{ featureId: string; canned: CannedShapeData }> = []
commitCannedRadiusDrag(preview, (featureId, canned) => writes.push({ featureId, canned }))
assert.equal(writes.length, 1, 'four pointer moves and one release are one write')
assert.equal(writes[0].featureId, ellipse.id, 'the write targets the dragged feature')
assert.deepEqual(writes[0].canned, { kind: 'ellipse', params: preview.params }, 'the write stores the last preview')

// ── 4. Through the real store: one undo step, placement kept ───────────

resetStore()
store().addEllipseFeature('Ellipse', 50, 50, 30, 20, 5)
const featureId = resolvedProjectFeatures(store().project)[0].id
const placement = resolveFeatureInstance(store().project, featureId)?.transform
const undoStepsBefore = store().history.past.length

const drag = beginCannedRadiusDrag(resolveFeatureInstance(store().project, featureId)!, 0)
assert.ok(drag, 'the placed ellipse starts a drag')
const dragged = dragTo(drag, { x: 80, y: 50 }, { x: 95, y: 50 })
commitCannedRadiusDrag(dragged, (id, canned) => store().updateFeature(id, { canned }))

assert.deepEqual(storedParams(featureId), { rx: 45, ry: 20 }, 'the release stores the dragged radius')
assert.equal(
  store().history.past.length - undoStepsBefore,
  1,
  'the whole drag is one undo step, like one Edit-panel Apply',
)
assert.deepEqual(
  resolveFeatureInstance(store().project, featureId)?.transform,
  placement,
  'a radius drag never moves the instance',
)

store().undo()
assert.deepEqual(storedParams(featureId), { rx: 30, ry: 20 }, 'undo restores both radii')

// Two instances of one definition both read the edited parameters, each keeping
// its own placement — the same rule an Edit-panel Apply follows.
const projectWithCopy = store().project
const [onlyRow] = projectWithCopy.features
store().loadProject({
  ...projectWithCopy,
  features: [
    onlyRow,
    { ...onlyRow, id: 'f-copy', transform: translateMatrix(120, 30) },
  ],
})
const copyPlacement = resolveFeatureInstance(store().project, 'f-copy')?.transform
const copyDrag = beginCannedRadiusDrag(resolveFeatureInstance(store().project, featureId)!, 1)
assert.ok(copyDrag, 'the shared definition starts a Y drag')
// Local (0, 30): the placed origin is (50, 50).
commitCannedRadiusDrag(updateCannedRadiusDrag(copyDrag, { x: 50, y: 80 }), (id, canned) => store().updateFeature(id, { canned }))
assert.equal(storedParams('f-copy').ry, 30, 'a linked copy reads the shared parameters')
assert.deepEqual(
  resolveFeatureInstance(store().project, 'f-copy')?.transform,
  copyPlacement,
  'the linked copy keeps its own placement',
)

console.log('✓ ellipse radius drag: start rules, preview-only moves, one write, one undo step')
