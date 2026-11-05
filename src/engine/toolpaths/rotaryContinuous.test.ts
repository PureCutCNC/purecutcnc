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
 * 4. **Refinement, and exhaustion when it cannot finish.** A square prism is
 *    turned so a corner sits at the midpoint of the initial angular step, where a
 *    straight `(along, A, Z)` move sags below the material. The emitted path must
 *    be within the operation's 0.005 mm tolerance at every segment's midpoint --
 *    measured by sampling that midpoint independently. The control is the
 *    **initial grid itself**: refinement only ever splits a segment, so the
 *    unrefined poses are still in the emitted path at whole `1 / STEPS`
 *    fractions of a revolution; the straight moves between them are exactly the
 *    path "remove refinement" leaves, and they must cut well past the tolerance.
 *    A budget too small to finish must report `exhausted` with **no points**
 *    (the ring fallback) rather than return the partly refined path: on this
 *    prism `rounds: 1` and `2` still leave 0.067 mm and 0.018 mm of gouge. That
 *    is the review's finding. `block 4`.
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
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { roundStock } from '../../types/project'
import type { BarStock, RoundStock } from '../../types/project'
import { createRotarySamplingPrep, sampleRotaryModel } from '../toolpaths/rotarySampling'
import type { RotarySamplingPrep } from '../toolpaths/rotarySampling'
import {
  CHIRAL_ALLOWANCE_MM,
  CHIRAL_BAR_RADIUS,
  CHIRAL_FROM,
  CHIRAL_SEEDS,
  CHIRAL_TO,
  CHIRAL_VERTICES,
  chiralMesh,
  chiralSupport,
} from '../../test/rotaryChiralReference'
import type { ChiralModel } from '../../test/rotaryChiralReference'
import {
  buildContinuousHelix, DEFAULT_CONTINUOUS_HELIX_BUDGET, MAX_HELIX_RASTER_WORK, MAX_HELIX_ROWS,
  MAX_HELIX_SPLIT_DEPTH, ZERO_HELIX_SPEND, walkContinuousBand,
} from './rotaryContinuous'
import type {
  ContinuousBandVisit,
  ContinuousHelix,
  ContinuousHelixFailure,
  ContinuousHelixInput,
  ContinuousHelixSpend,
} from './rotaryContinuous'
import { generateRotaryFinish } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import type { NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import type { ToolpathWarning } from './warningCodes'

const STOCK: RoundStock = roundStock(20, 60)
const PIVOT = barPivotZ(STOCK)
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
function support(
  mesh: RotaryModelMesh,
  tool: NormalizedTool,
  along: number,
  angle: number,
  stock: BarStock = STOCK,
  cell = CELL,
): number {
  const sampled = sampleRotaryModel(mesh, stock, tool, {
    anglesDeg: [angle],
    along: [along],
    requestedCellSize: cell,
    conservativeCellBounds: true,
  }, [])
  const raw = sampled.tipRadius[0][0]
  return Number.isFinite(raw) ? Math.min(Math.max(raw, 0), barMaxRadius(stock)) : NaN
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
  points: readonly ToolpathPoint[],
  mesh: RotaryModelMesh,
  tool: NormalizedTool,
): { worst: number; segments: number } {
  let worst = Number.NEGATIVE_INFINITY
  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1]
    const to = points[i]
    const along = (alongOf(from) + alongOf(to)) / 2
    const angle = (angleOf(from) + angleOf(to)) / 2
    const chord = (tipOf(from) + tipOf(to)) / 2
    const mid = support(mesh, tool, along, angle)
    assert.ok(Number.isFinite(mid), `segment ${i}: the midpoint pose has model under the tool`)
    const cut = mid - chord
    if (cut > worst) worst = cut
  }
  return { worst, segments: points.length - 1 }
}

/**
 * The poses a chain holds at one depth of refinement, taken from an emitted path.
 *
 * Refinement only splits segments, so every pose the module held after `rounds`
 * rounds is still an endpoint of the final path; its `u` is a whole multiple of
 * `1 / (STEPS * 2 ** rounds)`. Selecting those poses, in order, reconstructs that
 * depth's chain -- whose straight moves are the path a build with a `rounds`
 * budget would emit if it did not refuse an unresolved refinement. `rounds: 0`
 * is the initial grid, the "remove refinement" control.
 */
function gridAt(helix: ContinuousHelix, startAngle: number, rounds: number): ToolpathPoint[] {
  const scale = STEPS * 2 ** rounds
  return helix.points.filter((point) => {
    const u = (angleOf(point) - startAngle) / 360
    return Math.abs(u * scale - Math.round(u * scale)) < 1e-6
  })
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
 * 4. Refinement, its no-refinement control, and exhaustion when it cannot finish.
 *
 * A square prism's corner at 45 degrees is placed exactly at the midpoint of the
 * initial angular step (`startAngle` is chosen so `45 = startAngle + 360 u` for
 * the midpoint `u = 1.495`). The straight move between the two samples either
 * side sags below that corner; the module must sample the midpoint and keep
 * bisecting until every emitted segment's midpoint is within the operation's
 * 0.005 mm tolerance.
 *
 * The control is the initial grid: refinement only splits, so those poses are
 * still in the emitted path at whole `1 / STEPS` fractions of a revolution. The
 * straight moves between them are exactly the path "remove refinement" leaves,
 * and they gouge 0.071 mm -- twenty times the tolerance -- so the refinement is
 * load-bearing. The old control asked the module for `rounds: 0`, which it now
 * (correctly) refuses.
 *
 * The last part is the review's finding: a budget that cannot finish must say
 * so. `rounds: 1` halves each coarse segment once and still leaves 0.067 mm;
 * `rounds: 2` leaves 0.018 mm. Both used to return those points with
 * `exhausted: false`, which suppresses the caller's ring fallback.
 */
{
  const startAngle = 45 - 360 * (1 + 49.5 / STEPS) + 720
  const refined = buildOk(SQUARE_PRISM, FLAT, { startAngle })
  const initial = STEPS + (refined.turns * STEPS + 1) + STEPS
  assert.ok(refined.points.length > initial,
    `refinement inserted poses (${refined.points.length} vs ${initial})`)
  const coarse = gridAt(refined, startAngle, 0)
  assert.equal(coarse.length, initial,
    'the initial ring + helix + ring grid survives every refinement as segment ends')
  const REFINED_LIMIT = 0.007
  const refinedWorst = worstMidpointCut(refined.points, SQUARE_PRISM, FLAT)
  assert.ok(refinedWorst.worst <= REFINED_LIMIT,
    `every refined segment stays within 0.007 mm of the surface (worst ${refinedWorst.worst})`)
  const coarseWorst = worstMidpointCut(coarse, SQUARE_PRISM, FLAT)
  assert.ok(coarseWorst.worst > 0.02,
    `the no-refinement path cuts ${coarseWorst.worst} mm below the corner, so the refinement is load-bearing`)
  assert.ok(coarseWorst.worst > refinedWorst.worst * 3,
    `refinement removes most of the gouge (${coarseWorst.worst} -> ${refinedWorst.worst})`)
  // What the old code returned when its budget ran out at one and two rounds:
  // both are still past the 0.005 mm tolerance, so neither may be emitted.
  const partialWorsts: number[] = []
  let previous = coarse.length
  for (const rounds of [1, 2]) {
    const partial = gridAt(refined, startAngle, rounds)
    assert.ok(partial.length > previous,
      `round ${rounds} split more segments (${partial.length} vs ${previous})`)
    previous = partial.length
    const partialWorst = worstMidpointCut(partial, SQUARE_PRISM, FLAT)
    assert.ok(partialWorst.worst > 0.005,
      `the ${rounds}-round path still gouges ${partialWorst.worst} mm, past the 0.005 mm tolerance`)
    partialWorsts.push(partialWorst.worst)
  }
  // The finding's regression: an unfinished refinement is no points and no
  // path, never a partly refined path. Since #1103 slice ca-g it also reports
  // **where** it could not finish (`failures`), which is what lets the caller
  // cut rings there and helix the rest instead of giving the band up; it is a
  // tolerance refusal, not a spent budget, so `exhausted` stays false.
  for (const rounds of [0, 1, 2, 3]) {
    const unfinished = build(SQUARE_PRISM, FLAT, { startAngle, budget: { rounds } })
    assert.equal(unfinished.exhausted, false,
      `a ${rounds}-round unresolved refinement is a tolerance refusal, not an exhausted budget`)
    assert.equal(unfinished.points.length, 0,
      `an unresolved refinement emits no points (${rounds} rounds), so the caller keeps rings`)
    assert.ok(unfinished.failures.length > 0,
      `an unresolved refinement reports the spans it could not verify (${rounds} rounds)`)
    for (const failure of unfinished.failures) {
      assert.ok(failure.end >= failure.start, 'each reported span is ordered')
      assert.ok(failure.start >= BAND.start - 1e-9 && failure.end <= BAND.end + 1e-9,
        `a reported span stays inside the band (${failure.start}..${failure.end})`)
    }
    assert.ok(unfinished.samples > 0, `the unresolved attempt reports the work it did (${rounds} rounds)`)
  }
  console.log(`  refinement: ${coarse.length} -> ${refined.points.length} poses, `
    + `worst midpoint cut ${coarseWorst.worst.toFixed(4)} -> ${refinedWorst.worst.toFixed(4)} mm, `
    + `1/2 rounds ${partialWorsts.map((w) => w.toFixed(4)).join('/')} mm, `
    + 'rounds 0..3 exhausted with no points')
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
  // #1103 ca-e correction round 2: the attempt's raster work is a limit of its
  // own. Rows alone cannot price an attempt -- one row visits ~100 candidate
  // triangles on this fixture and ~96 000 on the busto-round finish -- so a
  // refused refinement on a fine mesh is bounded by the work it may spend.
  // Removing the check makes the `work: 1` build return a path instead of
  // exhaustion, which is the mutation this block catches.
  assert.equal(DEFAULT_CONTINUOUS_HELIX_BUDGET.work, MAX_HELIX_RASTER_WORK,
    'the default budget carries the exported raster-work cap')
  assert.ok(complete.rasterWork > 0,
    `a real helix reports the raster work it spent (${complete.rasterWork})`)
  assert.ok(complete.rasterWork < MAX_HELIX_RASTER_WORK,
    `a verified band is far below the work cap (${complete.rasterWork} versus ${MAX_HELIX_RASTER_WORK})`)
  const workCapped = build(RIDGE, FLAT, { budget: { work: 1 } })
  assert.equal(workCapped.exhausted, true,
    'a work budget below the first rows is reported as exhaustion, not spent')
  assert.equal(workCapped.points.length, 0,
    'a work-capped helix emits no points, so the caller keeps rings')
  assert.equal(workCapped.rows, 1,
    `the cap is checked before the next row, so only one row is built (${workCapped.rows})`)
  assert.ok(workCapped.rasterWork > 1 && workCapped.rasterWork <= complete.rasterWork,
    `the exhausted attempt reports the work that stopped it (${workCapped.rasterWork})`)
  // Half the measured work is not enough to finish, and the difference from the
  // full budget is the cap and nothing else -- same fixture, same band.
  const halfWork = build(RIDGE, FLAT, { budget: { work: Math.floor(complete.rasterWork / 2) } })
  assert.equal(halfWork.exhausted, true, 'half the measured raster work cannot finish the band')
  assert.equal(halfWork.points.length, 0, 'an exhausted attempt emits no points at half the work')
  assert.ok(halfWork.rasterWork < complete.rasterWork,
    `the half-work attempt stops short of the full one (${halfWork.rasterWork} versus ${complete.rasterWork})`)
  console.log(`  budget: exhausted at 10 samples / 1 row / 1 triangle of work, stopped with `
    + `${stopped.samples} samples, a real band uses ${complete.samples} samples in `
    + `${complete.rows} rows and ${complete.rasterWork} triangle raster passes`)
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
  // #1103 slice ca-j: a square blank is this module's case once its caller
  // supplies the blank's own rules (the rough's material-touch gate on the layer
  // and the retained-stub floor per pose). Both callers now use it -- the rough
  // since ca-j, the finish since correction round 1 -- and
  // `rotarySquareHelix.test.ts` owns both halves.
  const square = squareStock(20, 60)
  const squarePrep = createRotarySamplingPrep(SQUARE_PRISM, square, FLAT, {
    along: [6], requestedCellSize: CELL, conservativeCellBounds: true, workspace: {},
  })
  const onSquare = buildContinuousHelix({
    prep: squarePrep, tool: FLAT, band: BAND, stepover: STEPOVER, sampleSpacing: SAMPLE_SPACING,
    stockToLeave: 0, warnings: [],
  })
  assert.ok(onSquare !== null && onSquare.points.length > 1,
    'a square blank on the around path is a helix once the caller supplies its rules')

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
  console.log(`  coverage: along/degenerate refused, square blank helixed, pulled-in band ${retained.start}..${retained.end} held`)
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

// ---------------------------------------------------------------------------
// 8. #1103 slice ca-c: the around finish's integration.
//
//    `generateRotaryFinish` cuts an uninterrupted, fully covered round band with
//    one helix (see `finishFromTargets`), and everything else with forward-only
//    rings. The checks walk the **emitted** motion after run merging:
//
//    - every cut segment of the helix is sampled along its own combined
//      `(along, A)` path against the chiral swept reference ca-a built. A move
//      that interpolated ring heights, or took the wrong sign in along or A,
//      would stand below that reference;
//    - A never reverses inside a band, and it is never wrapped modulo 360;
//    - the planted mutations are caught: restoring the ring alternation, and
//      wrapping the commanded A, both make the reversal detector fire.
//
//    The excluded-region mutation lives in `rotaryRegion.test.ts`, next to the
//    region masks it needs.
// ---------------------------------------------------------------------------

/** A sign changes in consecutive turning cut moves. */
function aReversals(moves: readonly ToolpathMove[]): number {
  let reversals = 0
  let last = 0
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    const delta = (move.to.a ?? 0) - (move.from.a ?? 0)
    if (Math.abs(delta) < 1e-12) continue
    const sign = Math.sign(delta)
    if (last !== 0 && sign !== last) reversals++
    last = sign
  }
  return reversals
}

/**
 * The commanded A the cut moves sweep at each along position (#1103 slice ca-g).
 *
 * A forward-only **ring** is one along position whose cut runs close a whole
 * turn; a helix piece advances along while it turns, so its moves land at their
 * own along positions and contribute a fraction of a turn each. The map is
 * therefore how a test asks "is the ring beside this helix piece a **complete**
 * ring?" -- the ca-b boundary rule that keeps a triangular strip from standing
 * uncut at a seam.
 */
function turnPerAlong(moves: readonly ToolpathMove[], at: (point: ToolpathPoint) => number): Map<number, number> {
  const turn = new Map<number, number>()
  for (const move of moves) {
    // Only a move that holds its along position turns *at* that position. A
    // helix move advances while it turns, so it belongs to the stretch between
    // two positions, not to a ring.
    if (move.kind !== 'cut' || at(move.to) !== at(move.from)) continue
    const delta = Math.abs((move.to.a ?? 0) - (move.from.a ?? 0))
    if (delta < 1e-9) continue
    const along = Math.round(at(move.from) * 1e6) / 1e6
    turn.set(along, (turn.get(along) ?? 0) + delta)
  }
  return turn
}

/** Is the commanded A of every move endpoint non-decreasing, in emission order? */
function monotoneA(moves: readonly ToolpathMove[]): boolean {
  let last = Number.NEGATIVE_INFINITY
  for (const move of moves) {
    for (const point of [move.from, move.to]) {
      if (point.a === undefined) continue
      if (point.a < last - 1e-9) return false
      last = point.a
    }
  }
  return true
}

/** Two emitted along positions within this are the same ring position. */
const NEAR_ALONG = 1e-6

/**
 * The helix pieces of an emitted around path (#1103 slice ca-g).
 *
 * A piece is a maximal run of cut moves that **turn and advance**: a ring holds
 * its along position ("it turns, but at one position") and a seam link holds its
 * A ("it advances, at one angle"), so neither can join a piece, while a
 * steep-step leg keeps the move that carries both. Consecutive pieces are joined
 * where one ends where the next begins.
 *
 * A piece's `start` and `end` are the along positions of its two **boundary
 * rings** -- the ca-b rule -- because the first turn-and-advance move starts at
 * the piece's opening ring and the last one ends at its closing ring.
 */
function helixPieces(
  moves: readonly ToolpathMove[],
  at: (point: ToolpathPoint) => number,
): { start: number; end: number }[] {
  const pieces: { start: number; end: number }[] = []
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    const turned = Math.abs((move.to.a ?? 0) - (move.from.a ?? 0))
    const advanced = Math.abs(at(move.to) - at(move.from))
    if (!(turned > 1e-9) || !(advanced > 1e-9)) continue
    const last = pieces[pieces.length - 1]
    if (last !== undefined && Math.abs(at(move.from) - last.end) < NEAR_ALONG) last.end = at(move.to)
    else pieces.push({ start: at(move.from), end: at(move.to) })
  }
  return pieces
}

/**
 * The independent coverage check for a split band (#1103 slice ca-g correction
 * round 1).
 *
 * The synthetic `walkContinuousBand` cases above prove the walk's rules, but
 * they emit ring *indices*, not motion: they cannot prove that the rings the
 * split leaves cut any material. A real fixture can, and the two omissions the
 * review found both pass every check that only inspects the rings that are
 * **present**, so this walks the emitted motion instead:
 *
 * 1. **Every ring-grid position that is not strictly inside a helix piece is a
 *    complete ring.** A helix piece covers its own span; its two boundary rings
 *    and every forward-only ring the split left between pieces must each be one
 *    contiguous whole turn. Omitting a split piece's boundary ring leaves the
 *    triangular strip the ca-b rule exists to prevent, and omitting the finish's
 *    fallback rings leaves the feature standing; both make this fail, at the
 *    position that is missing. When a reference is supplied, every pose of such
 *    a ring must also cut at its own sampled support, so the ring is the
 *    surface, not a turn in air.
 * 2. **Every cut move stays at or above the surface, the seam links included.**
 *    A helix piece's every sampled pose is independent of the module, so a
 *    ring-to-helix link that skipped its checked path -- a straight cut where
 *    the caller supplied `followLink` -- is caught by the same sweep.
 *
 * `supportAt` is the caller's independent reference: the ca-a swept reference
 * (`chiralSupport`) on the chiral fixture, the sampler on a mesh fixture.
 */
function assertRingCoverage(
  moves: readonly ToolpathMove[],
  at: (point: ToolpathPoint) => number,
  tip: (point: ToolpathPoint) => number,
  ringGrid: readonly number[],
  /**
   * The reference the ring's poses are compared with, or `undefined` when the
   * caller already sweeps every emitted pose against one (the chiral section
   * above does). A one-pose re-sample aligns the height-map window to a single
   * along position, which on a steep model can move a tip by a whole cell; the
   * caller that wants the check passes its tolerance below.
   */
  supportAt: ((along: number, angle: number) => number) | undefined,
  allowance: number,
  label: string,
  /**
   * How close a ring pose must sit to its reference. This is the "the ring is
   * the surface, not a turn in air" check, not the no-gouge one: the gouge sweep
   * is `assertCutAboveSupport` (or the section's own analytic sweep) and it stays
   * exact. Re-asking the sampler for one pose aligns the height-map window to a
   * single along position, so a re-sampled pose can move by its conservative
   * cell bound; the caller passes the tolerance its reference needs.
   */
  tipTolerance = allowance,
): { pieces: { start: number; end: number }[]; rings: number[] } {
  const pieces = helixPieces(moves, at)
  const rings: number[] = []
  for (const along of ringGrid) {
    const inside = pieces.some((piece) => along > piece.start + NEAR_ALONG && along < piece.end - NEAR_ALONG)
    if (inside) continue
    // The whole turn, as contiguous A intervals from the cutting moves that hold
    // this along position.
    const spans: [number, number][] = []
    for (const move of moves) {
      if (move.kind !== 'cut') continue
      if (Math.abs(at(move.from) - along) > NEAR_ALONG || Math.abs(at(move.to) - along) > NEAR_ALONG) continue
      const from = move.from.a
      const to = move.to.a
      if (from === undefined || to === undefined || Math.abs(to - from) < 1e-12) continue
      spans.push([Math.min(from, to), Math.max(from, to)])
    }
    assert.ok(spans.length > 0,
      `${label}: the ring at along ${along} is cut -- a helix piece's boundary ring and a fallback ring `
      + 'the split left are never omitted')
    spans.sort((left, right) => left[0] - right[0])
    const start = spans[0][0]
    let end = spans[0][1]
    for (let i = 1; i < spans.length; i++) {
      const span = spans[i]
      assert.ok(span[0] <= end + 1e-6,
        `${label}: the ring at along ${along} is one contiguous turn (a gap of ${(span[0] - end).toFixed(6)} deg)`)
      end = Math.max(end, span[1])
    }
    assert.ok(Math.abs(end - start - 360) < 1e-6,
      `${label}: the ring at along ${along} sweeps one whole turn (${(end - start).toFixed(6)} deg)`)
    // Every emitted pose of the ring is the surface's own sampled support.
    let poses = 0
    if (supportAt === undefined) { rings.push(along); continue }
    for (const move of moves) {
      if (move.kind !== 'cut') continue
      for (const point of [move.from, move.to]) {
        if (Math.abs(at(point) - along) > NEAR_ALONG) continue
        const value = supportAt(at(point), point.a ?? 0)
        poses++
        const difference = tip(point) - value
        assert.ok(Math.abs(difference) <= tipTolerance,
          `${label}: the ring at along ${along} cuts the surface at A${(point.a ?? 0).toFixed(2)} `
          + `(${tip(point).toFixed(4)} versus ${value.toFixed(4)}, ${difference.toFixed(4)} off)`)
      }
    }
    assert.ok(poses > 0, `${label}: the ring at along ${along} has an emitted pose`)
    rings.push(along)
  }
  return { pieces, rings }
}

/**
 * Every cut move -- rings, helix pieces and the constant-A seam links between
 * them -- sampled against the same independent reference (#1103 slice ca-g
 * correction round 1).
 *
 * The seam links are the moves this exists for. They hold their A, so a check
 * that only looks at turning moves is blind to one: a ring-to-helix link whose
 * surface-following path was replaced by a straight cut is a cut that gouges the
 * interior geometry and nothing else in either suite looks at it.
 */
function assertCutAboveSupport(
  moves: readonly ToolpathMove[],
  at: (point: ToolpathPoint) => number,
  tip: (point: ToolpathPoint) => number,
  supportAt: (along: number, angle: number) => number,
  allowance: number,
  label: string,
): number {
  let segments = 0
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    for (let step = 0; step <= 3; step++) {
      const f = step / 3
      const along = at(move.from) + (at(move.to) - at(move.from)) * f
      const angle = (move.from.a ?? 0) + ((move.to.a ?? 0) - (move.from.a ?? 0)) * f
      const value = tip(move.from) + (tip(move.to) - tip(move.from)) * f
      const reference = supportAt(along, angle)
      segments++
      assert.ok(value >= reference - allowance,
        `${label}: ${move.kind} at along ${along.toFixed(4)} A${angle.toFixed(2)} tip ${value.toFixed(4)} `
        + `is below the swept reference ${reference.toFixed(4)} by more than ${allowance}`)
    }
  }
  return segments
}

let helixSeeds = 0
let chiralHelixSeeds = 0
let splitSeeds = 0
let splitRings = 0
let helixSegments = 0
let helixSamples = 0
let baseResult: ToolpathResult | undefined
console.log('Testing the around finish helix against the seeded swept reference...')
for (const { axis, units, type } of CHIRAL_SEEDS) {
  const scale = units === 'mm' ? 1 : 1 / 25.4
  const label = `${axis}-${units}-${type}`
  const allowance = CHIRAL_ALLOWANCE_MM * scale
  const stock = roundStock(CHIRAL_BAR_RADIUS * 2 * scale, 20 * scale, axis, { x: 0, y: 0 })
  const model: ChiralModel = {
    vertices: CHIRAL_VERTICES.map(([across, up]) => [across * scale, up * scale] as const),
    from: CHIRAL_FROM * scale,
    to: CHIRAL_TO * scale,
    scale0: 0.55,
    scale1: 1.25,
    twist0: 0,
    twist1: 40,
  }
  const tool: NormalizedTool = {
    ...BALL,
    id: `helix-${label}`,
    name: `helix-${label}`,
    type,
    sourceUnits: units,
    units,
    radius: 1 * scale,
    diameter: 2 * scale,
  }
  const at = (point: ToolpathPoint): number => (axis === 'x' ? point.x : point.y)
  const pivot = barPivotZ(stock)
  const mesh = chiralMesh(stock, model, 40)
  const result = generateRotaryFinish(`helix-${label}`, mesh, stock, tool, {
    stepover: 2.5 * scale,
    sampleSpacing: 1.5 * scale,
    stockToLeave: 0,
    alongStart: 5 * scale,
    alongEnd: 15 * scale,
    safeRadius: 30 * scale,
    requestedCellSize: 0.2 * scale,
    passDirection: 'around',
  }, {})
  assert.deepEqual(result.warnings, [], `${label}: the chiral finish has no warning`)
  // A is one-way whether the band came out as a helix or as forward-only rings:
  // no reversal and no rewind anywhere. (On this tapered, twisted model the
  // refinement refuses some bands -- the plan's ring fallback -- so the section
  // below does not insist every seed is a helix; it checks every segment the
  // generator did emit.)
  assert.equal(aReversals(result.moves), 0, `${label}: A never reverses inside the band`)
  assert.ok(monotoneA(result.moves), `${label}: the commanded A never rewinds`)
  // The cutter body stays inside the cut band: its one-radius pull-in at each
  // retained end survives whichever motion was chosen.
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    for (const point of [move.from, move.to]) {
      const along = at(point)
      assert.ok(along - tool.radius >= 5 * scale - 1e-9 && along + tool.radius <= 15 * scale + 1e-9,
        `${label}: the cutter body at along ${along.toFixed(4)} enters a retained end of the band`)
    }
    // Every emitted segment, after merging, against the independent reference.
    const fromAlong = at(move.from)
    const toAlong = at(move.to)
    const fromAngle = move.from.a ?? 0
    const toAngle = move.to.a ?? 0
    const fromTip = move.from.z - pivot
    const toTip = move.to.z - pivot
    for (let step = 0; step <= 3; step++) {
      const f = step / 3
      const supportValue = chiralSupport(
        model,
        fromAlong + (toAlong - fromAlong) * f,
        fromAngle + (toAngle - fromAngle) * f,
        tool,
      )
      const tip = fromTip + (toTip - fromTip) * f
      helixSamples++
      assert.ok(tip >= supportValue - allowance,
        `${label}: ${move.kind} at along ${(fromAlong + (toAlong - fromAlong) * f).toFixed(4)} `
        + `A${(fromAngle + (toAngle - fromAngle) * f).toFixed(2)} f=${f} tip ${tip.toFixed(4)} is below `
        + `the swept reference ${supportValue.toFixed(4)} by more than ${allowance.toFixed(4)}`)
    }
    helixSegments++
  }
  helixSeeds++
  let turningAlong = 0
  for (const move of result.moves) {
    if (move.kind === 'cut' && (move.from.a ?? 0) !== (move.to.a ?? 0) && at(move.from) !== at(move.to)) turningAlong++
  }
  if (turningAlong > 0) chiralHelixSeeds++
  // #1103 slice ca-g: where the refinement refuses some segments of the band the
  // band is **split** -- helices where the surface verifies, forward-only rings
  // around the spans it does not -- so a seed can carry both kinds of motion in
  // one path. Every ring the split leaves behind is a **complete** turn: the
  // ring beside a helix piece is that piece's boundary ring (ca-b), which is what
  // keeps a triangular strip from standing uncut at the seam.
  const turnsAt = turnPerAlong(result.moves, at)
  for (const [ringAlong, turn] of turnsAt) {
    // Every along position the path turns at is a **complete** ring -- the
    // boundary ring of a helix piece or a ring the split left behind. A partial
    // ring here would be a strip standing uncut at a seam.
    assert.ok(turn > 359.9,
      `${label}: the ring at along ${ringAlong} closes a whole turn (it sweeps ${turn})`)
  }
  // Correction round 1: the same seams, checked on the **emitted motion** rather
  // than on the rings that happen to be present. The ring grid is recomputed
  // from the operation's own numbers -- one position every stepover over the
  // cutter span, both ends included -- and every position that is not strictly
  // inside a helix piece must be a complete, contiguous ring that cuts the
  // surface: that is a piece's boundary ring at a seam, and the forward-only
  // rings the split left between two pieces. A split that omitted its boundary
  // rings, or dropped the fallback rings around a feature, used to pass because
  // this section only inspected rings that were there.
  const spanStart = 5 * scale + tool.radius
  const spanEnd = 15 * scale - tool.radius
  const ringCount = Math.ceil((spanEnd - spanStart) / (2.5 * scale))
  const ringGrid = Array.from(
    { length: ringCount + 1 },
    (_, i) => spanStart + (spanEnd - spanStart) * i / ringCount,
  )
  // This reads the ring **coverage** half only: the sweep above already checks
  // every emitted pose (links included) against the ca-a analytic reference. The
  // pose-by-pose tip half is deliberately not re-asked here: a one-pose
  // re-sample aligns the height-map window to a single along position, which on
  // this steep, faceted section can move a tip by a whole cell, so its answer
  // would be a property of the reference rather than of the ring. The mesh
  // fixture below, whose reference is the sampler on a smooth bar, is where that
  // half is checked.
  const coverage = assertRingCoverage(
    result.moves,
    at,
    (point) => point.z - pivot,
    ringGrid,
    undefined,
    allowance,
    label,
  )
  splitRings += coverage.rings.length
  // The helix's pitch is at most the requested stepover, so a cut that turns
  // while it advances moves at most `stepover / 360` per degree. A seam link
  // holds its A instead (a cut at one angle, or a turn in place), so a move that
  // sweeps a whole stepover across a wide A change is not a helix and not a
  // link: it is a seam joined without the constant-A check.
  const stepover = 2.5 * scale
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    const advanced = Math.abs(at(move.to) - at(move.from))
    const turned = Math.abs((move.to.a ?? 0) - (move.from.a ?? 0))
    if (!(advanced > 1e-9) || !(turned > 1e-9)) continue
    // A helix advances at most one requested stepover per revolution (ca-b), so a
    // cut that turns while it advances cannot sweep a whole stepover across a
    // wide A change: that shape is a seam link, and a seam link holds its A.
    assert.ok(advanced <= stepover * turned / 360 + 1e-6,
      `${label}: a cut that turns ${turned.toFixed(3)} deg advances at most `
      + `${(stepover * turned / 360).toFixed(6)} (it advances ${advanced.toFixed(6)})`)
  }
  // Every ring opens on a **whole turn**: the A cursor advances by complete turns,
  // so a piece the split emits opens where the forward lattice says it should. A
  // seam joined with an A change of its own would open its boundary ring part-way
  // round instead.
  const opening = new Map<number, number>()
  for (const move of result.moves) {
    if (move.kind !== 'cut' || at(move.to) !== at(move.from)) continue
    if (Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) < 1e-9) continue
    const along = Math.round(at(move.from) * 1e6) / 1e6
    const from = move.from.a ?? 0
    if (!opening.has(along) || from < opening.get(along)!) opening.set(along, from)
  }
  for (const [ringAlong, openAt] of opening) {
    const within = ((openAt % 360) + 360) % 360
    assert.ok(within < 1e-6 || within > 360 - 1e-6,
      `${label}: the ring at along ${ringAlong} opens on a whole turn (it opens at ${openAt})`)
  }
  // A **split**, not merely a helix: a helix emits exactly its two boundary
  // rings, so a third complete ring at its own along position means the split
  // left a forward-only ring beside a helix piece. Counting a turn anywhere in
  // the path (`completeRings > 0`) counted every plain helix as a split, which
  // is why this section could not tell the split case apart from the ca-b one.
  if (coverage.pieces.length > 0 && coverage.rings.length > 2) splitSeeds++
}

// ── a guaranteed helix, checked against the same swept reference ──────────
//
// The chiral model above is a triangle with sharp edges: its band refuses
// refinement after the eight rounds (the plan's ring fallback), so it proves the
// swept reference on every emitted ring segment but not on a helix. A gentler
// chiral section -- a narrower taper and twist -- converges, and its helix is the
// one case where the independent reference judges **diagonal** moves on a model
// whose support depends on A as well as on the along position. `baseResult` is
// this path: the mutations at the end of the section are planted on a real
// helix, not on a ring fallback.
{
  const model: ChiralModel = {
    vertices: CHIRAL_VERTICES.map(([across, up]) => [across, up] as const),
    from: CHIRAL_FROM,
    to: CHIRAL_TO,
    scale0: 0.8,
    scale1: 1.15,
    twist0: 0,
    twist1: 20,
  }
  const stock = roundStock(CHIRAL_BAR_RADIUS * 2, 20, 'x', { x: 0, y: 0 })
  const tool: NormalizedTool = {
    ...BALL, id: 'helix-chiral', name: 'helix-chiral', type: 'ball_endmill',
    sourceUnits: 'mm', units: 'mm', radius: 1, diameter: 2,
  }
  const pivot = barPivotZ(stock)
  const result = generateRotaryFinish('helix-chiral', chiralMesh(stock, model, 40), stock, tool, {
    stepover: 2.5, sampleSpacing: 1.5, stockToLeave: 0, alongStart: 6, alongEnd: 14,
    safeRadius: 30, requestedCellSize: 0.2, passDirection: 'around',
  }, {})
  assert.deepEqual(result.warnings, [], 'the gentle chiral finish has no warning')
  baseResult = result
  assert.equal(aReversals(result.moves), 0, 'the gentle chiral band has no A reversal')
  assert.ok(monotoneA(result.moves), 'the gentle chiral band is monotone in A')
  let turningAlong = 0
  let maxA = Number.NEGATIVE_INFINITY
  let checked = 0
  const allowance = CHIRAL_ALLOWANCE_MM
  for (const move of result.moves) {
    maxA = Math.max(maxA, move.to.a ?? maxA)
    if (move.kind !== 'cut') continue
    if ((move.from.a ?? 0) !== (move.to.a ?? 0) && alongOf(move.from) !== alongOf(move.to)) turningAlong++
    const fromAlong = alongOf(move.from)
    const toAlong = alongOf(move.to)
    const fromAngle = move.from.a ?? 0
    const toAngle = move.to.a ?? 0
    const fromTip = move.from.z - pivot
    const toTip = move.to.z - pivot
    for (let step = 0; step <= 3; step++) {
      const f = step / 3
      const supportValue = chiralSupport(
        model,
        fromAlong + (toAlong - fromAlong) * f,
        fromAngle + (toAngle - fromAngle) * f,
        tool,
      )
      const tip = fromTip + (toTip - fromTip) * f
      checked++
      assert.ok(tip >= supportValue - allowance,
        `helix: cut at along ${(fromAlong + (toAlong - fromAlong) * f).toFixed(4)} `
        + `A${(fromAngle + (toAngle - fromAngle) * f).toFixed(2)} f=${f} tip ${tip.toFixed(4)} is below `
        + `the swept reference ${supportValue.toFixed(4)} by more than ${allowance}`)
    }
  }
  assert.ok(turningAlong > 0, 'the gentle chiral band is a helix (some turning cut advances along)')
  assert.ok(maxA > 360, `commanded A passes one turn and is not wrapped (it ends at ${maxA})`)
  assert.equal(result.moves.filter((move) => move.kind === 'plunge').length, 1,
    'a continuous band plunges once')
  assert.equal(result.moves.filter((move) => move.kind === 'rapid').length, 2,
    'and retracts only at its two ends')
  console.log(`  chiral helix: ${result.moves.length} moves, ${checked} swept-reference samples, A to ${maxA}`)
}

// ── the mutations this section catches ────────────────────────────────────
{
  assert.ok(baseResult !== undefined, 'the seed loop produced a base helix')
  const base = baseResult.moves
  assert.equal(aReversals(base), 0, 'the real helix has no reversal')
  assert.ok(monotoneA(base), 'the real helix is monotone in A')

  // 1. Restore the old ring alternation: every other turn runs backwards again.
  const alternate = (a: number): number => {
    const turn = Math.floor(a / 360)
    const within = a - 360 * turn
    return turn % 2 === 0 ? a : 360 * turn + (360 - within)
  }
  const rewound = base.map((move) => ({
    ...move,
    from: { ...move.from, a: alternate(move.from.a ?? 0) },
    to: { ...move.to, a: alternate(move.to.a ?? 0) },
  }))
  assert.ok(aReversals(rewound) > 0,
    'restoring the ring alternation is caught: the reversal count fires')

  // 2. Wrap the commanded A modulo 360. The reversal detector fires as soon as
  //    a turn closes and the next one starts at zero again.
  const wrapped = base.map((move) => ({
    ...move,
    from: { ...move.from, a: ((move.from.a ?? 0) % 360 + 360) % 360 },
    to: { ...move.to, a: ((move.to.a ?? 0) % 360 + 360) % 360 },
  }))
  assert.ok(aReversals(wrapped) > 0,
    'wrapping the commanded A modulo 360 is caught: the wrap reads as a reversal')
  assert.ok(!monotoneA(wrapped), 'and it breaks the monotone-A contract')
}

assert.ok(splitSeeds > 0,
  `a refused band is split into helices and rings rather than given up (${splitSeeds} seeds)`)
console.log(
  `  finish integration: ${helixSeeds} chiral seeds (${chiralHelixSeeds} helixed, ${splitSeeds} split into `
  + `helix and rings over ${splitRings} required rings), ${helixSegments} emitted segments `
  + `(${helixSamples} swept-reference samples), zero reversals, both A mutations caught`,
)

// ---------------------------------------------------------------------------
// 9. #1103 slice ca-g: a band that cannot be verified everywhere is split into
//    helices where it verifies and forward-only rings where it does not.
//
//    The walk is driven with **synthetic attempts** here, so each rule it has
//    to keep is checked on its own:
//
//    - where the rings go. A failing span marks the ring positions that bracket
//      it, and the runs between them get their own helix, so the band comes out
//      helix - rings - helix with a **complete** ring on each side of a seam.
//      A splitter that marked only the rings strictly inside a span narrower
//      than one ring interval would mark nothing and give the whole band up;
//      that is the "split without the boundary rings" mutation, and the ring
//      list below is what catches it;
//    - what a non-tolerance refusal does. A spent budget, cancellation, no
//      model under the tool, no material at a roughing layer and a case the
//      builder does not cover all keep the whole band's rings, exactly as before
//      this slice: nothing is split where there is nothing to split around;
//    - the band's one work budget. Every attempt is handed what the band has
//      already spent, so a split cannot spend the cap again per piece; a mutation
//      that hands each attempt a fresh budget is caught by the exact spends.
// ---------------------------------------------------------------------------

/** A synthetic attempt's result: verified, or refused with these failing spans. */
function fakeHelix(
  turns: number,
  work: number,
  failures: readonly ContinuousHelixFailure[] = [],
  flags: Partial<Pick<ContinuousHelix, 'exhausted' | 'stopped' | 'uncovered' | 'ineligible'>> = {},
): ContinuousHelix {
  const verified = failures.length === 0 && Object.keys(flags).length === 0
  return {
    points: verified
      ? [{ x: 0, y: 0, z: PIVOT + 6, a: 0 }, { x: 1, y: 0, z: PIVOT + 6, a: 360 }]
      : [],
    turns,
    pitch: 1,
    samples: 10,
    rows: 5,
    rasterWork: work,
    reusedRows: 0,
    exhausted: flags.exhausted === true,
    stopped: flags.stopped === true,
    uncovered: flags.uncovered === true,
    ineligible: flags.ineligible === true,
    failures,
  }
}

interface WalkRecord {
  /** `helix:<from>-<to>` and `ring:<index>`, in the order the walk emitted them. */
  readonly order: string[]
  readonly helices: string[]
  readonly rings: number[]
  readonly spends: ContinuousHelixSpend[]
  readonly result: ReturnType<typeof walkContinuousBand>
}

function walkBand(
  along: readonly number[],
  attempt: ContinuousBandVisit['attempt'],
  extra: Partial<ContinuousBandVisit> = {},
  fromRing = 0,
  toRing = along.length - 1,
): WalkRecord {
  const order: string[] = []
  const helices: string[] = []
  const rings: number[] = []
  const spends: ContinuousHelixSpend[] = []
  const result = walkContinuousBand({
    along,
    attempt: (from, to, spent) => {
      spends.push(spent)
      return attempt(from, to, spent)
    },
    emitHelix: (helix) => {
      order.push(`helix:${helix.turns}`)
      helices.push(`${helix.turns}`)
    },
    emitRing: (ring) => {
      order.push(`ring:${ring}`)
      rings.push(ring)
    },
    ...extra,
  }, fromRing, toRing)
  return { order, helices, rings, spends, result }
}

// ── a middle feature: helix - rings - helix, on complete boundary rings ────
{
  const along = [0, 2, 4, 6, 8, 10, 12, 14]
  // One narrow span, between the rings at 6 and 10: the rings that bracket it
  // are 6 and 10, and both must be cut as rings.
  const feature: ContinuousHelixFailure = { start: 7.5, end: 8.5 }
  const record = walkBand(along, (from, to) => (
    along[from] <= feature.start && along[to] >= feature.end
      ? fakeHelix(1, 10, [feature])
      : fakeHelix(to - from, 10)
  ))
  assert.deepEqual(record.order, ['helix:2', 'ring:3', 'ring:4', 'ring:5', 'helix:1'],
    `the band is cut helix - rings - helix around the failing span (got ${record.order.join(', ')})`)
  assert.deepEqual(record.rings, [3, 4, 5],
    'the rings are the ring positions covering the span, bracketing rings included')
  // The bracketing rings are what makes the seams complete rings: without them
  // the whole band would fall back to rings, so the helix pieces and their
  // complete boundary rings are the boundary rule that keeps a strip from
  // standing uncut at a seam.
  assert.equal(record.helices.length, 2, 'both runs of the band get their own helix')
  assert.deepEqual(record.spends.map((spent) => spent.work), [0, 10, 20],
    `every attempt is handed what the band already spent (got ${record.spends.map((s) => s.work).join(', ')})`)
  assert.equal(record.result.stopped, false, 'a split band is not cancellation')

  // A span that brackets **no** ring interval -- the synthetic case a mutation
  // would produce by not expanding to the bracketing rings -- marks every ring
  // and must fall back to rings instead of looping.
  const wide = walkBand(along, () => fakeHelix(1, 10, [{ start: 0, end: 14 }]))
  assert.equal(wide.helices.length, 0, 'a span covering every ring cannot be split any further')
  assert.deepEqual(wide.rings, [0, 1, 2, 3, 4, 5, 6, 7], 'the whole band keeps its rings')
  console.log(`  ca-g split: helix - rings ${record.rings.join(',')} - helix, `
    + `${record.spends.map((s) => s.work).join('/')} triangles shared`)
}

// ── the refusals that are not about tolerance keep the whole band's rings ──
{
  const along = [0, 2, 4, 6, 8, 10]
  const band = [0, 1, 2, 3, 4, 5]
  const cases: { label: string; flags: Partial<ContinuousHelix> }[] = [
    { label: 'a spent budget', flags: { exhausted: true } },
    { label: 'no model under the tool', flags: { uncovered: true } },
    { label: 'no material at this layer', flags: { ineligible: true } },
  ]
  for (const { label, flags } of cases) {
    const record = walkBand(along, () => fakeHelix(1, 10, [], flags))
    assert.equal(record.helices.length, 0, `${label} splits nothing`)
    assert.deepEqual(record.rings, band, `${label} keeps every ring of the band`)
  }
  // Cancellation stops the walk with nothing emitted: the caller drops the
  // operation's motion.
  const stopped = walkBand(along, () => fakeHelix(1, 10, [], { stopped: true }))
  assert.equal(stopped.result.stopped, true, 'a cancelled attempt stops the walk')
  assert.deepEqual(stopped.rings, [], 'a cancelled walk emits no rings')

  // A case the builder does not cover is `null`, and still cuts the band rings.
  const notCovered = walkBand(along, () => null)
  assert.equal(notCovered.helices.length, 0, 'a case outside the module keeps rings')
  assert.deepEqual(notCovered.rings, band, 'and keeps every ring of the band')

  // The caller can refuse a verified helix -- the region test. That is not a
  // tolerance refusal either, so the range keeps its rings and is not split.
  const regionRefused = walkBand(along, () => fakeHelix(3, 10), { accept: () => false })
  assert.equal(regionRefused.helices.length, 0, 'a helix the caller will not cut keeps rings')
  assert.deepEqual(regionRefused.rings, band, 'the whole range keeps its rings')
  console.log('  ca-g refusals: cancelled / spent / uncovered / ineligible / uncovered case all keep rings')
}

// ── the recursion is bounded, and a real budget stops the split ────────────
{
  // Sixteen rings, so a middle failure still leaves a piece long enough to
  // refuse again: the surface whose failures keep landing in the same place.
  const along = Array.from({ length: 16 }, (_, i) => 2 * i)
  const selfSimilar = (from: number, to: number): ContinuousHelix => {
    const mid = (along[from] + along[to]) / 2
    return fakeHelix(1, 1, [{ start: mid - 0.5, end: mid + 0.5 }])
  }
  const depthZero = walkBand(along, selfSimilar, { maxDepth: 0 })
  assert.equal(depthZero.helices.length, 0, 'a zero-depth cap splits nothing')
  assert.deepEqual(depthZero.rings, along.map((_, i) => i), 'a zero-depth cap cuts the band as rings')
  assert.equal(depthZero.spends.length, 1, 'a zero-depth cap makes one attempt')
  // One level marks the two rings around the middle and attempts the two runs
  // beside them: the parent plus two pieces, and each of those pieces is at its
  // own cap. That is the split the failure is for, and the cap is what stops it
  // from going deeper.
  const depthOne = walkBand(along, selfSimilar, { maxDepth: 1 })
  assert.equal(depthOne.spends.length, 3, `one level is the parent and its two runs (${depthOne.spends.length})`)
  assert.deepEqual(depthOne.rings.filter((ring) => ring === 7 || ring === 8), [7, 8],
    'one level cuts the two rings around the middle as rings')
  assert.equal(MAX_HELIX_SPLIT_DEPTH, 3, 'the depth cap is the documented three levels')
  const defaulted = walkBand(along, selfSimilar, { maxDepth: undefined })
  assert.ok(defaulted.spends.length > depthOne.spends.length,
    `the default cap goes deeper than one level (${defaulted.spends.length} attempts)`)
  assert.ok(defaulted.spends.length <= 2 ** (MAX_HELIX_SPLIT_DEPTH + 1),
    `the default cap stops the recursion (${defaulted.spends.length} attempts)`)
  assert.ok(defaulted.rings.length > 0, 'whatever the split cannot verify is cut as rings')

  // A band budget that is already spent refuses every attempt, so the band is
  // rings. The real builder is what enforces it: a mutation that ignores
  // `spent` returns a path here and the test fails with a helix.
  const spentOut = walkBand(
    [BAND.start, BAND.start + 2, BAND.start + 4, BAND.start + 6],
    (from, to, spent) => build(RIDGE, FLAT, {
      band: { start: BAND.start + 2 * from, end: BAND.start + 2 * to },
      startAngle: 0,
      spent,
    }),
    { spent: { samples: 0, rows: 0, work: MAX_HELIX_RASTER_WORK } },
  )
  assert.equal(spentOut.helices.length, 0,
    'a band whose work budget is spent keeps its rings (the split shares the cap)')
  assert.deepEqual(spentOut.rings, [0, 1, 2, 3], 'every ring of the spent band is cut')
  const broke = build(RIDGE, FLAT, { spent: { samples: 0, rows: 0, work: MAX_HELIX_RASTER_WORK } })
  assert.equal(broke.exhausted, true, 'the builder charges the band\'s earlier attempts against its cap')
  assert.equal(broke.points.length, 0, 'a band over its shared budget emits no points')
  const free = build(RIDGE, FLAT, { spent: ZERO_HELIX_SPEND })
  assert.ok(free.points.length > 1, 'the same band with its budget unspent is a helix')
  console.log(`  ca-g budget: ${defaulted.spends.length} bounded attempts (0/1/2/deep caps), a spent band is rings, an unspent one is a helix`)
}

// ---------------------------------------------------------------------------
// 10. #1103 slice ca-g correction round 1: the required **real** middle feature,
//     and the seam link that must be the checked one.
//
//     Section 9's walk is driven with synthetic attempts: it proves *which*
//     rings and pieces the walk chooses, but a ring there is one index and a
//     piece is one number, so it cannot prove that any material moves. Both of
//     the review's P1 findings live in that gap -- removing the split's boundary
//     rings, or the finish's fallback rings, left both suites green.
//
//     This fixture is real. A D20 x 40 bar is turned to r6 with two sharp raised
//     sectors, 3 mm proud and 20 degrees wide, centred on the angle the around
//     finish commands as A0:
//
//     - the **middle feature** at x14..14.5. A sector is not a surface of
//       revolution, so a straight helix segment across its edge cannot be
//       verified and the refinement refuses it; the band is split into a helix,
//       the forward-only rings over the feature, and a helix. The ring at 14.25
//       cuts the feature's own top.
//     - the **seam feature** at x17..17.3. It lies between the last fallback
//       ring (16.167) and the second helix's opening ring (18.083) and more than
//       one cutter radius from both, so no ring's sample can see it: the only
//       pass that crosses it is the seam link. A straight cut between the same
//       two ring ends gouges it by three millimetres, which is the mutation
//       "replace the helix entry's `followLink` with a direct unchecked cut".
// ---------------------------------------------------------------------------
console.log('Testing the ca-g split on a real middle feature and its checked seam link...')

/** A raised angular sector on a turned bar: `degrees` wide at `radius`. */
interface SectorFeature {
  readonly from: number
  readonly to: number
  readonly degrees: number
  readonly radius: number
}

/**
 * A turned bar with sharp raised sectors, centred on the angle the around finish
 * commands as A0 (the `+Y` direction of an X-axis bar).
 *
 * `lathe` above is a surface of revolution, where every pose at one along
 * position has the same support and a helix over it verifies everywhere. A
 * sector is not, so a segment across its edge is the "sharp feature" the split
 * exists for; a sector between two ring positions is reachable only by the link
 * that crosses it.
 */
function sectoredBar(
  features: readonly SectorFeature[],
  stock: BarStock,
  base: number,
  step = 0.25,
  segments = 360,
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const lower = Math.min(6, ...features.map((feature) => feature.from))
  const upper = Math.max(34, ...features.map((feature) => feature.to))
  const rings: number[] = []
  for (let along = lower; along < upper - 1e-9; along += step) rings.push(along)
  rings.push(upper)
  for (const feature of features) {
    if (!rings.some((along) => Math.abs(along - feature.from) < 1e-9)) rings.push(feature.from)
    if (!rings.some((along) => Math.abs(along - feature.to) < 1e-9)) rings.push(feature.to)
  }
  rings.sort((left, right) => left - right)
  const DEG = Math.PI / 180
  const positions: number[] = []
  const index: number[] = []
  for (const along of rings) {
    for (let j = 0; j < segments; j++) {
      const theta = 360 * j / segments
      let radius = base
      for (const feature of features) {
        if (along < feature.from - 1e-9 || along > feature.to + 1e-9) continue
        let offset = ((theta - 90) % 360 + 360) % 360
        if (offset > 180) offset = 360 - offset
        if (offset <= feature.degrees / 2) radius = feature.radius
      }
      positions.push(along, centre + radius * Math.cos(theta * DEG), pivot + radius * Math.sin(theta * DEG))
    }
  }
  const n = segments
  for (let ring = 0; ring + 1 < rings.length; ring++) {
    for (let j = 0; j < segments; j++) {
      const j2 = (j + 1) % segments
      const a = ring * n + j
      const b = ring * n + j2
      const c = (ring + 1) * n + j2
      const d = (ring + 1) * n + j
      index.push(a, b, c, a, c, d)
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/**
 * The emitted seam link that enters a helix piece at `start`: the consecutive
 * cut moves that hold their A and end at the piece's opening ring.
 */
function entryLink(
  moves: readonly ToolpathMove[],
  at: (point: ToolpathPoint) => number,
  start: number,
): ToolpathMove[] {
  let last = -1
  for (let i = 0; i < moves.length; i++) {
    const move = moves[i]
    if (move.kind !== 'cut') continue
    if (Math.abs(at(move.to) - start) > NEAR_ALONG) continue
    if (Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) > 1e-9) continue
    if (!(Math.abs(at(move.to) - at(move.from)) > 1e-9)) continue
    last = i
    break
  }
  assert.ok(last >= 0, `a seam link enters the helix piece at along ${start}`)
  let first = last
  while (first > 0) {
    const move = moves[first - 1]
    if (move.kind !== 'cut') break
    // A seam link holds its A exactly. Its steep drops are emitted as an
    // along leg plus a vertical leg at the same along position, so a vertical
    // leg belongs to the link too: that is why this joins on the along
    // coordinate, not on "the move advances".
    if (Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) > 1e-9) break
    if (Math.abs(at(move.to) - at(moves[first].from)) > NEAR_ALONG) break
    first--
  }
  return moves.slice(first, last + 1)
}

{
  const stock: BarStock = roundStock(20, 40, 'x', { x: 0, y: 0 })
  const pivot = barPivotZ(stock)
  const tool: NormalizedTool = {
    ...BALL, id: 'seam-ball', name: '1 mm ball nose', type: 'ball_endmill',
    diameter: 1, radius: 0.5,
  }
  const base = 6
  const middle: SectorFeature = { from: 14, to: 14.5, degrees: 20, radius: 9 }
  const seam: SectorFeature = { from: 17, to: 17.3, degrees: 20, radius: 9 }
  const params = {
    stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 8, alongEnd: 32,
    safeRadius: 12, requestedCellSize: 0.05, passDirection: 'around' as const,
  }
  const mesh = sectoredBar([middle, seam], stock, base)
  const result = generateRotaryFinish('ca-g-seams', mesh, stock, tool, params, {})
  assert.deepEqual(result.warnings, [], 'the seam fixture warns about nothing')
  const at = alongOf
  const tip = (point: ToolpathPoint): number => point.z - pivot
  const supportAt = (along: number, angle: number): number => support(mesh, tool, along, angle, stock)
  // The ring grid as the around finish builds it, recomputed here from the
  // operation's own numbers: one position every stepover over the cutter span
  // (one radius inside each retained end), both ends included.
  const spanStart = params.alongStart + tool.radius
  const spanEnd = params.alongEnd - tool.radius
  const ringCount = Math.ceil((spanEnd - spanStart) / params.stepover)
  const ringGrid = Array.from(
    { length: ringCount + 1 },
    (_, i) => spanStart + (spanEnd - spanStart) * i / ringCount,
  )
  assert.equal(ringCount, 12, '23 mm at a 2 mm stepover is twelve ring intervals')
  const allowance = 0.02
  // The pose-by-pose tip check is skipped here on purpose: a one-pose re-sample
  // of the sampler moves by a whole cell at a sector's steep edge, which is a
  // property of the reference, not of the ring. The feature's own plateau is
  // checked explicitly below, and every cut move is swept against the surface
  // by `assertCutAboveSupport`.
  const coverage = assertRingCoverage(result.moves, at, tip, ringGrid, undefined, allowance, 'seam fixture')
  const segments = assertCutAboveSupport(result.moves, at, tip, supportAt, allowance, 'seam fixture')

  // The split is helix - rings - helix, and both helix pieces open and close on
  // the ring grid's own positions.
  assert.equal(coverage.pieces.length, 2,
    `the band is split into two helix pieces (got ${coverage.pieces.length})`)
  const [first, second] = coverage.pieces
  assert.ok(Math.abs(first.start - ringGrid[0]) < NEAR_ALONG,
    `the first piece opens on the band's first ring (${first.start} versus ${ringGrid[0]})`)
  assert.ok(Math.abs(first.end - ringGrid[1]) < NEAR_ALONG,
    `the first piece closes on the next ring (${first.end} versus ${ringGrid[1]})`)
  assert.ok(Math.abs(second.start - ringGrid[5]) < NEAR_ALONG,
    `the second piece opens after the feature's rings (${second.start} versus ${ringGrid[5]})`)
  assert.ok(Math.abs(second.end - ringGrid[ringGrid.length - 1]) < NEAR_ALONG,
    `the second piece closes on the band's last ring (${second.end})`)
  const fallback = coverage.rings.filter(
    (along) => along > first.end + NEAR_ALONG && along < second.start - NEAR_ALONG,
  )
  assert.deepEqual(fallback.map((along) => Math.round(along * 1e6) / 1e6),
    [ringGrid[2], ringGrid[3], ringGrid[4]].map((along) => Math.round(along * 1e6) / 1e6),
    'the three rings around the feature are cut as forward-only rings')

  // The middle feature is inside those rings and the ring on it cuts its top.
  const featureRing = ringGrid[3]
  assert.ok(featureRing > middle.from && featureRing < middle.to,
    'one fallback ring lands on the feature')
  const featureTop = supportAt(featureRing, 0)
  assert.ok(featureTop > middle.radius - 0.1,
    `the feature's own sampled top is its raised sector (${featureTop.toFixed(3)})`)
  let featureCut = Number.NEGATIVE_INFINITY
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    for (const point of [move.from, move.to]) {
      if (Math.abs(at(point) - featureRing) < NEAR_ALONG) featureCut = Math.max(featureCut, tip(point))
    }
  }
  assert.ok(Math.abs(featureCut - featureTop) <= 0.1,
    `the ring at the feature cuts its top (${featureCut.toFixed(3)} versus ${featureTop.toFixed(3)})`)
  assert.ok(featureCut > base + 2.5,
    `the ring at the feature really reaches its raised top (${featureCut.toFixed(3)} over a ${base} mm body)`)

  // The seam feature is between two rings and invisible to both, so the seam
  // link is the only pass that crosses it -- and it must follow it.
  assert.ok(seam.from > ringGrid[4] + tool.radius && seam.to < ringGrid[5] - tool.radius,
    'the seam feature is more than a cutter radius from both rings')
  for (const along of [ringGrid[4], ringGrid[5]]) {
    assert.ok(supportAt(along, 0) < seam.radius - 1,
      `the ring at ${along} cannot reach the seam feature (support ${supportAt(along, 0).toFixed(3)})`)
  }
  const entry = entryLink(result.moves, at, second.start)
  assert.ok(entry.length > 0, 'the second helix is entered by a cut, not a retract')
  let linkTop = Number.NEGATIVE_INFINITY
  for (const move of entry) {
    for (const point of [move.from, move.to]) linkTop = Math.max(linkTop, tip(point))
  }
  assert.ok(linkTop > seam.radius - 0.1,
    `the seam link climbs the feature it crosses (top ${linkTop.toFixed(3)}, feature ${seam.radius})`)
  // The mutation: `followLink` replaced by one straight cut between the same two
  // ends. The checked link is the only thing between this fixture and that cut.
  const linkFrom = entry[0].from
  const linkTo = entry[entry.length - 1].to
  const linkAngle = linkFrom.a ?? 0
  let straightGouge = Number.NEGATIVE_INFINITY
  for (let step = 0; step <= 40; step++) {
    const f = step / 40
    const along = at(linkFrom) + (at(linkTo) - at(linkFrom)) * f
    const z = tip(linkFrom) + (tip(linkTo) - tip(linkFrom)) * f
    straightGouge = Math.max(straightGouge, supportAt(along, linkAngle) - z)
  }
  assert.ok(straightGouge > 0.5,
    `a straight cut between the same ends gouges the seam feature by ${straightGouge.toFixed(3)} mm, `
    + 'so an unchecked helix-entry link cannot pass this fixture')
  // The fallback rings would not cut it, so the link is load-bearing: the emitted
  // link is the checked one, and the sweep above proved every one of its
  // segments stays at or above the surface.
  assert.ok(entry.length > 1, `the emitted seam link follows the surface (${entry.length} cut moves)`)
  console.log(`  ca-g seams: 2 helix pieces, ${fallback.length} fallback rings, `
    + `${coverage.rings.length} required rings, ${segments} cut samples; `
    + `seam link ${entry.length} moves, straight-cut gouge ${straightGouge.toFixed(2)} mm`)
}
