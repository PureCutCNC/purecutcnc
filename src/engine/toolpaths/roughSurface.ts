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
 *
 * Rough Surface Operation
 *
 * A 3D roughing operation that clears the material around a 3D model
 * (STL mesh) at each step-down level.
 *
 * The outer boundary is computed automatically from the mesh silhouette
 * (the 2D projection of all triangles) offset by tool.diameter + 2 × stepover,
 * so no separate range/region feature is required.
 *
 * Algorithm (per Z level):
 *   1. Slice the 3D model triangle mesh at this Z and union it with all
 *      higher slices to get the top-down protected model shadow at this depth
 *   2. Use the computed silhouette outline as the outer boundary
 *   3. Build a pocket region with the protected shadow as inner islands
 *      (the model occupies this area at or above this Z — we must not cut there)
 *   4. Apply the initial tool-radius + radial-leave inset
 *   5. Use standard pocket recursive offsetting to generate concentric
 *      passes from the region boundary inward, stepover by stepover,
 *      stopping at the model surface
 */

import ClipperLib from 'clipper-lib'
import type { CutDirection, Operation, Point, Project, SketchFeature } from '../../types/project'
import type { ClipperPath, PocketToolpathResult, ToolpathBounds, ToolpathMove, ToolpathPoint } from './types'
import type { ResolvedPocketRegion } from './types'
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
  generateStepLevels,
  orderRegionsGreedy,
  retractToSafe,
  updateBounds,
} from './pocket'
import { loadSTLTransformedGeometry } from '../csg'
import { getMeshSliceIndex, sliceMeshAtZ } from './meshSlicing'
import { significantSilhouettePaths } from './silhouette'

/**
 * Convert a scaled Clipper path back to unscaled Point[].
 */
function clipperPathToPoints(path: ClipperPath): Point[] {
  const scale = DEFAULT_CLIPPER_SCALE
  return path.map((p) => ({ x: p.X / scale, y: p.Y / scale }))
}

/**
 * Offset a set of Clipper paths outward (or inward) by `delta` project units.
 */
function offsetClipperPaths(paths: ClipperPath[], delta: number): ClipperPath[] {
  if (paths.length === 0) return []
  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, Math.round(delta * DEFAULT_CLIPPER_SCALE))
  return solution as ClipperPath[]
}

function slicePolygonsToClipperPaths(slicePolygons: Array<Array<[number, number]>>): ClipperPath[] {
  return slicePolygons
    .filter((poly) => poly.length >= 3)
    .map((poly) => toClipperPath(
      normalizeWinding(poly.map(([x, y]) => ({ x, y })), false),
      DEFAULT_CLIPPER_SCALE,
    ))
}

function modelSilhouetteClipperPaths(modelFeature: SketchFeature): ClipperPath[] {
  if (modelFeature.kind === 'stl' && modelFeature.stl?.silhouettePaths?.length) {
    return significantSilhouettePaths(modelFeature.stl.silhouettePaths)
      .map((path) => toClipperPath(normalizeWinding(path, true), DEFAULT_CLIPPER_SCALE))
  }

  const modelProfile = flattenProfile(modelFeature.sketch.profile)
  return [toClipperPath(modelProfile.points)]
}

function unionClipperPaths(paths: ClipperPath[]): ClipperPath[] {
  if (paths.length === 0) return []

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

function clipperPathsToSlicePolygons(paths: ClipperPath[]): Array<Array<[number, number]>> {
  return paths
    .filter((path) => path.length >= 3)
    .map((path) => path.map((point) => [point.X / DEFAULT_CLIPPER_SCALE, point.Y / DEFAULT_CLIPPER_SCALE]))
}

// ── Region helpers ──────────────────────────────────────────────────────

/**
 * Build a ResolvedPocketRegion from a computed outer boundary and protected
 * model-shadow polygons for a given Z.
 *
 * The outer boundary becomes the outer contour; each protected polygon becomes
 * an island (area the tool must avoid because model material exists there at
 * this Z or above it).
 */
function buildRegionFromSlice(
  outerBoundary: Point[],
  protectedPolygons: Array<Array<[number, number]>>,
): ResolvedPocketRegion {
  const outer = normalizeWinding(outerBoundary, false)

  // Convert protected-shadow tuples to Point arrays, normalized as islands.
  const islands: Point[][] = protectedPolygons.map((poly) =>
    normalizeWinding(
      poly.map(([x, y]) => ({ x, y })),
      false,
    ),
  )

  return {
    outer,
    islands,
    targetFeatureIds: [],
    islandFeatureIds: [],
  }
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

  const targetFeatures = target.featureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is Project['features'][number] => feature !== null)

  if (targetFeatures.length !== target.featureIds.length) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['One or more target features not found'],
      bounds: null,
      stepLevels: [],
    }
  }

  const modelFeature = targetFeatures.find((feature) => feature.operation === 'model' && feature.kind === 'stl') ?? null
  if (!modelFeature?.stl?.fileData) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Model feature must be an imported STL model'],
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
      warnings: ['Failed to load STL geometry'],
      bounds: null,
      stepLevels: [],
    }
  }

  const { positions: transformedPos, index } = stlData
  const sliceIndex = getMeshSliceIndex(stlData)

  // ── Compute Z bounds from transformed positions ───────────────────────

  let modelTopZ = -Infinity
  let modelBottomZ = Infinity
  for (let i = 0; i < transformedPos.length; i += 3) {
    const z = transformedPos[i + 2]
    if (z > modelTopZ) modelTopZ = z
    if (z < modelBottomZ) modelBottomZ = z
  }

  // ── Operation parameters ───────────────────────────────────────────────

  const radialLeave = Math.max(0, operation.stockToLeaveRadial)
  const axialLeave = Math.max(0, operation.stockToLeaveAxial)
  const effectiveBottom = modelBottomZ + axialLeave
  if (effectiveBottom >= modelTopZ) {
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

  // ── Step levels ────────────────────────────────────────────────────────

  const stepLevels = generateStepLevels(modelTopZ, effectiveBottom, operation.stepdown)
  if (stepLevels.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['No step levels generated'],
      bounds: null,
      stepLevels: [],
    }
  }

  // ── Pocket-style parameters ────────────────────────────────────────────

  const safeZ = getOperationSafeZ(project)
  const stepoverDistance = tool.diameter * stepoverRatio
  const maxLinkDistance = tool.diameter
  const direction: CutDirection = operation.cutDirection ?? 'conventional'
  const initialInset = tool.radius + radialLeave
  const minStepover = 1 / DEFAULT_CLIPPER_SCALE
  const effectiveStepover = Math.max(stepoverDistance, minStepover)

  // ── Compute outer boundary from model's 2D silhouette (sketch profile) ─
  //      The STL import stores the projected silhouette as the feature's
  //      sketch profile. Flatten → convert to Clipper path → offset outward
  //      by tool.diameter + 2 × radial stock-to-leave so the tool can enter
  //      from outside the model's projected footprint.

  const modelSilhouettePaths = modelSilhouetteClipperPaths(modelFeature)
  const silhouetteOffset = tool.diameter + 2 * radialLeave
  const offsetSilhouette = offsetClipperPaths(unionClipperPaths(modelSilhouettePaths), silhouetteOffset)
  const outlinePolygons = offsetSilhouette
    .filter((path) => path.length >= 3)
    .map(clipperPathToPoints)
  if (outlinePolygons.length === 0) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Computed outer boundary is degenerate — model silhouette may be too small'],
      bounds: null,
      stepLevels: [],
    }
  }

  // ── Per-level: slice → build pocket region → offset + cut ──────────────

  const allMoves: ToolpathMove[] = []
  const warnings: string[] = []
  const allStepLevels = new Set<number>()

  const depthWarning = checkMaxCutDepthWarning(tool, Math.abs(modelTopZ - effectiveBottom))
  if (depthWarning) warnings.push(depthWarning)

  if (operation.debugToolpath) {
    warnings.push(
      `Debug: Z range ${modelTopZ.toFixed(4)} -> ${modelBottomZ.toFixed(4)}, bottom ${effectiveBottom.toFixed(4)}`,
    )
    warnings.push(`Debug: levels = ${stepLevels.map((z) => z.toFixed(4)).join(', ')}`)
    warnings.push(`Debug: mesh triangles = ${index.length / 3}`)
    warnings.push(
      `Debug: initialInset=${initialInset.toFixed(4)} stepover=${effectiveStepover.toFixed(4)}`,
    )
  }

  let currentPosition: ToolpathPoint | null = null
  let protectedSlicePaths: ClipperPath[] = []
  const sliceSampleEpsilon = Math.max(Math.abs(modelTopZ - modelBottomZ) * 1e-6, 1e-6)

  for (const z of stepLevels) {
    allStepLevels.add(z)

    // ═══ 1. Slice the triangle mesh at this Z ════════════════════════════
    const sliceZ = z >= modelTopZ - sliceSampleEpsilon
      ? Math.max(modelBottomZ + sliceSampleEpsilon, modelTopZ - sliceSampleEpsilon)
      : z
    const slicePolygons = sliceMeshAtZ(sliceIndex, sliceZ)
    if (slicePolygons.length > 0) {
      protectedSlicePaths = unionClipperPaths([
        ...protectedSlicePaths,
        ...slicePolygonsToClipperPaths(slicePolygons),
      ])
    }

    if (protectedSlicePaths.length === 0) {
      if (operation.debugToolpath) warnings.push(`Debug: Z=${z.toFixed(4)} empty slice — no model at this level`)
      currentPosition = retractToSafe(allMoves, currentPosition, safeZ)
      continue
    }

    // ═══ 2. Build pocket region: silhouette outline = outer, protected model shadow = islands ══
    const protectedPolygons = clipperPathsToSlicePolygons(protectedSlicePaths)
    const baseRegions = outlinePolygons.map((outlinePolygon) => buildRegionFromSlice(outlinePolygon, protectedPolygons))

    // ═══ 3. Apply initial inset (tool radius + radial leave) ══════════════
    //      This offsets the outer INWARD and the islands OUTWARD, so the
    //      first pass respects the tool's physical radius.
    const insetRegions = baseRegions.flatMap((baseRegion) => buildInsetRegions(baseRegion, initialInset))
    if (insetRegions.length === 0) {
      if (operation.debugToolpath) {
        warnings.push(`Debug: Z=${z.toFixed(4)} no machinable region after initial inset`)
      }
      currentPosition = retractToSafe(allMoves, currentPosition, safeZ)
      continue
    }

    // ═══ 4. Order regions for efficient travel ════════════════════════════
    const orderedRegions = orderRegionsGreedy(
      insetRegions,
      currentPosition ? { x: currentPosition.x, y: currentPosition.y } : null,
    )

    // ═══ 5. Recursively cut each region (offset inward by stepover) ═══════
    //        The generalized transitionToCutEntry (used by cutClosedContours
    //        inside cutOffsetRegionRecursive) now handles 3D cut links
    //        across Z levels automatically, so no explicit Z-level linking
    //        is needed here.
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
      )
    }
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
