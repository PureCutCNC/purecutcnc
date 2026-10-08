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
 * Where the two stock faces must not leak into each other (issue #945) — the
 * cases the second review of PR #978 reproduced:
 *
 * - a ghost reached by feature id rather than through the selection;
 * - a shape drawn on one face judged against solids that only exist at the
 *   other;
 * - a provisional setup made real by a write that created nothing there;
 * - the face switched half-way through drawing a shape;
 * - text pasted across faces reading backwards;
 * - a folder's eye reaching the folder's ghosts.
 *
 * Mutations these assertions were checked against:
 * - the ghost gate removed from `resolveDrivingDimensionEdit` → "a dimension
 *   on a ghost does not drive" fails; removed from `moveFeatureControl` → "a
 *   ghost cannot be reshaped by feature id" fails;
 * - `featuresAtActiveFace` returning every feature (the original behaviour)
 *   → the pocket and Line assertions fail for both faces; returning only the
 *   active face's features → "the base still counts" fails;
 * - the setup made real whenever the face has content (the original rule) →
 *   "an edit that creates nothing on Bottom makes no setup" fails; restores
 *   not exempted → "undo puts the recorded project back" fails;
 * - `pendingAdd` left out of `isFaceEditInProgress` → "the face cannot be
 *   switched once a corner is placed" fails; an armed tool counted as work
 *   in progress → "an armed tool does not hold the face" fails;
 * - the cross-face mirror not applied to pasted text → "pasted text reads the
 *   right way round" fails; applied to a paste on the same face, or to a
 *   shape that is not text → those assertions fail;
 * - the folder eye toggling every feature in the folder → "the folder's
 *   ghosts keep their visibility" fails;
 * - one of the ghost predicates comparing `authoringFace` directly → "a
 *   feature that names no face is on Top for every ghost question" fails.
 *
 * Run with: npx tsx src/store/faceBoundaries.test.ts
 */

import { computeSketchViewTransform, worldToCanvas } from '../components/canvas/viewTransform'
import { orientationForFace, setupFace } from '../engine/setupOrientation'
import { pasteClipboardFeatures } from '../platform/featureClipboard'
import { resolveDrivingDimensionEdit } from '../sketch/drivingDimensionResolver'
import { defaultTextToolConfig, resolveTextFeatureShapes } from '../text'
import { getProfileBounds, newProject } from '../types/project'
import type { Point, Project, SketchProfile } from '../types/project'
import {
  activeFace,
  activeSetup,
  editableFeatures,
  faceAngles,
  faceOffsets,
  ghostFeatureIds,
  isGhostFeature,
} from './helpers/activeFace'
import { provisionalSetupFor } from './helpers/provisionalSetup'
import { resolveFeatureInstance, resolvedProjectFeatures } from './helpers/resolveFeatures'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { switchWorkspaceFace } from './workspaceFace'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function near(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) < epsilon
}

function resetStore(project: Project = newProject()): void {
  useProjectStore.setState({
    project,
    dirty: false,
    selection: {
      mode: 'feature',
      selectedFeatureId: null,
      selectedFeatureIds: [],
      selectedTabIds: [],
      selectedClampIds: [],
      selectedNode: null,
      hoveredFeatureId: null,
      sketchEditTool: null,
      activeControl: null,
      groupFolderId: null,
    },
    history: { past: [], future: [], transactionStart: null },
    pendingAdd: null,
    pendingMove: null,
  } as unknown as Partial<ProjectStore>)
}

const store = () => useProjectStore.getState()
const project = () => store().project
const lastFeature = () => project().features[project().features.length - 1]
const instance = (id: string) => project().features.find((feature) => feature.id === id)!
const operationOf = (id: string) => resolveFeatureInstance(project(), id)!.operation
const outlineOf = (id: string) => JSON.stringify(resolveFeatureInstance(project(), id)!.sketch.profile)
const bottomSetups = () => project().setups.filter((setup) => setupFace(setup) === 'bottom')
/** The document: everything but the timestamp and the face in view. */
const documentOf = (candidate: Project) => JSON.stringify({ ...candidate, meta: { ...candidate.meta, modified: '' }, activeSetupId: '' })

// ── A ghost is not edited by feature id either ────────────────

{
  resetStore()
  store().addRectFeature('Base', 10, 10, 40, 20, project().stock.thickness)
  const baseId = lastFeature().id
  const target = { source: 'feature' as const, featureId: baseId }
  const dimensionId = store().addDimensionAnnotation({
    type: 'horizontal',
    a: { kind: 'vertex', target, vertexIndex: 0 },
    b: { kind: 'vertex', target, vertexIndex: 1 },
    offset: 5,
    visible: true,
    locked: false,
    textOverride: null,
    precisionOverride: null,
  })
  const drivingEdit = () => resolveDrivingDimensionEdit(project().annotations.find((entry) => entry.id === dimensionId)!, project())

  const onTop = drivingEdit()
  assert(onTop !== null && !('disabled' in onTop) && onTop.kind === 'linear', 'fixture: on its own face the dimension drives the feature')

  switchWorkspaceFace('bottom')
  const onBottom = drivingEdit()
  assert(onBottom !== null && 'disabled' in onBottom, 'a dimension on a ghost does not drive')
  const before = outlineOf(baseId)
  store().moveFeatureControl(baseId, { kind: 'anchor', index: 1 }, { x: 80, y: 10 })
  assert(outlineOf(baseId) === before, 'a ghost cannot be reshaped by feature id')

  switchWorkspaceFace('top')
  store().moveFeatureControl(baseId, { kind: 'anchor', index: 1 }, { x: 80, y: 10 })
  assert(outlineOf(baseId) !== before, 'on its own face the same control moves')
}

// ── A new shape is judged against the solids at its own face ──

for (const drawnOn of ['bottom', 'top'] as const) {
  const pocketFace = drawnOn === 'bottom' ? 'top' : 'bottom'
  resetStore()
  const thickness = project().stock.thickness
  store().addRectFeature('Base', 0, 0, 100, 80, thickness)

  // A pocket cut a third of the way in from the other face.
  switchWorkspaceFace(pocketFace)
  store().addRectFeature('Pocket', 20, 20, 40, 30, thickness)
  const pocketId = lastFeature().id
  assert(operationOf(pocketId) === 'subtract', 'fixture: the rectangle inside the base is a pocket')
  store().updateFeature(pocketId, pocketFace === 'top'
    ? { z_top: thickness, z_bottom: thickness * 2 / 3 }
    : { z_top: thickness / 3, z_bottom: 0 })

  // Seen from this face that area is solid material: a rectangle drawn over
  // the pocket's outline is a pocket of its own, not an island in a hole.
  switchWorkspaceFace(drawnOn)
  store().addRectFeature('Inside', 25, 25, 10, 10, thickness)
  assert(
    operationOf(lastFeature().id) === 'subtract',
    `drawn on ${drawnOn}: a shape over a pocket cut part-way in from ${pocketFace} is a pocket`,
  )
  store().deleteFeature(lastFeature().id)

  // And a Line drawn there lies on this face, across the full stock.
  store().setCreationTarget('line')
  store().addRectFeature('Engraving', 25, 25, 10, 10, thickness)
  const line = lastFeature()
  assert(
    line.z_bottom === 0 && line.z_top === thickness,
    `drawn on ${drawnOn}: a Line over a pocket cut part-way in from ${pocketFace} lies on this face (got [${String(line.z_bottom)}, ${String(line.z_top)}])`,
  )
  store().deleteFeature(line.id)
  store().setCreationTarget('feature')

  // The base fills the stock, so it is material on this face too: outside
  // the pocket a new rectangle is still a pocket in the base.
  store().addRectFeature('Beside', 70, 50, 10, 10, thickness)
  assert(operationOf(lastFeature().id) === 'subtract', `drawn on ${drawnOn}: the base still counts`)
  store().deleteFeature(lastFeature().id)

  // A pocket that goes right through is open on this face as well.
  store().updateFeature(pocketId, { z_top: thickness, z_bottom: 0 })
  store().addRectFeature('Island', 25, 25, 10, 10, thickness)
  assert(operationOf(lastFeature().id) === 'add', `drawn on ${drawnOn}: a shape inside a through pocket is an island`)
}

// ── A setup is made real by creating content, not by having some ──

{
  resetStore()
  const thickness = project().stock.thickness
  store().addRectFeature('Base', 0, 0, 100, 80, thickness)
  const baseId = lastFeature().id
  switchWorkspaceFace('bottom')
  store().addRectFeature('Recess', 20, 20, 40, 30, thickness)
  const recessId = lastFeature().id
  switchWorkspaceFace('top')
  store().deleteSetup(bottomSetups()[0].id)
  assert(bottomSetups().length === 0 && instance(recessId).authoringFace === 'bottom', 'fixture: Bottom features, no Bottom setup')

  switchWorkspaceFace('bottom')
  assert(provisionalSetupFor(project()) !== undefined, 'fixture: Bottom is looked at provisionally')
  const recorded = documentOf(project())

  // The review's case: hide a ghost. Nothing was created on Bottom.
  store().updateFeature(baseId, { visible: false })
  assert(bottomSetups().length === 0, 'an edit that creates nothing on Bottom makes no setup')
  store().undo()
  assert(bottomSetups().length === 0 && documentOf(project()) === recorded, 'undo puts the recorded project back')

  // Editing what is already on Bottom creates nothing either.
  store().updateFeature(recessId, { name: 'Renamed recess' })
  assert(bottomSetups().length === 0, 'editing an existing Bottom feature makes no setup')
  store().undo()

  // A restore brings Bottom content back without creating it.
  store().deleteFeature(recessId)
  store().undo()
  assert(bottomSetups().length === 0 && documentOf(project()) === recorded, 'undoing a delete restores the Bottom feature and no setup')
  store().redo()
  store().undo()
  assert(documentOf(project()) === recorded, 'and redo / undo come back to the same project')

  // Creating content still does: drawing, and moving a feature across.
  store().addRectFeature('Second recess', 70, 50, 10, 10, thickness)
  assert(bottomSetups().length === 1, 'a feature drawn on Bottom makes the setup real')
  store().undo()
  assert(bottomSetups().length === 0, 'fixture: undone')
  store().setFeatureAuthoringFace([baseId], 'bottom')
  assert(bottomSetups().length === 1, 'a feature moved to Bottom makes the setup real')
}

// ── The face is held once a shape has a point on the canvas ───

{
  resetStore()
  store().startAddRectPlacement()
  assert(switchWorkspaceFace('bottom'), 'an armed tool does not hold the face')
  switchWorkspaceFace('top')
  store().setPendingAddAnchor({ x: 10, y: 10 })
  assert(!switchWorkspaceFace('bottom') && activeFace(project()) === 'top', 'the face cannot be switched once a corner is placed')
  store().cancelPendingAdd()
  assert(switchWorkspaceFace('bottom'), 'cancelling the shape releases the face')
  switchWorkspaceFace('top')

  // The review's case: two polygon points, then the switch.
  store().startAddPolygonPlacement()
  assert(switchWorkspaceFace('bottom'), 'an armed polygon tool does not hold the face')
  switchWorkspaceFace('top')
  store().addPendingPolygonPoint({ x: 10, y: 10 })
  store().addPendingPolygonPoint({ x: 30, y: 10 })
  assert(!switchWorkspaceFace('bottom'), 'the face cannot be switched half-way through a polygon')
  store().cancelPendingAdd()

  store().startAddCompositePlacement()
  store().addPendingCompositePoint({ x: 10, y: 10 })
  assert(!switchWorkspaceFace('bottom'), 'nor half-way through a composite outline')
  store().cancelPendingAdd()
}

// ── Pasted text reads the right way round on the face it lands on ──

/** Every outline point of a text feature, relative to the centre of its outline, on screen. */
function glyphOffsets(candidate: Project, featureId: string): Point[] {
  const feature = resolveFeatureInstance(candidate, featureId)!
  const view = computeSketchViewTransform(candidate, 800, 600, { zoom: 1, panX: 0, panY: 0 })
  const centreOf = (profile: SketchProfile) => {
    const bounds = getProfileBounds(profile)
    return worldToCanvas({ x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }, view)
  }
  const centre = centreOf(feature.sketch.profile)
  return resolveTextFeatureShapes(feature)
    .flatMap((shape) => [shape.profile.start, ...shape.profile.segments.map((segment) => segment.to)])
    .map((point) => {
      const onScreen = worldToCanvas(point, view)
      return { x: onScreen.cx - centre.cx, y: onScreen.cy - centre.cy }
    })
}

function sameOffsets(a: readonly Point[], b: readonly Point[]): boolean {
  return a.length > 3 && a.length === b.length && a.every((point, index) => near(point.x, b[index].x, 1e-6) && near(point.y, b[index].y, 1e-6))
}

for (const axis of ['x', 'y'] as const) {
  resetStore()
  const config = { ...defaultTextToolConfig(project().meta.units), text: 'F' }
  if (axis === 'y') store().createSetup({ orientation: orientationForFace('bottom', 'y') })

  store().startAddTextPlacement(config)
  const [topId] = store().placePendingTextAt({ x: 1, y: 1 })
  const asTyped = glyphOffsets(project(), topId)
  const copyOf = (id: string) => resolvedProjectFeatures(project()).filter((feature) => feature.id === id)

  // Top → Top: pasted as it is.
  const [sameFaceId] = pasteClipboardFeatures(store(), copyOf(topId), { x: 3, y: 1 })
  assert(sameOffsets(glyphOffsets(project(), sameFaceId), asTyped), `flip about ${axis}: text pasted on its own face is unchanged`)

  // Top → Bottom: mirrored once, so it reads from below.
  switchWorkspaceFace('bottom')
  assert(activeSetup(project()).orientation.axis === axis, `fixture: Bottom is flipped about ${axis}`)
  const [onBottomId] = pasteClipboardFeatures(store(), copyOf(topId), { x: 1, y: 2 })
  assert(instance(onBottomId).authoringFace === 'bottom', `flip about ${axis}: the pasted text is on Bottom`)
  assert(sameOffsets(glyphOffsets(project(), onBottomId), asTyped), `flip about ${axis}: pasted text reads the right way round on Bottom`)
  const centre = (id: string) => {
    const bounds = getProfileBounds(resolveFeatureInstance(project(), id)!.sketch.profile)
    return { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 }
  }
  assert(near(centre(onBottomId).x, 1, 1e-6) && near(centre(onBottomId).y, 2, 1e-6), `flip about ${axis}: and lands where it was placed`)

  // Bottom → Bottom keeps the one mirror it has; Bottom → Top takes it off.
  const [bottomAgainId] = pasteClipboardFeatures(store(), copyOf(onBottomId), { x: 3, y: 2 })
  assert(sameOffsets(glyphOffsets(project(), bottomAgainId), asTyped), `flip about ${axis}: Bottom text pasted on Bottom still reads correctly`)
  const bottomCopy = copyOf(onBottomId)
  switchWorkspaceFace('top')
  const [backOnTopId] = pasteClipboardFeatures(store(), bottomCopy, { x: 2, y: 2.5 })
  assert(sameOffsets(glyphOffsets(project(), backOnTopId), asTyped), `flip about ${axis}: Bottom text pasted on Top reads the right way round`)

  // A plain shape pasted across is the same shape in the stock, not mirrored.
  store().addRectFeature('Wedge', 0.2, 0.2, 0.5, 0.2, project().stock.thickness)
  const wedgeId = lastFeature().id
  const wedge = getProfileBounds(resolveFeatureInstance(project(), wedgeId)!.sketch.profile)
  const wedgeCopy = copyOf(wedgeId)
  switchWorkspaceFace('bottom')
  const [pastedWedgeId] = pasteClipboardFeatures(store(), wedgeCopy, { x: (wedge.minX + wedge.maxX) / 2, y: (wedge.minY + wedge.maxY) / 2 })
  assert(outlineOf(pastedWedgeId) === outlineOf(wedgeId), `flip about ${axis}: a shape that is not text is pasted as it is`)
}

// ── A folder's eye works on the face in view ──────────────────

{
  resetStore()
  const thickness = project().stock.thickness
  store().addRectFeature('Base', 0, 0, 100, 80, thickness)
  const topId = lastFeature().id
  switchWorkspaceFace('bottom')
  store().addRectFeature('Recess', 20, 20, 40, 30, thickness)
  const bottomId = lastFeature().id
  const folderId = store().addFeatureFolder('features')
  useProjectStore.setState({
    project: { ...project(), features: project().features.map((feature) => ({ ...feature, folderId })) },
  })
  switchWorkspaceFace('top')

  store().toggleFolderVisible(folderId)
  assert(instance(topId).visible === false, 'the folder eye hides the folder\'s features on the face in view')
  assert(instance(bottomId).visible === true, 'the folder\'s ghosts keep their visibility')
  store().toggleFolderVisible(folderId)
  assert(instance(topId).visible === true && instance(bottomId).visible === true, 'and shows them again')

  // The state the eye shows is this face's: a hidden ghost does not count.
  store().updateFeature(bottomId, { visible: false })
  store().toggleFolderVisible(folderId)
  assert(instance(topId).visible === false && instance(bottomId).visible === false, 'the eye toggles on this face\'s state, whatever the ghosts are')
}

// ── One ghost rule ────────────────────────────────────────────

{
  resetStore()
  store().addRectFeature('Base', 0, 0, 100, 80, project().stock.thickness)
  const baseId = lastFeature().id
  // A draft that names no face is on Top.
  const unnamed = { ...instance(baseId), authoringFace: undefined }
  const onTop = { ...project(), features: [unnamed] } as unknown as Project
  assert(
    !isGhostFeature(onTop, unnamed) && editableFeatures(onTop, [unnamed]).length === 1 && ghostFeatureIds(onTop).size === 0,
    'a feature that names no face is on Top for every ghost question',
  )
  const onBottom = { ...onTop, activeSetupId: 'provisional-bottom' }
  assert(
    isGhostFeature(onBottom, unnamed) && editableFeatures(onBottom, [unnamed]).length === 0 && ghostFeatureIds(onBottom).has(baseId),
    'and a ghost from Bottom for every one of them',
  )
}

// ── The face maps need only the active setup and the stock ────

// The distribution panel subscribes to those two alone; the maps it builds
// from them are the project's own, a provisional setup included.
{
  resetStore()
  switchWorkspaceFace('bottom')
  const setup = activeSetup(project())
  const view = { setups: [setup], activeSetupId: setup.id, stock: project().stock }
  assert(provisionalSetupFor(project()) !== undefined, 'fixture: the setup in view is provisional')
  assert(
    faceAngles(view).turn(30) === faceAngles(project()).turn(30) && faceAngles(view).direction(30) === faceAngles(project()).direction(30),
    'the angle maps built from the setup and the stock are the project\'s',
  )
  assert(
    faceOffsets(view).y(1) === faceOffsets(project()).y(1) && faceOffsets(view).y(1) === -1,
    'and so are the spacing maps',
  )
}

console.log('faceBoundaries tests passed')

// #994: direct-id edit entry and subject transitions must not capture ghosts.
for (const face of ['top', 'bottom'] as const) {
  resetStore()
  store().addRectFeature('Guide', 10, 10, 20, 10, project().stock.thickness)
  const guideId = lastFeature().id
  store().updateFeature(guideId, { operation: 'construction' })
  switchWorkspaceFace('bottom')
  store().addRectFeature('Bottom subject', 50, 30, 10, 10, project().stock.thickness)
  const bottomId = lastFeature().id
  if (face === 'top') {
    store().updateFeature(bottomId, { operation: 'construction' })
    switchWorkspaceFace('top')
  }
  const foreignId = face === 'top' ? bottomId : guideId
  const ownId = face === 'top' ? guideId : bottomId
  useProjectStore.setState({ sketchEditSession: null, pendingSketchEdit: null, pendingTransform: null, pendingOffset: null,
    history: { past: [], future: [], transactionStart: null }, dirty: false })
  const snapshot = JSON.stringify(project())
  store().enterSketchEdit(foreignId)
  assert(store().sketchEditSession === null && store().selection.mode === 'feature', `${face}: ghost edit entry cannot leave a session`)
  store().enterSketchEdit(ownId)
  assert(store().sketchEditSession?.entityId === ownId, 'own-face edit entry still works')
  store().setSketchEditTool('trim')
  const pendingBefore = JSON.stringify(store().pendingSketchEdit)
  store().setPendingSketchSubject({ featureId: foreignId, segmentIndex: 0, point: { x: 10, y: 10 }, t: 0.5 })
  assert(JSON.stringify(store().pendingSketchEdit) === pendingBefore, 'a ghost cannot become the trim subject through a direct call')
  assert(JSON.stringify(project()) === snapshot && store().history.past.length === 0 && !store().dirty, 'reference refusal writes no geometry, setup, history or dirty flag')
  store().cancelPendingSketchEdit()
  store().cancelSketchEdit()
  store().selectFeature(foreignId)
  store().hoverFeature(foreignId)
  assert(!store().selection.selectedFeatureIds.includes(foreignId) && store().selection.hoveredFeatureId === null, 'ordinary ghost selection and hover remain refused')
}
