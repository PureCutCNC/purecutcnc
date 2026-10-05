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
 * The workspace face (issue #945): the face switch, the active face stamped
 * on new features with a span measured from that face, text that reads
 * correctly from below, ghosts that cannot be selected, and the origin that
 * follows the face.
 *
 * Mutations these assertions were checked against:
 * - `addFeature` not stamping the active face → "a feature drawn on Bottom
 *   is authored on Bottom" fails;
 * - `newFeatureSpan` returning the Top span on Bottom → "a Line drawn in a
 *   Bottom pocket" fails;
 * - the Line inference reading the Top surface on Bottom → the same;
 * - `flippedZRange` returning the stored span → "a Bottom pocket reads like
 *   the same pocket on Top" fails;
 * - text placed without the face mirror → "Bottom text reads the right way
 *   round" fails; the mirror applied twice → the same;
 * - the ghost selection guard removed → "a ghost cannot be selected" and
 *   "switching face drops the selection" fail;
 * - `switchWorkspaceFace` creating the Bottom setup again (the review's
 *   finding 5) → "looking at Bottom adds no setup", "does not dirty" and "is
 *   not an undo step" fail;
 * - `syncWorkspaceSetups` never making the setup real → "the first feature
 *   drawn on Bottom makes the setup real" fails; making it real on any edit
 *   → "an edit that is not Bottom content leaves it provisional" fails;
 *   making it real without an edit → "looking at Bottom makes no setup, even
 *   when a feature is already authored there" fails;
 * - `keepWorkspaceFace` removed from undo/redo → "undo leaves the workspace
 *   on Bottom" fails; `keepWorkspaceFace` not looking for a setup on the same
 *   face → "a snapshot with a Bottom setup is restored onto it" fails (through
 *   the store that one is masked: the reconciler moves the workspace anyway);
 * - `renameSetup` not realizing the setup → "editing the setup makes it real"
 *   fails;
 * - the busy guard removed from `switchWorkspaceFace` (finding 1) → "the face
 *   cannot be switched during a move" fails; removed from
 *   `setFeatureAuthoringFace` → "a feature being moved keeps its face" fails;
 * - `placeOriginAt` storing the stock-space point on Bottom → "an origin
 *   placed on Bottom" fails;
 * - paste keeping the source's face → "a paste lands on the active face" fails;
 * - `setFeatureAuthoringFace` detaching the definition → "a linked copy moved
 *   to the other face keeps its link" fails;
 * - `linkedCopiesOffFace` counting copies on the same face, or the feature
 *   itself → the count assertions fail.
 *
 * Run with: npx tsx src/store/workspaceFace.test.ts
 */

import { depthFromFace, orientationForFace, setupFace, spanFromFaceDepth } from '../engine/setupOrientation'
import { computeSketchViewTransform, worldToCanvas } from '../components/canvas/viewTransform'
import { pasteClipboardFeatures } from '../platform/featureClipboard'
import { defaultTextToolConfig, resolveTextFeatureShapes } from '../text'
import { getProfileBounds, newProject, rectProfile } from '../types/project'
import type { Project } from '../types/project'
import {
  activeFace,
  activeOriginInStock,
  activeSetup,
  editableProjectFeatures,
  flippedZRange,
  isGhostFeature,
  isThroughFeature,
  linkedCopiesOffFace,
  projectUsesBothFaces,
} from './helpers/activeFace'
import { getDefinitionId } from './helpers/featureDefinitions'
import { isProvisionalSetupActive, keepWorkspaceFace, provisionalSetupId } from './helpers/provisionalSetup'
import { resolveFeatureInstance, resolvedProjectFeatures } from './helpers/resolveFeatures'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'
import { switchWorkspaceFace } from './workspaceFace'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9
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
  } as unknown as Partial<ProjectStore>)
}

const store = () => useProjectStore.getState()
const project = () => store().project
const lastFeature = () => project().features[project().features.length - 1]

// ── The face switch ───────────────────────────────────────────

/** The file a save would write, without the timestamp every save renews. */
function savedFile(): string {
  const saved = JSON.parse(store().saveProject()) as { meta: { modified?: string } }
  delete saved.meta.modified
  return JSON.stringify(saved)
}

/** True when nothing but the face in view differs between two projects. */
function sameDocument(a: Project, b: Project): boolean {
  const left = a as unknown as Record<string, unknown>
  const right = b as unknown as Record<string, unknown>
  return Object.keys(left).every((key) => key === 'activeSetupId' || left[key] === right[key])
}

const bottomSetups = () => project().setups.filter((setup) => setupFace(setup) === 'bottom')

// Looking at Bottom does not change the project (the review's finding 5):
// a clean Top-only project stays clean, Top-only and without an undo entry.
{
  resetStore()
  store().addRectFeature('Base', 0, 0, 100, 80, project().stock.thickness)
  useProjectStore.setState({ dirty: false, history: { past: [], future: [], transactionStart: null } })
  const before = project()
  const fileBefore = savedFile()
  assert(activeFace(before) === 'top', 'a new project is on Top')
  assert(!projectUsesBothFaces(before), 'a new project uses one face')

  assert(switchWorkspaceFace('bottom'), 'Bottom can be shown')
  assert(activeFace(project()) === 'bottom', 'the workspace is on Bottom')
  const shown = activeSetup(project())
  assert(shown.orientation.axis === 'x' && shown.orientation.angleDeg === 180, 'Bottom is shown flipped about X')
  assert(isProvisionalSetupActive(project()), 'the Bottom setup is provisional')
  assert(project().setups.length === 1 && bottomSetups().length === 0, 'looking at Bottom adds no setup')
  assert(sameDocument(project(), before), 'looking at Bottom changes nothing but the face in view')
  assert(store().dirty === false, 'looking at Bottom does not dirty the project')
  assert(store().history.past.length === 0, 'looking at Bottom is not an undo step')
  assert(savedFile() === fileBefore, 'a project that is only being looked at saves exactly as before')
  assert(projectUsesBothFaces(project()), 'the workspace shows both faces while Bottom is in view')

  switchWorkspaceFace('top')
  assert(project().activeSetupId === before.activeSetupId && sameDocument(project(), before), 'back on Top the project is what it was')
  assert(!projectUsesBothFaces(project()), 'and uses one face again')
  assert(store().dirty === false, 'looking at Bottom and back does not dirty the project')
  assert(store().history.past.length === 0, 'and leaves no undo step')

  // An edit that is not Bottom content leaves the setup provisional.
  switchWorkspaceFace('bottom')
  store().setProjectName('Renamed')
  assert(isProvisionalSetupActive(project()) && project().setups.length === 1, 'an edit that is not Bottom content leaves it provisional')
  assert(store().history.past.length === 1, 'fixture: the edit is one undo step')
  store().undo()
  assert(activeFace(project()) === 'bottom' && isProvisionalSetupActive(project()), 'undoing it leaves the workspace on Bottom')
  assert(savedFile() === fileBefore, 'and the project saves as before')
}

// The first feature drawn on Bottom makes the setup real, in the same undo step.
{
  resetStore()
  const thickness = project().stock.thickness
  switchWorkspaceFace('bottom')
  store().addRectFeature('Recess', 20, 20, 40, 30, thickness)
  assert(bottomSetups().length === 1, 'the first feature drawn on Bottom makes the setup real')
  const bottom = bottomSetups()[0]
  assert(bottom.orientation.axis === 'x' && bottom.orientation.angleDeg === 180, 'the new Bottom setup is flipped about X')
  assert(bottom.name === 'Bottom' && bottom.id !== activeSetup({ ...project(), setups: [] }).id, 'it is a setup of its own, named Bottom')
  assert(project().activeSetupId === bottom.id && !isProvisionalSetupActive(project()), 'the workspace is on the real setup')
  assert(lastFeature().authoringFace === 'bottom', 'the feature is authored on Bottom')
  assert(store().dirty === true, 'creating Bottom content dirties the project')
  assert(store().history.past.length === 1, 'the feature and its setup are one undo step')

  store().undo()
  assert(project().features.length === 0 && project().setups.length === 1, 'undo removes the feature and the setup together')
  assert(activeFace(project()) === 'bottom' && isProvisionalSetupActive(project()), 'undo leaves the workspace on Bottom')
  store().redo()
  assert(bottomSetups().length === 1 && bottomSetups()[0].id === bottom.id, 'redo brings the setup back')
  assert(project().activeSetupId === bottom.id, 'redo puts the workspace on the restored setup')
  assert(project().features.length === 1, 'and the feature with it')

  const setupCount = project().setups.length
  const pastCount = store().history.past.length
  useProjectStore.setState({ dirty: false })
  switchWorkspaceFace('top')
  switchWorkspaceFace('bottom')
  assert(project().setups.length === setupCount && project().activeSetupId === bottom.id, 'switching back and forth reuses the setup')
  assert(store().history.past.length === pastCount, 'switching face is not an undo step')
  assert(store().dirty === false, 'switching face does not dirty the project')
}

// An operation added on Bottom makes the setup real too.
{
  resetStore()
  store().addRectFeature('Base', 0, 0, 100, 80, project().stock.thickness)
  const baseId = lastFeature().id
  switchWorkspaceFace('bottom')
  const pastCount = store().history.past.length
  const operationId = store().addOperation('edge_route_outside', 'rough', { source: 'features', featureIds: [baseId] })
  assert(operationId !== null, 'fixture: an operation is added')
  assert(bottomSetups().length === 1, 'the first operation added on Bottom makes the setup real')
  const operation = project().operations.find((entry) => entry.id === operationId)!
  assert(operation.setupId === bottomSetups()[0].id, 'the operation belongs to the Bottom setup')
  assert(bottomSetups()[0].operationIds.join() === operationId, 'and the setup lists it')
  assert(store().history.past.length === pastCount + 1, 'the operation and its setup are one undo step')
  store().undo()
  assert(project().operations.length === 0 && bottomSetups().length === 0, 'undo removes the operation and the setup together')
}

// Editing the setup itself makes it real.
{
  resetStore()
  switchWorkspaceFace('bottom')
  store().renameSetup(activeSetup(project()).id, 'Underside')
  assert(bottomSetups().length === 1 && bottomSetups()[0].name === 'Underside', 'editing the setup makes it real')
  assert(project().activeSetupId === bottomSetups()[0].id, 'and the workspace stays on it')
  assert(store().history.past.length === 1 && store().dirty === true, 'as one undoable, dirtying edit')
}

// A project that already has a Bottom setup is switched to it, never to a provisional one.
{
  resetStore()
  const bottomId = store().createSetup({ orientation: orientationForFace('bottom', 'y') })
  assert(bottomId !== null, 'fixture: a Bottom setup')
  switchWorkspaceFace('bottom')
  assert(project().activeSetupId === bottomId && !isProvisionalSetupActive(project()), 'an existing Bottom setup is the one switched to')
}

// A restored snapshot is put on the face in view by `keepWorkspaceFace` itself,
// whatever the store's reconciler would do with the result afterwards.
{
  resetStore()
  const topOnly = project()
  const bottomId = store().createSetup({ orientation: orientationForFace('bottom', 'y') })
  assert(bottomId !== null, 'fixture: a Bottom setup')
  const bothFaces = project()
  const lookingAtBottom = { ...topOnly, activeSetupId: provisionalSetupId('bottom') }
  assert(keepWorkspaceFace(bothFaces, lookingAtBottom).activeSetupId === bottomId, 'a snapshot with a Bottom setup is restored onto it')
  assert(
    keepWorkspaceFace(topOnly, { ...bothFaces, activeSetupId: bottomId }).activeSetupId === provisionalSetupId('bottom'),
    'a snapshot without one is looked at provisionally',
  )
  assert(keepWorkspaceFace(bothFaces, topOnly).activeSetupId === topOnly.activeSetupId, 'a snapshot that has the setup in view stays on it')
}

// Cancelling a sketch edit restores a snapshot too, and stays on the face in view.
{
  resetStore()
  store().addRectFeature('Plate', 10, 10, 20, 10, project().stock.thickness)
  const plateId = lastFeature().id
  // A Bottom feature in a project with no Bottom setup: moved across from Top.
  store().setFeatureAuthoringFace([plateId], 'bottom')
  switchWorkspaceFace('bottom')
  assert(isProvisionalSetupActive(project()), 'fixture: Bottom is being looked at provisionally')
  store().enterSketchEdit(plateId)
  store().cancelSketchEdit()
  assert(activeFace(project()) === 'bottom', 'cancelling a sketch edit leaves the workspace on Bottom')
}

// ── The face stays put during an edit (the review's finding 1) ──

{
  resetStore()
  const thickness = project().stock.thickness
  store().addRectFeature('Base', 0, 0, 100, 80, thickness)
  const topId = lastFeature().id
  switchWorkspaceFace('bottom')
  store().addRectFeature('Recess', 20, 20, 40, 30, thickness)
  const bottomId = lastFeature().id
  const placed = () => resolveFeatureInstance(project(), bottomId)!.sketch.profile.start

  // A move is under way: its source point is picked.
  store().startMoveFeature(bottomId)
  store().setPendingMoveFrom({ x: 0, y: 0 })
  assert(store().pendingMove !== null, 'fixture: a move is pending')
  // Every caller goes through `switchWorkspaceFace` — the header control and
  // the ghost row's "Switch to top face to edit" alike.
  assert(!switchWorkspaceFace('top'), 'the face cannot be switched during a move')
  assert(activeFace(project()) === 'bottom', 'the workspace stays on the face the move started on')
  store().setFeatureAuthoringFace([bottomId], 'top')
  assert(project().features.find((feature) => feature.id === bottomId)!.authoringFace === 'bottom', 'a feature being moved keeps its face')

  const before = placed()
  store().completePendingMove({ x: 5, y: 3 })
  const after = placed()
  assert(near(after.x - before.x, 5) && near(after.y - before.y, 3), 'the move completes on the feature it started on')
  assert(!isGhostFeature(project(), project().features.find((feature) => feature.id === bottomId)!), 'which is not a ghost')
  const base = resolveFeatureInstance(project(), topId)!.sketch.profile.start
  assert(near(base.x, 0) && near(base.y, 0), 'and no ghost moved')

  assert(switchWorkspaceFace('top'), 'once the move is finished the face can be switched')
  store().enterSketchEdit(topId)
  assert(!switchWorkspaceFace('bottom'), 'the face cannot be switched during a sketch edit')
}

// ── New features take the active face and a span measured from it ──

{
  resetStore()
  const thickness = project().stock.thickness
  store().addRectFeature('Base', 0, 0, 100, 80, thickness)
  assert(lastFeature().authoringFace === 'top', 'a feature drawn on Top is authored on Top')

  switchWorkspaceFace('bottom')
  store().addRectFeature('Recess', 20, 20, 40, 30, thickness)
  const recess = lastFeature()
  assert(recess.authoringFace === 'bottom', 'a feature drawn on Bottom is authored on Bottom')
  assert(recess.z_top === thickness && recess.z_bottom === 0, 'a new Bottom feature spans the stock like a new Top one')
  assert(isThroughFeature(project(), resolveFeatureInstance(project(), recess.id)!), 'a full-depth cut goes through')
  assert(!isThroughFeature(project(), resolveFeatureInstance(project(), project().features[0].id)!), 'full-height material is not a through cut')

  // "Depth from bottom": written through the #944 helper, read back the same.
  const depth = thickness / 3
  const span = spanFromFaceDepth({ start: 0, end: depth }, 'bottom', project().stock)
  assert(span !== null, 'a depth from the bottom is a valid span')
  store().updateFeature(recess.id, span)
  const stored = project().features.find((feature) => feature.id === recess.id)!
  assert(stored.z_bottom === 0 && stored.z_top === depth, 'a Bottom pocket is stored as the stock span [0, depth]')
  const readBack = depthFromFace({ z_top: stored.z_top as number, z_bottom: stored.z_bottom as number }, 'bottom', project().stock)
  assert(readBack.start === 0 && readBack.end === depth, 'and reads back as that depth from the bottom')
  assert(!isThroughFeature(project(), resolveFeatureInstance(project(), recess.id)!), 'a partial-depth cut is not through')
  assert(spanFromFaceDepth({ start: depth * 2, end: depth }, 'bottom', project().stock) === null, 'an inside-out depth is refused, not swapped')

  // The Z range a Bottom feature shows is the stock flipped: the pocket reads
  // exactly as a pocket of the same depth cut from the top is stored.
  const flipped = flippedZRange({ z_top: depth, z_bottom: 0 }, project().stock)
  assert(flipped.top === thickness && near(flipped.bottom, thickness - depth), `a Bottom pocket reads like the same pocket on Top: got ${flipped.top} → ${flipped.bottom}`)
  const floating = flippedZRange({ z_top: thickness / 2, z_bottom: depth / 2 }, project().stock)
  assert(near(floating.top, thickness - depth / 2) && near(floating.bottom, thickness / 2), 'a floating Bottom feature keeps both ends when flipped')
  const backToStock = spanFromFaceDepth({ start: thickness - floating.top, end: thickness - floating.bottom }, 'bottom', project().stock)
  assert(backToStock !== null && near(backToStock.z_bottom, depth / 2) && near(backToStock.z_top, thickness / 2), 'and the flipped range maps back to the stored span')

  // A Line drawn inside the Bottom pocket engraves on its floor: from the
  // floor to the far face, not from the top of the stock.
  store().setCreationTarget('line')
  store().addRectFeature('Engraving', 25, 25, 10, 10, thickness)
  const line = lastFeature()
  assert(resolveFeatureInstance(project(), line.id)?.operation === 'line', 'the creation target makes a Line')
  assert(line.authoringFace === 'bottom', 'the Line is authored on Bottom')
  assert(line.z_bottom === depth && line.z_top === thickness, `a Line drawn in a Bottom pocket sits on its floor: got [${String(line.z_bottom)}, ${String(line.z_top)}]`)
  store().setCreationTarget('feature')

  // The same Line on Top sits on a Top pocket's floor, as it always did.
  switchWorkspaceFace('top')
  store().addRectFeature('Top pocket', 60, 40, 30, 30, thickness)
  const topPocket = lastFeature()
  const topFloor = thickness - depth
  store().updateFeature(topPocket.id, { z_bottom: topFloor })
  store().setCreationTarget('line')
  store().addRectFeature('Top engraving', 65, 45, 10, 10, thickness)
  const topLine = lastFeature()
  assert(topLine.authoringFace === 'top', 'the Top Line is authored on Top')
  assert(topLine.z_top === topFloor && topLine.z_bottom === 0, 'a Line drawn in a Top pocket keeps its Top span')
  store().setCreationTarget('feature')
}

// ── Ghosts cannot be selected ─────────────────────────────────

{
  resetStore()
  const thickness = project().stock.thickness
  store().addRectFeature('Base', 0, 0, 100, 80, thickness)
  const topId = lastFeature().id
  switchWorkspaceFace('bottom')
  store().addRectFeature('Recess', 20, 20, 40, 30, thickness)
  const bottomId = lastFeature().id

  assert(store().selection.selectedFeatureIds.join() === bottomId, 'a new feature is selected on its own face')
  assert(isGhostFeature(project(), project().features.find((feature) => feature.id === topId)!), 'the Top feature is a ghost on Bottom')
  assert(editableProjectFeatures(project()).map((feature) => feature.id).join() === bottomId, 'only the Bottom feature is editable on Bottom')

  store().selectFeature(topId)
  assert(!store().selection.selectedFeatureIds.includes(topId), 'a ghost cannot be selected')
  store().selectFeatures([topId, bottomId])
  assert(store().selection.selectedFeatureIds.join() === bottomId, 'a multi-selection leaves the ghosts out')
  store().hoverFeature(topId)
  assert(store().selection.hoveredFeatureId === null, 'a ghost cannot be hovered')

  store().selectFeature(bottomId)
  switchWorkspaceFace('top')
  assert(store().selection.selectedFeatureIds.length === 0, 'switching face drops the selection that became a ghost')
  assert(store().selection.selectedNode === null, 'and its primary node')

  // Changing a feature's face changes nothing but the face.
  store().selectFeature(topId)
  const before = project().features.find((feature) => feature.id === topId)!
  store().setFeatureAuthoringFace([topId], 'bottom')
  const after = project().features.find((feature) => feature.id === topId)!
  assert(after.authoringFace === 'bottom', 'the feature moved to Bottom')
  assert(after.z_top === before.z_top && after.z_bottom === before.z_bottom, 'its stock span is untouched')
  assert(store().selection.selectedFeatureIds.length === 0, 'a feature moved to the other face is no longer selected')
}

// ── A linked copy is one shape on both faces ──────────────────

// The maintainer's decision on the review's finding 6: a linked copy is the
// same shape wherever it sits. Moving a copy to the other face keeps the
// link, and editing one copy changes all of them — the copy on the other
// face included. The ghost guard still keeps that copy from being picked.
// What the UI owes the user is the count, which `linkedCopiesOffFace` gives.
{
  resetStore()
  const thickness = project().stock.thickness
  store().addRectFeature('Plate', 10, 10, 20, 10, thickness)
  const originalId = lastFeature().id
  for (const offset of [40, 80]) {
    store().startCopyFeature(originalId, 'reference')
    store().setPendingMoveFrom({ x: 0, y: 0 })
    store().completePendingMove({ x: offset, y: 0 }, 1)
  }
  const [, secondId, thirdId] = project().features.map((feature) => feature.id)
  const definitionOf = (id: string) => getDefinitionId(project().features.find((feature) => feature.id === id)!)
  const sizeOf = (id: string) => {
    const bounds = getProfileBounds(resolveFeatureInstance(project(), id)!.sketch.profile)
    return `${bounds.maxX - bounds.minX} × ${bounds.maxY - bounds.minY}`
  }
  assert(project().features.length === 3 && definitionOf(secondId) === definitionOf(originalId), 'fixture: three linked copies of one shape')
  assert(linkedCopiesOffFace(project(), [originalId], 'top') === 0, 'copies on the same face are not counted')

  // Before the move the confirmation counts the copies that will stay behind.
  assert(linkedCopiesOffFace(project(), [thirdId], 'bottom') === 2, 'moving one copy to Bottom leaves two linked copies on Top')
  assert(linkedCopiesOffFace(project(), [secondId, thirdId], 'bottom') === 1, 'moving two leaves one, and the moved ones are not counted')
  assert(linkedCopiesOffFace(project(), [originalId, secondId, thirdId], 'bottom') === 0, 'moving them all leaves none')

  store().setFeatureAuthoringFace([thirdId], 'bottom')
  assert(project().features.find((feature) => feature.id === thirdId)!.authoringFace === 'bottom', 'fixture: the copy is on Bottom')
  assert(definitionOf(thirdId) === definitionOf(originalId), 'a linked copy moved to the other face keeps its link')
  assert(linkedCopiesOffFace(project(), [thirdId], 'bottom') === 2, 'the Bottom copy shares its shape with two copies on Top')
  assert(linkedCopiesOffFace(project(), [originalId], 'top') === 1, 'a Top copy shares its shape with one copy on Bottom')

  // Editing the shape on Bottom changes the Top copies too: intended.
  const pastBeforeLooking = store().history.past.length
  switchWorkspaceFace('bottom')
  assert(
    isProvisionalSetupActive(project()) && store().history.past.length === pastBeforeLooking,
    'looking at Bottom makes no setup, even when a feature is already authored there',
  )
  store().selectFeature(thirdId)
  const edited = resolveFeatureInstance(project(), thirdId)!
  store().updateFeature(thirdId, { sketch: { ...edited.sketch, profile: rectProfile(10, 10, 40, 30) } })
  assert(sizeOf(thirdId) === '40 × 30', 'fixture: the Bottom copy is edited')
  assert(sizeOf(originalId) === '40 × 30' && sizeOf(secondId) === '40 × 30', 'editing a linked copy changes the copies on the other face')
  store().selectFeature(originalId)
  assert(!store().selection.selectedFeatureIds.includes(originalId), 'the copies on the other face are still ghosts')

  // Make unique is the way out of the link, on either face.
  store().makeUnique(thirdId)
  assert(definitionOf(thirdId) !== definitionOf(originalId), 'make unique detaches the copy')
  assert(linkedCopiesOffFace(project(), [thirdId], 'bottom') === 0, 'and it no longer shares a shape across the faces')
  assert(linkedCopiesOffFace(project(), [originalId], 'top') === 0, 'in either direction')
}

// ── Text reads the right way round from below ─────────────────

for (const axis of ['x', 'y'] as const) {
  resetStore()
  const config = { ...defaultTextToolConfig('mm'), text: 'F' }
  const anchor = { x: 30, y: 40 }

  store().startAddTextPlacement(config)
  const [topId] = store().placePendingTextAt(anchor)
  const topFeature = resolveFeatureInstance(project(), topId)!
  const topView = computeSketchViewTransform(project(), 800, 600, { zoom: 1, panX: 0, panY: 0 })
  const topAnchor = worldToCanvas(anchor, topView)

  // Flipped about X is what a first look at Bottom shows; about Y is a setup of its own.
  if (axis === 'y') store().createSetup({ orientation: orientationForFace('bottom', 'y') })
  switchWorkspaceFace('bottom')
  assert(activeSetup(project()).orientation.axis === axis, `fixture: Bottom is flipped about ${axis}`)
  store().startAddTextPlacement(config)
  const [bottomTextId] = store().placePendingTextAt(anchor)
  const bottomFeature = resolveFeatureInstance(project(), bottomTextId)!
  const bottomView = computeSketchViewTransform(project(), 800, 600, { zoom: 1, panX: 0, panY: 0 })
  const bottomAnchor = worldToCanvas(anchor, bottomView)
  assert(bottomFeature.authoringFace === 'bottom', `flip about ${axis}: text placed on Bottom is authored on Bottom`)

  // On screen, each glyph point sits at the same offset from the click on
  // Bottom as on Top: mirrored once by the feature, once back by the view.
  const topPoints = resolveTextFeatureShapes(topFeature).flatMap((shape) => [shape.profile.start, ...shape.profile.segments.map((segment) => segment.to)])
  const bottomPoints = resolveTextFeatureShapes(bottomFeature).flatMap((shape) => [shape.profile.start, ...shape.profile.segments.map((segment) => segment.to)])
  assert(topPoints.length > 3 && topPoints.length === bottomPoints.length, `flip about ${axis}: the same glyph outline on both faces`)
  topPoints.forEach((point, index) => {
    const onTop = worldToCanvas(point, topView)
    const onBottom = worldToCanvas(bottomPoints[index], bottomView)
    assert(
      Math.abs((onTop.cx - topAnchor.cx) - (onBottom.cx - bottomAnchor.cx)) < 1e-6
        && Math.abs((onTop.cy - topAnchor.cy) - (onBottom.cy - bottomAnchor.cy)) < 1e-6,
      `flip about ${axis}: Bottom text reads the right way round (glyph point ${index})`,
    )
  })
  // In stock space it is mirrored: seen through the stock from above, it reads backwards.
  const topBounds = getProfileBounds(topFeature.sketch.profile)
  const bottomBounds = getProfileBounds(bottomFeature.sketch.profile)
  assert(
    axis === 'x' ? !near(topBounds.minY, bottomBounds.minY) : !near(topBounds.minX, bottomBounds.minX),
    `flip about ${axis}: in stock space the Bottom run is the mirror image`,
  )
}

// ── Paste and the origin follow the face ──────────────────────

{
  resetStore()
  const thickness = project().stock.thickness
  store().addRectFeature('Base', 10, 10, 30, 20, thickness)
  const clipboard = resolvedProjectFeatures(project()).filter((feature) => feature.id === lastFeature().id)
  switchWorkspaceFace('bottom')
  const pasted = pasteClipboardFeatures(store(), clipboard, { x: 60, y: 40 })
  assert(pasted.length === 1, 'the copy is pasted')
  assert(project().features.find((feature) => feature.id === pasted[0])?.authoringFace === 'bottom', 'a paste lands on the active face')
  assert(bottomSetups().length === 1 && !isProvisionalSetupActive(project()), 'and, as the first Bottom content, makes the Bottom setup real')
  assert(store().selection.selectedFeatureIds.join() === pasted.join(), 'and is selected there')
}

{
  resetStore()
  switchWorkspaceFace('bottom')
  const view = computeSketchViewTransform(project(), 800, 600, { zoom: 1, panX: 0, panY: 0 })
  const picked = { x: 12, y: 7 }
  store().placeOriginAt(picked)
  const shown = activeOriginInStock(project())
  assert(near(shown.x, picked.x) && near(shown.y, picked.y), 'an origin placed on Bottom is shown where it was picked')
  const pickedOnScreen = worldToCanvas(picked, view)

  switchWorkspaceFace('top')
  const topView = computeSketchViewTransform(project(), 800, 600, { zoom: 1, panX: 0, panY: 0 })
  const topOrigin = activeOriginInStock(project())
  const onTopScreen = worldToCanvas(topOrigin, topView)
  assert(
    near(onTopScreen.cx, pickedOnScreen.cx) && near(onTopScreen.cy, pickedOnScreen.cy),
    'the shared origin keeps its place on screen when the face changes',
  )
  assert(!near(topOrigin.y, picked.y), 'an origin placed on Bottom is stored relative to the face, not as the stock point')
}

console.log('workspaceFace tests passed')
