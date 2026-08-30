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
 * Where the 2D direction arrows go, computed once per view scale (issue #664).
 *
 * Deciding which moves get an arrow is a full pass over the toolpath, and the
 * 2D canvas was redoing it on every animation frame. On this issue's
 * 249,663-move fixture that pass measured **93.7 ms per frame**, against 26.7 ms
 * to actually draw the 10,335 arrows it selected — so the decision, not the
 * drawing, is what made panning unusable.
 *
 * The pass depends on the toolpath, the view **scale** and the layer
 * visibility flags — never on the pan offset. Positions are therefore stored in
 * *scaled world* space (world x scale, no offset) and the caller adds the
 * offset when drawing, which is what makes panning free: it changes only the
 * offset, so the cache still hits. Zooming changes the scale and pays for one
 * rebuild, which is correct rather than merely convenient — the spacing
 * thresholds are screen-space, so which moves earn an arrow genuinely changes
 * with zoom.
 *
 * The 3D viewport has had the equivalent all along: it builds Float32Array
 * chunks once and lets the GPU redraw them. This gives the 2D canvas the same
 * shape.
 */

import type { ToolpathMove, ToolpathResult } from '../../engine/toolpaths/types'
import type { ToolpathVisibility } from '../toolpathVisibility'
import { moveMatchesZFilter } from '../viewport3d/toolpathOverlay'

/** Kinds that can carry a direction arrow. */
export type ArrowKind = 'cut' | 'rapid'

/**
 * Arrow endpoints in scaled-world space, four floats per arrow
 * (`fromX, fromY, toX, toY`). Add the view offset to get canvas coordinates.
 */
export interface ToolpathArrowPlacements {
  cut: Float32Array
  rapid: Float32Array
}

interface CachedPlacements extends ToolpathArrowPlacements {
  scale: number
  cuts: boolean
  rapids: boolean
  retractions: boolean
}

/**
 * `Math.hypot` is correct about overflow and underflow and pays for it; at
 * three calls per move it was a measurable share of the pass, and toolpath
 * coordinates are nowhere near the range where the difference matters.
 */
function distance(dx: number, dy: number): number {
  return Math.sqrt(dx * dx + dy * dy)
}

/**
 * The arrow-placement pass. Pure, and exported so the cache can be tested
 * against it; callers on a render path want `toolpathArrowPlacements`.
 *
 * `scale` is the view scale. Positions come back multiplied by it but *not*
 * offset, so they are pan-independent.
 */
export function computeToolpathArrowPlacements(
  toolpath: ToolpathResult,
  scale: number,
  visibility: ToolpathVisibility,
): ToolpathArrowPlacements {
  const bounds = toolpath.bounds
  if (!bounds) {
    return { cut: new Float32Array(0), rapid: new Float32Array(0) }
  }

  const span = Math.max(
    bounds.maxX - bounds.minX,
    bounds.maxY - bounds.minY,
    bounds.maxZ - bounds.minZ,
  )
  const preferredSpacing = Math.max(12, Math.min(40, span * scale * 0.09))
  const preferredArrowLength = Math.max(8.5, Math.min(18, span * scale * 0.03))

  const out: Record<ArrowKind, number[]> = { cut: [], rapid: [] }
  const distanceSinceLastArrowByKind: Record<ArrowKind, number> = { cut: 0, rapid: 0 }

  /** Normalized direction of a neighbour move, or null; writes into the pair below. */
  let neighbourX = 0
  let neighbourY = 0
  function loadNeighbourDirection(move: ToolpathMove | undefined): boolean {
    if (!move || (move.kind !== 'cut' && move.kind !== 'rapid')) return false
    const dx = (move.to.x - move.from.x) * scale
    const dy = (move.to.y - move.from.y) * scale
    const length = distance(dx, dy)
    if (length <= 0.001) return false
    neighbourX = dx / length
    neighbourY = dy / length
    return true
  }

  const moves = toolpath.moves
  for (let moveIndex = 0; moveIndex < moves.length; moveIndex += 1) {
    const move = moves[moveIndex]
    if (move.kind !== 'cut' && move.kind !== 'rapid') continue

    if (move.kind === 'cut' && !visibility.cuts) continue
    if (move.kind === 'rapid') {
      // Same split as the line layers, via the same predicate — the arrow code
      // having its own copy is how the two fell out of step (issue #482).
      const isRetraction = moveMatchesZFilter(move, 'retract')
      if (isRetraction && !visibility.retractions) continue
      if (!isRetraction && !visibility.rapids) continue
    }

    const fromX = move.from.x * scale
    const fromY = move.from.y * scale
    const toX = move.to.x * scale
    const toY = move.to.y * scale
    const dx = toX - fromX
    const dy = toY - fromY
    const length = distance(dx, dy)
    if (length < 0.5) continue

    distanceSinceLastArrowByKind[move.kind] += length

    const shouldForceArrow = length >= preferredArrowLength * 1.1
    const shouldPlaceBySpacing = distanceSinceLastArrowByKind[move.kind] >= preferredSpacing

    // A short cut move that turns sharply gets an arrow even when spacing says
    // no. The neighbour lookups only feed this decision, so they are skipped
    // whenever one of the two cheap tests has already placed the arrow —
    // `A || B || (!A && !B && C)` is `A || B || C`.
    let isConnectorCut = false
    if (
      !shouldForceArrow
      && !shouldPlaceBySpacing
      && move.kind === 'cut'
      && length <= preferredSpacing * 0.8
    ) {
      const directionX = dx / length
      const directionY = dy / length
      let previousX = 0
      let previousY = 0
      if (loadNeighbourDirection(moves[moveIndex - 1])) {
        previousX = neighbourX
        previousY = neighbourY
        if (loadNeighbourDirection(moves[moveIndex + 1])) {
          const previousTurn = Math.acos(
            Math.max(-1, Math.min(1, directionX * previousX + directionY * previousY)),
          )
          const nextTurn = Math.acos(
            Math.max(-1, Math.min(1, directionX * neighbourX + directionY * neighbourY)),
          )
          isConnectorCut = Math.min(previousTurn, nextTurn) >= Math.PI / 10
        }
      }
    }

    if (!shouldForceArrow && !shouldPlaceBySpacing && !isConnectorCut) continue

    out[move.kind].push(fromX, fromY, toX, toY)
    distanceSinceLastArrowByKind[move.kind] = 0
  }

  return { cut: new Float32Array(out.cut), rapid: new Float32Array(out.rapid) }
}

const placementCache = new WeakMap<ToolpathResult, CachedPlacements>()

/**
 * Cached `computeToolpathArrowPlacements`, keyed on the toolpath object plus
 * every input that changes the answer: the view scale and the three visibility
 * flags the pass reads. Panning changes none of them, so it hits.
 *
 * `ToolpathResult` objects come out of `useToolpathGeneration`'s memoized
 * cache, so they are referentially stable between regens — the same property
 * `feedColourLegendSteps` and `toolpathLayerBuckets` rely on.
 */
export function toolpathArrowPlacements(
  toolpath: ToolpathResult,
  scale: number,
  visibility: ToolpathVisibility,
): ToolpathArrowPlacements {
  const cached = placementCache.get(toolpath)
  if (
    cached !== undefined
    && cached.scale === scale
    && cached.cuts === visibility.cuts
    && cached.rapids === visibility.rapids
    && cached.retractions === visibility.retractions
  ) {
    return cached
  }

  const placements = computeToolpathArrowPlacements(toolpath, scale, visibility)
  // Store and return the same object, so a cache hit is observably a hit.
  const entry: CachedPlacements = {
    cut: placements.cut,
    rapid: placements.rapid,
    scale,
    cuts: visibility.cuts,
    rapids: visibility.rapids,
    retractions: visibility.retractions,
  }
  placementCache.set(toolpath, entry)
  return entry
}
