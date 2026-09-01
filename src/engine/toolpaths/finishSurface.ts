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
 *
 * Finish Surface Operation orchestrator.
 *
 * Strategy implementations live in:
 * - finishSurfaceParallel.ts
 * - finishSurfaceWaterline.ts
 */

import type { Operation, Point, Project } from '../../types/project'
import type { ToolpathWarning } from './warningCodes'
import type { PocketToolpathResult, ToolpathBounds } from './types'
import { getOperationSafeZ, normalizeToolForProject } from './geometry'
import { generateStepLevels, retractToSafe, updateBounds } from './pocket'
import { loadSTLTransformedGeometry } from '../csg'
import { splitFeatureTargets } from './regions'
import {
  buildExpandedTabFootprints,
  offsetClipperPaths,
  relatedIntersectingAddFeatures,
  relatedSubtractFeatures,
  safeSubtractBottomZAtPoint,
  tabTopZAtPoint,
} from './modelProtection'
import {
  generateFinishSurfaceParallel,
  modelSilhouettePathsForFinishSurface,
  type FinishSurfaceParallelCacheHost,
} from './finishSurfaceParallel'
import { generateFinishSurfaceWaterline } from './finishSurfaceWaterline'
import { effectivePocketPattern } from './pocketPatterns'

export { maxContourGap } from './finishSurfaceWaterline'

const FLOOR_Z_TOLERANCE = 1e-6

/**
 * Zs a waterline pass takes as critical floor levels: those carrying horizontal
 * model surface the cutter can actually reach (issue #685).
 *
 * Every distinct Z with a horizontal triangle used to qualify. That is right for
 * a genuine floor and catastrophic for a quantized depth map, where every grey
 * step is a plateau: the 291k-triangle relief behind #673 carried 431 of them a
 * median 4.5 um apart, so 431 critical levels joined 7 real stepdowns and the
 * whole per-level pipeline — mesh slice, even-odd union, shadow union, ring
 * offset — ran 438 times.
 *
 * This is #682's rule reaching waterline, which does not go through
 * `resolve3DSurfaceStepdown` and so never inherited it.
 */
export function criticalWaterlineFloorZs(
  transformedPositions: Float32Array,
  index: Uint32Array,
  toolRadius: number,
): Set<number> {
  const flatAreaByZ = new Map<number, number>()
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3
    const b = index[i + 1] * 3
    const c = index[i + 2] * 3
    const z0 = transformedPositions[a + 2]
    const z1 = transformedPositions[b + 2]
    const z2 = transformedPositions[c + 2]
    if (Math.abs(z0 - z1) >= FLOOR_Z_TOLERANCE || Math.abs(z1 - z2) >= FLOOR_Z_TOLERANCE) continue
    // Projected area, which for a horizontal triangle is its true area, in
    // project units — the positions are already transformed.
    const area = Math.abs(
      (transformedPositions[b] - transformedPositions[a]) * (transformedPositions[c + 1] - transformedPositions[a + 1])
      - (transformedPositions[c] - transformedPositions[a]) * (transformedPositions[b + 1] - transformedPositions[a + 1]),
    ) / 2
    flatAreaByZ.set(z0, (flatAreaByZ.get(z0) ?? 0) + area)
  }

  const floorZs = new Set<number>()
  const minimum = minReachableFloorArea(toolRadius)
  for (const { z, area } of mergeFlatAreasDescending(flatAreaByZ)) {
    if (area >= minimum) floorZs.add(z)
  }
  return floorZs
}

/**
 * Smallest flat area at one Z that the cutter can reach, and so the smallest
 * one worth a critical waterline level (issue #685).
 *
 * The tool tip can only sit at Z where a disc of the tool's own radius is clear
 * of material standing above Z, and a connected region containing a disc of
 * radius `R` has area at least `PI * R^2`. A plateau under that bound is
 * therefore surrounded, within a tool radius, by material higher than itself:
 * the cutter rides on the neighbours and never touches the plateau, so a ring
 * at its Z machines nothing that the ring above it did not already machine.
 *
 * Deliberately *necessary* and not *sufficient*, exactly as in #682. The sum is
 * over disconnected regions, so it keeps at least as many levels as a
 * connected-component test would; a long thin sliver that clears the bound is
 * left to the rest of the pipeline to produce nothing from. It is also measured
 * against the tool's own radius rather than `tool.radius + stockToLeaveRadial`,
 * which is the choice that keeps the *most* levels of the two.
 *
 * Dropping a level can only remove cutting motion, never add it, so this can
 * only ever leave more material — it cannot move a contour toward the model. A
 * Z that loses its critical level is left exactly as covered as any Z the mesh
 * happens to carry no horizontal triangle at: by the evenly spaced stepdown
 * ladder and by adaptive refinement.
 */
function minReachableFloorArea(toolRadius: number): number {
  return Math.PI * toolRadius * toolRadius
}

/**
 * Flat area per Z, merged on the same tolerance the horizontal-triangle test
 * uses, so a plateau whose vertices differ in the last bits is not split across
 * two buckets and dropped twice for being small.
 */
function mergeFlatAreasDescending(areaByZ: Map<number, number>): Array<{ z: number; area: number }> {
  const sorted = [...areaByZ.entries()].sort((a, b) => b[0] - a[0])
  const merged: Array<{ z: number; area: number }> = []
  for (const [z, area] of sorted) {
    const previous = merged[merged.length - 1]
    if (previous !== undefined && Math.abs(previous.z - z) <= FLOOR_Z_TOLERANCE) {
      previous.z = Math.min(previous.z, z)
      previous.area += area
      continue
    }
    merged.push({ z, area })
  }
  return merged
}

export function generateFinishSurfaceToolpath(
  project: Project,
  operation: Operation,
): PocketToolpathResult {
  // The strategy this kind runs for the stored pattern (issue #609). Only
  // `waterline` is its own strategy here; every other stored value has always
  // taken the parallel branch, and `OPERATION_PATTERN_SUPPORT` is now where
  // that is written down rather than in the `else` of each test below.
  const isWaterline = effectivePocketPattern(operation.kind, operation.pocketPattern) === 'waterline'
  const target = operation.target
  if (target.source !== 'features' || target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'finishNeedsModel' }],
      bounds: null,
      stepLevels: [],
    }
  }

  const splitTargets = splitFeatureTargets(project, target.featureIds)
  if (splitTargets.missingFeatureIds.length > 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'targetsNotFound' }],
      bounds: null,
      stepLevels: [],
    }
  }

  const modelFeature = splitTargets.machiningFeatures.find((f) => f.operation === 'model' && f.kind === 'stl')
  const regionFeatures = splitTargets.regionFeatures.filter((f) => f.sketch.profile.closed)

  if (!modelFeature) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'finishNotMesh' }],
      bounds: null,
      stepLevels: [],
    }
  }

  const toolRecord =
    operation.toolRef ? project.tools.find((t) => t.id === operation.toolRef) ?? null : null
  if (!toolRecord) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'noToolAssigned' }],
      bounds: null,
      stepLevels: [],
    }
  }
  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'toolDiameterPositive' }],
      bounds: null,
      stepLevels: [],
    }
  }
  if (!(operation.stepdown > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'stepdownPositive' }],
      bounds: null,
      stepLevels: [],
    }
  }

  const stlData = loadSTLTransformedGeometry(modelFeature, project)
  if (!stlData) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'surface3dLoadFailed' }],
      bounds: null,
      stepLevels: [],
    }
  }

  const { positions: transformedPos, index } = stlData

  let modelTopZ = -Infinity
  let modelBottomZ = Infinity
  for (let i = 0; i < transformedPos.length; i += 3) {
    const z = transformedPos[i + 2]
    if (z > modelTopZ) modelTopZ = z
    if (z < modelBottomZ) modelBottomZ = z
  }

  // Detect horizontal model surfaces (triangles whose three vertices share Z).
  // For waterline these become "critical" levels — the contour right at the
  // floor of a bump or the top of a pocket has to be included as a stepdown,
  // otherwise a thin ring of material is left between the lowest evenly-spaced
  // stepdown and the actual floor.
  //
  // A flat region only earns one if the cutter can actually reach it
  // (issue #685). This is #682's rule, arriving at waterline through its own
  // copy of the critical-floor scan rather than through
  // `resolve3DSurfaceStepdown`: on a quantized depth map every grey step is a
  // plateau, and the reporter's 291k-triangle relief carried 431 of them a
  // median 4.5 um apart — 431 critical levels added to 7 real stepdowns, each
  // one paying a full mesh slice, shadow union and ring offset.
  const horizontalFloorZs = isWaterline
    ? criticalWaterlineFloorZs(transformedPos, index, tool.radius)
    : new Set<number>()

  const axialLeave = Math.max(0, operation.stockToLeaveAxial)
  let effectiveBottom = modelBottomZ + axialLeave
  if (effectiveBottom >= modelTopZ) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'surface3dStockToLeaveTooLarge' }],
      bounds: null,
      stepLevels: [],
    }
  }

  const modelSilhouettePaths = modelSilhouettePathsForFinishSurface(modelFeature)
  const intersectingAdds = relatedIntersectingAddFeatures(
    project,
    new Set(target.featureIds),
    modelSilhouettePaths,
    { excludeContainingAddFeatures: isWaterline },
  )
  const intersectingAddTopMax = intersectingAdds.length === 0
    ? -Infinity
    : intersectingAdds.reduce((m, a) => Math.max(m, a.topZ), -Infinity)

  const relatedSubtracts = relatedSubtractFeatures(
    project,
    new Set(target.featureIds),
    modelSilhouettePaths,
  ).map((subtract) => ({
    ...subtract,
    clearancePaths: offsetClipperPaths(subtract.paths, -tool.radius),
  }))
  if (relatedSubtracts.length > 0) {
    const deepestRelatedBottom = relatedSubtracts.reduce((min, subtract) => Math.min(min, subtract.bottomZ), Infinity)
    effectiveBottom = Math.max(effectiveBottom, deepestRelatedBottom)
    if (effectiveBottom >= modelTopZ) {
      return {
        operationId: operation.id,
        moves: [],
        warnings: [{ code: 'finishNoDepthInPocket' }],
        bounds: null,
        stepLevels: [],
      }
    }
  }

  // Waterline must reach above modelTopZ when an intersecting add feature
  // pokes higher than the mesh — those exposed walls live above the model
  // surface and need finishing too. For other strategies, keep modelTopZ as
  // the upper bound (parallel finish samples the model surface only).
  const stepLevelTopZ = isWaterline
    ? Math.max(modelTopZ, intersectingAddTopMax)
    : modelTopZ
  let stepLevels = generateStepLevels(stepLevelTopZ, effectiveBottom, operation.stepdown)
  if (isWaterline) {
    // Insert stepLevelTopZ, modelTopZ, and horizontal floor Zs within the
    // effective range as additional waterline rings. The floor levels are
    // critical to leave a clean foot at the base of bumps (and a clean top at
    // the rim of pockets) — without them the lowest ring sits one stepdown
    // above the floor and leaves a small unmachined band.
    const merged = new Set<number>(stepLevels)
    if (stepLevelTopZ > effectiveBottom + 1e-9) merged.add(stepLevelTopZ)
    if (modelTopZ > effectiveBottom + 1e-9 && modelTopZ <= stepLevelTopZ + 1e-9) {
      merged.add(modelTopZ)
    }
    for (const z of horizontalFloorZs) {
      if (z > effectiveBottom + 1e-9 && z <= stepLevelTopZ + 1e-9) {
        merged.add(z)
      }
    }
    stepLevels = [...merged].sort((a, b) => b - a)
  }

  if (stepLevels.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'surface3dNoStepLevels' }],
      bounds: null,
      stepLevels: [],
    }
  }

  const safeZ = getOperationSafeZ(project)
  const warnings: ToolpathWarning[] = []
  // Tabs constrain the parallel-finish cut Z per-point: at any XY inside an
  // expanded tab footprint, the cutter tip must stay at or above tab.z_top so
  // the tab material from z_bottom..z_top is preserved. Tabs whose top sits
  // below the surface being cut still get clamped, but the natural surface Z
  // is already higher and the clamp is a no-op — i.e., the toolpath sweeps
  // over deep tabs normally rather than skipping their XY footprint.
  const tabFootprints = buildExpandedTabFootprints(project, tool.radius)
  const minCutZAtPoint = (point: Point): number => {
    const floor = safeSubtractBottomZAtPoint(relatedSubtracts, point) ?? effectiveBottom
    const tabTop = tabTopZAtPoint(tabFootprints, point)
    return tabTop !== null ? Math.max(floor, tabTop) : floor
  }

  const strategyResult = isWaterline
    ? generateFinishSurfaceWaterline(
      project,
      operation,
      regionFeatures,
      tool,
      stepLevels,
      stlData,
      safeZ,
      effectiveBottom,
      modelTopZ,
      warnings,
      intersectingAdds,
      modelSilhouettePaths,
      relatedSubtracts,
      horizontalFloorZs,
    )
    : generateFinishSurfaceParallel(
      project,
      operation,
      modelFeature,
      regionFeatures,
      tool,
      transformedPos,
      index,
      stlData as FinishSurfaceParallelCacheHost,
      safeZ,
      minCutZAtPoint,
      warnings,
    )

  const finalMoves = strategyResult.moves
  const lastMove = finalMoves[finalMoves.length - 1]
  if (lastMove && lastMove.to.z !== safeZ) {
    retractToSafe(finalMoves, lastMove.to, safeZ)
  }

  let bounds: ToolpathBounds | null = null
  for (const move of finalMoves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }

  return {
    operationId: operation.id,
    moves: finalMoves,
    warnings,
    bounds,
    stepLevels: [...strategyResult.stepLevels].sort((a, b) => b - a),
  }
}
