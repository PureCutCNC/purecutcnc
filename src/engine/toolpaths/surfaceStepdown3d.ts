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
import type { ToolpathWarning } from './warningCodes'
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
import { simplifyClosedRing } from './arcReconstruction'
import { loadSTLTransformedGeometry } from '../csg'
import { getMeshSliceIndex, sliceMeshAtZDetailed } from './meshSlicing'
import { buildRegionMask, splitFeatureTargets } from './regions'
import { resolveRegionDomainArea } from './regionDomain'
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
  /**
   * How far the mesh-slice keep-out was expanded past the true cross-section to
   * pay for decimation (issue #674). Consumers that measure a distance from a
   * level contour *to the model* have to add it: the contours in `levels` sit
   * that much further out than the mesh does. Consumers that only need
   * containment can ignore it — the expansion is always outward, so anything
   * derived by shrinking these paths is already conservative.
   */
  decimationTolerance: number
  levels: Resolved3DSurfaceLevel[]
  warnings: ToolpathWarning[]
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

/**
 * Mesh-slice decimation tolerance, as a fraction of tool radius, clamped into
 * an absolute band. Project units are mm (issue #674).
 *
 * `sliceMeshAtZDetailed` emits one contour vertex per triangle-edge crossing
 * and nothing downstream thinned it: `cleanClipperPath(path, 1.0)` in
 * `pocket.ts` drops vertices closer than 0.1 um at `DEFAULT_CLIPPER_SCALE`,
 * which is nothing for a real mesh. Every one of those vertices then entered a
 * single `ClipperOffset.Execute` per Z level, whose cost is superlinear in the
 * total — measured at roughly 4.7x per 2x vertices on #674's harness.
 *
 * Both finish strategies sample the mesh on a height-map cell of
 * `min(tool.radius / 3, stepover / 2)` (`finishSurfaceParallel.ts`,
 * `finishSurfaceWaterline.ts`), so 1% of tool radius sits about two orders of
 * magnitude below what the finish pass can resolve and cannot be the binding
 * fidelity limit. It is deliberately not scaled off `stockToLeaveRadial`, whose
 * default is 0: `slicePolygonsToClipperPaths` re-expands the keep-out by what
 * thinning actually cost, so roughing leaves *extra* stock against the model and
 * never less — safe at zero stock-to-leave by construction.
 *
 * This is a ceiling on the error, not the error itself. What any given contour
 * is charged is measured, and is usually far below it.
 */
const SLICE_DECIMATION_TOLERANCE_FRACTION = 0.01
const MIN_SLICE_DECIMATION_TOLERANCE = 0.002
const MAX_SLICE_DECIMATION_TOLERANCE = 0.02

/**
 * Contour vertices one Z level may hand to Clipper, counting this level's
 * decimated slice, the protection accumulated from the levels above, and the
 * surrounding 2D protection.
 *
 * From #674's measurements of the island offset this guards — one
 * `ClipperOffset.Execute`, `jtMiter`, `etClosedPolygon`, islands spread over a
 * 101.6 x 76.2 mm plaque, node v26.0.0 on an i7-8850H: 10 000 vertices took
 * 504 ms, 20 000 took 2 081 ms, 40 000 took 8 970 ms and 80 000 took 42 430 ms.
 * 20 000 holds a level near two seconds on that machine; 40 000 is already
 * nine, and the operation pays it once per Z level.
 *
 * Decimation buys a large constant factor but does not change the complexity
 * class, so this is the backstop for a mesh dense enough to blow through it.
 */
export const DEFAULT_SURFACE_3D_SLICE_VERTEX_BUDGET = 20_000

export function sliceDecimationTolerance(toolRadius: number): number {
  return Math.min(
    MAX_SLICE_DECIMATION_TOLERANCE,
    Math.max(MIN_SLICE_DECIMATION_TOLERANCE, toolRadius * SLICE_DECIMATION_TOLERANCE_FRACTION),
  )
}

function countPathVertices(paths: ClipperPath[]): number {
  let total = 0
  for (const path of paths) total += path.length
  return total
}

interface DecimatedSlice {
  paths: ClipperPath[]
  /** How far `paths` was expanded, which is what decimation actually cost here. */
  deviation: number
}

/**
 * Mesh cross-section at one Z, thinned and then re-expanded by the error that
 * thinning actually introduced, so the result provably contains the true
 * cross-section.
 *
 * The margin is the *measured* deviation rather than `decimationTolerance`,
 * which matters more than it looks. A rectangular or otherwise coarse
 * cross-section has no vertex RDP can drop, so it reports 0, skips the offset
 * entirely (`offsetClipperPaths` returns its input under a 1e-9 delta) and
 * comes out byte-identical to what this function returned before #674 — no
 * margin, no envelope shift, no change to the emitted program. Only a mesh
 * dense enough to actually thin pays anything, and it pays exactly what
 * thinning cost it.
 *
 * The expansion is the safety half of the decimation and belongs here rather
 * than at the `buildInsetRegions` call site the plan first proposed. That call
 * site produces `level.insetRegions` only, and `level.clearablePaths` is
 * consumed independently by `roughSurface.ts` as the safe-link domain — a
 * keep-out that shrank there would let the link planner rule a travel move safe
 * across standing stock. Expanding at the source instead means
 * `protectedAtLevel`, `protectedAbovePaths`, `clearablePaths`, `baseRegions`,
 * `insetRegions` and that safe-link domain all inherit the containment, and the
 * outer machining envelope — built from the undecimated import silhouette, so
 * it needs no margin — is left alone.
 *
 * Mesh-only: the 2.5D generators never reach this function. `src/import/stl.ts`
 * has a private function of the same name for silhouette extraction and is a
 * different code path.
 */
function slicePolygonsToClipperPaths(
  slicePolygons: Array<Array<[number, number]>>,
  decimationTolerance: number,
): DecimatedSlice {
  let deviation = 0
  const paths = slicePolygons
    .filter((poly) => poly.length >= 3)
    .map((poly) => {
      const simplified = simplifyClosedRing(poly.map(([x, y]) => ({ x, y })), decimationTolerance)
      if (simplified.deviation > deviation) deviation = simplified.deviation
      return toClipperPath(normalizeWinding(simplified.points, false), DEFAULT_CLIPPER_SCALE)
    })
  return { paths: offsetClipperPaths(unionClipperPathsEvenOdd(paths), deviation), deviation }
}

function emptyResult(operation: Operation, warning: ToolpathWarning): PocketToolpathResult {
  return {
    operationId: operation.id,
    moves: [],
    warnings: [warning],
    bounds: null,
    stepLevels: [],
  }
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
      result: emptyResult(operation, { code: 'surface3dNeedsModel', params: { operation: operationLabel } }),
    }
  }

  const splitTargets = splitFeatureTargets(project, target.featureIds)
  if (splitTargets.missingFeatureIds.length > 0) {
    return {
      ok: false,
      result: emptyResult(operation, { code: 'targetsNotFound' }),
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
      result: emptyResult(operation, { code: 'surface3dNotMesh' }),
    }
  }

  const toolRecord =
    operation.toolRef ? project.tools.find((entry) => entry.id === operation.toolRef) ?? null : null
  if (!toolRecord) {
    return {
      ok: false,
      result: emptyResult(operation, { code: 'noToolAssigned' }),
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      ok: false,
      result: emptyResult(operation, { code: 'toolDiameterPositive' }),
    }
  }

  const stepoverRatio = operation.stepover
  if (!(stepoverRatio > 0 && stepoverRatio <= 1)) {
    return {
      ok: false,
      result: emptyResult(operation, { code: 'stepoverRatioRange' }),
    }
  }

  const stlData = loadSTLTransformedGeometry(modelFeature, project)
  if (!stlData) {
    return {
      ok: false,
      result: emptyResult(operation, { code: 'surface3dLoadFailed' }),
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
      result: emptyResult(operation, { code: 'surface3dStockToLeaveTooLarge' }),
    }
  }

  const safeZ = getOperationSafeZ(project)
  const stepoverDistance = tool.diameter * stepoverRatio
  const maxLinkDistance = stepoverDistance * 1.5
  const direction: CutDirection = operation.cutDirection ?? 'conventional'
  const initialInset = tool.radius + radialLeave
  const decimationTolerance = sliceDecimationTolerance(tool.radius)
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const effectiveStepover = Math.max(stepoverDistance, minStepover)

  const modelSilhouettePaths = modelSilhouetteClipperPaths(modelFeature)
  const silhouetteArea = calculateClipperArea(modelSilhouettePaths)
  // Keep the tool-center envelope tight to the model outer wall. Rough/cleanup
  // only need enough radial band to retain a machinable outer-wall pass; they
  // should not create an extra floor-width pocket around the model.
  //
  // The envelope has to move out by whatever `slicePolygonsToClipperPaths` grew
  // the keep-out by, because a flat-bottomed model has a slice equal to its own
  // silhouette: the grown keep-out then eats straight into the outer-wall band,
  // and `OUTER_WALL_MARGIN` is a single micron. Without this the level collapses
  // and reports `surface3dFloorCollapsed`. Matching the shift keeps the band
  // exactly the width it was; the only effect on the cut is that the outer wall
  // keeps `stockToLeaveRadial` plus that same shift — the conservative
  // direction, and well inside what the finish pass removes.
  //
  // Cached by shift so a mesh that never thins (shift 0, the overwhelmingly
  // common case) builds exactly one envelope, identical to the pre-#674 one.
  // The shift only ever grows as levels are processed, so a level is never
  // measured against an envelope narrower than the protection reaching it.
  const silhouetteUnion = unionClipperPaths(modelSilhouettePaths)
  const baseSilhouetteOffset = 2 * initialInset + Math.max(minStepover, OUTER_WALL_MARGIN)
  const outlineCache = new Map<number, ClipperPath[]>()
  const outlineForShift = (shift: number): ClipperPath[] => {
    // Quantized to the Clipper unit the offset would round to anyway, so near
    // identical shifts share one envelope.
    const key = Math.round(shift * DEFAULT_CLIPPER_SCALE)
    const cached = outlineCache.get(key)
    if (cached) return cached
    let paths = offsetClipperPaths(silhouetteUnion, baseSilhouetteOffset + key / DEFAULT_CLIPPER_SCALE)
    if (regionMask) {
      paths = resolveRegionDomainArea(paths, regionMask, initialInset)
    }
    outlineCache.set(key, paths)
    return paths
  }

  if (outlineForShift(0).length === 0) {
    return {
      ok: false,
      result: emptyResult(operation, { code: 'surface3dDegenerateBoundary' }),
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
        result: emptyResult(operation, { code: 'surface3dNoDepthInPocket' }),
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
      result: emptyResult(operation, { code: 'stepdownPositive' }),
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
      result: emptyResult(operation, { code: 'surface3dNoStepLevels' }),
    }
  }

  const warnings: ToolpathWarning[] = []
  const depthWarning = checkMaxCutDepthWarning(tool, Math.abs(stockTop - effectiveBottom))
  if (depthWarning) {
    warnings.push(depthWarning)
  }

  if (operation.debugToolpath) {
    warnings.push({ code: 'debug', params: { text: `Debug: Z range ${stockTop.toFixed(4)} -> ${modelBottomZ.toFixed(4)}, bottom ${effectiveBottom.toFixed(4)}` } })
    warnings.push({ code: 'debug', params: { text: `Debug: silhouette area = ${silhouetteArea.toFixed(4)}` } })
    warnings.push({ code: 'debug', params: { text: `Debug: floor candidate Zs = ${[...floorLevels].map((z) => z.toFixed(4)).join(', ')}` } })
    warnings.push({ code: 'debug', params: { text: `Debug: rough levels = ${roughLevels.map((z) => z.toFixed(4)).join(', ')}` } })
    warnings.push({ code: 'debug', params: { text: `Debug: mesh triangles = ${index.length / 3}` } })
    warnings.push({ code: 'debug', params: { text: `Debug: initialInset=${initialInset.toFixed(4)} stepover=${effectiveStepover.toFixed(4)} stepdown=${resolvedStepdown.toFixed(4)}` } })
  }

  const levels: Resolved3DSurfaceLevel[] = []
  let protectedAbovePaths: ClipperPath[] = []
  let usedOpenSliceFallback = false
  // Running maximum of what decimation has actually cost so far. It is a
  // running maximum rather than this level's own figure because
  // `protectedAbovePaths` carries the levels above, already expanded by theirs.
  let appliedDecimation = 0
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
    const decimatedSlice = slicePolygonsToClipperPaths(sliceResult.polygons, decimationTolerance)
    const slicePaths = decimatedSlice.paths
    if (decimatedSlice.deviation > appliedDecimation) {
      appliedDecimation = decimatedSlice.deviation
    }
    const outlinePaths = outlineForShift(appliedDecimation)

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
        warnings.push({ code: 'debug', params: { text: `Debug: Z=${z.toFixed(4)} outside active subtract pocket depth` } })
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

    // Last point before any mesh-driven Clipper work at this level, and the
    // first at which the driver is known. Everything above is either cached
    // slicing or 2D-feature work whose cost does not move with mesh density.
    const levelVertexCount = countPathVertices(slicePaths)
      + countPathVertices(protectedAbovePaths)
      + countPathVertices(surroundingProtectedPaths)
    if (levelVertexCount > DEFAULT_SURFACE_3D_SLICE_VERTEX_BUDGET) {
      return {
        ok: false,
        result: emptyResult(operation, {
          code: 'surface3dMeshTooDense',
          params: {
            z: z.toFixed(4),
            vertices: levelVertexCount,
            budget: DEFAULT_SURFACE_3D_SLICE_VERTEX_BUDGET,
          },
        }),
      }
    }

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
        warnings.push({ code: 'surface3dOpenMesh' })
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
      warnings.push({ code: 'debug', params: { text: `Debug: Z=${z.toFixed(4)} protectionZ=${protectionZ.toFixed(4)} sliceArea=${sliceArea.toFixed(4)} protectedAbovePaths=${protectedAbovePaths.length} clearable=${clearablePaths.length}` } })
    }

    if (clearablePaths.length > 0) {
      const baseRegions = polyTreeToRegions(executeDifference(clearablePaths, []), [], [])
      const insetRegions = baseRegions.flatMap((baseRegion) => buildInsetRegions(baseRegion, initialInset))
      const isCriticalFloorLevel = criticalLevels.some((criticalLevel) => sameZ(criticalLevel, z))
      if (insetRegions.length === 0) {
        if (isCriticalFloorLevel) {
          warnings.push({ code: 'surface3dFloorCollapsed', params: { z: z.toFixed(4) } })
        }
        if (operation.debugToolpath) {
          warnings.push({ code: 'debug', params: { text: `Debug: Z=${z.toFixed(4)} no machinable region after initial inset` } })
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
      warnings.push({ code: 'debug', params: { text: `Debug: Z=${z.toFixed(4)} fully protected — no clearance area` } })
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
    warnings.push({ code: 'surface3dNoLevels' })
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
      decimationTolerance: appliedDecimation,
      levels,
      warnings,
    },
  }
}
