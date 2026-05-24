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

import type { Project } from '../../types/project'
import type { Operation } from '../../types/project'
import type { PocketToolpathResult, ToolpathBounds, ToolpathMove, ToolpathPoint } from './types'
import { cutOffsetRegionRecursive, orderRegionsGreedy, retractToSafe, updateBounds } from './pocket'
import { offsetClipperPaths, segmentInsideClipperPaths } from './modelProtection'
import { resolve3DSurfaceStepdown } from './surfaceStepdown3d'

export function generateRoughSurfaceToolpath(
  project: Project,
  operation: Operation,
): PocketToolpathResult {
  const resolvedResult = resolve3DSurfaceStepdown(project, operation, {
    operationLabel: 'Rough surface',
  })
  if (!resolvedResult.ok) {
    return resolvedResult.result
  }

  const { resolved } = resolvedResult
  const allMoves: ToolpathMove[] = []
  const allStepLevels = new Set<number>()
  const warnings = [...resolved.warnings]
  let currentPosition: ToolpathPoint | null = null

  for (const level of resolved.levels) {
    allStepLevels.add(level.z)

    const safeLinkPaths = offsetClipperPaths(level.clearablePaths, -resolved.tool.radius)
    const safeLinkSampleSpacing = Math.max(resolved.tool.radius * 0.5, resolved.effectiveStepover * 0.25)
    const safeLinkCheck = safeLinkPaths.length > 0
      ? (from: ToolpathPoint, to: ToolpathPoint): boolean =>
          segmentInsideClipperPaths(safeLinkPaths, from, to, safeLinkSampleSpacing)
      : undefined

    const orderedRegions = orderRegionsGreedy(
      level.insetRegions,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )

    for (const region of orderedRegions) {
      currentPosition = cutOffsetRegionRecursive(
        allMoves,
        region,
        level.z,
        resolved.safeZ,
        resolved.effectiveStepover,
        resolved.maxLinkDistance,
        currentPosition,
        resolved.direction,
        safeLinkCheck,
      )
    }
  }

  if (currentPosition && currentPosition.z !== resolved.safeZ) {
    retractToSafe(allMoves, currentPosition, resolved.safeZ)
  }

  let bounds: ToolpathBounds | null = null
  for (const move of allMoves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }

  return {
    operationId: resolved.operationId,
    moves: allMoves,
    warnings,
    bounds,
    stepLevels: [...allStepLevels].sort((a, b) => b - a),
  }
}
