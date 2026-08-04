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

import type { DrillType, Operation, Point, Project, SketchFeature, SketchProfile } from '../../types/project'
import type { ToolpathWarning } from './warningCodes'
import type { DrillCycle, ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
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
  const aboveSafe: ToolpathPoint = { x: center.x, y: center.y, z: safeZ }
  if (current && (current.x !== aboveSafe.x || current.y !== aboveSafe.y || current.z !== aboveSafe.z)) {
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
  // Rapid above the hole at safeZ — skip if we're already there (first hole, no prior position)
  const aboveSafe: ToolpathPoint = { x: center.x, y: center.y, z: safeZ }
  if (current && (current.x !== aboveSafe.x || current.y !== aboveSafe.y || current.z !== aboveSafe.z)) {
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
  } else if (tool.type !== 'drill') {
    warnings.push({ code: 'drillNotDrillBit' })
  }

  if (targetFeatures.length !== splitTargets.machiningFeatures.length || splitTargets.missingFeatureIds.length > 0) {
    warnings.push({ code: 'drillTargetsNotCircles' })
  }

  if ((drillType === 'peck' || drillType === 'chip_breaking') && !(peckDepth > 0)) {
    warnings.push({ code: 'drillPeckDepthPositive' })
  }

  // Precompute and sort targets by nearest-neighbor travel
  const { targets: drillTargets, warnings: precomputeWarnings } = precomputeDrillTargets(targetFeatures, project, regionMask)
  warnings.push(...precomputeWarnings)

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

  // Default retract height is just above the highest feature top, below safe Z.
  const defaultRetractOffset = 1 // small offset in project units
  const highestTop = featureSpans.reduce((max, span) => Math.max(max, span.top), 0)
  const retractZ = operation.retractHeight !== undefined
    ? Math.min(safeZ, operation.retractHeight)
    : Math.min(safeZ, highestTop + defaultRetractOffset)

  const moves: ToolpathMove[] = []
  const drillCycles: DrillCycle[] = []
  let currentPosition: ToolpathPoint | null = null

  const dwellTime = operation.dwellTime ?? 0
  const rampAngle = Math.min(45, Math.max(0.1, operation.entryRampAngle ?? DEFAULT_ENTRY_RAMP_ANGLE))
  const cutDirection = operation.cutDirection ?? 'conventional'

  for (const target of sortedTargets) {
    const topZ = target.span.top
    const bottomZ = target.span.bottom

    const depthWarning = checkMaxCutDepthWarning(tool, topZ - bottomZ)
    if (depthWarning) {
      warnings.push({ code: 'cutDepthExceedsToolMaxForFeature', params: { name: target.feature.name, ...depthWarning.params } })
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
          // Emit no moves for this target; advance currentPosition so the
          // next target (if any) still gets a proper safe-Z rapid from the
          // current hole centre.
          currentPosition = { x: target.center.x, y: target.center.y, z: safeZ }
        } else if (holeDiameter - twiceDiameter > 1e-9) {
          // Hole larger than 2× tool diameter — clearing requires pocketing.
          warnings.push({
            code: 'drillHelicalBoreTooLarge',
            params: {
              holeDiameter: Number(holeDiameter.toFixed(4)),
              maxDiameter: Number(twiceDiameter.toFixed(4)),
            },
          })
          currentPosition = { x: target.center.x, y: target.center.y, z: safeZ }
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
          currentPosition = result.position
          warnings.push(...result.warnings)
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
