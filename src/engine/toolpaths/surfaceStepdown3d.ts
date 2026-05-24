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

import type { CutDirection, Operation, Project, SketchFeature } from '../../types/project'
import type { ClipperPath, NormalizedTool, PocketToolpathResult, ResolvedPocketRegion } from './types'
import {
  DEFAULT_CLIPPER_SCALE,
  checkMaxCutDepthWarning,
  flattenProfile,
  getOperationSafeZ,
  normalizeWinding,
  normalizeToolForProject,
  toClipperPath,
} from './geometry'
import {
  buildInsetRegions,
  executeDifference,
  generateStepLevels,
  polyTreeToRegions,
} from './pocket'
import { loadSTLTransformedGeometry } from '../csg'
import { getMeshSliceIndex, sliceMeshAtZDetailed } from './meshSlicing'
import { buildRegionMask, splitFeatureTargets } from './regions'
import { significantSilhouettePaths } from './silhouette'
import {
  buildProtectedFootprintPaths,
  calculateClipperArea,
  differenceClipperPaths,
  intersectClipperPaths,
  offsetClipperPaths,
  relatedSubtractFeatures,
  unionClipperPaths,
  unionClipperPathsEvenOdd,
} from './modelProtection'

export interface Resolved3DSurfaceLevel {
  z: number
  clearablePaths: ClipperPath[]
  baseRegions: ResolvedPocketRegion[]
  insetRegions: ResolvedPocketRegion[]
  isCriticalFloorLevel: boolean
}

export interface Resolved3DSurfaceStepdown {
  operationId: string
  safeZ: number
  tool: NormalizedTool
  direction: CutDirection
  effectiveStepover: number
  maxLinkDistance: number
  levels: Resolved3DSurfaceLevel[]
  warnings: string[]
}

export type Resolve3DSurfaceStepdownResult =
  | { ok: true; resolved: Resolved3DSurfaceStepdown }
  | { ok: false; result: PocketToolpathResult }

interface Resolve3DSurfaceStepdownOptions {
  operationLabel?: string
  resolveStepdown?: (context: {
    project: Project
    operation: Operation
    tool: NormalizedTool
    stockTop: number
    modelTopZ: number
    modelBottomZ: number
    effectiveBottom: number
  }) => number
}

const Z_TOLERANCE = 1e-6
const OUTER_WALL_MARGIN = 1e-3

function emptyResult(operation: Operation, warning: string): PocketToolpathResult {
  return {
    operationId: operation.id,
    moves: [],
    warnings: [warning],
    bounds: null,
    stepLevels: [],
  }
}

function slicePolygonsToClipperPaths(slicePolygons: Array<Array<[number, number]>>): ClipperPath[] {
  const paths = slicePolygons
    .filter((poly) => poly.length >= 3)
    .map((poly) => toClipperPath(
      normalizeWinding(poly.map(([x, y]) => ({ x, y })), false),
      DEFAULT_CLIPPER_SCALE,
    ))
  return unionClipperPathsEvenOdd(paths)
}

function sameZ(left: number, right: number): boolean {
  return Math.abs(left - right) <= Z_TOLERANCE
}

function dedupeZLevelsDescending(levels: number[]): number[] {
  const sorted = [...levels].sort((a, b) => b - a)
  const deduped: number[] = []
  for (const z of sorted) {
    const previous = deduped[deduped.length - 1]
    if (previous !== undefined && sameZ(previous, z)) {
      deduped[deduped.length - 1] = Math.min(previous, z)
      continue
    }
    deduped.push(z)
  }
  return deduped
}

function modelSilhouetteClipperPaths(modelFeature: SketchFeature): ClipperPath[] {
  if (modelFeature.kind === 'stl' && modelFeature.stl?.silhouettePaths?.length) {
    return significantSilhouettePaths(modelFeature.stl.silhouettePaths)
      .map((path) => toClipperPath(normalizeWinding(path, true), DEFAULT_CLIPPER_SCALE))
  }

  const modelProfile = flattenProfile(modelFeature.sketch.profile)
  return [toClipperPath(modelProfile.points)]
}

export function resolve3DSurfaceStepdown(
  project: Project,
  operation: Operation,
  options?: Resolve3DSurfaceStepdownOptions,
): Resolve3DSurfaceStepdownResult {
  const operationLabel = options?.operationLabel ?? '3D surface operation'
  const target = operation.target
  if (target.source !== 'features' || target.featureIds.length === 0) {
    return {
      ok: false,
      result: emptyResult(operation, `${operationLabel} requires a model feature to be selected`),
    }
  }

  const splitTargets = splitFeatureTargets(project, target.featureIds)
  if (splitTargets.missingFeatureIds.length > 0) {
    return {
      ok: false,
      result: emptyResult(operation, 'One or more target features not found'),
    }
  }

  const modelFeature = splitTargets.machiningFeatures.find(
    (feature) => feature.operation === 'model' && feature.kind === 'stl',
  ) ?? null
  const regionFeatures = splitTargets.regionFeatures.filter((feature) => feature.sketch.profile.closed)
  const regionMask = buildRegionMask(regionFeatures)
  if (!modelFeature?.stl?.meshAssetId || !project.modelAssets?.[modelFeature.stl.meshAssetId]) {
    return {
      ok: false,
      result: emptyResult(operation, 'Model feature must be an imported mesh model'),
    }
  }

  const toolRecord =
    operation.toolRef ? project.tools.find((entry) => entry.id === operation.toolRef) ?? null : null
  if (!toolRecord) {
    return {
      ok: false,
      result: emptyResult(operation, 'No tool assigned to this operation'),
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      ok: false,
      result: emptyResult(operation, 'Tool diameter must be greater than zero'),
    }
  }

  const stepoverRatio = operation.stepover
  if (!(stepoverRatio > 0 && stepoverRatio <= 1)) {
    return {
      ok: false,
      result: emptyResult(operation, 'Stepover ratio must be between 0 and 1'),
    }
  }

  const stlData = loadSTLTransformedGeometry(modelFeature, project)
  if (!stlData) {
    return {
      ok: false,
      result: emptyResult(operation, 'Failed to load model geometry'),
    }
  }

  const { positions: transformedPos, index } = stlData
  const sliceIndex = getMeshSliceIndex(stlData)

  let modelTopZ = -Infinity
  let modelBottomZ = Infinity
  const floorLevels = new Set<number>()

  for (let i = 0; i < index.length; i += 3) {
    const i1 = index[i] * 3
    const i2 = index[i + 1] * 3
    const i3 = index[i + 2] * 3

    const z1 = transformedPos[i1 + 2]
    const z2 = transformedPos[i2 + 2]
    const z3 = transformedPos[i3 + 2]

    if (z1 > modelTopZ) modelTopZ = z1
    if (z2 > modelTopZ) modelTopZ = z2
    if (z3 > modelTopZ) modelTopZ = z3

    if (z1 < modelBottomZ) modelBottomZ = z1
    if (z2 < modelBottomZ) modelBottomZ = z2
    if (z3 < modelBottomZ) modelBottomZ = z3

    if (Math.abs(z1 - z2) < 1e-6 && Math.abs(z2 - z3) < 1e-6) {
      floorLevels.add(z1)
    }
  }

  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const axialLeave = Math.max(0, operation.stockToLeaveAxial)
  let effectiveBottom = modelBottomZ + axialLeave
  if (effectiveBottom > modelTopZ + 1e-6) {
    return {
      ok: false,
      result: emptyResult(operation, 'Axial stock-to-leave exceeds model height — nothing to cut'),
    }
  }

  const safeZ = getOperationSafeZ(project)
  const stepoverDistance = tool.diameter * stepoverRatio
  const maxLinkDistance = stepoverDistance * 1.5
  const direction: CutDirection = operation.cutDirection ?? 'conventional'
  const initialInset = tool.radius + radialLeave
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const effectiveStepover = Math.max(stepoverDistance, minStepover)

  const modelSilhouettePaths = modelSilhouetteClipperPaths(modelFeature)
  const silhouetteArea = calculateClipperArea(modelSilhouettePaths)
  // Keep the tool-center envelope tight to the model outer wall. Rough/cleanup
  // only need enough radial band to retain a machinable outer-wall pass; they
  // should not create an extra floor-width pocket around the model.
  const silhouetteOffset = 2 * initialInset + Math.max(minStepover, OUTER_WALL_MARGIN)
  let outlinePaths = offsetClipperPaths(unionClipperPaths(modelSilhouettePaths), silhouetteOffset)
  if (regionMask) {
    outlinePaths = intersectClipperPaths(outlinePaths, regionMask.paths)
  }

  if (outlinePaths.length === 0) {
    return {
      ok: false,
      result: emptyResult(operation, 'Computed outer boundary is degenerate — model silhouette may be too small'),
    }
  }

  const modelFootprintPaths = unionClipperPaths(modelSilhouettePaths)
  const relatedSubtracts = relatedSubtractFeatures(
    project,
    new Set(target.featureIds),
    modelFootprintPaths,
  )
  if (relatedSubtracts.length > 0) {
    const deepestRelatedBottom = relatedSubtracts.reduce(
      (min, subtract) => Math.min(min, subtract.bottomZ),
      Infinity,
    )
    effectiveBottom = Math.max(effectiveBottom, deepestRelatedBottom + axialLeave)
    if (effectiveBottom > modelTopZ + 1e-6) {
      return {
        ok: false,
        result: emptyResult(operation, 'Containing subtract feature leaves no machining depth for this model'),
      }
    }
  }

  const stockTop = Math.max(modelTopZ, project.stock.thickness)
  const resolvedStepdown = options?.resolveStepdown?.({
    project,
    operation,
    tool,
    stockTop,
    modelTopZ,
    modelBottomZ,
    effectiveBottom,
  }) ?? operation.stepdown
  if (!(resolvedStepdown > 0)) {
    return {
      ok: false,
      result: emptyResult(operation, 'Operation stepdown must be greater than zero'),
    }
  }

  const stepLevels = generateStepLevels(stockTop, effectiveBottom, resolvedStepdown)
  const subtractFloorLevels = relatedSubtracts.map((subtract) => subtract.bottomZ + axialLeave)
  const criticalLevels = dedupeZLevelsDescending([
    ...[...floorLevels].map((floorZ) => floorZ + axialLeave),
    ...subtractFloorLevels,
  ])
  const roughLevels = dedupeZLevelsDescending([...stepLevels, ...criticalLevels])
    .filter((z) => z <= stockTop + 1e-9 && z >= effectiveBottom - 1e-9)

  if (roughLevels.length === 0) {
    return {
      ok: false,
      result: emptyResult(operation, 'No step levels generated'),
    }
  }

  const warnings: string[] = []
  const depthWarning = checkMaxCutDepthWarning(tool, Math.abs(stockTop - effectiveBottom))
  if (depthWarning) {
    warnings.push(depthWarning)
  }

  if (operation.debugToolpath) {
    warnings.push(
      `Debug: Z range ${stockTop.toFixed(4)} -> ${modelBottomZ.toFixed(4)}, bottom ${effectiveBottom.toFixed(4)}`,
    )
    warnings.push(`Debug: silhouette area = ${silhouetteArea.toFixed(4)}`)
    warnings.push(`Debug: floor candidate Zs = ${[...floorLevels].map((z) => z.toFixed(4)).join(', ')}`)
    warnings.push(`Debug: rough levels = ${roughLevels.map((z) => z.toFixed(4)).join(', ')}`)
    warnings.push(`Debug: mesh triangles = ${index.length / 3}`)
    warnings.push(
      `Debug: initialInset=${initialInset.toFixed(4)} stepover=${effectiveStepover.toFixed(4)} stepdown=${resolvedStepdown.toFixed(4)}`,
    )
  }

  const levels: Resolved3DSurfaceLevel[] = []
  let protectedAbovePaths: ClipperPath[] = []
  let usedOpenSliceFallback = false
  const sliceSampleEpsilon = Math.max(Math.abs(modelTopZ - modelBottomZ) * 1e-6, 1e-6)

  for (const z of roughLevels) {
    const protectionZ = z - axialLeave
    const sliceWithinModel = protectionZ <= modelTopZ - sliceSampleEpsilon
      && protectionZ >= modelBottomZ - sliceSampleEpsilon
    const sliceZ = Math.min(
      modelTopZ - sliceSampleEpsilon,
      Math.max(modelBottomZ + sliceSampleEpsilon, protectionZ + sliceSampleEpsilon),
    )

    const sliceResult = sliceWithinModel
      ? sliceMeshAtZDetailed(sliceIndex, sliceZ)
      : { polygons: [], openChainCount: 0, segmentCount: 0 }
    const slicePaths = slicePolygonsToClipperPaths(sliceResult.polygons)

    const activeSubtractPaths = relatedSubtracts.length > 0
      ? unionClipperPaths(
        relatedSubtracts
          .filter((subtract) => z <= subtract.topZ + 1e-9 && z >= subtract.bottomZ - 1e-9)
          .flatMap((subtract) => subtract.paths),
      )
      : []
    const levelOutlinePaths = relatedSubtracts.length > 0
      ? intersectClipperPaths(outlinePaths, activeSubtractPaths)
      : outlinePaths

    if (levelOutlinePaths.length === 0) {
      if (operation.debugToolpath) {
        warnings.push(`Debug: Z=${z.toFixed(4)} outside active subtract pocket depth`)
      }
      continue
    }

    const surroundingProtectedPaths = buildProtectedFootprintPaths(project, {
      targetFeatureIds: new Set(target.featureIds),
      z,
      featureExpansion: 0,
      tabExpansion: 0,
      clampExpansion: 0,
      machiningEnvelopePaths: levelOutlinePaths,
    })

    let protectedAtLevel = unionClipperPaths([
      ...protectedAbovePaths,
      ...slicePaths,
      ...surroundingProtectedPaths,
    ])

    if (sliceResult.openChainCount > 0) {
      protectedAtLevel = unionClipperPaths([
        ...protectedAtLevel,
        ...modelFootprintPaths,
      ])
      if (!usedOpenSliceFallback) {
        warnings.push('Model has open/non-watertight slices; roughing used conservative silhouette protection')
        usedOpenSliceFallback = true
      }
    }

    let clearablePaths = differenceClipperPaths(levelOutlinePaths, protectedAtLevel)
    if (clearablePaths.length > 0) {
      const cleanupEpsilon = 1e-3
      clearablePaths = offsetClipperPaths(
        offsetClipperPaths(clearablePaths, -cleanupEpsilon),
        cleanupEpsilon,
      )
    }

    if (operation.debugToolpath) {
      const sliceArea = calculateClipperArea(slicePaths)
      warnings.push(
        `Debug: Z=${z.toFixed(4)} protectionZ=${protectionZ.toFixed(4)} sliceArea=${sliceArea.toFixed(4)} protectedAbovePaths=${protectedAbovePaths.length} clearable=${clearablePaths.length}`,
      )
    }

    if (clearablePaths.length > 0) {
      const baseRegions = polyTreeToRegions(executeDifference(clearablePaths, []), [], [])
      const insetRegions = baseRegions.flatMap((baseRegion) => buildInsetRegions(baseRegion, initialInset))
      const isCriticalFloorLevel = criticalLevels.some((criticalLevel) => sameZ(criticalLevel, z))
      if (insetRegions.length === 0) {
        if (isCriticalFloorLevel) {
          warnings.push(`Critical cleanup floor at Z=${z.toFixed(4)} collapsed after inset and was skipped`)
        }
        if (operation.debugToolpath) {
          warnings.push(`Debug: Z=${z.toFixed(4)} no machinable region after initial inset`)
        }
      } else {
        levels.push({
          z,
          clearablePaths,
          baseRegions,
          insetRegions,
          isCriticalFloorLevel,
        })
      }
    } else if (operation.debugToolpath) {
      warnings.push(`Debug: Z=${z.toFixed(4)} fully protected — no clearance area`)
    }

    const sliceArea = calculateClipperArea(slicePaths)
    const isSolidFloor = sliceArea > 0.95 * silhouetteArea
    if (isSolidFloor || sliceResult.openChainCount > 0) {
      protectedAbovePaths = unionClipperPaths([
        ...protectedAbovePaths,
        ...modelFootprintPaths,
      ])
    } else if (slicePaths.length > 0) {
      protectedAbovePaths = unionClipperPaths([
        ...protectedAbovePaths,
        ...slicePaths,
      ])
    }
  }

  if (levels.length === 0) {
    warnings.push('No machinable 3D surface levels were found')
  }

  return {
    ok: true,
    resolved: {
      operationId: operation.id,
      safeZ,
      tool,
      direction,
      effectiveStepover,
      maxLinkDistance,
      levels,
      warnings,
    },
  }
}
