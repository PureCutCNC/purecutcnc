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
 * one seed in eight) -- plus, since #1045 slice R, eight along-finish programs
 * (a bare along finish and an along rough + along finish, on a round bar and a
 * square blank) -- and replays each one, in order, through its own reference.
 * A finish emits only its model-following passes (2026-10-22 decision), so a
 * finish-only program cuts to full depth in one pass: it is replayed, but its
 * layer bounds are not asserted; it must carry the no-rough advisory instead.
 * At least 38 of them (every eighth seed) are **default-parameter**
 * programs on a shortened bar: their generator sampling is never coarsened, so
 * the defaults the adapter actually emits are covered rather than only the
 * coarsened draws. (The non-compact draws ask for a coarser sampling than the
 * adapter's defaults for the run's time budget; the reference stays four times
 * finer than whatever the case asks for.)
 *
 * #1093 adds the around ring-to-ring link to the proof. A full ring's end and
 * the next ring's start share one physical angle, so the emitter feeds along
 * the bar instead of retracting. The finish follows the model at that angle
 * through a row sampled no coarser than the ring spacing or a quarter of the
 * tool radius; the rough rises only to the material its own earlier layers
 * left, plus the 1 mm clearance, and that constant-height traverse is a rapid.
 * Ten **round-bar** around cases (a bare rough, a rough + finish and a bare
 * finish, with and without retained ends) join the seeded set, plus two
 * **non-revolved** models -- a square prism inside the round bar, ball and flat
 * -- so a link crossing a feature between two rings is replayed against the
 * full cutter body rather than one ray of a surface of revolution. Every
 * rough link is checked: a cut link removes nothing, and the in-air rapid's
 * body must clear the reference's standing material. Every finish link is
 * replayed too; after a rough its removal is bounded by that rough's stepdown
 * (a surface link removes the between-ring terrace, so the rough's air
 * allowance does not apply), while a finish-only link is covered by the
 * advisory and the final-surface check. A split ring still retracts through
 * the old travel path.
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
 * this suite exists to catch (and far inside both the around allowance and the
 * along stage's exact-geometry radial bound). The reference's sweep, pure-plunge, ball-shank and interior-span behaviour
 * is pinned by hand-computed unit cases before the seeded run. Every ray keeps
 * all occupied intervals, including cavities below an unchanged outer surface.
 * Engagement sums newly removed material over the whole swept move; interior
 * material counts against the same bound and retained ends must keep every span.
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
 * 1. a **rough** turning cut or plunge engages no more than its `stepdown`
 *    plus the stated reference tolerance. An along-mode stage's non-turning
 *    cuts are judged on a different metric (#1045 slice O): the **radial
 *    surface bite**, the material one move removes from the outermost solid at
 *    a ray, is asserted against the cutter's **exact geometry** (#1045 slice
 *    Q): the largest radial bite one stepdown can take, derived from the ball's
 *    sphere cap (or the flat's bottom face) at the ray's offset from the axis
 *    -- see `alongRadialBiteBound`. A finish **after a rough** keeps that
 *    bound with the **rough's** stepdown: the rough left at most one of those
 *    above the surface, so the finish's model-following pass removes at most
 *    that. A finish-only program has no layer bound at all (2026-10-22
 *    decision); it is covered by the advisory. The reference's interior number
 *    -- material below an intact shell -- is reported as a diagnostic and
 *    deliberately **not** asserted (#1045 slice P): it is not a radial depth
 *    and has no geometric bound, so the old stepover + diameter "flank bound"
 *    was removed.
 * 2. no cutter body enters a retained end: every reference cell outside the
 *    band keeps the blank's material;
 * 3. no rapid turns A below the blank's corner radius plus 1 mm clearance;
 * 4. a finished surface (a finish after a rough) is within tolerance of the
 *    model -- it is not cut below it, and no more than the finish's own scallop
 *    plus the sampler's stated cell lift is left above it. A finish-only
 *    program is not a finished surface: the raw blank stands between its
 *    passes, so only the not-below-the-model half applies to it.
 *
 * #1045 slice S adds an **independent structural assertion on the emitted
 * moves**, for every **rough** stage in both directions: at every along
 * position / angle sample the stage cuts, its commanded tip radii must descend
 * from the raw stock's surface -- the round bar's radius or the square blank's
 * **touch radius** at that angle, computed here from the blank's box and the
 * cutter's body, never from `rotaryModel` -- one operation stepdown at a time.
 * The first cut at a sample must be within one stepdown of the raw surface;
 * later cuts may use the slice-Q cutter-cap allowance as well. A cut above the
 * standing material removes nothing and is ignored, so the emitter's vertical
 * step leg is judged by the drop it actually makes. This is what a missing
 * clearing pass violates: the along-stage standing-material allowance in
 * assertion 1 is measured from whatever the reference still holds, so on its
 * own it could excuse a whole uncleared column. That allowance is therefore
 * conditional on this descent holding for the stage's own samples inside the
 * measured cutter's footprint; otherwise the plain previous-layer bound
 * applies.
 *
 * 2026-10-22 decision: a finish (around or along, round or square) only follows
 * the model -- no clearing layers and no link to a rough. This file therefore
 * asserts no layer bound for a finish-only program; the adapter's advisory,
 * `rotaryFinishWithoutRough`, says it cuts to full depth in one pass, and the
 * seeded program asserts that advisory through the real helper. A finish after a
 * rough keeps the along-stage radial bound with the rough's stepdown.
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
import type { BarStock } from '../../types/project'
import { defaultTool, getStockBounds, roundStock } from '../../types/project'
import { generateRotaryFinish, generateRotaryRough } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import { rotaryFinishWithoutRough } from './rotaryOperation'
import type { RotaryOrderOperation } from './rotaryOperation'
import type { NormalizedTool, ToolpathMove, ToolpathPoint } from './types'

// ── deterministic random source ──────────────────────────────────────────

// ── the model, built here rather than through the generator's helpers ─────

/** A closed revolved surface: one ring per profile entry, quads between them. */
function revolved(
  stock: BarStock,
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
 * An extruded rectangle (a closed box) inside the blank (#1093). A box is not a
 * surface of revolution: its material height varies with the angle under one
 * cutter pose, so replaying a link across it exercises the **full cutter
 * body**, not just the link's own ray. The side walls are quads rather than the
 * vertex-pair triangles first tried here; the pair winding left the
 * across-facing sides invisible to the sampler at some angles. The reference
 * stays blind to the generator's model code.
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
  // Extruded rectangle (four corners, caps and side walls). The earlier
  // vertex-pair box winding left the across-facing sides invisible to the
  // sampler at some angles; the prism's side quads sample at every angle.
  const crossSection: Array<readonly [number, number]> = [
    [acrossMin, upMin], [acrossMax, upMin], [acrossMax, upMax], [acrossMin, upMax],
  ]
  const positions: number[] = []
  for (const along of [alongFrom, alongTo]) {
    for (const [across, up] of crossSection) {
      if (stock.axis === 'x') positions.push(along, centre + across, pivot + up)
      else positions.push(centre + across, along, pivot + up)
    }
  }
  const n = crossSection.length
  const index: number[] = []
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    index.push(i, j, n + j, i, n + j, n + i)
  }
  for (let i = 1; i < n - 1; i++) index.push(0, i + 1, i, n, n + i, n + i + 1)
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
 * Largest cumulative interior removal from one ray during a commanded move,
 * with the case and the commanded pose that produced it (#1045 slice O): a
 * reported worst value is useless without the program it came from.
 */
export const interiorWorst = {
  depth: 0, along: 0, angle: 0, kind: '', label: '', seed: -1,
  fromAngle: 0, toAngle: 0, fromAlong: 0, toAlong: 0, fromTip: 0, toTip: 0,
  material: 0, standing: 0, stepover: 0, diameter: 0, stepdown: 0,
}
/** The case whose moves are being replayed, so a worst value can name it. */
let currentCaseLabel = ''
let currentCaseSeed = -1
let currentCaseStepover = 0
let currentCaseDiameter = 0
let moveInteriorWorst = 0
/**
 * Largest radial bite into the **outermost solid** any one ray took during a
 * commanded move (#1045 slice O). A cavity below the surface makes the outer
 * radius jump across air that an earlier pose already removed, so the raw
 * `startMaterial - material[index]` overstates the bite; this counts only the
 * removal from the interval that is the surface at that step.
 */
let moveSurfaceWorst = 0
let moveSurfaceCell = { along: 0, angle: 0, material: 0, standing: 0 }
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
  /** Non-scalar occupied rays; all others are the interval [0, material[index]]. */
  occupied: Map<number, Array<{ contact: number; exit: number }>>
  material: Float64Array
}

/** The blank's radius along the radial ray at `angleDeg`: round is constant, square is its flat. */
function blankRadius(stock: BarStock, angleDeg: number): number {
  if (stock.shape === 'round') return stock.thickness / 2
  const radians = angleDeg * Math.PI / 180
  return stock.thickness / 2 / Math.max(Math.abs(Math.cos(radians)), Math.abs(Math.sin(radians)))
}

/**
 * The raw stock's surface at one program angle, derived here rather than by the
 * generator (#1045 slice S).
 *
 * A round bar is its radius at every angle. A square blank's surface at a pass
 * is not the ray's own radius: the cutter's body spans a slab across the pass
 * ray, and the highest blank material inside that slab is what the first layer
 * meets. That **touch radius** is computed from the blank's box and the
 * cutter's own cross-section -- a flat's bottom face (`Y`) or a ball's lower
 * surface (`Y - r + sqrt(r^2 - X^2)`) -- by taking the maximum over the square's
 * intersection with `|X| <= r`. That intersection is convex, so its maximum is
 * on the boundary: a square corner inside the slab, an edge crossing
 * `X = +/-r`, or, for a ball, the interior tangency of a square edge.
 */
function rawStockSurface(stock: BarStock, angleDeg: number, cutterRadius: number, ball: boolean): number {
  if (stock.shape === 'round') return stock.thickness / 2
  const half = stock.thickness / 2
  const radians = angleDeg * Math.PI / 180
  const cos = Math.cos(radians)
  const sin = Math.sin(radians)
  const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => {
    const across = u * half
    const up = v * half
    return { x: across * cos - up * sin, y: across * sin + up * cos }
  })
  const reach = Math.abs(cutterRadius)
  const heightAt = ball
    ? (x: number, y: number): number => y - reach + Math.sqrt(Math.max(0, reach * reach - x * x))
    : (_x: number, y: number): number => y
  const tolerance = 1e-9 * Math.max(1, reach, half)
  let best = Number.NEGATIVE_INFINITY
  const consider = (x: number, y: number): void => {
    if (Math.abs(x) <= reach + tolerance) best = Math.max(best, heightAt(x, y))
  }
  for (const corner of corners) consider(corner.x, corner.y)
  for (let i = 0; i < corners.length; i++) {
    const a = corners[i]
    const b = corners[(i + 1) % corners.length]
    const dx = b.x - a.x
    if (dx === 0) continue
    for (const boundary of [-reach, reach]) {
      const t = (boundary - a.x) / dx
      if (t < -tolerance || t > 1 + tolerance) continue
      const clamped = Math.min(1, Math.max(0, t))
      consider(boundary, a.y + clamped * (b.y - a.y))
    }
    if (!ball) continue
    const length = Math.hypot(dx, b.y - a.y)
    if (!(length > 0)) continue
    // d/dX [Y - r + sqrt(r^2 - X^2)] = 0 at X = +/- r |dY| / |edge|.
    const xStar = reach * Math.abs(b.y - a.y) / length
    for (const x of [xStar, -xStar]) {
      const t = (x - a.x) / dx
      if (t < 0 || t > 1) continue
      consider(x, a.y + t * (b.y - a.y))
    }
  }
  return best
}

function createReference(stock: BarStock, alongStart: number, alongEnd: number, alongBin: number, angleBins: number): Reference {
  const alongBins = Math.max(1, Math.ceil((alongEnd - alongStart) / alongBin))
  const material = new Float64Array(alongBins * angleBins)
  const angleDeg = 360 / angleBins
  const row = new Float64Array(angleBins)
  for (let k = 0; k < angleBins; k++) row[k] = blankRadius(stock, (k + 0.5) * angleDeg)
  for (let i = 0; i < alongBins; i++) material.set(row, i * angleBins)
  return { alongStart, alongBins, alongBin, angleBins, angleDeg, maxMaterial: barMaxRadius(stock), occupied: new Map(), material }
}

/**
 * The radii at which the cutter body meets a ray `dTheta` off its axis and
 * `dx` along it, as the interval(s) of solid the ray passes through. A flat is
 * the solid `radial ≥ tip` inside its cylinder; a ball is its sphere **plus**
 * the shank above the ball's equator, exactly the emitted body. The intervals
 * are united into the convex body interval before subtracting it from every
 * occupied stock interval, including spans below an intact outer surface.
 */
function bodyInterval(
  ball: boolean,
  cutterRadius: number,
  tip: number,
  dTheta: number,
  dx: number,
): { contact: number; exit: number } | null {
  const cos = Math.cos(dTheta)
  const sin = Math.sin(dTheta)
  const alongSq = dx * dx
  const radiusSq = cutterRadius * cutterRadius
  const reachSq = radiusSq - alongSq
  if (cos <= 0) return null
  if (!ball) {
    // The solid is the cylinder `radial ≥ tip`: the ray enters at the bottom
    // face's own radius and leaves through the cylindrical wall.
    if (reachSq < 0) return null
    const contact = Math.max(0, tip / cos)
    const exit = Math.abs(sin) > 1e-12 ? Math.sqrt(reachSq) / Math.abs(sin) : Number.POSITIVE_INFINITY
    return exit >= contact ? { contact, exit } : null
  }
  const centre = tip + cutterRadius
  if (!(centre > 0)) return null
  const discriminant = reachSq - centre * centre * sin * sin
  let contact = Number.POSITIVE_INFINITY
  let exit = Number.NEGATIVE_INFINITY
  if (discriminant >= 0) {
    const root = Math.sqrt(discriminant)
    contact = Math.max(0, centre * cos - root)
    exit = centre * cos + root
  }
  if (reachSq >= 0) {
    const shankStart = centre / cos
    const shankExit = Math.abs(sin) > 1e-12 ? Math.sqrt(reachSq) / Math.abs(sin) : Number.POSITIVE_INFINITY
    if (shankExit >= shankStart) {
      contact = Math.min(contact, shankStart)
      exit = Math.max(exit, shankExit)
    }
  }
  // Sphere plus shank is convex: their ray intervals overlap whenever both
  // exist. Their union is one interval; avoid sorting/allocating a second list
  // for every swept pose. Stock can still contain arbitrarily many intervals.
  return exit >= contact ? { contact, exit } : null
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
 * admitted only 17.9 deg there and skipped the cell entirely.
 *
 * A flat's bottom face crosses a ray at `tip / cos(delta)`, so material out to
 * `M` is reachable up to `min(atan(R / tip), acos(tip / M))`; `asin(R / M)` (the cylinder wall at
 * the material radius) understated that too.
 */
function bodyAngularReachDeg(ball: boolean, cutterRadius: number, tip: number, materialRadius: number): number {
  if (ball) {
    const centre = tip + cutterRadius
    return centre > cutterRadius ? Math.min(90, Math.asin(cutterRadius / centre) * 180 / Math.PI) : 90
  }
  if (!(tip > 0)) return 90
  if (!(materialRadius > tip)) return 0
  return Math.min(Math.atan(cutterRadius / tip), Math.acos(tip / materialRadius)) * 180 / Math.PI
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
  // Bound the whole cutter body, including interior contact. The blank's
  // radius cannot bound the cutter wall's angular reach at smaller radii.
  const halfSpanDegrees = bodyAngularReachDeg(ball, cutterRadius, tipMin, reference.maxMaterial)
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
  moveInteriorWorst = 0
  moveSurfaceWorst = 0
  moveSurfaceCell = { along: 0, angle: 0, material: 0, standing: 0 }
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
      let removed = 0
      let interiorRemoved = 0
      let surfaceBite = 0
      const materialRadius = startMaterial
      // The representative of this cell's angle nearest the move's own angle
      // span: the move can sweep past 0/360 and the cell is one direction.
      const target = cellAngle + 360 * Math.round((midAngle - cellAngle) / 360)
      const angularHalfDeg = bodyAngularReachDeg(ball, cutterRadius, tipMin, materialRadius)
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
      // At fixed along and tip, ray/body intervals nest as |delta| grows:
      // contact rises and exit falls. The closest angle therefore gives the
      // exact union over a turning move. A pure plunge has the same nesting
      // as tip rises, so its deepest endpoint is the exact swept union too.
      // Slanted moves still require the full fine-grid continuous sweep.
      const fixedRing = dAlong === 0 && dTip === 0
      const purePlunge = dAlong === 0 && dAngle === 0
      const exactT = fixedRing && dAngle !== 0
        ? Math.max(lo, Math.min(hi, (target - fromAngle) / dAngle))
        : dTip <= 0 ? hi : lo
      const steps = fixedRing || purePlunge ? 0 : Math.max(1, Math.ceil(Math.max(
        Math.abs(dAngle) * (hi - lo) / angleDeg,
        Math.abs(dAlong) * (hi - lo) / alongBin,
        Math.abs(dTip) * (hi - lo) / alongBin,
      )))
      referenceStats.steps += steps + 1
      for (let step = 0; step <= steps; step++) {
        const t = steps === 0 ? exactT : lo + (hi - lo) * step / steps
        const toolAlong = fromAlong + dAlong * t
        const dx = cellAlong - toolAlong
        if (dx * dx >= cutterRadius * cutterRadius) continue
        const toolAngle = fromAngle + dAngle * t
        let delta = cellAngle - toolAngle
        while (delta > 180) delta -= 360
        while (delta < -180) delta += 360
        const tip = fromTip + dTip * t
        const span = bodyInterval(ball, cutterRadius, tip, delta * Math.PI / 180, dx)
        if (!span || span.contact >= standing - 1e-12) continue
        const cavity = reference.occupied.get(index)
        if (!cavity && span.exit >= standing) {
          // Most samples lower one solid surface. Preserve the scalar form
          // without allocating occupied/subtraction lists on this hot path.
          const next = Math.min(standing, span.contact)
          removed += standing - next
          surfaceBite += standing - next
          standing = next
          material[index] = next
          if (removed > engagement) {
            engagement = removed
            Object.assign(worstCell, { depth: removed, along: cellAlong, angle: cellAngle, material: startMaterial, contact: next })
          }
          if (span.contact < lowestContact.contact) {
            Object.assign(lowestContact, { contact: span.contact, along: cellAlong, angle: cellAngle, tip, kind: move.kind })
          }
          // The fast path is the ordinary case (material removed from the
          // outermost solid), so it must update the same radial-bite counter the
          // slow path does (#1045 slice P, Codex pass 9): a 1.95 mm removal was
          // reporting zero here because this branch jumped straight back to the
          // next step.
          if (surfaceBite > moveSurfaceWorst) {
            moveSurfaceWorst = surfaceBite
            moveSurfaceCell = { along: cellAlong, angle: cellAngle, material: startMaterial, standing: next }
          }
          continue
        }
        let occupied = cavity ?? [{ contact: 0, exit: standing }]
        const next: Array<{ contact: number; exit: number }> = []
        for (const solid of occupied) {
          const low = Math.max(solid.contact, span.contact)
          const high = Math.min(solid.exit, span.exit)
          if (high <= low + 1e-12) { next.push(solid); continue }
          const depth = high - low
          removed += depth
          if (high < standing - 1e-12) interiorRemoved += depth
          else if (high >= solid.exit - 1e-12) surfaceBite += solid.exit - low
          if (solid.contact < low) next.push({ contact: solid.contact, exit: low })
          if (high < solid.exit) next.push({ contact: high, exit: solid.exit })
          if (low < lowestContact.contact) {
            Object.assign(lowestContact, { contact: low, along: cellAlong, angle: cellAngle, tip, kind: move.kind })
          }
        }
        occupied = next
        standing = occupied.length ? occupied[occupied.length - 1].exit : 0
        material[index] = standing
        // A single interval starting at zero needs only the scalar fast path.
        if (occupied.length <= 1 && (!occupied.length || occupied[0].contact === 0)) reference.occupied.delete(index)
        else reference.occupied.set(index, occupied)
        moveInteriorWorst = Math.max(moveInteriorWorst, interiorRemoved)
        if (interiorRemoved > interiorWorst.depth) {
          Object.assign(interiorWorst, {
            depth: interiorRemoved, along: cellAlong, angle: cellAngle, kind: move.kind,
            label: currentCaseLabel, seed: currentCaseSeed, fromAngle, toAngle, fromAlong, toAlong, fromTip, toTip,
            material: startMaterial, standing,
            stepover: currentCaseStepover, diameter: currentCaseDiameter,
          })
        }
        if (surfaceBite > moveSurfaceWorst) {
          moveSurfaceWorst = surfaceBite
          moveSurfaceCell = { along: cellAlong, angle: cellAngle, material: startMaterial, standing: material[index] }
        }
        if (removed > engagement) {
          engagement = removed
          Object.assign(worstCell, { depth: removed, along: cellAlong, angle: cellAngle, material: startMaterial, contact: standing })
        }
        if (!(standing > 0)) break
      }
    }
  }
  return engagement
}

/**
 * How far the cutter body of a constant-height along rapid clears the
 * reference's standing material, in mm (#1093).
 *
 * The rough's ring-to-ring link is now a rapid: it runs at one angle and one
 * height, derived from what the operation's own earlier layers left plus the
 * clearance. It must be in air, so at every cell the cutter passes over the
 * body's own contact must be at or above the material -- not the tip, because a
 * ball or a flat reaches a neighbouring angle higher than its lowest point.
 * The move is along the bar, so the tool passes directly over every cell it
 * spans; `dx = 0` is the deepest pose for that cell. Returns the smallest
 * `contact - material`, negative when the body is inside the material.
 */
export const rapidWorst = { along: 0, angle: 0, material: 0, contact: 0, tip: 0, delta: 0 }

function rapidClearance(
  reference: Reference,
  move: ToolpathMove,
  pivot: number,
  cutterRadius: number,
  ball: boolean,
  alongOf: (point: ToolpathMove['from']) => number,
): number {
  const { material, alongBins, alongStart, alongBin, angleBins, angleDeg } = reference
  const fromAlong = alongOf(move.from)
  const toAlong = alongOf(move.to)
  const tip = move.from.z - pivot
  const angle = move.from.a ?? 0
  const halfSpan = bodyAngularReachDeg(ball, cutterRadius, tip, reference.maxMaterial)
  const i0 = Math.max(0, Math.floor((Math.min(fromAlong, toAlong) - cutterRadius - alongStart) / alongBin))
  const i1 = Math.min(alongBins - 1, Math.floor((Math.max(fromAlong, toAlong) + cutterRadius - alongStart) / alongBin))
  const loBin = Math.floor((angle - halfSpan - angleDeg) / angleDeg)
  const hiBin = Math.ceil((angle + halfSpan + angleDeg) / angleDeg)
  let margin = Number.POSITIVE_INFINITY
  for (let i = i0; i <= i1; i++) {
    const cellAlong = alongStart + (i + 0.5) * alongBin
    // The tool passes over this cell only inside the link's own span; outside
    // it, the nearest pose is the nearer endpoint, `dx` away. Using dx = 0 for
    // a cell beyond the span overstates the body's reach by the whole offset.
    const dx = cellAlong < fromAlong ? fromAlong - cellAlong
      : cellAlong > toAlong ? cellAlong - toAlong : 0
    if (dx > cutterRadius) continue
    for (let cell = loBin; cell <= hiBin; cell++) {
      const k = ((cell % angleBins) + angleBins) % angleBins
      const cellAngle = (k + 0.5) * angleDeg
      const delta = Math.abs(((cellAngle - angle + 180) % 360 + 360) % 360 - 180)
      if (delta > halfSpan + angleDeg) continue
      const standing = material[i * angleBins + k]
      if (standing <= 0) continue
      const span = bodyInterval(ball, cutterRadius, tip, delta * Math.PI / 180, dx)
      if (!span) continue
      const cellMargin = span.contact - standing
      if (cellMargin < margin) {
        margin = cellMargin
        Object.assign(rapidWorst, {
          along: cellAlong, angle: cellAngle,
          material: standing, contact: span.contact, tip, delta,
        })
      }
    }
  }
  return margin
}

/** Count cavities as well as surface loss when judging retained stock. */
function retainedRemoval(reference: Reference, index: number, blank: number): number {
  const occupied = reference.occupied.get(index)
  const remaining = occupied
    ? occupied.reduce((sum, span) => sum + span.exit - span.contact, 0)
    : reference.material[index]
  return blank - remaining
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
    // #1045 slice P (Codex pass 9): this removal takes the reference's ordinary
    // (no-cavity) fast path, which used to `continue` before updating the
    // radial-bite counter, so a 1.95 mm surface removal reported zero.
    assert.ok(Math.abs(moveSurfaceWorst - 1.95) < 0.01,
      `pure plunge: the radial surface bite is recorded (${moveSurfaceWorst.toFixed(4)}, expected 1.95)`)
  }
  // Pass-8 repro: a pure plunge reaches the ray ten degrees off-axis,
  // even though the blank-radius window would exclude it.
  {
    const reference = singleCellReference(10, 0)
    const k = 20
    reference.material[k] = 9.95
    const engagement = referenceMove(reference, {
      kind: 'plunge', from: { x: 10, y: 10, z: 10, a: 0.25 },
      to: { x: 10, y: 10, z: 8, a: 0.25 },
    }, 0, 2, false, alongOf, 0.25, 0.25)
    const contact = 8 / Math.cos(10 * Math.PI / 180)
    assert.ok(Math.abs(reference.material[k] - contact) < 1e-9)
    assert.ok(Math.abs(engagement - 1.826587104914) < 1e-9)
    assert.throws(() => checkEngagement(engagement, 1, 'off-axis plunge'), /off-axis plunge engages/)
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
    assert.ok(Math.abs(engagement - (exit - contact)) < 0.0001,
      'interior span: the complete occupied span counts as engagement')
    assert.throws(() => checkEngagement(engagement, 1, 'ball interior repro'), /ball interior repro engages/)
    assert.deepEqual(reference.occupied.get(k), [{ contact: 0, exit: contact }, { contact: exit, exit: 6.5 }])
    assert.equal(referenceMove(reference, {
      kind: 'cut', from: { x: 10, y: 10, z: 2, a: 0.25 }, to: { x: 10, y: 10, z: 2, a: 0.25 },
    }, 0, 2, true, alongOf, 0.25, 0.25), 0, 'a second identical pose removes no cavity material twice')
    assert.ok(Math.abs(interiorWorst.depth - (exit - contact)) < 0.02,
      `interior span: recorded span ${interiorWorst.depth.toFixed(4)}, expected ${(exit - contact).toFixed(4)}`)
    assert.ok(Math.abs(retainedRemoval(reference, k, 6.5) - (exit - contact)) < 1e-9,
      'retained-end exclusion detects the cavity despite its intact outer surface')
    assert.equal(reference.material[k], 6.5,
      'interior span: the outermost stock is unchanged, because the body never crosses it')
  }
  // A fixed-height ring reaches a ray deepest in the middle of its A span,
  // not at an endpoint. Its exact swept union must preserve that minimum.
  for (const ball of [false, true]) {
    const reference = singleCellReference(10, 0)
    const k = 40
    reference.material[k] = 6.5
    const engagement = referenceMove(reference, {
      kind: 'cut', from: { x: 10, y: 10, z: 2, a: 0.25 },
      to: { x: 10, y: 10, z: 2, a: 40.25 },
    }, 0, 2, ball, alongOf, 0.25, 40.25)
    assert.ok(Math.abs(engagement - 4.5) < 1e-9)
    assert.ok(Math.abs(reference.material[k] - 2) < 1e-9,
      'a ring includes its closest-angle pose inside the commanded sweep')
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

// #1045 slice O: the reference unit tests above are not a separate mode. The
// seeded run always follows them; an environment variable must not be able to
// skip the 300 programs CI is meant to check.
interiorWorst.depth = 0

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
 * 0.05 mm chord tolerance is far inside this file's stated allowances (the
 * around `alongBin + ballRise` on the order of a third of a millimetre, and the
 * along stage's exact-geometry radial bound of about a millimetre) and an order
 * of magnitude tighter than the 0.49 mm gouge this suite was built to catch.
 */
const COALESCE_TOLERANCE = 0.05
const MAX_ANGLE_BINS = 2_048

type ProgramKind = 'rough' | 'finish' | 'both' | 'mixed'

interface Case {
  label: string
  stock: BarStock
  profile: { along: number; radius: number }[]
  /**
   * A non-revolved model (#1093). When present it replaces the revolved mesh;
   * `profile` is then only the label's shape and the finished-surface check is
   * skipped (it needs an analytic radius, and a box's is not one).
   */
  mesh?: RotaryModelMesh
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
  /** The finish's own pass direction (#1045 slice R adds along finishes). */
  finishKind: 'around' | 'along'
  retained: boolean
  alongStart: number
  alongEnd: number
  defaultParams: boolean
  /** A default-parameter case whose bar is drawn short; never coarsened. */
  compact: boolean
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
  let along = Number.POSITIVE_INFINITY
  let arc = Number.POSITIVE_INFINITY
  const roughRan = entry.programKind !== 'finish'
  const finishRan = entry.programKind !== 'rough'
  if (roughRan) {
    if (entry.roughKind === 'along') {
      along = Math.min(along, entry.roughSpacing)
      arc = Math.min(arc, entry.stepover)
    } else {
      along = Math.min(along, entry.stepover)
      arc = Math.min(arc, aroundArcStep(corner, entry.roughSpacing))
    }
  }
  if (finishRan) {
    if (entry.finishKind === 'along') {
      along = Math.min(along, entry.finishSpacing)
      arc = Math.min(arc, entry.stepover)
    } else {
      along = Math.min(along, entry.stepover)
      arc = Math.min(arc, aroundArcStep(corner, entry.finishSpacing))
    }
  }
  return { along, arc }
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
    // The layer depth drives the rough's layer count; a millimetre-scale
    // default keeps a deep corner to a handful of layers.
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
      finishKind: 'around',
      retained: ends > 0,
      alongStart,
      alongEnd,
      defaultParams: true,
      compact: true,
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
  // one (a rough that must clear it is the most demanding case).
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
    finishKind: 'around',
    retained: ends > 0,
    alongStart,
    alongEnd,
    defaultParams: false,
    compact: false,
  }
}

/**
 * One seeded **along-finish** case: a short bar, a cutter large against it and
 * a deep model corner, on a round bar and a square blank, both a bare along
 * finish and an along rough + along finish. A bare along finish cuts to full
 * depth in one pass and carries the advisory; the rough + finish pair keeps the
 * along-stage radial bound with the rough's stepdown (2026-10-22 decision).
 */
function drawAlongCase(seed: number): Case {
  const rand = mulberry32(seed * 0x9e3779b1 + 0x52)
  const pick = (low: number, high: number): number => low + (high - low) * rand()
  const square = seed % 2 === 1
  const kind: ProgramKind = seed < 4 ? 'finish' : 'both'
  // Balls on most seeds: the reference's surface sweep is affordable at the
  // adapter's default sampling, and a flat covers the staircase scallop.
  const type = seed % 3 === 0 ? 'flat_endmill' as const : 'ball_endmill' as const
  const side = Math.round(pick(22, 26) * 2) / 2
  const length = Math.max(20, Math.round(pick(20, 22)))
  const diameter = Math.round(pick(6, 8) * 10) / 10
  const radius = diameter / 2
  const inscribed = side / 2
  const modelRadius = Math.round(pick(0.6, 0.75) * inscribed * 10) / 10
  const ends = seed >= 4 && seed % 3 === 0 ? 0 : Math.max(1, Math.round(pick(0.05, 0.1) * length))
  const stock = square ? squareStock(side, length) : roundStock(side, length)
  const bounds = getStockBounds(stock)
  const alongStart = bounds.minX + ends
  const alongEnd = bounds.maxX - ends
  const profile: { along: number; radius: number }[] = [
    { along: alongStart, radius: modelRadius },
    { along: alongEnd, radius: modelRadius },
  ]
  const stepover = Math.max(0.5 * diameter, 1e-3)
  const roughSpacing = Math.max(radius / 2, 1e-3)
  const finishSpacing = Math.max(radius / 4, 1e-3)
  const requestedCellSize = Math.min(radius / 3, stepover * 0.5)
  const stepdown = seed >= 4 ? 3 : 2
  return {
    label: `${type === 'ball_endmill' ? 'ball' : 'flat'} D${diameter} ${side}x${length} `
      + `${square ? 'square' : 'round'} cyl ${kind} along-clear ends ${ends} stepdown ${stepdown}`,
    stock,
    profile,
    type,
    diameter,
    stepdown,
    stepover,
    roughSpacing,
    finishSpacing,
    requestedCellSize,
    stockToLeave: 0,
    programKind: kind,
    roughKind: 'along',
    finishKind: 'along',
    retained: ends > 0,
    alongStart,
    alongEnd,
    defaultParams: false,
    compact: true,
  }
}

/**
 * One seeded **round-bar around** case (#1093). The square set above proves
 * the blank's corner rules; these prove the same ring links on a bar whose
 * cross-section is a circle, where the blank's support is its radius at every
 * angle and the finish's between-ring link has no corner to clear. Both a bare
 * around rough and a rough + around finish are drawn, with and without retained
 * ends, and a bare around finish (which carries the no-rough advisory) on every
 * fourth seed.
 */
function drawRoundCase(seed: number, lengthScale = 1): Case {
  const rand = mulberry32(seed * 0x9e3779b1 + 0x1093)
  const pick = (low: number, high: number): number => low + (high - low) * rand()
  const kinds: ProgramKind[] = ['both', 'rough', 'finish', 'both', 'rough', 'both', 'finish', 'both']
  const programKind = kinds[seed % kinds.length]
  // Balls on most seeds: a ball's replay window is the affordable one, and a
  // flat covers the staircase link height.
  const type = seed % 3 === 1 ? 'flat_endmill' as const : 'ball_endmill' as const
  const side = Math.round(pick(16, 22) * 2) / 2
  const length = Math.max(20, Math.round(pick(20, 24) * lengthScale))
  const diameter = Math.round(pick(3, 6) * 10) / 10
  const radius = diameter / 2
  const modelRadius = Math.round(pick(0.55, 0.8) * (side / 2) * 10) / 10
  const ends = seed % 2 === 0 ? Math.max(1, Math.round(pick(0.05, 0.12) * length)) : 0
  const stock = roundStock(side, length)
  const bounds = getStockBounds(stock)
  const alongStart = bounds.minX + ends
  const alongEnd = bounds.maxX - ends
  const cone = seed % 4 === 0
  const profile: { along: number; radius: number }[] = [
    { along: alongStart, radius: modelRadius },
    { along: alongEnd, radius: cone ? Math.max(0.6, modelRadius * pick(0.6, 0.95)) : modelRadius },
  ]
  const stepover = Math.max(0.75 * diameter, 1e-3)
  const roughSpacing = Math.max(radius / 2, 1e-3)
  const finishSpacing = Math.max(radius / 4, 1e-3)
  const requestedCellSize = Math.min(radius / 3, stepover * 0.5)
  const stepdown = Math.round(pick(1, 3) * 10) / 10
  return {
    label: `${type === 'ball_endmill' ? 'ball' : 'flat'} D${diameter} round ${side}x${length} `
      + `${cone ? 'cone' : 'cyl'} ${programKind} around ends ${ends} stepdown ${stepdown}`,
    stock,
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
    roughKind: 'around',
    finishKind: 'around',
    retained: ends > 0,
    alongStart,
    alongEnd,
    defaultParams: false,
    compact: true,
  }
}

/**
 * A non-revolved around case (#1093 review): the model is a **square prism**
 * inside a round bar, so the material height under one cutter pose varies with
 * the angle and the link's whole body is judged, not one ray. Two cases cover
 * a ball and a flat cutter, both rough + finish, so every finish link is
 * replayed after a rough and the removal bound applies.
 *
 * The model is a box rather than `revolved`, so the finished-surface check is
 * skipped for these cases; the link replay, the rough layer descent and the
 * retained-end check are the proof.
 */
function drawFeatureCase(seed: number): Case {
  const type = seed % 2 === 0 ? 'ball_endmill' as const : 'flat_endmill' as const
  const side = 10
  const length = 14
  const stock = roundStock(side, length)
  const alongStart = 3
  const alongEnd = 11
  const half = 2.6
  const diameter = 1.5
  const mesh = box(stock, alongStart, alongEnd, -half, half, -half, half)
  return {
    label: `${type === 'ball_endmill' ? 'ball' : 'flat'} D${diameter} round ${side}x${length} `
      + `square prism ${2 * half} both around ends 0 stepdown 1.5`,
    stock,
    // The prism's inscribed radius; only the label and the (skipped) surface
    // check would read it.
    profile: [{ along: alongStart, radius: half }, { along: alongEnd, radius: half }],
    mesh,
    type,
    diameter,
    stepdown: 1.5,
    stepover: 1,
    roughSpacing: 0.35,
    finishSpacing: 0.3,
    requestedCellSize: 0.25,
    stockToLeave: 0,
    programKind: 'both',
    roughKind: 'around',
    finishKind: 'around',
    retained: false,
    alongStart,
    alongEnd,
    defaultParams: false,
    compact: true,
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
  const model = entry.mesh ?? revolved(stock, entry.profile)
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
  const roughResult = entry.programKind === 'finish'
    ? null
    : generateRotaryRough(`${entry.label} rough`, model, stock, tool, {
      ...common,
      stepdown: entry.stepdown,
      passDirection: entry.roughKind,
    }, {})
  const rough = roughResult ?? { moves: [] as ToolpathMove[], warnings: [] as { code: string }[] }
  const finish = entry.programKind === 'rough'
    ? { moves: [] as ToolpathMove[], warnings: [] as { code: string }[] }
    : generateRotaryFinish(`${entry.label} finish`, model, stock, tool, {
      ...common,
      sampleSpacing: entry.finishSpacing,
      stockToLeave: entry.stockToLeave,
      passDirection: entry.finishKind,
    }, {})
  const finishCodes = finish.warnings.map((warning) => warning.code)
  if (entry.programKind !== 'rough') {
    // The adapter decides the advisory from the project; reproduce its
    // operation list here so a finish-only program asserts the real helper's
    // answer. The motion above is unchanged either way.
    const finishOperation: RotaryOrderOperation = {
      id: 'finish', setupId: 'setup', kind: 'rotary_finish', enabled: true,
      target: { source: 'features', featureIds: ['model'] },
    }
    const roughOperation: RotaryOrderOperation = {
      id: 'rough', setupId: 'setup', kind: 'rotary_rough', enabled: true,
      target: { source: 'features', featureIds: ['model'] },
    }
    const operations = entry.programKind === 'finish' ? [finishOperation] : [roughOperation, finishOperation]
    if (rotaryFinishWithoutRough(operations, finishOperation, ['model'])) finishCodes.push('rotaryFinishWithoutRough')
  }
  return {
    roughMoves: rough.moves,
    finishMoves: finish.moves,
    roughCodes: rough.warnings.map((warning) => warning.code),
    finishCodes,
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
    // #1045 slice O: use the reference's own body reach. The old
    // `asin(R / barMaxRadius)` window excluded interior material that a ball's
    // shank (or a flat's bottom face at a small tip) reaches, so the estimate
    // under-counted the replay cost of exactly the moves that are most
    // expensive to check.
    const halfSpanDegrees = bodyAngularReachDeg(ball, radius, tipMin, barMaxRadius(entry.stock))
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
  return fitEntry(drawCase(seed, 1), (scale) => drawCase(seed, scale))
}

function fitEntry(initial: Case, redraw?: (scale: number) => Case): Fitted {
  if (initial.defaultParams) {
    // A default-parameter case is never coarsened: the drawn side, cutter,
    // stepdown and sampling are the adapter's defaults, and the short bar is
    // what makes its reference affordable. If the grid does not fit, the draw
    // itself is wrong and must be fixed rather than silently degraded.
    assert.ok(fitsGrid(initial), `${initial.label}: a default-parameter case must fit the reference grid`)
    return { entry: initial, program: generate(initial) }
  }
  let scale = 1
  let entry = coarsenGrid(initial)
  let program = generate(entry)
  let cells = estimateReplayCells(program, entry)
  for (let attempt = 0; attempt < 8 && redraw !== undefined
    && (cells > MAX_REPLAY_CELLS || !fitsGrid(entry)); attempt++) {
    const length = entry.alongEnd - entry.alongStart
    if (length <= 20.5) break
    const ratio = cells > 0 ? MAX_REPLAY_CELLS / cells : 0.8
    const nextScale = scale * Math.max(0.1, Math.min(0.9, ratio * 0.95))
    if (nextScale >= scale * 0.999) break
    scale = nextScale
    entry = coarsenGrid(redraw(scale))
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
      stepdown: Math.min(3, entry.stepdown * Math.max(1.2, Math.min(1.8, ratio))),
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

/**
 * The exact largest **radial surface bite** a cutter can take at one ray while
 * it descends one stepdown, given the layer's own tip radius (#1045 slice Q).
 *
 * The along-stage metric is not engagement but a radial depth: the material one
 * move removes from the outermost solid at a ray. For a cutter whose axis is
 * `d` off the ray and `dx` along it, the reference's body contact is exact:
 *
 *   ball: c(t) = (t+R) cos(d) - sqrt(R^2 - dx^2 - (t+R)^2 sin(d)^2)
 *   flat: c(t) = t / cos(d)                    (dx only limits the reach)
 *
 * A move at layer tip `t` is preceded, at the same pass angle and the same
 * along span (every layer shares the sample grid), by a pass at tip `t+s` or
 * lower. That pass swept this ray, so the standing material before the move is
 * at most `c(t+s)` -- any other earlier move only lowers it -- and the move
 * leaves `c(t)`. The bite is therefore at most `c(t+s) - c(t)`, and the bound
 * is that difference maximised over the ray offsets the reference resolves.
 * The first layer has no such pass, but its standing material is the blank,
 * at most `t + s` because its layer tip is `maxRadius - s` (raised to the
 * model where the model stands above it), while its contact is at least `t`;
 * that bite is at most `s`, which every bound below exceeds.
 *
 * **Ball.** At a fixed `d` the difference grows with `|dx|` (the two sphere
 * surfaces diverge as the ray moves toward the upper one's tangent), so the
 * maximum is at that tangency, `dx^2 = R^2 - (t+s+R)^2 sin(d)^2`, where the
 * upper contact is `(t+s+R) cos(d)`. The difference is then
 *
 *   D(d) = s cos(d) + sqrt(s (2 (t+R) + s)) sin(d),
 *
 * which increases over the whole reachable range `d <= asin(R/(t+s+R))`: its
 * unconstrained peak sits at `atan(sqrt((2 (t+R) + s) / s))`, beyond that
 * tangency. The exact maximum is therefore at the tangency:
 *
 *   bound = [ s sqrt((t+s+R)^2 - R^2) + R sqrt(s (2 (t+R) + s)) ] / (t+s+R).
 *
 * The ball's shank does not raise it: its bite is the flat expression at tip
 * `t+R`, and its reach `atan(R/(t+s+R))` lies inside the sphere's
 * `asin(R/(t+s+R))`, so the sphere alone sets the bound.
 *
 * **Flat.** The bite is `s / cos(d)`, and the upper layer's rim limits the
 * reach to `d <= atan(R/(t+s))`, where `cos(d) = (t+s)/sqrt((t+s)^2 + R^2)`:
 *
 *   bound = s sqrt((t+s)^2 + R^2) / (t+s).
 *
 * `tip` is the **lowest** tip the move reaches. The bound falls as `t` grows,
 * so evaluating it at the move's minimum tip can only over-estimate: the
 * previous layer's tip at that along position is at most `minTip + stepdown`.
 * Unlike the old `alongBin + ballRise` term, this is the cutter's own geometry;
 * the reference's bin sizes do not appear as a tolerance, only as the cell
 * offsets whose maximum the bound describes.
 */
function alongRadialBiteBound(ball: boolean, radius: number, stepdown: number, tip: number): number {
  if (!ball) {
    const upper = tip + stepdown
    return stepdown * Math.sqrt(upper * upper + radius * radius) / upper
  }
  const lower = tip + radius
  const upper = tip + stepdown + radius
  return (stepdown * Math.sqrt(upper * upper - radius * radius)
    + radius * Math.sqrt(stepdown * (2 * lower + stepdown))) / upper
}

/**
 * The cutter body's nearest radial contact at a ray `deltaDeg` off its axis and
 * `dx` along it (#1045 slice Q extension).
 *
 * `alongRadialBiteBound` assumes the previous layer's pass reached the ray, so
 * the standing material there is at most that pass's own contact. That is not
 * always true: a lower layer reaches rays the layer above cannot, because the
 * ball's angular reach `asin(R / (tip + R))` grows as the tip gets smaller, and
 * the shank above its equator reaches high-radius rays the sphere misses. On
 * such a **newly reached** ray the material is whatever stood there before --
 * the blank, or whatever an even earlier pass left -- not the previous layer's
 * contact. The exact allowance is then measured from that standing material
 * down to this body's own contact, which is what this helper returns.
 *
 * The formula is the reference's own body contact for the near side of the
 * sphere (`centre * cos - sqrt(...)`), the shank's entry, and a flat's bottom
 * face; `tip` is the fallback when the ray is outside the body, since the
 * body's contact is never below its tip. Using the reference's standing
 * material and this contact cannot hide a bite: the measured bite is the
 * removal from the outermost solid down to the body's contact or above it.
 */
function alongRayContact(
  ball: boolean,
  radius: number,
  tip: number,
  deltaDeg: number,
  dx: number,
): number {
  const delta = deltaDeg * Math.PI / 180
  const cos = Math.cos(delta)
  const sin = Math.sin(delta)
  if (cos <= 0) return tip
  const reachSq = radius * radius - dx * dx
  if (reachSq < 0) return tip
  if (!ball) return Math.max(tip, tip / cos)
  const centre = tip + radius
  const discriminant = reachSq - centre * centre * sin * sin
  let contact = Number.POSITIVE_INFINITY
  if (discriminant >= 0) contact = Math.max(0, centre * cos - Math.sqrt(discriminant))
  const shankStart = centre / cos
  const shankExit = Math.abs(sin) > 1e-12 ? Math.sqrt(reachSq) / Math.abs(sin) : Number.POSITIVE_INFINITY
  if (shankExit >= shankStart) contact = Math.min(contact, shankStart)
  return Number.isFinite(contact) ? contact : tip
}

// ── the emitted motion's own layer descent (#1045 slice S) ────────────────
//
// The along-stage radial bound above assumes the previous layer's pass reached
// the ray under test. Slice Q extended it to a ray the previous layer missed by
// measuring from the material still standing there, but that standing material
// is read from the reference: if the operation never emitted a clearing pass at
// all, the reference still holds the raw blank and the allowance becomes the
// whole bite. A 1 000 mm generator stepdown left every along-finish replay case
// green that way, including a 9.3975 mm bite.
//
// So the emitted motion is judged independently, at its own samples: every
// stage's tip radii must descend from the raw stock's surface one operation
// stepdown at a time. Only where that holds may the standing-material allowance
// widen the along-stage bound.

/** The generator's own collinear-merge tolerance; a sampled pose may drift this far. */
const DESCENT_TOLERANCE = 1e-3
/** Angle key resolution, 0.0001 degrees. */
const DESCENT_ANGLE_QUANTUM = 1e4
/** Along key resolution, 0.001 mm. */
const DESCENT_ALONG_QUANTUM = 1e3
const DESCENT_ALONG_OFFSET = 10_000_000
const DESCENT_KEY_BASE = 40_000_000

/** One sample that actually cut, for the standing allowance's footprint query. */
interface DescentSample {
  readonly along: number
  readonly angle: number
}

interface StageDescent {
  /** Every sample this stage cut, with its raw-surface descent verified. */
  readonly samples: Map<number, DescentSample>
  /** Cuts that lowered a sample's standing material. */
  readonly cuts: number
  /** The closest a step came to its allowance, for the report. */
  readonly margin: number
  readonly marginLabel: string
}

function descentKey(along: number, angleDeg: number): number {
  const angle = Math.round((((angleDeg % 360) + 360) % 360) * DESCENT_ANGLE_QUANTUM)
    % (360 * DESCENT_ANGLE_QUANTUM)
  const alongKey = Math.round(along * DESCENT_ALONG_QUANTUM) + DESCENT_ALONG_OFFSET
  return angle * DESCENT_KEY_BASE + alongKey
}

/**
 * Assert that one stage's emitted cuts descend from the raw stock at every
 * along/angle sample it visits (#1045 slice S).
 *
 * The samples are the generator's own pass/ring positions: its along vertex
 * positions (an along pass) or its base angular grid plus every emitted vertex
 * angle (an around ring). All layers share those positions, so each key is the
 * same physical sample for every layer. For each key:
 *
 * 1. the **first** cut may be at most one stepdown below the raw surface there
 *    -- on a square blank the touch radius, on a round bar its radius. This is
 *    what a missing clearing layer violates immediately;
 * 2. every **later** cut may descend at most one stepdown plus the slice-Q
 *    cutter-cap allowance from the material the previous cut left. The cap
 *    allowance is the extra radial depth the cutter's own geometry reaches at a
 *    ray off its axis (`alongRadialBiteBound - stepdown`); at a sample's own ray
 *    it is zero and the plain stepdown is the whole allowance.
 *
 * A cut above the standing material removes nothing and is ignored, so a
 * generator's vertical step leg (which arrives high and then drops) is judged
 * by the drop it actually makes, not by the height it transits.
 */
function assertStageDescent(
  entry: Case,
  label: string,
  moves: readonly ToolpathMove[],
  direction: 'around' | 'along',
  pivot: number,
  ball: boolean,
  cutterRadius: number,
  stepdown: number,
  alongOf: (point: ToolpathMove['from']) => number,
  sampleSpacing: number,
): StageDescent {
  const stock = entry.stock
  const corner = barMaxRadius(stock)
  const rawCache = new Map<number, number>()
  const rawAt = (angleDeg: number): number => {
    const key = Math.round((((angleDeg % 360) + 360) % 360) * DESCENT_ANGLE_QUANTUM)
    let raw = rawCache.get(key)
    if (raw === undefined) {
      raw = rawStockSurface(stock, key / DESCENT_ANGLE_QUANTUM, cutterRadius, ball)
      rawCache.set(key, raw)
    }
    return raw
  }
  const alongGrid = new Map<number, number>()
  const collectAlong = (value: number): void => {
    const key = Math.round(value * DESCENT_ALONG_QUANTUM)
    if (!alongGrid.has(key)) alongGrid.set(key, key / DESCENT_ALONG_QUANTUM)
  }
  const angleGrid = new Map<number, number>()
  const collectAngle = (value: number): void => {
    const angle = ((value % 360) + 360) % 360
    const key = Math.round(angle * DESCENT_ANGLE_QUANTUM)
    if (!angleGrid.has(key)) angleGrid.set(key, key / DESCENT_ANGLE_QUANTUM)
  }
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    collectAlong(alongOf(move.from))
    collectAlong(alongOf(move.to))
    // The emitted vertices carry any refined angle too, so a plunge or a
    // bisected segment is sampled at its own ray as well as on the base grid.
    collectAngle(move.from.a ?? 0)
    collectAngle(move.to.a ?? 0)
  }
  if (direction === 'around') {
    // The generator's base angular grid: `ceil(2 pi R / cap)` intervals, each
    // `360 / n` degrees, so the corner is resolved by the same 0.005 mm sagitta
    // rule the generator uses. Sampling only emitted vertices would miss the
    // corner on a ring that merged into one full-turn move.
    const intervals = Math.max(1, Math.ceil(2 * Math.PI * corner / aroundArcStep(corner, sampleSpacing)))
    for (let k = 0; k <= intervals; k++) collectAngle(360 * k / intervals)
  }
  const alongSamples = [...alongGrid.values()].sort((a, b) => a - b)
  const angleSamples = [...angleGrid.values()].sort((a, b) => a - b)
  const standing = new Map<number, number>()
  const samples = new Map<number, DescentSample>()
  let cuts = 0
  let margin = Number.POSITIVE_INFINITY
  let marginLabel = ''
  const visit = (along: number, angleRaw: number, tip: number): void => {
    if (!Number.isFinite(tip)) return
    const angle = ((angleRaw % 360) + 360) % 360
    const raw = rawAt(angle)
    if (!(raw > 0)) return
    const key = descentKey(along, angle)
    let current = standing.get(key)
    if (current === undefined) {
      current = raw
      standing.set(key, raw)
    }
    if (!(tip < current - 1e-12)) return
    const drop = current - tip
    const first = !samples.has(key)
    const cap = first ? 0 : Math.max(0, alongRadialBiteBound(ball, cutterRadius, stepdown, tip) - stepdown)
    const allowed = stepdown + cap + DESCENT_TOLERANCE
    cuts++
    const slack = allowed - drop
    if (slack < margin) {
      margin = slack
      marginLabel = `${label} along ${along.toFixed(3)} A${angle.toFixed(3)} `
        + `drop ${drop.toFixed(4)} against ${allowed.toFixed(4)}`
    }
    if (drop > allowed + 1e-9) {
      assert.ok(false,
        `${entry.label}: the emitted ${label} does not descend from the raw blank at along `
        + `${along.toFixed(3)} A${angle.toFixed(3)}: ${first ? 'the first cut is' : 'one cut drops'} `
        + `${drop.toFixed(4)} mm (${current.toFixed(4)} -> ${tip.toFixed(4)}), over the `
        + `${allowed.toFixed(4)} mm allowed ${first ? '(one stepdown)' : `(one stepdown ${stepdown.toFixed(4)} `
        + `+ cutter cap ${cap.toFixed(4)})`}`,
      )
    }
    samples.set(key, { along, angle })
    standing.set(key, tip)
  }
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    const fromAlong = alongOf(move.from)
    const toAlong = alongOf(move.to)
    const fromTip = move.from.z - pivot
    const toTip = move.to.z - pivot
    const fromAngle = move.from.a ?? 0
    const toAngle = move.to.a ?? fromAngle
    const dAlong = toAlong - fromAlong
    const dAngle = toAngle - fromAngle
    if (direction === 'along') {
      if (Math.abs(dAngle) > 1e-9) {
        // A turning link at travel height: judge its endpoints at their own
        // angles. It is above the blank and removes nothing.
        visit(fromAlong, fromAngle, fromTip)
        visit(toAlong, toAngle, toTip)
        continue
      }
      const low = Math.min(fromAlong, toAlong)
      const high = Math.max(fromAlong, toAlong)
      for (const along of alongSamples) {
        if (along < low - DESCENT_TOLERANCE) continue
        if (along > high + DESCENT_TOLERANCE) break
        const fraction = dAlong === 0 ? 0 : (along - fromAlong) / dAlong
        visit(along, fromAngle, fromTip + (toTip - fromTip) * fraction)
      }
    } else {
      if (Math.abs(dAlong) > 1e-9) {
        visit(fromAlong, fromAngle, fromTip)
        visit(toAlong, toAngle, toTip)
        continue
      }
      const low = Math.min(fromAngle, toAngle)
      const high = Math.max(fromAngle, toAngle)
      for (const angle of angleSamples) {
        if (angle < low - DESCENT_TOLERANCE) continue
        if (angle > high + DESCENT_TOLERANCE) break
        const fraction = dAngle === 0 ? 0 : (angle - fromAngle) / dAngle
        visit(fromAlong, angle, fromTip + (toTip - fromTip) * fraction)
      }
    }
  }
  return { samples, cuts, margin, marginLabel }
}

/**
 * Whether a stage's verified descent covers the measured ray: some cut sample
 * lies inside this cutter body's footprint of it (along within one radius,
 * angle within the body's own angular reach). The along-stage standing
 * allowance may only use its measurement where this is true (#1045 slice S);
 * otherwise the plain previous-layer bound applies.
 */
function descentCoversRay(
  stage: StageDescent,
  along: number,
  angleDeg: number,
  ball: boolean,
  cutterRadius: number,
  tip: number,
  material: number,
): boolean {
  if (stage.samples.size === 0) return false
  const reach = bodyAngularReachDeg(ball, cutterRadius, tip, Math.max(material, cutterRadius))
  for (const sample of stage.samples.values()) {
    if (Math.abs(sample.along - along) >= cutterRadius) continue
    let delta = ((sample.angle - angleDeg) % 360 + 360) % 360
    if (delta > 180) delta = 360 - delta
    if (delta <= reach + 1e-9) return true
  }
  return false
}

// The repro the slice-Q bound missed (#1045 slice Q extension), checked before
// the seeded run and independently of it: a Ø4 ball at tip 2 removes 2.3435 mm
// from a ray 24.25° off its axis where 4.85 mm of material still stands, while
// the layer above (tip 3) cannot reach that ray at all -- `asin(2 / 5) =
// 23.58°`. Slice Q's bound of 2.1165 mm assumed the previous layer swept the
// ray, so the measured bite exceeded it. The extended allowance measures that
// bite from the standing material at the ray, and passes.
{
  const radius = 2
  const lowerTip = 2
  const upperTip = 3
  const stepdown = 1
  const angleDeg = 0.5
  const angleBins = 720
  const standing = 4.85
  const reference: Reference = {
    // The cell sits at along 0.5, and the move from 0.5 to 1.5 is swept at
    // half-bin steps, so its first step is directly over the cell (dx = 0) --
    // the same continuous sweep the seeded reference performs.
    alongStart: 0.25,
    alongBins: 1,
    alongBin: 0.5,
    angleBins,
    angleDeg,
    maxMaterial: standing,
    occupied: new Map(),
    material: new Float64Array(angleBins).fill(standing),
  }
  const alongOf = (point: ToolpathMove['from']): number => point.x
  // The move starts directly over the cell (dx = 0 at its first swept step), so
  // the lower layer's contact is the outermost-surface removal the slice-Q
  // metric records. The previous layer's window cannot reach that ray.
  const cutAt = (tip: number): ToolpathMove => ({
    kind: 'cut', from: { x: 0.5, y: 0, z: tip }, to: { x: 1.5, y: 0, z: tip },
  })
  // The upper layer misses the 24.25° ray, so the material there stays blank.
  referenceMove(reference, cutAt(upperTip), 0, radius, true, alongOf, 0, 0)
  assert.ok(asinDeg(radius / (upperTip + radius)) < 24.25,
    'the previous layer is out of reach of the repro ray')
  assert.equal(reference.material[48], standing,
    'the upper layer leaves the repro ray standing')
  // The lower layer reaches it through the ball's shank and takes the column.
  referenceMove(reference, cutAt(lowerTip), 0, radius, true, alongOf, 0, 0)
  const reproBite = standing - reference.material[48]
  const oldBound = alongRadialBiteBound(true, radius, stepdown, lowerTip)
  assert.ok(Math.abs(reproBite - 2.3435) < 1e-3,
    `the repro ray removes ${reproBite.toFixed(4)} mm, not 2.3435`)
  assert.ok(reproBite > oldBound + 1e-6,
    `the repro exceeds the previous-layer bound (${reproBite.toFixed(4)} > ${oldBound.toFixed(4)})`)
  // The seeded allowance is evaluated at the **recorded worst cell** exactly as
  // the seeded loop does it: the standing material there minus this body's
  // contact at that ray, never below the previous-layer bound.
  const cell = moveSurfaceCell
  const cellDelta = (() => {
    const d = ((cell.angle - 0) % 360 + 360) % 360
    return d > 180 ? 360 - d : d
  })()
  const cellDx = cell.along < 0.5 ? 0.5 - cell.along : cell.along > 1.5 ? cell.along - 1.5 : 0
  const extendedBound = Math.max(oldBound,
    cell.material - alongRayContact(true, radius, lowerTip, cellDelta, cellDx))
  assert.ok(extendedBound >= moveSurfaceWorst - 1e-12,
    `the standing-material bound ${extendedBound.toFixed(4)} covers the measured ${moveSurfaceWorst.toFixed(4)}`)
  console.log(`  slice-Q repro: ${reproBite.toFixed(4)} mm at the 24.25 deg ray; previous-layer bound `
    + `${oldBound.toFixed(4)} mm (missed); worst cell ${moveSurfaceWorst.toFixed(4)} mm covered by `
    + `the standing-material bound ${extendedBound.toFixed(4)} mm`)
}

/** `Math.asin` in degrees, for the repro's reach check. */
function asinDeg(value: number): number {
  return Math.asin(Math.min(1, value)) * 180 / Math.PI
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
let worstAssertedInterior = 0
let worstAssertedInteriorLabel = ''
let worstAlongBite = 0
let worstAlongBiteLabel = ''
// The closest an along-stage radial bite came to its exact-geometry bound, and
// the bound it was checked against (#1045 slice Q).
let worstAlongMargin = Number.POSITIVE_INFINITY
let worstAlongMarginLabel = ''
// Diagnostic only, never asserted (#1045 slice P): interior removal an along
// move finds below an intact shell. It is not a radial depth and has no bound.
let alongInteriorDiagnostic = { depth: 0, label: '', stepover: 0, diameter: 0, stepdown: 0 }
// Count the along-stage assertion so a change that drops it (rather than making
// it a no-op) cannot pass silently: the seeded set must assert the radial
// surface bite of every along program.
let alongBiteChecks = 0
// The subset of those checks on a **finish after a rough** (the task's bound).
let finishAlongBiteChecks = 0
// #1045 slice S: how many emitted cuts the independent raw-descent assertion
// judged, split so a run that drops one mode (or one stage) cannot pass silently.
let descentChecks = 0
let alongDescentChecks = 0
let aroundDescentChecks = 0
let roughDescentChecks = 0
let worstDescentMargin = Number.POSITIVE_INFINITY
let worstDescentMarginLabel = ''
let nonTurningWorst = 0
let nonTurningLabel = ''
// #1093: finish links replayed against the independent model.
let finishLinkChecks = 0
let worstFinishLinkBite = 0
let worstFinishLinkBiteLabel = ''
let worstFinishAfterRoughLinkBite = 0
let worstFinishAfterRoughLinkBiteLabel = ''
let finishAfterRoughLinkChecks = 0
// #1093: the rough's in-air link is a rapid now, checked for clearance.
let rapidLinkChecks = 0
let roundRapidLinkChecks = 0
let worstRapidLinkMargin = Number.POSITIVE_INFINITY
let worstRapidLinkLabel = ''

// `SQUARE_CASES` is a profiling aid only: the committed run uses all 300 seeded
// cases, and the assertions below still require the full set.
const CASE_COUNT = process.env.SQUARE_CASES ? Number(process.env.SQUARE_CASES) : 300
const startedAt = Date.now()
const ROUND_CASES = 10
const CASES = [
  ...Array.from({ length: CASE_COUNT }, (_, seed) => fitCase(seed)),
  // #1045 slice R's along-finish cases are always in the set, whatever the
  // profiling count: a finish-only along program on a round bar and a square
  // blank, and the same with a rough in front of it.
  ...Array.from({ length: 8 }, (_, seed) => fitEntry(drawAlongCase(seed))),
  // #1093: the round-bar around equivalent of the square set, always present.
  ...Array.from({ length: ROUND_CASES }, (_, seed) =>
    fitEntry(drawRoundCase(seed), (scale) => drawRoundCase(seed, scale))),
  // #1093 review: non-revolved around models, so a link crossing a feature
  // between two rings is replayed against the full cutter body at every angle
  // under the pose, not one ray of a surface of revolution.
  fitEntry(drawFeatureCase(0)),
  fitEntry(drawFeatureCase(1)),
]
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
let alongFinishStages = 0
let alongFinishOnlyRound = 0
let alongFinishOnlySquare = 0
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
// #1093: rough link moves replayed against the reference's remaining material.
// An in-air link is a rapid and is checked for body clearance below; a link
// that stays a cut (the A-changing travel rule) must remove nothing.
let roughLinkChecks = 0
let roundAroundCases = 0
/** Non-revolved models replayed (#1093 review). */
let featureCases = 0

for (const { entry, program } of CASES) {
  currentCaseLabel = entry.label
  currentCaseSeed = casesDone
  currentCaseStepover = entry.stepover
  currentCaseDiameter = entry.diameter
  if (process.env.SQUARE_PROFILE) {
    console.log(`  [case] ${casesDone} ${((Date.now() - startedAt) / 1000).toFixed(1)} s${entry.compact ? ' compact' : ''} `
      + `est ${estimateReplayCells(program, entry)} steps ${referenceStats.steps - profileSteps} `
      + `moves ${referenceStats.moves - profileMoves} sd ${entry.stepdown} ${entry.programKind} — ${entry.label}`)
    profileSteps = referenceStats.steps
    profileMoves = referenceStats.moves
  }
  casesDone++
  if (entry.mesh) featureCases++
  if (entry.stock.shape === 'round' && entry.roughKind === 'around') roundAroundCases++
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
    // A non-revolved box that straddles the axis may legitimately need a cut
    // below the centreline (#1093); every revolved case here is above it.
    assert.ok(
      entry.mesh
        ? program.roughCodes.every((code) => code === 'rotaryBelowCentreline')
        : program.roughCodes.length === 0,
      `${entry.label}: the rough warns about nothing else`,
    )
  }
  if (finishRan) {
    // A finish only follows the model, so it cuts with or without a rough. A
    // finish-only program therefore cuts to full depth in one pass and is
    // outside every layer bound; it carries the advisory instead. A finish
    // after a rough is bounded by what the rough left.
    assert.ok(program.finishMoves.length > 0, `${entry.label}: the finish follows the model and cuts`)
    if (entry.programKind === 'finish') {
      assert.deepEqual(program.finishCodes, ['rotaryFinishWithoutRough'],
        `${entry.label}: a finish-only program carries the no-rough advisory`)
    } else {
      assert.ok(entry.mesh
        ? program.finishCodes.every((code) => code === 'rotaryBelowCentreline')
        : program.finishCodes.length === 0,
      `${entry.label}: a preceding rough suppresses the advisory`)
    }
    if (entry.finishKind === 'along') {
      alongFinishStages++
      if (entry.programKind === 'finish') {
        if (entry.stock.shape === 'round') alongFinishOnlyRound++
        else alongFinishOnlySquare++
      }
    }
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

  // A finish after a rough removes at most what the rough left at an along
  // stage's ray: one rough `stepdown`, plus the reference's own cell allowance
  // (`alongRadialBiteBound` below). A finish-only program has no layer bound
  // (2026-10-22 decision). Turning engagement is a rough-only assertion: a
  // finish has no clearing layers, and its single model-following ring can meet
  // the rough's between-pass ridge frontally, which is not a radial depth.
  const roughBound = entry.stepdown + budget.alongBin + ballRiseAt(cutterRadius, budget.alongBin) + 1e-6
  // #1093: a rough link is sized from the material its own earlier layers left
  // plus the 1 mm clearance, so it is in air. The reference's cell and ball
  // discretisation is the only removal it may report.
  const linkBiteAllowance = budget.alongBin + ballRiseAt(cutterRadius, budget.alongBin) + 1e-6
  const stageSpecs: Array<{ moves: ToolpathMove[]; finish: boolean; direction: 'around' | 'along' }> = []
  if (roughRan) stageSpecs.push({
    moves: coalesceCommandedMoves(program.roughMoves, COALESCE_TOLERANCE),
    finish: false,
    direction: entry.roughKind,
  })
  if (finishRan) stageSpecs.push({
    moves: coalesceCommandedMoves(program.finishMoves, COALESCE_TOLERANCE),
    finish: true,
    direction: entry.finishKind,
  })
  assert.ok(stageSpecs.length > 0, `${entry.label}: the program has motion`)

  // #1045 slice S (2026-10-22 decision): judge the emitted motion of every
  // **rough** before replaying it. A finish emits only the model-following
  // passes, so it has no layer descent to verify; after a rough the radial
  // bound below uses the rough's stepdown instead of a finish one.
  const stages = stageSpecs.map((spec) => ({
    ...spec,
    descent: spec.finish || entry.mesh
      ? null
      : assertStageDescent(
        entry,
        `rough ${spec.direction} stage`,
        spec.moves,
        spec.direction,
        pivot,
        ball,
        cutterRadius,
        entry.stepdown,
        alongOf,
        entry.roughSpacing,
      ),
  }))
  for (const stage of stages) {
    if (!stage.descent) continue
    descentChecks += stage.descent.cuts
    if (stage.direction === 'along') alongDescentChecks += stage.descent.cuts
    else aroundDescentChecks += stage.descent.cuts
    roughDescentChecks += stage.descent.cuts
    if (stage.descent.margin < worstDescentMargin) {
      worstDescentMargin = stage.descent.margin
      worstDescentMarginLabel = `${entry.label} ${stage.descent.marginLabel}`
    }
    assert.ok(stage.descent.cuts > 0,
      `${entry.label}: the rough ${stage.direction} stage emits a verified descent`)
  }

  let controller = allMoves.find((move) => move.from.a !== undefined)?.from.a ?? 0
  for (const stage of stages) {
    const bound = roughBound
    // A finish-only program cuts to full depth in one pass, so the along-stage
    // radial bite does not apply to it; it is covered by the advisory instead.
    // (Turning engagement and plunges are rough-only assertions regardless.)
    const unlicensedFinish = stage.finish && entry.programKind === 'finish'
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
        } else if (stage.direction === 'around'
          && fromAngle === toAngle && alongOf(move.from) !== alongOf(move.to)
          && move.from.z === move.to.z) {
          // #1093: the rough's in-air link is a constant-height rapid along the
          // bar. It must clear everything the reference still holds under the
          // whole cutter body; it removes nothing, so a rapid that dips below
          // the leftover bound is a gouge the reference would never replay.
          rapidLinkChecks++
          if (entry.stock.shape === 'round') roundRapidLinkChecks++
          const margin = rapidClearance(reference, move, pivot, cutterRadius, ball, alongOf)
          if (margin < worstRapidLinkMargin) {
            worstRapidLinkMargin = margin
            worstRapidLinkLabel = `${entry.label} A${fromAngle.toFixed(2)} along `
              + `${alongOf(move.from).toFixed(2)}->${alongOf(move.to).toFixed(2)} `
              + `tip ${(move.from.z - pivot).toFixed(3)}`
          }
          assert.ok(margin >= -linkBiteAllowance,
            `${entry.label}: an in-air rough link at A${fromAngle.toFixed(2)} along `
            + `${alongOf(move.from).toFixed(2)}->${alongOf(move.to).toFixed(2)} stands `
            + `${(-margin).toFixed(4)} mm below the material its earlier layers left `
            + `(allowed ${linkBiteAllowance.toFixed(4)}; tip ${rapidWorst.tip.toFixed(3)} `
            + `contact ${rapidWorst.contact.toFixed(3)} material ${rapidWorst.material.toFixed(3)} `
            + `at along ${rapidWorst.along.toFixed(2)} A${rapidWorst.angle.toFixed(2)} delta ${rapidWorst.delta.toFixed(2)})`)
        }
      } else if (lowZ < travelZ - 1e-6) {
        const engagement = referenceMove(reference, move, pivot, cutterRadius, ball, alongOf, fromAngle, toAngle)
        // #1093: a rough link is a feed at one angle that changes along. Its
        // height came from what this operation's earlier layers left, so the
        // reference should lose nothing to it; a link sized from the model
        // instead would cut the terrace between the two rings.
        // Only an around stage's constant-angle along feed is a #1093 link; an
        // along-mode pass is a constant-angle cut by construction.
        const linkMove = stage.direction === 'around'
          && fromAngle === toAngle && alongOf(move.from) !== alongOf(move.to)
        if (linkMove) {
          if (stage.finish) {
            finishLinkChecks++
            if (moveSurfaceWorst > worstFinishLinkBite) {
              worstFinishLinkBite = moveSurfaceWorst
              worstFinishLinkBiteLabel = `${entry.label} ${entry.programKind} A${fromAngle.toFixed(2)} along `
                + `${alongOf(move.from).toFixed(2)}->${alongOf(move.to).toFixed(2)} `
                + `tip ${(move.from.z - pivot).toFixed(3)}->${(move.to.z - pivot).toFixed(3)}`
            }
            // A surface-following link is not an air move: between two rings it
            // removes the terrace the rough left, so the air allowance the rough
            // link uses does not apply. A finish after a rough is bounded by that
            // rough's stepdown, exactly as the along-stage finish above is; a
            // finish-only program has no layer bound (2026-10-22 decision) and is
            // covered by its advisory and the final-surface check.
            if (entry.programKind !== 'finish') {
              finishAfterRoughLinkChecks++
              if (moveSurfaceWorst > worstFinishAfterRoughLinkBite) {
                worstFinishAfterRoughLinkBite = moveSurfaceWorst
                worstFinishAfterRoughLinkBiteLabel = `${entry.label} A${fromAngle.toFixed(2)} along `
                  + `${alongOf(move.from).toFixed(2)}->${alongOf(move.to).toFixed(2)} `
                  + `tip ${(move.from.z - pivot).toFixed(3)}->${(move.to.z - pivot).toFixed(3)}`
              }
              assert.ok(moveSurfaceWorst <= roughBound,
                `${entry.label}: a finish link at A${fromAngle.toFixed(2)} along `
                + `${alongOf(move.from).toFixed(2)}->${alongOf(move.to).toFixed(2)} removes `
                + `${moveSurfaceWorst.toFixed(4)} mm of the material the rough left `
                + `(allowed ${roughBound.toFixed(4)}, one rough stepdown; cell along `
                + `${moveSurfaceCell.along.toFixed(2)} A${moveSurfaceCell.angle.toFixed(2)} `
                + `material ${moveSurfaceCell.material.toFixed(3)} standing ${moveSurfaceCell.standing.toFixed(3)}; `
                + `stepover ${entry.stepover} cell ${entry.requestedCellSize})`)
            }
          } else {
            // A rough link that stays a cut (it changes A, or its next cut is
            // above the clearance plane) is the old travel-height motion; the
            // rapid is checked above.
            roughLinkChecks++
            assert.ok(moveSurfaceWorst <= linkBiteAllowance,
              `${entry.label}: a rough link at A${fromAngle.toFixed(2)} along `
              + `${alongOf(move.from).toFixed(2)}->${alongOf(move.to).toFixed(2)} removes `
              + `${moveSurfaceWorst.toFixed(4)} mm of the material the earlier layers left `
              + `(allowed ${linkBiteAllowance.toFixed(4)})`)
          }
        }
        if (stage.direction === 'around') {
          if (!stage.finish) {
            if (moveInteriorWorst > worstAssertedInterior) {
              worstAssertedInterior = moveInteriorWorst
              worstAssertedInteriorLabel = `${entry.label} ${move.kind} A${fromAngle.toFixed(2)}->${toAngle.toFixed(2)} `
                + `at along ${interiorWorst.along.toFixed(2)} A${interiorWorst.angle.toFixed(2)}`
            }
            // A sharp non-revolved corner makes the cumulative removed material
            // an upper bound with no stepdown meaning (the same reason the along
            // stage's interior number is not a bound); the link and rapid checks
            // carry the non-revolved cases.
            if (!entry.mesh) checkEngagement(moveInteriorWorst, bound, `${entry.label}: interior ${move.kind}`)
          }
        } else {
          // #1045 slice O/P: an along pass is a **flank** cut, not a radial
          // plunge. The radial metric that matters is the material this move
          // removes from the outermost solid at a ray -- one radial depth of
          // cut, which must stay within a stepdown exactly as a turning cut's
          // does. The reference's cumulative "interior" number is the cutter's
          // body occupying air below an intact shell (and spans a previous pose
          // already removed); it is **not** a radial depth and has no geometric
          // bound: a Ø4 flat sweeping at tip 2 with a 10° ray offset removes
          // 9.4867 mm internally, so the stepover + diameter "flank bound" this
          // file used to assert (4.1 mm there) was not a bound at all. It is
          // reported as a diagnostic below and deliberately not asserted
          // (#1045 slice P, Codex pass 9).
          if (moveSurfaceWorst > worstAlongBite) {
            worstAlongBite = moveSurfaceWorst
            worstAlongBiteLabel = `${entry.label} ${move.kind} A${fromAngle.toFixed(2)}->${toAngle.toFixed(2)} `
              + `tip ${(move.from.z - pivot).toFixed(3)}->${(move.to.z - pivot).toFixed(3)} `
              + `at along ${moveSurfaceCell.along.toFixed(2)} A${moveSurfaceCell.angle.toFixed(2)}`
          }
          // #1045 slice Q: the allowance is the cutter's **exact geometry**, not
          // the old `alongBin + ballRise` scallop term. A step down from layer
          // `t + stepdown` to `t` can move the outermost solid at a ray by at
          // most the difference between the ball's sphere (or the flat's bottom
          // face) at those two tips, maximised over the ray offsets the
          // reference resolves. `alongRadialBiteBound` derives that maximum in
          // closed form; `tip` is the move's lowest tip, at which the bound is
          // largest.
          // A finish after a rough is bounded by the rough's stepdown: the
          // rough left at most one of those above the surface, so the finish's
          // model-following pass removes at most that. A rough uses its own.
          // Both use slice Q's exact geometry. The bound is extended past the
          // previous layer's reach (#1045 slice Q extension): on a ray that
          // layer did **not** reach, the standing material is not its contact,
          // so the allowance is measured from the material actually standing at
          // that ray down to this body's own contact. Where the previous layer
          // did reach, the standing material is at most its contact, so the
          // second term cannot exceed the first and the exact bound is
          // unchanged.
          const tip = Math.min(move.from.z - pivot, move.to.z - pivot)
          const stepdown = entry.stepdown
          const cellDelta = (() => {
            const d = ((moveSurfaceCell.angle - fromAngle) % 360 + 360) % 360
            return d > 180 ? 360 - d : d
          })()
          const alongLo = Math.min(alongOf(move.from), alongOf(move.to))
          const alongHi = Math.max(alongOf(move.from), alongOf(move.to))
          const cellDx = moveSurfaceCell.along < alongLo
            ? alongLo - moveSurfaceCell.along
            : moveSurfaceCell.along > alongHi ? moveSurfaceCell.along - alongHi : 0
          const reachedBound = alongRadialBiteBound(ball, cutterRadius, stepdown, tip)
          const standingBound = moveSurfaceCell.material
            - alongRayContact(ball, cutterRadius, tip, cellDelta, cellDx)
          // #1045 slice S: the standing-material term is only sound where the
          // stage's own emitted samples inside this cutter's footprint really
          // descended from the raw blank one stepdown at a time. A finish has
          // no descent of its own (it follows the model), so it uses the plain
          // previous-layer bound. Without that proof it would measure from
          // material the operation never cleared and excuse any bite (a
          // 1 000 mm stepdown passed all eight along-finish cases, including
          // 9.3975 mm).
          const standingAllowed = stage.descent !== null && descentCoversRay(
            stage.descent,
            moveSurfaceCell.along,
            moveSurfaceCell.angle,
            ball,
            cutterRadius,
            tip,
            moveSurfaceCell.material,
          )
          const alongBound = standingAllowed ? Math.max(reachedBound, standingBound) : reachedBound
          if (!unlicensedFinish) {
            const alongMargin = alongBound - moveSurfaceWorst
            if (alongMargin < worstAlongMargin) {
              worstAlongMargin = alongMargin
              worstAlongMarginLabel = `${entry.label} ${move.kind} `
                + `A${fromAngle.toFixed(2)} tip ${tip.toFixed(3)} `
                + `bite ${moveSurfaceWorst.toFixed(4)} against ${alongBound.toFixed(4)} `
                + `(previous-layer ${reachedBound.toFixed(4)}, standing ${standingBound.toFixed(4)} `
                + `${standingAllowed ? 'covered' : 'not covered'} at ray off ${cellDelta.toFixed(2)} deg / along ${cellDx.toFixed(3)})`
            }
            checkEngagement(moveSurfaceWorst, alongBound,
              `${entry.label}: along ${move.kind} radial surface bite `
              + `(at along ${moveSurfaceCell.along.toFixed(2)} A${moveSurfaceCell.angle.toFixed(2)} `
              + `material ${moveSurfaceCell.material.toFixed(3)} -> ${moveSurfaceCell.standing.toFixed(3)}; `
              + `exact ${ball ? 'ball' : 'flat'} bound ${alongBound.toFixed(4)}: `
              + `previous-layer ${reachedBound.toFixed(4)}, standing ${standingBound.toFixed(4)} `
              + `(${standingAllowed ? 'covered by the emitted descent' : 'not applied: no verified descent inside the footprint'})`)
            alongBiteChecks++
            if (stage.finish) finishAlongBiteChecks++
          }
          // Diagnostic only: the interior removal an along move finds below an
          // intact shell. It has no asserted bound (see above); recording the
          // worst is what lets the report show how much it is, without claiming
          // that number is safe or unsafe.
          if (moveInteriorWorst > alongInteriorDiagnostic.depth) {
            alongInteriorDiagnostic = {
              depth: moveInteriorWorst,
              label: `${entry.label} ${move.kind} A${fromAngle.toFixed(2)}`,
              stepover: entry.stepover, diameter: entry.diameter, stepdown: entry.stepdown,
            }
          }
        }
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
            if (!stage.finish) {
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
              if (!entry.mesh) {
                checkEngagement(engagement, bound,
                  `${entry.label}: a ${stage.finish ? 'finish' : 'rough'} turning cut `
                  + `(A${fromAngle.toFixed(2)} -> ${toAngle.toFixed(2)}; worst cell along ${worstCell.along.toFixed(2)} `
                  + `A${worstCell.angle.toFixed(2)} material ${worstCell.material.toFixed(3)} contact ${worstCell.contact.toFixed(3)})`)
              }
            }
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
          const around = stage.direction === 'around'
          if (!around) {
            if (engagement > nonTurningWorst) {
              nonTurningWorst = engagement
              nonTurningLabel = `${entry.label} @A${fromAngle.toFixed(2)} plunge`
            }
          } else {
            checkedPlunges++
            const keyLabel = `${entry.label} @A${fromAngle.toFixed(2)}`
            if (!stage.finish) {
              if (engagement > worstPlunge) {
                worstPlunge = engagement
                worstPlungeLabel = keyLabel
              }
              if (!entry.mesh) {
                checkEngagement(engagement, bound,
                  `${entry.label}: a ${stage.finish ? 'finish' : 'rough'} plunge (A${fromAngle.toFixed(2)}; `
                  + `cell along ${worstCell.along.toFixed(2)} A${worstCell.angle.toFixed(2)} `
                  + `material ${worstCell.material.toFixed(3)} contact ${worstCell.contact.toFixed(3)})`)
              }
            }
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
      const blank = blankRadius(stock, angle)
      const index = i * reference.angleBins + k
      const drop = retainedRemoval(reference, index, blank)
      if (drop > worstStubDrop) {
        worstStubDrop = drop
        worstStubLabel = `${entry.label} along ${along.toFixed(2)} A${angle.toFixed(2)}`
      }
      assert.ok(drop <= 1e-6, `${entry.label}: the cutter lowered a retained end by ${drop.toFixed(4)} mm at along ${along.toFixed(2)}`)
    }
  }

  // (3) The finished surface: not below the model, and -- for a finish that
  // has a rough in front of it -- no more than the finish's own scallop above
  // model + stock. A finish-only program cuts to full depth in one pass and
  // leaves the raw blank between its passes, so its above-model material is not
  // a finished-surface measure; it is covered by the advisory instead.
  if (!finishRan) continue
  // A non-revolved model has no "radius at this along"; the surface bounds
  // below need one. Its link replay, layer descent and retained-end checks are
  // the proof for those cases (#1093).
  if (entry.mesh) continue
  const finishOnly = entry.programKind === 'finish'
  const slope = modelMaxSlope(entry.profile)
  // A ball leaves its between-pass scallop; a flat leaves a staircase one full
  // step tall on a sloped surface, because each pass's bottom is a horizontal
  // plane at that pass's model height. An around finish steps `stepover` along
  // and `sampleSpacing` round; an along finish steps `stepover` round and
  // `sampleSpacing` along, so the two motions swap the two scallops.
  const alongStep = entry.finishKind === 'along' ? entry.finishSpacing : entry.stepover
  const alongScallop = ball
    ? ballRiseAt(cutterRadius, alongStep / 2)
    : slope * alongStep
  const angleArc = entry.finishKind === 'along'
    ? entry.stepover
    : aroundArcStep(corner, entry.finishSpacing)
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
      if (!finishOnly && over > worstSurfaceOver) {
        worstSurfaceOver = over
        worstSurfaceOverLabel = `${entry.label} along ${along.toFixed(2)} A${angle.toFixed(2)} material ${material.toFixed(4)} model ${model.toFixed(4)}`
      }
      const under = wanted - material
      if (under > worstSurfaceUnder) {
        worstSurfaceUnder = under
        worstSurfaceUnderLabel = `${entry.label} along ${along.toFixed(2)} A${angle.toFixed(2)} material ${material.toFixed(4)} model ${model.toFixed(4)}`
      }
      if (!finishOnly) {
        assert.ok(over <= surfaceTolerance,
          `${entry.label}: the finish leaves ${over.toFixed(4)} mm above the model (allowed ${surfaceTolerance.toFixed(4)}) `
          + `at along ${along.toFixed(2)} A${angle.toFixed(2)}`)
      }
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
console.log(`  interior engagement asserted in around stages: worst ${worstAssertedInterior.toFixed(4)} mm `
  + `(${worstAssertedInteriorLabel || 'none'})`)
console.log(`  interior engagement including frozen along stages: worst ${interiorWorst.depth.toFixed(4)} mm `
  + `at along ${interiorWorst.along.toFixed(2)} A${interiorWorst.angle.toFixed(2)} (${interiorWorst.kind || 'none'}) `
  + `— ${interiorWorst.label || 'none'} (seed ${interiorWorst.seed}); move A${interiorWorst.fromAngle.toFixed(2)}->${interiorWorst.toAngle.toFixed(2)} `
  + `tip ${interiorWorst.fromTip.toFixed(3)}->${interiorWorst.toTip.toFixed(3)} `
  + `along ${interiorWorst.fromAlong.toFixed(2)}->${interiorWorst.toAlong.toFixed(2)}; `
  + `material ${interiorWorst.material.toFixed(3)} standing ${interiorWorst.standing.toFixed(3)}; `
  + `stepover ${interiorWorst.stepover.toFixed(3)} diameter ${interiorWorst.diameter.toFixed(3)})`)
console.log(`  retained ends: worst material lowered ${worstStubDrop.toFixed(6)} mm (${worstStubLabel || 'none'})`)
console.log(`  finished surface: worst ${worstSurfaceOver.toFixed(4)} mm above the model `
  + `(${worstSurfaceOverLabel})`)
console.log(`  finished surface: worst ${worstSurfaceUnder.toFixed(4)} mm below the model `
  + `(${worstSurfaceUnderLabel})`)
console.log(`  along stage: worst radial surface bite ${worstAlongBite.toFixed(4)} mm (${worstAlongBiteLabel || 'none'})`)
console.log(`  along stage: closest to its exact-geometry bound at ${worstAlongMargin.toFixed(4)} mm margin `
  + `(${worstAlongMarginLabel || 'none'})`)
console.log(`  emitted layer descent: ${descentChecks} cuts checked (${alongDescentChecks} along, `
  + `${aroundDescentChecks} around; all ${roughDescentChecks} rough; finishes have no layer descent); `
  + `closest to its allowance at ${worstDescentMargin.toFixed(4)} mm margin `
  + `(${worstDescentMarginLabel || 'none'})`)
// Diagnostic only, explicitly not a bound (#1045 slice P). The old
// stepover + diameter "flank bound" is gone: a hand-built Ø4 flat sweep at tip 2
// with a 10° ray offset removes 9.4867 mm internally, far past it.
console.log(`  along stage: interior removal below an intact shell ${alongInteriorDiagnostic.depth.toFixed(4)} mm `
  + `(${alongInteriorDiagnostic.label || 'none'}; stepover ${alongInteriorDiagnostic.stepover.toFixed(3)} `
  + `diameter ${alongInteriorDiagnostic.diameter.toFixed(3)} stepdown ${alongInteriorDiagnostic.stepdown.toFixed(3)}) `
  + '— diagnostic only, not a bound')
console.log(`  non-turning cuts (reported, not asserted: the along-mode rough output is frozen): `
  + `worst ${nonTurningWorst.toFixed(4)} mm (${nonTurningLabel || 'none'})`)
if (process.env.SQUARE_CASES) {
  console.log(`  [profile] ${referenceStats.moves} reference moves, ${referenceStats.cells} cell visits, `
    + `${referenceStats.steps} sweep steps; ${((Date.now() - startedAt) / 1000).toFixed(1)} s`)
}

console.log(`  along finishes: ${alongFinishStages} stages (${alongFinishOnlyRound} finish-only round, `
  + `${alongFinishOnlySquare} finish-only square) — finish-only programs carry the advisory; `
  + `a finish after a rough keeps the radial bound with the rough's stepdown`)
assert.ok(checkedCuts > 1000, `the reference checked turning/cut moves (${checkedCuts})`)
assert.ok(alongFinishStages >= 8, `the along-finish stages are in the seeded set (${alongFinishStages})`)
assert.ok(alongFinishOnlyRound >= 1, `a finish-only along program on a round bar (${alongFinishOnlyRound})`)
assert.ok(alongFinishOnlySquare >= 1, `a finish-only along program on a square blank (${alongFinishOnlySquare})`)
assert.ok(alongBiteChecks > 100, `the along stage's radial surface bite is asserted (${alongBiteChecks})`)
assert.ok(finishAlongBiteChecks > 100,
  `the finish-after-rough along stage's radial surface bite is asserted (${finishAlongBiteChecks})`)
// #1045 slice S: the raw-descent assertion must actually cover every stage
// shape, in both modes, for rough and finish. A change that stops calling it
// fails here rather than passing with no checks.
assert.ok(alongDescentChecks > 1000, `the emitted along descent is asserted (${alongDescentChecks})`)
assert.ok(aroundDescentChecks > 1000, `the emitted around descent is asserted (${aroundDescentChecks})`)
assert.ok(roughDescentChecks > 1000, `the emitted rough descent is asserted (${roughDescentChecks})`)
assert.ok(checkedPlunges > 100, `the reference asserted plunges too (${checkedPlunges})`)
console.log(`  plunges: worst engagement ${worstPlunge.toFixed(4)} mm (${worstPlungeLabel || 'none'})`)
console.log(`  #1093 rough links: ${rapidLinkChecks} replayed as in-air rapids `
  + `(${roundRapidLinkChecks} on round bars; ${roughLinkChecks} cut links), `
  + `worst body clearance ${worstRapidLinkMargin.toFixed(4)} mm (${worstRapidLinkLabel || 'none'})`)
console.log(`  #1093 finish links: ${finishLinkChecks} replayed `
  + `(${finishAfterRoughLinkChecks} after a rough), worst removal ${worstFinishLinkBite.toFixed(4)} mm `
  + `(${worstFinishLinkBiteLabel || 'none'}); after a rough ${worstFinishAfterRoughLinkBite.toFixed(4)} mm `
  + `(${worstFinishAfterRoughLinkBiteLabel || 'none'})`)
assert.ok(roundAroundCases >= ROUND_CASES,
  `the round-bar around set is in the seeded run (${roundAroundCases} >= ${ROUND_CASES})`)
assert.ok(featureCases >= 2,
  `non-revolved around models are replayed (${featureCases})`)
assert.ok(rapidLinkChecks > 0, `the rough in-air links are replayed against the reference (${rapidLinkChecks})`)
assert.ok(roundRapidLinkChecks > 0, `a round-bar rough in-air link is replayed (${roundRapidLinkChecks})`)
assert.ok(finishLinkChecks > 0, `the finish links are replayed against the reference (${finishLinkChecks})`)
assert.ok(finishAfterRoughLinkChecks > 0,
  `a finish link after a rough is replayed against the reference (${finishAfterRoughLinkChecks})`)
// #1045 slice N: at least 38 programs must run at the adapter's **default**
// parameters -- never coarsened, only shortened -- so the default cutting
// programs are covered, not only the custom-sampling ones. The subset covers
// every program shape and both retained-end states.
assert.ok(defaultCases >= 38, `at least 38 default-parameter programs (${defaultCases})`)
assert.ok(defaultFinishOnly > 0, `a finish-only default program (${defaultFinishOnly})`)
assert.ok(defaultRoughOnly > 0, `a rough-only default program (${defaultRoughOnly})`)
assert.ok(defaultBoth > 0, `a rough+finish default program (${defaultBoth})`)
assert.ok(defaultMixed > 0, `an along-rough + around-finish default program (${defaultMixed})`)
assert.ok(defaultRetained > 0, `a default program with retained ends (${defaultRetained})`)
assert.ok(defaultFree > 0, `a default program with free ends (${defaultFree})`)

console.log(`engine/toolpaths/squareAroundGenerator.property.test.ts: all assertions passed in ${((Date.now() - startedAt) / 1000).toFixed(1)} s (including generation)`)
