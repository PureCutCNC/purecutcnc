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

import type { AroundFrame } from './aroundFrame'
import type { ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './toolpaths/types'

function foldedBounds(moves: readonly ToolpathMove[]): ToolpathBounds | null {
  if (!moves.length) return null
  const bounds: ToolpathBounds = {
    minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity,
  }
  for (const move of moves) for (const point of [move.from, move.to]) {
    bounds.minX = Math.min(bounds.minX, point.x)
    bounds.maxX = Math.max(bounds.maxX, point.x)
    bounds.minY = Math.min(bounds.minY, point.y)
    bounds.maxY = Math.max(bounds.maxY, point.y)
    bounds.minZ = Math.min(bounds.minZ, point.z)
    bounds.maxZ = Math.max(bounds.maxZ, point.z)
  }
  return bounds
}

/** Fold sheet moves at circumference seams, keeping each swept piece continuous. */
export function foldToolpath<T extends ToolpathResult>(result: T, frame: AroundFrame): T {
  const axis = frame.axis === 'x' ? 'y' : 'x'
  const start = frame.sheetStart
  const period = frame.circumference
  const end = start + period
  if (result.moves.every((move) => [move.from, move.to].every((point) => point[axis] >= start && point[axis] <= end))) {
    return { ...result, bounds: foldedBounds(result.moves) }
  }
  const moves: ToolpathMove[] = []
  const collisions = new Set(result.collidingMoveIndices)
  const collidingMoveIndices: number[] = []
  result.moves.forEach((move, index) => {
    const from = move.from[axis]
    const to = move.to[axis]
    const fractions = [0, 1]
    if (from !== to) {
      const low = Math.min(from, to)
      const high = Math.max(from, to)
      for (let turn = Math.floor((low - start) / period) + 1; start + turn * period < high; turn++) {
        const fraction = (start + turn * period - from) / (to - from)
        // A seam at the endpoint ends the piece; it never creates an empty one.
        if (fraction > 1e-12 && fraction < 1 - 1e-12) fractions.push(fraction)
      }
    }
    fractions.sort((a, b) => a - b)
    for (let i = 1; i < fractions.length; i++) {
      const t0 = fractions[i - 1]
      const t1 = fractions[i]
      const middle = from + (to - from) * (t0 + t1) / 2
      const shift = Math.floor((middle - start) / period) * period
      const at = (t: number): ToolpathPoint => {
        const point = {
          ...move.from,
          x: move.from.x + (move.to.x - move.from.x) * t,
          y: move.from.y + (move.to.y - move.from.y) * t,
          z: move.from.z + (move.to.z - move.from.z) * t,
        }
        point[axis] -= shift
        // Keep interpolated seam endpoints exact despite floating point roundoff.
        if (Math.abs(point[axis] - start) < period * 1e-12) point[axis] = start
        if (Math.abs(point[axis] - end) < period * 1e-12) point[axis] = end
        return point
      }
      const piece = { ...move, from: at(t0), to: at(t1) }
      if (collisions.has(index)) collidingMoveIndices.push(moves.length)
      moves.push(piece)
    }
  })
  return {
    ...result, moves, bounds: foldedBounds(moves),
    ...(result.collidingMoveIndices ? { collidingMoveIndices } : {}),
  }
}
