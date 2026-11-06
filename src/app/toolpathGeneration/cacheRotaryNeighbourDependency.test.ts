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
 * real generator and, for the store path, through the shipped generation service
 * (#1155 rn-b, corrected in fix 1).
 *
 * Since rn-a an around-the-bar rotary rough or finish samples every STL model
 * whose along extent overlaps its cut range. The cache never modelled that read:
 * `operationFootprint` was the target's own box grown by two tool diameters,
 * which on a thin turning target covers only a little of the bar's cross-section.
 * A Hex standing on the far side of the bar, outside that grown box but still
 * overlapping the Turn's along span, could be moved with the cached Turn path
 * staying "valid" — and served, cutting the Hex's old shape.
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
 * Two corrections ride on top of that original shape:
 *
 * - **Fix 1, across the bar is unbounded.** The generator's neighbour cull is
 *   along-only, and Y on the Around face is the unrolled sheet's across
 *   coordinate (one circumference wide), not the stock's rectangle. A Hex moved
 *   to across 15 on a Ø20 bar is outside that rectangle and still sampled; a
 *   stock-clipped footprint called both cache checks valid. Section 5 is the
 *   repro, with the fresh hashes to prove the miss was a wrong path.
 * - **Fix 1, the store and the service.** Sections 1–5 call the generator
 *   directly. Section 6 loads the fixture into `useProjectStore`, generates
 *   both Turn operations through `createToolpathGenerationService` (inline
 *   executor) and requires both cached entries, moves the Hex with the store's
 *   own drag-move gesture (`startMoveFeature` →
 *   `setPendingMoveFrom` → `completePendingMove`), and asks the service again:
 *   the rough and the finish it returns must each equal a fresh generation of
 *   the edited project. Without a footprint that sees the move the service
 *   answers from its cache with the pre-move path.
 *
 * Mutations this file is checked with (applied, seen to fail, and restored):
 * restore the target-bbox footprint for the rotary kinds -> sections 1–4 fail;
 * restore the stock-clipped across bound -> section 5 and section 6's returned-
 * path checks fail; drop section 6's finish request -> the both-cached check
 * fails, because acceptance 2 is about both Turn operations being generated.
 *
 * Run with: npx tsx src/app/toolpathGeneration/cacheRotaryNeighbourDependency.test.ts
 */

import { createHash } from 'node:crypto'
import type { Operation, Project } from '../../types/project'
import type { ProjectStore } from '../../store/types'
import { useProjectStore } from '../../store/projectStore'
import { rotaryBoltFixture, rotaryBoltOperation, translateAcrossBar } from '../../test/rotaryBoltFixture'
import { computeOperationToolpath } from '../../engine/toolpaths/generateOperation'
import { diffToolpathInputs } from '../../engine/toolpaths/toolpathDependencies'
import type { ToolpathMove } from '../../engine/toolpaths/types'
import { captureCacheInputs, cacheInputsValid } from './cacheInputs'
import { createToolpathGenerationService, type GenerationContext } from './service'

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

// ── 5. Fix 1: a neighbour outside the stock rectangle ────────────────
//
// Y on the Around face is the unrolled sheet's across coordinate (one
// circumference wide, centred on the bar's centreline), not the stock's across
// extent, and the generator's neighbour cull is along-only. A Hex at across 15
// on a Ø20 bar is outside the stock rectangle (0..20) and squarely on the sheet;
// the stock-clipped footprint this slice first shipped reported both cache
// checks valid while the sampled surface had moved. This is the review's repro.
{
  const far = rotaryBoltFixture({ hexAcross: 15 })
  const farRough: Operation = {
    ...rotaryBoltOperation(far.project, [far.turnId], 'rotary_rough'),
    id: 'far-rough',
    name: 'Far turn rough',
  }
  const farFinish: Operation = {
    ...rotaryBoltOperation(far.project, [far.turnId], 'rotary_finish'),
    id: 'far-finish',
    name: 'Far turn finish',
  }
  const farProject = withOperations(far.project, [farRough, farFinish])
  const farRoughBefore = generate(farProject, farRough)
  const farFinishBefore = generate(farProject, farFinish)
  const farEdited = translateAcrossBar(farProject, far.hexId, 1.5)
  check(
    'fix 1 - the far-side rough invalidates when its neighbour moves across the sheet',
    !cacheInputsValid(captureCacheInputs(farProject, farRough), farRough, farEdited),
    'the Hex is on the sheet and overlaps the along span, so the generator samples it',
  )
  check(
    'fix 1 - the far-side finish invalidates when its neighbour moves across the sheet',
    !cacheInputsValid(captureCacheInputs(farProject, farFinish), farFinish, farEdited),
    'the finish reads the same neighbour set',
  )
  // The invalidation is only worth anything if the move really changes the path.
  check(
    'fix 1 - the far-side samples are a genuinely different path',
    movesHash(generate(farEdited, farRough)) !== movesHash(farRoughBefore)
      && movesHash(generate(farEdited, farFinish)) !== movesHash(farFinishBefore),
    'a move that changed no output would make the invalidation untestable',
  )
}

// ── 6. Fix 1: the same path through the store and the service ────────
//
// Sections 1-5 call the generator and the cache predicates directly. The shipped
// path is different: an edit lands through `useProjectStore`, and the result comes
// back from `createToolpathGenerationService`. That service answers a request
// from its cache when `cacheInputsValid` says the entry still holds. This section
// drives exactly that: generate both Turn operations through the service, move
// the Hex with the store's own drag-move gesture (`startMoveFeature` →
// `setPendingMoveFrom` → `completePendingMove`), request the rough again, and
// require the returned moves to equal a fresh generation of the edited project.
async function storeAndServicePath(): Promise<void> {
  const stored = rotaryBoltFixture({ hexAcross: 15 })
  const hexInstance = stored.project.features.find((feature) => feature.id === stored.hexId)
  if (!hexInstance) throw new Error('fixture premise: the Hex row exists')
  const hexDefinition = stored.project.featureDefinitions[hexInstance.definitionId]
  // The fixture's Hex is a *canned* Polygon, and the store's rotary drag projects
  // a canned band along the bar's axis (`rotaryMoveDelta`), so a canned solid
  // cannot be dragged across the sheet — it is always planned centred on the
  // axis. Strip `canned` to leave the same row as an imported model: the mesh
  // asset and profile are unchanged, it is still a `model` neighbour, and its
  // drag is the ordinary free placement `translateAcrossBar` models.
  const importedProject: Project = {
    ...stored.project,
    featureDefinitions: {
      ...stored.project.featureDefinitions,
      [hexInstance.definitionId]: { ...hexDefinition, canned: undefined },
    },
  }
  const storedRough: Operation = {
    ...rotaryBoltOperation(importedProject, [stored.turnId], 'rotary_rough'),
    id: 'store-rough',
    name: 'Store turn rough',
  }
  const storedFinish: Operation = {
    ...rotaryBoltOperation(importedProject, [stored.turnId], 'rotary_finish'),
    id: 'store-finish',
    name: 'Store turn finish',
  }
  const storedProject = withOperations(importedProject, [storedRough, storedFinish])
  useProjectStore.setState({
    project: storedProject,
    history: { past: [], future: [], transactionStart: null },
  } as unknown as Partial<ProjectStore>)

  const context = (): GenerationContext => ({
    project: useProjectStore.getState().project,
    documentKey: 1,
  })
  const service = createToolpathGenerationService({
    getCurrentContext: context,
    executor: 'inline',
  })
  try {
    const roughBefore = await service.request(context(), storedRough.id, { purpose: 'export' })
    const finishBefore = await service.request(context(), storedFinish.id, { purpose: 'export' })
    check(
      'the service generates and caches both Turn operations before the edit',
      roughBefore.status === 'completed' && finishBefore.status === 'completed'
        && service.peekCurrent(context(), storedRough.id) !== null
        && service.peekCurrent(context(), storedFinish.id) !== null,
      `rough ${roughBefore.status}, finish ${finishBefore.status}; cached ${service.peekCurrent(context(), storedRough.id) !== null ? 'rough' : 'no rough'} + ${service.peekCurrent(context(), storedFinish.id) !== null ? 'finish' : 'no finish'}`,
    )
    const roughHashBefore = roughBefore.status === 'completed' ? movesHash(roughBefore.result.moves) : ''
    const finishHashBefore = finishBefore.status === 'completed' ? movesHash(finishBefore.result.moves) : ''

    const hexRow = storedProject.features.find((feature) => feature.id === stored.hexId)
    if (!hexRow) throw new Error('fixture premise: the Hex row exists in the store')
    // Move the Hex through the store's own drag-move gesture: start the move on
    // the feature, anchor it, then commit a 1.5 mm across-the-bar translation.
    // This is the path a user's move takes, not a hand-built project variant.
    useProjectStore.getState().startMoveFeature(stored.hexId)
    useProjectStore.getState().setPendingMoveFrom({ x: 0, y: 0 })
    useProjectStore.getState().completePendingMove({ x: 0, y: 1.5 })
    const editedProject = useProjectStore.getState().project
    const hexAfter = editedProject.features.find((feature) => feature.id === stored.hexId)
    check(
      'the store move gesture moves the Hex across the sheet and nothing else',
      editedProject !== storedProject
        && hexAfter !== undefined
        && hexAfter.transform.f === hexRow.transform.f + 1.5
        && editedProject.features.length === storedProject.features.length,
      'the edit must be one row, or the cache test would pass for the wrong reason',
    )
    // Premise: this is a per-feature move, not a project-wide invalidation
    // (`invalidatesEveryOperation` would bypass the footprint entirely).
    const diff = diffToolpathInputs(storedProject, editedProject)
    check(
      'the store edit is a single-feature change, so the footprint decides',
      !diff.invalidatesEveryOperation
        && diff.changedFeatureIds.size === 1
        && diff.changedFeatureIds.has(stored.hexId),
      `changed ${[...diff.changedFeatureIds].join(',')}, every-operation ${diff.invalidatesEveryOperation}`,
    )

    const regeneratedRough = await service.request(context(), storedRough.id, { purpose: 'export' })
    const regeneratedFinish = await service.request(context(), storedFinish.id, { purpose: 'export' })
    check(
      'the service regenerates the rough instead of serving the pre-move path',
      regeneratedRough.status === 'completed' && movesHash(regeneratedRough.result.moves) !== roughHashBefore,
      `outcome ${regeneratedRough.status}`,
    )
    check(
      'the service regenerates the finish instead of serving the pre-move path',
      regeneratedFinish.status === 'completed' && movesHash(regeneratedFinish.result.moves) !== finishHashBefore,
      `outcome ${regeneratedFinish.status}`,
    )
    // Fresh generation of the edited project: a deep copy, so no generator-side
    // identity cache from the service's run can be recycled.
    const freshProject = structuredClone(useProjectStore.getState().project)
    const freshRough = freshProject.operations.find((operation) => operation.id === storedRough.id)
    const freshFinish = freshProject.operations.find((operation) => operation.id === storedFinish.id)
    check(
      'the service-returned rough equals a fresh generation (same moves hash)',
      regeneratedRough.status === 'completed' && freshRough !== undefined
        && movesHash(regeneratedRough.result.moves) === movesHash(generate(freshProject, freshRough)),
      regeneratedRough.status === 'completed' ? `returned ${movesHash(regeneratedRough.result.moves)}` : 'no result',
    )
    check(
      'the service-returned finish equals a fresh generation (same moves hash)',
      regeneratedFinish.status === 'completed' && freshFinish !== undefined
        && movesHash(regeneratedFinish.result.moves) === movesHash(generate(freshProject, freshFinish)),
      regeneratedFinish.status === 'completed' ? `returned ${movesHash(regeneratedFinish.result.moves)}` : 'no result',
    )
    if (regeneratedRough.status === 'completed' && regeneratedFinish.status === 'completed') {
      console.log(`   store rough sha256 ${roughHashBefore.slice(0, 16)} → ${movesHash(regeneratedRough.result.moves).slice(0, 16)}`)
      console.log(`   store finish sha256 ${finishHashBefore.slice(0, 16)} → ${movesHash(regeneratedFinish.result.moves).slice(0, 16)}`)
    }
  } finally {
    service.dispose()
  }
}

void storeAndServicePath()
  .catch((error: unknown) => {
    failed += 1
    console.log(`   ✗ store/service path threw: ${error instanceof Error ? error.message : String(error)}`)
  })
  .then(() => {
    console.log(`\n${passed} passed, ${failed} failed`)
    if (failed > 0) process.exit(1)
  })
