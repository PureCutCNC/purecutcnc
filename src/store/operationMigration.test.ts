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
  circleProfile,
  defaultGrid,
  defaultStock,
  defaultTool,
  rectProfile,
  type DimensionRef,
  type Operation,
  type SketchFeature,
  type Tool,
} from '../types/project'
import { decodeProjectFormat, normalizeProject, type ProjectFormatInput } from './helpers/projectFormat'

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

function legacyProjectWithEdgeRoute(): ProjectFormatInput {
  const project = legacyProjectWithRecursiveOp()
  project.operations = [{
    ...recursiveOperation(),
    id: 'edge-op',
    kind: 'edge_route_inside',
    pass: 'rough',
    toolRef: 't1',
  }]
  return project
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

test('legacy edge routes default to contour strategy on load', () => {
  const project = normalizeProject(legacyProjectWithEdgeRoute())
  const operation = project.operations.find((entry) => entry.id === 'edge-op')
  assert(operation !== undefined, 'expected the legacy edge route to survive load')
  assert(operation.edgeStrategy === 'contour', `expected contour default, got ${operation.edgeStrategy}`)
})

// ── Format 3.1: retractHeight becomes a distance above the material ──

function drillingOperation(retractHeight: number | undefined, featureIds = ['f1']): Operation {
  return {
    ...recursiveOperation(),
    id: 'drill-op',
    kind: 'drilling',
    drillType: 'simple',
    target: { source: 'features', featureIds },
    ...(retractHeight === undefined ? {} : { retractHeight }),
  } as Operation
}

/** Drilling targets must be circles, or normalizeOperation replaces the
 *  target with its fallback before the retract migration ever runs. */
function drillableFeature(id: string, zTop: number | DimensionRef): SketchFeature {
  return {
    ...subtractFeature(id),
    kind: 'circle',
    sketch: {
      profile: circleProfile(15, 15, 4),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    z_top: zTop,
  }
}

function drillingProject(options: {
  version?: '3.0' | '3.1'
  retractHeight?: number
  omitRetractHeight?: boolean
  featureIds?: string[]
  extraFeatures?: SketchFeature[]
  dropStockThickness?: boolean
} = {}): ProjectFormatInput {
  const project = legacyProjectWithRecursiveOp()
  project.version = options.version ?? '3.0'
  project.operations = [drillingOperation(
    options.omitRetractHeight ? undefined : options.retractHeight,
    options.featureIds,
  )]
  if (options.extraFeatures?.length) project.features = [...project.features, ...options.extraFeatures]
  if (options.dropStockThickness) {
    // defaultStock always sets a thickness; strip it to simulate a malformed file.
    ;(project.stock as unknown as Record<string, unknown>).thickness = undefined
  }
  return project
}

function findDrillOp(project: { operations: Operation[] }): Operation {
  const op = project.operations.find((entry) => entry.id === 'drill-op')
  assert(op !== undefined, 'expected the drilling operation to survive load')
  return op
}

test('format ≤ 3.0 absolute retract heights become distances above their own targets (#481)', () => {
  // Stock is 20 mm thick and the op drills a hole whose top sits at the
  // stock surface; an absolute Z of 22 is 2 mm above that surface.
  const op = findDrillOp(normalizeProject(drillingProject({
    retractHeight: 22,
    extraFeatures: [drillableFeature('hole', 20)],
    featureIds: ['hole'],
  })))
  assert(Math.abs((op.retractHeight ?? NaN) - 2) < 1e-9, `expected offset 2, got ${op.retractHeight}`)
})

test('an operation without a stored value keeps the injected relative default', () => {
  // normalizeOperation fills the *new* relative default on load; migrating
  // that as an absolute Z would collapse the plane onto the material surface
  // instead of leaving it 1 mm above (issue #481 review, blocker 1).
  const op = findDrillOp(normalizeProject(drillingProject({ omitRetractHeight: true })))
  assert(op.retractHeight === 1, `expected the relative default 1 to survive, got ${op.retractHeight}`)
})

test('the offset resolves against the operation\'s own targets, not the tallest feature', () => {
  // A non-target feature towers over the stock while the drilled surface is
  // still the stock top: "2 above the stock" must survive as 2 rather than be
  // collapsed onto the surface by the bystander's height (issue #481 review,
  // blocker 2).
  const op = findDrillOp(normalizeProject(drillingProject({
    retractHeight: 22,
    extraFeatures: [drillableFeature('hole', 20), drillableFeature('tall-bystander', 30)],
    featureIds: ['hole'],
  })))
  assert(Math.abs((op.retractHeight ?? NaN) - 2) < 1e-9, `expected offset 2, got ${op.retractHeight}`)

  // When the tall feature IS the target, its top is the drilled surface.
  const targeted = findDrillOp(normalizeProject(drillingProject({
    retractHeight: 32,
    extraFeatures: [drillableFeature('tall-target', 30)],
    featureIds: ['tall-target'],
  })))
  assert(Math.abs((targeted.retractHeight ?? NaN) - 2) < 1e-9, `expected offset 2 against the tall target, got ${targeted.retractHeight}`)
})

test('a constraint-linked target top leaves the stored value untouched', () => {
  // A DimensionRef string top cannot reveal a numeric surface here; keeping
  // the raw number resolves high under the new reading and is capped at the
  // clearance plane — safe-side, never skimmed. (An outright missing target
  // cannot reach the migration: normalizeOperation swaps invalid targets for
  // their fallback before it runs.)
  const op = findDrillOp(normalizeProject(drillingProject({
    retractHeight: 22,
    extraFeatures: [drillableFeature('linked-top', 'linked-height')],
    featureIds: ['linked-top'],
  })))
  assert(Math.abs((op.retractHeight ?? NaN) - 22) < 1e-9, `expected the value left alone, got ${op.retractHeight}`)
})

test('legacy retract heights below the surface land on the surface offset', () => {
  // Exactly what the issue #479 runtime clamp produced at generation time,
  // so no pre-3.1 project changes behaviour through the migration.
  const op = findDrillOp(normalizeProject(drillingProject({ retractHeight: 15 })))
  assert(op.retractHeight === 0, `expected the surface offset 0, got ${op.retractHeight}`)
})

test('a stock without a finite thickness skips the migration instead of writing NaN', () => {
  // NaN survives Math.max(0, …); committing it would post a literal Z NaN.
  const op = findDrillOp(normalizeProject(drillingProject({ retractHeight: 22, dropStockThickness: true })))
  assert(Number.isFinite(op.retractHeight), `retractHeight must stay finite, got ${op.retractHeight}`)
  assert(Math.abs((op.retractHeight ?? NaN) - 22) < 1e-9, `expected the value untouched, got ${op.retractHeight}`)
})

test('3.1 files already carry distances and are never re-migrated', () => {
  const once = normalizeProject(drillingProject({ version: '3.1', retractHeight: 2 }))
  const op = findDrillOp(once)
  assert(Math.abs((op.retractHeight ?? NaN) - 2) < 1e-9, `a 3.1 distance must survive untouched, got ${op.retractHeight}`)
  const reloaded = findDrillOp(normalizeProject(JSON.parse(JSON.stringify(once))))
  assert(Math.abs((reloaded.retractHeight ?? NaN) - 2) < 1e-9, 'save/reload must be stable for the field')
})

/** A modern-envelope .camj body with one drilling operation, as a real 3.0/3.1
 *  file would carry it. Built by normalizing once (decodeProjectFormat rejects
 *  legacy baked rows outright), then re-stamping the claimed version and — when
 *  given — the raw absolute retractHeight the file "read". */
function drillingFile(options: { retractHeight?: number; version?: '3.0' | '3.1' }): ProjectFormatInput {
  const base = normalizeProject(drillingProject({
    omitRetractHeight: true,
    extraFeatures: [drillableFeature('hole', 20)],
    featureIds: ['hole'],
  }))
  const stored = findDrillOp(base)
  const fileOp: typeof stored = { ...stored }
  if (options.retractHeight === undefined) {
    // The first normalize injected the relative default; a real file with no
    // stored value simply lacks the key, so remove it rather than let decode
    // mistake the injected number for an absolute Z.
    delete fileOp.retractHeight
  } else {
    fileOp.retractHeight = options.retractHeight
  }
  return {
    ...base,
    version: options.version ?? '3.0',
    operations: [fileOp],
  }
}

test('decode reports how many retract heights were re-expressed (#599)', () => {
  // The load warning keys on this count: a 3.0 file whose stored absolute Z
  // actually moves must surface the conversion instead of silently changing
  // what the number in the panel means.
  const decoded = decodeProjectFormat(drillingFile({ retractHeight: 22 }))
  assert(decoded.retractHeightsReexpressed === 1, `expected 1 rewrite, got ${decoded.retractHeightsReexpressed}`)
  const op = findDrillOp(decoded.project)
  assert(Math.abs((op.retractHeight ?? NaN) - 2) < 1e-9, `expected offset 2 alongside the report, got ${op.retractHeight}`)
})

test('no re-expression is reported when no stored value moved', () => {
  // Without a file-read value the migration deliberately skips the position —
  // normalizeOperation's injected relative default is not a rewrite.
  const decoded = decodeProjectFormat(drillingFile({}))
  assert(decoded.retractHeightsReexpressed === 0, `expected 0 rewrites, got ${decoded.retractHeightsReexpressed}`)
})

test('3.1 files report zero re-expressions', () => {
  const decoded = decodeProjectFormat(drillingFile({ retractHeight: 2, version: '3.1' }))
  assert(decoded.retractHeightsReexpressed === 0, `expected 0 rewrites, got ${decoded.retractHeightsReexpressed}`)
  assert(findDrillOp(decoded.project).retractHeight === 2, 'a 3.1 distance must survive untouched')
})

console.log(`\noperationMigration.test.ts: ${passed} passed, ${failed} failed`)
if (failed > 0) {
  throw new Error(`${failed} operationMigration test(s) failed`)
}
