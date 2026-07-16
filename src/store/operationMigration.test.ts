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
 * Operation-kind migration on project load. The retired v_carve_recursive
 * skeleton op (issue #279) is rewritten to v_carve_medial with its parameters
 * preserved for compatibility, so saved projects keep working after the op
 * was removed. The medial generator now ignores the legacy stepover value.
 */

import {
  defaultGrid,
  defaultStock,
  defaultTool,
  rectProfile,
  type Operation,
  type SketchFeature,
  type Tool,
} from '../types/project'
import { normalizeProject, type ProjectFormatInput } from './helpers/projectFormat'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function subtractFeature(id: string): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(10, 10, 40, 20),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function vBit(id: string): Tool {
  return { ...defaultTool('mm', 1), id, type: 'v_bit', vBitAngle: 60, diameter: 6, maxCutDepth: 10 }
}

/** A legacy operation carrying the retired kind, as it would appear on disk. */
function recursiveOperation(): Operation {
  return {
    id: 'op1',
    name: 'V-Carve skeleton',
    kind: 'v_carve_recursive' as unknown as Operation['kind'],
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['f1'] },
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.37,
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
    maxCarveDepth: 3.5,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
}

function legacyProjectWithRecursiveOp(): ProjectFormatInput {
  return {
    version: '2.1',
    meta: {
      name: 'legacy-recursive',
      created: '2026-01-01T00:00:00.000Z',
      modified: '2026-01-01T00:00:00.000Z',
      units: 'mm',
      showFeatureInfo: true,
      showDimensions: true,
      copyMode: 'reference',
      maxTravelZ: 50,
      operationClearanceZ: 5,
      clampClearanceXY: 2,
      clampClearanceZ: 5,
      machineDefinitions: [],
      selectedMachineId: null,
    },
    grid: defaultGrid('mm'),
    stock: defaultStock(200, 200, 20, 'mm'),
    origin: { name: 'Origin', x: 0, y: 200, z: 20, visible: true },
    backdrop: null,
    dimensions: {},
    annotations: [],
    modelAssets: {},
    featureDefinitions: {},
    features: [subtractFeature('f1')],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    tools: [vBit('t1')],
    operations: [recursiveOperation()],
    tabs: [],
    clamps: [],
    ai_history: [],
  }
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.error(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

test('v_carve_recursive migrates to v_carve_medial on load', () => {
  const project = normalizeProject(legacyProjectWithRecursiveOp())
  const op = project.operations.find((o) => o.id === 'op1')
  assert(op !== undefined, 'expected the migrated operation to survive load')
  assert(op.kind === 'v_carve_medial', `expected v_carve_medial, got ${op.kind}`)
})

test('migration preserves the operation parameters', () => {
  const project = normalizeProject(legacyProjectWithRecursiveOp())
  const op = project.operations.find((o) => o.id === 'op1')
  assert(op !== undefined, 'expected the migrated operation to survive load')
  assert(Math.abs(op.stepover - 0.37) < 1e-9, `stepover not preserved: ${op.stepover}`)
  assert(Math.abs(op.maxCarveDepth - 3.5) < 1e-9, `maxCarveDepth not preserved: ${op.maxCarveDepth}`)
  assert(op.toolRef === 't1', `toolRef not preserved: ${op.toolRef}`)
  assert(
    op.target.source === 'features' && op.target.featureIds.join() === 'f1',
    'target not preserved',
  )
})

test('no v_carve_recursive kind survives the load', () => {
  const project = normalizeProject(legacyProjectWithRecursiveOp())
  assert(
    project.operations.every((o) => (o.kind as string) !== 'v_carve_recursive'),
    'a v_carve_recursive op leaked through normalization',
  )
})

console.log(`\noperationMigration.test.ts: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  throw new Error(`${failed} operationMigration test(s) failed`)
}
