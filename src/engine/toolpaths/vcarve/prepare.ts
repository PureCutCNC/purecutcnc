import type { Point } from '../../../types/project'
import type { ResolvedPocketRegion } from '../types'
import type { PreparedVCarveRegion, PreparedVCarveRing, VCarveBounds } from './types'
import { isClockwise, removeCollinearVertices } from './geometry'

function normalizeOuter(points: Point[]): Point[] {
  const ring = removeCollinearVertices(points)
  return isClockwise(ring) ? [...ring].reverse() : ring
}

function normalizeHole(points: Point[]): Point[] {
  const ring = removeCollinearVertices(points)
  return isClockwise(ring) ? ring : [...ring].reverse()
}

function computeBounds(rings: PreparedVCarveRing[]): VCarveBounds {
  const allPoints = rings.flatMap((ring) => ring.points)
  return {
    minX: Math.min(...allPoints.map((point) => point.x)),
    minY: Math.min(...allPoints.map((point) => point.y)),
    maxX: Math.max(...allPoints.map((point) => point.x)),
    maxY: Math.max(...allPoints.map((point) => point.y)),
  }
}

export function prepareVCarveRegion(region: ResolvedPocketRegion): PreparedVCarveRegion | null {
  const outer = normalizeOuter(region.outer)
  if (outer.length < 3) {
    return null
  }

  const holes = region.islands
    .map(normalizeHole)
    .filter((ring) => ring.length >= 3)

  const rings: PreparedVCarveRing[] = [
    { points: outer, hole: false },
    ...holes.map((points) => ({ points, hole: true })),
  ]

  return {
    outer,
    holes,
    rings,
    bounds: computeBounds(rings),
  }
}
