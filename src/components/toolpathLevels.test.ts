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

import type { ToolpathMove } from '../engine/toolpaths/types'
import { moveMatchesToolpathLevel, movesAtToolpathLevel, toolpathLevels } from './toolpathLevels'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function cut(fromZ: number, toZ = fromZ): ToolpathMove {
  return { kind: 'cut', from: { x: 0, y: 0, z: fromZ }, to: { x: 10, y: 0, z: toZ } }
}

function testPlanarLevelsAreHighToLow(): void {
  const levels = toolpathLevels({ moves: [cut(-2), cut(0), cut(-1), cut(-1 + 1e-8)] })
  assert(levels.length === 3, 'distinct planar levels are retained')
  assert(levels[0] === 0 && levels[1] === -1 && levels[2] === -2, 'levels are high to low')
}

function testNonPlanarCutsAreIneligible(): void {
  assert(toolpathLevels({ moves: [cut(0), cut(-1, -1.25)] }).length === 0, 'surface-style Z motion is ineligible')
  assert(toolpathLevels({ moves: [cut(-1)] }).length === 0, 'one level has no useful selector')
  assert(toolpathLevels({ moves: [cut(0), cut(-1)] }, { kind: 'finish_surface' }).length === 0, 'waterline and other finish-surface operations stay ineligible')
}

function testLevelFilterKeepsOnlyCompleteLevelMoves(): void {
  const levelMove = cut(-1)
  const transition = { kind: 'rapid' as const, from: { x: 0, y: 0, z: 0 }, to: { x: 0, y: 0, z: -1 } }
  const otherLevel = cut(-2)
  const moves = [levelMove, transition, otherLevel]
  assert(moveMatchesToolpathLevel(levelMove, -1), 'planar move matches its level')
  assert(!moveMatchesToolpathLevel(transition, -1), 'vertical transition is hidden')
  const selected = movesAtToolpathLevel(moves, -1)
  assert(selected.length === 1 && selected[0] === levelMove, 'only selected-level moves remain')
  assert(movesAtToolpathLevel(moves, null) === moves, 'All preserves the original move list')
}

testPlanarLevelsAreHighToLow()
testNonPlanarCutsAreIneligible()
testLevelFilterKeepsOnlyCompleteLevelMoves()
