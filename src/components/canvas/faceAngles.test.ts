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
 * Typed and displayed angles on a turned-over stock (issue #945): on Bottom a
 * positive angle turns the same way on screen as on Top, the field shows the
 * angle as seen in the Bottom view, and the stored value stays in stock space.
 *
 * Every conversion is its own inverse, so "applied twice" and "dropped" are
 * the same failure, and each assertion below fails for both.
 *
 * Mutations these assertions were checked against:
 * - `faceAngles` returning the stock maps on Bottom (conversion dropped, or
 *   applied twice) → the map values, the #944 comparison, every "on screen
 *   as on Top" assertion and every round trip fail;
 * - `direction` ignoring which axis is flipped → the flip-about-Y cases fail;
 * - `computeDimensionEditPreviewPoint` not converting the typed angle → the
 *   line, slot and polygon "on screen as on Top" assertions fail;
 * - `formatDirectionAngle` not converting → "the field shows the typed
 *   angle back" fails;
 * - `computeRotatePreviewPoint` / `computeRotateDegreesFromPreview` not
 *   converting → the rotate assertions fail;
 * - the radial default left in stock space → "a new radial sweep reads 360" fails;
 * - `drawAngleMeasurement` printing the stock-space turn in a mirrored view
 *   (the review's finding on PR #978) → "the rotate label reads the turn as
 *   the field does" fails;
 * - `faceOffsets` returning the stock distance on Bottom, or reversing the
 *   wrong axis → "a typed grid spacing steps the same way on screen" fails;
 * - the grid default left in stock space → "a new grid steps the same way on
 *   screen as on Top" fails;
 * - `axisTurn` flipping the wrong axes → the model orientation assertions fail;
 * - a conversion added to the text-on-arc angle → "text on an arc" fails.
 *
 * Run with: npx tsx src/components/canvas/faceAngles.test.ts
 */

import { rotatePointByModelOrientation } from '../../engine/importedModelTransform'
import { canonicalToSetupPoint, setupFrame } from '../../engine/setupOrientation'
import { STOCK_ANGLES, STOCK_OFFSETS, faceAngles, faceOffsets } from '../../store/helpers/activeFace'
import { resolveFeatureInstance } from '../../store/helpers/resolveFeatures'
import { useProjectStore } from '../../store/projectStore'
import type { ProjectStore } from '../../store/types'
import { switchWorkspaceFace } from '../../store/workspaceFace'
import { BOTTOM_SETUP_ID, withBottomSetup } from '../../test/projectFixtures'
import { defaultTextToolConfig, resolveTextFeatureShapes } from '../../text'
import { DEFAULT_SETUP_ID, newProject } from '../../types/project'
import type { Point, Project, SetupFace, TextLayout } from '../../types/project'
import {
  computeDimensionEditPreviewPoint,
  computeRotateDegreesFromPreview,
  computeRotatePreviewPoint,
  formatDirectionAngle,
} from './manualEntry'
import type { DimensionEditState } from './manualEntry'
import { drawAngleMeasurement } from './measurements'
import { computeSketchViewTransform, worldToCanvas } from './viewTransform'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function near(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) <= epsilon
}

function projectOn(face: SetupFace, axis: 'x' | 'y' = 'x'): Project {
  const base = withBottomSetup(newProject(), { axis })
  return { ...base, activeSetupId: face === 'top' ? DEFAULT_SETUP_ID : BOTTOM_SETUP_ID }
}

const VIEW = { zoom: 1, panX: 0, panY: 0 }

/** Where a stock point is drawn, relative to where `from` is drawn. */
function onScreen(project: Project, from: Point, to: Point): { dx: number; dy: number } {
  const vt = computeSketchViewTransform(project, 800, 600, VIEW)
  const a = worldToCanvas(from, vt)
  const b = worldToCanvas(to, vt)
  return { dx: b.cx - a.cx, dy: b.cy - a.cy }
}

function sameOnScreen(a: { dx: number; dy: number }, b: { dx: number; dy: number }): boolean {
  return near(a.dx, b.dx) && near(a.dy, b.dy)
}

const TOP = projectOn('top')

// ── The maps themselves ───────────────────────────────────────

{
  assert(faceAngles(TOP) === STOCK_ANGLES, 'Top reads angles as they are stored')

  const aboutX = faceAngles(projectOn('bottom', 'x'))
  assert(aboutX.direction(30) === -30 && aboutX.direction(-135) === 135, 'flip about X: a heading mirrors top to bottom')
  assert(Object.is(aboutX.direction(0), 0) && Object.is(aboutX.turn(0), 0), 'flip about X: zero stays a plain zero')
  assert(aboutX.turn(30) === -30, 'flip about X: a turn reverses')

  const aboutY = faceAngles(projectOn('bottom', 'y'))
  assert(aboutY.direction(30) === 150 && aboutY.direction(-30) === -150, 'flip about Y: a heading mirrors left to right')
  assert(aboutY.direction(180) === 0 && aboutY.direction(0) === 180, 'flip about Y: left and right swap')
  assert(aboutY.turn(30) === -30, 'flip about Y: a turn reverses')

  for (const axis of ['x', 'y'] as const) {
    const project = projectOn('bottom', axis)
    const face = faceAngles(project)
    const frame = setupFrame({ axis, angleDeg: 180 }, project.stock)
    for (const degrees of [-170, -90, -30, 0, 12.5, 45, 90, 135, 180]) {
      // The field shows the heading as it lies in the setup-local frame.
      const radians = degrees * Math.PI / 180
      const from = canonicalToSetupPoint({ x: 5, y: 7, z: 0 }, frame)
      const to = canonicalToSetupPoint({ x: 5 + Math.cos(radians), y: 7 + Math.sin(radians), z: 0 }, frame)
      const seen = Math.atan2(to.y - from.y, to.x - from.x) * 180 / Math.PI
      const shown = face.direction(degrees)
      assert(near(Math.cos(seen * Math.PI / 180), Math.cos(shown * Math.PI / 180)) && near(Math.sin(seen * Math.PI / 180), Math.sin(shown * Math.PI / 180)), `flip about ${axis}: ${degrees}° is shown as it lies on the turned stock (#944 transform)`)
      assert(shown > -180 && shown <= 180, `flip about ${axis}: the shown heading stays in (-180, 180]`)
      // One map both ways: stored → shown → stored.
      assert(near(face.direction(shown), degrees === -180 ? 180 : degrees), `flip about ${axis}: typing the shown heading stores the original`)
      assert(face.turn(face.turn(degrees)) === degrees, `flip about ${axis}: a turn converts back exactly`)
    }
  }
}

// ── Length-and-angle entry: line, slot, polygon, gear ─────────

function typedEdit(shape: DimensionEditState['shape'], anchor: Point, angle: string): DimensionEditState {
  return {
    shape,
    anchor,
    ...(shape === 'slot' ? { arcStart: anchor } : {}),
    signX: 1,
    signY: 1,
    activeField: 'angle',
    width: '',
    height: '',
    radius: '10',
    length: '10',
    angle,
  }
}

for (const axis of ['x', 'y'] as const) {
  const bottom = projectOn('bottom', axis)
  const anchor = { x: 40, y: 25 }
  for (const shape of ['composite', 'slot', 'ngon', 'gear'] as const) {
    for (const typed of ['30', '-120', '90']) {
      const topPoint = computeDimensionEditPreviewPoint(typedEdit(shape, anchor, typed), 'mm', faceAngles(TOP))
      const bottomPoint = computeDimensionEditPreviewPoint(typedEdit(shape, anchor, typed), 'mm', faceAngles(bottom))
      assert(
        sameOnScreen(onScreen(TOP, anchor, topPoint), onScreen(bottom, anchor, bottomPoint)),
        `flip about ${axis}: a typed ${typed}° ${shape} angle points the same way on screen as on Top`,
      )
      // The field shows the typed angle back: stored in stock space, read on the face.
      const shown = formatDirectionAngle(bottomPoint.x - anchor.x, bottomPoint.y - anchor.y, faceAngles(bottom))
      assert(shown === typed, `flip about ${axis}: the field shows the typed ${shape} angle back (${typed} → ${shown})`)
      // And the stored geometry is not the Top geometry: it is in stock space.
      // (A heading along the flip axis' normal is its own mirror image, so
      // only an oblique one can tell the two apart.)
      if (typed === '30') {
        assert(!near(topPoint.x, bottomPoint.x) || !near(topPoint.y, bottomPoint.y), `flip about ${axis}: the ${shape} point is stored in stock space`)
      }
    }
  }
  const stockHeading = formatDirectionAngle(1, 1, faceAngles(TOP))
  assert(stockHeading === '45', 'Top shows a stock heading unchanged')
}

// ── Typed rotation ────────────────────────────────────────────

for (const axis of ['x', 'y'] as const) {
  const bottom = projectOn('bottom', axis)
  const pivot = { x: 20, y: 20 }
  const reference = { x: 30, y: 20 }
  for (const typed of [30, -75]) {
    const topPoint = computeRotatePreviewPoint(pivot, reference, typed, faceAngles(TOP))
    const bottomPoint = computeRotatePreviewPoint(pivot, reference, typed, faceAngles(bottom))
    // Same turn on screen: the reference arm swings by the same screen angle.
    const swing = (project: Project, to: Point) => {
      const arm = onScreen(project, pivot, reference)
      const turned = onScreen(project, pivot, to)
      return Math.atan2(arm.dx * turned.dy - arm.dy * turned.dx, arm.dx * turned.dx + arm.dy * turned.dy)
    }
    assert(near(swing(TOP, topPoint), swing(bottom, bottomPoint)), `flip about ${axis}: a typed ${typed}° rotation turns the same way on screen as on Top`)
    assert(near(swing(TOP, topPoint), typed * Math.PI / 180), 'Top turns by the typed angle, as it always did')
    const shown = computeRotateDegreesFromPreview(pivot, reference, bottomPoint, faceAngles(bottom))
    assert(shown === String(typed), `flip about ${axis}: the rotate field shows the typed angle back (${typed} → ${shown})`)
  }
}

// ── Radial sweep default, model orientation, text on an arc ───

function resetStore(project: Project = newProject()): void {
  useProjectStore.setState({
    project,
    dirty: false,
    selection: {
      mode: 'feature', selectedFeatureId: null, selectedFeatureIds: [], selectedTabIds: [], selectedClampIds: [],
      selectedNode: null, hoveredFeatureId: null, sketchEditTool: null, activeControl: null, groupFolderId: null,
    },
    history: { past: [], future: [], transactionStart: null },
    pendingAdd: null,
    pendingFeatureDistribution: null,
  } as unknown as Partial<ProjectStore>)
}

for (const face of ['top', 'bottom'] as const) {
  resetStore()
  const store = () => useProjectStore.getState()
  if (face === 'bottom') switchWorkspaceFace('bottom')
  store().addRectFeature('Part', 1, 1, 0.5, 0.5, store().project.stock.thickness)
  store().startFeatureDistribution('radial')
  const spec = store().pendingFeatureDistribution?.spec
  assert(spec?.mode === 'radial', 'the radial workflow starts')
  assert(faceAngles(store().project).turn(spec.sweepDegrees) === 360, `on ${face}: a new radial sweep reads 360 in its field`)
  assert(spec.sweepDegrees === (face === 'top' ? 360 : -360), `on ${face}: and is stored in stock space`)
}

// ── The rotate preview label reads like the rotate field ──────

// The review's case: on Bottom the canvas label showed the stock-space turn
// while the typed field showed the turn as seen, so the two disagreed in sign.
{
  const labelFor = (project: Project, origin: Point, from: Point, to: Point): string | undefined => {
    const labels: string[] = []
    const noop = () => undefined
    const ctx = {
      save: noop, restore: noop, translate: noop, rotate: noop, beginPath: noop, closePath: noop, moveTo: noop,
      lineTo: noop, arcTo: noop, quadraticCurveTo: noop, roundRect: noop, rect: noop, fill: noop, stroke: noop,
      fillRect: noop, strokeRect: noop, setLineDash: noop,
      measureText: () => ({ width: 10 }),
      fillText: (text: string) => { labels.push(text) },
      font: '', textAlign: '', textBaseline: '', fillStyle: '', strokeStyle: '', lineWidth: 0, globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D
    drawAngleMeasurement(ctx, origin, from, to, computeSketchViewTransform(project, 800, 600, VIEW))
    return labels[0]
  }
  const origin = { x: 1, y: 1 }
  const from = { x: 2, y: 1 }
  const turned = (degrees: number) => ({ x: 1 + Math.cos((degrees * Math.PI) / 180), y: 1 + Math.sin((degrees * Math.PI) / 180) })

  assert(labelFor(TOP, origin, from, turned(30)) === '+30°', 'on Top the label reads the stock-space turn')
  for (const axis of ['x', 'y'] as const) {
    const project = projectOn('bottom', axis)
    for (const stockTurn of [30, -45]) {
      // What Tab puts in the rotate field, as a number.
      const field = Number.parseFloat(computeRotateDegreesFromPreview(origin, from, turned(stockTurn), faceAngles(project)))
      const label = labelFor(project, origin, from, turned(stockTurn))
      assert(label !== undefined, `flip about ${axis}: the rotate label is drawn`)
      assert(
        near(Number.parseFloat(label), field, 0.05) && near(field, -stockTurn),
        `flip about ${axis}: the rotate label reads the turn as the field does (label ${label}, field ${field})`,
      )
    }
  }
}

// ── Grid spacing: a signed distance along a stock axis ────────

{
  assert(faceOffsets(TOP) === STOCK_OFFSETS, 'Top reads distances as they are stored')
  const pivot = { x: 1, y: 1 }
  for (const axis of ['x', 'y'] as const) {
    const bottom = projectOn('bottom', axis)
    const offsets = faceOffsets(bottom)
    for (const typed of [0.7, -0.4]) {
      // The panel stores what the map makes of the typed value, and shows
      // what the map makes of the stored one.
      const stored = { x: offsets.x(typed), y: offsets.y(typed) }
      assert(offsets.x(stored.x) === typed && offsets.y(stored.y) === typed, `flip about ${axis}: a typed spacing reads back as typed`)
      assert(
        sameOnScreen(onScreen(bottom, pivot, { x: pivot.x + stored.x, y: pivot.y }), onScreen(TOP, pivot, { x: pivot.x + typed, y: pivot.y }))
          && sameOnScreen(onScreen(bottom, pivot, { x: pivot.x, y: pivot.y + stored.y }), onScreen(TOP, pivot, { x: pivot.x, y: pivot.y + typed })),
        `flip about ${axis}: a typed grid spacing of ${typed} steps the same way on screen as on Top`,
      )
    }
    // Only the axis the turn reverses changes sign: the stored value stays in stock space.
    assert(offsets.x(1) === (axis === 'y' ? -1 : 1) && offsets.y(1) === (axis === 'x' ? -1 : 1), `flip about ${axis}: only the reversed axis changes sign`)
    assert(Object.is(offsets.x(0), 0) && Object.is(offsets.y(0), 0), `flip about ${axis}: zero stays a plain zero`)
  }

  // A new grid steps the same way on screen on every face.
  const gridSpec = (project: Project) => {
    resetStore(project)
    const store = () => useProjectStore.getState()
    store().addRectFeature('Part', 1, 1, 0.5, 0.5, store().project.stock.thickness)
    store().startFeatureDistribution('grid')
    const spec = store().pendingFeatureDistribution?.spec
    assert(spec?.mode === 'grid', 'the grid workflow starts')
    return spec
  }
  const onTop = gridSpec(TOP)
  assert(onTop.spacingX > 0 && onTop.spacingY > 0, 'fixture: a new grid on Top steps the positive way')
  for (const axis of ['x', 'y'] as const) {
    const bottom = projectOn('bottom', axis)
    const spec = gridSpec(bottom)
    const offsets = faceOffsets(bottom)
    assert(
      offsets.x(spec.spacingX) === onTop.spacingX && offsets.y(spec.spacingY) === onTop.spacingY,
      `flip about ${axis}: a new grid reads the same spacing in its fields as on Top`,
    )
    assert(
      sameOnScreen(onScreen(bottom, pivot, { x: pivot.x + spec.spacingX, y: pivot.y + spec.spacingY }), onScreen(TOP, pivot, { x: pivot.x + onTop.spacingX, y: pivot.y + onTop.spacingY })),
      `flip about ${axis}: a new grid steps the same way on screen as on Top`,
    )
  }
}

for (const axis of ['x', 'y'] as const) {
  const project = projectOn('bottom', axis)
  const face = faceAngles(project)
  const frame = setupFrame({ axis, angleDeg: 180 }, project.stock)
  const origin = canonicalToSetupPoint({ x: 0, y: 0, z: 0 }, frame)
  // The turn as a rigid motion of directions, straight from the #944 transform.
  const turnStock = (p: { x: number; y: number; z: number }) => {
    const q = canonicalToSetupPoint(p, frame)
    return { x: q.x - origin.x, y: q.y - origin.y, z: q.z - origin.z }
  }
  const stored = { rx: 20, ry: -35, rz: 50 }
  const shown = { rx: face.axisTurn('x', stored.rx), ry: face.axisTurn('y', stored.ry), rz: face.axisTurn('z', stored.rz) }
  for (const p of [{ x: 1, y: 0, z: 0 }, { x: 0.3, y: -2, z: 1.5 }]) {
    // Rotating in stock space and then turning the stock over is the same as
    // turning it over and rotating by the angles the fields show.
    const a = turnStock(rotatePointByModelOrientation(stored, p.x, p.y, p.z))
    const local = turnStock(p)
    const b = rotatePointByModelOrientation(shown, local.x, local.y, local.z)
    assert(near(a.x, b.x) && near(a.y, b.y) && near(a.z, b.z), `flip about ${axis}: the model rotation fields describe the model as it sits on the turned stock`)
  }
  assert(shown[axis === 'x' ? 'rx' : 'ry'] === stored[axis === 'x' ? 'rx' : 'ry'], `flip about ${axis}: a rotation about the flip axis keeps its sign`)
  assert(shown.rz === -stored.rz, `flip about ${axis}: a rotation about Z reverses`)
}

// Text on an arc is typed in the run's own frame, and a run drawn on Bottom
// already carries the face mirror: with no conversion it reads on Bottom as
// the same run reads on Top. A conversion added here would apply it twice.
for (const axis of ['x', 'y'] as const) {
  const anchor = { x: 2, y: 1.5 }
  const layout: TextLayout = {
    kind: 'arc', center: { x: 2, y: 2.5 }, radius: 1, angleDegrees: -60, sweepDegrees: 90,
    anchor: 'start', fit: 'natural', direction: 'cw', orientation: 'follow',
  }
  const glyphOffsets = (bottom: boolean) => {
    resetStore()
    const store = () => useProjectStore.getState()
    if (bottom) {
      switchWorkspaceFace('bottom')
      if (axis === 'y') {
        const id = store().project.activeSetupId
        useProjectStore.setState({ project: { ...store().project, setups: store().project.setups.map((setup) => (setup.id === id ? { ...setup, orientation: { axis: 'y', angleDeg: 180 } } : setup)) } })
      }
    }
    store().startAddTextPlacement({ ...defaultTextToolConfig('inch'), text: 'AB' })
    const [id] = store().placePendingTextAt(anchor)
    // The layout's centre is in the run's own (definition-local) frame.
    useProjectStore.setState({ project: { ...store().project, features: store().project.features.map((row) => (row.id === id ? { ...row, textLayout: layout } : row)) } })
    const project = store().project
    const feature = resolveFeatureInstance(project, id)!
    return resolveTextFeatureShapes(feature)
      .flatMap((shape) => [shape.profile.start, ...shape.profile.segments.map((segment) => segment.to)])
      .map((point) => onScreen(project, anchor, point))
  }
  const top = glyphOffsets(false)
  const bottom = glyphOffsets(true)
  assert(top.length > 3 && top.length === bottom.length, `flip about ${axis}: the same curved run on both faces`)
  top.forEach((offset, index) => {
    assert(sameOnScreen(offset, bottom[index]), `flip about ${axis}: text on an arc reads on Bottom as on Top with the same typed angle (point ${index})`)
  })
}

console.log('faceAngles tests passed')
