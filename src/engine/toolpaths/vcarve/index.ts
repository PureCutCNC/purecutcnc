export { prepareVCarveRegion } from './prepare'
export { buildInitialWavefront, enumerateInitialEdgeEvents } from './wavefront'
export { cleanupSkeletonGraph, constrainSkeletonGraphToRegion } from './cleanup'
export { radiusToDepth, skeletonGraphToRadiusBranches } from './depth'
export { generateGeometricVCarveToolpath } from './geometricToolpath'
export { buildGeometricVCarveRegionResult } from './pipeline'
export { radiusBranchesToToolpathMoves } from './toolpath'
export { skeletonGraphToPolylines } from './traverse'
export { diagnoseSkeletonGraph } from './validate'
// Clipper-topology skeleton solver — the primary robust solver
export { solveClipperSkeleton, regionToClipperPaths } from './clipperSkeleton'
// Analytical wavefront solver — retained as experimental reference only
export { enumerateEdgeEvents, enumerateSplitEvents, solveEdgeSkeletonPreview, solveSkeletonGraph } from './skeleton'
export type {
  ClipperSkeletonOptions,
  EdgeEventCandidate,
  PreparedVCarveRegion,
  PreparedVCarveRing,
  SkeletonBranchPoint,
  SkeletonNode,
  SkeletonArc,
  SkeletonGraph,
  SplitEventCandidate,
  VCarveBounds,
  WavefrontEdge,
  WavefrontRing,
  WavefrontVertex,
} from './types'
