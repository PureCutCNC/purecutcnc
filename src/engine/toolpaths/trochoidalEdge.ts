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

import type { Point } from '../../types/project'
import { XY_EPSILON, samePointXY } from './geometry'

/**
 * The orbit accuracy contract is a **sagitta**, not a step count — see
 * `planning/TROCHOIDAL_EDGE_DESIGN.md` §"Why the allowance is 1% of D and not
 * less". An emitted chord may deviate from the true orbit by at most this
 * fraction of the cutter diameter, and the `0.01 x D` guide allowance is sized
 * to swallow that deviation on both cut sides.
 *
 * `0.0022` is the worst case the previous 36-step floor already produced, at
 * the crossover `R ~= 0.573 x D` where the `0.1 x D` chord cap took over.
 * Enforcing it directly therefore leaves the maximum exactly where it was; what
 * it removes is small orbits being cut several times finer than the contract
 * asks for, at full cost in points.
 */
const ORBIT_SAGITTA_FRACTION = 0.0022

/**
 * Totality floor for a degenerate orbit radius, not an accuracy floor: it keeps
 * a vanishing orbit a recognisable polygon instead of a triangle. It can only
 * bind below `R = 0.029 x D`, and `W >= 1.15 x D` already forces
 * `R >= 0.075 x D`, so no reachable operation sees it.
 */
const MIN_STEPS_PER_LOOP = 8

const GEOMETRY_EPSILON = XY_EPSILON

/**
 * The ceiling is a **memory** target, stated as one, with the point count
 * derived from it rather than the other way round (issue #662).
 *
 * One operation's emitted moves may claim at most **248 MB** of heap. At the
 * 248 bytes an emitted `ToolpathMove` was measured to retain, that is 1,000,000
 * moves. Four such operations in one project is roughly a gigabyte of emitted
 * moves, which is about as much as a desktop browser tab carries alongside the
 * CSG, the meshes and the render buffers.
 *
 * The 248 B/move is measured, not assumed: retaining the real
 * `ToolpathResult.moves` array under `--expose-gc`, after a warm-up run so
 * one-time caches are not charged to it, a 400 x 300 mm trochoidal outside
 * route gives 252.4 B/move at 115,227 moves and 247.9 B/move at 576,123, and
 * the slope between the two is 246.8. Consecutive moves do **not** share point
 * objects — 1,082 of 576,122 — so every move retains two distinct `{x, y, z}`.
 * That is why the figure is higher than the 178 B/move quoted in #659, and why
 * the 500,000 this replaces was already worth about 124 MB rather than 89 MB.
 *
 * **This is not the point at which the app stays usable, and must not be read
 * as one.** #664 measures the UI unusable at about 249,663 moves, already below
 * the 500,000 this replaces. Clamping the ceiling to a renderability figure
 * would refuse the large, deep, legitimate cuts #662 exists to stop refusing;
 * renderability is a lower, separate limit and #664 owns raising it.
 *
 * Fatal, deliberately: a partial trochoidal path is unsafe — see
 * `planning/TROCHOIDAL_EDGE_DESIGN.md` § Budgets.
 */
export const DEFAULT_TROCHOIDAL_POINT_BUDGET = 1_000_000

/**
 * Degeneracy, not size (issue #662). An orbit that advances less than 1% of the
 * cutter diameter per loop is not a fine cut, it is the same arc traced over and
 * over, and the parameter that produced it is defective rather than ambitious.
 *
 * `trochoidalAdvance` is the only one of the three shape parameters that can do
 * this: `W >= 1.15 x D` is refused before generation, which floors the orbit
 * radius at `0.075 x D`, and a small radius *lowers* the step count rather than
 * raising it (`MIN_STEPS_PER_LOOP` holds the bottom). The advance passes its own
 * validation at any value in `(0, 1]` and can still make a bounded guide cost
 * unbounded points.
 *
 * This is the check the global ceiling can never be: `0.005 x D` on a 50 mm
 * guide costs about 40,000 points — comfortably inside any ceiling — while
 * re-cutting the same material 1,667 times.
 *
 * The bound is strict on purpose: `0.01` itself is the smallest advance the CAM
 * panel offers (`min={1}` percent, clamped by `Math.max(0.01, …)`), so exactly
 * `0.01 x D` is an ordinary setting a user can select and must generate. Only
 * something below it is defective.
 */
const MIN_ADVANCE_FRACTION = 0.01

export type TrochoidalContourError = 'invalid-guide' | 'move-budget' | 'degenerate-advance'

export interface TrochoidalContourOptions {
  orbitRadius: number
  advance: number
  /** The cutter diameter sets both orbit bounds: chords ≤ 0.1 × diameter, sagitta ≤ 0.0022 × diameter. */
  toolDiameter: number
  angularDirection: 1 | -1
  closed?: boolean
  maxPoints?: number
}

export interface TrochoidalContourResult {
  points: Point[]
  entryCenter: Point | null
  loopCount: number
  actualAdvance: number
  error?: TrochoidalContourError
}

interface ArcLengthPath {
  points: Point[]
  cumulative: number[]
  length: number
  closed: boolean
}

const samePoint = samePointXY

function normalizeContour(contour: Point[], closed: boolean): Point[] {
  const points: Point[] = []
  for (const point of contour) {
    if (points.length === 0 || !samePoint(points.at(-1)!, point)) {
      points.push({ x: point.x, y: point.y })
    }
  }
  if (closed && points.length > 1 && samePoint(points[0], points.at(-1)!)) {
    points.pop()
  }
  return points
}

function buildArcLengthPath(contour: Point[], closed: boolean): ArcLengthPath | null {
  const points = normalizeContour(contour, closed)
  if (points.length < (closed ? 3 : 2)) return null

  const cumulative = [0]
  let length = 0
  const segmentCount = closed ? points.length : points.length - 1
  for (let index = 0; index < segmentCount; index += 1) {
    const from = points[index]
    const to = points[(index + 1) % points.length]
    const segmentLength = Math.hypot(to.x - from.x, to.y - from.y)
    if (segmentLength <= GEOMETRY_EPSILON) return null
    length += segmentLength
    cumulative.push(length)
  }

  return length > GEOMETRY_EPSILON ? { points, cumulative, length, closed } : null
}

function wrappedDistance(distance: number, length: number): number {
  const wrapped = distance % length
  return wrapped < 0 ? wrapped + length : wrapped
}

function samplePosition(path: ArcLengthPath, distance: number): Point {
  const target = path.closed
    ? wrappedDistance(distance, path.length)
    : Math.max(0, Math.min(path.length, distance))
  if (!path.closed && target >= path.length) return { ...path.points.at(-1)! }

  let low = 0
  let high = path.points.length - 1
  while (low < high) {
    const middle = Math.floor((low + high + 1) / 2)
    if (path.cumulative[middle] <= target) low = middle
    else high = middle - 1
  }

  const from = path.points[low]
  const to = path.points[(low + 1) % path.points.length]
  const segmentStart = path.cumulative[low]
  const segmentLength = path.cumulative[low + 1] - segmentStart
  const t = (target - segmentStart) / segmentLength
  return {
    x: from.x + (to.x - from.x) * t,
    y: from.y + (to.y - from.y) * t,
  }
}

function sampleFrame(path: ArcLengthPath, distance: number, lookaround: number): { tangent: Point; normal: Point } | null {
  const before = samplePosition(path, distance - lookaround)
  const after = samplePosition(path, distance + lookaround)
  const dx = after.x - before.x
  const dy = after.y - before.y
  const magnitude = Math.hypot(dx, dy)
  if (!(magnitude > GEOMETRY_EPSILON)) return null

  const tangent = { x: dx / magnitude, y: dy / magnitude }
  return { tangent, normal: { x: -tangent.y, y: tangent.x } }
}

/**
 * Steps per orbit, from the two bounds the design contracts for: no chord
 * longer than `0.1 x D`, and no chord deviating from the true circle by more
 * than `ORBIT_SAGITTA_FRACTION x D`. A chord subtending `2θ` on radius `R`
 * has sagitta `R(1 - cos θ)`, so the tolerated half-angle is
 * `acos(1 - tol / R)` and a full turn needs `π / acos(1 - tol / R)` of them.
 *
 * The two cross at `R ~= 0.568 x D`, where both ask for the same ~36 steps:
 * the chord cap governs above it, the sagitta bound below.
 * Neither ever asks for more steps than the 36-step floor this replaced, so the
 * change is a strict reduction in emitted points at unchanged worst-case
 * accuracy. Deliberately not exported: a test that pins the step count would
 * re-freeze the proxy this bound exists to remove.
 */
function orbitStepsPerLoop(orbitRadius: number, toolDiameter: number): number {
  const maxChord = Math.max(toolDiameter * 0.1, GEOMETRY_EPSILON)
  const chordSteps = Math.ceil(2 * Math.PI * orbitRadius / maxChord)
  const tolerance = toolDiameter * ORBIT_SAGITTA_FRACTION
  const sagittaSteps = tolerance < orbitRadius
    ? Math.ceil(Math.PI / Math.acos(1 - tolerance / orbitRadius))
    : MIN_STEPS_PER_LOOP
  return Math.max(MIN_STEPS_PER_LOOP, chordSteps, sagittaSteps)
}

function orbitPoint(center: Point, tangent: Point, normal: Point, radius: number, phase: number): Point {
  return {
    x: center.x + radius * (Math.cos(phase) * tangent.x + Math.sin(phase) * normal.x),
    y: center.y + radius * (Math.cos(phase) * tangent.y + Math.sin(phase) * normal.y),
  }
}

/**
 * Generates a bounded overlapping-orbit path around an already-safe guide.
 * Safety validation and entry synthesis stay with the edge-route integration:
 * clipping this output would break the orbit and can create an unsafe re-entry.
 */
export function buildTrochoidalContour(
  contour: Point[],
  options: TrochoidalContourOptions,
): TrochoidalContourResult {
  const closed = options.closed ?? true
  const path = buildArcLengthPath(contour, closed)
  if (!path || !(options.orbitRadius > 0) || !(options.advance > 0) || !(options.toolDiameter > 0)) {
    return { points: [], entryCenter: null, loopCount: 0, actualAdvance: 0, error: 'invalid-guide' }
  }

  const loopCount = Math.max(1, Math.ceil(path.length / options.advance))
  const actualAdvance = path.length / loopCount
  // The *requested* advance is what is defective or not, so that is what is
  // measured. Deriving the test from the orbit count instead — `loopCount >
  // path.length / (D x MIN_ADVANCE_FRACTION)` — compared a ceil'd integer with
  // the real quotient it was rounded up from, so at exactly `0.01 x D` the two
  // sides were the same quantity and `ceil(m) > m` refused every guide whose
  // length was not a whole number of advances. That is the smallest advance the
  // panel offers, refusing ordinary parts: a 60 x 40 mm outside route at
  // `0.01 x D` generates 94,743 moves and that form emitted none.
  //
  // A fragment shorter than one advance still has exactly one orbit and cannot
  // be degenerate however small the advance is, so the single-loop case is
  // exempt rather than measured — otherwise a sub-millimetre tab fragment would
  // refuse on a perfectly ordinary operation.
  if (loopCount > 1 && options.advance < options.toolDiameter * MIN_ADVANCE_FRACTION) {
    return { points: [], entryCenter: null, loopCount, actualAdvance, error: 'degenerate-advance' }
  }

  const stepsPerLoop = orbitStepsPerLoop(options.orbitRadius, options.toolDiameter)
  const movingSteps = loopCount * stepsPerLoop
  const maxPoints = Math.min(DEFAULT_TROCHOIDAL_POINT_BUDGET, options.maxPoints ?? DEFAULT_TROCHOIDAL_POINT_BUDGET)
  const stationarySteps = stepsPerLoop * (closed ? 1 : 2)
  if (movingSteps + stationarySteps + 1 > maxPoints) {
    return { points: [], entryCenter: null, loopCount, actualAdvance, error: 'move-budget' }
  }

  const frameLookaround = Math.min(
    path.length / 100,
    Math.max(actualAdvance / stepsPerLoop, options.toolDiameter * 0.01),
  )
  const entryCenter = samplePosition(path, 0)
  const entryFrame = sampleFrame(path, 0, frameLookaround)
  if (!entryFrame) {
    return { points: [], entryCenter: null, loopCount, actualAdvance, error: 'invalid-guide' }
  }

  const points: Point[] = [orbitPoint(entryCenter, entryFrame.tangent, entryFrame.normal, options.orbitRadius, 0)]
  for (let step = 1; step <= stepsPerLoop; step += 1) {
    const phase = options.angularDirection * 2 * Math.PI * step / stepsPerLoop
    points.push(orbitPoint(entryCenter, entryFrame.tangent, entryFrame.normal, options.orbitRadius, phase))
  }

  for (let step = 1; step <= movingSteps; step += 1) {
    const distance = path.length * step / movingSteps
    const center = samplePosition(path, distance)
    const frame = sampleFrame(path, distance, frameLookaround)
    if (!frame) return { points: [], entryCenter: null, loopCount, actualAdvance, error: 'invalid-guide' }
    const phase = options.angularDirection * 2 * Math.PI * step / stepsPerLoop
    points.push(orbitPoint(center, frame.tangent, frame.normal, options.orbitRadius, phase))
  }

  if (!closed) {
    const exitCenter = samplePosition(path, path.length)
    const exitFrame = sampleFrame(path, path.length, frameLookaround)
    if (!exitFrame) return { points: [], entryCenter: null, loopCount, actualAdvance, error: 'invalid-guide' }
    for (let step = 1; step <= stepsPerLoop; step += 1) {
      const phase = options.angularDirection * 2 * Math.PI * step / stepsPerLoop
      points.push(orbitPoint(exitCenter, exitFrame.tangent, exitFrame.normal, options.orbitRadius, phase))
    }
  }

  if (closed) points[points.length - 1] = { ...points[0] }
  return { points, entryCenter, loopCount, actualAdvance }
}
