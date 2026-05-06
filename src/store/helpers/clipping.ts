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
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  fromClipperPath,
  normalizeWinding,
  toClipperPath,
} from '../../engine/toolpaths/geometry'
import { getProfileBounds, polygonProfile } from '../../types/project'
import type { Point, Segment, SketchFeature, SketchProfile } from '../../types/project'

export interface KnownCircle {
  center: Point
  radius: number
}

export interface ClipperPolyNode {
  IsHole(): boolean
  Contour(): Array<{ X: number; Y: number }>
  Childs?: () => ClipperPolyNode[]
  m_Childs?: ClipperPolyNode[]
}

export function getClipperChildren(node: ClipperPolyNode): ClipperPolyNode[] {
  return node.Childs ? node.Childs() : (node.m_Childs ?? [])
}

export function flattenFeatureToClipperPath(feature: SketchFeature, scale = DEFAULT_CLIPPER_SCALE) {
  const flattened = flattenProfile(feature.sketch.profile)
  return toClipperPath(normalizeWinding(flattened.points, false), scale)
}

export function executeClipPaths(
  subjectPaths: ReturnType<typeof flattenFeatureToClipperPath>[],
  clipPaths: ReturnType<typeof flattenFeatureToClipperPath>[],
  clipType: number,
) {
  const clipper = new ClipperLib.Clipper()
  if (subjectPaths.length > 0) {
    clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  }
  if (clipPaths.length > 0) {
    clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  }

  const solution = new ClipperLib.Paths()
  clipper.Execute(
    clipType,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution as ReturnType<typeof flattenFeatureToClipperPath>[]
}

export function executeClipTree(
  subjectPaths: ReturnType<typeof flattenFeatureToClipperPath>[],
  clipPaths: ReturnType<typeof flattenFeatureToClipperPath>[],
  clipType: number,
): ClipperPolyNode {
  const clipper = new ClipperLib.Clipper()
  if (subjectPaths.length > 0) {
    clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  }
  if (clipPaths.length > 0) {
    clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  }

  const polyTree = new ClipperLib.PolyTree()
  clipper.Execute(
    clipType,
    polyTree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return polyTree as ClipperPolyNode
}

export function unionClipperPaths(paths: ReturnType<typeof flattenFeatureToClipperPath>[]) {
  if (paths.length === 0) {
    return []
  }
  return executeClipPaths(paths, [], ClipperLib.ClipType.ctUnion)
}

function rangesOverlap(minA: number, maxA: number, minB: number, maxB: number): boolean {
  return maxA >= minB && maxB >= minA
}

export function featuresOverlap(a: SketchFeature, b: SketchFeature): boolean {
  if (!a.sketch.profile.closed || !b.sketch.profile.closed) {
    return false
  }

  const boundsA = getProfileBounds(a.sketch.profile)
  const boundsB = getProfileBounds(b.sketch.profile)
  if (
    !rangesOverlap(boundsA.minX, boundsA.maxX, boundsB.minX, boundsB.maxX)
    || !rangesOverlap(boundsA.minY, boundsA.maxY, boundsB.minY, boundsB.maxY)
  ) {
    return false
  }

  const intersections = executeClipPaths(
    [flattenFeatureToClipperPath(a)],
    [flattenFeatureToClipperPath(b)],
    0,
  )

  return intersections.length > 0
}

export function featuresFormConnectedOverlapGroup(features: SketchFeature[]): boolean {
  if (features.length <= 1) {
    return true
  }

  const visited = new Set<number>([0])
  const stack = [0]

  while (stack.length > 0) {
    const currentIndex = stack.pop()!
    for (let index = 0; index < features.length; index += 1) {
      if (visited.has(index)) {
        continue
      }
      if (featuresOverlap(features[currentIndex], features[index])) {
        visited.add(index)
        stack.push(index)
      }
    }
  }

  return visited.size === features.length
}

export function offsetClipperPaths(paths: ReturnType<typeof flattenFeatureToClipperPath>[], delta: number) {
  if (paths.length === 0) {
    return []
  }
  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta)
  return solution as ReturnType<typeof flattenFeatureToClipperPath>[]
}

export function clipperContourToProfile(
  contour: ReturnType<typeof flattenFeatureToClipperPath>,
  scale = DEFAULT_CLIPPER_SCALE,
  knownCircles: KnownCircle[] = [],
): SketchProfile | null {
  const points = fromClipperPath(contour, scale)
  if (points.length < 3) {
    return null
  }

  const first = points[0]
  const last = points[points.length - 1]
  const vertices = Math.abs(first.x - last.x) <= 1e-9 && Math.abs(first.y - last.y) <= 1e-9
    ? points.slice(0, -1)
    : points
  if (vertices.length < 3) {
    return null
  }

  if (knownCircles.length === 0) {
    return polygonProfile(vertices)
  }

  return reconstructArcsInProfile(vertices, knownCircles)
}

export function collectKnownCircles(features: SketchFeature[]): KnownCircle[] {
  const circles: KnownCircle[] = []
  for (const feature of features) {
    const profile = feature.sketch.profile
    let current = profile.start
    for (const seg of profile.segments) {
      if (seg.type === 'circle' || seg.type === 'arc') {
        const radius = Math.hypot(current.x - seg.center.x, current.y - seg.center.y)
        const isDuplicate = circles.some((c) =>
          Math.abs(c.center.x - seg.center.x) < 1e-6
          && Math.abs(c.center.y - seg.center.y) < 1e-6
          && Math.abs(c.radius - radius) < 1e-6,
        )
        if (!isDuplicate) {
          circles.push({ center: { x: seg.center.x, y: seg.center.y }, radius })
        }
      }
      current = seg.to
    }
  }
  return circles
}

function findMatchingCircle(point: Point, circles: KnownCircle[]): number {
  for (let i = 0; i < circles.length; i++) {
    const c = circles[i]
    const dist = Math.hypot(point.x - c.center.x, point.y - c.center.y)
    const tolerance = Math.max(c.radius * 5e-4, 1e-4)
    if (Math.abs(dist - c.radius) <= tolerance) {
      return i
    }
  }
  return -1
}

function arcIsClockwise(center: Point, from: Point, to: Point): boolean {
  const ax = from.x - center.x
  const ay = from.y - center.y
  const bx = to.x - center.x
  const by = to.y - center.y
  // cross product: positive means CCW (from→to), negative means CW
  return ax * by - ay * bx < 0
}

function reconstructArcsInProfile(vertices: Point[], knownCircles: KnownCircle[]): SketchProfile {
  const n = vertices.length
  const circleIndex = vertices.map((v) => findMatchingCircle(v, knownCircles))

  // Pass 1: emit a segment for every consecutive pair of vertices.
  // Any two adjacent vertices on the same circle become an arc; others become lines.
  const segments: Segment[] = []
  for (let i = 0; i < n; i++) {
    const nextIdx = (i + 1) % n
    const ci = circleIndex[i]
    if (ci >= 0 && ci === circleIndex[nextIdx]) {
      const circle = knownCircles[ci]
      const clockwise = arcIsClockwise(circle.center, vertices[i], vertices[nextIdx])
      segments.push({
        type: 'arc',
        to: vertices[nextIdx],
        center: { x: circle.center.x, y: circle.center.y },
        clockwise,
      })
    } else {
      segments.push({ type: 'line', to: vertices[nextIdx] })
    }
  }

  // Pass 2: merge consecutive arcs that share the same center and direction
  // into a single arc. This collapses the many tiny per-edge arcs into the
  // full arc spans that Clipper fragmented.
  function mergeAdjacentArcs(segs: Segment[], startPoint: Point): { segments: Segment[]; start: Point } {
    if (segs.length === 0) return { segments: segs, start: startPoint }
    const merged: Segment[] = []
    let i = 0
    while (i < segs.length) {
      const seg = segs[i]
      if (seg.type !== 'arc') {
        merged.push(seg)
        i++
        continue
      }
      // Extend forward while the next segment is an arc on the same circle+direction
      let j = i + 1
      while (
        j < segs.length
        && segs[j].type === 'arc'
        && Math.abs((segs[j] as Extract<Segment, { type: 'arc' }>).center.x - seg.center.x) < 1e-6
        && Math.abs((segs[j] as Extract<Segment, { type: 'arc' }>).center.y - seg.center.y) < 1e-6
        && (segs[j] as Extract<Segment, { type: 'arc' }>).clockwise === seg.clockwise
      ) {
        j++
      }
      // Emit one arc from segs[i].start to segs[j-1].to
      merged.push({
        type: 'arc',
        to: segs[j - 1].to,
        center: seg.center,
        clockwise: seg.clockwise,
      })
      i = j
    }
    return { segments: merged, start: startPoint }
  }

  // Handle the wrap-around case: if the first and last segments are arcs on
  // the same circle, Clipper's start point split one arc in two. Rotate the
  // segment list so the split arc becomes contiguous, then merge.
  let workSegments = segments
  let workStart = vertices[0]

  if (
    workSegments.length >= 2
    && workSegments[0].type === 'arc'
    && workSegments[workSegments.length - 1].type === 'arc'
  ) {
    const first = workSegments[0] as Extract<Segment, { type: 'arc' }>
    const last = workSegments[workSegments.length - 1] as Extract<Segment, { type: 'arc' }>
    const sameCircle =
      Math.abs(first.center.x - last.center.x) < 1e-6
      && Math.abs(first.center.y - last.center.y) < 1e-6
      && first.clockwise === last.clockwise
    if (sameCircle) {
      // Find the last non-arc segment before the trailing arc run to use as new start
      let splitPoint = workSegments.length - 1
      while (
        splitPoint > 0
        && workSegments[splitPoint - 1].type === 'arc'
        && Math.abs((workSegments[splitPoint - 1] as Extract<Segment, { type: 'arc' }>).center.x - last.center.x) < 1e-6
        && Math.abs((workSegments[splitPoint - 1] as Extract<Segment, { type: 'arc' }>).center.y - last.center.y) < 1e-6
        && (workSegments[splitPoint - 1] as Extract<Segment, { type: 'arc' }>).clockwise === last.clockwise
      ) {
        splitPoint--
      }
      // Rotate: trailing arc run moves to front
      const newStart = splitPoint === 0 ? workStart : workSegments[splitPoint - 1].to
      workSegments = [...workSegments.slice(splitPoint), ...workSegments.slice(0, splitPoint)]
      workStart = newStart
    }
  }

  const result = mergeAdjacentArcs(workSegments, workStart)
  return {
    start: result.start,
    segments: result.segments,
    closed: true,
  }
}
