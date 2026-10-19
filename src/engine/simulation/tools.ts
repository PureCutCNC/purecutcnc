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

import type { ToolType } from '../../types/project'

/**
 * The radial span a cutter removes on one wrapped ray (issue #1016 C2-F8).
 *
 * `lo` is the radius the material is lowered to where the cutter reaches the
 * outside of the column; `hi` is where the cutter's solid ends. A heightfield
 * cell keeps one radius, so `hi` only matters as the "did the cutter reach the
 * outside" test — a cutter that passes through the middle of the ray
 * (`top > hi`) leaves the outer shell in place.
 */
export interface CutterRayInterval {
  lo: number
  hi: number
}

/** A ray this close to the cutter axis is treated as exactly on it. */
const ON_AXIS_EPSILON = 1e-12

/**
 * Scratch interval the wrapped kernel reuses per cell. That kernel is the
 * simulator's hottest loop and reads the result immediately, so it does not
 * allocate one object per cell. Never keep this reference: the next call
 * overwrites it.
 */
const scratchInterval: CutterRayInterval = { lo: 0, hi: 0 }

/**
 * The exact vertical span a cutter removes along one wrapped ray (issue #1016
 * C2-F8). This is the wrapped counterpart of {@link cutterSurfaceZ}: instead of
 * pretending the bar is flat, it places the ray physically.
 *
 * The cutter's axis is the radial line through its tip (`toolCenterZ` from the
 * turning pivot). A cell at `angle` radians from that line, at radius `r`, sits
 * `r·sin(angle)` across the cutter and `r·cos(angle)` along it, and
 * `alongOffset` from the cutter's axial plane. The solid is therefore
 * `across² + alongOffset² <= radius²` for the flat/shank cylinder, a sphere for
 * a ball's nose (plus the shank above its centre), and a cone for a V-bit (plus
 * its shank); solving each for `r` is closed form — no sampling, no iteration.
 *
 * Returns the shared `scratchInterval` — copy it if you need to keep it — or
 * `null` when the ray misses the cutter. Flat (non-wrapped) grids never call
 * this: `cutterSurfaceZ` is exact there.
 */
function solveRayInterval(
  toolType: ToolType,
  toolRadius: number,
  toolCenterZ: number,
  vBitAngle: number | null,
  alongOffset: number,
  angle: number,
): CutterRayInterval | null {
  const radius = toolRadius
  const along = alongOffset
  // Every cutter body lies on the outward side of its bottom face: a ray whose
  // radial coordinate never increases (|angle| >= 90°) cannot reach it. That
  // also keeps cos positive, so one sin and one exact sqrt replace a second
  // trigonometric call in the hottest loop.
  if (angle >= Math.PI / 2 || angle <= -Math.PI / 2) return null
  const sin = Math.sin(angle)
  const absoluteSin = Math.abs(sin)
  const cos = Math.sqrt(1 - sin * sin)
  // The cutter's axial half-width at this ray. A ray further from the cutter's
  // axial plane than its radius misses every profile.
  const acrossSideSq = radius * radius - along * along
  if (acrossSideSq < 0) return null
  const acrossSide = Math.sqrt(acrossSideSq)

  if (toolType === 'flat_endmill' || toolType === 'drill') {
    // A flat cylinder with its bottom face at the tip plane `x = tip`.
    const lo = toolCenterZ / cos
    const hi = absoluteSin <= ON_AXIS_EPSILON ? Infinity : acrossSide / absoluteSin
    if (lo > hi) return null
    scratchInterval.lo = lo
    scratchInterval.hi = hi
    return scratchInterval
  }

  if (toolType === 'ball_endmill') {
    // The nose is a sphere whose centre sits one radius out from the tip; the
    // shank is the cylinder above that centre. The shank contains the sphere's
    // half beyond the centre, so the two spans always meet on the ray.
    const centre = toolCenterZ + radius
    const sphereDisc = acrossSideSq - centre * centre * sin * sin
    let lo = Infinity
    let hi = -Infinity
    if (sphereDisc >= 0) {
      const root = Math.sqrt(sphereDisc)
      const sphereHi = centre * cos + root
      if (sphereHi >= 0) {
        lo = Math.max(0, centre * cos - root)
        hi = sphereHi
      }
    }
    const shankLo = centre / cos
    const shankHi = absoluteSin <= ON_AXIS_EPSILON ? Infinity : acrossSide / absoluteSin
    if (shankLo <= shankHi) {
      if (lo > hi) {
        lo = shankLo
        hi = shankHi
      } else if (shankLo <= hi) {
        lo = Math.min(lo, shankLo)
        hi = Math.max(hi, shankHi)
      } else if (shankHi > hi) {
        // Numerically disjoint (mathematically the shank starts inside the
        // sphere): the outer span is the one a surface cell can meet.
        lo = shankLo
        hi = shankHi
      }
    }
    if (!(hi >= 0)) return null
    scratchInterval.lo = lo
    scratchInterval.hi = hi
    return scratchInterval
  }

  // v_bit: a cone from the tip, truncated where its radius reaches the cutter
  // radius, then the shank cylinder of that same radius above it. The two spans
  // meet on the truncation disk, so a ray either crosses both or neither — but
  // a tip below the bar's centre can put the truncation below the pivot, and
  // then only the shank is in reach.
  const includedAngle = Math.max(1, Math.min(179, vBitAngle ?? 60))
  const coneHalf = Math.tan((includedAngle * Math.PI) / 360)
  if (coneHalf <= 1e-9) return null
  const slopeCos = coneHalf * cos
  const truncation = (toolCenterZ + radius / coneHalf) / cos
  let lo = Infinity
  let hi = -Infinity
  const coneSq = sin * sin - slopeCos * slopeCos
  if (coneSq < 0 && truncation > 0) {
    const absConeSq = -coneSq
    const coneZ = coneHalf * coneHalf * cos * toolCenterZ
    const disc = absConeSq * along * along + sin * sin * coneHalf * coneHalf * toolCenterZ * toolCenterZ
    const coneLo = (coneZ + Math.sqrt(disc)) / absConeSq
    if (coneLo <= truncation) {
      lo = Math.max(0, coneLo)
      hi = truncation
    }
  }
  // The shank runs from the truncation outward (or from the pivot when the
  // truncation is below it).
  const shankLo = Math.max(0, truncation)
  const shankHi = absoluteSin <= ON_AXIS_EPSILON ? Infinity : acrossSide / absoluteSin
  if (shankLo <= shankHi) {
    if (lo > hi) {
      lo = shankLo
      hi = shankHi
    } else if (shankLo <= hi) {
      lo = Math.min(lo, shankLo)
      hi = Math.max(hi, shankHi)
    } else if (shankHi > hi) {
      lo = shankLo
      hi = shankHi
    }
  }
  if (!(hi >= 0)) return null
  scratchInterval.lo = lo
  scratchInterval.hi = hi
  return scratchInterval
}

/** {@link solveRayInterval} for the kernel's hot loop: reads the shared scratch. */
export function cutterRayIntervalInPlace(
  toolType: ToolType,
  toolRadius: number,
  toolCenterZ: number,
  vBitAngle: number | null,
  alongOffset: number,
  angle: number,
): CutterRayInterval | null {
  return solveRayInterval(toolType, toolRadius, toolCenterZ, vBitAngle, alongOffset, angle)
}

/** A pure {@link solveRayInterval}: the interval is a fresh object. */
export function cutterRayInterval(
  toolType: ToolType,
  toolRadius: number,
  toolCenterZ: number,
  vBitAngle: number | null,
  alongOffset: number,
  angle: number,
): CutterRayInterval | null {
  const interval = solveRayInterval(toolType, toolRadius, toolCenterZ, vBitAngle, alongOffset, angle)
  return interval === null ? null : { lo: interval.lo, hi: interval.hi }
}

export function cutterSurfaceZ(
  toolType: ToolType,
  toolRadius: number,
  toolCenterZ: number,
  radialDistance: number,
  vBitAngle: number | null = null,
): number | null {
  if (radialDistance > toolRadius + 1e-9) {
    return null
  }

  switch (toolType) {
    case 'plasma':
      // Not a milling cutter surface. The replay kernel does not ask for one:
      // `applyMoveToGrid` inlines a flat, full-depth one-kerf cut for a torch
      // (issue #961), so this milling-profile reader stays milling-only.
      return null
    case 'flat_endmill':
      return toolCenterZ
    case 'ball_endmill': {
      const clampedDistance = Math.max(0, Math.min(toolRadius, radialDistance))
      const dz = toolRadius - Math.sqrt(Math.max(0, toolRadius * toolRadius - clampedDistance * clampedDistance))
      return toolCenterZ + dz
    }
    case 'v_bit': {
      const includedAngle = Math.max(1, Math.min(179, vBitAngle ?? 60))
      const halfAngleRadians = (includedAngle * Math.PI) / 360
      const slope = Math.tan(halfAngleRadians)
      if (slope <= 1e-9) {
        return toolCenterZ
      }
      return toolCenterZ + radialDistance / slope
    }
    case 'drill':
      return toolCenterZ
  }
}
