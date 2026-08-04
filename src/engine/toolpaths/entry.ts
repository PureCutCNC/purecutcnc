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

import type { CutDirection, EntryStrategy, Operation, Point } from '../../types/project'
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

export type EntryCutSide = 'internal' | 'external'

export interface EntryClearanceRegion {
  outer: Point[]
  islands: Point[][]
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

    const rampPlacement = findRampPlacement(target, policy.clearanceRegions, policy.toolDiameter)
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

  const rampPlacement = findRampPlacement(target, policy.clearanceRegions, policy.toolDiameter)
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
  const runLength = Math.hypot(placement.end.x - placement.start.x, placement.end.y - placement.start.y)
  const dropPerRun = runLength * Math.tan(toRadians(rampAngle))
  return dropPerRun > ENTRY_EPSILON ? Math.max(1, Math.ceil(Math.max(0, depth) / dropPerRun)) : Infinity
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
    moves.push({
      kind: 'lead_in',
      from: current,
      to: target,
      ...(policy.handoffFeedScale === undefined ? {} : { feedScale: policy.handoffFeedScale }),
    })
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
    moves.push({
      kind: 'lead_in',
      from: current,
      to: target,
      ...(policy.handoffFeedScale === undefined ? {} : { feedScale: policy.handoffFeedScale }),
    })
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
      cells.push(makeCell(x + half, y + half, half, region))
    }
  }

  const requiredClearance = radius + safety
  let visited = 0
  let endpointAttempts = 0
  while (cells.length > 0 && visited < MAX_CLEARANCE_SEARCH_CELLS) {
    const cell = cells.pop()
    if (!cell) break
    visited += 1
    if (cell.maxDistance < requiredClearance - ENTRY_EPSILON) continue

    if (cell.distance >= requiredClearance - ENTRY_EPSILON) {
      // Cells pop in descending clearance order, so the first candidates are
      // the roomiest ones. If none of them can reach the cut start, sweeping
      // the rest of the quadtree will not help — give up and let the caller
      // shrink the radius or fall back.
      if (endpointAttempts >= MAX_HELIX_ENDPOINT_CANDIDATES) return null
      endpointAttempts += 1
      const center = { x: cell.x, y: cell.y }
      const endpoint = findSafeHelixEndpoint(center, radius, target, region)
      if (endpoint) return { center, endpoint, radius, region }
    }

    if (cell.h <= precision / 2) continue
    const nextHalf = cell.h / 2
    cells.push(makeCell(cell.x - nextHalf, cell.y - nextHalf, nextHalf, region))
    cells.push(makeCell(cell.x + nextHalf, cell.y - nextHalf, nextHalf, region))
    cells.push(makeCell(cell.x - nextHalf, cell.y + nextHalf, nextHalf, region))
    cells.push(makeCell(cell.x + nextHalf, cell.y + nextHalf, nextHalf, region))
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
): RampPlacement | null {
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
      warnings.push({ code: 'entryStrategyFallback', params: { requested: 'helix', fallback: 'plunge' } })
      return { position: emitPlungeEntryFallback(moves, current, center, bottomZ, safeZ, retractZ), warnings }
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

  push(cell: ClearanceCell): void {
    this.cells.push(cell)
    let index = this.cells.length - 1
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2)
      if (this.cells[parent].maxDistance >= cell.maxDistance) break
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
        && this.cells[right].maxDistance > this.cells[left].maxDistance
        ? right
        : left
      if (this.cells[child].maxDistance <= last.maxDistance) break
      this.cells[index] = this.cells[child]
      index = child
    }
    this.cells[index] = last
    return first
  }
}

function makeCell(x: number, y: number, h: number, region: EntryClearanceRegion): ClearanceCell {
  const distance = pointToRegionDistance({ x, y }, region)
  return {
    x,
    y,
    h,
    distance,
    maxDistance: distance + h * Math.SQRT2,
  }
}

function pointToRegionDistance(point: Point, region: EntryClearanceRegion): number {
  const inside = pointInRegion(point, region)
  let distanceSquared = Infinity
  for (const contour of [region.outer, ...region.islands]) {
    forEachEdge(contour, (a, b) => {
      distanceSquared = Math.min(distanceSquared, pointSegmentDistanceSquared(point, a, b))
    })
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
