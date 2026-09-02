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
import type { Operation, Point } from '../../types/project'
import { addOpenSubject, openPathsFromPolyTree } from '../clipperOpenPaths'
import type { HeightMap } from './finishSurfaceParallel'
import { DEFAULT_CLIPPER_SCALE } from './geometry'
import { pointInClipperPaths, unionClipperPaths } from './modelProtection'
import { resolveRegionDomainCentre } from './regionDomain'
import type { ClipperPath } from './types'
import type { ToolpathWarning } from './warningCodes'

export interface SurfaceSlopeRange { min: number; max: number }

/** Missing bounds disable filtering; one missing bound means 0 or 90 degrees.
 * Do not coerce malformed saved values (including null) into unrestricted cuts. */
export function surfaceSlopeRange(operation: Operation): SurfaceSlopeRange | null | 'invalid' {
  if (operation.finishSlopeMin === undefined && operation.finishSlopeMax === undefined) return null
  const min = operation.finishSlopeMin === undefined ? 0 : operation.finishSlopeMin
  const max = operation.finishSlopeMax === undefined ? 90 : operation.finishSlopeMax
  return typeof min === 'number' && typeof max === 'number'
    && Number.isFinite(min) && Number.isFinite(max) && min >= 0 && max <= 90 && min <= max
    ? { min, max } : 'invalid'
}

// A checkerboard slope mask must not expand a bounded height map into millions
// of polygon objects. Refuse visibly rather than drop pieces of its domain.
const MAX_SLOPE_RECTANGLES = 50_000

/** CL-surface slope at cell centres. Use the larger one-sided derivative on
 * each axis so opposite slopes at a ridge cannot cancel into a false flat.
 * One-sided differences at the map perimeter are valid; a missing interior
 * neighbour is unknown, not a zero gradient. Boundaries have one-cell spatial
 * resolution; no cutter-radius dilation or inferred seam overlap is applied. */
export function buildSurfaceSlopeDomain(
  operation: Operation,
  heightMap: HeightMap,
  toolTipZAt: (x: number, y: number) => number,
  warnings: ToolpathWarning[],
): ClipperPath[] | null {
  const range = surfaceSlopeRange(operation)
  if (range === null) return null
  if (range === 'invalid') {
    warnings.push({ code: 'finishSlopeInvalid' })
    return []
  }
  const { width, height, cellSize, originX, originY } = heightMap
  const cl = new Float64Array(width * height).fill(NaN)
  for (let row = 0; row < height; row += 1) {
    for (let col = 0; col < width; col += 1) {
      const at = row * width + col
      if (Number.isFinite(heightMap.data[at])) {
        cl[at] = toolTipZAt(originX + (col + 0.5) * cellSize, originY + (row + 0.5) * cellSize)
      }
    }
  }
  const derivative = (at: number, position: number, size: number, stride: number): number => {
    if (size < 2 || !Number.isFinite(cl[at])) return NaN
    const left = position > 0 ? Math.abs(cl[at] - cl[at - stride]) / cellSize : 0
    const right = position + 1 < size ? Math.abs(cl[at + stride] - cl[at]) / cellSize : 0
    return Math.max(left, right)
  }
  const eligible = (col: number, row: number): boolean => {
    const at = row * width + col
    const dx = derivative(at, col, width, 1)
    const dy = derivative(at, row, height, width)
    const degrees = Math.atan(Math.hypot(dx, dy)) * 180 / Math.PI
    return Number.isFinite(degrees) && degrees >= range.min - 1e-8 && degrees <= range.max + 1e-8
  }
  const rectangles: ClipperPath[] = []
  let previous = new Map<string, ClipperPath>()
  const sx = (col: number): number => Math.round((originX + col * cellSize) * DEFAULT_CLIPPER_SCALE)
  const sy = (row: number): number => Math.round((originY + row * cellSize) * DEFAULT_CLIPPER_SCALE)
  for (let row = 0; row < height; row += 1) {
    const next = new Map<string, ClipperPath>()
    for (let col = 0; col < width;) {
      if (!eligible(col, row)) { col += 1; continue }
      const start = col
      while (col < width && eligible(col, row)) col += 1
      const key = `${start}:${col}`
      const prior = previous.get(key)
      if (prior) {
        prior[2].Y = sy(row + 1)
        prior[3].Y = sy(row + 1)
        next.set(key, prior)
      } else {
        if (rectangles.length >= MAX_SLOPE_RECTANGLES) {
          warnings.push({ code: 'finishSlopeTooComplex' })
          return []
        }
        const path = [
          { X: sx(start), Y: sy(row) }, { X: sx(col), Y: sy(row) },
          { X: sx(col), Y: sy(row + 1) }, { X: sx(start), Y: sy(row + 1) },
        ]
        rectangles.push(path)
        next.set(key, path)
      }
    }
    previous = next
  }
  const domain = unionClipperPaths(rectangles)
  if (domain.length === 0) warnings.push({ code: 'finishSlopeEmpty' })
  return domain
}

/** The slope mask is already in tool-centre space, so its inset is zero. */
export function intersectSurfaceSlopeDomain(domain: ClipperPath[], slope: ClipperPath[]): ClipperPath[] {
  if (slope.length === 0) return []
  return resolveRegionDomainCentre(domain, {
    paths: slope, hasIncludeRegions: true, excludePaths: [], boundaryPaths: slope,
    entries: [{ mode: 'include', paths: slope }], baseIncludesSubject: false,
    containsPoint: (point) => pointInClipperPaths(slope, point),
  }, 0)
}

interface IntegerBounds { minX: number; minY: number; maxX: number; maxY: number }

interface BoundedDomainPath extends IntegerBounds {
  path: ClipperPath
  edges: IntegerBounds[]
}

function boundsOverlap(a: IntegerBounds, b: IntegerBounds): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}

/** Build the exact link predicate once per generated operation. Path and edge
 * bounds reject the common case without constructing Clipper state; a link
 * that can touch any boundary still uses an exact open-path difference. */
export function createSurfaceDomainLinkCheck(paths: ClipperPath[]): (from: Point, to: Point) => boolean {
  const boundedPaths: BoundedDomainPath[] = paths.filter((path) => path.length >= 3).map((path) => {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const edges: IntegerBounds[] = []
    for (let i = 0; i < path.length; i += 1) {
      const from = path[i]
      const to = path[(i + 1) % path.length]
      minX = Math.min(minX, from.X)
      minY = Math.min(minY, from.Y)
      maxX = Math.max(maxX, from.X)
      maxY = Math.max(maxY, from.Y)
      edges.push({
        minX: Math.min(from.X, to.X), minY: Math.min(from.Y, to.Y),
        maxX: Math.max(from.X, to.X), maxY: Math.max(from.Y, to.Y),
      })
    }
    return { path, edges, minX, minY, maxX, maxY }
  })

  return (from: Point, to: Point): boolean => {
    const a = { X: Math.round(from.x * DEFAULT_CLIPPER_SCALE), Y: Math.round(from.y * DEFAULT_CLIPPER_SCALE) }
    const b = { X: Math.round(to.x * DEFAULT_CLIPPER_SCALE), Y: Math.round(to.y * DEFAULT_CLIPPER_SCALE) }
    const segmentBounds = {
      minX: Math.min(a.X, b.X), minY: Math.min(a.Y, b.Y),
      maxX: Math.max(a.X, b.X), maxY: Math.max(a.Y, b.Y),
    }
    const candidates: ClipperPath[] = []
    let mayCrossBoundary = false
    for (const bounded of boundedPaths) {
      if (!boundsOverlap(bounded, segmentBounds)) continue
      candidates.push(bounded.path)
      if (!mayCrossBoundary && bounded.edges.some((edge) => boundsOverlap(edge, segmentBounds))) {
        mayCrossBoundary = true
      }
    }
    if (!pointInClipperPaths(candidates, from) || !pointInClipperPaths(candidates, to)) return false
    if (a.X === b.X && a.Y === b.Y || !mayCrossBoundary) return true
    const clipper = new ClipperLib.Clipper()
    addOpenSubject(clipper, [a, b])
    clipper.AddPaths(candidates, ClipperLib.PolyType.ptClip, true)
    const tree = new ClipperLib.PolyTree()
    clipper.Execute(ClipperLib.ClipType.ctDifference, tree,
      ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftEvenOdd)
    return openPathsFromPolyTree(tree).length === 0
  }
}
