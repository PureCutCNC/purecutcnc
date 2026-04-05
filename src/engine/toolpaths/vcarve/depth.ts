import type { SkeletonArc, SkeletonBranchPoint, SkeletonGraph } from './types'

const DEPTH_EPSILON = 1e-7

function interpolateArcPoint(arc: SkeletonArc, t: number): SkeletonBranchPoint {
  return {
    x: arc.start.x + (arc.end.x - arc.start.x) * t,
    y: arc.start.y + (arc.end.y - arc.start.y) * t,
    radius: arc.startRadius + (arc.endRadius - arc.startRadius) * t,
  }
}

export function skeletonGraphToRadiusBranches(graph: SkeletonGraph, segmentLength: number): SkeletonBranchPoint[][] {
  const safeSegmentLength = Math.max(segmentLength, 1e-4)
  const arcBranches = graph.arcs
    .map((arc) => {
      const length = Math.hypot(arc.end.x - arc.start.x, arc.end.y - arc.start.y)
      const segments = Math.max(1, Math.ceil(length / safeSegmentLength))
      const points: SkeletonBranchPoint[] = []
      for (let index = 0; index <= segments; index += 1) {
        points.push(interpolateArcPoint(arc, index / segments))
      }
      return points
    })
    .filter((branch) => branch.length >= 2)
  const nodeBranches = graph.nodes.map((node) => [{
    x: node.point.x,
    y: node.point.y,
    radius: node.radius,
  }])

  return [...arcBranches, ...nodeBranches]
    .sort((a, b) => {
      const aMax = a.reduce((maxValue, point) => Math.max(maxValue, point.radius), 0)
      const bMax = b.reduce((maxValue, point) => Math.max(maxValue, point.radius), 0)
      return bMax - aMax
    })
}

export function radiusToDepth(radius: number, slope: number, maxDepth: number): number {
  if (!(radius > DEPTH_EPSILON) || !(slope > DEPTH_EPSILON) || !(maxDepth > DEPTH_EPSILON)) {
    return 0
  }
  return Math.min(maxDepth, radius / slope)
}
