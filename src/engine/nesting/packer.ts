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
//
// A part's holes (#859) are shrunk by the caller's `shrinkHoles`. A placed
// part's no-fit polygon then loses the inner-fit region of each of its shrunk
// holes: the translations that put the moving part's grown footprint inside
// one. Only the placed part's holes are used — under largest-first order a
// part never fits inside the hole of a part placed after it.

import ClipperLib from 'clipper-lib'
import type { ClipperPath } from '../toolpaths/types'
import {
  NEST_SCALE,
  differencePaths,
  frameAround,
  growPaths,
  noFitPolygon,
  outerContours,
  pathsBox,
  rectPath,
  regionComponents,
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
  holes: Hole[]
  /** Raw footprint area in project units², for the unplaced score. */
  area: number
}

/** One connected piece of a part's shrunk holes, with the frame around it. */
interface Hole {
  box: IntBox
  /** Convex pieces of the hole's bounding rectangle outside it, islands included. */
  framePieces: ClipperPath[]
}

interface Oriented {
  key: string
  part: NestPart
  rotation: number
  rawPieces: ClipperPath[]
  grownPieces: ClipperPath[]
  rawBox: IntBox
  grownBox: IntBox
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

/**
 * A packer for one request whose part shapes and no-fit polygons outlive a
 * single layout, so an improvement search can place the same copies in many
 * orders and pay for each Minkowski sum once (#862).
 */
export interface Nester {
  /** Every copy's part id in the caller's order: all copies of the first part, then the next. */
  initialSequence: string[]
  /**
   * Places one copy per entry, in order. `sequence` must hold each part id as
   * many times as its quantity. Once a copy finds no place, the later copies of
   * the same part — identical shapes facing a region that only grows — are
   * reported unplaced without being tried.
   */
  place(sequence: string[]): NestResult
}

export function nest(request: NestRequest): NestResult {
  const nester = createNester(request)
  return nester.place(nester.initialSequence)
}

export function createNester(request: NestRequest): Nester {
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

  const partsById = new Map(request.parts.map((part) => [part.id, part]))
  const shapes = new Map<string, PartShape>()
  const orientedCache = new Map<string, Oriented>()
  const orientationsCache = new Map<string, Oriented[]>()
  const nfpCache = new Map<string, ClipperPath[]>()
  /** Obstacles and the sheet edge per orientation — the same for every layout. */
  const fixedForbidden = new Map<string, ClipperPath[]>()

  const shapeOf = (part: NestPart): PartShape => {
    let shape = shapes.get(part.id)
    if (!shape) {
      const raw = outerContours(part.footprint.map(ringToPath))
      const grown = outerContours(request.expandFootprint(part.footprint, request.minimumGap).map(ringToPath))
      if (raw.length === 0 || grown.length === 0) {
        throw new Error(`nest: part "${part.id}" has an empty footprint`)
      }
      const holes = part.holes && part.holes.length > 0
        ? regionComponents(request.shrinkHoles!(part.holes, request.minimumGap).map(ringToPath)).map((piece) => {
          const box = pathsBox([piece[0]])
          return { box, framePieces: frameAround(box, piece).flatMap(convexPieces) }
        })
        : []
      const area = raw.reduce((sum, path) => sum + Math.abs(ClipperLib.Clipper.Area(path)), 0) / NEST_SCALE ** 2
      shape = { raw, grown, holes, area }
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
      const grown = rotatePaths(shape.grown, rotation)
      entry = {
        key,
        part,
        rotation,
        rawPieces: raw.flatMap(convexPieces),
        grownPieces: grown.flatMap(convexPieces),
        rawBox: pathsBox(raw),
        grownBox: pathsBox(grown),
      }
      orientedCache.set(key, entry)
    }
    return entry
  }

  const orientationsOf = (part: NestPart): Oriented[] => {
    let list = orientationsCache.get(part.id)
    if (!list) {
      const rotations: number[] = []
      for (const rotation of part.rotations) {
        const normalized = normalizeRotation(rotation)
        if (!rotations.some((existing) => Math.abs(existing - normalized) < 1e-9)) rotations.push(normalized)
      }
      list = rotations.map((rotation) => orientedOf(part, rotation))
      orientationsCache.set(part.id, list)
    }
    return list
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
        const turned = orientedOf(moving.part, relative)
        base = noFitPolygon(orientedOf(fixed.part, 0).grownPieces, turned.grownPieces)
        const fits = shapeOf(fixed.part).holes.flatMap((hole) => holeFit(hole, turned))
        if (fits.length > 0) base = differencePaths(base, fits)
        nfpCache.set(baseKey, base)
      }
      nfp = growPaths(rotatePaths(base, fixed.rotation), SAFETY_UNITS)
      nfpCache.set(key, nfp)
    }
    return nfp
  }

  const fixedForbiddenFor = (moving: Oriented): ClipperPath[] => {
    let paths = fixedForbidden.get(moving.key)
    if (!paths) {
      const base = [
        ...noFitPolygon(obstaclePieces, moving.grownPieces),
        // Unfilled, as for holes: around a round sheet these no-fit polygons
        // close into a ring whose inside is where the part fits.
        ...noFitPolygon(outsideSheetPieces, moving.rawPieces, false),
      ]
      paths = unionPaths(growPaths(base, SAFETY_UNITS))
      fixedForbidden.set(moving.key, paths)
    }
    return paths
  }

  const initialSequence = request.orderParts(request.parts)
    .flatMap((part) => Array.from({ length: Math.max(0, part.quantity) }, () => part.id))

  function place(sequence: string[]): NestResult {
    validateSequence(request.parts, sequence)
    const forbidden = new Map<string, ForbiddenRegion>()
    const placed: Placed[] = []
    const placements: NestPlacement[] = []
    const unplaced: NestUnplaced[] = []
    const copies = new Map<string, number>()
    let unplacedArea = 0
    let placedBox: IntBox | null = null

    const forbiddenFor = (moving: Oriented): ClipperPath[] => {
      let region = forbidden.get(moving.key)
      if (!region) {
        region = { paths: fixedForbiddenFor(moving), placedCount: 0 }
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

    for (const partId of sequence) {
      const part = partsById.get(partId)!
      const failed = unplaced.find((entry) => entry.partId === partId)
      if (failed) {
        failed.count += 1
        unplacedArea += shapeOf(part).area
        continue
      }
      let best: { oriented: Oriented; dx: number; dy: number; score: number[] } | null = null
      for (const oriented of orientationsOf(part)) {
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
        unplaced.push({ partId, count: 1 })
        unplacedArea += shapeOf(part).area
        continue
      }
      const copyIndex = copies.get(partId) ?? 0
      copies.set(partId, copyIndex + 1)
      placed.push({ oriented: best.oriented, dx: best.dx, dy: best.dy })
      placedBox = mergeBox(placedBox, shiftBox(best.oriented.rawBox, best.dx, best.dy))
      placements.push({
        partId,
        copyIndex,
        rotation: best.oriented.rotation,
        translation: { x: best.dx / NEST_SCALE, y: best.dy / NEST_SCALE },
      })
    }

    const usedArea = placedBox
      ? ((placedBox.maxX - placedBox.minX) / NEST_SCALE) * ((placedBox.maxY - placedBox.minY) / NEST_SCALE)
      : 0
    return { placements, unplaced, unplacedArea, usedArea }
  }

  return { initialSequence, place }
}

function validateSequence(parts: NestPart[], sequence: string[]): void {
  const remaining = new Map(parts.map((part) => [part.id, Math.max(0, part.quantity)]))
  for (const partId of sequence) {
    const left = remaining.get(partId)
    if (left === undefined) throw new Error(`nest: sequence names unknown part "${partId}"`)
    if (left === 0) throw new Error(`nest: sequence holds more copies of "${partId}" than its quantity`)
    remaining.set(partId, left - 1)
  }
  for (const [partId, left] of remaining) {
    if (left > 0) throw new Error(`nest: sequence is missing ${left} copies of "${partId}"`)
  }
}

/**
 * Translations that put `moving`'s grown footprint inside one shrunk hole: the
 * hole's bounding rectangle, as an inner-fit range, minus the no-fit polygon of
 * the frame around the hole (islands included) — the sheet's construction. A
 * hole whose box cannot hold the part costs no Minkowski sum.
 */
function holeFit(hole: Hole, moving: Oriented): ClipperPath[] {
  const { box } = hole
  const xRange = innerFitRange(box.minX, box.maxX, moving.grownBox.minX, moving.grownBox.maxX)
  const yRange = innerFitRange(box.minY, box.maxY, moving.grownBox.minY, moving.grownBox.maxY)
  // An exact fit has no area to subtract, so it is not worth a sum.
  if (!xRange || !yRange || xRange.hi - xRange.lo < 2 || yRange.hi - yRange.lo < 2) return []
  const fit = rectPath({ minX: xRange.lo, maxX: xRange.hi, minY: yRange.lo, maxY: yRange.hi })
  // Unfilled: the free positions are exactly the holes this polygon encloses.
  return differencePaths([fit], noFitPolygon(hole.framePieces, moving.grownPieces, false))
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
    if (part.holes && part.holes.length > 0 && !request.shrinkHoles) {
      throw new Error(`nest: part "${part.id}" has holes but the request has no shrinkHoles`)
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
