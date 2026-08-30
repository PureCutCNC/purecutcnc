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

import type { ToolpathMove, ToolpathMoveKind, ToolpathPoint } from '../../engine/toolpaths/types'
import type { ToolpathVisibility } from '../toolpathVisibility'

export const DEFAULT_TOOLPATH_LINE_SEGMENTS_PER_CHUNK = 16384

export type ToolpathOverlayLayerKey = 'cuts' | 'leadIns' | 'rapids' | 'plunges' | 'retractions'

/** Z tolerance separating a retraction from level or descending motion. */
export const TOOLPATH_LAYER_Z_EPSILON = 1e-9

/**
 * Which half of a `rapid`'s Z motion a layer claims. The two values partition
 * every rapid move: `retract` takes ascents, `nonRetract` takes everything else
 * — level travel *and descents*.
 *
 * This used to be two independent booleans (`horizontalOnly`, `retractOnly`),
 * which admitted a move matching neither: a rapid that descends is not level
 * and not a retraction, so it belonged to no layer and was silently dropped
 * from both renderers. That hid a rapid plunging into material — exactly the
 * motion the preview exists to catch (issue #482). A single discriminant makes
 * "every rapid lands in exactly one layer" structural instead of incidental.
 */
export type ToolpathLayerZFilter = 'nonRetract' | 'retract'

export interface ToolpathOverlayLayer {
  key: ToolpathOverlayLayerKey
  kinds: ToolpathMoveKind[]
  visible: boolean
  zFilter?: ToolpathLayerZFilter
}

/** True when `move` belongs to a layer carrying `zFilter` (undefined takes all). */
export function moveMatchesZFilter(
  move: Pick<ToolpathMove, 'from' | 'to'>,
  zFilter: ToolpathLayerZFilter | undefined,
): boolean {
  if (!zFilter) return true
  const isRetraction = move.to.z > move.from.z + TOOLPATH_LAYER_Z_EPSILON
  return zFilter === 'retract' ? isRetraction : !isRetraction
}

/**
 * The semantic layer set shared by both toolpath renderers. Order is paint
 * order, and both the 3D overlay and the 2D canvas consume this list rather
 * than declaring their own — they map each key to their own styling, so the two
 * views cannot disagree about what a layer contains.
 */
export function buildToolpathOverlayLayers(visibility: ToolpathVisibility): ToolpathOverlayLayer[] {
  return [
    { key: 'cuts', kinds: ['cut'], visible: visibility.cuts },
    { key: 'leadIns', kinds: ['lead_in', 'lead_out'], visible: visibility.leadIns },
    { key: 'rapids', kinds: ['rapid'], visible: visibility.rapids, zFilter: 'nonRetract' },
    { key: 'plunges', kinds: ['plunge'], visible: visibility.plunges },
    { key: 'retractions', kinds: ['rapid'], visible: visibility.retractions, zFilter: 'retract' },
  ]
}

/** Moves a layer draws: kind membership then its share of the Z split. */
export function movesForToolpathLayer(
  moves: readonly ToolpathMove[],
  layer: Pick<ToolpathOverlayLayer, 'kinds' | 'zFilter'>,
): ToolpathMove[] {
  return moves.filter(
    (move) => layer.kinds.includes(move.kind) && moveMatchesZFilter(move, layer.zFilter),
  )
}

/** Every layer's move list, keyed by layer. */
export type ToolpathLayerBuckets = Record<ToolpathOverlayLayerKey, ToolpathMove[]>

/**
 * The same split as `movesForToolpathLayer`, for all five layers in **one**
 * pass instead of five (issue #664).
 *
 * The five layers partition by `kind` alone except for `rapid`, which
 * `zFilter` splits in two, so a single switch assigns every move without
 * consulting `layer.kinds.includes` — an `Array.includes` per move per layer,
 * which is what the per-layer filter was paying.
 *
 * Exported for the tests; callers on a render path want `toolpathLayerBuckets`
 * below, which caches this.
 */
export function splitMovesIntoLayers(moves: readonly ToolpathMove[]): ToolpathLayerBuckets {
  const buckets: ToolpathLayerBuckets = {
    cuts: [], leadIns: [], rapids: [], plunges: [], retractions: [],
  }
  for (const move of moves) {
    switch (move.kind) {
      case 'cut':
        buckets.cuts.push(move)
        break
      case 'lead_in':
      case 'lead_out':
        buckets.leadIns.push(move)
        break
      case 'plunge':
        buckets.plunges.push(move)
        break
      case 'rapid':
        // The one kind two layers share. `moveMatchesZFilter` is the same
        // predicate both renderers use, so the split cannot drift from it.
        if (moveMatchesZFilter(move, 'retract')) buckets.retractions.push(move)
        else buckets.rapids.push(move)
        break
      default:
        break
    }
  }
  return buckets
}

const layerBucketsCache = new WeakMap<object, ToolpathLayerBuckets>()

/**
 * The layer split for one toolpath, computed once per toolpath object.
 *
 * The split depends only on each move's `kind` and Z direction — never on
 * visibility, which gates whether a layer is *drawn*, not what it contains —
 * so it is a pure function of the toolpath and caches on its identity. That
 * matters because both renderers used to re-filter every frame: on issue
 * #664's 249,663-move fixture that was five full copies of the move array per
 * animation frame, 25% of the 2D canvas frame, and it cost the same whether or
 * not the layer was visible.
 *
 * `ToolpathResult` objects come out of `useToolpathGeneration`'s memoized
 * cache, so they are referentially stable between regens — the same property
 * `feedColourLegendSteps` relies on. Hits cost a WeakMap lookup; misses cost
 * one pass per regen.
 */
export function toolpathLayerBuckets(toolpath: { moves: readonly ToolpathMove[] }): ToolpathLayerBuckets {
  const cached = layerBucketsCache.get(toolpath)
  if (cached !== undefined) {
    return cached
  }
  const buckets = splitMovesIntoLayers(toolpath.moves)
  layerBucketsCache.set(toolpath, buckets)
  return buckets
}

export interface ToolpathLinePositionChunk {
  positions: Float32Array
  segmentCount: number
}

export function toolpathPointToWorldTuple(point: ToolpathPoint): [number, number, number] {
  return [point.x, point.z, point.y]
}

export function buildToolpathLinePositionChunks(
  moves: readonly ToolpathMove[],
  maxSegmentsPerChunk = DEFAULT_TOOLPATH_LINE_SEGMENTS_PER_CHUNK,
): ToolpathLinePositionChunk[] {
  if (moves.length === 0) {
    return []
  }

  const segmentLimit = Math.max(1, Math.floor(maxSegmentsPerChunk))
  const chunks: ToolpathLinePositionChunk[] = []

  for (let start = 0; start < moves.length; start += segmentLimit) {
    const chunkMoves = moves.slice(start, start + segmentLimit)
    const positions = new Float32Array(chunkMoves.length * 2 * 3)
    let offset = 0

    for (const move of chunkMoves) {
      const from = toolpathPointToWorldTuple(move.from)
      const to = toolpathPointToWorldTuple(move.to)
      positions[offset] = from[0]
      positions[offset + 1] = from[1]
      positions[offset + 2] = from[2]
      positions[offset + 3] = to[0]
      positions[offset + 4] = to[1]
      positions[offset + 5] = to[2]
      offset += 6
    }

    chunks.push({
      positions,
      segmentCount: chunkMoves.length,
    })
  }

  return chunks
}
