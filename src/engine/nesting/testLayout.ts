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

// Layout checks shared by the nesting engine tests. Every guarantee is measured
// on the placed geometry itself — distances between the transformed material
// (footprint minus holes), not inferred from the translations reported.

import ClipperLib from 'clipper-lib'
import type { Point } from '../../types/project'
import { NEST_SCALE, pathToRing, ringToPath, rotateRing } from './clipperOps'
import type { NestPart, NestRequest, NestResult, NestRing } from './types'

export function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

export const GAP_TOLERANCE = 1e-6

export function rect(x: number, y: number, w: number, h: number): NestRing {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
}

/** The footprint minus its holes, clockwise rings being holes (non-zero rule). */
function materialRings(part: NestPart): NestRing[] {
  if (!part.holes?.length) return part.footprint
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(part.footprint.map(ringToPath), ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths(part.holes.map(ringToPath), ClipperLib.PolyType.ptClip, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctDifference,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution.map(pathToRing)
}

function placedRings(req: NestRequest, result: NestResult): { key: string; rings: NestRing[] }[] {
  return result.placements.map((placement) => {
    const part = req.parts.find((candidate) => candidate.id === placement.partId)
    if (!part) throw new Error(`unknown part ${placement.partId}`)
    const rings = materialRings(part).map((ring) => rotateRing(ring, placement.rotation).map((p) => ({
      x: p.x + placement.translation.x,
      y: p.y + placement.translation.y,
    })))
    return { key: `${placement.partId}#${placement.copyIndex}`, rings }
  })
}

function overlapArea(a: NestRing[], b: NestRing[]): number {
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(a.map(ringToPath), ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths(b.map(ringToPath), ClipperLib.PolyType.ptClip, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctIntersection,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution.reduce((sum, path) => sum + Math.abs(ClipperLib.Clipper.Area(path)), 0) / NEST_SCALE ** 2
}

/** Area of `inner` lying outside `outer`. */
function outsideArea(inner: NestRing[], outer: NestRing): number {
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(inner.map(ringToPath), ClipperLib.PolyType.ptSubject, true)
  clipper.AddPaths([ringToPath(outer)], ClipperLib.PolyType.ptClip, true)
  const solution = new ClipperLib.Paths()
  clipper.Execute(
    ClipperLib.ClipType.ctDifference,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution.reduce((sum, path) => sum + Math.abs(ClipperLib.Clipper.Area(path)), 0) / NEST_SCALE ** 2
}

function pointSegmentDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

/** Closest approach between two non-overlapping ring sets. */
function ringDistance(a: NestRing[], b: NestRing[]): number {
  if (overlapArea(a, b) > 0) return 0
  let best = Infinity
  const scan = (from: NestRing[], to: NestRing[]) => {
    for (const ring of from) {
      for (const point of ring) {
        for (const target of to) {
          for (let i = 0; i < target.length; i += 1) {
            best = Math.min(best, pointSegmentDistance(point, target[i], target[(i + 1) % target.length]))
          }
        }
      }
    }
  }
  scan(a, b)
  scan(b, a)
  return best
}

export function assertValidLayout(req: NestRequest, result: NestResult, label: string): number {
  const placed = placedRings(req, result)
  let closest = Infinity
  for (const entry of placed) {
    const outside = outsideArea(entry.rings, req.sheet)
    assert(outside < 1e-6, `${label}: ${entry.key} lies ${outside} mm² outside the sheet`)
    for (const obstacle of req.obstacles) {
      const distance = ringDistance(entry.rings, [obstacle])
      assert(distance >= req.minimumGap - GAP_TOLERANCE, `${label}: ${entry.key} is ${distance} from an obstacle`)
    }
  }
  for (let i = 0; i < placed.length; i += 1) {
    for (let j = i + 1; j < placed.length; j += 1) {
      const distance = ringDistance(placed[i].rings, placed[j].rings)
      closest = Math.min(closest, distance)
      assert(
        distance >= req.minimumGap - GAP_TOLERANCE,
        `${label}: ${placed[i].key} and ${placed[j].key} are ${distance} apart, need ${req.minimumGap}`,
      )
    }
  }
  return closest
}
