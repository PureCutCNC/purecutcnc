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
 *  - an around finish with no rough in front of it may still take a full-depth
 *    corner bite out of a **raw** blank: since #1045 slice E the generator
 *    emits it and warns (`rotarySquareFinishNeedsRough`), because only the
 *    export guard sees the material the program's earlier operations actually
 *    removed.
 *
 * The output guard (`src/engine/gcode/squareSweepGuard.ts`, asked from
 * `motionPipeline.ts`) keeps one standing-material grid for the whole program
 * -- along-bar bins by angle bins, initialised from the raw blank -- and walks
 * every move of every square turning operation through it. A turning **cut**
 * below `rotaryTravelZ` is admitted only when the material inside the cutter's
 * footprint at every interior sample of the actual commanded motion is within
 * the operation's bound: `stepdown` for a rough, `stockToLeaveRadial` plus the
 * scallop of the strongest earlier rough on the same target for a finish.
 * Rapids, along-mode turns and a cut that takes more than the bound keep
 * refusing. The three Codex review-pass-2 reproductions live at the end of
 * block 7: a chuck-support-limited rough cannot license the finish across the
 * band it never reached, an A0 -> A90 cut at tip radius 9 takes the 14.14 mm
 * corner at A45 in its interior, and A0 -> A360 is judged as the full
 * revolution the controller makes rather than a zero-span shortcut.
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

/** A closed extrusion of `section` over `ends`, the blank's own square prism for a square section. */
function prism(
  stock: BarStock,
  section: readonly (readonly [number, number])[],
  ends: readonly [number, number],
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const along of ends) {
    for (const [across, up] of section) {
      if (stock.axis === 'x') positions.push(along, centre + across, pivot + up)
      else positions.push(centre + across, along, pivot + up)
    }
  }
  const n = section.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    index.push(i, j, n + j, i, n + j, n + i)
  }
  for (let i = 1; i < n - 1; i++) index.push(0, i + 1, i, n, n + i, n + i + 1)
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/** A coaxial cylinder surface: a square-to-round model inside the blank. */
function cylinder(stock: BarStock, radius: number, from: number, to: number, segments = 96): RotaryModelMesh {
  return revolved(stock, [{ along: from, radius }, { along: to, radius }], segments)
}

const SQUARE = squareStock(20, 40, 'x', { x: 0, y: 0 })
const HALF = barInscribedRadius(SQUARE)
const SQUARE_SECTION = [[-HALF, -HALF], [HALF, -HALF], [HALF, HALF], [-HALF, HALF]] as const
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
    ...SQUARE_BASE, passDirection: 'around', squareRoughBefore: true,
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
    if (move.kind !== 'cut') continue
    const along = move.from.x
    assert.equal(move.to.x, along, 'a cut move never leaves its ring')
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
      if (move.kind !== 'cut') continue
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
// 3. The around finish advisory rule (#1045 slice E).
//
//    A finish follows the model. On a **raw** square blank the corners stand
//    whole layers above it, so its first ring would take a full-depth corner
//    bite. Since slice E the generator no longer refuses that: it emits the
//    motion and warns `rotarySquareFinishNeedsRough`, because the export guard
//    is the authority (only it sees the material the program's earlier
//    operations actually removed). A finish told an earlier enabled rough runs
//    (`squareRoughBefore`) warns about nothing, and a model equal to the
//    blank's own surface has no material above the tip beyond the stock it
//    leaves, so it needs no rough and warns about nothing either.
// ---------------------------------------------------------------------------

console.log('Testing the around finish advisory rule...')
{
  const raw = generateRotaryFinish('finish-raw', SQUARE_MODEL, SQUARE, FLAT, {
    ...SQUARE_BASE, passDirection: 'around',
  }, {})
  assert.ok(raw.moves.length > 0, 'a finish on a raw square blank still generates (the guard decides at export)')
  assert.deepEqual(raw.warnings.map((warning) => warning.code),
    ['rotarySquareFinishNeedsRough'], 'and warns that a rough should run first')
  assert.ok(raw.bounds !== null, 'and has bounds')

  const roughed = generateRotaryFinish('finish-roughed', SQUARE_MODEL, SQUARE, FLAT, {
    ...SQUARE_BASE, passDirection: 'around', squareRoughBefore: true,
  }, {})
  assert.deepEqual(roughed.warnings, [], 'the same finish with an earlier rough warns about nothing')
  assert.ok(roughed.moves.length > 0, 'and cuts')

  // The blank itself as the model: no material stands above the tip beyond the
  // stock the operation leaves, so no rough is needed.
  const blankModel = prism(SQUARE, SQUARE_SECTION, [0, 40])
  const nearNet = generateRotaryFinish('finish-near-net', blankModel, SQUARE, FLAT, {
    stepover: 4, sampleSpacing: 2, stockToLeave: 0, alongStart: 0, alongEnd: 40,
    safeRadius: 40, requestedCellSize: 0.2, passDirection: 'around',
  }, {})
  assert.deepEqual(nearNet.warnings, [], 'a finish on a blank already at its model needs no rough and warns about nothing')
  assert.ok(nearNet.moves.length > 0, 'and cuts')
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
      // the guard uses, reached independently here. A full turn is needed only
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
        if (step === steps) {
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
    ...SQUARE_BASE, passDirection: 'around', squareRoughBefore: true,
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
// guard blocks below.
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
// 6. Generation through the production adapter: the advisory flag is derived
//    from the operation list, and a finish without its rough still generates --
//    the export guard, not the generator, is the authority.
// ---------------------------------------------------------------------------

console.log('Testing the adapter\'s rough-before advisory and the generated programs...')
{
  const { project } = fixture()
  const [rough, finish] = project.operations
  const roughEnvelope = computeOperationToolpath(project, rough)
  assert.ok(roughEnvelope, 'the around rough generates through the dispatch')
  assert.deepEqual(roughEnvelope!.result.warnings, [], 'the around rough warns about nothing')
  assert.ok(roughEnvelope!.result.moves.length > 0, 'the around rough cuts')

  const finishEnvelope = computeOperationToolpath(project, finish)
  assert.ok(finishEnvelope, 'the around finish generates through the dispatch')
  assert.deepEqual(finishEnvelope!.result.warnings, [], 'the finish warns about nothing because the rough precedes it')
  assert.ok(finishEnvelope!.result.moves.length > 0, 'the around finish cuts')

  // Remove the rough: the same finish on the raw blank still generates (#1045
  // slice E moved the decision to the export guard) and warns that a rough
  // should run first.
  const rawProject: Project = { ...project, operations: [finish] }
  const rawFinish = computeOperationToolpath(rawProject, finish)
  assert.ok(rawFinish, 'the finish is a result, not a missing envelope')
  assert.ok(rawFinish!.result.moves.length > 0, 'the finish on a raw blank still generates')
  assert.deepEqual(rawFinish!.result.warnings.map((warning) => warning.code),
    ['rotarySquareFinishNeedsRough'], 'and says to rough first')

  // A disabled rough is not a rough: the advisory fires again.
  const disabled: Project = {
    ...project,
    operations: [{ ...rough, enabled: false }, finish],
  }
  const disabledFinish = computeOperationToolpath(disabled, finish)
  assert.deepEqual(disabledFinish!.result.warnings.map((warning) => warning.code),
    ['rotarySquareFinishNeedsRough'], 'a disabled rough does not count as a rough')
  // A rough on another target does not count for this one.
  const otherTarget: Project = {
    ...project,
    operations: [{ ...rough, target: { source: 'stock' } }, finish],
  }
  const otherFinish = computeOperationToolpath(otherTarget, finish)
  assert.deepEqual(otherFinish!.result.warnings.map((warning) => warning.code),
    ['rotarySquareFinishNeedsRough'], 'a rough on another target does not count')
  // A rough that comes after the finish does not precede it.
  const reordered: Project = { ...project, operations: [finish, rough] }
  const reorderedFinish = computeOperationToolpath(reordered, finish)
  assert.deepEqual(reorderedFinish!.result.warnings.map((warning) => warning.code),
    ['rotarySquareFinishNeedsRough'], 'a rough later in the list does not precede the finish')
}

// ---------------------------------------------------------------------------
// 7. The output guard: turning cuts below the travel height are admitted only
//    for an around-mode square operation whose engagement the program's own
//    cuts prove, and only for a cut. Rapids, along-mode turns and an
//    over-engagement edit keep refusing.
// ---------------------------------------------------------------------------

console.log('Testing the square around output guard...')
{
  const { project, stock } = fixture()
  const [rough, finish] = project.operations
  const roughResult = computeOperationToolpath(project, rough)!.result
  const finishResult = computeOperationToolpath(project, finish)!.result
  assert.deepEqual(roughResult.warnings, [])
  assert.deepEqual(finishResult.warnings, [])

  // The generated rough and the generated rough+finish both post.
  const roughProgram = post(project, ROTARY, [{ operation: rough, moves: roughResult.moves }])
  assert.deepEqual(roughProgram.warnings, [], 'the generated around rough posts')
  assert.ok(/A-?\d/.test(roughProgram.gcode), 'and carries A words')
  const aWords = [...roughProgram.gcode.matchAll(/A(-?\d+(?:\.\d+)?)/g)].map((match) => Number(match[1]))
  for (const a of aWords) assert.ok(a >= 0 && a <= 360, `posted A ${a} stays inside [0, 360]`)
  const both = post(project, ROTARY, [
    { operation: rough, moves: roughResult.moves },
    { operation: finish, moves: finishResult.moves },
  ])
  assert.deepEqual(both.warnings, [], 'the generated around rough followed by its finish posts')

  // An **along**-mode rough clears the blank too, even though it never turns
  // below the travel height: its cuts are recorded in the guard's account, so
  // an around finish after it is admitted as well.
  const alongRoughProject = fixture('x', 'along').project
  const alongRough = alongRoughProject.operations[0]
  const alongRoughResult = computeOperationToolpath(alongRoughProject, alongRough)!.result
  assert.deepEqual(alongRoughResult.warnings, [], 'the along-mode rough generates cleanly')
  const mixed = post(project, ROTARY, [
    { operation: alongRough, moves: alongRoughResult.moves },
    { operation: finish, moves: finishResult.moves },
  ])
  // The conservative guard (#1045 slice H) charges the along rough's retained-end
  // shoulder: its passes start one cutter radius inside the model end, so the
  // corner cells between that start and the end are still blank, and the finish's
  // first ring takes them. Slice E's centre-evaluating guard admitted this; the
  // whole-cell guard refuses it. Refusing is the safe answer, and the reach of
  // the finish past the along rough's cut range is the thing to fix in the
  // generator, not the guard.
  assert.deepEqual(mixed.warnings.map((warning) => warning.code),
    ['postRotarySquareTurnBelowEnvelope'],
    'the around finish after the along-mode rough is refused at the retained-end shoulder')

  // A blank already at its model needs no rough: the geometric alternative
  // admits the finish on any square operation whose material is within the
  // stock it leaves (plus the adapter's cell).
  const nearNetMoves = generateRotaryFinish('near-net-post', prism(SQUARE, SQUARE_SECTION, [0, 40]), SQUARE, FLAT, {
    stepover: 4, sampleSpacing: 2, stockToLeave: 0, alongStart: 0, alongEnd: 40,
    safeRadius: 40, requestedCellSize: 0.2, passDirection: 'around',
  }, {})
  assert.deepEqual(nearNetMoves.warnings, [], 'the near-net finish generates')
  const nearNetProgram = post(project, ROTARY, [{ operation: finish, moves: nearNetMoves.moves }])
  assert.deepEqual(nearNetProgram.warnings, [], 'a near-net finish needs no rough in the program')

  // The finish alone: its own turning cuts have no rough in the program to
  // account for the material they would remove, so the guard refuses them.
  const finishAlone = post(project, ROTARY, [{ operation: finish, moves: finishResult.moves }])
  assert.deepEqual(finishAlone.warnings.map((warning) => warning.code),
    ['postRotarySquareTurnBelowEnvelope'], 'the finish alone is refused')

  // A turning rapid below the travel height is refused even on an admitted
  // around operation: it removes nothing.
  const centre = barCentre(stock)
  const travel = barPivotZ(stock) + barMaxRadius(stock) + 1
  const lowTurn: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 20, y: centre, z: travel + 2, a: 0 }, to: { x: 20, y: centre, z: travel + 2, a: 0 } },
    { kind: 'rapid', from: { x: 20, y: centre, z: travel - 2, a: 0 }, to: { x: 20, y: centre, z: travel - 2, a: 30 } },
  ]
  assert.deepEqual(post(project, ROTARY, [{ operation: rough, moves: lowTurn }]).warnings.map((w) => w.code),
    ['postRotarySquareTurnBelowEnvelope'], 'a turning rapid below the height is refused')

  // The same turn on an along-mode operation is refused: only an around-mode
  // cut is licensed by the generator's layer bound.
  const alongProject = fixture('x', 'along').project
  const alongStock = fixture('x', 'along').stock
  const alongOp = alongProject.operations[0]
  const alongCut: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 20, y: barCentre(alongStock), z: travel + 2, a: 0 }, to: { x: 20, y: barCentre(alongStock), z: travel + 2, a: 0 } },
    { kind: 'cut', from: { x: 20, y: barCentre(alongStock), z: travel - 2, a: 0 }, to: { x: 20, y: barCentre(alongStock), z: travel - 2, a: 3 } },
  ]
  assert.deepEqual(post(alongProject, ROTARY, [{ operation: alongOp, moves: alongCut }]).warnings.map((w) => w.code),
    ['postRotarySquareTurnBelowEnvelope'], 'an along-mode turning cut below the height is refused')

  // An around-mode program whose engagement exceeds its bound: take the real
  // rough and push its deepest layer lower by twice the stepdown at one ring.
  const over: ToolpathMove[] = structuredClone(roughResult.moves)
  let edited = false
  for (const move of over) {
    // A **turning** cut: a constant-angle cut is never checked for engagement
    // (it lowers the grid only), so editing one would test nothing.
    if (move.kind !== 'cut' || move.from.x !== move.to.x) continue
    if (move.from.a === move.to.a) continue
    const tip = move.from.z - barPivotZ(stock)
    if (tip > barMaxRadius(stock) - 0.5) continue
    if (edited) break
    // A single move whose whole ring plunges two stepdowns deeper.
    const drop = 2 * rough.stepdown
    if (move.from.z - drop < barPivotZ(stock)) continue
    const angle = move.from.a
    if (angle === undefined) continue
    move.from = { ...move.from, z: move.from.z - drop }
    move.to = { ...move.to, z: move.to.z - drop }
    edited = true
  }
  assert.ok(edited, 'the fixture edited one rough move deeper')
  assert.deepEqual(post(project, ROTARY, [{ operation: rough, moves: over }]).warnings.map((w) => w.code),
    ['postRotarySquareTurnBelowEnvelope'], 'a cut that takes more than the layer bound is refused')

  // A non-rotary operation carrying A keeps its semantic refusal.
  const engrave: Operation = { ...rough, kind: 'follow_line' }
  assert.deepEqual(post(project, ROTARY, [{ operation: engrave, moves: roughResult.moves }]).warnings.map((w) => w.code),
    ['postSetupOperationRefused'], 'a non-rotary operation carrying A is refused')

  // -------------------------------------------------------------------------
  // Codex review pass 2, finding 1: an **incomplete** rough must not license
  // the whole finish. The rough's 20 mm chuck support restricts its cutter
  // centres to x 24..26, while the finish spans x 14..26: at x 14 the blank's
  // corner is still standing whole layers above the model, and the finish would
  // sweep it in one turning pass.
  // -------------------------------------------------------------------------
  {
    const partial = fixture('x', 'around', 20)
    const partialRough = partial.project.operations[0]
    const partialFinish = partial.project.operations[1]
    const partialRoughResult = computeOperationToolpath(partial.project, partialRough)!.result
    const partialFinishResult = computeOperationToolpath(partial.project, partialFinish)!.result
    assert.deepEqual(partialRoughResult.warnings, [], 'the supported rough generates')
    const roughAlong = partialRoughResult.moves.flatMap((move) => [move.from.x, move.to.x])
    assert.ok(Math.min(...roughAlong) >= 24 - 1e-6 && Math.max(...roughAlong) <= 26 + 1e-6,
      `the supported rough only reaches x 24..26 (it covers ${Math.min(...roughAlong).toFixed(4)}..${Math.max(...roughAlong).toFixed(4)})`)
    const finishAlong = partialFinishResult.moves.flatMap((move) => [move.from.x, move.to.x])
    assert.ok(Math.min(...finishAlong) < 15, 'the finish spans the whole band, not only the roughed part')
    const partialProgram = post(partial.project, ROTARY, [
      { operation: partialRough, moves: partialRoughResult.moves },
      { operation: partialFinish, moves: partialFinishResult.moves },
    ])
    assert.deepEqual(partialProgram.warnings.map((warning) => warning.code),
      ['postRotarySquareTurnBelowEnvelope'],
      'an incomplete rough cannot license the finish over the material it never reached')
  }

  // -------------------------------------------------------------------------
  // Codex review pass 2, finding 1b: an along rough with a single cut point is
  // not coverage either.
  // -------------------------------------------------------------------------
  {
    const alongFixtures = fixture('x', 'along')
    const aloneRough = alongFixtures.project.operations[0]
    // One constant-angle cut point deep in the band: the along rough ran, but it
    // cleared a single spot and nothing else.
    const onePoint: ToolpathMove[] = [
      { kind: 'rapid', from: { x: 20, y: centre, z: travel + 2, a: 0 }, to: { x: 20, y: centre, z: travel + 2, a: 0 } },
      { kind: 'cut', from: { x: 20, y: centre, z: barPivotZ(stock) + 5, a: 0 }, to: { x: 20.1, y: centre, z: barPivotZ(stock) + 5, a: 0 } },
    ]
    const program = post(project, ROTARY, [
      { operation: aloneRough, moves: onePoint },
      { operation: finish, moves: finishResult.moves },
    ])
    assert.deepEqual(program.warnings.map((warning) => warning.code),
      ['postRotarySquareTurnBelowEnvelope'],
      'one cut point of an along rough does not clear the blank for a finish')
  }

  // -------------------------------------------------------------------------
  // Codex review pass 2, finding 2: the interior of a turning cut is checked,
  // and A is the commanded sweep.
  //
  // A single A0 -> A90 cut at tip radius 9 with the Ø4 flat over the 20 mm
  // square: both endpoints stand no more than 1 mm above the flat, but at A45
  // the corner stands at 14.142 mm -- 5.142 mm of engagement. Endpoint checks
  // pass it; the grid must refuse it.
  // -------------------------------------------------------------------------
  {
    const corner = barMaxRadius(stock)
    const single: ToolpathMove[] = [
      { kind: 'rapid', from: { x: 20, y: centre, z: travel + 2, a: 0 }, to: { x: 20, y: centre, z: travel + 2, a: 0 } },
      { kind: 'cut', from: { x: 20, y: centre, z: barPivotZ(stock) + 9, a: 0 }, to: { x: 20, y: centre, z: barPivotZ(stock) + 9, a: 90 } },
    ]
    // Confirm the review's figure: at A45 the untouched corner is 5.14 mm above
    // this tip (the grid's engagement, not a helper's, is what the guard reads).
    assert.ok(corner - 9 > 5 && corner - 9 < 5.3,
      `the A45 corner stands ${(corner - 9).toFixed(3)} mm above a tip radius of 9`)
    assert.deepEqual(post(project, ROTARY, [{ operation: rough, moves: single }]).warnings.map((w) => w.code),
      ['postRotarySquareTurnBelowEnvelope'], 'a turning cut whose interior takes the corner is refused')

    // The same sweep written as A0 -> A360 must be a full revolution, not a
    // zero-span check: the corner is taken at A45 either way.
    const full: ToolpathMove[] = [
      { kind: 'rapid', from: { x: 20, y: centre, z: travel + 2, a: 0 }, to: { x: 20, y: centre, z: travel + 2, a: 0 } },
      { kind: 'cut', from: { x: 20, y: centre, z: barPivotZ(stock) + 9, a: 0 }, to: { x: 20, y: centre, z: barPivotZ(stock) + 9, a: 360 } },
    ]
    assert.deepEqual(post(project, ROTARY, [{ operation: rough, moves: full }]).warnings.map((w) => w.code),
      ['postRotarySquareTurnBelowEnvelope'], 'an A0 -> A360 cut is judged as a full revolution')

    // A real ring at the rough's first layer is admitted: its interior
    // engagement is one stepdown everywhere.
    const ring: ToolpathMove[] = [
      { kind: 'rapid', from: { x: 20, y: centre, z: travel + 2, a: 0 }, to: { x: 20, y: centre, z: travel + 2, a: 0 } },
      { kind: 'cut', from: { x: 20, y: centre, z: barPivotZ(stock) + corner - rough.stepdown, a: 0 }, to: { x: 20, y: centre, z: barPivotZ(stock) + corner - rough.stepdown, a: 360 } },
    ]
    assert.deepEqual(post(project, ROTARY, [{ operation: rough, moves: ring }]).warnings, [],
      'a full ring at one stepdown below the corner is admitted')
  }
}

// ---------------------------------------------------------------------------
// 8. Round bars stay frozen: an around finish on a round bar is not given the
//    square guard, and the same kind of low turning cut still posts there.
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
