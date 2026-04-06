import type { Point } from '../../../types/project'

export interface VCarveBounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface PreparedVCarveRing {
  points: Point[]
  hole: boolean
}

export interface PreparedVCarveRegion {
  outer: Point[]
  holes: Point[][]
  rings: PreparedVCarveRing[]
  bounds: VCarveBounds
}

export interface WavefrontEdge {
  index: number
  start: Point
  end: Point
  direction: Point
  inwardNormal: Point
  length: number
}

export interface WavefrontVertex {
  index: number
  point: Point
  prevIndex: number
  nextIndex: number
  reflex: boolean
  bisectorDirection: Point
  speedScale: number
}

export interface WavefrontRing {
  hole: boolean
  points: Point[]
  edges: WavefrontEdge[]
  vertices: WavefrontVertex[]
}

export interface SkeletonNode {
  point: Point
  radius: number
}

export interface EdgeEventCandidate {
  startVertexIndex: number
  endVertexIndex: number
  time: number
  point: Point
}

export interface SplitEventCandidate {
  vertexIndex: number
  edgeIndex: number
  time: number
  point: Point
}

export interface SkeletonArc {
  start: Point
  end: Point
  startRadius: number
  endRadius: number
}

export interface SkeletonGraph {
  arcs: SkeletonArc[]
  nodes: SkeletonNode[]
}

export interface SkeletonBranchPoint {
  x: number
  y: number
  radius: number
}

export interface SkeletonCleanupOptions {
  minArcLength?: number
  minRadius?: number
}

/**
 * Options for the Clipper-topology skeleton solver.
 *
 * stepSize   – inward offset increment per frame (mm). Smaller = more accurate
 *              skeleton but more frames to process. Default 0.05 mm.
 * maxRadius  – stop iterating once offset distance exceeds this (mm). Defaults
 *              to the largest inscribed circle radius of the polygon's bounding box.
 * minContourArea – contours whose area falls below this threshold (mm²) are
 *              considered collapsed and ignored. Default 0.001 mm².
 */
export interface ClipperSkeletonOptions {
  stepSize?: number
  maxRadius?: number
  minContourArea?: number
}
