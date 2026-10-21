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
 * and ball cutters, Ø1-12, a bare around rough, a bare around finish, around
 * rough + around finish, and along rough + around finish, with and without
 * retained ends, `stepdown` 0.5-3 mm (one seed in ten draws the low end; the
 * rest take 3 mm, since a millimetre-scale layer multiplies both the emitted
 * rings and the replay), default and custom stepover/sampling, blanks from 10
 * to 60 mm square and 20 to 1 000 mm long (every size band, the large ones on
 * one seed in eight) -- and replays each one, in order, through its own
 * reference. Since #1045 slice M removed the finish's licensing, a bare around
 * finish clears its own blank and cuts, so every one of those programs is
 * replayed. At least 30 of them (every eighth seed) are **default-parameter**
 * programs on a shortened bar: their generator sampling is never coarsened, so
 * the defaults the adapter actually emits are covered rather than only the
 * coarsened draws. (The non-compact draws ask for a coarser sampling than the
 * adapter's defaults for the run's time budget; the reference stays four times
 * finer than whatever the case asks for.)
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
 * one. A run of A-cuts whose interior points all lie within 0.05 mm of the
 * chord is replayed as that chord too: a ring emitted as hundreds of short
 * fragments would otherwise re-scan its whole cutter footprint for every
 * fragment, and 0.05 mm is an order of magnitude tighter than the 0.49 mm gouge
 * this suite exists to catch (and far inside `alongBin + ballRise`). The reference's sweep, pure-plunge, ball-shank and interior-span behaviour
 * is pinned by hand-computed unit cases before the seeded run. An interval wholly
 * inside the standing solid removes an interior span without crossing the
 * surface; a scalar radial map cannot show the cavity, so its span is recorded
 * separately (`interiorWorst`) and reported, not folded into the surface
 * engagement -- a chord near a cutter's footprint edge can be long while the
 * undercut itself is a fraction of a millimetre (#1045 slice M).
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
 * 1. no turning cut **or plunge** engages more than its operation's bound --
 *    a rough's `stepdown`, a finish's `stockToLeave` plus the rough's layer
 *    allowance, each plus the stated reference tolerance. (An along-mode stage's
 *    non-turning cuts stay reported rather than asserted: that output is frozen
 *    byte-for-byte to the base, and a footprint-edge chord there is not a
 *    radial depth.)
 * 2. no cutter body enters a retained end: every reference cell outside the
 *    band keeps the blank's material;
 * 3. no rapid turns A below the blank's corner radius plus 1 mm clearance;
 * 4. the finished surface is within tolerance of the model -- it is not cut
 *    below it, and no more than the finish's own scallop plus the sampler's
 *    stated cell lift is left above it.
 *
 * #1045 slice M removed the finish's licensing entirely: a square around finish
 * clears the standing blank above its own finish surface in the around rough's
 * layered rings before it follows the model, so it depends on no other
 * operation. Nothing is refused here; the self-clearing layers are what the
 * engagement bound and the surface tolerance judge.
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
import type { NormalizedTool, ToolpathMove, ToolpathPoint } from './types'

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
/**
 * The deepest **interior** span any move's body occupied inside standing
 * material without crossing its surface (#1045 slice M). A scalar radial map
 * cannot represent the cavity, so this is recorded separately rather than folded
 * into the surface engagement: a chord near a cutter's footprint edge can be
 * long while the undercut itself is a fraction of a millimetre, so it is not the
 * operation's radial depth.
 */
export const interiorWorst = { depth: 0, along: 0, angle: 0, kind: '' }
const referenceStats = { moves: 0, cells: 0, steps: 0 }
const lowestContact = { contact: Number.POSITIVE_INFINITY, along: 0, angle: 0, tip: 0, kind: '' }

interface Reference {
  alongStart: number
  alongBins: number
  alongBin: number
  angleBins: number
  angleDeg: number
  /** The blank's largest radius, an upper bound on any cell's material. */
  maxMaterial: number
  /**
   * Bin stride of the cheap interior-removal diagnostic (#1045 slice M). It is
   * a report, not an assertion, so the seeded run samples it; the hand-computed
   * unit references keep 1 and are exact.
   */
  interiorStride: number
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
  return { alongStart, alongBins, alongBin, angleBins, angleDeg, maxMaterial: Math.hypot(halfSide, halfSide), interiorStride: 1, material }
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
 * The widest angle off its axis at which the cutter body can reach a cell whose
 * standing material reaches `materialRadius` (#1045 slice M).
 *
 * A ball's body -- the sphere **and** the shank above its equator -- stays
 * within `asin(R / (tip + R))` of the axis, because every point of it is inside
 * the cylinder of radius `R` about the axis whose closest radius to the turn
 * centre is `tip + R`. That bound is independent of the material: a ray 20 deg
 * off a Ø4 ball at tip 2 crosses the body at radii 2.30..5.85, so material out
 * at 6.5 is still reached in the interior. The old `asin(R / materialRadius)`
 * admitted only 8.9 deg there and skipped the cell entirely.
 *
 * A flat's bottom face crosses a ray at `tip / cos(delta)`, so material out to
 * `M` is reachable up to `acos(tip / M)`; `asin(R / M)` (the cylinder wall at
 * the material radius) understated that too.
 */
function bodyAngularReachDeg(ball: boolean, cutterRadius: number, tip: number, materialRadius: number): number {
  if (ball) {
    const centre = tip + cutterRadius
    return centre > cutterRadius ? Math.min(90, Math.asin(cutterRadius / centre) * 180 / Math.PI) : 90
  }
  if (!(tip > 0)) return 90
  if (!(materialRadius > tip)) return 0
  return Math.min(90, Math.acos(tip / materialRadius) * 180 / Math.PI)
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
  // A body can only *lower a surface* where it reaches the material radius at
  // all. The wall of the cutter's axial cylinder meets a radius `M` at
  // `asin(R / M)`, and no body point can leave that cylinder; the sphere can
  // add up to its own angular extent `asin(R / (tip + R))` for a ball. Taking
  // the material's bound as the blank's own largest radius -- never the tip,
  // which for a deep layer is far inside the stock and made this window a whole
  // 90 degrees on every flat -- is what keeps the swept window affordable. The
  // wider true extent is used only by the cheap interior pass below.
  const wallReach = Math.min(90, Math.asin(Math.min(1, cutterRadius / reference.maxMaterial)) * 180 / Math.PI)
  const sphereReach = ball && tipMin + cutterRadius > 0
    ? Math.min(90, Math.asin(Math.min(1, cutterRadius / (tipMin + cutterRadius))) * 180 / Math.PI)
    : wallReach
  const halfSpanDegrees = Math.max(wallReach, sphereReach)
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
      const angularHalfDeg = materialRadius > cutterRadius
        ? Math.min(90, Math.asin(cutterRadius / materialRadius) * 180 / Math.PI)
        : 90
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
          // A body whose solid starts at or above the standing surface is in
          // air here.
          if (span.contact >= standing - 1e-12) continue
          if (span.contact < lowestContact.contact) {
            lowestContact.contact = span.contact
            lowestContact.along = cellAlong
            lowestContact.angle = cellAngle
            lowestContact.tip = tip
            lowestContact.kind = move.kind
          }
          // An interval that crosses the standing surface lowers it to its
          // entrance. One wholly inside the solid removes an interior span and
          // leaves the outermost stock standing (a scalar radial map cannot
          // show the cavity); that removal is recorded in {@link interiorWorst}
          // instead of being lost (#1045 slice M).
          if (standing > span.exit + 1e-12) {
            const inside = span.exit - span.contact
            if (inside > interiorWorst.depth) {
              interiorWorst.depth = inside
              interiorWorst.along = cellAlong
              interiorWorst.angle = cellAngle
              interiorWorst.kind = move.kind
            }
            continue
          }
          if (span.contact < next) next = span.contact
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
  // #1045 slice M: record the **interior** removal the surface sweep cannot
  // represent. A body interval wholly inside the standing solid leaves the
  // outermost stock standing, so it takes no surface engagement -- but the
  // material was still there and the cutter still occupied it. One pose per
  // cell at the move's deepest endpoint is enough for the diagnostic, and it is
  // cheap enough to use the body's true angular extent (`bodyAngularReachDeg`),
  // which the surface sweep cannot afford. The body's extent for a ball is
  // `asin(R / (tip + R))`; on the reviewer's Ø4 ball at tip 2 and a ray 20 deg
  // off, the surface window `asin(R / 6.5)` is only 8.9 deg and would skip the
  // cell entirely.
  const deepAtEnd = toTip <= fromTip
  const deepTip = deepAtEnd ? toTip : fromTip
  const deepAlong = deepAtEnd ? toAlong : fromAlong
  const deepAngle = deepAtEnd ? toAngle : fromAngle
  const wideHalfDeg = bodyAngularReachDeg(ball, cutterRadius, deepTip, reference.maxMaterial)
  const wideLo = deepAngle - wideHalfDeg - angleDeg
  const wideHi = deepAngle + wideHalfDeg + angleDeg
  const wideAll = wideHi - wideLo >= 360 - 1e-9
  const wideFirst = wideAll ? 0 : Math.floor(wideLo / angleDeg)
  const wideLast = wideAll ? angleBins - 1 : Math.ceil(wideHi / angleDeg)
  const stride = Math.max(1, reference.interiorStride)
  for (let i = i0; i <= i1; i += stride) {
    const cellAlong = alongStart + (i + 0.5) * alongBin
    const dx = cellAlong - deepAlong
    if (dx * dx >= cutterRadius * cutterRadius) continue
    const rowOffset = i * angleBins
    for (let cell = wideFirst; cell <= wideLast; cell += stride) {
      const k = wideAll ? cell : ((cell % angleBins) + angleBins) % angleBins
      const materialRadius = material[rowOffset + k]
      if (!(materialRadius > 0)) continue
      const cellAngle = (k + 0.5) * angleDeg
      let delta = cellAngle - deepAngle
      while (delta > 180) delta -= 360
      while (delta < -180) delta += 360
      const intervals = bodyIntervals(ball, cutterRadius, deepTip, delta * Math.PI / 180, dx)
      for (const span of intervals) {
        if (span.contact >= materialRadius - 1e-12) continue
        if (span.exit < materialRadius - 1e-12) {
          const inside = span.exit - span.contact
          if (inside > interiorWorst.depth) {
            interiorWorst.depth = inside
            interiorWorst.along = cellAlong
            interiorWorst.angle = cellAngle
            interiorWorst.kind = move.kind
          }
        }
      }
    }
  }
  return engagement
}

/**
 * The common engagement assertion for a turning cut and for a plunge (#1045
 * slice M). Extracted so a hand-built over-bound plunge is checked directly by
 * the unit block below: a mutation that turns this check into a no-op fails
 * there as well as in the seeded run.
 */
function checkEngagement(engagement: number, bound: number, message: string): void {
  assert.ok(engagement <= bound + 1e-6,
    `${message} engages ${engagement.toFixed(4)} mm, over its ${bound.toFixed(4)} mm bound`)
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
  // Reviewer repro 4 (#1045 slice M): interior removal with the material above
  // the body. The same Ø4 ball at 20 deg occupies radii 2.299..5.848. With the
  // solid out to 6.5 the whole body is inside it: the outermost surface cannot
  // move (the body never crosses it), but the 3.548 mm span the body removes is
  // interior material and must be recorded as engagement, not lost. The old
  // `standing > exit` skip reported zero there.
  {
    const reference = singleCellReference(10, 6.5)
    const k = 40 // cell angle 20.25 deg; the cutter sits at A0.25
    // Stand material only at the cell under test, so the returned engagement is
    // that cell's and not a nearer cell's (the ray at the cutter's own angle is
    // cut much deeper).
    reference.material.fill(0)
    reference.material[k] = 6.5
    const engagement = referenceMove(reference, {
      kind: 'cut',
      from: { x: 10, y: 10, z: 2, a: 0.25 },
      to: { x: 10, y: 10, z: 2, a: 0.25 },
    }, 0, 2, true, alongOf, 0.25, 0.25)
    const radians = 20 * Math.PI / 180
    const contact = 4 * Math.cos(radians)
      - Math.sqrt(Math.max(0, 4 - 16 * Math.sin(radians) ** 2))
    const exit = 2 / Math.sin(radians)
    assert.equal(engagement, 0,
      'interior span: the body never crosses the surface, so it takes no surface engagement')
    assert.ok(Math.abs(interiorWorst.depth - (exit - contact)) < 0.02,
      `interior span: recorded span ${interiorWorst.depth.toFixed(4)}, expected ${(exit - contact).toFixed(4)}`)
    assert.equal(reference.material[k], 6.5,
      'interior span: the outermost stock is unchanged, because the body never crosses it')
  }
  // Reviewer repro 5 (#1045 slice M): the engagement bound is checked for a
  // plunge as well as a turning cut. A plunge that takes more than its bound
  // must be reported; this is the assertion the seeded run applies to every
  // plunge, exercised directly so dropping the check fails here too.
  {
    assert.throws(() => checkEngagement(4.5, 3, 'plunge repro'), /plunge repro engages 4\.5000 mm/,
      'an over-bound plunge is reported')
    checkEngagement(3, 3, 'plunge at its bound')
  }
  console.log('  continuous sweep, pure plunge, ball-shank and interior-span repros match')
}

// ── the seeded cases ──────────────────────────────────────────────────────

/**
 * The reference's grid is capped, and so is the number of cell visits one
 * program may cost. A case whose drawn bar would exceed the visit cap is
 * redrawn **shorter** -- never with a coarser reference -- so the 4x-finer
 * resolution above always holds. The drawn side, cutter, stepdown, stepover and
 * model are kept; only the bar length shrinks (20 mm is the stated minimum).
 */
const MAX_REFERENCE_CELLS = 150_000
const MAX_REPLAY_CELLS = 400_000
/**
 * How far an intermediate commanded point may sit from the chord that replaces
 * its run, in millimetres (#1045 slice M). Every move is still swept at the
 * reference's own resolution, but a ring emitted as hundreds of three-degree
 * fragments would otherwise re-scan its whole footprint for each fragment. A
 * 0.05 mm chord tolerance is far inside this file's stated bound
 * (`alongBin + ballRise` on the order of a third of a millimetre) and an order
 * of magnitude tighter than the 0.49 mm gouge this suite was built to catch.
 */
const COALESCE_TOLERANCE = 0.05
const MAX_ANGLE_BINS = 2_048

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
  /** A default-parameter case whose bar is drawn short; never coarsened. */
  compact: boolean
  /**
   * The finish's own clearing depth. A finish usually carries the tool's
   * `defaultStepdown`, not the rough's drawn value; keeping it at 1.5 mm or more
   * also keeps the replay affordable, because the finish now clears its own
   * blank (#1045 slice M) and half-millimetre layers on a 60 mm blank would
   * dominate the run.
   */
  finishStepdown: number
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
  // #1045 slice M: every eighth seed is a **default-parameter** program on a
  // short bar. Its grid and replay are affordable without coarsening anything,
  // so the default cutting programs the adapter actually produces are replayed,
  // not only custom-sampling ones. The shapes cycle through finish-only,
  // rough+finish, along-rough + around-finish and rough-only, and the retained
  // ends alternate, so every combination is covered on both sides.
  if (seed % 8 === 0) {
    const compactKinds: ProgramKind[] = ['finish', 'both', 'mixed', 'rough', 'finish', 'both', 'mixed', 'both']
    const slot = Math.floor(seed / 8)
    const programKind = compactKinds[slot % compactKinds.length]
    const roughKind = programKind === 'mixed' ? 'along' as const : 'around' as const
    // Short bars and a cutter large against the blank keep the reference grid
    // and the replay affordable at the adapter's own defaults.
    const side = Math.round(pick(24, 30) * 2) / 2
    const length = Math.max(20, Math.round(pick(20, 24) * lengthScale))
    // Mostly balls: the surface sweep's window is `asin(R / material)`, so a
    // ball's replay is affordable at default parameters; an eighth of the
    // default cases carry a flat so flats are covered too.
    const type = slot % 8 === 0 ? 'flat_endmill' as const : 'ball_endmill' as const
    const diameter = Math.round(pick(8, Math.min(12, side * 0.5)) * 10) / 10
    const radius = diameter / 2
    const inscribed = side / 2
    const modelRadius = Math.round(pick(0.7, 0.9) * inscribed * 10) / 10
    const endsWanted = slot % 3 !== 2
    const ends = endsWanted ? Math.max(1, Math.round(pick(0.05, 0.15) * length)) : 0
    const bounds = getStockBounds(squareStock(side, length, 'x', { x: 0, y: 0 }))
    const alongStart = bounds.minX + ends
    const alongEnd = bounds.maxX - ends
    const modelKind = seed % 2
    const profile: { along: number; radius: number }[] = modelKind === 0
      ? [{ along: alongStart, radius: modelRadius }, { along: alongEnd, radius: modelRadius }]
      : [
        { along: alongStart, radius: modelRadius },
        { along: alongEnd, radius: Math.max(0.6, modelRadius * pick(0.6, 0.95)) },
      ]
    const defaultStepover = Math.max(0.5 * diameter, 1e-3)
    const stepover = defaultStepover
    const roughSpacing = Math.max(radius / 2, 1e-3)
    const finishSpacing = Math.max(radius / 4, 1e-3)
    const requestedCellSize = Math.min(radius / 3, defaultStepover * 0.5)
    // The layer depth matters here: it drives the finish's own clearing, and a
    // millimetre-scale default keeps a deep corner to a handful of layers.
    const stepdown = Math.round(pick(2.5, 3) * 10) / 10
    return {
      label: `${type === 'ball_endmill' ? 'ball' : 'flat'} D${diameter} ${side}x${length} `
        + `${modelKind === 0 ? 'cyl' : 'cone'} ${programKind} ${roughKind} rough `
        + `ends ${ends} stepdown ${stepdown} default`,
      stock: squareStock(side, length, 'x', { x: 0, y: 0 }),
      profile,
      type,
      diameter,
      stepdown,
      stepover,
      roughSpacing,
      finishSpacing,
      requestedCellSize,
      stockToLeave: 0,
      programKind,
      roughKind,
      retained: ends > 0,
      alongStart,
      alongEnd,
      defaultParams: true,
      compact: true,
      finishStepdown: 3,
    }
  }
  // Every size band is covered, but the large ones only on one seed in eight:
  // the reference's cells and sweep steps scale with the side, and a uniform
  // draw over 10-60 mm spends most of the run on the top band.
  const scale = [0, 1, 0, 2, 0, 1, 0, 3, 0, 1, 0, 2, 0, 1, 0, 1][seed % 16]
  const sizeRanges: ReadonlyArray<{ side: [number, number]; length: [number, number] }> = [
    { side: [10, 18], length: [20, 40] },
    { side: [16, 28], length: [40, 110] },
    { side: [24, 40], length: [110, 300] },
    { side: [36, 60], length: [300, 1000] },
  ]
  const size = sizeRanges[scale]
  const side = Math.round(pick(size.side[0], size.side[1]) * 2) / 2
  const length = Math.max(20, Math.round(pick(size.length[0], size.length[1]) * lengthScale))
  // A flat's replay is the expensive shape (the cutter's wall reaches a given
  // material radius at `asin(R/M)`, and its ring follows the square's own
  // corner more closely than a ball's), so a quarter of the seeds carry one.
  const type = seed % 4 === 0 ? 'flat_endmill' as const : 'ball_endmill' as const
  // The cutter scales with the blank, so the set covers Ø1-12 without asking a
  // sub-millimetre tool to machine a metre of stock in this test.
  const diameter = Math.round(pick(
    scale === 0 ? 1 : scale === 1 ? 2 : scale === 2 ? 3 : 6,
    Math.min(12, side * 0.5),
  ) * 10) / 10
  const radius = diameter / 2
  const inscribed = side / 2
  // Most programs leave a realistic corner to clear; a quarter keep a deep
  // one (the finish's self-clearing is most demanding there).
  const modelRadius = Math.round(pick(seed % 4 === 0 ? 0.4 : 0.6, 0.9) * inscribed * 10) / 10
  // A bare around rough is the most expensive program to replay (every ring
  // follows the raw square's corner), so it is one seed in eight; the finish and
  // the mixed and rough+finish programs carry the rest of the coverage.
  const kinds: ProgramKind[] = ['both', 'rough', 'finish', 'mixed', 'both', 'mixed', 'both', 'mixed']
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
  // A cone makes every ring's Z change and keeps more of the emitted
  // polyline; a quarter of the seeds carry one.
  const modelKind = seed % 4 === 0 ? 1 : 0
  const profile: { along: number; radius: number }[] =
    modelKind === 0
      ? [{ along: alongStart, radius: modelRadius }, { along: alongEnd, radius: modelRadius }]
      : [
        { along: alongStart, radius: modelRadius },
        { along: alongEnd, radius: Math.max(0.6, modelRadius * pick(0.55, 0.95)) },
      ]
  // The default adapter parameters for this tool and operation kind.
  const defaultStepover = Math.max(0.5 * diameter, 1e-3)
  // The seeded set is one program per seed and the reference replays all 300
  // inside its time budget, so a non-compact case asks for a coarser sampling
  // than the adapter's default: the **default** sampling and the default
  // cutting programs are the compact subset (every eighth seed), which is never
  // coarsened. Coarser sampling also coarsens the reference by the same 4x
  // relationship, never the other way round.
  const roughSpacing = Math.max(radius, 1e-3)
  const finishSpacing = Math.max(radius / 2, 1e-3)
  const requestedCellSize = Math.min(radius / 2, defaultStepover * 0.5)
  const custom = seed % 5 === 0
  const stepover = custom ? Math.max(pick(0.6, 1) * diameter, 1e-3) : Math.max(0.75 * diameter, 1e-3)
  const rough = roughSpacing
  const finish = finishSpacing
  const cell = requestedCellSize
  // One seed in ten draws a stepdown anywhere in 0.5-3 (the range the review
  // asks the set to cover); the rest take 3 mm, because a millimetre-scale
  // layer on a 60 mm corner multiplies both the emitted rings and the reference
  // replay by the layer count. The covered range is unchanged; the distribution
  // is not uniform.
  const stepdown = seed % 10 === 3 ? Math.round(pick(0.5, 3) * 10) / 10 : 3
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
    defaultParams: false,
    compact: false,
    finishStepdown: Math.max(stepdown, 2),
  }
}

/** The reference grid limit for one case. Default-parameter cases keep the full
 *  resolution; a coarsened non-compact case may run on a smaller grid, which
 *  coarsens the generator's requested cells too (the 4x relationship holds). */
function referenceLimits(entry: Case): { cells: number; angleBins: number } {
  return entry.compact
    ? { cells: MAX_REFERENCE_CELLS, angleBins: MAX_ANGLE_BINS }
    : { cells: 100_000, angleBins: 1_024 }
}

/** Whether the reference's grid itself fits the per-case cell budget. */
function fitsGrid(entry: Case): boolean {
  const budget = referenceBudget(entry)
  const limit = referenceLimits(entry)
  return budget.cells <= limit.cells && budget.angleBins <= limit.angleBins
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
    // The rough's own sampling. The finish reads its own in the call below.
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
      // #1045 slice M: the finish clears its own standing material, so it needs
      // no earlier result. Its clearing layers use the finish's own stepdown.
      stepdown: entry.finishStepdown,
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
function coalesceCommandedMoves(moves: readonly ToolpathMove[], tolerance = 0): ToolpathMove[] {
  const out: ToolpathMove[] = []
  const intermediates: ToolpathPoint[][] = []
  const collinear = (point: ToolpathPoint, chord: ToolpathMove, tol: number): boolean => {
    if (chord.from.a === undefined || chord.to.a === undefined) return false
    const span = chord.to.a - chord.from.a
    if (span === 0) return false
    const fraction = ((point.a ?? 0) - chord.from.a) / span
    if (!(fraction > -1e-9 && fraction < 1 + 1e-9)) return false
    const f = Math.min(1, Math.max(0, fraction))
    const x = chord.from.x + (chord.to.x - chord.from.x) * f
    const z = chord.from.z + (chord.to.z - chord.from.z) * f
    return Math.abs(point.x - x) <= tol + 1e-12 && Math.abs(point.z - z) <= tol + 1e-12
  }
  for (const move of moves) {
    const last = out[out.length - 1]
    const joins = last !== undefined
      && last.kind === 'cut' && move.kind === 'cut'
      && last.from.x === last.to.x && move.from.x === move.to.x
      && last.to.x === move.from.x && last.to.y === move.from.y && last.to.z === move.from.z
      && last.to.a === move.from.a
      && last.from.a !== undefined && last.to.a !== undefined
      && move.to.a !== undefined
      && last.from.a !== last.to.a && move.from.a !== move.to.a
      && Math.sign(last.to.a - last.from.a) === Math.sign(move.to.a! - move.from.a!)
    if (joins && last) {
      const candidate: ToolpathMove = { kind: 'cut', from: last.from, to: move.to }
      const points = [...(intermediates[intermediates.length - 1] ?? []), last.to]
      if (points.every((point) => collinear(point, candidate, tolerance))) {
        out[out.length - 1] = candidate
        intermediates[intermediates.length - 1] = points
        continue
      }
    }
    out.push(move)
    intermediates.push([])
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
  const ball = entry.type === 'ball_endmill'
  const alongOf = (point: ToolpathMove['from']): number => point.x
  const travel = pivot + barMaxRadius(entry.stock) + 1
  let total = 0
  let controller = 0
  for (const move of coalesceCommandedMoves([...program.roughMoves, ...program.finishMoves], COALESCE_TOLERANCE)) {
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
    const wallReach = Math.min(90, Math.asin(Math.min(1, radius / barMaxRadius(entry.stock))) * 180 / Math.PI)
    const sphereReach = ball && tipMin + radius > 0
      ? Math.min(90, Math.asin(Math.min(1, radius / (tipMin + radius))) * 180 / Math.PI)
      : wallReach
    const halfSpanDegrees = Math.max(wallReach, sphereReach)
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
    const limit = referenceLimits(fitted)
    if (budget.cells <= limit.cells && budget.angleBins <= limit.angleBins) break
    const ratio = Math.max(budget.cells / limit.cells, budget.angleBins / limit.angleBins, 1)
    const factor = Math.max(1.3, Math.min(5, Math.sqrt(ratio) * 1.05))
    const next = Math.min(fitted.requestedCellSize * factor, cellCeiling(fitted))
    if (next <= fitted.requestedCellSize * 1.001) break
    fitted = { ...fitted, requestedCellSize: next, defaultParams: false }
  }
  return fitted
}

function fitCase(seed: number): Fitted {
  const initial = drawCase(seed, 1)
  if (initial.compact) {
    // A default-parameter case is never coarsened: the drawn side, cutter,
    // stepdown and sampling are the adapter's defaults, and the short bar is
    // what makes its reference affordable. If the grid does not fit, the draw
    // itself is wrong and must be fixed rather than silently degraded.
    assert.ok(fitsGrid(initial), `${initial.label}: a default-parameter case must fit the reference grid`)
    return { entry: initial, program: generate(initial) }
  }
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
    entry = {
      ...entry,
      // Both radial depths, not only the rough's: the finish now clears its own
      // blank (#1045 slice M), so a half-millimetre finish stepdown on a tall
      // corner is the most expensive input in the set.
      stepdown: Math.min(3, entry.stepdown * Math.max(1.2, Math.min(1.8, ratio))),
      finishStepdown: Math.min(3, entry.finishStepdown * Math.max(1.2, Math.min(1.8, ratio))),
      defaultParams: false,
    }
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
let defaultFinishOnly = 0
let defaultRoughOnly = 0
let defaultBoth = 0
let defaultMixed = 0
let defaultRetained = 0
let defaultFree = 0
let profileSteps = 0
let profileMoves = 0
let checkedPlunges = 0
let worstPlunge = 0
let worstPlungeLabel = ''

for (const { entry, program } of CASES) {
  if (process.env.SQUARE_PROFILE) {
    console.log(`  [case] ${casesDone} ${((Date.now() - startedAt) / 1000).toFixed(1)} s${entry.compact ? ' compact' : ''} `
      + `est ${estimateReplayCells(program, entry)} steps ${referenceStats.steps - profileSteps} `
      + `moves ${referenceStats.moves - profileMoves} sd ${entry.stepdown}/${entry.finishStepdown} ${entry.programKind} — ${entry.label}`)
    profileSteps = referenceStats.steps
    profileMoves = referenceStats.moves
  }
  casesDone++
  if (entry.defaultParams) {
    defaultCases++
    if (entry.programKind === 'finish') defaultFinishOnly++
    else if (entry.programKind === 'rough') defaultRoughOnly++
    else if (entry.programKind === 'both') defaultBoth++
    else defaultMixed++
    if (entry.retained) defaultRetained++
    else defaultFree++
  }
  const stock = entry.stock
  const tool = normalizedTool(entry.type, entry.diameter)
  const cutterRadius = tool.radius
  const ball = entry.type === 'ball_endmill'
  const pivot = barPivotZ(stock)
  const corner = barMaxRadius(stock)
  const clearance = 1
  const travelZ = pivot + corner + clearance

  const roughRan = entry.programKind !== 'finish'
  const finishRan = entry.programKind !== 'rough'
  if (roughRan) {
    assert.ok(program.roughMoves.length > 0, `${entry.label}: the rough emits motion`)
    assert.deepEqual(program.roughCodes, [], `${entry.label}: the rough warns about nothing`)
  }
  if (finishRan) {
    // #1045 slice M: with the licensing gone a bare finish clears its own blank
    // and cuts; so does one after any rough, retained ends or not.
    assert.ok(program.finishMoves.length > 0, `${entry.label}: the around finish clears itself and cuts`)
    assert.deepEqual(program.finishCodes, [], `${entry.label}: the finish warns about nothing`)
  }

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
  reference.interiorStride = 4

  const finishBound = entry.stockToLeave + entry.finishStepdown
    + budget.alongBin + ballRiseAt(cutterRadius, budget.alongBin) + 1e-6
  const roughBound = entry.stepdown + budget.alongBin + ballRiseAt(cutterRadius, budget.alongBin) + 1e-6
  const stages: Array<{ moves: ToolpathMove[]; finish: boolean }> = []
  if (roughRan) stages.push({ moves: coalesceCommandedMoves(program.roughMoves, COALESCE_TOLERANCE), finish: false })
  if (finishRan) stages.push({ moves: coalesceCommandedMoves(program.finishMoves, COALESCE_TOLERANCE), finish: true })
  assert.ok(stages.length > 0, `${entry.label}: the program has motion`)

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
            checkEngagement(engagement, bound,
              `${entry.label}: a ${stage.finish ? 'finish' : 'rough'} turning cut `
              + `(A${fromAngle.toFixed(2)} -> ${toAngle.toFixed(2)}; worst cell along ${worstCell.along.toFixed(2)} `
              + `A${worstCell.angle.toFixed(2)} material ${worstCell.material.toFixed(3)} contact ${worstCell.contact.toFixed(3)})`)
          } else if (engagement > nonTurningWorst) {
            nonTurningWorst = engagement
            nonTurningLabel = `${entry.label} @A${fromAngle.toFixed(2)}`
          }
        } else if (move.kind === 'plunge') {
          // A plunge enters stock from the travel height, so its whole Z travel
          // is swept and the material it takes must fit the same bound (#1045
          // slice M; the engagement was computed but never asserted before).
          // The around stage is the slice's own motion and is asserted. An
          // along-stage plunge is part of the frozen along output: like that
          // stage's non-turning cuts, it is reported rather than asserted,
          // because a plunge at the band edge cuts the shoulder the generator
          // deliberately leaves within one cutter radius of a stub.
          const around = stage.finish || entry.roughKind === 'around'
          if (!around) {
            if (engagement > nonTurningWorst) {
              nonTurningWorst = engagement
              nonTurningLabel = `${entry.label} @A${fromAngle.toFixed(2)} plunge`
            }
          } else {
            checkedPlunges++
            const keyLabel = `${entry.label} @A${fromAngle.toFixed(2)}`
            if (engagement > worstPlunge) {
              worstPlunge = engagement
              worstPlungeLabel = keyLabel
            }
            checkEngagement(engagement, bound,
              `${entry.label}: a ${stage.finish ? 'finish' : 'rough'} plunge (A${fromAngle.toFixed(2)}; `
              + `cell along ${worstCell.along.toFixed(2)} A${worstCell.angle.toFixed(2)} `
              + `material ${worstCell.material.toFixed(3)} contact ${worstCell.contact.toFixed(3)})`)
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
  + `${checkedCuts} cuts, ${checkedPlunges} plunges and ${checkedRapids} rapids replayed, `
  + `${checkedSurfaceCells} surface cells checked`)
console.log(`  default subset: ${defaultFinishOnly} finish-only, ${defaultRoughOnly} rough-only, `
  + `${defaultBoth} rough+finish, ${defaultMixed} along-rough+around-finish; `
  + `${defaultRetained} with retained ends, ${defaultFree} free`)
console.log(`  rough: worst engagement ${worst.rough.peak.toFixed(4)} mm (${worst.rough.peakLabel}); `
  + `closest to its bound at ${worst.rough.excess.toFixed(4)} mm excess against ${worst.rough.bound.toFixed(4)} `
  + `(${worst.rough.label})`)
console.log(`  finish: worst engagement ${worst.finish.peak.toFixed(4)} mm (${worst.finish.peakLabel}); `
  + `closest to its bound at ${worst.finish.excess.toFixed(4)} mm excess against ${worst.finish.bound.toFixed(4)} `
  + `(${worst.finish.label})`)
console.log(`  rapid turns: worst margin ${worstRapidMargin.toFixed(4)} mm above the corner envelope plus clearance `
  + `(${worstRapidLabel})`)
console.log(`  interior removal recorded (not a surface bite): deepest span ${interiorWorst.depth.toFixed(4)} mm `
  + `at along ${interiorWorst.along.toFixed(2)} A${interiorWorst.angle.toFixed(2)} (${interiorWorst.kind || 'none'})`)
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
assert.ok(checkedPlunges > 100, `the reference asserted plunges too (${checkedPlunges})`)
console.log(`  plunges: worst engagement ${worstPlunge.toFixed(4)} mm (${worstPlungeLabel || 'none'})`)
// #1045 slice M: at least 30 programs must run at the adapter's **default**
// parameters -- never coarsened, only shortened -- so the default cutting
// programs are covered, not only the custom-sampling ones. The subset covers
// every program shape and both retained-end states.
assert.ok(defaultCases >= 30, `at least 30 default-parameter programs (${defaultCases})`)
assert.ok(defaultFinishOnly > 0, `a finish-only default program (${defaultFinishOnly})`)
assert.ok(defaultRoughOnly > 0, `a rough-only default program (${defaultRoughOnly})`)
assert.ok(defaultBoth > 0, `a rough+finish default program (${defaultBoth})`)
assert.ok(defaultMixed > 0, `an along-rough + around-finish default program (${defaultMixed})`)
assert.ok(defaultRetained > 0, `a default program with retained ends (${defaultRetained})`)
assert.ok(defaultFree > 0, `a default program with free ends (${defaultFree})`)

console.log('engine/toolpaths/squareAroundGenerator.property.test.ts: all assertions passed')
