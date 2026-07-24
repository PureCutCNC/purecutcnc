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

import type { ToolpathBounds, ToolpathMove, ToolpathResult } from './types'

const EPSILON = 1e-9

/**
 * Pure finalizer that removes zero-length duplicate moves and merges
 * contiguous, direction-preserving, collinear XY moves.
 *
 * Applied after tab transformations but before clamp warnings so collision
 * move indices refer to the final (optimized) move array.
 *
 * Preserves every {@link ToolpathResult} property by spreading the input and
 * replacing only `moves` and recomputed `bounds`.
 */
export function optimizeLinearMoves(result: ToolpathResult): ToolpathResult {
  if (result.moves.length === 0) {
    return result
  }

  const optimized: ToolpathMove[] = []

  for (const move of result.moves) {
    if (isZeroLength(move)) {
      continue
    }

    if (optimized.length === 0) {
      optimized.push(move)
      continue
    }

    const prev = optimized[optimized.length - 1]
    if (canMerge(prev, move)) {
      optimized[optimized.length - 1] = {
        ...prev,
        to: move.to,
      }
    } else {
      optimized.push(move)
    }
  }

  if (optimized.length === result.moves.length) {
    return result
  }

  return {
    ...result,
    moves: optimized,
    bounds: computeBounds(optimized),
  }
}

function isZeroLength(move: ToolpathMove): boolean {
  return (
    Math.abs(move.to.x - move.from.x) < EPSILON &&
    Math.abs(move.to.y - move.from.y) < EPSILON &&
    Math.abs(move.to.z - move.from.z) < EPSILON
  )
}

function canMerge(a: ToolpathMove, b: ToolpathMove): boolean {
  // Must be contiguous — a's endpoint must meet b's start point
  if (!samePoint(a.to, b.from)) return false

  if (a.kind !== b.kind) return false
  if (a.source !== b.source) return false
  if (a.feedScale !== b.feedScale) return false

  // Both moves must be constant-Z and at the same Z
  if (!sameZ(a) || !sameZ(b)) return false
  if (Math.abs(a.from.z - b.from.z) > EPSILON) return false

  // Must be direction-preserving and collinear in XY
  return sameDirectionXY(a, b)
}

function samePoint(a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }): boolean {
  return (
    Math.abs(a.x - b.x) < EPSILON &&
    Math.abs(a.y - b.y) < EPSILON &&
    Math.abs(a.z - b.z) < EPSILON
  )
}

function sameZ(move: ToolpathMove): boolean {
  return Math.abs(move.to.z - move.from.z) < EPSILON
}

/**
 * Returns true when `a` and `b` are collinear in the XY plane and travel in
 * the same direction (no reversal).
 */
function sameDirectionXY(a: ToolpathMove, b: ToolpathMove): boolean {
  const dxA = a.to.x - a.from.x
  const dyA = a.to.y - a.from.y
  const dxB = b.to.x - b.from.x
  const dyB = b.to.y - b.from.y

  const lenA2 = dxA * dxA + dyA * dyA
  const lenB2 = dxB * dxB + dyB * dyB

  if (lenA2 < EPSILON * EPSILON || lenB2 < EPSILON * EPSILON) {
    return false
  }

  const dot = dxA * dxB + dyA * dyB
  if (dot <= 0) return false

  const cross = dxA * dyB - dyA * dxB
  const tol2 = EPSILON * EPSILON * lenA2 * lenB2
  return cross * cross < tol2
}

function computeBounds(moves: ToolpathMove[]): ToolpathBounds | null {
  if (moves.length === 0) return null

  let bounds: ToolpathBounds = {
    minX: moves[0].from.x,
    minY: moves[0].from.y,
    minZ: moves[0].from.z,
    maxX: moves[0].from.x,
    maxY: moves[0].from.y,
    maxZ: moves[0].from.z,
  }

  for (const move of moves) {
    bounds = expandBounds(bounds, move.from)
    bounds = expandBounds(bounds, move.to)
  }

  return bounds
}

function expandBounds(
  bounds: ToolpathBounds,
  p: { x: number; y: number; z: number },
): ToolpathBounds {
  return {
    minX: Math.min(bounds.minX, p.x),
    minY: Math.min(bounds.minY, p.y),
    minZ: Math.min(bounds.minZ, p.z),
    maxX: Math.max(bounds.maxX, p.x),
    maxY: Math.max(bounds.maxY, p.y),
    maxZ: Math.max(bounds.maxZ, p.z),
  }
}
