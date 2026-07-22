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

/**
 * Medial-axis V-carve generator (`v_carve_medial`).
 *
 * Successor to the offset-stepping skeleton experiments (issue #177): the
 * skeleton is computed geometrically from the Voronoi diagram of a dense
 * boundary sampling (see ./medialAxis.ts), giving exact clearances and
 * therefore exact V-bit depths, natural junctions without topology-event
 * heuristics, and zero-depth tips in sharp convex corners.
 *
 * Boundary sampling resolution is derived from each resolved region's scale;
 * `operation.maxCarveDepth` clamps the depth in wide areas.
 */

import type { Operation, Point, Project } from '../../../types/project'
import type {
  ToolpathBounds,
  ToolpathMove,
  ToolpathPoint,
  ToolpathResult,
} from '../types'
import { checkMaxCutDepthWarning, getOperationSafeZ, normalizeToolForProject } from '../geometry'
import { isFeatureFirst, mergeToolpathResults, perFeatureOperations } from '../multiFeature'
import { updateBounds } from '../pocket'
import { resolvePocketRegions } from '../resolver'
import { computeMedialAxis } from './medialAxis'
import { resolveMedialResolution } from './resolution'
import { emitMedialToolpath } from './toolpath'

export * from './medialAxis'
export * from './resolution'
export { emitMedialToolpath, extractChains } from './toolpath'
export type { MedialToolpathParams } from './toolpath'

/** Empty-result refinement: halve the step at most this many times. */
const MAX_AUTO_REFINEMENTS = 2

function computeBounds(moves: ToolpathMove[]): ToolpathBounds | null {
  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }
  return bounds
}

function regionCentroid(region: { outer: Point[] }): { x: number; y: number } {
  let sx = 0
  let sy = 0
  for (const p of region.outer) { sx += p.x; sy += p.y }
  const n = region.outer.length || 1
  return { x: sx / n, y: sy / n }
}

function sortRegionsNearestNeighbor<T extends { outer: Point[] }>(
  regions: T[],
  currentPosition: ToolpathPoint | null,
): T[] {
  if (regions.length <= 1) return regions
  const remaining = regions.slice()
  const sorted: T[] = []
  let curX = currentPosition?.x ?? 0
  let curY = currentPosition?.y ?? 0

  while (remaining.length > 0) {
    let bestIdx = 0
    let bestDist = Infinity
    for (let i = 0; i < remaining.length; i += 1) {
      const c = regionCentroid(remaining[i])
      const d = Math.hypot(c.x - curX, c.y - curY)
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }
    const chosen = remaining.splice(bestIdx, 1)[0]
    const c = regionCentroid(chosen)
    curX = c.x
    curY = c.y
    sorted.push(chosen)
  }
  return sorted
}

export function generateVCarveMedialToolpath(project: Project, operation: Operation): ToolpathResult {
  if (operation.kind !== 'v_carve_medial') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'vcarveMedialWrongKind' }],
      bounds: null,
    }
  }

  if (isFeatureFirst(operation, project)) {
    const parts = perFeatureOperations(operation, project).map((subOp) =>
      generateVCarveMedialToolpathSingle(project, subOp),
    )
    return mergeToolpathResults(operation.id, parts, { orderBlocks: 'nearest' })
  }
  return generateVCarveMedialToolpathSingle(project, operation)
}

function generateVCarveMedialToolpathSingle(project: Project, operation: Operation): ToolpathResult {
  const resolved = resolvePocketRegions(project, operation)
  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null

  if (!toolRecord) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, { code: 'noToolAssigned' }],
      bounds: null,
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (tool.type !== 'v_bit') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, { code: 'vcarveMedialNeedsVBit' }],
      bounds: null,
    }
  }

  if (!(tool.vBitAngle && tool.vBitAngle > 0 && tool.vBitAngle < 180)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, { code: 'vBitAngleRange' }],
      bounds: null,
    }
  }

  if (!(operation.maxCarveDepth > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, { code: 'maxCarveDepthPositive' }],
      bounds: null,
    }
  }

  const halfAngleRadians = (tool.vBitAngle * Math.PI) / 360
  const slope = Math.tan(halfAngleRadians)
  if (!(slope > 1e-9)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, { code: 'vBitInvalidSlope' }],
      bounds: null,
    }
  }

  const safeZ = getOperationSafeZ(project)
  const moves: ToolpathMove[] = []
  const warnings = [...resolved.warnings]
  const depthWarning = checkMaxCutDepthWarning(tool, operation.maxCarveDepth)
  if (depthWarning) {
    warnings.push(depthWarning)
  }
  let budgetWarned = false
  let currentPosition: ToolpathPoint | null = null

  for (const band of resolved.bands) {
    const maxBandDepth = Math.max(0, Math.min(operation.maxCarveDepth, band.topZ - band.bottomZ))
    if (!(maxBandDepth > 0)) {
      warnings.push({ code: 'vcarveBandNoDepth', params: { topZ: band.topZ, bottomZ: band.bottomZ } })
      continue
    }

    const sortedRegions = sortRegionsNearestNeighbor(band.regions, currentPosition)
    for (const region of sortedRegions) {
      const resolvedResolution = resolveMedialResolution(region)
      if (!resolvedResolution) {
        warnings.push({ code: 'vcarveDegenerateRegion' })
        continue
      }

      let resolution = resolvedResolution.resolution
      if (resolvedResolution.budgetLimited) {
        if (!budgetWarned) {
          budgetWarned = true
          warnings.push({ code: 'vcarveSamplingBudget', params: { resolution: resolution.toFixed(3) } })
        }
      }

      let graph = computeMedialAxis(
        { outer: region.outer, islands: region.islands },
        { resolution },
      )
      // A region narrower than the sampling step can miss interior Voronoi
      // vertices entirely — retry at a finer step before giving up.
      for (let attempt = 0; graph.nodes.length === 0 && attempt < MAX_AUTO_REFINEMENTS; attempt += 1) {
        const refinedResolution = Math.max(resolvedResolution.budgetFloor, resolution / 2)
        if (!(refinedResolution < resolution)) break
        resolution = refinedResolution
        graph = computeMedialAxis(
          { outer: region.outer, islands: region.islands },
          { resolution },
        )
      }
      if (graph.nodes.length === 0) {
        warnings.push({ code: 'vcarveNoMedialAxis' })
        continue
      }

      currentPosition = emitMedialToolpath(
        graph,
        {
          topZ: band.topZ,
          maxDepth: maxBandDepth,
          slope,
          safeZ,
          simplifyTolerance: resolution * 0.25,
          enableChainLinks: true,
          redundancyTolerance: resolution * 0.75,
          debugSource: operation.debugToolpath === true ? 'medial-axis' : undefined,
        },
        moves,
        currentPosition,
      )
    }
  }

  if (moves.length === 0) {
    warnings.push({ code: 'vcarveMedialNoMoves' })
  }

  return {
    operationId: operation.id,
    moves,
    warnings,
    bounds: computeBounds(moves),
    debugToolpath: operation.debugToolpath === true,
  }
}
