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
 * - `switchWorkspaceFace` not creating the Bottom setup → "the first switch
 *   to Bottom creates the setup" fails;
 * - `placeOriginAt` storing the stock-space point on Bottom → "an origin
 *   placed on Bottom" fails;
 * - paste keeping the source's face → "a paste lands on the active face" fails.
 *
 * Run with: npx tsx src/store/workspaceFace.test.ts
 */

import { depthFromFace, setupFace, spanFromFaceDepth } from '../engine/setupOrientation'
import { computeSketchViewTransform, worldToCanvas } from '../components/canvas/viewTransform'
import { pasteClipboardFeatures } from '../platform/featureClipboard'
import { defaultTextToolConfig, resolveTextFeatureShapes } from '../text'
import { getProfileBounds, newProject } from '../types/project'
import type { Project } from '../types/project'
import {
  activeFace,
  activeOriginInStock,
  editableProjectFeatures,
  flippedZRange,
  isGhostFeature,
  isThroughFeature,
  projectUsesBothFaces,
} from './helpers/activeFace'
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

{
  resetStore()
  assert(activeFace(project()) === 'top', 'a new project is on Top')
  assert(!projectUsesBothFaces(project()), 'a new project uses one face')

  assert(switchWorkspaceFace('bottom'), 'Bottom can be shown')
  const bottom = project().setups.find((setup) => setupFace(setup) === 'bottom')
  assert(bottom !== undefined, 'the first switch to Bottom creates the setup')
  assert(bottom.orientation.axis === 'x' && bottom.orientation.angleDeg === 180, 'the new Bottom setup is flipped about X')
  assert(project().activeSetupId === bottom.id && activeFace(project()) === 'bottom', 'the workspace is on Bottom')
  assert(projectUsesBothFaces(project()), 'the project now uses both faces')
  assert(store().history.past.length === 1, 'creating the Bottom setup is one undo step')

  const setupCount = project().setups.length
  useProjectStore.setState({ dirty: false })
  switchWorkspaceFace('top')
  switchWorkspaceFace('bottom')
  assert(project().setups.length === setupCount, 'switching back and forth reuses the setups')
  assert(store().history.past.length === 1, 'switching face is not an undo step')
  assert(store().dirty === false, 'switching face does not dirty the project')
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

  switchWorkspaceFace('bottom')
  if (axis === 'y') {
    const bottomId = project().activeSetupId
    useProjectStore.setState({
      project: {
        ...project(),
        setups: project().setups.map((setup) => (
          setup.id === bottomId ? { ...setup, orientation: { axis: 'y', angleDeg: 180 } } : setup
        )),
      },
    })
  }
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
