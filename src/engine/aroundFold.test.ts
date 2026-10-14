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
  const frame: AroundFrame = { axis, centre: 17, radius: 10, sheetStart: -7, circumference: 40 }
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
  assert.deepEqual(foldedEnding.moves[0].from, { ...ending.from, a: 90 }, 'a first-turn start carries its program angle')
  assert.deepEqual(foldedEnding.moves[0].to, { ...ending.to, a: 360 }, 'the first seam reads a full 360, not zero')
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
    foldedInside.moves.every((move) => [move.from, move.to].every((p) => typeof p.a === 'number' && p.a >= 0 && p.a <= 360)),
    'and every first-turn point still carries its program angle',
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
  const frame: AroundFrame = { axis, centre: 17, radius: 10, sheetStart: -7, circumference: 40 }
  const point = (along: number, offset: number, z = 6): { x: number; y: number; z: number } => axis === 'x'
    ? { x: along, y: frame.sheetStart + offset, z }
    : { x: frame.sheetStart + offset, y: along, z }
  for (const sign of [1, -1]) {
    const line: ToolpathMove = { kind: 'cut', from: point(3, 0), to: point(53, sign * 1.5 * frame.circumference) }
    const folded = foldToolpath(path([line]), frame)
    const angles = folded.moves.flatMap((piece) => [piece.from.a ?? NaN, piece.to.a ?? NaN])
    assert(angles.every((a) => Number.isFinite(a)), `${axis}/${sign}: every folded point carries an angle`)
    assert.equal(Math.min(...angles), sign > 0 ? 0 : -540, `${axis}/${sign}: 1.5 turns reaches its start angle`)
    assert.equal(Math.max(...angles), sign > 0 ? 540 : 0, `${axis}/${sign}: 1.5 turns reads 540, not one turn`)
    for (const [i, piece] of folded.moves.entries()) {
      if (i) assert.equal(folded.moves[i - 1].to.a, piece.from.a, `${axis}/${sign}: both sides of a seam read the same angle`)
    }
  }
}
console.log('aroundFold tests passed')
