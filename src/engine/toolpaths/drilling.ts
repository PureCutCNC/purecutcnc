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
  getOperationSafeZ,
  normalizeToolForProject,
  resolveFeatureZSpan,
} from './geometry'
import { buildRegionMask, splitFeatureTargets } from './regions'

const CHIP_BREAK_CLEARANCE = 0.5    // tiny retract between pecks in chip-breaking mode (project units)

interface DrillTarget {
  feature: SketchFeature
  center: Point
  span: ReturnType<typeof resolveFeatureZSpan>
  originalIndex: number
}

function xyDistanceSquared(a: ToolpathPoint, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  return dx * dx + dy * dy
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

function sortTargetsByNearestNeighbor(targets: DrillTarget[], startPosition: ToolpathPoint | null): DrillTarget[] {
  if (targets.length <= 1) return targets

  const current = startPosition ?? { x: 0, y: 0, z: 0 }
  const ordered: DrillTarget[] = []
  const remaining = [...targets]

  while (remaining.length > 0) {
    let bestIndex = 0
    let bestDistance = xyDistanceSquared(current, remaining[0].center)

    for (let i = 1; i < remaining.length; i += 1) {
      const distance = xyDistanceSquared(current, remaining[i].center)
      if (
        distance < bestDistance
        || (distance === bestDistance && remaining[i].originalIndex < remaining[bestIndex].originalIndex)
      ) {
        bestIndex = i
        bestDistance = distance
      }
    }

    const [next] = remaining.splice(bestIndex, 1)
    ordered.push(next)
    current.x = next.center.x
    current.y = next.center.y
  }

  return ordered
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

  if (tool.type !== 'drill') {
    warnings.push({ code: 'drillNotDrillBit' })
  }

  if (targetFeatures.length !== splitTargets.machiningFeatures.length || splitTargets.missingFeatureIds.length > 0) {
    warnings.push({ code: 'drillTargetsNotCircles' })
  }



  const drillType: DrillType = operation.drillType ?? 'simple'
  const peckDepth = operation.peckDepth ?? 0

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

    currentPosition = emitDrillCycle(
      moves,
      currentPosition,
      target.center,
      topZ,
      bottomZ,
      safeZ,
      retractZ,
      drillType,
      peckDepth,
    )

    drillCycles.push({
      x: target.center.x,
      y: target.center.y,
      clearZ: safeZ,
      retractZ,
      bottomZ,
      drillType,
      peckDepth: operation.peckDepth ?? 0,
      dwellTime,
    })
  }

  return {
    operationId: operation.id,
    moves,
    warnings,
    bounds: computeBounds(moves),
    drillCycles,
  }
}
