/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the \"License\");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an \"AS IS\" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Rough Surface Operation
 *
 * A 3D roughing operation that clears the material around a 3D model
 * (STL mesh) at each step-down level.
 *
 * The outer boundary is computed automatically from the mesh silhouette
 * (the 2D projection of all triangles) offset far enough to leave a real
 * outside-wall tool-center lane after the tool-radius inset, so no separate
 * range/region feature is required.
 *
 * Algorithm (per Z level):
 *   1. Slice the 3D model triangle mesh at this Z and union it with all
 *      higher slices to get the top-down protected model solid at this depth,
 *      preserving nested contours as pocket holes
 *   2. Subtract that protected solid from the computed silhouette outline to
 *      produce clearable outside-wall and pocket regions
 *   3. Apply the initial tool-radius + radial-leave inset
 *   4. Use standard pocket recursive offsetting to generate concentric
 *      passes from the region boundary inward, stepover by stepover,
 *      stopping at the model surface
 */

import type { CutDirection, Operation, Project, SketchFeature } from '../../types/project'
import type { ClipperPath, PocketToolpathResult, ToolpathBounds, ToolpathMove, ToolpathPoint } from './types'
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
  cutOffsetRegionRecursive,
  executeDifference,
  generateStepLevels,
  orderRegionsGreedy,
  polyTreeToRegions,
  retractToSafe,
  updateBounds,
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
  segmentInsideClipperPaths,
  unionClipperPaths,
  unionClipperPathsEvenOdd,
} from './modelProtection'

function slicePolygonsToClipperPaths(slicePolygons: Array<Array<[number, number]>>): ClipperPath[] {
  const paths = slicePolygons
    .filter((poly) => poly.length >= 3)
    .map((poly) => toClipperPath(
      normalizeWinding(poly.map(([x, y]) => ({ x, y })), false),
      DEFAULT_CLIPPER_SCALE,
    ))
  return unionClipperPathsEvenOdd(paths)
}

function modelSilhouetteClipperPaths(modelFeature: SketchFeature): ClipperPath[] {
  if (modelFeature.kind === 'stl' && modelFeature.stl?.silhouettePaths?.length) {
    return significantSilhouettePaths(modelFeature.stl.silhouettePaths)
      .map((path) => toClipperPath(normalizeWinding(path, true), DEFAULT_CLIPPER_SCALE))
  }

  const modelProfile = flattenProfile(modelFeature.sketch.profile)
  return [toClipperPath(modelProfile.points)]
}

// ── Main entry point ────────────────────────────────────────────────────

export function generateRoughSurfaceToolpath(
  project: Project,
  operation: Operation,
): PocketToolpathResult {
  const target = operation.target
  if (target.source !== 'features' || target.featureIds.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Rough surface requires a model feature to be selected'],
      bounds: null,
      stepLevels: [],
    }
  }

  // ── Identify the model feature ─────────────────────────────────────────

  const splitTargets = splitFeatureTargets(project, target.featureIds)
  if (splitTargets.missingFeatureIds.length > 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['One or more target features not found'],
      bounds: null,
      stepLevels: [],
    }
  }

  const modelFeature = splitTargets.machiningFeatures.find((feature) => feature.operation === 'model' && feature.kind === 'stl') ?? null
  const regionFeatures = splitTargets.regionFeatures.filter((feature) => feature.sketch.profile.closed)
  const regionMask = buildRegionMask(regionFeatures)
  if (!modelFeature?.stl?.meshAssetId || !project.modelAssets?.[modelFeature.stl.meshAssetId]) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Model feature must be an imported mesh model'],
      bounds: null,
      stepLevels: [],
    }
  }

  // ── Tool validation ────────────────────────────────────────────────────

  const toolRecord =
    operation.toolRef ? project.tools.find((t) => t.id === operation.toolRef) ?? null : null
  if (!toolRecord) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['No tool assigned to this operation'],
      bounds: null,
      stepLevels: [],
    }
  }
  const tool = normalizeToolForProject(toolRecord, project)
  if (!(tool.diameter > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Tool diameter must be greater than zero'],
      bounds: null,
      stepLevels: [],
    }
  }
  if (!(operation.stepdown > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Operation stepdown must be greater than zero'],
      bounds: null,
      stepLevels: [],
    }
  }

  // ── Load transformed STL geometry (shared with 3D preview) ────────────

  const stlData = loadSTLTransformedGeometry(modelFeature, project)
  if (!stlData) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Failed to load model geometry'],
      bounds: null,
      stepLevels: [],
    }
  }

  const { positions: transformedPos, index } = stlData
  const sliceIndex = getMeshSliceIndex(stlData)

  // ── Compute Z bounds and identify major floor levels ───────────────────

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

    // Check if triangle is horizontal (major floor candidate)
    if (Math.abs(z1 - z2) < 1e-6 && Math.abs(z2 - z3) < 1e-6) {
        floorLevels.add(z1)
    }
  }

  // ── Operation parameters ───────────────────────────────────────────────

  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const axialLeave = Math.max(0, operation.stockToLeaveAxial)
  let effectiveBottom = modelBottomZ + axialLeave
  if (effectiveBottom > modelTopZ + 1e-6) { // Small epsilon
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Axial stock-to-leave exceeds model height — nothing to cut'],
      bounds: null,
      stepLevels: [],
    }
  }

  const stepoverRatio = operation.stepover
  if (!(stepoverRatio > 0 && stepoverRatio <= 1)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Stepover ratio must be between 0 and 1'],
      bounds: null,
      stepLevels: [],
    }
  }

  // ── Pocket-style parameters ────────────────────────────────────────────

  const safeZ = getOperationSafeZ(project)
  const stepoverDistance = tool.diameter * stepoverRatio
  // 3D roughing rings within one level can be linked at Z when the straight
  // tool-center segment stays inside a tool-radius-eroded safe-link region
  // built per level (see `safeLinkCheck` further down). The cap below bounds
  // how far a link is allowed even when containment passes — it limits
  // exposure to mesh-slice noise the containment test might miss.
  const maxLinkDistance = stepoverDistance * 1.5
  const direction: CutDirection = operation.cutDirection ?? 'conventional'
  const initialInset = tool.radius + radialLeave
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const effectiveStepover = Math.max(stepoverDistance, minStepover)

  // ── Compute outer boundary from model silhouette ──────────────────────

  const modelSilhouettePaths = modelSilhouetteClipperPaths(modelFeature)
  const silhouetteArea = calculateClipperArea(modelSilhouettePaths)
  const silhouetteOffset = tool.diameter + effectiveStepover + 2 * radialLeave
  let outlinePaths = offsetClipperPaths(unionClipperPaths(modelSilhouettePaths), silhouetteOffset)
  if (regionMask) {
    outlinePaths = intersectClipperPaths(outlinePaths, regionMask.paths)
  }

  if (outlinePaths.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Computed outer boundary is degenerate — model silhouette may be too small'],
      bounds: null,
      stepLevels: [],
    }
  }

  const modelFootprintPaths = unionClipperPaths(modelSilhouettePaths)
  const relatedSubtracts = relatedSubtractFeatures(
    project,
    new Set(target.featureIds),
    modelFootprintPaths,
  )
  if (relatedSubtracts.length > 0) {
    const deepestRelatedBottom = relatedSubtracts.reduce((min, subtract) => Math.min(min, subtract.bottomZ), Infinity)
    // Leave `axialLeave` stock above the floor defined by surrounding 2.5D pockets,
    // just like we do above the mesh bottom.
    effectiveBottom = Math.max(effectiveBottom, deepestRelatedBottom + axialLeave)
    if (effectiveBottom > modelTopZ + 1e-6) {
      return {
        operationId: operation.id,
        moves: [],
        warnings: ['Containing subtract feature leaves no roughing depth for this model'],
        bounds: null,
        stepLevels: [],
      }
    }
  }

  // ── Step levels ────────────────────────────────────────────────────────

  const stockTop = Math.max(modelTopZ, project.stock.thickness)
  const stepLevels = generateStepLevels(stockTop, effectiveBottom, operation.stepdown)

  // Include MAJOR floors + model top (adjusted by axial leave)
  const criticalLevels = [...floorLevels].map(f => f + axialLeave)

  // Note: stockTop itself is not added as a cut level — the first real pass is
  // one stepdown below it (generateStepLevels already handles that). A critical
  // level (floor + axialLeave) that coincides with stockTop is allowed; that
  // happens naturally when the stock height equals the model top, so the
  // model-top finishing pass lands at stockTop.
  const allCandidateLevels = new Set([...stepLevels, ...criticalLevels])
  const roughLevels = [...allCandidateLevels]
    .filter(z => z <= stockTop + 1e-9 && z >= effectiveBottom - 1e-9)
    .sort((a, b) => b - a)

  if (roughLevels.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['No step levels generated'],
      bounds: null,
      stepLevels: [],
    }
  }

  // ── Per-level: slice → build pocket region → offset + cut ──────────────

  const allMoves: ToolpathMove[] = []
  const warnings: string[] = []
  const allStepLevels = new Set<number>()

  const depthWarning = checkMaxCutDepthWarning(tool, Math.abs(stockTop - effectiveBottom))
  if (depthWarning) warnings.push(depthWarning)

  if (operation.debugToolpath) {
    warnings.push(
      `Debug: Z range ${stockTop.toFixed(4)} -> ${modelBottomZ.toFixed(4)}, bottom ${effectiveBottom.toFixed(4)}`,
    )
    warnings.push(`Debug: silhouette area = ${silhouetteArea.toFixed(4)}`)
    warnings.push(`Debug: floor candidate Zs = ${[...floorLevels].map(z => z.toFixed(4)).join(', ')}`)
    warnings.push(`Debug: rough levels = ${roughLevels.map((z) => z.toFixed(4)).join(', ')}`)
    warnings.push(`Debug: mesh triangles = ${index.length / 3}`)
    warnings.push(
      `Debug: initialInset=${initialInset.toFixed(4)} stepover=${effectiveStepover.toFixed(4)}`,
    )
  }

  let currentPosition: ToolpathPoint | null = null
  let protectedAbovePaths: ClipperPath[] = []
  let usedOpenSliceFallback = false
  const sliceSampleEpsilon = Math.max(Math.abs(modelTopZ - modelBottomZ) * 1e-6, 1e-6)

  for (const z of roughLevels) {
    // ═══ 1. Slice the triangle mesh at this Z - axialLeave ═══════════════
    //      To respect axial stock-to-leave, we must protect the model
    //      at a depth of (z - axialLeave). This prevents the tool from
    //      gouging flat surfaces or pocket floors at level z.
    const protectionZ = z - axialLeave

    // Slice just above protectionZ so a horizontal model surface AT protectionZ
    // (a pocket floor, model bottom, or the top deck itself) is treated as being
    // below the slice plane. This is what allows the finishing pass at
    // z = surface + axialLeave to clear the area directly above that surface.
    //
    // When protectionZ is at or above the model top, no model exists above the
    // slice plane — leave the slice empty so the entire outline is clearable.
    const sliceWithinModel = protectionZ <= modelTopZ - sliceSampleEpsilon
      && protectionZ >= modelBottomZ - sliceSampleEpsilon
    const sliceZ = Math.min(
      modelTopZ - sliceSampleEpsilon,
      Math.max(modelBottomZ + sliceSampleEpsilon, protectionZ + sliceSampleEpsilon),
    )

    const sliceResult = sliceWithinModel
      ? sliceMeshAtZDetailed(sliceIndex, sliceZ)
      : { polygons: [], openChainCount: 0, segmentCount: 0 }

    const slicePolygons = sliceResult.polygons
    const slicePaths = slicePolygonsToClipperPaths(slicePolygons)

    // ═══ 2. Build pocket region ══════════════════════════════════════════
    //      A unified clearing area is computed per level:
    //        Machinable = Outline - (ShadowOfSlicesAboveAndAtLevel + SurroundingProtected)
    //      We protect everything at or above (z - axialLeave).

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
      if (operation.debugToolpath) warnings.push(`Debug: Z=${z.toFixed(4)} outside active subtract pocket depth`)
      currentPosition = retractToSafe(allMoves, currentPosition, safeZ)
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
      ...slicePaths, // Protect current level's model surface (adjusted for axial leave)
      ...surroundingProtectedPaths,
    ])

    if (sliceResult.openChainCount > 0) {
      // If current slice is not watertight, fallback to silhouette protection
      // for this and all future (lower) levels.
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

    // Cleanup step: remove tiny artifact ridges with a small opening operation
    if (clearablePaths.length > 0) {
        const cleanupEpsilon = 1e-3
        clearablePaths = offsetClipperPaths(offsetClipperPaths(clearablePaths, -cleanupEpsilon), cleanupEpsilon)
    }

    if (operation.debugToolpath) {
        const sliceArea = calculateClipperArea(slicePaths)
        warnings.push(`Debug: Z=${z.toFixed(4)} protectionZ=${protectionZ.toFixed(4)} sliceArea=${sliceArea.toFixed(4)} protectedAbovePaths=${protectedAbovePaths.length} clearable=${clearablePaths.length}`)
    }

    if (clearablePaths.length === 0) {
      if (operation.debugToolpath) warnings.push(`Debug: Z=${z.toFixed(4)} fully protected — no clearance area`)
      currentPosition = retractToSafe(allMoves, currentPosition, safeZ)
    } else {
      const baseRegions = polyTreeToRegions(
        executeDifference(clearablePaths, []),
        [],
        [],
      )

      // ═══ 3. Apply initial inset (tool radius + radial leave) ══════════════
      const insetRegions = baseRegions.flatMap((baseRegion) => buildInsetRegions(baseRegion, initialInset))
      if (insetRegions.length === 0) {
        if (operation.debugToolpath) {
          warnings.push(`Debug: Z=${z.toFixed(4)} no machinable region after initial inset`)
        }
        currentPosition = retractToSafe(allMoves, currentPosition, safeZ)
      } else {
        // Machinable area exists. Record this level.
        allStepLevels.add(z)

        // Safe-link region for at-Z ring-to-ring linking inside this level.
        // Erode the clearable polygon by tool.radius — that's the tool-center
        // lane known to be free of the model and protected geometry. A link
        // segment sampled inside this region cannot gouge.
        const safeLinkPaths = offsetClipperPaths(clearablePaths, -tool.radius)
        const safeLinkSampleSpacing = Math.max(tool.radius * 0.5, effectiveStepover * 0.25)
        const safeLinkCheck = safeLinkPaths.length > 0
          ? (from: ToolpathPoint, to: ToolpathPoint): boolean =>
              segmentInsideClipperPaths(safeLinkPaths, from, to, safeLinkSampleSpacing)
          : undefined

        // ═══ 4. Order regions for efficient travel ════════════════════════════
        const orderedRegions = orderRegionsGreedy(
          insetRegions,
          currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
        )

        // ═══ 5. Recursively cut each region (offset inward by stepover) ══════
        for (const region of orderedRegions) {
          currentPosition = cutOffsetRegionRecursive(
            allMoves,
            region,
            z,
            safeZ,
            effectiveStepover,
            maxLinkDistance,
            currentPosition,
            direction,
            safeLinkCheck,
          )
        }
      }
    }

    // Accumulate for future (lower) levels.
    // If this slice is substantially solid (area > 95% silhouette), treat it as fully solid shadow.
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

  // ── Final retract to safe Z ────────────────────────────────────────────

  if (currentPosition && currentPosition.z !== safeZ) {
    retractToSafe(allMoves, currentPosition, safeZ)
  }

  // ── Bounds ─────────────────────────────────────────────────────────────

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
  }
}
