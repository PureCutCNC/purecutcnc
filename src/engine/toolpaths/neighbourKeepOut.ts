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
 * Follow line on the Around face: keep the cutter body out of a neighbouring
 * section of the part that stands above the surface the guide is cut on
 * (issue #1112 slice rt6-e).
 *
 * Frank's bolt: the Thread starts where the Hex ends, both on/next to the same
 * Ø0.75, and the V-bit's flank reaches into the Hex's end face at the start of
 * the thread. The guide loop put the tool centre on the guide from end to end;
 * nothing kept the cutter body off a neighbouring section. The decision is
 * **trim and warn** — a safety rule, not an option.
 *
 * The rule, per guide feature:
 *
 * 1. Each material band the caller supplies (from `aroundMaterialBands`) whose
 *    surface counts as a wall for its kind — see `AroundMaterialKind` — is a
 *    keep-out interval along the bar.
 * 2. That interval is grown by the cutter's real half-width at the height of
 *    the neighbour's surface: `(height above the tip) · tan(angle / 2)` for a
 *    V-bit capped at the tool radius, the radius for a flat or ball cutter,
 *    and at least half the trochoidal cut width. The deepest cut level gives
 *    the widest body, so the trim is computed at the operation's deepest tip.
 * 3. The grown interval becomes a full-width rectangle on the unrolled sheet
 *    and is subtracted from the guide with the **same splitter the clamps use**
 *    (`splitGuideFragmentsOutside`), so fragment order, link moves and lead-ins
 *    behave exactly as they do around a clamp. A guide the keep-out shortens is
 *    reported once per feature and neighbour; a guide it removes entirely is
 *    reported as cutting nothing and why.
 *
 * A guide with clear space on both sides comes back byte-identical: the bands
 * are only applied when they actually shorten a fragment.
 */

import { rectProfile } from '../../types/project'
import { formatLength, type Units } from '../../utils/units'
import type { AroundMaterialBand } from '../aroundFrame'
import { DEFAULT_CLIPPER_SCALE, flattenProfile, normalizeWinding, toClipperPath } from './geometry'
import type { ClosedGuideFragment } from './guideFragments'
import type { NormalizedTool } from './types'
import { guideFragmentsBlockedBy, splitGuideFragmentsOutside } from './regionDomain'
import type { ClipperPath } from './types'
import type { ToolpathWarning } from './warningCodes'

/**
 * Slack on the surface comparison, in project units. A canned model's stored Z
 * top comes out of its mesh bounds, which are Float32: a Turn's reads 9.8e-6
 * below the value its Thread was synced to on an inch bar. Without the slack
 * that noise alone would decide whether the Turn a Thread rides on counts as a
 * wall.
 */
const SURFACE_TOLERANCE = 1e-4

/** Slack on the along extent before and after a split, in project units. */
const ALONG_TOLERANCE = 1e-7

/** Padding past the guide's across extent, so a keep-out covers every point. */
const ACROSS_PADDING = 1

/**
 * The keep-out is grown by this much beyond the cutter's computed half-width so
 * the Clipper integer grid can never round it *inward*: a keep-out one count
 * short is a cutter body inside the material it was meant to stay out of, and
 * the reported distance is still the computed half-width.
 */
const KEEPOUT_EPSILON = 2 / DEFAULT_CLIPPER_SCALE

export interface NeighbourTrimInput {
  fragments: ClosedGuideFragment[]
  /** The stock's axis: `along` is this coordinate of the sheet. */
  axis: 'x' | 'y'
  bands: readonly AroundMaterialBand[]
  /** The surface the guide is cut on, in the unrolled sheet frame. */
  guideSurfaceZ: number
  /** The operation's deepest tip level, in the unrolled sheet frame. */
  tipZ: number
  tool: NormalizedTool
  /** Half the trochoidal cut width; `0` in direct mode. */
  trochoidalHalfWidth: number
  /** The guide feature's name, for the warning. */
  guideName: string
  units: Units
}

export interface NeighbourTrimResult {
  fragments: ClosedGuideFragment[]
  warnings: ToolpathWarning[]
}

interface Obstacle {
  band: AroundMaterialBand
  halfWidth: number
}

/**
 * Trim one guide's fragments out of every neighbouring section the cutter body
 * would enter, and say what was kept clear. Returns the input fragments by
 * reference (and no warnings) when nothing is close enough to matter.
 */
export function trimGuideForNeighbourMaterial(input: NeighbourTrimInput): NeighbourTrimResult {
  const unchanged: NeighbourTrimResult = { fragments: input.fragments, warnings: [] }
  if (input.fragments.length === 0 || input.bands.length === 0) return unchanged

  // The guide's extent decides which body supports it. Taken before this
  // keep-out shortens it: a fragment an earlier trim left inside a body is not
  // thereby a guide the user drew on that body.
  const drawn = guideExtent(input.fragments, input.axis)
  if (!drawn) return unchanged

  const obstacles = input.bands
    .filter((band) => isWall(band, input.guideSurfaceZ, drawn))
    .map((band) => ({ band, halfWidth: cutterHalfWidthAt(band.surfaceZ - input.tipZ, input) }))
    // Widest first: overlapping keeps-out then resolve to the one that keeps
    // the cutter furthest away, and the narrower ones report nothing.
    .sort((left, right) => right.halfWidth - left.halfWidth
      || left.band.alongMin - right.band.alongMin
      || left.band.name.localeCompare(right.band.name))
    .filter((obstacle) => obstacle.halfWidth > 0)
  if (obstacles.length === 0) return unchanged

  let fragments = input.fragments
  const warnings: ToolpathWarning[] = []

  for (const obstacle of obstacles) {
    const extent = guideExtent(fragments, input.axis)
    if (!extent) break
    const keepOut = keepOutPath(obstacle, extent)
    if (!guideFragmentsBlockedBy(fragments, [keepOut])) continue

    const before = fragments
    fragments = splitGuideFragmentsOutside(fragments, [keepOut])

    if (fragments.length === 0) {
      warnings.push(removedWarning(input, obstacle.band))
      return { fragments, warnings }
    }

    const after = guideExtent(fragments, input.axis)
    if (!after) {
      warnings.push(removedWarning(input, obstacle.band))
      return { fragments, warnings }
    }

    const trimmedStart = after.min > extent.min + ALONG_TOLERANCE
    const trimmedEnd = after.max < extent.max - ALONG_TOLERANCE
    if (!trimmedStart && !trimmedEnd) {
      // The guide was broken in the middle: say how much of it was left uncut.
      warnings.push({
        code: 'carveNeighbourTrimmedSpan',
        params: {
          name: input.guideName,
          ...neighbourParam(obstacle.band),
          distance: formatLength(guideLength(before) - guideLength(fragments), input.units),
          units: input.units,
        },
      })
      continue
    }
    warnings.push({
      code: 'carveNeighbourTrimmed',
      params: {
        name: input.guideName,
        ...neighbourParam(obstacle.band),
        distance: formatLength(obstacle.halfWidth, input.units),
        units: input.units,
        sideId: trimmedStart ? 'start' : 'end',
      },
    })
  }

  return { fragments, warnings }
}

/**
 * Whether one band is a wall for a guide on `guideSurfaceZ`. `turn` and `bar`
 * are surfaces a follow line is cut *on*, so they count only where they stand
 * above the guide; a `body` counts at or above, because its end face is a wall
 * even where its top is level with the guide's surface (see
 * `AroundMaterialKind`).
 *
 * The exception is the body that **supports** the guide (issue #1112 rt6-e
 * correction 1): a line drawn wholly inside a Hex's own band and level with
 * its top is cut on that Hex, not beside it, so the Hex is its surface and not
 * a neighbour. Its end faces are then not walls either — a body whose own top
 * is being cut has no exposed face inside the band. A guide that crosses the
 * body or stops beside it is still kept clear of it: Frank's bolt, where the
 * Thread starts exactly at the Hex's end, is that case.
 */
function isWall(band: AroundMaterialBand, guideSurfaceZ: number, guide: GuideExtent): boolean {
  if (band.kind !== 'body') return band.surfaceZ > guideSurfaceZ + SURFACE_TOLERANCE
  if (band.surfaceZ < guideSurfaceZ - SURFACE_TOLERANCE) return false
  const levelWithGuide = band.surfaceZ <= guideSurfaceZ + SURFACE_TOLERANCE
  const supports = levelWithGuide
    && band.alongMin <= guide.min + ALONG_TOLERANCE
    && band.alongMax >= guide.max - ALONG_TOLERANCE
  return !supports
}

/**
 * The cutter body's half-width at a given height above its tip: the V-bit's
 * cone capped at its radius, a flat or ball cutter's radius, and never less
 * than the trochoidal orbit's half cut width.
 */
function cutterHalfWidthAt(heightAboveTip: number, input: NeighbourTrimInput): number {
  const { tool } = input
  let halfWidth = tool.radius
  if (tool.type === 'v_bit') {
    const angle = tool.vBitAngle && tool.vBitAngle > 0 && tool.vBitAngle < 180 ? tool.vBitAngle : 60
    halfWidth = Math.min(tool.radius, Math.max(0, heightAboveTip) * Math.tan((angle * Math.PI) / 360))
  }
  return Math.max(halfWidth, input.trochoidalHalfWidth)
}

/** The keep-out rectangle on the sheet: the grown along band, full width. */
function keepOutPath(obstacle: Obstacle, extent: GuideExtent): ClipperPath {
  const reach = obstacle.halfWidth + KEEPOUT_EPSILON
  const alongMin = obstacle.band.alongMin - reach
  const alongMax = obstacle.band.alongMax + reach
  const pad = reach + ACROSS_PADDING
  const acrossMin = extent.acrossMin - pad
  const acrossMax = extent.acrossMax + pad
  const minX = extent.axis === 'x' ? alongMin : acrossMin
  const maxX = extent.axis === 'x' ? alongMax : acrossMax
  const minY = extent.axis === 'x' ? acrossMin : alongMin
  const maxY = extent.axis === 'x' ? acrossMax : alongMax
  const points = flattenProfile(rectProfile(minX, minY, maxX - minX, maxY - minY)).points
  return toClipperPath(normalizeWinding(points, false), DEFAULT_CLIPPER_SCALE)
}

interface GuideExtent {
  axis: 'x' | 'y'
  min: number
  max: number
  acrossMin: number
  acrossMax: number
}

/** The guide's along and across extents over every fragment it has left. */
function guideExtent(fragments: readonly ClosedGuideFragment[], axis: 'x' | 'y'): GuideExtent | null {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let acrossMin = Number.POSITIVE_INFINITY
  let acrossMax = Number.NEGATIVE_INFINITY
  for (const fragment of fragments) {
    for (const point of fragment.points) {
      const along = axis === 'x' ? point.x : point.y
      const across = axis === 'x' ? point.y : point.x
      min = Math.min(min, along)
      max = Math.max(max, along)
      acrossMin = Math.min(acrossMin, across)
      acrossMax = Math.max(acrossMax, across)
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return null
  return { axis, min, max, acrossMin, acrossMax }
}

/** Total drawn length of a fragment set, including a closed fragment's seam. */
function guideLength(fragments: readonly ClosedGuideFragment[]): number {
  let total = 0
  for (const fragment of fragments) {
    const { points } = fragment
    for (let index = 1; index < points.length; index += 1) {
      total += Math.hypot(points[index].x - points[index - 1].x, points[index].y - points[index - 1].y)
    }
    if (fragment.closed && points.length > 2) {
      const first = points[0]
      const last = points[points.length - 1]
      total += Math.hypot(first.x - last.x, first.y - last.y)
    }
  }
  return total
}

/** The neighbour's name, or the marker the presentation layer translates. */
function neighbourParam(band: AroundMaterialBand): { neighbour?: string; neighbourId?: 'bar' } {
  if (band.kind === 'bar') return { neighbourId: 'bar' }
  return { neighbour: band.name }
}

function removedWarning(input: NeighbourTrimInput, band: AroundMaterialBand): ToolpathWarning {
  return {
    code: 'carveNeighbourTrimmedAway',
    params: { name: input.guideName, ...neighbourParam(band) },
  }
}
