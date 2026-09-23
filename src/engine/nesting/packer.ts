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

// Bottom-left-fill placement over no-fit polygons (issue #844, step 1 of #741).
//
// For each copy, in the caller's part order, every allowed rotation is tried:
// the feasible translations are the inner-fit rectangle of the sheet minus the
// no-fit polygons of everything already on it, and the chosen translation is
// the feasible-region vertex that keeps the placed set's bounding box smallest.
//
// Two shape families are kept per (part, rotation):
//  - `raw`, the footprint itself, tested against the sheet — the sheet is its
//    bounding rectangle (an exact inner-fit region) plus the pieces of
//    "rectangle minus sheet", which are treated as ordinary obstacles;
//  - `grown`, the caller's `expandFootprint` result, tested against other
//    grown parts and grown obstacles, so touching grown shapes are exactly the
//    caller's gap apart.

import type { ClipperPath } from '../toolpaths/types'
import {
  NEST_SCALE,
  differencePaths,
  growPaths,
  noFitPolygon,
  outerContours,
  pathsBox,
  rectPath,
  ringToPath,
  rotatePaths,
  translatePaths,
  unionPaths,
  type IntBox,
} from './clipperOps'
import { convexPieces } from './convex'
import type { NestGravity, NestPart, NestPlacement, NestRequest, NestResult, NestUnplaced } from './types'

/**
 * Every forbidden region is grown by this many integer units before feasible
 * positions are taken from it, so integer rounding of a touching position can
 * never turn into an overlap. 2 units = 0.2 µm at the default scale.
 */
const SAFETY_UNITS = 2

/** A part's footprint at rotation 0, as given and as grown by the caller. */
interface PartShape {
  raw: ClipperPath[]
  grown: ClipperPath[]
}

interface Oriented {
  key: string
  part: NestPart
  rotation: number
  rawPieces: ClipperPath[]
  grownPieces: ClipperPath[]
  rawBox: IntBox
}

interface Placed {
  oriented: Oriented
  dx: number
  dy: number
}

interface ForbiddenRegion {
  paths: ClipperPath[]
  /** How many entries of the placed list are already folded into `paths`. */
  placedCount: number
}

interface Range {
  lo: number
  hi: number
}

export function nest(request: NestRequest): NestResult {
  validateRequest(request)
  const gravity = request.gravity ?? { x: 1, y: 1 }

  const sheetPath = ringToPath(request.sheet)
  const sheetBox = pathsBox([sheetPath])
  const outsideSheet = differencePaths([rectPath(sheetBox)], [sheetPath])
  const outsideSheetPieces = outsideSheet.flatMap(convexPieces)
  const obstaclePieces = request.obstacles.length > 0
    ? outerContours(request.expandFootprint(request.obstacles, request.minimumGap).map(ringToPath))
      .flatMap(convexPieces)
    : []

  const shapes = new Map<string, PartShape>()
  const orientedCache = new Map<string, Oriented>()

  const nfpCache = new Map<string, ClipperPath[]>()
  const forbidden = new Map<string, ForbiddenRegion>()
  const placed: Placed[] = []
  const placements: NestPlacement[] = []
  const unplaced: NestUnplaced[] = []
  let placedBox: IntBox | null = null

  const shapeOf = (part: NestPart): PartShape => {
    let shape = shapes.get(part.id)
    if (!shape) {
      const raw = outerContours(part.footprint.map(ringToPath))
      const grown = outerContours(request.expandFootprint(part.footprint, request.minimumGap).map(ringToPath))
      if (raw.length === 0 || grown.length === 0) {
        throw new Error(`nest: part "${part.id}" has an empty footprint`)
      }
      shape = { raw, grown }
      shapes.set(part.id, shape)
    }
    return shape
  }

  // Grown shapes are rotated rather than re-grown, which assumes the caller's
  // expansion commutes with rotation — true of any offset.
  const orientedOf = (part: NestPart, rotation: number): Oriented => {
    const key = `${part.id}@${rotation}`
    let entry = orientedCache.get(key)
    if (!entry) {
      const shape = shapeOf(part)
      const raw = rotatePaths(shape.raw, rotation)
      entry = {
        key,
        part,
        rotation,
        rawPieces: raw.flatMap(convexPieces),
        grownPieces: rotatePaths(shape.grown, rotation).flatMap(convexPieces),
        rawBox: pathsBox(raw),
      }
      orientedCache.set(key, entry)
    }
    return entry
  }

  // NFP(R1·A, R2·B) = R1·NFP(A, R(r2 − r1)·B): only the relative turn needs a
  // Minkowski sum, so four quarter turns cost four sums per part pair, not 16.
  const pairNfp = (fixed: Oriented, moving: Oriented): ClipperPath[] => {
    const key = `${fixed.key}|${moving.key}`
    let nfp = nfpCache.get(key)
    if (!nfp) {
      const relative = normalizeRotation(moving.rotation - fixed.rotation)
      const baseKey = `${fixed.part.id}@0|${moving.part.id}@${relative}`
      let base = nfpCache.get(baseKey)
      if (!base) {
        base = noFitPolygon(orientedOf(fixed.part, 0).grownPieces, orientedOf(moving.part, relative).grownPieces)
        nfpCache.set(baseKey, base)
      }
      nfp = growPaths(rotatePaths(base, fixed.rotation), SAFETY_UNITS)
      nfpCache.set(key, nfp)
    }
    return nfp
  }

  const forbiddenFor = (moving: Oriented): ClipperPath[] => {
    let region = forbidden.get(moving.key)
    if (!region) {
      const base = [
        ...noFitPolygon(obstaclePieces, moving.grownPieces),
        ...noFitPolygon(outsideSheetPieces, moving.rawPieces),
      ]
      region = { paths: unionPaths(growPaths(base, SAFETY_UNITS)), placedCount: 0 }
      forbidden.set(moving.key, region)
    }
    if (region.placedCount < placed.length) {
      const added = placed
        .slice(region.placedCount)
        .flatMap((entry) => translatePaths(pairNfp(entry.oriented, moving), entry.dx, entry.dy))
      region.paths = unionPaths([...region.paths, ...added])
      region.placedCount = placed.length
    }
    return region.paths
  }

  for (const part of request.orderParts(request.parts)) {
    if (part.quantity <= 0) continue
    const orientations = orient(part)
    for (let copyIndex = 0; copyIndex < part.quantity; copyIndex += 1) {
      let best: { oriented: Oriented; dx: number; dy: number; score: number[] } | null = null
      for (const oriented of orientations) {
        const xRange = innerFitRange(sheetBox.minX, sheetBox.maxX, oriented.rawBox.minX, oriented.rawBox.maxX)
        const yRange = innerFitRange(sheetBox.minY, sheetBox.maxY, oriented.rawBox.minY, oriented.rawBox.maxY)
        if (!xRange || !yRange) continue
        // A zero-width inner-fit range has no area for Clipper to subtract
        // from, so it is widened by one unit and candidates are clamped back.
        const fit = rectPath({
          minX: xRange.lo - (xRange.hi - xRange.lo < 2 ? 1 : 0),
          maxX: xRange.hi + (xRange.hi - xRange.lo < 2 ? 1 : 0),
          minY: yRange.lo - (yRange.hi - yRange.lo < 2 ? 1 : 0),
          maxY: yRange.hi + (yRange.hi - yRange.lo < 2 ? 1 : 0),
        })
        const feasible = differencePaths([fit], forbiddenFor(oriented))
        for (const path of feasible) {
          for (const vertex of path) {
            const dx = clamp(vertex.X, xRange)
            const dy = clamp(vertex.Y, yRange)
            const score = placementScore(placedBox, oriented.rawBox, dx, dy, gravity)
            if (!best || compareScores(score, best.score) < 0) best = { oriented, dx, dy, score }
          }
        }
      }

      if (!best) {
        unplaced.push({ partId: part.id, count: part.quantity - copyIndex })
        break
      }
      placed.push({ oriented: best.oriented, dx: best.dx, dy: best.dy })
      placedBox = mergeBox(placedBox, shiftBox(best.oriented.rawBox, best.dx, best.dy))
      placements.push({
        partId: part.id,
        copyIndex,
        rotation: best.oriented.rotation,
        translation: { x: best.dx / NEST_SCALE, y: best.dy / NEST_SCALE },
      })
    }
  }

  return { placements, unplaced }

  function orient(part: NestPart): Oriented[] {
    const rotations: number[] = []
    for (const rotation of part.rotations) {
      const normalized = normalizeRotation(rotation)
      if (!rotations.some((existing) => Math.abs(existing - normalized) < 1e-9)) rotations.push(normalized)
    }
    return rotations.map((rotation) => orientedOf(part, rotation))
  }
}

function normalizeRotation(degrees: number): number {
  return ((degrees % 360) + 360) % 360
}

function validateRequest(request: NestRequest): void {
  if (!Number.isFinite(request.minimumGap) || request.minimumGap < 0) {
    throw new Error(`nest: minimumGap must be a finite non-negative number, got ${request.minimumGap}`)
  }
  if (request.sheet.length < 3) throw new Error('nest: the sheet needs at least three points')
  const ids = new Set<string>()
  for (const part of request.parts) {
    if (ids.has(part.id)) throw new Error(`nest: duplicate part id "${part.id}"`)
    ids.add(part.id)
    if (!Number.isInteger(part.quantity) || part.quantity < 0) {
      throw new Error(`nest: part "${part.id}" quantity must be a non-negative integer`)
    }
    if (part.quantity > 0 && part.rotations.length === 0) {
      throw new Error(`nest: part "${part.id}" allows no rotation`)
    }
    if (part.rotations.some((rotation) => !Number.isFinite(rotation))) {
      throw new Error(`nest: part "${part.id}" has a non-finite rotation`)
    }
  }
}

/**
 * Translations along one axis that keep a footprint spanning [partMin, partMax]
 * inside [sheetMin, sheetMax]. A footprint wider than the sheet by less than a
 * unit is treated as an exact fit rather than rejected over rounding.
 */
function innerFitRange(sheetMin: number, sheetMax: number, partMin: number, partMax: number): Range | null {
  const lo = sheetMin - partMin
  const hi = sheetMax - partMax
  if (hi >= lo) return { lo, hi }
  if (lo - hi <= 1) return { lo: hi, hi }
  return null
}

function clamp(value: number, range: Range): number {
  return Math.min(range.hi, Math.max(range.lo, value))
}

function shiftBox(box: IntBox, dx: number, dy: number): IntBox {
  return { minX: box.minX + dx, minY: box.minY + dy, maxX: box.maxX + dx, maxY: box.maxY + dy }
}

function mergeBox(a: IntBox | null, b: IntBox): IntBox {
  if (!a) return b
  return {
    minX: Math.min(a.minX, b.minX),
    minY: Math.min(a.minY, b.minY),
    maxX: Math.max(a.maxX, b.maxX),
    maxY: Math.max(a.maxY, b.maxY),
  }
}

/**
 * Smallest bounding box of the placed set first, then the part's edge nearest
 * the gravity corner in Y, then in X — deterministic, and comparable across
 * rotations because it scores the placed box, not the raw translation.
 */
function placementScore(
  placedBox: IntBox | null,
  rawBox: IntBox,
  dx: number,
  dy: number,
  gravity: NestGravity,
): number[] {
  const part = shiftBox(rawBox, dx, dy)
  const box = mergeBox(placedBox, part)
  return [
    (box.maxX - box.minX) * (box.maxY - box.minY),
    gravity.y > 0 ? part.minY : -part.maxY,
    gravity.x > 0 ? part.minX : -part.maxX,
  ]
}

function compareScores(a: number[], b: number[]): number {
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  return 0
}
