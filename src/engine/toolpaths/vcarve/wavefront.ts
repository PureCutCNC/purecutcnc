import type { Point } from '../../../types/project'
import type { EdgeEventCandidate, PreparedVCarveRegion, WavefrontEdge, WavefrontRing, WavefrontVertex } from './types'
import { add, angleBisector, distance, leftNormal, normalize, rightNormal, scale, sub } from './geometry'

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
    const next = ring.vertices[vertex.nextIndex]
    if (!next) {
      continue
    }
    if (
      !Number.isFinite(vertex.speedScale)
      || vertex.speedScale <= 0
      || !Number.isFinite(next.speedScale)
      || next.speedScale <= 0
    ) {
      continue
    }

    const vertexVelocity = scale(vertex.bisectorDirection, vertex.speedScale)
    const nextVelocity = scale(next.bisectorDirection, next.speedScale)
    const deltaPoint = sub(next.point, vertex.point)
    const deltaVelocity = sub(nextVelocity, vertexVelocity)
    const deltaVelocityLengthSquared = deltaVelocity.x * deltaVelocity.x + deltaVelocity.y * deltaVelocity.y
    if (!(deltaVelocityLengthSquared > 1e-12)) {
      continue
    }

    const time = -((deltaPoint.x * deltaVelocity.x) + (deltaPoint.y * deltaVelocity.y)) / deltaVelocityLengthSquared
    if (!(time > 0) || !Number.isFinite(time)) {
      continue
    }

    const vertexMoved = add(vertex.point, scale(vertexVelocity, time))
    const nextMoved = add(next.point, scale(nextVelocity, time))
    if (distance(vertexMoved, nextMoved) > 1e-5) {
      continue
    }

    const candidatePoint = scale(add(vertexMoved, nextMoved), 0.5)
    candidates.push({
      startVertexIndex: vertex.index,
      endVertexIndex: next.index,
      time,
      point: candidatePoint,
    })
  }
  return candidates
}
