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

import ClipperLib from 'clipper-lib'
import type { Operation, Point, Project } from '../../types/project'
import type { ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import { applyContourDirection, checkMaxCutDepthWarning, DEFAULT_CLIPPER_SCALE, getOperationSafeZ, greedyNearestNeighbor, normalizeToolForProject, normalizeWinding, toClipperPath } from './geometry'
import { isFeatureFirst, mergeToolpathResults, perFeatureOperations } from './multiFeature'
import { appendClampBlockedWarnings, clampKeepOutPaths, clampsBlockingArea, differenceClipperPaths, unionClipperPaths } from './modelProtection'
import { buildContourLoops, buildInsetRegions, contourStartPoint, executeDifference, polyTreeToRegions, retractToSafe, toClosedCutMoves, transitionToCutEntry, updateBounds } from './pocket'
import { resolveRegionDomainArea } from './regionDomain'
import { buildRegionMask, splitFeatureTargets } from './regions'
import { resolvePocketRegions } from './resolver'
import { appendAll } from './appendAll'

function regionCentroid(region: { outer: Point[] }): { x: number; y: number } {
  let sx = 0
  let sy = 0
  for (const p of region.outer) { sx += p.x; sy += p.y }
  const n = region.outer.length || 1
  return { x: sx / n, y: sy / n }
}

/**
 * Re-order contours so each starts as close as possible (in XY) to where
 * the previous one ended.  Closed contours are rotated so the nearest
 * vertex becomes the entry point.
 */
function sortContoursNearestNeighbor(
  contours: Point[][],
  currentPosition: ToolpathPoint | null,
): Point[][] {
  if (contours.length <= 1) return contours

  const remaining = contours.slice()
  const sorted: Point[][] = []
  let curX = currentPosition?.x ?? 0
  let curY = currentPosition?.y ?? 0

  while (remaining.length > 0) {
    let bestIdx = 0
    let bestDist = Infinity
    let bestVertexIdx = 0

    for (let i = 0; i < remaining.length; i++) {
      const contour = remaining[i]
      for (let j = 0; j < contour.length; j++) {
        const d = Math.hypot(contour[j].x - curX, contour[j].y - curY)
        if (d < bestDist) {
          bestDist = d
          bestIdx = i
          bestVertexIdx = j
        }
      }
    }

    const chosen = remaining.splice(bestIdx, 1)[0]
    const rotated = bestVertexIdx > 0
      ? [...chosen.slice(bestVertexIdx), ...chosen.slice(0, bestVertexIdx)]
      : chosen
    sorted.push(rotated)

    curX = rotated[0].x
    curY = rotated[0].y
  }

  return sorted
}

function computeBounds(moves: ToolpathMove[]): ToolpathBounds | null {
  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }
  return bounds
}

export function generateVCarveToolpath(project: Project, operation: Operation): ToolpathResult {
  if (operation.kind !== 'v_carve') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [{ code: 'vcarveWrongKind' }],
      bounds: null,
    }
  }

  if (isFeatureFirst(operation, project)) {
    const parts = perFeatureOperations(operation, project).map((subOp) =>
      generateVCarveToolpathSingle(project, subOp),
    )
    return mergeToolpathResults(operation.id, parts, { orderBlocks: 'nearest' })
  }
  return generateVCarveToolpathSingle(project, operation)
}

function generateVCarveToolpathSingle(project: Project, operation: Operation): ToolpathResult {
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
      warnings: [...resolved.warnings, { code: 'vcarveNeedsVBit' }],
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

  if (!(operation.stepover > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, { code: 'contourSpacingPositive' }],
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
  // stepover is the absolute contour spacing distance in project units.
  const stepoverDistance = operation.stepover
  const direction = operation.cutDirection ?? 'conventional'
  const moves: ToolpathMove[] = []
  const warnings = [...resolved.warnings]
  const depthWarning = checkMaxCutDepthWarning(tool, operation.maxCarveDepth)
  if (depthWarning) {
    warnings.push(depthWarning)
  }
  let currentPosition: ToolpathPoint | null = null

  // Build the region mask from the operation's selected features and resolve
  // it into each band's domain before generation.  V-carve's cut width varies
  // with depth: a V-bit at depth d cuts a half-width of d·slope, and
  // buildInsetRegions erodes by currentDepth·slope.  We pass the maximum
  // carved half-width (maxCarveDepth·slope) as centreInset so the widest pass
  // still respects the region — shallower passes over-reach the region
  // boundary by at most (maxCarveDepth - currentDepth)·slope, which is the
  // coverage the include contract permits.
  const regionMask = operation.target.source === 'features'
    ? buildRegionMask(splitFeatureTargets(project, operation.target.featureIds).regionFeatures)
    : null
  const centreInset = operation.maxCarveDepth * slope

  for (const band of resolved.bands) {
    const maxBandDepth = Math.max(0, Math.min(operation.maxCarveDepth, band.topZ - band.bottomZ))
    if (!(maxBandDepth > 0)) {
      warnings.push({ code: 'vcarveBandNoDepth', params: { topZ: band.topZ, bottomZ: band.bottomZ } })
      continue
    }

    // Apply the region mask to this band's domain.
    // `expansion: tool.radius`, not `0` as the pocket uses: a V-carve's erosion
    // is the carved half-width at depth (`currentDepth * slope`), not the tool
    // radius, so it cannot be relied on to carry the radius the way the pocket's
    // `centreInset` does. `clamps.ts` judges the finished path against the full
    // tool radius — a V-bit's body is its nominal diameter well before it
    // reaches a clamp's height — so that is the clearance generation has to
    // provide. The carve erosion then rides on top, which leaves a little more
    // room than strictly required next to a clamp and none anywhere else.
    const clampKeepOut = clampKeepOutPaths(project, { z: band.bottomZ, expansion: tool.radius })
    if (regionMask || clampKeepOut.length > 0) {
      const scale = DEFAULT_CLIPPER_SCALE
      const outerPaths = band.regions.map((r) => toClipperPath(normalizeWinding(r.outer, false), scale))
      const bandDomain = unionClipperPaths(outerPaths)
      if (bandDomain.length === 0) continue

      // Clamps constrain the domain the same way an exclude region does, but they
      // are not user-orderable geometry: they are subtracted last, after the mask
      // has composed, so no ordering of regions can put material back under a
      // clamp. The clamps that actually removed area are named in a warning:
      // the cut silently stopping short is the failure #458 replaced, and an
      // unexplained gap in a pocket floor is not much better than a gouge.
      const regionDomain = resolveRegionDomainArea(bandDomain, regionMask, centreInset)
      let maskedDomain = regionDomain
      if (clampKeepOut.length > 0) {
        appendClampBlockedWarnings(
          warnings,
          clampsBlockingArea(project, regionDomain, { z: band.bottomZ, expansion: tool.radius }),
        )
        maskedDomain = differenceClipperPaths(regionDomain, clampKeepOut)
      }
      if (maskedDomain.length === 0) continue

      const islandPaths = band.regions.flatMap((r) =>
        r.islands.map((island) => toClipperPath(normalizeWinding(island, false), scale)),
      )
      const polyTree = executeDifference(maskedDomain, islandPaths)
      band.regions = polyTreeToRegions(polyTree, band.targetFeatureIds, band.islandFeatureIds, scale)
      if (band.regions.length === 0) continue
    }

    const vcarveJoinType = ClipperLib.JoinType.jtRound
    const sortedRegions = greedyNearestNeighbor(band.regions, {
      positionOf: regionCentroid,
      start: currentPosition ?? { x: 0, y: 0 },
    })

    for (const region of sortedRegions) {
      let currentDepth = Math.min(stepoverDistance / slope, maxBandDepth)
      let currentRegions = buildInsetRegions(region, currentDepth * slope, vcarveJoinType)

      while (currentRegions.length > 0 && currentDepth <= maxBandDepth + 1e-9) {
        const rawContours = buildContourLoops(currentRegions)
        if (rawContours.length === 0) {
          break
        }

        const contours = sortContoursNearestNeighbor(
          applyContourDirection(rawContours, direction),
          currentPosition,
        )
        const z = band.topZ - currentDepth
        for (const contour of contours) {
          const entryPoint = contourStartPoint(contour, z)
          // For cross-Z transitions (between depth levels) use a generous link
          // budget so the tool ramps diagonally to the next level rather than
          // retracting.  Curved features like "C" can shift the entry point
          // significantly between levels, so 8 × stepover is needed.
          // For same-Z transitions (multiple counter-loops at the same depth)
          // always retract: a direct cut between disjoint loops would gouge
          // across the gap and ruin the work piece.
          const isCrossZ = currentPosition !== null && Math.abs(currentPosition.z - z) > 1e-6
          const linkBudget = isCrossZ ? stepoverDistance * 8 : 0
          currentPosition = transitionToCutEntry(moves, currentPosition, entryPoint, safeZ, linkBudget)
          const cutMoves = toClosedCutMoves(contour, z)
          appendAll(moves, cutMoves)
          currentPosition = cutMoves.at(-1)?.to ?? currentPosition
        }
        currentDepth += stepoverDistance / slope
        if (currentDepth > maxBandDepth + 1e-9) {
          break
        }
        currentRegions = currentRegions.flatMap((r) => buildInsetRegions(r, stepoverDistance, vcarveJoinType))
      }
      // Retract once after completing all depth levels for this region.
      currentPosition = retractToSafe(moves, currentPosition, safeZ)
    }
  }

  if (moves.length === 0) {
    warnings.push({ code: 'vcarveNoMoves' })
  }

  return {
    operationId: operation.id,
    moves,
    warnings,
    bounds: computeBounds(moves),
  }
}
