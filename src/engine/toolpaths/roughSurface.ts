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
import { createEntryPolicy, withEntryHandoffFeedScale } from './entry'
import {
  applyLevelFeed,
  buildContourLoops,
  buildOffsetRegionTree,
  buildPocketParallelSegments,
  contourStartPoint,
  cutOffsetRegionNode,
  cutOffsetRegionRecursive,
  orderClosedContoursGreedy,
  orderOpenSegmentsGreedy,
  orderRegionsGreedy,
  resolveSlotFeedScale,
  retractToSafe,
  rotateContourToNearestEntry,
  toClosedCutMoves,
  toOpenCutMoves,
  transitionToCutEntry,
  updateBounds,
  SLOT_FEED_ADJACENCY_FACTOR,
  SLOT_FEED_ENGAGEMENT_FACTOR,
  SLOT_FEED_OWN_TRAIL_FACTOR,
} from './pocket'
import { cornerSmoothingRadius } from './offsetSmoothing'
import { offsetClipperPaths, segmentInsideClipperPaths } from './modelProtection'
import { resolve3DSurfaceStepdown } from './surfaceStepdown3d'
import { areaCoverage, effectivePocketPattern, usesTangentLinks } from './pocketPatterns'
import { pocketTangentLinkOptions } from './tangentLink'
import { planSeedCircles, seedCircleContours, seedStartRadius } from './seedClearing'
import { applyContourDirection } from './geometry'
import { EngagementTelemetryAccumulator, nominalEngagement } from './engagement'
import type { ToolpathWarning } from './warningCodes'
import { isFeatureFirst, perFeatureOperations, mergePocketToolpathResults } from './multiFeature'
import { createSharedEngagementTelemetry } from './pocket'
import { resolvedFeatureMap } from '../../store/helpers/resolveFeatures'
import { clearingControlApplies } from './clearingControls'

function appendUniqueWarning(warnings: ToolpathWarning[], warning: ToolpathWarning): void {
  const key = `${warning.code}:${JSON.stringify(warning.params ?? {})}`
  if (!warnings.some((entry) => `${entry.code}:${JSON.stringify(entry.params ?? {})}` === key)) {
    warnings.push(warning)
  }
}

/**
 * Whether every part of a per-feature split would still carry a mesh to rough.
 *
 * This kind's target validity is `.some(model)` among its machining features
 * (`operationDefaults.ts:189`), so a target of one STL model plus an `add`
 * feature is legal and has always roughed as a single operation. Splitting it
 * hands one part the model and the other nothing to slice, and that part
 * resolves to `surface3dNotMesh` — a warning on an operation that plainly has
 * a mesh, raised on saved projects because `machiningOrder` is stored
 * `feature_first` by default (`operationDefaults.ts:350`).
 *
 * Region features never reach this question: `perFeatureOperations` carries
 * them into every part rather than splitting on them.
 */
function everyPartKeepsAMesh(project: Project, parts: Operation[]): boolean {
  const featuresById = resolvedFeatureMap(project)
  return parts.every((part) => part.target.source === 'features'
    && part.target.featureIds.some((featureId) => {
      const feature = featuresById.get(featureId)
      return feature?.operation === 'model' && feature.kind === 'stl'
    }))
}

export function generateRoughSurfaceToolpath(
  project: Project,
  operation: Operation,
): PocketToolpathResult {
  const featureFirstParts = isFeatureFirst(operation, project)
    ? perFeatureOperations(operation, project)
    : []
  if (featureFirstParts.length > 1 && everyPartKeepsAMesh(project, featureFirstParts)) {
    const parts = featureFirstParts
    const sharedTelemetry = createSharedEngagementTelemetry(project, operation)
    const merged = mergePocketToolpathResults(
      operation.id,
      parts.map((subOp) => generateRoughSurfaceToolpathSingle(project, subOp, sharedTelemetry)),
      { orderBlocks: 'nearest' },
    )
    return sharedTelemetry
      ? { ...merged, engagementTelemetry: sharedTelemetry.toTelemetry() }
      : merged
  }
  return generateRoughSurfaceToolpathSingle(project, operation)
}

function generateRoughSurfaceToolpathSingle(
  project: Project,
  operation: Operation,
  sharedTelemetry?: EngagementTelemetryAccumulator | null,
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
  // Feed reduction (issue #619). The declaration decides whether this kind
  // offers the control at all; `resolveSlotFeedScale` reads it, so there is no
  // kind test here. Both the slot classifier and the engagement quantizer live
  // in `applyLevelFeed`, applied once per cleared level over that level's own
  // moves — the same shape `surface.ts` uses.
  const slotScale = resolveSlotFeedScale(operation)
  const slotDistance = Math.max(
    resolved.tool.diameter * SLOT_FEED_ENGAGEMENT_FACTOR,
    resolved.effectiveStepover * SLOT_FEED_ADJACENCY_FACTOR,
  )
  const ownTrailTolerance = resolved.effectiveStepover * SLOT_FEED_OWN_TRAIL_FACTOR
  const telemetry = sharedTelemetry !== undefined
    ? sharedTelemetry
    : operation.pocketFeedReduction === 'engagement'
      ? new EngagementTelemetryAccumulator(nominalEngagement(resolved.effectiveStepover, resolved.tool.radius))
    : null
  const applyFeedForLevel = (startIndex: number): void => {
    applyLevelFeed(
      allMoves,
      startIndex,
      operation,
      slotScale,
      slotDistance,
      ownTrailTolerance,
      resolved.tool.diameter,
      resolved.effectiveStepover,
      telemetry,
    )
  }
  let currentPosition: ToolpathPoint | null = null

  // Wall-corner cleanup (issue #633). The declaration decides whether this kind
  // offers the control; the gate mirrors surface.ts's exactly.
  const wallCleanup = clearingControlApplies(operation.kind, 'cleanWallCorners') && operation.roundOutsideCorners
    && operation.cleanWallCorners === true
    ? {
        enabled: true as const,
        onFallback: (): void => appendUniqueWarning(warnings, { code: 'pocketWallCornerCleanupFallback' }),
      }
    : undefined

  for (const level of resolved.levels) {
    const levelStartIndex = allMoves.length
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

    // Tangential S-links for rough_surface rings (issue #621). The domain is
    // the level's own inset regions — the same clearable boundary the per-level
    // safeLinkCheck enforces for straight links. A link that leaves it drives
    // the cutter through standing stock.
    const levelTangentLink = usesTangentLinks(operation.kind, operation.pocketPattern) && operation.roundLinkCorners
      ? pocketTangentLinkOptions(
        operation.roundLinkCorners,
        resolved.tool.diameter,
        level.insetRegions,
      )
      : undefined

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
      // The level boundary is cut first, exactly as the pocket and surface_clean
      // raster branches do: scanlines alone leave a scalloped ridge of standing
      // stock at the silhouette on every level, while the offset pattern's
      // outermost ring is that same contour. Contours are rebuilt per level
      // because 3D roughing has no level-independent footprint to reuse.
      const boundaryContours = orderedRegions.length > 0
        ? applyContourDirection(buildContourLoops(orderedRegions), resolved.direction)
        : []
      const segments = orderedRegions.length > 0
        ? buildPocketParallelSegments(orderedRegions, resolved.effectiveStepover, operation.pocketAngle)
        : []
      if (boundaryContours.length === 0 && segments.length === 0) {
        continue
      }
      // The entry hands off at the reduced feed when one applies, so the first
      // cut after a plunge is not run at full feed into a slot.
      const entryPolicy = withEntryHandoffFeedScale(
        createEntryPolicy(
          operation,
          resolved.tool.diameter,
          orderedRegions,
          (warning) => appendUniqueWarning(warnings, warning),
        ),
        slotScale,
      )

      const orderedBoundaryContours = orderClosedContoursGreedy(
        boundaryContours,
        currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
      )
      for (const contour of orderedBoundaryContours) {
        currentPosition = transitionToCutEntry(
          allMoves,
          currentPosition,
          contourStartPoint(contour, level.z),
          resolved.safeZ,
          resolved.maxLinkDistance,
          safeLinkCheck,
          entryPolicy,
        )
        const cutMoves = toClosedCutMoves(contour, level.z)
        allMoves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      }

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

      applyFeedForLevel(levelStartIndex)
      continue
    }

    for (const region of orderedRegions) {
      const entryPolicy = withEntryHandoffFeedScale(
        createEntryPolicy(
          operation,
          resolved.tool.diameter,
          [region],
          (warning) => appendUniqueWarning(warnings, warning),
        ),
        slotScale,
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
          levelTangentLink,
          wallCleanup,
          resolved.tool.radius,
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
        levelTangentLink,
        wallCleanup,
        resolved.tool.radius,
      )
    }

    // After every region on this level, never per region: the classifier reads
    // the level's whole move range to decide what was already cleared.
    applyFeedForLevel(levelStartIndex)
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
    ...(!sharedTelemetry && telemetry ? { engagementTelemetry: telemetry.toTelemetry() } : {}),
  }
}
