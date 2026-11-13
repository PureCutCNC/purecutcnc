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
 * The sketch on a turned-over stock (issue #945): the oriented view
 * transform for both flip axes, and ghost features staying out of
 * hit-testing and snapping.
 *
 * Mutations these assertions were checked against:
 * - `worldToCanvas` ignoring the mirror → "a Bottom view draws a stock point
 *   where the setup-local frame puts it" fails;
 * - `canvasToWorld` ignoring the mirror → "the pointer maps back" fails;
 * - `viewMirrorForOrientation` always mirroring Y → the flip-about-Y case fails;
 * - `worldArcToCanvas` keeping the sweep direction → "an arc keeps its
 *   mid-point" fails;
 * - `editableFeatures` returning every feature → the hit-test, segment and
 *   snap assertions fail;
 * - `computeFitViewState` fitting stock-space bounds → "fit frames the
 *   feature where it is drawn" fails.
 *
 * Run with: npx tsx src/components/canvas/faceView.test.ts
 */

import { canonicalToSetupPoint, setupFrame } from '../../engine/setupOrientation'
import { DEFAULT_SNAP_SETTINGS } from '../../sketch/snapping'
import { referenceProjectFeatures } from '../../store/helpers/referenceFeatures'
import { editableProjectFeatures } from '../../store/helpers/activeFace'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { BOTTOM_SETUP_ID, projectWithFeatures, withBottomSetup } from '../../test/projectFixtures'
import { DEFAULT_SETUP_ID, getProfileBounds, getStockBounds, newProject, rectProfile, roundStock } from '../../types/project'
import type { MachiningSetup, Point, Project, RoundStock, SetupFace, SketchFeature } from '../../types/project'
import { aroundSheet } from './aroundSheet'
import { drawOtherFace } from './faceOverlay'
import { findHitFeatureId, segmentHitTest } from './hitTest'
import { resolveSketchSnap } from './snappingHelpers'
import {
  canvasToWorld,
  computeFitViewState,
  computeSketchLocalTransform,
  computeSketchViewTransform,
  computeViewTransform,
  sketchViewStock,
  viewIsMirrored,
  viewMirrorForOrientation,
  worldArcToCanvas,
  worldToCanvas,
} from './viewTransform'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function near(a: number, b: number, epsilon = 1e-9): boolean {
  return Math.abs(a - b) <= epsilon
}

const CANVAS_W = 800
const CANVAS_H = 600
const VIEW = { zoom: 1.7, panX: 13, panY: -21 }

function makeFeature(id: string, face: SetupFace, profile = rectProfile(10, 10, 30, 20)): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    // Blind: the ghost cases here are features that cannot be a target from
    // the other face now that a through subtract can (issue #1112 I).
    z_top: 0.5,
    z_bottom: 0.1,
    authoringFace: face,
    visible: true,
    locked: false,
  }
}

function projectOn(face: SetupFace, axis: 'x' | 'y' = 'x', features: SketchFeature[] = []): Project {
  const base = withBottomSetup(projectWithFeatures(newProject(), features), { axis })
  return { ...base, activeSetupId: face === 'top' ? DEFAULT_SETUP_ID : BOTTOM_SETUP_ID }
}

/** A round bar with an Around setup in view (issue #395). */
function projectAround(stock: RoundStock, features: SketchFeature[] = []): Project {
  const base = projectWithFeatures(newProject(), features)
  const setup: MachiningSetup = {
    id: 'setup-around',
    name: 'Around',
    kind: 'around',
    orientation: { axis: stock.axis, angleDeg: 0 },
    indexing: 'manual',
    registration: [],
    notes: '',
    operationIds: [],
  }
  return { ...base, stock, setups: [...base.setups, setup], activeSetupId: setup.id }
}

// ── The oriented view transform ───────────────────────────────

for (const axis of ['x', 'y'] as const) {
  const project = projectOn('bottom', axis)
  const orientation = { axis, angleDeg: 180 }
  const frame = setupFrame(orientation, project.stock)
  const plain = computeViewTransform(project.stock, CANVAS_W, CANVAS_H, VIEW)
  const turned = computeSketchViewTransform(project, CANVAS_W, CANVAS_H, VIEW)
  const mirror = viewMirrorForOrientation(orientation, project.stock)

  assert((mirror.mirrorX === undefined) === (axis === 'x'), `flip about ${axis}: only the other axis is mirrored (X)`)
  assert((mirror.mirrorY === undefined) === (axis === 'y'), `flip about ${axis}: only the other axis is mirrored (Y)`)
  assert(viewIsMirrored(turned), `flip about ${axis}: the view is mirrored`)

  for (const point of [{ x: 0, y: 0 }, { x: 12.5, y: 71 }, { x: -40, y: 300 }] as Point[]) {
    // The view is the stock as it sits on the machine: the #944 transform,
    // then the same pan/zoom a Top view uses.
    const local = canonicalToSetupPoint({ x: point.x, y: point.y, z: 0 }, frame)
    const expected = worldToCanvas({ x: local.x, y: local.y }, plain)
    const drawn = worldToCanvas(point, turned)
    assert(
      near(drawn.cx, expected.cx) && near(drawn.cy, expected.cy),
      `flip about ${axis}: a Bottom view draws a stock point where the setup-local frame puts it`,
    )
    const back = canvasToWorld(drawn.cx, drawn.cy, turned)
    assert(near(back.x, point.x) && near(back.y, point.y), `flip about ${axis}: the pointer maps back to the stock point`)
  }

  // The stock itself stays put: its centre lands on the same canvas point.
  const centre = { x: frame.pivot.x, y: frame.pivot.y }
  const centreTop = worldToCanvas(centre, plain)
  const centreBottom = worldToCanvas(centre, turned)
  assert(near(centreTop.cx, centreBottom.cx) && near(centreTop.cy, centreBottom.cy), `flip about ${axis}: the stock centre does not move on screen`)

  // An arc from angle 0 to 90° counter-clockwise (canvas sense) keeps its
  // mid-point after the mirror: the sweep reverses with the angles.
  const [start, end, counterclockwise] = worldArcToCanvas(0, Math.PI / 2, false, turned)
  const turn = (angle: number) => ((angle % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const midAngle = counterclockwise ? start - turn(start - end) / 2 : start + turn(end - start) / 2
  const worldMid = { x: 100 + Math.cos(Math.PI / 4) * 10, y: 100 + Math.sin(Math.PI / 4) * 10 }
  const centreCanvas = worldToCanvas({ x: 100, y: 100 }, turned)
  const expectedMid = worldToCanvas(worldMid, turned)
  const radius = 10 * turned.scale
  assert(
    near(centreCanvas.cx + Math.cos(midAngle) * radius, expectedMid.cx, 1e-6)
      && near(centreCanvas.cy + Math.sin(midAngle) * radius, expectedMid.cy, 1e-6),
    `flip about ${axis}: an arc keeps its mid-point in the mirrored view`,
  )
}

{
  const project = projectOn('top')
  const plain = computeViewTransform(project.stock, CANVAS_W, CANVAS_H, VIEW)
  const top = computeSketchViewTransform(project, CANVAS_W, CANVAS_H, VIEW)
  assert(JSON.stringify(top) === JSON.stringify(plain), 'a Top view is the unmirrored transform, unchanged')
  assert(JSON.stringify(worldArcToCanvas(0.3, 1.2, true, top)) === JSON.stringify([0.3, 1.2, true]), 'a Top view leaves arcs alone')
}

// Fit frames the feature where it is drawn, not where it is stored: a feature
// far off the stock along the mirrored axis is on screen after the fit.
for (const axis of ['x', 'y'] as const) {
  const profile = axis === 'y' ? rectProfile(300, 10, 40, 20) : rectProfile(10, 300, 40, 20)
  const project = projectOn('bottom', axis, [makeFeature('f1', 'bottom', profile)])
  const fitted = computeFitViewState(project, CANVAS_W, CANVAS_H)
  const vt = computeSketchViewTransform(project, CANVAS_W, CANVAS_H, fitted)
  const corners = axis === 'y' ? [{ x: 300, y: 10 }, { x: 340, y: 30 }] : [{ x: 10, y: 300 }, { x: 50, y: 320 }]
  for (const corner of corners) {
    const c = worldToCanvas(corner, vt)
    assert(
      c.cx >= 0 && c.cx <= CANVAS_W && c.cy >= 0 && c.cy <= CANVAS_H,
      `flip about ${axis}: fit frames the feature where it is drawn`,
    )
  }
}

// ── Ghost features: no hit-testing, no snapping ───────────────

{
  const topFeature = makeFeature('top-pocket', 'top', rectProfile(10, 10, 30, 20))
  const bottomFeature = makeFeature('bottom-pocket', 'bottom', rectProfile(60, 10, 30, 20))
  const vt = { scale: 1, offsetX: 0, offsetY: 0 }
  const inTop = { x: 25, y: 20 }
  const inBottom = { x: 75, y: 20 }
  const snapSettings = { ...DEFAULT_SNAP_SETTINGS, enabled: true, modes: ['point' as const], pixelRadius: 6 }

  for (const face of ['top', 'bottom'] as const) {
    const project = projectOn(face, 'x', [topFeature, bottomFeature])
    const own = face === 'top' ? topFeature : bottomFeature
    const ghost = face === 'top' ? bottomFeature : topFeature
    const inOwn = face === 'top' ? inTop : inBottom
    const inGhost = face === 'top' ? inBottom : inTop
    const editable = editableProjectFeatures(project)

    assert(editable.length === 1 && editable[0].id === own.id, `on ${face}: only this face's features are editable`)
    assert(findHitFeatureId(inOwn, editable, vt) === own.id, `on ${face}: this face's feature is hit`)
    assert(findHitFeatureId(inGhost, editable, vt) === null, `on ${face}: the ghost is not hit`)

    const ownCorner = face === 'top' ? { x: 10, y: 10 } : { x: 60, y: 10 }
    const ghostCorner = face === 'top' ? { x: 60, y: 10 } : { x: 10, y: 10 }
    const ghostEdge = { x: ghostCorner.x + 15, y: ghostCorner.y }
    assert(segmentHitTest({ x: ownCorner.x + 15, y: ownCorner.y }, project, vt, { openOnly: false })?.featureId === own.id, `on ${face}: this face's edge is hit`)
    assert(segmentHitTest(ghostEdge, project, vt, { openOnly: false }) === null, `on ${face}: a ghost edge is not hit`)

    const snapOwn = resolveSketchSnap({ rawPoint: { x: ownCorner.x + 1, y: ownCorner.y + 1 }, vt, snapSettings, project, referencePoint: null })
    assert(snapOwn.mode === 'point' && near(snapOwn.point.x, ownCorner.x) && near(snapOwn.point.y, ownCorner.y), `on ${face}: this face's corner is a snap target`)
    const snapGhost = resolveSketchSnap({ rawPoint: { x: ghostCorner.x + 1, y: ghostCorner.y + 1 }, vt, snapSettings, project, referencePoint: null })
    assert(snapGhost.mode === null, `on ${face}: a ghost corner is not a snap target (ghost ${ghost.id})`)
  }

  // A Top-only project takes the unfiltered path: same array, nothing dropped.
  const topOnly = projectWithFeatures(newProject(), [topFeature])
  assert(editableProjectFeatures(topOnly).length === 1, 'a Top-only project keeps every feature editable')
}

// Explicit construction references keep canonical points, indices and parameters.
for (const face of ['top', 'bottom'] as const) {
  for (const axis of ['x', 'y'] as const) {
    for (const units of ['mm', 'inch'] as const) {
      const guide = makeFeature('reference-guide', face === 'top' ? 'bottom' : 'top', rectProfile(13, 21, 7, 4))
      guide.operation = 'construction'
      guide.locked = true
      const project = projectOn(face, axis, [guide])
      project.meta.units = units
      project.features[0].transform = { a: 0, b: 1, c: -1, d: 0, e: 70, f: 10 }
      const snapshot = JSON.stringify(project)
      const vt = computeSketchViewTransform(project, CANVAS_W, CANVAS_H, VIEW)
      const canonical = { x: 49, y: 23 }
      const drawn = worldToCanvas(canonical, vt)
      const pointer = canvasToWorld(drawn.cx + 0.3, drawn.cy - 0.2, vt)
      const settings = { enabled: true, modes: ['point' as const], pixelRadius: 6 }
      const input = { rawPoint: pointer, vt, snapSettings: settings, project, referencePoint: null }
      const candidates = referenceProjectFeatures(project, true)
      const snap = resolveSketchSnap({ ...input, referenceFeatures: candidates })
      assert(snap.mode === 'point' && near(snap.point.x, canonical.x) && near(snap.point.y, canonical.y), `${face}/${axis}/${units}: reference snap is canonical, mirrored only by the view`)
      assert(snap.anchor?.kind === 'vertex' && snap.anchor.target.source === 'feature' && snap.anchor.target.featureId === guide.id && snap.anchor.vertexIndex === 0, 'reference snap keeps its source vertex identity')
      const segmentCanvas = worldToCanvas({ x: 49, y: 26.5 }, vt)
      const segmentPointer = canvasToWorld(segmentCanvas.cx, segmentCanvas.cy, vt)
      const hit = segmentHitTest(segmentPointer, project, vt, { openOnly: false, referenceFeatures: candidates })
      assert(hit?.featureId === guide.id && hit.segmentIndex === 0 && near(hit.t, 0.5), `${face}/${axis}/${units}: reference edge retains canonical segment index and t`)
      assert(segmentHitTest(segmentPointer, project, vt, { openOnly: false }) === null, 'default segment subject picker stays edit-only')
      assert(resolveSketchSnap(input).mode === null, 'ordinary snapping keeps ghosts excluded')
      assert(resolveSketchSnap({ ...input, referenceFeatures: referenceProjectFeatures(project, false) }).mode === null, 'hidden other-side overlay cannot snap')
      assert(segmentHitTest(segmentPointer, project, vt, { openOnly: false, referenceFeatures: referenceProjectFeatures(project, false) }) === null, 'hidden other-side overlay cannot hit')
      assert(JSON.stringify(project) === snapshot, 'all reference queries are read-only')
      project.features[0].visible = false
      assert(resolveSketchSnap({ ...input, referenceFeatures: referenceProjectFeatures(project, true) }).mode === null, 'hidden construction cannot snap even with the overlay on')
      assert(segmentHitTest(segmentPointer, project, vt, { openOnly: false, referenceFeatures: referenceProjectFeatures(project, true) }) === null, 'hidden construction cannot hit')
    }
  }
}

// ── Around: the unrolled sheet, never mirrored ────────────────

for (const axis of ['x', 'y'] as const) {
  const stock = axis === 'x' ? roundStock(0.75, 4, 'x', { x: 0, y: 0 }) : roundStock(20, 60, 'y', { x: 5, y: 0 })
  const project = projectAround(stock)

  const vt = computeSketchViewTransform(project, CANVAS_W, CANVAS_H, VIEW)
  assert(!viewIsMirrored(vt), `Around/${axis}: the sheet is not a half-turn mirror`)
  assert(vt.mirrorX === undefined && vt.mirrorY === undefined, `Around/${axis}: the view is never mirrored`)
  // Unmirrored, so every other face-path helper behaves as on Top.
  assert(JSON.stringify(vt) === JSON.stringify(computeSketchLocalTransform(project, CANVAS_W, CANVAS_H, VIEW)),
    `Around/${axis}: the drawn view is the unmirrored setup-local view`)

  const sheet = aroundSheet(project)
  assert(sheet !== null, `Around/${axis}: a bar on Around has a sheet`)
  const rect = sheet!.rect
  const acrossExtent = axis === 'x' ? rect.maxY - rect.minY : rect.maxX - rect.minX
  assert(near(acrossExtent, Math.PI * stock.thickness), `Around/${axis}: the frame is one circumference across`)

  // Fit-to-view fits the sheet. The bar's own rectangle is a different
  // rectangle (the sheet is inscribed in the bar's centreline, so its across
  // extent is the circumference), and the sheet fit keeps all four corners on
  // screen.
  const fittedView = computeSketchViewTransform(project, CANVAS_W, CANVAS_H, computeFitViewState(project, CANVAS_W, CANVAS_H))
  const farCorner = { x: rect.maxX, y: rect.maxY }
  const onScreen = (point: { cx: number; cy: number }): boolean =>
    point.cx >= -1e-6 && point.cx <= CANVAS_W + 1e-6 && point.cy >= -1e-6 && point.cy <= CANVAS_H + 1e-6
  for (const corner of [
    { x: rect.minX, y: rect.minY }, { x: rect.maxX, y: rect.minY },
    { x: rect.minX, y: rect.maxY }, farCorner,
  ]) {
    assert(onScreen(worldToCanvas(corner, fittedView)), `Around/${axis}: the sheet fit shows the whole sheet (${corner.x}, ${corner.y})`)
  }
  const sheetCorners = [
    { x: rect.minX, y: rect.minY }, { x: rect.maxX, y: rect.minY },
    { x: rect.minX, y: rect.maxY }, farCorner,
  ]
  // A fit that framed the bar's own rectangle instead would frame a different
  // rectangle: the fit frames the sheet, never the bar (issue #1026).
  const barBounds = getStockBounds(project.stock)
  const sheetBounds = getProfileBounds(sketchViewStock(project).profile)
  assert(
    JSON.stringify(sheetBounds) === JSON.stringify({
      minX: rect.minX, maxX: rect.maxX, minY: rect.minY, maxY: rect.maxY,
    }),
    `Around/${axis}: the fit frames the sheet's own rectangle`,
  )
  assert(
    JSON.stringify(sheetBounds) !== JSON.stringify(barBounds),
    `Around/${axis}: the bar rectangle is not the sheet rectangle`,
  )
  // The sheet's across extent exceeds the bar's own thickness, so the bar's
  // rectangle cannot cover the sheet: at least one of its four corners is
  // outside the bar profile's bounds.
  assert(
    sheetCorners.some((corner) => corner.x < barBounds.minX || corner.x > barBounds.maxX
      || corner.y < barBounds.minY || corner.y > barBounds.maxY),
    `Around/${axis}: the bar rectangle cannot cover the sheet`,
  )

  // The sheet is the frame; on Top the stock is its own.
  assert(sketchViewStock(project) !== project.stock, `Around/${axis}: the view frames the sheet, not the bar`)
  const top = { ...project, activeSetupId: DEFAULT_SETUP_ID }
  assert(sketchViewStock(top) === top.stock, `Around/${axis}: on Top the stock is its own frame`)
  assert(JSON.stringify(computeSketchViewTransform(top, CANVAS_W, CANVAS_H, VIEW))
    === JSON.stringify(computeViewTransform(top.stock, CANVAS_W, CANVAS_H, VIEW)),
    `Around/${axis}: a Top view of the same project is unchanged`)
}

// ── Around: no ghost of a flat face, and no reference from one ─

{
  const sheetFeature = makeFeature('sheet-pocket', 'around', rectProfile(0, 0, 1, Math.PI * 0.75))
  const stock = roundStock(0.75, 4, 'x', { x: 0, y: 0 })
  const project = projectAround(stock, [sheetFeature])
  const sheetOnly = referenceProjectFeatures(project, true)
  assert(sheetOnly.length === 1 && sheetOnly[0].id === sheetFeature.id, 'Around: its own feature is the only reference')

  const flatFeature = makeFeature('top-pocket', 'top', rectProfile(0, 0, 1, 1))
  const mixed = projectAround(stock, [sheetFeature, flatFeature])
  const onAround = referenceProjectFeatures(mixed, true)
  assert(onAround.length === 1 && onAround[0].id === sheetFeature.id, 'Around: a flat feature is not offered as a reference')
  const onTop = referenceProjectFeatures({ ...mixed, activeSetupId: DEFAULT_SETUP_ID }, true)
  assert(onTop.length === 1 && onTop[0].id === flatFeature.id, 'Top: a sheet feature is not offered as a reference either')
}

// ── Around: a flat feature is neither drawn as a ghost nor hit ─

{
  function countingContext(): { ctx: CanvasRenderingContext2D; strokes: () => number } {
    let strokes = 0
    const noop = (): void => undefined
    const ctx = {
      save: noop, restore: noop, setLineDash: noop, beginPath: noop, moveTo: noop,
      lineTo: noop, closePath: noop, arc: noop, fill: noop, fillText: noop,
      stroke: () => { strokes += 1 },
      measureText: () => ({ width: 0 }),
      lineWidth: 0, strokeStyle: '', fillStyle: '', font: '', textAlign: '', textBaseline: '',
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D
    return { ctx, strokes: () => strokes }
  }
  // A coarse scale keeps the hit test's pixel tolerance from reaching the
  // neighbouring shape.
  const vt = { scale: 100, offsetX: 0, offsetY: 0 }
  const sheetFeature = makeFeature('sheet', 'around', rectProfile(2, 0, 1, 1))
  const flatFeature = makeFeature('flat', 'top', rectProfile(0, 0, 1, 1))
  const stock = roundStock(0.75, 4, 'x', { x: 0, y: 0 })
  const mixed = projectAround(stock, [sheetFeature, flatFeature])
  const features = resolvedProjectFeatures(mixed)

  const onAround = countingContext()
  drawOtherFace(onAround.ctx, mixed, features, vt, true, 'THRU', 'Top origin')
  assert(onAround.strokes() === 0, 'on Around no flat feature is drawn as a ghost, even with other side on')

  const onTop = countingContext()
  const topProject = { ...mixed, activeSetupId: DEFAULT_SETUP_ID }
  drawOtherFace(onTop.ctx, topProject, features, vt, true, 'THRU', 'Top origin')
  assert(onTop.strokes() === 0, 'on Top the sheet feature is not drawn as a ghost either')

  const editable = editableProjectFeatures(mixed)
  assert(editable.length === 1 && editable[0].id === sheetFeature.id, 'on Around only the sheet feature is editable')
  assert(findHitFeatureId({ x: 0.5, y: 0.5 }, editable, vt) === null, 'on Around a flat feature is not hit')
  assert(findHitFeatureId({ x: 2.5, y: 0.5 }, editable, vt) === sheetFeature.id, 'on Around the sheet feature is hit')
  assert(findHitFeatureId({ x: 2.5, y: 0.5 }, editableProjectFeatures(topProject), vt) === null, 'on Top the sheet feature is not hit')
}

console.log('faceView tests passed')
