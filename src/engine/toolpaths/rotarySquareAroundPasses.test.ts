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
 * #1045 slice C: rotary passes **around** the bar on a **square** blank.
 *
 * Slice A refused an around pass on a square blank because a ring follows one
 * radius while a square blank's material changes with the angle. Slice C gives the ring the
 * square rules the along pass already had:
 *
 *  - a rough sample is cut only when its layer radius is below
 *    `squareRotaryTouchRadius` at **that sample's own angle**, so no layer is
 *    spent cutting air above a flat;
 *  - every sample is floored at its own exact retained-stub contact (the C2-F6
 *    floor) and the C2-F7 cutter-centre pull-in keeps the cutter body out of a
 *    stubbed end;
 *  - a rough ring never takes more than `stepdown` out of the material standing
 *    at its angle: a layer is exactly one `stepdown` below the layer above, and
 *    that layer either cut there (one stepdown lower) or skipped the sample
 *    because its standing material was already below its radius;
 *  - an around finish only follows the model (2026-10-22 decision): no clearing
 *    layers and no link to a rough. A raw blank, a disabled rough, a rough
 *    later in the list and an along rough over a retained end all generate the
 *    same finish motion; only the advisory `rotaryFinishWithoutRough` warning
 *    changes. The export check does not re-prove coverage from the program; the
 *    generator's safety is proven by `squareAroundGenerator.property.test.ts`.
 *
 * The export check (`motionPipeline.ts`, #1045 slice K) regenerates an
 * around-mode square operation for the current project and requires the motion
 * being posted to equal it move for move (same kinds, points within a relative
 * 1e-9, same order); anything else is `postSquareAroundToolpathStale`. That is
 * what admits a turning cut below `rotaryTravelZ`, where the turn is the cut: a
 * stale, hand-edited or borrowed toolpath is refused, while a turning **rapid**
 * in any mode and a turn on an along-mode operation keep
 * `postRotarySquareTurnBelowEnvelope`. Block 7 exercises the fresh, stale,
 * hand-edited and borrowed paths, the rapid and along-mode refusals, and a
 * non-rotary operation carrying A.
 *
 * The seeded property block builds its material model independently: the
 * blank's cross-section is sampled from the square's own boundary (never
 * `squareRotaryTouchRadius`), and it keeps a **two-dimensional**
 * along-bin by angle-bin standing map, lowered through the cutter footprint at
 * every sample of every move. The emitted rough is asserted never to cut above
 * that standing material or take more than one `stepdown` out of it at any
 * interior point. Since #1045 slice D the block also walks **every** move --
 * cuts, links, rapids and plunges -- at interior points plus both endpoints
 * against the model's independent safe tip, and requires every non-cut move
 * that turns the stock to stay at or above the travel height.
 *
 * Run with: npx tsx src/engine/toolpaths/rotarySquareAroundPasses.test.ts
 */

import assert from 'node:assert/strict'
import { computeMeshBounds, serializeImportedMesh } from '../importedMesh'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import type { BarStock, Operation, Project, SquareStock, Tool } from '../../types/project'
import { barCentre, barInscribedRadius, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import { projectWithFeatures } from '../../test/projectFixtures'
import { aroundFrame, unwrapToolpath } from '../aroundFrame'
import { computeOperationToolpath } from './generateOperation'
import { normalizeToolForProject } from './geometry'
import { generateRotaryFinish, generateRotaryRough } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import { squareRotaryStubContactFloor, squareRotaryTouchRadius } from './squareRotaryStock'
import type { NormalizedTool, ToolpathMove, ToolpathPoint } from './types'
import { applyMoveToGrid } from '../simulation/replay'
import { createSimulationGrid } from '../simulation/grid'
import { BUNDLED_DEFINITIONS } from '../gcode/definitions'
import { runPostProcessor } from '../gcode/postprocessor'
import { validateMachineDefinition } from '../gcode/types'
import type { MachineDefinition, PostProcessorResult } from '../gcode/types'

const GRBL = validateMachineDefinition(structuredClone(BUNDLED_DEFINITIONS.find((entry) => entry.id === 'grbl')!))
/** The bundled grbl machine with an own-drive rotary axis about the bar. */
const ROTARY = validateMachineDefinition({
  ...structuredClone(GRBL),
  rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
})

const BALL: NormalizedTool = {
  id: 'ball-3', name: '3 mm ball nose', sourceUnits: 'mm', units: 'mm',
  type: 'ball_endmill', diameter: 3, radius: 1.5, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}
const FLAT: NormalizedTool = { ...BALL, id: 'flat-4', name: '4 mm flat end mill', type: 'flat_endmill', diameter: 4, radius: 2 }

/** A closed surface of revolution around the bar's axis, one ring per entry. */
function revolved(stock: BarStock, rings: readonly { along: number; radius: number }[], segments: number): RotaryModelMesh {
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

/** A coaxial cylinder surface: a square-to-round model inside the blank. */
function cylinder(stock: BarStock, radius: number, from: number, to: number, segments = 96): RotaryModelMesh {
  return revolved(stock, [{ along: from, radius }, { along: to, radius }], segments)
}

/**
 * A closed box inside the blank, offset from the turning axis: material the
 * tool meets near one angle and misses at others, so a ring is genuinely split
 * rather than a full turn (#1093's A-changing link).
 */
function box(
  stock: BarStock,
  alongFrom: number,
  alongTo: number,
  acrossMin: number,
  acrossMax: number,
  upMin: number,
  upMax: number,
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const across = [acrossMin, acrossMax]
  const up = [upMin, upMax]
  const positions: number[] = []
  for (const along of [alongFrom, alongTo]) {
    for (const u of up) {
      for (const v of across) {
        if (stock.axis === 'x') positions.push(along, centre + v, pivot + u)
        else positions.push(centre + v, along, pivot + u)
      }
    }
  }
  // Vertex order: (along index, up index, across index) flattened.
  const vertex = (alongIndex: number, u: number, v: number): number => alongIndex * 4 + u * 2 + v
  const index = new Uint32Array([
    // alongFrom face
    vertex(0, 0, 0), vertex(0, 0, 1), vertex(0, 1, 1), vertex(0, 0, 0), vertex(0, 1, 1), vertex(0, 1, 0),
    // alongTo face
    vertex(1, 0, 0), vertex(1, 1, 1), vertex(1, 0, 1), vertex(1, 0, 0), vertex(1, 1, 0), vertex(1, 1, 1),
    // across faces
    vertex(0, 0, 0), vertex(1, 0, 0), vertex(1, 1, 0), vertex(0, 0, 0), vertex(1, 1, 0), vertex(0, 1, 0),
    vertex(0, 0, 1), vertex(0, 1, 1), vertex(1, 1, 1), vertex(0, 0, 1), vertex(1, 1, 1), vertex(1, 0, 1),
    // up faces
    vertex(0, 0, 0), vertex(0, 1, 0), vertex(1, 1, 0), vertex(0, 0, 0), vertex(1, 1, 0), vertex(1, 0, 0),
    vertex(0, 0, 1), vertex(1, 0, 1), vertex(1, 1, 1), vertex(0, 0, 1), vertex(1, 1, 1), vertex(0, 1, 1),
  ])
  return { positions: new Float32Array(positions), index }
}

const SQUARE = squareStock(20, 40, 'x', { x: 0, y: 0 })
const ROUND_RADIUS = 5
const SQUARE_MODEL = cylinder(SQUARE, ROUND_RADIUS, 12, 28)
const SQUARE_BASE = {
  stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 12, alongEnd: 28,
  safeRadius: 30, requestedCellSize: 0.05,
}
const TRAVEL_TIP = barMaxRadius(SQUARE) + 1

const tipOf = (point: ToolpathPoint): number => point.z - barPivotZ(SQUARE)
const angleOf = (point: ToolpathPoint): number => {
  assert.ok(point.a !== undefined, 'every rotary point carries A')
  return point.a
}
/**
 * A #1093 link leg: a cut at one angle. A ring's own vertical step is also one
 * angle; both are excluded from the ring-shape and touch-gate walks, which are
 * about the layer's turning cuts.
 */
const isConstantAngleCut = (move: ToolpathMove): boolean => move.kind === 'cut'
  && move.from.a !== undefined && move.to.a !== undefined && move.from.a === move.to.a
/** A ring-to-ring link's along feed: a cut at one angle that changes along. */
const isAlongLink = (move: ToolpathMove): boolean => isConstantAngleCut(move)
  && (move.from.x !== move.to.x || move.from.y !== move.to.y)

// ---------------------------------------------------------------------------
// 1. The slice-A refusal is gone: a square blank generates around passes.
// ---------------------------------------------------------------------------

console.log('Testing that a square blank generates around passes...')
{
  const rough = generateRotaryRough('square-rough', SQUARE_MODEL, SQUARE, FLAT, {
    ...SQUARE_BASE, stepdown: 2, passDirection: 'around',
  }, {})
  assert.deepEqual(rough.warnings, [], 'the square around rough has no warning')
  assert.ok(rough.moves.length > 0, 'the square around rough cuts')
  assert.ok(rough.bounds !== null, 'the square around rough has bounds')
  const finish = generateRotaryFinish('square-finish', SQUARE_MODEL, SQUARE, FLAT, {
    ...SQUARE_BASE, passDirection: 'around',
  }, {})
  assert.deepEqual(finish.warnings, [], 'the square around finish has no warning')
  assert.ok(finish.moves.length > 0, 'the square around finish cuts')
  // A rough has no full-depth-corner problem: its layers are bounded.
  for (const move of rough.moves) {
    for (const point of [move.from, move.to]) {
      const a = angleOf(point)
      assert.ok(a >= 0 && a <= 360, `rough A ${a} stays inside [0, 360]`)
    }
  }
  // Every ring is one along coordinate, and consecutive rings alternate.
  const rings: Array<{ along: number; direction: number }> = []
  for (const move of rough.moves) {
    if (move.kind !== 'cut' || isConstantAngleCut(move)) continue
    const along = move.from.x
    assert.equal(move.to.x, along, 'a ring cut never leaves its ring')
    const last = rings[rings.length - 1]
    const direction = Math.sign(angleOf(move.to) - angleOf(move.from))
    if (last && last.along === along) {
      if (last.direction === 0 && direction !== 0) last.direction = direction
    } else {
      rings.push({ along, direction })
    }
  }
  assert.ok(rings.length > 2, 'the around rough emits many rings')
  let forward = 0
  let reversed = 0
  for (let i = 0; i < rings.length; i++) {
    assert.notEqual(rings[i].direction, 0, `ring ${i} turns`)
    if (rings[i].direction > 0) forward++
    else reversed++
    // Rings alternate within a layer. Across a layer boundary the direction
    // also alternates by the generator's single ring counter, but a ring that
    // is all air at its layer emits no cut moves and is absent here, so the
    // parity only holds inside a layer (the along coordinate climbs).
    if (i > 0 && rings[i].along > rings[i - 1].along) {
      assert.equal(rings[i].direction, -rings[i - 1].direction, `ring ${i} runs opposite its predecessor`)
    }
  }
  assert.ok(forward > 0 && reversed > 0, 'both ring directions are emitted')
}

// ---------------------------------------------------------------------------
// 2. The per-sample touch radius: no cut point may stand above the blank's own
//    material at its angle. Without the gate a rough spends its first layers
//    cutting air above each flat -- which is exactly what the mutation that
//    skips the gate does.
// ---------------------------------------------------------------------------

console.log('Testing the square touch-radius gate on every cut point...')
{
  let probedTools = 0
  for (const tool of [FLAT, BALL]) {
    const rough = generateRotaryRough('gate-rough', SQUARE_MODEL, SQUARE, tool, {
      ...SQUARE_BASE, stepdown: 2, passDirection: 'around',
    }, {})
    let checked = 0
    for (const move of rough.moves) {
      // A link leg travels above the material this layer already left; the
      // touch gate is about a layer's own turning cut, not about the link.
      if (move.kind !== 'cut' || isConstantAngleCut(move)) continue
      for (const point of [move.from, move.to]) {
        const tip = tipOf(point)
        // The emitter's links are cuts at the travel height, above the blank;
        // a real layer never reaches the corner envelope.
        if (tip >= TRAVEL_TIP - 1e-9) continue
        const material = squareRotaryTouchRadius(SQUARE, angleOf(point), tool.radius, tool.type)
        // `squareRotaryTouchRadius` is the blank's radius along the sample's own
        // ray; the cutter's footprint also reaches material just off that ray
        // (a corner, or the retained stub one radius away), and since #1045
        // slice F the sampler reads that footprint support plus the conservative
        // cell pad, so a grazing cut can sit above the ray radius by that pad.
        // The gate being tested is the per-sample one that would otherwise emit
        // a whole layer (millimetres) above the material; the pad is a fraction
        // of the requested height-map cell.
        assert.ok(tip <= material + 0.06,
          `${tool.type}: cut at A ${angleOf(point).toFixed(2)} reaches ${tip.toFixed(4)}, above the blank material ${material.toFixed(4)}`)
        checked++
      }
    }
    assert.ok(checked > 100, `${tool.type}: the gate probe checked many cut points (${checked})`)
    probedTools++
  }
  assert.equal(probedTools, 2, 'both supported cutters were probed')
}

// ---------------------------------------------------------------------------
// 3. #1093: a split ring cannot stay down, so it retracts. Only a link that
//    joins a run ending at a ring end to a run starting at a ring start may
//    stay down; anything else keeps the old rapid/plunge, and an A-changing
//    link is never emitted by the new surface path (the link callback requires
//    the same physical angle). On a square blank that is also the corner
//    rule: a turn stays at the travel height.
// ---------------------------------------------------------------------------

console.log('Testing that a split square ring retracts instead of linking low...')
{
  // A small box offset above the axis: angle 0 meets it, most angles miss it,
  // so a ring is split into runs and cannot be linked end to end.
  const model = box(SQUARE, 12, 28, -1, 1, 6, 10)
  const finish = generateRotaryFinish('split-link', model, SQUARE, FLAT, {
    ...SQUARE_BASE, passDirection: 'around',
  }, {})
  // The offset box reaches below the turning centre at some angles, which is
  // the advisory this fixture legitimately carries; no other warning is.
  assert.ok(finish.warnings.every((warning) => warning.code === 'rotaryBelowCentreline'),
    'the split-ring finish carries only the below-centreline advisory')
  const plunges = finish.moves.filter((move) => move.kind === 'plunge').length
  assert.ok(plunges > 1,
    `a split ring retracts and plunges again rather than feeding at the surface (${plunges} plunges)`)
  const pivot = barPivotZ(SQUARE)
  for (const move of finish.moves) {
    if (!isAlongLink(move)) continue
    // The new link keeps the shared physical angle of the two ring ends (A0 or
    // A360); any other A change is the old travel link, which must stay at the
    // blank's corner envelope.
    if (move.from.a !== 0 && move.from.a !== 360) {
      assert.ok(move.from.z - pivot >= TRAVEL_TIP - 1e-9,
        `an A-changing square link turns at the corner envelope (${(move.from.z - pivot).toFixed(4)})`)
    }
  }
}

// ---------------------------------------------------------------------------
// 4. Seeded property: an independent square-material model.
//
//    The reference never calls `squareRotaryTouchRadius`. It samples the
//    square's own boundary densely (the material's height inside the cutter
//    slab) and keeps a **two-dimensional** standing-material map -- along bins
//    by angle bins, initialised from the blank -- lowering it through the
//    cutter footprint at every sample of every move (#1045 slice E). The map
//    has axial position and footprint, so a rough that covered only part of the
//    band cannot look complete.
//    Three assertions on the emitted around rough:
//      - no cut sample stands above the blank material at its own angle;
//      - every interior sample of a cut move takes at most `stepdown` out of
//        the standing material inside the cutter's footprint, which is the
//        review's "engagement at interior points of every move";
//      - no move point is below the model's analytic safe tip.
// ---------------------------------------------------------------------------

const PROP_SEEDS = 50
const PROP_SEGMENTS = 48
const SUPPORT_SAMPLES = 8192
const SLOPE_BOUND = 0.55
const REFERENCE_STEPS = 1200

let randomState = 0x1045c0de
function random(): number {
  randomState = (randomState + 0x6d2b79f5) >>> 0
  let t = randomState
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const between = (lo: number, hi: number): number => lo + (hi - lo) * random()

interface Profile {
  readonly xs: readonly number[]
  readonly rs: readonly number[]
}

/** A random revolved profile with bounded slope, sampled into rings for the mesh. */
function randomProfile(length: number, maxRadius: number): Profile {
  for (;;) {
    const xs = [0]
    for (let i = 0; i < 3; i++) xs.push(xs[xs.length - 1] + between(0.5, 0.9))
    xs[3] = length
    const rs = Array.from({ length: 4 }, () => between(0.3 * maxRadius, 0.6 * maxRadius))
    let ok = xs[3] > xs[2]
    for (let i = 1; i < 4 && ok; i++) {
      ok = Math.abs(rs[i] - rs[i - 1]) / (xs[i] - xs[i - 1]) <= SLOPE_BOUND - 1e-9
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

/** The analytic lowest safe tip of the revolved model at `x` (slice A's reference). */
function referenceTip(profile: Profile, x: number, tool: NormalizedTool): number {
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
  return best
}

/**
 * The reference blank material at `angleDeg`: the highest point of the square's
 * boundary that a cutter of `radius` can reach inside its cross-sectional slab.
 * `flat` reads the boundary's `y`; a ball reads `y - r + sqrt(r^2 - x^2)` (its
 * lower surface at that plane). The square's boundary is sampled densely, so
 * the maximum is found without any of the generator's closed-form helpers.
 */
function referenceSupport(halfSide: number, angleDeg: number, tool: NormalizedTool): number {
  const radians = angleDeg * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  let best = Number.NEGATIVE_INFINITY
  const corners: Array<readonly [number, number]> = [
    [-halfSide, -halfSide], [halfSide, -halfSide], [halfSide, halfSide], [-halfSide, halfSide],
  ]
  for (let e = 0; e < 4; e++) {
    const [au, av] = corners[e]
    const [bu, bv] = corners[(e + 1) % 4]
    for (let s = 0; s < SUPPORT_SAMPLES / 4; s++) {
      const f = s / (SUPPORT_SAMPLES / 4)
      const u = au + (bu - au) * f
      const v = av + (bv - av) * f
      const x = u * cos - v * sin
      const y = u * sin + v * cos
      if (Math.abs(x) > tool.radius) continue
      const height = tool.type === 'ball_endmill'
        ? y - tool.radius + Math.sqrt(Math.max(0, tool.radius * tool.radius - x * x))
        : y
      if (height > best) best = height
    }
  }
  return best
}

/** The reference's own resolution: adjacent boundary samples differ by less than this in height. */
const supportStep = (4 * 2 * 4.5) / SUPPORT_SAMPLES * Math.SQRT2

console.log(`Testing the ${PROP_SEEDS}-seed square around rough property...`)
{
  let checkedCuts = 0
  let checkedSamples = 0
  let checkedSeeds = 0
  let worstEngagement = -Infinity
  for (let seed = 0; seed < PROP_SEEDS; seed++) {
    const side = between(7, 9)
    const length = between(2.5, 3.2)
    const stock = squareStock(side, length, 'x', { x: 0, y: 0 })
    const half = barInscribedRadius(stock)
    const profile = randomProfile(length, half)
    const tool: NormalizedTool = {
      ...BALL,
      id: `prop-${seed}`,
      name: `prop-${seed}`,
      type: seed % 2 === 0 ? 'ball_endmill' : 'flat_endmill',
      radius: between(0.3, 0.6),
      diameter: 0,
    }
    tool.diameter = 2 * tool.radius
    const stepdown = between(0.6, 1.2)
    const cell = 0.06
    const mesh = revolved(stock, profile.xs.map((along, i) => ({ along, radius: profile.rs[i] })), PROP_SEGMENTS)
    const result = generateRotaryRough(`prop-${seed}`, mesh, stock, tool, {
      stepover: between(0.7, 1.1),
      sampleSpacing: between(0.5, 0.7),
      stockToLeave: 0,
      alongStart: 0,
      alongEnd: length,
      safeRadius: 20,
      requestedCellSize: cell,
      stepdown,
      passDirection: 'around',
    }, {})
    assert.deepEqual(result.warnings, [], `seed ${seed}: no warning`)
    const pivot = barPivotZ(stock)
    const travel = barMaxRadius(stock) + 1
    // The blank's own material radius along the ray at `angleDeg`, from the
    // square's half-side. Raw blank geometry, not the cutter's support: a cell
    // is the material standing there, and the cutter's footprint is applied
    // when a cut is read.
    const blankRadius = (angleDeg: number): number => {
      const radians = angleDeg * Math.PI / 180
      return half / Math.max(Math.abs(Math.cos(radians)), Math.abs(Math.sin(radians)))
    }
    // The highest blank material the cutter can touch at `angleDeg` (the
    // footprint-aware support) -- only for the "a cut never stands above the
    // blank" gate, because a ball's tip can sit above the ray radius while it
    // touches material earlier in its footprint.
    const supportCache = new Map<number, number>()
    const support = (angle: number): number => {
      let value = supportCache.get(angle)
      if (value === undefined) {
        value = referenceSupport(half, angle, tool)
        supportCache.set(angle, value)
      }
      return value
    }
    const referenceByAlong = new Map<number, number>()
    const referenceAt = (along: number): number => {
      let reference = referenceByAlong.get(along)
      if (reference === undefined) {
        reference = referenceTip(profile, along, tool)
        referenceByAlong.set(along, reference)
      }
      return reference
    }
    const allowance = SLOPE_BOUND * (cell + (2 * tool.radius) / REFERENCE_STEPS)
      + (tool.type === 'ball_endmill'
        ? tool.radius - Math.sqrt(Math.max(0, tool.radius * tool.radius - (cell * Math.SQRT2 / 2) ** 2))
        : 0)
      + supportStep
      + 1e-4
    // The reference's **standing-material map**. Unlike the slice-C block it is
    // two-dimensional -- along bins by angle bins -- because the review's
    // finding was exactly that one global tip cannot see a rough that covered
    // only part of the band. Its cells are the blank's own material (sampled
    // from the square boundary through the cutter footprint, never
    // `squareRotaryTouchRadius`), and every emitted cut lowers them through the
    // same footprint. A cut's engagement is read from the map *before* it is
    // lowered, at every interior sample of every move, so a bite hidden between
    // two safe endpoints is measured too.
    const referenceAngleBins = 720
    const referenceAngleBin = 360 / referenceAngleBins
    const alongLower = stock.axis === 'x' ? stock.profile.start.x : stock.profile.start.y
    const alongBins = Math.max(1, Math.ceil(length / (0.25 * tool.radius)))
    const alongBin = length / alongBins
    const standing = new Float64Array(alongBins * referenceAngleBins)
    for (let i = 0; i < alongBins; i++) {
      for (let k = 0; k < referenceAngleBins; k++) {
        standing[i * referenceAngleBins + k] = blankRadius((k + 0.5) * referenceAngleBin)
      }
    }
    const referenceCut = (along: number, angle: number, tip: number): number => {
      const i0 = Math.max(0, Math.floor((along - alongLower) / alongBin) - Math.ceil(tool.radius / alongBin) - 1)
      const i1 = Math.min(alongBins - 1, Math.floor((along - alongLower) / alongBin) + Math.ceil(tool.radius / alongBin) + 1)
      // Only cells whose material still stands above the tip can be touched, and
      // the widest angle that can hold them is `asin(r / tip)`; the same window
      // the old standing-material guard used, reached independently here. A full turn is needed only
      // for a tip at or below the axis.
      const halfSpan = tip > 0
        ? Math.ceil(Math.asin(Math.min(1, tool.radius / tip)) / (referenceAngleBin * Math.PI / 180)) + 1
        : Math.ceil(referenceAngleBins / 2)
      const baseBin = Math.floor(((angle % 360) + 360) % 360 / referenceAngleBin)
      let engagement = Number.NEGATIVE_INFINITY
      for (let i = i0; i <= i1; i++) {
        const dx = alongLower + (i + 0.5) * alongBin - along
        const remaining = tool.radius * tool.radius - dx * dx
        if (remaining <= 0) continue
        for (let o = -halfSpan; o <= halfSpan; o++) {
          const k = ((baseBin + o) % referenceAngleBins + referenceAngleBins) % referenceAngleBins
          const cellAngle = (k + 0.5) * referenceAngleBin
          const material = standing[i * referenceAngleBins + k]
          if (material <= tip) continue
          const offset = material * Math.sin((cellAngle - angle) * Math.PI / 180)
          if (offset * offset > remaining) continue
          const contact = tool.type === 'ball_endmill'
            ? tip + tool.radius - Math.sqrt(Math.max(0, remaining - offset * offset))
            : tip
          if (material - contact > engagement) engagement = material - contact
          if (contact < material) standing[i * referenceAngleBins + k] = contact
        }
      }
      return engagement
    }
    // The reference's own resolution: two angle bins' worth of the blank's
    // corner envelope (`barMaxRadius` covers the cusp's steepest change),
    // one along bin, and its boundary-sampling step.
    const gridAllowance = 2 * barMaxRadius(stock) * referenceAngleBin * Math.PI / 180
      + alongBin + supportStep + 1e-4
    let seedCuts = 0
    let seedSamples = 0
    for (const move of result.moves) {
      // A non-cut move that turns the stock must do it above the blank: the
      // link, retract and traverse heights are the whole reason a turning rapid
      // is safe, and lowering them to the pivot is the mutation this catches.
      if (move.kind !== 'cut' && move.from.a !== move.to.a) {
        for (const point of [move.from, move.to]) {
          assert.ok(point.z - pivot >= travel - 1e-9,
            `seed ${seed}: a non-cut turning move at A ${angleOf(point).toFixed(2)} travels at tip ${(point.z - pivot).toFixed(4)}, below the travel height ${travel}`)
        }
      }
      const alongOf = (point: ToolpathPoint): number => stock.axis === 'x' ? point.x : point.y
      const fromAlong = alongOf(move.from)
      const toAlong = alongOf(move.to)
      const fromAngle = angleOf(move.from)
      const toAngle = angleOf(move.to)
      // A #1093 ring-to-ring link travels above the material the earlier layers
      // left, so its destination is not a layer cut at the blank's support.
      const linkMove = isConstantAngleCut(move)
      const steps = Math.max(8,
        Math.ceil(Math.abs(toAngle - fromAngle) / referenceAngleBin),
        Math.ceil(Math.abs(toAlong - fromAlong) / alongBin))
      for (let step = 0; step <= steps; step++) {
        const f = step / steps
        const x = fromAlong + (toAlong - fromAlong) * f
        const tip = move.from.z + (move.to.z - move.from.z) * f - pivot
        const reference = referenceAt(x)
        assert.ok(Number.isFinite(reference), `seed ${seed}: the model reference at x ${x.toFixed(3)} is finite`)
        assert.ok(tip >= reference - allowance,
          `seed ${seed} ${tool.type} ${move.kind}: tip ${tip.toFixed(4)} at x ${x.toFixed(3)} f=${f} is below the model reference ${reference.toFixed(4)} by more than ${allowance.toFixed(4)}`)
        seedSamples++
        if (move.kind === 'rapid') continue
        // Only a sample under the blank's envelope removes material; a link at
        // the travel height is in air and no cell is lowered by it.
        if (tip >= travel - 1e-9) continue
        const angle = fromAngle + (toAngle - fromAngle) * f
        // The touch gate is a question about a *cut's* destination, exactly as
        // before: a plunge's or a link's straight leg passes above the blank on
        // its way down from the travel height, and that is not a cut there.
        if (step === steps && !linkMove) {
          assert.ok(tip < support(angle) + supportStep + 1e-9,
            `seed ${seed}: cut at x ${x.toFixed(3)} A ${angle.toFixed(2)} reaches ${tip.toFixed(4)}, above the blank material ${support(angle).toFixed(4)}`)
        }
        const engagement = referenceCut(x, angle, tip)
        if (engagement > stepdown + gridAllowance) {
          assert.fail(`seed ${seed} ${tool.type}: engagement ${engagement.toFixed(4)} at x ${x.toFixed(3)} A ${angle.toFixed(2)} f=${f} exceeds stepdown ${stepdown.toFixed(4)} + ${gridAllowance.toFixed(4)}`)
        }
        if (Number.isFinite(engagement)) worstEngagement = Math.max(worstEngagement, engagement)
        seedCuts++
      }
    }
    assert.ok(seedCuts > 0, `seed ${seed}: the rough cuts something`)
    checkedCuts += seedCuts
    checkedSamples += seedSamples
    checkedSeeds++
  }
  assert.ok(checkedSeeds === PROP_SEEDS, `the property ran all ${PROP_SEEDS} seeds`)
  console.log(`  ${PROP_SEEDS} seeds, ${checkedCuts} cut samples and ${checkedSamples} move samples; worst axial engagement ${worstEngagement.toFixed(4)}`)
}

// ---------------------------------------------------------------------------
// 5. Shoulder: the retained square ends are never entered, on forward and
//    reversed rings. The measure is the cutter body's exact contact against the
//    retained prism (`squareRotaryStubContactFloor`) at each cut point's own
//    angle and axial gap; the C2-F7 pull-in keeps the centre a cutter radius
//    off each face, so the floor is the net it is.
// ---------------------------------------------------------------------------

console.log('Testing the retained-square shoulders on both ring directions...')
{
  const rough = generateRotaryRough('shoulder-rough', SQUARE_MODEL, SQUARE, FLAT, {
    ...SQUARE_BASE, stepdown: 2, passDirection: 'around',
  }, {})
  const finish = generateRotaryFinish('shoulder-finish', SQUARE_MODEL, SQUARE, FLAT, {
    ...SQUARE_BASE, passDirection: 'around',
  }, {})
  const pulled = { start: SQUARE_BASE.alongStart + FLAT.radius, end: SQUARE_BASE.alongEnd - FLAT.radius }
  let forwardRings = 0
  let reversedRings = 0
  for (const [label, result] of [['rough', rough], ['finish', finish]] as const) {
    let previousDirection = 0
    let previousAlong = Number.NaN
    for (const move of result.moves) {
      if (move.kind !== 'cut') continue
      const along = move.from.x
      const direction = Math.sign(angleOf(move.to) - angleOf(move.from))
      if (along !== previousAlong) {
        if (previousDirection > 0) forwardRings++
        else if (previousDirection < 0) reversedRings++
        previousDirection = 0
        previousAlong = along
      }
      if (previousDirection === 0 && direction !== 0) previousDirection = direction
      for (const point of [move.from, move.to]) {
        const tip = tipOf(point)
        if (tip >= TRAVEL_TIP - 1e-9) continue
        const a = angleOf(point)
        const x = point.x
        assert.ok(x >= pulled.start - 1e-9 && x <= pulled.end + 1e-9,
          `${label}: the cutter centre at x ${x.toFixed(3)} stays a radius inside both stub faces`)
        for (const face of [SQUARE_BASE.alongStart, SQUARE_BASE.alongEnd]) {
          const gap = Math.abs(x - face)
          const floor = squareRotaryStubContactFloor(SQUARE, a, FLAT.radius, FLAT.type, gap)
          if (!Number.isFinite(floor)) continue
          assert.ok(tip >= floor - 1e-9,
            `${label}: cut ${tip.toFixed(4)} at x ${x.toFixed(3)} A ${a.toFixed(2)} enters the retained stub (floor ${floor.toFixed(4)})`)
        }
      }
    }
    if (previousDirection > 0) forwardRings++
    else if (previousDirection < 0) reversedRings++
  }
  assert.ok(forwardRings > 0, 'forward rings were measured')
  assert.ok(reversedRings > 0, 'reversed rings were measured')
  console.log(`  forward rings ${forwardRings}, reversed rings ${reversedRings}`)
}

// ---------------------------------------------------------------------------
// 5b. Missing model under the tool (#1045 slice D, finding 3).
//
//     Part of the band has no model under the tool. A square blank's rough
//     still removes the standing blank there, down to the axis fallback -- or
//     the retained-stub floor where one reaches -- exactly as the along rough
//     does. A mutation that leaves the blank untouched in that band would
//     otherwise still pass every cut-point check, because the empty band emits
//     nothing to check.
// ---------------------------------------------------------------------------

console.log('Testing the square around rough on a band with no model under the tool...')
{
  const stock = squareStock(20, 40, 'x', { x: 0, y: 0 })
  const pivot = barPivotZ(stock)
  const model = cylinder(stock, 5, 12, 28)
  const result = generateRotaryRough('square-nan', model, stock, FLAT, {
    stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 5, alongEnd: 35,
    safeRadius: 30, requestedCellSize: 0.1, stepdown: 2, passDirection: 'around',
  }, {})
  assert.deepEqual(result.warnings, [], 'the missing-model square rough has no warning')
  const cuts = result.moves.filter((move) => move.kind === 'cut').flatMap((move) => [move.from, move.to])
  // The cutter centre is pulled one radius inside the lower stub face (5 + 2 =
  // 7); the model starts at 12. Sample the empty band away from the pull's own
  // tangency so the stub floor (if any) is not what is being measured.
  const empty = cuts.filter((point) => point.x > 7.2 && point.x < 11.8)
  assert.ok(empty.length > 0, 'the empty band is cut')
  const lowest = Math.min(...empty.map((point) => point.z - pivot))
  assert.ok(lowest <= 1e-6,
    `the rough removes the blank to the axis fallback in the empty band (lowest ${lowest.toFixed(4)})`)
  for (const point of cuts) {
    if (point.x < 12 - 1e-9 || point.x > 28 + 1e-9) continue
    assert.ok(point.z - pivot >= 5 - 0.15,
      `the modelled band is not cut below its 5 mm radius (tip ${(point.z - pivot).toFixed(4)})`)
  }
  console.log(`  ${empty.length} cut endpoints in the empty band, lowest tip ${lowest.toFixed(4)}`)
}

// ---------------------------------------------------------------------------
// Project fixture: a real square rotary project, used by the adapter and output
// export-check blocks below.
// ---------------------------------------------------------------------------

type Axis = 'x' | 'y'

interface Fixture {
  project: Project
  stock: SquareStock
}

function fixture(axis: Axis = 'x', direction: 'around' | 'along' = 'around', chuckSupport = 0): Fixture {
  const stock = squareStock(20, 40, axis, { x: 0, y: 0 })
  // The model as the project sees it: the same square-to-round section, placed
  // on the stock's own axis (a Y bar swaps the across coordinate).
  const model = cylinder(stock, ROUND_RADIUS, 12, 28)
  const base = newProject('Square around', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 25
  base.stock = stock
  base.origin = { name: 'Origin', x: 0, y: 0, z: stock.thickness, visible: true }
  const tool: Tool = {
    ...defaultTool('mm', 1),
    id: 't1',
    name: 'Flat 4',
    units: 'mm',
    type: 'flat_endmill',
    diameter: 4,
    defaultStepover: 0.5,
    defaultStepdown: 1,
  }
  base.tools = [tool]
  base.modelAssets = {
    asset: serializeImportedMesh(
      { positions: model.positions, index: model.index, bounds: computeMeshBounds(model.positions) },
      'stl',
    ),
  }
  const centre = barCentre(stock)
  const modelFeature = {
    id: 'model', name: 'Model', kind: 'stl' as const, operation: 'model' as const, authoringFace: 'top' as const,
    folderId: null,
    sketch: {
      profile: rectProfile(12, centre - ROUND_RADIUS, 16, 2 * ROUND_RADIUS),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    stl: { format: 'stl' as const, meshAssetId: 'asset', scale: 1, axisSwap: 'none' as const },
    z_top: barPivotZ(stock) + ROUND_RADIUS, z_bottom: barPivotZ(stock) - ROUND_RADIUS,
    visible: true, locked: false,
  }
  const project = projectWithFeatures(base, [modelFeature])
  project.setups.push({ ...project.setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis, angleDeg: 0 } })
  project.activeSetupId = 'around'
  project.clamps = [{ ...defaultRoundWorkholding('chuck', stock, 'mm'), id: 'chuck', name: 'Chuck', visible: true }]
  const target = { source: 'features' as const, featureIds: ['model'] }
  const rough: Operation = {
    ...defaultOperationForTarget(project, 'rotary_rough', 'rough', target, 0),
    setupId: 'around',
    rotaryPassDirection: direction,
    stockToLeaveRadial: 0,
    stepdown: 2,
    stepover: 0.5,
    ...(chuckSupport > 0 ? { rotaryChuckSupport: chuckSupport } : {}),
  }
  const finish: Operation = {
    ...defaultOperationForTarget(project, 'rotary_finish', 'finish', target, 1),
    setupId: 'around',
    rotaryPassDirection: direction,
    stockToLeaveRadial: 0,
    stepover: 0.5,
  }
  project.operations = [rough, finish]
  return { project, stock }
}

function toolpathOf(operation: Operation, moves: ToolpathMove[]): { operationId: string; moves: ToolpathMove[]; warnings: []; bounds: null } {
  return { operationId: operation.id, moves, warnings: [], bounds: null }
}

function post(
  project: Project,
  definition: MachineDefinition,
  entries: Array<{ operation: Operation; moves: ToolpathMove[] }>,
): PostProcessorResult {
  return runPostProcessor({
    project,
    definition,
    operations: entries.map(({ operation, moves }) => ({
      operation,
      tool: normalizeToolForProject(project.tools.find((tool) => tool.id === operation.toolRef)!, project),
      toolpath: toolpathOf(operation, moves),
    })),
    options: { emitToolChanges: false, emitCoolant: false, programName: project.meta.name },
  })
}

// ---------------------------------------------------------------------------
// 6. Generation through the production adapter (2026-10-22 decision): a square
//    around finish only follows the model, so its motion is identical whether
//    an earlier rough exists, is disabled, sits on another target, comes later,
//    or is an along rough over a retained end. The operation list only changes
//    the advisory warning: an enabled rotary rough on the same model earlier in
//    the same setup suppresses it; everything else keeps it.
// ---------------------------------------------------------------------------

console.log('Testing the adapter\'s model-only around finish and its advisory...')
{
  const { project } = fixture()
  const [rough, finish] = project.operations
  const roughEnvelope = computeOperationToolpath(project, rough)
  assert.ok(roughEnvelope, 'the around rough generates through the dispatch')
  assert.deepEqual(roughEnvelope!.result.warnings, [], 'the around rough warns about nothing')
  assert.ok(roughEnvelope!.result.moves.length > 0, 'the around rough cuts')

  const finishEnvelope = computeOperationToolpath(project, finish)
  assert.ok(finishEnvelope, 'the around finish generates through the dispatch')
  assert.deepEqual(finishEnvelope!.result.warnings, [], 'a finish after its rough warns about nothing')
  assert.ok(finishEnvelope!.result.moves.length > 0, 'the around finish cuts')
  const expected = finishEnvelope!.result.moves

  const same = (candidate: Project, label: string, warned: boolean): void => {
    const result = computeOperationToolpath(candidate, finish)
    assert.ok(result, `${label}: the finish is a result, not a missing envelope`)
    assert.deepEqual(result!.result.moves, expected, `${label}: the finish's own motion is unchanged`)
    assert.deepEqual(result!.result.warnings.map((warning) => warning.code),
      warned ? ['rotaryFinishWithoutRough'] : [],
      `${label}: ${warned ? 'the finish warns that it cuts full depth' : 'the preceding rough suppresses the warning'}`)
  }

  // Remove the rough: the finish is the same operation on the raw blank, and it
  // says it will cut to full depth in one pass.
  same({ ...project, operations: [finish] }, 'no rough at all', true)
  // A disabled rough, one on another target, and one later in the list.
  same({ ...project, operations: [{ ...rough, enabled: false }, finish] }, 'a disabled rough', true)
  same({ ...project, operations: [{ ...rough, target: { source: 'stock' } }, finish] }, 'a rough on another target', true)
  same({ ...project, operations: [finish, rough] }, 'a rough later in the list', true)
  // An **along** rough over the retained end still precedes the finish on the
  // same model, so the advisory is suppressed even though the finish motion is
  // the same either way.
  same({ ...project, operations: [{ ...rough, rotaryPassDirection: 'along' as const }, finish] },
    'an along rough over a retained end', false)
  const supported = fixture('x', 'around', 20)
  same({ ...supported.project, operations: [supported.project.operations[1]] }, 'a rough held back by its chuck support', true)
  // An enabled rough with a zero stepdown still precedes the finish; the
  // advisory is about the operation list, not about whether the rough emitted
  // motion.
  same({ ...project, operations: [{ ...rough, stepdown: 0 }, finish] }, 'a zero-stepdown rough', false)
  same({ ...project, operations: [{ ...rough, stockToLeaveRadial: 5 }, { ...finish, stockToLeaveRadial: 0 }] },
    'a rough leaving 5 mm above a zero-allowance finish', false)
}

// ---------------------------------------------------------------------------
// 7. The export check (#1045 slice K): around mode turns below the blank's
//    corner envelope because the turn is the cut, so the threat the check
//    exists for is a stale or hand-edited toolpath, not a safe program the
//    generator emitted. An around-mode square operation regenerates its own
//    motion for the current project and must match it move for move; a turning
//    rapid in any mode, and a turn on an along-mode operation, keep the old
//    height refusal.
// ---------------------------------------------------------------------------

console.log('Testing the square around export check...')
{
  const { project, stock } = fixture()
  const [rough, finish] = project.operations
  const roughResult = computeOperationToolpath(project, rough)!.result
  const finishResult = computeOperationToolpath(project, finish)!.result
  assert.deepEqual(roughResult.warnings, [])
  assert.deepEqual(finishResult.warnings, [])
  const codesOf = (result: PostProcessorResult): string[] => result.warnings.map((warning) => warning.code)

  // The freshly generated rough and rough+finish both post.
  const roughProgram = post(project, ROTARY, [{ operation: rough, moves: roughResult.moves }])
  assert.deepEqual(roughProgram.warnings, [], 'the freshly generated around rough posts')
  assert.ok(/A-?\d/.test(roughProgram.gcode), 'and carries A words')
  const aWords = [...roughProgram.gcode.matchAll(/A(-?\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]))
  for (const a of aWords) assert.ok(a >= 0 && a <= 360, `posted A ${a} stays inside [0, 360]`)
  const both = post(project, ROTARY, [
    { operation: rough, moves: roughResult.moves },
    { operation: finish, moves: finishResult.moves },
  ])
  assert.deepEqual(both.warnings, [], 'the freshly generated around rough followed by its finish posts')

  // A **stale** path: the project's stepdown changed after this toolpath was
  // generated, so regenerating now produces different layers than the moves
  // being posted. Refused, naming the stale path rather than the geometry.
  const steeperProject: Project = {
    ...project,
    operations: project.operations.map((entry) =>
      entry.id === rough.id ? { ...entry, stepdown: entry.stepdown + 0.5 } : entry),
  }
  const steeperRough = steeperProject.operations[0]
  assert.deepEqual(
    codesOf(post(steeperProject, ROTARY, [{ operation: steeperRough, moves: roughResult.moves }])),
    ['postSquareAroundToolpathStale'],
    'a toolpath generated before a stepdown change is refused as stale',
  )

  // A **hand-edited** path: one cut point moved 0.5 mm deeper.
  const edited: ToolpathMove[] = structuredClone(roughResult.moves)
  let editedOne = false
  for (const move of edited) {
    if (move.kind !== 'cut' || move.from.a === move.to.a) continue
    move.from = { ...move.from, z: move.from.z - 0.5 }
    editedOne = true
    break
  }
  assert.ok(editedOne, 'the fixture edited one cut point')
  assert.deepEqual(codesOf(post(project, ROTARY, [{ operation: rough, moves: edited }])),
    ['postSquareAroundToolpathStale'], 'a hand-edited around toolpath is refused as stale')

  // **Another operation's** toolpath posted as this one.
  assert.deepEqual(codesOf(post(project, ROTARY, [{ operation: rough, moves: finishResult.moves }])),
    ['postSquareAroundToolpathStale'], "another operation's toolpath is refused as stale")

  // #1045 slice L, finding 4: the comparison is exact. A coordinate edited by
  // 1e-9 mm must not pass; at a number-format rounding boundary such an edit
  // changes the emitted word.
  const nudged = structuredClone(roughResult.moves)
  const nudgedCut = nudged.find((move) => move.kind === 'cut')
  assert.ok(nudgedCut, 'the fixture has a cut to nudge')
  nudgedCut.from = { ...nudgedCut.from, z: nudgedCut.from.z + 1e-9 }
  assert.deepEqual(codesOf(post(project, ROTARY, [{ operation: rough, moves: nudged }])),
    ['postSquareAroundToolpathStale'], 'a 1e-9 mm coordinate edit is refused as stale')

  // The finish now only follows the model, so exporting it without its rough
  // (or with the rough after it) is a legitimate program; the post carries no
  // warning of its own. Regenerate-and-match still proves each posted path is
  // the generator's own current motion.
  assert.deepEqual(codesOf(post(project, ROTARY, [{ operation: finish, moves: finishResult.moves }])),
    [], 'the finish without its rough posts')
  assert.deepEqual(codesOf(post(project, ROTARY, [
    { operation: finish, moves: finishResult.moves },
    { operation: rough, moves: roughResult.moves },
  ])), [], 'a rough exported after the finish posts too')

  // An along-mode operation is never regenerate-and-matched: its turns are all
  // at the travel height. Its generated moves post unchanged.
  const alongFixture = fixture('x', 'along')
  const alongOp = alongFixture.project.operations[0]
  const alongResult = computeOperationToolpath(alongFixture.project, alongOp)!.result
  assert.deepEqual(
    post(alongFixture.project, ROTARY, [{ operation: alongOp, moves: alongResult.moves }]).warnings,
    [],
    'the generated along-mode square rough posts',
  )

  // An along rough followed by an around finish over the retained end: the
  // finish only follows the model, so the mixed program posts both operations.
  const mixedProject: Project = {
    ...project,
    operations: [{ ...rough, rotaryPassDirection: 'along' as const }, finish],
  }
  const mixedFinish = computeOperationToolpath(mixedProject, finish)
  assert.deepEqual(mixedFinish!.result.warnings, [], 'an enabled rough before the finish suppresses the advisory')
  assert.ok(mixedFinish!.result.moves.length > 0, 'and cuts')

  // A turning **rapid** below the travel height is refused in every mode: it
  // removes nothing and swings the standing corner into the cutter.
  const centre = barCentre(stock)
  const travel = barPivotZ(stock) + barMaxRadius(stock) + 1
  const lowTurn: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 20, y: centre, z: travel + 2, a: 0 }, to: { x: 20, y: centre, z: travel + 2, a: 0 } },
    { kind: 'rapid', from: { x: 20, y: centre, z: travel - 2, a: 0 }, to: { x: 20, y: centre, z: travel - 2, a: 30 } },
  ]
  assert.deepEqual(codesOf(post(project, ROTARY, [{ operation: rough, moves: lowTurn }])),
    ['postRotarySquareTurnBelowEnvelope'], 'a turning rapid below the height is refused in around mode')
  assert.deepEqual(codesOf(post(alongFixture.project, ROTARY, [{ operation: alongOp, moves: lowTurn }])),
    ['postRotarySquareTurnBelowEnvelope'], 'a turning rapid below the height is refused in along mode')

  // The same turn as a **cut** on an along-mode operation is refused: only an
  // around-mode cut may turn below the height, and only with the generator's
  // own current motion.
  const alongStock = alongFixture.stock
  const alongCentre = barCentre(alongStock)
  const alongCut: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 20, y: alongCentre, z: travel + 2, a: 0 }, to: { x: 20, y: alongCentre, z: travel + 2, a: 0 } },
    { kind: 'cut', from: { x: 20, y: alongCentre, z: travel - 2, a: 0 }, to: { x: 20, y: alongCentre, z: travel - 2, a: 3 } },
  ]
  assert.deepEqual(codesOf(post(alongFixture.project, ROTARY, [{ operation: alongOp, moves: alongCut }])),
    ['postRotarySquareTurnBelowEnvelope'], 'an along-mode turning cut below the height is refused')

  // A non-rotary operation carrying A keeps its semantic refusal.
  const engrave: Operation = { ...rough, kind: 'follow_line' }
  assert.deepEqual(codesOf(post(project, ROTARY, [{ operation: engrave, moves: roughResult.moves }])),
    ['postSetupOperationRefused'], 'a non-rotary operation carrying A is refused')
}

// ---------------------------------------------------------------------------
// 8. Round bars stay frozen: an around finish on a round bar is not given the
//    square export check, and the same kind of low turning cut still posts there.
// ---------------------------------------------------------------------------

console.log('Testing that round-bar output is untouched...')
{
  const { project, stock } = fixture()
  const roundStock = { ...stock, shape: 'round' as const } as unknown as Project['stock']
  const roundProject: Project = { ...project, stock: roundStock }
  // The round copy drops the square's Around-specific physical guard.
  const operation = roundProject.operations[0]
  const centre = barCentre(roundStock as SquareStock)
  const travel = barPivotZ(roundStock as SquareStock) + 20
  const lowTurn: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 20, y: centre, z: travel + 2, a: 0 }, to: { x: 20, y: centre, z: travel + 2, a: 0 } },
    { kind: 'cut', from: { x: 20, y: centre, z: travel - 2, a: 0 }, to: { x: 20, y: centre, z: travel - 2, a: 3 } },
  ]
  const result = post(roundProject, ROTARY, [{ operation, moves: lowTurn }])
  assert.ok(!result.warnings.some((warning) => warning.code === 'postRotarySquareTurnBelowEnvelope'),
    'a round bar is not given the square turn guard')
}

// ---------------------------------------------------------------------------
// 9. Simulation: the square material path renders around-mode rings (turning
//    cuts). The replay is the same returned-heightfield kernel every blank uses;
//    what is specific here is that a ring's cut moves change A while their
//    along is constant, so the sheet-space replay must lower the cells the ring
//    sweeps and never raise one.
// ---------------------------------------------------------------------------

console.log('Testing the square simulation path on around-mode rings...')
{
  const side = 20
  const frame = aroundFrame(SQUARE)
  const circumference = Math.PI * side
  const sheet = newProject('square around sim', 'mm')
  sheet.stock = {
    ...sheet.stock,
    profile: rectProfile(0, frame.zero - circumference / 2, 40, circumference),
    thickness: side / 2,
  }
  const grid = createSimulationGrid(sheet, { squareBar: { side, frame }, targetLongAxisCells: 96 })
  const rough = generateRotaryRough('sim-rough', SQUARE_MODEL, SQUARE, FLAT, {
    ...SQUARE_BASE, stepdown: 2, passDirection: 'around',
  }, {})
  const unwrapped = unwrapToolpath(rough, frame)
  let removed = 0
  for (const move of unwrapped.moves) {
    if (move.kind !== 'cut' && move.kind !== 'plunge') continue
    const result = applyMoveToGrid(grid, move, FLAT.radius, FLAT.type, null)
    removed += result.changedCount
  }
  assert.ok(removed > 0, 'the around rough lowers cells in the square replay')
  let raised = 0
  const baseline = grid.initialTopZ!
  let changed = 0
  for (let i = 0; i < grid.topZ.length; i++) {
    if (grid.topZ[i] > baseline[i] + 1e-9) raised++
    if (baseline[i] - grid.topZ[i] > 1e-9) changed++
  }
  assert.equal(raised, 0, 'no square replay cell is raised')
  assert.ok(changed > 0, 'the replay changed cells')
  // The machined band is lowered and the retained ends keep the blank. The
  // sheet's along coordinate is the project X, offset by the grid origin.
  const alongOrigin = grid.originX
  const alongCount = grid.cols
  const bandCell = Math.min(alongCount - 1, Math.round((20 - alongOrigin) / grid.cellSize - 0.5))
  const endCell = Math.max(0, Math.round((2 - alongOrigin) / grid.cellSize - 0.5))
  const row = Math.floor(grid.rows / 2)
  const bandZ = grid.topZ[row * grid.cols + bandCell]
  const endZ = grid.topZ[row * grid.cols + endCell]
  assert.ok(bandZ < endZ - 0.5, `the machined band is lower than the retained end (${bandZ} < ${endZ})`)
  console.log(`  around replay lowered ${changed} cells, none raised; band ${bandZ.toFixed(3)} vs end ${endZ.toFixed(3)}`)
}

console.log('rotary square around passes tests passed')
