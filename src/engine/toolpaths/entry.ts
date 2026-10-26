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

import type { CutDirection, EntryStrategy, Operation, OperationKind, Point } from '../../types/project'
import { isTrochoidalCarve, isTrochoidalEdgeRoughing, isTrochoidalPocket } from '../../types/project'
import type { ToolpathMove, ToolpathPoint } from './types'
import type { ToolpathWarning } from './warningCodes'

export const DEFAULT_ENTRY_RAMP_ANGLE = 5
export const DEFAULT_ENTRY_HELIX_DIAMETER_PERCENT = 80

export const HELIX_SEGMENTS_PER_REVOLUTION = 48
const ENTRY_EPSILON = 1e-9
const MAX_CLEARANCE_SEARCH_CELLS = 20_000
export const MAX_ENTRY_DESCENT_MOVES = 20_000

// Entry moves stay this far inside the region boundary, as a fraction of tool
// diameter. Without it a ramp or helix runs right up to the wall and scores the
// surface the finish pass is meant to leave — a single contour at final depth
// cannot clean a sloped entry groove that crosses it.
const ENTRY_BOUNDARY_SAFETY_FRACTION = 0.1
// A ramp is a local zig-zag near the entry point, not a traverse of the whole
// pocket. Cap the run at this multiple of tool diameter.
const MAX_RAMP_RUN_DIAMETERS = 3
// A contour-constrained ramp needs at least this much connected cut travel to
// be a ramp rather than reciprocal rubbing (issue #1084). The ordinary broad
// domain cap is an upper bound and its floor (`MIN_RAMP_RUN`) is deliberately
// microscopic because a chord across the pocket can always be lengthened; on a
// real contour there may be nothing but a few tessellation chords next to the
// entry, and reversing on one of those is the 106/308-stroke defect. One tool
// diameter of contiguous travel is the smallest stroke worth using; below it
// the existing warned plunge fallback is the honest answer.
const MIN_CONTOUR_RAMP_RUN_DIAMETERS = 1
// Connecting a candidate helix centre to the cut start is by far the most
// expensive test here (segment-inside-region against every contour edge).
// Bound the centres and angles tried so a hopeless search fails fast instead of
// sweeping the entire quadtree once per radius attempt.
//
// This is not a micro-optimisation. A wall-finish contour *is* the region
// boundary, so the cheap tangent placement can never succeed and every entry
// falls through to the global search. Unbounded, one pocket finish pass spent
// 101.6 s here versus 0.10 s bounded — and produced byte-identical output, so
// the entire sweep was wasted. Do not raise these without re-measuring a
// finish pass on a contour-heavy pocket.
const MAX_HELIX_ENDPOINT_CANDIDATES = 12
const HELIX_ENDPOINT_ANGLE_SAMPLES = 24
const MAX_HELIX_RADIUS_ATTEMPTS = 4
const clearanceCircleCache = new WeakMap<
  EntryClearanceRegion,
  Map<number, EntryClearanceCircle | null>
>()

/**
 * The straight planar link an entry emits to reach the cut start when the
 * helix/ramp bottom does not land on it exactly. Marked at emission because a
 * trailing flat-revolution chord is structurally identical to a handoff — the
 * difference is only whether the emitter pushed one. Consumers (the pocket
 * S-link splice) must not mistake the two.
 */
const entryHandoffMoves = new WeakSet<object>()

export function isEntryHandoffMove(move: ToolpathMove): boolean {
  return entryHandoffMoves.has(move)
}

export type EntryCutSide = 'internal' | 'external'

export interface EntryClearanceRegion {
  outer: Point[]
  islands: Point[][]
}

/**
 * The real cut polyline a requested ramp is allowed to follow (issue #1084).
 *
 * An edge route's outside entry used to be placed anywhere in the broad
 * collision-free domain, which on a part standing in uncut stock includes the
 * stock beside the profile. The ramp now has to run along the connected travel
 * of the path the operation is about to cut, so its swept envelope is the kerf
 * the level cut already removes. It follows that polyline through its
 * tessellation vertices rather than treating each chord as a separate stroke.
 *
 * The entry vertex is the path point matched to the synthesis target:
 * - an OPEN fragment may use only the connected travel forward of it, because
 *   the reverse side is not part of the cut;
 * - a CLOSED fragment may run either way around the loop, since both sides are
 *   cut. A run long enough to reach the entry again is a full loop and needs no
 *   final retrace.
 *
 * The polyline is only a candidate: `findRampPlacement` still enforces the
 * existing minimum length, maximum run, move budget and region/tab safety, and
 * a run that fails any of them leaves the constrained ramp unavailable.
 */
export interface EntryRampPath {
  points: Point[]
  closed: boolean
}

export interface EntryPolicy {
  strategy: Exclude<EntryStrategy, 'plunge'>
  rampAngle: number
  helixDiameterPercent: number
  toolDiameter: number
  cutFeed: number
  plungeFeed: number
  cutDirection: CutDirection
  cutSide: EntryCutSide
  clearanceRegions: EntryClearanceRegion[]
  /**
   * Constrain a requested ramp to this actual cut polyline. Absent preserves
   * the legacy clearance-domain placement; `null` is an explicit "unavailable"
   * and forces the existing warned fallback rather than returning to the broad
   * domain chord.
   */
  rampPath?: EntryRampPath | null
  startZ?: number
  handoffFeedScale?: number
  onWarning?: (warning: ToolpathWarning) => void
}

export interface EntrySynthesisResult {
  end: ToolpathPoint
  usedStrategy: EntryStrategy
  warnings: ToolpathWarning[]
}

export interface EntryClearanceCircle {
  center: Point
  radius: number
  region: EntryClearanceRegion
}

interface ClearanceCell {
  x: number
  y: number
  h: number
  distance: number
  maxDistance: number
  /** Set only when the queue serves a target-seeded search (helix placement). */
  distanceToTarget?: number
}

interface HelixPlacement {
  center: Point
  endpoint: Point
  radius: number
  region: EntryClearanceRegion
}

interface RampPlacement {
  start: Point
  end: Point
  region: EntryClearanceRegion
  /**
   * The real cut polyline from the entry vertex to `end`, in order. Present
   * only for a contour-constrained placement (issue #1084); absent keeps the
   * legacy straight reciprocation between `start` and `end`.
   */
  contour?: Point[]
}

/** Either flavour of trochoidal motion: rough edge routing, engraving, or pocket clearing. */
export function isTrochoidalOperation(operation: Operation): boolean {
  return isTrochoidalEdgeRoughing(operation) || isTrochoidalCarve(operation) || isTrochoidalPocket(operation)
}

/**
 * Operations that let the user choose how the cutter enters the material.
 *
 * Lives here, next to the policy it gates, because three separate surfaces ask
 * the question — the CAM panel's rows, the operation booklet printed at the
 * machine, and the generators — and a copy per surface is how a panel ends up
 * offering a setting the generator ignores. Edge routes joined the list in #708
 * when `edge.ts` stopped carrying its own copy of pocket's motion layer.
 */
export function supportsEntryStrategy(operation: Operation): boolean {
  return operation.kind === 'pocket'
    || operation.kind === 'surface_clean'
    || operation.kind === 'rough_surface'
    || isEdgeRouteKind(operation.kind)
    || isTrochoidalOperation(operation)
}

function isEdgeRouteKind(kind: OperationKind): boolean {
  return kind === 'edge_route_inside' || kind === 'edge_route_outside'
}

/**
 * The entry strategy actually in force. Trochoidal motion has no ramp, so a
 * stale `'ramp'` on the operation reads back as a helix rather than as a mode
 * the generator does not implement.
 */
export function resolvedEntryStrategy(operation: Operation): EntryStrategy {
  if (isTrochoidalOperation(operation)) {
    return operation.entryStrategy === 'plunge' ? 'plunge' : 'helix'
  }
  return operation.entryStrategy ?? 'plunge'
}

export function createEntryPolicy(
  operation: Operation,
  toolDiameter: number,
  clearanceRegions: EntryClearanceRegion[],
  onWarning?: (warning: ToolpathWarning) => void,
  cutSide: EntryCutSide = 'internal',
): EntryPolicy | undefined {
  const strategy = operation.entryStrategy ?? 'plunge'
  if (strategy === 'plunge') return undefined

  return {
    strategy,
    rampAngle: clamp(operation.entryRampAngle ?? DEFAULT_ENTRY_RAMP_ANGLE, 0.1, 45),
    helixDiameterPercent: clamp(
      operation.entryHelixDiameterPercent ?? DEFAULT_ENTRY_HELIX_DIAMETER_PERCENT,
      1,
      100,
    ),
    toolDiameter,
    cutFeed: operation.feed,
    plungeFeed: operation.plungeFeed,
    cutDirection: operation.cutDirection ?? 'conventional',
    cutSide,
    clearanceRegions,
    onWarning,
  }
}

export function withEntryHandoffFeedScale(
  policy: EntryPolicy | undefined,
  handoffFeedScale: number | null,
): EntryPolicy | undefined {
  return policy && handoffFeedScale !== null ? { ...policy, handoffFeedScale } : policy
}

export function withEntryStartZ(
  policy: EntryPolicy | undefined,
  startZ: number,
): EntryPolicy | undefined {
  return policy ? { ...policy, startZ } : undefined
}

/**
 * Constrain a requested ramp to the operation's real cut polyline (issue #1084).
 *
 * `null` is meaningful: the caller knows there is no usable cut contour to
 * use, and the entry must fall back with the existing warning instead of
 * silently returning to the clearance domain's broad chord.
 */
export function withEntryRampPath(
  policy: EntryPolicy | undefined,
  rampPath: EntryRampPath | null,
): EntryPolicy | undefined {
  return policy ? { ...policy, rampPath } : undefined
}

export function pitchFromRampAngle(pathDiameter: number, rampAngleDegrees: number): number {
  if (!(pathDiameter > 0) || !(rampAngleDegrees > 0)) return 0
  return Math.PI * pathDiameter * Math.tan(toRadians(rampAngleDegrees))
}

export function plungeLimitedFeedScale(
  cutFeed: number,
  plungeFeed: number,
  rampAngleDegrees: number,
): number {
  if (!(cutFeed > 0) || !(plungeFeed > 0)) return 1
  const verticalRatio = Math.sin(toRadians(rampAngleDegrees))
  if (!(verticalRatio > 0)) return 1
  return Math.min(1, plungeFeed / (cutFeed * verticalRatio))
}

export function helixAngularDirection(cutDirection: CutDirection, cutSide: EntryCutSide): 1 | -1 {
  // Positive project-space rotation becomes clockwise after the Y-down to
  // machine-space Y-up transform. A climb cut is therefore negative for an
  // internal helix and positive for an external helix.
  if (cutSide === 'internal') {
    return cutDirection === 'climb' ? -1 : 1
  }
  return cutDirection === 'climb' ? 1 : -1
}

export function findLargestClearanceCircle(
  regions: EntryClearanceRegion[],
  precision = 1e-3,
): EntryClearanceCircle | null {
  let best: EntryClearanceCircle | null = null
  for (const region of regions) {
    const candidate = findRegionClearanceCircle(region, precision)
    if (candidate && (!best || candidate.radius > best.radius)) {
      best = candidate
    }
  }
  return best
}

export function synthesizeEntry(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  target: ToolpathPoint,
  safeZ: number,
  policy: EntryPolicy,
): EntrySynthesisResult {
  const warnings: ToolpathWarning[] = []
  const startZ = Math.max(target.z, Math.min(safeZ, policy.startZ ?? safeZ))
  const warn = (warning: ToolpathWarning) => {
    if (!warnings.some((entry) => warningKey(entry) === warningKey(warning))) {
      warnings.push(warning)
      policy.onWarning?.(warning)
    }
  }

  if (policy.strategy === 'helix') {
    const requestedDiameter = policy.toolDiameter * policy.helixDiameterPercent / 100
    const requestedRadius = requestedDiameter / 2
    const placement = findHelixPlacement(target, policy, requestedRadius)
    if (placement && helixDescentMoveCount(startZ - target.z, placement.radius, policy.rampAngle)
      <= MAX_ENTRY_DESCENT_MOVES) {
      const actualDiameter = placement.radius * 2
      if (actualDiameter < requestedDiameter - numericTolerance(requestedDiameter)) {
        warn({
          code: 'entryHelixDiameterClamped',
          params: {
            requestedDiameter: formatWarningNumber(requestedDiameter),
            actualDiameter: formatWarningNumber(actualDiameter),
          },
        })
      }
      return {
        end: emitHelix(moves, from, target, safeZ, startZ, policy, placement),
        usedStrategy: 'helix',
        warnings,
      }
    }

    const rampPlacement = findRampPlacement(
      target,
      policy.clearanceRegions,
      policy.toolDiameter,
      policy.rampPath,
    )
    if (rampPlacement && rampDescentMoveCount(startZ - target.z, rampPlacement, policy.rampAngle)
      <= MAX_ENTRY_DESCENT_MOVES) {
      warn({ code: 'entryStrategyFallback', params: { requested: 'helix', fallback: 'ramp' } })
      return {
        end: emitRamp(moves, from, target, safeZ, startZ, policy, rampPlacement),
        usedStrategy: 'ramp',
        warnings,
      }
    }

    warn({ code: 'entryStrategyFallback', params: { requested: 'helix', fallback: 'plunge' } })
    return {
      end: emitPlunge(moves, from, target, safeZ, startZ),
      usedStrategy: 'plunge',
      warnings,
    }
  }

  const rampPlacement = findRampPlacement(
    target,
    policy.clearanceRegions,
    policy.toolDiameter,
    policy.rampPath,
  )
  if (rampPlacement && rampDescentMoveCount(startZ - target.z, rampPlacement, policy.rampAngle)
    <= MAX_ENTRY_DESCENT_MOVES) {
    return {
      end: emitRamp(moves, from, target, safeZ, startZ, policy, rampPlacement),
      usedStrategy: 'ramp',
      warnings,
    }
  }

  warn({ code: 'entryStrategyFallback', params: { requested: 'ramp', fallback: 'plunge' } })
  return {
    end: emitPlunge(moves, from, target, safeZ, startZ),
    usedStrategy: 'plunge',
    warnings,
  }
}

function helixDescentMoveCount(depth: number, radius: number, rampAngle: number): number {
  const pitch = pitchFromRampAngle(radius * 2, rampAngle)
  const revolutions = pitch > ENTRY_EPSILON ? Math.max(0, depth) / pitch : Infinity
  return Math.max(1, Math.ceil(revolutions * HELIX_SEGMENTS_PER_REVOLUTION))
}

function rampDescentMoveCount(depth: number, placement: RampPlacement, rampAngle: number): number {
  const rise = Math.tan(toRadians(rampAngle))
  const contour = placement.contour
  if (!contour || contour.length < 2) {
    const runLength = Math.hypot(
      placement.end.x - placement.start.x,
      placement.end.y - placement.start.y,
    )
    const dropPerRun = runLength * rise
    if (!(dropPerRun > ENTRY_EPSILON)) return Infinity
    return Math.max(1, Math.ceil(Math.max(0, depth) / dropPerRun))
  }

  // A contour run is measured by its ACTUAL arclength, not the chord between
  // its endpoints. On a full closed loop the endpoints coincide, so the chord
  // is zero and every stroke looks infinitely deep; on a near-full circle the
  // chord is much shorter than the travel. The emitter descends by accumulated
  // arclength, so the budget has to use the same measure.
  const runLength = contourLength(contour)
  const dropPerRun = runLength * rise
  if (!(dropPerRun > ENTRY_EPSILON)) return Infinity
  const strokes = Math.max(1, Math.ceil(Math.max(0, depth) / dropPerRun))
  const fullStrokes = strokes - 1
  const segments = contour.length - 1
  // Every full stroke crosses every vertex, so it emits one move per segment.
  let count = fullStrokes * segments
  if (count > MAX_ENTRY_DESCENT_MOVES) return count

  // Account for the final partial stroke's actual vertex crossings rather than
  // charging a whole stroke for it. A full final stroke is handled by the same
  // arithmetic: its travel equals the run length and it crosses every vertex.
  const remaining = Math.max(0, depth - fullStrokes * dropPerRun)
  const finalDistance = clamp(remaining / rise, 0, runLength)
  const forward = fullStrokes % 2 === 0
  count += contourTravelMoves(contour, finalDistance, !forward)
  if (count > MAX_ENTRY_DESCENT_MOVES) return count

  // At final depth the emitter follows the contour back to the entry vertex.
  // That handoff is usually a single move on the legacy straight ramp, but on a
  // tessellated contour it can be as many moves as the whole run. Count it, or
  // a run whose descent just fits the ceiling can still emit a program twice
  // the size. A full closed loop already ends at the entry, so it needs none.
  const finalTravel = forward ? finalDistance : runLength - finalDistance
  const closedLoop = sameXY(contour[0], contour[contour.length - 1])
  if (!(closedLoop && finalTravel >= runLength - ENTRY_EPSILON)) {
    count += contourHandoffMoves(contour, finalTravel)
  }
  return count
}

/** Planar arclength of a polyline. */
function contourLength(contour: Point[]): number {
  let length = 0
  for (let index = 1; index < contour.length; index += 1) {
    length += Math.hypot(
      contour[index].x - contour[index - 1].x,
      contour[index].y - contour[index - 1].y,
    )
  }
  return length
}

/**
 * Moves `emitContourRamp` emits to travel `distance` from one end of the
 * contour: one per crossed vertex, plus one when the travel stops inside a
 * segment. Mirrors the emitter's boundary stepping without emitting anything,
 * so a dense tessellation is costed before it is allocated.
 */
function contourTravelMoves(contour: Point[], distance: number, fromEnd: boolean): number {
  if (!(distance > ENTRY_EPSILON)) return 0
  let travelled = 0
  let moves = 0
  for (let step = 1; step < contour.length; step += 1) {
    const previous = contour[fromEnd ? contour.length - step : step - 1]
    const next = contour[fromEnd ? contour.length - 1 - step : step]
    const segment = Math.hypot(next.x - previous.x, next.y - previous.y)
    if (!(segment > ENTRY_EPSILON)) continue
    if (travelled + segment < distance - ENTRY_EPSILON) {
      travelled += segment
      moves += 1
      continue
    }
    return moves + 1
  }
  return moves
}

/**
 * Moves `emitContourRamp` needs to retrace from `travel` back to the entry
 * vertex at final depth. Boundaries are cumulative from the start, so this is
 * direction-independent; the terminal boundary at zero is the last move.
 */
function contourHandoffMoves(contour: Point[], travel: number): number {
  if (!(travel > ENTRY_EPSILON)) return 0
  let cumulative = 0
  let moves = 1
  for (let index = 1; index < contour.length; index += 1) {
    const segment = Math.hypot(
      contour[index].x - contour[index - 1].x,
      contour[index].y - contour[index - 1].y,
    )
    cumulative += segment
    if (!(segment > ENTRY_EPSILON)) continue
    if (!(cumulative < travel - ENTRY_EPSILON)) break
    moves += 1
  }
  return moves
}

function emitHelix(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  target: ToolpathPoint,
  safeZ: number,
  startZ: number,
  policy: EntryPolicy,
  placement: HelixPlacement,
): ToolpathPoint {
  const direction = helixAngularDirection(policy.cutDirection, policy.cutSide)
  const depth = Math.max(0, startZ - target.z)
  const pitch = pitchFromRampAngle(placement.radius * 2, policy.rampAngle)
  const revolutions = pitch > ENTRY_EPSILON ? depth / pitch : 0
  const descentSegments = helixDescentMoveCount(depth, placement.radius, policy.rampAngle)
  const endpointAngle = Math.atan2(
    placement.endpoint.y - placement.center.y,
    placement.endpoint.x - placement.center.x,
  )
  const startAngle = endpointAngle - direction * revolutions * Math.PI * 2
  const startPoint = {
    x: placement.center.x + Math.cos(startAngle) * placement.radius,
    y: placement.center.y + Math.sin(startAngle) * placement.radius,
  }
  let current = rapidToEntryStart(moves, from, { ...startPoint, z: startZ }, safeZ)

  for (let index = 1; index <= descentSegments; index += 1) {
    const ratio = index / descentSegments
    const angle = startAngle + direction * revolutions * Math.PI * 2 * ratio
    const next: ToolpathPoint = {
      x: placement.center.x + Math.cos(angle) * placement.radius,
      y: placement.center.y + Math.sin(angle) * placement.radius,
      z: startZ + (target.z - startZ) * ratio,
    }
    moves.push({
      kind: 'lead_in',
      from: current,
      to: next,
      feedScale: plungeLimitedMoveFeedScale(policy.cutFeed, policy.plungeFeed, current, next),
    })
    current = next
  }

  // Flatten the shallow spiral floor with one non-descending revolution.
  for (let index = 1; index <= HELIX_SEGMENTS_PER_REVOLUTION; index += 1) {
    const angle = endpointAngle + direction * Math.PI * 2 * index / HELIX_SEGMENTS_PER_REVOLUTION
    const next: ToolpathPoint = {
      x: placement.center.x + Math.cos(angle) * placement.radius,
      y: placement.center.y + Math.sin(angle) * placement.radius,
      z: target.z,
    }
    moves.push({ kind: 'lead_in', from: current, to: next })
    current = next
  }

  if (!sameXY(current, target)) {
    const handoff: ToolpathMove = {
      kind: 'lead_in',
      from: current,
      to: target,
      ...(policy.handoffFeedScale === undefined ? {} : { feedScale: policy.handoffFeedScale }),
    }
    entryHandoffMoves.add(handoff)
    moves.push(handoff)
  }
  return target
}

function emitRamp(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  target: ToolpathPoint,
  safeZ: number,
  startZ: number,
  policy: EntryPolicy,
  placement: RampPlacement,
): ToolpathPoint {
  if (placement.contour && placement.contour.length >= 2) {
    return emitContourRamp(moves, from, target, safeZ, startZ, policy, placement.contour)
  }
  let current = rapidToEntryStart(moves, from, { ...placement.start, z: startZ }, safeZ)
  let descendingTo = placement.end
  const fullRun = Math.hypot(placement.end.x - placement.start.x, placement.end.y - placement.start.y)
  const dropPerRun = fullRun * Math.tan(toRadians(policy.rampAngle))

  while (current.z > target.z + ENTRY_EPSILON) {
    const remainingDrop = current.z - target.z
    const ratio = dropPerRun > ENTRY_EPSILON ? Math.min(1, remainingDrop / dropPerRun) : 1
    const next: ToolpathPoint = {
      x: current.x + (descendingTo.x - current.x) * ratio,
      y: current.y + (descendingTo.y - current.y) * ratio,
      z: Math.max(target.z, current.z - dropPerRun * ratio),
    }
    moves.push({
      kind: 'lead_in',
      from: current,
      to: next,
      feedScale: plungeLimitedMoveFeedScale(policy.cutFeed, policy.plungeFeed, current, next),
    })
    current = next
    if (ratio < 1) break
    descendingTo = sameXY(current, placement.end) ? placement.start : placement.end
  }

  if (!sameXY(current, target)) {
    const handoff: ToolpathMove = {
      kind: 'lead_in',
      from: current,
      to: target,
      ...(policy.handoffFeedScale === undefined ? {} : { feedScale: policy.handoffFeedScale }),
    }
    entryHandoffMoves.add(handoff)
    moves.push(handoff)
  }
  return target
}

/**
 * Ramp along a real cut contour (issue #1084).
 *
 * The stroke is the connected path the operation is about to cut, so crossing a
 * tessellation vertex is a normal move rather than a reason to reverse: reversing
 * per chord is what produced the 106/308 descending strokes on
 * `ramp-on-path-test.camj`. The cutter descends by accumulated XY arclength at
 * the requested angle, reverses only at the useful stroke endpoints, and at
 * final depth follows the same contour back to the entry vertex instead of
 * taking an off-path chord. Every emitted move therefore has its centreline on
 * the level cut's own centreline, which keeps the ramp inside the level kerf.
 */
function emitContourRamp(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  target: ToolpathPoint,
  safeZ: number,
  startZ: number,
  policy: EntryPolicy,
  contour: Point[],
): ToolpathPoint {
  const cumulative = [0]
  for (let index = 1; index < contour.length; index += 1) {
    cumulative.push(cumulative[index - 1]
      + Math.hypot(contour[index].x - contour[index - 1].x, contour[index].y - contour[index - 1].y))
  }
  const runLength = cumulative[cumulative.length - 1] ?? 0
  if (!(runLength > ENTRY_EPSILON)) return target
  // A run that comes back to the entry vertex is a full loop. It ends where it
  // began, so the final-depth handoff below must not retrace it: that would cut
  // the same loop twice at full depth.
  const closedLoop = contour.length >= 3 && sameXY(contour[0], contour[contour.length - 1])
  const rise = Math.tan(toRadians(policy.rampAngle))
  const pointAt = (travel: number): Point => {
    const distance = clamp(travel, 0, runLength)
    if (closedLoop && distance >= runLength - ENTRY_EPSILON) {
      return { x: contour[0].x, y: contour[0].y }
    }
    let index = 1
    while (index < cumulative.length - 1 && cumulative[index] < distance - ENTRY_EPSILON) index += 1
    const start = Math.max(0, cumulative[index - 1])
    const end = cumulative[index] ?? start
    const ratio = end > start + ENTRY_EPSILON ? (distance - start) / (end - start) : 0
    return {
      x: contour[index - 1].x + (contour[index].x - contour[index - 1].x) * ratio,
      y: contour[index - 1].y + (contour[index].y - contour[index - 1].y) * ratio,
    }
  }
  const nextBoundary = (travel: number, direction: 1 | -1): number => {
    if (direction > 0) {
      for (const value of cumulative) {
        if (value > travel + ENTRY_EPSILON) return value
      }
      return runLength
    }
    for (let index = cumulative.length - 1; index >= 0; index -= 1) {
      if (cumulative[index] < travel - ENTRY_EPSILON) return cumulative[index]
    }
    return 0
  }

  let current = rapidToEntryStart(moves, from, { ...contour[0], z: startZ }, safeZ)
  let travel = 0
  let direction: 1 | -1 = 1
  while (current.z > target.z + ENTRY_EPSILON) {
    const strokeEnd = direction > 0 ? runLength : 0
    const strokeDistance = Math.abs(strokeEnd - travel)
    if (!(strokeDistance > ENTRY_EPSILON)) {
      direction = direction > 0 ? -1 : 1
      continue
    }
    const remainingDrop = current.z - target.z
    const budget = Math.min(strokeDistance, remainingDrop / rise)
    let advanced = 0
    while (advanced < budget - ENTRY_EPSILON) {
      const boundary = nextBoundary(travel, direction)
      const toBoundary = Math.abs(boundary - travel)
      const step = Math.min(toBoundary, budget - advanced)
      if (!(step > ENTRY_EPSILON)) break
      const nextTravel = travel + direction * step
      const nextPoint = pointAt(nextTravel)
      const nextZ = Math.max(target.z, current.z - step * rise)
      const next: ToolpathPoint = { x: nextPoint.x, y: nextPoint.y, z: nextZ }
      moves.push({
        kind: 'lead_in',
        from: current,
        to: next,
        feedScale: plungeLimitedMoveFeedScale(policy.cutFeed, policy.plungeFeed, current, next),
      })
      current = next
      travel = nextTravel
      advanced += step
      if (current.z <= target.z + ENTRY_EPSILON) break
    }
    if (current.z <= target.z + ENTRY_EPSILON) break
    direction = direction > 0 ? -1 : 1
  }

  // Final-depth handoff on the contour itself: retrace to the entry vertex, so
  // no straight chord leaves the kerf the cut removes. A full loop is already
  // at that vertex; normalising its travel to zero suppresses the duplicate.
  if (closedLoop && travel >= runLength - ENTRY_EPSILON) travel = 0
  while (travel > ENTRY_EPSILON) {
    const boundary = nextBoundary(travel, -1)
    const nextPoint = pointAt(boundary)
    const next: ToolpathPoint = { x: nextPoint.x, y: nextPoint.y, z: target.z }
    const move: ToolpathMove = {
      kind: 'lead_in',
      from: current,
      to: next,
      ...(policy.handoffFeedScale === undefined ? {} : { feedScale: policy.handoffFeedScale }),
    }
    if (boundary <= ENTRY_EPSILON) entryHandoffMoves.add(move)
    moves.push(move)
    current = next
    travel = boundary
  }
  return target
}

function plungeLimitedMoveFeedScale(
  cutFeed: number,
  plungeFeed: number,
  from: ToolpathPoint,
  to: ToolpathPoint,
): number {
  if (!(cutFeed > 0) || !(plungeFeed > 0)) return 1
  const dx = to.x - from.x
  const dy = to.y - from.y
  const dz = to.z - from.z
  const distance = Math.hypot(dx, dy, dz)
  if (!(distance > ENTRY_EPSILON) || Math.abs(dz) <= ENTRY_EPSILON) return 1
  return Math.min(1, plungeFeed / (cutFeed * Math.abs(dz) / distance))
}

function emitPlunge(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  target: ToolpathPoint,
  safeZ: number,
  startZ: number,
): ToolpathPoint {
  const current = rapidToEntryStart(moves, from, { x: target.x, y: target.y, z: startZ }, safeZ)
  moves.push({ kind: 'plunge', from: current, to: target })
  return target
}

function rapidToEntryStart(
  moves: ToolpathMove[],
  from: ToolpathPoint | null,
  target: ToolpathPoint,
  safeZ: number,
): ToolpathPoint {
  let current = from
  if (current && Math.abs(current.z - safeZ) > ENTRY_EPSILON) {
    const retracted = { x: current.x, y: current.y, z: safeZ }
    moves.push({ kind: 'rapid', from: current, to: retracted })
    current = retracted
  }
  const safeTarget = { x: target.x, y: target.y, z: safeZ }
  if (!current) {
    moves.push({ kind: 'rapid', from: safeTarget, to: safeTarget })
  } else if (!samePoint(current, safeTarget)) {
    moves.push({ kind: 'rapid', from: current, to: safeTarget })
  }
  if (!samePoint(safeTarget, target)) {
    moves.push({ kind: 'plunge', from: safeTarget, to: target })
  }
  return target
}

function findHelixPlacement(
  target: ToolpathPoint,
  policy: EntryPolicy,
  requestedRadius: number,
): HelixPlacement | null {
  if (!(requestedRadius > ENTRY_EPSILON)) return null
  const targetPoint = { x: target.x, y: target.y }
  const candidateRegions = policy.clearanceRegions.filter((region) => pointInRegion(targetPoint, region))
  const regions = candidateRegions.length > 0 ? candidateRegions : policy.clearanceRegions
  const precision = Math.max(1e-4, policy.toolDiameter * 0.0025)
  const safety = entryBoundarySafety(policy.toolDiameter)
  const maximumCoreSafeRadius = policy.toolDiameter / 2
  const minimumUsefulRadius = Math.min(requestedRadius, policy.toolDiameter * 0.05)

  for (const region of regions) {
    const circle = findRegionClearanceCircle(region, precision)
    if (!circle) continue
    let radius = Math.min(requestedRadius, maximumCoreSafeRadius, Math.max(0, circle.radius - safety))

    for (
      let attempt = 0;
      attempt < MAX_HELIX_RADIUS_ATTEMPTS && radius >= Math.max(precision, minimumUsefulRadius);
      attempt += 1
    ) {
      const local = findTargetTouchingHelix(region, targetPoint, radius, safety)
      if (local) return local

      const reachable = findReachableHelixPlacement(region, targetPoint, radius, safety, precision)
      if (reachable) return reachable
      radius *= 0.5
    }
  }
  return null
}

function findReachableHelixPlacement(
  region: EntryClearanceRegion,
  target: Point,
  radius: number,
  safety: number,
  precision: number,
): HelixPlacement | null {
  const bounds = contourBounds(region.outer)
  if (!bounds) return null
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const cellSize = Math.min(width, height)
  if (!(cellSize > 0)) return null

  const cells = new ClearanceCellQueue()
  const half = cellSize / 2
  for (let x = bounds.minX; x < bounds.maxX; x += cellSize) {
    for (let y = bounds.minY; y < bounds.maxY; y += cellSize) {
      cells.push(makeCell(x + half, y + half, half, region, target))
    }
  }

  const requiredClearance = radius + safety
  // A coarse cell's centre can be legal while a much closer legal centre sits
  // inside it or in a neighbour. Refuse placements above this cell size so the
  // proximity-ordered queue must refine around the cut start first; otherwise
  // the first coarse cell over open floor wins and the entry lands mid-pocket.
  const acceptCellSize = Math.max(precision, radius / 2)
  let visited = 0
  let endpointAttempts = 0
  while (cells.length > 0 && visited < MAX_CLEARANCE_SEARCH_CELLS) {
    const cell = cells.pop()
    if (!cell) break
    visited += 1
    if (cell.maxDistance < requiredClearance - ENTRY_EPSILON) continue

    if (
      cell.distance >= requiredClearance - ENTRY_EPSILON
      && cell.h <= acceptCellSize + ENTRY_EPSILON
    ) {
      // Cells pop nearest-to-target first, so the first legal candidates are
      // the ones that keep the entry next to the cut start. If none of them
      // can reach the cut start, sweeping farther out cannot help — give up
      // and let the caller shrink the radius or fall back.
      if (endpointAttempts >= MAX_HELIX_ENDPOINT_CANDIDATES) return null
      endpointAttempts += 1
      const center = { x: cell.x, y: cell.y }
      const endpoint = findSafeHelixEndpoint(center, radius, target, region)
      if (endpoint) return { center, endpoint, radius, region }
    }

    if (cell.h <= precision / 2) continue
    const nextHalf = cell.h / 2
    cells.push(makeCell(cell.x - nextHalf, cell.y - nextHalf, nextHalf, region, target))
    cells.push(makeCell(cell.x + nextHalf, cell.y - nextHalf, nextHalf, region, target))
    cells.push(makeCell(cell.x - nextHalf, cell.y + nextHalf, nextHalf, region, target))
    cells.push(makeCell(cell.x + nextHalf, cell.y + nextHalf, nextHalf, region, target))
  }
  return null
}

function findTargetTouchingHelix(
  region: EntryClearanceRegion,
  target: Point,
  radius: number,
  safety: number,
): HelixPlacement | null {
  for (let index = 0; index < 72; index += 1) {
    const angle = Math.PI * 2 * index / 72
    const center = {
      x: target.x - Math.cos(angle) * radius,
      y: target.y - Math.sin(angle) * radius,
    }
    if (pointToRegionDistance(center, region) >= radius + safety - ENTRY_EPSILON) {
      return { center, endpoint: target, radius, region }
    }
  }
  return null
}

function findSafeHelixEndpoint(
  center: Point,
  radius: number,
  target: Point,
  region: EntryClearanceRegion,
): Point | null {
  const preferred = Math.atan2(target.y - center.y, target.x - center.x)
  for (let index = 0; index < HELIX_ENDPOINT_ANGLE_SAMPLES; index += 1) {
    const alternating = index === 0 ? 0 : Math.ceil(index / 2) * (index % 2 === 0 ? -1 : 1)
    const angle = preferred + alternating * Math.PI * 2 / HELIX_ENDPOINT_ANGLE_SAMPLES
    const endpoint = {
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    }
    if (segmentInsideRegion(endpoint, target, region)) return endpoint
  }
  return null
}

function findRampPlacement(
  target: ToolpathPoint,
  regions: EntryClearanceRegion[],
  toolDiameter: number,
  rampPath?: EntryRampPath | null,
): RampPlacement | null {
  // An explicit path constraint (including the explicit "unavailable" null)
  // replaces the broad-domain search. It never falls through to it: the whole
  // point of the constraint is that the collision-free domain is not proof the
  // stock there was removed (issue #1084).
  if (rampPath !== undefined) {
    return findConstrainedRampPlacement(target, regions, toolDiameter, rampPath)
  }

  const point = { x: target.x, y: target.y }
  const candidates = regions.filter((region) => pointInRegion(point, region))
  const searchRegions = candidates.length > 0 ? candidates : regions
  const safety = entryBoundarySafety(toolDiameter)
  const maxRun = toolDiameter * MAX_RAMP_RUN_DIAMETERS
  const minRun = Math.max(ENTRY_EPSILON, toolDiameter * 0.02)
  let best: RampPlacement | null = null
  let bestLength = 0
  let bestRoom = 0

  for (const region of searchRegions) {
    for (let index = 0; index < 72; index += 1) {
      const angle = Math.PI * index / 72
      const direction = { x: Math.cos(angle), y: Math.sin(angle) }
      const interval = lineIntervalInsideRegion(point, direction, region)
      if (!interval) continue
      const low = interval.min + safety
      const high = interval.max - safety
      const room = high - low
      if (!(room > minRun)) continue

      // Centre a bounded run on the entry point and slide it to stay inside the
      // region. Taking the whole chord instead would ramp wall to wall across
      // the pocket, which is a long air move and drags the entry across the
      // finished boundary at both ends.
      let start = Math.max(low, -maxRun / 2)
      const end = Math.min(high, start + maxRun)
      start = Math.max(low, end - maxRun)
      const length = end - start
      if (!(length > minRun)) continue
      if (length < bestLength || (length === bestLength && room <= bestRoom)) continue

      bestLength = length
      bestRoom = room
      best = {
        start: { x: point.x + direction.x * start, y: point.y + direction.y * start },
        end: { x: point.x + direction.x * end, y: point.y + direction.y * end },
        region,
      }
    }
  }
  return best
}

/**
 * Ramp placement constrained to a real adjacent cut contour (issue #1084).
 *
 * The run is anchored at the entry vertex, because that vertex is on the cut
 * path and the ramp's handoff has to be as well. It follows the connected
 * polyline up to the existing `MAX_RAMP_RUN_DIAMETERS` cap, crossing
 * tessellation vertices rather than treating each chord as a stroke. A CLOSED
 * fragment may run either actual direction; an OPEN one only forward, because
 * the reverse side is not part of that cut.
 *
 * Each candidate is truncated to the longest prefix that stays inside ONE
 * clearance region, which is what keeps a tab, clamp or region edge from being
 * bridged: no gap is ever crossed, the run simply stops before it. A blocked
 * segment is clipped at its first exit rather than dropped whole (issue #1109):
 * on a straight cut the 3D cap is usually a single interpolated segment, so
 * dropping it discarded the clear travel before a tab even when that travel was
 * several tool diameters. The clip keeps its existing boundary safety margin,
 * stops at the first exit (it never skips an island and re-enters), and backs
 * up across earlier vertices if the margin reaches into them, so a subdivided
 * straight run reaches the same safe point as the unsplit one. A run below the
 * meaningful-stroke floor is rejected so a contour too short to ramp falls back
 * with the existing warning instead of reciprocating on a few chords.
 */
function findConstrainedRampPlacement(
  target: ToolpathPoint,
  regions: EntryClearanceRegion[],
  toolDiameter: number,
  rampPath: EntryRampPath | null,
): RampPlacement | null {
  if (rampPath === null || regions.length === 0) return null
  const points = rampPath.closed ? trimClosedPath(rampPath.points) : rampPath.points
  if (points.length < 2) return null
  const entryIndex = points.findIndex((point) => sameXY(point, target))
  if (entryIndex < 0) return null

  const maxRun = toolDiameter * MAX_RAMP_RUN_DIAMETERS
  const minRun = Math.max(ENTRY_EPSILON, toolDiameter * MIN_CONTOUR_RAMP_RUN_DIAMETERS)
  const safety = entryBoundarySafety(toolDiameter)
  const directions: Array<1 | -1> = rampPath.closed ? [1, -1] : [1]
  let best: RampPlacement | null = null
  let bestLength = 0
  for (const direction of directions) {
    const run = contourRun(points, entryIndex, direction, rampPath.closed, maxRun)
    if (!run || run.length < 2) continue
    for (const region of regions) {
      const valid = trimContourRunToRegion(run, region, minRun, safety)
      if (!valid || !(valid.length > bestLength + ENTRY_EPSILON)) continue
      bestLength = valid.length
      const contour = [...valid.points]
      // Anchor on the requested vertex exactly. `sameXY` admits a nanometre of
      // slack, and the handoff has to land on the point the cut starts from.
      contour[0] = { x: target.x, y: target.y }
      best = {
        start: contour[0],
        end: contour[contour.length - 1],
        region,
        contour,
      }
    }
  }
  return best
}

/**
 * Connected travel from the entry vertex in one direction, capped at `maxRun`
 * and preserving every actual vertex it crosses. A closed path stops after one
 * full loop; the final point may be a linear interpolation on the last segment
 * so a partial stroke ends exactly at the cap rather than overshooting it.
 */
function contourRun(
  points: Point[],
  entryIndex: number,
  direction: 1 | -1,
  closed: boolean,
  maxRun: number,
): Point[] | null {
  const count = points.length
  const run: Point[] = [points[entryIndex]]
  let length = 0
  const steps = closed ? count : count - entryIndex - 1
  for (let step = 1; step <= steps; step += 1) {
    const raw = entryIndex + direction * step
    const index = closed ? ((raw % count) + count) % count : raw
    if (index < 0 || index >= count) break
    const previous = run[run.length - 1]
    const next = points[index]
    const segment = Math.hypot(next.x - previous.x, next.y - previous.y)
    if (!(segment > ENTRY_EPSILON)) continue
    if (length + segment >= maxRun - ENTRY_EPSILON) {
      const remaining = Math.max(0, maxRun - length)
      if (remaining > ENTRY_EPSILON) {
        const ratio = remaining / segment
        run.push({
          x: previous.x + (next.x - previous.x) * ratio,
          y: previous.y + (next.y - previous.y) * ratio,
        })
      }
      break
    }
    run.push(next)
    length += segment
  }
  return run.length >= 2 ? run : null
}

/**
 * The longest prefix of `run` whose every segment stays in `region`. This is
 * where a tab or obstacle cuts the stroke short; the caller then either uses the
 * prefix (if it is long enough to be useful) or falls back.
 *
 * A segment that leaves the region is clipped, not dropped (issue #1109). The
 * clip lands `safety` back from the FIRST exit along the run's arclength; it
 * may cut into geometry that was already accepted, so a long straight run and
 * its equivalent subdivision reach the same safe point instead of the
 * subdivided one stopping one chord short. Everything after the first exit is
 * ignored — an island can be crossed and left, but the ramp must not fly over
 * it and resume on the far side.
 */
function trimContourRunToRegion(
  run: Point[],
  region: EntryClearanceRegion,
  minRun: number,
  safety: number,
): { points: Point[]; length: number } | null {
  const points: Point[] = [run[0]]
  let length = 0
  for (let index = 1; index < run.length; index += 1) {
    const previous = points[points.length - 1]
    const next = run[index]
    if (segmentInsideRegion(previous, next, region)) {
      points.push(next)
      length += Math.hypot(next.x - previous.x, next.y - previous.y)
      continue
    }

    // The segment is blocked somewhere ahead. Its exit parameter is found from
    // the interval boundaries and a point strictly inside each interval, not by
    // testing the endpoint: region membership is not monotonic along a segment
    // (an island can be crossed, a concave wall can re-enter), so the first
    // outside interval is the only safe stopping point.
    const segmentLength = Math.hypot(next.x - previous.x, next.y - previous.y)
    if (!(segmentLength > ENTRY_EPSILON)) break
    const exit = firstRegionExitParameter(previous, next, region)
    if (exit === null) break
    const targetLength = length + exit * segmentLength - safety
    if (!(targetLength > ENTRY_EPSILON)) return null

    // Truncate to `targetLength` of arclength, interpolating inside the segment
    // that contains the cut. `points` ends at the blocked segment's start, so
    // the clip may land inside that segment as well as inside an earlier
    // accepted one; removing already-accepted vertices is deliberate, because
    // leaving one inside the margin would keep the cutter closer to the tab
    // than the margin allows.
    const extended = [...points, next]
    const clipped: Point[] = [extended[0]]
    let travelled = 0
    for (let pointIndex = 1; pointIndex < extended.length; pointIndex += 1) {
      const before = extended[pointIndex - 1]
      const after = extended[pointIndex]
      const segment = Math.hypot(after.x - before.x, after.y - before.y)
      if (travelled + segment <= targetLength + ENTRY_EPSILON) {
        clipped.push(after)
        travelled += segment
        if (travelled >= targetLength - ENTRY_EPSILON) break
        continue
      }
      const ratio = (targetLength - travelled) / segment
      if (ratio > ENTRY_EPSILON) {
        clipped.push({
          x: before.x + (after.x - before.x) * ratio,
          y: before.y + (after.y - before.y) * ratio,
        })
      }
      break
    }
    if (clipped.length < 2) return null

    // Revalidate the one segment the clip may have created. Every retained
    // whole segment was already accepted above; a clip that lands inside one is
    // a prefix of accepted geometry. If the new partial fails its own check the
    // run is refused rather than trusting a point near the boundary.
    const end = clipped[clipped.length - 1]
    const tail = clipped[clipped.length - 2]
    if (!segmentInsideRegion(tail, end, region)) return null
    const clippedLength = contourLength(clipped)
    if (!(clippedLength >= minRun - ENTRY_EPSILON)) return null
    return { points: clipped, length: clippedLength }
  }
  if (points.length < 2 || !(length >= minRun - ENTRY_EPSILON)) return null
  return { points, length }
}

/**
 * The parameter of the first point along `from`-`to` where continuous travel
 * stops being inside `region`. Returns 0 when the segment starts outside and 1
 * when only its endpoint leaves; `null` means every sampled interval is inside.
 *
 * Intersections are interval boundaries only. Each interval is classified by a
 * point strictly between its ends, which is what makes a tangency, a collinear
 * stretch along the boundary, or an island crossed and left behave correctly:
 * boundary contact is inside (the cut path itself rides the outside domain's
 * wall), and the first genuinely outside interval is the exit.
 */
function firstRegionExitParameter(
  from: Point,
  to: Point,
  region: EntryClearanceRegion,
): number | null {
  if (!pointInRegion(from, region)) return 0
  const parameters: number[] = [0, 1]
  for (const contour of [region.outer, ...region.islands]) {
    forEachEdge(contour, (a, b) => {
      const parameter = segmentIntersectionParameter(from, to, a, b)
      if (parameter !== null) parameters.push(parameter)
    })
  }
  const sorted = [...new Set(parameters.map((value) => Number(value.toFixed(12))))]
    .sort((left, right) => left - right)
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const start = sorted[index]
    const end = sorted[index + 1]
    if (!(end - start > ENTRY_EPSILON)) continue
    const middle = (start + end) / 2
    const sample = {
      x: from.x + (to.x - from.x) * middle,
      y: from.y + (to.y - from.y) * middle,
    }
    if (!pointInRegion(sample, region)) return start
  }
  return pointInRegion(to, region) ? null : 1
}

/** Drop the repeated closing vertex some callers leave on a closed polyline. */
function trimClosedPath(points: Point[]): Point[] {
  if (points.length >= 2 && sameXY(points[0], points[points.length - 1])) {
    return points.slice(0, -1)
  }
  return points
}

export function entryBoundarySafety(toolDiameter: number): number {
  return Math.max(1e-4, toolDiameter * ENTRY_BOUNDARY_SAFETY_FRACTION)
}

/**
 * Emit a center-locked helical bore path for endmill boring of circular holes.
 *
 * This is a narrow shared helper for drilling.ts — it does NOT run #412's
 * generic clearance search or relocate from the selected hole centre. The
 * caller supplies the desired (requested) helix radius; the helper clamps it
 * by the no-core cap (tool radius) and the swept-envelope safety constraint
 * (`pathRadius + toolDiameter / 2 + boundarySafety <= holeRadius`), then emits
 * the descending G1 helix plus a bottom-flattening revolution.
 *
 * When no safe positive path radius remains the helper falls back to a simple
 * centre plunge with a structured warning, matching the existing plunge/canned-
 * cycle behaviour for unsupported cases.
 */
export function emitCenterLockedCircularBore(
  moves: ToolpathMove[],
  current: ToolpathPoint | null,
  center: Point,
  requestedRadius: number,
  holeRadius: number,
  toolDiameter: number,
  bottomZ: number,
  safeZ: number,
  retractZ: number,
  rampAngle: number,
  cutDirection: CutDirection,
  cutFeed: number,
  plungeFeed: number,
  isFinishBore?: boolean,
): { position: ToolpathPoint; warnings: ToolpathWarning[] } {
  const warnings: ToolpathWarning[] = []
  const safety = entryBoundarySafety(toolDiameter)
  const toolRadius = toolDiameter / 2

  let helixRadius: number

  if (isFinishBore) {
    // Drilling finish-bore mode: the caller has already verified eligibility
    // (toolDiameter < holeDiameter <= 2 * toolDiameter).  The requested radius
    // is the intentional cutter-centre orbit (holeRadius - toolRadius), whose
    // swept envelope reaches the selected wall exactly.  Do NOT subtract
    // entry-boundary safety from this finish radius; do NOT apply the
    // no-core cap as an additional clamp.
    helixRadius = requestedRadius

    // Swept-envelope gate: the cutter outside edge must not exceed the hole
    // radius (within tolerance).  When helixRadius == holeRadius - toolRadius
    // this holds exactly, so the gate only catches a caller mistake.
    if (!(helixRadius > ENTRY_EPSILON) || helixRadius + toolRadius > holeRadius + ENTRY_EPSILON) {
      warnings.push({ code: 'drillHelicalBoreUnmachinable' })
      return { position: current ?? { x: center.x, y: center.y, z: safeZ }, warnings }
    }
  } else {
    const noCoreCap = toolRadius
    const maxSafePathRadius = Math.max(0, holeRadius - toolRadius - safety)
    helixRadius = Math.min(requestedRadius, maxSafePathRadius, noCoreCap)

    // Swept-envelope safety gate: the cutter must stay inside the selected
    // hole at every point. The path is centred on the hole, so the constraint
    // is constant per hole.
    if (!(helixRadius > ENTRY_EPSILON) || helixRadius + toolRadius + safety > holeRadius + ENTRY_EPSILON) {
      warnings.push({ code: 'entryStrategyFallback', params: { requested: 'helix', fallback: 'plunge' } })
      return { position: emitPlungeEntryFallback(moves, current, center, bottomZ, safeZ, retractZ), warnings }
    }
  }

  const depth = Math.max(0, retractZ - bottomZ)
  const pitch = pitchFromRampAngle(helixRadius * 2, rampAngle)
  const revolutions = pitch > ENTRY_EPSILON ? depth / pitch : 0
  const descentSegments = Math.max(1, Math.ceil(revolutions * HELIX_SEGMENTS_PER_REVOLUTION))

  if (descentSegments > MAX_ENTRY_DESCENT_MOVES) {
    if (isFinishBore) {
      warnings.push({ code: 'drillHelicalBoreUnmachinable' })
      return { position: current ?? { x: center.x, y: center.y, z: safeZ }, warnings }
    }
    warnings.push({ code: 'entryStrategyFallback', params: { requested: 'helix', fallback: 'plunge' } })
    return { position: emitPlungeEntryFallback(moves, current, center, bottomZ, safeZ, retractZ), warnings }
  }

  if (helixRadius < requestedRadius - Math.max(ENTRY_EPSILON, requestedRadius * ENTRY_EPSILON)) {
    warnings.push({
      code: 'entryHelixDiameterClamped',
      params: {
        requestedDiameter: formatWarningNumber(requestedRadius * 2),
        actualDiameter: formatWarningNumber(helixRadius * 2),
      },
    })
  }

  const direction = helixAngularDirection(cutDirection, 'internal')

  // Establish { hole centre, safeZ } before any descent. When this is the
  // first expanded operation current is null, so the postprocessor has no
  // known machine location. A zero-length rapid tells it to position XY and Z
  // at safeZ before the next rapid (which descends to retractZ). Without it
  // the postprocessor emits Z before XY and can lower Z at an unsafe location.
  const aboveSafe: ToolpathPoint = { x: center.x, y: center.y, z: safeZ }
  if (!current) {
    moves.push({ kind: 'rapid', from: aboveSafe, to: aboveSafe })
  } else if (current.x !== aboveSafe.x || current.y !== aboveSafe.y || current.z !== aboveSafe.z) {
    moves.push({ kind: 'rapid', from: current, to: aboveSafe })
  }

  // Rapid down to retract height at hole centre.
  const atRetract: ToolpathPoint = { x: center.x, y: center.y, z: retractZ }
  if (retractZ < safeZ) {
    moves.push({ kind: 'rapid', from: aboveSafe, to: atRetract })
  }

  // Rapid from centre to helix start at retract height.
  const startPoint: ToolpathPoint = {
    x: center.x + helixRadius,
    y: center.y,
    z: retractZ,
  }
  if (helixRadius > ENTRY_EPSILON) {
    moves.push({ kind: 'rapid', from: atRetract, to: startPoint })
  }

  let prev = startPoint

  // Helical descent.
  const feedScale = plungeLimitedFeedScale(cutFeed, plungeFeed, rampAngle)
  for (let index = 1; index <= descentSegments; index += 1) {
    const ratio = index / descentSegments
    const angle = direction * revolutions * Math.PI * 2 * ratio
    const next: ToolpathPoint = {
      x: center.x + Math.cos(angle) * helixRadius,
      y: center.y + Math.sin(angle) * helixRadius,
      z: retractZ + (bottomZ - retractZ) * ratio,
    }
    moves.push({
      kind: 'lead_in',
      from: prev,
      to: next,
      ...(feedScale < 1 ? { feedScale } : {}),
    })
    prev = next
  }

  // Bottom-flattening revolution.
  const finalAngle = direction * revolutions * Math.PI * 2
  for (let index = 1; index <= HELIX_SEGMENTS_PER_REVOLUTION; index += 1) {
    const angle = finalAngle + direction * Math.PI * 2 * index / HELIX_SEGMENTS_PER_REVOLUTION
    const next: ToolpathPoint = {
      x: center.x + Math.cos(angle) * helixRadius,
      y: center.y + Math.sin(angle) * helixRadius,
      z: bottomZ,
    }
    moves.push({ kind: 'lead_in', from: prev, to: next })
    prev = next
  }

  // Rapid retract to safeZ from final position (on the helix circle at bottomZ).
  const finalRetract: ToolpathPoint = { x: center.x, y: center.y, z: safeZ }
  moves.push({ kind: 'rapid', from: prev, to: finalRetract })

  return { position: finalRetract, warnings }
}

/** Simple centre plunge fallback used when the bore cannot fit a safe helix. */
function emitPlungeEntryFallback(
  moves: ToolpathMove[],
  current: ToolpathPoint | null,
  center: Point,
  bottomZ: number,
  safeZ: number,
  retractZ: number,
): ToolpathPoint {
  // Same safe-Z ordering as the main bore path (see comment there).
  const aboveSafe: ToolpathPoint = { x: center.x, y: center.y, z: safeZ }
  if (!current) {
    moves.push({ kind: 'rapid', from: aboveSafe, to: aboveSafe })
  } else if (current.x !== aboveSafe.x || current.y !== aboveSafe.y || current.z !== aboveSafe.z) {
    moves.push({ kind: 'rapid', from: current, to: aboveSafe })
  }
  const rapidStart: ToolpathPoint = { x: center.x, y: center.y, z: retractZ }
  if (retractZ < safeZ) {
    moves.push({ kind: 'rapid', from: aboveSafe, to: rapidStart })
  }
  const bottom: ToolpathPoint = { x: center.x, y: center.y, z: bottomZ }
  moves.push({ kind: 'plunge', from: rapidStart, to: bottom })
  const retract: ToolpathPoint = { x: center.x, y: center.y, z: safeZ }
  moves.push({ kind: 'rapid', from: bottom, to: retract })
  return retract
}

function lineIntervalInsideRegion(
  origin: Point,
  direction: Point,
  region: EntryClearanceRegion,
): { min: number; max: number } | null {
  const intersections: number[] = []
  for (const contour of [region.outer, ...region.islands]) {
    forEachEdge(contour, (a, b) => {
      const edge = { x: b.x - a.x, y: b.y - a.y }
      const denominator = cross(direction, edge)
      if (Math.abs(denominator) <= ENTRY_EPSILON) return
      const offset = { x: a.x - origin.x, y: a.y - origin.y }
      const alongLine = cross(offset, edge) / denominator
      const alongEdge = cross(offset, direction) / denominator
      if (alongEdge >= -ENTRY_EPSILON && alongEdge <= 1 + ENTRY_EPSILON) {
        intersections.push(alongLine)
      }
    })
  }

  const sorted = [...new Set(intersections.map((value) => Number(value.toFixed(12))))]
    .sort((left, right) => left - right)
  let best: { min: number; max: number } | null = null
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const min = sorted[index]
    const max = sorted[index + 1]
    if (min > ENTRY_EPSILON || max < -ENTRY_EPSILON) continue
    const middle = (min + max) / 2
    const sample = { x: origin.x + direction.x * middle, y: origin.y + direction.y * middle }
    if (!pointInRegion(sample, region)) continue
    if (!best || max - min > best.max - best.min) best = { min, max }
  }
  return best
}

function findRegionClearanceCircle(
  region: EntryClearanceRegion,
  precision: number,
): EntryClearanceCircle | null {
  const cached = clearanceCircleCache.get(region)?.get(precision)
  if (cached !== undefined) return cached

  const circle = computeRegionClearanceCircle(region, precision)
  const precisionCache = clearanceCircleCache.get(region) ?? new Map<number, EntryClearanceCircle | null>()
  precisionCache.set(precision, circle)
  clearanceCircleCache.set(region, precisionCache)
  return circle
}

function computeRegionClearanceCircle(
  region: EntryClearanceRegion,
  precision: number,
): EntryClearanceCircle | null {
  if (region.outer.length < 3) return null
  const bounds = contourBounds(region.outer)
  if (!bounds) return null
  const width = bounds.maxX - bounds.minX
  const height = bounds.maxY - bounds.minY
  const cellSize = Math.min(width, height)
  if (!(cellSize > 0)) return null

  const cells = new ClearanceCellQueue()
  const half = cellSize / 2
  for (let x = bounds.minX; x < bounds.maxX; x += cellSize) {
    for (let y = bounds.minY; y < bounds.maxY; y += cellSize) {
      cells.push(makeCell(x + half, y + half, half, region))
    }
  }

  const centroid = contourCentroid(region.outer)
  let best = makeCell(centroid.x, centroid.y, 0, region)
  const boundsCell = makeCell(
    (bounds.minX + bounds.maxX) / 2,
    (bounds.minY + bounds.maxY) / 2,
    0,
    region,
  )
  if (boundsCell.distance > best.distance) best = boundsCell

  let visited = 0
  while (cells.length > 0 && visited < MAX_CLEARANCE_SEARCH_CELLS) {
    const cell = cells.pop()
    if (!cell) break
    visited += 1
    if (cell.distance > best.distance) best = cell
    if (cell.maxDistance - best.distance <= precision || cell.h <= precision / 2) continue
    const nextHalf = cell.h / 2
    cells.push(makeCell(cell.x - nextHalf, cell.y - nextHalf, nextHalf, region))
    cells.push(makeCell(cell.x + nextHalf, cell.y - nextHalf, nextHalf, region))
    cells.push(makeCell(cell.x - nextHalf, cell.y + nextHalf, nextHalf, region))
    cells.push(makeCell(cell.x + nextHalf, cell.y + nextHalf, nextHalf, region))
  }

  return best.distance > ENTRY_EPSILON
    ? { center: { x: best.x, y: best.y }, radius: best.distance, region }
    : null
}

class ClearanceCellQueue {
  private readonly cells: ClearanceCell[] = []

  get length(): number {
    return this.cells.length
  }

  /**
   * True when `a` should be explored before `b`. A target-seeded search (any
   * cell carries a distanceToTarget) explores nearest-to-target first — the
   * closest legal helix centre wins, so the entry ends next to the cut start.
   * Cells whose whole extent lacks the required clearance are pruned by the
   * caller before their children exist, so proximity ordering cannot promote
   * an unsafe centre. The plain largest-clearance search keeps roomiest-first.
   * Lexicographic on exact keys: heaps need a strict weak order, and an
   * epsilon-banded mix of the two keys is not transitive.
   */
  private static precedes(a: ClearanceCell, b: ClearanceCell): boolean {
    if (a.distanceToTarget !== undefined && b.distanceToTarget !== undefined) {
      if (a.distanceToTarget !== b.distanceToTarget) {
        return a.distanceToTarget < b.distanceToTarget
      }
      return a.maxDistance > b.maxDistance
    }
    return a.maxDistance > b.maxDistance
  }

  push(cell: ClearanceCell): void {
    this.cells.push(cell)
    let index = this.cells.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (!ClearanceCellQueue.precedes(cell, this.cells[parent])) break
      this.cells[index] = this.cells[parent]
      index = parent
    }
    this.cells[index] = cell
  }

  pop(): ClearanceCell | undefined {
    const first = this.cells[0]
    const last = this.cells.pop()
    if (!first || this.cells.length === 0 || !last) return first

    let index = 0
    while (true) {
      const left = index * 2 + 1
      const right = left + 1
      if (left >= this.cells.length) break
      const child = right < this.cells.length
        && ClearanceCellQueue.precedes(this.cells[right], this.cells[left])
        ? right
        : left
      if (!ClearanceCellQueue.precedes(this.cells[child], last)) break
      this.cells[index] = this.cells[child]
      index = child
    }
    this.cells[index] = last
    return first
  }
}

function makeCell(x: number, y: number, h: number, region: EntryClearanceRegion, target?: Point): ClearanceCell {
  const distance = pointToRegionDistance({ x, y }, region)
  return {
    x,
    y,
    h,
    distance,
    maxDistance: distance + h * Math.SQRT2,
    ...(target === undefined ? {} : { distanceToTarget: Math.hypot(x - target.x, y - target.y) }),
  }
}

const contourBoundsCache = new WeakMap<Point[], { minX: number, minY: number, maxX: number, maxY: number } | null>()

function cachedContourBounds(contour: Point[]): { minX: number, minY: number, maxX: number, maxY: number } | null {
  const hit = contourBoundsCache.get(contour)
  if (hit !== undefined) return hit
  const value = contourBounds(contour)
  contourBoundsCache.set(contour, value)
  return value
}

function bboxDistanceSquared(point: Point, b: { minX: number, minY: number, maxX: number, maxY: number }): number {
  const dx = point.x < b.minX ? b.minX - point.x : (point.x > b.maxX ? point.x - b.maxX : 0)
  const dy = point.y < b.minY ? b.minY - point.y : (point.y > b.maxY ? point.y - b.maxY : 0)
  return dx * dx + dy * dy
}

/**
 * One indexed pass per contour yields all three facts the callers need: the
 * minimum squared edge distance, the crossing parity, and whether the point
 * lies on the boundary (exactly `minDistanceSquared <= 1e-16`, the same test
 * `pointOnContour` makes edge by edge). Returns null when the contour's
 * bounding box is farther than `pruneAboveSquared`, in which case the point is
 * outside it and cannot lower the running minimum.
 */
function scanContour(
  point: Point,
  contour: Point[],
  pruneAboveSquared: number,
): { minDistanceSquared: number, crossings: boolean } | null {
  const bounds = cachedContourBounds(contour)
  if (bounds) {
    const near = bboxDistanceSquared(point, bounds)
    if (near > pruneAboveSquared) return null
  }
  let minDistanceSquared = Infinity
  let crossings = false
  const count = contour.length
  for (let index = 0; index < count; index += 1) {
    const a = contour[index]
    const b = contour[index + 1 === count ? 0 : index + 1]
    const dx = b.x - a.x
    const dy = b.y - a.y
    let candidate: number
    if (dx === 0 && dy === 0) {
      const px = point.x - a.x
      const py = point.y - a.y
      candidate = px * px + py * py
    } else {
      const ratio = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1)
      const px = point.x - (a.x + dx * ratio)
      const py = point.y - (a.y + dy * ratio)
      candidate = px * px + py * py
    }
    if (candidate < minDistanceSquared) minDistanceSquared = candidate
    if ((a.y > point.y) !== (b.y > point.y) && point.x < dx * (point.y - a.y) / dy + a.x) {
      crossings = !crossings
    }
  }
  return { minDistanceSquared, crossings }
}

function pointToRegionDistance(point: Point, region: EntryClearanceRegion): number {
  const outer = scanContour(point, region.outer, Infinity)
  let distanceSquared = outer ? outer.minDistanceSquared : Infinity
  const outerOn = outer !== null && outer.minDistanceSquared <= 1e-16
  let inside = outer !== null && (outerOn || outer.crossings)
  if (inside) {
    for (const island of region.islands) {
      const scan = scanContour(point, island, distanceSquared)
      if (!scan) continue
      if (scan.minDistanceSquared < distanceSquared) distanceSquared = scan.minDistanceSquared
      const on = scan.minDistanceSquared <= 1e-16
      if (!on && scan.crossings) { inside = false; break }
    }
  }
  if (!inside) {
    for (const island of region.islands) {
      const scan = scanContour(point, island, distanceSquared)
      if (!scan) continue
      if (scan.minDistanceSquared < distanceSquared) distanceSquared = scan.minDistanceSquared
    }
  }
  const distance = Number.isFinite(distanceSquared) ? Math.sqrt(distanceSquared) : 0
  return inside ? distance : -distance
}

function segmentInsideRegion(from: Point, to: Point, region: EntryClearanceRegion): boolean {
  const intersections = [0, 1]
  for (const contour of [region.outer, ...region.islands]) {
    forEachEdge(contour, (a, b) => {
      const t = segmentIntersectionParameter(from, to, a, b)
      if (t !== null) intersections.push(t)
    })
  }
  const sorted = [...new Set(intersections.map((value) => Number(value.toFixed(12))))]
    .sort((left, right) => left - right)
  for (let index = 0; index + 1 < sorted.length; index += 1) {
    const middle = (sorted[index] + sorted[index + 1]) / 2
    const sample = {
      x: from.x + (to.x - from.x) * middle,
      y: from.y + (to.y - from.y) * middle,
    }
    if (!pointInRegion(sample, region)) return false
  }
  return true
}

function pointInRegion(point: Point, region: EntryClearanceRegion): boolean {
  if (!pointInContour(point, region.outer)) return false
  return !region.islands.some((island) => pointInContour(point, island) && !pointOnContour(point, island))
}

function pointInContour(point: Point, contour: Point[]): boolean {
  if (pointOnContour(point, contour)) return true
  let inside = false
  forEachEdge(contour, (a, b) => {
    const crosses = (a.y > point.y) !== (b.y > point.y)
      && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x
    if (crosses) inside = !inside
  })
  return inside
}

function pointOnContour(point: Point, contour: Point[]): boolean {
  let onBoundary = false
  forEachEdge(contour, (a, b) => {
    if (pointSegmentDistanceSquared(point, a, b) <= 1e-16) onBoundary = true
  })
  return onBoundary
}

function pointSegmentDistanceSquared(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  if (dx === 0 && dy === 0) return squaredDistance(point, a)
  const ratio = clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy), 0, 1)
  return squaredDistance(point, { x: a.x + dx * ratio, y: a.y + dy * ratio })
}

function segmentIntersectionParameter(a: Point, b: Point, c: Point, d: Point): number | null {
  const ab = { x: b.x - a.x, y: b.y - a.y }
  const cd = { x: d.x - c.x, y: d.y - c.y }
  const denominator = cross(ab, cd)
  if (Math.abs(denominator) <= ENTRY_EPSILON) return null
  const offset = { x: c.x - a.x, y: c.y - a.y }
  const t = cross(offset, cd) / denominator
  const u = cross(offset, ab) / denominator
  if (t <= ENTRY_EPSILON || t >= 1 - ENTRY_EPSILON || u < -ENTRY_EPSILON || u > 1 + ENTRY_EPSILON) {
    return null
  }
  return t
}

function contourCentroid(contour: Point[]): Point {
  let twiceArea = 0
  let x = 0
  let y = 0
  forEachEdge(contour, (a, b) => {
    const areaTerm = a.x * b.y - b.x * a.y
    twiceArea += areaTerm
    x += (a.x + b.x) * areaTerm
    y += (a.y + b.y) * areaTerm
  })
  if (Math.abs(twiceArea) <= ENTRY_EPSILON) return contour[0] ?? { x: 0, y: 0 }
  return { x: x / (3 * twiceArea), y: y / (3 * twiceArea) }
}

function contourBounds(contour: Point[]): { minX: number; minY: number; maxX: number; maxY: number } | null {
  if (contour.length === 0) return null
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of contour) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }
  return { minX, minY, maxX, maxY }
}

function forEachEdge(contour: Point[], callback: (a: Point, b: Point) => void): void {
  for (let index = 0; index < contour.length; index += 1) {
    callback(contour[index], contour[(index + 1) % contour.length])
  }
}

function sameXY(left: Point, right: Point): boolean {
  return Math.abs(left.x - right.x) <= ENTRY_EPSILON && Math.abs(left.y - right.y) <= ENTRY_EPSILON
}

function samePoint(left: ToolpathPoint, right: ToolpathPoint): boolean {
  return sameXY(left, right) && Math.abs(left.z - right.z) <= ENTRY_EPSILON
}

function squaredDistance(left: Point, right: Point): number {
  const dx = left.x - right.x
  const dy = left.y - right.y
  return dx * dx + dy * dy
}

function cross(left: Point, right: Point): number {
  return left.x * right.y - left.y * right.x
}

function toRadians(degrees: number): number {
  return degrees * Math.PI / 180
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function numericTolerance(value: number): number {
  return Math.max(1e-9, Math.abs(value) * 1e-9)
}

function formatWarningNumber(value: number): number {
  return Number(value.toFixed(4))
}

function warningKey(warning: ToolpathWarning): string {
  return `${warning.code}:${JSON.stringify(warning.params ?? {})}`
}
