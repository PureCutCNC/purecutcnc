import type { Point } from '../../../types/project'
import type { PreparedVCarveRegion, SkeletonArc, SkeletonCleanupOptions, SkeletonGraph } from './types'
import { distance, pointInPreparedRegion, segmentInsidePreparedRegion } from './geometry'

const CLEANUP_EPSILON = 1e-6

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y }
}

function pointKey(point: Point): string {
  const scale = 1 / CLEANUP_EPSILON
  return `${Math.round(point.x * scale)}:${Math.round(point.y * scale)}`
}

function canonicalArc(arc: SkeletonArc): SkeletonArc {
  const startBeforeEnd = arc.start.x < arc.end.x
    || (Math.abs(arc.start.x - arc.end.x) <= CLEANUP_EPSILON && arc.start.y <= arc.end.y)
  if (startBeforeEnd) {
    return {
      start: clonePoint(arc.start),
      end: clonePoint(arc.end),
      startRadius: arc.startRadius,
      endRadius: arc.endRadius,
    }
  }
  return {
    start: clonePoint(arc.end),
    end: clonePoint(arc.start),
    startRadius: arc.endRadius,
    endRadius: arc.startRadius,
  }
}

function arcKey(arc: SkeletonArc): string {
  const normalized = canonicalArc(arc)
  const scale = 1 / CLEANUP_EPSILON
  return [
    Math.round(normalized.start.x * scale),
    Math.round(normalized.start.y * scale),
    Math.round(normalized.end.x * scale),
    Math.round(normalized.end.y * scale),
    Math.round(normalized.startRadius * scale),
    Math.round(normalized.endRadius * scale),
  ].join(':')
}

function pointEquals(a: Point, b: Point): boolean {
  return distance(a, b) <= CLEANUP_EPSILON
}

function vector(from: Point, to: Point): Point {
  return { x: to.x - from.x, y: to.y - from.y }
}

function cross(a: Point, b: Point): number {
  return a.x * b.y - a.y * b.x
}

function dot(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y
}

function isCollinearContinuation(a: Point, b: Point, c: Point): boolean {
  const ab = vector(a, b)
  const bc = vector(b, c)
  const crossValue = Math.abs(cross(ab, bc))
  const dotValue = dot(ab, bc)
  return crossValue <= CLEANUP_EPSILON && dotValue > 0
}

function buildAdjacency(arcs: SkeletonArc[]): Map<string, number[]> {
  const adjacency = new Map<string, number[]>()
  arcs.forEach((arc, index) => {
    const startKey = pointKey(arc.start)
    const endKey = pointKey(arc.end)
    adjacency.set(startKey, [...(adjacency.get(startKey) ?? []), index])
    adjacency.set(endKey, [...(adjacency.get(endKey) ?? []), index])
  })
  return adjacency
}

function collapseRadialStarToNode(arcs: SkeletonArc[], nodes: SkeletonGraph['nodes']): SkeletonGraph {
  if (nodes.length !== 1 || arcs.length < 8) {
    return { arcs, nodes }
  }

  const center = nodes[0]
  const incident = arcs.filter((arc) => pointEquals(arc.start, center.point) || pointEquals(arc.end, center.point))
  if (incident.length !== arcs.length) {
    return { arcs, nodes }
  }

  const radii = incident.map((arc) => pointEquals(arc.start, center.point) ? arc.endRadius : arc.startRadius)
  const lengths = incident.map((arc) => pointEquals(arc.start, center.point)
    ? distance(center.point, arc.end)
    : distance(center.point, arc.start))

  const maxBoundaryRadius = Math.max(...radii)
  if (maxBoundaryRadius > CLEANUP_EPSILON * 10) {
    return { arcs, nodes }
  }

  const minLength = Math.min(...lengths)
  const maxLength = Math.max(...lengths)
  if (maxLength - minLength > Math.max(CLEANUP_EPSILON * 50, maxLength * 0.1)) {
    return { arcs, nodes }
  }

  return {
    arcs: [],
    nodes,
  }
}

function mergeCollinearArcs(arcs: SkeletonArc[]): SkeletonArc[] {
  let current = arcs.slice()
  let changed = true

  while (changed) {
    changed = false
    const adjacency = buildAdjacency(current)

    for (const [nodeKey, incident] of adjacency) {
      if (incident.length !== 2) {
        continue
      }
      const [aIndex, bIndex] = incident
      const arcA = current[aIndex]
      const arcB = current[bIndex]
      if (!arcA || !arcB) {
        continue
      }

      const nodePoint = pointKey(arcA.start) === nodeKey
        ? arcA.start
        : arcA.end
      const aOther = pointEquals(arcA.start, nodePoint) ? arcA.end : arcA.start
      const bOther = pointEquals(arcB.start, nodePoint) ? arcB.end : arcB.start
      if (!isCollinearContinuation(aOther, nodePoint, bOther)) {
        continue
      }

      const merged: SkeletonArc = {
        start: clonePoint(aOther),
        end: clonePoint(bOther),
        startRadius: pointEquals(arcA.start, nodePoint) ? arcA.endRadius : arcA.startRadius,
        endRadius: pointEquals(arcB.start, nodePoint) ? arcB.endRadius : arcB.startRadius,
      }

      current = current.filter((_, index) => index !== aIndex && index !== bIndex)
      current.push(merged)
      changed = true
      break
    }
  }

  return current
}

export function cleanupSkeletonGraph(graph: SkeletonGraph, options: SkeletonCleanupOptions = {}): SkeletonGraph {
  const minArcLength = Math.max(options.minArcLength ?? CLEANUP_EPSILON * 10, CLEANUP_EPSILON)
  const minRadius = Math.max(options.minRadius ?? CLEANUP_EPSILON, 0)
  const deduped = new Map<string, SkeletonArc>()

  for (const arc of graph.arcs) {
    if (distance(arc.start, arc.end) <= minArcLength) {
      continue
    }
    if (Math.max(arc.startRadius, arc.endRadius) <= minRadius) {
      continue
    }
    const key = arcKey(arc)
    if (!deduped.has(key)) {
      deduped.set(key, canonicalArc(arc))
    }
  }

  const merged = mergeCollinearArcs([...deduped.values()])

  const normalizedNodes = graph.nodes
      .filter((node) => Number.isFinite(node.radius) && node.radius > minRadius)
      .map((node) => ({
        point: clonePoint(node.point),
        radius: node.radius,
      }))

  return collapseRadialStarToNode(merged, normalizedNodes)
}

export function constrainSkeletonGraphToRegion(
  graph: SkeletonGraph,
  region: PreparedVCarveRegion,
): SkeletonGraph {
  const arcs = graph.arcs.filter((arc) => (
    pointInPreparedRegion(arc.start, region)
    && pointInPreparedRegion(arc.end, region)
    && segmentInsidePreparedRegion(arc.start, arc.end, region)
  ))

  const nodes = graph.nodes.filter((node) => pointInPreparedRegion(node.point, region))

  return {
    arcs,
    nodes,
  }
}
