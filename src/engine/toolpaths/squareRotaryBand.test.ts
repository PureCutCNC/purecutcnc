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
 * The cutter fully inside the band on a square blank (#1016 C2-F7).
 *
 * `rotaryAlongRange` limits the cutter *centre* to the model's extent, so at a
 * cut range that ends on a retained square stub the centre sat exactly on the
 * stub face and the cutter reached a full radius into the retained end. Frank
 * measured it on `work/square-to-round-test-01.camj` (2 in square, a Ø2 cylinder
 * from 1..5, a 1/4 in flat, 0.32 stepover): the rough at A35.4 plunged at
 * `x = 5.000` to r1.315, then fed a staircase to `x = 4.880` before the real
 * pass. F7 pulls the centre one cutter radius inside each stubbed end, so the
 * cutter's rim is tangent to the face: every sample is at or beyond the F6
 * floor's reach, the floor stops binding, and the pass is a straight plunge, one
 * feed and a straight retract.
 *
 * The two fixtures are Frank's own file rebuilt from the mesh it stores (inch,
 * 2 in square, r1.0 target 1..5, 0.25 in flat, default chuck) and the 25 mm
 * case from F6 (25 mm square, `x < 18` retained, Ø20 target from 10..40, 6 mm
 * flat and ball). `bandStart`/`bandEnd` are the range the adapter derives
 * *before* the pull-in, i.e. the band the F7 tests are about.
 *
 * ## The independent oracle
 *
 * `stubPenetration` never reads the engine's placement: it rebuilds the real
 * cutter (flat cylinder, or ball plus shank) from the **emitted** moves, maps it
 * into the unturned blank through the frozen rotation, and intersects it with
 * the analytic retained square prism. Zero means no point of the cutter is
 * inside a stub, a tangency included.
 *
 * ## Mutations this file bites
 *
 *  - **range not pulled in at a stubbed end**: the finish's first/last sample is
 *    at `bandStart`/`bandEnd` instead of one radius inside, so the exact span
 *    assertions fail;
 *  - **pulled in by the cutter diameter**: the span starts `2 * rt` inside and
 *    the "still one radius inside" assertions and the simulated band check fail;
 *  - **pulled in at an end with no stub**: the model-to-bar-end fixture's last
 *    sample is one radius short of the bar end, and its exact-span assertion
 *    fails;
 *  - **a feed move allowed into a stub**: the endpoint containment and the
 *    penetration oracle fail;
 *  - **the pull-in skipped when the range collapses**: the collapsed fixture
 *    emits motion instead of `rotaryNoRoom`.
 *
 * Run with: npx tsx src/engine/toolpaths/squareRotaryBand.test.ts
 */

import assert from 'node:assert/strict'
import {
  barCentre,
  barInscribedRadius,
  barMaxRadius,
  barPivotZ,
  squareStock,
} from '../../types/barStock'
import { defaultTool, getStockBounds, newProject, rectProfile } from '../../types/project'
import type { BarStock, Operation, Project, SketchFeature, SquareStock, StockAxis, ToolType } from '../../types/project'
import { computeMeshBounds, serializeImportedMesh } from '../importedMesh'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import { convertLength } from '../../utils/units'
import { buildSimulationSetupInput } from '../../app/simulationSetup'
import { computeSimulationResult } from '../../app/simulationCompute'
import { generateRotaryOperation } from './rotaryOperation'
import { rotaryAlongRange } from './rotaryModel'
import { normalizeToolForProject } from './geometry'
import { resolveFinishModelSurface } from './finishModelSurface'
import type { NormalizedTool, ToolpathMove } from './types'

function approx(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: got ${actual}, expected ${expected}`)
}

// ── the exact retained-stub oracle (independent of the generator) ─────

interface SquarePolygon {
  readonly y: number[]
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
 * The largest distance any point of the real cutter lies inside either retained
 * stub prism, over every cut endpoint and densely along every cut segment. The
 * reference is the emitted motion, the frozen rotation and the analytic square
 * -- never the generator's range or floor. `0` is a tangency, not a gouge.
 */
function stubPenetration(
  stock: BarStock,
  tool: NormalizedTool,
  moves: readonly ToolpathMove[],
  bandStart: number,
  bandEnd: number,
): { max: number; where: string | null } {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const halfSide = barInscribedRadius(stock)
  const bounds = getStockBounds(stock)
  const lower = stock.axis === 'x' ? bounds.minX : bounds.minY
  const upper = stock.axis === 'x' ? bounds.maxX : bounds.maxY
  const radius = tool.radius
  const ball = tool.type === 'ball_endmill'
  const step = Math.min(convertLength(0.05, 'mm', tool.units), radius / 8)
  let max = 0
  let where: string | null = null
  const test = (px: number, tip: number, angle: number, label: string): void => {
    const polygon = rotatedSquare(halfSide, centre, pivot, angle)
    for (const [from, to, name] of [[lower, bandStart, 'lower'], [bandEnd, upper, 'upper']] as const) {
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
      const depth = radial > 0 ? Math.min(hi - lo, radial) : 0
      if (depth > max) {
        max = depth
        where = `${label} ${name} x=${px.toFixed(5)} tip=${tip.toFixed(5)} a=${angle.toFixed(4)}`
      }
    }
  }
  const alongOf = (point: { x: number; y: number }): number => stock.axis === 'x' ? point.x : point.y
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    const a0 = move.from.a ?? 0
    const a1 = move.to.a ?? a0
    const fromAlong = alongOf(move.from)
    const toAlong = alongOf(move.to)
    const dz = move.to.z - move.from.z
    const lo = Math.min(fromAlong, toAlong) - radius
    const hi = Math.max(fromAlong, toAlong) + radius
    if (hi < lower || (lo > bandStart && (hi < bandEnd || lo > upper))) continue
    const steps = Math.max(1, Math.ceil(Math.hypot(toAlong - fromAlong, dz) / step))
    for (let s = 0; s <= steps; s++) {
      const f = s / steps
      test(fromAlong + (toAlong - fromAlong) * f, move.from.z + dz * f - pivot, a0 + (a1 - a0) * f,
        `${move.kind} ${fromAlong.toFixed(3)}->${toAlong.toFixed(3)}`)
    }
  }
  return { max, where }
}

// ── fixtures ──────────────────────────────────────────────────────────

type Kind = 'rotary_rough' | 'rotary_finish'

interface BandSpec {
  side: number
  length: number
  units: 'mm' | 'inch'
  /** Finished target radius. */
  radius: number
  modelStart: number
  modelEnd: number
  toolRadius: number
  toolType: ToolType
  kind: Kind
  stepover: number
  stepdown: number
  axis?: StockAxis
}

interface BandFixture {
  project: Project
  operation: Operation
  stock: SquareStock
  tool: NormalizedTool
  /** The range the adapter derives before the F7 pull-in: the band's stub faces. */
  band: { start: number; end: number }
  targetRadius: number
}

function coaxialCylinder(
  stock: SquareStock,
  radius: number,
  from: number,
  to: number,
  segments = 192,
) {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const along of [from, to]) {
    for (let i = 0; i < segments; i++) {
      const t = (2 * Math.PI * i) / segments
      if (stock.axis === 'x') positions.push(along, centre + radius * Math.cos(t), pivot + radius * Math.sin(t))
      else positions.push(centre + radius * Math.cos(t), along, pivot + radius * Math.sin(t))
    }
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    index.push(i, j, segments + j, i, segments + j, segments + i)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/**
 * Frank's file, rebuilt from the mesh it stores: inch, 2 in square, a Ø2
 * cylinder target from `x = 1` to `x = 5`, a 0.25 in flat end mill. The stock
 * is 6 in long and the default chuck keeps 15 mm, so the model sets both band
 * ends; `work/square-to-round-test-01.camj` measured the same `1..5`.
 */
function frankFixture(kind: Kind, toolType: ToolType = 'flat_endmill'): BandFixture {
  return bandFixture({
    side: 2, length: 6, units: 'inch', radius: 1, modelStart: 1, modelEnd: 5,
    toolRadius: 0.125, toolType, kind, stepover: 0.32, stepdown: 0.125,
  })
}

/**
 * The 25 mm case from F6: 25 mm square, default chuck (15 mm grip), a Ø20
 * target from 10..40, so the chuck's keep-out sets the start at 18 and the model
 * the end at 40.
 */
function codexBandFixture(kind: Kind, toolType: ToolType): BandFixture {
  return bandFixture({
    side: 25, length: 100, units: 'mm', radius: 10, modelStart: 10, modelEnd: 40,
    toolRadius: 3, toolType, kind, stepover: 0.4, stepdown: 2,
  })
}

function bandFixture(spec: BandSpec): BandFixture {
  const axis = spec.axis ?? 'x'
  const stock = squareStock(spec.side, spec.length, axis)
  const base = newProject('band', spec.units)
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = barPivotZ(stock) + barMaxRadius(stock) + 4 * spec.toolRadius
  base.stock = stock
  base.tools = [{
    ...defaultTool(spec.units, 1),
    id: 't1',
    type: spec.toolType,
    diameter: 2 * spec.toolRadius,
    defaultStepover: 0.4,
    defaultStepdown: spec.stepdown,
  }]
  const mesh = coaxialCylinder(stock, spec.radius, spec.modelStart, spec.modelEnd)
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
      profile: axis === 'x'
        ? rectProfile(spec.modelStart, centre - spec.radius, spec.modelEnd - spec.modelStart, 2 * spec.radius)
        : rectProfile(centre - spec.radius, spec.modelStart, 2 * spec.radius, spec.modelEnd - spec.modelStart),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    stl: { format: 'stl', meshAssetId: 'asset', scale: 1, axisSwap: 'none' },
    z_top: pivot + spec.radius, z_bottom: pivot - spec.radius,
    visible: true, locked: false,
  }
  const around: SketchFeature = {
    ...model, id: 'sketch', name: 'Sketch', kind: 'rect', operation: 'subtract', stl: null,
    authoringFace: 'around', z_top: pivot + spec.side / 2, z_bottom: pivot - spec.side / 2,
  }
  const project = projectWithFeatures(base, [model, around])
  project.setups.push({
    ...project.setups[0], id: 'around', name: 'Around', kind: 'around',
    orientation: { axis, angleDeg: 0 },
  })
  project.activeSetupId = 'around'
  project.clamps = [{ ...defaultRoundWorkholding('chuck', stock, spec.units), id: 'chuck', name: 'Chuck', visible: true }]
  const operation: Operation = {
    ...defaultOperationForTarget(
      project, spec.kind, spec.kind === 'rotary_rough' ? 'rough' : 'finish',
      { source: 'features', featureIds: ['model'] }, 0,
    ),
    setupId: 'around',
    stockToLeaveRadial: 0,
    stepover: spec.stepover,
    stepdown: spec.stepdown,
  }
  project.operations = [operation]
  const tool = normalizeToolForProject(project.tools[0], project)
  const surface = resolveFinishModelSurface(project, [model])
  assert.ok(surface, 'the fixture model resolves')
  const axisIndex = axis === 'x' ? 0 : 1
  let min = Infinity
  let max = -Infinity
  for (let i = axisIndex; i < surface.mesh.positions.length; i += 3) {
    min = Math.min(min, surface.mesh.positions[i])
    max = Math.max(max, surface.mesh.positions[i])
  }
  const band = rotaryAlongRange(stock, project.clamps, { min, max }, tool, { chuckEnd: 0, tailEnd: 0 })
  assert.ok(band, 'the fixture has room between its supports')
  return { project, operation, stock, tool, band, targetRadius: spec.radius }
}

/** The along coordinate of an emitted point. */
function alongOf(stock: BarStock, point: { x: number; y: number }): number {
  return stock.axis === 'x' ? point.x : point.y
}

const TOOL_TYPES: ReadonlyArray<Extract<ToolType, 'flat_endmill' | 'ball_endmill'>> = ['flat_endmill', 'ball_endmill']

// ── 1. the exact cutter-centre span on Frank's own case ───────────────

console.log('Testing the cutter centre starts and ends one radius inside Frank\'s band...')
{
  const finish = frankFixture('rotary_finish')
  approx(finish.band.start, 1, 'Frank\'s band starts at the model')
  approx(finish.band.end, 5, 'Frank\'s band ends at the model')
  const rt = finish.tool.radius
  const spanStart = finish.band.start + rt
  const spanEnd = finish.band.end - rt
  const result = generateRotaryOperation(finish.project, finish.operation)
  assert.deepEqual(result.warnings, [], 'Frank\'s finish generates without a warning')
  assert.ok(result.moves.length > 0, 'Frank\'s finish cuts')
  // The finish cuts every sample of its span, so the emitted extremes are the
  // span's own ends: exactly one radius in, not two and not zero.
  const alongs = result.moves.flatMap((move) => [alongOf(finish.stock, move.from), alongOf(finish.stock, move.to)])
  approx(Math.min(...alongs), spanStart, 'the first sample is one cutter radius inside the band')
  approx(Math.max(...alongs), spanEnd, 'the last sample is one cutter radius inside the band')
  for (const move of result.moves) {
    for (const point of [move.from, move.to]) {
      const along = alongOf(finish.stock, point)
      assert.ok(along >= spanStart - 1e-9 && along <= spanEnd + 1e-9,
        `every emitted point is inside the pulled-in span (${along})`)
    }
  }
  // The measured shape of the pass: rapid at travel height, one straight plunge,
  // one feed across the span at the target radius, and a straight retract.
  const first = result.moves[0]
  assert.equal(first.kind, 'rapid', 'the pass opens with a rapid')
  const plunge = result.moves[1]
  assert.equal(plunge.kind, 'plunge', 'a straight plunge follows it')
  approx(alongOf(finish.stock, plunge.from), spanStart, 'the plunge is at the span start')
  approx(alongOf(finish.stock, plunge.to), spanStart, 'the plunge is vertical')
  const feed = result.moves.find((move) => move.kind === 'cut'
    && Math.abs(alongOf(finish.stock, move.to) - alongOf(finish.stock, move.from)) > 1e-9)
  assert.ok(feed, 'the pass feeds along the bar')
  approx(alongOf(finish.stock, feed.from), spanStart, 'the feed starts at the span start')
  approx(alongOf(finish.stock, feed.to), spanEnd, 'the feed ends at the span end')
  approx(feed.from.z - barPivotZ(finish.stock), finish.targetRadius, 'the feed cuts at the target radius', 0.01)
  const retract = result.moves[result.moves.length - 1]
  assert.equal(retract.kind, 'rapid', 'the pass ends with the final retract')
  assert.equal(alongOf(finish.stock, retract.from), alongOf(finish.stock, retract.to),
    'the final retract is straight up, not along the bar')
  assert.ok(Math.abs(alongOf(finish.stock, retract.from) - spanStart) <= 1e-9
    || Math.abs(alongOf(finish.stock, retract.from) - spanEnd) <= 1e-9,
  'the final retract leaves from a span end')
  const measured = stubPenetration(finish.stock, finish.tool, result.moves, finish.band.start, finish.band.end)
  assert.ok(measured.max <= 1e-6,
    `Frank's finish clears both retained ends (${measured.max} at ${measured.where})`)

  const rough = frankFixture('rotary_rough')
  const roughResult = generateRotaryOperation(rough.project, rough.operation)
  assert.deepEqual(roughResult.warnings, [], 'Frank\'s rough generates without a warning')
  assert.ok(roughResult.moves.length > 0, 'Frank\'s rough cuts')
  const roughAlongs = roughResult.moves.flatMap((move) => [alongOf(rough.stock, move.from), alongOf(rough.stock, move.to)])
  assert.ok(Math.min(...roughAlongs) >= spanStart - 1e-9, 'the rough never starts inside the stub reach')
  assert.ok(Math.max(...roughAlongs) <= spanEnd + 1e-9, 'the rough never ends inside the stub reach')
  const roughMeasured = stubPenetration(rough.stock, rough.tool, roughResult.moves, rough.band.start, rough.band.end)
  assert.ok(roughMeasured.max <= 1e-6,
    `Frank's rough clears both retained ends (${roughMeasured.max} at ${roughMeasured.where})`)
  console.log(`  Frank: band ${finish.band.start}..${finish.band.end} in, span ${spanStart}..${spanEnd}, `
    + `finish ${result.moves.length} moves, rough ${roughResult.moves.length} moves, `
    + `penetration ${Math.max(measured.max, roughMeasured.max).toExponential(2)}`)
}

// ── 2. the 25 mm case, flat and ball, rough and finish ────────────────

console.log('Testing the 25 mm case on both cutter shapes and both pass kinds...')
{
  let checked = 0
  for (const toolType of TOOL_TYPES) {
    for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
      const fixture = codexBandFixture(kind, toolType)
      const rt = fixture.tool.radius
      const spanStart = fixture.band.start + rt
      const spanEnd = fixture.band.end - rt
      approx(fixture.band.start, 18, `${toolType}/${kind}: the chuck-limited band starts at 18`)
      approx(fixture.band.end, 40, `${toolType}/${kind}: the model-limited band ends at 40`)
      const result = generateRotaryOperation(fixture.project, fixture.operation)
      assert.deepEqual(result.warnings, [], `${toolType}/${kind}: generates without a warning`)
      assert.ok(result.moves.length > 0, `${toolType}/${kind}: cuts`)
      let min = Infinity
      let max = -Infinity
      for (const move of result.moves) {
        for (const point of [move.from, move.to]) {
          const along = alongOf(fixture.stock, point)
          min = Math.min(min, along)
          max = Math.max(max, along)
          assert.ok(along >= spanStart - 1e-9 && along <= spanEnd + 1e-9,
            `${toolType}/${kind}: the cutter footprint stays inside the band at ${along}`)
        }
      }
      assert.ok(min >= spanStart - 1e-9, `${toolType}/${kind}: no sample reaches the lower stub (${min})`)
      assert.ok(max <= spanEnd + 1e-9, `${toolType}/${kind}: no sample reaches the upper stub (${max})`)
      const measured = stubPenetration(fixture.stock, fixture.tool, result.moves, fixture.band.start, fixture.band.end)
      assert.ok(measured.max <= 1e-6,
        `${toolType}/${kind}: zero retained-stub intrusion (${measured.max} at ${measured.where})`)
      checked++
    }
  }
  assert.equal(checked, 4, 'both cutter shapes and both pass kinds are exercised')
  console.log(`  25 mm: ${checked} cases, span 21..37 mm, zero retained-stub penetration`)
}

// ── 3. the F6 floor never binds, and an end with no stub is unchanged ──

console.log('Testing the F6 floor is a net that never binds and an unstubbed end is untouched...')
{
  // Every emitted point is at least the cutter radius from both stub faces, so
  // the exact F6 contact floor is -Infinity everywhere on the motion.
  for (const toolType of TOOL_TYPES) {
    const fixture = codexBandFixture('rotary_finish', toolType)
    const result = generateRotaryOperation(fixture.project, fixture.operation)
    let closest = Infinity
    for (const move of result.moves) {
      for (const point of [move.from, move.to]) {
        const along = alongOf(fixture.stock, point)
        closest = Math.min(closest, along - fixture.band.start, fixture.band.end - along)
      }
    }
    assert.ok(closest >= fixture.tool.radius - 1e-9,
      `${toolType}: no sample is inside the retained stub's reach (${closest} >= ${fixture.tool.radius})`)
  }

  // A band that runs to the bar's own end has no stub there: only the stubbed
  // start is pulled in. The model's end is the stock's end (6 in), so the last
  // sample must still be exactly 6, not one radius short of it.
  const open = bandFixture({
    side: 2, length: 6, units: 'inch', radius: 1, modelStart: 1, modelEnd: 6,
    toolRadius: 0.125, toolType: 'flat_endmill', kind: 'rotary_finish', stepover: 0.32, stepdown: 0.125,
  })
  approx(open.band.end, 6, 'the band reaches the bar end')
  const result = generateRotaryOperation(open.project, open.operation)
  assert.deepEqual(result.warnings, [], 'the open-end fixture generates without a warning')
  const alongs = result.moves.flatMap((move) => [alongOf(open.stock, move.from), alongOf(open.stock, move.to)])
  approx(Math.min(...alongs), open.band.start + open.tool.radius, 'the stubbed start is still pulled in')
  approx(Math.max(...alongs), open.band.end, 'the bar end is not pulled in')
  console.log('  floor net: every sample at least one radius from a stub; open end keeps its full reach')
}

// ── 4. a collapsed span refuses with rotaryNoRoom ─────────────────────

console.log('Testing a collapsed cutter-centre span refuses with rotaryNoRoom...')
{
  // A 0.2 in band with a 1/4 in flat: the two pulls cross, there is no room for
  // the cutter inside the band, and the refusal is the existing rotaryNoRoom.
  const collapsed = bandFixture({
    side: 2, length: 6, units: 'inch', radius: 1, modelStart: 1, modelEnd: 1.2,
    toolRadius: 0.125, toolType: 'flat_endmill', kind: 'rotary_finish', stepover: 0.32, stepdown: 0.125,
  })
  approx(collapsed.band.end - collapsed.band.start, 0.2, 'the fixture band is narrower than the cutter', 1e-6)
  const result = generateRotaryOperation(collapsed.project, collapsed.operation)
  assert.deepEqual(result.moves, [], 'the collapsed span emits no motion')
  assert.deepEqual(result.warnings.map((warning) => warning.code), ['rotaryNoRoom'],
    'the collapsed span says there is no room')
  console.log('  collapsed span: rotaryNoRoom, no motion')
}

// ── 5. the band beyond one cutter radius still reaches the target ─────

console.log('Testing the simulated band beyond one radius from each end reaches the target...')
{
  const audit = (label: string, fixture: BandFixture): void => {
    const setup = fixture.project.setups.find((entry) => entry.id === 'around')
    assert.ok(setup, `${label}: the fixture has its Around setup`)
    const toolpath = generateRotaryOperation(fixture.project, fixture.operation)
    const paths = new Map([[fixture.operation.id, toolpath]])
    const input = buildSimulationSetupInput(fixture.project, setup, paths)
    assert.ok(input, `${label}: the Around setup produces a simulation input`)
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
    const rt = fixture.tool.radius
    // The band's finished part starts one cutter radius inside each end; the
    // material within a radius of a stub keeps the shoulder fillet, so it is
    // outside the audited band. The allowance is the shared kernel's own
    // accuracy on a flat that stands at the target (F8 owns its true width).
    const bandStart = fixture.band.start + rt
    const bandEnd = fixture.band.end - rt
    const allowance = convertLength(0.05, 'mm', fixture.project.meta.units)
    let audited = 0
    let worstTop = -Infinity
    let retained = 0
    let lowestRetained = Infinity
    for (let row = 0; row < grid.rows; row++) {
      for (let col = 0; col < grid.cols; col++) {
        const along = fixture.stock.axis === 'x'
          ? grid.originX + (col + 0.5) * cell
          : grid.originY + (row + 0.5) * cell
        const top = grid.topZ[row * grid.cols + col]
        if (along >= bandStart && along <= bandEnd) {
          audited++
          worstTop = Math.max(worstTop, top)
        } else if (along < fixture.band.start - cell) {
          retained++
          lowestRetained = Math.min(lowestRetained, top)
        }
      }
    }
    assert.ok(audited > 0, `${label}: the audited band has cells`)
    assert.ok(worstTop <= fixture.targetRadius + allowance,
      `${label}: the band reaches the target away from the shoulders (${worstTop} <= ${fixture.targetRadius + allowance})`)
    assert.ok(retained > 0 && lowestRetained >= barInscribedRadius(fixture.stock) - 1e-3,
      `${label}: the retained end keeps its square material (${lowestRetained} >= ${barInscribedRadius(fixture.stock)})`)
    assert.deepEqual(simulation.warnings, [], `${label}: the simulation replays without a warning`)
    console.log(`  ${label}: ${audited} band cells, worst ${worstTop.toFixed(4)} <= `
      + `${(fixture.targetRadius + allowance).toFixed(4)}; ${retained} retained cells at `
      + `${lowestRetained.toFixed(4)}+`)
  }
  audit('Frank', frankFixture('rotary_finish'))
  audit('25 mm flat', codexBandFixture('rotary_finish', 'flat_endmill'))
  // The ball's band is audited by its emitted moves and the stub oracle above,
  // not by the shared kernel: with F8 not landed yet the wrapped kernel treats a
  // cell's across offset as a straight distance and under-removes below the
  // frame radius (measured 0.112 mm here, on a 10 mm target inside a 12.5 mm
  // frame). That is F8's own test, and F7 must not be pinned to it.
}

console.log('engine/toolpaths/squareRotaryBand.test.ts: all assertions passed')
