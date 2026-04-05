import type { Point } from '../../../types/project'
import type { SkeletonGraph } from './types'

const GRAPH_EPSILON = 1e-6

interface GraphNodeRef {
  point: Point
  neighbors: Array<{ nodeIndex: number; arcIndex: number }>
}

function clonePoint(point: Point): Point {
  return { x: point.x, y: point.y }
}

function pointKey(point: Point): string {
  const scale = 1 / GRAPH_EPSILON
  return `${Math.round(point.x * scale)}:${Math.round(point.y * scale)}`
}

function buildAdjacency(graph: SkeletonGraph): GraphNodeRef[] {
  const nodes: GraphNodeRef[] = []
  const nodeIndexByKey = new Map<string, number>()

  function ensureNode(point: Point): number {
    const key = pointKey(point)
    const existing = nodeIndexByKey.get(key)
    if (existing !== undefined) {
      return existing
    }
    const index = nodes.length
    nodes.push({
      point: clonePoint(point),
      neighbors: [],
    })
    nodeIndexByKey.set(key, index)
    return index
  }

  graph.arcs.forEach((arc, arcIndex) => {
    const startIndex = ensureNode(arc.start)
    const endIndex = ensureNode(arc.end)
    if (startIndex === endIndex) {
      return
    }
    nodes[startIndex].neighbors.push({ nodeIndex: endIndex, arcIndex })
    nodes[endIndex].neighbors.push({ nodeIndex: startIndex, arcIndex })
  })

  return nodes
}

function walkBranch(
  startNodeIndex: number,
  nextNodeIndex: number,
  nodes: GraphNodeRef[],
  visitedArcs: Set<number>,
): Point[] {
  const points: Point[] = [clonePoint(nodes[startNodeIndex].point)]
  let previousNodeIndex = startNodeIndex
  let currentNodeIndex = nextNodeIndex

  while (true) {
    points.push(clonePoint(nodes[currentNodeIndex].point))

    const outgoing = nodes[currentNodeIndex].neighbors.filter(({ nodeIndex, arcIndex }) => {
      if (visitedArcs.has(arcIndex)) {
        return false
      }
      return nodeIndex !== previousNodeIndex
    })

    if (outgoing.length !== 1) {
      break
    }

    const next = outgoing[0]
    visitedArcs.add(next.arcIndex)
    previousNodeIndex = currentNodeIndex
    currentNodeIndex = next.nodeIndex
  }

  return points
}

function simplifyPolyline(points: Point[]): Point[] {
  if (points.length <= 2) {
    return points.map(clonePoint)
  }
  const simplified: Point[] = [clonePoint(points[0])]
  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = simplified[simplified.length - 1]
    const current = points[index]
    const next = points[index + 1]
    const ax = current.x - prev.x
    const ay = current.y - prev.y
    const bx = next.x - current.x
    const by = next.y - current.y
    const cross = Math.abs(ax * by - ay * bx)
    const dot = ax * bx + ay * by
    if (cross <= GRAPH_EPSILON && dot >= 0) {
      continue
    }
    simplified.push(clonePoint(current))
  }
  simplified.push(clonePoint(points[points.length - 1]))
  return simplified
}

export function skeletonGraphToPolylines(graph: SkeletonGraph): Point[][] {
  const nodes = buildAdjacency(graph)
  if (nodes.length === 0) {
    return []
  }

  const visitedArcs = new Set<number>()
  const polylines: Point[][] = []

  nodes.forEach((node, nodeIndex) => {
    if (node.neighbors.length === 2) {
      return
    }
    for (const neighbor of node.neighbors) {
      if (visitedArcs.has(neighbor.arcIndex)) {
        continue
      }
      visitedArcs.add(neighbor.arcIndex)
      polylines.push(simplifyPolyline(walkBranch(nodeIndex, neighbor.nodeIndex, nodes, visitedArcs)))
    }
  })

  graph.arcs.forEach((arc, arcIndex) => {
    if (visitedArcs.has(arcIndex)) {
      return
    }
    visitedArcs.add(arcIndex)
    polylines.push([clonePoint(arc.start), clonePoint(arc.end)])
  })

  return polylines.filter((polyline) => polyline.length >= 2)
}
