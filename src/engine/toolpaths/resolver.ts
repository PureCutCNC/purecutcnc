import ClipperLib from 'clipper-lib'
import type { Operation, Project, SketchFeature } from '../../types/project'
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
  const clockwise = feature.operation === 'subtract'
  return toClipperPath(normalizeWinding(flattened.points, clockwise), scale)
}

function uniqueSortedDepths(features: FeatureWithSpan[]): number[] {
  return [...new Set(features.flatMap(({ span }) => [span.min, span.max]))].sort((a, b) => b - a)
}

function activeForBand(features: FeatureWithSpan[], topZ: number, bottomZ: number): FeatureWithSpan[] {
  return features.filter(({ span }) => span.max >= topZ && span.min <= bottomZ)
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

  const targetFeatures = operation.target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is SketchFeature => feature !== null)
    .filter((feature) => feature.operation === 'subtract')
    .map((feature) => ({ feature, span: resolveFeatureZSpan(project, feature) }))

  if (targetFeatures.length !== operation.target.featureIds.length) {
    warnings.push('Some selected target features are missing or are not subtract features')
  }

  if (targetFeatures.length === 0) {
    return {
      operationId: operation.id,
      units: project.meta.units,
      bands: [],
      warnings: [...warnings, 'No valid subtract features were found for this pocket operation'],
    }
  }

  const candidateIslands = project.features
    .filter((feature) => feature.operation === 'add')
    .map((feature) => ({ feature, span: resolveFeatureZSpan(project, feature) }))

  const depths = uniqueSortedDepths(targetFeatures)
  const bands: ResolvedPocketBand[] = []

  for (let index = 0; index < depths.length - 1; index += 1) {
    const topZ = depths[index]
    const bottomZ = depths[index + 1]
    if (!bandHasThickness(topZ, bottomZ)) {
      continue
    }

    const activeTargets = activeForBand(targetFeatures, topZ, bottomZ)
    if (activeTargets.length === 0) {
      continue
    }

    const activeIslands = activeForBand(candidateIslands, topZ, bottomZ)
    const subjectPaths = activeTargets.map(({ feature }) => flattenFeatureToClipperPath(feature))
    const islandPaths = activeIslands.map(({ feature }) => flattenFeatureToClipperPath(feature))
    const unitedSubjectPaths = unionPaths(subjectPaths)

    if (unitedSubjectPaths.length === 0) {
      warnings.push(`Band ${topZ} -> ${bottomZ} resolved to empty subject geometry`)
      continue
    }

    const polyTree = islandPaths.length > 0
      ? executeClip(unitedSubjectPaths, islandPaths, ClipperLib.ClipType.ctDifference)
      : executeClip(unitedSubjectPaths, [], ClipperLib.ClipType.ctUnion)

    const regions = polyTreeToRegions(
      polyTree,
      activeTargets.map(({ feature }) => feature.id),
      activeIslands.map(({ feature }) => feature.id),
    )

    if (regions.length === 0) {
      warnings.push(`Band ${topZ} -> ${bottomZ} resolved to no machinable regions`)
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
    warnings.push('Pocket resolver produced no depth bands')
  }

  return {
    operationId: operation.id,
    units: project.meta.units,
    bands,
    warnings,
  }
}
