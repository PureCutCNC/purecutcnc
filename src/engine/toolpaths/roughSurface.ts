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
import type { Project } from '../../types/project'
import type { Operation } from '../../types/project'
import type { PocketToolpathResult, ResolvedPocketRegion, ToolpathBounds, ToolpathMove, ToolpathPoint } from './types'
import { createEntryPolicy } from './entry'
import {
  buildOffsetRegionTree,
  buildPocketParallelSegments,
  contourStartPoint,
  cutOffsetRegionNode,
  cutOffsetRegionRecursive,
  orderOpenSegmentsGreedy,
  orderRegionsGreedy,
  retractToSafe,
  rotateContourToNearestEntry,
  toClosedCutMoves,
  toOpenCutMoves,
  transitionToCutEntry,
  updateBounds,
} from './pocket'
import { cornerSmoothingRadius } from './offsetSmoothing'
import { offsetClipperPaths, segmentInsideClipperPaths } from './modelProtection'
import { resolve3DSurfaceStepdown } from './surfaceStepdown3d'
import { areaCoverage, effectivePocketPattern } from './pocketPatterns'
import { planSeedCircles, seedCircleContours, seedStartRadius } from './seedClearing'
import { applyContourDirection } from './geometry'
import type { ToolpathWarning } from './warningCodes'

function appendUniqueWarning(warnings: ToolpathWarning[], warning: ToolpathWarning): void {
  const key = `${warning.code}:${JSON.stringify(warning.params ?? {})}`
  if (!warnings.some((entry) => `${entry.code}:${JSON.stringify(entry.params ?? {})}` === key)) {
    warnings.push(warning)
  }
}

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
  const smoothRadius = cornerSmoothingRadius(
    operation.roundOutsideCorners,
    resolved.tool.radius,
    resolved.effectiveStepover,
  )
  const islandJoinType = operation.roundOutsideCorners
    ? ClipperLib.JoinType.jtRound
    : ClipperLib.JoinType.jtMiter
  // What the stored pattern clears with (issue #618). The declared table is the
  // only gate; before it this generator hard-coded concentric rings no matter
  // what was stored — the exact panel-offers/generator-ignores split #609
  // shipped three times elsewhere.
  const coverage = areaCoverage(effectivePocketPattern(operation.kind, operation.pocketPattern))
  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const seedStart = coverage.seedCircles ? seedStartRadius(operation, resolved.tool.radius) : 0
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

    // No withEntryStartZ() here, unlike pocket and surface clearing. Those
    // reuse one XY footprint for every level, so the previous level's floor is
    // guaranteed cleared and the entry can start just above it. 3D roughing
    // recomputes the clearable region per level, so a level can expose area the
    // level above never cut — descending to the previous cut Z there would
    // drive the tool through standing stock. Entry stays at the global safe Z
    // until that containment is proven per level.
    //
    // That protection is pattern-independent and guards every branch below:
    // entries synthesize against this level's own regions, and every link that
    // stays at depth must pass this level's safeLinkCheck or the transition
    // retracts to safe Z first. A raster shortcut across standing stock is
    // rejected exactly like a ring-to-ring one.

    if (coverage.rasterSegments) {
      const segments = orderedRegions.length > 0
        ? buildPocketParallelSegments(orderedRegions, resolved.effectiveStepover, operation.pocketAngle)
        : []
      if (segments.length === 0) {
        continue
      }
      const entryPolicy = createEntryPolicy(
        operation,
        resolved.tool.diameter,
        orderedRegions,
        (warning) => appendUniqueWarning(warnings, warning),
      )
      const orderedSegments = orderOpenSegmentsGreedy(
        segments,
        currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
      )
      for (const segment of orderedSegments) {
        currentPosition = transitionToCutEntry(
          allMoves,
          currentPosition,
          contourStartPoint(segment, level.z),
          resolved.safeZ,
          resolved.maxLinkDistance,
          safeLinkCheck,
          entryPolicy,
        )
        const cutMoves = toOpenCutMoves(segment, level.z)
        allMoves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      }
      continue
    }

    for (const region of orderedRegions) {
      const entryPolicy = createEntryPolicy(
        operation,
        resolved.tool.diameter,
        [region],
        (warning) => appendUniqueWarning(warnings, warning),
      )
      const cutRingsForRegion = (
        target: ResolvedPocketRegion,
        from: ToolpathPoint | null,
      ): ToolpathPoint | null =>
        cutOffsetRegionRecursive(
          allMoves,
          target,
          level.z,
          resolved.safeZ,
          resolved.effectiveStepover,
          resolved.maxLinkDistance,
          from,
          resolved.direction,
          safeLinkCheck,
          'outer-first',
          smoothRadius,
          islandJoinType,
          entryPolicy,
        )

      const plans = coverage.seedCircles && seedStart > 0
        ? planSeedCircles(region, seedStart, resolved.effectiveStepover, resolved.tool.radius * 2, radialLeave)
        : []
      if (plans.length === 0) {
        // Plain offset, or seeded_offset where no open area schedules three
        // circles: the shipped rings, unchanged.
        currentPosition = cutRingsForRegion(region, currentPosition)
        continue
      }

      // Phase 1 (issue #554): full circles innermost first, one independent
      // stack per open area. Every cross-stack transition retracts — a stack's
      // internal links are safe only over the disc the stack itself cleared.
      for (const plan of plans) {
        currentPosition = retractToSafe(allMoves, currentPosition, resolved.safeZ)
        const circles = applyContourDirection(
          seedCircleContours(plan, resolved.effectiveStepover),
          resolved.direction,
        )
        let previousCircleEnd: ToolpathPoint | null = null
        for (const baseCircle of circles) {
          const circle = rotateContourToNearestEntry(baseCircle, previousCircleEnd ?? currentPosition)
          currentPosition = transitionToCutEntry(
            allMoves,
            currentPosition,
            contourStartPoint(circle, level.z),
            resolved.safeZ,
            resolved.maxLinkDistance,
            undefined,
            entryPolicy,
          )
          const circleMoves = toClosedCutMoves(circle, level.z)
          allMoves.push(...circleMoves)
          currentPosition = circleMoves.at(-1)?.to ?? currentPosition
          previousCircleEnd = currentPosition
        }
      }

      // Phase 2: the ring tree offsets around each extended seed island, but
      // the root keeps its own island list so the laps phase 1 already ran are
      // not cut a second time (the same construction pocket uses).
      const seededTree = buildOffsetRegionTree(
        { ...region, islands: [...region.islands, ...plans.map((plan) => plan.island)] },
        resolved.effectiveStepover,
        islandJoinType,
      )
      currentPosition = cutOffsetRegionNode(
        allMoves,
        { region, children: seededTree.children },
        level.z,
        resolved.safeZ,
        resolved.maxLinkDistance,
        currentPosition,
        resolved.direction,
        safeLinkCheck,
        'outer-first',
        'all',
        smoothRadius,
        0,
        entryPolicy,
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
