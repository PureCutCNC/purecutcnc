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
 * Unit tests for applyClampWarnings — collision detection, auto-lift of
 * rapids, and per-move collision tagging (collidingMoveIndices).
 *
 * Run with: npx tsx src/engine/toolpaths/clamps.test.ts
 */

import type { Clamp, Project } from '../../types/project'
import { newProject } from '../../types/project'
import type { ToolpathMove, ToolpathResult } from './types'
import { applyClampWarnings } from './clamps'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

// mm project: clampClearanceXY = 2, clampClearanceZ = 5, maxTravelZ = 50.
// Clamp 10..20 x 10..20, height 5 → expanded rect 8..22 x 8..22, requiredZ 10.
function makeProjectWithClamp(): Project {
  const project = newProject('clamp-test', 'mm')
  const clamp: Clamp = {
    id: 'clamp-1',
    name: 'Front clamp',
    type: 'step_clamp',
    x: 10,
    y: 10,
    w: 10,
    h: 10,
    height: 5,
    visible: true,
  }
  project.clamps.push(clamp)
  return project
}

function move(kind: ToolpathMove['kind'], fromZ: number, toZ: number, fromX = 0, toX = 40): ToolpathMove {
  return {
    kind,
    from: { x: fromX, y: 15, z: fromZ },
    to: { x: toX, y: 15, z: toZ },
  }
}

function makeResult(moves: ToolpathMove[]): ToolpathResult {
  return { operationId: 'op-1', moves, warnings: [], bounds: null }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

function testNoClampsReturnsResultUnchanged() {
  const project = newProject('no-clamps', 'mm')
  const result = makeResult([move('cut', -1, -1)])
  const out = applyClampWarnings(project, result)
  assert(out === result, 'result is returned as-is when project has no clamps')
  assert(out.collidingMoveIndices === undefined, 'no collidingMoveIndices without clamps')
  console.log('no clamps → unchanged: PASSED')
}

function testSafeMoveAboveClearanceNotFlagged() {
  const project = makeProjectWithClamp()
  const result = makeResult([move('rapid', 20, 20)])
  const out = applyClampWarnings(project, result)
  assert(out === result, 'move above required clearance Z is untouched')
  console.log('safe move above clearance: PASSED')
}

function testCollidingCutIsTaggedAndWarned() {
  const project = makeProjectWithClamp()
  const result = makeResult([move('cut', -1, -1)])
  const out = applyClampWarnings(project, result)
  assert(out.warnings.some((w) => w.includes('Front clamp')), 'warning names the clamp')
  assert((out.collidingClampIds ?? []).includes('clamp-1'), 'clamp id reported')
  assert((out.collidingMoveIndices ?? []).length === 1, 'one colliding move tagged')
  assert((out.collidingMoveIndices ?? [])[0] === 0, 'colliding move index refers to the cut')
  console.log('colliding cut tagged + warned: PASSED')
}

function testAutoLiftedRapidIsNotTagged() {
  const project = makeProjectWithClamp()
  const result = makeResult([move('rapid', 2, 2)])
  const out = applyClampWarnings(project, result)
  assert(out.moves.length === 3, 'rapid is lifted into up/traverse/down moves')
  assert(out.moves[1].from.z === 10 && out.moves[1].to.z === 10, 'traverse at required clearance Z')
  assert((out.collidingMoveIndices ?? []).length === 0, 'auto-lifted rapid is resolved, not tagged')
  assert((out.collidingClampIds ?? []).includes('clamp-1'), 'clamp id still reported for the lift')
  console.log('auto-lifted rapid not tagged: PASSED')
}

function testIndicesReferToAdjustedMovesArray() {
  const project = makeProjectWithClamp()
  // Move 0: auto-liftable rapid (expands to 3 output moves).
  // Move 1: colliding cut → lands at output index 3.
  const result = makeResult([move('rapid', 2, 2), move('cut', -1, -1)])
  const out = applyClampWarnings(project, result)
  assert(out.moves.length === 4, 'lifted rapid (3) + cut (1)')
  assert((out.collidingMoveIndices ?? []).length === 1, 'only the cut is tagged')
  const index = (out.collidingMoveIndices ?? [])[0]
  assert(index === 3, `index refers to adjusted array (expected 3, got ${index})`)
  assert(out.moves[index].kind === 'cut', 'tagged move is the cut')
  console.log('indices refer to adjusted moves: PASSED')
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

try {
  testNoClampsReturnsResultUnchanged()
  testSafeMoveAboveClearanceNotFlagged()
  testCollidingCutIsTaggedAndWarned()
  testAutoLiftedRapidIsNotTagged()
  testIndicesReferToAdjustedMovesArray()
  console.log('\nAll clamp tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
