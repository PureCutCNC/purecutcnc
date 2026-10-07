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

// Conservative XY attribution for the stock-Z reach display. Generated moves
// are straight segments (including flattened helical/curved motion); clipping
// the whole segment avoids crediting its deepest endpoint outside the target.
import ClipperLib from 'clipper-lib'
import type { Point, SketchFeature } from '../types/project'
import { getFeatureGeometryProfiles } from '../text'
import { addOpenSubject, openPathsFromPolyTree } from './clipperOpenPaths'
import { flattenProfileWithin } from './nesting/flatten'
import { DEFAULT_CLIPPER_SCALE, toClipperPath } from './toolpaths/geometry'
import { pointInClipperPaths } from './toolpaths/modelProtection'
import type { ClipperPath, ToolpathMove } from './toolpaths/types'

const CURVE_ERROR = 1 / DEFAULT_CLIPPER_SCALE
// Reserve both curve-flattening and integer rounding error. Round offset joins
// stay inside the circular cutter footprint; miter joins would over-credit the
// corners, recreating the nearby-target false positive on polygonal features.
const ERROR_RESERVE = CURVE_ERROR + 2 / DEFAULT_CLIPPER_SCALE

export function featureReachFootprint(feature: SketchFeature, cutterRadius: number): ClipperPath[] {
  const profiles = getFeatureGeometryProfiles(feature)
  const contours = feature.kind === 'stl' && feature.stl?.silhouettePaths?.length
    ? feature.stl.silhouettePaths
    : profiles.filter((profile) => profile.closed)
      .map((profile) => flattenProfileWithin(profile, CURVE_ERROR))
  const clipper = new ClipperLib.Clipper()
  clipper.AddPaths(contours.map((points) => toClipperPath(points, DEFAULT_CLIPPER_SCALE)), ClipperLib.PolyType.ptSubject, true)
  const filled = new ClipperLib.Paths()
  // Keep contour holes empty and normalize the winding for ClipperOffset.
  clipper.Execute(ClipperLib.ClipType.ctUnion, filled, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd)
  const offset = new ClipperLib.ClipperOffset()
  offset.ArcTolerance = 1
  offset.AddPaths(filled, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
  const footprint = new ClipperLib.Paths()
  offset.Execute(footprint, Math.floor((cutterRadius - ERROR_RESERVE) * DEFAULT_CLIPPER_SCALE))
  // Open engraving/edge targets have no filled interior: credit only their
  // actual cutter-width stroke, including circular end caps.
  if (cutterRadius > ERROR_RESERVE && feature.kind !== 'stl') {
    for (const profile of profiles.filter((entry) => !entry.closed)) {
      const stroke = new ClipperLib.ClipperOffset()
      stroke.ArcTolerance = 1
      stroke.AddPaths([toClipperPath(flattenProfileWithin(profile, CURVE_ERROR), DEFAULT_CLIPPER_SCALE)], ClipperLib.JoinType.jtRound, (ClipperLib.EndType as unknown as { etOpenRound: number }).etOpenRound)
      const result = new ClipperLib.Paths()
      stroke.Execute(result, Math.floor((cutterRadius - ERROR_RESERVE) * DEFAULT_CLIPPER_SCALE))
      for (const path of result) footprint.push(path)
    }
  }
  return footprint as ClipperPath[]
}

/** Z endpoints of the portions that intersect the target's cutter footprint. */
export function cutMoveZAtFeature(footprint: ClipperPath[], move: ToolpathMove): number[] {
  if (move.kind === 'rapid' || footprint.length === 0) return []
  const dx = move.to.x - move.from.x, dy = move.to.y - move.from.y
  const lengthSquared = dx * dx + dy * dy
  // A plunge (or zero-length cut) has no XY line for Clipper to intersect.
  if (lengthSquared === 0) return pointInClipperPaths(footprint, move.from) ? [move.from.z, move.to.z] : []
  const clipper = new ClipperLib.Clipper()
  addOpenSubject(clipper, toClipperPath([move.from, move.to], DEFAULT_CLIPPER_SCALE))
  clipper.AddPaths(footprint, ClipperLib.PolyType.ptClip, true)
  const intersection = new ClipperLib.PolyTree()
  clipper.Execute(ClipperLib.ClipType.ctIntersection, intersection, ClipperLib.PolyFillType.pftEvenOdd, ClipperLib.PolyFillType.pftEvenOdd)
  const zAt = (point: Point): number => {
    const t = Math.max(0, Math.min(1, ((point.x - move.from.x) * dx + (point.y - move.from.y) * dy) / lengthSquared))
    return move.from.z + t * (move.to.z - move.from.z)
  }
  return openPathsFromPolyTree(intersection).flatMap((path) => path.map((point) => zAt({ x: point.X / DEFAULT_CLIPPER_SCALE, y: point.Y / DEFAULT_CLIPPER_SCALE })))
}
