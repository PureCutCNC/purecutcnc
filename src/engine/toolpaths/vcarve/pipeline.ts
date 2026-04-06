import type { ToolpathMove } from '../types'
import { cleanupSkeletonGraph, constrainSkeletonGraphToRegion } from './cleanup'
import { solveClipperSkeleton } from './clipperSkeleton'
import { skeletonGraphToRadiusBranches } from './depth'
import { prepareVCarveRegion } from './prepare'
import { radiusBranchesToToolpathMoves } from './toolpath'
import { skeletonGraphToPolylines } from './traverse'
import { diagnoseSkeletonGraph } from './validate'
import type { PreparedVCarveRegion, SkeletonBranchPoint, SkeletonGraph } from './types'

export interface GeometricVCarveRegionResult {
  prepared: PreparedVCarveRegion
  graph: SkeletonGraph
  polylines: Array<Array<{ x: number; y: number }>>
  branches: SkeletonBranchPoint[][]
  moves: ToolpathMove[]
  diagnostics: {
    illegalCrossingCount: number
  }
}

export function buildGeometricVCarveRegionResult(
  regionInput: Parameters<typeof prepareVCarveRegion>[0],
  options: {
    topZ: number
    maxDepth: number
    slope: number
    safeZ: number
    segmentLength: number
    minArcLength?: number
    minRadius?: number
  },
): GeometricVCarveRegionResult | null {
  const prepared = prepareVCarveRegion(regionInput)
  if (!prepared) {
    return null
  }

  // maxRadius: explore the full skeleton of the shape. The tool's max depth is
  // enforced downstream by radiusToDepth — it must not limit how far we trace
  // the skeleton, or large shapes will stop before their strokes collapse.
  const { minX, minY, maxX, maxY } = prepared.bounds
  const regionRadius = Math.hypot(maxX - minX, maxY - minY) / 2
  const rawGraph = solveClipperSkeleton(prepared, {
    stepSize: Math.max(options.segmentLength * 0.5, 0.02),
    maxRadius: regionRadius,
  })

  const constrainedGraph = constrainSkeletonGraphToRegion(rawGraph, prepared)
  const graph = cleanupSkeletonGraph(constrainedGraph, {
    minArcLength: options.minArcLength ?? options.segmentLength * 0.5,
    minRadius: options.minRadius ?? 1e-4,
  })
  const diagnostics = diagnoseSkeletonGraph(graph)
  const polylines = skeletonGraphToPolylines(graph)
  const branches = skeletonGraphToRadiusBranches(graph, options.segmentLength)
  const moves = radiusBranchesToToolpathMoves(
    branches,
    options.topZ,
    options.slope,
    options.maxDepth,
    options.safeZ,
  )

  return {
    prepared,
    graph,
    polylines,
    branches,
    moves,
    diagnostics,
  }
}
