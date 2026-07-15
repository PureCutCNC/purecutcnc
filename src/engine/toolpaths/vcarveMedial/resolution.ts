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

import type { Point } from '../../../types/project'

/** Keep similar shapes at a stable boundary-sample density as they scale. */
export const MEDIAL_SAMPLES_ACROSS_SHORT_SPAN = 40
/** Regions above this estimated boundary sample count are coarsened. */
export const MEDIAL_SAMPLE_BUDGET_PER_REGION = 40_000

export interface MedialResolutionRegion {
  outer: readonly Point[]
  islands: readonly (readonly Point[])[]
}

export interface MedialResolution {
  resolution: number
  budgetFloor: number
  budgetLimited: boolean
}

function loopPerimeter(loop: readonly Point[]): number {
  let length = 0
  for (let i = 0; i < loop.length; i += 1) {
    const next = loop[(i + 1) % loop.length]
    length += Math.hypot(next.x - loop[i].x, next.y - loop[i].y)
  }
  return length
}

function shortSpan(loop: readonly Point[]): number | null {
  if (loop.length < 3) return null

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of loop) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
  }

  const width = maxX - minX
  const height = maxY - minY
  return width > 0 && height > 0 ? Math.min(width, height) : null
}

export function resolveMedialResolution(
  region: MedialResolutionRegion,
): MedialResolution | null {
  const span = shortSpan(region.outer)
  if (span === null) return null

  const shapeResolution = span / MEDIAL_SAMPLES_ACROSS_SHORT_SPAN
  const perimeter = loopPerimeter(region.outer)
    + region.islands.reduce((sum, island) => sum + loopPerimeter(island), 0)
  const budgetFloor = perimeter / MEDIAL_SAMPLE_BUDGET_PER_REGION
  const resolution = Math.max(shapeResolution, budgetFloor)

  if (!(resolution > 0) || !Number.isFinite(resolution)) return null
  return {
    resolution,
    budgetFloor,
    budgetLimited: budgetFloor > shapeResolution,
  }
}
