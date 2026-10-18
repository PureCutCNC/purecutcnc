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
 * Exact retained-stub contact for a square blank's rotary rough and finish
 * (#1016 C2-F6).
 *
 * `withRetainedBar` adds the retained square stubs to the mesh the height-map
 * sampler reads, but the sampler only lifts a sample where its **discrete
 * footprint cells** land on a stub, so a thin axial overlap slips between cell
 * centres. Codex measured two on a 25 mm blank (default chuck, `x < 18`
 * retained, a Ø20 target from `x = 10`):
 *
 *  - the finish's A0 sample at `x = 20.933333` read `9.999256` from the model
 *    while the retained stub's flat stands at `12.5`; the radius-3 cutter's rim
 *    reached `17.933333`, i.e. `0.066667 mm` axially into the stub and
 *    `2.500744 mm` below its top;
 *  - the stub face at `A7.769784` read `13.001261` against the exact contact
 *    `13.025160` (`0.023899 mm` into the face, about `1.01 mm` axially).
 *
 * `squareRotaryStubContactFloor` replaces that sampled contact with the exact
 * closed form at the cutter's real radius (the ball's `-(rt - rho)` term is
 * derived and proved there); `rotaryTargets` floors every finite sample after
 * the normal stock offset, and `retainedStubStepForced` splits the one straight
 * move whose chord could sag below the floor. Round bars never call either: the
 * floor returns `-Infinity` for a round stock and no step predicate is built.
 *
 * ## The independent oracle
 *
 * `stubPenetration` never reads the floor helper. It takes the **emitted**
 * moves, rebuilds the real cutter solid (a flat cylinder with a flat bottom, or
 * a ball plus its shank), and intersects it analytically with each retained
 * square prism at every cut endpoint and densely along every cut segment. For a
 * move position it uses the closest axial plane the cutter can reach, where its
 * cross-section is widest, and returns the largest distance a cutter point lies
 * inside the prism: `0` for a tangency (`x` reach exactly zero) and the
 * measured penetration otherwise.
 *
 * ## Mutations this file bites
 *
 *  - **floor removed**: the A0 sample falls back to the mesh's `10` and the
 *    oracle measures the plunge; the A0 exact-tip assertion fails;
 *  - **ball `-(rt - rho)` dropped**: the ball's A0 stub sample lifts to
 *    `12.5` instead of `12.408990`; its exact-tip assertion fails;
 *  - **`rho = rt` regardless of the axial gap**: the sample `0.02 mm` inside
 *    the cutter radius lifts to the full `13.025160` instead of `12.663010`;
 *    the near-reach assertions fail;
 *  - **stepped-chord safeguard removed**: the 0.7 mm drop adjacent to the stub
 *    at `A229.787` sags into the retained corner and the segment oracle fails.
 *
 * Run with: npx tsx src/engine/toolpaths/squareRotaryStub.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { defaultTool, getStockBounds, newProject, rectProfile, roundStock } from '../../types/project'
import type {
  BarStock, Operation, Project, SketchFeature, StockAxis, ToolType,
} from '../../types/project'
import { computeMeshBounds, serializeImportedMesh } from '../importedMesh'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import { convertLength } from '../../utils/units'
import { buildSimulationSetupInput } from '../../app/simulationSetup'
import { computeSimulationResult } from '../../app/simulationCompute'
import { generateRotaryOperation } from './rotaryOperation'
import { resolveFinishModelSurface } from './finishModelSurface'
import { rotaryAlongRange } from './rotaryModel'
import { normalizeToolForProject } from './geometry'
import { squareRotaryStubContactFloor, squareRotaryTouchRadius } from './squareRotaryStock'
import type { NormalizedTool, ToolpathMove } from './types'

function approx(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: got ${actual}, expected ${expected}`)
}

// ── the independent exact oracle ─────────────────────────────────────
//
// The retained stub is the blank's square cross-section extruded along the bar.
// In the turned (project) frame at program angle `a` that cross-section is the
// stock square rotated by `a`; the cutter is a vertical solid at the emitted
// point. Intersecting the two at the closest axial plane is exact because the
// prism's cross-section is constant along the bar: a wider plane (closer to the
// cutter's axis) intersects whenever a narrower one does.

interface SquarePolygon {
  /** Across (project Y for an X bar) of the four rotated corners. */
  readonly y: number[]
  /** Up (project Z) of the four rotated corners. */
  readonly z: number[]
}

function rotatedSquare(halfSide: number, centre: number, pivot: number, angleDeg: number): SquarePolygon {
  const radians = (angleDeg * Math.PI) / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const y: number[] = []
  const z: number[] = []
  for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]] as const) {
    y.push(centre + halfSide * (u * cos - v * sin))
    z.push(pivot + halfSide * (u * sin + v * cos))
  }
  return { y, z }
}

function insidePolygon(polygon: SquarePolygon, y: number, z: number): boolean {
  let sign = 0
  for (let i = 0; i < polygon.y.length; i++) {
    const j = (i + 1) % polygon.y.length
    const cross = (polygon.y[j] - polygon.y[i]) * (z - polygon.z[i])
      - (polygon.z[j] - polygon.z[i]) * (y - polygon.y[i])
    if (cross === 0) continue
    const next = cross > 0 ? 1 : -1
    if (sign === 0) sign = next
    else if (sign !== next) return false
  }
  return true
}

function segmentDistance(y0: number, z0: number, y1: number, z1: number, y2: number, z2: number): number {
  const dy = y2 - y1
  const dz = z2 - z1
  const lengthSq = dy * dy + dz * dz
  const t = lengthSq > 0
    ? Math.max(0, Math.min(1, ((y0 - y1) * dy + (z0 - z1) * dz) / lengthSq))
    : 0
  return Math.hypot(y0 - (y1 + t * dy), z0 - (z1 + t * dz))
}

function distanceToPolygon(polygon: SquarePolygon, y: number, z: number): number {
  if (insidePolygon(polygon, y, z)) return 0
  let best = Infinity
  for (let i = 0; i < polygon.y.length; i++) {
    const j = (i + 1) % polygon.y.length
    best = Math.min(best, segmentDistance(y, z, polygon.y[i], polygon.z[i], polygon.y[j], polygon.z[j]))
  }
  return best
}

/** The largest up coordinate of the polygon inside the across interval. */
function maxUpInStrip(polygon: SquarePolygon, yMin: number, yMax: number): number {
  let best = -Infinity
  for (let i = 0; i < polygon.y.length; i++) {
    if (polygon.y[i] >= yMin && polygon.y[i] <= yMax) best = Math.max(best, polygon.z[i])
    const j = (i + 1) % polygon.y.length
    const dy = polygon.y[j] - polygon.y[i]
    if (dy === 0) continue
    for (const edge of [yMin, yMax]) {
      const t = (edge - polygon.y[i]) / dy
      if (t < 0 || t > 1) continue
      best = Math.max(best, polygon.z[i] + t * (polygon.z[j] - polygon.z[i]))
    }
  }
  return best
}

/**
 * The largest distance any point of the real cutter lies inside either
 * retained stub prism, over every cut endpoint and densely along every cut
 * segment. `0` means no penetration (a tangency is `0`: the cutter's axial
 * reach into the stub is zero, so no point has a positive distance to the
 * prism's boundary).
 */
function stubPenetration(
  stock: BarStock,
  tool: NormalizedTool,
  moves: readonly ToolpathMove[],
  alongStart: number,
  alongEnd: number,
): { max: number; where: string | null } {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const halfSide = stock.thickness / 2
  const bounds = getStockBounds(stock)
  const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
  const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  const radius = tool.radius
  const ball = tool.type === 'ball_endmill'
  // A step no coarser than an eighth of the cutter: the narrowest feature the
  // oracle can miss is then the tip's own discretization, not the walk's.
  const step = Math.min(convertLength(0.05, 'mm', tool.units), radius / 8)
  let max = 0
  let where: string | null = null

  const test = (px: number, tip: number, angle: number, label: string): void => {
    const polygon = rotatedSquare(halfSide, centre, pivot, angle)
    for (const [from, to, name] of [[lower, alongStart, 'lower'], [alongEnd, upper, 'upper']] as const) {
      const lo = Math.max(from, px - radius)
      const hi = Math.min(to, px + radius)
      if (lo > hi) continue
      const closest = Math.max(lo, Math.min(hi, px))
      const rho = Math.sqrt(Math.max(0, radius * radius - (closest - px) * (closest - px)))
      const tipZ = pivot + tip
      let radial = 0
      if (!ball) {
        radial = Math.max(0, maxUpInStrip(polygon, centre - rho, centre + rho) - tipZ)
      } else {
        const ballDepth = Math.max(0, rho - distanceToPolygon(polygon, centre, tipZ + radius))
        const shankDepth = Math.max(0, maxUpInStrip(polygon, centre - rho, centre + rho) - (tipZ + radius))
        radial = Math.max(ballDepth, shankDepth)
      }
      // No point can be deeper inside the prism than the cutter's axial reach
      // into it; a zero-reach tangency is therefore not a penetration.
      const depth = radial > 0 ? Math.min(hi - lo, radial) : 0
      if (depth > max) {
        max = depth
        where = `${label} ${name} x=${px.toFixed(5)} tip=${tip.toFixed(5)} a=${angle.toFixed(4)}`
      }
    }
  }

  const alongOf = (point: { x: number; y: number }): number =>
    stock.axis === 'x' ? point.x : point.y
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    const a0 = move.from.a ?? 0
    const a1 = move.to.a ?? a0
    const fromAlong = alongOf(move.from)
    const toAlong = alongOf(move.to)
    const dz = move.to.z - move.from.z
    // Skip a move whose whole along span is clear of both stubs.
    const lo = Math.min(fromAlong, toAlong) - radius
    const hi = Math.max(fromAlong, toAlong) + radius
    if (hi < lower || (lo > alongStart && (hi < alongEnd || lo > upper))) continue
    const steps = Math.max(1, Math.ceil(Math.hypot(toAlong - fromAlong, dz) / step))
    for (let s = 0; s <= steps; s++) {
      const f = s / steps
      test(fromAlong + (toAlong - fromAlong) * f, move.from.z + dz * f - pivot, a0 + (a1 - a0) * f,
        `${move.kind} ${fromAlong.toFixed(3)}->${toAlong.toFixed(3)}`)
    }
  }
  return { max, where }
}

/** The lowest emitted tip radius at one along position and pass angle. */
function lowestTipAt(moves: readonly ToolpathMove[], along: number, angleDeg: number, stock: BarStock): number {
  const pivot = barPivotZ(stock)
  let best = Infinity
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    const fromAngle = move.from.a ?? 0
    const toAngle = move.to.a ?? fromAngle
    const fromAlong = stock.axis === 'x' ? move.from.x : move.from.y
    const toAlong = stock.axis === 'x' ? move.to.x : move.to.y
    if (Math.abs(fromAlong - along) <= 1e-6 && Math.abs(fromAngle - angleDeg) <= 1e-6) {
      best = Math.min(best, move.from.z - pivot)
    }
    if (Math.abs(toAlong - along) <= 1e-6 && Math.abs(toAngle - angleDeg) <= 1e-6) {
      best = Math.min(best, move.to.z - pivot)
    }
  }
  return best
}

// ── the exact Codex reproduction ──────────────────────────────────────
//
// 25 mm square, default chuck (`x = -40..15`), a Ø20 square-to-round target
// from `x = 10` to `x = 40`, a 6 mm flat at a 0.4 stepover. The chuck's 15 mm
// grip and the cutter radius put the cut range at `18..40`, so the retained
// lower stub is `x < 18` and the upper one starts at the stock's end.

const CODEX_SIDE = 25
const CODEX_LENGTH = 100
const CODEX_MODEL = { start: 10, end: 40, radius: 10 }
const CODEX_ALONG = { start: 18, end: 40 }

function coaxialCylinder(stock: BarStock, radius: number, from: number, to: number, segments = 192) {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const along of [from, to]) {
    for (let i = 0; i < segments; i++) {
      const t = (2 * Math.PI * i) / segments
      const across = centre + radius * Math.cos(t)
      const up = pivot + radius * Math.sin(t)
      if (stock.axis === 'x') positions.push(along, across, up)
      else positions.push(across, along, up)
    }
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    index.push(i, j, segments + j, i, segments + j, segments + i)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/**
 * The along extent of the **resolved** model mesh, exactly as the production
 * adapter reads it. The imported positions are Float32, so the cut range's end
 * can sit a few ulps past the authored number; the oracle must judge the stub
 * the generator actually retained, at that same Float32 boundary.
 */
function modelAlongExtent(project: Project, model: SketchFeature, axis: StockAxis): { min: number; max: number } {
  const surface = resolveFinishModelSurface(project, [model])
  assert.ok(surface, 'the fixture model resolves')
  const axisIndex = axis === 'x' ? 0 : 1
  let min = Infinity
  let max = -Infinity
  for (let i = axisIndex; i < surface.mesh.positions.length; i += 3) {
    min = Math.min(min, surface.mesh.positions[i])
    max = Math.max(max, surface.mesh.positions[i])
  }
  return { min, max }
}

interface Fixture {
  project: Project
  operation: Operation
  tool: NormalizedTool
  along: { start: number; end: number }
  targetRadius: number
}

function codexFixture(toolType: ToolType = 'flat_endmill'): Fixture {
  const stock = squareStock(CODEX_SIDE, CODEX_LENGTH, 'x')
  const base = newProject('stub contact', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 25
  base.stock = stock
  base.tools = [{
    ...defaultTool('mm', 1),
    id: 't1',
    type: toolType,
    diameter: 6,
    defaultStepover: 0.4,
    defaultStepdown: 1,
  }]
  const mesh = coaxialCylinder(stock, CODEX_MODEL.radius, CODEX_MODEL.start, CODEX_MODEL.end)
  base.modelAssets = {
    asset: serializeImportedMesh(
      { positions: mesh.positions, index: mesh.index, bounds: computeMeshBounds(mesh.positions) },
      'stl',
    ),
  }
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const model: SketchFeature = {
    id: 'model', name: 'Model', kind: 'stl', operation: 'model', authoringFace: 'top', folderId: null,
    sketch: {
      profile: rectProfile(
        CODEX_MODEL.start, centre - CODEX_MODEL.radius,
        CODEX_MODEL.end - CODEX_MODEL.start, 2 * CODEX_MODEL.radius,
      ),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    stl: { format: 'stl', meshAssetId: 'asset', scale: 1, axisSwap: 'none' },
    z_top: pivot + CODEX_MODEL.radius, z_bottom: pivot - CODEX_MODEL.radius,
    visible: true, locked: false,
  }
  const around: SketchFeature = {
    ...model, id: 'sketch', name: 'Sketch', kind: 'rect', operation: 'subtract', stl: null,
    authoringFace: 'around', z_top: pivot + CODEX_SIDE / 2, z_bottom: pivot - CODEX_SIDE / 2,
  }
  const project = projectWithFeatures(base, [model, around])
  project.setups.push({ ...project.setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 } })
  project.activeSetupId = 'around'
  project.clamps = [{ ...defaultRoundWorkholding('chuck', stock, 'mm'), id: 'chuck', name: 'Chuck', visible: true }]
  const operation: Operation = {
    ...defaultOperationForTarget(project, 'rotary_finish', 'finish', { source: 'features', featureIds: ['model'] }, 0),
    setupId: 'around',
    stockToLeaveRadial: 0,
    stepover: 0.4,
  }
  project.operations = [operation]
  const tool = normalizeToolForProject(project.tools[0], project)
  const along = rotaryAlongRange(
    stock, project.clamps, modelAlongExtent(project, model, 'x'),
    tool, { chuckEnd: 0, tailEnd: 0 },
  )
  assert.ok(along, 'the Codex fixture has room between its supports')
  return { project, operation, tool, along, targetRadius: CODEX_MODEL.radius }
}

// ── 1. the two measured Codex cases ───────────────────────────────────

console.log('Testing the Codex A0 plunge and the stub-face under-read...')
{
  const fixture = codexFixture()
  const { project, operation, tool, along } = fixture
  const stock = project.stock as BarStock
  const pivot = barPivotZ(stock)
  approx(along.start, CODEX_ALONG.start, 'the fixture reproduces the 18 mm chuck-limited start')
  approx(along.end, CODEX_ALONG.end, 'the fixture reproduces the 40 mm model-limited end')
  const result = generateRotaryOperation(project, operation)
  assert.deepEqual(result.warnings, [], 'the exact repro generates without a warning')
  assert.ok(result.moves.length > 0, 'the exact repro cuts')

  // The A0 sample at x = 20.933333 is the one the mesh under-read as 9.999256.
  // Its exact contact at A0 is the retained flat, 12.5; with every sample
  // lifted there the run is one horizontal leg at 12.5 across it (the collinear
  // merge then keeps only the leg's ends), so the leg itself is the evidence.
  const target = 20.933333333333334
  const a0Moves = result.moves.filter((move) => move.kind !== 'rapid'
    && (move.from.a ?? 0) === 0 && (move.to.a ?? 0) === 0)
  const leg = a0Moves.find((move) => Math.min(move.from.x, move.to.x) <= target
    && Math.max(move.from.x, move.to.x) >= target)
  assert.ok(leg, 'the A0 pass still covers x=20.933333')
  assert.ok(Math.abs(leg.from.z - leg.to.z) <= 1e-9, 'the A0 coverage of x=20.933333 is horizontal')
  approx(leg.from.z - pivot, CODEX_SIDE / 2, 'the A0 sample at x=20.933333 is lifted to the stub flat', 1e-9)
  // Every A0 cut point within the cutter's axial reach of the stub is at or
  // above the retained flat: the unsafe vertical plunge has moved past it.
  let reachable = 0
  for (const move of a0Moves) {
    for (const point of [move.from, move.to]) {
      if (point.x < along.start || point.x > along.start + tool.radius) continue
      reachable++
      assert.ok(point.z - pivot >= CODEX_SIDE / 2 - 1e-9,
        `an A0 point within the cutter radius of the stub stays on or above its flat (${point.z - pivot})`)
    }
  }
  assert.ok(reachable > 0, 'the A0 pass still has points within the cutter radius of the stub')
  const a0Drop = a0Moves
    .filter((move) => Math.abs(move.from.z - move.to.z) > 1e-9
      && move.from.z - pivot <= CODEX_SIDE / 2 + 1e-6
      && move.to.z - pivot <= CODEX_SIDE / 2 + 1e-6)
    .map((move) => Math.min(move.from.x, move.to.x))
  assert.ok(a0Drop.length > 0, 'the A0 pass still descends to the model')
  assert.ok(Math.min(...a0Drop) >= along.start + tool.radius,
    `the A0 descent starts outside the cutter's axial reach of the stub (${Math.min(...a0Drop)})`)
  const measured = stubPenetration(stock, tool, result.moves, along.start, along.end)
  assert.ok(measured.max <= 1e-6,
    `the whole Codex program clears both retained stubs (${measured.max} at ${measured.where})`)

  // The second measured case: the exact contact the review cites at
  // A7.769784 is the helper's value, and the review's under-read 13.001261 is
  // a real intrusion while the exact value only touches. (The pass angle is
  // not reachable through the current pass-count rounding; the generated pass
  // at the nearest angle, A7.659574, exercises the same stub-face under-read
  // below.)
  const measuredFloor = squareRotaryStubContactFloor(stock, 7.769784, 3, 'flat_endmill', 0)
  approx(measuredFloor, 13.025160, 'the review\'s exact contact at A7.769784', 1e-6)
  const atStubFace = (tip: number): ToolpathMove => ({
    kind: 'cut',
    from: { x: along.start, y: barCentre(stock), z: pivot + tip, a: 7.769784 },
    to: { x: along.start, y: barCentre(stock), z: pivot + tip, a: 7.769784 },
  })
  const under = stubPenetration(stock, tool, [atStubFace(13.001261)], along.start, along.end)
  assert.ok(under.max > 1e-6, `the review's 13.001261 at the stub face is an intrusion (${under.max})`)
  const exact = stubPenetration(stock, tool, [atStubFace(measuredFloor)], along.start, along.end)
  assert.ok(exact.max <= 1e-6, `the exact contact only touches the stub face (${exact.max})`)

  // The reachable stub-face sample is exact, not the mesh's under-read: the
  // generated pass at A7.659574 read 12.941416 before the floor.
  const faceAngle = 360 / 47
  approx(lowestTipAt(result.moves, along.start, faceAngle, stock),
    squareRotaryStubContactFloor(stock, faceAngle, 3, 'flat_endmill', 0),
    'the stub-face sample at the nearest reachable pass is exact', 1e-9)
  console.log(`  Codex A0: the leg over x=20.933333 sits at tip ${(leg.from.z - pivot).toFixed(6)} `
    + `(exact ${CODEX_SIDE / 2}); program penetration ${measured.max.toExponential(2)}`)
}

// ── 2. the ball offset and the near-reach lift are exact ──────────────

console.log('Testing the ball offset and the near-reach contact...')
{
  const stock = squareStock(CODEX_SIDE, CODEX_LENGTH, 'x')
  // Over-lift guard for `rho = rt`: 0.02 mm inside the cutter radius the exact
  // contact is barely above the square's height over the centreline, while the
  // full footprint is much higher.
  const angle = 7.769784
  const zero = squareRotaryTouchRadius(stock, angle, 0, 'flat_endmill')
  const full = squareRotaryTouchRadius(stock, angle, 3, 'flat_endmill')
  const near = squareRotaryStubContactFloor(stock, angle, 3, 'flat_endmill', 2.98)
  approx(near, 12.663010, 'the near-reach contact at d = 2.98', 1e-6)
  assert.ok(near - zero < 0.1, `a sample 0.02 mm inside the cutter radius is lifted only the exact small amount `
    + `(${(near - zero).toFixed(6)} above the centreline contact)`)
  assert.ok(near < full - 0.3, `and not to the full-footprint contact (${near} < ${full - 0.3})`)
  assert.equal(squareRotaryStubContactFloor(stock, angle, 3, 'flat_endmill', 3), Number.NEGATIVE_INFINITY,
    'a sample at the cutter radius is untouched')
  // Ball at the Codex A0 stub face: the exact floor for d = 0.733333 is
  // 12.408990. Dropping `-(rt - rho)` would read the flat's 12.5.
  const ballFloor = squareRotaryStubContactFloor(stock, 0, 3, 'ball_endmill', 0.7333333333333333)
  approx(ballFloor, 12.408990, 'the ball floor 0.733333 mm from the stub face', 1e-6)
  assert.ok(ballFloor < 12.499, 'the ball is not the flat\'s cylinder contact')

  const fixture = codexFixture('ball_endmill')
  const result = generateRotaryOperation(fixture.project, fixture.operation)
  approx(
    lowestTipAt(result.moves, 18.733333333333334, 0, stock),
    ballFloor,
    'the generated ball sample at the stub is lifted to the exact ball contact', 1e-9,
  )
  const measured = stubPenetration(stock, fixture.tool, result.moves, CODEX_ALONG.start, CODEX_ALONG.end)
  assert.ok(measured.max <= 1e-6,
    `the ball program clears both retained stubs (${measured.max} at ${measured.where})`)

  console.log(`  ball floor ${ballFloor.toFixed(6)}; near-reach lift ${(near - zero).toFixed(6)} vs full ${full.toFixed(6)}`)
}

// ── 3. seeded physical sweep: no intrusion, every shape and range ─────
//
// Sides 12 / 25 / 2 in, flat and ball cutters from 0.5 to 6 mm, both axes, both
// retained ends, chuck-limited and model-limited ranges, mm and inch, and a
// nonlinear stock-to-leave. Every case is generated through the production
// adapter and measured by the independent oracle; the worst case is reported.

interface CaseSpec {
  side: number
  units: 'mm' | 'inch'
  shape: 'square' | 'round'
  axis: StockAxis
  toolType: ToolType
  radius: number
  kind: 'rotary_rough' | 'rotary_finish'
  range: 'chuck-model' | 'model-model' | 'chuck-end' | 'model-end'
  stockToLeave: number
}

/** A seeded LCG: the case list is fixed between runs. */
function seeded(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * A rotary project with one coaxial cylinder target and whatever retained stub
 * each cut range end leaves. `range` names which end is chuck-limited and which
 * is model-limited:
 *
 *  - `chuck-*`: the model starts near the bar's start so the chuck sets the
 *    start; `model-*`: it starts past the chuck's keep-out.
 *  - `*-model`: the model stops before the far end, leaving an upper stub;
 *    `*-end`: it runs to the bar's end, so only the other end is retained.
 */
function buildFixture(spec: CaseSpec): Fixture {
  const { side, units, shape, axis } = spec
  const length = side * 4
  const stock: BarStock = shape === 'round'
    ? roundStock(side, length, axis)
    : squareStock(side, length, axis)
  const bounds = getStockBounds(stock)
  const lower = axis === 'x' ? bounds.minX : bounds.minY
  const upper = axis === 'x' ? bounds.maxX : bounds.maxY
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const targetRadius = side * 0.35
  const grip = Math.min(convertLength(15, 'mm', units), length / 4)
  const keepOut = grip + spec.radius + side * 0.3
  // `chuck-*` starts near the bar's start so the chuck sets the cut start;
  // `model-*` starts past the chuck's keep-out, so the model does. A `*-model`
  // end stops well before the far end (an upper stub); `*-end` runs to it.
  const modelStart = spec.range.startsWith('chuck') ? lower + side * 0.1 : lower + keepOut
  const modelEnd = spec.range.endsWith('model') ? modelStart + side * 1.5 : upper
  assert.ok(modelEnd - modelStart > side * 0.5, `${spec.range}: the model spans a usable band`)
  const base = newProject('stub sweep', units)
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = pivot + barMaxRadius(stock) + 4 * spec.radius + convertLength(10, 'mm', units)
  base.stock = stock
  base.tools = [{
    ...defaultTool(units, 1),
    id: 't1',
    type: spec.toolType,
    diameter: 2 * spec.radius,
    defaultStepover: 0.4,
    defaultStepdown: side * 0.1,
  }]
  const mesh = coaxialCylinder(stock, targetRadius, modelStart, modelEnd, 96)
  base.modelAssets = {
    asset: serializeImportedMesh(
      { positions: mesh.positions, index: mesh.index, bounds: computeMeshBounds(mesh.positions) },
      'stl',
    ),
  }
  const model: SketchFeature = {
    id: 'model', name: 'Model', kind: 'stl', operation: 'model', authoringFace: 'top', folderId: null,
    sketch: {
      profile: axis === 'x'
        ? rectProfile(modelStart, centre - targetRadius, modelEnd - modelStart, 2 * targetRadius)
        : rectProfile(centre - targetRadius, modelStart, 2 * targetRadius, modelEnd - modelStart),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    stl: { format: 'stl', meshAssetId: 'asset', scale: 1, axisSwap: 'none' },
    z_top: pivot + targetRadius, z_bottom: pivot - targetRadius,
    visible: true, locked: false,
  }
  const around: SketchFeature = {
    ...model, id: 'sketch', name: 'Sketch', kind: 'rect', operation: 'subtract', stl: null,
    authoringFace: 'around', z_top: pivot + side / 2, z_bottom: pivot - side / 2,
  }
  const project = projectWithFeatures(base, [model, around])
  project.setups.push({ ...project.setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis, angleDeg: 0 } })
  project.activeSetupId = 'around'
  project.clamps = [{
    ...defaultRoundWorkholding('chuck', stock, units), id: 'chuck', name: 'Chuck', visible: true,
  }]
  const operation: Operation = {
    ...defaultOperationForTarget(project, spec.kind, spec.kind === 'rotary_rough' ? 'rough' : 'finish',
      { source: 'features', featureIds: ['model'] }, 0),
    setupId: 'around',
    stockToLeaveRadial: spec.stockToLeave,
    stepover: 0.4,
    stepdown: side * 0.1,
  }
  project.operations = [operation]
  const tool = normalizeToolForProject(project.tools[0], project)
  const along = rotaryAlongRange(
    stock, project.clamps, modelAlongExtent(project, model, axis), tool, { chuckEnd: 0, tailEnd: 0 },
  )
  assert.ok(along, `${spec.range}: the sweep fixture has room between its supports`)
  return { project, operation, tool, along, targetRadius }
}

console.log('Testing the seeded square sweep against both retained stubs...')
{
  const random = seeded(0x1016f6)
  const sides: Array<{ side: number; units: 'mm' | 'inch' }> = [
    { side: 12, units: 'mm' },
    { side: 25, units: 'mm' },
    { side: 2, units: 'inch' },
  ]
  let cases = 0
  let worst = 0
  let worstLabel = ''
  let movesWalked = 0
  let smallestRadius = Infinity
  let largestRadius = -Infinity
  const audit = (spec: CaseSpec): void => {
    const radiusMm = spec.units === 'mm' ? spec.radius : spec.radius * 25.4
    smallestRadius = Math.min(smallestRadius, radiusMm)
    largestRadius = Math.max(largestRadius, radiusMm)
    const fixture = buildFixture(spec)
    const result = generateRotaryOperation(fixture.project, fixture.operation)
    const label = `${spec.axis}/${spec.units}/${spec.toolType}/r${spec.radius.toFixed(3)}/${spec.range}`
    assert.deepEqual(result.warnings, [], `${label}: no warning`)
    assert.ok(result.moves.length > 0, `${label}: cuts`)
    const measured = stubPenetration(
      fixture.project.stock as BarStock, fixture.tool, result.moves, fixture.along.start, fixture.along.end,
    )
    movesWalked += result.moves.length
    if (measured.max > worst) {
      worst = measured.max
      worstLabel = label
    }
    assert.ok(measured.max <= 1e-6,
      `${label} range ${fixture.along.start.toFixed(3)}..${fixture.along.end.toFixed(3)}: `
      + `the cutter clears the retained stubs (${measured.max} at ${measured.where})`)
    cases++
  }
  // Both retained ends, both limiting causes, both axes and cutter shapes.
  for (const { side, units } of sides) {
    const perMm = units === 'mm' ? 1 : 1 / 25.4
    for (const axis of ['x', 'y'] as const) {
      for (const toolType of ['flat_endmill', 'ball_endmill'] as const) {
        for (const range of ['chuck-model', 'model-model'] as const) {
          audit({
            side, units, shape: 'square', axis, toolType,
            radius: (0.5 + random() * 5.5) * perMm,
            kind: 'rotary_finish',
            range,
            stockToLeave: random() < 0.25 ? 0 : 0.2 * perMm,
          })
        }
      }
    }
  }
  // A range that meets the bar's end has no stub there at all; on the Y axis
  // the default chuck limits that same end instead. One of each is enough.
  for (const spec of [
    { side: 25, units: 'mm' as const, shape: 'square' as const, axis: 'x' as const, toolType: 'flat_endmill' as const, radius: 3, kind: 'rotary_finish' as const, range: 'chuck-end' as const, stockToLeave: 0 },
    { side: 25, units: 'mm' as const, shape: 'square' as const, axis: 'x' as const, toolType: 'ball_endmill' as const, radius: 3, kind: 'rotary_finish' as const, range: 'model-end' as const, stockToLeave: 0 },
    { side: 25, units: 'mm' as const, shape: 'square' as const, axis: 'y' as const, toolType: 'flat_endmill' as const, radius: 3, kind: 'rotary_finish' as const, range: 'chuck-end' as const, stockToLeave: 0 },
    { side: 25, units: 'mm' as const, shape: 'square' as const, axis: 'y' as const, toolType: 'ball_endmill' as const, radius: 3, kind: 'rotary_finish' as const, range: 'model-end' as const, stockToLeave: 0 },
  ]) audit(spec)
  // Both ends of the 0.5..6 mm cutter range are pinned explicitly, not left to
  // the seed: the smallest cutter's stub sliver is only its own radius wide.
  for (const spec of [
    { side: 25, units: 'mm' as const, shape: 'square' as const, axis: 'x' as const, toolType: 'flat_endmill' as const, radius: 0.5, kind: 'rotary_finish' as const, range: 'model-model' as const, stockToLeave: 0 },
    { side: 25, units: 'mm' as const, shape: 'square' as const, axis: 'y' as const, toolType: 'ball_endmill' as const, radius: 0.5, kind: 'rotary_finish' as const, range: 'model-model' as const, stockToLeave: 0 },
    { side: 25, units: 'mm' as const, shape: 'square' as const, axis: 'x' as const, toolType: 'ball_endmill' as const, radius: 6, kind: 'rotary_finish' as const, range: 'model-model' as const, stockToLeave: 0 },
    { side: 25, units: 'mm' as const, shape: 'square' as const, axis: 'y' as const, toolType: 'flat_endmill' as const, radius: 6, kind: 'rotary_finish' as const, range: 'model-model' as const, stockToLeave: 0 },
  ]) audit(spec)
  // The rough shares the same sampling path; two seeded shapes cover it too.
  for (const toolType of ['flat_endmill', 'ball_endmill'] as const) {
    audit({
      side: 25, units: 'mm', shape: 'square', axis: 'x', toolType, radius: 3,
      kind: 'rotary_rough', range: 'model-model', stockToLeave: 0,
    })
  }
  assert.ok(cases >= 34, 'the sweep covers every side, axis, shape and retained end')
  assert.ok(smallestRadius <= 0.5 + 1e-9, `the sweep reaches the 0.5 mm cutter (${smallestRadius})`)
  assert.ok(largestRadius >= 6 - 1e-9, `the sweep reaches the 6 mm cutter (${largestRadius})`)
  assert.ok(movesWalked > 0, 'the sweep walks real motion')
  console.log(`  square sweep: ${cases} cases (cutters ${smallestRadius.toFixed(3)}..${largestRadius.toFixed(3)} mm), `
    + `${movesWalked} moves, worst stub penetration ${worst.toExponential(2)}`
    + `${worstLabel ? ` (${worstLabel})` : ''}`)
}

// ── 4. the band still reaches the target away from the stubs ──────────

console.log('Testing the simulated band reaches the target clear of the stubs...')
{
  const fixture = codexFixture()
  const stock = fixture.project.stock as BarStock
  const setup = fixture.project.setups.find((entry) => entry.id === 'around')
  assert.ok(setup, 'the fixture has its Around setup')
  const toolpath = generateRotaryOperation(fixture.project, fixture.operation)
  const paths = new Map([[fixture.operation.id, toolpath]])
  const input = buildSimulationSetupInput(fixture.project, setup, paths)
  assert.ok(input, 'the Around setup produces a simulation input')
  assert.ok(input.squareBar, 'a square blank carries its grid descriptor')
  const simulation = computeSimulationResult({
    setupInput: input,
    project: fixture.project,
    simulationMode: 'visible',
    simulationDetailCells: 280,
    selectedInSetup: null,
    paths,
  })
  const grid = simulation.grid
  const cell = grid.cellSize
  const reach = fixture.tool.radius
  const bandStart = fixture.along.start + reach
  const bandEnd = fixture.along.end - reach
  const target = fixture.targetRadius
  const allowance = convertLength(0.05, 'mm', 'mm')
  let audited = 0
  let worstTop = -Infinity
  let retainedCells = 0
  let lowestRetained = Infinity
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      const along = stock.axis === 'x'
        ? grid.originX + (col + 0.5) * cell
        : grid.originY + (row + 0.5) * cell
      const top = grid.topZ[row * grid.cols + col]
      if (along >= bandStart && along <= bandEnd) {
        audited++
        worstTop = Math.max(worstTop, top)
      } else if (along < fixture.along.start - cell) {
        retainedCells++
        lowestRetained = Math.min(lowestRetained, top)
      }
    }
  }
  assert.ok(audited > 0, 'the band away from the stubs has cells')
  assert.ok(worstTop <= target + allowance,
    `the band reaches the target radius away from the stubs (${worstTop} <= ${target + allowance})`)
  assert.ok(retainedCells > 0 && lowestRetained >= CODEX_SIDE / 2 - 1e-3,
    `the retained end keeps its material (${lowestRetained} >= ${CODEX_SIDE / 2})`)
  assert.deepEqual(simulation.warnings, [], 'the simulation replays without a warning')
  console.log(`  simulation: ${audited} band cells, worst ${worstTop.toFixed(4)} <= ${target + allowance}; `
    + `${retainedCells} retained cells at ${lowestRetained.toFixed(4)}+`)
}

// ── 5. the round bar is byte-identical to the base commit ────────────
//
// Captured from `HEAD` before this slice (`git show HEAD:...`): the round path
// never calls the floor or the step predicate, so these hashes must not move.

function moveFingerprint(result: { moves: readonly ToolpathMove[]; warnings: Array<{ code: string }> }): string {
  return [
    createHash('sha256').update(JSON.stringify(result.moves)).digest('hex').slice(0, 16),
    result.warnings.map((warning) => warning.code).join(','),
  ].join('|')
}

const ROUND_BASELINE: Record<string, string> = {
  'x/mm/flat_endmill/finish/chuck-model': '865aefcecc768b62|',
  'x/mm/ball_endmill/rough/model-model': 'c4e71162193ae7eb|',
  'y/mm/flat_endmill/finish/chuck-model': '862dc5617a9b5e58|',
  'y/inch/ball_endmill/rough/model-model': 'f260175bba58561f|',
}

console.log('Testing the round fixtures are byte-identical to the base commit...')
for (const key of Object.keys(ROUND_BASELINE)) {
  const [axis, units, toolType, shortKind, range] = key.split('/') as [
    StockAxis, 'mm' | 'inch', ToolType, 'rough' | 'finish', CaseSpec['range'],
  ]
  const kind = shortKind === 'rough' ? 'rotary_rough' : 'rotary_finish'
  const perMm = units === 'mm' ? 1 : 1 / 25.4
  const spec: CaseSpec = {
    side: units === 'mm' ? 25 : 2, units, shape: 'round', axis, toolType,
    radius: 3 * perMm, kind, range, stockToLeave: 0,
  }
  const fixture = buildFixture(spec)
  const result = generateRotaryOperation(fixture.project, fixture.operation)
  assert.equal(moveFingerprint(result), ROUND_BASELINE[key], `${key}: the round bar is unchanged`)
}

console.log('engine/toolpaths/squareRotaryStub.test.ts: all assertions passed')
