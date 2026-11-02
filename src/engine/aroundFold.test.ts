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

import assert from 'node:assert/strict'
import { foldToolpath } from './aroundFold'
import type { AroundFrame } from './aroundFrame'
import type { ToolpathMove, ToolpathResult } from './toolpaths/types'

const length = (move: ToolpathMove): number => Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y, move.to.z - move.from.z)
const path = (moves: ToolpathMove[], collidingMoveIndices?: number[]): ToolpathResult => ({ operationId: 'fold', moves, bounds: null, warnings: [], collidingMoveIndices })

for (const axis of ['x', 'y'] as const) {
  const frame: AroundFrame = { axis, centre: 17, radius: 10, zero: 13, sheetStart: -7, circumference: 40 }
  const across = axis === 'x' ? 'y' : 'x'
  const point = (along: number, offset: number, z = 6): { x: number; y: number; z: number } => axis === 'x'
    ? { x: along, y: frame.sheetStart + offset, z }
    : { x: frame.sheetStart + offset, y: along, z }
  for (const sign of [1, -1]) {
    const move: ToolpathMove = { kind: 'lead_in', feedScale: 0.4, source: 'seam', from: point(3, 0, 8), to: point(53, sign * 100, 3) }
    const folded = foldToolpath(path([move], [0]), frame)
    assert.equal(folded.moves.length, 3, `${axis}/${sign}: 2.5 turns is three pieces`)
    assert.deepEqual(folded.collidingMoveIndices, [0, 1, 2], 'collision indices follow every piece')
    assert(Math.abs(folded.moves.reduce((sum, piece) => sum + length(piece), 0) - length(move)) < 1e-9, 'fold preserves total 3D length')
    for (const [i, piece] of folded.moves.entries()) {
      assert.equal(piece.kind, 'lead_in')
      assert.equal(piece.feedScale, 0.4)
      assert.equal(piece.source, 'seam')
      for (const p of [piece.from, piece.to]) assert(p[across] >= -7 && p[across] <= 33, 'every piece stays inside first turn')
      if (i) {
        const previous = folded.moves[i - 1].to
        assert.equal(previous[across], sign > 0 ? 33 : -7, 'arriving side of seam')
        assert.equal(piece.from[across], sign > 0 ? -7 : 33, 'departing side of seam')
        const along = axis === 'x' ? 'x' : 'y'
        assert.equal(previous[along], piece.from[along])
        assert.equal(previous.z, piece.from.z)
      }
    }
    assert.equal(folded.bounds?.minZ, 3)
    assert.equal(folded.bounds?.maxZ, 8)
    assert.equal(axis === 'x' ? folded.bounds?.minY : folded.bounds?.minX, -7)
    assert.equal(axis === 'x' ? folded.bounds?.maxY : folded.bounds?.maxX, 33)
  }
  const ending: ToolpathMove = { kind: 'cut', from: point(5, 10), to: point(10, 40) }
  const foldedEnding = foldToolpath(path([ending]), frame)
  assert.equal(foldedEnding.moves.length, 1, 'ending exactly at first seam is not split')
  assert.deepEqual(foldedEnding.moves[0].from, { ...ending.from, a: -90 }, 'a first-turn start carries its program angle from the zero line')
  assert.deepEqual(foldedEnding.moves[0].to, { ...ending.to, a: 180 }, 'the first seam reads half a turn from the zero line, not zero')
  const outsideEnding = { ...ending, from: point(5, 50), to: point(10, 80) }
  assert.equal(foldToolpath(path([outsideEnding]), frame).moves.length, 1, 'later seam endpoint is not split')
  const starting = foldToolpath(path([{ ...ending, from: point(5, 40), to: point(10, 55) }]), frame)
  assert.equal(starting.moves[0].from[across], -7, 'starting on seam and going up starts at low edge')
  const inside = path([ending, { kind: 'plunge', from: point(5, 20, 10), to: point(5, 20, 4) }])
  const foldedInside = foldToolpath(inside, frame)
  const geometry = (moves: readonly ToolpathMove[]): number[][] => moves.map((move) => [
    move.from.x, move.from.y, move.from.z, move.to.x, move.to.y, move.to.z,
  ])
  assert.deepEqual(geometry(foldedInside.moves), geometry(inside.moves), 'first-turn toolpath geometry is unchanged')
  assert(
    foldedInside.moves.every((move) => [move.from, move.to].every((p) => typeof p.a === 'number' && p.a >= -180 && p.a <= 360)),
    'and every first-turn point still carries its program angle from the zero line',
  )
  const vertical = foldToolpath(path([{ kind: 'plunge', from: point(5, 90, 9), to: point(5, 90, 2) }]), frame)
  assert.equal(vertical.moves[0].from[across], frame.sheetStart + 10)
  assert.equal(vertical.moves[0].to.z, 2)
  const alongOnly = foldToolpath(path([{ kind: 'rapid', from: point(3, -50), to: point(30, -50) }]), frame)
  assert.equal(alongOnly.moves.length, 1)
  assert.equal(alongOnly.moves[0].from[across], frame.sheetStart + 30)
  const mixed = foldToolpath(path([ending, { ...ending, from: point(3, 0), to: point(53, 100) }], [1]), frame)
  assert.deepEqual(mixed.collidingMoveIndices, [1, 2, 3], 'noncolliding preceding moves shift the piece indices')
}

// The folded angle is the program's own, unreduced (issue #395): a 1.5-turn
// line reads 0..540, and a seam reads the same angle on both of its sides.
for (const axis of ['x', 'y'] as const) {
  const frame: AroundFrame = { axis, centre: 17, radius: 10, zero: 13, sheetStart: -7, circumference: 40 }
  const point = (along: number, offset: number, z = 6): { x: number; y: number; z: number } => axis === 'x'
    ? { x: along, y: frame.sheetStart + offset, z }
    : { x: frame.sheetStart + offset, y: along, z }
  for (const sign of [1, -1]) {
    const line: ToolpathMove = { kind: 'cut', from: point(3, 0), to: point(53, sign * 1.5 * frame.circumference) }
    const folded = foldToolpath(path([line]), frame)
    const angles = folded.moves.flatMap((piece) => [piece.from.a ?? NaN, piece.to.a ?? NaN])
    assert(angles.every((a) => Number.isFinite(a)), `${axis}/${sign}: every folded point carries an angle`)
    assert.equal(Math.min(...angles), sign > 0 ? -180 : -720, `${axis}/${sign}: 1.5 turns reaches its start angle from the zero line`)
    assert.equal(Math.max(...angles), sign > 0 ? 360 : -180, `${axis}/${sign}: 1.5 turns spans one and a half turns, unreduced`)
    for (const [i, piece] of folded.moves.entries()) {
      if (i) assert.equal(folded.moves[i - 1].to.a, piece.from.a, `${axis}/${sign}: both sides of a seam read the same angle`)
    }
  }
}
// The pre-#1112-rt2-e fold, kept as the reference the current implementation
// must reproduce exactly (issue #1112 rt2-e). The optimization that removed the
// per-piece closure allocates nothing extra and changes no arithmetic, so every
// value — including the unreduced angle and the seam-snapped across coordinate —
// has to be identical. If this comparison is ever loosened to a tolerance, the
// guard is gone: fold feeds the simulation's seam copies and export's angles, and
// both must not drift.
function referenceFold<T extends ToolpathResult>(result: T, frame: AroundFrame): T {
  const axis = frame.axis === 'x' ? 'y' : 'x'
  const start = frame.sheetStart
  const zero = frame.zero
  const period = frame.circumference
  const end = start + period
  const boundsOf = (moves: readonly ToolpathMove[]): ToolpathResult['bounds'] => {
    if (!moves.length) return null
    const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }
    for (const move of moves) for (const p of [move.from, move.to]) {
      bounds.minX = Math.min(bounds.minX, p.x)
      bounds.maxX = Math.max(bounds.maxX, p.x)
      bounds.minY = Math.min(bounds.minY, p.y)
      bounds.maxY = Math.max(bounds.maxY, p.y)
      bounds.minZ = Math.min(bounds.minZ, p.z)
      bounds.maxZ = Math.max(bounds.maxZ, p.z)
    }
    return bounds
  }
  const angle = (across: number): number => 360 * (across - zero) / period
  if (result.moves.every((move) => [move.from, move.to].every((p) => p[axis] >= start && p[axis] <= end))) {
    const moves = result.moves.map((move) => ({
      ...move,
      from: { ...move.from, a: angle(move.from[axis]) },
      to: { ...move.to, a: angle(move.to[axis]) },
    }))
    return { ...result, moves, bounds: boundsOf(moves) }
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
        if (fraction > 1e-12 && fraction < 1 - 1e-12) fractions.push(fraction)
      }
    }
    fractions.sort((a, b) => a - b)
    for (let i = 1; i < fractions.length; i++) {
      const t0 = fractions[i - 1]
      const t1 = fractions[i]
      const middle = from + (to - from) * (t0 + t1) / 2
      const shift = Math.floor((middle - start) / period) * period
      const at = (t: number): { x: number; y: number; z: number; a: number; [key: string]: number } => {
        const across = move.from[axis] + (move.to[axis] - move.from[axis]) * t
        const p = {
          ...move.from,
          x: move.from.x + (move.to.x - move.from.x) * t,
          y: move.from.y + (move.to.y - move.from.y) * t,
          z: move.from.z + (move.to.z - move.from.z) * t,
          a: angle(across),
        } as { x: number; y: number; z: number; a: number; [key: string]: number }
        p[axis] = across - shift
        if (Math.abs(p[axis] - start) < period * 1e-12) p[axis] = start
        if (Math.abs(p[axis] - end) < period * 1e-12) p[axis] = end
        return p
      }
      const piece = { ...move, from: at(t0), to: at(t1) }
      if (collisions.has(index)) collidingMoveIndices.push(moves.length)
      moves.push(piece)
    }
  })
  return {
    ...result, moves, bounds: boundsOf(moves),
    ...(result.collidingMoveIndices ? { collidingMoveIndices } : {}),
  }
}

for (const axis of ['x', 'y'] as const) {
  const frame: AroundFrame = { axis, centre: 17, radius: 10, zero: 13, sheetStart: -7, circumference: 40 }
  // A many-move sheet path that crosses seams in both directions, ramps in Z and
  // carries motion metadata, plus the seam endpoint cases the equality must hold
  // for. 400 moves makes the sweep representative without a timing test.
  const moves: ToolpathMove[] = []
  for (let i = 0; i < 400; i += 1) {
    const offsetFrom = -60 + i * 0.4
    const offsetTo = offsetFrom + (i % 3 === 0 ? -1.3 : 0.55)
    const along = 3 + i * 0.05
    const point = (alongAt: number, offset: number, z: number): { x: number; y: number; z: number } => axis === 'x'
      ? { x: alongAt, y: frame.sheetStart + offset, z }
      : { x: frame.sheetStart + offset, y: alongAt, z }
    moves.push({
      kind: i % 7 === 0 ? 'rapid' : 'cut',
      feedScale: i % 5 === 0 ? 0.6 : undefined,
      from: point(along, offsetFrom, 9 - (i % 11) * 0.1),
      to: point(along + 0.3, offsetTo, 8.5 + (i % 13) * 0.1),
    })
  }
  const colliding = moves.map((_, index) => index).filter((index) => index % 37 === 0)
  const source = path(moves, colliding)
  assert.deepEqual(foldToolpath(source, frame), referenceFold(source, frame), `${axis}: the fold reproduces its pre-optimization result exactly`)
  // The all-inside fast path too, so both branches of the fold are held.
  const inside = path(moves.filter((_, index) => index < 20).map((move) => ({ ...move, from: { x: 5, y: 6, z: move.from.z }, to: { x: 6, y: 7, z: move.to.z } })))
  assert.deepEqual(foldToolpath(inside, frame), referenceFold(inside, frame), `${axis}: the inside-sheet path reproduces its pre-optimization result exactly`)
}

console.log('aroundFold tests passed')
