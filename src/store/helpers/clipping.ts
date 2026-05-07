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
import { bezierPoint, getProfileBounds, polygonProfile } from '../../types/project'
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

export function largestConnectedOverlapGroup(features: SketchFeature[]): SketchFeature[] {
  if (features.length <= 1) {
    return features
  }

  let bestGroup: number[] = []
  const assigned = new Set<number>()

  for (let start = 0; start < features.length; start += 1) {
    if (assigned.has(start)) {
      continue
    }
    const visited = new Set<number>([start])
    const stack = [start]

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

    for (const index of visited) {
      assigned.add(index)
    }
    if (visited.size > bestGroup.length) {
      bestGroup = [...visited]
    }
  }

  return bestGroup.map((index) => features[index])
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

// ── Segment-preserving boolean reconstruction ─────────────────────────────────
// Instead of reconstructing curves from a flattened polygon, this approach
// maps Clipper output vertices back to their original segments and preserves
// them exactly. Only intersection points become line segments.

const FLATTEN_CURVE_SAMPLES = 24
const FLATTEN_ARC_STEP = Math.PI / 36

export interface SegmentAnnotation {
  featureIdx: number
  segIdx: number
  sampleIdx: number
  totalSamples: number
}

function annKey(X: number, Y: number): string {
  return `${X},${Y}`
}

function getSegmentSampleCount(seg: Segment, segStart: Point): number {
  if (seg.type === 'line') return 1
  if (seg.type === 'bezier') return FLATTEN_CURVE_SAMPLES
  if (seg.type === 'circle') return 64
  const startAngle = Math.atan2(segStart.y - seg.center.y, segStart.x - seg.center.x)
  const endAngle = Math.atan2(seg.to.y - seg.center.y, seg.to.x - seg.center.x)
  let sweep = endAngle - startAngle
  if (seg.clockwise && sweep > 0) sweep -= Math.PI * 2
  else if (!seg.clockwise && sweep < 0) sweep += Math.PI * 2
  return Math.max(8, Math.ceil(Math.abs(sweep) / FLATTEN_ARC_STEP))
}

export function buildSegmentAnnotations(
  features: SketchFeature[],
  scale: number = DEFAULT_CLIPPER_SCALE,
): Map<string, SegmentAnnotation> {
  const map = new Map<string, SegmentAnnotation>()

  for (let fi = 0; fi < features.length; fi++) {
    const profile = features[fi].sketch.profile
    let current = profile.start

    for (let si = 0; si < profile.segments.length; si++) {
      const seg = profile.segments[si]
      const totalSamples = getSegmentSampleCount(seg, current)

      if (seg.type === 'line') {
        const k = annKey(Math.round(seg.to.x * scale), Math.round(seg.to.y * scale))
        if (!map.has(k)) map.set(k, { featureIdx: fi, segIdx: si, sampleIdx: 1, totalSamples: 1 })
        current = seg.to
      } else if (seg.type === 'bezier') {
        for (let s = 1; s <= FLATTEN_CURVE_SAMPLES; s++) {
          const pt = bezierPoint(current, seg.control1, seg.control2, seg.to, s / FLATTEN_CURVE_SAMPLES)
          const k = annKey(Math.round(pt.x * scale), Math.round(pt.y * scale))
          if (!map.has(k)) map.set(k, { featureIdx: fi, segIdx: si, sampleIdx: s, totalSamples: FLATTEN_CURVE_SAMPLES })
        }
        current = seg.to
      } else if (seg.type === 'arc') {
        const startAngle = Math.atan2(current.y - seg.center.y, current.x - seg.center.x)
        const endAngle = Math.atan2(seg.to.y - seg.center.y, seg.to.x - seg.center.x)
        const radius = Math.hypot(current.x - seg.center.x, current.y - seg.center.y)
        let sweep = endAngle - startAngle
        if (seg.clockwise && sweep > 0) sweep -= Math.PI * 2
        else if (!seg.clockwise && sweep < 0) sweep += Math.PI * 2
        for (let s = 1; s <= totalSamples; s++) {
          const angle = startAngle + (sweep * s) / totalSamples
          const pt = { x: seg.center.x + Math.cos(angle) * radius, y: seg.center.y + Math.sin(angle) * radius }
          const k = annKey(Math.round(pt.x * scale), Math.round(pt.y * scale))
          if (!map.has(k)) map.set(k, { featureIdx: fi, segIdx: si, sampleIdx: s, totalSamples })
        }
        current = seg.to
      } else if (seg.type === 'circle') {
        const radius = Math.hypot(current.x - seg.center.x, current.y - seg.center.y)
        const startAngle = Math.atan2(current.y - seg.center.y, current.x - seg.center.x)
        for (let s = 1; s <= 64; s++) {
          const angle = startAngle + (seg.clockwise ? -1 : 1) * (Math.PI * 2 * s) / 64
          const pt = { x: seg.center.x + Math.cos(angle) * radius, y: seg.center.y + Math.sin(angle) * radius }
          const k = annKey(Math.round(pt.x * scale), Math.round(pt.y * scale))
          if (!map.has(k)) map.set(k, { featureIdx: fi, segIdx: si, sampleIdx: s, totalSamples: 64 })
        }
        current = profile.start
      }
    }
  }

  return map
}

function lerp(a: Point, b: Point, t: number): Point {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function splitBezierAt(
  p0: Point, p1: Point, p2: Point, p3: Point, t: number,
): { left: [Point, Point, Point, Point]; right: [Point, Point, Point, Point] } {
  const a = lerp(p0, p1, t)
  const b = lerp(p1, p2, t)
  const c = lerp(p2, p3, t)
  const ab = lerp(a, b, t)
  const bc = lerp(b, c, t)
  const mid = lerp(ab, bc, t)
  return {
    left: [p0, a, ab, mid],
    right: [mid, bc, c, p3],
  }
}

function subBezierControlPoints(
  p0: Point, p1: Point, p2: Point, p3: Point,
  tStart: number, tEnd: number,
): { control1: Point; control2: Point; to: Point } {
  if (tStart <= 0 && tEnd >= 1) {
    return { control1: p1, control2: p2, to: p3 }
  }
  if (tStart <= 0) {
    const { left } = splitBezierAt(p0, p1, p2, p3, tEnd)
    return { control1: left[1], control2: left[2], to: left[3] }
  }
  const { right } = splitBezierAt(p0, p1, p2, p3, tStart)
  if (tEnd >= 1) {
    return { control1: right[1], control2: right[2], to: right[3] }
  }
  const tAdj = (tEnd - tStart) / (1 - tStart)
  const { left } = splitBezierAt(right[0], right[1], right[2], right[3], tAdj)
  return { control1: left[1], control2: left[2], to: left[3] }
}

function getSegmentStart(profile: SketchProfile, segIdx: number): Point {
  return segIdx === 0 ? profile.start : profile.segments[segIdx - 1].to
}

export function clipperContourToProfilePreserving(
  contour: ReturnType<typeof flattenFeatureToClipperPath>,
  features: SketchFeature[],
  annotations: Map<string, SegmentAnnotation>,
  scale: number = DEFAULT_CLIPPER_SCALE,
): SketchProfile | null {
  const points = fromClipperPath(contour, scale)
  if (points.length < 3) return null

  const first = points[0]
  const last = points[points.length - 1]
  const vertices = (Math.abs(first.x - last.x) <= 1e-9 && Math.abs(first.y - last.y) <= 1e-9)
    ? points.slice(0, -1)
    : points
  if (vertices.length < 3) return null

  const n = vertices.length
  const anns: (SegmentAnnotation | null)[] = vertices.map((v) => {
    const k = annKey(Math.round(v.x * scale), Math.round(v.y * scale))
    return annotations.get(k) ?? null
  })

  // Group consecutive vertices into runs by (featureIdx, segIdx).
  // Unannotated vertices (intersection points) break runs.
  interface Run {
    startIdx: number
    endIdx: number
    annotation: SegmentAnnotation | null
  }

  const runs: Run[] = []
  let ri = 0
  while (ri < n) {
    const ann = anns[ri]
    if (ann === null) {
      runs.push({ startIdx: ri, endIdx: ri, annotation: null })
      ri++
      continue
    }
    let rj = ri + 1
    while (rj < n && anns[rj] !== null
      && anns[rj]!.featureIdx === ann.featureIdx
      && anns[rj]!.segIdx === ann.segIdx) {
      rj++
    }
    runs.push({ startIdx: ri, endIdx: rj - 1, annotation: ann })
    ri = rj
  }

  // Handle wrap-around: if the first and last runs are from the same segment,
  // merge them (Clipper's arbitrary start point may have split a segment).
  if (runs.length >= 2) {
    const firstRun = runs[0]
    const lastRun = runs[runs.length - 1]
    if (firstRun.annotation && lastRun.annotation
      && firstRun.annotation.featureIdx === lastRun.annotation.featureIdx
      && firstRun.annotation.segIdx === lastRun.annotation.segIdx) {
      // Rotate so the split segment is contiguous: move runs[0] to the end
      const merged = runs.slice(1, -1)
      merged.push({
        startIdx: lastRun.startIdx,
        endIdx: firstRun.endIdx + n,
        annotation: lastRun.annotation,
      })
      // Adjust: we'll treat indices >= n as wrapping (mod n)
      runs.length = 0
      runs.push(...merged)
    }
  }

  // Emit segments for each run
  const segments: Segment[] = []
  // Determine profile start: the first vertex at the start of runs[0]
  const startVertex = vertices[runs[0].startIdx % n]

  for (let r = 0; r < runs.length; r++) {
    const run = runs[r]

    if (run.annotation === null) {
      // Intersection point → emit line
      segments.push({ type: 'line', to: vertices[run.startIdx % n] })
      continue
    }

    const { featureIdx, segIdx } = run.annotation
    const profile = features[featureIdx].sketch.profile
    const seg = profile.segments[segIdx]
    const segStart = getSegmentStart(profile, segIdx)

    // Gather sample indices in this run
    const runLen = (run.endIdx >= run.startIdx)
      ? run.endIdx - run.startIdx + 1
      : (run.endIdx - run.startIdx + 1) // wrapped case already adjusted above
    const firstSample = anns[run.startIdx % n]!.sampleIdx
    const lastSample = anns[run.endIdx % n]!.sampleIdx
    const totalSamples = anns[run.startIdx % n]!.totalSamples
    const runEndPoint = vertices[run.endIdx % n]

    // Check if this run represents a complete segment
    const isComplete = (firstSample === 0 || firstSample === 1) && lastSample === totalSamples && runLen >= totalSamples

    if (seg.type === 'line') {
      segments.push({ type: 'line', to: runEndPoint })
    } else if (seg.type === 'arc' || seg.type === 'circle') {
      const center = seg.center
      // Determine clockwise from actual vertex traversal direction (normalizeWinding may have reversed)
      const prevEnd = r > 0 ? vertices[runs[r - 1].endIdx % n] : startVertex
      const clockwise = run.endIdx > run.startIdx
        ? arcIsClockwise(center, vertices[run.startIdx % n], vertices[(run.startIdx + 1) % n])
        : arcIsClockwise(center, prevEnd, vertices[run.startIdx % n])
      if (isComplete && seg.type === 'circle') {
        segments.push({ type: 'circle', to: runEndPoint, center: { x: center.x, y: center.y }, clockwise })
      } else {
        segments.push({ type: 'arc', to: runEndPoint, center: { x: center.x, y: center.y }, clockwise })
      }
    } else if (seg.type === 'bezier') {
      const reversed = firstSample > lastSample
      const isCompleteBezier = reversed
        ? firstSample === totalSamples && (lastSample === 0 || lastSample === 1) && runLen >= totalSamples
        : isComplete
      if (isCompleteBezier) {
        if (reversed) {
          segments.push({ type: 'bezier', to: segStart, control1: seg.control2, control2: seg.control1 })
        } else {
          segments.push({ type: 'bezier', to: seg.to, control1: seg.control1, control2: seg.control2 })
        }
      } else {
        const tLow = Math.min(firstSample, lastSample) / totalSamples
        const tHigh = Math.max(firstSample, lastSample) / totalSamples
        if (tHigh - tLow < 1e-9 || runLen < 3) {
          for (let k = run.startIdx; k < run.endIdx; k++) {
            segments.push({ type: 'line', to: vertices[(k + 1) % n] })
          }
        } else {
          const sub = subBezierControlPoints(segStart, seg.control1, seg.control2, seg.to, tLow, tHigh)
          if (reversed) {
            segments.push({ type: 'bezier', to: runEndPoint, control1: sub.control2, control2: sub.control1 })
          } else {
            segments.push({ type: 'bezier', to: runEndPoint, control1: sub.control1, control2: sub.control2 })
          }
        }
      }
    }
  }

  if (segments.length < 2) return null

  const lastTo = segments[segments.length - 1].to
  if (Math.abs(lastTo.x - startVertex.x) > 1e-9 || Math.abs(lastTo.y - startVertex.y) > 1e-9) {
    segments.push({ type: 'line', to: startVertex })
  }

  return { start: startVertex, segments, closed: true }
}
