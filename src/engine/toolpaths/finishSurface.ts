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
import type { PocketToolpathResult, ToolpathBounds } from './types'
import { getOperationSafeZ, normalizeToolForProject } from './geometry'
import { generateStepLevels, retractToSafe, updateBounds } from './pocket'
import { loadSTLTransformedGeometry } from '../csg'
import { splitFeatureTargets } from './regions'
import {
  offsetClipperPaths,
  relatedIntersectingAddFeatures,
  relatedSubtractFeatures,
  safeSubtractBottomZAtPoint,
} from './modelProtection'
import {
  generateFinishSurfaceParallel,
  modelSilhouettePathsForFinishSurface,
  type FinishSurfaceParallelCacheHost,
} from './finishSurfaceParallel'
import { generateFinishSurfaceWaterline } from './finishSurfaceWaterline'

export { maxContourGap } from './finishSurfaceWaterline'

export function generateFinishSurfaceToolpath(
  project: Project,
  operation: Operation,
): PocketToolpathResult {
  const target = operation.target
  if (target.source !== 'features' || target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Finish surface requires a model feature and optionally one or more region features'],
      bounds: null,
      stepLevels: [],
    }
  }

  const splitTargets = splitFeatureTargets(project, target.featureIds)
  if (splitTargets.missingFeatureIds.length > 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['One or more target features not found'],
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
      warnings: ['Finish surface requires an imported mesh model feature'],
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
      warnings: ['No tool assigned to this operation'],
      bounds: null,
      stepLevels: [],
    }
  }
  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Tool diameter must be greater than zero'],
      bounds: null,
      stepLevels: [],
    }
  }
  if (!(operation.stepdown > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Operation stepdown must be greater than zero'],
      bounds: null,
      stepLevels: [],
    }
  }

  const stlData = loadSTLTransformedGeometry(modelFeature, project)
  if (!stlData) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Failed to load model geometry'],
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
  const horizontalFloorZs = new Set<number>()
  if (operation.pocketPattern === 'waterline') {
    for (let i = 0; i < index.length; i += 3) {
      const z0 = transformedPos[index[i] * 3 + 2]
      const z1 = transformedPos[index[i + 1] * 3 + 2]
      const z2 = transformedPos[index[i + 2] * 3 + 2]
      if (Math.abs(z0 - z1) < 1e-6 && Math.abs(z1 - z2) < 1e-6) {
        horizontalFloorZs.add(z0)
      }
    }
  }

  const axialLeave = Math.max(0, operation.stockToLeaveAxial)
  let effectiveBottom = modelBottomZ + axialLeave
  if (effectiveBottom >= modelTopZ) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Axial stock-to-leave exceeds model height — nothing to cut'],
      bounds: null,
      stepLevels: [],
    }
  }

  const modelSilhouettePaths = modelSilhouettePathsForFinishSurface(modelFeature)
  const intersectingAdds = relatedIntersectingAddFeatures(
    project,
    new Set(target.featureIds),
    modelSilhouettePaths,
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
        warnings: ['Containing subtract feature leaves no finish depth for this model'],
        bounds: null,
        stepLevels: [],
      }
    }
  }

  // Waterline must reach above modelTopZ when an intersecting add feature
  // pokes higher than the mesh — those exposed walls live above the model
  // surface and need finishing too. For other strategies, keep modelTopZ as
  // the upper bound (parallel finish samples the model surface only).
  const stepLevelTopZ = operation.pocketPattern === 'waterline'
    ? Math.max(modelTopZ, intersectingAddTopMax)
    : modelTopZ
  let stepLevels = generateStepLevels(stepLevelTopZ, effectiveBottom, operation.stepdown)
  if (operation.pocketPattern === 'waterline') {
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
      warnings: ['No step levels generated'],
      bounds: null,
      stepLevels: [],
    }
  }

  const safeZ = getOperationSafeZ(project)
  const warnings: string[] = []
  const minCutZAtPoint = (point: Point): number => (
    safeSubtractBottomZAtPoint(relatedSubtracts, point) ?? effectiveBottom
  )

  const strategyResult = operation.pocketPattern === 'waterline'
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
