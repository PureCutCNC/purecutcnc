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
 * Display-only toolpath geometry for the 2D canvas (issue #679).
 *
 * `ToolpathResult` remains the complete machining record. This module derives
 * a scale-specific, screen-space representation and indexes it in
 * pan-independent scaled-world coordinates, so panning only queries what the
 * canvas can see. It is deliberately not shared with generation, G-code, or
 * simulation.
 */

import type { ToolpathMove, ToolpathResult } from '../../engine/toolpaths/types'
import {
  toolpathLayerBuckets,
  type ToolpathOverlayLayerKey,
} from '../viewport3d/toolpathOverlay'
import type { ViewTransform } from './viewTransform'

const DISPLAY_PATH_LENGTH = 3
const INDEX_CELL_SIZE = 128
const MAX_INDEXED_CELLS_PER_SEGMENT = 64
const FULL_LAYER_QUERY_FRACTION = 0.5
const MIN_MATCHED_SEGMENTS_FOR_FULL_LAYER_FALLBACK = 512
const MAX_CACHED_SCALES_PER_TOOLPATH = 2

export interface DisplayViewport {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

export interface DisplaySegment {
  fromX: number
  fromY: number
  toX: number
  toY: number
  feedScale: number | undefined
  source: string | undefined
}

export interface DisplaySegmentIndex {
  readonly segments: readonly DisplaySegment[]
  readonly cells: ReadonlyMap<string, readonly number[]>
  readonly alwaysVisible: readonly number[]
  readonly bounds: DisplayViewport | null
}

export interface ToolpathDisplayGeometry {
  readonly layers: Record<ToolpathOverlayLayerKey, DisplaySegmentIndex>
  readonly collisions: DisplaySegmentIndex
  readonly debug: DisplaySegmentIndex
}

interface CachedDisplayGeometry {
  scale: number
  simplify: boolean
  geometry: ToolpathDisplayGeometry
}

interface QueryScratch {
  stamps: Uint32Array
  generation: number
}

const displayGeometryCache = new WeakMap<ToolpathResult, CachedDisplayGeometry[]>()
const packedSegmentIndexCache = new WeakMap<Float32Array, DisplaySegmentIndex>()
const queryScratchCache = new WeakMap<DisplaySegmentIndex, QueryScratch>()

function cellKey(x: number, y: number): string {
  return `${x}:${y}`
}

function segmentBounds(segment: DisplaySegment): DisplayViewport {
  return {
    minX: Math.min(segment.fromX, segment.toX),
    minY: Math.min(segment.fromY, segment.toY),
    maxX: Math.max(segment.fromX, segment.toX),
    maxY: Math.max(segment.fromY, segment.toY),
  }
}

function combineBounds(current: DisplayViewport | null, next: DisplayViewport): DisplayViewport {
  if (!current) return next
  return {
    minX: Math.min(current.minX, next.minX),
    minY: Math.min(current.minY, next.minY),
    maxX: Math.max(current.maxX, next.maxX),
    maxY: Math.max(current.maxY, next.maxY),
  }
}

function intersects(a: DisplayViewport, b: DisplayViewport): boolean {
  return a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY
}

function segmentIntersectsViewport(segment: DisplaySegment, viewport: DisplayViewport): boolean {
  return Math.min(segment.fromX, segment.toX) <= viewport.maxX
    && Math.max(segment.fromX, segment.toX) >= viewport.minX
    && Math.min(segment.fromY, segment.toY) <= viewport.maxY
    && Math.max(segment.fromY, segment.toY) >= viewport.minY
}

function contains(a: DisplayViewport, b: DisplayViewport): boolean {
  return a.minX <= b.minX && a.minY <= b.minY && a.maxX >= b.maxX && a.maxY >= b.maxY
}

function makeSegment(move: ToolpathMove, scale: number): DisplaySegment {
  return {
    fromX: move.from.x * scale,
    fromY: move.from.y * scale,
    toX: move.to.x * scale,
    toY: move.to.y * scale,
    feedScale: move.feedScale,
    source: move.source,
  }
}

/**
 * Coalesce only connected, same-feed runs up to three canvas pixels of total
 * travel, not endpoint distance (a tight reversal must not disappear). Every
 * original point is at most half that travel from an endpoint of the chord;
 * the real trochoidal fixtures stay below 0.25 px displacement at overview.
 * Rebuilding at the new scale restores fine detail as the user zooms in.
 */
function displaySegments(moves: readonly ToolpathMove[], scale: number, simplify: boolean): DisplaySegment[] {
  if (!simplify) return moves.map((move) => makeSegment(move, scale))

  const out: DisplaySegment[] = []
  let pending: DisplaySegment | null = null
  let pendingLength = 0

  const flush = (): void => {
    if (pending) out.push(pending)
    pending = null
    pendingLength = 0
  }

  for (const move of moves) {
    const next = makeSegment(move, scale)
    const length = Math.hypot(next.toX - next.fromX, next.toY - next.fromY)
    if (!pending) {
      pending = next
      pendingLength = length
      continue
    }

    const isConnected = pending.toX === next.fromX && pending.toY === next.fromY
    const hasSameFeed = pending.feedScale === next.feedScale
    if (isConnected && hasSameFeed && pendingLength + length <= DISPLAY_PATH_LENGTH) {
      pending.toX = next.toX
      pending.toY = next.toY
      pendingLength += length
      continue
    }

    flush()
    pending = next
    pendingLength = length
  }

  flush()
  return out
}

function indexSegments(segments: readonly DisplaySegment[]): DisplaySegmentIndex {
  const cells = new Map<string, number[]>()
  const alwaysVisible: number[] = []
  let bounds: DisplayViewport | null = null

  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index]
    const segmentBox = segmentBounds(segment)
    bounds = combineBounds(bounds, segmentBox)
    const minCellX = Math.floor(segmentBox.minX / INDEX_CELL_SIZE)
    const maxCellX = Math.floor(segmentBox.maxX / INDEX_CELL_SIZE)
    const minCellY = Math.floor(segmentBox.minY / INDEX_CELL_SIZE)
    const maxCellY = Math.floor(segmentBox.maxY / INDEX_CELL_SIZE)
    const cellCount = (maxCellX - minCellX + 1) * (maxCellY - minCellY + 1)
    if (cellCount > MAX_INDEXED_CELLS_PER_SEGMENT) {
      alwaysVisible.push(index)
      continue
    }

    for (let x = minCellX; x <= maxCellX; x += 1) {
      for (let y = minCellY; y <= maxCellY; y += 1) {
        const key = cellKey(x, y)
        const entries = cells.get(key)
        if (entries) {
          entries.push(index)
        } else {
          cells.set(key, [index])
        }
      }
    }
  }

  return { segments, cells, alwaysVisible, bounds }
}

function visibleSegmentIndices(index: DisplaySegmentIndex, viewport: DisplayViewport | null): readonly number[] | null {
  if (!viewport || !index.bounds || contains(viewport, index.bounds)) return null
  if (!intersects(viewport, index.bounds) && index.alwaysVisible.length === 0) return []

  let scratch = queryScratchCache.get(index)
  if (!scratch) {
    scratch = { stamps: new Uint32Array(index.segments.length), generation: 0 }
    queryScratchCache.set(index, scratch)
  }
  scratch.generation += 1
  if (scratch.generation === 0) {
    scratch.stamps.fill(0)
    scratch.generation = 1
  }

  const { stamps, generation } = scratch
  let matchedCount = 0
  const fullLayerThreshold = Math.max(
    MIN_MATCHED_SEGMENTS_FOR_FULL_LAYER_FALLBACK,
    index.segments.length * FULL_LAYER_QUERY_FRACTION,
  )
  const addIfVisible = (segmentIndex: number): boolean => {
    if (stamps[segmentIndex] === generation || !segmentIntersectsViewport(index.segments[segmentIndex], viewport)) {
      return false
    }
    stamps[segmentIndex] = generation
    matchedCount += 1
    return matchedCount >= fullLayerThreshold
  }

  for (const segmentIndex of index.alwaysVisible) {
    if (addIfVisible(segmentIndex)) return null
  }
  const minCellX = Math.floor(viewport.minX / INDEX_CELL_SIZE)
  const maxCellX = Math.floor(viewport.maxX / INDEX_CELL_SIZE)
  const minCellY = Math.floor(viewport.minY / INDEX_CELL_SIZE)
  const maxCellY = Math.floor(viewport.maxY / INDEX_CELL_SIZE)
  for (let x = minCellX; x <= maxCellX; x += 1) {
    for (let y = minCellY; y <= maxCellY; y += 1) {
      for (const segmentIndex of index.cells.get(cellKey(x, y)) ?? []) {
        if (addIfVisible(segmentIndex)) return null
      }
    }
  }

  if (matchedCount === 0) return []
  const matched: number[] = []
  for (let segmentIndex = 0; segmentIndex < stamps.length; segmentIndex += 1) {
    if (stamps[segmentIndex] === generation) matched.push(segmentIndex)
  }
  return matched
}

function queryIndex(index: DisplaySegmentIndex, viewport: DisplayViewport | null): readonly DisplaySegment[] {
  const indices = visibleSegmentIndices(index, viewport)
  return indices === null ? index.segments : indices.map((segmentIndex) => index.segments[segmentIndex])
}

function debugSegments(toolpath: ToolpathResult, scale: number): DisplaySegment[] {
  if (!toolpath.debugToolpath) return []
  const out: DisplaySegment[] = []
  for (const move of toolpath.moves) {
    if (move.kind === 'cut' && move.source) out.push(makeSegment(move, scale))
  }
  return out
}

function collisionSegments(toolpath: ToolpathResult, scale: number): DisplaySegment[] {
  if (!toolpath.collidingMoveIndices?.length) return []
  const out: DisplaySegment[] = []
  for (const moveIndex of toolpath.collidingMoveIndices) {
    const move = toolpath.moves[moveIndex]
    if (move) out.push(makeSegment(move, scale))
  }
  return out
}

/**
 * Cache the two most-recent scale/detail variants per stable toolpath identity.
 * The second entry keeps booklet snapshots from evicting the live canvas's
 * pan cache, while bounding memory during continuous zooming.
 */
export function toolpathDisplayGeometry(
  toolpath: ToolpathResult,
  scale: number,
  simplify = true,
): ToolpathDisplayGeometry {
  const cachedEntries = displayGeometryCache.get(toolpath) ?? []
  const cachedIndex = cachedEntries.findIndex((entry) => entry.scale === scale && entry.simplify === simplify)
  if (cachedIndex >= 0) {
    const [cached] = cachedEntries.splice(cachedIndex, 1)
    cachedEntries.push(cached)
    return cached.geometry
  }

  const buckets = toolpathLayerBuckets(toolpath)
  const geometry: ToolpathDisplayGeometry = {
    layers: {
      cuts: indexSegments(displaySegments(buckets.cuts, scale, simplify)),
      leadIns: indexSegments(displaySegments(buckets.leadIns, scale, simplify)),
      rapids: indexSegments(displaySegments(buckets.rapids, scale, simplify)),
      plunges: indexSegments(displaySegments(buckets.plunges, scale, simplify)),
      retractions: indexSegments(displaySegments(buckets.retractions, scale, simplify)),
    },
    collisions: indexSegments(collisionSegments(toolpath, scale)),
    debug: indexSegments(debugSegments(toolpath, scale)),
  }
  cachedEntries.push({ scale, simplify, geometry })
  if (cachedEntries.length > MAX_CACHED_SCALES_PER_TOOLPATH) cachedEntries.shift()
  displayGeometryCache.set(toolpath, cachedEntries)
  return geometry
}

/** Return the pan-independent scaled-world rectangle currently covered by a canvas. */
export function canvasDisplayViewport(
  canvas: { width: number; height: number } | undefined,
  vt: ViewTransform,
): DisplayViewport | null {
  if (!canvas || !Number.isFinite(canvas.width) || !Number.isFinite(canvas.height) || canvas.width <= 0 || canvas.height <= 0) {
    return null
  }
  return {
    minX: -vt.offsetX,
    minY: -vt.offsetY,
    maxX: canvas.width - vt.offsetX,
    maxY: canvas.height - vt.offsetY,
  }
}

export function expandDisplayViewport(viewport: DisplayViewport | null, padding: number): DisplayViewport | null {
  if (!viewport) return null
  return {
    minX: viewport.minX - padding,
    minY: viewport.minY - padding,
    maxX: viewport.maxX + padding,
    maxY: viewport.maxY + padding,
  }
}

export function visibleDisplaySegments(index: DisplaySegmentIndex, viewport: DisplayViewport | null): readonly DisplaySegment[] {
  return queryIndex(index, viewport)
}

function packedSegments(packed: Float32Array): DisplaySegment[] {
  const out: DisplaySegment[] = []
  for (let offset = 0; offset < packed.length; offset += 4) {
    out.push({
      fromX: packed[offset],
      fromY: packed[offset + 1],
      toX: packed[offset + 2],
      toY: packed[offset + 3],
      feedScale: undefined,
      source: undefined,
    })
  }
  return out
}

/**
 * Offsets into an arrow-placement array that can affect the current viewport.
 * `null` means no canvas bounds were available, so callers should draw all.
 */
export function visiblePackedSegmentOffsets(
  packed: Float32Array,
  viewport: DisplayViewport | null,
): readonly number[] | null {
  if (!viewport) return null
  let index = packedSegmentIndexCache.get(packed)
  if (!index) {
    index = indexSegments(packedSegments(packed))
    packedSegmentIndexCache.set(packed, index)
  }
  const visible = visibleSegmentIndices(index, viewport)
  return visible === null ? null : visible.map((segmentIndex) => segmentIndex * 4)
}
