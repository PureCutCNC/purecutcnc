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
 * Vertical overcut through the real persistence seams (issue #834): the
 * `.camj` save/load path in `projectFormat.ts`, `convertProjectUnits`, and the
 * folder import/merge in `import/camj.ts`. The fields are optional and the
 * format number does not move, so a file without them has to load, save and
 * reopen exactly as before; a file with them has to keep them exactly —
 * including a value the engine refuses, which must never be clamped on load.
 *
 * Run with: npx tsx src/store/helpers/verticalOvercutFormat.test.ts
 */

import assert from 'node:assert/strict'
import { defaultTool, newProject, rectProfile, type Operation, type Project } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { convertProjectUnits } from '../../utils/units'
import { decodeProjectFormat } from './projectFormat'
import { mergeCamjFolders } from '../../import/camj'
import { resolveVerticalOvercut } from '../../engine/toolpaths/verticalOvercut'
import { generateEdgeRouteToolpath } from '../../engine/toolpaths/edge'

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function edgeOperation(patch: Partial<Operation> = {}): Operation {
  return {
    id: 'op1',
    name: 'Cut out',
    kind: 'edge_route_outside',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['f1'] },
    toolRef: 't1',
    stepdown: 4,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    ...patch,
  }
}

function project(options: { units?: 'mm' | 'inch'; maxSpoilboardCutDepth?: number; operation?: Partial<Operation> } = {}): Project {
  const units = options.units ?? 'mm'
  const base = newProject('Overcut', units)
  const withMeta: Project = {
    ...base,
    meta: {
      ...base.meta,
      ...(options.maxSpoilboardCutDepth === undefined ? {} : { maxSpoilboardCutDepth: options.maxSpoilboardCutDepth }),
    },
    stock: { ...base.stock, thickness: 12 },
    tools: [{ ...defaultTool(units, 1), id: 't1', name: 'em6', diameter: 6, units: 'mm', maxCutDepth: 30 }],
    featureFolders: [{ id: 'fd1', name: 'Part', collapsed: false } as never],
    featureTree: [{ type: 'folder', folderId: 'fd1' }],
  }
  const withFeatures = projectWithFeatures(withMeta, [
    {
      id: 'f1',
      name: 'Part',
      kind: 'rect',
      folderId: 'fd1',
      sketch: {
        profile: rectProfile(20, 20, 80, 60),
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [],
      },
      operation: 'add',
      z_top: 12,
      z_bottom: 0,
      visible: true,
      locked: false,
    },
  ] as never)
  return { ...withFeatures, operations: [edgeOperation(options.operation)] }
}

/** The real save → JSON → load path. */
function saveAndLoad(value: Project): Project {
  return decodeProjectFormat(JSON.parse(JSON.stringify(value))).project
}

test('a project without the fields loads with them absent and saves back without them', () => {
  const loaded = saveAndLoad(project())
  assert.equal(loaded.meta.maxSpoilboardCutDepth, undefined)
  assert.equal(loaded.operations[0].verticalOvercut, undefined)
  const json = JSON.stringify(loaded)
  assert.doesNotMatch(json, /maxSpoilboardCutDepth|verticalOvercut/, 'no new keys are written')
  assert.equal(loaded.version, saveAndLoad(loaded).version, 'the format number does not move')
  assert.equal(JSON.stringify(saveAndLoad(loaded)), json, 'save and reopen is stable')
})

test('a project without the fields keeps its motion after a round trip', () => {
  // Compared after one load, so the loader's ordinary backfill of this
  // hand-built operation is on both sides.
  const loaded = saveAndLoad(project())
  const before = generateEdgeRouteToolpath(loaded, loaded.operations[0])
  const reopened = saveAndLoad(loaded)
  const after = generateEdgeRouteToolpath(reopened, reopened.operations[0])
  assert.ok(before.moves.length > 0)
  assert.deepEqual(after.moves, before.moves)
  // And a zero overcut with a limit set is the same motion as no field at all.
  const zero = saveAndLoad(project({ maxSpoilboardCutDepth: 1, operation: { verticalOvercut: 0 } }))
  assert.deepEqual(generateEdgeRouteToolpath(zero, zero.operations[0]).moves, before.moves)
})

test('present values round-trip exactly', () => {
  const loaded = saveAndLoad(project({ maxSpoilboardCutDepth: 0.75, operation: { verticalOvercut: 0.5 } }))
  assert.equal(loaded.meta.maxSpoilboardCutDepth, 0.75)
  assert.equal(loaded.operations[0].verticalOvercut, 0.5)
  const reopened = saveAndLoad(loaded)
  assert.equal(reopened.meta.maxSpoilboardCutDepth, 0.75)
  assert.equal(reopened.operations[0].verticalOvercut, 0.5)
  assert.equal(resolveVerticalOvercut(reopened, reopened.operations[0]).kind, 'ok')
})

test('refused values from an edited file load unclamped and stay refused', () => {
  for (const [overcut, limit] of [[-1, 1], [2, 1], [0.5, -1]] as const) {
    const loaded = saveAndLoad(project({ maxSpoilboardCutDepth: limit, operation: { verticalOvercut: overcut } }))
    assert.equal(loaded.operations[0].verticalOvercut, overcut, `overcut ${overcut} is kept as stored`)
    assert.equal(loaded.meta.maxSpoilboardCutDepth, limit, `limit ${limit} is kept as stored`)
    assert.equal(resolveVerticalOvercut(loaded, loaded.operations[0]).kind, 'invalid')
    assert.equal(generateEdgeRouteToolpath(loaded, loaded.operations[0]).moves.length, 0)
  }
  // NaN and Infinity become null in JSON; null stays refused, never zero.
  const nonFinite = saveAndLoad(project({ maxSpoilboardCutDepth: 1, operation: { verticalOvercut: Number.NaN } }))
  assert.equal(nonFinite.operations[0].verticalOvercut, null)
  assert.equal(resolveVerticalOvercut(nonFinite, nonFinite.operations[0]).kind, 'invalid')
})

test('a stray overcut on another kind is dropped on load', () => {
  const loaded = saveAndLoad(project({ operation: { kind: 'pocket', verticalOvercut: 0.5 } }))
  assert.equal(loaded.operations[0].verticalOvercut, undefined)
})

test('unit conversion converts both values and keeps them within the limit', () => {
  const inch = convertProjectUnits(project({ maxSpoilboardCutDepth: 1.27, operation: { verticalOvercut: 1.27 } }), 'inch')
  assert.ok(Math.abs((inch.meta.maxSpoilboardCutDepth ?? 0) - 0.05) <= 1e-12)
  assert.ok(Math.abs((inch.operations[0].verticalOvercut ?? 0) - 0.05) <= 1e-12)
  assert.equal(resolveVerticalOvercut(inch, inch.operations[0]).kind, 'ok', 'an at-limit value stays at the limit')
  const back = convertProjectUnits(inch, 'mm')
  assert.ok(Math.abs((back.operations[0].verticalOvercut ?? 0) - 1.27) <= 1e-9)

  const absent = convertProjectUnits(project(), 'inch')
  assert.equal(absent.meta.maxSpoilboardCutDepth, undefined, 'an absent limit stays absent')
  assert.equal('verticalOvercut' in absent.operations[0], false, 'an absent overcut stays absent')

  const refused = convertProjectUnits(project({ maxSpoilboardCutDepth: 1, operation: { verticalOvercut: null as never } }), 'inch')
  assert.equal(refused.operations[0].verticalOvercut, null, 'a non-number is not converted into a number')
})

test('import/merge carries the overcut, converted, and flags it against the target project limit', () => {
  const source = project({ maxSpoilboardCutDepth: 2, operation: { verticalOvercut: 1.27 } })
  const generous = newProject('Target', 'inch')
  const merged = mergeCamjFolders({
    currentProject: { ...generous, meta: { ...generous.meta, maxSpoilboardCutDepth: 0.1 } },
    sourceProject: source,
    selectedFolderIds: ['fd1'],
  })
  const imported = merged.project.operations.find((operation) => operation.kind === 'edge_route_outside')
  assert.ok(imported, 'the edge route is imported')
  assert.ok(Math.abs((imported.verticalOvercut ?? 0) - 0.05) <= 1e-12, 'converted to the target units')
  assert.equal(merged.project.meta.maxSpoilboardCutDepth, 0.1, 'the target keeps its own limit')
  assert.equal(resolveVerticalOvercut(merged.project, imported).kind, 'ok')

  const strict = mergeCamjFolders({
    currentProject: newProject('Strict', 'mm'),
    sourceProject: source,
    selectedFolderIds: ['fd1'],
  })
  const flagged = strict.project.operations.find((operation) => operation.kind === 'edge_route_outside')
  assert.ok(flagged)
  assert.equal(flagged.verticalOvercut, 1.27, 'not clamped to the target limit')
  const status = resolveVerticalOvercut(strict.project, flagged)
  assert.equal(status.kind, 'invalid', 'an over-limit import is flagged, not silently allowed')
})

console.log(`\n  verticalOvercutFormat: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exit(1)
}
