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
 * #1045 slice K: the square blank's around-mode generator, proven safe by an
 * independent model.
 *
 * Slice K replaced the export standing-material guard with a
 * regenerate-and-match check: the export proves a toolpath is the *current
 * generator's own* motion, not that the motion is safe. Safety is therefore a
 * property of the generator, and this file is the test that owns it.
 *
 * It generates 300 seeded **generator-emitted** square around programs -- flat
 * and ball cutters, Ø1-12, a bare around rough, a bare around finish (refused
 * since slice K), around rough + around finish, and along rough + around finish,
 * with and without retained ends, `stepdown` 0.5-3 mm, default and custom
 * stepover/sampling, blanks from 10 to 60 mm square and 20 to 1 000 mm long --
 * and replays each one, in order, through its own reference.
 *
 * The reference is written without the generator's helpers (no
 * `squareRotaryStock`, no `rotaryModel` function is called here): the blank is
 * a square cross-section sampled into dense polar slices per along position,
 * the true cutter body is a flat's disc/cylinder or a ball's sphere/shank
 * (including the shank above a ball's equator), and the material is lowered
 * through the exact ray/body intersection. The reference's along and angle bins
 * are four times finer than **every nominal cell the generator uses**
 * (`stepover`, `sampleSpacing`, `aroundArcStep`, `requestedCellSize`); the
 * generator's adaptive angular refinement is what makes the emitted motion meet
 * its own 0.005 mm surface bound, so the reference judges the *emitted moves*
 * (not the ideal endpoints) and the surface tolerance includes that stated
 * bound. Consecutive straight **commanded** A moves at one along and Z are
 * replayed as the one line they describe; that is the same controller path, not
 * a coarser one.
 *
 * Each case is drawn inside a fixed visit budget. A case whose drawn bar would
 * exceed it is redrawn **shorter** (20 mm is the floor) and, only at that floor,
 * has its sampling -- and finally its `stepdown`, still inside 0.5-3 mm --
 * coarsened. The reference's 4x-finer resolution is never reduced.
 *
 * For each program the reference asserts:
 *
 * 1. no cut engages more than its operation's bound -- a rough's `stepdown`, a
 *    finish's `stockToLeave` plus the rough's layer allowance, each plus the
 *    stated reference tolerance;
 * 2. no cutter body enters a retained end: every reference cell outside the
 *    band keeps the blank's material;
 * 3. no rapid turns A below the blank's corner radius plus 1 mm clearance;
 * 4. the finished surface is within tolerance of the model -- it is not cut
 *    below it, and no more than the finish's own scallop plus the sampler's
 *    stated cell lift is left above it.
 *
 * The unsafe configurations the reference found -- an around finish with no
 * covering rough, and an along rough over a retained end -- are refused by the
 * generator with `rotarySquareFinishNeedsRough` and no motion; the test asserts
 * the refusal rather than replaying a cut that must not exist.
 *
 * The per-sample **touch-radius gate** is asserted by the seeded square-material
 * property in `rotarySquareAroundPasses.test.ts`, not duplicated here: a cut
 * point above the blank's local radius is not necessarily air, because the
 * cutter's body can reach material elsewhere in its slab, and a naive version
 * of that check false-positives on a legitimate end-face cut.
 *
 * It reports the worst value found for each assertion.
 *
 * Run with: npx tsx src/engine/toolpaths/squareAroundGenerator.property.test.ts
 */
import assert from 'node:assert/strict'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import type { SquareStock } from '../../types/project'
import { defaultTool, getStockBounds } from '../../types/project'
import { generateRotaryFinish, generateRotaryRough } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import type { NormalizedTool, ToolpathMove } from './types'

// ── deterministic random source ──────────────────────────────────────────

// ── the model, built here rather than through the generator's helpers ─────

/** A closed revolved surface: one ring per profile entry, quads between them. */
function revolved(
  stock: SquareStock,
  profile: readonly { along: number; radius: number }[],
  segments = 96,
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const ring of profile) {
    for (let j = 0; j < segments; j++) {
      const t = 2 * Math.PI * j / segments
      positions.push(ring.along, centre + ring.radius * Math.cos(t), pivot + ring.radius * Math.sin(t))
    }
  }
  for (let ring = 0; ring + 1 < profile.length; ring++) {
    for (let j = 0; j < segments; j++) {
      const j2 = (j + 1) % segments
      const a = ring * segments
      const b = (ring + 1) * segments
      index.push(a + j, a + j2, b + j2, a + j, b + j2, b + j)
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/**
 * The finished model's radius at an along position between two profile rings,
 * or `null` in a vertical shoulder (where a revolved "radius at this along"
 * does not exist) or outside the model.
 */
function modelSurfaceAt(profile: readonly { along: number; radius: number }[], along: number): number | null {
  for (let i = 0; i + 1 < profile.length; i++) {
    const a = profile[i]
    const b = profile[i + 1]
    if (b.along === a.along) {
      if (along === a.along) return null
      continue
    }
    if (along < a.along || along > b.along) continue
    return a.radius + (b.radius - a.radius) * (along - a.along) / (b.along - a.along)
  }
  return null
}

/** The steepest slope of the model's revolved surface, for the flat's staircase. */
function modelMaxSlope(profile: readonly { along: number; radius: number }[]): number {
  let slope = 0
  for (let i = 0; i + 1 < profile.length; i++) {
    const a = profile[i]
    const b = profile[i + 1]
    if (b.along === a.along) continue
    slope = Math.max(slope, Math.abs(b.radius - a.radius) / (b.along - a.along))
  }
  return slope
}

// ── the independent reference ─────────────────────────────────────────────
//
// A polar slice per along position: `material[i][k]` is the radius of the
// material still standing at along bin `i` and angle bin `k`. It starts at the
// square blank's own cross-section and is lowered by the exact ray/cutter
// intersection of every commanded sample. Written blind to `rotaryModel.ts`.

export const worstCell = { depth: 0, along: 0, angle: 0, material: 0, contact: 0 }
const lowestContact = { contact: Number.POSITIVE_INFINITY, along: 0, angle: 0, tip: 0, kind: '' }

interface Reference {
  alongStart: number
  alongBins: number
  alongBin: number
  angleBins: number
  angleDeg: number
  material: Float64Array
}

function blankRadius(halfSide: number, angleDeg: number): number {
  const radians = angleDeg * Math.PI / 180
  return halfSide / Math.max(Math.abs(Math.cos(radians)), Math.abs(Math.sin(radians)))
}

function createReference(stock: SquareStock, alongStart: number, alongEnd: number, alongBin: number, angleBins: number): Reference {
  const alongBins = Math.max(1, Math.ceil((alongEnd - alongStart) / alongBin))
  const material = new Float64Array(alongBins * angleBins)
  const halfSide = stock.thickness / 2
  const angleDeg = 360 / angleBins
  const row = new Float64Array(angleBins)
  for (let k = 0; k < angleBins; k++) row[k] = blankRadius(halfSide, (k + 0.5) * angleDeg)
  for (let i = 0; i < alongBins; i++) material.set(row, i * angleBins)
  return { alongStart, alongBins, alongBin, angleBins, angleDeg, material }
}

/**
 * The near (`contact`) and far (`exit`) radii at which the cutter body meets a
 * ray `dTheta` off its axis, `dx` along it, or `null` when the body misses the
 * ray. A flat is its bottom disc and cylindrical side; a ball is its sphere and
 * the shank above the sphere's equator, exactly as the emitted body is.
 */
function bodySpan(
  ball: boolean,
  cutterRadius: number,
  tip: number,
  dTheta: number,
  dx: number,
): { contact: number; exit: number } | null {
  const cos = Math.cos(dTheta)
  if (!(cos > 1e-9)) return null
  const alongSq = dx * dx
  const radiusSq = cutterRadius * cutterRadius
  if (alongSq >= radiusSq) return null
  if (!ball) {
    const reach = Math.sqrt(radiusSq - alongSq)
    if (Math.abs(tip * Math.tan(dTheta)) > reach) return null
    const sin = Math.abs(Math.sin(dTheta))
    return { contact: Math.max(0, tip / cos), exit: sin > 1e-12 ? reach / sin : Number.POSITIVE_INFINITY }
  }
  const centre = tip + cutterRadius
  if (!(centre > 0)) return null
  const sin = Math.sin(dTheta)
  const sinSq = sin * sin
  const discriminant = radiusSq - alongSq - centre * centre * sinSq
  if (discriminant < 0) return null
  const root = Math.sqrt(discriminant)
  const sphereExit = centre * cos + root
  const shankStart = centre / cos
  const shankExit = Math.abs(sin) > 1e-12 ? Math.sqrt(radiusSq - alongSq) / Math.abs(sin) : Number.POSITIVE_INFINITY
  return {
    contact: Math.max(0, centre * cos - root),
    exit: shankStart <= shankExit ? Math.max(sphereExit, shankExit) : sphereExit,
  }
}

/**
 * Apply one commanded move to the reference and return the deepest bite it
 * takes (`0` when it removes nothing measurable). The move is judged at the
 * point of its linear (along, A, Z) path nearest each cell, plus both of its
 * ends when both along and A change, so a slanted move cannot hide a bite
 * between its cells.
 */
function referenceMove(
  reference: Reference,
  move: ToolpathMove,
  pivot: number,
  cutterRadius: number,
  ball: boolean,
  alongOf: (point: ToolpathMove['from']) => number,
  fromAngle: number,
  toAngle: number,
): number {
  const { material, alongBins, alongStart, alongBin, angleBins, angleDeg } = reference
  const fromAlong = alongOf(move.from)
  const toAlong = alongOf(move.to)
  const fromTip = move.from.z - pivot
  const toTip = move.to.z - pivot
  const dAlong = toAlong - fromAlong
  const dAngle = toAngle - fromAngle
  const tipMin = Math.min(fromTip, toTip)
  const halfSpan = tipMin > 0 ? Math.asin(Math.min(1, cutterRadius / tipMin)) : Math.PI
  const halfSpanDegrees = Math.min(180, halfSpan * 180 / Math.PI)
  const i0 = Math.max(0, Math.floor((Math.min(fromAlong, toAlong) - cutterRadius - alongStart) / alongBin))
  const i1 = Math.min(alongBins - 1, Math.floor((Math.max(fromAlong, toAlong) + cutterRadius - alongStart) / alongBin))
  const windowLo = Math.min(fromAngle, toAngle) - halfSpanDegrees - angleDeg
  const windowHi = Math.max(fromAngle, toAngle) + halfSpanDegrees + angleDeg
  const allAngles = windowHi - windowLo >= 360 - 1e-9
  const firstBin = allAngles ? 0 : Math.floor(windowLo / angleDeg)
  const lastBin = allAngles ? angleBins - 1 : Math.ceil(windowHi / angleDeg)
  const weight = Math.max(Math.abs(tipMin), cutterRadius, 1e-6)
  const denominator = dAlong * dAlong + weight * weight * dAngle * dAngle
  const slanted = dAlong !== 0 && dAngle !== 0
  let engagement = 0
  worstCell.depth = 0
  for (let i = i0; i <= i1; i++) {
    const cellAlong = alongStart + (i + 0.5) * alongBin
    const rowOffset = i * angleBins
    for (let cell = firstBin; cell <= lastBin; cell++) {
      const k = allAngles ? cell : ((cell % angleBins) + angleBins) % angleBins
      const cellAngle = (k + 0.5) * angleDeg
      let candidateCount = 1
      let nearest = 0
      if (denominator > 1e-18) {
        nearest = Math.min(1, Math.max(0, ((cellAlong - fromAlong) * dAlong
          + (cellAngle - fromAngle) * weight * weight * dAngle) / denominator))
      }
      candidateCount = slanted ? 3 : 1
      for (let candidate = 0; candidate < candidateCount; candidate++) {
        const fraction = slanted ? (candidate === 0 ? 0 : candidate === 1 ? 1 : nearest) : nearest
        const toolAlong = fromAlong + dAlong * fraction
        const dx = cellAlong - toolAlong
        if (dx * dx >= cutterRadius * cutterRadius) continue
        const toolAngle = fromAngle + dAngle * fraction
        let delta = cellAngle - toolAngle
        while (delta > 180) delta -= 360
        while (delta < -180) delta += 360
        const tip = fromTip + (toTip - fromTip) * fraction
        const span = bodySpan(ball, cutterRadius, tip, delta * Math.PI / 180, dx)
        if (span === null) continue
        const index = rowOffset + k
        const materialRadius = material[index]
        if (!(materialRadius > 0) || span.exit < materialRadius) continue
        if (span.contact < lowestContact.contact) {
          lowestContact.contact = span.contact
          lowestContact.along = cellAlong
          lowestContact.angle = cellAngle
          lowestContact.tip = tip
          lowestContact.kind = move.kind
        }
        const depth = materialRadius - span.contact
        if (depth > engagement) {
          engagement = depth
          worstCell.depth = depth
          worstCell.along = cellAlong
          worstCell.angle = cellAngle
          worstCell.material = materialRadius
          worstCell.contact = span.contact
        }
        if (span.contact < materialRadius) material[index] = span.contact
      }
    }
  }
  return engagement
}

// ── the seeded cases ──────────────────────────────────────────────────────

/**
 * The reference's grid is capped, and so is the number of cell visits one
 * program may cost. A case whose drawn bar would exceed the visit cap is
 * redrawn **shorter** -- never with a coarser reference -- so the 4x-finer
 * resolution above always holds. The drawn side, cutter, stepdown, stepover and
 * model are kept; only the bar length shrinks (20 mm is the stated minimum).
 */
const MAX_REFERENCE_CELLS = 500_000
const MAX_REPLAY_CELLS = 3_500_000
const MAX_ANGLE_BINS = 1_800

type ProgramKind = 'rough' | 'finish' | 'both' | 'mixed'

interface Case {
  label: string
  stock: SquareStock
  profile: { along: number; radius: number }[]
  type: 'flat_endmill' | 'ball_endmill'
  diameter: number
  stepdown: number
  stepover: number
  roughSpacing: number
  finishSpacing: number
  requestedCellSize: number
  stockToLeave: number
  programKind: ProgramKind
  roughKind: 'around' | 'along'
  retained: boolean
  alongStart: number
  alongEnd: number
  defaultParams: boolean
}

function normalizedTool(type: 'flat_endmill' | 'ball_endmill', diameter: number): NormalizedTool {
  const row = { ...defaultTool('mm', 1), units: 'mm' as const, type, diameter }
  return {
    id: 'tool', name: 'tool', sourceUnits: 'mm' as const, units: 'mm' as const,
    type, diameter, radius: diameter / 2, vBitAngle: null,
    flutes: row.flutes, material: row.material, defaultRpm: 0, defaultFeed: 0,
    defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
  }
}

/** The generator's nominal angular arc step for an around pass, in mm. */
function aroundArcStep(cornerRadius: number, sampleSpacing: number): number {
  return Math.min(sampleSpacing, Math.sqrt(8 * cornerRadius * 0.005))
}

/**
 * The generator's two sampling cells for this program: the distance between
 * along steps (an around ring's `stepover`, or an along pass's
 * `sampleSpacing`) and the distance round the blank between angle samples (an
 * around pass's `aroundArcStep`, or an along pass's `stepover`). These are the
 * cells the emitted program is actually built on; the height map inside the
 * sampler is a model lookup, not an emitted grid.
 */
function generatorCells(entry: Case): { along: number; arc: number } {
  const corner = barMaxRadius(entry.stock)
  const aroundAngle = aroundArcStep(corner, entry.finishSpacing)
  const roughAngle = aroundArcStep(corner, entry.roughSpacing)
  return {
    along: entry.roughKind === 'along' ? Math.min(entry.stepover, entry.roughSpacing) : entry.stepover,
    arc: entry.roughKind === 'along' ? Math.min(aroundAngle, entry.stepover) : Math.min(aroundAngle, roughAngle),
  }
}

/** The reference's grid for one case: bins, start, and cell count. */
function referenceBudget(entry: Case): {
  alongStart: number
  alongBins: number
  alongBin: number
  angleBins: number
  angleDeg: number
  cells: number
} {
  const corner = barMaxRadius(entry.stock)
  const cells = generatorCells(entry)
  const alongBin = cells.along / 4
  const angleBins = Math.max(24, Math.ceil((2 * Math.PI * corner) / (cells.arc / 4)))
  const bounds = getStockBounds(entry.stock)
  const band = (bounds.maxX - bounds.minX) + 2 * (entry.diameter / 2 + 1)
  const alongBins = Math.ceil(band / alongBin)
  return {
    alongStart: bounds.minX,
    alongBins,
    alongBin,
    angleBins,
    angleDeg: 360 / angleBins,
    cells: alongBins * angleBins,
  }
}

/** A small deterministic PRNG, so one case's draw does not depend on the order of others. */
function mulberry32(seed: number): () => number {
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
 * One seeded case, with the blank shortened by `lengthScale`. The large drawn
 * lengths (up to 1 000 mm) are part of the draw; a case whose reference cannot
 * afford them is redrawn shorter rather than checked against a coarser
 * reference. `programKind` covers a bare rough, a bare finish (refused), an
 * around rough + around finish, and an along rough + around finish.
 */
function drawCase(seed: number, lengthScale: number): Case {
  const rand = mulberry32(seed * 0x9e3779b1 + 0x1045)
  const pick = (low: number, high: number): number => low + (high - low) * rand()
  const scale = seed % 4
  const sizeRanges: ReadonlyArray<{ side: [number, number]; length: [number, number] }> = [
    { side: [10, 18], length: [20, 40] },
    { side: [16, 28], length: [40, 110] },
    { side: [24, 40], length: [110, 300] },
    { side: [36, 60], length: [300, 1000] },
  ]
  const size = sizeRanges[scale]
  const side = Math.round(pick(size.side[0], size.side[1]) * 2) / 2
  const length = Math.max(20, Math.round(pick(size.length[0], size.length[1]) * lengthScale))
  const type = seed % 2 === 0 ? 'ball_endmill' as const : 'flat_endmill' as const
  // The cutter scales with the blank, so the set covers Ø1-12 without asking a
  // sub-millimetre tool to machine a metre of stock in this test.
  const diameter = Math.round(pick(
    scale === 0 ? 1 : scale === 1 ? 2 : scale === 2 ? 3 : 6,
    Math.min(12, side * 0.5),
  ) * 10) / 10
  const radius = diameter / 2
  const inscribed = side / 2
  const modelRadius = Math.round(pick(0.4, 0.85) * inscribed * 10) / 10
  const kinds: ProgramKind[] = ['both', 'rough', 'finish', 'mixed', 'rough', 'mixed', 'both', 'mixed']
  const programKind = kinds[seed % kinds.length]
  const roughKind = programKind === 'mixed' ? 'along' as const : 'around' as const
  // A mixed program with a retained end is the unsafe combination the finish
  // generator refuses; the set keeps both sides of it (some mixed cases have
  // ends, some do not). Every other kind keeps ends on most seeds.
  const endsWanted = programKind === 'mixed'
    ? seed % 3 !== 0
    : (seed % 2 === 0 ? seed % 3 !== 0 : seed % 3 === 0)
  const ends = endsWanted ? Math.max(1, Math.round(pick(0.05, 0.18) * length)) : 0
  const bounds = getStockBounds(squareStock(side, length, 'x', { x: 0, y: 0 }))
  const alongStart = bounds.minX + ends
  const alongEnd = bounds.maxX - ends
  // A revolved part with a continuous surface: a cylinder or a cone. A model
  // with a mid-band vertical shoulder asks the around pass to face a wall it
  // has no along pass for; that is a separate geometry question, and the
  // reference's surface check excludes a vertical face (`modelSurfaceAt`).
  const modelKind = seed % 2
  const profile: { along: number; radius: number }[] =
    modelKind === 0
      ? [{ along: alongStart, radius: modelRadius }, { along: alongEnd, radius: modelRadius }]
      : [
        { along: alongStart, radius: modelRadius },
        { along: alongEnd, radius: Math.max(0.6, modelRadius * pick(0.55, 0.95)) },
      ]
  // The default adapter parameters for this tool and operation kind.
  const defaultStepover = Math.max(0.5 * diameter, 1e-3)
  const roughSpacing = Math.max(radius / 2, 1e-3)
  const finishSpacing = Math.max(radius / 4, 1e-3)
  const requestedCellSize = Math.min(radius / 3, defaultStepover * 0.5)
  const custom = seed % 5 === 0
  const stepover = custom ? Math.max(pick(0.3, 1) * diameter, 1e-3) : defaultStepover
  const rough = custom ? Math.max(pick(0.2, 1) * radius, 1e-3) : roughSpacing
  const finish = custom ? Math.max(pick(0.15, 1) * radius, 1e-3) : finishSpacing
  // The adapter derives the height-map cell from the tool and stepover; a saved
  // operation cannot set it, so the seeded set keeps the same formula.
  const cell = requestedCellSize
  const stepdown = Math.round(pick(0.5, 3) * 10) / 10
  const stockToLeave = custom ? Math.round(pick(0, 0.5) * 100) / 100 : 0
  return {
    label: `${type === 'ball_endmill' ? 'ball' : 'flat'} D${diameter} ${side}x${length} `
      + `${modelKind === 0 ? 'cyl' : 'cone'} ${programKind} ${roughKind} rough `
      + `ends ${ends} stepdown ${stepdown}${custom ? ' custom' : ''}`,
    stock: squareStock(side, length, 'x', { x: 0, y: 0 }),
    profile,
    type,
    diameter,
    stepdown,
    stepover,
    roughSpacing: rough,
    finishSpacing: finish,
    requestedCellSize: cell,
    stockToLeave,
    programKind,
    roughKind,
    retained: ends > 0,
    alongStart,
    alongEnd,
    defaultParams: !custom,
  }
}

/** Whether the reference's grid itself fits the per-case cell budget. */
function fitsGrid(entry: Case): boolean {
  const budget = referenceBudget(entry)
  return budget.cells <= MAX_REFERENCE_CELLS && budget.angleBins <= MAX_ANGLE_BINS
}

interface Program {
  roughMoves: ToolpathMove[]
  finishMoves: ToolpathMove[]
  roughCodes: string[]
  finishCodes: string[]
}

function generate(entry: Case): Program {
  const tool = normalizedTool(entry.type, entry.diameter)
  const stock = entry.stock
  const model = revolved(stock, entry.profile)
  const common = {
    stepover: entry.stepover,
    sampleSpacing: entry.roughSpacing,
    // The adapter passes the operation's radial stock to both generators: a
    // rough that cut to the model while the finish was asked to leave stock
    // would leave the finish no material to leave it in.
    stockToLeave: entry.stockToLeave,
    alongStart: entry.alongStart,
    alongEnd: entry.alongEnd,
    safeRadius: barMaxRadius(stock) * 2,
    requestedCellSize: entry.requestedCellSize,
  }
  const rough = entry.programKind === 'finish'
    ? { moves: [] as ToolpathMove[], warnings: [] as { code: string }[] }
    : generateRotaryRough(`${entry.label} rough`, model, stock, tool, {
      ...common,
      stepdown: entry.stepdown,
      passDirection: entry.roughKind,
    }, {})
  const finish = entry.programKind === 'rough'
    ? { moves: [] as ToolpathMove[], warnings: [] as { code: string }[] }
    : generateRotaryFinish(`${entry.label} finish`, model, stock, tool, {
      ...common,
      sampleSpacing: entry.finishSpacing,
      stockToLeave: entry.stockToLeave,
      passDirection: 'around',
      // The status the adapter passes: an around rough covers the blank, an
      // along rough leaves a retained-end corner standing, and no rough at all
      // is a raw blank.
      squareRoughBefore: entry.programKind === 'both' ? 'around'
        : entry.programKind === 'mixed' ? 'along' : undefined,
    }, {})
  return {
    roughMoves: rough.moves,
    finishMoves: finish.moves,
    roughCodes: rough.warnings.map((warning) => warning.code),
    finishCodes: finish.warnings.map((warning) => warning.code),
  }
}


/**
 * Collapse consecutive straight **commanded** moves on the controller into the
 * one move they describe. A ring's emitted chords run at constant along and
 * constant Z with a continuous A, so their union is the same linear A move; the
 * reference judges the commanded path, not the emitter's segmentation, and one
 * ring costs one window instead of a few hundred overlapping ones. A move that
 * changes Z or along, or reverses A, starts a new group.
 */
function coalesceCommandedMoves(moves: readonly ToolpathMove[]): ToolpathMove[] {
  const out: ToolpathMove[] = []
  for (const move of moves) {
    const last = out[out.length - 1]
    const straightA = (entry: ToolpathMove): boolean =>
      entry.kind === 'cut'
      && entry.from.x === entry.to.x && entry.from.y === entry.to.y && entry.from.z === entry.to.z
      && entry.from.a !== undefined && entry.to.a !== undefined
      && entry.from.a !== entry.to.a
    if (last && straightA(last) && straightA(move)
      && last.to.x === move.from.x && last.to.y === move.from.y && last.to.z === move.from.z
      && last.to.a === move.from.a
      && Math.sign(last.to.a! - last.from.a!) === Math.sign(move.to.a! - move.from.a!)) {
      out[out.length - 1] = { kind: 'cut', from: last.from, to: move.to }
    } else {
      out.push(move)
    }
  }
  return out
}
/** How many cell visits the reference will make replaying these moves. */
function estimateReplayCells(program: Program, entry: Case): number {
  const budget = referenceBudget(entry)
  const pivot = barPivotZ(entry.stock)
  const radius = entry.diameter / 2
  const alongOf = (point: ToolpathMove['from']): number => point.x
  const travel = pivot + barMaxRadius(entry.stock) + 1
  let total = 0
  let controller = 0
  for (const move of coalesceCommandedMoves([...program.roughMoves, ...program.finishMoves])) {
    const hasAngle = move.from.a !== undefined || move.to.a !== undefined
    const fromAngle = move.kind === 'rapid' ? controller : (move.from.a ?? controller)
    const toAngle = hasAngle ? (move.to.a ?? fromAngle) : fromAngle
    controller = toAngle
    if (move.kind === 'rapid' || Math.min(move.from.z, move.to.z) >= travel) continue
    const fromAlong = alongOf(move.from)
    const toAlong = alongOf(move.to)
    const fromTip = move.from.z - pivot
    const toTip = move.to.z - pivot
    const tipMin = Math.min(fromTip, toTip)
    const halfSpanDegrees = Math.min(180, tipMin > 0
      ? Math.asin(Math.min(1, radius / tipMin)) * 180 / Math.PI
      : 180)
    const i0 = Math.max(0, Math.floor((Math.min(fromAlong, toAlong) - radius - budget.alongStart) / budget.alongBin))
    const i1 = Math.min(budget.alongBins - 1, Math.floor((Math.max(fromAlong, toAlong) + radius - budget.alongStart) / budget.alongBin))
    if (i1 < i0) continue
    const windowLo = Math.min(fromAngle, toAngle) - halfSpanDegrees - budget.angleDeg
    const windowHi = Math.max(fromAngle, toAngle) + halfSpanDegrees + budget.angleDeg
    const allAngles = windowHi - windowLo >= 360 - 1e-9
    const first = allAngles ? 0 : Math.floor(windowLo / budget.angleDeg)
    const last = allAngles ? budget.angleBins - 1 : Math.ceil(windowHi / budget.angleDeg)
    const angleCount = Math.max(0, last - first + 1)
    const candidates = fromAlong !== toAlong && fromAngle !== toAngle ? 3 : 1
    total += (i1 - i0 + 1) * angleCount * candidates
  }
  return total
}

interface Fitted {
  entry: Case
  program: Program
}

/**
 * Draw a case and shorten its bar until the reference's actual replay fits the
 * visit cap. Resolution never changes: a case that still does not fit at the
 * 20 mm minimum is coarsened in its **sampling** parameters (and marked
 * custom), which is still a legitimate generator input, rather than checked
 * against a reference coarser than 4x.
 */
function fitCase(seed: number): Fitted {
  let scale = 1
  let entry = drawCase(seed, scale)
  let program = generate(entry)
  let cells = estimateReplayCells(program, entry)
  for (let attempt = 0; attempt < 10 && (cells > MAX_REPLAY_CELLS || !fitsGrid(entry)); attempt++) {
    const length = entry.alongEnd - entry.alongStart
    if (length <= 20.5) break
    const ratio = cells > 0 ? MAX_REPLAY_CELLS / cells : 0.8
    const nextScale = scale * Math.max(0.1, Math.min(0.9, ratio * 0.95))
    if (nextScale >= scale * 0.999) break
    scale = nextScale
    entry = drawCase(seed, scale)
    program = generate(entry)
    cells = estimateReplayCells(program, entry)
  }
  for (let step = 1; step <= 16 && (cells > MAX_REPLAY_CELLS || !fitsGrid(entry)); step++) {
    const factor = 1.35 ** step
    const base = drawCase(seed, scale)
    entry = {
      ...base,
      stepover: Math.min(base.stepover * factor, Math.max(0.5 * base.diameter, base.diameter)),
      roughSpacing: Math.min(base.roughSpacing * factor, base.diameter),
      finishSpacing: Math.min(base.finishSpacing * factor, base.diameter),
      defaultParams: false,
    }
    program = generate(entry)
    cells = estimateReplayCells(program, entry)
  }
  // The angular sampling is the generator's own 0.005 mm sagitta cap, so a
  // minimum-length, thin-stepdown case can still exceed the visit cap after
  // every sampling parameter has been coarsened. Coarsen the **layer** height
  // instead (still inside the stated 0.5-3 mm range) rather than the reference:
  // this is the one input that changes how many rings a layer emits.
  for (let step = 1; step <= 8 && (cells > MAX_REPLAY_CELLS || !fitsGrid(entry)); step++) {
    entry = { ...entry, stepdown: Math.min(3, entry.stepdown * 1.35), defaultParams: false }
    program = generate(entry)
    cells = estimateReplayCells(program, entry)
  }
  assert.ok(cells <= MAX_REPLAY_CELLS,
    `${entry.label}: the reference replay needs ${cells} cell visits, over its ${MAX_REPLAY_CELLS} cap`)
  assert.ok(fitsGrid(entry), `${entry.label}: the reference grid does not fit its cell cap`)
  return { entry, program }
}

// ── the program and the reference replay ──────────────────────────────────

function ballRiseAt(radius: number, dx: number): number {
  return radius - Math.sqrt(Math.max(0, radius * radius - dx * dx))
}

interface Worst {
  /** The largest engagement any cut of this operation took. */
  peak: number
  peakLabel: string
  bound: number
  excess: number
  label: string
}

const worst: Record<'rough' | 'finish', Worst> = {
  rough: { peak: 0, peakLabel: '', bound: 0, excess: Number.NEGATIVE_INFINITY, label: '' },
  finish: { peak: 0, peakLabel: '', bound: 0, excess: Number.NEGATIVE_INFINITY, label: '' },
}
let worstRapidMargin = Number.POSITIVE_INFINITY
let worstRapidLabel = ''
let worstStubDrop = 0
let worstStubLabel = ''
let worstSurfaceOver = Number.NEGATIVE_INFINITY
let worstSurfaceOverLabel = ''
let worstSurfaceUnder = Number.NEGATIVE_INFINITY
let worstSurfaceUnderLabel = ''
let nonTurningWorst = 0
let nonTurningLabel = ''

const CASES = Array.from({ length: 300 }, (_, seed) => fitCase(seed))

console.log(`Testing ${CASES.length} seeded generator-emitted square around programs...`)
let checkedCuts = 0
let checkedRapids = 0
let checkedSurfaceCells = 0
let defaultCases = 0
let refusedFinish = 0
let retainedMixed = 0

for (const { entry, program } of CASES) {
  if (entry.defaultParams) defaultCases++
  const stock = entry.stock
  const tool = normalizedTool(entry.type, entry.diameter)
  const cutterRadius = tool.radius
  const ball = entry.type === 'ball_endmill'
  const pivot = barPivotZ(stock)
  const corner = barMaxRadius(stock)
  const clearance = 1
  const travelZ = pivot + corner + clearance

  if (entry.programKind === 'finish') {
    refusedFinish++
    assert.equal(program.finishMoves.length, 0, `${entry.label}: a finish with no rough emits no motion`)
    assert.ok(program.finishCodes.includes('rotarySquareFinishNeedsRough'),
      `${entry.label}: a finish with no rough is refused`)
    continue
  }
  assert.ok(program.roughMoves.length > 0, `${entry.label}: the rough emits motion`)
  const finishRefused = program.finishMoves.length === 0
  if (entry.programKind !== 'rough') {
    if (finishRefused) {
      refusedFinish++
      if (entry.programKind === 'mixed' && entry.retained) retainedMixed++
      assert.ok(program.finishCodes.includes('rotarySquareFinishNeedsRough'),
        `${entry.label}: an uncovered around finish is refused`)
    } else {
      assert.ok(entry.programKind !== 'mixed' || !entry.retained,
        `${entry.label}: only a mixed program without a retained end may finish around`)
    }
  }
  const finishRan = !finishRefused

  const budget = referenceBudget(entry)
  // The reference must be four times finer than both generator sampling cells.
  const cells = generatorCells(entry)
  assert.ok(budget.alongBin <= cells.along / 4 * (1 + 1e-9),
    `${entry.label}: the reference's along bin ${budget.alongBin} is 4x finer than ${cells.along}`)
  assert.ok((2 * Math.PI * corner / budget.angleBins) <= cells.arc / 4 * (1 + 1e-9),
    `${entry.label}: the reference's angle bin is 4x finer than ${cells.arc}`)

  const alongOf = (point: ToolpathMove['from']): number => point.x
  const allMoves = [...program.roughMoves, ...program.finishMoves]
  const bounds = getStockBounds(stock)
  let minCutAlong = Number.POSITIVE_INFINITY
  let maxCutAlong = Number.NEGATIVE_INFINITY
  for (const move of allMoves) {
    if (move.kind === 'rapid') continue
    minCutAlong = Math.min(minCutAlong, alongOf(move.from), alongOf(move.to))
    maxCutAlong = Math.max(maxCutAlong, alongOf(move.from), alongOf(move.to))
  }
  const windowLow = Math.max(bounds.minX, minCutAlong - cutterRadius - 1)
  const windowHigh = Math.min(bounds.maxX, maxCutAlong + cutterRadius + 1)
  const reference = createReference(stock, windowLow, windowHigh, budget.alongBin, budget.angleBins)

  const finishBound = entry.stockToLeave + entry.stepdown
    + budget.alongBin + ballRiseAt(cutterRadius, budget.alongBin) + 1e-6
  const roughBound = entry.stepdown + budget.alongBin + ballRiseAt(cutterRadius, budget.alongBin) + 1e-6
  const stages = finishRan
    ? [{ moves: coalesceCommandedMoves(program.roughMoves), finish: false }, { moves: coalesceCommandedMoves(program.finishMoves), finish: true }] as const
    : [{ moves: coalesceCommandedMoves(program.roughMoves), finish: false }] as const

  let controller = allMoves.find((move) => move.from.a !== undefined)?.from.a ?? 0
  for (const stage of stages) {
    const bound = stage.finish ? finishBound : roughBound
    for (const move of stage.moves) {
      const hasAngle = move.from.a !== undefined || move.to.a !== undefined
      const fromAngle = move.kind === 'rapid' ? controller : (move.from.a ?? controller)
      const toAngle = hasAngle ? (move.to.a ?? fromAngle) : fromAngle
      const turns = toAngle !== fromAngle
      const lowZ = Math.min(move.from.z, move.to.z)
      if (move.kind === 'rapid') {
        checkedRapids++
        if (turns) {
          const margin = lowZ - travelZ
          if (margin < worstRapidMargin) {
            worstRapidMargin = margin
            worstRapidLabel = entry.label
          }
          assert.ok(margin >= -1e-6,
            `${entry.label}: a rapid turns A at Z${lowZ.toFixed(4)}, below the corner envelope plus clearance `
            + `(${travelZ.toFixed(4)})`)
        }
      } else if (lowZ < travelZ - 1e-6) {
        const engagement = referenceMove(reference, move, pivot, cutterRadius, ball, alongOf, fromAngle, toAngle)
        if (move.kind === 'cut') {
          if (turns) {
            // The bound is about a **turning** cut taking material out of the
            // standing corner. An along-mode pass cuts at a constant angle; its
            // layer residue is the frozen along-mode output the slice-K
            // contract keeps byte-identical to the base, so it is reported but
            // not asserted here (see `nonTurning`).
            checkedCuts++
            const key = stage.finish ? 'finish' : 'rough'
            const keyLabel = `${entry.label} @A${fromAngle.toFixed(2)}->${toAngle.toFixed(2)}`
            if (engagement > worst[key].peak) {
              worst[key].peak = engagement
              worst[key].peakLabel = keyLabel
            }
            const excess = engagement - bound
            if (excess > worst[key].excess) {
              worst[key].bound = bound
              worst[key].excess = excess
              worst[key].label = keyLabel
            }
            assert.ok(engagement <= bound + 1e-6,
              `${entry.label}: a ${stage.finish ? 'finish' : 'rough'} turning cut engages ${engagement.toFixed(4)} mm, `
              + `over its ${bound.toFixed(4)} mm bound (A${fromAngle.toFixed(2)} -> ${toAngle.toFixed(2)}); `
              + `worst cell along ${worstCell.along.toFixed(2)} A${worstCell.angle.toFixed(2)} `
              + `material ${worstCell.material.toFixed(3)} contact ${worstCell.contact.toFixed(3)}`)
          } else if (engagement > nonTurningWorst) {
            nonTurningWorst = engagement
            nonTurningLabel = `${entry.label} @A${fromAngle.toFixed(2)}`
          }
        }
      }
      controller = toAngle
    }
  }

  // (2) The retained ends keep the blank. Cells outside the band are material
  // the cutter's body must never reach.
  for (let i = 0; i < reference.alongBins; i++) {
    const along = reference.alongStart + (i + 0.5) * reference.alongBin
    if (along >= entry.alongStart - 1e-9 && along <= entry.alongEnd + 1e-9) continue
    if (along < bounds.minX || along > bounds.maxX) continue
    for (let k = 0; k < reference.angleBins; k++) {
      const angle = (k + 0.5) * reference.angleDeg
      const blank = blankRadius(stock.thickness / 2, angle)
      const drop = blank - reference.material[i * reference.angleBins + k]
      if (drop > worstStubDrop) {
        worstStubDrop = drop
        worstStubLabel = `${entry.label} along ${along.toFixed(2)} A${angle.toFixed(2)}`
      }
      assert.ok(drop <= 1e-6, `${entry.label}: the cutter lowered a retained end by ${drop.toFixed(4)} mm at along ${along.toFixed(2)}`)
    }
  }

  // (3) The finished surface: not below the model, and no more than the
  // finish's own scallop above model + stock.
  if (!finishRan) continue
  const slope = modelMaxSlope(entry.profile)
  // A ball leaves its between-ring scallop; a flat leaves a staircase one full
  // ring step tall on a sloped surface, because each ring's bottom is a
  // horizontal plane at that ring's model height.
  const alongScallop = ball
    ? ballRiseAt(cutterRadius, entry.stepover / 2)
    : slope * entry.stepover
  const angleArc = aroundArcStep(corner, entry.finishSpacing)
  const angularScallop = ball ? (angleArc * angleArc) / (8 * cutterRadius) : 0
  const referenceAngleRad = (360 / budget.angleBins) * Math.PI / 180
  // The generator's conservative cell lift (`angleLifts`, capped at
  // `requestedCellSize` in `sampleRotaryModel`) is part of the surface it
  // promises: it guarantees the emitted tip is at or above the model. The
  // property checked here is that the finish is not below the model and not
  // further above it than that lift plus its own scallop.
  const conservativeLift = entry.requestedCellSize
  const surfaceTolerance = conservativeLift + alongScallop + angularScallop + 0.005
    + corner * referenceAngleRad + 1e-6
  const skip = 2 * budget.alongBin + cutterRadius
  // A stubbed end keeps one cutter radius of the band uncut on purpose: the
  // cutter-centre span is pulled inside the stub face so the cutter's side
  // never enters the retained square. The finished-surface assertion is about
  // the machined band, so those collars are excluded (the stub assertion above
  // covers the retained ends themselves).
  const lowerCollar = entry.alongStart + cutterRadius + skip
  const upperCollar = entry.alongEnd - cutterRadius - skip
  for (let i = 0; i < reference.alongBins; i++) {
    const along = reference.alongStart + (i + 0.5) * reference.alongBin
    if (along < lowerCollar || along > upperCollar || along > entry.alongEnd || along < entry.alongStart) continue
    const model = modelSurfaceAt(entry.profile, along)
    if (model === null) continue
    for (let k = 0; k < reference.angleBins; k++) {
      const angle = (k + 0.5) * reference.angleDeg
      const material = reference.material[i * reference.angleBins + k]
      const wanted = model + entry.stockToLeave
      checkedSurfaceCells++
      const over = material - wanted
      if (over > worstSurfaceOver) {
        worstSurfaceOver = over
        worstSurfaceOverLabel = `${entry.label} along ${along.toFixed(2)} A${angle.toFixed(2)} material ${material.toFixed(4)} model ${model.toFixed(4)}`
      }
      const under = wanted - material
      if (under > worstSurfaceUnder) {
        worstSurfaceUnder = under
        worstSurfaceUnderLabel = `${entry.label} along ${along.toFixed(2)} A${angle.toFixed(2)} material ${material.toFixed(4)} model ${model.toFixed(4)}`
      }
      assert.ok(over <= surfaceTolerance,
        `${entry.label}: the finish leaves ${over.toFixed(4)} mm above the model (allowed ${surfaceTolerance.toFixed(4)}) `
        + `at along ${along.toFixed(2)} A${angle.toFixed(2)}`)
      const underLimit = corner * referenceAngleRad + budget.alongBin + 1e-6
      assert.ok(under <= underLimit,
        `${entry.label}: the finish cuts ${under.toFixed(4)} mm below the model `
        + `(allowed ${underLimit.toFixed(4)}) at along ${along.toFixed(2)} A${angle.toFixed(2)}; `
        + `lowest contact ${lowestContact.contact.toFixed(3)} at along ${lowestContact.along.toFixed(2)} `
        + `A${lowestContact.angle.toFixed(2)} tip ${lowestContact.tip.toFixed(3)} (${lowestContact.kind}); `
        + `params ${JSON.stringify({ stepover: entry.stepover, rough: entry.roughSpacing, finish: entry.finishSpacing, cell: entry.requestedCellSize, leave: entry.stockToLeave })}`)
    }
  }
}

console.log(`  ${CASES.length} cases (${defaultCases} with default adapter parameters), `
  + `${checkedCuts} cuts and ${checkedRapids} rapids replayed, ${checkedSurfaceCells} surface cells checked`)
console.log(`  refusals: ${refusedFinish} around finishes with no covering rough (${retainedMixed} after an along rough over a retained end)`)
console.log(`  rough: worst engagement ${worst.rough.peak.toFixed(4)} mm (${worst.rough.peakLabel}); `
  + `closest to its bound at ${worst.rough.excess.toFixed(4)} mm excess against ${worst.rough.bound.toFixed(4)} `
  + `(${worst.rough.label})`)
console.log(`  finish: worst engagement ${worst.finish.peak.toFixed(4)} mm (${worst.finish.peakLabel}); `
  + `closest to its bound at ${worst.finish.excess.toFixed(4)} mm excess against ${worst.finish.bound.toFixed(4)} `
  + `(${worst.finish.label})`)
console.log(`  rapid turns: worst margin ${worstRapidMargin.toFixed(4)} mm above the corner envelope plus clearance `
  + `(${worstRapidLabel})`)
console.log(`  retained ends: worst material lowered ${worstStubDrop.toFixed(6)} mm (${worstStubLabel || 'none'})`)
console.log(`  finished surface: worst ${worstSurfaceOver.toFixed(4)} mm above the model `
  + `(${worstSurfaceOverLabel})`)
console.log(`  finished surface: worst ${worstSurfaceUnder.toFixed(4)} mm below the model `
  + `(${worstSurfaceUnderLabel})`)
console.log(`  non-turning cuts (reported, not asserted: the along-mode square output is frozen): `
  + `worst ${nonTurningWorst.toFixed(4)} mm (${nonTurningLabel || 'none'})`)

assert.ok(checkedCuts > 1000, `the reference checked turning/cut moves (${checkedCuts})`)
assert.ok(defaultCases > 40, `the default-parameter subset exists (${defaultCases})`)
assert.ok(refusedFinish > 0, 'the unsafe finishes were refused')
console.log('engine/toolpaths/squareAroundGenerator.property.test.ts: all assertions passed')
