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

import type { ToolpathBounds, ToolpathMove, ToolpathMoveKind, ToolpathPoint } from '../../engine/toolpaths/types'
import type { RoundStock, Stock } from '../../types/project'
import { isRoundStock } from '../../types/project'
import { aroundFrame, unwrapPoint, wrapPoint } from '../../engine/aroundFrame'
import { stockSpacePoint } from '../../engine/rotaryFrame'
import type { ToolpathVisibility } from '../toolpathVisibility'

/**
 * The display view of a toolpath: the original with its drawn moves and
 * bounds substituted, plus the wrapped path it came from. A scene rebuild asks
 * {@link stockSpaceToolpath} for it and gets the same object back, so the layer
 * split — which caches on object identity — is not redone (issue #395).
 */
export interface DisplayToolpath {
  readonly moves: readonly ToolpathMove[]
  readonly bounds: ToolpathBounds | null
  readonly operationId?: string
  readonly toolpath?: { readonly moves: readonly ToolpathMove[] }
}

/**
 * The display toolpath per generated toolpath, then per stock. Both keys are
 * the caller's own objects — the generated result comes from the generation
 * cache and the stock from the project — so a WeakMap holds no object alive
 * and a regenerated path or an edited stock simply misses.
 */
const displayToolpathCache = new WeakMap<object, WeakMap<object, DisplayToolpath>>()

/** The toolpath to draw (issue #395). A wrapped Around toolpath — any point
 *  carrying `a` — is drawn at `stockSpacePoint`, its turning moves subdivided;
 *  an angle-free toolpath is handed back unchanged, so its line data is
 *  exactly what it is today.
 *
 *  The result is cached on the pair, so the split and the subdivided move
 *  array survive a scene rebuild (issue #395) and the layer split below can
 *  key on the display object's identity. */
export function stockSpaceToolpath<T extends { readonly moves: readonly ToolpathMove[]; readonly bounds: ToolpathBounds | null }>(
  toolpath: T,
  stock: Stock,
): DisplayToolpath {
  const cachedByStock = displayToolpathCache.get(toolpath)
  const cached = cachedByStock?.get(stock)
  if (cached !== undefined) return cached

  const display = computeStockSpaceToolpath(toolpath, stock)
  if (cachedByStock) cachedByStock.set(stock, display)
  else displayToolpathCache.set(toolpath, new WeakMap([[stock, display]]))
  return display
}

function computeStockSpaceToolpath<T extends { readonly moves: readonly ToolpathMove[]; readonly bounds: ToolpathBounds | null }>(
  toolpath: T,
  stock: Stock,
): DisplayToolpath {
  if (!isRoundStock(stock)) return toolpath
  const moves = stockSpaceMoves(toolpath.moves, stock)
  if (moves === toolpath.moves) return toolpath
  return { ...toolpath, moves, bounds: toolpathBoundsOfMoves(moves), toolpath }
}

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

/**
 * The layer split the 3D overlay draws for one generated toolpath (issue
 * #395). A wrapped Around toolpath's generated points sit over the bar's
 * centreline, so bucketing the generated moves draws the wrap as the straight
 * line over the bar that it never is; the lines are built from the stock-space
 * display moves, and so must the split be.
 *
 * `stockSpaceToolpath` caches the display object per generated toolpath and
 * stock and `toolpathLayerBuckets` caches the split per object, so a scene
 * rebuild reuses both instead of redoing the subdivision every build.
 */
export function displayToolpathLayerBuckets(
  toolpath: { readonly moves: readonly ToolpathMove[]; readonly bounds: ToolpathBounds | null },
  stock: Stock,
): ToolpathLayerBuckets {
  return toolpathLayerBuckets(stockSpaceToolpath(toolpath, stock))
}

export interface ToolpathLinePositionChunk {
  positions: Float32Array
  segmentCount: number
}

/**
 * A 3D toolpath layer's line opacity. The selected operation keeps the
 * layer's own; other operations of the active setup draw lighter; a muted one
 * — cut in a setup the workspace is not on (issue #947) — lighter still.
 */
export function toolpathOverlayOpacity(layerOpacity: number, emphasized: boolean, muted = false): number {
  if (emphasized) return layerOpacity
  return muted ? layerOpacity * 0.2 : Math.max(layerOpacity * 0.55, 0.45)
}

export function toolpathPointToWorldTuple(point: ToolpathPoint): [number, number, number] {
  return [point.x, point.z, point.y]
}

/**
 * Most the bar may turn between the two ends of one drawn piece of a wrapped
 * Around move (issue #395). A move that turns further is subdivided so the
 * curve it draws follows the bar rather than chording across it; at 5° a
 * half turn draws as 36 pieces.
 */
export const MAX_WRAPPED_PIECE_TURN_DEGREES = 5

/**
 * The moves to draw for a wrapped Around toolpath, in stock space (issue
 * #395). A wrapped point carries `a`; `stockSpacePoint` says which point of
 * the unturned bar is under the tool tip there, so drawing it puts the pass
 * on the bar's surface all the way round, underside included.
 *
 * A move whose angle changes is a curve on the bar, drawn as pieces of at
 * most {@link MAX_WRAPPED_PIECE_TURN_DEGREES}. Both ends are unwrapped to the
 * flat sheet, the piece ends are interpolated there, and each is wrapped
 * back: the flat across coordinate is linear in the angle, so the pieces turn
 * by equal steps. A move whose angle does not change stays one segment.
 *
 * An angle-free toolpath is returned exactly as it is — the same moves array —
 * so the line data it draws cannot change.
 */
export function stockSpaceMoves(moves: readonly ToolpathMove[], stock: RoundStock): readonly ToolpathMove[] {
  if (!moves.some((move) => move.from.a !== undefined || move.to.a !== undefined)) {
    return moves
  }
  const frame = aroundFrame(stock)
  const out: ToolpathMove[] = []
  for (const move of moves) {
    const fromA = move.from.a
    const toA = move.to.a
    // Only a move with a real turn is subdivided. A half-wrapped endpoint
    // cannot happen on a wrapped path, and is drawn as it stands rather than
    // guessed at.
    if (fromA === undefined || toA === undefined || fromA === toA) {
      out.push({ ...move, from: stockSpacePoint(move.from, stock), to: stockSpacePoint(move.to, stock) })
      continue
    }
    const from = unwrapPoint(move.from, frame)
    const to = unwrapPoint(move.to, frame)
    const pieces = Math.max(1, Math.ceil(Math.abs(toA - fromA) / MAX_WRAPPED_PIECE_TURN_DEGREES))
    let previous = stockSpacePoint(move.from, stock)
    for (let piece = 1; piece <= pieces; piece++) {
      const t = piece / pieces
      const at = piece === pieces
        ? move.to
        : wrapPoint({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t, z: from.z + (to.z - from.z) * t }, frame)
      const next = stockSpacePoint(at, stock)
      out.push({ ...move, from: previous, to: next })
      previous = next
    }
  }
  return out
}

/** Bounds of a move list, in the same shape a generated toolpath carries. */
export function toolpathBoundsOfMoves(moves: readonly ToolpathMove[]): ToolpathBounds | null {
  if (moves.length === 0) return null
  const bounds: ToolpathBounds = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  }
  for (const move of moves) {
    for (const point of [move.from, move.to]) {
      bounds.minX = Math.min(bounds.minX, point.x)
      bounds.minY = Math.min(bounds.minY, point.y)
      bounds.minZ = Math.min(bounds.minZ, point.z)
      bounds.maxX = Math.max(bounds.maxX, point.x)
      bounds.maxY = Math.max(bounds.maxY, point.y)
      bounds.maxZ = Math.max(bounds.maxZ, point.z)
    }
  }
  return bounds
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
