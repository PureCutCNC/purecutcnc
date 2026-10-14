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

/**
 * An Around feature as a solid on the bar (issue #395 slice G1).
 *
 * An Around feature stores sheet coordinates: along the bar on its axis, across
 * the unrolled surface on the other. Its profile is swept across the bar's
 * depth and then wound onto the bar with the frozen wrap (see `aroundFrame.ts`):
 * a point at radius `r` and angle `a = 2π·(across − sheetStart)/circumference`
 * lands at `across' = centre + r·sin a`, `z' = R + r·cos a`, along unchanged.
 * `wrapPoint` followed by `stockSpacePoint` gives the same point.
 *
 * The sweep is built flat first, cut into bands of at most a quarter turn so no
 * warped piece can overlap itself, refined until no flat edge is longer than
 * `R · 5°` (sheet distance maps to angle as `distance / R` at every depth, so
 * every warped edge spans at most 5° of turn and no chord cuts through the
 * bar), and warped vertex by vertex.
 *
 * Heights are Top-style: the surface is `z = D`, the centreline `z = R`, so a
 * height maps to the radius `z − R`. The result is a Manifold in project
 * coordinates, the same space `buildFeatureSolid` returns.
 */

import type { Manifold as ManifoldSolid, ManifoldToplevel } from 'manifold-3d'
import { isRoundStock, type Project, type SketchFeature } from '../types/project'
import { aroundFrame, type AroundFrame } from './aroundFrame'
import { DEFAULT_ARC_STEP_RADIANS, profileToPolygon } from './profilePolyline'
import { resolveDimensionRef } from './toolpaths/geometry'

/**
 * The most turn one warped piece may span, and therefore the longest flat edge
 * it may carry: 5° of turn. A flat edge longer than `R · 5°` would chord
 * through the bar once wrapped.
 */
const CHORD_STEP_RADIANS = (5 * Math.PI) / 180

/**
 * `refineToLength` splits edges to *roughly* the target, and the boolean union
 * of neighbouring bands re-triangulates their shared face, so the longest edge
 * left behind runs up to about 1.5× the target. Refining to half the 5° budget
 * keeps every measured mesh edge under it.
 */
const REFINE_SAFETY = 0.5

/**
 * How much neighbouring quarter-turn bands overlap, as a fraction of a quarter
 * turn. It only has to clear Manifold's boolean epsilon; the intersection with
 * the feature's own shape keeps it from widening the solid.
 */
const BAND_OVERLAP_FRACTION = 0.01

/**
 * How far past the surface (as a fraction of the bar radius) a slab whose top
 * reaches the surface is pushed, so a subtract breaks through instead of
 * leaving a skin coplanar with the bar's own facets.
 */
const SURFACE_MARGIN_FRACTION = 0.02

export interface AroundSlabOptions {
  /**
   * The smallest drawable height in the project's units — pass
   * `minRenderHeight(project.meta.units)`. It floors the slab's depth and keeps
   * its bottom off the centreline, where the wrap would fold the slab onto
   * itself.
   */
  readonly minHeight: number
  readonly arcStepRadians?: number
}

/**
 * One expanded Around feature as a solid in project coordinates, or `null` when
 * it has no slab: an imported model, a line or construction operation, an open
 * profile, fewer than three points, or a span entirely inside the centreline.
 * A `region` is accepted too, for its display-only mesh.
 */
export function buildAroundFeatureSolid(
  module: ManifoldToplevel,
  project: Project,
  feature: SketchFeature,
  options: AroundSlabOptions,
): ManifoldSolid | null {
  if (feature.kind === 'stl') return null
  if (feature.operation !== 'add' && feature.operation !== 'subtract' && feature.operation !== 'region') return null
  if (!feature.sketch.profile.closed) return null
  if (!isRoundStock(project.stock)) return null

  const contour = profileToPolygon(feature.sketch.profile, options.arcStepRadians ?? DEFAULT_ARC_STEP_RADIANS)
  if (contour.length < 3) return null

  const frame = aroundFrame(project.stock)
  const zTop = resolveDimensionRef(project, feature.z_top)
  const zBottom = resolveDimensionRef(project, feature.z_bottom)
  const lowerRadius = Math.min(zTop, zBottom) - frame.radius
  // The same floor `buildFeatureSolid` puts on a flat feature's depth.
  const depth = Math.max(Math.abs(zTop - zBottom), options.minHeight)
  const rBottom = Math.max(lowerRadius, options.minHeight)
  const rTopRaw = lowerRadius + depth
  const rTop = rTopRaw >= frame.radius - 1e-9 ? frame.radius * (1 + SURFACE_MARGIN_FRACTION) : rTopRaw
  if (!(rTop > rBottom)) return null

  return sweepOntoBar(module, frame, contour, rBottom, rTop)
}

/** The flat sweep, banded, refined and warped onto the bar; `null` if empty. */
function sweepOntoBar(
  module: ManifoldToplevel,
  frame: AroundFrame,
  contour: [number, number][],
  rBottom: number,
  rTop: number,
): ManifoldSolid | null {
  // The flat mesh keeps the feature's own coordinates: x is along for an X bar
  // and across for a Y bar, and y is the other way round.
  const alongOf = (point: [number, number]): number => point[alongIndex(frame)]
  const acrossOf = (point: [number, number]): number => point[frame.axis === 'x' ? 1 : 0]
  const alongMin = Math.min(...contour.map(alongOf))
  const alongMax = Math.max(...contour.map(alongOf))
  const acrossMin = Math.min(...contour.map(acrossOf))
  const acrossMax = Math.max(...contour.map(acrossOf))
  const quarter = frame.circumference / 4
  const firstBand = Math.floor((acrossMin - frame.sheetStart) / quarter)
  const lastBand = Math.ceil((acrossMax - frame.sheetStart) / quarter) - 1
  const refineLength = frame.radius * CHORD_STEP_RADIANS * REFINE_SAFETY

  const pieces: ManifoldSolid[] = []
  const unions: ManifoldSolid[] = []
  let result: ManifoldSolid | null = null
  try {
    const flat = module.CrossSection.ofPolygons([contour], 'EvenOdd')
    try {
      for (let band = firstBand; band <= lastBand; band += 1) {
        const from = frame.sheetStart + band * quarter
        // Neighbouring bands overlap by a hair so their warped solids share
        // volume rather than meeting on a pair of exactly-coincident faces with
        // different triangulations, which Manifold's union cannot weld into one
        // connected solid. Clipping to the shape keeps the overlap from adding
        // any material.
        const overlap = quarter * BAND_OVERLAP_FRACTION
        // A quarter-turn band across the sheet's across axis.
        const bandRect: [number, number][] = frame.axis === 'x'
          ? [
              [alongMin, from - overlap], [alongMax, from - overlap],
              [alongMax, from + quarter + overlap], [alongMin, from + quarter + overlap],
            ]
          : [
              [from - overlap, alongMin], [from + quarter + overlap, alongMin],
              [from + quarter + overlap, alongMax], [from - overlap, alongMax],
            ]
        const clipped = flat.intersect([bandRect])
        let extruded: ManifoldSolid | null = null
        let refined: ManifoldSolid | null = null
        try {
          extruded = clipped.extrude(rTop - rBottom)
          refined = extruded.refineToLength(refineLength)
          pieces.push(refined.warp((vert) => { warpVertex(vert, frame, rBottom) }))
        } finally {
          refined?.delete()
          extruded?.delete()
          clipped.delete()
        }
      }
    } finally {
      flat.delete()
    }

    if (pieces.length === 0) return null
    let current = pieces[0]
    for (let index = 1; index < pieces.length; index += 1) {
      current = module.Manifold.union(current, pieces[index])
      unions.push(current)
    }
    result = current
    return result
  } finally {
    // `result` is handed to the caller; every other intermediate goes.
    for (const piece of pieces) if (piece !== result) piece.delete()
    for (const union of unions) if (union !== result) union.delete()
  }
}

/** The flat mesh's own axis carrying the bar's length: x for an X bar, y for a Y bar. */
function alongIndex(frame: AroundFrame): 0 | 1 {
  return frame.axis === 'x' ? 0 : 1
}

/**
 * One flat vertex to its stock point: the frozen wrap from the `aroundFrame.ts`
 * header, for the bar's own axis. The flat mesh keeps the feature's own
 * coordinates, so `across` is x for a Y bar and y for an X bar.
 */
function warpVertex(vert: [number, number, number], frame: AroundFrame, rBottom: number): void {
  const acrossIndex = frame.axis === 'x' ? 1 : 0
  const radius = vert[2] + rBottom
  const angle = (vert[acrossIndex] - frame.sheetStart) / frame.radius
  const across = frame.centre + radius * Math.sin(angle)
  const up = frame.radius + radius * Math.cos(angle)
  vert[acrossIndex] = across
  vert[2] = up
}
