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
 * Engagement-limited path generation (issue #499, slice S3) — the reusable
 * generator that produces an unwind excursion for a qualifying inside corner
 * of an offset ring, with the corner unwind as its first caller.
 *
 * The general problem, per the issue: *produce a path from A to B whose
 * measured engagement stays at or below a bound*. #501 needs the same
 * generator to spiral out from a helix seed, so nothing here knows about
 * corners specifically. The core takes two tangent endpoints, an engagement
 * bound, and an engagement oracle, and emits a path between them whose every
 * sample the oracle measures at or below the bound. `cornerUnwindPath` only
 * assembles a corner's A and B from the lead-in distance and the interior
 * side; the geometry is the core's.
 *
 * Pure module in the sense `engagement.ts` is pure: no `Project`/`Operation`
 * imports, no pocket coupling, no I/O, fully deterministic (no
 * `Math.random`, no `Date.now`, stable ordering).
 *
 * ## The load-bearing geometric fact (issue #499)
 *
 * Rough offset traversal is `'inner-first'`, so when a ring is cut its inner
 * neighbours are already gone: cleared space lies toward the pocket
 * interior, and that is the only direction an excursion may unwind.
 * Unwinding outward drives the tool into uncut stock — or into the wall on
 * the root ring. The `side` parameter carries that direction explicitly, and
 * `cornerUnwindPath` asserts it: a side that does not match the corner's
 * turn direction is rejected with a `RangeError`, so the sign can never be
 * flipped silently. (Conventional pocket rings wind positively in the
 * internal screen-Y-down coordinates and turn left at inside corners, so
 * the interior is on the left of travel; climb rings wind negatively and
 * take `'right'`. In both cases the side equals the inside of the turn.)
 *
 * ## Construction — the tangent biarc
 *
 * The emitted path is two circular arcs of equal radius `R` joined at their
 * external tangent point `M`: arc 1 leaves `from` tangent to the incoming
 * direction and curves toward `side`; arc 2 arrives at `to` tangent to the
 * outgoing direction, curving the other way. The junction condition
 * `|C1 − C2| = 2R` is a quadratic in `R` with a unique positive root (the
 * closed form below), so the shape is fully determined by the endpoints —
 * no tuning, no search. For the symmetric corner configuration (`A` and `B`
 * at equal distance `l` from the corner vertex on the two edges) the
 * junction collapses onto `B` and the biarc degenerates to the single
 * tangent circle of radius `R = l·cot(φ/2)` — the corner excursion: the
 * tool leaves the ring `l` before the corner, arcs through the cleared
 * interior, and rejoins `l` past it, so the corner is never cut at the
 * spike heading. Near-parallel tangents (`u ≈ v`) degenerate further: the
 * emitted path is the straight chord, still verified sample by sample.
 *
 * ## Fail closed
 *
 * The generator measures its own output: every emitted sample is queried
 * against the caller's oracle, and any sample above the bound — or any
 * non-finite oracle reading — returns `{ status: 'engagement-exceeded' }`
 * with the violating sample. The caller (slice S5) then discards the
 * excursion and emits the legacy corner; a generator that cannot prove its
 * path safe emits nothing.
 */

/** Length below which two points count as coincident. */
const GEOMETRY_EPS = 1e-9

/** `4 − |left(u) + left(v)|²` below which the tangents count as parallel. */
const PARALLEL_TANGENT_EPS = 1e-12

/** Smallest turn magnitude `cornerUnwindPath` treats as a corner at all. */
const TURN_ZERO_EPS = 1e-9

/**
 * Sampling step of the emitted path as a fraction of the tool diameter:
 * `d/4`, the slice-1 measurement resolution and the corner qualifier's walk
 * step (`ENGAGEMENT_SAMPLE_STEP_FRACTION`), kept equal here so the emitted
 * path is verified at the same resolution the span table was captured at.
 * Internal: the acceptance tests re-measure the emitted polyline at this
 * resolution independently and fail if emission coarsens (mutation-checked
 * during development).
 */
const SAMPLE_STEP_FRACTION = 0.25

/**
 * How far before and after the corner the excursion leaves and rejoins the
 * ring, in tool diameters.
 *
 * Derived from the #498/#499 measured spike shape: the corner spike decays
 * back to the straight-wall value over roughly two tool diameters of path
 * either side of the corner (the #499 issue's reopening comment, and the
 * slice-1 measured spans, which run 1.0d–7.4d two-sided). A lead-in of `2d`
 * places both the departure point A and the re-entry point B at the nominal
 * straight-run engagement, which is what makes the re-entry bound below
 * (`nominal + ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD`) attainable at all: a
 * smaller lead-in lands A or B inside the decaying spike and the excursion
 * fails its own bound. The acceptance test fails when this constant is
 * retuned below 2 (mutation-checked during development).
 */
export const CORNER_LEAD_IN_TOOL_DIAMETERS = 2

/**
 * The stated engagement margin above the straight-wall value: every sample
 * of a corner excursion is verified against
 * `nominalEngagement + ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD`.
 *
 * Derived from measurement, never guessed. Under the production replay
 * oracle (60 mm square, r = 3, stepover 2.4, every inner ring indexed) the
 * excursion's measured peak sits 0.1213 rad above the 1.3694 rad
 * straight-wall value at the anchor corner, and 0.1308 rad above it on
 * `largeComplex` — the worst accepted corner of the pack scan, both at the
 * re-entry approach where the tool's outboard flank pokes past the swept
 * edge just before the tangent re-join. The margin of 0.15 rad covers the
 * worst measured accepted excess with ~15% headroom and stays ~10× below
 * the anchor corner's direct excess (2.9404 − 1.3694 = 1.5710 rad), so the
 * suppressed-excursion contrast has far more room than it needs.
 * Bracket-tested both ways (mutation-checked during development, and pinned
 * by a premise test).
 */
export const ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD = 0.15

/** Which side of travel an excursion may bulge toward. */
export type ExcursionSide = 'left' | 'right'

/** One tangent endpoint of an engagement-limited path. */
export interface EngagementLimitedPathEndpoint {
  x: number
  y: number
  /** Unit travel direction: incoming at `from`, outgoing at `to`. */
  directionX: number
  directionY: number
}

/** One emitted, oracle-verified sample of an engagement-limited path. */
export interface EngagementLimitedPathSample {
  x: number
  y: number
  directionX: number
  directionY: number
  /** Measured engagement at this point, radians, in `[0, π]`. */
  engagement: number
}

export type EngagementLimitedPathResult =
  | { status: 'ok'; samples: EngagementLimitedPathSample[]; maxEngagement: number }
  | {
      status: 'engagement-exceeded'
      samples: EngagementLimitedPathSample[]
      maxEngagement: number
      violation: { x: number; y: number; engagement: number }
    }

export interface EngagementLimitedPathOptions {
  /** Tool diameter in project units; the sampling step derives from it. */
  toolDiameter: number
  /** Engagement upper bound, radians; every emitted sample must be at or below it. */
  maxEngagement: number
  /** Side of the incoming travel direction the path bulges toward (see the module doc). */
  side: ExcursionSide
  /**
   * Engagement oracle, in radians, for a cutter at `(x, y)` heading
   * `(dirX, dirY)` (need not be unit length). The generator queries only
   * its own emitted positions.
   */
  engagementAt: (x: number, y: number, dirX: number, dirY: number) => number
}

export interface CornerUnwindRequest {
  /** The corner vertex (the qualifying corner's position). */
  cornerX: number
  cornerY: number
  /** Unit direction along the approach edge, pointing INTO the vertex. */
  approachX: number
  approachY: number
  /** Unit direction along the departure edge, pointing OUT of the vertex. */
  departureX: number
  departureY: number
  /** The interior side — the only direction an excursion may unwind. */
  side: ExcursionSide
  /** Tool diameter in project units. */
  toolDiameter: number
  /** Straight-wall engagement for the stepover: `nominalEngagement(stepover · diameter, diameter / 2)`. */
  nominalEngagement: number
  /** Engagement oracle (see `EngagementLimitedPathOptions.engagementAt`). */
  engagementAt: (x: number, y: number, dirX: number, dirY: number) => number
}

interface UnitVector {
  x: number
  y: number
}

/** `(−y, x)`: the +90° (atan2-left) rotation, the `'left'` side of travel. */
function leftOf(x: number, y: number): UnitVector {
  return { x: -y, y: x }
}

function normalizeDirection(x: number, y: number, label: string): UnitVector {
  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    throw new RangeError(`engagementLimitedPath: ${label} direction must be finite, got (${x}, ${y})`)
  }
  const length = Math.hypot(x, y)
  if (length <= 1e-12) {
    throw new RangeError(`engagementLimitedPath: ${label} direction must be non-degenerate, got (${x}, ${y})`)
  }
  return { x: x / length, y: y / length }
}

function sideSign(side: ExcursionSide): number {
  if (side === 'left') return 1
  if (side === 'right') return -1
  throw new RangeError(`engagementLimitedPath: side must be 'left' or 'right', got ${String(side)}`)
}

function normalizeSweep(value: number): number {
  const twoPi = 2 * Math.PI
  return ((value % twoPi) + twoPi) % twoPi
}

interface ArcEmission {
  /** Centre of the arc. */
  cx: number
  cy: number
  /** Radius of the arc. */
  radius: number
  /** Angle of the arc's start point (the first emitted point). */
  fromAngle: number
  /** Sweep in `(0, 2π]`, always positive. */
  sweep: number
  /** +1 = counterclockwise (atan2-increasing), −1 = clockwise. */
  traversal: number
}

/** Empty-path result for coincident endpoints: no motion, nothing measured. */
function emptyResult(): EngagementLimitedPathResult {
  return { status: 'ok', samples: [], maxEngagement: 0 }
}

/**
 * Emit the arc's samples and verify each against the oracle and the bound.
 * Returns the running maximum and any violation; the caller folds the
 * emitted prefix into the final result. `skipFirst` drops the arc's start
 * point, which the caller uses so the biarc junction is emitted once.
 */
function emitAndVerifyArc(
  arc: ArcEmission,
  step: number,
  skipFirst: boolean,
  options: EngagementLimitedPathOptions,
  emitted: EngagementLimitedPathSample[],
  maxEngagement: number,
): { maxEngagement: number; violation: { x: number; y: number; engagement: number } | null } {
  let runningMax = maxEngagement
  const angularStep = step / arc.radius
  const steps = Math.max(1, Math.ceil(arc.sweep / angularStep))
  for (let index = skipFirst ? 1 : 0; index <= steps; index += 1) {
    const angle = arc.fromAngle + arc.traversal * arc.sweep * (index / steps)
    const x = arc.cx + arc.radius * Math.cos(angle)
    const y = arc.cy + arc.radius * Math.sin(angle)
    // Traversal +1 (CCW) tangent = left of the radial; traversal −1 = its negation.
    const directionX = arc.traversal * -Math.sin(angle)
    const directionY = arc.traversal * Math.cos(angle)
    const engagement = options.engagementAt(x, y, directionX, directionY)
    const sample: EngagementLimitedPathSample = { x, y, directionX, directionY, engagement }
    emitted.push(sample)
    if (!Number.isFinite(engagement)) {
      return { maxEngagement: runningMax, violation: { x, y, engagement } }
    }
    if (engagement > runningMax) runningMax = engagement
    if (engagement > options.maxEngagement) {
      return { maxEngagement: runningMax, violation: { x, y, engagement } }
    }
  }
  return { maxEngagement: runningMax, violation: null }
}

/**
 * Produce a path from `from` to `to` whose measured engagement stays at or
 * below `options.maxEngagement`, bulging toward `options.side`. Deterministic
 * and fail-closed: a bound violation (or a non-finite oracle reading) at any
 * emitted sample returns `'engagement-exceeded'` with the violating sample;
 * no partial path is ever reported as safe.
 */
export function engagementLimitedPath(
  from: EngagementLimitedPathEndpoint,
  to: EngagementLimitedPathEndpoint,
  options: EngagementLimitedPathOptions,
): EngagementLimitedPathResult {
  if (!Number.isFinite(options.toolDiameter) || options.toolDiameter <= 0) {
    throw new RangeError(`engagementLimitedPath: toolDiameter must be positive and finite, got ${options.toolDiameter}`)
  }
  if (!Number.isFinite(options.maxEngagement) || options.maxEngagement < 0 || options.maxEngagement > Math.PI) {
    throw new RangeError(`engagementLimitedPath: maxEngagement must be in [0, π], got ${options.maxEngagement}`)
  }
  if (typeof options.engagementAt !== 'function') {
    throw new RangeError('engagementLimitedPath: engagementAt must be a function')
  }
  const s = sideSign(options.side)
  const u = normalizeDirection(from.directionX, from.directionY, 'from')
  const v = normalizeDirection(to.directionX, to.directionY, 'to')
  if (!Number.isFinite(from.x) || !Number.isFinite(from.y) || !Number.isFinite(to.x) || !Number.isFinite(to.y)) {
    throw new RangeError('engagementLimitedPath: endpoint coordinates must be finite')
  }
  const deltaX = from.x - to.x
  const deltaY = from.y - to.y
  const chordSq = deltaX * deltaX + deltaY * deltaY
  if (chordSq <= GEOMETRY_EPS * GEOMETRY_EPS) return emptyResult()

  const step = options.toolDiameter * SAMPLE_STEP_FRACTION
  const leftU = leftOf(u.x, u.y)
  const leftV = leftOf(v.x, v.y)
  const gx = s * (leftU.x + leftV.x)
  const gy = s * (leftU.y + leftV.y)
  const gSq = gx * gx + gy * gy
  const fourMinusGSq = 4 - gSq

  if (fourMinusGSq <= PARALLEL_TANGENT_EPS) {
    // Near-parallel tangents: no loop shape exists — emit the straight chord
    // and let the verification decide (fail closed if the chord violates).
    const emitted: EngagementLimitedPathSample[] = []
    const chordLength = Math.sqrt(chordSq)
    const chordSteps = Math.max(1, Math.ceil(chordLength / step))
    let maxEngagement = 0
    let violation: { x: number; y: number; engagement: number } | null = null
    for (let index = 0; index <= chordSteps; index += 1) {
      const t = index / chordSteps
      const x = from.x - deltaX * t
      const y = from.y - deltaY * t
      const engagement = options.engagementAt(x, y, u.x, u.y)
      const sample: EngagementLimitedPathSample = { x, y, directionX: u.x, directionY: u.y, engagement }
      emitted.push(sample)
      if (!Number.isFinite(engagement)) {
        violation = { x, y, engagement }
        break
      }
      if (engagement > maxEngagement) maxEngagement = engagement
      if (engagement > options.maxEngagement) {
        violation = { x, y, engagement }
        break
      }
    }
    if (violation !== null) {
      return { status: 'engagement-exceeded', samples: emitted, maxEngagement, violation }
    }
    return { status: 'ok', samples: emitted, maxEngagement }
  }

  // Equal-radius tangent biarc. C1 = A + R·s·left(u), C2 = B − R·s·left(v),
  // and the junction condition |C1 − C2| = 2R is the quadratic
  // R²(|g|² − 4) + 2R(d·g) + |d|² = 0; its unique positive root:
  // R = (|b| + √Δ) / (2·(4 − |g|²)).
  const dotG = deltaX * gx + deltaY * gy
  const discriminant = 4 * (dotG * dotG + fourMinusGSq * chordSq)
  const radius = (2 * Math.abs(dotG) + Math.sqrt(discriminant)) / (2 * fourMinusGSq)
  const c1x = from.x + radius * s * leftU.x
  const c1y = from.y + radius * s * leftU.y
  const c2x = to.x - radius * s * leftV.x
  const c2y = to.y - radius * s * leftV.y
  const mx = (c1x + c2x) / 2
  const my = (c1y + c2y) / 2

  const arcOne: ArcEmission = {
    cx: c1x,
    cy: c1y,
    radius,
    fromAngle: Math.atan2(from.y - c1y, from.x - c1x),
    sweep: normalizeSweep(s * (Math.atan2(my - c1y, mx - c1x) - Math.atan2(from.y - c1y, from.x - c1x))),
    traversal: s,
  }
  const junctionAngle = Math.atan2(my - c2y, mx - c2x)
  const arcTwo: ArcEmission = {
    cx: c2x,
    cy: c2y,
    radius,
    fromAngle: junctionAngle,
    sweep: normalizeSweep(-s * (Math.atan2(to.y - c2y, to.x - c2x) - junctionAngle)),
    traversal: -s,
  }

  const emitted: EngagementLimitedPathSample[] = []
  let maxEngagement = 0
  const arcOneEmitted = arcOne.sweep > GEOMETRY_EPS
  if (arcOneEmitted) {
    const result = emitAndVerifyArc(arcOne, step, false, options, emitted, maxEngagement)
    maxEngagement = result.maxEngagement
    if (result.violation !== null) {
      return { status: 'engagement-exceeded', samples: emitted, maxEngagement, violation: result.violation }
    }
  }
  if (arcTwo.sweep > GEOMETRY_EPS) {
    // Skip the first sample of arc two when arc one emitted it already: the
    // first sample of arc two is the junction point, which is arc one's last.
    const result = emitAndVerifyArc(arcTwo, step, arcOneEmitted, options, emitted, maxEngagement)
    maxEngagement = result.maxEngagement
    if (result.violation !== null) {
      return { status: 'engagement-exceeded', samples: emitted, maxEngagement, violation: result.violation }
    }
  }
  return { status: 'ok', samples: emitted, maxEngagement }
}

/**
 * Build the unwind excursion for one inside corner: leave the ring
 * `CORNER_LEAD_IN_TOOL_DIAMETERS` tool diameters before the vertex, arc
 * through the cleared interior, and rejoin the same distance past it, with
 * every sample verified at or below
 * `nominalEngagement + ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD`.
 *
 * The direction assertion (the issue's load-bearing fact): `side` must be
 * the inside of the corner's turn — the interior side, where inner-first
 * traversal has already cleared material. A mismatched side is rejected
 * before any geometry is built, so the sign cannot be flipped silently.
 */
export function cornerUnwindPath(request: CornerUnwindRequest): EngagementLimitedPathResult {
  if (!Number.isFinite(request.cornerX) || !Number.isFinite(request.cornerY)) {
    throw new RangeError(`cornerUnwindPath: corner coordinates must be finite, got (${request.cornerX}, ${request.cornerY})`)
  }
  if (!Number.isFinite(request.toolDiameter) || request.toolDiameter <= 0) {
    throw new RangeError(`cornerUnwindPath: toolDiameter must be positive and finite, got ${request.toolDiameter}`)
  }
  if (!Number.isFinite(request.nominalEngagement) || request.nominalEngagement < 0 || request.nominalEngagement > Math.PI) {
    throw new RangeError(`cornerUnwindPath: nominalEngagement must be in [0, π], got ${request.nominalEngagement}`)
  }
  if (typeof request.engagementAt !== 'function') {
    throw new RangeError('cornerUnwindPath: engagementAt must be a function')
  }
  const u = normalizeDirection(request.approachX, request.approachY, 'approach')
  const v = normalizeDirection(request.departureX, request.departureY, 'departure')
  const cross = u.x * v.y - u.y * v.x
  const dot = u.x * v.x + u.y * v.y
  const turn = Math.atan2(cross, dot)
  if (Math.abs(turn) <= TURN_ZERO_EPS) {
    throw new RangeError(
      `cornerUnwindPath: the corner must actually turn (approach (${u.x.toFixed(6)}, ${u.y.toFixed(6)}), departure (${v.x.toFixed(6)}, ${v.y.toFixed(6)}))`,
    )
  }
  const s = sideSign(request.side)
  if (Math.sign(turn) !== s) {
    throw new RangeError(
      `cornerUnwindPath: side must be the inside of the corner's turn (the cleared interior under inner-first traversal); the turn is ${turn >= 0 ? 'left' : 'right'} but side is '${request.side}'`,
    )
  }

  const leadIn = CORNER_LEAD_IN_TOOL_DIAMETERS * request.toolDiameter
  const from: EngagementLimitedPathEndpoint = {
    x: request.cornerX - leadIn * u.x,
    y: request.cornerY - leadIn * u.y,
    directionX: u.x,
    directionY: u.y,
  }
  const to: EngagementLimitedPathEndpoint = {
    x: request.cornerX + leadIn * v.x,
    y: request.cornerY + leadIn * v.y,
    directionX: v.x,
    directionY: v.y,
  }
  return engagementLimitedPath(from, to, {
    toolDiameter: request.toolDiameter,
    maxEngagement: request.nominalEngagement + ENGAGEMENT_MARGIN_ABOVE_NOMINAL_RAD,
    side: request.side,
    engagementAt: request.engagementAt,
  })
}
