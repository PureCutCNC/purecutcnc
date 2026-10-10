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
 * The order one plasma operation cuts its contours in (issue #958).
 *
 * A plasma cut frees what it encloses. Once an outline is cut the part is
 * loose: it can tip or drop into the table, and nothing inside it can be cut
 * in place any more. So the order is not a matter of travel time first:
 *
 * 1. **Inside before outside.** Everything a contour encloses is cut before
 *    that contour: a part's holes before its outline, and a part sitting in
 *    another part's hole before that hole.
 * 2. **Part by part.** A top-level contour with everything inside it is one
 *    part, and it is finished before the next one starts. That keeps a part's
 *    holes and its outline close together in time, so the sheet has little
 *    chance to move with the heat between them.
 * 3. **Nearest next**, among the contours rules 1 and 2 leave to choose from.
 *    The first cut is the one nearest the machine origin, where the torch
 *    starts.
 * 4. **Prefer a travel that does not pass over a piece already cut loose.** A
 *    freed piece can tip up into the path of a rapid. Best effort: when every
 *    choice passes over one, the nearest is taken.
 *
 * This module only decides a sequence. It never looks at, or changes, how a
 * contour is cut: kerf side, direction, start point and leads are settled
 * per contour before it is called.
 *
 * Pure: points in, indices out. No project, no i18n, no warnings.
 */

import type { Point } from '../../types/project'
import { DEFAULT_CLIPPER_SCALE } from './geometry'
import { insideContour, pointDistance, segmentsIntersect } from './plasmaGeometry'

/** One contour the operation cuts, as far as ordering needs to know it. */
export interface PlasmaOrderContour {
  /** The drawn contour, not the kerf-offset path: containment is a fact about the drawing. */
  ring: Point[]
  /** Where the torch pierces to start this cut. */
  pierce: Point
  /** Where the torch is when this cut ends, before it lifts. */
  end: Point
}

/** Work counters, so a test can assert the cost of a large nest without timing it. */
export interface PlasmaOrderStats {
  /** Full ring-in-ring tests that survived the area and bounding-box prefilters. */
  containmentTests: number
}

interface Box { minX: number; minY: number; maxX: number; maxY: number }

function boxOf(points: Point[]): Box {
  const box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }
  for (const point of points) {
    if (point.x < box.minX) box.minX = point.x
    if (point.x > box.maxX) box.maxX = point.x
    if (point.y < box.minY) box.minY = point.y
    if (point.y > box.maxY) box.maxY = point.y
  }
  return box
}

const boxWithin = (inner: Box, outer: Box): boolean =>
  inner.minX >= outer.minX && inner.maxX <= outer.maxX && inner.minY >= outer.minY && inner.maxY <= outer.maxY

const boxesOverlap = (a: Box, b: Box): boolean =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY

function ringArea(ring: Point[]): number {
  let sum = 0
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    sum += a.x * b.y - b.x * a.y
  }
  return Math.abs(sum) / 2
}

/** A is inside B when every point of A is. Same test the generator uses for a hole in its part. */
export function ringInsideRing(inner: Point[], outer: Point[]): boolean {
  return inner.length > 0 && inner.every((point) => insideContour(point, outer))
}

/**
 * The containment tree: for each contour, the index of the smallest contour
 * that encloses it, or -1 for a top-level one.
 *
 * A container is strictly larger than what it holds, which is what makes the
 * result a tree whatever the input: two identical contours cannot each be the
 * other's parent. Candidates are tried smallest first, so the first one that
 * encloses a contour is its immediate parent and the search stops there. With
 * the bounding-box test in front, a nest of separate parts costs about one
 * ring test per contour rather than one per pair.
 */
export function plasmaContainmentParents(rings: Point[][], stats?: PlasmaOrderStats): number[] {
  const boxes = rings.map(boxOf)
  const areas = rings.map(ringArea)
  const bySize = rings.map((_, index) => index).sort((a, b) => areas[a] - areas[b] || a - b)
  return rings.map((ring, index) => {
    for (const candidate of bySize) {
      if (areas[candidate] <= areas[index] || !boxWithin(boxes[index], boxes[candidate])) continue
      if (stats) stats.containmentTests += 1
      if (ringInsideRing(ring, rings[candidate])) return candidate
    }
    return -1
  })
}

/**
 * Distances are compared on the geometry's own grid. Pierce points come out of
 * Clipper, which rounds to this grid, so two parts placed symmetrically about
 * the torch differ by rounding noise; without this the noise, not the
 * selection order, would break the tie.
 */
const distanceKey = (a: Point, b: Point): number => Math.round(pointDistance(a, b) * DEFAULT_CLIPPER_SCALE)

/**
 * The order to cut `contours` in, as indices into it.
 *
 * `contours` is in selection order, and that order breaks every tie.
 * `origin` is where the torch starts: the machine origin, in the same
 * coordinates as the contours.
 */
export function orderPlasmaCuts(contours: PlasmaOrderContour[], origin: Point, stats?: PlasmaOrderStats): number[] {
  const rings = contours.map((contour) => contour.ring)
  const boxes = rings.map(boxOf)
  const parents = plasmaContainmentParents(rings, stats)
  const children: number[][] = contours.map(() => [])
  const roots: number[] = []
  // Ascending index, so children and roots stay in selection order.
  parents.forEach((parent, index) => { (parent === -1 ? roots : children[parent]).push(index) })

  // The contours of a subtree that can be cut straight away: the ones with
  // nothing inside them. A subtree is as near as the nearest of these, because
  // that is where the torch would actually pierce first, not at the outline.
  const leavesBelow: number[][] = contours.map(() => [])
  const collectLeaves = (node: number): number[] => {
    leavesBelow[node] = children[node].length === 0 ? [node] : children[node].flatMap(collectLeaves)
    return leavesBelow[node]
  }
  roots.forEach(collectLeaves)

  const order: number[] = []
  let position = origin

  // Would a straight rapid pass over a piece that is already cut loose? The
  // piece the torch is leaving does not count: it just finished cutting it,
  // and every way out crosses that contour.
  const crossesLoosePiece = (from: Point, to: Point): boolean => {
    const travel = boxOf([from, to])
    return order.some((cut) => {
      if (!boxesOverlap(travel, boxes[cut])) return false
      const ring = rings[cut]
      if (insideContour(from, ring)) return false
      return ring.some((a, i) => segmentsIntersect(from, to, a, ring[(i + 1) % ring.length]))
    })
  }

  // Which of these sibling subtrees to enter next, and by which first pierce.
  const pick = (candidates: number[]): number => {
    const ranked = candidates.map((node) => {
      let entry = -1, key = Infinity
      for (const leaf of leavesBelow[node]) {
        const leafKey = distanceKey(position, contours[leaf].pierce)
        if (leafKey < key || (leafKey === key && leaf < entry)) { entry = leaf; key = leafKey }
      }
      return { node, entry, key }
    }).sort((a, b) => a.key - b.key || a.entry - b.entry)
    const clear = ranked.find((candidate) => !crossesLoosePiece(position, contours[candidate.entry].pierce))
    return (clear ?? ranked[0]).node
  }

  // Children first, and one sibling subtree finished before the next begins:
  // at the top level that is "part by part", and it holds the same way for a
  // part nested in another part's hole.
  const cutGroup = (siblings: number[]): void => {
    const remaining = [...siblings]
    while (remaining.length > 0) {
      const next = pick(remaining)
      remaining.splice(remaining.indexOf(next), 1)
      cutGroup(children[next])
      order.push(next)
      position = contours[next].end
    }
  }
  cutGroup(roots)
  return order
}

/**
 * Which of `outlines` enclose at least one of `laterRings`, as indices.
 *
 * For the one mistake ordering inside an operation cannot fix: an outline
 * cut by this operation while something inside it is left to a later one.
 */
export function outlinesEnclosingLaterCuts(outlines: Point[][], laterRings: Point[][]): number[] {
  if (laterRings.length === 0) return []
  const laterBoxes = laterRings.map(boxOf)
  const laterAreas = laterRings.map(ringArea)
  const enclosing: number[] = []
  outlines.forEach((outline, index) => {
    const box = boxOf(outline), area = ringArea(outline)
    // Strictly larger, as in the tree: a contour does not enclose its own twin.
    if (laterRings.some((ring, later) => laterAreas[later] < area && boxWithin(laterBoxes[later], box) && ringInsideRing(ring, outline))) enclosing.push(index)
  })
  return enclosing
}
