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
 * Reusing a finished simulation replay (issue #1112 rt2-h).
 *
 * Opening the Simulation tab replays the selected operation, and the playback
 * starting stock replays the operations before it; neither answer depends on
 * the tab being open. These tests pin the two halves of that: a key that
 * describes exactly the work a result is the answer to, and a cache that
 * serves a result only for that key.
 *
 * Mutations these assertions were checked against, each applied to
 * `simulationReuse.ts` on its own and reverted:
 * - dropping the path identity from `sameSimulationReplayKey` (comparing only
 *   operation ids) → "a regenerated path is a different replay" fails;
 * - dropping the project identity → "an edit makes every key a miss" fails;
 * - `remember` no longer dropping another document's entries → "a new document
 *   drops what the old one left" fails;
 * - dropping the capacity bound → "the oldest replay is dropped past the
 *   capacity" fails;
 * - `rememberedReplay` building again when the key is known → "a known replay
 *   is not built again" fails.
 *
 * Run with: npx tsx src/app/simulationReuse.test.ts
 */

import { defaultTool, newProject, rectProfile } from '../types/project'
import type { MachiningSetup, Operation, Project } from '../types/project'
import { createSimulationGrid } from '../engine/simulation/grid'
import type { SimulationResult } from '../engine/simulation/types'
import type { ToolpathBounds, ToolpathMove, ToolpathResult } from '../engine/toolpaths/types'
import {
  rememberedReplay,
  sameSimulationReplayKey,
  simulationReplayEntries,
  SimulationReplayCache,
  type SimulationReplayKey,
} from './simulationReuse'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeProject(name: string): Project {
  const base = newProject(name, 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 100, 80), thickness: 10 }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Flat endmill', diameter: 3 }]
  return base
}

function makeOperation(id: string, setupId: string, overrides: Partial<Operation> = {}): Operation {
  return {
    id, name: id, kind: 'pocket', pass: 'rough', enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'features', featureIds: [] }, toolRef: 't1', setupId,
    stepdown: 2, stepover: 0.4, feed: 800, plungeFeed: 300, rpm: 18000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: true, finishFloor: true, carveDepth: 1, maxCarveDepth: 2,
    cutDirection: 'conventional', machiningOrder: 'level_first',
    ...overrides,
  }
}

function makeToolpath(operationId: string): ToolpathResult {
  const moves: ToolpathMove[] = [{
    kind: 'cut',
    from: { x: 10, y: 10, z: 9 },
    to: { x: 30, y: 10, z: 9 },
  }]
  const bounds: ToolpathBounds = { minX: 10, minY: 10, minZ: 9, maxX: 30, maxY: 10, maxZ: 9 }
  return { operationId, moves, warnings: [], bounds }
}

function makeResult(project: Project): SimulationResult {
  const grid = createSimulationGrid(project, { targetLongAxisCells: 16 })
  return { grid, stats: { removedCellCount: 0, minTopZ: 0, maxRemovedDepth: 0, processedMoveCount: 0 }, warnings: [] }
}

const project = makeProject('reuse')
const setup: MachiningSetup = project.setups[0]!
const pathA = makeToolpath('opA')
const pathB = makeToolpath('opB')

function key(overrides: Partial<SimulationReplayKey> = {}): SimulationReplayKey {
  return {
    project,
    setup,
    detailCells: 200,
    items: [{ operationId: 'opA', toolpath: pathA }],
    ...overrides,
  }
}

function testKeyEquality(): void {
  console.log('Testing a replay key names the project, setup, detail and exact paths...')
  assert(sameSimulationReplayKey(key(), key()), 'the same work keys the same')
  assert(!sameSimulationReplayKey(key(), key({ project: makeProject('reuse') })), 'an edit makes every key a miss')
  assert(!sameSimulationReplayKey(key(), key({ setup: { ...setup } })), 'another setup object is another sheet')

  // A regenerated path is a new object even when the project is unchanged: a
  // backend switch clears and refills the generation cache. It must not read
  // the older replay.
  assert(
    !sameSimulationReplayKey(key(), key({ items: [{ operationId: 'opA', toolpath: makeToolpath('opA') }] })),
    'a regenerated path is a different replay',
  )
  assert(
    !sameSimulationReplayKey(key(), key({ items: [{ operationId: 'opA', toolpath: pathB }] })),
    'another operation path is a different replay',
  )
  assert(
    !sameSimulationReplayKey(key(), key({ items: [{ operationId: 'opZ', toolpath: pathA }] })),
    'the same path under another operation id is a different replay',
  )
  assert(
    !sameSimulationReplayKey(key(), key({ items: [{ operationId: 'opA', toolpath: pathA }, { operationId: 'opB', toolpath: pathB }] })),
    'an extra replayed operation is a different replay',
  )
  // Cut order is part of the work.
  assert(
    !sameSimulationReplayKey(
      key({ items: [{ operationId: 'opA', toolpath: pathA }, { operationId: 'opB', toolpath: pathB }] }),
      key({ items: [{ operationId: 'opB', toolpath: pathB }, { operationId: 'opA', toolpath: pathA }] }),
    ),
    'the same operations in another order are a different replay',
  )
  assert(
    !sameSimulationReplayKey(key(), key({ detailCells: 201 })),
    'the grid detail is a different replay',
  )
}

function testEntries(): void {
  console.log('Testing the entries of an operation list follow its order and skip missing paths...')
  const operations = [
    makeOperation('opA', setup.id),
    makeOperation('opB', setup.id),
    makeOperation('opC', setup.id),
  ]
  const entries = simulationReplayEntries(operations, new Map([['opC', pathB], ['opA', pathA]]))
  assert(
    entries.length === 2 && entries[0].operationId === 'opA' && entries[1].operationId === 'opC',
    `cut order, missing paths skipped, got ${JSON.stringify(entries.map((entry) => entry.operationId))}`,
  )

  // Eligibility is deliberately not consulted: the kernel drops a disabled or
  // hidden operation, and naming it in the key can only make a key stricter.
  const hidden = simulationReplayEntries(
    [makeOperation('opA', setup.id, { enabled: false, showToolpath: false })],
    new Map([['opA', pathA]]),
  )
  assert(hidden.length === 1, 'a hidden operation with a path is still named, so a key can never be too loose')
}

function testCache(): void {
  console.log('Testing the cache serves only the recorded key...')
  const cache = new SimulationReplayCache()
  const result = makeResult(project)

  assert(cache.peek(key()) === null, 'an unknown replay misses')
  cache.remember(key(), result)
  assert(cache.peek(key()) === result, 'the recorded replay is served')
  assert(cache.peek(key({ detailCells: 120 })) === null, 'another detail misses')
  assert(cache.peek(key({ project: makeProject('other') })) === null, 'another document misses')

  // A remembered key is replaced, not duplicated.
  const replacement = makeResult(project)
  cache.remember(key(), replacement)
  // `number`, so the size checks below are not narrowed by the compiler's
  // literal-type view of an asserted getter.
  const afterReplace: number = cache.size
  assert(afterReplace === 1 && cache.peek(key()) === replacement, 're-recording one replay keeps one entry')

  // A new document drops what the old one left: its keys can never match
  // again, and each one pins a whole project snapshot and its paths.
  const other = makeProject('other')
  const otherSetup = other.setups[0]!
  cache.remember({ project: other, setup: otherSetup, detailCells: 200, items: [] }, makeResult(other))
  const afterOtherDocument: number = cache.size
  assert(afterOtherDocument === 1, 'a new document drops the old document\'s entries')
  assert(cache.peek(key()) === null, 'and the old document misses')

  cache.clear()
  const afterClear: number = cache.size
  assert(afterClear === 0 && cache.peek(key()) === null, 'clear drops everything')
}

function testCapacity(): void {
  console.log('Testing the cache keeps a bounded number of replays...')
  const cache = new SimulationReplayCache(2)
  const first = makeResult(project)
  cache.remember(key({ detailCells: 100 }), first)
  cache.remember(key({ detailCells: 120 }), makeResult(project))
  cache.remember(key({ detailCells: 140 }), makeResult(project))
  const size: number = cache.size
  assert(size === 2, 'the capacity is respected')
  assert(cache.peek(key({ detailCells: 100 })) === null, 'the oldest replay is dropped past the capacity')
  assert(cache.peek(key({ detailCells: 140 })) !== null, 'the newest replay is kept')
}

function testRememberedReplay(): void {
  console.log('Testing a known replay is not built again...')
  const cache = new SimulationReplayCache()
  let builds = 0
  const build = (): SimulationResult => {
    builds += 1
    return makeResult(project)
  }
  const first = rememberedReplay(cache, key(), build)
  const second = rememberedReplay(cache, key(), build)
  const afterReuse: number = builds
  assert(afterReuse === 1, `one build for one replay, got ${afterReuse}`)
  assert(first === second, 'and the same result is served')

  const other = rememberedReplay(cache, key({ detailCells: 120 }), build)
  const afterOtherWork: number = builds
  assert(afterOtherWork === 2 && other !== first, 'different work builds its own result')
}

testKeyEquality()
testEntries()
testCache()
testCapacity()
testRememberedReplay()

console.log('simulation reuse tests passed')
