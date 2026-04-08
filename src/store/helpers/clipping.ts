import ClipperLib from 'clipper-lib'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  fromClipperPath,
  normalizeWinding,
  toClipperPath,
} from '../../engine/toolpaths/geometry'
import { getProfileBounds, polygonProfile } from '../../types/project'
import type { SketchFeature, SketchProfile } from '../../types/project'

export interface ClipperPolyNode {
  IsHole(): boolean
  Contour(): Array<{ X: number; Y: number }>
  Childs?: () => ClipperPolyNode[]
  m_Childs?: ClipperPolyNode[]
}

export function getClipperChildren(node: ClipperPolyNode): ClipperPolyNode[] {
  return node.Childs ? node.Childs() : (node.m_Childs ?? [])
}

export function flattenFeatureToClipperPath(feature: SketchFeature, scale = DEFAULT_CLIPPER_SCALE) {
  const flattened = flattenProfile(feature.sketch.profile)
  return toClipperPath(normalizeWinding(flattened.points, false), scale)
}

export function executeClipPaths(
  subjectPaths: ReturnType<typeof flattenFeatureToClipperPath>[],
  clipPaths: ReturnType<typeof flattenFeatureToClipperPath>[],
  clipType: number,
) {
  const clipper = new ClipperLib.Clipper()
  if (subjectPaths.length > 0) {
    clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  }
  if (clipPaths.length > 0) {
    clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  }

  const solution = new ClipperLib.Paths()
  clipper.Execute(
    clipType,
    solution,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return solution as ReturnType<typeof flattenFeatureToClipperPath>[]
}

export function executeClipTree(
  subjectPaths: ReturnType<typeof flattenFeatureToClipperPath>[],
  clipPaths: ReturnType<typeof flattenFeatureToClipperPath>[],
  clipType: number,
): ClipperPolyNode {
  const clipper = new ClipperLib.Clipper()
  if (subjectPaths.length > 0) {
    clipper.AddPaths(subjectPaths, ClipperLib.PolyType.ptSubject, true)
  }
  if (clipPaths.length > 0) {
    clipper.AddPaths(clipPaths, ClipperLib.PolyType.ptClip, true)
  }

  const polyTree = new ClipperLib.PolyTree()
  clipper.Execute(
    clipType,
    polyTree,
    ClipperLib.PolyFillType.pftNonZero,
    ClipperLib.PolyFillType.pftNonZero,
  )
  return polyTree as ClipperPolyNode
}

export function unionClipperPaths(paths: ReturnType<typeof flattenFeatureToClipperPath>[]) {
  if (paths.length === 0) {
    return []
  }
  return executeClipPaths(paths, [], ClipperLib.ClipType.ctUnion)
}

function rangesOverlap(minA: number, maxA: number, minB: number, maxB: number): boolean {
  return maxA >= minB && maxB >= minA
}

export function featuresOverlap(a: SketchFeature, b: SketchFeature): boolean {
  if (!a.sketch.profile.closed || !b.sketch.profile.closed) {
    return false
  }

  const boundsA = getProfileBounds(a.sketch.profile)
  const boundsB = getProfileBounds(b.sketch.profile)
  if (
    !rangesOverlap(boundsA.minX, boundsA.maxX, boundsB.minX, boundsB.maxX)
    || !rangesOverlap(boundsA.minY, boundsA.maxY, boundsB.minY, boundsB.maxY)
  ) {
    return false
  }

  const intersections = executeClipPaths(
    [flattenFeatureToClipperPath(a)],
    [flattenFeatureToClipperPath(b)],
    0,
  )

  return intersections.length > 0
}

export function featuresFormConnectedOverlapGroup(features: SketchFeature[]): boolean {
  if (features.length <= 1) {
    return true
  }

  const visited = new Set<number>([0])
  const stack = [0]

  while (stack.length > 0) {
    const currentIndex = stack.pop()!
    for (let index = 0; index < features.length; index += 1) {
      if (visited.has(index)) {
        continue
      }
      if (featuresOverlap(features[currentIndex], features[index])) {
        visited.add(index)
        stack.push(index)
      }
    }
  }

  return visited.size === features.length
}

export function offsetClipperPaths(paths: ReturnType<typeof flattenFeatureToClipperPath>[], delta: number) {
  if (paths.length === 0) {
    return []
  }
  const offset = new ClipperLib.ClipperOffset()
  offset.AddPaths(paths, ClipperLib.JoinType.jtMiter, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta)
  return solution as ReturnType<typeof flattenFeatureToClipperPath>[]
}

export function clipperContourToProfile(
  contour: ReturnType<typeof flattenFeatureToClipperPath>,
  scale = DEFAULT_CLIPPER_SCALE,
): SketchProfile | null {
  const points = fromClipperPath(contour, scale)
  if (points.length < 3) {
    return null
  }

  const first = points[0]
  const last = points[points.length - 1]
  const vertices = Math.abs(first.x - last.x) <= 1e-9 && Math.abs(first.y - last.y) <= 1e-9
    ? points.slice(0, -1)
    : points
  if (vertices.length < 3) {
    return null
  }

  return polygonProfile(vertices)
}
