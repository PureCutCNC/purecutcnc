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

/**
 * The 2.5D material that stays standing around an imported model (issue #773).
 *
 * Every surface operation used to decide whether an add feature was an
 * obstacle by asking whether it *contained* the model's machining envelope, and
 * dropped the ones that did as "base / stock geometry". A dropped add was then
 * ignored outright, so a plate under the model was cut straight through, and
 * the walls of a pocket sunk into that plate were gouged wherever the model's
 * silhouette crossed them. Rough and cleanup were only right on the reporter's
 * file because a 1/4" tool happened to grow their level outline past the plate
 * edge, which made the plate non-containing.
 *
 * This module models exactly those dropped adds, minus the subtracts cut into
 * them, as a stack of Z bands. Each call site keeps its own containment test,
 * so an add it already protects keeps today's handling, and only the geometry
 * that was being ignored changes.
 */

import type { Point, Project, SketchFeature } from '../../types/project'
import type { ClipperPath, NormalizedTool } from './types'
import { DEFAULT_CLIPPER_SCALE, resolveFeatureZSpan } from './geometry'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import {
  differenceClipperPaths,
  featureFootprintPaths,
  intersectClipperPaths,
  offsetClipperPaths,
  pathsContainEnvelope,
  unionClipperPaths,
} from './modelProtection'

/**
 * How close to tangent the cutter may come to retained material, in both the
 * lateral and the vertical sense. Four Clipper units, for the reason
 * `CLAMP_KEEPOUT_EPSILON` gives: feature footprints and the passes laid out
 * against them are Clipper results that agree only to the integer scale, so a
 * pass that is meant to touch a wall lands a unit or two either side of it.
 */
export const RETAINED_CONTACT_TOLERANCE = 4 / DEFAULT_CLIPPER_SCALE

/**
 * How far a tip may sit under a retained top before it counts as cutting it.
 * Z is never Clipper-rounded, so this is float noise and not the lateral
 * tolerance above: four Clipper units of Z let an inch-project finish ride
 * 0.0004 in into a plate. It is the #711 unmachinable-surface epsilon, so a
 * mesh flat that coincides with a plate top is judged the way a flat on a
 * subtract floor already is.
 */
const RETAINED_Z_TOLERANCE = 1e-6

const Z_EPSILON = 1e-9

/**
 * How finely a move near a band boundary is sampled, as a fraction of the tool
 * radius. A chord of length `s` grazing a disc of radius `r` hides a sagitta of
 * about `s^2 / 8r`; at `r / 32` that is `r / 8192`, which stays under
 * {@link RETAINED_CONTACT_TOLERANCE} for any cutter up to 3 mm radius in a mm
 * project and any cutter at all in an inch one.
 */
const SAMPLES_PER_RADIUS = 32

export interface RetainedMaterialBand {
  bottomZ: number
  topZ: number
  /** Footprint of the material standing between `bottomZ` and `topZ`. */
  paths: ClipperPath[]
}

export interface RetainedMaterial {
  bands: RetainedMaterialBand[]
  /**
   * Footprint of every band with material above `z`: what the cutter body
   * occupies with its tip at `z`. A tip exactly on a top face or on a pocket
   * floor is touching that material, not cutting it.
   */
  footprintAbove(z: number): ClipperPath[]
}

/**
 * The non-target adds whose footprint, grown by `expansion`, contains
 * `envelopePaths`: exactly the ones `buildProtectedFootprintPaths` skips when
 * handed the same envelope and expansion.
 */
export function containingAddFeatures(
  project: Project,
  targetFeatureIds: Set<string>,
  envelopePaths: ClipperPath[],
  expansion: number,
): SketchFeature[] {
  if (envelopePaths.length === 0) return []
  const adds: SketchFeature[] = []
  for (const feature of resolvedProjectFeatures(project)) {
    if (targetFeatureIds.has(feature.id) || feature.operation !== 'add') continue
    const footprint = featureFootprintPaths(feature)
    if (footprint.length === 0) continue
    if (pathsContainEnvelope(offsetClipperPaths(footprint, Math.max(0, expansion)), envelopePaths)) {
      adds.push(feature)
    }
  }
  return adds
}

interface FeatureSolid {
  paths: ClipperPath[]
  minZ: number
  maxZ: number
}

function spansBand(solid: FeatureSolid, midZ: number): boolean {
  return solid.minZ < midZ && solid.maxZ > midZ
}

/**
 * Bands of `adds` minus every non-target subtract cut into them, or `null` when
 * nothing is left standing. Band breakpoints are the features' own Z values, so
 * a pocket in a plate comes out as the plate below the pocket floor and the
 * frame around the pocket above it.
 */
export function buildRetainedMaterial(
  project: Project,
  targetFeatureIds: Set<string>,
  adds: SketchFeature[],
): RetainedMaterial | null {
  const solidOf = (feature: SketchFeature): FeatureSolid => {
    const span = resolveFeatureZSpan(project, feature)
    return { paths: featureFootprintPaths(feature), minZ: span.min, maxZ: span.max }
  }
  const standing = adds.map(solidOf).filter((solid) => solid.paths.length > 0)
  if (standing.length === 0) return null

  const standingUnion = unionClipperPaths(standing.flatMap((solid) => solid.paths))
  const cuts: FeatureSolid[] = []
  for (const feature of resolvedProjectFeatures(project)) {
    if (targetFeatureIds.has(feature.id) || feature.operation !== 'subtract') continue
    const solid = solidOf(feature)
    if (solid.paths.length > 0 && intersectClipperPaths(solid.paths, standingUnion).length > 0) cuts.push(solid)
  }

  const breakpoints = [...standing, ...cuts]
    .flatMap((solid) => [solid.minZ, solid.maxZ])
    .sort((a, b) => a - b)
    .filter((z, index, sorted) => index === 0 || z - sorted[index - 1] > Z_EPSILON)

  const bands: RetainedMaterialBand[] = []
  for (let index = 0; index + 1 < breakpoints.length; index += 1) {
    const bottomZ = breakpoints[index]
    const topZ = breakpoints[index + 1]
    const midZ = (bottomZ + topZ) / 2
    const addsHere = standing.filter((solid) => spansBand(solid, midZ))
    if (addsHere.length === 0) continue
    const cutsHere = cuts.filter((solid) => spansBand(solid, midZ))
    const union = unionClipperPaths(addsHere.flatMap((solid) => solid.paths))
    const paths = cutsHere.length > 0
      ? differenceClipperPaths(union, unionClipperPaths(cutsHere.flatMap((solid) => solid.paths)))
      : union
    if (paths.length > 0) bands.push({ bottomZ, topZ, paths })
  }
  if (bands.length === 0) return null

  // Prefix unions from the highest top down, so a query is a scan over a
  // handful of bands rather than a Clipper union per call.
  const byTop = [...bands].sort((a, b) => b.topZ - a.topZ)
  const above: ClipperPath[][] = []
  let accumulated: ClipperPath[] = []
  for (const band of byTop) {
    accumulated = unionClipperPaths([...accumulated, ...band.paths])
    above.push(accumulated)
  }

  return {
    bands,
    footprintAbove(z: number): ClipperPath[] {
      let count = 0
      while (count < byTop.length && byTop[count].topZ > z + Z_EPSILON) count += 1
      return count === 0 ? [] : above[count - 1]
    },
  }
}

/**
 * Exact distance queries against one band footprint: a uniform grid of the
 * footprint's edges for the nearest-edge search, and the same edges bucketed by
 * row for an even-odd containment test.
 */
class FootprintIndex {
  private readonly edges: Float64Array
  private readonly minX: number
  private readonly minY: number
  private readonly maxX: number
  private readonly maxY: number
  private readonly cellSize: number
  private readonly columns: number
  private readonly rows: number
  private readonly cells: Array<number[] | undefined>
  private readonly rowEdges: Array<number[] | undefined>
  private readonly reach: number

  constructor(paths: ClipperPath[], reach: number) {
    this.reach = reach
    const coordinates: number[] = []
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const path of paths) {
      for (let index = 0; index < path.length; index += 1) {
        const from = path[index]
        const to = path[(index + 1) % path.length]
        const ax = from.X / DEFAULT_CLIPPER_SCALE, ay = from.Y / DEFAULT_CLIPPER_SCALE
        const bx = to.X / DEFAULT_CLIPPER_SCALE, by = to.Y / DEFAULT_CLIPPER_SCALE
        coordinates.push(ax, ay, bx, by)
        minX = Math.min(minX, ax); maxX = Math.max(maxX, ax)
        minY = Math.min(minY, ay); maxY = Math.max(maxY, ay)
      }
    }
    this.edges = new Float64Array(coordinates)
    // A cell never narrower than the reach keeps a distance query to a 3 x 3
    // neighbourhood; the span cap bounds the grid on a small cutter.
    const span = Math.max(maxX - minX, maxY - minY, 0)
    this.cellSize = Math.max(reach, span / 128, 1e-9)
    this.minX = minX - reach
    this.minY = minY - reach
    this.maxX = maxX + reach
    this.maxY = maxY + reach
    this.columns = Math.floor((this.maxX - this.minX) / this.cellSize) + 1
    this.rows = Math.floor((this.maxY - this.minY) / this.cellSize) + 1
    this.cells = new Array(this.columns * this.rows)
    this.rowEdges = new Array(this.rows)
    for (let edge = 0; edge * 4 < this.edges.length; edge += 1) {
      const ax = this.edges[edge * 4], ay = this.edges[edge * 4 + 1]
      const bx = this.edges[edge * 4 + 2], by = this.edges[edge * 4 + 3]
      const rowFrom = this.rowOf(Math.min(ay, by)), rowTo = this.rowOf(Math.max(ay, by))
      const columnFrom = this.columnOf(Math.min(ax, bx)), columnTo = this.columnOf(Math.max(ax, bx))
      for (let row = rowFrom; row <= rowTo; row += 1) {
        ;(this.rowEdges[row] ??= []).push(edge)
        for (let column = columnFrom; column <= columnTo; column += 1) {
          ;(this.cells[row * this.columns + column] ??= []).push(edge)
        }
      }
    }
  }

  private columnOf(x: number): number {
    return Math.min(this.columns - 1, Math.max(0, Math.floor((x - this.minX) / this.cellSize)))
  }

  private rowOf(y: number): number {
    return Math.min(this.rows - 1, Math.max(0, Math.floor((y - this.minY) / this.cellSize)))
  }

  contains(x: number, y: number): boolean {
    if (x < this.minX || x > this.maxX || y < this.minY || y > this.maxY) return false
    let inside = false
    for (const edge of this.rowEdges[this.rowOf(y)] ?? []) {
      const ax = this.edges[edge * 4], ay = this.edges[edge * 4 + 1]
      const bx = this.edges[edge * 4 + 2], by = this.edges[edge * 4 + 3]
      if ((ay > y) !== (by > y) && x < ax + ((y - ay) * (bx - ax)) / (by - ay)) inside = !inside
    }
    return inside
  }

  /** True when some edge may lie within reach of the box; false proves none does. */
  boundaryNear(minX: number, minY: number, maxX: number, maxY: number): boolean {
    if (maxX + this.reach < this.minX || minX - this.reach > this.maxX) return false
    if (maxY + this.reach < this.minY || minY - this.reach > this.maxY) return false
    const columnTo = this.columnOf(maxX + this.reach)
    const rowTo = this.rowOf(maxY + this.reach)
    for (let row = this.rowOf(minY - this.reach); row <= rowTo; row += 1) {
      for (let column = this.columnOf(minX - this.reach); column <= columnTo; column += 1) {
        if (this.cells[row * this.columns + column]) return true
      }
    }
    return false
  }

  /** 0 inside, the distance to the boundary when under `reach`, otherwise Infinity. */
  distance(x: number, y: number): number {
    if (this.contains(x, y)) return 0
    if (!this.boundaryNear(x, y, x, y)) return Infinity
    let best = Infinity
    const columnTo = this.columnOf(x + this.reach)
    const rowTo = this.rowOf(y + this.reach)
    for (let row = this.rowOf(y - this.reach); row <= rowTo; row += 1) {
      for (let column = this.columnOf(x - this.reach); column <= columnTo; column += 1) {
        for (const edge of this.cells[row * this.columns + column] ?? []) {
          const ax = this.edges[edge * 4], ay = this.edges[edge * 4 + 1]
          const dx = this.edges[edge * 4 + 2] - ax, dy = this.edges[edge * 4 + 3] - ay
          const lengthSq = dx * dx + dy * dy
          const t = lengthSq > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (y - ay) * dy) / lengthSq)) : 0
          best = Math.min(best, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)))
        }
      }
    }
    return best < this.reach ? best : Infinity
  }
}

export interface RetainedPolylineRun<T extends Point> {
  points: T[]
  closed: boolean
}

export interface RetainedMaterialCheck {
  /** The lowest tip Z that keeps the cutter out of every band, stock to leave included. */
  requiredTipZ(x: number, y: number): number
  /** Does a straight move keep the cutter out of retained material along its whole length? */
  segmentIsClear(from: Point & { z: number }, to: Point & { z: number }): boolean
  /**
   * Split a polyline into the runs that keep the cutter clear. Returns the input
   * unchanged, as its only run, when nothing is violated.
   *
   * `zOf` gives a vertex's Z, `create` builds a vertex for a split point at the
   * interpolated Z, and `sampleZ`, when given, is the Z the caller will actually
   * emit at a split point — a split point is kept only if both are clear.
   */
  splitPolyline<T extends Point>(
    points: T[],
    closed: boolean,
    zOf: (point: T) => number,
    create: (x: number, y: number, z: number) => T,
    sampleZ?: (point: Point) => number,
  ): Array<RetainedPolylineRun<T>>
}

/**
 * The cutter-body check every surface finish runs its passes and links through.
 *
 * Distances are exact against the band footprints rather than rasterised, so a
 * wall is not aliased to a height-map cell and a wall outside the mesh bounding
 * box is still seen. The profiles are `safeToolTipZAt`'s: a ball clears a top
 * edge at lateral distance `d` with its tip at `top - r + sqrt(r^2 - d^2)`, a
 * V-bit at `top - d * cot(half angle)`, anything else at `top`.
 */
export function buildRetainedMaterialCheck(
  material: RetainedMaterial,
  tool: NormalizedTool,
  axialLeave: number,
): RetainedMaterialCheck {
  const radius = tool.radius
  const leave = Math.max(0, axialLeave)
  const isBall = tool.type === 'ball_endmill'
  const cotHalfAngle = tool.type === 'v_bit' && tool.vBitAngle && tool.vBitAngle > 0
    ? 1 / Math.tan((tool.vBitAngle / 2) * Math.PI / 180)
    : 0
  const tolerance = RETAINED_CONTACT_TOLERANCE
  const spacing = Math.max(radius / SAMPLES_PER_RADIUS, tolerance)
  // Highest top first: a profile never rises above its band's top, so a scan can
  // stop at the first band too low to matter.
  const bands = [...material.bands]
    .sort((a, b) => b.topZ - a.topZ)
    .map((band) => ({ topZ: band.topZ, index: new FootprintIndex(band.paths, radius) }))

  const profileZ = (topZ: number, distance: number): number | null => {
    if (!(distance < radius - tolerance)) return null
    if (isBall) return topZ - radius + Math.sqrt(radius * radius - distance * distance)
    if (cotHalfAngle > 0) return topZ - distance * cotHalfAngle
    return topZ
  }

  const pointIsClear = (x: number, y: number, z: number): boolean => {
    for (const band of bands) {
      if (band.topZ + leave <= z + RETAINED_Z_TOLERANCE) return true
      const required = profileZ(band.topZ, band.index.distance(x, y))
      if (required !== null && z + RETAINED_Z_TOLERANCE < required + leave) return false
    }
    return true
  }

  const segmentIsClear = (from: Point & { z: number }, to: Point & { z: number }): boolean => {
    const lowZ = Math.min(from.z, to.z)
    const minX = Math.min(from.x, to.x), maxX = Math.max(from.x, to.x)
    const minY = Math.min(from.y, to.y), maxY = Math.max(from.y, to.y)
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    for (const band of bands) {
      if (band.topZ + leave <= lowZ + RETAINED_Z_TOLERANCE) return true
      if (!band.index.boundaryNear(minX, minY, maxX, maxY)) {
        // No edge within reach of the move: the band is under all of it or none
        // of it, and its constraint is the flat top.
        if (band.index.contains(from.x, from.y) && lowZ + RETAINED_Z_TOLERANCE < band.topZ + leave) return false
        continue
      }
      const steps = Math.max(1, Math.ceil(length / spacing))
      for (let step = 0; step <= steps; step += 1) {
        const t = step / steps
        const x = from.x + (to.x - from.x) * t
        const y = from.y + (to.y - from.y) * t
        const z = from.z + (to.z - from.z) * t
        const required = profileZ(band.topZ, band.index.distance(x, y))
        if (required !== null && z + RETAINED_Z_TOLERANCE < required + leave) return false
      }
    }
    return true
  }

  const splitPolyline = <T extends Point>(
    points: T[],
    closed: boolean,
    zOf: (point: T) => number,
    create: (x: number, y: number, z: number) => T,
    sampleZ?: (point: Point) => number,
  ): Array<RetainedPolylineRun<T>> => {
    if (points.length < 2) return [{ points, closed }]
    const edgeCount = closed ? points.length : points.length - 1
    const vertex = (point: T): Point & { z: number } => ({ x: point.x, y: point.y, z: zOf(point) })
    let allClear = true
    for (let index = 0; index < edgeCount && allClear; index += 1) {
      allClear = segmentIsClear(vertex(points[index]), vertex(points[(index + 1) % points.length]))
    }
    if (allClear) return [{ points, closed }]

    const runs: Array<RetainedPolylineRun<T>> = []
    let current: T[] = []
    const flush = (): void => {
      if (current.length >= 2) runs.push({ points: current, closed: false })
      current = []
    }
    const startsAtFirstVertex: boolean[] = []
    for (let index = 0; index < edgeCount; index += 1) {
      const fromPoint = points[index]
      const toPoint = points[(index + 1) % points.length]
      const from = vertex(fromPoint)
      const to = vertex(toPoint)
      if (segmentIsClear(from, to)) {
        if (current.length === 0) {
          startsAtFirstVertex[runs.length] = index === 0
          current.push(fromPoint)
        }
        current.push(toPoint)
        continue
      }
      const steps = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / spacing))
      for (let step = 0; step <= steps; step += 1) {
        // The previous edge already ended on this vertex.
        if (step === 0 && current.length > 0 && current[current.length - 1] === fromPoint) continue
        const t = step / steps
        const x = from.x + (to.x - from.x) * t
        const y = from.y + (to.y - from.y) * t
        const z = from.z + (to.z - from.z) * t
        const emittedZ = step === 0 || step === steps || !sampleZ ? z : Math.min(z, sampleZ({ x, y }))
        if (!pointIsClear(x, y, emittedZ)) {
          flush()
          continue
        }
        if (current.length === 0) startsAtFirstVertex[runs.length] = index === 0 && step === 0
        current.push(step === 0 ? fromPoint : step === steps ? toPoint : create(x, y, z))
      }
    }
    // A closed contour that is clear across its seam comes out as a last run
    // ending on the first vertex and a first run starting on it: rejoin them.
    const lastEndsOnSeam = closed && current.length >= 2 && current[current.length - 1] === points[0]
    flush()
    if (lastEndsOnSeam && runs.length >= 2 && startsAtFirstVertex[0]) {
      const last = runs.pop()!
      runs[0] = { points: [...last.points, ...runs[0].points.slice(1)], closed: false }
    }
    return runs
  }

  return {
    requiredTipZ(x: number, y: number): number {
      let required = -Infinity
      for (const band of bands) {
        if (band.topZ + leave <= required) break
        const z = profileZ(band.topZ, band.index.distance(x, y))
        if (z !== null && z + leave > required) required = z + leave
      }
      return required
    },
    segmentIsClear,
    splitPolyline,
  }
}
