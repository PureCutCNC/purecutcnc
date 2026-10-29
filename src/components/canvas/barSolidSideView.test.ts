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
 * Turn and Polygon on a flat face (issue #1112 rt2-d, item 19): the solid's
 * side view, drawn dashed and read-only, on Top and Bottom, on both bar axes,
 * both bar shapes, and in both unit systems.
 *
 * Mutations these assertions were checked against:
 * - drawing the model's flat placement rectangle instead of its side view →
 *   the stepped-profile point assertions fail;
 * - ignoring the Polygon's rotation → its across-width assertions fail;
 * - drawing stock-space points without the Bottom view transform → "a Bottom
 *   view draws the side view where the flipped stock puts it" fails;
 * - hit-testing the placement frame rather than the silhouette → "the space a
 *   stepped Turn does not fill is not clickable" fails;
 * - drawing a sheet feature on a flat face as well → "on a flat face only the
 *   solid is drawn" fails;
 * - drawing on the Around sheet too → "on Around the sheet draws its own
 *   features, not a side view" fails.
 *
 * Run with: npx tsx src/components/canvas/barSolidSideView.test.ts
 */

import assert from 'node:assert/strict'
import { squareStock } from '../../types/barStock'
import {
  newProject,
  roundStock,
  sampleProfilePoints,
  type Point,
  type Project,
  type SketchFeature,
  type SketchProfile,
} from '../../types/project'
import { BOTTOM_SETUP_ID, projectWithFeatures, withBottomSetup } from '../../test/projectFixtures'
import { planRotarySolid } from '../../store/helpers/rotarySolids'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import type { SelectionState } from '../../store/types'
import { getFeatureGeometryProfiles } from '../../text'
import { POLYGON_CANNED_KIND, TURN_CANNED_KIND } from '../../cannedShapes/generators/kinds'
import { rotarySolidAlong, rotarySolidFrame } from '../../cannedShapes/generators/rotarySolidParams'
import { drawOtherFace, drawRotarySolidSideViews, isRotarySolid } from './faceOverlay'
import { findHitFeatureId } from './hitTest'
import { canvasColors, canvasRgba } from './canvasPalette'
import {
  canvasToWorld,
  computeSketchViewTransform,
  computeViewTransform,
  worldToCanvas,
} from './viewTransform'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'

const CANVAS = { width: 900, height: 650 }
const VIEW = { zoom: 1.7, panX: 21, panY: -13 }

const EMPTY_SELECTION: SelectionState = {
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
}

const NO_SELECTION = { hoveredFeatureId: null, selectedFeatureIds: [] }

function assertClose(actual: number, expected: number, label: string, tolerance = 1e-6): void {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual}`,
  )
}

function assertPoints(actual: readonly Point[], expected: readonly Point[], label: string): void {
  assert.equal(actual.length, expected.length, `${label}: point count`)
  for (let index = 0; index < expected.length; index += 1) {
    const got = actual[index]
    const want = expected[index]
    assert(got && want, `${label}: point ${index} missing`)
    assertClose(got.x, want.x, `${label}: point ${index} x`)
    assertClose(got.y, want.y, `${label}: point ${index} y`)
  }
}

function assertRect(profile: SketchProfile, expected: { minX: number; maxX: number; minY: number; maxY: number }, label: string): void {
  assertPoints(sampleProfilePoints(profile), [
    { x: expected.minX, y: expected.minY },
    { x: expected.maxX, y: expected.minY },
    { x: expected.maxX, y: expected.maxY },
    { x: expected.minX, y: expected.maxY },
  ], label)
}

/**
 * A canvas context that records the paths it is asked to stroke, with the
 * stroke colour, width and dash in force at that moment.
 */
function recordingContext(): {
  ctx: CanvasRenderingContext2D
  paths: { points: Point[]; stroke: string; width: number; dash: number[] }[]
  strokes: () => number
} {
  const paths: { points: Point[]; stroke: string; width: number; dash: number[] }[] = []
  let points: Point[] = []
  let dash: number[] = []
  let strokeStyle = ''
  let lineWidth = 1
  const ctx = {
    save() {},
    restore() {},
    setLineDash(next: number[]) { dash = [...next] },
    beginPath() { points = [] },
    closePath() {},
    moveTo(x: number, y: number) { points.push({ x, y }) },
    lineTo(x: number, y: number) { points.push({ x, y }) },
    arc(x: number, y: number) { points.push({ x, y }) },
    bezierCurveTo(x1: number, y1: number, x2: number, y2: number, x: number, y: number) {
      points.push({ x: x1, y: y1 }, { x: x2, y: y2 }, { x, y })
    },
    fill() {},
    fillText() {},
    stroke(this: { strokeStyle: string; lineWidth: number }) {
      paths.push({ points: [...points], stroke: strokeStyle, width: lineWidth, dash: [...dash] })
    },
    measureText: () => ({ width: 0 }),
    get strokeStyle() { return strokeStyle },
    set strokeStyle(value: string) { strokeStyle = value },
    get lineWidth() { return lineWidth },
    set lineWidth(value: number) { lineWidth = value },
    fillStyle: '',
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    shadowColor: '',
    shadowBlur: 0,
  } as unknown as CanvasRenderingContext2D
  return { ctx, paths, strokes: () => paths.length }
}

/** One bar of the given shape, axis and unit system, ready for a Turn/Polygon. */
function barProject(units: 'mm' | 'inch', shape: 'round' | 'square', axis: 'x' | 'y'): Project {
  const sizes = lengths(units)
  const base = newProject('Bar solid side view', units)
  base.meta.projectType = 'rotary'
  base.stock = shape === 'square'
    ? squareStock(sizes.bar, sizes.barLength, axis)
    : roundStock(sizes.bar, sizes.barLength, axis)
  return base
}

/** One length scale in project units, so the same case reads in mm and inch. */
function lengths(units: 'mm' | 'inch'): {
  bar: number
  barLength: number
  start: number
  length: number
  size: number
} {
  return units === 'mm'
    ? { bar: 25, barLength: 120, start: 10, length: 30, size: 20 }
    : { bar: 1, barLength: 5, start: 0.5, length: 1.5, size: 0.8 }
}

function createSolid(project: Project, input: Parameters<typeof planRotarySolid>[2]): Project {
  const planned = planRotarySolid(project, EMPTY_SELECTION, input)
  assert(planned.ok, `the solid must be created (${planned.ok ? '' : planned.reason})`)
  return planned.project
}

function solidOf(project: Project, kind: string): ResolvedSketchFeature {
  const feature = resolvedProjectFeatures(project).find((row) => row.canned?.kind === kind)
  assert(feature, `the project has a ${kind} model`)
  return feature
}

/** A side-view rectangle in stock space, given the bar's frame and the band. */
function expectedRect(
  project: Project,
  axis: 'x' | 'y',
  start: number,
  length: number,
  halfWidth: number,
): { minX: number; maxX: number; minY: number; maxY: number } {
  const frame = rotarySolidFrame(project)
  assert(frame, 'the bar has a frame')
  const { alongStart, alongEnd } = rotarySolidAlong(frame, start, length)
  return axis === 'x'
    ? {
        minX: alongStart,
        maxX: alongEnd,
        minY: frame.acrossCentre - halfWidth,
        maxY: frame.acrossCentre + halfWidth,
      }
    : {
        minX: frame.acrossCentre - halfWidth,
        maxX: frame.acrossCentre + halfWidth,
        minY: alongStart,
        maxY: alongEnd,
      }
}

// ── The plain Turn's side view is its band crossed by its diameter ──────────

for (const axis of ['x', 'y'] as const) {
  for (const shape of ['round', 'square'] as const) {
    for (const units of ['mm', 'inch'] as const) {
      const sizes = lengths(units)
      const label = `Turn ${units} ${shape} ${axis}`
      const project = createSolid(barProject(units, shape, axis), {
        kind: 'turn',
        start: sizes.start,
        length: sizes.length,
        diameter: sizes.size,
      })
      const turn = solidOf(project, TURN_CANNED_KIND)
      assert(isRotarySolid(turn), `${label}: the Turn is a bar solid`)
      const [profile] = getFeatureGeometryProfiles(turn)
      assert(profile, `${label}: the Turn has a side view`)
      assertRect(
        profile,
        expectedRect(project, axis, sizes.start, sizes.length, sizes.size / 2),
        `${label}: the side view is the band crossed by the diameter`,
      )
    }
  }
}

// ── A stepped profile is stepped in the side view, not boxed ────────────────

/** An asymmetric half profile: a cone, a step up, and a square shoulder. */
function steppedProfile(project: Project) {
  const frame = rotarySolidFrame(project)
  assert(frame, 'the bar has a frame')
  const half = frame.thickness / 4
  return {
    sourceFeatureId: 'f-source',
    sourceName: 'Stepped',
    contours: [{
      closed: false,
      points: [
        { along: frame.alongMin + 5, radius: 0 },
        { along: frame.alongMin + 15, radius: half },
        { along: frame.alongMin + 35, radius: half * 2 },
        { along: frame.alongMin + 35, radius: 0 },
      ],
    }],
  }
}

for (const axis of ['x', 'y'] as const) {
  for (const shape of ['round', 'square'] as const) {
    const label = `stepped Turn ${shape} ${axis}`
    const project = barProject('mm', shape, axis)
    const frame = rotarySolidFrame(project)
    assert(frame, `${label}: the bar has a frame`)
    const created = createSolid(project, {
      kind: 'turn',
      start: 0,
      length: 1,
      diameter: 1,
      profile: steppedProfile(project),
    })
    const turn = solidOf(created, TURN_CANNED_KIND)
    const profiles = getFeatureGeometryProfiles(turn)
    assert.equal(profiles.length, 1, `${label}: a half profile draws one silhouette loop`)
    const loop = profiles[0]
    assert(loop, `${label}: the side view exists`)
    // The profile mirrored about the centreline: the drawn half forward, the
    // mirrored half back, with no line along the axis itself.
    const at = (along: number, radius: number): Point => (axis === 'x'
      ? { x: along, y: frame.acrossCentre + radius }
      : { x: frame.acrossCentre + radius, y: along })
    const half = frame.thickness / 4
    assertPoints(
      sampleProfilePoints(loop),
      [
        at(frame.alongMin + 5, 0),
        at(frame.alongMin + 15, half),
        at(frame.alongMin + 35, half * 2),
        at(frame.alongMin + 35, 0),
        at(frame.alongMin + 35, -half * 2),
        at(frame.alongMin + 15, -half),
      ],
      `${label}: the profile mirrored about the bar axis`,
    )
    // The stored placement frame is the side view's bounds, so Properties,
    // selection bounds and export keep reading the shape's own extent.
    const outer = half * 2
    const bandStart = frame.alongMin + 5
    const bandEnd = frame.alongMin + 35
    const bounds = axis === 'x'
      ? { minX: bandStart, maxX: bandEnd, minY: frame.acrossCentre - outer, maxY: frame.acrossCentre + outer }
      : { minX: frame.acrossCentre - outer, maxX: frame.acrossCentre + outer, minY: bandStart, maxY: bandEnd }
    const frameProfile = turn.sketch.profile
    assertPoints(sampleProfilePoints(frameProfile), [
      { x: bounds.minX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.minY },
      { x: bounds.maxX, y: bounds.maxY },
      { x: bounds.minX, y: bounds.maxY },
    ], `${label}: the placement frame is the side view's bounds`)
  }
}

// ── A Polygon's width follows its rotation ─────────────────────────────────

for (const axis of ['x', 'y'] as const) {
  for (const units of ['mm', 'inch'] as const) {
    const sizes = lengths(units)
    const label = `Polygon ${units} ${axis}`
    const acrossCorners = sizes.size / Math.cos(Math.PI / 6)
    // Flat up, like creation: a corner points across the bar.
    const flatUp = createSolid(barProject(units, 'round', axis), {
      kind: 'polygon',
      start: sizes.start + sizes.length + sizes.length / 2,
      length: sizes.length,
      sides: 6,
      acrossFlats: sizes.size,
      rotationDeg: 0,
    })
    const [flatUpView] = getFeatureGeometryProfiles(solidOf(flatUp, POLYGON_CANNED_KIND))
    assert(flatUpView, `${label}: the Polygon has a side view`)
    assertRect(
      flatUpView,
      expectedRect(flatUp, axis, sizes.start + sizes.length * 1.5, sizes.length, acrossCorners / 2),
      `${label}: flat up puts the across-corners width across the bar`,
    )
    // Turned 30°, the same hexagon shows a flat across the bar instead.
    const turned = createSolid(barProject(units, 'round', axis), {
      kind: 'polygon',
      start: sizes.start + sizes.length + sizes.length / 2,
      length: sizes.length,
      sides: 6,
      acrossFlats: sizes.size,
      rotationDeg: 30,
    })
    const [turnedView] = getFeatureGeometryProfiles(solidOf(turned, POLYGON_CANNED_KIND))
    assert(turnedView, `${label}: the turned Polygon has a side view`)
    assertRect(
      turnedView,
      expectedRect(turned, axis, sizes.start + sizes.length * 1.5, sizes.length, sizes.size / 2),
      `${label}: a 30° turn puts the across-flats width across the bar`,
    )
  }
}

// ── Drawing: dashed, ghost-coloured, and mirrored with the Bottom view ─────

/** A Turn and a 30°-turned hexagon, on Top and on the same project's Bottom. */
function topAndBottom(axis: 'x' | 'y'): {
  top: Project
  bottom: Project
  solidIds: string[]
} {
  const sizes = lengths('mm')
  const turn = createSolid(barProject('mm', 'round', axis), {
    kind: 'turn',
    start: sizes.start,
    length: sizes.length,
    diameter: sizes.size,
  })
  const project = createSolid(turn, {
    kind: 'polygon',
    start: sizes.start + sizes.length * 1.5,
    length: sizes.length,
    sides: 6,
    acrossFlats: sizes.size,
    rotationDeg: 30,
  })
  const bottom = { ...withBottomSetup(project, { axis }), activeSetupId: BOTTOM_SETUP_ID }
  return {
    top: project,
    bottom,
    solidIds: resolvedProjectFeatures(project).filter(isRotarySolid).map((feature) => feature.id),
  }
}

for (const axis of ['x', 'y'] as const) {
  const { top, bottom, solidIds } = topAndBottom(axis)
  assert.equal(solidIds.length, 2, `${axis}: the project holds a Turn and a Polygon`)
  for (const face of ['top', 'bottom'] as const) {
    const label = `${face} view on a ${axis} bar`
    const project = face === 'top' ? top : bottom
    const features = resolvedProjectFeatures(project)
    const solids = features.filter(isRotarySolid)
    assert.deepEqual(solids.map((feature) => feature.id), solidIds, `${label}: both solids resolve`)
    const vt = computeSketchViewTransform(project, CANVAS.width, CANVAS.height, VIEW)
    const { ctx, paths } = recordingContext()
    const drawn = drawRotarySolidSideViews(ctx, project, features, vt, NO_SELECTION)
    assert.deepEqual([...drawn], solidIds, `${label}: both solids are drawn by the side-view pass`)
    assert.equal(paths.length, solids.length, `${label}: one side-view outline per solid is stroked`)

    // It is drawn where the view transform puts it — which is the mirror on
    // Bottom. Comparing against the unmirrored mapping is the mutation check.
    const unmirrored = computeViewTransform(project.stock, CANVAS.width, CANVAS.height, VIEW)
    const ghostKey = face === 'top' ? 'ghostTop' : 'ghostBottom'
    solids.forEach((solid, solidIndex) => {
      const solidLabel = `${label}, ${solid.canned?.kind}`
      const path = paths[solidIndex]
      assert(path, `${solidLabel}: the outline path exists`)
      // Ghost style: dashed, thin, and the face's own ghost colour at rest.
      assert.deepEqual(path.dash, [4, 4], `${solidLabel}: the outline is dashed like a ghost`)
      assert.equal(path.width, 1.3, `${solidLabel}: the outline keeps the ghost width`)
      assert.equal(path.stroke, canvasRgba(ghostKey, 0.6), `${solidLabel}: the outline is the face's ghost colour`)

      const [profile] = getFeatureGeometryProfiles(solid)
      assert(profile, `${solidLabel}: the solid has a side view`)
      const worldPoints = sampleProfilePoints(profile)
      const expected = worldPoints.map((point) => worldToCanvas(point, vt))
      const shifted = worldPoints.map((point) => worldToCanvas(point, unmirrored))
      // `traceProfilePath` walks the closed loop, so the start point closes it.
      const stroked = [...expected, expected[0]]
      assert.equal(path.points.length, stroked.length, `${solidLabel}: every outline vertex is stroked`)
      for (let index = 0; index < stroked.length; index += 1) {
        const got = path.points[index]
        const want = stroked[index]
        assert(got && want, `${solidLabel}: vertex ${index} is drawn`)
        assertClose(got.x, want.cx, `${solidLabel}: vertex ${index} canvas x`)
        assertClose(got.y, want.cy, `${solidLabel}: vertex ${index} canvas y`)
      }
      if (face === 'bottom') {
        // The comparison bites only if the turned-over view really moves the
        // outline: on Bottom it must differ from the stock-space mapping.
        assert(
          expected.some((point, index) => {
            const other = shifted[index]
            return other !== undefined && (Math.abs(point.cx - other.cx) > 1e-6 || Math.abs(point.cy - other.cy) > 1e-6)
          }),
          `${solidLabel}: the Bottom view really is mirrored, so the comparison bites`,
        )
        // Clicking what was drawn selects the model, in world space: the same
        // transform that drew the outline is the one that maps a click back.
        const canvasPoint = path.points[0]
        assert(canvasPoint, `${solidLabel}: the outline has a first vertex`)
        const world = canvasToWorld(canvasPoint.x, canvasPoint.y, vt)
        assert.equal(findHitFeatureId(world, features, vt), solid.id, `${solidLabel}: the drawn outline selects the model`)
      }
    })
  }
}

// ── Hit testing follows the silhouette, not the placement frame ────────────

{
  const project = barProject('mm', 'round', 'x')
  const created = createSolid(project, {
    kind: 'turn',
    start: 0,
    length: 1,
    diameter: 1,
    profile: steppedProfile(project),
  })
  const features = resolvedProjectFeatures(created)
  const turn = solidOf(created, TURN_CANNED_KIND)
  const vt = computeSketchViewTransform(created, CANVAS.width, CANVAS.height, VIEW)
  const frame = rotarySolidFrame(created)
  assert(frame, 'the bar has a frame')
  const half = frame.thickness / 4
  const onOutline: Point = { x: frame.alongMin + 35, y: frame.acrossCentre + half * 2 }
  // Inside the placement frame, above the cone: only the silhouette says no.
  const emptyCorner: Point = { x: frame.alongMin + 10, y: frame.acrossCentre + half * 1.5 }
  const inside: Point = { x: frame.alongMin + 30, y: frame.acrossCentre + 3 }
  assert.equal(findHitFeatureId(onOutline, features, vt), turn.id, 'the outline is clickable')
  assert.equal(findHitFeatureId(inside, features, vt), turn.id, 'the solid is clickable')
  assert.equal(
    findHitFeatureId(emptyCorner, features, vt),
    null,
    'the space a stepped Turn does not fill is not clickable, even inside its placement frame',
  )
}

// ── Selection and hover keep the ghost's dashed style ─────────────────────

{
  const { top, solidIds } = topAndBottom('x')
  const turnId = solidIds[0]!
  const features = resolvedProjectFeatures(top)
  const vt = computeSketchViewTransform(top, CANVAS.width, CANVAS.height, VIEW)
  const hovered = recordingContext()
  drawRotarySolidSideViews(hovered.ctx, top, features, vt, { hoveredFeatureId: turnId, selectedFeatureIds: [] })
  assert.equal(hovered.paths[0]?.stroke, canvasColors().draft, 'hover shows the draft colour')
  assert.deepEqual(hovered.paths[0]?.dash, [4, 4], 'hover keeps the read-only dash')
  const selected = recordingContext()
  drawRotarySolidSideViews(selected.ctx, top, features, vt, { hoveredFeatureId: turnId, selectedFeatureIds: [turnId] })
  assert.equal(selected.paths[0]?.stroke, canvasColors().active, 'selection wins over hover')
  assert.deepEqual(selected.paths[0]?.dash, [4, 4], 'selection keeps the read-only dash')
}

// ── A sheet feature is never drawn on a flat face ─────────────────────────

{
  const sizes = lengths('mm')
  const project = barProject('mm', 'round', 'x')
  const withTurn = createSolid(project, {
    kind: 'turn',
    start: sizes.start,
    length: sizes.length,
    diameter: sizes.size,
  })
  const turn = solidOf(withTurn, TURN_CANNED_KIND)
  const sheet: SketchFeature = {
    id: 'sheet',
    name: 'Sheet pocket',
    kind: 'rect',
    folderId: null,
    operation: 'subtract',
    authoringFace: 'around',
    visible: true,
    locked: false,
    z_top: 10,
    z_bottom: 8,
    sketch: {
      profile: {
        start: { x: 2, y: 30 },
        segments: [
          { type: 'line', to: { x: 12, y: 30 } },
          { type: 'line', to: { x: 12, y: 40 } },
          { type: 'line', to: { x: 2, y: 40 } },
          { type: 'line', to: { x: 2, y: 30 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }
  const withSheet = projectWithFeatures(withTurn, [...withTurn.features, sheet])
  const features = resolvedProjectFeatures(withSheet)
  assert(features.some((feature) => feature.id === sheet.id), 'the sheet feature resolves')
  const vt = computeSketchViewTransform(withSheet, CANVAS.width, CANVAS.height, VIEW)
  const { ctx, paths } = recordingContext()
  const drawn = drawRotarySolidSideViews(ctx, withSheet, features, vt, NO_SELECTION)
  assert.deepEqual([...drawn], [turn.id], 'on a flat face only the solid side view is drawn')
  assert.equal(paths.length, 1, 'the sheet feature adds no outline')

  // The ghost pass is what the canvas uses to leave a sheet feature out.
  const ghosts = drawOtherFace(ctx, withSheet, features, vt, true, 'THRU', 'Top origin')
  assert(ghosts.has(sheet.id), 'a sheet feature stays a ghost on a flat face')

  // And on its own sheet there is no side view at all: the sheet draws bands.
  const aroundSetup = {
    id: 'setup-around',
    name: 'Around',
    kind: 'around' as const,
    orientation: { axis: 'x' as const, angleDeg: 0 },
    indexing: 'manual' as const,
    registration: [],
    notes: '',
    operationIds: [],
  }
  const onAround: Project = {
    ...withSheet,
    setups: [...withSheet.setups, aroundSetup],
    activeSetupId: aroundSetup.id,
  }
  const aroundContext = recordingContext()
  const aroundDrawn = drawRotarySolidSideViews(
    aroundContext.ctx,
    onAround,
    resolvedProjectFeatures(onAround),
    computeSketchViewTransform(onAround, CANVAS.width, CANVAS.height, VIEW),
    NO_SELECTION,
  )
  assert.equal(aroundDrawn.size, 0, 'on Around the sheet draws its own features, not a side view')
  assert.equal(aroundContext.strokes(), 0, 'on Around no side view is stroked')
}

// ── An imported model is not a bar solid ─────────────────────────────────

{
  const imported: SketchFeature = {
    id: 'imported',
    name: 'Imported',
    kind: 'stl',
    folderId: null,
    operation: 'model',
    authoringFace: 'top',
    visible: true,
    locked: false,
    z_top: 10,
    z_bottom: 0,
    sketch: {
      profile: {
        start: { x: 0, y: 0 },
        segments: [
          { type: 'line', to: { x: 10, y: 0 } },
          { type: 'line', to: { x: 10, y: 10 } },
          { type: 'line', to: { x: 0, y: 10 } },
          { type: 'line', to: { x: 0, y: 0 } },
        ],
        closed: true,
      },
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }
  assert.equal(isRotarySolid(imported), false, 'an imported model keeps its ordinary drawing')
}

console.log('barSolidSideView tests passed')
