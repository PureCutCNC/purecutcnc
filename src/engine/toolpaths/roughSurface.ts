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
 *   1. Slice the 3D model triangle mesh at this Z to get the true 3D
 *      cross-section (works on any mesh, manifold or not)
 *   2. Use the computed silhouette outline as the outer boundary
 *   3. Build a pocket region with the slice(s) as inner islands (the
 *      model occupies this area — we must not cut there)
 *   4. Apply the initial tool-radius + radial-leave inset
 *   5. Use standard pocket recursive offsetting to generate concentric
 *      passes from the region boundary inward, stepover by stepover,
 *      stopping at the model surface
 */

import ClipperLib from 'clipper-lib'
import type { CutDirection, Operation, Point, Project } from '../../types/project'
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

// ── Constants ───────────────────────────────────────────────────────────

/** Epsilon for floating-point Z comparisons during mesh slicing. */
const Z_EPS = 1e-8

/** Epsilon for 2D point matching during segment chaining. */
const PT_EPS = 1e-6

// ── 3D → 2D mesh slicing (non-manifold safe) ───────────────────────────

interface Vec3 { x: number; y: number; z: number }

function lerp(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t }
}

/**
 * Compute the XY intersection point where edge (a→b) crosses the Z plane.
 * Returns null if the edge does not cross the plane.
 */
function edgeCrossZ(a: Vec3, b: Vec3, z: number): Vec3 | null {
  const dzA = a.z - z
  const dzB = b.z - z
  if (Math.abs(dzA) < Z_EPS) return a
  if (Math.abs(dzB) < Z_EPS) return b
  if (dzA * dzB > 0) return null // same side
  const t = -dzA / (dzB - dzA)
  return lerp(a, b, t)
}

/**
 * Slice a triangle mesh at Z height `z` by intersecting every triangle
 * with the horizontal plane. Works on **any** triangle mesh (manifold or not).
 *
 * Returns an array of closed polygon contours (each contour is an array
 * of [x, y] points).
 */
function sliceMeshAtZ(
  positions: Float32Array,
  index: Uint32Array,
  z: number,
): Array<Array<[number, number]>> {
  const segments: Array<[[number, number], [number, number]]> = []

  for (let i = 0; i < index.length; i += 3) {
    const i0 = index[i]
    const i1 = index[i + 1]
    const i2 = index[i + 2]

    const p0: Vec3 = {
      x: positions[i0 * 3],
      y: positions[i0 * 3 + 1],
      z: positions[i0 * 3 + 2],
    }
    const p1: Vec3 = {
      x: positions[i1 * 3],
      y: positions[i1 * 3 + 1],
      z: positions[i1 * 3 + 2],
    }
    const p2: Vec3 = {
      x: positions[i2 * 3],
      y: positions[i2 * 3 + 1],
      z: positions[i2 * 3 + 2],
    }

    // Classify vertices relative to the Z plane
    const dz = [p0.z - z, p1.z - z, p2.z - z]
    const above = dz.filter((d) => d > Z_EPS).length
    const below = dz.filter((d) => d < -Z_EPS).length

    // All on one side → no intersection
    if (above === 0 || below === 0) continue

    // Triangle crosses the plane — find intersection points on crossing edges
    const pts: Array<[number, number]> = []

    const e01 = edgeCrossZ(p0, p1, z)
    if (e01) pts.push([e01.x, e01.y])

    const e12 = edgeCrossZ(p1, p2, z)
    if (e12) pts.push([e12.x, e12.y])

    const e20 = edgeCrossZ(p2, p0, z)
    if (e20) pts.push([e20.x, e20.y])

    if (pts.length >= 2) {
      segments.push([pts[0], pts[1]])
    }
  }

  // Chain segments into closed polygons
  return chainSegments(segments)
}

/**
 * Key function for 2D point hashing in the adjacency map.
 */
function ptKey(x: number, y: number): string {
  return `${x.toFixed(6)},${y.toFixed(6)}`
}

/**
 * Chain unordered line segments into closed polygon contours.
 *
 * Builds an adjacency graph (point → neighbor points) and walks it
 * to extract closed loops.
 */
function chainSegments(
  segments: Array<[[number, number], [number, number]]>,
): Array<Array<[number, number]>> {
  if (segments.length === 0) return []

  // ── Build adjacency graph ──────────────────────────────────────────────
  // pointKey → { pt: [x,y], neighbors: [{ key, pt }] }
  const graph = new Map<
    string,
    { pt: [number, number]; neighbors: Array<{ key: string; pt: [number, number] }> }
  >()

  function ensureNode(x: number, y: number): string {
    const key = ptKey(x, y)
    if (!graph.has(key)) {
      graph.set(key, { pt: [x, y], neighbors: [] })
    }
    return key
  }

  for (const [a, b] of segments) {
    const ka = ensureNode(a[0], a[1])
    const kb = ensureNode(b[0], b[1])
    graph.get(ka)!.neighbors.push({ key: kb, pt: b })
    graph.get(kb)!.neighbors.push({ key: ka, pt: a })
  }

  // ── Walk the graph ─────────────────────────────────────────────────────
  const visited = new Set<string>()
  const polygons: Array<Array<[number, number]>> = []

  for (const [startKey, _startNode] of graph) {
    if (visited.has(startKey)) continue

    const poly: Array<[number, number]> = []
    let currentKey = startKey
    let prevKey: string | null = null

    while (true) {
      if (visited.has(currentKey)) {
        // Already visited — loop closed
        break
      }
      visited.add(currentKey)

      const node = graph.get(currentKey)!
      if (poly.length === 0) {
        // First point — add the start node's coordinates
        poly.push(node.pt)
      }

      // Pick next neighbor (prefer unvisited, avoid backtracking)
      let next: { key: string; pt: [number, number] } | null = null
      for (const n of node.neighbors) {
        if (n.key !== prevKey) {
          next = n
          break
        }
      }
      if (!next) break // dead end

      // If the next point would close the loop without adding new info, stop
      if (next.key === startKey) break

      poly.push(next.pt)
      prevKey = currentKey
      currentKey = next.key

      // Safety: prevent infinite loops with a max iteration count
      if (poly.length > segments.length * 2) break
    }

    if (poly.length >= 3) {
      // Ensure polygon is closed (last point ≈ first point)
      const first = poly[0]
      const last = poly[poly.length - 1]
      if (
        Math.abs(last[0] - first[0]) > PT_EPS ||
        Math.abs(last[1] - first[1]) > PT_EPS
      ) {
        poly.push(first)
      }
      polygons.push(poly)
    }
  }

  return polygons
}

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

/**
 * Compute the signed area of a Clipper path using the Shoelace formula.
 * Positive = counter-clockwise (outer), Negative = clockwise (hole).
 */
function clipperPathArea(path: ClipperPath): number {
  let area = 0
  const n = path.length
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    area += path[i].X * path[j].Y
    area -= path[j].X * path[i].Y
  }
  return area / 2
}

/**
 * Find the polygon with the largest signed area — the outermost contour.
 */
function largestPolygon(paths: ClipperPath[]): ClipperPath | null {
  if (paths.length === 0) return null
  let best = paths[0]
  let bestArea = -Infinity
  for (const path of paths) {
    const area = clipperPathArea(path)
    if (area > bestArea) {
      bestArea = area
      best = path
    }
  }
  return best
}

// ── Region helpers ──────────────────────────────────────────────────────

/**
 * Build a ResolvedPocketRegion from a computed outer boundary and slice
 * polygons (the model cross-section at a given Z).
 *
 * The outer boundary becomes the outer contour; each slice polygon becomes
 * an island (area the tool must avoid).
 */
function buildRegionFromSlice(
  outerBoundary: Point[],
  slicePolygons: Array<Array<[number, number]>>,
): ResolvedPocketRegion {
  const outer = normalizeWinding(outerBoundary, false)

  // Convert slice tuples to Point arrays, normalized as islands
  const islands: Point[][] = slicePolygons.map((poly) =>
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

  const modelFeature = project.features.find((f) => f.id === target.featureIds[0]) ?? null
  if (!modelFeature) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Target feature not found'],
      bounds: null,
      stepLevels: [],
    }
  }

  if (modelFeature.kind !== 'stl' || !modelFeature.stl?.fileData) {
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

  const modelProfile = flattenProfile(modelFeature.sketch.profile)
  const modelSilhouettePath = toClipperPath(modelProfile.points)
  const silhouetteOffset = tool.diameter + 2 * radialLeave
  const offsetSilhouette = offsetClipperPaths([modelSilhouettePath], silhouetteOffset)
  const largest = largestPolygon(offsetSilhouette)
  if (!largest || largest.length < 3) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Computed outer boundary is degenerate — model silhouette may be too small'],
      bounds: null,
      stepLevels: [],
    }
  }
  const outlinePolygon = clipperPathToPoints(largest)

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

  for (const z of stepLevels) {
    allStepLevels.add(z)

    // ═══ 1. Slice the triangle mesh at this Z ════════════════════════════
    const slicePolygons = sliceMeshAtZ(transformedPos, index, z)

    if (slicePolygons.length === 0) {
      if (operation.debugToolpath) warnings.push(`Debug: Z=${z.toFixed(4)} empty slice — no model at this level`)
      currentPosition = retractToSafe(allMoves, currentPosition, safeZ)
      continue
    }

    // ═══ 2. Build pocket region: silhouette outline = outer, slice = islands ══
    const baseRegion = buildRegionFromSlice(outlinePolygon, slicePolygons)

    // ═══ 3. Apply initial inset (tool radius + radial leave) ══════════════
    //      This offsets the outer INWARD and the islands OUTWARD, so the
    //      first pass respects the tool's physical radius.
    const insetRegions = buildInsetRegions(baseRegion, initialInset)
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
