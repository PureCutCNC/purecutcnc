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
 * Folding drawn geometry onto the Around sheet (issue #1112 slice L, decision
 * 8.13). The sheet is one circumference across; anything drawn past its edge is
 * folded back into it, splitting at the seam, so a 20-turn thread reads as
 * stripes inside the sheet instead of a line running far past it.
 *
 * This is a **drawing** step. The geometry stays one continuous thing: a
 * canned shape still generates its outlines on the fly, and a toolpath is
 * computed continuous and stored wrapped around the bar. Nothing here mutates
 * the input; a profile or path already inside the sheet is returned as it is.
 */

import { sampleProfilePoints } from '../../types/project'
import type { Point, SketchProfile } from '../../types/project'
import type { ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from '../../engine/toolpaths/types'

/**
 * The sheet a drawing folds at. `AroundSheet` and `AroundFrame` both satisfy
 * it structurally; only the seam and the across direction are needed.
 */
export interface AroundWrapWindow {
  readonly axis: 'x' | 'y'
  readonly sheetStart: number
  readonly circumference: number
}

function acrossOf(axis: 'x' | 'y', point: { x: number; y: number }): number {
  return axis === 'x' ? point.y : point.x
}

function insideWindow(across: number, sheet: AroundWrapWindow): boolean {
  if (!(sheet.circumference > 0)) return true
  const offset = across - sheet.sheetStart
  return offset >= -1e-9 && offset <= sheet.circumference + 1e-9
}

/**
 * The fractions of a segment at which it crosses a seam, plus its two ends.
 * Boundaries exactly at an end are not crossings: that piece already stops
 * there.
 */
function seamFractions(
  from: number,
  to: number,
  sheet: AroundWrapWindow,
): number[] {
  const fractions = [0, 1]
  if (from === to || !(sheet.circumference > 0)) return fractions
  const low = Math.min(from, to)
  const high = Math.max(from, to)
  const first = Math.floor((low - sheet.sheetStart) / sheet.circumference) + 1
  for (let k = first; sheet.sheetStart + k * sheet.circumference < high; k += 1) {
    const boundary = sheet.sheetStart + k * sheet.circumference
    if (boundary <= low) continue
    const t = (boundary - from) / (to - from)
    if (t > 1e-12 && t < 1 - 1e-12) fractions.push(t)
  }
  fractions.sort((a, b) => a - b)
  const unique: number[] = []
  for (const fraction of fractions) {
    if (unique.length === 0 || fraction - unique[unique.length - 1] > 1e-12) unique.push(fraction)
  }
  return unique
}

/** Keep a folded coordinate on the sheet despite floating-point roundoff. */
function clampAcross(across: number, sheet: AroundWrapWindow): number {
  const end = sheet.sheetStart + sheet.circumference
  if (across < sheet.sheetStart) return sheet.sheetStart
  if (across > end) return end
  return across
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) < 1e-9 && Math.abs(a.y - b.y) < 1e-9
}

function pointAt(from: Point, to: Point, t: number, shift: number, sheet: AroundWrapWindow): Point {
  const x = from.x + (to.x - from.x) * t
  const y = from.y + (to.y - from.y) * t
  const across = clampAcross((sheet.axis === 'x' ? y : x) - shift, sheet)
  return sheet.axis === 'x' ? { x, y: across } : { x: across, y }
}

function pieceProfile(points: Point[]): SketchProfile {
  return {
    start: points[0],
    segments: points.slice(1).map((to) => ({ type: 'line', to })),
    closed: false,
  }
}

/**
 * Fold a world-space polyline into the sheet. Each seam crossing starts a new
 * piece, so a line that wraps twice comes back as two polylines at the right
 * sheet coordinates rather than one line drawn outside the sheet.
 */
export function foldSheetPolylines(points: readonly Point[], sheet: AroundWrapWindow): Point[][] {
  if (points.length < 2) return []
  if (!(sheet.circumference > 0)) return [points.map((point) => ({ ...point }))]
  const pieces: Point[][] = []
  let current: Point[] | null = null
  for (let index = 1; index < points.length; index += 1) {
    const from = points[index - 1]
    const to = points[index]
    const fromAcross = acrossOf(sheet.axis, from)
    const toAcross = acrossOf(sheet.axis, to)
    const fractions = seamFractions(fromAcross, toAcross, sheet)
    for (let slot = 1; slot < fractions.length; slot += 1) {
      const t0 = fractions[slot - 1]
      const t1 = fractions[slot]
      if (t1 - t0 <= 1e-12) continue
      const middle = (t0 + t1) / 2
      const middleAcross = fromAcross + (toAcross - fromAcross) * middle
      const shift = Math.floor((middleAcross - sheet.sheetStart) / sheet.circumference + 1e-12) * sheet.circumference
      const start = pointAt(from, to, t0, shift, sheet)
      const end = pointAt(from, to, t1, shift, sheet)
      if (samePoint(start, end)) continue
      if (current && samePoint(current[current.length - 1], start)) {
        current.push(end)
      } else {
        current = [start, end]
        pieces.push(current)
      }
    }
  }
  return pieces
}

/**
 * A profile as the Around sheet draws it. A profile wholly inside the sheet is
 * returned untouched (so an ordinary curve keeps its arcs); a folded one comes
 * back as open polyline pieces, each ending on a seam.
 */
export function foldProfileToSheet(profile: SketchProfile, sheet: AroundWrapWindow): SketchProfile[] {
  const points = sampleProfilePoints(profile)
  if (points.length < 2) return [profile]
  if (profile.closed) points.push(points[0])
  if (points.every((point) => insideWindow(acrossOf(sheet.axis, point), sheet))) return [profile]
  const pieces = foldSheetPolylines(points, sheet).filter((piece) => piece.length >= 2)
  return pieces.length > 0 ? pieces.map(pieceProfile) : [profile]
}

function toolpathBounds(moves: readonly ToolpathMove[]): ToolpathBounds | null {
  if (moves.length === 0) return null
  const bounds: ToolpathBounds = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  }
  for (const move of moves) {
    for (const point of [move.from, move.to]) {
      bounds.minX = Math.min(bounds.minX, point.x)
      bounds.maxX = Math.max(bounds.maxX, point.x)
      bounds.minY = Math.min(bounds.minY, point.y)
      bounds.maxY = Math.max(bounds.maxY, point.y)
      bounds.minZ = Math.min(bounds.minZ, point.z)
      bounds.maxZ = Math.max(bounds.maxZ, point.z)
    }
  }
  return bounds
}

function toolpathPointAt(from: ToolpathPoint, to: ToolpathPoint, t: number, shift: number, sheet: AroundWrapWindow): ToolpathPoint {
  const x = from.x + (to.x - from.x) * t
  const y = from.y + (to.y - from.y) * t
  const z = from.z + (to.z - from.z) * t
  const across = clampAcross((sheet.axis === 'x' ? y : x) - shift, sheet)
  const point: ToolpathPoint = { ...from, x, y, z }
  if (sheet.axis === 'x') point.y = across
  else point.x = across
  return point
}

/**
 * Fold a displayed toolpath into the sheet. The result is a new object with
 * moves split at the seams; the input — the generated or stored path — is
 * never touched, so the machine still runs one continuous helix. A path
 * already inside the sheet is returned as the same object.
 */
export function foldToolpathToSheet<T extends ToolpathResult>(result: T, sheet: AroundWrapWindow): T {
  if (!(sheet.circumference > 0)) return result
  const inside = result.moves.every((move) => (
    insideWindow(acrossOf(sheet.axis, move.from), sheet)
    && insideWindow(acrossOf(sheet.axis, move.to), sheet)
  ))
  if (inside) return result

  const moves: ToolpathMove[] = []
  const colliding = new Set(result.collidingMoveIndices)
  const collidingMoveIndices: number[] = []
  result.moves.forEach((move, index) => {
    const fromAcross = acrossOf(sheet.axis, move.from)
    const toAcross = acrossOf(sheet.axis, move.to)
    const fractions = seamFractions(fromAcross, toAcross, sheet)
    for (let slot = 1; slot < fractions.length; slot += 1) {
      const t0 = fractions[slot - 1]
      const t1 = fractions[slot]
      if (t1 - t0 <= 1e-12) continue
      const middle = (t0 + t1) / 2
      const middleAcross = fromAcross + (toAcross - fromAcross) * middle
      const shift = Math.floor((middleAcross - sheet.sheetStart) / sheet.circumference + 1e-12) * sheet.circumference
      if (colliding.has(index)) collidingMoveIndices.push(moves.length)
      moves.push({
        ...move,
        from: toolpathPointAt(move.from, move.to, t0, shift, sheet),
        to: toolpathPointAt(move.from, move.to, t1, shift, sheet),
      })
    }
  })
  const folded: T = {
    ...result,
    moves,
    bounds: toolpathBounds(moves),
    ...(result.collidingMoveIndices ? { collidingMoveIndices } : {}),
  }
  return folded
}

/**
 * `foldToolpathToSheet` with the identity kept stable between frames. Both
 * renderers key their per-toolpath caches on object identity, so folding afresh
 * every frame would rebuild every buffer every frame. The wrapped display path
 * it receives is already cached per frame, so it is the key.
 */
const foldCache = new WeakMap<ToolpathResult, { key: string; result: ToolpathResult }>()

export function foldToolpathForDisplay<T extends ToolpathResult>(toolpath: T, sheet: AroundWrapWindow): T {
  const key = `${sheet.axis}:${sheet.sheetStart}:${sheet.circumference}`
  const cached = foldCache.get(toolpath)
  if (cached && cached.key === key) return cached.result as T
  const result = foldToolpathToSheet(toolpath, sheet)
  foldCache.set(toolpath, { key, result })
  return result
}
