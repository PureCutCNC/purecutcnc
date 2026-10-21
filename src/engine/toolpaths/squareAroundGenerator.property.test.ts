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
 * the true cutter body is a flat's cylinder or a ball's sphere/shank
 * (including the shank above a ball's equator), and the material is lowered
 * through the exact ray/body intersection. The reference's along, angle and Z
 * bins are four times finer than **every cell the generator uses**
 * (`stepover`, `sampleSpacing`, `aroundArcStep`, **and the `requestedCellSize`
 * height-map cell**); every move is swept continuously at that resolution
 * (#1045 slice L), so a pure plunge sweeps its whole Z travel and a slanted
 * move cannot hide a bite between the sampled fractions. The generator's
 * adaptive angular refinement is what makes the emitted motion meet its own
 * 0.005 mm surface bound, so the reference judges the *emitted moves* (not the
 * ideal endpoints) and the surface tolerance includes that stated bound. A
 * consecutive straight **commanded** A move at one along and Z is replayed as
 * the one line it describes; that is the same controller path, not a coarser
 * one. The reference's sweep, pure-plunge and ball-shank behaviour is pinned by
 * hand-computed unit cases before the seeded run.
 *
 * Each case is drawn inside a fixed work budget. A case whose drawn bar would
 * exceed it is redrawn **shorter** (20 mm is the floor) and, only at that floor,
 * has its generator sampling -- including a coarser `requestedCellSize` -- and
 * finally its `stepdown`, still inside 0.5-3 mm, coarsened. The reference's
 * 4x-finer relationship to whatever the case asks the generator for is never
 * reduced.
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
const referenceStats = { moves: 0, cells: 0, steps: 0 }
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
 * The radii at which the cutter body meets a ray `dTheta` off its axis and
 * `dx` along it, as the interval(s) of solid the ray passes through. A flat is
 * the solid `radial ≥ tip` inside its cylinder; a ball is its sphere **plus**
 * the shank above the ball's equator, exactly the emitted body. The intervals
 * are returned separately so a material radius is lowered to the boundary of
 * the interval that actually contains it, never to a different part of the body
 * (#1045 slice L).
 */
function bodyIntervals(
  ball: boolean,
  cutterRadius: number,
  tip: number,
  dTheta: number,
  dx: number,
): Array<{ contact: number; exit: number }> {
  const cos = Math.cos(dTheta)
  const sin = Math.sin(dTheta)
  const alongSq = dx * dx
  const radiusSq = cutterRadius * cutterRadius
  const reachSq = radiusSq - alongSq
  if (cos <= 0) return []
  const intervals: Array<{ contact: number; exit: number }> = []
  if (!ball) {
    // The solid is the cylinder `radial ≥ tip`: the ray enters at the bottom
    // face's own radius and leaves through the cylindrical wall.
    if (reachSq < 0) return []
    const contact = Math.max(0, tip / cos)
    const exit = Math.abs(sin) > 1e-12 ? Math.sqrt(reachSq) / Math.abs(sin) : Number.POSITIVE_INFINITY
    if (exit >= contact) intervals.push({ contact, exit })
    return intervals
  }
  const centre = tip + cutterRadius
  if (!(centre > 0)) return []
  const sinSq = sin * sin
  const discriminant = reachSq - centre * centre * sinSq
  if (discriminant >= 0) {
    const root = Math.sqrt(discriminant)
    const contact = Math.max(0, centre * cos - root)
    const exit = centre * cos + root
    if (exit >= contact) intervals.push({ contact, exit })
  }
  // The shank is the cylinder of the same radius above the ball's equator. Its
  // interval is separate here even though the real body is continuous there;
  // the removal below uses whichever interval contains the material radius.
  if (reachSq >= 0) {
    const shankStart = centre / cos
    const shankExit = Math.abs(sin) > 1e-12 ? Math.sqrt(reachSq) / Math.abs(sin) : Number.POSITIVE_INFINITY
    if (shankExit >= shankStart) intervals.push({ contact: shankStart, exit: shankExit })
  }
  // Merge overlapping intervals: the solid is the union, and material inside
  // the overlap is reached at the lowest boundary of the union.
  intervals.sort((a, b) => a.contact - b.contact)
  const merged: Array<{ contact: number; exit: number }> = []
  for (const interval of intervals) {
    const last = merged[merged.length - 1]
    if (last && interval.contact <= last.exit) last.exit = Math.max(last.exit, interval.exit)
    else merged.push({ ...interval })
  }
  return merged
}

/**
 * Apply one commanded move to the reference and return the deepest bite it
 * takes (`0` when it removes nothing measurable).
 *
 * The move is **swept continuously** (#1045 slice L): for every cell the
 * parameter interval in which the cutter body can reach that cell is derived
 * from the cell's angle, along position and standing radius (the angular reach,
 * the cutter's axial footprint, and the body's contact being at or above the
 * tip), and that interval is sampled no coarser than the reference's own angle,
 * along and Z resolution. A pure plunge has a non-zero interval in Z and its
 * whole travel is swept; a slanted move cannot hide a bite in the middle at a
 * fraction the old single "nearest" sample never visited.
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
  const dTip = toTip - fromTip
  const tipMin = Math.min(fromTip, toTip)
  const halfSpan = tipMin > 0 ? Math.asin(Math.min(1, cutterRadius / tipMin)) : Math.PI / 2
  const halfSpanDegrees = Math.min(90, halfSpan * 180 / Math.PI)
  const i0 = Math.max(0, Math.floor((Math.min(fromAlong, toAlong) - cutterRadius - alongStart) / alongBin))
  const i1 = Math.min(alongBins - 1, Math.floor((Math.max(fromAlong, toAlong) + cutterRadius - alongStart) / alongBin))
  const windowLo = Math.min(fromAngle, toAngle) - halfSpanDegrees - angleDeg
  const windowHi = Math.max(fromAngle, toAngle) + halfSpanDegrees + angleDeg
  const allAngles = windowHi - windowLo >= 360 - 1e-9
  const firstBin = allAngles ? 0 : Math.floor(windowLo / angleDeg)
  const lastBin = allAngles ? angleBins - 1 : Math.ceil(windowHi / angleDeg)
  const midAngle = fromAngle + dAngle / 2
  referenceStats.moves++
  let engagement = 0
  worstCell.depth = 0
  for (let i = i0; i <= i1; i++) {
    const cellAlong = alongStart + (i + 0.5) * alongBin
    const rowOffset = i * angleBins
    for (let cell = firstBin; cell <= lastBin; cell++) {
      const k = allAngles ? cell : ((cell % angleBins) + angleBins) % angleBins
      const cellAngle = (k + 0.5) * angleDeg
      const index = rowOffset + k
      referenceStats.cells++
      const startMaterial = material[index]
      if (!(startMaterial > 0)) continue
      let standing = startMaterial
      const materialRadius = startMaterial
      // The representative of this cell's angle nearest the move's own angle
      // span: the move can sweep past 0/360 and the cell is one direction.
      const target = cellAngle + 360 * Math.round((midAngle - cellAngle) / 360)
      const angularHalfSpan = materialRadius > cutterRadius
        ? Math.asin(Math.min(1, cutterRadius / materialRadius))
        : Math.PI / 2
      const angularHalfDeg = Math.min(90, angularHalfSpan * 180 / Math.PI)
      // The interval of the move that can reach this cell at all.
      let lo = 0
      let hi = 1
      if (Math.abs(dAngle) > 1e-12) {
        const a = (target - angularHalfDeg - fromAngle) / dAngle
        const b = (target + angularHalfDeg - fromAngle) / dAngle
        lo = Math.max(lo, Math.min(a, b))
        hi = Math.min(hi, Math.max(a, b))
        if (hi < lo) continue
      } else {
        const delta = Math.abs(((target - fromAngle + 180) % 360 + 360) % 360 - 180)
        if (delta > angularHalfDeg + angleDeg) continue
      }
      if (Math.abs(dAlong) > 1e-12) {
        const a = (cellAlong - cutterRadius - fromAlong) / dAlong
        const b = (cellAlong + cutterRadius - fromAlong) / dAlong
        lo = Math.max(lo, Math.min(a, b))
        hi = Math.min(hi, Math.max(a, b))
        if (hi < lo) continue
      } else if (Math.abs(cellAlong - fromAlong) > cutterRadius) {
        continue
      }
      // The body's contact is never below the tip, so a tip above the standing
      // material removes nothing.
      if (Math.abs(dTip) > 1e-12) {
        const boundary = (materialRadius - fromTip) / dTip
        if (dTip > 0) hi = Math.min(hi, boundary)
        else lo = Math.max(lo, boundary)
        if (hi < lo) continue
      } else if (fromTip > materialRadius) {
        continue
      }
      if (hi < 0 || lo > 1) continue
      lo = Math.max(0, lo)
      hi = Math.min(1, hi)
      // Steps no coarser than the reference's own resolution in angle, along
      // and Z.
      const steps = Math.max(1, Math.ceil(Math.max(
        Math.abs(dAngle) * (hi - lo) / angleDeg,
        Math.abs(dAlong) * (hi - lo) / alongBin,
        Math.abs(dTip) * (hi - lo) / alongBin,
      )))
      referenceStats.steps += steps + 1
      for (let step = 0; step <= steps; step++) {
        const t = steps === 0 ? lo : lo + (hi - lo) * step / steps
        const toolAlong = fromAlong + dAlong * t
        const dx = cellAlong - toolAlong
        if (dx * dx >= cutterRadius * cutterRadius) continue
        const toolAngle = fromAngle + dAngle * t
        let delta = cellAngle - toolAngle
        while (delta > 180) delta -= 360
        while (delta < -180) delta += 360
        const tip = fromTip + dTip * t
        const intervals = bodyIntervals(ball, cutterRadius, tip, delta * Math.PI / 180, dx)
        if (intervals.length === 0) continue
        let next = standing
        for (const span of intervals) {
          if (standing < span.contact - 1e-12 || standing > span.exit + 1e-12) continue
          if (span.contact < next) {
            next = span.contact
            if (span.contact < lowestContact.contact) {
              lowestContact.contact = span.contact
              lowestContact.along = cellAlong
              lowestContact.angle = cellAngle
              lowestContact.tip = tip
              lowestContact.kind = move.kind
            }
          }
        }
        if (next >= standing) continue
        const depth = startMaterial - next
        if (depth > engagement) {
          engagement = depth
          worstCell.depth = depth
          worstCell.along = cellAlong
          worstCell.angle = cellAngle
          worstCell.material = startMaterial
          worstCell.contact = next
        }
        material[index] = next
        standing = next
        if (!(standing > 0)) break
      }
    }
  }
  return engagement
}

// ── reference unit tests against hand-computed values (#1045 slice L) ─────

/**
 * One reference row with `angleBins` half-degree cells and one along bin, so a
 * cell's angle is `(k + 0.5) * 0.5` and its along position is `cellAlong`.
 */
function singleCellReference(cellAlong: number, material: number, angleBins = 720): Reference {
  const alongBin = 0.05
  const reference = createReference(
    squareStock(20, 40, 'x', { x: 0, y: 0 }),
    cellAlong - alongBin / 2,
    cellAlong + alongBin / 2,
    alongBin,
    angleBins,
  )
  reference.material.fill(material)
  return reference
}

console.log('Testing the continuous reference against hand-computed values...')
{
  const alongOf = (point: ToolpathMove['from']): number => point.x
  // Reviewer repro 1: a Ø4 flat move from tip 10 to 8 while A turns 0 -> 10.
  // The A0.25 cell is nearest the move's start, but the body reaches it deepest
  // at the end (dTheta = 9.75° with the tip at 8): the bottom face there is
  // 8 / cos(9.75°) = 8.117 mm, so material at 9.95 is cut to ~8.12, not to the
  // 9.95 the old single nearest sample reported.
  {
    const reference = singleCellReference(10, 9.95)
    const k = 0 // cell angle 0.25°
    const engagement = referenceMove(reference, {
      kind: 'cut',
      from: { x: 10, y: 10, z: 10, a: 0 },
      to: { x: 10, y: 10, z: 8, a: 10 },
    }, 0, 2, false, alongOf, 0, 10)
    const left = reference.material[k]
    const expected = 8 / Math.cos(9.75 * Math.PI / 180)
    assert.ok(Math.abs(left - expected) < 0.02,
      `flat sweep: material at A0.25 was ${left.toFixed(4)}, expected ${expected.toFixed(4)}`)
    assert.ok(left < 8.2, `flat sweep: material at A0.25 (${left.toFixed(4)}) is cut below 8.2`)
    assert.ok(engagement > 1.5, `flat sweep: engagement ${engagement.toFixed(4)} is the full bite`)
  }
  // Reviewer repro 2: a pure plunge. The whole Z travel is swept, so the
  // starting tip (10) is not the answer: the cut reaches the end tip (8).
  {
    const reference = singleCellReference(10, 9.95)
    const k = 0
    const engagement = referenceMove(reference, {
      kind: 'plunge',
      from: { x: 10, y: 10, z: 10, a: 0.25 },
      to: { x: 10, y: 10, z: 8, a: 0.25 },
    }, 0, 2, false, alongOf, 0.25, 0.25)
    assert.ok(Math.abs(reference.material[k] - 8) < 0.01,
      `pure plunge: material at A0.25 was ${reference.material[k].toFixed(4)}, expected 8`)
    assert.ok(Math.abs(engagement - 1.95) < 0.01,
      `pure plunge: engagement ${engagement.toFixed(4)}, expected 1.95`)
  }
  // Reviewer repro 3: interior ball-shank removal. A Ø4 ball (tip 2, centre 4)
  // at dTheta = 20° removes material at 5.5 mm: the sphere ends at 5.218, the
  // shank covers 4.257..5.848, and the union's lower boundary is the sphere's
  // contact 4cos20 - sqrt(16 - 16sin²20) = 2.299. The old outer-wall condition
  // skipped material above the sphere; the body reaches it.
  {
    const reference = singleCellReference(10, 5.5)
    const k = 40 // cell angle 20.25°; the cutter sits at A0.25
    referenceMove(reference, {
      kind: 'cut',
      from: { x: 10, y: 10, z: 2, a: 0.25 },
      to: { x: 10, y: 10, z: 2, a: 0.25 },
    }, 0, 2, true, alongOf, 0.25, 0.25)
    const expected = 4 * Math.cos(20 * Math.PI / 180)
      - Math.sqrt(Math.max(0, 4 - 16 * Math.sin(20 * Math.PI / 180) ** 2))
    assert.ok(Math.abs(reference.material[k] - expected) < 0.02,
      `ball shank: material at A${(k + 0.5) * 0.5} was ${reference.material[k].toFixed(4)}, expected ${expected.toFixed(4)}`)
    assert.ok(reference.material[k] < 2.4, 'ball shank: the interior shank removes down to the sphere contact')
  }
  console.log('  continuous sweep, pure plunge and ball-shank repros match')
}

// ── the seeded cases ──────────────────────────────────────────────────────

/**
 * The reference's grid is capped, and so is the number of cell visits one
 * program may cost. A case whose drawn bar would exceed the visit cap is
 * redrawn **shorter** -- never with a coarser reference -- so the 4x-finer
 * resolution above always holds. The drawn side, cutter, stepdown, stepover and
 * model are kept; only the bar length shrinks (20 mm is the stated minimum).
 */
const MAX_REFERENCE_CELLS = 250_000
const MAX_REPLAY_CELLS = 6_000_000
const MAX_ANGLE_BINS = 4_096

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
  // The reference must be finer than **every** cell the generator uses,
  // including the height-map cell it was asked for (`requestedCellSize`), which
  // the earlier budget ignored (#1045 slice L). Angle, along and Z all take
  // their step from the finest of them.
  const fineAlong = Math.min(cells.along, entry.requestedCellSize)
  const fineArc = Math.min(cells.arc, entry.requestedCellSize)
  const alongBin = fineAlong / 4
  const angleBins = Math.max(24, Math.ceil((2 * Math.PI * corner) / (fineArc / 4)))
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
      // #1045 slice L: the finish is licensed by the material the earlier
      // rough's own sampled result leaves, never by the program kind. A finish
      // with no rough (or no motion) gets no coverage and refuses a raw blank.
      squareRoughLeft: 'squareRoughLeft' in rough && rough.squareRoughLeft ? [rough.squareRoughLeft] : undefined,
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
/**
 * How much work the reference will do replaying these moves: the cells each
 * move's window covers times the sweep steps each cell is sampled at. The
 * estimate is deliberately conservative -- it is a runtime budget, not an
 * accuracy bound -- so a case whose replay would be slow is redrawn with
 * coarser generator sampling (never with a coarser reference).
 */
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
    const halfSpanDegrees = Math.min(90, tipMin > 0
      ? Math.asin(Math.min(1, radius / tipMin)) * 180 / Math.PI
      : 90)
    const i0 = Math.max(0, Math.floor((Math.min(fromAlong, toAlong) - radius - budget.alongStart) / budget.alongBin))
    const i1 = Math.min(budget.alongBins - 1, Math.floor((Math.max(fromAlong, toAlong) + radius - budget.alongStart) / budget.alongBin))
    if (i1 < i0) continue
    const windowLo = Math.min(fromAngle, toAngle) - halfSpanDegrees - budget.angleDeg
    const windowHi = Math.max(fromAngle, toAngle) + halfSpanDegrees + budget.angleDeg
    const allAngles = windowHi - windowLo >= 360 - 1e-9
    const first = allAngles ? 0 : Math.floor(windowLo / budget.angleDeg)
    const last = allAngles ? budget.angleBins - 1 : Math.ceil(windowHi / budget.angleDeg)
    const angleCount = Math.max(0, last - first + 1)
    // The sweep: a cell's relevant angular window is at most twice the cutter's
    // angular reach, and its Z travel at most the move's tip change.
    const angularSweep = Math.min(Math.abs(toAngle - fromAngle), 2 * halfSpanDegrees + budget.angleDeg)
    const steps = Math.max(1,
      Math.ceil(angularSweep / budget.angleDeg)
      + Math.ceil(Math.abs(toTip - fromTip) / budget.alongBin))
    total += (i1 - i0 + 1) * angleCount * steps
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
/** The coarsest height-map cell a case may be reduced to: one cutter radius. */
function cellCeiling(entry: Case): number {
  return Math.max(entry.requestedCellSize, Math.min(barMaxRadius(entry.stock), entry.diameter / 2))
}

/** Coarsen the generator's requested height-map cell until the reference grid fits, without generating. */
function coarsenGrid(entry: Case): Case {
  let fitted = entry
  for (let attempt = 0; attempt < 5; attempt++) {
    const budget = referenceBudget(fitted)
    if (budget.cells <= MAX_REFERENCE_CELLS && budget.angleBins <= MAX_ANGLE_BINS) break
    const ratio = Math.max(budget.cells / MAX_REFERENCE_CELLS, budget.angleBins / MAX_ANGLE_BINS, 1)
    const factor = Math.max(1.3, Math.min(5, Math.sqrt(ratio) * 1.05))
    const next = Math.min(fitted.requestedCellSize * factor, cellCeiling(fitted))
    if (next <= fitted.requestedCellSize * 1.001) break
    fitted = { ...fitted, requestedCellSize: next, defaultParams: false }
  }
  return fitted
}

function fitCase(seed: number): Fitted {
  let scale = 1
  let entry = coarsenGrid(drawCase(seed, scale))
  let program = generate(entry)
  let cells = estimateReplayCells(program, entry)
  for (let attempt = 0; attempt < 8 && (cells > MAX_REPLAY_CELLS || !fitsGrid(entry)); attempt++) {
    const length = entry.alongEnd - entry.alongStart
    if (length <= 20.5) break
    const ratio = cells > 0 ? MAX_REPLAY_CELLS / cells : 0.8
    const nextScale = scale * Math.max(0.1, Math.min(0.9, ratio * 0.95))
    if (nextScale >= scale * 0.999) break
    scale = nextScale
    entry = coarsenGrid(drawCase(seed, scale))
    program = generate(entry)
    cells = estimateReplayCells(program, entry)
  }
  // A small cutter's height-map cell is its own `radius / 3`, which the adapter
  // never coarsens, so on a large blank that is the finest grid the generator
  // asks for. The replay work scales roughly with the reference grid, which
  // scales with the inverse square of the cell: compute the step, and regenerate
  // the motion once afterwards because a coarser height map can change the tips.
  let coarseChanged = false
  for (let attempt = 0; attempt < 4 && (cells > MAX_REPLAY_CELLS || !fitsGrid(entry)); attempt++) {
    const before = referenceBudget(entry)
    const ratio = Math.max(cells / MAX_REPLAY_CELLS, before.cells / MAX_REFERENCE_CELLS, 1)
    const factor = Math.max(1.3, Math.min(5, Math.sqrt(ratio) * 1.05))
    const next = Math.min(entry.requestedCellSize * factor, cellCeiling(entry))
    if (next <= entry.requestedCellSize * 1.001) break
    entry = { ...entry, requestedCellSize: next, defaultParams: false }
    const after = referenceBudget(entry)
    cells = Math.ceil(cells * Math.max(0.02, after.cells / Math.max(1, before.cells)))
    coarseChanged = true
  }
  if (coarseChanged) {
    program = generate(entry)
    cells = estimateReplayCells(program, entry)
  }
  for (let attempt = 0; attempt < 4 && (cells > MAX_REPLAY_CELLS || !fitsGrid(entry)); attempt++) {
    const ratio = Math.max(cells / MAX_REPLAY_CELLS, referenceBudget(entry).cells / MAX_REFERENCE_CELLS, 1)
    const factor = Math.max(1.25, Math.min(3, Math.sqrt(ratio) * 1.05))
    const nextCell = Math.min(entry.requestedCellSize * factor, cellCeiling(entry))
    entry = {
      ...entry,
      stepover: Math.min(entry.stepover * factor, Math.max(0.5 * entry.diameter, entry.diameter)),
      roughSpacing: Math.min(entry.roughSpacing * factor, entry.diameter),
      finishSpacing: Math.min(entry.finishSpacing * factor, entry.diameter),
      requestedCellSize: nextCell,
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
  for (let attempt = 0; attempt < 4 && (cells > MAX_REPLAY_CELLS || !fitsGrid(entry)); attempt++) {
    const ratio = Math.max(cells / MAX_REPLAY_CELLS, 1)
    entry = { ...entry, stepdown: Math.min(3, entry.stepdown * Math.max(1.2, Math.min(1.8, ratio))), defaultParams: false }
    program = generate(entry)
    cells = estimateReplayCells(program, entry)
  }
  // `cells` is an estimated work budget used to drive coarsening, not an
  // accuracy bound; the estimate over-counts a wide angular window and is
  // deliberately not asserted. The grid itself must fit, because it is the
  // material map the reference actually allocates.
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

// `SQUARE_CASES` is a profiling aid only: the committed run uses all 300 seeded
// cases, and the assertions below still require the full set.
const CASE_COUNT = process.env.SQUARE_CASES ? Number(process.env.SQUARE_CASES) : 300
const CASES = Array.from({ length: CASE_COUNT }, (_, seed) => fitCase(seed))
if (process.env.SQUARE_ESTIMATE_ONLY) {
  const ranked = CASES.map(({ entry, program }, seed) => ({
    seed,
    estimate: estimateReplayCells(program, entry),
    budget: referenceBudget(entry),
    label: entry.label,
  })).sort((a, b) => b.estimate - a.estimate)
  for (const row of ranked.slice(0, 15)) {
    console.log(`  [estimate] seed ${row.seed}: ${row.estimate} work, ${row.budget.cells} cells, `
      + `${row.budget.alongBins}x${row.budget.angleBins} bins — ${row.label}`)
  }
  console.log(`  [estimate] total ${ranked.reduce((sum, row) => sum + row.estimate, 0)} work`)
  process.exit(0)
}

console.log(`Testing ${CASES.length} seeded generator-emitted square around programs...`)
let checkedCuts = 0
const startedAt = Date.now()
let casesDone = 0
let checkedRapids = 0
let checkedSurfaceCells = 0
let defaultCases = 0
let refusedFinish = 0
let retainedMixed = 0

for (const { entry, program } of CASES) {
  if (CASE_COUNT < 300 && casesDone % 25 === 0) {
    console.log(`  [profile] case ${casesDone}/${CASE_COUNT} (${((Date.now() - startedAt) / 1000).toFixed(1)} s)`)
  }
  casesDone++
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
  // The reference must be four times finer than both generator sampling cells
  // **and** the height-map cell the generator asked for (#1045 slice L).
  const cells = generatorCells(entry)
  assert.ok(budget.alongBin <= Math.min(cells.along, entry.requestedCellSize) / 4 * (1 + 1e-9),
    `${entry.label}: the reference's along bin ${budget.alongBin} is 4x finer than ${cells.along} and ${entry.requestedCellSize}`)
  assert.ok((2 * Math.PI * corner / budget.angleBins) <= Math.min(cells.arc, entry.requestedCellSize) / 4 * (1 + 1e-9),
    `${entry.label}: the reference's angle bin is 4x finer than ${cells.arc} and ${entry.requestedCellSize}`)

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
if (process.env.SQUARE_CASES) {
  console.log(`  [profile] ${referenceStats.moves} reference moves, ${referenceStats.cells} cell visits, `
    + `${referenceStats.steps} sweep steps; ${((Date.now() - startedAt) / 1000).toFixed(1)} s`)
}

assert.ok(checkedCuts > 1000, `the reference checked turning/cut moves (${checkedCuts})`)
// The strict 4x-finer-than-`requestedCellSize` grid coarsens most drawn cases
// (marked custom) to fit the runtime budget, so the default subset is small but
// must still exist: the set is not all custom sampling.
assert.ok(defaultCases > 0, `the default-parameter subset exists (${defaultCases})`)
assert.ok(refusedFinish > 0, 'the unsafe finishes were refused')

// ── the slice-L licensing cases (#1045 slice L) ───────────────────────────
//
// Every one of these is refused by the generator and emits no motion; none may
// be posted. The finish is licensed by the material a rough's own result
// leaves, so an ineffective rough, a rough that leaves too much, and the
// operation-list-only cases all license nothing.
console.log('Testing the slice-L licensing cases...')
{
  const stock = squareStock(20, 40, 'x', { x: 0, y: 0 })
  const model = revolved(stock, [{ along: 12, radius: 5 }, { along: 28, radius: 5 }])
  const tool = normalizedTool('flat_endmill', 4)
  const base = {
    stepover: 2, sampleSpacing: 1, stockToLeave: 0, alongStart: 12, alongEnd: 28,
    safeRadius: 30, requestedCellSize: 0.2,
  }
  const refused = (result: { moves: ToolpathMove[]; warnings: Array<{ code: string }> }, label: string): void => {
    assert.deepEqual(result.moves, [], `${label} emits no motion`)
    assert.ok(result.warnings.some((warning) => warning.code === 'rotarySquareFinishNeedsRough'),
      `${label} is refused with the rough-first code`)
  }

  // A rough with **no motion** licenses nothing: zero stepdown refuses the
  // rough itself, so there is no result to hand the finish.
  const zero = generateRotaryRough('licence-zero', model, stock, tool, {
    ...base, stepdown: 0, passDirection: 'around',
  }, {})
  assert.deepEqual(zero.moves, [], 'a zero-stepdown rough emits no motion')
  assert.deepEqual(zero.warnings.map((warning) => warning.code), ['stepdownPositive'])
  refused(generateRotaryFinish('licence-zero-finish', model, stock, tool, {
    ...base, passDirection: 'around',
  }, {}), 'a finish with no rough result')

  // A rough that leaves 5 mm above a zero-allowance finish: the bite is far
  // over the finish's bound.
  const leaving = generateRotaryRough('licence-leaving', model, stock, tool, {
    ...base, stepdown: 2, stockToLeave: 5, passDirection: 'around',
  }, {})
  assert.ok(leaving.moves.length > 0, 'the rough leaving 5 mm cuts')
  assert.ok(leaving.squareRoughLeft, 'and reports the material it leaves')
  refused(generateRotaryFinish('licence-mismatch', model, stock, tool, {
    ...base, stockToLeave: 0, passDirection: 'around',
    squareRoughLeft: [leaving.squareRoughLeft!],
  }, {}), 'a finish with a zero allowance under a rough leaving 5 mm')

  // The same rough with a matching allowance is a legitimate pair.
  const matched = generateRotaryFinish('licence-matched', model, stock, tool, {
    ...base, stockToLeave: 5, passDirection: 'around',
    squareRoughLeft: [generateRotaryRough('licence-matched-rough', model, stock, tool, {
      ...base, stepdown: 2, stockToLeave: 5, passDirection: 'around',
    }, {}).squareRoughLeft!],
  }, {})
  assert.deepEqual(matched.warnings, [], 'a matching 5 mm allowance licenses the finish')
  assert.ok(matched.moves.length > 0, 'and it cuts')
  console.log('  zero-stepdown, mismatched and matched allowances behave')
}
console.log('engine/toolpaths/squareAroundGenerator.property.test.ts: all assertions passed')
