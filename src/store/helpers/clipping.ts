/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// Thin clipper-lib wrappers. This module handles the integer-scaling factor and
// the bridge between `.camj` profiles and Clipper paths, plus the boolean/offset
// execution helpers and overlap predicates the store relies on. Pure-geometry
// arc/curve reconstruction of Clipper output lives in
// `engine/toolpaths/arcReconstruction.ts`, not here (see issue #122).

import ClipperLib from 'clipper-lib'
import {
  DEFAULT_CLIPPER_SCALE,
  flattenProfile,
  normalizeWinding,
  toClipperPath,
} from '../../engine/toolpaths/geometry'
import { getProfileBounds } from '../../types/project'
import type { SketchFeature } from '../../types/project'
import { openCrossesClosedFully } from './polygonSplit'

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

// Convert an open profile to a Clipper path without auto-closing. Used
// when feeding an open polyline to Clipper as an open subject.
export function flattenOpenFeatureToClipperPath(feature: SketchFeature, scale = DEFAULT_CLIPPER_SCALE) {
  const flattened = flattenProfile(feature.sketch.profile)
  return flattened.points.map((p) => ({
    X: Math.round(p.x * scale),
    Y: Math.round(p.y * scale),
  }))
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

// Overlap test used to validate cut-mode target selection. Unlike
// `featuresOverlap`, this accepts open profiles on either side and uses
// the appropriate semantics:
//   - closed target × closed cutter: any area intersection
//   - closed target × open cutter:   open cutter must fully cross target
//   - open target × closed cutter:   any intersection (partial OK)
//   - open target × open cutter:     not allowed (returns false)
export function featuresOverlapForCut(target: SketchFeature, cutter: SketchFeature): boolean {
  const tClosed = target.sketch.profile.closed
  const cClosed = cutter.sketch.profile.closed

  const boundsA = getProfileBounds(target.sketch.profile)
  const boundsB = getProfileBounds(cutter.sketch.profile)
  if (
    !rangesOverlap(boundsA.minX, boundsA.maxX, boundsB.minX, boundsB.maxX)
    || !rangesOverlap(boundsA.minY, boundsA.maxY, boundsB.minY, boundsB.maxY)
  ) {
    return false
  }

  if (tClosed && cClosed) {
    const intersections = executeClipPaths(
      [flattenFeatureToClipperPath(target)],
      [flattenFeatureToClipperPath(cutter)],
      0,
    )
    return intersections.length > 0
  }

  if (tClosed && !cClosed) {
    return openCrossesClosedFully(cutter.sketch.profile, target.sketch.profile)
  }

  if (!tClosed && cClosed) {
    // Trim semantics: any portion of the open target inside the closed cutter
    // gets removed. Detect by clipping the open path as a Clipper subject.
    const clipper = new ClipperLib.Clipper()
    ;(clipper as any).AddPath(flattenOpenFeatureToClipperPath(target), ClipperLib.PolyType.ptSubject, false)
    ;(clipper as any).AddPath(flattenFeatureToClipperPath(cutter), ClipperLib.PolyType.ptClip, true)
    const polyTree = new ClipperLib.PolyTree()
    clipper.Execute(
      ClipperLib.ClipType.ctIntersection,
      polyTree,
      ClipperLib.PolyFillType.pftNonZero,
      ClipperLib.PolyFillType.pftNonZero,
    )
    const openPaths = (ClipperLib.Clipper as any).OpenPathsFromPolyTree(polyTree)
    return openPaths && openPaths.length > 0
  }

  return false
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

export function largestConnectedOverlapGroup(features: SketchFeature[]): SketchFeature[] {
  if (features.length <= 1) {
    return features
  }

  let bestGroup: number[] = []
  const assigned = new Set<number>()

  for (let start = 0; start < features.length; start += 1) {
    if (assigned.has(start)) {
      continue
    }
    const visited = new Set<number>([start])
    const stack = [start]

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

    for (const index of visited) {
      assigned.add(index)
    }
    if (visited.size > bestGroup.length) {
      bestGroup = [...visited]
    }
  }

  return bestGroup.map((index) => features[index])
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
