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

import { defaultRetractOffset } from '../../types/project'
import type { DrillType, Operation, Point, Project, SketchFeature, SketchProfile } from '../../types/project'
import type { ToolpathWarning } from './warningCodes'
import type { DrillCycle, NormalizedTool, ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import {
  checkMaxCutDepthWarning,
  greedyNearestNeighbor,
  getOperationSafeZ,
  normalizeToolForProject,
  resolveFeatureZSpan,
} from './geometry'
import { buildRegionMask, splitFeatureTargets } from './regions'
import {
  DEFAULT_ENTRY_RAMP_ANGLE,
  emitCenterLockedCircularBore,
} from './entry'
import { appendAll } from './appendAll'

const CHIP_BREAK_CLEARANCE = 0.5    // tiny retract between pecks in chip-breaking mode (project units)

interface DrillTarget {
  feature: SketchFeature
  center: Point
  span: ReturnType<typeof resolveFeatureZSpan>
  originalIndex: number
}

function precomputeDrillTargets(
  targetFeatures: SketchFeature[],
  project: Project,
  regionMask: ReturnType<typeof buildRegionMask> | null,
): { targets: DrillTarget[]; warnings: ToolpathWarning[] } {
  const targets: DrillTarget[] = []
  const warnings: ToolpathWarning[] = []

  for (let i = 0; i < targetFeatures.length; i += 1) {
    const feature = targetFeatures[i]
    const center = getCircleCenter(feature.sketch.profile)
    if (!center) {
      warnings.push({ code: 'drillNoCenter', params: { name: feature.name } })
      continue
    }
    if (regionMask && !regionMask.containsPoint(center)) {
      continue
    }

    const span = resolveFeatureZSpan(project, feature)
    const topZ = span.top
    const bottomZ = span.bottom

    if (bottomZ >= topZ) {
      warnings.push({ code: 'drillBottomAboveTop', params: { name: feature.name } })
      continue
    }

    targets.push({ feature, center, span, originalIndex: i })
  }

  return { targets, warnings }
}

export function sortTargetsByNearestNeighbor(targets: DrillTarget[], startPosition: ToolpathPoint | null): DrillTarget[] {
  return greedyNearestNeighbor(targets, {
    positionOf: (target) => target.center,
    start: startPosition ?? { x: 0, y: 0 },
    tieBreakOf: (target) => target.originalIndex,
  })
}

function updateBounds(bounds: ToolpathBounds | null, point: ToolpathPoint): ToolpathBounds {
  if (!bounds) {
    return {
      minX: point.x, minY: point.y, minZ: point.z,
      maxX: point.x, maxY: point.y, maxZ: point.z,
    }
  }
  return {
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    minZ: Math.min(bounds.minZ, point.z),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
    maxZ: Math.max(bounds.maxZ, point.z),
  }
}

function computeBounds(moves: ToolpathMove[]): ToolpathBounds | null {
  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }
  return bounds
}

function getCircleCenter(profile: SketchProfile): Point | null {
  if (profile.segments.length === 1 && profile.segments[0].type === 'circle') {
    return profile.segments[0].center
  }

  if (profile.segments.length === 4 && profile.segments.every((s) => s.type === 'arc')) {
    if (!isValidFourArcCircle(profile)) return null
    const first = profile.segments[0]
    if (first.type === 'arc') {
      return first.center
    }
  }

  return null
}

/**
 * Validate that a four-arc SketchProfile forms a proper complete circle:
 * closed, contiguous, consistently directed, and each arc sweeps exactly one
 * quarter turn. Returns false for partial, repeated, overlapping, open, or
 * otherwise malformed four-arc inputs so the caller never treats them as a
 * circular hole.
 */
function isValidFourArcCircle(profile: SketchProfile): boolean {
  if (profile.segments.length !== 4) return false
  if (!profile.closed) return false
  const arcs = profile.segments
  if (!arcs.every((s) => s.type === 'arc')) return false

  const first = arcs[0]
  if (first.type !== 'arc') return false
  const cx = first.center.x
  const cy = first.center.y
  const r = Math.hypot(first.to.x - cx, first.to.y - cy)
  const direction = first.clockwise
  const tolerance = 1e-6

  // All four arcs must share the same centre, radius, and direction.
  for (const seg of arcs) {
    if (seg.type !== 'arc') return false
    if (Math.abs(seg.center.x - cx) > tolerance || Math.abs(seg.center.y - cy) > tolerance) return false
    const segR = Math.hypot(seg.to.x - seg.center.x, seg.to.y - seg.center.y)
    if (Math.abs(segR - r) > tolerance) return false
    if (seg.clockwise !== direction) return false
  }

  // profile.start must lie on the circle.
  const startDist = Math.hypot(profile.start.x - cx, profile.start.y - cy)
  if (Math.abs(startDist - r) > tolerance) return false

  // Path must be closed: the last arc's to equals profile.start.
  const last = arcs[3]
  if (last.type !== 'arc') return false
  if (Math.abs(last.to.x - profile.start.x) > tolerance || Math.abs(last.to.y - profile.start.y) > tolerance) {
    return false
  }

  // Each arc must sweep exactly one quarter turn (≈ 90°). In Y-down project
  // space atan2 increases clockwise, so clockwise arcs sweep +π/2 and
  // counterclockwise arcs sweep −π/2.
  const sweepTolerance = 1e-4
  let prevPoint = profile.start
  for (const seg of arcs) {
    if (seg.type !== 'arc') return false
    const startAngle = Math.atan2(prevPoint.y - cy, prevPoint.x - cx)
    const endAngle = Math.atan2(seg.to.y - cy, seg.to.x - cx)
    let sweep = endAngle - startAngle
    while (sweep > Math.PI) sweep -= 2 * Math.PI
    while (sweep < -Math.PI) sweep += 2 * Math.PI
    const expectedSweep = seg.clockwise ? Math.PI / 2 : -Math.PI / 2
    if (Math.abs(sweep - expectedSweep) > sweepTolerance) return false
    prevPoint = seg.to
  }

  return true
}

function getCircleRadius(profile: SketchProfile): number | null {
  if (profile.segments.length === 1 && profile.segments[0].type === 'circle') {
    const seg = profile.segments[0]
    const dx = seg.to.x - seg.center.x
    const dy = seg.to.y - seg.center.y
    return Math.sqrt(dx * dx + dy * dy)
  }
  if (profile.segments.length === 4 && profile.segments.every((s) => s.type === 'arc')) {
    if (!isValidFourArcCircle(profile)) return null
    const first = profile.segments[0]
    if (first.type === 'arc') {
      const dx = first.to.x - first.center.x
      const dy = first.to.y - first.center.y
      return Math.sqrt(dx * dx + dy * dy)
    }
  }
  return null
}

function emitSimplePlunge(
  moves: ToolpathMove[],
  current: ToolpathPoint | null,
  center: Point,
  bottomZ: number,
  safeZ: number,
  retractZ: number,
): ToolpathPoint {
  // Same safe-Z ordering as emitDrillCycle (see comment there).
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

/**
 * Depth below the surface a V-bit tip must reach for a countersink that opens
 * to `mouthDiameter` (issue #489).
 *
 * A cone of included angle θ opens to radius `d · tan(θ/2)` at depth `d`, so
 * reaching the requested mouth radius takes `d = (D/2) / tan(θ/2)`. The V-bit is
 * treated as an ideal point — this release does not model a tip flat, matching
 * the rest of the tool model.
 *
 * Returns `null` when the angle cannot produce a usable cone.
 */
export function countersinkTipDepth(mouthDiameter: number, includedAngleDegrees: number): number | null {
  // The angle domain is checked here rather than left to the arithmetic: at
  // exactly 180° `Math.tan` returns 1.6e16 instead of Infinity, so the division
  // would yield a plausible-looking sub-nanometre depth for a cutter that is
  // flat. Callers that render the depth (the CAM panel, the booklet) rely on
  // this returning null for a tool that cannot countersink at all.
  if (!(includedAngleDegrees > 0 && includedAngleDegrees < 180)) return null
  const slope = Math.tan((includedAngleDegrees * Math.PI) / 360)
  if (!(slope > 1e-9) || !Number.isFinite(slope)) return null
  const depth = mouthDiameter / (2 * slope)
  return Number.isFinite(depth) && depth > 0 ? depth : null
}

/**
 * Validate the countersink-specific tool and setting constraints once for the
 * whole operation. Everything checked here is target-independent — the derived
 * depth comes from the requested mouth diameter and the V-bit angle alone — so a
 * failure means the operation emits no motion at all rather than an approximate
 * cut on some targets.
 */
function resolveCountersinkDepth(
  tool: NormalizedTool,
  operation: Operation,
): { depth: number; mouthDiameter: number } | { warning: ToolpathWarning } {
  if (tool.type !== 'v_bit') {
    return { warning: { code: 'drillCountersinkNeedsVBit' } }
  }

  const angle = tool.vBitAngle
  if (!(angle !== null && angle > 0 && angle < 180)) {
    return { warning: { code: 'vBitAngleRange' } }
  }

  const mouthDiameter = operation.countersinkDiameter ?? 0
  if (!(mouthDiameter > 0)) {
    return { warning: { code: 'drillCountersinkDiameterPositive' } }
  }

  // The cone only exists out to the cutter's own diameter; past that the tool
  // has no cutting edge and the shank would rub.
  if (mouthDiameter - tool.diameter > 1e-9) {
    return {
      warning: {
        code: 'drillCountersinkExceedsToolDiameter',
        params: {
          requested: Number(mouthDiameter.toFixed(4)),
          toolDiameter: Number(tool.diameter.toFixed(4)),
        },
      },
    }
  }

  const depth = countersinkTipDepth(mouthDiameter, angle)
  if (depth === null) {
    return { warning: { code: 'vBitInvalidSlope' } }
  }

  // maxCutDepth of 0 means "unset", the same convention checkMaxCutDepthWarning
  // uses. Unlike that helper this fails closed: the plunge is the entire cut.
  //
  // The tolerance is load-bearing, not defensive rounding. A V-bit cannot plunge
  // past its own cone height, so `maxCutDepth` for one is naturally authored as
  // exactly D / (2·tan(θ/2)) — and asking that bit for its full diameter derives
  // that same number in floating point, where it lands one ULP high: a 90° Ø12
  // bit yields 6.000000000000001 against a limit of 6. Without the epsilon the
  // most ordinary countersink there is — full diameter on a correctly described
  // tool — fails closed. Same 1e-9 the geometry comparisons here already use.
  if (tool.maxCutDepth > 0 && depth - tool.maxCutDepth > 1e-9) {
    return {
      warning: {
        code: 'drillCountersinkDepthExceedsToolMax',
        params: {
          depth: depth.toFixed(3),
          max: tool.maxCutDepth.toFixed(3),
          units: tool.units,
        },
      },
    }
  }

  return { depth, mouthDiameter }
}

/**
 * One countersink: a single direct plunge to the derived depth below this
 * target's own top face, then a retract to safe Z.
 *
 * The motion itself is an ordinary simple plunge — deliberately so. Countersink
 * output must stay expanded G0/G1, never a canned cycle, because no G8x cycle
 * describes "plunge to a depth derived from a cone angle". The caller records no
 * `DrillCycle` for it, which is what keeps the postprocessor on the linear path.
 */
function emitCountersinkPlunge(
  moves: ToolpathMove[],
  current: ToolpathPoint | null,
  center: Point,
  topZ: number,
  tipDepth: number,
  safeZ: number,
  retractZ: number,
): ToolpathPoint {
  return emitSimplePlunge(moves, current, center, topZ - tipDepth, safeZ, retractZ)
}

function emitDrillCycle(
  moves: ToolpathMove[],
  current: ToolpathPoint | null,
  center: Point,
  topZ: number,
  bottomZ: number,
  safeZ: number,
  retractZ: number,
  drillType: DrillType,
  peckDepth: number,
): ToolpathPoint {
  // Establish { hole centre, safeZ } before any descent. When this is the first
  // hole `current` is null, so the postprocessor has no known machine location
  // and would emit Z before XY — putting the traverse to the first hole at
  // retract height instead of the clearance plane. A zero-length rapid tells it
  // to position XY and Z at safeZ first; `optimizeLinearMoves` preserves it as
  // the operation's entry marker. Same pattern as `emitCenterLockedCircularBore`.
  const aboveSafe: ToolpathPoint = { x: center.x, y: center.y, z: safeZ }
  if (!current) {
    moves.push({ kind: 'rapid', from: aboveSafe, to: aboveSafe })
  } else if (current.x !== aboveSafe.x || current.y !== aboveSafe.y || current.z !== aboveSafe.z) {
    moves.push({ kind: 'rapid', from: current, to: aboveSafe })
  }

  // Rapid down to retract height (just above the material)
  const rapidStart: ToolpathPoint = { x: center.x, y: center.y, z: retractZ }
  if (retractZ < safeZ) {
    moves.push({ kind: 'rapid', from: aboveSafe, to: rapidStart })
  }

  if (drillType === 'simple' || drillType === 'dwell') {
    const bottom: ToolpathPoint = { x: center.x, y: center.y, z: bottomZ }
    moves.push({ kind: 'plunge', from: rapidStart, to: bottom })
    const retract: ToolpathPoint = { x: center.x, y: center.y, z: safeZ }
    moves.push({ kind: 'rapid', from: bottom, to: retract })
    return retract
  }

  // Peck or chip-breaking: iteratively drill down peckDepth at a time.
  const effectivePeck = peckDepth > 0 ? peckDepth : Math.max(topZ - bottomZ, 1e-6)
  let currentZ = Math.min(topZ, retractZ)
  let prev = rapidStart

  while (currentZ > bottomZ) {
    const nextZ = Math.max(bottomZ, currentZ - effectivePeck)
    const plungeTo: ToolpathPoint = { x: center.x, y: center.y, z: nextZ }
    moves.push({ kind: 'plunge', from: prev, to: plungeTo })

    if (nextZ <= bottomZ) {
      prev = plungeTo
      break
    }

    if (drillType === 'peck') {
      // G83 — full retract to safe Z to clear chips, then rapid back to just above last cut
      const retract: ToolpathPoint = { x: center.x, y: center.y, z: safeZ }
      moves.push({ kind: 'rapid', from: plungeTo, to: retract })
      const reEntry: ToolpathPoint = { x: center.x, y: center.y, z: nextZ + CHIP_BREAK_CLEARANCE }
      moves.push({ kind: 'rapid', from: retract, to: reEntry })
      prev = reEntry
    } else {
      // G73 chip breaking — small retract to break the chip
      const chipBreak: ToolpathPoint = { x: center.x, y: center.y, z: nextZ + CHIP_BREAK_CLEARANCE }
      moves.push({ kind: 'rapid', from: plungeTo, to: chipBreak })
      prev = chipBreak
    }

    currentZ = nextZ
  }

  const finalRetract: ToolpathPoint = { x: center.x, y: center.y, z: safeZ }
  moves.push({ kind: 'rapid', from: prev, to: finalRetract })
  return finalRetract
}

export function generateDrillingToolpath(project: Project, operation: Operation): ToolpathResult {
  if (operation.kind !== 'drilling') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'drillWrongKind' }],
      bounds: null,
    }
  }

  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'drillNoTargets' }],
      bounds: null,
    }
  }

  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null

  if (!toolRecord) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'noToolAssigned' }],
      bounds: null,
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'toolDiameterPositive' }],
      bounds: null,
    }
  }

  const splitTargets = splitFeatureTargets(project, operation.target.featureIds)
  const regionMask = buildRegionMask(splitTargets.regionFeatures)
  const targetFeatures = splitTargets.machiningFeatures
    .filter((feature) => feature.kind === 'circle')

  const warnings: ToolpathWarning[] = []

  const drillType: DrillType = operation.drillType ?? 'simple'
  const peckDepth = operation.peckDepth ?? 0

  if (drillType === 'helical') {
    if (tool.type !== 'flat_endmill') {
      warnings.push({ code: 'drillHelicalToolUnsupported' })
    }
  } else if (drillType === 'countersink') {
    // Validated below against the V-bit's geometry — a drill bit is the wrong
    // tool here, so the drillNotDrillBit advice would be actively misleading.
  } else if (tool.type !== 'drill') {
    warnings.push({ code: 'drillNotDrillBit' })
  }

  if (targetFeatures.length !== splitTargets.machiningFeatures.length || splitTargets.missingFeatureIds.length > 0) {
    warnings.push({ code: 'drillTargetsNotCircles' })
  }

  if ((drillType === 'peck' || drillType === 'chip_breaking') && !(peckDepth > 0)) {
    warnings.push({ code: 'drillPeckDepthPositive' })
  }

  // Countersinking fails closed: an unusable tool or diameter produces warnings
  // and no motion, never a plunge to some approximated depth.
  let countersink: { depth: number; mouthDiameter: number } | null = null
  if (drillType === 'countersink') {
    const resolved = resolveCountersinkDepth(tool, operation)
    if ('warning' in resolved) {
      return {
        operationId: operation.id,
        moves: [],
        warnings: [...warnings, resolved.warning],
        bounds: null,
      }
    }
    countersink = resolved
  }

  // Precompute and sort targets by nearest-neighbor travel
  const { targets: drillTargets, warnings: precomputeWarnings } = precomputeDrillTargets(targetFeatures, project, regionMask)
  appendAll(warnings, precomputeWarnings)

  if (drillTargets.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...warnings, { code: 'drillNoValidCircles' }],
      bounds: null,
    }
  }

  // Sort by nearest-neighbor from current position
  const sortedTargets = sortTargetsByNearestNeighbor(drillTargets, null)

  const featureSpans = sortedTargets.map((target) => target.span)
  const safeZ = getOperationSafeZ(project, featureSpans)

  // The retract plane is where every rapid descent stops before the fed plunge
  // begins, so it must never sit inside material: below it the tool would enter
  // the part at rapid, and the first hole's XY traverse would cross the stock at
  // that height (issue #479). `retractHeight` is stored as a distance above the
  // material surface (issue #481); resolve it against that surface, then clamp
  // up to it and cap at the clearance plane. The two bounds can never fight —
  // `getOperationSafeZ` is `max(stockTop, highestFeatureMax) + clearance`, and
  // every target that passes the `bottomZ >= topZ` guard has
  // `span.max === span.top`, so `safeZ === materialTopZ + clearance >= materialTopZ`.
  const highestTop = featureSpans.reduce((max, span) => Math.max(max, span.top), 0)
  const materialTopZ = Math.max(project.stock.thickness, highestTop)
  const requestedRetractOffset = operation.retractHeight ?? defaultRetractOffset(project.meta.units)
  const requestedRetractZ = materialTopZ + requestedRetractOffset
  const retractZ = Math.min(safeZ, Math.max(requestedRetractZ, materialTopZ))

  // Only an explicit operator value earns a warning. The shared default above
  // is already clear of the surface, so clamping it would be reporting our own
  // arithmetic back to the user. A stored distance of zero or less parks the
  // plane at or inside the part — the UI prevents negatives and the format
  // migration floors legacy values here, but both remain possible through old
  // files and direct edits, so they warn. The reported numbers are the same
  // distances the field holds (issue #481 review), not absolute Zs.
  if (operation.retractHeight !== undefined && requestedRetractOffset <= 0) {
    warnings.push({
      code: 'drillRetractBelowStockTop',
      params: {
        requested: Number(requestedRetractOffset.toFixed(4)),
        clamped: Number((retractZ - materialTopZ).toFixed(4)),
      },
    })
  }

  const moves: ToolpathMove[] = []
  const drillCycles: DrillCycle[] = []
  let currentPosition: ToolpathPoint | null = null

  const dwellTime = operation.dwellTime ?? 0
  const rampAngle = Math.min(45, Math.max(0.1, operation.entryRampAngle ?? DEFAULT_ENTRY_RAMP_ANGLE))
  const cutDirection = operation.cutDirection ?? 'conventional'

  for (const target of sortedTargets) {
    const topZ = target.span.top
    const bottomZ = target.span.bottom

    // A countersink never cuts the feature's full depth — the V-bit only opens
    // the mouth — so the hole's own depth says nothing about the tool's limit.
    // `resolveCountersinkDepth` has already checked the depth that is cut.
    if (countersink === null) {
      const depthWarning = checkMaxCutDepthWarning(tool, topZ - bottomZ)
      if (depthWarning) {
        warnings.push({ code: 'cutDepthExceedsToolMaxForFeature', params: { name: target.feature.name, ...depthWarning.params } })
      }
    }

    if (countersink !== null) {
      const holeRadius = getCircleRadius(target.feature.sketch.profile)
      if (holeRadius === null) {
        // getCircleCenter already accepted this profile, so this is unreachable
        // in practice; skip rather than guess at a diameter. Do not mutate
        // currentPosition — the tool has not visited this centre.
        warnings.push({ code: 'drillTargetsNotCircles' })
        continue
      }

      const holeDiameter = holeRadius * 2
      // A mouth no wider than the hole leaves the cone's rim inside the bore:
      // there is no seat to cut, and the plunge would only rub the wall.
      if (countersink.mouthDiameter - holeDiameter <= 1e-9) {
        warnings.push({
          code: 'drillCountersinkNotLargerThanHole',
          params: {
            name: target.feature.name,
            requested: Number(countersink.mouthDiameter.toFixed(4)),
            holeDiameter: Number(holeDiameter.toFixed(4)),
          },
        })
        continue
      }

      currentPosition = emitCountersinkPlunge(
        moves,
        currentPosition,
        target.center,
        topZ,
        countersink.depth,
        safeZ,
        retractZ,
      )
      // No drillCycles entry — countersinking stays on the expanded G0/G1 path.
      continue
    }

    if (drillType === 'helical' && tool.type === 'flat_endmill') {
      const holeRadius = getCircleRadius(target.feature.sketch.profile)
      if (holeRadius !== null) {
        const holeDiameter = holeRadius * 2
        const toolDiameter = tool.diameter
        const toolRadius = toolDiameter / 2
        const twiceDiameter = toolDiameter * 2

        // Eligibility: the selected-circle diameter must be strictly larger
        // than the tool diameter and no greater than twice it.  Outside that
        // range a single centred helix cannot both clear the core and reach
        // the wall without becoming a pocket operation.
        if (holeDiameter - toolDiameter <= 1e-9) {
          // Hole at or below tool diameter — no room to orbit.
          warnings.push({
            code: 'drillHelicalBoreTooSmall',
            params: { holeDiameter: Number(holeDiameter.toFixed(4)), toolDiameter: Number(toolDiameter.toFixed(4)) },
          })
          // Emit no moves for this target; do not mutate currentPosition —
          // the tool has not visited this hole centre.
        } else if (holeDiameter - twiceDiameter > 1e-9) {
          // Hole larger than 2× tool diameter — clearing requires pocketing.
          warnings.push({
            code: 'drillHelicalBoreTooLarge',
            params: {
              holeDiameter: Number(holeDiameter.toFixed(4)),
              maxDiameter: Number(twiceDiameter.toFixed(4)),
            },
          })
          // Do not mutate currentPosition — the tool has not visited this hole centre.
        } else {
          // Eligible: cutter-centre orbit = holeRadius - toolRadius.
          const boreRadius = holeRadius - toolRadius
          const result = emitCenterLockedCircularBore(
            moves,
            currentPosition,
            target.center,
            boreRadius,
            holeRadius,
            toolDiameter,
            bottomZ,
            safeZ,
            retractZ,
            rampAngle,
            cutDirection,
            operation.feed,
            operation.plungeFeed,
            true, // isFinishBore — do not subtract entry safety or clamp to no-core cap
          )
          // Rejected (unmachinable) bores emit no moves — do not advance
          // currentPosition so the next target starts from the actual prior position.
          if (!result.warnings.some((w) => w.code === 'drillHelicalBoreUnmachinable')) {
            currentPosition = result.position
          }
          appendAll(warnings, result.warnings)
        }
      } else {
        // Should not reach here (getCircleCenter already passed), but be safe
        currentPosition = emitSimplePlunge(moves, currentPosition, target.center, bottomZ, safeZ, retractZ)
      }
      // No drillCycles entry for helical — moves are emitted as G1 lead-in moves
    } else {
      const effectiveDrillType: DrillType = drillType === 'helical' ? 'simple' : drillType
      currentPosition = emitDrillCycle(
        moves,
        currentPosition,
        target.center,
        topZ,
        bottomZ,
        safeZ,
        retractZ,
        effectiveDrillType,
        peckDepth,
      )

      drillCycles.push({
        x: target.center.x,
        y: target.center.y,
        clearZ: safeZ,
        retractZ,
        bottomZ,
        drillType: effectiveDrillType,
        peckDepth: operation.peckDepth ?? 0,
        dwellTime,
      })
    }
  }

  return {
    operationId: operation.id,
    moves,
    warnings,
    bounds: computeBounds(moves),
    drillCycles,
  }
}
