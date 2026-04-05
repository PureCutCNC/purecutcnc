import type { Point } from '../../../types/project'
import type { EdgeEventCandidate, PreparedVCarveRegion, WavefrontEdge, WavefrontRing, WavefrontVertex } from './types'
import { add, angleBisector, distance, leftNormal, normalize, rayLineIntersection, rightNormal, scale, sub } from './geometry'

function buildEdges(points: Point[], hole: boolean): WavefrontEdge[] {
  return points.map((start, index) => {
    const end = points[(index + 1) % points.length]
    const rawDirection = sub(end, start)
    const direction = normalize(rawDirection)
    const length = distance(start, end)
      return {
        index,
        start,
        end,
        direction,
        inwardNormal: hole ? rightNormal(direction) : leftNormal(direction),
        length,
      }
  })
}

function buildVertices(points: Point[], edges: WavefrontEdge[], hole: boolean): WavefrontVertex[] {
  return points.map((point, index) => {
    const prevIndex = (index - 1 + points.length) % points.length
    const nextIndex = index
    const prevEdge = edges[prevIndex]
    const nextEdge = edges[nextIndex]
    const bisector = angleBisector(prevEdge.direction, nextEdge.direction, prevEdge.inwardNormal, hole)
    return {
      index,
      point,
      prevIndex,
      nextIndex: (index + 1) % points.length,
      reflex: bisector.reflex,
      bisectorDirection: bisector.direction,
      speedScale: bisector.speedScale,
    }
  })
}

export function buildWavefrontRing(points: Point[], hole: boolean): WavefrontRing {
  const edges = buildEdges(points, hole)
  const vertices = buildVertices(points, edges, hole)
  return {
    hole,
    points,
    edges,
    vertices,
  }
}

export function buildInitialWavefront(region: PreparedVCarveRegion): WavefrontRing[] {
  return region.rings.map((ring) => buildWavefrontRing(ring.points, ring.hole))
}

export function enumerateInitialEdgeEvents(ring: WavefrontRing): EdgeEventCandidate[] {
  const candidates: EdgeEventCandidate[] = []
  for (const vertex of ring.vertices) {
    if (!Number.isFinite(vertex.speedScale) || vertex.speedScale <= 0) {
      continue
    }
    const prev = ring.vertices[vertex.prevIndex]
    const next = ring.vertices[vertex.nextIndex]
    const left = rayLineIntersection(vertex.point, vertex.bisectorDirection, prev.point, prev.bisectorDirection)
    const right = rayLineIntersection(vertex.point, vertex.bisectorDirection, next.point, next.bisectorDirection)
    const candidate = [left, right]
      .filter((hit): hit is NonNullable<typeof hit> => hit !== null)
      .filter((hit) => hit.rayT > 0)
      .sort((a, b) => a.rayT - b.rayT)[0]
    if (!candidate) {
      continue
    }
    candidates.push({
      vertexIndex: vertex.index,
      time: candidate.rayT / vertex.speedScale,
      point: add(vertex.point, scale(vertex.bisectorDirection, candidate.rayT)),
    })
  }
  return candidates
}
