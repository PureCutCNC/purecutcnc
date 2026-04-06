import type { Point } from '../../../types/project'
import type { SkeletonArc, SkeletonGraph } from './types'
import { cross, distance, sub } from './geometry'

const VALIDATION_EPSILON = 1e-6

function pointEquals(a: Point, b: Point): boolean {
  return distance(a, b) <= VALIDATION_EPSILON
}

function sharesEndpoint(a: SkeletonArc, b: SkeletonArc): boolean {
  return pointEquals(a.start, b.start)
    || pointEquals(a.start, b.end)
    || pointEquals(a.end, b.start)
    || pointEquals(a.end, b.end)
}

function pointOnSegment(point: Point, start: Point, end: Point): boolean {
  const toPoint = sub(point, start)
  const segment = sub(end, start)
  const segmentLength = distance(start, end)
  if (segmentLength <= VALIDATION_EPSILON) {
    return distance(point, start) <= VALIDATION_EPSILON
  }
  if (Math.abs(cross(toPoint, segment)) > VALIDATION_EPSILON * segmentLength) {
    return false
  }
  const dot = toPoint.x * segment.x + toPoint.y * segment.y
  if (dot < -VALIDATION_EPSILON) {
    return false
  }
  const segmentSquared = segment.x * segment.x + segment.y * segment.y
  return dot <= segmentSquared + VALIDATION_EPSILON
}

function properSegmentIntersection(a: SkeletonArc, b: SkeletonArc): boolean {
  const p = a.start
  const r = sub(a.end, a.start)
  const q = b.start
  const s = sub(b.end, b.start)
  const rxs = cross(r, s)
  const qmp = sub(q, p)
  const qmpxr = cross(qmp, r)

  if (Math.abs(rxs) <= VALIDATION_EPSILON && Math.abs(qmpxr) <= VALIDATION_EPSILON) {
    return (
      pointOnSegment(a.start, b.start, b.end)
      || pointOnSegment(a.end, b.start, b.end)
      || pointOnSegment(b.start, a.start, a.end)
      || pointOnSegment(b.end, a.start, a.end)
    ) && !sharesEndpoint(a, b)
  }

  if (Math.abs(rxs) <= VALIDATION_EPSILON) {
    return false
  }

  const t = cross(qmp, s) / rxs
  const u = cross(qmp, r) / rxs
  if (t <= VALIDATION_EPSILON || t >= 1 - VALIDATION_EPSILON || u <= VALIDATION_EPSILON || u >= 1 - VALIDATION_EPSILON) {
    return false
  }
  return true
}

export interface SkeletonGraphDiagnostics {
  illegalCrossingCount: number
}

export function diagnoseSkeletonGraph(graph: SkeletonGraph): SkeletonGraphDiagnostics {
  let illegalCrossingCount = 0

  for (let aIndex = 0; aIndex < graph.arcs.length; aIndex += 1) {
    for (let bIndex = aIndex + 1; bIndex < graph.arcs.length; bIndex += 1) {
      const arcA = graph.arcs[aIndex]
      const arcB = graph.arcs[bIndex]
      if (sharesEndpoint(arcA, arcB)) {
        continue
      }
      if (properSegmentIntersection(arcA, arcB)) {
        illegalCrossingCount += 1
      }
    }
  }

  return { illegalCrossingCount }
}
