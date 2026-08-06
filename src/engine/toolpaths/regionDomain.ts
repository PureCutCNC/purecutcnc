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

import type { Point } from '../../types/project'
import { DEFAULT_CLIPPER_SCALE, samePointXY } from './geometry'
import {
  distinctSorted,
  normalizeClipperPath,
  pointAt,
  pointInForbiddenPaths,
  segmentIntersectionParameters,
  splitClosedGuideByForbiddenPaths,
  type ClosedGuideFragment,
} from './guideFragments'
import { differenceClipperPaths, intersectClipperPaths, offsetClipperPaths, unionClipperPaths } from './modelProtection'
import type { RegionMask } from './regions'
import type { ClipperPath } from './types'

/**
 * Resolve a region mask into an area domain (polygon set) so the generator
 * receives already-valid geometry.  `centreInset` is `tool.radius +
 * stockToLeaveRadial`, computed once per operation.
 *
 * **Precondition:** the generator will subsequently erode the entire domain by
 * `centreInset`.  For an **include** region the resolver pre-dilates by
 * `centreInset` to cancel that erosion.  For an **exclude** region the raw
 * paths are subtracted — the erosion supplies the required clearance.
 *
 * Callers that have already applied the tool radius (so the domain *is* the
 * tool-centre path and no further `centreInset` erosion remains) must use
 * {@link resolveRegionDomainCentre} instead.
 *
 * Ordered composition matches `buildRegionMask`: the first entry sets the
 * starting state (empty for include, full domain for exclude); later includes
 * add, later excludes remove.  The result is always constrained to the original
 * `domain`.
 */
export function resolveRegionDomainArea(
  domain: ClipperPath[],
  mask: RegionMask | null,
  centreInset: number,
): ClipperPath[] {
  if (mask === null) return domain
  if (domain.length === 0) return []

  const entries = mask.entries
  if (entries.length === 0) return domain

  const firstMode = entries[0].mode
  let accumulator: ClipperPath[] = firstMode === 'include' ? [] : domain

  for (const entry of entries) {
    if (entry.paths.length === 0) continue
    if (entry.mode === 'include') {
      const dilated = centreInset > 0 ? offsetClipperPaths(entry.paths, centreInset) : entry.paths
      accumulator = unionClipperPaths([...accumulator, ...dilated])
    } else {
      accumulator = differenceClipperPaths(accumulator, entry.paths)
    }
  }

  // Always constrain to the original domain so coverage over-reach cannot
  // introduce cuts the unmasked operation would never have made.
  return intersectClipperPaths(accumulator, domain)
}

/**
 * Resolve a region mask into a domain that is already a tool-centre path, so
 * no further erosion by `centreInset` will happen and the resolver must provide
 * the required clearance itself.
 *
 * Both polarities dilate the region by `centreInset`:
 *
 * - **include** `R`: intersect with `R ⊕ centreInset` — the centre may reach
 *   `centreInset` beyond the region so the cut covers it (coverage).
 * - **exclude** `X`: subtract `X ⊕ centreInset` — the centre stays
 *   `centreInset` clear so the tool body never enters (containment).
 *
 * Ordered composition matches `buildRegionMask`: the first entry sets the
 * starting state (empty for include, full domain for exclude); later includes
 * add, later excludes remove.  The result is always constrained to the original
 * `domain`, so `masked ⊆ unmasked` still holds.
 *
 * Null mask returns `domain` by reference.
 */
export function resolveRegionDomainCentre(
  domain: ClipperPath[],
  mask: RegionMask | null,
  centreInset: number,
): ClipperPath[] {
  if (mask === null) return domain
  if (domain.length === 0) return []

  const entries = mask.entries
  if (entries.length === 0) return domain

  const firstMode = entries[0].mode
  let accumulator: ClipperPath[] = firstMode === 'include' ? [] : domain

  for (const entry of entries) {
    if (entry.paths.length === 0) continue
    const dilated = centreInset > 0 ? offsetClipperPaths(entry.paths, centreInset) : entry.paths
    if (entry.mode === 'include') {
      accumulator = unionClipperPaths([...accumulator, ...dilated])
    } else {
      accumulator = differenceClipperPaths(accumulator, dilated)
    }
  }

  // Always constrain to the original domain so coverage over-reach cannot
  // introduce cuts the unmasked operation would never have made.
  return intersectClipperPaths(accumulator, domain)
}

/**
 * Compute a bounding-axis-aligned Clipper rectangle that comfortably encloses
 * both the world-space guide and every entry's (already Clipper-space) paths.
 * The caller uses this as the initial "everything" domain when the first mask
 * entry is `exclude`.
 */
function buildClipperBoundingBox(guide: Point[], entries: Array<{ paths: ClipperPath[] }>): ClipperPath {
  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  for (const point of guide) {
    if (point.x < minX) minX = point.x
    if (point.y < minY) minY = point.y
    if (point.x > maxX) maxX = point.x
    if (point.y > maxY) maxY = point.y
  }

  for (const entry of entries) {
    for (const path of entry.paths) {
      for (const pt of path) {
        const wx = pt.X / DEFAULT_CLIPPER_SCALE
        const wy = pt.Y / DEFAULT_CLIPPER_SCALE
        if (wx < minX) minX = wx
        if (wy < minY) minY = wy
        if (wx > maxX) maxX = wx
        if (wy > maxY) maxY = wy
      }
    }
  }

  const margin = Math.max((maxX - minX) * 0.25, (maxY - minY) * 0.25, 10)
  const scale = DEFAULT_CLIPPER_SCALE
  return [
    { X: Math.round((minX - margin) * scale), Y: Math.round((minY - margin) * scale) },
    { X: Math.round((maxX + margin) * scale), Y: Math.round((minY - margin) * scale) },
    { X: Math.round((maxX + margin) * scale), Y: Math.round((maxY + margin) * scale) },
    { X: Math.round((minX - margin) * scale), Y: Math.round((maxY + margin) * scale) },
  ]
}

/**
 * Resolve a region mask into curve-guide fragments.  A curve generator's guide
 * *is* the tool-centre path — no further erosion happens — so both polarities
 * offset the region and only the keep-side differs:
 *
 * - **include** `R`: keep the guide **inside** `R ⊕ includeOffset`.  The include
 *   offset is usually an **erosion** (negative) because the region bounds where
 *   the tool centre may go, and a generator whose guide is offset from the tool
 *   centre (e.g. a trochoidal orbit) must inset the region by that offset so
 *   tool-centre containment stays identical to every other operation.
 * - **exclude** `X`: keep the guide **outside** `X ⊕ excludeOffset`.  The exclude
 *   offset is a **dilation** (positive) because the region must clear the tool
 *   body.
 *
 * `excludeOffset` defaults to `includeOffset` so existing callers that pass a
 * single offset get the same behaviour as before.
 *
 * Ordered composition matches `buildRegionMask`.  The composite allowed area is
 * built with Clipper boolean ops and then a single call to
 * `splitClosedGuideByForbiddenPaths` produces the final fragments.
 */
export function resolveRegionDomainCurve(
  guide: Point[],
  closed: boolean,
  mask: RegionMask | null,
  includeOffset: number,
  excludeOffset?: number,
): ClosedGuideFragment[] {
  if (mask === null) return [{ points: guide, closed }]
  if (guide.length < 2) return []

  const entries = mask.entries
  if (entries.length === 0) return [{ points: guide, closed }]

  const effectiveExclude = excludeOffset ?? includeOffset

  const firstMode = entries[0].mode

  // Build the composite allowed area.  When the first entry is exclude we seed
  // with a bounding box that covers the guide and every region so Clipper has a
  // finite subject to difference from.
  let allowed: ClipperPath[] = firstMode === 'include' ? [] : [buildClipperBoundingBox(guide, entries)]

  for (const entry of entries) {
    if (entry.paths.length === 0) continue
    const offset = entry.mode === 'include' ? includeOffset : effectiveExclude
    const offsetPaths = offset !== 0 ? offsetClipperPaths(entry.paths, offset) : entry.paths
    if (entry.mode === 'include') {
      allowed = unionClipperPaths([...allowed, ...offsetPaths])
    } else {
      allowed = differenceClipperPaths(allowed, offsetPaths)
    }
  }

  if (allowed.length === 0) return []

  // `splitClosedGuideByForbiddenPaths` with keep:'inside' treats the forbidden
  // paths AS the allowed area — everything outside is discarded.
  if (closed) {
    return splitClosedGuideByForbiddenPaths(guide, allowed, 'inside')
  }

  // Open guide: the closed-guide splitter wraps around, which would create
  // spurious fragments across the open ends.  Split each segment individually
  // against the composite and collect the inside spans.
  return splitOpenGuideByAllowedPaths(guide, allowed)
}

/**
 * Split an open polyline, keeping only the spans that lie inside `allowed`.
 * Every returned fragment is open (`closed: false`).
 */
function splitOpenGuideByAllowedPaths(guide: Point[], allowed: ClipperPath[]): ClosedGuideFragment[] {
  // Convert allowed ClipperPaths to world-space point arrays for the
  // even-odd containment test, matching splitClosedGuideByForbiddenPaths.
  const allowedWorld = allowed
    .map((path) => normalizeClipperPath(path, DEFAULT_CLIPPER_SCALE))
    .filter((path) => path.length >= 3)

  if (allowedWorld.length === 0) return []

  const fragments: ClosedGuideFragment[] = []
  let current: Point[] | null = null

  const finishCurrent = () => {
    if (current !== null && current.length >= 2) {
      fragments.push({ points: current, closed: false })
    }
    current = null
  }

  for (let i = 0; i < guide.length - 1; i += 1) {
    const from = guide[i]
    const to = guide[i + 1]
    const params = [0, 1]

    for (const path of allowedWorld) {
      for (let j = 0; j < path.length; j += 1) {
        const edgeFrom = path[j]
        const edgeTo = path[(j + 1) % path.length]
        params.push(...segmentIntersectionParameters(from, to, edgeFrom, edgeTo))
      }
    }

    const breakpoints = distinctSorted(params)
    for (let k = 0; k < breakpoints.length - 1; k += 1) {
      const t0 = breakpoints[k]
      const t1 = breakpoints[k + 1]
      if (t1 - t0 <= 1e-9) continue

      const mid = pointAt(from, to, (t0 + t1) / 2)
      if (!pointInForbiddenPaths(mid, allowedWorld)) {
        finishCurrent()
        continue
      }

      const startPt = pointAt(from, to, t0)
      const endPt = pointAt(from, to, t1)
      if (current === null) {
        current = [startPt, endPt]
      } else if (samePointXY(current.at(-1)!, startPt)) {
        current.push(endPt)
      } else {
        finishCurrent()
        current = [startPt, endPt]
      }
    }
  }
  finishCurrent()
  return fragments
}
