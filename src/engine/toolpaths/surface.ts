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
import type { ToolpathWarning } from './warningCodes'
import type { CutDirection, Operation, Project, SketchFeature } from '../../types/project'
import { createEntryPolicy, withEntryStartZ, withEntryHandoffFeedScale } from './entry'
import type {
  ClipperPath,
  PocketToolpathResult,
  ResolvedPocketBand,
  ResolvedPocketRegion,
  ResolvedPocketResult,
  ToolpathBounds,
  ToolpathMove,
  ToolpathPoint,
} from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  applyContourDirection,
  checkMaxCutDepthWarning,
  flattenProfile,
  getOperationClearance,
  getOperationSafeZ,
  normalizeToolForProject,
  normalizeWinding,
  resolveFeatureZSpan,
  toClipperPath,
} from './geometry'
import {
  applyLevelFeed,
  buildContourLoops,
  buildInsetRegions,
  buildOffsetBandEngagementClassification,
  buildOffsetRegionTree,
  buildOffsetUnitFrontier,
  buildPocketParallelSegments,
  buildRingPerimeterIndex,
  contourStartPoint,
  createSharedEngagementTelemetry,
  cutSeedLeftoverExcursions,
  cutOffsetNodeRings,
  cutOffsetRegionNode,
  executeDifference,
  generateStepLevels,
  nextRoughSection,
  offsetSectionEntryPoint,
  offsetUnitEntryPoint,
  orderClosedContoursGreedy,
  orderNodesGreedy,
  orderOpenSegmentsGreedy,
  planRegionSeedLeftovers,
  polyTreeToRegions,
  retractToSafe,
  resolveBandBottomZ,
  resolveSlotFeedScale,
  rotateContourToNearestEntry,
  SLOT_FEED_ADJACENCY_FACTOR,
  SLOT_FEED_ENGAGEMENT_FACTOR,
  SLOT_FEED_OWN_TRAIL_FACTOR,
  spliceTangentSLink,
  toClosedCutMoves,
  toOpenCutMoves,
  transitionToCutEntry,
  updateBounds,
} from './pocket'
import type { OffsetRegionNode } from './pocket'
import { EngagementTelemetryAccumulator, nominalEngagement } from './engagement'
import { pocketTangentLinkOptions } from './tangentLink'
import { seedStartRadius, planSeedCircles, seedCircleContours } from './seedClearing'
import { areaCoverage, effectivePocketPattern, usesTangentLinks } from './pocketPatterns'
import { clearingControlApplies } from './clearingControls'
import type { SeedCirclePlan } from './seedClearing'
import { cornerSmoothingRadius } from './offsetSmoothing'
import {
  buildRegionMask,
  splitFeatureTargets,
} from './regions'
import { resolveRegionDomainCentre } from './regionDomain'
import { unionClipperPaths } from './modelProtection'
import { expandFeatureGeometry, featureHasClosedGeometry } from '../../text'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { isFeatureFirst, perFeatureOperations, mergePocketToolpathResults } from './multiFeature'

interface PolyTreeNode {
  IsHole(): boolean
  Contour(): ClipperPath
  Childs?: () => PolyTreeNode[]
  m_Childs?: PolyTreeNode[]
}

interface SurfaceCleanBand extends ResolvedPocketBand {
  subjectPaths: ClipperPath[]
  protectedPaths: ClipperPath[]
  regionMask: ReturnType<typeof buildRegionMask>
}

interface SurfaceCleanResult {
  operationId: string
  units: ResolvedPocketResult['units']
  bands: SurfaceCleanBand[]
  regionMask: ReturnType<typeof buildRegionMask>
  warnings: ToolpathWarning[]
}

function appendUniqueWarning(warnings: ToolpathWarning[], warning: ToolpathWarning): void {
  const key = `${warning.code}:${JSON.stringify(warning.params ?? {})}`
  if (!warnings.some((entry) => `${entry.code}:${JSON.stringify(entry.params ?? {})}` === key)) {
    warnings.push(warning)
  }
}

function executeClip(
  subjectPaths: ClipperPath[],
  clipPaths: ClipperPath[],
  clipType: number,
): PolyTreeNode {
  const clipper = new ClipperLib.Clipper()
  if (subjectPaths.length > 0) {
    clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  }
  if (clipPaths.length > 0) {
    clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  }

  const polyTree = new ClipperLib.PolyTree()
  clipper.Execute(
    clipType,
    polyTree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return polyTree as PolyTreeNode
}

function executeClipPaths(
  subjectPaths: ClipperPath[],
  clipPaths: ClipperPath[],
  clipType: number,
): ClipperPath[] {
  const clipper = new ClipperLib.Clipper()
  if (subjectPaths.length > 0) {
    clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  }
  if (clipPaths.length > 0) {
    clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  }

  const solution = new ClipperLib.Paths()
  clipper.Execute(
    clipType,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution as ClipperPath[]
}

function offsetPaths(paths: ClipperPath[], delta: number): ClipperPath[] {
  if (paths.length === 0) {
    return []
  }

  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta)
  return solution as ClipperPath[]
}

function flattenProfileToClipperPath(profile: SketchFeature['sketch']['profile'], scale = DEFAULT_CLIPPER_SCALE): ClipperPath {
  const flattened = flattenProfile(profile)
  return toClipperPath(normalizeWinding(flattened.points, false), scale)
}

function buildSurfaceCoverageRegions(
  subjectPaths: ClipperPath[],
  protectedPaths: ClipperPath[],
  regions: ResolvedPocketBand['regions'],
  toolRadius: number,
): ResolvedPocketRegion[] {
  const scale = DEFAULT_CLIPPER_SCALE

  if (subjectPaths.length === 0) {
    return []
  }

  // Expand the original subject and protected paths before subtraction so the
  // tool centre path respects the true protected-feature boundary rather than
  // the already-clipped edge.  AllowedArea = Offset(Subject, +r) - Offset(Protected, +r)
  const expandedSubjectPaths = offsetPaths(subjectPaths, toolRadius * scale)
  if (expandedSubjectPaths.length === 0) {
    return []
  }

  const expandedProtectedPaths = offsetPaths(protectedPaths, toolRadius * scale)
  const polyTree = executeClip(expandedSubjectPaths, expandedProtectedPaths, ClipperLib.ClipType.ctDifference)

  const targetFeatureIds = [...new Set(regions.flatMap((r) => r.targetFeatureIds))]
  const islandFeatureIds = [...new Set(regions.flatMap((r) => r.islandFeatureIds))]

  return polyTreeToRegions(polyTree, targetFeatureIds, islandFeatureIds, scale)
    .filter((region) => region.outer.length >= 3)
}

function resolveSurfaceCleanRegions(project: Project, operation: Operation): SurfaceCleanResult {
  const warnings: ToolpathWarning[] = []

  if (operation.kind !== 'surface_clean') {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      regionMask: null,
      warnings: [{ code: 'surfaceCleanWrongKind' }],
    }
  }

  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      regionMask: null,
      warnings: [{ code: 'surfaceCleanNoTargets' }],
    }
  }

  const splitTargets = splitFeatureTargets(project, operation.target.featureIds)
  const regionMask = buildRegionMask(splitTargets.regionFeatures)
  const selectedTargetFeatures = splitTargets.machiningFeatures
  const validTargetSourceFeatures = selectedTargetFeatures
    .filter((feature) => feature.operation === 'add' || feature.operation === 'model')

  const targetFeatures = validTargetSourceFeatures
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'add')
    .map((feature) => {
      const span = resolveFeatureZSpan(project, feature)
      return { feature, top: span.max }
    })

  if (validTargetSourceFeatures.length !== selectedTargetFeatures.length || splitTargets.missingFeatureIds.length > 0) {
    warnings.push({ code: 'surfaceTargetsWrongRole' })
  }

  const closedTargetFeatures = targetFeatures.filter(({ feature }) => featureHasClosedGeometry(feature))
  if (closedTargetFeatures.length !== targetFeatures.length) {
    warnings.push({ code: 'surfaceClosedProfilesOnly' })
  }

  if (closedTargetFeatures.length === 0) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      regionMask,
      warnings: [...warnings, { code: 'surfaceCleanNoValidTargets' }],
    }
  }

  const allAddFeatures = resolvedProjectFeatures(project)
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'add' && featureHasClosedGeometry(feature))
    .map((feature) => {
      const span = resolveFeatureZSpan(project, feature)
      return { feature, top: span.max }
    })

  const depthLevels = [...new Set([project.stock.thickness, ...closedTargetFeatures.map(({ top }) => top)])]
    .sort((a, b) => b - a)
  const bands: SurfaceCleanBand[] = []

  for (let index = 0; index < depthLevels.length - 1; index += 1) {
    const topZ = depthLevels[index]
    const bottomZ = depthLevels[index + 1]
    if (Math.abs(topZ - bottomZ) <= Number.EPSILON) {
      continue
    }

    const activeTargets = closedTargetFeatures.filter(({ top }) => top <= bottomZ)
    if (activeTargets.length === 0) {
      continue
    }

    let subjectPaths = activeTargets.map(({ feature }) => flattenProfileToClipperPath(feature.sketch.profile))
    // Protect any add feature whose top is above this band's floor — including
    // target features at higher levels that haven't been reached yet. Otherwise
    // the expanded subject of a lower target can sweep through a taller target.
    const activeTargetIdSet = new Set(activeTargets.map(({ feature }) => feature.id))
    const protectedFeatures = allAddFeatures.filter(({ top, feature }) => top > bottomZ && !activeTargetIdSet.has(feature.id))
    const protectedPaths = protectedFeatures.map(({ feature }) => flattenProfileToClipperPath(feature.sketch.profile))
    subjectPaths = executeClipPaths(subjectPaths, protectedPaths, ClipperLib.ClipType.ctDifference)
    const polyTree = executeClip(subjectPaths, [], ClipperLib.ClipType.ctUnion)
    const regions = polyTreeToRegions(
      polyTree,
      activeTargets.map(({ feature }) => feature.id),
      protectedFeatures.map(({ feature }) => feature.id),
    )

    if (regions.length === 0) {
      warnings.push({ code: 'bandNoRegions', params: { topZ, bottomZ } })
      continue
    }

    bands.push({
      topZ,
      bottomZ,
      targetFeatureIds: activeTargets.map(({ feature }) => feature.id),
      islandFeatureIds: protectedFeatures.map(({ feature }) => feature.id),
      regions,
      subjectPaths,
      protectedPaths,
      regionMask,
    })
  }

  if (bands.length === 0) {
    warnings.push({ code: 'surfaceNoBands' })
  }

  return {
    operationId: operation.id,
    units: project.meta.units,
    bands,
    regionMask,
    warnings,
  }
}

function generateRoughBandMoves(
  band: SurfaceCleanBand,
  operation: Operation,
  safeZ: number,
  entryClearance: number,
  stepdown: number,
  toolRadius: number,
  stepoverDistance: number,
  maxLinkDistance: number,
  direction: CutDirection = 'conventional',
  telemetry: EngagementTelemetryAccumulator | null = null,
): { moves: ToolpathMove[]; stepLevels: number[]; warnings: ToolpathWarning[] } {
  const moves: ToolpathMove[] = []
  const warnings: ToolpathWarning[] = []
  const effectiveBottom = resolveBandBottomZ(band, operation)
  if (effectiveBottom === null) {
    return {
      moves,
      stepLevels: [],
      warnings: [{ code: 'surfaceBandNoRoughDepth', params: { topZ: band.topZ, bottomZ: band.bottomZ } }],
    }
  }

  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  let coverageRegions = buildSurfaceCoverageRegions(band.subjectPaths, band.protectedPaths, band.regions, toolRadius)
  // Apply region mask after toolRadius expansion.  coverageRegions is already
  // a tool-centre domain, so both polarities must dilate by the remaining
  // clearance (toolRadius + radialLeave) — no further erosion will happen.
  if (band.regionMask) {
    const scale = DEFAULT_CLIPPER_SCALE
    const domainPaths = coverageRegions
      .flatMap((r) => r.outer.length >= 3 ? [toClipperPath(normalizeWinding(r.outer, false), scale)] : [])
    if (domainPaths.length === 0) {
      return { moves, stepLevels: [], warnings: [{ code: 'surfaceNoOffsetContours', params: { topZ: band.topZ, bottomZ: band.bottomZ } }] }
    }
    const domain = unionClipperPaths(domainPaths).filter((p) => p.length >= 2)
    if (domain.length === 0) {
      return { moves, stepLevels: [], warnings: [{ code: 'surfaceNoOffsetContours', params: { topZ: band.topZ, bottomZ: band.bottomZ } }] }
    }
    const maskedDomain = resolveRegionDomainCentre(domain, band.regionMask, toolRadius + radialLeave)
      .filter((p) => p.length >= 2)
    if (maskedDomain.length === 0) {
      return { moves, stepLevels: [], warnings: [{ code: 'surfaceNoOffsetContours', params: { topZ: band.topZ, bottomZ: band.bottomZ } }] }
    }
    const polyTree = executeDifference(maskedDomain, [])
    coverageRegions = polyTreeToRegions(polyTree, band.targetFeatureIds, band.islandFeatureIds, scale)
      .filter((r) => r.outer.length >= 3)
    if (coverageRegions.length === 0) {
      return { moves, stepLevels: [], warnings: [{ code: 'surfaceNoOffsetContours', params: { topZ: band.topZ, bottomZ: band.bottomZ } }] }
    }
  }
  const initialInset = radialLeave
  // What the stored pattern actually clears with (issue #609): the declared
  // table decides, so the raster branch below and the seed gate further down
  // can no longer disagree about which patterns exist.
  const roughCoverage = areaCoverage(effectivePocketPattern(operation.kind, operation.pocketPattern))
  const stepLevels = generateStepLevels(band.topZ, effectiveBottom, stepdown)
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const effectiveStepover = Math.max(stepoverDistance, minStepover)
  let currentPosition: ToolpathPoint | null = null
  const slotScale = resolveSlotFeedScale(operation)
  const slotDistance = Math.max(
    toolRadius * 2 * SLOT_FEED_ENGAGEMENT_FACTOR,
    effectiveStepover * SLOT_FEED_ADJACENCY_FACTOR,
  )

  if (roughCoverage.rasterSegments) {
    const roughRegions = coverageRegions.flatMap((region) => buildInsetRegions(region, initialInset))
    if (roughRegions.length === 0) {
      return {
        moves,
        stepLevels,
        warnings: [{ code: 'surfaceNoCleanupRegion', params: { topZ: band.topZ, bottomZ: band.bottomZ } }],
      }
    }

    const boundaryContours = applyContourDirection(buildContourLoops(roughRegions), direction)
    const segments = buildPocketParallelSegments(roughRegions, effectiveStepover, operation.pocketAngle)
    const entryPolicy = withEntryHandoffFeedScale(
      createEntryPolicy(
        operation,
        toolRadius * 2,
        roughRegions,
        (warning) => appendUniqueWarning(warnings, warning),
      ),
      slotScale,
    )
    if (segments.length === 0) {
      return {
        moves,
        stepLevels,
        warnings: [{ code: 'surfaceNoCleanupSegments', params: { topZ: band.topZ, bottomZ: band.bottomZ } }],
      }
    }

    for (let levelIndex = 0; levelIndex < stepLevels.length; levelIndex += 1) {
      const z = stepLevels[levelIndex]
      const levelEntryPolicy = withEntryStartZ(
        entryPolicy,
        levelIndex === 0 ? safeZ : Math.min(safeZ, stepLevels[levelIndex - 1] + entryClearance),
      )
      const levelStartIndex = moves.length
      const orderedBoundaryContours = orderClosedContoursGreedy(
        boundaryContours,
        currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
      )

      for (const contour of orderedBoundaryContours) {
        const entryPoint = contourStartPoint(contour, z)
        currentPosition = transitionToCutEntry(
          moves,
          currentPosition,
          entryPoint,
          safeZ,
          maxLinkDistance,
          undefined,
          levelEntryPolicy,
        )
        const cutMoves = toClosedCutMoves(contour, z)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      }

      const orderedSegments = orderOpenSegmentsGreedy(
        segments,
        currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
      )

      for (const segment of orderedSegments) {
        const entryPoint = contourStartPoint(segment, z)
        currentPosition = transitionToCutEntry(
          moves,
          currentPosition,
          entryPoint,
          safeZ,
          maxLinkDistance,
          undefined,
          levelEntryPolicy,
        )
        const cutMoves = toOpenCutMoves(segment, z)
        moves.push(...cutMoves)
        currentPosition = cutMoves.at(-1)?.to ?? currentPosition
      }

      applyLevelFeed(
        moves,
        levelStartIndex,
        operation,
        slotScale,
        slotDistance,
        effectiveStepover * SLOT_FEED_OWN_TRAIL_FACTOR,
        toolRadius * 2,
        effectiveStepover,
        telemetry,
      )

      currentPosition = retractToSafe(moves, currentPosition, safeZ)
    }

    return { moves, stepLevels, warnings }
  }

  // Round joins on islands (bumps we clear around) when the option is on, so
  // the tool wraps convex corners smoothly without gouging; outer/wall rings
  // stay mitered and are filleted at emit time. Matches the pocket rough pass.
  const islandJoinType = operation.roundOutsideCorners
    ? ClipperLib.JoinType.jtRound
    : ClipperLib.JoinType.jtMiter
  const smoothRadius = cornerSmoothingRadius(operation.roundOutsideCorners, toolRadius, effectiveStepover)
  const centreRegions = coverageRegions.flatMap((region) =>
    buildInsetRegions(region, initialInset, ClipperLib.JoinType.jtMiter, islandJoinType))
  // Seeded circle clearing (issue #554). Full circles grow from each region's
  // clearance seed; the last is recorded as an island so each offset ring
  // stays one stepover outside the cleared disc. Both are independent inner
  // sections in the travel scheduler below. The pattern is the only gate: any
  // other value plans nothing and takes the previous path.
  const seedStart = roughCoverage.seedCircles
    ? seedStartRadius(operation, toolRadius)
    : 0
  const seedPlans = new Map<OffsetRegionNode, SeedCirclePlan[]>()
  const regionTrees = centreRegions.map((region) => {
    const plans = seedStart > 0
      ? planSeedCircles(region, seedStart, effectiveStepover, toolRadius * 2, radialLeave)
      : []
    if (plans.length === 0) return buildOffsetRegionTree(region, effectiveStepover, islandJoinType)

    const seeded = buildOffsetRegionTree(
      { ...region, islands: [...region.islands, ...plans.map((plan) => plan.island)] },
      effectiveStepover,
      islandJoinType,
    )
    // The tree must OFFSET around the seed islands but must not CUT them:
    // seed stacks emit those exact laps separately, and `cutOffsetRegionNode`
    // emits every island of the node it is cutting. Restoring the root's
    // original island list drops the duplicates while the children retain the
    // seed islands that keep every outward ring clear.
    const tree: OffsetRegionNode = { region, children: seeded.children }
    seedPlans.set(tree, plans)
    return tree
  })
  // Leftover excursions (issue #576): the enlarged island is what deletes the
  // graze rings, and it is also what can strand a sliver where it merges with
  // a wall or a real island. Planned once per band and cut after the rings at
  // every level.
  const seedLeftovers = regionTrees.flatMap((tree) => planRegionSeedLeftovers(
    tree,
    seedPlans.get(tree) ?? [],
    effectiveStepover,
    toolRadius,
    islandJoinType,
    direction,
    smoothRadius,
  ))
  // Tangential links (issue #545): replace the straight ring-to-ring link
  // with a tangent S-curve, gated by the operation field (absent = today's
  // straight links). The domain is the band's tool-centre region — the tree
  // roots are exactly that construction — and the solver falls back to the
  // straight link when nothing fits. Which kinds link on which patterns is
  // usesTangentLinks's call (#616); this gate no longer keeps its own list.
  const tangentLink = usesTangentLinks(operation.kind, operation.pocketPattern) && operation.roundLinkCorners
    ? pocketTangentLinkOptions(
      operation.roundLinkCorners,
      toolRadius * 2,
      regionTrees.map((tree) => tree.region),
    )
    : undefined
  const engagementCacheEnabled = telemetry !== null && operation.pocketFeedReduction === 'engagement'
  const wallCleanup = clearingControlApplies(operation.kind, 'cleanWallCorners') && operation.roundOutsideCorners
    && operation.cleanWallCorners === true
    ? {
      enabled: true,
      onFallback: (): void => appendUniqueWarning(warnings, { code: 'pocketWallCornerCleanupFallback' }),
    }
    : undefined
  const ringPerimeters = engagementCacheEnabled
    ? buildRingPerimeterIndex(regionTrees, direction, smoothRadius ?? null, wallCleanup !== undefined, toolRadius)
    : null
  const entryPolicy = withEntryHandoffFeedScale(
    createEntryPolicy(
      operation,
      toolRadius * 2,
      regionTrees.map((tree) => tree.region),
      (warning) => appendUniqueWarning(warnings, warning),
    ),
    slotScale,
  )

  for (let levelIndex = 0; levelIndex < stepLevels.length; levelIndex += 1) {
    const z = stepLevels[levelIndex]
    const levelEntryPolicy = withEntryStartZ(
      entryPolicy,
      levelIndex === 0 ? safeZ : Math.min(safeZ, stepLevels[levelIndex - 1] + entryClearance),
    )

    if (regionTrees.length === 0) {
      warnings.push({ code: 'surfaceNoOffsetContours', params: { topZ: band.topZ, bottomZ: band.bottomZ } })
      currentPosition = retractToSafe(moves, currentPosition, safeZ)
      continue
    }

    const levelStartIndex = moves.length
    const remainingSeedPlans = regionTrees.flatMap((tree) => seedPlans.get(tree) ?? [])
    // A seed stack is an independent section. Its links are safe only inside
    // the stack, so every cross-section transition retracts before the
    // nearest-entry choice moves in XY.
    const cutSeedStack = (seedPlan: SeedCirclePlan): void => {
      currentPosition = retractToSafe(moves, currentPosition, safeZ)
      const circles = applyContourDirection(seedCircleContours(seedPlan, effectiveStepover), direction)
      let previousCircleEnd: ToolpathPoint | null = null
      for (const baseCircle of circles) {
        const circle = rotateContourToNearestEntry(baseCircle, previousCircleEnd ?? currentPosition)
        const linkStartIndex = moves.length
        currentPosition = transitionToCutEntry(
          moves,
          currentPosition,
          contourStartPoint(circle, z),
          safeZ,
          maxLinkDistance,
          undefined,
          levelEntryPolicy,
        )
        let circleMoves = toClosedCutMoves(circle, z)
        const tangentSplice = spliceTangentSLink(
          moves,
          linkStartIndex,
          circle,
          circleMoves,
          tangentLink,
        )
        if (tangentSplice) {
          circleMoves = tangentSplice.cutMoves
          currentPosition = tangentSplice.nextPosition
        }
        moves.push(...circleMoves)
        currentPosition = circleMoves.at(-1)?.to ?? currentPosition
        previousCircleEnd = currentPosition
      }
    }

    if (remainingSeedPlans.length === 0) {
      // Legacy schedule: each whole offset tree is one section competing on
      // its innermost entry. This is the plain `offset` path, and the
      // byte-identical fallback seeded_offset must keep when no seed fits.
      const remainingOffsetSections = regionTrees.map((node) => ({ node, parent: null, depth: 0 }))
      while (remainingOffsetSections.length > 0) {
        const choice = nextRoughSection(
          remainingSeedPlans,
          remainingOffsetSections,
          (section, current, levelZ) => offsetSectionEntryPoint(
            section, current, levelZ, direction, smoothRadius, wallCleanup, toolRadius,
          ),
          currentPosition,
          z,
          effectiveStepover,
          direction,
        )
        const [section] = remainingOffsetSections.splice(choice.index, 1)
        // A separately scheduled offset section never inherits a short
        // direct-cut link from the previous section. Its XY travel is
        // explicitly at safe Z before the configured entry resumes cutting.
        currentPosition = retractToSafe(moves, currentPosition, safeZ)
        currentPosition = cutOffsetRegionNode(
          moves,
          section.node,
          z,
          safeZ,
          maxLinkDistance,
          currentPosition,
          'inner-first',
          {
            direction,
            loops: 'all',
            smoothRadius,
            depth: section.depth,
            entryPolicy: levelEntryPolicy,
            tangentLink,
            wallCleanup,
            toolRadius,
          },
        )
      }
    } else {
      // Seeded schedule (issue #575): offset work is a frontier of ring
      // units. A unit becomes eligible once its children are cut, which
      // preserves inner-first; after every seed stack or offset unit the next
      // entry is re-chosen globally from the actual endpoint, so seed stacks
      // and offset branches interleave instead of one whole tree draining
      // after its first selection. Links inside one tree stay direct (and
      // eligible for tangent S-curves); transitions from a seed stack or from
      // another tree travel at safe Z first — the same rule the legacy
      // section-to-section transitions used.
      const { frontier, pendingChildren, unitByNode } = buildOffsetUnitFrontier(
        regionTrees,
        direction,
        smoothRadius,
        wallCleanup,
        toolRadius,
      )
      let previousUnitRoot: OffsetRegionNode | null = null
      while (remainingSeedPlans.length > 0 || frontier.length > 0) {
        const choice = nextRoughSection(
          remainingSeedPlans,
          frontier,
          offsetUnitEntryPoint,
          currentPosition,
          z,
          effectiveStepover,
          direction,
        )
        if (choice.kind === 'seed') {
          const [seedPlan] = remainingSeedPlans.splice(choice.index, 1)
          cutSeedStack(seedPlan)
          previousUnitRoot = null
          continue
        }

        const [unit] = frontier.splice(choice.index, 1)
        if (previousUnitRoot !== unit.root) {
          currentPosition = retractToSafe(moves, currentPosition, safeZ)
        }
        currentPosition = cutOffsetNodeRings(
          moves,
          unit.node,
          z,
          safeZ,
          maxLinkDistance,
          currentPosition,
          [],
          {
            direction,
            loops: 'all',
            smoothRadius,
            depth: unit.depth,
            entryPolicy: levelEntryPolicy,
            tangentLink,
            wallCleanup,
            toolRadius,
            parent: unit.parent ?? undefined,
          },
        )
        previousUnitRoot = unit.root
        const parentNode = unit.parent
        if (parentNode !== null) {
          const remaining = (pendingChildren.get(parentNode) ?? 0) - 1
          pendingChildren.set(parentNode, remaining)
          if (remaining <= 0) {
            const promoted = unitByNode.get(parentNode)
            if (promoted !== undefined) {
              frontier.push(promoted)
            }
          }
        }
      }
    }

    if (seedLeftovers.length > 0) {
      currentPosition = cutSeedLeftoverExcursions(
        moves,
        seedLeftovers,
        z,
        safeZ,
        currentPosition,
        levelEntryPolicy,
      )
    }

    const levelEndIndex = moves.length
    const engagementCache = ringPerimeters !== null
      ? buildOffsetBandEngagementClassification(moves, levelStartIndex, levelEndIndex, { toolRadius, ringPerimeters })
      : null

    applyLevelFeed(
      moves,
      levelStartIndex,
      operation,
      slotScale,
      slotDistance,
      effectiveStepover * SLOT_FEED_OWN_TRAIL_FACTOR,
      toolRadius * 2,
      effectiveStepover,
      telemetry,
      engagementCache,
    )

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  return { moves, stepLevels, warnings }
}

function generateFinishBandMoves(
  band: SurfaceCleanBand,
  operation: Operation,
  safeZ: number,
  _stepdown: number,
  toolRadius: number,
  stepoverDistance: number,
  maxLinkDistance: number,
  direction: CutDirection = 'conventional',
  telemetry: EngagementTelemetryAccumulator | null = null,
): { moves: ToolpathMove[]; stepLevels: number[]; warnings: ToolpathWarning[] } {
  const moves: ToolpathMove[] = []
  const warnings: ToolpathWarning[] = []
  const effectiveBottom = resolveBandBottomZ(band, operation)
  if (effectiveBottom === null) {
    return {
      moves,
      stepLevels: [],
      warnings: [{ code: 'surfaceBandNoFinishDepth', params: { topZ: band.topZ, bottomZ: band.bottomZ } }],
    }
  }

  if (!operation.finishWalls && !operation.finishFloor) {
    return {
      moves,
      stepLevels: [],
      warnings: [{ code: 'surfaceFinishBothDisabled' }],
    }
  }

  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  let coverageRegions = buildSurfaceCoverageRegions(band.subjectPaths, band.protectedPaths, band.regions, toolRadius)
  // Apply region mask after toolRadius expansion.  coverageRegions is already
  // a tool-centre domain, so both polarities must dilate by the remaining
  // clearance (toolRadius + radialLeave) — no further erosion will happen.
  if (band.regionMask) {
    const scale = DEFAULT_CLIPPER_SCALE
    const domainPaths = coverageRegions
      .flatMap((r) => r.outer.length >= 3 ? [toClipperPath(normalizeWinding(r.outer, false), scale)] : [])
    if (domainPaths.length === 0) {
      return { moves, stepLevels: [], warnings: [{ code: 'surfaceNoFinishContours', params: { topZ: band.topZ, bottomZ: band.bottomZ } }] }
    }
    const domain = unionClipperPaths(domainPaths).filter((p) => p.length >= 2)
    if (domain.length === 0) {
      return { moves, stepLevels: [], warnings: [{ code: 'surfaceNoFinishContours', params: { topZ: band.topZ, bottomZ: band.bottomZ } }] }
    }
    const maskedDomain = resolveRegionDomainCentre(domain, band.regionMask, toolRadius + radialLeave)
      .filter((p) => p.length >= 2)
    if (maskedDomain.length === 0) {
      return { moves, stepLevels: [], warnings: [{ code: 'surfaceNoFinishContours', params: { topZ: band.topZ, bottomZ: band.bottomZ } }] }
    }
    const polyTree = executeDifference(maskedDomain, [])
    coverageRegions = polyTreeToRegions(polyTree, band.targetFeatureIds, band.islandFeatureIds, scale)
      .filter((r) => r.outer.length >= 3)
    if (coverageRegions.length === 0) {
      return { moves, stepLevels: [], warnings: [{ code: 'surfaceNoFinishContours', params: { topZ: band.topZ, bottomZ: band.bottomZ } }] }
    }
  }
  const finishDelta = radialLeave
  const finishRegions = coverageRegions.flatMap((region) => buildInsetRegions(region, finishDelta))
  const slotScale = resolveSlotFeedScale(operation)
  const entryPolicy = withEntryHandoffFeedScale(
    createEntryPolicy(
      operation,
      toolRadius * 2,
      finishRegions,
      (warning) => appendUniqueWarning(warnings, warning),
    ),
    slotScale,
  )
  const wallContours = operation.finishWalls ? applyContourDirection(buildContourLoops(finishRegions), direction) : []
  const minFloorStepover = 1 / DEFAULT_CLIPPER_SCALE
  const floorStepover = Math.max(stepoverDistance, minFloorStepover)
  const floorSmoothRadius = cornerSmoothingRadius(operation.roundOutsideCorners, toolRadius, floorStepover)
  const floorIslandJoin = operation.roundOutsideCorners
    ? ClipperLib.JoinType.jtRound
    : ClipperLib.JoinType.jtMiter
  const finishCoverage = areaCoverage(effectivePocketPattern(operation.kind, operation.pocketPattern))
  const isParallelPocket = finishCoverage.rasterSegments
  // Seeded circle clearing on the finish floor (issue #579): the same phase 1
  // the rough pass runs (issue #554), planned against each region the floor
  // tree is actually built from so every circle fits whole. Each plan's last
  // circle is injected as an island so the rings offset around — but never
  // cut — the seed discs; the root keeps its original islands because the
  // seed stacks emit those exact laps separately.
  const floorSeedStart = finishCoverage.seedCircles
    ? seedStartRadius(operation, toolRadius)
    : 0
  const floorSeedPlans = new Map<OffsetRegionNode, SeedCirclePlan[]>()
  const floorTrees = operation.finishFloor && !isParallelPocket
    ? finishRegions
      .flatMap((region) => buildInsetRegions(region, 0))
      .flatMap((region) => buildInsetRegions(region, floorStepover, ClipperLib.JoinType.jtMiter, floorIslandJoin))
      .flatMap((region) => {
        const plans = floorSeedStart > 0
          ? planSeedCircles(region, floorSeedStart, floorStepover, toolRadius * 2, radialLeave)
          : []
        if (plans.length === 0) return [buildOffsetRegionTree(region, floorStepover, floorIslandJoin)]
        const seeded = buildOffsetRegionTree(
          { ...region, islands: [...region.islands, ...plans.map((plan) => plan.island)] },
          floorStepover,
          floorIslandJoin,
        )
        // The tree must OFFSET around the seed islands but must not CUT them:
        // seed stacks emit those exact laps separately, and `cutOffsetRegionNode`
        // emits every island of the node it is cutting. Restoring the root's
        // original island list drops the duplicates while the children retain the
        // seed islands that keep every outward ring clear.
        const tree: OffsetRegionNode = { region, children: seeded.children }
        floorSeedPlans.set(tree, plans)
        return [tree]
      })
    : []
  // Leftover excursions on the floor tree (issue #576), same construction as
  // the rough band's.
  const floorSeedLeftovers = floorTrees.flatMap((tree) => planRegionSeedLeftovers(
    tree,
    floorSeedPlans.get(tree) ?? [],
    floorStepover,
    toolRadius,
    floorIslandJoin,
    direction,
    floorSmoothRadius,
  ))
  // Tangential link junctions for the offset floor rings; the domain is the
  // wall-finish tool-centre path (finishRegions), which is the hard boundary a
  // floor-ring link may sweep up to. Which kinds link on which patterns is
  // usesTangentLinks's call (#616), same as the rough band above.
  const floorTangentLink = usesTangentLinks(operation.kind, operation.pocketPattern) && operation.finishFloor
    ? pocketTangentLinkOptions(
      operation.roundLinkCorners,
      toolRadius * 2,
      finishRegions,
    )
    : undefined
  const floorWallCleanup = clearingControlApplies(operation.kind, 'cleanWallCorners') && operation.roundOutsideCorners
    && operation.cleanWallCorners === true
    ? {
      enabled: true,
      onFallback: (): void => appendUniqueWarning(warnings, { code: 'pocketWallCornerCleanupFallback' }),
    }
    : undefined
  const floorSegments = operation.finishFloor && isParallelPocket
    ? buildPocketParallelSegments(finishRegions, stepoverDistance, operation.pocketAngle)
    : []
  if (
    wallContours.length === 0
    && floorTrees.length === 0
    && floorSegments.length === 0
  ) {
    return {
      moves,
      stepLevels: [],
      warnings: [{ code: 'surfaceNoFinishContours', params: { topZ: band.topZ, bottomZ: band.bottomZ } }],
    }
  }

  const wallStepLevels = operation.finishWalls ? [effectiveBottom] : []
  const floorStepLevels = operation.finishFloor ? [effectiveBottom] : []
  let currentPosition: ToolpathPoint | null = null

  // Floor before walls: when roughing left axial stock, a wall pass at final
  // depth would slot through the uncleared floor skin at full feed. Cutting
  // the floor first removes that skin (with its first pass at the reduced
  // slot feed), so the wall pass only shaves the radial stock — and cutting
  // walls last leaves the cleanest final wall surface.
  // One feed classification for the whole band level, floor and walls together
  // (issue #622) -- the same fix as the pocket finish band, which this function
  // mirrors. Classifying only the floor block left every wall cut at full feed
  // regardless of engagement, in both reduction modes.
  const levelStartIndex = moves.length
  for (const z of floorStepLevels) {
    const remainingSeedPlans = floorTrees.flatMap((tree) => floorSeedPlans.get(tree) ?? [])
    if (remainingSeedPlans.length === 0) {
      const orderedTrees = orderNodesGreedy(
        floorTrees,
        currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
      )
      for (const tree of orderedTrees) {
        currentPosition = cutOffsetRegionNode(
          moves,
          tree,
          z,
          safeZ,
          maxLinkDistance,
          currentPosition,
          'inner-first',
          {
            direction,
            loops: 'all',
            smoothRadius: floorSmoothRadius,
            depth: 0,
            entryPolicy,
            tangentLink: floorTangentLink,
            wallCleanup: floorWallCleanup,
            toolRadius,
          },
        )
      }
    } else {
      // Seeded schedule (issue #575 machinery, shared with the rough pass):
      // offset work is a frontier of ring units, and after every seed stack or
      // offset unit the next entry is re-chosen globally from the actual
      // endpoint. A seed stack is an independent section — its links are only
      // safe inside the stack — so every cross-section transition retracts
      // before the nearest-entry choice moves in XY.
      const { frontier, pendingChildren, unitByNode } = buildOffsetUnitFrontier(
        floorTrees,
        direction,
        floorSmoothRadius,
        floorWallCleanup,
        toolRadius,
      )
      let previousUnitRoot: OffsetRegionNode | null = null
      const cutSeedStack = (seedPlan: SeedCirclePlan): void => {
        currentPosition = retractToSafe(moves, currentPosition, safeZ)
        const circles = applyContourDirection(
          seedCircleContours(seedPlan, floorStepover),
          direction,
        )
        let previousCircleEnd: ToolpathPoint | null = null
        for (const baseCircle of circles) {
          const circle = rotateContourToNearestEntry(baseCircle, previousCircleEnd ?? currentPosition)
          const linkStartIndex = moves.length
          currentPosition = transitionToCutEntry(
            moves,
            currentPosition,
            contourStartPoint(circle, z),
            safeZ,
            maxLinkDistance,
            undefined,
            entryPolicy,
          )
          let circleMoves = toClosedCutMoves(circle, z)
          const tangentSplice = spliceTangentSLink(
            moves,
            linkStartIndex,
            circle,
            circleMoves,
            floorTangentLink,
          )
          if (tangentSplice) {
            circleMoves = tangentSplice.cutMoves
            currentPosition = tangentSplice.nextPosition
          }
          moves.push(...circleMoves)
          currentPosition = circleMoves.at(-1)?.to ?? currentPosition
          previousCircleEnd = currentPosition
        }
      }
      while (remainingSeedPlans.length > 0 || frontier.length > 0) {
        const choice = nextRoughSection(
          remainingSeedPlans,
          frontier,
          offsetUnitEntryPoint,
          currentPosition,
          z,
          floorStepover,
          direction,
        )
        if (choice.kind === 'seed') {
          const [seedPlan] = remainingSeedPlans.splice(choice.index, 1)
          cutSeedStack(seedPlan)
          previousUnitRoot = null
          continue
        }

        const [unit] = frontier.splice(choice.index, 1)
        if (previousUnitRoot !== unit.root) {
          currentPosition = retractToSafe(moves, currentPosition, safeZ)
        }
        currentPosition = cutOffsetNodeRings(
          moves,
          unit.node,
          z,
          safeZ,
          maxLinkDistance,
          currentPosition,
          [],
          {
            direction,
            loops: 'all',
            smoothRadius: floorSmoothRadius,
            depth: unit.depth,
            entryPolicy,
            tangentLink: floorTangentLink,
            wallCleanup: floorWallCleanup,
            toolRadius,
            parent: unit.parent ?? undefined,
          },
        )
        previousUnitRoot = unit.root
        const parentNode = unit.parent
        if (parentNode !== null) {
          const remaining = (pendingChildren.get(parentNode) ?? 0) - 1
          pendingChildren.set(parentNode, remaining)
          if (remaining <= 0) {
            const promoted = unitByNode.get(parentNode)
            if (promoted !== undefined) {
              frontier.push(promoted)
            }
          }
        }
      }
    }

    if (floorSeedLeftovers.length > 0) {
      currentPosition = cutSeedLeftoverExcursions(
        moves,
        floorSeedLeftovers,
        z,
        safeZ,
        currentPosition,
        entryPolicy,
      )
    }

    const orderedFloorSegments = orderOpenSegmentsGreedy(
      floorSegments,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )
    for (const segment of orderedFloorSegments) {
      const entryPoint = contourStartPoint(segment, z)
      currentPosition = transitionToCutEntry(
        moves,
        currentPosition,
        entryPoint,
        safeZ,
        maxLinkDistance,
        undefined,
        entryPolicy,
      )
      const cutMoves = toOpenCutMoves(segment, z)
      moves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  for (const z of wallStepLevels) {
    const orderedWallContours = orderClosedContoursGreedy(
      wallContours,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )

    for (const contour of orderedWallContours) {
      const entryPoint = contourStartPoint(contour, z)
      currentPosition = transitionToCutEntry(
        moves,
        currentPosition,
        entryPoint,
        safeZ,
        maxLinkDistance,
        undefined,
        entryPolicy,
      )
      const cutMoves = toClosedCutMoves(contour, z)
      moves.push(...cutMoves)
      currentPosition = cutMoves.at(-1)?.to ?? currentPosition
    }

    currentPosition = retractToSafe(moves, currentPosition, safeZ)
  }

  const slotDistance = Math.max(
    toolRadius * 2 * SLOT_FEED_ENGAGEMENT_FACTOR,
    floorStepover * SLOT_FEED_ADJACENCY_FACTOR,
  )
  applyLevelFeed(
    moves,
    levelStartIndex,
    operation,
    slotScale,
    slotDistance,
    floorStepover * SLOT_FEED_OWN_TRAIL_FACTOR,
    toolRadius * 2,
    floorStepover,
    telemetry,
  )

  return {
    moves,
    stepLevels: [...new Set([...wallStepLevels, ...floorStepLevels])].sort((a, b) => b - a),
    warnings,
  }
}

export function generateSurfaceCleanToolpath(project: Project, operation: Operation): PocketToolpathResult {
  if (isFeatureFirst(operation, project)) {
    const parts = perFeatureOperations(operation, project)
    const sharedTelemetry = createSharedEngagementTelemetry(project, operation)
    const merged = mergePocketToolpathResults(
      operation.id,
      parts.map((subOp) => generateSurfaceCleanToolpathSingle(project, subOp, sharedTelemetry)),
      { orderBlocks: 'nearest' },
    )
    return sharedTelemetry
      ? { ...merged, engagementTelemetry: sharedTelemetry.toTelemetry() }
      : merged
  }
  return generateSurfaceCleanToolpathSingle(project, operation)
}

function generateSurfaceCleanToolpathSingle(
  project: Project,
  operation: Operation,
  sharedTelemetry?: EngagementTelemetryAccumulator | null,
): PocketToolpathResult {
  const resolved = resolveSurfaceCleanRegions(project, operation)
  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null

  if (!toolRecord) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, { code: 'noToolAssigned' }],
      bounds: null,
      stepLevels: [],
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, { code: 'toolDiameterPositive' }],
      bounds: null,
      stepLevels: [],
    }
  }

  if (!(operation.stepdown > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, { code: 'stepdownPositive' }],
      bounds: null,
      stepLevels: [],
    }
  }

  const safeZ = getOperationSafeZ(project)
  const entryClearance = getOperationClearance(project)
  const stepoverDistance = tool.diameter * operation.stepover
  const effectiveStepover = Math.max(stepoverDistance, 1 / DEFAULT_CLIPPER_SCALE)
  const maxLinkDistance = tool.diameter
  const direction = operation.cutDirection ?? 'conventional'
  const telemetry = sharedTelemetry !== undefined
    ? sharedTelemetry
    : operation.pocketFeedReduction === 'engagement'
      ? new EngagementTelemetryAccumulator(nominalEngagement(effectiveStepover, tool.radius))
      : null
  const allMoves: ToolpathMove[] = []
  const warnings = [...resolved.warnings]
  const allStepLevels = new Set<number>()
  const maxBandDepth = resolved.bands.reduce((max, band) => Math.max(max, Math.abs(band.topZ - band.bottomZ)), 0)
  const depthWarning = checkMaxCutDepthWarning(tool, maxBandDepth)
  if (depthWarning) {
    warnings.push(depthWarning)
  }

  for (const band of resolved.bands) {
    const result = operation.pass === 'finish'
      ? generateFinishBandMoves(
        band,
        operation,
        safeZ,
        operation.stepdown,
        tool.radius,
        stepoverDistance,
        maxLinkDistance,
        direction,
        telemetry,
      )
      : generateRoughBandMoves(
        band,
        operation,
        safeZ,
        entryClearance,
        operation.stepdown,
        tool.radius,
        stepoverDistance,
        maxLinkDistance,
        direction,
        telemetry,
      )

    const { moves, stepLevels, warnings: bandWarnings } = result
    moves.forEach((move) => allMoves.push(move))
    stepLevels.forEach((level) => allStepLevels.add(level))
    warnings.push(...bandWarnings)
  }

  let bounds: ToolpathBounds | null = null
  for (const move of allMoves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }

  return {
    operationId: operation.id,
    moves: allMoves,
    warnings,
    bounds,
    stepLevels: [...allStepLevels].sort((a, b) => b - a),
    ...(!sharedTelemetry && telemetry ? { engagementTelemetry: telemetry.toTelemetry() } : {}),
  }
}
