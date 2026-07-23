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

// Pure-geometry arc/curve reconstruction for Clipper output.
//
// Clipper works on integer polylines, so any arc, circle, or bezier in the
// source geometry comes back as a dense run of flattened chords. This module
// recovers curves from those chord runs. It has no state-management concern —
// profiles in, profiles out — so it lives in the engine layer alongside the
// other geometry helpers, not in `store/helpers/clipping.ts` (which stays a
// thin Clipper wrapper).
//
// Three reconstruction strategies live here:
//   1. Known-circle reconstruction (`reconstructArcsInProfile`,
//      `clipperContourToProfile`) — recover arcs/circles whose center+radius
//      we already know from the source features.
//   2. Segment-preserving boolean reconstruction (`buildSegmentAnnotations`,
//      `clipperContourToProfilePreserving`) — map Clipper output vertices back
//      to the exact source segment that produced them and reuse it verbatim.
//   3. Offset simplification (`simplifyOffsetContour`) — for Clipper-offset
//      polylines, collapse collinear chords and re-fit arcs via a Kasa
//      least-squares fit constrained to source-concentric centers, then RDP.

import {
  DEFAULT_CLIPPER_SCALE,
  DEFAULT_FLATTEN_ARC_STEP,
  DEFAULT_FLATTEN_CURVE_SAMPLES,
  fromClipperPath,
} from './geometry'
import type { ClipperPath } from './types'
import { bezierPoint, polygonProfile } from '../../types/project'
import type { Point, Segment, SketchFeature, SketchProfile } from '../../types/project'

export interface KnownCircle {
  center: Point
  radius: number
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

export function reconstructArcsInProfile(
  vertices: Point[],
  knownCircles: KnownCircle[],
  maxSingleArcAngle?: number,
): SketchProfile {
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
      if (maxSingleArcAngle !== undefined) {
        const a1 = Math.atan2(vertices[i].y - circle.center.y, vertices[i].x - circle.center.x)
        const a2 = Math.atan2(vertices[nextIdx].y - circle.center.y, vertices[nextIdx].x - circle.center.x)
        let span = Math.abs(a2 - a1)
        if (span > Math.PI) span = 2 * Math.PI - span
        if (span > maxSingleArcAngle) {
          segments.push({ type: 'line', to: vertices[nextIdx] })
          continue
        }
      }
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

export function clipperContourToProfile(
  contour: ClipperPath,
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

// ── Segment-preserving boolean reconstruction ─────────────────────────────────
// Instead of reconstructing curves from a flattened polygon, this approach
// maps Clipper output vertices back to their original segments and preserves
// them exactly. Only intersection points become line segments.
//
// The annotation map keys Clipper integer coordinates to the source segment
// that produced them, so it MUST flatten arcs/beziers with the same sampling
// parameters Clipper input was flattened with — hence the shared
// DEFAULT_FLATTEN_* constants from `geometry.ts`. Diverging here would silently
// drop annotation keys and fall arcs back to polyline chords.

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
  if (seg.type === 'bezier') return DEFAULT_FLATTEN_CURVE_SAMPLES
  if (seg.type === 'circle') return 64
  const startAngle = Math.atan2(segStart.y - seg.center.y, segStart.x - seg.center.x)
  const endAngle = Math.atan2(seg.to.y - seg.center.y, seg.to.x - seg.center.x)
  let sweep = endAngle - startAngle
  if (seg.clockwise && sweep > 0) sweep -= Math.PI * 2
  else if (!seg.clockwise && sweep < 0) sweep += Math.PI * 2
  return Math.max(8, Math.ceil(Math.abs(sweep) / DEFAULT_FLATTEN_ARC_STEP))
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
        for (let s = 1; s <= DEFAULT_FLATTEN_CURVE_SAMPLES; s++) {
          const pt = bezierPoint(current, seg.control1, seg.control2, seg.to, s / DEFAULT_FLATTEN_CURVE_SAMPLES)
          const k = annKey(Math.round(pt.x * scale), Math.round(pt.y * scale))
          if (!map.has(k)) map.set(k, { featureIdx: fi, segIdx: si, sampleIdx: s, totalSamples: DEFAULT_FLATTEN_CURVE_SAMPLES })
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
  contour: ClipperPath,
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
      // Intersection point → emit line (skip if it would be zero-length)
      const target = vertices[run.startIdx % n]
      const prev = segments.length > 0 ? segments[segments.length - 1].to : startVertex
      if (Math.abs(target.x - prev.x) > 1e-9 || Math.abs(target.y - prev.y) > 1e-9) {
        segments.push({ type: 'line', to: target })
      }
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
      const prev = segments.length > 0 ? segments[segments.length - 1].to : startVertex
      if (Math.abs(runEndPoint.x - prev.x) > 1e-9 || Math.abs(runEndPoint.y - prev.y) > 1e-9) {
        segments.push({ type: 'line', to: runEndPoint })
      }
    } else if (seg.type === 'arc' || seg.type === 'circle') {
      const center = seg.center
      const prevEnd = r > 0 ? vertices[runs[r - 1].endIdx % n] : startVertex
      const arcStart = vertices[run.startIdx % n]
      const originalRadius = Math.hypot(segStart.x - center.x, segStart.y - center.y)
      const rStart = Math.hypot(arcStart.x - center.x, arcStart.y - center.y)
      const rEnd = Math.hypot(runEndPoint.x - center.x, runEndPoint.y - center.y)
      const radiusTolerance = Math.max(originalRadius * 0.02, 0.005)
      const arcValid = Math.abs(rStart - originalRadius) <= radiusTolerance
        && Math.abs(rEnd - originalRadius) <= radiusTolerance

      if (!arcValid) {
        // Arc endpoints are not on the claimed circle — emit line segments
        for (let k = run.startIdx; k <= run.endIdx; k++) {
          segments.push({ type: 'line', to: vertices[k % n] })
        }
      } else {
        // Bridge any gap between previous segment end and arc start
        if (Math.abs(arcStart.x - prevEnd.x) > 1e-6 || Math.abs(arcStart.y - prevEnd.y) > 1e-6) {
          segments.push({ type: 'line', to: arcStart })
        }
        // Determine clockwise from actual vertex traversal direction (normalizeWinding may have reversed)
        const clockwise = run.endIdx > run.startIdx
          ? arcIsClockwise(center, vertices[run.startIdx % n], vertices[(run.startIdx + 1) % n])
          : arcIsClockwise(center, prevEnd, vertices[run.startIdx % n])
        if (isComplete && seg.type === 'circle') {
          segments.push({ type: 'circle', to: runEndPoint, center: { x: center.x, y: center.y }, clockwise })
        } else {
          segments.push({ type: 'arc', to: runEndPoint, center: { x: center.x, y: center.y }, clockwise })
        }
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

// ── Shared partial-run arc fitting ────────────────────────────────────────────
// Extracted from the offset-simplification pipeline so G-code export can reuse
// the same greedy sub-run search without depending on source-circle metadata,
// Segment types, or Clipper internals.
//
// The function operates on a flat point sequence — no segment types, no
// closed/open semantics. Callers adapt their data into Point[] and convert
// the returned index ranges back into their own geometry descriptors.

/** Options controlling the partial-run greedy arc search. */
export interface PartialArcFitOptions {
  /** Minimum number of points needed to attempt a fit (≥ 3). */
  minArcPoints: number
  /** Maximum absolute chordal deviation (radial residual) in project units. */
  maxResidual: number
  /** Maximum angular step between consecutive points, in degrees. Rejects
   *  runs whose individual chord-to-chord angles exceed this threshold. */
  maxSegmentAngleDeg: number
  /** Minimum total angular sweep in radians to accept a fit (0 = skip).
   *  Prevents fitting a huge-radius circle to a nearly-straight line —
   *  a scale-independent gate.  0.5° ≈ 0.0087 rad is a reasonable default. */
  minTotalSweepRad?: number
  /** Minimum chord-length-to-radius ratio to accept a non-full-circle fit.
   *  Set to 0 to skip this check.  Prevents fitting a tiny chord as an arc. */
  minChordRatio: number
  /** Optional source-circle centers for anti-spurious validation.
   *  When provided and non-empty, a fit whose center is farther than
   *  min(0.01, radius×0.001) from any source center is rejected.
   *  Pass an empty array to skip this check (export does this). */
  sourceCenters?: Point[]
}

/** One contiguous arc sub-run found within a point sequence. */
export interface FittedArcRun {
  /** Index of the first point in the run (inclusive). */
  startIndex: number
  /** Index of the last point in the run (inclusive). */
  endIndex: number
  /** Fitted circle centre. */
  center: Point
  /** Fitted circle radius. */
  radius: number
  /** True when the arc turns clockwise (negative cross sum). */
  clockwise: boolean
}

function dist2D(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/**
 * Greedy partial-run arc finder.
 *
 * Walks the point sequence from left to right. At each position it attempts
 * the longest qualifying arc run (working backward from the end). When a fit
 * passes all validation gates the run is recorded and the walker advances
 * past it; otherwise the walker advances by one point.
 *
 * Points not covered by any returned {@link FittedArcRun} are linear.
 */
export function findArcRunsInPoints(
  points: Point[],
  opts: PartialArcFitOptions,
): FittedArcRun[] {
  const n = points.length
  if (n < opts.minArcPoints) return []

  const runs: FittedArcRun[] = []
  let i = 0

  while (i < n - opts.minArcPoints + 1) {
    let best: FittedArcRun | null = null

    // Try the longest qualifying sub-run first (greedy).
    for (let end = n - 1; end >= i + opts.minArcPoints - 1; end -= 1) {
      const sub = points.slice(i, end + 1)
      const fit = fitCircleLeastSquares(sub)
      if (!fit) continue

      if (!validateArcFitPoints(sub, fit, opts)) continue

      const clockwise = arcSweepClockwise(sub, fit.center)
      best = {
        startIndex: i,
        endIndex: end,
        center: fit.center,
        radius: fit.radius,
        clockwise,
      }
      break // longest wins; stop trying shorter runs
    }

    if (best) {
      runs.push(best)
      i = best.endIndex // advance past the consumed arc run
    } else {
      i += 1
    }
  }

  return runs
}

/** Shared arc-fit validation used by both the offset and export paths. */
function validateArcFitPoints(
  points: Point[],
  fit: { center: Point; radius: number },
  opts: PartialArcFitOptions,
): boolean {
  const { center, radius } = fit

  // 1. Residual check — every point must lie within maxResidual of the circle.
  for (const p of points) {
    if (Math.abs(dist2D(p, center) - radius) > opts.maxResidual) return false
  }

  // 2. Source-centre anti-spurious safeguard (optional).
  if (opts.sourceCenters && opts.sourceCenters.length > 0) {
    const centerProximity = Math.min(0.01, radius * 0.001)
    let nearSource = false
    for (const sc of opts.sourceCenters) {
      if (dist2D(center, sc) <= centerProximity) { nearSource = true; break }
    }
    if (!nearSource) return false
  }

  // 3. Per-segment angle check — individual chord-to-chord step must not
  //    exceed maxSegmentAngleDeg.
  const maxSegmentAngle = (opts.maxSegmentAngleDeg * Math.PI) / 180
  for (let k = 0; k < points.length - 1; k += 1) {
    const a1 = Math.atan2(points[k].y - center.y, points[k].x - center.x)
    const a2 = Math.atan2(points[k + 1].y - center.y, points[k + 1].x - center.x)
    let da = Math.abs(a2 - a1)
    if (da > Math.PI) da = 2 * Math.PI - da
    if (da > maxSegmentAngle) return false
  }

  // 4. Minimum total sweep gate — prevent fitting a huge-radius circle
  //    to a nearly-straight line (scale-independent).
  if (opts.minTotalSweepRad && opts.minTotalSweepRad > 0) {
    let totalSweep = 0
    for (let k = 0; k < points.length - 1; k += 1) {
      const a0 = Math.atan2(points[k].y - center.y, points[k].x - center.x)
      const a1 = Math.atan2(points[k + 1].y - center.y, points[k + 1].x - center.x)
      let diff = a1 - a0
      while (diff > Math.PI) diff -= 2 * Math.PI
      while (diff <= -Math.PI) diff += 2 * Math.PI
      totalSweep += Math.abs(diff)
    }
    if (totalSweep < opts.minTotalSweepRad) return false
  }

  // 5. Minimum chord ratio — prevent fitting a tiny chord as an arc.
  //    Full circles (chord ≈ 0) are exempt.
  if (opts.minChordRatio > 0) {
    const chord = dist2D(points[0], points[points.length - 1])
    const isFullCircle = chord <= radius * 1e-6
    if (!isFullCircle && chord < radius * opts.minChordRatio) return false
  }

  return true
}

// ── Offset polyline simplification ────────────────────────────────────────────
// Clipper offset emits dense polylines (a flattened source curve stays flat
// after offsetting, and Clipper rebuilds the polygon from integer vertices).
// This pass converts those polylines back into arcs/circles where possible.
//
// Two strategies layered together:
//   1. Known-circle reconstruction. Any source `arc`/`circle` of radius R at
//      center C produces an offset arc with the same center and radius
//      R ± |delta|. We feed those candidate circles to reconstructArcsInProfile
//      to recover exact original centers.
//   2. Generic Kasa least-squares arc fit, for offsets of curves whose centers
//      are not in the source feature set (e.g. arcs introduced by another
//      simplification pass, or offsets of dense polylines).
// Followed by collinear-line merge and a single-arc → circle promotion.

interface OffsetFitOptions {
  minArcSegments: number
  radiusToleranceFraction: number
  maxSegmentAngleDeg: number
}

const DEFAULT_OFFSET_FIT_OPTIONS: OffsetFitOptions = {
  minArcSegments: 6,
  radiusToleranceFraction: 0.01,
  maxSegmentAngleDeg: 20,
}

// Kasa least-squares circle fit. Returns null on near-collinear input.
function fitCircleLeastSquares(points: Point[]): { center: Point; radius: number } | null {
  const n = points.length
  if (n < 3) return null

  let cx = 0
  let cy = 0
  for (const p of points) {
    cx += p.x
    cy += p.y
  }
  cx /= n
  cy /= n

  let Suu = 0
  let Suv = 0
  let Svv = 0
  let Arhs = 0
  let Brhs = 0
  for (const p of points) {
    const u = p.x - cx
    const v = p.y - cy
    const r2 = u * u + v * v
    Suu += u * u
    Suv += u * v
    Svv += v * v
    Arhs -= u * r2
    Brhs -= v * r2
  }

  const det = Suu * Svv - Suv * Suv
  if (Math.abs(det) < 1e-12) return null

  const A = (Arhs * Svv - Brhs * Suv) / det
  const B = (Suu * Brhs - Suv * Arhs) / det
  const cu = -A / 2
  const cv = -B / 2

  let Sr2 = 0
  for (const p of points) {
    const u = p.x - cx
    const v = p.y - cy
    Sr2 += u * u + v * v
  }
  const radius2 = cu * cu + cv * cv + Sr2 / n
  if (radius2 <= 0) return null

  return { center: { x: cu + cx, y: cv + cy }, radius: Math.sqrt(radius2) }
}

function arcSweepClockwise(points: Point[], center: Point): boolean {
  let cross = 0
  for (let i = 0; i < points.length - 1; i += 1) {
    const v0x = points[i].x - center.x
    const v0y = points[i].y - center.y
    const v1x = points[i + 1].x - center.x
    const v1y = points[i + 1].y - center.y
    cross += v0x * v1y - v0y * v1x
  }
  // Match the project convention used by arcIsClockwise: negative cross sum
  // is clockwise. Using the wrong sign makes long arcs render as their
  // (much shorter) complement.
  return cross < 0
}

function pointsCollinear(a: Point, b: Point, c: Point): boolean {
  const abx = b.x - a.x
  const aby = b.y - a.y
  const bcx = c.x - b.x
  const bcy = c.y - b.y
  const dot = abx * bcx + aby * bcy
  if (dot <= 0) return false
  const cross = abx * bcy - aby * bcx
  const abLen2 = abx * abx + aby * aby
  const bcLen2 = bcx * bcx + bcy * bcy
  return cross * cross < 1e-8 * abLen2 * bcLen2
}

function mergeCollinearLinesClosed(profile: SketchProfile): SketchProfile {
  if (profile.segments.length < 2) return profile

  // Walk segments and merge adjacent collinear line-line pairs. Also rotate the
  // start point if the closing line is collinear with the first line.
  const segs = profile.segments
  const merged: Segment[] = []
  let currentStart = profile.start
  let current: Segment = segs[0]

  for (let i = 1; i < segs.length; i += 1) {
    const next = segs[i]
    if (
      current.type === 'line'
      && next.type === 'line'
      && pointsCollinear(currentStart, current.to, next.to)
    ) {
      current = { type: 'line', to: next.to }
    } else {
      merged.push(current)
      currentStart = current.to
      current = next
    }
  }
  merged.push(current)

  if (!profile.closed || merged.length < 2) {
    return { ...profile, segments: merged }
  }

  // Wrap-around merge: if the closing line and the leading line are collinear
  // through profile.start, shift the start point so the three collinear
  // segments collapse into one and the trailing point becomes a new start.
  if (merged.length >= 3) {
    const lastSeg = merged[merged.length - 1]
    const firstSeg = merged[0]
    if (lastSeg.type === 'line' && firstSeg.type === 'line') {
      const lastStart = merged[merged.length - 2].to
      if (pointsCollinear(lastStart, lastSeg.to, firstSeg.to)) {
        const newStart = lastStart
        const rotated: Segment[] = [
          { type: 'line', to: firstSeg.to },
          ...merged.slice(1, -1),
        ]
        return { ...profile, start: newStart, segments: rotated }
      }
    }
  }

  return { ...profile, segments: merged }
}

interface ArcFitOutcome {
  center: Point
  clockwise: boolean
}

function tryFitArcRun(
  points: Point[],
  opts: OffsetFitOptions,
  sourceCenters: Point[],
): ArcFitOutcome | null {
  if (points.length < opts.minArcSegments + 1) return null
  if (sourceCenters.length === 0) return null

  const fit = fitCircleLeastSquares(points)
  if (!fit) return null

  const { center, radius } = fit
  const tolerance = Math.min(opts.radiusToleranceFraction * radius, 0.05)

  for (const p of points) {
    if (Math.abs(dist2D(p, center) - radius) > tolerance) return null
  }

  // Every legitimate offset arc is concentric with a source arc/circle. A
  // Kasa fit whose center is far from any source center is geometrically
  // valid math but spurious — typically a huge-radius circle fitted to a
  // slightly-bowed straight run. Reject it.
  const centerProximity = Math.min(0.01, radius * 0.001)
  let nearSource = false
  for (const sc of sourceCenters) {
    if (dist2D(center, sc) <= centerProximity) { nearSource = true; break }
  }
  if (!nearSource) return null

  const maxSegmentAngle = (opts.maxSegmentAngleDeg * Math.PI) / 180
  for (let i = 0; i < points.length - 1; i += 1) {
    const a1 = Math.atan2(points[i].y - center.y, points[i].x - center.x)
    const a2 = Math.atan2(points[i + 1].y - center.y, points[i + 1].x - center.x)
    let da = Math.abs(a2 - a1)
    if (da > Math.PI) da = 2 * Math.PI - da
    if (da > maxSegmentAngle) return null
  }

  const chord = dist2D(points[0], points[points.length - 1])
  const isFullCircle = chord <= radius * 1e-6
  if (!isFullCircle && chord < radius * 0.15) return null

  return { center, clockwise: arcSweepClockwise(points, center) }
}

function sliceLineRunVertices(profile: SketchProfile, startSeg: number, endSeg: number): Point[] {
  const origin: Point = startSeg === 0 ? profile.start : profile.segments[startSeg - 1].to
  const pts: Point[] = [origin]
  for (let i = startSeg; i < endSeg; i += 1) {
    pts.push(profile.segments[i].to)
  }
  return pts
}

// Fit arcs into contiguous runs of line segments. Non-line segments (existing
// arcs/circles/beziers) are passed through unchanged. Operates on a sequential
// walk and does not attempt to merge an arc across the start/end boundary of a
// closed profile.
function fitArcsInLineRuns(
  profile: SketchProfile,
  opts: OffsetFitOptions,
  sourceCenters: Point[],
): SketchProfile {
  const segs = profile.segments
  if (segs.length < opts.minArcSegments) return profile
  if (sourceCenters.length === 0) return profile

  const out: Segment[] = []
  let i = 0
  while (i < segs.length) {
    if (segs[i].type !== 'line') {
      out.push(segs[i])
      i += 1
      continue
    }

    let runEnd = i + 1
    while (runEnd < segs.length && segs[runEnd].type === 'line') {
      runEnd += 1
    }

    let consumed = false
    for (let end = runEnd; end >= i + opts.minArcSegments; end -= 1) {
      const pts = sliceLineRunVertices(profile, i, end)
      const fit = tryFitArcRun(pts, opts, sourceCenters)
      if (fit) {
        out.push({
          type: 'arc',
          to: pts[pts.length - 1],
          center: fit.center,
          clockwise: fit.clockwise,
        })
        i = end
        consumed = true
        break
      }
    }

    if (!consumed) {
      out.push(segs[i])
      i += 1
    }
  }

  return { ...profile, segments: out }
}

// ── Douglas-Peucker simplification for residual line runs ────────────────────
// Applied to contiguous runs of `line` segments only — arcs and other curves
// are anchors that bound runs. A fully-closed line-only profile is split at
// the vertex farthest from start so neither RDP half degenerates.

function perpendicularDistance(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-18) return Math.hypot(p.x - a.x, p.y - a.y)
  // Perpendicular distance to the infinite line through a,b (standard RDP).
  return Math.abs(dy * p.x - dx * p.y + b.x * a.y - b.y * a.x) / Math.sqrt(len2)
}

function rdpSimplifyOpenRun(points: Point[], tolerance: number): Point[] {
  const n = points.length
  if (n < 3) return points

  // Iterative stack-based RDP to avoid stack overflow on long runs.
  const keep = new Uint8Array(n)
  keep[0] = 1
  keep[n - 1] = 1
  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!
    let maxDist = 0
    let maxIdx = -1
    for (let i = lo + 1; i < hi; i += 1) {
      const d = perpendicularDistance(points[i], points[lo], points[hi])
      if (d > maxDist) { maxDist = d; maxIdx = i }
    }
    if (maxDist > tolerance && maxIdx >= 0) {
      keep[maxIdx] = 1
      stack.push([lo, maxIdx])
      stack.push([maxIdx, hi])
    }
  }

  const result: Point[] = []
  for (let i = 0; i < n; i += 1) {
    if (keep[i]) result.push(points[i])
  }
  return result
}

function applyRDPToLineRuns(profile: SketchProfile, tolerance: number): SketchProfile {
  if (tolerance <= 0 || profile.segments.length === 0) return profile

  const segs = profile.segments
  const out: Segment[] = []
  let i = 0
  let cursor: Point = profile.start

  while (i < segs.length) {
    if (segs[i].type !== 'line') {
      out.push(segs[i])
      cursor = segs[i].to
      i += 1
      continue
    }

    // Collect a contiguous run of line segments. runPts[0] is the anchor at
    // the start of the run; runPts[N] is the anchor at the end.
    const runPts: Point[] = [cursor]
    let j = i
    while (j < segs.length && segs[j].type === 'line') {
      runPts.push(segs[j].to)
      j += 1
    }

    let simplified: Point[]
    const isFullClosed = profile.closed
      && i === 0
      && j === segs.length
      && dist2D(runPts[0], runPts[runPts.length - 1]) < 1e-9

    if (isFullClosed) {
      // No external anchors — RDP would collapse the loop. Pick the vertex
      // farthest from the start as a second anchor and RDP each half.
      let splitIdx = 0
      let maxD = 0
      for (let k = 1; k < runPts.length - 1; k += 1) {
        const d = dist2D(runPts[k], runPts[0])
        if (d > maxD) { maxD = d; splitIdx = k }
      }
      if (splitIdx < 2 || splitIdx > runPts.length - 3) {
        simplified = runPts
      } else {
        const left = rdpSimplifyOpenRun(runPts.slice(0, splitIdx + 1), tolerance)
        const right = rdpSimplifyOpenRun(runPts.slice(splitIdx), tolerance)
        simplified = [...left.slice(0, -1), ...right]
      }
    } else {
      simplified = rdpSimplifyOpenRun(runPts, tolerance)
    }

    for (let k = 1; k < simplified.length; k += 1) {
      out.push({ type: 'line', to: simplified[k] })
    }
    cursor = simplified[simplified.length - 1]
    i = j
  }

  return { ...profile, segments: out }
}

function bboxDiagonal(points: Point[]): number {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return Math.hypot(maxX - minX, maxY - minY)
}

// If a closed profile reduces to a single arc whose endpoint coincides with
// the start, promote it to a `circle` segment.
function promoteClosedArcToCircle(profile: SketchProfile): SketchProfile {
  if (!profile.closed || profile.segments.length !== 1) return profile
  const seg = profile.segments[0]
  if (seg.type !== 'arc') return profile

  const radius = dist2D(profile.start, seg.center)
  if (radius <= 0) return profile
  if (dist2D(seg.to, profile.start) > 0.01 * radius) return profile

  return {
    start: profile.start,
    segments: [{
      type: 'circle',
      center: seg.center,
      to: profile.start,
      clockwise: seg.clockwise,
    }],
    closed: true,
  }
}

export function simplifyOffsetContour(
  contour: ClipperPath,
  sourceFeatures: SketchFeature[],
  _delta: number,
  scale: number = DEFAULT_CLIPPER_SCALE,
): SketchProfile | null {
  // Offset output is a closed polyline. We collapse runs of collinear chords
  // back into single lines and re-fit dense chord runs to arcs, but only when
  // the fitted center matches a source arc/circle center — every legitimate
  // offset arc is concentric with its source, so any fit whose center wanders
  // is a spurious match (typically a slightly-bowed straight run fitted to a
  // huge-radius circle).
  const points = fromClipperPath(contour, scale)
  if (points.length < 3) return null

  const first = points[0]
  const last = points[points.length - 1]
  const vertices = Math.abs(first.x - last.x) <= 1e-9 && Math.abs(first.y - last.y) <= 1e-9
    ? points.slice(0, -1)
    : points
  if (vertices.length < 3) return null

  const sourceCenters = collectKnownCircles(sourceFeatures).map((c) => c.center)
  const rdpTolerance = bboxDiagonal(vertices) * 0.001

  let profile: SketchProfile = polygonProfile(vertices)
  profile = mergeCollinearLinesClosed(profile)
  profile = fitArcsInLineRuns(profile, DEFAULT_OFFSET_FIT_OPTIONS, sourceCenters)
  profile = applyRDPToLineRuns(profile, rdpTolerance)
  profile = promoteClosedArcToCircle(profile)
  return profile
}
