import ClipperLib from 'clipper-lib'
import type { Operation, Project, SketchFeature } from '../../types/project'
import { rectProfile } from '../../types/project'
import { expandFeatureGeometry, featureHasClosedGeometry } from '../../text'
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

function differencePaths(subjectPaths: ClipperPath[], clipPaths: ClipperPath[]): ClipperPath[] {
  if (subjectPaths.length === 0) {
    return []
  }

  if (clipPaths.length === 0) {
    return subjectPaths
  }

  return executeClipPaths(subjectPaths, clipPaths, ClipperLib.ClipType.ctDifference)
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

export function resolvePocketRegions(project: Project, operation: Operation): ResolvedPocketResult {
  const warnings: string[] = []

  if (operation.kind !== 'pocket') {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: ['Only pocket operations can be resolved by the pocket resolver'],
    }
  }

  if (operation.target.source !== 'features' || operation.target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: ['Pocket operation has no feature targets'],
    }
  }

  const selectedTargetFeatures = operation.target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is SketchFeature => feature !== null)
  const validTargetSourceFeatures = selectedTargetFeatures
    .filter((feature) => feature.operation === 'subtract')

  const targetFeatures = validTargetSourceFeatures
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'subtract')
    .map((feature) => ({
      feature,
      span: resolveFeatureZSpan(project, feature),
    }))

  if (validTargetSourceFeatures.length !== operation.target.featureIds.length) {
    warnings.push('Some selected target features are missing or are not subtract features')
  }

  const closedTargetFeatures = targetFeatures.filter(({ feature }) => featureHasClosedGeometry(feature))
  if (closedTargetFeatures.length !== targetFeatures.length) {
    warnings.push('Pocket operations only support closed target profiles')
  }

  if (closedTargetFeatures.length === 0) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [...warnings, 'No valid subtract features were found for this pocket operation'],
    }
  }

  const candidateIslands = project.features
    .flatMap((feature) => expandFeatureGeometry(feature))
    .filter((feature) => feature.operation === 'add' && featureHasClosedGeometry(feature))
    .map((feature) => ({
      feature,
      span: resolveFeatureZSpan(project, feature),
    }))
  const candidateTabIslands: AdditiveObstacleWithSpan[] = project.tabs.map((tab) => ({
    id: tab.id,
    path: toClipperPath(normalizeWinding(flattenProfile(rectProfile(tab.x, tab.y, tab.w, tab.h)).points, false), DEFAULT_CLIPPER_SCALE),
    span: {
      min: Math.min(tab.z_bottom, tab.z_top),
      max: Math.max(tab.z_bottom, tab.z_top),
    },
  }))

  const depths = uniqueSortedDepthsFromSpans([
    ...closedTargetFeatures.map(({ span }) => span),
    ...candidateIslands.map(({ span }) => span),
    ...candidateTabIslands.map(({ span }) => span),
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

      const featurePath = flattenFeatureToClipperPath(feature)
      if (feature.operation === 'subtract' && targetIdSet.has(feature.id)) {
        resolvedPaths = unionPaths([...resolvedPaths, featurePath])
        continue
      }

      if (feature.operation === 'add' && resolvedPaths.length > 0) {
        resolvedPaths = differencePaths(resolvedPaths, [featurePath])
      }
    }

    if (resolvedPaths.length > 0 && activeTabIslands.length > 0) {
      resolvedPaths = differencePaths(
        resolvedPaths,
        activeTabIslands.map((tab) => tab.path),
      )
    }

    if (resolvedPaths.length === 0) {
      warnings.push(`Band ${topZ} -> ${bottomZ} resolved to empty subject geometry`)
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
      warnings.push(`Band ${topZ} -> ${bottomZ} resolved to no machinable regions`)
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
    warnings.push('Pocket resolver produced no depth bands')
  }

  return {
    operationId: operation.id,
    units: project.meta.units,
    bands,
    warnings,
  }
}
