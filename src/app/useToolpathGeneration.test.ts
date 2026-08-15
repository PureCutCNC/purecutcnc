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
 * Unit tests for the React-free parts of useToolpathGeneration.
 * Run with: npx tsx src/app/useToolpathGeneration.test.ts
 */

import { operationFootprint, type ToolpathResult } from '../engine/toolpaths'
import type { FeatureInstance, Operation, Project, SketchFeature, Tool } from '../types/project'
import { defaultTool, IDENTITY_MATRIX, newProject, rectProfile } from '../types/project'
import type { LegacyFeatureRow } from '../store/helpers/projectFormat'
import { createDefinitionForFeatureWithId, createFeatureInstance } from '../store/helpers/featureDefinitions'
import { projectWithFeatures } from '../test/projectFixtures'
import {
  isCacheHit,
  operationComputationEquals,
  startToolpathGenerationPipeline,
  type ToolpathCacheEntry,
} from './useToolpathGeneration'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  const target = { source: 'features', featureIds: ['feature-1'] } satisfies Operation['target']
  return {
    id: 'op-1',
    name: 'Operation 1',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target,
    toolRef: 'tool-1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: false,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    drillType: 'simple',
    peckDepth: 0.5,
    dwellTime: 0.1,
    retractHeight: 3,
    debugShowRejectedCorners: false,
    waterlineAdaptiveRefinement: false,
    waterlineMicroStepover: 0.02,
    waterlineRefinementThreshold: 0.01,
    waterlineMaxRingsPerBand: 4,
    waterlineTipStepdown: 0.05,
    arcFittingEnabled: true,
    ...overrides,
  }
}

function makeProject(operation = makeOperation()): Project {
  return {
    ...newProject('toolpath-generation-test', 'mm'),
    operations: [operation],
  }
}

/** Authoritative definition-backed project with three machinable rects. */
function makeFeatureProject(operation = makeOperation()): Project {
  return projectWithFeatures(
    { ...newProject('toolpath-generation-test', 'mm'), operations: [operation] },
    [draftFeature('f1'), draftFeature('f2'), draftFeature('f3')],
  )
}

function draftFeature(id: string, overrides: Partial<SketchFeature> = {}): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 20, 10),
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
    ...overrides,
  }
}

/** Immutable per-row edit, matching how the store updates feature rows. */
function patchFeatureRow(project: Project, id: string, patch: Partial<FeatureInstance>): Project {
  return {
    ...project,
    features: project.features.map((feature) => (feature.id === id ? { ...feature, ...patch } : feature)),
  }
}

/** Attach one real tool so `operationFootprint` can resolve a toolRef. */
function withTool(project: Project, tool: Tool = defaultTool('mm')): Project {
  return { ...project, tools: [tool] }
}

/** A `draftFeature` rect at an explicit world position. */
function rectDraft(
  id: string,
  x: number,
  y: number,
  w = 20,
  h = 10,
  overrides: Partial<SketchFeature> = {},
): SketchFeature {
  return draftFeature(id, {
    ...overrides,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  })
}

/**
 * Append a new feature the way the store does: a new definition plus a new
 * instance row, everything else by reference. (Rebuilding through
 * `projectWithFeatures` would also rebuild the tools and operations arrays
 * and invalidate for the wrong reason.)
 */
function addFeatureDraft(project: Project, draft: SketchFeature): Project {
  const definitionId = draft.id
  const { definition } = createDefinitionForFeatureWithId(draft, definitionId)
  const instance = createFeatureInstance(draft, definitionId, IDENTITY_MATRIX)
  return {
    ...project,
    featureDefinitions: { ...project.featureDefinitions, [definitionId]: definition },
    features: [...project.features, instance],
  }
}

/**
 * S3b fixture: the operation targets f1 (the 20×10 rect at the origin) with a
 * 6 mm tool. Its footprint is the target union grown by
 * 4·toolDiameter + stepover = 24.4, i.e. roughly (-24.4…44.4)². f2 at (40, 0)
 * lies inside it; f3 at (500, 0) is far outside it.
 */
function makeFootprintProject(): Project {
  const operation = makeOperation({ target: { source: 'features', featureIds: ['f1'] }, toolRef: 't1' })
  return withTool(
    projectWithFeatures(
      { ...newProject('toolpath-generation-test', 'mm'), operations: [operation] },
      [draftFeature('f1'), rectDraft('f2', 40, 0), rectDraft('f3', 500, 0)],
    ),
  )
}

/** The operation object as normalized inside a fixture project. */
function footprintOperation(project: Project): Operation {
  const operation = project.operations.find((o) => o.id === 'op-1')
  assert(operation !== undefined, 'op-1 should exist')
  return operation
}

function makeResult(operationId: string): ToolpathResult {
  return {
    operationId,
    moves: [],
    warnings: [],
    bounds: null,
  }
}

function makeEntry(project: Project, operation: Operation, result = makeResult(operation.id)): ToolpathCacheEntry {
  return {
    result,
    operation,
    stock: project.stock,
    project,
    footprint: operationFootprint(project, operation),
    tools: project.tools,
    tabs: project.tabs,
    clamps: project.clamps,
  }
}

/** Minimal deterministic rAF: queues callbacks; `flush()` runs and clears them. */
function makeFakeRaf() {
  const pending = new Map<number, FrameRequestCallback>()
  let nextHandle = 1
  const raf = (cb: FrameRequestCallback): number => {
    const handle = nextHandle++
    pending.set(handle, cb)
    return handle
  }
  const flush = (): void => {
    const callbacks = [...pending.values()]
    pending.clear()
    for (const cb of callbacks) cb(performance.now())
  }
  return { raf, flush, pendingCount: () => pending.size }
}

function testOperationComputationEquals() {
  console.log('Testing operationComputationEquals field allowlist...')

  const base = makeOperation()
  assert(operationComputationEquals(base, base), 'identical operation reference returns true')
  assert(operationComputationEquals(base, { ...base }), 'identical operation values return true')

  const computationChanges: Array<[string, Partial<Operation>]> = [
    ['kind', { kind: 'drilling' }],
    ['pass', { pass: 'finish' }],
    ['target', { target: { source: 'features', featureIds: ['feature-1'] } }],
    ['toolRef', { toolRef: 'tool-2' }],
    ['stepdown', { stepdown: 3 }],
    ['stepover', { stepover: 0.5 }],
    ['feed', { feed: 900 }],
    ['plungeFeed', { plungeFeed: 350 }],
    ['rpm', { rpm: 19000 }],
    ['pocketPattern', { pocketPattern: 'parallel' }],
    ['pocketAngle', { pocketAngle: 45 }],
    ['edgeStrategy', { edgeStrategy: 'trochoidal' }],
    ['carveStrategy', { carveStrategy: 'trochoidal' }],
    ['trochoidalCutWidth', { trochoidalCutWidth: 6 }],
    ['trochoidalAdvance', { trochoidalAdvance: 0.1 }],
    ['entryStrategy', { entryStrategy: 'helix' }],
    ['entryRampAngle', { entryRampAngle: 8 }],
    ['entryHelixDiameterPercent', { entryHelixDiameterPercent: 60 }],
    ['roundOutsideCorners', { roundOutsideCorners: true }],
    ['stockToLeaveRadial', { stockToLeaveRadial: 0.1 }],
    ['stockToLeaveAxial', { stockToLeaveAxial: 0.2 }],
    ['finishWalls', { finishWalls: false }],
    ['finishFloor', { finishFloor: false }],
    ['carveDepth', { carveDepth: 1.5 }],
    ['maxCarveDepth', { maxCarveDepth: 2.5 }],
    ['cutDirection', { cutDirection: 'climb' }],
    ['machiningOrder', { machiningOrder: 'feature_first' }],
    ['drillType', { drillType: 'peck' }],
    ['peckDepth', { peckDepth: 0.75 }],
    ['dwellTime', { dwellTime: 0.25 }],
    ['countersinkDiameter', { countersinkDiameter: 6 }],
    ['retractHeight', { retractHeight: 4 }],
    ['debugToolpath', { debugToolpath: true }],
    ['debugShowRejectedCorners', { debugShowRejectedCorners: true }],
    ['waterlineAdaptiveRefinement', { waterlineAdaptiveRefinement: true }],
    ['waterlineMicroStepover', { waterlineMicroStepover: 0.03 }],
    ['waterlineRefinementThreshold', { waterlineRefinementThreshold: 0.02 }],
    ['waterlineMaxRingsPerBand', { waterlineMaxRingsPerBand: 5 }],
    ['waterlineTipStepdown', { waterlineTipStepdown: 0.08 }],
  ]

  for (const [field, change] of computationChanges) {
    assert(!operationComputationEquals(base, { ...base, ...change }), `${field} change returns false`)
  }

  const displayChanges: Array<[string, Partial<Operation>]> = [
    ['name', { name: 'Renamed' }],
    ['enabled', { enabled: false }],
    ['showToolpath', { showToolpath: false }],
    ['arcFittingEnabled', { arcFittingEnabled: false }],
  ]

  for (const [field, change] of displayChanges) {
    assert(operationComputationEquals(base, { ...base, ...change }), `${field} display change returns true`)
  }

  console.log('operationComputationEquals field allowlist: PASSED')
}

function testIsCacheHit() {
  console.log('Testing isCacheHit reference and operation invalidation...')

  const operation = makeOperation()
  const project = makeProject(operation)
  const entry = makeEntry(project, operation)

  assert(isCacheHit(entry, operation, project), 'identical object references hit')
  assert(!isCacheHit(entry, { ...operation, stepdown: operation.stepdown + 1 }, project), 'operation computation change misses')
  assert(!isCacheHit(entry, operation, { ...project, stock: { ...project.stock } }), 'stock reference change misses')
  // Whole-array identity for tools/tabs/clamps is retained by this slice:
  // a fresh array (even of identical rows) still invalidates.
  assert(!isCacheHit(entry, operation, { ...project, tools: [...project.tools] }), 'tools reference change misses')
  assert(!isCacheHit(entry, operation, { ...project, tabs: [...project.tabs] }), 'tabs reference change misses')
  assert(!isCacheHit(entry, operation, { ...project, clamps: [...project.clamps] }), 'clamps reference change misses')
  // A fresh features array with identical rows is no longer a miss — that is
  // the whole point of the slice: the diff, not array identity, decides.
  assert(isCacheHit(entry, operation, { ...project, features: [...project.features] }), 'features reference change with identical rows hits')

  console.log('isCacheHit reference and operation invalidation: PASSED')
}

function testIsCacheHitFeatureDiff() {
  console.log('Testing isCacheHit feature-input diff...')

  const operation = makeOperation()
  const project = makeFeatureProject(operation)
  const entry = makeEntry(project, operation)

  // Fast path: the exact snapshot reference the entry was generated from
  // short-circuits before the O(n) diff.
  assert(isCacheHit(entry, operation, project), 'entry.project === project fast path hits')

  // Display-only instance changes must not invalidate any toolpath.
  assert(isCacheHit(entry, operation, patchFeatureRow(project, 'f1', { visible: false })), 'visible change hits')
  assert(isCacheHit(entry, operation, patchFeatureRow(project, 'f2', { locked: true })), 'locked change hits')
  assert(isCacheHit(entry, operation, patchFeatureRow(project, 'f3', { folderId: 'folder-x' })), 'folderId change hits')

  // `name` is computation-relevant: generators embed `feature.name` in
  // user-visible toolpath warnings, so a cached result would keep the old
  // name in the CAM panel after a rename.
  assert(!isCacheHit(entry, operation, patchFeatureRow(project, 'f1', { name: 'renamed' })), 'name change misses')

  // Geometry-relevant instance changes must still invalidate.
  const row = project.features.find((feature) => feature.id === 'f2')
  assert(row !== undefined, 'f2 row should exist')
  assert(
    !isCacheHit(entry, operation, patchFeatureRow(project, 'f2', { transform: { ...row.transform, e: 12 } })),
    'transform change misses',
  )

  // Editing the definition shared by two instances, while both instance rows
  // stay byte-identical, must invalidate — a naive instance-only diff misses
  // this case silently.
  {
    const sharedDraft = (id: string): LegacyFeatureRow => ({ ...draftFeature(id), definitionId: 'd-shared' })
    const defProject = projectWithFeatures(
      { ...newProject('toolpath-generation-test', 'mm'), operations: [operation] },
      [sharedDraft('i1'), sharedDraft('i2')],
    )
    const defEntry = makeEntry(defProject, operation)
    const sharedDefinition = defProject.featureDefinitions['d-shared']
    const next: Project = {
      ...defProject,
      featureDefinitions: {
        ...defProject.featureDefinitions,
        'd-shared': { ...sharedDefinition, profile: rectProfile(50, 50, 8, 8) },
      },
    }
    assert(next.features === defProject.features, 'instance rows must stay byte-identical')
    assert(!isCacheHit(defEntry, operation, next), 'shared definition edit misses')
  }

  // Per-band topology is order-dependent: a pure reorder invalidates every
  // operation.
  {
    const reordered: Project = {
      ...project,
      features: [project.features[0], project.features[2], project.features[1]],
    }
    assert(!isCacheHit(entry, operation, reordered), 'feature reorder misses')
  }

  // Inputs the old whole-array predicate missed entirely: named dimensions
  // resolve every feature's Z span, and units feed tool normalization.
  {
    const withDimension: Project = {
      ...project,
      dimensions: { d1: { id: 'd1', name: 'Depth', value: 5, formula: null } },
    }
    const dimEntry = makeEntry(withDimension, operation)
    const dimChanged: Project = {
      ...project,
      dimensions: { d1: { id: 'd1', name: 'Depth', value: 6, formula: null } },
    }
    assert(!isCacheHit(dimEntry, operation, dimChanged), 'dimension change misses')

    assert(project.meta.units === 'mm', 'fixture should be mm')
    const unitChanged: Project = {
      ...project,
      meta: { ...project.meta, units: 'inch' },
    }
    assert(!isCacheHit(entry, operation, unitChanged), 'units change misses')
  }

  console.log('isCacheHit feature-input diff: PASSED')
}

function testIsCacheHitFootprint() {
  console.log('Testing isCacheHit footprint narrowing (S3b)...')

  const project = makeFootprintProject()
  const operation = footprintOperation(project)
  const entry = makeEntry(project, operation)
  assert(entry.footprint.bounds !== null, 'the fixture footprint must be known')

  // 1. The headline case: a feature edited far outside the footprint must not
  // invalidate the operation — the symptom issue #518 was filed for.
  assert(
    isCacheHit(entry, operation, patchFeatureRow(project, 'f3', { z_top: 9 })),
    'a feature edited far outside the footprint must keep the cache hit',
  )

  // 2. A feature edited so its bbox overlaps the footprint must invalidate.
  assert(
    !isCacheHit(entry, operation, patchFeatureRow(project, 'f2', { z_top: 9 })),
    'a feature edited inside the footprint must miss',
  )

  // 3. A direct target edited must invalidate.
  assert(
    !isCacheHit(entry, operation, patchFeatureRow(project, 'f1', { z_top: 9 })),
    'a direct target edit must miss',
  )

  // 4. A brand-new feature added far away must not invalidate; one added
  // inside the footprint must.
  assert(
    isCacheHit(entry, operation, addFeatureDraft(project, rectDraft('f4', 500, 100))),
    'adding a feature far away must keep the cache hit',
  )
  assert(
    !isCacheHit(entry, operation, addFeatureDraft(project, rectDraft('f4', 40, 30))),
    'adding a feature inside the footprint must miss',
  )

  // 5. An unrelated feature moved into the footprint must invalidate.
  const f3Row = project.features.find((feature) => feature.id === 'f3')
  assert(f3Row !== undefined, 'f3 row should exist')
  const movedIn = patchFeatureRow(project, 'f3', { transform: { ...f3Row.transform, e: -460 } })
  assert(
    !isCacheHit(entry, operation, movedIn),
    'moving an unrelated feature into the footprint must miss',
  )

  console.log('isCacheHit footprint narrowing: PASSED')
}

function testIsCacheHitStockTargeted() {
  console.log('Testing isCacheHit footprint for stock-targeted operations...')

  // A stock-targeted surface operation reads the whole model. The operation
  // is attached after the authoritative feature build because project
  // normalization rewrites a target it considers invalid onto the first solid
  // feature, and a stock target only survives normalization as the
  // empty-feature fallback — which is not this fixture.
  const stockOp = makeOperation({
    kind: 'rough_surface',
    target: { source: 'stock' },
    toolRef: 't1',
  })
  const base = withTool(
    projectWithFeatures(
      { ...newProject('toolpath-generation-test', 'mm'), operations: [] },
      [draftFeature('f1'), rectDraft('c1', 40, 0, 20, 10, { operation: 'construction' })],
    ),
  )
  const project = { ...base, operations: [stockOp] }
  const operation = project.operations[0]
  assert(operation !== undefined, 'stock op should exist')
  assert(operation.target.source === 'stock', 'fixture must carry a stock target')
  const entry = makeEntry(project, operation)
  assert(entry.footprint.readsWholeModel, 'a stock-targeted footprint must read the whole model')

  // Any solid-feature change must invalidate a stock-targeted operation.
  assert(
    !isCacheHit(entry, operation, patchFeatureRow(project, 'f1', { z_top: 9 })),
    'a solid-feature change must miss for a stock-targeted operation',
  )

  // A construction-only change must not.
  assert(
    isCacheHit(entry, operation, patchFeatureRow(project, 'c1', { z_top: 8 })),
    'a construction-only change must keep the cache hit for a stock-targeted operation',
  )

  console.log('isCacheHit footprint for stock-targeted operations: PASSED')
}

function testIsCacheHitUnknownFootprint() {
  console.log('Testing isCacheHit invalidates when the footprint is unknown (missing tool)...')

  // Same positioned features, but no tools at all: `operationFootprint`
  // cannot resolve the toolRef and must report unknown, which invalidates on
  // every change — even a far-away one.
  const operation = makeOperation({ target: { source: 'features', featureIds: ['f1'] }, toolRef: 't1' })
  const project = projectWithFeatures(
    { ...newProject('toolpath-generation-test', 'mm'), operations: [operation] },
    [draftFeature('f1'), rectDraft('f2', 40, 0), rectDraft('f3', 500, 0)],
  )
  const normalizedOperation = footprintOperation(project)
  const entry = makeEntry(project, normalizedOperation)
  assert(entry.footprint.bounds === null, 'a missing tool must yield an unknown footprint')

  assert(
    !isCacheHit(entry, normalizedOperation, patchFeatureRow(project, 'f3', { z_top: 9 })),
    'any change must miss when the footprint is unknown, even a far-away one',
  )

  console.log('isCacheHit unknown-footprint invalidation: PASSED')
}

function testPipelineRegeneration() {
  console.log('Testing pipeline regeneration: display-only change does not regenerate, transform change does...')

  const project = makeFootprintProject()
  // The pipeline looks operations up from `project.operations`; prime the
  // cache with that same object, exactly as generation does. (Project
  // normalization rebuilds operation objects, so the pre-normalization draft
  // above is a different object and must not be the one cached.)
  const normalizedOperation = footprintOperation(project)

  const fake = makeFakeRaf()
  let generatedCalls = 0
  const generateToolpathForOperation = (op: Operation | null): ToolpathResult | null => {
    if (!op) return null
    generatedCalls += 1
    return makeResult(op.id)
  }
  const cache = new Map<string, ToolpathCacheEntry>()
  const primedResult = makeResult(normalizedOperation.id)
  cache.set(normalizedOperation.id, makeEntry(project, normalizedOperation, primedResult))
  let currentMap = new Map<string, ToolpathResult>()
  const setToolpathMap = (
    value: Map<string, ToolpathResult> | ((prev: Map<string, ToolpathResult>) => Map<string, ToolpathResult>),
  ): void => {
    currentMap = typeof value === 'function' ? value(currentMap) : value
  }
  const scheduleAfterPaint = (fn: () => void): void => {
    fake.raf(() => fake.raf(fn))
  }

  const runPipeline = (nextProject: Project): void => {
    startToolpathGenerationPipeline({
      neededOperationIds: [normalizedOperation.id],
      project: nextProject,
      toolpathCache: cache,
      generateToolpathForOperation,
      setToolpathMap,
      requestAnimationFrameFn: fake.raf,
      scheduleAfterPaintFn: scheduleAfterPaint,
    })
    fake.flush()
    fake.flush()
  }

  // A visibility-toggle-shaped change must not regenerate: the cache entry
  // hits, so the generator spy is never called and the primed result stays.
  runPipeline(patchFeatureRow(project, 'f1', { visible: false }))
  // Snapshot the counter into a fresh const: asserting on the mutable
  // variable directly would literal-narrow it and break the `=== 1` assert
  // below (`asserts condition` narrowing).
  const callsAfterVisibility = generatedCalls
  assert(callsAfterVisibility === 0, 'visibility toggle must not regenerate the toolpath')
  assert(currentMap.has(normalizedOperation.id), 'cached result must stay in the map')

  // A transform-shaped change on the direct target must regenerate exactly once.
  const row = project.features.find((feature) => feature.id === 'f1')
  assert(row !== undefined, 'f1 row should exist')
  runPipeline(patchFeatureRow(project, 'f1', { transform: { ...row.transform, e: 1 } }))
  const callsAfterTransform = generatedCalls
  assert(callsAfterTransform === 1, 'transform change must regenerate the toolpath once')

  // S3b headline: a feature edited far outside the operation's footprint must
  // not regenerate either — the spy stays quiet and the previous result stays
  // in the map (which is exactly what stops the visible blanking during
  // editing).
  runPipeline(patchFeatureRow(project, 'f3', { z_top: 9 }))
  const callsAfterFarAway = generatedCalls
  assert(callsAfterFarAway === 1, 'a far-away feature edit must not regenerate the toolpath')
  assert(currentMap.get(normalizedOperation.id) === primedResult, 'previous result must stay in the map after a far-away edit')

  // An edit inside the footprint must regenerate exactly once.
  runPipeline(patchFeatureRow(project, 'f2', { z_top: 9 }))
  const callsAfterOverlapping = generatedCalls
  assert(callsAfterOverlapping === 2, 'an overlapping feature edit must regenerate the toolpath once')

  console.log('pipeline regeneration on display-only vs transform vs footprint-relevant changes: PASSED')
}

function testOnePerFrameScheduler() {
  console.log('Testing toolpath pipeline computes uncached operations one per frame...')

  const operations = [
    makeOperation({ id: 'op-1' }),
    makeOperation({ id: 'op-2' }),
    makeOperation({ id: 'op-3' }),
  ]
  const project = {
    ...makeProject(operations[0]),
    operations,
  }
  const cache = new Map<string, ToolpathCacheEntry>()
  const fake = makeFakeRaf()
  const computed: string[] = []
  let currentMap = new Map<string, ToolpathResult>()
  const setToolpathMap = (
    value: Map<string, ToolpathResult> | ((prev: Map<string, ToolpathResult>) => Map<string, ToolpathResult>),
  ): void => {
    currentMap = typeof value === 'function' ? value(currentMap) : value
  }
  const scheduleAfterPaint = (fn: () => void): void => {
    fake.raf(() => fake.raf(fn))
  }

  startToolpathGenerationPipeline({
    neededOperationIds: operations.map((operation) => operation.id),
    project,
    toolpathCache: cache,
    generateToolpathForOperation: (operation) => {
      if (!operation) return null
      computed.push(operation.id)
      const result = makeResult(operation.id)
      cache.set(operation.id, makeEntry(project, operation, result))
      return result
    },
    setToolpathMap,
    requestAnimationFrameFn: fake.raf,
    scheduleAfterPaintFn: scheduleAfterPaint,
  })

  assert(currentMap.size === 0, 'initial map is set before async computation')
  assert(fake.pendingCount() === 1, 'initial double-rAF starts with one pending frame')
  assert(computed.length === 0, 'no operations computed before frames flush')

  fake.flush()
  assert(computed.length === 0, 'first frame only queues the compute frame')
  fake.flush()
  assert(computed.join(',') === 'op-1', 'second frame computes first operation')
  assert(currentMap.has('op-1'), 'first operation is added to the map')

  fake.flush()
  assert(computed.join(',') === 'op-1', 'paint gap frame does not compute a second operation')
  fake.flush()
  assert(computed.join(',') === 'op-1,op-2', 'next frame computes second operation')
  assert(currentMap.has('op-2'), 'second operation is added to the map')

  fake.flush()
  assert(computed.join(',') === 'op-1,op-2', 'second paint gap frame does not compute third operation')
  fake.flush()
  assert(computed.join(',') === 'op-1,op-2,op-3', 'final compute frame computes third operation')
  assert(currentMap.has('op-3'), 'third operation is added to the map')

  console.log('toolpath pipeline computes uncached operations one per frame: PASSED')
}

try {
  testOperationComputationEquals()
  testIsCacheHit()
  testIsCacheHitFeatureDiff()
  testIsCacheHitFootprint()
  testIsCacheHitStockTargeted()
  testIsCacheHitUnknownFootprint()
  testPipelineRegeneration()
  testOnePerFrameScheduler()
  console.log('\nAll useToolpathGeneration tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
