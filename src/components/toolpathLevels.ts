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
 * Display-only Z-level filtering for planar, multi-level toolpaths (issue #752).
 *
 * The test is deliberately strict: every cut must remain on one Z plane. That
 * makes the selector meaningful for stepped 2.5D work, while declining surface
 * and waterline paths whose cut moves follow a changing Z surface.
 */

import type { ToolpathMove } from '../engine/toolpaths/types'
import type { Operation } from '../types/project'

/** Numeric tolerance for generated coordinates that represent one Z level. */
export const TOOLPATH_LEVEL_Z_TOLERANCE = 1e-7

function sameLevel(a: number, b: number): boolean {
  return Math.abs(a - b) <= TOOLPATH_LEVEL_Z_TOLERANCE
}

/** Endpoint form used by the Canvas display cache as well as raw moves. */
export function zMatchesToolpathLevel(fromZ: number, toZ: number, level: number | null): boolean {
  return level === null || (sameLevel(fromZ, level) && sameLevel(toZ, level))
}

/** A move belongs to a selected level only when both endpoints are on it. */
export function moveMatchesToolpathLevel(move: Pick<ToolpathMove, 'from' | 'to'>, level: number | null): boolean {
  return zMatchesToolpathLevel(move.from.z, move.to.z, level)
}

/**
 * High-to-low planar cut levels, or none when the toolpath is not a stepped
 * planar operation. Returning no levels is fail-closed: the preview remains
 * on its complete, unfiltered machining record.
 */
export function toolpathLevels(
  toolpath: Pick<{ moves: readonly ToolpathMove[] }, 'moves'>,
  operation: Pick<Operation, 'kind'> | null = null,
): number[] {
  // Finish operations include waterline and curved CL-surface strategies. They
  // stay disabled even when a particular fixture happens to contain planar
  // segments, because their level semantics are not the 2.5D pass contract.
  if (operation?.kind === 'surface_clean' || operation?.kind === 'rough_surface' || operation?.kind === 'finish_surface' || operation?.kind === 'finish_surface_cleanup') {
    return []
  }
  const levels: number[] = []
  let cutCount = 0

  for (const move of toolpath.moves) {
    if (move.kind !== 'cut') continue
    cutCount += 1
    if (!Number.isFinite(move.from.z) || !Number.isFinite(move.to.z) || !sameLevel(move.from.z, move.to.z)) {
      return []
    }
    if (!levels.some((level) => sameLevel(level, move.from.z))) {
      levels.push(move.from.z)
    }
  }

  return cutCount > 0 && levels.length > 1 ? levels.sort((a, b) => b - a) : []
}

/** Keep the generated toolpath immutable while deriving a view-only subset. */
export function movesAtToolpathLevel(
  moves: readonly ToolpathMove[],
  level: number | null,
): readonly ToolpathMove[] {
  return level === null ? moves : moves.filter((move) => moveMatchesToolpathLevel(move, level))
}
