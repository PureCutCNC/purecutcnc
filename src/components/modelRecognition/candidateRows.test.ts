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
 * The Find pockets and holes dialog's decisions (issue #1206): which rows
 * start checked, what is drawn for a set of checked rows, a row's size, and
 * the not-drawn summary.
 *
 * Mutation checks (each made the named block fail, then was reverted):
 * - `defaultCheckedIds` includes islands                 -> default checks
 * - `defaultCheckedIds` includes solids                  -> default checks
 * - `defaultCheckedIds` ignores `alreadyDrawn`           -> default checks
 * - `shapesToDraw` reads an island's own id              -> boss follows pocket
 * - `shapesToDraw` draws an already-drawn island         -> boss follows pocket
 * - `candidateSize` returns the radius                   -> size
 * - `skippedCounts` keeps zero counts                    -> not drawn
 *
 * Run with: npx tsx src/components/modelRecognition/candidateRows.test.ts
 */

import type { RecognitionCandidate, SkippedCavity } from '../../engine/modelRecognition'
import { circleProfile, rectProfile } from '../../types/project'
import { candidateSize, defaultCheckedIds, shapesToDraw, skippedCounts, solidSkippedCounts } from './candidateRows'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function candidate(patch: Partial<RecognitionCandidate> & { id: string }): RecognitionCandidate {
  return {
    parentId: null,
    face: 'top',
    kind: 'pocket',
    operation: 'subtract',
    profile: rectProfile(0, 0, 20, 10),
    outline: [{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 }],
    circle: null,
    zTop: 20,
    zBottom: 12,
    bottom: 'flat',
    flaredAbove: false,
    alreadyDrawn: false,
    ...patch,
  }
}

const solid = candidate({
  id: 's0', kind: 'solid', operation: 'add',
  profile: rectProfile(0, 0, 60, 40),
  outline: [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 40 }, { x: 0, y: 40 }],
  zTop: 20, zBottom: 0, bottom: null,
})
const pocket = candidate({ id: 'c0' })
const boss = candidate({
  id: 'c0.i0', parentId: 'c0', kind: 'island', operation: 'add',
  profile: circleProfile(10, 5, 2), circle: { center: { x: 10, y: 5 }, radius: 2 }, zTop: 16, bottom: null,
})
const hole = candidate({
  id: 'c1', kind: 'throughHole', profile: circleProfile(40, 10, 3),
  circle: { center: { x: 40, y: 10 }, radius: 3 }, zBottom: 0, bottom: 'through',
})
const drawnHole = candidate({ ...hole, id: 'c2', alreadyDrawn: true })
const rows = [solid, pocket, boss, hole, drawnHole]
const name = (row: RecognitionCandidate): string => row.id

// Default checks: cavities not yet drawn; a boss has no box of its own, and a
// solid is unchecked because most runs only want the pockets.
{
  assert(defaultCheckedIds(rows).join(',') === 'c0,c1', `default checks: got ${defaultCheckedIds(rows).join(',')}`)
}

// A checked solid is drawn before the cavities: it is the body they cut.
{
  assert(!defaultCheckedIds(rows).includes('s0'), 'solid first: a solid is never checked by default')
  const all = shapesToDraw(rows, new Set(['s0', 'c0', 'c1']), name)
  assert(all.map((shape) => shape.name).join(',') === 's0,c0,c0.i0,c1', `solid first: got ${all.map((shape) => shape.name).join(',')}`)
  assert(all[0].operation === 'add' && all[0].zTop === 20 && all[0].zBottom === 0, 'solid first: it adds the whole body')
}

// A boss follows its pocket, whatever is in the checked set under its own id.
{
  const both = shapesToDraw(rows, new Set(['c0', 'c1']), name)
  assert(both.map((shape) => shape.name).join(',') === 'c0,c0.i0,c1', 'boss follows pocket: pocket, its boss, then the hole')
  assert(both[1].operation === 'add' && both[1].zTop === 16 && both[1].zBottom === 12, 'boss follows pocket: the boss keeps its own span')

  const holeOnly = shapesToDraw(rows, new Set(['c1', 'c0.i0']), name)
  assert(holeOnly.map((shape) => shape.name).join(',') === 'c1', 'boss follows pocket: no pocket, no boss')

  // A pocket drawn again after its span was edited must not double its boss.
  const bossDrawn = rows.map((row) => (row.id === 'c0.i0' ? { ...row, alreadyDrawn: true } : row))
  const again = shapesToDraw(bossDrawn, new Set(['c0']), name)
  assert(again.map((shape) => shape.name).join(',') === 'c0', 'boss follows pocket: an already-drawn boss is not drawn twice')

  assert(shapesToDraw(rows, new Set(), name).length === 0, 'boss follows pocket: nothing checked, nothing drawn')
}

// Size: a diameter for a circle, the outline's box otherwise.
{
  const round = candidateSize(hole)
  assert(round.kind === 'diameter' && round.diameter === 6, 'size: a hole reads as its diameter')
  const box = candidateSize(pocket)
  assert(box.kind === 'box' && box.width === 20 && box.height === 10, 'size: a pocket reads as its box')
}

// Not drawn: counted per reason, in a fixed order, with nothing at zero.
{
  const entry = (reason: SkippedCavity['reason']): SkippedCavity => ({ reason, outline: [], zBottom: 0, zTop: 1 })
  const counts = skippedCounts([entry('undercut'), entry('taperedWalls'), entry('undercut')])
  assert(
    JSON.stringify(counts) === JSON.stringify([{ reason: 'taperedWalls', count: 1 }, { reason: 'undercut', count: 2 }]),
    `not drawn: got ${JSON.stringify(counts)}`,
  )
  assert(skippedCounts([]).length === 0, 'not drawn: nothing skipped, nothing listed')
  assert(
    JSON.stringify(solidSkippedCounts([entry('undercut'), entry('openMesh')]))
      === JSON.stringify([{ reason: 'undercut', count: 1 }, { reason: 'openMesh', count: 1 }]),
    'not drawn: the bodies are counted under their own list, in the same order',
  )
}

console.log('modelRecognition/candidateRows.test.ts: all assertions passed')
