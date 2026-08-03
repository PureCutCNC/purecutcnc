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
  DEFAULT_ENTRY_HELIX_DIAMETER_PERCENT,
  HELIX_SEGMENTS_PER_REVOLUTION,
  MAX_ENTRY_DESCENT_MOVES,
  helixAngularDirection,
  pitchFromRampAngle,
  plungeLimitedFeedScale,
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
    const first = profile.segments[0]
    if (first.type === 'arc') {
      return first.center
    }
  }

  return null
}

function getCircleRadius(profile: SketchProfile): number | null {
  if (profile.segments.length === 1 && profile.segments[0].type === 'circle') {
    const seg = profile.segments[0]
    const dx = seg.to.x - seg.center.x
    const dy = seg.to.y - seg.center.y
    return Math.sqrt(dx * dx + dy * dy)
  }
  if (profile.segments.length === 4 && profile.segments.every((s) => s.type === 'arc')) {
    const first = profile.segments[0]
    if (first.type === 'arc') {
      const dx = first.to.x - first.center.x
      const dy = first.to.y - first.center.y
      return Math.sqrt(dx * dx + dy * dy)
    }
  }
  return null
}

const ENTRY_BOUNDARY_SAFETY_FRACTION = 0.1

function entryBoundarySafety(toolDiameter: number): number {
  return Math.max(1e-4, toolDiameter * ENTRY_BOUNDARY_SAFETY_FRACTION)
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

function emitHelicalBore(
  moves: ToolpathMove[],
  current: ToolpathPoint | null,
  center: Point,
  bottomZ: number,
  safeZ: number,
  retractZ: number,
  operation: Operation,
  toolDiameter: number,
  holeRadius: number,
): { position: ToolpathPoint; warnings: ToolpathWarning[] } {
  const warnings: ToolpathWarning[] = []
  const rampAngle = clampRampAngle(operation.entryRampAngle ?? DEFAULT_ENTRY_RAMP_ANGLE)
  const helixDiameterPercent = clampPercent(operation.entryHelixDiameterPercent ?? DEFAULT_ENTRY_HELIX_DIAMETER_PERCENT)
  const cutDirection = operation.cutDirection ?? 'conventional'

  const requestedDiameter = toolDiameter * helixDiameterPercent / 100
  const requestedRadius = requestedDiameter / 2

  const safety = entryBoundarySafety(toolDiameter)
  const noCoreCap = toolDiameter / 2

  const clearanceRadius = Math.max(0, holeRadius - safety)
  const helixRadius = Math.min(requestedRadius, clearanceRadius, noCoreCap)

  if (!(helixRadius > 1e-9) || !(clearanceRadius > 1e-9)) {
    warnings.push({ code: 'entryStrategyFallback', params: { requested: 'helix', fallback: 'plunge' } })
    const pos = emitSimplePlunge(moves, current, center, bottomZ, safeZ, retractZ)
    return { position: pos, warnings }
  }

  const depth = Math.max(0, retractZ - bottomZ)
  const pitch = pitchFromRampAngle(helixRadius * 2, rampAngle)
  const revolutions = pitch > 1e-9 ? depth / pitch : 0
  const descentSegments = Math.max(1, Math.ceil(revolutions * HELIX_SEGMENTS_PER_REVOLUTION))

  if (descentSegments > MAX_ENTRY_DESCENT_MOVES) {
    warnings.push({ code: 'entryStrategyFallback', params: { requested: 'helix', fallback: 'plunge' } })
    const pos = emitSimplePlunge(moves, current, center, bottomZ, safeZ, retractZ)
    return { position: pos, warnings }
  }

  if (helixRadius < requestedRadius - Math.max(1e-9, requestedRadius * 1e-9)) {
    warnings.push({
      code: 'entryHelixDiameterClamped',
      params: {
        requestedDiameter: Number(requestedDiameter.toFixed(4)),
        actualDiameter: Number((helixRadius * 2).toFixed(4)),
      },
    })
  }

  const direction = helixAngularDirection(cutDirection, 'internal')

  // Rapid to safeZ above hole center
  const aboveSafe: ToolpathPoint = { x: center.x, y: center.y, z: safeZ }
  if (current && (current.x !== aboveSafe.x || current.y !== aboveSafe.y || current.z !== aboveSafe.z)) {
    moves.push({ kind: 'rapid', from: current, to: aboveSafe })
  }

  // Rapid down to retract height at hole center
  const atRetract: ToolpathPoint = { x: center.x, y: center.y, z: retractZ }
  if (retractZ < safeZ) {
    moves.push({ kind: 'rapid', from: aboveSafe, to: atRetract })
  }

  // Rapid from center to helix start at retract height
  const startPoint: ToolpathPoint = {
    x: center.x + helixRadius,
    y: center.y,
    z: retractZ,
  }
  if (helixRadius > 1e-9) {
    moves.push({ kind: 'rapid', from: atRetract, to: startPoint })
  }

  let prev = startPoint

  // Helical descent
  const feedScale = plungeLimitedFeedScale(operation.feed, operation.plungeFeed, rampAngle)
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

  // Bottom-flattening revolution
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

  // Rapid retract to safeZ from final position (which is on the helix circle at bottomZ)
  const finalRetract: ToolpathPoint = { x: center.x, y: center.y, z: safeZ }
  moves.push({ kind: 'rapid', from: prev, to: finalRetract })

  return { position: finalRetract, warnings }
}

function clampRampAngle(value: number): number {
  return Math.min(45, Math.max(0.1, value))
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(1, value))
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
        const result = emitHelicalBore(
          moves,
          currentPosition,
          target.center,
          bottomZ,
          safeZ,
          retractZ,
          operation,
          tool.diameter,
          holeRadius,
        )
        currentPosition = result.position
        warnings.push(...result.warnings)
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
