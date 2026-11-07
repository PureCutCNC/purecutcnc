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
 * The along pass keeps its original **rough** motion byte-identical: the first
 * block asserts that a missing `passDirection` and an explicit `'along'` produce
 * the same result, and that both match a digest recorded from the base commit
 * (`e3175dd6`) with a scratch script before the change. The digests are of
 * `JSON.stringify(result)` for the three fixtures exactly as built here -- the
 * cone and the stepped cylinder on a round bar, and the square blank. The along
 * **finish** digests moved with #1045 slice R (self-clearing) and again with
 * slice R2 (clearing from the raw blank only, and a required depth), then were
 * restored to the base values when the 2026-10-22 decision removed that
 * clearing; the rough
 * digests still pin the base commit.
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
 * #1103 slice ca-a adds block 3b: a chiral, tapered bar whose section scales and
 * turns with the along position. Its independent reference computes the lowest
 * safe tip of the solid cutter body inside its axial footprint at one pose, from
 * the analytic section and never from the sampler, and it seeds both stock axes,
 * mm and inch, ball and flat cutters and retained ends. Diagonal moves are
 * sampled at the emitted fraction with `along(f)` and `angle(f)` interpolated
 * together. Four mutations are proved caught on every seed: an axial sign error,
 * an A sign error, a tip-only reference that ignores the body's off-axis reach,
 * and an interior dip whose endpoints are safe.
 *
 * Block 13 pins the wrapped 2D engrave path (moves and posted program), which is
 * not a rotary generator output and must stay byte-identical.
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
 * #1117 adds block 2d: a round rough's adjacent rings are joined by a cutting
 * feed at the current layer -- at `max(layerRadius, model)`, so the clamp and a
 * model rise are both exercised -- instead of the raised rapid #1093 emitted.
 * The region, model-gap and alternate-angle transitions deliberately keep the
 * raised link, and the block pins that too. Mutations: the raised-only path
 * restored, the layer clamp removed, the dense link row replaced by the ring
 * positions, and the model-gap refusal removed.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryAroundPasses.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { defaultTool, newProject, rectProfile, roundStock } from '../../types/project'
import type { BarStock, Operation, Project, RoundStock, SketchFeature, Tool } from '../../types/project'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { BUNDLED_DEFINITIONS } from '../gcode/definitions'
import { runPostProcessor } from '../gcode/postprocessor'
import { validateMachineDefinition } from '../gcode/types'
import { projectWithFeatures } from '../../test/projectFixtures'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import {
  CHIRAL_ALLOWANCE_MM,
  CHIRAL_BAR_RADIUS,
  CHIRAL_FROM,
  CHIRAL_SEEDS,
  CHIRAL_TO,
  CHIRAL_VERTICES,
  chiralMesh,
  chiralSupport,
  diagonalGouge,
} from '../../test/rotaryChiralReference'
import type { ChiralModel, DiagonalPath } from '../../test/rotaryChiralReference'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { computeOperationToolpath } from './generateOperation'
import { normalizeToolForProject } from './geometry'
import { generateRotaryFinish, generateRotaryRough, sampleRotaryModel } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import { buildRegionMask } from './regions'
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

/** A SHA-256 of a generated result, recorded so a motion change fails loudly. */
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

const alongOf = (point: { x: number; y: number }): number => point.x
const angleOf = (point: ToolpathPoint): number => {
  assert.ok(point.a !== undefined, 'every rotary point carries A')
  return point.a
}
/**
 * A ring-to-ring link (#1093): a feed at one angle that changes the along
 * coordinate. A ring's own cut always shares its along position and turns A, so
 * this is the one shape that distinguishes the new link from a ring chord.
 */
const isAlongLink = (move: ToolpathMove): boolean => move.kind === 'cut'
  && move.from.a !== undefined && move.to.a !== undefined
  && move.from.a === move.to.a
  && (move.from.x !== move.to.x || move.from.y !== move.to.y)
/**
 * The rough's in-air link leg (#1093): a rapid at one angle and one height that
 * changes the along coordinate. It is above the material the operation's own
 * earlier layers can leave, by the clearance, so it is a rapid rather than a
 * feed -- the machine must not creep through that air.
 */
const isAirLink = (move: ToolpathMove): boolean => move.kind === 'rapid'
  && move.from.a !== undefined && move.to.a !== undefined
  && move.from.a === move.to.a
  && move.from.z === move.to.z
  // Forward along the bar, in ring order. A layer boundary's travel-height
  // traverse runs back to the first along position and is not a link.
  && (move.to.x > move.from.x || move.to.y > move.from.y)

// ---------------------------------------------------------------------------
// 1. Byte-identical along mode (rough; re-captured finish).
//
// All six digests were recorded from the base commit's generators with a
// scratch script, on the fixtures below and the parameters named in each row,
// and are restored to those values: a finish now emits only its
// model-following passes again (2026-10-22 decision), so its along output is
// the base output. The fixtures' bands meet the bar's own ends, so #1045 slice
// D's retained-end pull-in changes none of them. A missing `passDirection` and
// `'along'` must both reproduce each row. Re-captured for #1098: the three
// **rough** rows move because along layers alternate the direction of their
// angle sequence (A no longer gains a turn per layer); the finish rows did not
// move.
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
    recorded: 'b301f903eb96f9ac81d7448f1b982a358e7302977a86e0c3ac4c530655eccc94',
  },
  {
    label: 'stepped finish', operationId: 'step', kind: 'finish', mesh: digestStepped,
    stock: DIGEST_STOCK, params: DIGEST_FINISH,
    recorded: 'dbb5052518b3066acf31a02cafa8f9a3d816a85400362c52bc38a01fa48a8d2f',
  },
  {
    label: 'stepped rough', operationId: 'step', kind: 'rough', mesh: digestStepped,
    stock: DIGEST_STOCK, params: DIGEST_ROUGH,
    recorded: 'c8527f5f34b7b5a4ada4e296f745fea49f8ec2a68ab4da7370f81edaa16b3370',
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
    recorded: '815adf6645f21eddd8521095772df8c56563a39a4b45394129110f03560feba5',
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
// 2. Continuous A (#1103 slice ca-c): an uninterrupted band is one helix, and
//    where a band cannot be helixed its rings keep turning the same way.
//    Commanded A grows one turn per ring (never rewound, never wrapped).
// ---------------------------------------------------------------------------

interface Ring {
  readonly along: number
  readonly angles: number[]
}

/** Cut moves grouped into rings by their along coordinate, in emission order. */
function cutRings(moves: readonly ToolpathMove[]): Ring[] {
  const rings: Ring[] = []
  for (const move of moves) {
    // A ring's turning cuts are the ones that change A. A constant-angle cut is
    // either a ring's own vertical step leg or a #1093 link leg; neither is a
    // ring sample, and an intermediate link leg would otherwise look like a
    // ring at an along position no ring visits.
    if (move.kind !== 'cut' || move.from.a === move.to.a) continue
    // An A-changing cut that also moves along the bar is a transition, not a
    // ring sample: a #1117 drift link, or #1103 slice ca-d's gate-gap link and
    // the helix. Rings turn A at one along position.
    if (alongOf(move.from) !== alongOf(move.to)) continue
    const along = alongOf(move.from)
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
 * One Around-sheet rectangle as a region feature, the shape the production mask
 * is built from (#1096). `mode` omitted is an include.
 */
function sheetRegion(
  stock: BarStock,
  id: string,
  alongMin: number,
  alongMax: number,
  mode?: 'include' | 'exclude',
): SketchFeature {
  const circumference = Math.PI * stock.thickness
  const centre = barCentre(stock)
  return {
    id,
    name: id,
    kind: 'rect',
    operation: 'region',
    authoringFace: 'around',
    folderId: null,
    sketch: {
      profile: rectProfile(alongMin, centre - circumference / 2, alongMax - alongMin, circumference),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    z_top: stock.thickness,
    z_bottom: 0,
    visible: true,
    locked: false,
    ...(mode === undefined ? {} : { regionMaskMode: mode }),
  }
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
  // `RING_MESH` is a surface of revolution under every angle, so the whole band
  // is one uninterrupted helix: A never reverses, and the two complete
  // boundary rings are the only turning cuts that keep their along coordinate.
  const result = generateRotaryFinish('rings', RING_MESH, RING_STOCK, FLAT, { ...RING_PARAMS, passDirection: 'around' }, {})
  assert.deepEqual(result.warnings, [], 'the around finish has no warning')
  const turning: ToolpathMove[] = []
  let reversals = 0
  let lastSign = 0
  for (const move of result.moves) {
    for (const point of [move.from, move.to]) {
      assert.ok(angleOf(point) >= 0, `commanded A never goes negative (${angleOf(point)})`)
      assert.ok(point.z >= barPivotZ(RING_STOCK) - 1e-9, 'no point cuts below the pivot')
    }
    if (move.kind !== 'cut') continue
    const delta = angleOf(move.to) - angleOf(move.from)
    if (Math.abs(delta) < 1e-12) continue
    turning.push(move)
    const sign = Math.sign(delta)
    if (lastSign !== 0 && sign !== lastSign) reversals++
    lastSign = sign
  }
  assert.equal(reversals, 0, 'A never reverses: every turning cut advances A')
  assert.equal(lastSign, 1, 'the band turns A forward throughout')
  // 20 mm at a 2 mm stepover is ten revolutions of advance; the helix closes
  // both ends with a complete ring, so A spans twelve turns and is not wrapped.
  // This is the whole point of the slice: the base output ended at A360 after
  // reversing 10 times, this one ends at A4320 turning one way.
  const maxA = Math.max(...result.moves.map((move) => angleOf(move.to)))
  approx(maxA, 360 * 12, 'the helix spans one turn per revolution plus its two end rings')
  assert.equal(result.moves.filter((move) => move.kind === 'rapid').length, 2,
    'a continuous band retracts only for the opening positioning move and the final retract')
  assert.equal(result.moves.filter((move) => move.kind === 'plunge').length, 1,
    'and plunges once, at its first cut')
  // A turning cut at a fixed along coordinate is one of the two complete
  // boundary rings; everything between them advances along as it turns.
  const boundaries = [...new Set(turning
    .filter((move) => alongOf(move.from) === alongOf(move.to))
    .map((move) => alongOf(move.from)))].sort((a, b) => a - b)
  assert.deepEqual(boundaries, [RING_PARAMS.alongStart, RING_PARAMS.alongEnd],
    'the helix opens and closes with a complete ring at each axial end')
  // The angular grid is the same slice-D cap the rings used (the helix measures
  // 12 turns, so the check counts one turn's samples between the A0/A360 ends).
  const angularIntervals = aroundAngleIntervals(20, RING_PARAMS.sampleSpacing)
  const firstRing = turning.filter((move) => alongOf(move.from) === RING_PARAMS.alongStart)
  assert.ok(firstRing.length <= angularIntervals,
    `a boundary ring sweeps no more than the capped angle count (${firstRing.length} <= ${angularIntervals})`)
  assert.ok(firstRing.length >= 1, 'and it still turns')
}

{
  // #1103 slice ca-j: a square blank is helixed once its band is a whole ring of
  // the model at every angle -- which this surface-of-revolution model is -- so
  // its only turning cuts at a fixed along are the helix's two complete boundary
  // rings, one cutter radius inside each end. A turns forward throughout, exactly
  // as the ring fallback does; the ring shape itself is proved on the taper below.
  const SQUARE_RING_STOCK = squareStock(40, 20, 'x', { x: 10, y: 7 })
  const result = generateRotaryFinish('rings-square', RING_MESH, SQUARE_RING_STOCK, FLAT, {
    ...RING_PARAMS, passDirection: 'around',
  }, {})
  assert.deepEqual(result.warnings, [], 'the square around finish has no warning')
  for (const move of result.moves) {
    for (const point of [move.from, move.to]) {
      assert.ok(point.z >= barPivotZ(SQUARE_RING_STOCK) - 1e-9, 'no point cuts below the pivot')
    }
  }
  const rings = cutRings(result.moves)
  // This fixture's cut range meets both stock ends, so there is no stub to pull
  // the band off: the boundary rings sit on the raw ends.
  assert.deepEqual(rings.map((ring) => ring.along), [RING_PARAMS.alongStart, RING_PARAMS.alongEnd],
    'the helix opens and closes with one complete ring at each axial end')
  // The helix between them advances one turn per `stepover`: `turns` of them,
  // so the end ring opens at A(turns + 1) and closes at A(turns + 2).
  const turns = Math.ceil((RING_PARAMS.alongEnd - RING_PARAMS.alongStart) / RING_PARAMS.stepover)
  for (let i = 0; i < rings.length; i++) {
    const turn = i === 0 ? 0 : turns + 1
    assert.equal(ringDirection(rings[i]), 1, `boundary ring ${i} turns forward, never back`)
    assert.equal(rings[i].angles[0], 360 * turn, `boundary ring ${i} opens at its own turn`)
    assert.equal(rings[i].angles[rings[i].angles.length - 1], 360 * (turn + 1), `boundary ring ${i} closes its own turn`)
  }
  // The band between the rings is one helix: a cut that advances along and turns.
  const helical = result.moves.filter((move) => move.kind === 'cut'
    && alongOf(move.from) !== alongOf(move.to) && angleOf(move.from) !== angleOf(move.to))
  assert.ok(helical.length > 0, `the square band is helixed (${helical.length} helix cuts)`)
}

{
  // The rough keeps the same ring shape at every layer: layers are not rings,
  // the along positions are. Since #1103 slice ca-d A never reverses -- every
  // ring turns forward, the cursor grows one turn per ring across layers -- and
  // the taper stays inside one stepdown, so every ring cuts at every layer and
  // the emitted rings are exactly the visited ones.
  const taper = revolved(RING_STOCK, Array.from({ length: 65 }, (_, s) => ({
    along: 10 + 20 * s / 64,
    radius: 4 + 0.5 * s / 64,
  })), 64)
  const result = generateRotaryRough('rings-rough', taper, RING_STOCK, FLAT, {
    ...RING_PARAMS, stepdown: 3, passDirection: 'around',
  }, {})
  assert.deepEqual(result.warnings, [], 'the around rough has no warning')
  // #1103 slice ca-d: commanded A is one-way and never wrapped. It grows past
  // one turn per ring, and more than one turn per layer.
  let previousA = 0
  let maxA = 0
  for (const move of result.moves) {
    for (const point of [move.from, move.to]) {
      const a = angleOf(point)
      assert.ok(a >= previousA - 1e-9, `rough A never rewinds (${previousA} -> ${a})`)
      previousA = a
      maxA = Math.max(maxA, a)
    }
  }
  assert.ok(maxA > 360, `the rough turns through more than one revolution (A${maxA.toFixed(1)})`)
  const rings = cutRings(result.moves)
  assert.ok(rings.length > 11, 'the rough cuts more than one layer of rings')
  for (let i = 1; i < rings.length; i++) {
    const current = ringDirection(rings[i])
    assert.notEqual(current, 0, `rough ring ${i} turns`)
    assert.equal(current, 1, `rough ring ${i} turns A forward like its predecessor`)
  }
  // #1103 slice ca-d: a full-ring layer is one continuous helix, whose merged
  // segments are transitions rather than ring samples, so the `rings` walk only
  // sees the layers that keep separate rings. Their along positions still climb
  // within a layer and restart at the band's start on the next one.
  for (let i = 1; i < rings.length; i++) {
    const along = rings[i].along
    const previous = rings[i - 1].along
    assert.ok(along >= previous - 1e-9 || along < previous,
      `rough ring ${i} keeps a ring's along position (${previous} -> ${along})`)
  }
}

// ---------------------------------------------------------------------------
// 2b. A round around finish follows the model only (2026-10-22 decision).
//
//     The same Codex pass-9 geometry: Ø20 round stock, a Ø10 model turned down
//     to radius 5, a Ø4 flat cutter. A raw bar stands 5 mm above the finish
//     surface. The finish no longer clears it in stepdown layers: its highest
//     tip is the finish surface itself and there is one ring per along position.
//     The rejected behaviour this block guards against is the old self-clearing
//     layers at 9, 8, 7, 6.
// ---------------------------------------------------------------------------

{
  const stock = roundStock(20, 20, 'x', { x: 0, y: 0 })
  const model = revolved(stock, [{ along: 0, radius: 5 }, { along: 20, radius: 5 }], 64)
  const params = {
    stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 0, alongEnd: 20,
    safeRadius: 30, requestedCellSize: 0.5, passDirection: 'around' as const,
  }
  const result = generateRotaryFinish('round-model-only', model, stock, FLAT, params, {})
  assert.deepEqual(result.warnings, [], 'the model-only round finish has no warning')
  const pivot = barPivotZ(stock)
  const tips = result.moves
    .filter((move) => move.kind === 'cut')
    .flatMap((move) => [move.from, move.to])
    .map((point) => point.z - pivot)
  const highest = Math.max(...tips)
  // The sampler's conservative cell read may lift a sample by up to the
  // requested cell (0.5 mm); nothing places a cut above that, and in particular
  // there is no clearing layer near the 10 mm bar radius.
  assert.ok(highest <= 5 + params.requestedCellSize + 0.05,
    `the finish starts at the model, not the raw bar (highest ${highest.toFixed(3)})`)
  assert.ok(highest > 1, 'and it does cut a real depth of the standing bar')
  // #1103 slice ca-c: a surface of revolution is one eligible band, so the
  // passes are one continuous helix. A one-way turn that advances along on
  // every revolution is what proves there is no second clearing pass at any
  // along position (and no stop between rings).
  const turning = result.moves.filter((move) => move.kind === 'cut' && angleOf(move.from) !== angleOf(move.to))
  assert.ok(turning.length > 0, 'the finish turns A')
  const alongAt = turning.map((move) => alongOf(move.from))
  assert.ok(Math.min(...alongAt) < 2 && Math.max(...alongAt) > 18, 'the helix covers the whole band')
  for (let i = 1; i < turning.length; i++) {
    assert.ok(angleOf(turning[i].to) > angleOf(turning[i].from), 'every revolution advances A forward')
  }
}

// ---------------------------------------------------------------------------
// 2c. #1093 links hold where their exact constant-A precondition still does.
//
//     A full ring ends at A(360k) and the next forward ring starts at
//     A(360(k+1)) -- the same commanded angle -- so the surface link still
//     joins them, exactly as it joined the alternating rings at A0/A360 before
//     #1103 slice ca-c. An uninterrupted band is one helix, on a round bar and
//     (since ca-j) on a square blank too, so a full ring is the **fallback**
//     the ring path still emits where a helix is refused. This fixture refuses
//     it with a narrow excluded along-gap placed *between* two ring positions:
//     the helix's combined poses sample the gap, every ring stays whole, and
//     the rings run and link. The gap's own boundary link is refused by the
//     mask's segment test (that rule is `rotaryRegion.test.ts`'s); every other
//     boundary links. The rejection this block guards is the old motion: one
//     retract and one plunge per ring. A finish assumes no rough, so the link
//     must stay on the model surface at the shared ring-end angle -- far below
//     the travel height.
// ---------------------------------------------------------------------------

{
  const SQUARE_RING_STOCK = squareStock(40, 20, 'x', { x: 10, y: 7 })
  const circumference = Math.PI * SQUARE_RING_STOCK.thickness
  // Between the ring positions X10 and X12, so no ring is trimmed.
  const region = buildRegionMask([
    sheetRegion(SQUARE_RING_STOCK, 'sheet', 0, 40, 'include'),
    sheetRegion(SQUARE_RING_STOCK, 'gap', 10.8, 11.2, 'exclude'),
  ], { axis: SQUARE_RING_STOCK.axis === 'x' ? 'y' : 'x', period: circumference })
  assert.ok(region, 'the ring-fallback mask builds')
  const result = generateRotaryFinish('links', RING_MESH, SQUARE_RING_STOCK, FLAT, {
    ...RING_PARAMS, passDirection: 'around', region,
  }, {})
  assert.deepEqual(result.warnings, [], 'the linked finish has no warning')
  const rapid = result.moves.filter((move) => move.kind === 'rapid')
  const plunges = result.moves.filter((move) => move.kind === 'plunge')
  // One plunge at the start, plus the one the refused boundary link needs.
  assert.ok(plunges.length <= 2, `the ring fallback plunges only at its first cut and the refused link (${plunges.length})`)
  assert.ok(rapid.length <= 4, `and retracts only for the opening move, the refused link and the final retract (${rapid.length})`)
  const links = result.moves.filter(isAlongLink)
  // One feed link between each of the eleven rings; a steep shoulder splits a
  // link into its horizontal legs, so a boundary can contribute more than one,
  // and the boundary over the excluded gap is the one link the mask refuses.
  assert.ok(links.length >= 8 && links.length <= 24,
    `the ring boundaries around the refused one are linked by feed moves (got ${links.length})`)
  const pivot = barPivotZ(SQUARE_RING_STOCK)
  for (const link of links) {
    assert.ok(angleOf(link.from) === angleOf(link.to), 'the link keeps the rings\' shared angle')
    assert.ok(link.to.x > link.from.x, 'the link runs along the bar in ring order')
    for (const point of [link.from, link.to]) {
      const tip = point.z - pivot
      // The model on this fixture is radius 4 then 7; the sampler's
      // conservative cell bound can lift a sample by at most the 0.05 cell.
      assert.ok(tip <= 7 + RING_PARAMS.requestedCellSize + 1e-9,
        `a finish link stays on the model (tip ${tip.toFixed(4)}), not at the 21 mm bar envelope`)
      assert.ok(tip >= 4 - RING_PARAMS.requestedCellSize - 1e-9,
        `a finish link does not sink below the model (tip ${tip.toFixed(4)})`)
    }
  }
  // No run is split, so every ring boundary carries a link cut.
  const rings = cutRings(result.moves)
  assert.equal(rings.length, 11, 'the linked finish still emits eleven rings')
}

// ---------------------------------------------------------------------------
// 2c-bis. The continuous helix resolves a ridge between ring positions.
//
//     #1093's review counter-example, reused for #1103 slice ca-c: a Ø200 bar,
//     a Ø1 ball, a 0.2 mm ridge 19.82 mm above a 60.18 mm cylinder, with the
//     ridge at the midpoint of rings 6 and 7 -- more than one cutter radius
//     from either, so no ring's own sample can see it. The helix's combined
//     (along, A) samples are 0.015 mm apart along the bar, so its emitted path
//     has to climb the ridge instead of interpolating between the ring heights.
// ---------------------------------------------------------------------------

console.log('Testing that a continuous helix resolves a ridge between two rings...')
{
  const stock = roundStock(200, 30, 'x', { x: 0, y: 0 })
  const ball: NormalizedTool = {
    ...BALL, id: 'ball-1', name: '1 mm ball nose', type: 'ball_endmill',
    diameter: 1, radius: 0.5,
  }
  const base = 60.18
  const peak = 80
  // The retained ends pull the band one cutter radius inside it, so the ring
  // grid is 5.5 + 19i/13: the ridge sits at the midpoint of rings 6 and 7
  // (14.2692 and 15.7308), 0.73 mm from either -- more than the 0.5 mm cutter
  // radius, so neither ring's own footprint reaches it.
  const ridgeFrom = 14.9
  const ridgeTo = 15.1
  const model = revolved(stock, [
    { along: 5, radius: base },
    { along: ridgeFrom, radius: base },
    { along: ridgeFrom, radius: peak },
    { along: ridgeTo, radius: peak },
    { along: ridgeTo, radius: base },
    { along: 25, radius: base },
  ], 128)
  const finish = generateRotaryFinish('ridge-link', model, stock, ball, {
    stepover: 1.49, sampleSpacing: 2, stockToLeave: 0, alongStart: 5, alongEnd: 25,
    safeRadius: 30, requestedCellSize: 0.05, passDirection: 'around',
  }, {})
  // A Ø200 bar's height map is reduced to its budget; that is a resolution
  // advisory, not a refusal, and the ridge below still resolves.
  assert.ok(finish.warnings.every((warning) => warning.code === 'surfaceHeightMapReduced'),
    'the ridge finish carries only the height-map resolution advisory')
  // A surface of revolution is one eligible band, so there are no ring
  // boundaries left to link: the whole band turns one way.
  let reversals = 0
  let lastSign = 0
  for (const move of finish.moves) {
    if (move.kind !== 'cut') continue
    const delta = angleOf(move.to) - angleOf(move.from)
    if (Math.abs(delta) < 1e-12) continue
    const sign = Math.sign(delta)
    if (lastSign !== 0 && sign !== lastSign) reversals++
    lastSign = sign
  }
  assert.equal(reversals, 0, 'the ridge band is one continuous helix')
  const pivot = barPivotZ(stock)
  // Every emitted cut segment that crosses the ridge's flat top must sit on it.
  // The segment, not its endpoints: a merge collapses the run to its two ends,
  // so an endpoint filter would miss the very point the link crosses. The
  // sampler's conservative cell bound can lift a sample by at most its 0.05 mm
  // cell; the tip must never be at the surrounding 60.18 mm cylinder.
  let crossed = 0
  let lowest = Number.POSITIVE_INFINITY
  for (const move of finish.moves) {
    if (move.kind !== 'cut') continue
    const a = alongOf(move.from)
    const b = alongOf(move.to)
    if (!(b > a)) continue
    const lo = Math.max(a, ridgeFrom)
    const hi = Math.min(b, ridgeTo)
    if (hi <= lo) continue
    crossed++
    for (const x of [lo, hi]) {
      const tip = move.from.z + (move.to.z - move.from.z) * (x - a) / (b - a) - pivot
      if (tip < lowest) lowest = tip
    }
  }
  assert.ok(crossed > 0, 'the helix samples the ridge at all')
  assert.ok(lowest >= peak - 0.06,
    `the helix climbs over the ridge instead of cutting through it (lowest tip ${lowest.toFixed(4)}, model ${peak})`)
}

// ---------------------------------------------------------------------------
// 2d. #1117: a round rough's ring-to-ring link stays down at the layer and cuts.
//
//     The raised link (#1093) rose above whatever the operation's own earlier
//     layers left and rapid across. On a round bar the stock standing before a
//     layer is `max(model, previous radius)`, so the same link can cut at this
//     layer's radius instead: full engagement, no deeper cut, no new feed. The
//     layer radius is a clamp -- a link over a model lower than the layer stays
//     at the layer rather than diving to the model -- and a model rise is
//     followed, so a ridge between two rings is protected instead of cut
//     through. A link that cannot be proved to meet only one band of material,
//     or that is not two adjoining rings at one exact angle, keeps the raised
//     form.
//
//     Mutations each fail here:
//      - the raised-only path restored -> the first block: no rapid between the
//        rings, and the air-link count;
//      - the `max(tip, layerRadius)` clamp removed -> the step block's first
//        layer: its links dive to the low model (and the safety rule then
//        refuses them, so the count fails too);
//      - the link row sampled only at the ring positions -> the ridge block: the
//        link cuts through the ridge at the layer height instead of climbing it;
//      - the model-gap refusal removed -> the last block: a link crosses the gap
//        the ring there does not cut;
//      - the inclusive boundary scan removed (strict interior filter restored)
//        -> the fine-step gap block: with the row and ring grids coincident a
//        cutting link enters the span where the row has no model;
//      - the round bar's wide A-change bound removed -> the split-ring block: the
//        twenty low links between the second layer's split rings return, crossing
//        the lobe the layer does not remove (its sweep is far past the 45 degree
//        drift bound). #1103 ca-f moved the split-ring gate to the region case
//        only, so this fixture is now held by the wide bound instead.
// ---------------------------------------------------------------------------

/** The first layer-boundary retract of an around rough: a rapid back along the bar. */
function firstLayerRetract(moves: readonly ToolpathMove[]): number {
  return moves.findIndex((move) => move.kind === 'rapid' && move.to.x < move.from.x)
}

{
  // The step: radius 8 for x < 9 and 6.5 after it, in 3 mm layers. The first
  // layer's radius is 7, so the links after the step must stay at 7 -- the
  // clamp -- although the model there is 6.5. The low model is close enough to
  // the layer that an unclamped link is still only one band deep, so removing
  // the clamp produces a link *at the model* rather than a refusal, and the
  // height assertion below is what catches it.
  const stock = roundStock(20, 20, 'x', { x: 0, y: 0 })
  const model = revolved(stock, [
    { along: 0, radius: 8 }, { along: 9, radius: 8 },
    { along: 9, radius: 6.5 }, { along: 20, radius: 6.5 },
  ], 128)
  const params = {
    stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 0, alongEnd: 20,
    safeRadius: 30, requestedCellSize: 0.5, passDirection: 'around' as const,
  }
  const result = generateRotaryRough('rough-clamp', model, stock, FLAT, { ...params, stepdown: 3 }, {})
  assert.deepEqual(result.warnings, [], 'the clamp rough has no warning')
  const pivot = barPivotZ(stock)
  // #1103 slice ca-d: the first layer's full rings are one continuous helix, so
  // its clamp is the helix's `ContinuousHelixLayer.radius` rather than a link's.
  // Every first-layer cut stays at the 7 mm layer radius even where the model
  // drops to 6.5 -- removing the clamp dives the helix to the model.
  const boundary = firstLayerRetract(result.moves)
  assert.ok(boundary > 0, 'the first layer ends with its retract')
  const layerOne = result.moves.slice(0, boundary).filter((move) => move.kind === 'cut')
  assert.ok(layerOne.length >= 10, `the first layer cuts a continuous path (${layerOne.length} moves)`)
  const lowest = Math.min(...layerOne.flatMap((cut) => [cut.from.z, cut.to.z])) - pivot
  approx(lowest, 7, 'the first layer clamp holds every cut at the layer radius, not the 6.5 mm model', 1e-6)
  for (const cut of layerOne) {
    for (const tip of [cut.from.z - pivot, cut.to.z - pivot]) {
      assert.ok(tip >= 7 - 1e-9,
        `every first-layer cut stays at or above the layer radius (tip ${tip.toFixed(4)}, model 6.5)`)
    }
  }
}

{
  // A Ø20 bar, a Ø10 model, a Ø4 flat in 3 mm layers. Ten ring boundaries per
  // layer, ten links. Layer 1's radius is 7 -- above the 5 mm model -- so its
  // links must sit at 7 even though the model is lower; layer 2's last radius
  // is the model's own, so its links follow it.
  const stock = roundStock(20, 20, 'x', { x: 0, y: 0 })
  const model = revolved(stock, [{ along: 0, radius: 5 }, { along: 20, radius: 5 }], 64)
  const params = {
    stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 0, alongEnd: 20,
    safeRadius: 30, requestedCellSize: 0.5, passDirection: 'around' as const,
  }
  const result = generateRotaryRough('rough-links', model, stock, FLAT, { ...params, stepdown: 3 }, {})
  assert.deepEqual(result.warnings, [], 'the linked rough has no warning')
  const pivot = barPivotZ(stock)
  // #1103 slice ca-d: both layers are whole rings, so each is one continuous
  // helix. The layer clamp is what must hold: layer 1 (radius 7) cuts at 7 even
  // though the model is 5, and the deepest layer follows the model.
  assert.equal(result.moves.filter(isAirLink).length, 0,
    'no raised link is emitted for whole rings')
  const layerRadius = 7
  const boundary = firstLayerRetract(result.moves)
  assert.ok(boundary > 0, 'the layer boundary is still a rapid back along the bar')
  const layerOne = result.moves.slice(0, boundary).filter((move) => move.kind === 'cut')
  const layerTwo = result.moves.slice(boundary).filter((move) => move.kind === 'cut')
  // On a cylinder the helix is exactly a straight line in (along, A), so the
  // cutter merge collapses each layer to a handful of moves.
  assert.ok(layerOne.length > 2 && layerTwo.length > 2, 'both layers cut a continuous path')
  for (const cut of layerOne) {
    approx(cut.from.z - pivot, layerRadius, 'a first-layer cut rides the layer radius')
  }
  for (const cut of layerTwo) {
    for (const tip of [cut.from.z - pivot, cut.to.z - pivot]) {
      assert.ok(tip >= 5 - 1e-9 && tip <= 5 + params.requestedCellSize + 1e-9,
        `a deepest-layer cut follows the model, not the 7 mm floor (tip ${tip.toFixed(4)})`)
    }
  }
  assert.equal(result.moves.filter((move) => move.kind === 'plunge').length, 2,
    'one plunge per layer, at the first cut of each')
}

{
  // A ridge between two rings, 0.2 mm wide and 3 mm above the model, on a Ø20
  // bar with a Ø1 ball in 3 mm layers: neither ring's 0.5 mm footprint reaches
  // it, so only a link that samples between the rings can climb over it. The
  // link must follow the protected model over the ridge instead of cutting it
  // off at the 7 mm layer radius.
  const stock = roundStock(20, 20, 'x', { x: 0, y: 0 })
  const ball = { ...BALL, id: 'ball-1', name: '1 mm ball nose', type: 'ball_endmill' as const, diameter: 1, radius: 0.5 }
  const base = 5
  const peak = 8
  const ridgeFrom = 0.9
  const ridgeTo = 1.1
  const model = revolved(stock, [
    { along: 0, radius: base },
    { along: ridgeFrom, radius: base },
    { along: ridgeFrom, radius: peak },
    { along: ridgeTo, radius: peak },
    { along: ridgeTo, radius: base },
    { along: 20, radius: base },
  ], 128)
  const params = {
    stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 0, alongEnd: 20,
    safeRadius: 30, requestedCellSize: 0.05, passDirection: 'around' as const,
  }
  const result = generateRotaryRough('ridge-link', model, stock, ball, { ...params, stepdown: 3 }, {})
  assert.deepEqual(result.warnings, [], 'the ridge rough has no warning')
  const pivot = barPivotZ(stock)
  // #1103 slice ca-d: the first layer is one continuous helix, so the ridge is
  // protected by sampling the helix's own combined poses and refining a segment
  // whose midpoint stands above its chord -- not by a ring-to-ring link.
  const ridgeBoundary = firstLayerRetract(result.moves)
  assert.ok(ridgeBoundary > 0, 'the first layer ends with its retract')
  const links = result.moves.slice(0, ridgeBoundary)
    .filter((move) => move.kind === 'cut' && move.to.x > move.from.x + 1e-9)
  assert.ok(links.length > 0, `the ridge fixture still cuts along the bar (${links.length} moves)`)
  // The first layer never cuts below its own 7 mm radius; the ridge is the only
  // thing above it (and a merged move that ends on the ridge is above it too).
  for (const move of links) {
    assert.ok(Math.min(move.from.z, move.to.z) - pivot >= 7 - 1e-6,
      `a first-layer cut never dives below the layer (tip ${(Math.min(move.from.z, move.to.z) - pivot).toFixed(4)})`)
  }
  // The segment, not its endpoints: a merge collapses the run to its ends, so
  // an endpoint filter would miss the point the link crosses.
  let crossed = 0
  let lowest = Number.POSITIVE_INFINITY
  for (const link of links) {
    const a = link.from.x
    const b = link.to.x
    if (!(b > a)) continue
    const lo = Math.max(a, ridgeFrom)
    const hi = Math.min(b, ridgeTo)
    if (hi <= lo) continue
    crossed++
    for (const x of [lo, hi]) {
      const tip = link.from.z + (link.to.z - link.from.z) * (x - a) / (b - a) - pivot
      if (tip < lowest) lowest = tip
    }
  }
  assert.ok(crossed > 0, 'a link crosses the ridge between the two rings')
  // The row's conservative cell bound can only lift a sample above the model,
  // so the crossing never falls below the peak; a coarse row that missed the
  // ridge reads the 7 mm layer radius there (measured 7.951 under that
  // mutation, 8.002 here).
  assert.ok(lowest >= peak - 0.02,
    `the link climbs over the ridge instead of cutting through it (lowest tip ${lowest.toFixed(4)}, model ${peak})`)
}

{
  // A model gap: two 4 mm bosses with nothing between x = 6 and x = 14. The link
  // row there has no model under the tool and the ring at those along positions
  // removes nothing, so the transition keeps the raised link (the old motion)
  // rather than cutting uncut blank.
  const stock = roundStock(20, 20, 'x', { x: 0, y: 0 })
  const lower = revolved(stock, [{ along: 0, radius: 4 }, { along: 6, radius: 4 }], 64)
  const upper = revolved(stock, [{ along: 14, radius: 4 }, { along: 20, radius: 4 }], 64)
  const offset = lower.positions.length / 3
  const positions = new Float32Array(lower.positions.length + upper.positions.length)
  positions.set(lower.positions, 0)
  positions.set(upper.positions, lower.positions.length)
  const index = new Uint32Array(lower.index.length + upper.index.length)
  index.set(lower.index, 0)
  index.set(upper.index.map((vertex) => vertex + offset), lower.index.length)
  const model: RotaryModelMesh = { positions, index }
  const params = {
    stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 0, alongEnd: 20,
    safeRadius: 30, requestedCellSize: 0.5, passDirection: 'around' as const,
  }
  const result = generateRotaryRough('rough-gap', model, stock, FLAT, { ...params, stepdown: 3 }, {})
  assert.deepEqual(result.warnings, [], 'the gap rough has no warning')
  const pivot = barPivotZ(stock)
  const links = result.moves.filter(isAlongLink)
  assert.ok(links.length > 0, 'the bosses are still linked at the layer')
  assert.ok(links.every((link) => !(link.from.x < 10 - 1e-9 && link.to.x > 10 + 1e-9)),
    'no cutting link crosses the model gap')
  const raised = result.moves.filter(isAirLink)
  assert.ok(raised.some((link) => link.from.x === 8 && link.to.x === 10),
    'the transition over the gap keeps the raised link')
  assert.ok(raised.every((link) => link.from.z - pivot >= 4 + 1 - 1e-6),
    'and the raised link still clears the last material the operation left')
}

{
  // #1117 review (P1): a stepover at or below the tool radius makes the dense
  // link row and the ring grid the same points. Every interior row sample then
  // lands exactly on a ring position, the old strict `x > from && x < to`
  // filter skipped all of them, and the candidate collapsed to one straight
  // cut with no leftover sample examined at all. On the two-boss gap it cut 76
  // links into the span where the row has no model (the raised-only path emits
  // only raised links there). The inclusive scan validates the boundary
  // samples, and a transition longer than one row interval with no interior
  // sample is refused.
  const stock = roundStock(20, 20, 'x', { x: 0, y: 0 })
  const lower = revolved(stock, [{ along: 0, radius: 4 }, { along: 6, radius: 4 }], 64)
  const upper = revolved(stock, [{ along: 14, radius: 4 }, { along: 20, radius: 4 }], 64)
  const offset = lower.positions.length / 3
  const positions = new Float32Array(lower.positions.length + upper.positions.length)
  positions.set(lower.positions, 0)
  positions.set(upper.positions, lower.positions.length)
  const index = new Uint32Array(lower.index.length + upper.index.length)
  index.set(lower.index, 0)
  index.set(upper.index.map((vertex) => vertex + offset), lower.index.length)
  const model: RotaryModelMesh = { positions, index }
  const params = {
    stepover: 0.25, sampleSpacing: 1, stockToLeave: 0, alongStart: 0, alongEnd: 20,
    safeRadius: 30, requestedCellSize: 0.5, passDirection: 'around' as const,
  }
  const result = generateRotaryRough('rough-gap-fine', model, stock, FLAT, { ...params, stepdown: 2 }, {})
  assert.deepEqual(result.warnings, [], 'the fine-step gap rough has no warning')
  // Where the cutter's 2 mm footprint no longer reaches either boss, the link
  // row has no model; a cutting link may not enter that span at all.
  const gapFrom = 6 + FLAT.radius
  const gapTo = 14 - FLAT.radius
  const entersGap = (link: ToolpathMove): boolean =>
    link.from.x < gapTo - 1e-9 && link.to.x > gapFrom + 1e-9
  // #1103 slice ca-d: with A one-way the boss boundaries are safe gaps, so the
  // rule that matters is stated on every cutting move: nothing may cut into the
  // span the link row has no model over, and the gap is crossed by a rapid.
  // A ring sample there is the rough's own "no model under the tool = cut to the
  // axis" fallback, which this slice keeps. What may not enter the span is a
  // **link**: a cut that also moves along the bar.
  const linkCuts = result.moves.filter((move) => move.kind === 'cut'
    && move.from.x !== move.to.x && entersGap(move))
  assert.equal(linkCuts.length, 0,
    'no cutting link enters the no-model span between the bosses')
  assert.ok(result.moves.some((move) => move.kind === 'rapid' && entersGap(move)),
    'the transitions inside the gap are rapid traverses')
  // Both bosses still cut at the layer on their own side.
  assert.ok(result.moves.some((move) => move.kind === 'cut' && move.to.x <= gapFrom + 0.5 && move.to.x > 0),
    'the last boundary before the gap still cuts')
  assert.ok(result.moves.some((move) => move.kind === 'cut' && move.from.x >= gapTo - 0.5),
    'the first boundary after the gap still cuts')
}

{
  // #1117 review (P2): a split ring -- one whose cut runs are separated by
  // angular sectors this layer does not remove -- must keep the raised link to
  // its neighbour. Its first/last run can still share an angle with the next
  // ring, and the old candidate accepted that shared angle and cut at the
  // layer regardless. The round model here has an angular radius
  // 7 - 2cos(2 theta), so layer 2 (radius 6) cuts two runs per ring and the
  // transition between them was 20 low links. The caller now tracks both
  // adjoining rings' eligibility, so only layer 1's whole rings stay down.
  const stock = roundStock(20, 20, 'x', { x: 0, y: 0 })
  const segments = 128
  const crossSection: (readonly [number, number])[] = []
  for (let j = 0; j < segments; j++) {
    const t = 2 * Math.PI * j / segments
    const radius = 7 - 2 * Math.cos(2 * t)
    crossSection.push([radius * Math.cos(t), radius * Math.sin(t)])
  }
  const model = prism(stock, crossSection, [0, 20])
  const params = {
    stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 0, alongEnd: 20,
    safeRadius: 30, requestedCellSize: 0.05, passDirection: 'around' as const,
  }
  const result = generateRotaryRough('rough-split-rings', model, stock, FLAT, { ...params, stepdown: 2 }, {})
  assert.deepEqual(result.warnings, [], 'the split-ring rough has no warning')
  const pivot = barPivotZ(stock)
  // #1103 slice ca-d: every ring turns forward, so a split ring's boundary is a
  // safe gap rather than an at-layer link. No low link may join the split rings,
  // and each boundary retracts and plunges again.
  //
  // #1103 slice ca-f: the split-ring **gate** no longer decides this on a round
  // bar without a region (see the seam-groove block below); the boundary here is
  // refused by the wide A-change bound instead. These rings' gaps are the tall
  // lobe itself -- the two runs are separated by the sector the layer does not
  // remove -- so the transition between them sweeps across that lobe, a forward
  // A change far past `MAX_LINK_ACROSS_DEG`. The assertion is unchanged and now
  // pins that bound rather than the eligibility rule.
  assert.equal(result.moves.filter(isAlongLink).length, 0,
    'no at-layer link joins the split rings')
  const plunges = result.moves.filter((move) => move.kind === 'plunge')
  assert.ok(plunges.length > 10,
    `every split-ring boundary retracts and plunges (${plunges.length} plunges)`)
  assert.ok(pivot > 0)
}

{
  // #1103 slice ca-f: a round rough's ring-to-ring link after a helix.
  //
  // The bar is radius 7 up to a shoulder at along 8, so layer 2 cuts whole rings
  // there and the band is one continuous helix (ca-d). Past the shoulder a tall
  // (radius 9) sector stands above layer 1's floor, so every ring there cuts two
  // runs that **wrap the A0/A360 seam**: the ring's first run starts at A0 and
  // its last run ends at A360, and the sector drifts a few degrees per ring.
  // The previous ring's last cut and the next ring's first cut are therefore the
  // same commanded A, which is #1117's at-layer link; before this slice the
  // split-ring bookkeeping refused exactly that boundary on a round bar without
  // a region, so every ring after the helix retracted and plunged again.
  //
  // Mutations each fail here (both measured):
  //  - the split-ring gate restored for a region-less round bar -> the five
  //    raised links come back and the post-shoulder link count falls from six to
  //    three;
  //  - an extra 360 on the forward-equivalent A of any ring (`unitBase`) -> the
  //    boundary is no longer the same A, falls to the wide A-change bound and
  //    keeps the raised link (nine rapids, seven groups on this fixture).
  const stock = roundStock(20, 20, 'x', { x: 0, y: 0 })
  const pivot = barPivotZ(stock)
  const shoulder = 8
  const segments = 360
  const DEG = Math.PI / 180
  const radiusAt = (x: number, across: number): number => {
    if (x <= shoulder + 1e-9) return 7
    let off = ((across - (180 + 4 * (x - shoulder))) % 360 + 360) % 360
    if (off > 180) off = 360 - off
    return Math.abs(off) <= 20 ? 9 : 7
  }
  const centre = barCentre(stock)
  const alongs: number[] = []
  for (let x = 0; x < 16 - 1e-9; x += 0.25) alongs.push(x)
  alongs.push(16)
  const rings: number[] = []
  for (const x of alongs) {
    rings.push(x)
    // A duplicated along position makes the tall sector a vertical wall.
    if (Math.abs(x - shoulder) < 1e-9) rings.push(x)
  }
  const positions: number[] = []
  const index: number[] = []
  for (const x of rings) {
    for (let j = 0; j < segments; j++) {
      const theta = 360 * j / segments
      const r = radiusAt(x, 90 - theta)
      positions.push(x, centre + r * Math.cos(theta * DEG), pivot + r * Math.sin(theta * DEG))
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
  const model: RotaryModelMesh = { positions: new Float32Array(positions), index: new Uint32Array(index) }
  const params = {
    stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 0, alongEnd: 16,
    safeRadius: 30, requestedCellSize: 0.1, passDirection: 'around' as const,
  }
  const result = generateRotaryRough('ca-f-forward-ring-links', model, stock, BALL, { ...params, stepdown: 2 }, {})
  assert.deepEqual(result.warnings, [], 'the seam-groove rough warns about nothing')
  // The band before the shoulder is a continuous helix: a cut that changes A and
  // the along position at once, well before any ring boundary.
  assert.ok(result.moves.some((move) => move.kind === 'cut'
    && alongOf(move.to) > alongOf(move.from)
    && angleOf(move.to) !== angleOf(move.from)
    && alongOf(move.to) < shoulder),
    'layer 2 helixes the whole-ring band before the shoulder')
  // No raised link between the rings: every boundary after the helix is a
  // stay-down feed at the layer instead of a retract/rapid/plunge.
  assert.equal(result.moves.filter(isAirLink).length, 0,
    'no raised link joins the forward-only rings after the helix')
  const links = result.moves.filter(isAlongLink)
  const afterShoulder = links.filter((move) => alongOf(move.from) >= shoulder - 1e-6)
  // #1155 rn-e: the band's far end (16) is the model's own end, so the centre
  // now reaches it instead of stopping one cutter radius inside it, and the
  // along grid gains the ring at 16. The rings past the shoulder are therefore
  // 8, 10, 12, 14 and 16 -- four boundaries, each of which must link.
  const ringAlong = [...new Set(result.moves
    .filter((move) => move.kind !== 'rapid' && angleOf(move.from) !== angleOf(move.to)
      && alongOf(move.from) === alongOf(move.to))
    .map((move) => Math.round(alongOf(move.from) * 1e6) / 1e6))].sort((a, b) => a - b)
  const boundaries = ringAlong.filter((along) => along >= shoulder - 1e-6).length - 1
  // The count is the number of ring-to-ring boundaries that still exist, not a
  // constant: #1103 slice ca-g splits layer 1's band -- which used to be all
  // rings because one shoulder segment could not be verified -- into a helix
  // over its first rings plus the rings around the shoulder, so one boundary
  // that used to be a ring link is now a helix boundary (measured on this
  // fixture: nine rapids and 478 moves before, four rapids and 385 after, with
  // no raised link either way).
  assert.equal(afterShoulder.length, boundaries,
    `every ring after the helix links to its neighbour (${afterShoulder.length} links, ${boundaries} boundaries)`)
  assert.ok(boundaries >= 4,
    `the fixture still has the rings this check is about (${boundaries} boundaries past the shoulder)`)
  // The ring after a helix is entered by a **link**, not a retract: every move
  // between the helix piece's end boundary ring and the next ring's first cut is
  // a feed that holds that ring's exact A, so the tool never rises. That is
  // #1117's at-layer boundary, and it is what a link that skipped its own angle
  // or height rule would break. A layer ends with a rapid back along the bar, so
  // the layers are the stretches between those traverses.
  const layerStarts = [0]
  for (let i = 1; i < result.moves.length; i++) {
    if (result.moves[i].kind === 'rapid' && alongOf(result.moves[i].to) < alongOf(result.moves[i].from) - 1e-12) {
      layerStarts.push(i + 1)
    }
  }
  layerStarts.push(result.moves.length)
  let seamChecked = 0
  for (let layer = 0; layer + 1 < layerStarts.length; layer++) {
    const layerMoves = result.moves.slice(layerStarts[layer], layerStarts[layer + 1])
    let lastHelixMove = -1
    for (let i = 0; i < layerMoves.length; i++) {
      const move = layerMoves[i]
      if (move.kind === 'cut' && alongOf(move.to) !== alongOf(move.from)
        && angleOf(move.to) !== angleOf(move.from)) lastHelixMove = i
    }
    if (lastHelixMove <= 0) continue
    const helixEndAlong = Math.max(...layerMoves.slice(0, lastHelixMove + 1).map((move) => alongOf(move.to)))
    // The helix piece closes on its own complete boundary ring at that along
    // position; the ring past it is the next along position the path cuts.
    let boundaryEnd = lastHelixMove
    for (let i = lastHelixMove + 1; i < layerMoves.length; i++) {
      if (Math.abs(alongOf(layerMoves[i].to) - helixEndAlong) > 1e-9
        || Math.abs(alongOf(layerMoves[i].from) - helixEndAlong) > 1e-9) break
      boundaryEnd = i
    }
    let firstRing = -1
    for (let i = boundaryEnd + 1; i < layerMoves.length; i++) {
      const move = layerMoves[i]
      if (move.kind !== 'cut') break
      if (alongOf(move.from) > helixEndAlong + 1e-9
        && alongOf(move.to) === alongOf(move.from)
        && angleOf(move.to) !== angleOf(move.from)) {
        firstRing = i
        break
      }
    }
    if (firstRing < 0) continue
    const seam = layerMoves.slice(boundaryEnd + 1, firstRing)
    assert.ok(seam.length > 0, `layer ${layer + 1}: a link joins the helix piece to the ring after it`)
    for (const move of seam) {
      assert.equal(move.kind, 'cut',
        `layer ${layer + 1}: the ring after the helix is entered by a stay-down link, not a retract`)
      assert.equal(angleOf(move.from), angleOf(move.to),
        `layer ${layer + 1}: the link holds the ring first cut angle through every leg`)
    }
    assert.equal(angleOf(layerMoves[firstRing].from), angleOf(seam[seam.length - 1].to),
      `layer ${layer + 1}: the ring first cut continues from exactly where the link left the tool`)
    seamChecked++
  }
  assert.ok(seamChecked > 0, 'a helix piece bounded by rings was checked for its at-layer seam')
  // Those rings are **split**: their two runs wrap the seam, and the join
  // between the runs is an A move at the travel height, not a cut.
  assert.ok(result.moves.some((move) => move.kind === 'cut'
    && alongOf(move.from) >= shoulder - 1e-6
    && alongOf(move.to) === alongOf(move.from)
    && angleOf(move.to) !== angleOf(move.from)
    && move.from.z - pivot > 8),
    'each ring after the helix is split by the tall sector')
  // The links stay within one band of the layer: the at-layer candidate may ride
  // at the previous layer's floor (radius 8), never higher.
  for (const move of afterShoulder) {
    assert.ok(move.from.z - pivot <= 8 + 1e-6 && move.to.z - pivot <= 8 + 1e-6,
      `an at-layer link stays at or below the previous layer's floor (${(Math.max(move.from.z, move.to.z) - pivot).toFixed(3)})`)
  }
  // A keeps moving forward over all of it.
  let reversals = 0
  let lastDirection = 0
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    const delta = (move.to.a ?? 0) - (move.from.a ?? 0)
    const direction = Math.sign(delta)
    if (direction !== 0) {
      if (lastDirection !== 0 && direction !== lastDirection) reversals++
      lastDirection = direction
    }
  }
  assert.equal(reversals, 0, 'the rough never reverses A')
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
// 3b. The swept cutter/material reference on a chiral, tapered bar: diagonal
//     moves, where the along position and A change together.
//
//     The reference above (section 3) is the analytic drop-cutter of a solid of
//     revolution, so its material is the same at every A and a diagonal move is
//     judged by its along coordinate alone. The model below is not a surface of
//     revolution: a triangle that scales and turns as it is extruded along the
//     bar, so the material a cutter can reach at one pose depends on the along
//     position **and** on A. Its reference support is computed from the analytic
//     section -- the highest material a solid cutter body reaches inside its
//     axial footprint at that pose, including the off-axis reach and the ball's
//     shank -- and never from `sampleRotaryModel` or the mesh the generator
//     reads. The path is sampled at the emitted fraction: `along(f)` and
//     `angle(f)` are both interpolated, so a move that changes them together is
//     judged along the path it commands, never by swapping in one endpoint's
//     value.
//
//     Seeds cover both stock axes, mm and inch, ball and flat cutters, retained
//     ends (the cut band is inset from the model's ends) and the asymmetric
//     section. Four mutations are proved caught for every seed:
//      - an axial sign error on a diagonal move (the commanded along direction
//        reversed while the tips stay with their poses);
//      - an A sign error on a diagonal move;
//      - the reference reduced to the tip-only ray under the tool axis, which
//        misses material the cutter body reaches off-axis;
//      - an interior gouge on a diagonal move, with both endpoints safe
//        (an endpoint-only sample cannot see it).
// ---------------------------------------------------------------------------


let chiralMutationsCaught = 0
let chiralChecks = 0
/** Closest the generator came to the reference over all seeds (positive = slack). */
let chiralClosest = Number.POSITIVE_INFINITY
console.log('Testing the chiral diagonal reference across axes, units and cutters...')
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
    id: `chiral-${label}`,
    name: `chiral-${label}`,
    type,
    sourceUnits: units,
    units,
    radius: 1 * scale,
    diameter: 2 * scale,
  }
  const at = (point: ToolpathPoint): number => (axis === 'x' ? point.x : point.y)
  const pivot = barPivotZ(stock)

  // The reference must actually depend on both coordinates, or the mutations
  // below would pass for the wrong reason.
  const alongA = chiralSupport(model, 8 * scale, 30, tool)
  const alongB = chiralSupport(model, 12 * scale, 30, tool)
  const angleA = chiralSupport(model, 10 * scale, 20, tool)
  const angleB = chiralSupport(model, 10 * scale, 110, tool)
  assert.ok(Math.abs(alongB - alongA) > 0.3 * scale,
    `${label}: the support moves with the along position (${alongA.toFixed(3)} vs ${alongB.toFixed(3)})`)
  assert.ok(Math.abs(angleB - angleA) > 0.3 * scale,
    `${label}: the support moves with A (${angleA.toFixed(3)} vs ${angleB.toFixed(3)})`)

  const result = generateRotaryFinish(`chiral-${label}`, chiralMesh(stock, model, 40), stock, tool, {
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
  assert.ok(result.moves.length > 0, `${label}: the chiral finish emits motion`)
  const travel = barMaxRadius(stock) + scale
  for (const move of result.moves) {
    if (move.kind !== 'cut' && move.from.a !== move.to.a) {
      for (const point of [move.from, move.to]) {
        assert.ok(point.z - pivot >= travel - 1e-9,
          `${label}: a non-cut turning move travels below the travel height (${(point.z - pivot).toFixed(4)})`)
      }
    }
    if (move.kind !== 'cut') continue
    // The cut band is inset from the model's ends, so the material outside it
    // is retained: no cutting pose's body may reach past the band.
    for (const point of [move.from, move.to]) {
      const along = at(point)
      assert.ok(along - tool.radius >= 5 * scale - 1e-9 && along + tool.radius <= 15 * scale + 1e-9,
        `${label}: the cutter body at along ${along.toFixed(4)} enters a retained end of the band`)
    }
    for (let step = 0; step <= 4; step++) {
      const f = step / 4
      const along = at(move.from) + (at(move.to) - at(move.from)) * f
      const angle = (move.from.a ?? 0) + ((move.to.a ?? 0) - (move.from.a ?? 0)) * f
      const tip = move.from.z + (move.to.z - move.from.z) * f - pivot
      const support = chiralSupport(model, along, angle, tool)
      chiralChecks++
      chiralClosest = Math.min(chiralClosest, (tip - support) / scale)
      assert.ok(tip >= support - allowance,
        `${label}: ${move.kind} at along ${along.toFixed(4)} A${angle.toFixed(2)} f=${f} tip ${tip.toFixed(4)} `
        + `is below the chiral reference ${support.toFixed(4)} by more than ${allowance.toFixed(4)}`)
    }
  }

  // ── the four mutations ──────────────────────────────────────────────────
  const margin = 0.25 * scale
  const tolerance = allowance
  /**
   * A commanded diagonal from one pose to another, lifted by its own chord sag
   * so the correct path is safe, plus the two sign mutations: the along
   * coordinates swapped and the A coordinates swapped, with the tips left on
   * their original fractions.
   */
  const signMutations = (
    fromAlong: number,
    fromAngle: number,
    toAlong: number,
    toAngle: number,
  ): { correct: number; axialSign: number; angleSign: number } => {
    const startSupport = chiralSupport(model, fromAlong, fromAngle, tool)
    const endSupport = chiralSupport(model, toAlong, toAngle, tool)
    const chord: DiagonalPath = {
      along: (f) => fromAlong + (toAlong - fromAlong) * f,
      angle: (f) => fromAngle + (toAngle - fromAngle) * f,
      tip: (f) => startSupport + (endSupport - startSupport) * f,
    }
    const lift = Math.max(0, diagonalGouge(model, tool, chord)) + 0.05 * scale
    const tip = (f: number): number => startSupport + (endSupport - startSupport) * f + lift
    return {
      correct: diagonalGouge(model, tool, { ...chord, tip }),
      axialSign: diagonalGouge(model, tool, {
        along: (f) => toAlong + (fromAlong - toAlong) * f,
        angle: (f) => fromAngle + (toAngle - fromAngle) * f,
        tip,
      }),
      angleSign: diagonalGouge(model, tool, {
        along: (f) => fromAlong + (toAlong - fromAlong) * f,
        angle: (f) => toAngle + (fromAngle - toAngle) * f,
        tip,
      }),
    }
  }
  // One move is along-dominated, the other A-dominated, so each sign error is
  // caught where its own coordinate drives the support.
  const axialCase = signMutations(8 * scale, 10, 10 * scale, 14)
  assert.ok(axialCase.correct <= tolerance,
    `${label}: the along-dominated diagonal's own path is safe (${axialCase.correct.toFixed(4)})`)
  assert.ok(axialCase.axialSign > tolerance,
    `${label}: the axial sign error is caught (worst ${axialCase.axialSign.toFixed(4)} against ${tolerance.toFixed(4)})`)
  const angleCase = signMutations(8 * scale, 10, 8.4 * scale, 20)
  assert.ok(angleCase.correct <= tolerance,
    `${label}: the A-dominated diagonal's own path is safe (${angleCase.correct.toFixed(4)})`)
  assert.ok(angleCase.angleSign > tolerance,
    `${label}: the A sign error is caught (worst ${angleCase.angleSign.toFixed(4)} against ${tolerance.toFixed(4)})`)
  chiralMutationsCaught += 2

  // A short, safe diagonal: every sample is the reference plus a margin. The
  // straight tip chord between its endpoints is inside the margin on this
  // segment, so a correct generator move is accepted.
  const shortFrom = { along: 9 * scale, angle: 30 }
  const shortTo = { along: 9.6 * scale, angle: 38 }
  const shortFromTip = chiralSupport(model, shortFrom.along, shortFrom.angle, tool) + margin
  const shortToTip = chiralSupport(model, shortTo.along, shortTo.angle, tool) + margin
  const shortPath: DiagonalPath = {
    along: (f) => shortFrom.along + (shortTo.along - shortFrom.along) * f,
    angle: (f) => shortFrom.angle + (shortTo.angle - shortFrom.angle) * f,
    tip: (f) => shortFromTip + (shortToTip - shortFromTip) * f,
  }
  assert.ok(diagonalGouge(model, tool, shortPath) <= tolerance,
    `${label}: the safe diagonal is accepted (${diagonalGouge(model, tool, shortPath).toFixed(4)})`)

  // The tip-only mutation: the body reaches material the axis ray does not.
  const tipOnlyAt = { along: 10 * scale, angle: 30 }
  const fullSupport = chiralSupport(model, tipOnlyAt.along, tipOnlyAt.angle, tool)
  const axisSupport = chiralSupport(model, tipOnlyAt.along, tipOnlyAt.angle, tool, true)
  assert.ok(fullSupport - axisSupport > 0.3 * scale,
    `${label}: the cutter body reaches ${(fullSupport - axisSupport).toFixed(4)} above the axis ray`)
  const tipOnlyPath: DiagonalPath = {
    along: (f) => tipOnlyAt.along + 0.3 * scale * f,
    angle: (f) => tipOnlyAt.angle + 3 * f,
    tip: () => axisSupport + margin,
  }
  const bodyGouge = diagonalGouge(model, tool, tipOnlyPath)
  const tipOnlyGouge = diagonalGouge(model, tool, tipOnlyPath, 24, true)
  assert.ok(bodyGouge > tolerance,
    `${label}: the full reference catches the axis-ray-only pose (${bodyGouge.toFixed(4)})`)
  assert.ok(tipOnlyGouge <= tolerance,
    `${label}: the tip-only reference would accept it (${tipOnlyGouge.toFixed(4)})`)
  chiralMutationsCaught += 1

  // An interior gouge on a move a generator actually emits. A linear move
  // interpolates along, A and Z linearly between its endpoints, so this path is
  // straight in all three coordinates: no curved dip, just the chord between
  // two poses, each `margin` above the reference at its own end. The chiral
  // section turns with the along position, so its support rises above that
  // chord in the middle: an endpoint-only sample sees two safe poses and misses
  // the material between them, while the actual combined path finds it.
  const gougeFrom = { along: 10 * scale, angle: 0 }
  const gougeTo = { along: 11.5 * scale, angle: 30 }
  const gougeFromTip = chiralSupport(model, gougeFrom.along, gougeFrom.angle, tool) + margin
  const gougeToTip = chiralSupport(model, gougeTo.along, gougeTo.angle, tool) + margin
  const straightGougePath: DiagonalPath = {
    along: (f) => gougeFrom.along + (gougeTo.along - gougeFrom.along) * f,
    angle: (f) => gougeFrom.angle + (gougeTo.angle - gougeFrom.angle) * f,
    tip: (f) => gougeFromTip + (gougeToTip - gougeFromTip) * f,
  }
  const straightInterior = diagonalGouge(model, tool, straightGougePath)
  const straightEndpoints = diagonalGouge(model, tool, straightGougePath, 1)
  assert.ok(straightInterior > 0.3 * scale,
    `${label}: the straight diagonal's interior gouge is caught (${straightInterior.toFixed(4)})`)
  assert.ok(straightEndpoints <= tolerance,
    `${label}: an endpoint-only sample misses the straight diagonal's gouge (${straightEndpoints.toFixed(4)})`)
  chiralMutationsCaught += 1
}
assert.equal(chiralMutationsCaught, CHIRAL_SEEDS.length * 4,
  `${chiralMutationsCaught} mutation checks were caught across ${CHIRAL_SEEDS.length} seeds`)
console.log(`  chiral diagonal reference: ${CHIRAL_SEEDS.length} seeds, ${chiralChecks} emitted samples, `
  + `${chiralMutationsCaught} mutations caught, closest emitted sample ${chiralClosest.toFixed(4)} mm above the reference`)

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
  // The hex prism contains the axis, so every angle has model and the whole
  // band is one continuous helix: the emitted tips are exercised on the helix's
  // own combined (along, A) poses, one-way and never rewound (#1103 slice ca-c).
  let lastSign = 0
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    const delta = angleOf(move.to) - angleOf(move.from)
    if (Math.abs(delta) < 1e-12) continue
    const sign = Math.sign(delta)
    assert.equal(sign, 1, `the helix only ever advances A (A${angleOf(move.from)} -> A${angleOf(move.to)})`)
    lastSign = sign
  }
  assert.equal(lastSign, 1, 'the hex band turns A')
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
  // A finish no longer reads a stepdown at all (2026-10-22 decision), so the
  // comparison is purely the direction field.
  const around = generateRotaryFinish('change', mesh, DIGEST_STOCK, FLAT,
    { ...params, passDirection: 'around' }, {})
  assert.ok(along.moves.length > 0 && around.moves.length > 0, 'both directions cut')
  assert.notDeepEqual(around.moves, along.moves, 'around and along produce different motion')
  // #1103 slice ca-c: an around pass turns one way and A grows across the
  // operation; it is never wrapped back into one turn.
  assert.ok(around.moves.every((move) => angleOf(move.from) >= 0), 'commanded A never goes negative')
  const lastA = Math.max(...around.moves.map((move) => angleOf(move.to)))
  assert.ok(lastA > 360, `the around motion carries A past one turn (it ends at A${lastA.toFixed(1)})`)
}

// ---------------------------------------------------------------------------
// 7. Square blank: the slice-A refusal is gone (#1045 slice C supports it).
//    The square rules themselves -- per-sample touch radius, stub floor and the
//    output guard -- live in `rotarySquareAroundPasses.test.ts`.
// ---------------------------------------------------------------------------

{
  const mesh = prism(DIGEST_SQUARE, SQUARE_SECTION, [10, 30])
  const params = { ...RING_PARAMS, alongStart: 10, alongEnd: 30 }
  const rough = generateRotaryRough('square-around', mesh, DIGEST_SQUARE, FLAT, {
    ...params, stepdown: 3, passDirection: 'around',
  }, {})
  const finish = generateRotaryFinish('square-around', mesh, DIGEST_SQUARE, FLAT, {
    ...params, passDirection: 'around',
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
  assert.deepEqual(toolpath.warnings.map((warning) => warning.code), ['rotaryFinishWithoutRough'],
    'the finish-only program carries the no-rough advisory')
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
  // #1103 slice ca-c: A is one-way and grows across the operation. It is never
  // wrapped modulo 360, and there is no closing unwind (#1091 -- the controller
  // owns the A range). This is the posted-text half of that contract.
  for (const a of aWords) assert.ok(a >= 0, `posted A ${a} is not negative`)
  for (let i = 1; i < aWords.length; i++) {
    assert.ok(aWords[i] >= aWords[i - 1] - 1e-9,
      `posted A is never rewound (${aWords[i - 1]} -> ${aWords[i]})`)
  }
  assert.ok(Math.max(...aWords) > 360,
    `the program turns A past one revolution (it reaches A${Math.max(...aWords).toFixed(3)})`)
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
  // A ring-to-ring link changes the along coordinate at one angle; it is not a
  // ring sample and must not shift the layer count.
  const points = orderedCutPoints(moves.filter((move) => !isAlongLink(move)))
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
  // #1103 slice ca-d: the layer's full rings are one continuous helix, so its
  // cuts visit many along positions instead of three ring planes.
  assert.ok(new Set(points.map(alongOf)).size > 3,
    `the around band is cut continuously (${new Set(points.map(alongOf)).size} along positions)`)
  checkLayering('around', aroundLayers(result.moves, pivot))
}

{
  const pivot = barPivotZ(LAYER_STOCK)
  const result = generateRotaryRough('layer-along', LAYER_MESH, LAYER_STOCK, FLAT, {
    ...LAYER_PARAMS, stepdown: LAYER_STEPDOWN,
  }, {})
  assert.deepEqual(result.warnings, [], 'the along layering rough has no warning')
  // #1098: along layers alternate direction instead of adding a full turn, so A
  // no longer marks the layer. A cut tip lies inside its own disjoint band
  // `[layerRadius, previousRadius)`, which identifies the layer; travel-height
  // link rises (above the bar radius) are not cuts into a layer.
  const tips = orderedCutPoints(result.moves)
    .map((point) => point.z - pivot)
    .filter((tip) => tip < LAYER_BAR_RADIUS - 1e-9)
  const lowest = Math.min(...tips)
  const layers = Math.ceil((LAYER_BAR_RADIUS - lowest) / LAYER_STEPDOWN)
  checkLayering('along', tips.map((tip) => {
    let layer = 1
    for (let i = 1; i <= layers; i++) {
      const previous = LAYER_BAR_RADIUS - (i - 1) * LAYER_STEPDOWN
      const layerRadius = Math.max(lowest, LAYER_BAR_RADIUS - i * LAYER_STEPDOWN)
      if (tip >= layerRadius - 1e-6 && tip < previous - 1e-9) { layer = i; break }
    }
    return { layer, tip }
  }))
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
//
//     #1155 rn-e: a retained stub only stands at a band end that is **inside**
//     the model -- the approved rule lets the plain bar beyond the model's own
//     end be cut. The fixture's model therefore runs 16..44 with the band still
//     18..42, which is what an end support or a keep-out produces: the band's
//     ends are held inside the model, the radius-5 model at 16..18 and 42..44
//     sits under the radius-20 stubs, and the band's own geometry is unchanged.
// ---------------------------------------------------------------------------

console.log('Testing the retained round ends on around and along passes...')
{
  const stock = roundStock(40, 60, 'x', { x: 0, y: 0 })
  const pivot = barPivotZ(stock)
  const tool: NormalizedTool = { ...BALL, id: 'flat-6', name: '6 mm flat end mill', type: 'flat_endmill', radius: 3, diameter: 6 }
  const model = revolved(stock, [{ along: 16, radius: 5 }, { along: 44, radius: 5 }], 64)
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

// ---------------------------------------------------------------------------
// 13. Engrave control (#1103 slice ca-a).
//
//     A wrapped 2D Follow line on the Around sheet is not a rotary generator
//     path: it is the unrolled 2D pipeline re-wrapped, and this issue must not
//     touch it. Its generated motion and posted program are pinned here so a
//     later slice that changes the wrapping, the rotary frame or the post
//     emitter fails instead of silently moving an engrave.
//
//     The fixture is built by hand (the round bar a bar project always has, a
//     guide drawn on the Around face and a V-bit), so the control does not
//     depend on a user file. Programs are posted through the bundled grbl
//     definition plus an own-drive rotary block, with only the generation date
//     normalised. #1103 slice ca-h changed the posted text of every rotary
//     program — the operation now ends at 0 up — so the posted hash includes
//     that end turn/instruction; the *motion* hash is unchanged.
// ---------------------------------------------------------------------------
{
  const stock = roundStock(20, 60, 'x', { x: 0, y: 0 })
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const base = newProject('Engrave control', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 25
  base.stock = stock
  base.origin = { name: 'Origin', x: 0, y: 0, z: stock.thickness, visible: true }
  const tool: Tool = {
    ...defaultTool('mm', 1),
    id: 'vbit', name: '60 degree V-bit', type: 'v_bit', diameter: 2, vBitAngle: 60, units: 'mm',
  }
  base.tools = [tool]
  const guide: SketchFeature = {
    id: 'guide', name: 'Guide', kind: 'polygon', operation: 'line', authoringFace: 'around', folderId: null,
    sketch: {
      profile: {
        start: { x: 8, y: centre - 20 },
        segments: [
          { type: 'line', to: { x: 16, y: centre + 20 } },
          { type: 'line', to: { x: 24, y: centre - 20 } },
          { type: 'line', to: { x: 32, y: centre + 20 } },
          { type: 'line', to: { x: 40, y: centre - 20 } },
          { type: 'line', to: { x: 50, y: centre } },
        ],
        closed: false,
      },
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    z_top: pivot + 8, z_bottom: pivot + 7.5, visible: true, locked: false,
  }
  const project: Project = projectWithFeatures(base, [guide])
  project.setups.push({
    ...project.setups[0],
    id: 'around',
    name: 'Around',
    kind: 'around',
    orientation: { axis: 'x', angleDeg: 0 },
  })
  project.activeSetupId = 'around'
  const operation: Operation = {
    ...defaultOperationForTarget(project, 'follow_line', 'finish', { source: 'features', featureIds: [guide.id] }, 0),
    setupId: 'around',
    toolRef: 'vbit',
    carveDepth: 0.5,
    stepdown: 0.5,
    feed: 600,
    plungeFeed: 200,
    rpm: 16000,
  }
  project.operations = [operation]
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, 'the wrapped engrave generates')
  const moves = envelope.result.moves
  assert.deepEqual(envelope.result.warnings, [], 'the wrapped engrave has no warning')
  assert.ok(moves.some((move) => move.from.a !== undefined || move.to.a !== undefined),
    'the wrapped engrave carries A')
  const raw = BUNDLED_DEFINITIONS.find((definition) => definition.id === 'grbl')
  assert.ok(raw, 'the bundled grbl definition exists')
  const definition = validateMachineDefinition({
    ...structuredClone(raw),
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  const posted = runPostProcessor({
    project,
    definition,
    operations: [{
      operation,
      tool: normalizeToolForProject(tool, project),
      toolpath: envelope.result,
    }],
    options: { emitToolChanges: false, emitCoolant: false, programName: project.meta.name },
  })
  assert.deepEqual(posted.warnings, [], 'the wrapped engrave program posts without a refusal')
  assert.ok(/\bA-?\d/.test(posted.gcode), 'the engrave program carries A words')
  assert.ok(posted.gcode.includes('G93'), 'the engrave program selects inverse-time feed')
  const movesHash = digest(moves)
  const postedHash = createHash('sha256')
    .update(posted.gcode.replace(/(Generated by PureCutCNC on )\d{4}-\d{2}-\d{2}/, '$1<date>'))
    .digest('hex')
  assert.equal(movesHash, '403cf195253577fa89e466126de2d61e982de6f2336e29ba8b3cbb0c12ceb9fa',
    'the wrapped engrave motion is byte-identical')
  assert.equal(postedHash, '4112ed30cfa1e3eb77bb215e2094efaacb90c872f51e327d3dfdda517f367a43',
    'the wrapped engrave posted program carries only the #1103 ca-h end turn beyond its pre-slice bytes')
  console.log(`  engrave control: ${moves.length} moves, ${posted.stats.lineCount} program lines`)
}

console.log('rotary around passes tests passed')
