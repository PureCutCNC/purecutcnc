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
 * #1103 slice ca-b: the forward helix (`rotaryContinuous.ts`).
 *
 * The helix replaces alternating rings inside an uninterrupted band of a round
 * bar, so the tests here are about the four things that make it different from
 * the ring path and the five mutations that would quietly break them.
 *
 * 1. **Sampled, never interpolated (a ridge between two ring positions).** A
 *    narrow raised ring at an along position no ring pass visits is invisible to
 *    both neighbouring rings; `block 1` places one exactly on a helix knot and
 *    requires that pose's tip to be the surface's own, not the average of the
 *    ring tips around it. This is the mutation "interpolate heights between ring
 *    positions" and it is caught by three millimetres on this fixture.
 * 2. **Pitch.** The axial advance per revolution may never exceed the requested
 *    stepover. `block 2` uses a band that is not a whole number of stepovers, so
 *    a rounded or floored revolution count overshoots the stepover.
 * 3. **Complete end rings and monotone A.** The band is bounded by a *complete*
 *    ring at each axial end, and A only ever grows -- no modulo wrap, no closing
 *    unwind. `block 3` counts each boundary ring's poses and its exact 360
 *    degrees, which is what "omit an end ring" breaks, and re-samples poses
 *    against the sampler to prove they are not interpolated.
 * 4. **Refinement.** A square prism is turned so a corner sits at the midpoint
 *    of the initial angular step, where a straight `(along, A, Z)` move sags
 *    below the material. The emitted path must be within the operation's
 *    0.005 mm tolerance at every segment's midpoint -- measured by sampling that
 *    midpoint independently -- and the same fixture with `rounds: 0` (the
 *    no-refinement path, the mutation) must not be. `block 4`.
 * 5. **Budgets and cancellation.** A sample or row limit that runs out reports
 *    `exhausted` with no points (so the caller keeps rings); `shouldStop` reports
 *    `stopped`. `block 5` sets both limits below the first pass, so a module that
 *    bypasses the budget returns a path and fails.
 *
 * The fixture is a Ø20 x 60 mm bar. `angularIntervals` caps the angle step at
 * `sqrt(8 R * 0.005)` = 0.632 mm of surface on this bar, so the ring grid is
 * 100 intervals of 3.6 degrees whatever `sampleSpacing` above that asks for;
 * `STEPS_PER_TURN` recomputes it here from the bar, never from the module.
 * Every reference tip comes from `sampleRotaryModel` at the exact pose, so the
 * tests compare the emitted motion against the sampler, not against the
 * module's own bookkeeping.
 */

import assert from 'node:assert/strict'
import { barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { roundStock } from '../../types/project'
import type { BarStock, RoundStock } from '../../types/project'
import { createRotarySamplingPrep, sampleRotaryModel } from '../toolpaths/rotarySampling'
import type { RotarySamplingPrep } from '../toolpaths/rotarySampling'
import { buildContinuousHelix, MAX_HELIX_ROWS } from './rotaryContinuous'
import type { ContinuousHelix, ContinuousHelixInput } from './rotaryContinuous'
import type { RotaryModelMesh } from './rotaryModel'
import type { NormalizedTool, ToolpathPoint } from './types'
import type { ToolpathWarning } from './warningCodes'

const STOCK: RoundStock = roundStock(20, 60)
const PIVOT = barPivotZ(STOCK)
const MAX_RADIUS = barMaxRadius(STOCK)
const CELL = 0.05
const BAND = { start: 6, end: 24 }
const STEPOVER = 2
const SAMPLE_SPACING = 2

const FLAT: NormalizedTool = {
  id: 'flat-1', name: '1 mm flat end mill', sourceUnits: 'mm', units: 'mm',
  type: 'flat_endmill', diameter: 1, radius: 0.5, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}

const BALL: NormalizedTool = {
  ...FLAT,
  id: 'ball-2',
  name: '2 mm ball nose',
  type: 'ball_endmill',
  diameter: 2,
  radius: 1,
}

/** The ring grid's angle step, recomputed from the bar (not from the module). */
function stepsPerTurn(stock: BarStock, sampleSpacing: number): number {
  const cap = Math.sqrt(8 * barMaxRadius(stock) * 0.005)
  return Math.ceil((2 * Math.PI * barMaxRadius(stock)) / Math.min(sampleSpacing, cap))
}

const STEPS = stepsPerTurn(STOCK, SAMPLE_SPACING)
assert.equal(STEPS, 100, 'the fixture bar needs 100 angular steps: sqrt(8 R tol) caps the arc')

/** A lathe-turned mesh: one ring of `segments` vertices per ring in `rings`. */
function lathe(rings: readonly { along: number; radius: number }[], segments: number): RotaryModelMesh {
  const positions: number[] = []
  const index: number[] = []
  for (const ring of rings) {
    for (let j = 0; j < segments; j++) {
      const t = (2 * Math.PI * j) / segments
      positions.push(ring.along, 10 + ring.radius * Math.cos(t), 10 + ring.radius * Math.sin(t))
    }
  }
  for (let s = 0; s + 1 < rings.length; s++) {
    for (let j = 0; j < segments; j++) {
      const j2 = (j + 1) % segments
      const a = s * segments + j
      const b = s * segments + j2
      const c = (s + 1) * segments + j2
      const d = (s + 1) * segments + j
      index.push(a, b, c, a, c, d)
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/** A closed extrusion of `crossSection` between the two along positions. */
function prism(crossSection: readonly (readonly [number, number])[], ends: readonly number[]): RotaryModelMesh {
  const positions: number[] = []
  const index: number[] = []
  for (const along of ends) {
    for (const [across, up] of crossSection) positions.push(along, 10 + across, 10 + up)
  }
  const n = crossSection.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    index.push(i, j, n + j, i, n + j, n + i)
  }
  for (let i = 1; i < n - 1; i++) index.push(0, i + 1, i, n, n + i, n + i + 1)
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/** A Ø20 bar turned to r6 with one narrow raised ring at x = 7. */
const RIDGE = lathe([
  { along: 4, radius: 6 },
  { along: 6.9, radius: 6 },
  { along: 6.98, radius: 9 },
  { along: 7.02, radius: 9 },
  { along: 7.1, radius: 6 },
  { along: 26, radius: 6 },
], 128)

const HALF_SIDE = 5
const SQUARE_PRISM = prism([[-HALF_SIDE, -HALF_SIDE], [HALF_SIDE, -HALF_SIDE], [HALF_SIDE, HALF_SIDE], [-HALF_SIDE, HALF_SIDE]], [4, 26])

function prepFor(mesh: RotaryModelMesh, tool: NormalizedTool, along: readonly number[], stock: BarStock = STOCK): RotarySamplingPrep {
  return createRotarySamplingPrep(mesh, stock, tool, {
    along,
    requestedCellSize: CELL,
    conservativeCellBounds: true,
    workspace: {},
  })
}

const alongOf = (point: ToolpathPoint): number => point.x
const tipOf = (point: ToolpathPoint): number => point.z - PIVOT
const angleOf = (point: ToolpathPoint): number => point.a ?? 0

/** The safe tip radius at one exact pose, from the sampler alone. */
function support(mesh: RotaryModelMesh, tool: NormalizedTool, along: number, angle: number): number {
  const sampled = sampleRotaryModel(mesh, STOCK, tool, {
    anglesDeg: [angle],
    along: [along],
    requestedCellSize: CELL,
    conservativeCellBounds: true,
  }, [])
  const raw = sampled.tipRadius[0][0]
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 0), MAX_RADIUS) : NaN
}

function build(
  mesh: RotaryModelMesh,
  tool: NormalizedTool,
  overrides: Partial<ContinuousHelixInput> = {},
): ContinuousHelix {
  const warnings: ToolpathWarning[] = []
  const helix = buildContinuousHelix({
    // The prep's own `along` list is unused by the helix, which supplies each
    // row's positions; the ring grid would pass its along grid here.
    prep: prepFor(mesh, tool, [BAND.start]),
    tool,
    band: BAND,
    stepover: STEPOVER,
    sampleSpacing: SAMPLE_SPACING,
    stockToLeave: 0,
    warnings,
    ...overrides,
  })
  assert.ok(helix !== null, 'the round-bar band is a case the helix covers')
  return helix
}

function buildOk(
  mesh: RotaryModelMesh,
  tool: NormalizedTool,
  overrides: Partial<ContinuousHelixInput> = {},
): ContinuousHelix {
  const helix = build(mesh, tool, overrides)
  assert.equal(helix.exhausted, false, 'the fixture stays inside its budget')
  assert.equal(helix.stopped, false, 'the fixture is not cancelled')
  assert.equal(helix.uncovered, false, 'the fixture band has model under every pose')
  return helix
}

/** The largest amount by which a segment's straight move cuts below the surface. */
function worstMidpointCut(
  helix: ContinuousHelix,
  mesh: RotaryModelMesh,
  tool: NormalizedTool,
): { worst: number; segments: number } {
  let worst = Number.NEGATIVE_INFINITY
  for (let i = 1; i < helix.points.length; i++) {
    const from = helix.points[i - 1]
    const to = helix.points[i]
    const along = (alongOf(from) + alongOf(to)) / 2
    const angle = (angleOf(from) + angleOf(to)) / 2
    const chord = (tipOf(from) + tipOf(to)) / 2
    const mid = support(mesh, tool, along, angle)
    assert.ok(Number.isFinite(mid), `segment ${i}: the midpoint pose has model under the tool`)
    const cut = mid - chord
    if (cut > worst) worst = cut
  }
  return { worst, segments: helix.points.length - 1 }
}

/**
 * 1. The narrow ridge between two ring positions.
 *
 * The ring grid steps two millimetres along this band, so x = 7 lies exactly
 * between the ring at 6 and the ring at 8 and neither pass can see it (a 1 mm
 * flat's footprint is half a millimetre). The helix crosses x = 7 on its first
 * turn, and its tip there must be the ridge's own sampled support -- 9.05 --
 * never the 6.05 the two neighbouring ring tips average to. That average is the
 * mutation "interpolate heights between ring positions", and the three
 * millimetres between it and the sampled value are what catches it.
 */
{
  const helix = buildOk(RIDGE, FLAT, { startAngle: 0 })
  const ridge = helix.points.find((point) => Math.abs(alongOf(point) - 7) < 1e-9)
  assert.ok(ridge, 'the helix visits the ridge position on its first turn')
  const angle = angleOf(ridge)
  const direct = support(RIDGE, FLAT, 7, angle)
  assert.ok(Math.abs(tipOf(ridge) - direct) < 1e-6,
    `the ridge pose is sampled at the ridge: got ${tipOf(ridge)}, sampler ${direct}`)
  assert.ok(tipOf(ridge) > 9, `the ridge's support is the ridge top (got ${tipOf(ridge)})`)
  const left = support(RIDGE, FLAT, 6, angle)
  const right = support(RIDGE, FLAT, 8, angle)
  const interpolated = (left + right) / 2
  assert.ok(Math.abs(interpolated - 6.05) < 0.2,
    `neither neighbouring ring position can see the ridge (got ${left}, ${right})`)
  assert.ok(direct - interpolated > 1,
    `interpolating between the ring positions would miss the ridge by ${direct - interpolated} mm`)
  // The emitted path really does carry a cut at the ridge's own height, not
  // just a sample that the merge later dropped.
  assert.ok(helix.points.some((point) => tipOf(point) > 9), 'the ridge height is in the emitted path')
  console.log(`  ridge: sampled ${tipOf(ridge).toFixed(3)} mm, ring interpolation ${interpolated.toFixed(3)} mm`)
}

/**
 * 2. The pitch never exceeds the stepover.
 *
 * The band is 16.8 mm long, which is 8.4 of the requested 2 mm steps. Nine whole
 * revolutions are the only count under the limit (`ceil`), and the resulting
 * pitch is 1.867 mm. A rounded or floored revolution count would put 2.1 mm
 * between threads, which the assertion catches before the geometry matters.
 */
{
  const band = { start: 6, end: 22.8 }
  const helix = buildOk(RIDGE, FLAT, { band })
  assert.ok(helix.pitch <= STEPOVER + 1e-12,
    `the axial advance per revolution is at most the stepover (${helix.pitch} <= ${STEPOVER})`)
  assert.equal(helix.turns, 9, '16.8 mm at a 2 mm stepover is nine revolutions')
  assert.ok(Math.abs(helix.pitch - 16.8 / 9) < 1e-12, `pitch is the band divided into whole turns (${helix.pitch})`)
  // The commanded pitch, measured from the path: the pose one whole revolution
  // after the helix's first knot is exactly one pitch further along.
  const firstKnot = helix.points.find((point) => Math.abs(angleOf(point) - 360) < 1e-9)
  assert.ok(firstKnot, 'the helix starts at the first ring\'s end angle')
  const oneTurnOn = helix.points.find((point) => Math.abs(angleOf(point) - 720) < 1e-9)
  assert.ok(oneTurnOn, 'the next revolution boundary is a pose')
  assert.ok(Math.abs(alongOf(oneTurnOn) - alongOf(firstKnot) - helix.pitch) < 1e-9,
    `one revolution advances one pitch (${alongOf(oneTurnOn) - alongOf(firstKnot)} vs ${helix.pitch})`)
  assert.ok(alongOf(firstKnot) - band.start <= STEPOVER + 1e-12,
    'the first thread is no farther than a stepover from the start ring')
  console.log(`  pitch: ${helix.turns} turns, ${helix.pitch.toFixed(4)} mm per revolution`)
}

/**
 * 3. Complete boundary rings, monotone A, and the band's exact ends.
 *
 * Both axial ends carry a full ring: `STEPS + 1` poses, the first at the start
 * angle and the last exactly one turn later. Commanded A strictly increases
 * across the whole path and spans `360 * (turns + 2)` -- the two rings plus the
 * helix -- with no wrap and no closing unwind. Every point stays inside the
 * band, and every pose is sampled at its own `(along, A)`: a subset is compared
 * with an independent sampler call at exactly that pose.
 */
{
  const helix = buildOk(RIDGE, FLAT, { startAngle: 0 })
  const atStart = helix.points.filter((point) => Math.abs(alongOf(point) - BAND.start) < 1e-9)
  const atEnd = helix.points.filter((point) => Math.abs(alongOf(point) - BAND.end) < 1e-9)
  assert.equal(atStart.length, STEPS + 1, 'the start ring is a complete turn')
  assert.equal(atEnd.length, STEPS + 1, 'the end ring is a complete turn')
  assert.equal(angleOf(atStart[0]), 0, 'the start ring opens at the requested angle')
  assert.equal(angleOf(atStart[STEPS]), 360, 'the start ring closes a whole turn later')
  assert.equal(angleOf(atEnd[0]), 360 * (1 + helix.turns), 'the end ring opens where the helix leaves')
  assert.equal(angleOf(atEnd[STEPS]), 360 * (helix.turns + 2), 'the end ring closes the path')
  for (let i = 1; i <= STEPS; i++) {
    assert.ok(Math.abs(angleOf(atStart[i]) - angleOf(atStart[i - 1]) - 360 / STEPS) < 1e-9,
      `the start ring advances one angular step at a time (${i})`)
  }
  // A grows, never wraps, and never rewinds.
  for (let i = 1; i < helix.points.length; i++) {
    assert.ok(angleOf(helix.points[i]) > angleOf(helix.points[i - 1]),
      `commanded A strictly increases at pose ${i}`)
  }
  assert.equal(angleOf(helix.points[helix.points.length - 1]) - angleOf(helix.points[0]), 360 * (helix.turns + 2),
    'the path spans two boundary rings plus the helix, with no closing unwrap')
  // The band is obeyed exactly: the pull-in the caller passed is the path's ends.
  for (const point of helix.points) {
    assert.ok(alongOf(point) >= BAND.start - 1e-12 && alongOf(point) <= BAND.end + 1e-12,
      `no pose leaves the band (${alongOf(point)})`)
  }
  // Every pose's tip is its own pose's support, not a neighbour's.
  let checked = 0
  for (let i = 0; i < helix.points.length; i += 37) {
    const point = helix.points[i]
    const direct = support(RIDGE, FLAT, alongOf(point), angleOf(point))
    assert.ok(Math.abs(tipOf(point) - direct) < 1e-4,
      `pose ${i} is sampled at its own (along, A): ${tipOf(point)} vs ${direct}`)
    checked++
  }
  console.log(`  rings: ${atStart.length}+${atEnd.length} poses, A spans ${360 * (helix.turns + 2)} deg, `
    + `${checked} poses re-sampled`)
}

/**
 * 4. Refinement and its no-refinement control.
 *
 * A square prism's corner at 45 degrees is placed exactly at the midpoint of the
 * initial angular step (`startAngle` is chosen so `45 = startAngle + 360 u` for
 * the midpoint `u = 1.495`). The straight move between the two samples either
 * side sags below that corner; the module must sample the midpoint and keep
 * bisecting until every emitted segment's midpoint is within the operation's
 * 0.005 mm tolerance. The control is the same build with `rounds: 0`: that is
 * exactly the path "remove refinement" leaves, and it must cut more than the
 * tolerance allows.
 */
{
  const startAngle = 45 - 360 * (1 + 49.5 / STEPS) + 720
  const refined = buildOk(SQUARE_PRISM, FLAT, { startAngle })
  const coarse = buildOk(SQUARE_PRISM, FLAT, { startAngle, budget: { rounds: 0 } })
  const initial = STEPS + (refined.turns * STEPS + 1) + STEPS
  assert.equal(coarse.points.length, initial,
    'the no-refinement control is exactly the initial ring + helix + ring grid')
  assert.ok(refined.points.length > initial,
    `refinement inserted poses (${refined.points.length} vs ${initial})`)
  const REFINED_LIMIT = 0.007
  const refinedWorst = worstMidpointCut(refined, SQUARE_PRISM, FLAT)
  assert.ok(refinedWorst.worst <= REFINED_LIMIT,
    `every refined segment stays within 0.007 mm of the surface (worst ${refinedWorst.worst})`)
  const coarseWorst = worstMidpointCut(coarse, SQUARE_PRISM, FLAT)
  assert.ok(coarseWorst.worst > 0.02,
    `the no-refinement path cuts ${coarseWorst.worst} mm below the corner, so the refinement is load-bearing`)
  assert.ok(coarseWorst.worst > refinedWorst.worst * 3,
    `refinement removes most of the gouge (${coarseWorst.worst} -> ${refinedWorst.worst})`)
  console.log(`  refinement: ${coarse.points.length} -> ${refined.points.length} poses, `
    + `worst midpoint cut ${coarseWorst.worst.toFixed(4)} -> ${refinedWorst.worst.toFixed(4)} mm`)
}

/**
 * 5. Budgets and cancellation.
 *
 * The first pass alone needs `STEPS x (turns + 2)` samples and `STEPS` rows, so
 * both limits are set below that: a module that samples anyway, or that returns
 * a path regardless, fails here instead of in the caller's fallback.
 */
{
  const sampleCapped = build(RIDGE, FLAT, { budget: { samples: 10 } })
  assert.equal(sampleCapped.exhausted, true, 'a sample budget below the first pass is reported')
  assert.equal(sampleCapped.points.length, 0, 'an exhausted helix emits no points (the caller keeps rings)')
  assert.ok(sampleCapped.samples <= 10, `no sample is taken past the budget (${sampleCapped.samples})`)
  const rowCapped = build(RIDGE, FLAT, { budget: { rows: 1 } })
  assert.equal(rowCapped.exhausted, true, 'a row budget below the first pass is reported')
  assert.equal(rowCapped.points.length, 0, 'an exhausted helix emits no points')
  assert.ok(rowCapped.rows <= 1, `no row is built past the budget (${rowCapped.rows})`)
  const stopped = build(RIDGE, FLAT, { shouldStop: () => true })
  assert.equal(stopped.stopped, true, 'a cancelled operation reports stopped')
  assert.equal(stopped.points.length, 0, 'a cancelled operation emits no points')
  assert.equal(stopped.samples, 0, 'a cancelled operation samples nothing')
  const complete = buildOk(RIDGE, FLAT)
  assert.ok(complete.samples > 0 && complete.rows > 0, 'a real helix reports the work it did')
  assert.ok(complete.rows <= MAX_HELIX_ROWS && complete.samples <= 16_000_000,
    'a real helix stays inside the default budget')
  console.log(`  budget: exhausted at 10 samples / 1 row, stopped with ${stopped.samples} samples, `
    + `a real band uses ${complete.samples} samples in ${complete.rows} rows`)
}

/**
 * 6. Cases the helix does not cover, and the retained-end pull-in.
 *
 * A square blank, a plane/revolved mismatch and a degenerate band are not this
 * module's path (`null`), which is how the caller knows to keep rings. A band
 * that has already been pulled one cutter radius inside a retained end -- the
 * span `rotaryCutterSpan` hands the ring grid -- is taken as given: the path's
 * extreme rings sit exactly on it and nowhere else, so the cutter body stays
 * out of the retained end.
 */
{
  const square = squareStock(20, 60)
  const squarePrep = createRotarySamplingPrep(SQUARE_PRISM, square, FLAT, {
    along: [6], requestedCellSize: CELL, conservativeCellBounds: true, workspace: {},
  })
  assert.equal(buildContinuousHelix({
    prep: squarePrep, tool: FLAT, band: BAND, stepover: STEPOVER, sampleSpacing: SAMPLE_SPACING,
    stockToLeave: 0, warnings: [],
  }), null, 'a square blank keeps the ring path')

  const alongPrep = createRotarySamplingPrep(RIDGE, STOCK, FLAT, {
    along: [6], requestedCellSize: CELL, workspace: {},
  })
  assert.equal(buildContinuousHelix({
    prep: alongPrep, tool: FLAT, band: BAND, stepover: STEPOVER, sampleSpacing: SAMPLE_SPACING,
    stockToLeave: 0, warnings: [],
  }), null, 'a prep without the around path\'s conservative sampling is not covered')

  for (const band of [{ start: 6, end: 6 }, { start: 8, end: 6 }, { start: NaN, end: 24 }]) {
    assert.equal(buildContinuousHelix({
      prep: prepFor(RIDGE, FLAT, [6]), tool: FLAT, band, stepover: STEPOVER,
      sampleSpacing: SAMPLE_SPACING, stockToLeave: 0, warnings: [],
    }), null, `a degenerate band (${band.start}..${band.end}) is not covered`)
  }
  assert.equal(buildContinuousHelix({
    prep: prepFor(RIDGE, FLAT, [6]), tool: FLAT, band: BAND, stepover: 0,
    sampleSpacing: SAMPLE_SPACING, stockToLeave: 0, warnings: [],
  }), null, 'a non-positive stepover is not covered')

  // Raw cut range 5..25 with a 0.5 mm cutter radius: the ring grid would be drawn
  // on 5.5..24.5, one radius inside each retained end. The helix must sit exactly
  // on that span.
  const retained = { start: 5.5, end: 24.5 }
  const pulled = buildOk(RIDGE, FLAT, { band: retained })
  const first = pulled.points[0]
  const last = pulled.points[pulled.points.length - 1]
  assert.equal(alongOf(first), retained.start, 'the path starts on the pulled-in span')
  assert.equal(alongOf(last), retained.end, 'the path ends on the pulled-in span')
  assert.equal(pulled.points.filter((point) => point.x === retained.start).length, STEPS + 1,
    'the pull-in start carries a complete ring')
  assert.equal(pulled.points.filter((point) => point.x === retained.end).length, STEPS + 1,
    'the pull-in end carries a complete ring')

  // Stock to leave is added back at the tip, as the ring path does.
  const bare = buildOk(RIDGE, FLAT)
  const left = buildOk(RIDGE, FLAT, { stockToLeave: 0.2 })
  assert.equal(left.points.length, bare.points.length, 'stock to leave changes no pose')
  let raised = 0
  for (let i = 0; i < left.points.length; i++) {
    const delta = tipOf(left.points[i]) - tipOf(bare.points[i])
    assert.ok(Math.abs(delta - 0.2) < 1e-5, `stock to leave lifts the tip by 0.2 (got ${delta})`)
    if (delta > 0) raised++
  }
  assert.equal(raised, left.points.length, 'every pose carries the stock to leave')
  console.log(`  coverage: square/along/degenerate refused, pulled-in band ${retained.start}..${retained.end} held`)
}

/**
 * 7. A ball cutter, whose tolerance is not the flat floor.
 *
 * On the same ridge model a 2 mm ball is used to exercise the ball branch of the
 * tolerance rule: the path still has to be refined and every pose still has to be
 * its own sampled support (the ball cannot be under the model).
 */
{
  const helix = buildOk(RIDGE, BALL, { startAngle: 0 })
  let checked = 0
  for (let i = 0; i < helix.points.length; i += 29) {
    const point = helix.points[i]
    const direct = support(RIDGE, BALL, alongOf(point), angleOf(point))
    assert.ok(Math.abs(tipOf(point) - direct) < 1e-4,
      `ball pose ${i} is sampled at its own (along, A): ${tipOf(point)} vs ${direct}`)
    checked++
  }
  assert.ok(helix.points.length >= STEPS + helix.turns * STEPS + 1, 'the ball path keeps its grid')
  console.log(`  ball: ${helix.points.length} poses in ${helix.rows} rows, ${checked} re-sampled`)
}

console.log('  rotaryContinuous: helix shape, ridge, refinement, pitch, rings, budgets and pull-in verified')
