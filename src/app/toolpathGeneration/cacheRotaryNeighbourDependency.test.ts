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
 * The toolpath cache's rotary neighbour-model dependency, end to end through the
 * real generator (#1155 rn-b).
 *
 * Since rn-a an around-the-bar rotary rough or finish samples every STL model on
 * the bar whose along extent overlaps its cut range. The cache never modelled
 * that read: `operationFootprint` was the target's own box grown by two tool
 * diameters, which on a thin turning target covers only a little of the bar's
 * cross-section. A Hex standing on the far side of the bar, outside that grown
 * box but still overlapping the Turn's along span, could be moved with the
 * cached Turn path staying "valid" — and served, cutting the Hex's old shape.
 *
 * This drives the shipped pipeline, not a stand-in: `captureCacheInputs` (what a
 * submission stamps), `cacheInputsValid` (the hit test), and
 * `computeOperationToolpath` (the rotary generator). Both Turn operations are
 * generated on the unedited project, the Hex is moved across the bar, and the
 * cached entries must be reported stale. The regenerated rough must equal a
 * fresh generation of the edited project — the moves hash — and must differ from
 * the stale one, which is what makes the stale entry a wrong toolpath rather
 * than a harmless one.
 *
 * Mutation this file is checked with (applied, seen to fail, and restored):
 * restore the target-bbox footprint for the rotary kinds -> the two "invalidates"
 * checks fail, because the moved Hex never touches the grown target box.
 *
 * Run with: npx tsx src/app/toolpathGeneration/cacheRotaryNeighbourDependency.test.ts
 */

import { createHash } from 'node:crypto'
import type { Operation, Project } from '../../types/project'
import { rotaryBoltFixture, rotaryBoltOperation, translateAcrossBar } from '../../test/rotaryBoltFixture'
import { computeOperationToolpath } from '../../engine/toolpaths/generateOperation'
import type { ToolpathMove } from '../../engine/toolpaths/types'
import { captureCacheInputs, cacheInputsValid } from './cacheInputs'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) { passed += 1; console.log(`   ✓ ${name}`); return }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

/** The moves of one operation as the generator emits them. */
function generate(project: Project, operation: Operation): readonly ToolpathMove[] {
  const envelope = computeOperationToolpath(project, operation)
  if (!envelope) throw new Error(`${operation.kind} ${operation.id} did not dispatch to the rotary generator`)
  return envelope.result.moves
}

/** One short identity for a move stream, so a failure prints one line. */
function movesHash(moves: readonly ToolpathMove[]): string {
  return createHash('sha256').update(JSON.stringify(moves)).digest('hex')
}

/** The project with its operations attached, as the store holds them. */
function withOperations(project: Project, operations: Operation[]): Project {
  return { ...project, operations }
}

console.log('\nToolpath cache: a rotary operation depends on neighbour models across the bar')

// The Hex starts on the far side of the bar (across +6), which is the geometry
// the pre-rn-b footprint missed: its box is well clear of the Turn's, but it is
// real material on the bar, overlapping the Turn's along span. A centred Hex
// would be reported relevant before the move as well (the hit test measures both
// snapshots), so it could not show the hole this test exists for.
const base = rotaryBoltFixture({ hexAcross: 6 })
// Both operations are planned against a project with no operations, so give them
// ids of their own: `defaultOperationForTarget` numbers them by position, and
// two `op1`s would make the fresh-project lookup below ambiguous.
const rough: Operation = {
  ...rotaryBoltOperation(base.project, [base.turnId], 'rotary_rough'),
  id: 'turn-rough',
  name: 'Turn rough',
}
const finish: Operation = {
  ...rotaryBoltOperation(base.project, [base.turnId], 'rotary_finish'),
  id: 'turn-finish',
  name: 'Turn finish',
}
const project = withOperations(base.project, [rough, finish])

const roughBefore = generate(project, rough)
const finishBefore = generate(project, finish)
const roughHashBefore = movesHash(roughBefore)
const finishHashBefore = movesHash(finishBefore)

// The stamp a real submission would take, before the edit.
const roughInputs = captureCacheInputs(project, rough)
const finishInputs = captureCacheInputs(project, finish)

// The Hex moves 1.5 mm further across the bar: still on the bar, still within
// the Turn's along span, still outside the Turn's own profile box.
const editedProject = translateAcrossBar(project, base.hexId, 1.5)

// ── 1. The cache must not serve the pre-move path ────────────────────
{
  check(
    'the Turn rotary rough invalidates when the Hex moves',
    !cacheInputsValid(roughInputs, rough, editedProject),
    'the Hex is material this rough samples, so the captured entry describes a path that cut its old shape',
  )
  check(
    'the Turn rotary finish invalidates when the Hex moves',
    !cacheInputsValid(finishInputs, finish, editedProject),
    'the finish reads the same neighbour set as the rough',
  )
}

// ── 2. The stale path is genuinely different ─────────────────────────
const roughAfter = generate(editedProject, rough)
const finishAfter = generate(editedProject, finish)
{
  check(
    'the regenerated rough is not the stale path',
    movesHash(roughAfter) !== roughHashBefore,
    'if the move changed nothing, the invalidation above would be untestable here',
  )
  check(
    'the regenerated finish is not the stale path',
    movesHash(finishAfter) !== finishHashBefore,
    'the finish follows the sampled surface, and the sampled surface moved',
  )
}

// ── 3. The regenerated path equals a fresh generation ────────────────
{
  // A fresh project: a deep copy of the edit, so no generator-side cache can be
  // recycling the first run's objects (the joined-mesh and geometry caches key
  // on the geometry identity, which a copy breaks).
  const freshProject = structuredClone(editedProject)
  const freshRough = freshProject.operations.find((operation) => operation.id === rough.id)
  const freshFinish = freshProject.operations.find((operation) => operation.id === finish.id)
  check('the fresh project resolves both operations', freshRough !== undefined && freshFinish !== undefined, 'fixture premise')
  if (freshRough && freshFinish) {
    check(
      'the regenerated rough equals a fresh generation (same moves hash)',
      movesHash(generate(freshProject, freshRough)) === movesHash(roughAfter),
      `hash ${movesHash(roughAfter)}`,
    )
    check(
      'the regenerated finish equals a fresh generation (same moves hash)',
      movesHash(generate(freshProject, freshFinish)) === movesHash(finishAfter),
      `hash ${movesHash(finishAfter)}`,
    )
  }
  console.log(`   rough moves ${roughBefore.length} → ${roughAfter.length}, sha256 ${roughHashBefore.slice(0, 16)} → ${movesHash(roughAfter).slice(0, 16)}`)
  console.log(`   finish moves ${finishBefore.length} → ${finishAfter.length}, sha256 ${finishHashBefore.slice(0, 16)} → ${movesHash(finishAfter).slice(0, 16)}`)
}

// ── 4. Control: an untouched project stays valid ─────────────────────
{
  check(
    'control - an unedited project stays a cache hit',
    cacheInputsValid(roughInputs, rough, project) && cacheInputsValid(finishInputs, finish, project),
    'nothing changed, so the entries must survive or the cache is worthless',
  )
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
