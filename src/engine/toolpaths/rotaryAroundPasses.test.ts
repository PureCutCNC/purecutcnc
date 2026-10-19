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
 * #1045 slice A: rotary passes **around** the bar.
 *
 * The along pass is the original motion and must stay byte-identical: the first
 * block asserts that a missing `passDirection` and an explicit `'along'` produce
 * the same result, and that both match a digest recorded from the base commit
 * (`e3175dd6`) with a scratch script before the change. The digests are of
 * `JSON.stringify(result)` for the three fixtures exactly as built here -- the
 * cone and the stepped cylinder on a round bar, and the square blank.
 *
 * The around pass is a ring per along position: one angle every `sampleSpacing`
 * of surface distance, both 0 and 360 present, rings alternating direction so A
 * stays in [0, 360] and no `(layer - 1) * 360` is added in the rough. The angle
 * step is capped so the straight move between two samples stays within the
 * stated 0.005 mm of a convex section (#1045 slice D, finding 2): the cap's
 * arithmetic is `barMaxRadius * dTheta^2 / 8 <= 0.005 mm`, and the hex block
 * below walks every cutting move at eight interior points against an
 * independent drop-cutter support of the extruded hex, not just its endpoints.
 *
 * The independent reference for the seeded property block does not call
 * `sampleRotaryModel` or any other sampler code: it is the analytic drop-cutter
 * tip of a solid of revolution, `max` over the tool footprint of
 * `sqrt(max(0, r(x+dx)^2 - dy^2)) - lift(dx, dy)`, reduced to its dy = 0
 * maximum (a revolved surface is highest over the axis) and evaluated on a
 * 2000-step grid. The property block now walks **every** move -- cuts, links,
 * rapids and plunges -- at eight interior points plus both endpoints, and
 * checks each against that reference; a non-cut move that turns the stock must
 * also stay at or above the travel height.
 *
 * A round bar keeps material beyond the cut band (#1045 slice D, finding 1).
 * The along positions start and end one cutter radius inside a stubbed end --
 * the C2-F7 rule the square blank already used -- so no move's cutter body can
 * enter the retained end even when the overlap is thinner than a height-map
 * cell. Both around and along mode are checked, because along mode gouged too
 * at unfavourable sample spacings (see the retained-end block).
 *
 * Mutations checked (each must fail here):
 *  - the arc term dropped from the steep-step spacing -> the hex prism gains
 *    purely vertical cut moves;
 *  - the ring direction not alternating -> consecutive-direction assertion;
 *  - the tip read with the forward `k` on a reversed ring -> the angle-asymmetric
 *    index check;
 *  - `stepover` used for the angular step -> the ring length / A range;
 *  - `(layer - 1) * 360` added back in the around rough -> the A range;
 *  - the `max(tip, layerRadius)` clamp dropped in the around rough -> the
 *    layering block: the cylinder is cut to its model radius on the first
 *    layer and that full-depth cut is repeated at every layer;
 *  - the around pass silently falling back to along -> the differing-outputs and
 *    ring-shape blocks;
 *  - the link / retract / traverse height set to the pivot instead of the
 *    travel height -> the property block (the swept reference check and the
 *    non-cut turning-move check) and the all-move walk;
 *  - the rough's `NaN` fallback leaving the blank untouched -> the missing-model
 *    block: no move reaches the axis fallback;
 *  - the new angle-step cap removed -> the ring-count assertion, and
 *    independently the hex block's cap and sweep assertions (the pre-cap
 *    A325.7143 -> 330 move gouges 0.0396 mm);
 *  - the adaptive subdivision removed (#1045 slice E) -> the hex block's
 *    **emitted-motion** assertion: the sampler-backed cap alone leaves more
 *    than `tol` at a 1.5 mm ball on the hex, because the sagitta bound is not
 *    the ball contact envelope. `tol` is `max(0.005 mm, s^2 / (8 r))` for the
 *    segment's own surface spacing `s`, asserted with no added allowance;
 *  - the conservative cell upper bound removed (#1045 slice F,
 *    `conservativeCellBounds`) -> the same block's endpoint check: a
 *    cell-centre height map under-reads the hex's vertex by 0.0127 mm, so the
 *    emitted sample itself stands below the model and the block fails before
 *    it even measures the interpolation;
 *  - the retained-end pull-in removed for round bars -> the retained-end block:
 *    the first centre is on the stub face and the cutter body crosses it.
 *
 * A square blank now generates around passes; #1045 slice C owns those
 * (`rotarySquareAroundPasses.test.ts`), so the square block here only proves
 * the old refusal is gone and the blank still produces motion.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryAroundPasses.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { roundStock } from '../../types/project'
import type { BarStock, Operation, RoundStock } from '../../types/project'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { BUNDLED_DEFINITIONS } from '../gcode/definitions'
import { runPostProcessor } from '../gcode/postprocessor'
import { validateMachineDefinition } from '../gcode/types'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { normalizeToolForProject } from './geometry'
import { generateRotaryFinish, generateRotaryRough, sampleRotaryModel } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import { generateRotaryOperation } from './rotaryOperation'
import type { NormalizedTool, ToolpathMove, ToolpathPoint } from './types'

const CELL = 0.05
const BALL: NormalizedTool = {
  id: 'ball-3', name: '3 mm ball nose', sourceUnits: 'mm', units: 'mm',
  type: 'ball_endmill', diameter: 3, radius: 1.5, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}
const FLAT: NormalizedTool = { ...BALL, id: 'flat-4', name: '4 mm flat end mill', type: 'flat_endmill', diameter: 4, radius: 2 }
/** The tool the recorded base-commit digests were taken with: a 4 mm ball. */
const DIGEST_TOOL: NormalizedTool = { ...BALL, id: 'ball-2', name: '2 mm ball nose', diameter: 4, radius: 2 }

function approx(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: got ${actual}, expected ${expected}`)
}

/**
 * A closed surface of revolution around the bar's own axis: one ring of
 * `segments` points at each entry, so a duplicated along position makes a
 * vertical shoulder. The radius is exact between rings (the triangles
 * interpolate linearly), which is what the property block's reference assumes.
 */
function revolved(stock: RoundStock, rings: readonly { along: number; radius: number }[], segments: number): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const ring of rings) {
    for (let j = 0; j < segments; j++) {
      const t = 2 * Math.PI * j / segments
      const across = centre + ring.radius * Math.cos(t)
      const up = pivot + ring.radius * Math.sin(t)
      if (stock.axis === 'x') positions.push(ring.along, across, up)
      else positions.push(across, ring.along, up)
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

/** Closed extrusion: two triangulated caps and triangulated side quads. */
function prism(
  stock: BarStock,
  crossSection: readonly (readonly [number, number])[],
  ends: readonly [number, number],
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const along of ends) {
    for (const [across, up] of crossSection) {
      if (stock.axis === 'x') positions.push(along, centre + across, pivot + up)
      else positions.push(centre + across, along, pivot + up)
    }
  }
  const n = crossSection.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    index.push(i, j, n + j, i, n + j, n + i)
  }
  for (let i = 1; i < n - 1; i++) index.push(0, i + 1, i, n, n + i, n + i + 1)
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

const alongOf = (point: { x: number; y: number }): number => point.x
const angleOf = (point: ToolpathPoint): number => {
  assert.ok(point.a !== undefined, 'every rotary point carries A')
  return point.a
}

// ---------------------------------------------------------------------------
// 1. Byte-identical along mode.
//
// The digests were recorded from the base commit's generators with a scratch
// script before the change, on the fixtures below and the parameters named in
// each row. A missing `passDirection` and `'along'` must both reproduce them.
// ---------------------------------------------------------------------------

const DIGEST_STOCK = roundStock(40, 20, 'x', { x: 10, y: 7 })
const DIGEST_SQUARE = squareStock(40, 30, 'x')
const SQUARE_SECTION = [[-10, -10], [10, -10], [10, 10], [-10, 10]] as const

function digestCone(): RotaryModelMesh {
  const rings = Array.from({ length: 65 }, (_, s) => {
    const along = 10 + 20 * s / 64
    return { along, radius: 3 + along / 10 }
  })
  return revolved(DIGEST_STOCK, rings, 64)
}

function digestStepped(): RotaryModelMesh {
  return revolved(DIGEST_STOCK, [
    { along: 10, radius: 4 }, { along: 20, radius: 4 },
    { along: 20, radius: 7 }, { along: 30, radius: 7 },
  ], 64)
}

const DIGEST_FINISH = {
  sampleSpacing: 2, stockToLeave: 0, alongStart: 10, alongEnd: 30,
  safeRadius: 30, requestedCellSize: CELL, stepover: 20,
}
const DIGEST_ROUGH = { ...DIGEST_FINISH, sampleSpacing: 1, stepover: 22, stepdown: 4 }
const DIGEST_SQUARE_FINISH = { ...DIGEST_FINISH, alongStart: 5, alongEnd: 25 }
const DIGEST_SQUARE_ROUGH = { ...DIGEST_SQUARE_FINISH, sampleSpacing: 1, stepover: 22, stepdown: 4 }

interface DigestCase {
  readonly label: string
  readonly operationId: string
  readonly kind: 'finish' | 'rough'
  readonly mesh: () => RotaryModelMesh
  readonly stock: BarStock
  readonly params: typeof DIGEST_FINISH & { stepdown?: number }
  readonly recorded: string
}

const DIGEST_CASES: readonly DigestCase[] = [
  {
    label: 'cone finish', operationId: 'cone', kind: 'finish', mesh: digestCone,
    stock: DIGEST_STOCK, params: DIGEST_FINISH,
    recorded: 'f7b83ed181b9fb70d2b335dc1015e7a609a84995b8a95dfaecf16c57f5a5cd1b',
  },
  {
    label: 'cone rough', operationId: 'cone', kind: 'rough', mesh: digestCone,
    stock: DIGEST_STOCK, params: DIGEST_ROUGH,
    recorded: 'e7264da966e737845e6a230d100031840fbc0cd6a321ca33146af3552af889b0',
  },
  {
    label: 'stepped finish', operationId: 'step', kind: 'finish', mesh: digestStepped,
    stock: DIGEST_STOCK, params: DIGEST_FINISH,
    recorded: 'dbb5052518b3066acf31a02cafa8f9a3d816a85400362c52bc38a01fa48a8d2f',
  },
  {
    label: 'stepped rough', operationId: 'step', kind: 'rough', mesh: digestStepped,
    stock: DIGEST_STOCK, params: DIGEST_ROUGH,
    recorded: 'edeb101f1f5eda21e77217db752713ba218eaa05303a63ce0f56a092c4b94814',
  },
  {
    label: 'square finish', operationId: 'square', kind: 'finish',
    mesh: () => prism(DIGEST_SQUARE, SQUARE_SECTION, [10, 30]),
    stock: DIGEST_SQUARE, params: DIGEST_SQUARE_FINISH,
    recorded: '8e03601562ba666c743f1c2f4ffbe5ebe433f6464ac5834c5148865b92bc4965',
  },
  {
    label: 'square rough', operationId: 'square', kind: 'rough',
    mesh: () => prism(DIGEST_SQUARE, SQUARE_SECTION, [10, 30]),
    stock: DIGEST_SQUARE, params: DIGEST_SQUARE_ROUGH,
    recorded: 'cb24f0e3cd807accfcb1d70890103854d66268ec06ef54d519c74643b770210e',
  },
]

for (const testCase of DIGEST_CASES) {
  const run = (passDirection: 'along' | undefined) => {
    const params = passDirection === undefined
      ? testCase.params
      : { ...testCase.params, passDirection }
    const mesh = testCase.mesh()
    return testCase.kind === 'finish'
      ? generateRotaryFinish(testCase.operationId, mesh, testCase.stock, DIGEST_TOOL, params as typeof DIGEST_FINISH, {})
      : generateRotaryRough(testCase.operationId, mesh, testCase.stock, DIGEST_TOOL, params as typeof DIGEST_ROUGH, {})
  }
  const missing = run(undefined)
  const along = run('along')
  assert.deepEqual(missing, along, `${testCase.label}: missing passDirection equals 'along'`)
  assert.deepEqual(missing, run('along'), `${testCase.label}: along is deterministic`)
  assert.equal(digest(missing), testCase.recorded, `${testCase.label}: along output is byte-identical to the base commit`)
  assert.ok(missing.moves.length > 0, `${testCase.label}: along output has motion`)
}

// ---------------------------------------------------------------------------
// 2. Ring shape: one along coordinate per ring, A inside [0, 360], and
//    consecutive rings running in opposite angle directions.
// ---------------------------------------------------------------------------

interface Ring {
  readonly along: number
  readonly angles: number[]
}

/** Cut moves grouped into rings by their along coordinate, in emission order. */
function cutRings(moves: readonly ToolpathMove[]): Ring[] {
  const rings: Ring[] = []
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    const along = alongOf(move.from)
    assert.equal(alongOf(move.to), along, 'a cut move never leaves its ring')
    const last = rings[rings.length - 1]
    if (last && last.along === along) {
      last.angles.push(angleOf(move.from), angleOf(move.to))
    } else {
      rings.push({ along, angles: [angleOf(move.from), angleOf(move.to)] })
    }
  }
  return rings
}

/** +1 for a forward ring, -1 for a reversed one, 0 for a ring that does not turn. */
function ringDirection(ring: Ring): number {
  for (let i = 1; i < ring.angles.length; i++) {
    if (ring.angles[i] !== ring.angles[i - 1]) return Math.sign(ring.angles[i] - ring.angles[i - 1])
  }
  return 0
}

const RING_STOCK = roundStock(40, 20, 'x', { x: 10, y: 7 })
const RING_MESH = revolved(RING_STOCK, [
  { along: 10, radius: 4 }, { along: 20, radius: 4 },
  { along: 20, radius: 7 }, { along: 30, radius: 7 },
], 64)
const RING_PARAMS = {
  stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 10, alongEnd: 30,
  safeRadius: 30, requestedCellSize: CELL,
}

/**
 * The around grid's angular interval count under the slice-D cap (#1045 slice
 * D): one sample every `min(sampleSpacing, sqrt(8 R tolerance))` of arc, with
 * `R = barMaxRadius` and the stated 0.005 mm tolerance (these fixtures are mm).
 * Restated here rather than read from the generator, so a cap that changes
 * silently moves the expected ring length.
 */
function aroundAngleIntervals(radius: number, sampleSpacing: number, tolerance = 0.005): number {
  return Math.ceil((2 * Math.PI * radius) / Math.min(sampleSpacing, Math.sqrt(8 * radius * tolerance)))
}

{
  const result = generateRotaryFinish('rings', RING_MESH, RING_STOCK, FLAT, { ...RING_PARAMS, passDirection: 'around' }, {})
  assert.deepEqual(result.warnings, [], 'the around finish has no warning')
  for (const move of result.moves) {
    for (const point of [move.from, move.to]) {
      const a = angleOf(point)
      assert.ok(a >= 0 && a <= 360, `A ${a} is inside [0, 360]`)
      if (move.kind === 'cut') {
        assert.equal(alongOf(point), alongOf(move.from), 'every cut point keeps its ring’s along coordinate')
      }
      assert.ok(point.z >= barPivotZ(RING_STOCK) - 1e-9, 'no point cuts below the pivot')
    }
  }
  const rings = cutRings(result.moves)
  // `stepover` is the along step: 20 mm over 2 mm makes 11 rings. The angular
  // step is `sampleSpacing` round the bar's circumference, capped by slice D.
  assert.equal(rings.length, 11, 'one ring per along position, `stepover` apart')
  // 141 samples per ring under the slice-D angle cap (both ends of the turn).
  // Slice G's merge drops the interior points of a run that is straight in
  // (along, A, Z), so a ring's emitted points are that grid or fewer; the run
  // still starts and ends on the grid's own angles, and `rotaryMerge.test.ts`
  // proves the dropped points are on the emitted line within tolerance.
  const angularIntervals = aroundAngleIntervals(20, RING_PARAMS.sampleSpacing)
  assert.ok(rings[0].angles.length <= angularIntervals * 2,
    'a ring sweeps no more points than the capped angle count')
  assert.ok(rings[0].angles.length >= 2, 'and it still turns')
  for (let i = 0; i < rings.length; i++) {
    const direction = ringDirection(rings[i])
    assert.equal(direction, i % 2 === 0 ? 1 : -1, `ring ${i} runs ${i % 2 === 0 ? 'forward' : 'reversed'}`)
    const forward = i % 2 === 0
    assert.equal(rings[i].angles[0], forward ? 0 : 360, `ring ${i} starts where the previous one ended`)
    assert.equal(rings[i].angles[rings[i].angles.length - 1], forward ? 360 : 0, `ring ${i} closes the turn`)
  }
}

{
  // The rough keeps the same ring shape at every layer: layers are not rings,
  // the along positions are, and the direction alternation continues across the
  // layer boundary instead of adding `(layer - 1) * 360`. The taper stays inside
  // one stepdown, so every ring cuts at every layer and the emitted rings are
  // exactly the visited ones.
  const taper = revolved(RING_STOCK, Array.from({ length: 65 }, (_, s) => ({
    along: 10 + 20 * s / 64,
    radius: 4 + 0.5 * s / 64,
  })), 64)
  const result = generateRotaryRough('rings-rough', taper, RING_STOCK, FLAT, {
    ...RING_PARAMS, stepdown: 3, passDirection: 'around',
  }, {})
  assert.deepEqual(result.warnings, [], 'the around rough has no warning')
  for (const move of result.moves) {
    for (const point of [move.from, move.to]) {
      const a = angleOf(point)
      assert.ok(a >= 0 && a <= 360, `rough A ${a} is inside [0, 360]`)
    }
  }
  const rings = cutRings(result.moves)
  assert.ok(rings.length > 11, 'the rough cuts more than one layer of rings')
  for (let i = 1; i < rings.length; i++) {
    const previous = ringDirection(rings[i - 1])
    const current = ringDirection(rings[i])
    assert.notEqual(current, 0, `rough ring ${i} turns`)
    assert.equal(current, -previous, `rough ring ${i} runs opposite its predecessor, layers included`)
  }
  // A ring repeated at a later layer is the same along coordinate; the layer
  // count is a multiple of the along count.
  for (let i = 11; i < rings.length; i++) {
    approx(rings[i].along, rings[i - 11].along, `rough ring ${i} returns to the same along position`, 1e-12)
  }
}

// ---------------------------------------------------------------------------
// 3. Independent reference: seeded revolved profiles, ball and flat tools.
//
// The reference is the analytic lowest safe tip of a solid of revolution:
//
//   tip(x) = max over the tool footprint (dx, dy) of
//            sqrt(max(0, r(x + dx)^2 - dy^2)) - lift(dx, dy)
//
// `lift` is 0 for a flat tool and `r - sqrt(r^2 - dx^2 - dy^2)` for a ball. For a
// revolved surface the integrand falls with |dy|, and the footprint's dy = 0
// line is always inside it, so the two-dimensional maximum is the one on
// dy = 0:
//
//   flat: max_{|dx| <= r} r(x + dx)
//   ball: max_{|dx| <= r} r(x + dx) - (r - sqrt(r^2 - dx^2))
//
// which is what `referenceTip` evaluates on a 2000-step dx grid. It never calls
// `sampleRotaryModel` or reads any sampler helper.
// ---------------------------------------------------------------------------

const PROP_BAR = 5
const PROP_LENGTH = 3.2
const PROP_STOCK = roundStock(PROP_BAR, PROP_LENGTH, 'x', { x: 0, y: 0 })
const PROP_SAMPLE_SPACING = 0.06
const PROP_CELL = PROP_SAMPLE_SPACING / 2
const PROP_STEPOVER = 1
const PROP_SEEDS = 50
const PROFILE_SLOPE = 0.4
/** Conservative bound the allowance is stated against; profiles stay under it. */
const SLOPE_BOUND = 0.5
const REFERENCE_STEPS = 2000
const PROP_SEGMENTS = 128

interface Profile {
  readonly xs: readonly number[]
  readonly rs: readonly number[]
}

let randomState = 0x51ce4e2d
function random(): number {
  randomState = (randomState + 0x6d2b79f5) >>> 0
  let t = randomState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (lo: number, hi: number): number => lo + (hi - lo) * random()

/**
 * A random revolved profile covering the whole cut band: three linear segments
 * whose slopes stay at or below `PROFILE_SLOPE`, so the shoulders are cones and
 * chamfered steps of a bounded steepness -- the class the height map's cell
 * allowance is stated for. Radii stay inside the round bar.
 */
function randomProfile(): Profile {
  for (;;) {
    const xs = [0]
    for (let i = 0; i < 3; i++) xs.push(xs[xs.length - 1] + between(0.55, 1.0))
    xs[3] = PROP_LENGTH
    const rs = Array.from({ length: 4 }, () => between(0.6, 2.0))
    let ok = xs[3] > xs[2]
    for (let i = 1; i < 4 && ok; i++) {
      ok = Math.abs(rs[i] - rs[i - 1]) / (xs[i] - xs[i - 1]) <= PROFILE_SLOPE - 1e-9
    }
    if (ok) return { xs, rs }
  }
}

function profileRadius(profile: Profile, x: number): number | null {
  if (x < profile.xs[0] || x > profile.xs[profile.xs.length - 1]) return null
  for (let i = 0; i + 1 < profile.xs.length; i++) {
    if (x <= profile.xs[i + 1]) {
      const f = (x - profile.xs[i]) / (profile.xs[i + 1] - profile.xs[i])
      return profile.rs[i] + (profile.rs[i + 1] - profile.rs[i]) * f
    }
  }
  return profile.rs[profile.rs.length - 1]
}

/** The analytic lowest safe tip at `x`, independent of the sampler (see above). */
function referenceTip(profile: Profile, x: number, tool: NormalizedTool, stockToLeave: number): number {
  const step = (2 * tool.radius) / REFERENCE_STEPS
  let best = Number.NEGATIVE_INFINITY
  for (let i = 0; i <= REFERENCE_STEPS; i++) {
    const dx = -tool.radius + i * step
    const radius = profileRadius(profile, x + dx)
    if (radius === null) continue
    const lift = tool.type === 'ball_endmill'
      ? tool.radius - Math.sqrt(Math.max(0, tool.radius * tool.radius - dx * dx))
      : 0
    if (radius - lift > best) best = radius - lift
  }
  return best + stockToLeave
}

/**
 * The allowance, derived from the grid the sampler reads and the reference's own
 * step -- never a fitted constant:
 *
 *   SLOPE_BOUND x (height-map cell + reference step) + ball footprint clearance
 *
 * The sampler reads surface height at cell centres and can miss the material in
 * the last fraction of a cell inside its footprint; every profile here has a
 * slope of at most `PROFILE_SLOPE` (0.4), so `SLOPE_BOUND` (0.5) is a
 * conservative bound on that miss. The ball term bounds how much its clearance
 * changes over one cell diagonal. At this block's parameters (cell 0.03 mm, tool
 * radius <= 0.6 mm) the worst allowance is ~0.0175 mm, at or below the 0.02 mm
 * the slice allows; the measured worst deficit over the 50 seeds was 0.0108 mm.
 */
function propertyAllowance(tool: NormalizedTool): number {
  const referenceStep = (2 * tool.radius) / REFERENCE_STEPS
  const halfDiagonal = (PROP_CELL * Math.SQRT2) / 2
  const ballClearance = tool.type === 'ball_endmill'
    ? tool.radius - Math.sqrt(Math.max(0, tool.radius * tool.radius - halfDiagonal * halfDiagonal))
    : 0
  return SLOPE_BOUND * (PROP_CELL + referenceStep) + ballClearance + 1e-4
}

{
  let checked = 0
  for (let seed = 0; seed < PROP_SEEDS; seed++) {
    const profile = randomProfile()
    const ball = seed % 2 === 0
    const radius = between(0.25, 0.6)
    const tool: NormalizedTool = {
      ...BALL,
      id: `prop-${seed}`,
      name: `prop-${seed}`,
      type: ball ? 'ball_endmill' : 'flat_endmill',
      radius,
      diameter: 2 * radius,
    }
    const mesh = revolved(PROP_STOCK, profile.xs.map((along, i) => ({ along, radius: profile.rs[i] })), PROP_SEGMENTS)
    const result = generateRotaryFinish(`prop-${seed}`, mesh, PROP_STOCK, tool, {
      stepover: PROP_STEPOVER,
      sampleSpacing: PROP_SAMPLE_SPACING,
      stockToLeave: 0,
      alongStart: 0,
      alongEnd: PROP_LENGTH,
      safeRadius: 20,
      requestedCellSize: PROP_CELL,
      passDirection: 'around',
    }, {})
    assert.deepEqual(result.warnings, [], `seed ${seed}: no warning`)
    const allowance = propertyAllowance(tool)
    assert.ok(allowance <= 0.02, `seed ${seed}: the derived allowance ${allowance} stays at or below 0.02 mm`)
    const referenceByAlong = new Map<number, number>()
    const referenceAt = (along: number): number => {
      let reference = referenceByAlong.get(along)
      if (reference === undefined) {
        reference = referenceTip(profile, along, tool, 0)
        referenceByAlong.set(along, reference)
      }
      return reference
    }
    // The travel height the emitter uses between runs: the bar's surface plus
    // the 1 mm clearance (`rotaryTravelZ`). A non-cut move that turns the stock
    // must never leave it -- the link at travel height is the whole reason the
    // A sweep between two surface samples is in air.
    const travel = barMaxRadius(PROP_STOCK) + 1
    const pivot = barPivotZ(PROP_STOCK)
    let seedCut = 0
    let seedSamples = 0
    for (const move of result.moves) {
      if (move.kind !== 'cut' && move.from.a !== move.to.a) {
        for (const point of [move.from, move.to]) {
          assert.ok(
            point.z - pivot >= travel - 1e-9,
            `seed ${seed}: a non-cut turning move at A ${angleOf(point).toFixed(2)} travels at tip ${(point.z - pivot).toFixed(4)}, below the travel height ${travel}`,
          )
        }
      }
      // Walk the move itself, not only its endpoints (#1045 slice D): a link
      // lowered to the pivot, or a mid-move dip, is invisible to an endpoint
      // check.
      for (let step = 0; step <= 9; step++) {
        const fraction = step / 9
        const along = alongOf(move.from) + (alongOf(move.to) - alongOf(move.from)) * fraction
        const tip = move.from.z + (move.to.z - move.from.z) * fraction - pivot
        const reference = referenceAt(along)
        assert.ok(Number.isFinite(reference), `seed ${seed}: reference at ${along} is finite`)
        assert.ok(
          tip >= reference - allowance,
          `seed ${seed} ${tool.type} r=${tool.radius.toFixed(3)} ${move.kind} along ${along.toFixed(3)} f=${fraction}: tip ${tip.toFixed(4)} is below the reference ${reference.toFixed(4)} by more than ${allowance.toFixed(4)}`,
        )
        seedSamples++
      }
      if (move.kind === 'cut') seedCut += 2
    }
    assert.ok(seedCut > 0, `seed ${seed}: the finish cuts something`)
    checked += seedSamples
  }
  assert.ok(checked > 0, 'the property block walked every move')
  console.log(`rotary around property: ${PROP_SEEDS} seeds, ${checked} move samples (cuts, links, rapids, plunges) at or above the reference`)
}

// ---------------------------------------------------------------------------
// 4. Angle-asymmetric index discipline: every emitted tip is the sampler's own
//    value at that point's (along, angle), on forward and reversed rings.
// ---------------------------------------------------------------------------

const HEX_STOCK = roundStock(40, 20, 'x', { x: 10, y: 7 })
const HEX_RADIUS = 8
const HEX_SECTION = Array.from({ length: 6 }, (_, i): readonly [number, number] => {
  const t = Math.PI * i / 3
  return [HEX_RADIUS * Math.cos(t), HEX_RADIUS * Math.sin(t)]
})

{
  const mesh = prism(HEX_STOCK, HEX_SECTION, [10, 30])
  const result = generateRotaryFinish('hex', mesh, HEX_STOCK, BALL, {
    stepover: 20, sampleSpacing: 1.5, stockToLeave: 0, alongStart: 10, alongEnd: 30,
    safeRadius: 30, requestedCellSize: CELL, passDirection: 'around',
  }, {})
  assert.deepEqual(result.warnings, [], 'the hex finish has no warning')
  const points = result.moves.filter((move) => move.kind === 'cut').flatMap((move) => [move.from, move.to])
  const alongs = [...new Set(points.map(alongOf))].sort((a, b) => a - b)
  const angles = [...new Set(points.map(angleOf))].sort((a, b) => a - b)
  // The emitted tips come from the around-mode sampler's conservative cell
  // bounds (#1045 slice F): every sample is at or above the model's support, so
  // the value at that (along, angle) is the one the emitter had.
  const sampling = sampleRotaryModel(mesh, HEX_STOCK, BALL, {
    anglesDeg: angles, along: alongs, requestedCellSize: CELL, conservativeCellBounds: true,
  }, [])
  const maxRadius = barMaxRadius(HEX_STOCK)
  for (const point of points) {
    const i = alongs.indexOf(alongOf(point))
    const k = angles.indexOf(angleOf(point))
    assert.ok(i >= 0 && k >= 0, 'the point names a sample of the measured grid')
    const raw = sampling.tipRadius[k][i]
    assert.ok(Number.isFinite(raw), 'the sampler has a model there')
    const expected = Math.min(Math.max(raw, 0), maxRadius)
    assert.equal(point.z, barPivotZ(HEX_STOCK) + expected,
      `hex tip at along ${alongOf(point)} A ${angleOf(point)} is the sampler’s own value`)
  }
  const rings = cutRings(result.moves)
  const directions = rings.map(ringDirection)
  assert.ok(directions.includes(1) && directions.includes(-1), 'both ring directions are measured')
}

// ---------------------------------------------------------------------------
// 5. Steep step in A: no cut move rises further than its surface distance
//    unless it is purely vertical or flat, the arc term still suppresses a
//    split on a hex prism (slope < 1) and still forces one on a steep bump.
// ---------------------------------------------------------------------------

/** |dz| against the surface distance between two emitted points. */
function stepCheck(move: ToolpathMove, pivot: number): { rise: number; spacing: number } {
  const rise = Math.abs(move.to.z - move.from.z)
  const arc = Math.max(0, Math.min(move.from.z, move.to.z) - pivot)
    * Math.abs(angleOf(move.to) - angleOf(move.from)) * Math.PI / 180
  return { rise, spacing: Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y, arc) }
}

{
  const pivot = barPivotZ(HEX_STOCK)
  const mesh = prism(HEX_STOCK, HEX_SECTION, [10, 30])
  const result = generateRotaryFinish('hex-steps', mesh, HEX_STOCK, BALL, {
    stepover: 20, sampleSpacing: 1.5, stockToLeave: 0, alongStart: 10, alongEnd: 30,
    safeRadius: 30, requestedCellSize: CELL, passDirection: 'around',
  }, {})
  const cuts = result.moves.filter((move) => move.kind === 'cut')
  const vertical = cuts.filter((move) => Math.abs(move.to.z - move.from.z) > 1e-9
    && stepCheck(move, pivot).spacing <= 1e-9)
  assert.deepEqual(vertical, [], 'a hex prism (slope below 1 in the surface distance) needs no stepped move')
  for (const move of cuts) {
    const { rise, spacing } = stepCheck(move, pivot)
    assert.ok(rise <= spacing + 1e-9 || spacing <= 1e-9,
      `hex move at A ${angleOf(move.from)} raises ${rise} over a surface distance of ${spacing}`)
  }
}

{
  // A narrow radial bump is steeper than 1 in the surface distance, so the
  // emitter must split the rise into its vertical leg and its along-height leg.
  const sides = 512
  const bumpSection = Array.from({ length: sides }, (_, i): readonly [number, number] => {
    const t = 2 * Math.PI * i / sides
    let gap = Math.abs(t - Math.PI / 2)
    if (gap > Math.PI) gap = 2 * Math.PI - gap
    const radius = 6 + 5 * Math.exp(-(gap * gap) / (2 * 0.02 * 0.02))
    return [radius * Math.cos(t), radius * Math.sin(t)]
  })
  const mesh = prism(HEX_STOCK, bumpSection, [10, 30])
  const result = generateRotaryFinish('bump', mesh, HEX_STOCK, { ...BALL, radius: 0.25, diameter: 0.5 }, {
    stepover: 20, sampleSpacing: 1, stockToLeave: 0, alongStart: 10, alongEnd: 30,
    safeRadius: 30, requestedCellSize: CELL, passDirection: 'around',
  }, {})
  const cuts = result.moves.filter((move) => move.kind === 'cut')
  const pivot = barPivotZ(HEX_STOCK)
  let stepped = 0
  for (const move of cuts) {
    const { rise, spacing } = stepCheck(move, pivot)
    assert.ok(rise <= spacing + 1e-9 || spacing <= 1e-9,
      `bump move at A ${angleOf(move.from)} raises ${rise} over a surface distance of ${spacing}`)
    if (rise > 1e-9 && spacing <= 1e-9) stepped++
  }
  assert.ok(stepped > 0, 'the bump’s rise is split into a vertical move and an along-height move')
}

// ---------------------------------------------------------------------------
// 6. The field changes the output.
// ---------------------------------------------------------------------------

{
  const mesh = digestCone()
  const params = { ...DIGEST_FINISH, sampleSpacing: 1 }
  const along = generateRotaryFinish('change', mesh, DIGEST_STOCK, FLAT, params, {})
  const around = generateRotaryFinish('change', mesh, DIGEST_STOCK, FLAT, { ...params, passDirection: 'around' }, {})
  assert.ok(along.moves.length > 0 && around.moves.length > 0, 'both directions cut')
  assert.notDeepEqual(around.moves, along.moves, 'around and along produce different motion')
  assert.ok(around.moves.every((move) => angleOf(move.from) >= 0 && angleOf(move.to) <= 360),
    'the around motion stays within one turn')
}

// ---------------------------------------------------------------------------
// 7. Square blank: the slice-A refusal is gone (#1045 slice C supports it).
//    The square rules themselves -- per-sample touch radius, stub floor, the
//    finish refusal and the output guard -- live in
//    `rotarySquareAroundPasses.test.ts`.
// ---------------------------------------------------------------------------

{
  const mesh = prism(DIGEST_SQUARE, SQUARE_SECTION, [10, 30])
  const params = { ...RING_PARAMS, alongStart: 10, alongEnd: 30 }
  const finish = generateRotaryFinish('square-around', mesh, DIGEST_SQUARE, FLAT, {
    ...params, passDirection: 'around', squareRoughBefore: true,
  }, {})
  const rough = generateRotaryRough('square-around', mesh, DIGEST_SQUARE, FLAT, {
    ...params, stepdown: 3, passDirection: 'around',
  }, {})
  for (const [label, result] of [['finish', finish], ['rough', rough]] as const) {
    assert.ok(result.moves.length > 0, `${label} square around emits motion`)
    assert.deepEqual(result.warnings, [], `${label} square around has no warning`)
    assert.ok(result.bounds !== null, `${label} square around has bounds`)
  }
}

// ---------------------------------------------------------------------------
// 8. Posted program: an around finish exported through the real postprocessor.
// ---------------------------------------------------------------------------

{
  const fixture = rotaryOperationFixture('x', 'rotary_finish')
  const operation: Operation = { ...fixture.operations[0], rotaryPassDirection: 'around' }
  fixture.operations = [operation]
  const toolpath = generateRotaryOperation(fixture, operation)
  assert.ok(toolpath.moves.length > 0, 'the around operation generates motion through the adapter')
  assert.deepEqual(toolpath.warnings, [], 'the around operation has no warning')
  const raw = BUNDLED_DEFINITIONS.find((definition) => definition.id === 'grbl')
  assert.ok(raw, 'the bundled grbl definition exists')
  const definition = validateMachineDefinition({
    ...structuredClone(raw),
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  const tool = normalizeToolForProject(fixture.tools[0], fixture)
  const posted = runPostProcessor({
    project: fixture,
    definition,
    operations: [{ operation, tool, toolpath }],
    options: { emitToolChanges: false, emitCoolant: false, programName: 'Around' },
  })
  const lines = posted.gcode.split('\n').filter((line) => line.length > 0 && !/^[;(%]/.test(line))
  const turning = lines.findIndex((line) => /A-?\d/.test(line) && /F-?\d/.test(line))
  assert.ok(turning > 0, 'the program has a turning feed move')
  assert.equal(lines[turning - 1], 'G93', 'inverse-time feed is selected directly before the turning move')
  assert.ok(lines.slice(turning).some((line) => /A-?\d/.test(line)), 'the turning motion carries A words')
  const aWords = lines.flatMap((line) => [...line.matchAll(/A(-?\d+(?:\.\d+)?)/g)].map((match) => Number(match[1])))
  assert.ok(aWords.length > 0, 'the posted program carries A words')
  for (const a of aWords) assert.ok(a >= 0 && a <= 360, `posted A ${a} is inside [0, 360]`)
}

// ---------------------------------------------------------------------------
// 9. Layering: a rough steps down, it never cuts the model in the first layer.
//    The mutation this block exists for drops the `Math.max(tip, layerRadius)`
//    clamp in the around branch: every layer would then cut straight to the
//    model radius, a full-depth cut with a roughing tool. A 5 mm cylinder in a
//    20 mm bar with a 3 mm stepdown needs several layers, so the first layer
//    must cut at or above 17, the next at 14, 11, ... and the model radius is
//    not reached before the last layer.
//
//    Along mode's stepdown is already asserted by the cone-rough block in
//    `rotaryModel.test.ts` (both axes, ball and flat, `tip == max(target,
//    layerRadius)` at every layer), so the same walk is repeated here on this
//    fixture only to hold both directions to one explicit check.
// ---------------------------------------------------------------------------

const LAYER_DIAMETER = 40
const LAYER_BAR_RADIUS = LAYER_DIAMETER / 2
const LAYER_MODEL_RADIUS = 5
const LAYER_STEPDOWN = 3
// The bar is exactly the cut band (10..30), so `withRetainedBar` adds no end
// stub and the sampled tips are the cylinder's own radius along the whole pass.
const LAYER_STOCK = roundStock(LAYER_DIAMETER, 20, 'x', { x: 10, y: 0 })
const LAYER_MESH = revolved(LAYER_STOCK, [
  { along: 10, radius: LAYER_MODEL_RADIUS },
  { along: 30, radius: LAYER_MODEL_RADIUS },
], 64)
const LAYER_PARAMS = {
  stepover: 10, sampleSpacing: 2, stockToLeave: 0, alongStart: 10, alongEnd: 30,
  safeRadius: 30, requestedCellSize: CELL,
}

function samePoint(a: ToolpathPoint, b: ToolpathPoint): boolean {
  return a.x === b.x && a.y === b.y && a.z === b.z && a.a === b.a
}

/** Every cut endpoint once, in emission order. */
function orderedCutPoints(moves: readonly ToolpathMove[]): ToolpathPoint[] {
  const points: ToolpathPoint[] = []
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    const from = points[points.length - 1]
    if (!from || !samePoint(from, move.from)) points.push(move.from)
    const tail = points[points.length - 1]
    if (!samePoint(tail, move.to)) points.push(move.to)
  }
  return points
}

interface LayeredPoint {
  readonly layer: number
  readonly tip: number
}

/**
 * Around-mode cut points with their layer. A ring is one along coordinate and
 * the rings visit every along position in order once per layer, so the ring
 * index divided by the along count is the layer. Every ring must carry the same
 * number of samples, otherwise a ring that cut nothing would shift the layers
 * and this block would check the wrong thing.
 */
function aroundLayers(moves: readonly ToolpathMove[], pivot: number): LayeredPoint[] {
  const points = orderedCutPoints(moves)
  const alongCount = new Set(points.map(alongOf)).size
  assert.ok(alongCount > 0, 'the around rough cuts an along position')
  const rings: ToolpathPoint[][] = []
  let ring: ToolpathPoint[] = []
  let ringAlong: number | undefined
  for (const point of points) {
    const along = alongOf(point)
    if (ring.length > 0 && along !== ringAlong) {
      rings.push(ring)
      ring = []
    }
    ring.push(point)
    ringAlong = along
  }
  if (ring.length > 0) rings.push(ring)
  // A ring is one along position; the along coordinate climbs through a layer
  // and drops to the first position at the next one. The layer is therefore the
  // number of descents before the ring plus one -- never the ring index divided
  // by a count, because a ring that finds only air at its layer emits no cut
  // moves and is simply absent (#1045 slice F changed the sampled support, and
  // a descending layer can now be all air at the retained-stub edge). Sample
  // **counts** within a ring are not asserted either: the emitter merges a run
  // of collinear cut points, and a layer that lands on a flat model radius is
  // exactly collinear there, so its ring is legitimately shorter.
  let layer = 1
  for (let r = 1; r < rings.length; r++) {
    if (alongOf(rings[r][0]) <= alongOf(rings[r - 1][0])) layer++
  }
  assert.ok(layer > 1, 'the around rough cuts more than one layer')
  let ringLayer = 1
  const layered: LayeredPoint[] = []
  for (let r = 0; r < rings.length; r++) {
    if (r > 0 && alongOf(rings[r][0]) <= alongOf(rings[r - 1][0])) ringLayer++
    for (const point of rings[r]) layered.push({ layer: ringLayer, tip: point.z - pivot })
  }
  return layered
}

/**
 * Walk the cut points layer by layer and assert the stepdown rule: the first
 * layer cuts at or above `maxRadius - stepdown`, each later layer is at most one
 * stepdown below the deepest cut of the layers before it, and every unclamped
 * layer radius `maxRadius - k * stepdown` (k = 1..layers-1) appears among the
 * cut tip radii. `layers` is read from the emission, so a pass that skipped a
 * layer cannot hide behind a hard-coded count.
 */
function checkLayering(label: string, points: readonly LayeredPoint[]): void {
  assert.ok(points.length > 0, `${label}: the rough cuts something`)
  const layers = Math.max(...points.map((point) => point.layer))
  assert.ok(layers >= 3, `${label}: the rough needs several layers, got ${layers}`)
  let previousDeepest = LAYER_BAR_RADIUS
  for (let layer = 1; layer <= layers; layer++) {
    const tips = points.filter((point) => point.layer === layer).map((point) => point.tip)
    assert.ok(tips.length > 0, `${label}: layer ${layer} cuts something`)
    for (const tip of tips) {
      assert.ok(
        tip >= previousDeepest - LAYER_STEPDOWN - 1e-9,
        `${label}: layer ${layer} cuts at ${tip}, more than ${LAYER_STEPDOWN} below the deepest earlier cut ${previousDeepest}`,
      )
    }
    previousDeepest = Math.min(previousDeepest, ...tips)
  }
  // The revolved mesh is a 64-gon, so its sampled radius sits a few thousandths
  // under the nominal 5; the layers still have to reach it.
  approx(previousDeepest, LAYER_MODEL_RADIUS, `${label}: the layers reach the model's deepest cut`, 0.01)
  for (let k = 1; k < layers; k++) {
    const radius = LAYER_BAR_RADIUS - k * LAYER_STEPDOWN
    assert.ok(
      points.some((point) => Math.abs(point.tip - radius) <= 1e-9),
      `${label}: layer radius ${radius} appears among the cut tip radii`,
    )
  }
}

{
  const pivot = barPivotZ(LAYER_STOCK)
  const result = generateRotaryRough('layer-around', LAYER_MESH, LAYER_STOCK, FLAT, {
    ...LAYER_PARAMS, stepdown: LAYER_STEPDOWN, passDirection: 'around',
  }, {})
  assert.deepEqual(result.warnings, [], 'the around layering rough has no warning')
  const points = orderedCutPoints(result.moves)
  // 20 mm of cut span over a 10 mm stepover is three rings a layer.
  assert.equal(new Set(points.map(alongOf)).size, 3, 'the around grid cuts three along positions')
  checkLayering('around', aroundLayers(result.moves, pivot))
}

{
  const pivot = barPivotZ(LAYER_STOCK)
  const result = generateRotaryRough('layer-along', LAYER_MESH, LAYER_STOCK, FLAT, {
    ...LAYER_PARAMS, stepdown: LAYER_STEPDOWN,
  }, {})
  assert.deepEqual(result.warnings, [], 'the along layering rough has no warning')
  // Along mode marks the layers in A: each layer is one more full turn.
  checkLayering('along', orderedCutPoints(result.moves).map((point) => ({
    layer: Math.floor(angleOf(point) / 360) + 1,
    tip: point.z - pivot,
  })))
}

// ---------------------------------------------------------------------------
// 10. Retained round ends (#1045 slice D, finding 1).
//
//     Codex's repro: a Ø40 x 60 bar, cut band X18..42, Ø6 flat cutter, 2.7
//     stepover and 0.75 sample spacing. The around grid used to start on the
//     band edge, so the ring at X20.6667 had the cutter's rim 0.3333 mm inside
//     the retained X<18 end -- an overlap thinner than the height-map cell --
//     and still cut at tip 4.97 against the stub's 20 mm surface. The C2-F7
//     pull-in now starts and ends the grid one cutter radius inside each
//     stubbed face, in both modes. The assertion is the cutter body itself: no
//     cutting centre may sit closer to a stubbed face than its own radius.
// ---------------------------------------------------------------------------

console.log('Testing the retained round ends on around and along passes...')
{
  const stock = roundStock(40, 60, 'x', { x: 0, y: 0 })
  const pivot = barPivotZ(stock)
  const tool: NormalizedTool = { ...BALL, id: 'flat-6', name: '6 mm flat end mill', type: 'flat_endmill', radius: 3, diameter: 6 }
  const model = revolved(stock, [{ along: 18, radius: 5 }, { along: 42, radius: 5 }], 64)
  const params = {
    stepover: 2.7, sampleSpacing: 0.75, stockToLeave: 0, alongStart: 18, alongEnd: 42,
    safeRadius: 30, requestedCellSize: 1,
  }
  const travel = barMaxRadius(stock) + 1
  // Along mode at 0.75 happens to sample the stub before the rim reaches it, so
  // it did not gouge on the review's exact input; 2.9 does (the along position
  // lands at 20.6667, the same 0.3333 mm overlap). Both are checked so the
  // along half of the fix is not carried by the around half.
  const cases = [
    { label: 'around', passDirection: 'around' as const, sampleSpacing: 0.75 },
    { label: 'along', passDirection: undefined, sampleSpacing: 0.75 },
    { label: 'along at 2.9', passDirection: undefined, sampleSpacing: 2.9 },
  ]
  for (const { label, passDirection, sampleSpacing } of cases) {
    const result = passDirection
      ? generateRotaryFinish('round-stub', model, stock, tool, { ...params, sampleSpacing, passDirection }, {})
      : generateRotaryFinish('round-stub', model, stock, tool, { ...params, sampleSpacing }, {})
    assert.deepEqual(result.warnings, [], `${label}: the stubbed finish has no warning`)
    let first = Infinity
    let last = -Infinity
    let cutting = 0
    for (const move of result.moves) {
      if (move.kind !== 'cut') continue
      for (const point of [move.from, move.to]) {
        // A link at the travel height is in air; only a surface cut carries the
        // cutter body into the band's ends.
        if (point.z - pivot >= travel - 1e-9) continue
        const along = alongOf(point)
        assert.ok(along - tool.radius >= params.alongStart - 1e-9,
          `${label}: the cutter body at along ${along.toFixed(4)} (rim ${(along - tool.radius).toFixed(4)}) enters the retained lower end at ${params.alongStart}`)
        assert.ok(along + tool.radius <= params.alongEnd + 1e-9,
          `${label}: the cutter body at along ${along.toFixed(4)} (rim ${(along + tool.radius).toFixed(4)}) enters the retained upper end at ${params.alongEnd}`)
        first = Math.min(first, along)
        last = Math.max(last, along)
        cutting++
      }
    }
    assert.ok(cutting > 0, `${label}: the stubbed finish cuts`)
    // The grid still covers the band up to the tangency, so the pull is the
    // only change: both ends sit exactly one cutter radius inside.
    approx(first, params.alongStart + tool.radius, `${label}: the first centre is one radius inside the lower stub`, 1e-9)
    approx(last, params.alongEnd - tool.radius, `${label}: the last centre is one radius inside the upper stub`, 1e-9)
    console.log(`  ${label}: first centre ${first.toFixed(4)}, last centre ${last.toFixed(4)}, ${cutting} cut endpoints`)
  }
}

// ---------------------------------------------------------------------------
// 11. Missing model under the tool (#1045 slice D, finding 3).
//
//     Part of the band has no model under the tool. The finish does not cut
//     there, but the rough must remove the blank down to the axis fallback --
//     the same thing the along rough does -- or a mutation that leaves the
//     stock in place would look safe. The band is inside the bar, so its ends
//     are retained; the pull-in keeps the check away from the stub floor.
// ---------------------------------------------------------------------------

console.log('Testing the around rough on a band with no model under the tool...')
{
  const stock = roundStock(40, 40, 'x', { x: 0, y: 0 })
  const pivot = barPivotZ(stock)
  const model = revolved(stock, [{ along: 12, radius: 5 }, { along: 28, radius: 5 }], 64)
  const params = {
    stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 5, alongEnd: 35,
    safeRadius: 30, requestedCellSize: 0.1, stepdown: 2,
  }
  for (const direction of ['around', 'along'] as const) {
    const result = direction === 'around'
      ? generateRotaryRough('nan-fallback', model, stock, FLAT, { ...params, passDirection: 'around' }, {})
      : generateRotaryRough('nan-fallback', model, stock, FLAT, params, {})
    assert.deepEqual(result.warnings, [], `${direction}: the missing-model rough has no warning`)
    const cuts = result.moves.filter((move) => move.kind === 'cut').flatMap((move) => [move.from, move.to])
    // The lower empty band starts one cutter radius inside the retained stub
    // (7 mm) and ends at the model's own start (12 mm).
    const empty = cuts.filter((point) => alongOf(point) > 7 + 1e-9 && alongOf(point) < 12 - 1e-9)
    assert.ok(empty.length > 0, `${direction}: the empty band is cut`)
    const lowest = Math.min(...empty.map((point) => point.z - pivot))
    assert.ok(lowest <= 1e-6,
      `${direction}: the rough removes the blank to the axis fallback in the empty band (lowest ${lowest.toFixed(4)})`)
    // It still follows the model where the model exists: the cylinder is 5 mm,
    // so nothing in the solid band is cut below it.
    for (const point of cuts) {
      const along = alongOf(point)
      if (along < 12 - 1e-9 || along > 28 + 1e-9) continue
      assert.ok(point.z - pivot >= 5 - 0.11,
        `${direction}: the modelled band is not cut below its 5 mm radius (tip ${(point.z - pivot).toFixed(4)})`)
    }
    console.log(`  ${direction}: ${empty.length} cut endpoints in the empty band, lowest tip ${lowest.toFixed(4)}`)
  }
}

// ---------------------------------------------------------------------------
// 12. The emitted sweep, not its ideal endpoints (#1045 slice D finding 2,
//     corrected by #1045 slice E).
//
//     An around move interpolates the tip radius linearly between two angle
//     samples. On the radius-8 hex prism with the 1.5 mm ball and 1.5 mm
//     spacing, the cap's A209.362 -> A211.915 move reached 7.9247 at its
//     midpoint while the independent cutter contact required 7.9643. Slice D
//     capped the angle step by `barMaxRadius * dTheta^2 / 8 <= 0.005 mm`, but
//     that is the circular sagitta, not the ball-cutter contact envelope: the
//     review measured the **emitted** Z values (the sampler's, not the ideal
//     supports) at 0.02363 mm of gouge on that move, while the endpoint-only
//     measure said 0.01402 mm and the test permitted 0.02 mm.
//
//     The check below therefore walks the emitted motion. For each cut move it
//     samples the independent drop-cutter support of the extruded hex -- the
//     highest material a cutter can touch at one bar rotation, on the section's
//     own edges, never the sampler -- at nine interior points and compares it
//     with the emitted chord. The allowance is `tol` alone:
//     `tol` = max(0.005 mm, s^2 / (8 r)) for the segment's own surface spacing
//     `s` and ball radius `r`, the between-sample error the along path accepts
//     at the same spacing. No measured under-cut is added back: #1045 slice F
//     makes the around sampler read each height-map cell as an upper bound over
//     its square and the support from the cell's nearest point, so the emitted
//     sample stands at or above the model (the block asserts that too) and the
//     only remaining error is the interpolation between samples. A cell-centre
//     map under-read the hex's vertex by 0.0127 mm, which is what the measured
//     endpoint allowance used to hide.
// ---------------------------------------------------------------------------

console.log('Testing the emitted around sweep on the hex prism...')
{
  const section = HEX_SECTION
  const samplesPerEdge = 4000
  const supportCache = new Map<number, number>()
  /** Highest material a `tool` can touch at bar rotation `angleDeg`, from the section alone. */
  const sectionSupport = (angleDeg: number, tool: NormalizedTool): number => {
    const cached = supportCache.get(angleDeg)
    if (cached !== undefined) return cached
    const radians = angleDeg * Math.PI / 180
    const cos = Math.cos(radians)
    const sin = Math.sin(radians)
    let best = Number.NEGATIVE_INFINITY
    for (let e = 0; e < section.length; e++) {
      const [au, av] = section[e]
      const [bu, bv] = section[(e + 1) % section.length]
      for (let s = 0; s < samplesPerEdge; s++) {
        const f = s / samplesPerEdge
        const across = au + (bu - au) * f
        const up = av + (bv - av) * f
        // The bar's rotation maps the model point to (turned across, turned up)
        // = (across cos - up sin, across sin + up cos); the cutter sits over the
        // centreline, so `t` is its horizontal distance from the tool axis.
        const t = across * cos - up * sin
        const h = across * sin + up * cos
        if (Math.abs(t) > tool.radius) continue
        const candidate = tool.type === 'ball_endmill'
          ? h - tool.radius + Math.sqrt(Math.max(0, tool.radius * tool.radius - t * t))
          : h
        if (candidate > best) best = candidate
      }
    }
    supportCache.set(angleDeg, best)
    return best
  }

  const mesh = prism(HEX_STOCK, section, [10, 30])
  const reference = generateRotaryFinish('hex-cap', mesh, HEX_STOCK, BALL, {
    stepover: 20, sampleSpacing: 1.5, stockToLeave: 0, alongStart: 10, alongEnd: 30,
    safeRadius: 30, requestedCellSize: CELL, passDirection: 'around',
  }, {})
  assert.deepEqual(reference.warnings, [], 'the capped hex finish has no warning')

  // The emitted angular step starts at the cap's sagitta bound (the slice-D
  // guarantee), and the adaptive subdivision has made at least one segment
  // finer than that for the ball's contact envelope.
  const angles = [...new Set(reference.moves.flatMap((move) => [angleOf(move.from), angleOf(move.to)]))].sort((a, b) => a - b)
  let step = Infinity
  for (let i = 1; i < angles.length; i++) step = Math.min(step, angles[i] - angles[i - 1])
  const capError = barMaxRadius(HEX_STOCK) * (step * Math.PI / 180) ** 2 / 8
  assert.ok(step < 360 / 84,
    `the angle step ${step.toFixed(4)} deg is finer than the uncapped 4.2857 deg`)
  assert.ok(capError <= 0.005 * (1 + 1e-9),
    `the cap keeps barRadius * dTheta^2 / 8 = ${capError.toFixed(6)} mm at or below the stated 0.005 mm`)
  const travel = barMaxRadius(HEX_STOCK) + 1
  const pivot = barPivotZ(HEX_STOCK)
  const toleranceFloor = 0.005
  let worst = { error: Number.NEGATIVE_INFINITY, allowance: 0, angle: 0 }
  let undercut = Number.NEGATIVE_INFINITY
  let checked = 0
  for (const move of reference.moves) {
    if (move.kind !== 'cut') continue
    // A link at the travel height is in air; the sweep error there is not a
    // surface gouge and its endpoints are not surface samples.
    const z0 = move.from.z - pivot
    const z1 = move.to.z - pivot
    if (z0 >= travel - 1e-9 || z1 >= travel - 1e-9) continue
    const a0 = angleOf(move.from)
    const a1 = angleOf(move.to)
    const ideal0 = sectionSupport(a0, BALL)
    const ideal1 = sectionSupport(a1, BALL)
    // The emitted sample must not stand **below** the model: the around sampler
    // reads a cell as an upper bound over its square (#1045 slice F), so the
    // ideal endpoint support is at or under the emitted tip. This is the check
    // that the "measured endpoint undercut" allowance used to hide.
    undercut = Math.max(undercut, ideal0 - z0, ideal1 - z1)
    // `tol` from the segment's own surface spacing at the smaller emitted tip.
    const surfaceArc = Math.max(0, Math.min(z0, z1)) * Math.abs(a1 - a0) * Math.PI / 180
    const tolerance = Math.max(toleranceFloor, surfaceArc * surfaceArc / (8 * BALL.radius))
    for (let s = 1; s <= 8; s++) {
      const f = s / 9
      const angle = a0 + (a1 - a0) * f
      const emitted = z0 + (z1 - z0) * f
      const error = sectionSupport(angle, BALL) - emitted
      if (error > worst.error) worst = { error, allowance: tolerance, angle }
      assert.ok(error <= tolerance + 1e-9,
        `emitted gouge ${error.toFixed(5)} mm at A ${angle.toFixed(3)} stays within tol ${tolerance.toFixed(5)}`)
      checked++
    }
  }
  assert.ok(undercut <= 1e-6,
    `every emitted sample is at or above the model (worst endpoint under-read ${undercut.toFixed(6)} mm)`)
  assert.ok(checked > 2000, `the emitted sweep check walked ${checked} interior points`)
  // And the subdivision is what made it hold: at least one emitted step is
  // finer than the unrefined starting step, while the sagitta cap still bounds
  // the step as a whole.
  assert.ok(step < 2.5532 / 2,
    `the adaptive subdivision refined a segment below the ${(2.5532).toFixed(4)} deg starting step (it is ${step.toFixed(4)})`)
  console.log(`  hex step ${step.toFixed(4)} deg, worst emitted gouge ${worst.error.toFixed(5)} mm at A ${worst.angle.toFixed(3)} within ${worst.allowance.toFixed(5)} mm (${checked} points)`)
}

// ---------------------------------------------------------------------------
// 12b. The cap converts into the operation's units (#1045 slice D).
//
//      The stated 0.005 mm is a physical surface error, so an inch operation's
//      cap is that many inches (0.005 / 25.4). The emitted step is checked in
//      the bar's own units, which is what an inch project's `sampleSpacing` and
//      `barMaxRadius` are in.
// ---------------------------------------------------------------------------

console.log('Testing the angle cap in inch units...')
{
  const stock = roundStock(1.5, 4, 'x', { x: 0, y: 0 })
  const barRadius = barMaxRadius(stock)
  const mesh = revolved(stock, [{ along: 0, radius: 0.5 }, { along: 4, radius: 0.5 }], 64)
  const tool: NormalizedTool = {
    ...BALL, id: 'inch-ball', name: '0.12 in ball', sourceUnits: 'inch', units: 'inch', radius: 0.06, diameter: 0.12,
  }
  const result = generateRotaryFinish('inch-cap', mesh, stock, tool, {
    stepover: 1, sampleSpacing: 0.06, stockToLeave: 0, alongStart: 0, alongEnd: 4,
    safeRadius: 2, requestedCellSize: 0.005, passDirection: 'around',
  }, {})
  assert.deepEqual(result.warnings, [], 'the inch around finish has no warning')
  const angles = [...new Set(result.moves.flatMap((move) => [angleOf(move.from), angleOf(move.to)]))].sort((a, b) => a - b)
  let step = Infinity
  for (let i = 1; i < angles.length; i++) step = Math.min(step, angles[i] - angles[i - 1])
  const arc = barRadius * step * Math.PI / 180
  const cap = Math.sqrt(8 * barRadius * (0.005 / 25.4))
  assert.ok(arc <= cap * (1 + 1e-9),
    `the inch angle step ${arc.toFixed(5)} in of arc is at or below the converted cap ${cap.toFixed(5)} in`)
  console.log(`  inch step ${step.toFixed(4)} deg = ${arc.toFixed(5)} in of arc, cap ${cap.toFixed(5)} in`)
}

console.log('rotary around passes tests passed')
