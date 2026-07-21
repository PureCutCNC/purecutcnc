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
import type { Operation, Project, SketchFeature } from '../../types/project'
import { rectProfile } from '../../types/project'
import { expandFeatureGeometry, featureHasClosedGeometry } from '../../text'
import { resolveProject } from '../../store/helpers/resolveFeatures'
import type {
  ClipperPath,
  ResolvedFeatureZSpan,
  ResolvedPocketBand,
  ResolvedPocketRegion,
  ResolvedPocketResult,
} from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  fromClipperPath,
  normalizeWinding,
  resolveFeatureZSpan,
  toClipperPath,
} from './geometry'
import { applyRegionMaskToPaths, buildRegionMask } from './regions'

interface FeatureWithSpan {
  feature: SketchFeature
  span: ResolvedFeatureZSpan
}

interface AdditiveObstacleWithSpan {
  id: string
  path: ClipperPath
  span: {
    min: number
    max: number
  }
}

interface PolyTreeNode {
  IsHole(): boolean
  Contour(): ClipperPath
  Childs?: () => PolyTreeNode[]
  m_Childs?: PolyTreeNode[]
}

function getChildren(node: PolyTreeNode): PolyTreeNode[] {
  return node.Childs ? node.Childs() : (node.m_Childs ?? [])
}

function flattenFeatureToClipperPath(feature: SketchFeature, scale = DEFAULT_CLIPPER_SCALE): ClipperPath {
  const flattened = flattenProfile(feature.sketch.profile)
  return toClipperPath(normalizeWinding(flattened.points, false), scale)
}

function uniqueSortedDepthsFromSpans(spans: Array<{ min: number; max: number }>): number[] {
  return [...new Set(spans.flatMap((span) => [span.min, span.max]))].sort((a, b) => b - a)
}

function activeForBand(features: FeatureWithSpan[], topZ: number, bottomZ: number): FeatureWithSpan[] {
  return features.filter(({ span }) => span.max >= topZ && span.min <= bottomZ)
}

function activeObstaclesForBand(
  obstacles: AdditiveObstacleWithSpan[],
  topZ: number,
  bottomZ: number,
): AdditiveObstacleWithSpan[] {
  return obstacles.filter(({ span }) => span.max >= topZ && span.min <= bottomZ)
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

function unionPaths(paths: ClipperPath[]): ClipperPath[] {
  if (paths.length === 0) {
    return []
  }

  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )

  return solution as ClipperPath[]
}

/**
 * Union paths with even-odd fill semantics. When multiple same-winding
 * contours nest, the even-odd rule creates a hole (unlike non-zero, which
 * would fill the inner area). Used for closed Line contours so that nested
 * same-winding Lines produce holes rather than a solid fill (issue #270 S2).
 */
function unionPathsEvenOdd(paths: ClipperPath[]): ClipperPath[] {
  if (paths.length === 0) {
    return []
  }

  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(paths, ClipperLib.PolyType.ptSubject, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctUnion,
    solution,
    ClipperLib.PolyFillType.pftEvenOdd,
    ClipperLib.PolyFillType.pftEvenOdd,
  )

  return solution as ClipperPath[]
}

function differencePaths(subjectPaths: ClipperPath[], clipPaths: ClipperPath[]): ClipperPath[] {
  if (subjectPaths.length === 0) {
    return []
  }

  if (clipPaths.length === 0) {
    return subjectPaths
  }

  return executeClipPaths(subjectPaths, clipPaths, ClipperLib.ClipType.ctDifference)
}

function pathsIntersect(subjectPaths: ClipperPath[], clipPaths: ClipperPath[]): boolean {
  if (subjectPaths.length === 0 || clipPaths.length === 0) {
    return false
  }

  return executeClipPaths(subjectPaths, clipPaths, ClipperLib.ClipType.ctIntersection).length > 0
}

function polyTreeToRegions(
  node: PolyTreeNode,
  targetFeatureIds: string[],
  islandFeatureIds: string[],
  scale = DEFAULT_CLIPPER_SCALE,
): ResolvedPocketRegion[] {
  const regions: ResolvedPocketRegion[] = []
  const contour = node.Contour()

  if (contour.length > 0 && !node.IsHole()) {
    const children = getChildren(node)
    const islands = children
      .filter((child) => child.IsHole())
      .map((child) => fromClipperPath(child.Contour(), scale))

    regions.push({
      outer: fromClipperPath(contour, scale),
      islands,
      targetFeatureIds,
      islandFeatureIds,
    })
  }

  for (const child of getChildren(node)) {
    regions.push(...polyTreeToRegions(child, targetFeatureIds, islandFeatureIds, scale))
  }

  return regions
}

function bandHasThickness(topZ: number, bottomZ: number): boolean {
  return Math.abs(topZ - bottomZ) > Number.EPSILON
}

export function resolvePocketRegions(authoritativeProject: Project, operation: Operation): ResolvedPocketResult {
  const project = resolveProject(authoritativeProject)
  const warnings: ToolpathWarning[] = []
  const isPocketLike =
    operation.kind === 'pocket' || operation.kind === 'v_carve' || operation.kind === 'v_carve_medial'
  const operationLabel =
    operation.kind === 'pocket'
      ? 'Pocket'
      : operation.kind === 'v_carve_medial'
        ? 'V-carve medial'
        : 'V-carve'

  if (!isPocketLike) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [{ code: 'resolverOnlyPocketVcarve' }],
    }
  }

  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [{ code: 'resolverNoTargets', params: { operation: operationLabel } }],
    }
  }

  const selectedTargetFeatures = operation.target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature) => feature !== null)
  const regionFeatures = selectedTargetFeatures
    .filter((feature) => feature.operation === 'region')
  const regionMask = buildRegionMask(regionFeatures)

  const isVCarve = operation.kind === 'v_carve' || operation.kind === 'v_carve_medial'
  const validTargetSourceFeatures = selectedTargetFeatures
    .filter((feature) => isVCarve
      ? (feature.operation === 'subtract' || feature.operation === 'line')
      : feature.operation === 'subtract')

  const subtractSourceFeatures = validTargetSourceFeatures.filter((f) => f.operation === 'subtract')
  const lineSourceFeatures = validTargetSourceFeatures.filter((f) => f.operation === 'line')

  const subtractTargetFeatures = subtractSourceFeatures
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'subtract')
    .map((feature) => ({
      feature,
      span: resolveFeatureZSpan(project, feature),
    }))

  const lineTargetFeatures = lineSourceFeatures
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'line')
    .map((feature) => ({
      feature,
      span: resolveFeatureZSpan(project, feature),
    }))

  const targetFeatures = [...subtractTargetFeatures, ...lineTargetFeatures]

  if (validTargetSourceFeatures.length + regionFeatures.length !== operation.target.featureIds.length) {
    const expectedRoles = isVCarve ? 'subtract/line/region' : 'subtract/region'
    warnings.push({ code: 'targetsMissingOrWrongRole', params: { roles: expectedRoles } })
  }

  const closedSubtractFeatures = subtractTargetFeatures.filter(({ feature }) => featureHasClosedGeometry(feature))
  const closedLineFeatures = lineTargetFeatures.filter(({ feature }) => featureHasClosedGeometry(feature))
  const closedTargetFeatures = [...closedSubtractFeatures, ...closedLineFeatures]

  if (closedTargetFeatures.length !== targetFeatures.length) {
    warnings.push({ code: 'closedProfilesOnly', params: { operation: operationLabel } })
  }

  if (closedTargetFeatures.length === 0) {
    const targetKindLabel = isVCarve ? 'subtract or line' : 'subtract'
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [...warnings, { code: 'resolverNoValidKindTargets', params: { kind: targetKindLabel, operation: operationLabel.toLowerCase() } }],
    }
  }

  // Candidate island/tab discovery must be conservative across all depth
  // bands: union every target path with non-zero fill so an obstacle
  // inside any target contour is discovered regardless of which bands it
  // overlaps.  Even-odd topology for closed Lines belongs inside each
  // band (below) where we know which Lines are simultaneously active.
  const allTargetPathsForDiscovery = [
    ...closedSubtractFeatures.map(({ feature }) => flattenFeatureToClipperPath(feature)),
    ...closedLineFeatures.map(({ feature }) => flattenFeatureToClipperPath(feature)),
  ]
  const targetUnionPaths = unionPaths(allTargetPathsForDiscovery)

  const candidateIslands = project.features
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'add' && featureHasClosedGeometry(feature))
    .filter((feature) => pathsIntersect(targetUnionPaths, [flattenFeatureToClipperPath(feature)]))
    .map((feature) => ({
      feature,
      span: resolveFeatureZSpan(project, feature),
    }))
  const candidateTabIslands: AdditiveObstacleWithSpan[] = project.tabs
    .map((tab) => ({
      id: tab.id,
      path: toClipperPath(normalizeWinding(flattenProfile(rectProfile(tab.x, tab.y, tab.w, tab.h)).points, false), DEFAULT_CLIPPER_SCALE),
      span: {
        min: Math.min(tab.z_bottom, tab.z_top),
        max: Math.max(tab.z_bottom, tab.z_top),
      },
    }))
    .filter((tab) => pathsIntersect(targetUnionPaths, [tab.path]))

  const depths = uniqueSortedDepthsFromSpans([
    ...closedTargetFeatures.map(({ span }) => span),
    ...candidateIslands.map(({ span }) => span),
    ...candidateTabIslands.map(({ span }) => span),
  ])
  const bands: ResolvedPocketBand[] = []
  const targetIdSet = new Set(closedSubtractFeatures.map(({ feature }) => feature.id))
  const lineIdSet = new Set(closedLineFeatures.map(({ feature }) => feature.id))
  const expandedFeaturesInOrder = project.features.flatMap((feature) => expandFeatureGeometry(feature))

  for (let index = 0; index < depths.length - 1; index += 1) {
    const topZ = depths[index]
    const bottomZ = depths[index + 1]
    if (!bandHasThickness(topZ, bottomZ)) {
      continue
    }

    const activeTargets = activeForBand(closedTargetFeatures, topZ, bottomZ)
    if (activeTargets.length === 0) {
      continue
    }

    const activeIslands = activeForBand(candidateIslands, topZ, bottomZ)
    const activeTabIslands = activeObstaclesForBand(candidateTabIslands, topZ, bottomZ)
    const activeBandFeatureIds = new Set([
      ...activeTargets.map(({ feature }) => feature.id),
      ...activeIslands.map(({ feature }) => feature.id),
    ])
    let resolvedPaths: ClipperPath[] = []

    for (const feature of expandedFeaturesInOrder) {
      if (!activeBandFeatureIds.has(feature.id)) {
        continue
      }

      // Skip line features in the subtract/add loop — they are resolved
      // separately with even-odd semantics below.
      if (feature.operation === 'line' && lineIdSet.has(feature.id)) {
        continue
      }

      const featurePath = flattenFeatureToClipperPath(feature)
      if (feature.operation === 'subtract' && targetIdSet.has(feature.id)) {
        resolvedPaths = unionPaths([...resolvedPaths, featurePath])
        continue
      }

      if (feature.operation === 'add' && resolvedPaths.length > 0) {
        resolvedPaths = differencePaths(resolvedPaths, [featurePath])
      }
    }

    // Resolve closed Line targets with even-odd fill semantics (issue #270 S2).
    // Nested same-winding Lines create holes; disjoint Lines remain separate.
    const activeLineTargetsForBand = activeForBand(closedLineFeatures, topZ, bottomZ)
    let lineAreas: ClipperPath[] = []
    if (activeLineTargetsForBand.length > 0) {
      const linePaths = activeLineTargetsForBand.map(({ feature }) => flattenFeatureToClipperPath(feature))
      lineAreas = unionPathsEvenOdd(linePaths)

      // Subtract add islands from line areas so islands protect material
      // from line targets as they do from subtract targets.
      // An add that fully encloses every active line target is parent
      // material the line carves into — it is not an island and must not
      // be subtracted (issue #340).
      for (const island of activeIslands) {
        if (lineAreas.length > 0) {
          const islandPath = flattenFeatureToClipperPath(island.feature)
          const islandEnclosesAllLines = activeLineTargetsForBand.every(({ feature }) => {
            const targetPath = flattenFeatureToClipperPath(feature)
            return differencePaths([targetPath], [islandPath]).length === 0
          })
          if (!islandEnclosesAllLines) {
            lineAreas = differencePaths(lineAreas, [islandPath])
          }
        }
      }

      resolvedPaths = unionPaths([...resolvedPaths, ...lineAreas])
    }

    if (resolvedPaths.length > 0 && activeTabIslands.length > 0) {
      resolvedPaths = differencePaths(
        resolvedPaths,
        activeTabIslands.map((tab) => tab.path),
      )
    }

    if (resolvedPaths.length > 0 && regionMask && operation.kind !== 'pocket') {
      resolvedPaths = applyRegionMaskToPaths(resolvedPaths, regionMask)
    }

    if (resolvedPaths.length === 0) {
      warnings.push({ code: 'bandEmptySubject', params: { topZ, bottomZ } })
      continue
    }

    const polyTree = executeClip(resolvedPaths, [], ClipperLib.ClipType.ctUnion)

    const regions = polyTreeToRegions(
      polyTree,
      activeTargets.map(({ feature }) => feature.id),
      [
        ...activeIslands.map(({ feature }) => feature.id),
        ...activeTabIslands.map((tab) => tab.id),
      ],
    )

    if (regions.length === 0) {
      warnings.push({ code: 'bandNoRegions', params: { topZ, bottomZ } })
      continue
    }

    bands.push({
      topZ,
      bottomZ,
      targetFeatureIds: activeTargets.map(({ feature }) => feature.id),
      islandFeatureIds: [
        ...activeIslands.map(({ feature }) => feature.id),
        ...activeTabIslands.map((tab) => tab.id),
      ],
      regions,
    })
  }

  if (bands.length === 0) {
    warnings.push({ code: 'resolverNoBands', params: { operation: operationLabel } })
  }

  return {
    operationId: operation.id,
    units: project.meta.units,
    bands,
    warnings,
  }
}

export function resolveInsideEdgeRegions(authoritativeProject: Project, operation: Operation): ResolvedPocketResult {
  const project = resolveProject(authoritativeProject)
  const warnings: ToolpathWarning[] = []
  const operationLabel = 'Inside edge route'

  if (operation.kind !== 'edge_route_inside') {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [{ code: 'resolverOnlyInsideEdge' }],
    }
  }

  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [{ code: 'resolverNoTargets', params: { operation: operationLabel } }],
    }
  }

  const selectedTargetFeatures = operation.target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature) => feature !== null)
  const regionFeatures = selectedTargetFeatures
    .filter((feature) => feature.operation === 'region')
  const validTargetSourceFeatures = selectedTargetFeatures
    .filter((feature) => feature.operation === 'subtract')

  const targetFeatures = validTargetSourceFeatures
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'subtract')
    .map((feature) => ({
      feature,
      span: resolveFeatureZSpan(project, feature),
    }))

  if (validTargetSourceFeatures.length + regionFeatures.length !== operation.target.featureIds.length) {
    warnings.push({ code: 'targetsMissingOrWrongRole', params: { roles: 'subtract/region' } })
  }

  const closedTargetFeatures = targetFeatures.filter(({ feature }) => featureHasClosedGeometry(feature))
  if (closedTargetFeatures.length !== targetFeatures.length) {
    warnings.push({ code: 'closedProfilesOnly', params: { operation: operationLabel } })
  }

  if (closedTargetFeatures.length === 0) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [...warnings, { code: 'resolverNoValidSubtracts', params: { operation: operationLabel.toLowerCase() } }],
    }
  }

  const targetUnionPaths = unionPaths(closedTargetFeatures.map(({ feature }) => flattenFeatureToClipperPath(feature)))

  const candidateIslands = project.features
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'add' && featureHasClosedGeometry(feature))
    .map((feature) => ({
      feature,
      path: flattenFeatureToClipperPath(feature),
    }))
    .filter(({ path }) => pathsIntersect(targetUnionPaths, [path]))
    .filter(({ path }) => differencePaths([path], targetUnionPaths).length > 0)
    .map(({ feature }) => ({
      feature,
      span: resolveFeatureZSpan(project, feature),
    }))

  const depths = uniqueSortedDepthsFromSpans([
    ...closedTargetFeatures.map(({ span }) => span),
    ...candidateIslands.map(({ span }) => span),
  ])
  const bands: ResolvedPocketBand[] = []
  const targetIdSet = new Set(closedTargetFeatures.map(({ feature }) => feature.id))
  const expandedFeaturesInOrder = project.features.flatMap((feature) => expandFeatureGeometry(feature))

  for (let index = 0; index < depths.length - 1; index += 1) {
    const topZ = depths[index]
    const bottomZ = depths[index + 1]
    if (!bandHasThickness(topZ, bottomZ)) {
      continue
    }

    const activeTargets = activeForBand(closedTargetFeatures, topZ, bottomZ)
    if (activeTargets.length === 0) {
      continue
    }

    const activeIslands = activeForBand(candidateIslands, topZ, bottomZ)
    const activeBandFeatureIds = new Set([
      ...activeTargets.map(({ feature }) => feature.id),
      ...activeIslands.map(({ feature }) => feature.id),
    ])
    let resolvedPaths: ClipperPath[] = []

    for (const feature of expandedFeaturesInOrder) {
      if (!activeBandFeatureIds.has(feature.id)) {
        continue
      }

      const featurePath = flattenFeatureToClipperPath(feature)
      if (feature.operation === 'subtract' && targetIdSet.has(feature.id)) {
        resolvedPaths = unionPaths([...resolvedPaths, featurePath])
        continue
      }

      if (feature.operation === 'add' && resolvedPaths.length > 0) {
        resolvedPaths = differencePaths(resolvedPaths, [featurePath])
      }
    }

    if (resolvedPaths.length === 0) {
      warnings.push({ code: 'bandEmptySubject', params: { topZ, bottomZ } })
      continue
    }

    const polyTree = executeClip(resolvedPaths, [], ClipperLib.ClipType.ctUnion)

    const regions = polyTreeToRegions(
      polyTree,
      activeTargets.map(({ feature }) => feature.id),
      activeIslands.map(({ feature }) => feature.id),
    )

    if (regions.length === 0) {
      warnings.push({ code: 'bandNoRegions', params: { topZ, bottomZ } })
      continue
    }

    bands.push({
      topZ,
      bottomZ,
      targetFeatureIds: activeTargets.map(({ feature }) => feature.id),
      islandFeatureIds: activeIslands.map(({ feature }) => feature.id),
      regions,
    })
  }

  if (bands.length === 0) {
    warnings.push({ code: 'resolverNoBands', params: { operation: operationLabel } })
  }

  return {
    operationId: operation.id,
    units: project.meta.units,
    bands,
    warnings,
  }
}
