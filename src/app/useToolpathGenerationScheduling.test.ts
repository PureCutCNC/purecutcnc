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
 * S4 scheduling tests for useToolpathGeneration (issue #518): gesture
 * coalescing and stale-result retention. Kept in their own file because
 * `useToolpathGeneration.test.ts` sits at the `src/app` max-lines ratchet
 * (eslint.config.js), and the repo rule is to split rather than bump the cap.
 * Run with: npx tsx src/app/useToolpathGenerationScheduling.test.ts
 */

import { type ToolpathResult } from '../engine/toolpaths'
import type { FeatureInstance, Operation, Project, SketchFeature, Tool } from '../types/project'
import { defaultTool, newProject, rectProfile } from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { buildDisplayToolpathMap } from './useToolpathGeneration'
import { makeCountingService } from './toolpathGeneration/testSupport'

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

/** Attach one real tool so `operationFootprint` can resolve a toolRef. */
function withTool(project: Project, tool: Tool = defaultTool('mm')): Project {
  return { ...project, tools: [tool] }
}

/**
 * The shared S4 fixture: the operation targets f1 (the 20×10 rect at the
 * origin) with a 6 mm tool; f2 at (40, 0) lies inside the footprint, f3 at
 * (500, 0) is far outside it (see useToolpathGeneration.test.ts, S3b).
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

/** Immutable per-row edit, matching how the store updates feature rows. */
function patchFeatureRow(project: Project, id: string, patch: Partial<FeatureInstance>): Project {
  return {
    ...project,
    features: project.features.map((feature) => (feature.id === id ? { ...feature, ...patch } : feature)),
  }
}

function makeResult(operationId: string): ToolpathResult {
  return {
    operationId,
    moves: [],
    warnings: [],
    bounds: null,
  }
}


/**
 * S4 harness: fake rAF, a synchronous map setter (so the pipeline's initial
 * map rebuild is observable before any frame flushes), and a write counter.
 */
async function testStaleRetentionDuringRecompute() {
  console.log('Testing a pending recompute keeps the previous result in the map (S4)...')

  const project = makeFootprintProject()
  const operation = footprintOperation(project)
  const harness = makeCountingService({ project, documentKey: 1 }, (id) => makeResult(id))

  harness.service.setAutomaticDemand(harness.context(), [operation.id], false)
  await harness.settle()
  const oldResult = harness.service.peekCurrent(harness.context(), operation.id)
  assert(oldResult !== null, 'the first pass should produce a result')
  assert(harness.calls() === 1, 'the first pass should generate once')

  // Editing the direct target invalidates the cached entry: the operation is
  // queued for recompute, not a cache hit.
  const row = project.features.find((feature) => feature.id === 'f1')
  assert(row !== undefined, 'f1 row should exist')
  const changed = patchFeatureRow(project, 'f1', { transform: { ...row.transform, e: 1 } })
  harness.setContext({ project: changed, documentKey: 1 })

  // Before the recompute settles, the previous result must still be what the
  // viewport draws — this is what stops visible toolpaths blanking out mid-edit.
  assert(
    harness.service.peekCurrent(harness.context(), operation.id) === null,
    'the edited operation must no longer be cache-valid',
  )
  assert(
    buildDisplayToolpathMap(harness.service, harness.context(), [operation.id]).get(operation.id) === oldResult,
    'the previous result must stay in the map while the recompute is pending',
  )

  harness.service.setAutomaticDemand(harness.context(), [operation.id], false)
  await harness.settle()

  assert(harness.calls() === 2, 'the invalidated operation must regenerate exactly once')
  assert(
    buildDisplayToolpathMap(harness.service, harness.context(), [operation.id]).get(operation.id) !== oldResult,
    'the recomputed result must replace the stale placeholder',
  )

  harness.service.dispose()
  console.log('stale-result retention during a recompute: PASSED')
}

async function testMapRebuiltFromNeededOperationIds() {
  console.log('Testing the map is rebuilt from neededOperationIds, dropping removed operations (S4)...')

  const operations = [makeOperation({ id: 'op-1' }), makeOperation({ id: 'op-2' })]
  const project = { ...newProject('toolpath-generation-test', 'mm'), operations }
  const harness = makeCountingService({ project, documentKey: 1 }, (id) => makeResult(id))

  harness.service.setAutomaticDemand(harness.context(), ['op-1', 'op-2'], false)
  await harness.settle()
  assert(harness.calls() === 2, 'both operations should generate')

  // Only op-1 is needed now; the service still holds a result for op-2.
  const map = buildDisplayToolpathMap(harness.service, harness.context(), ['op-1'])
  assert(map.has('op-1'), 'the needed operation must stay in the map')
  assert(!map.has('op-2'), 'an operation removed from neededOperationIds must be dropped from the map')
  assert(map.size === 1, 'nothing beyond the needed list may be carried over')

  harness.service.setAutomaticDemand(harness.context(), ['op-1'], false)
  await harness.settle()
  assert(harness.calls() === 2, 'a cache hit must not regenerate')

  harness.service.dispose()
  console.log('map rebuilt from neededOperationIds: PASSED')
}

async function testDeferredGeneration() {
  console.log('Testing deferGeneration coalesces generation until it flips back (S4)...')

  const project = makeFootprintProject()
  const operation = footprintOperation(project)
  const harness = makeCountingService({ project, documentKey: 1 }, (id) => makeResult(id))

  harness.service.setAutomaticDemand(harness.context(), [operation.id], false)
  await harness.settle()
  const oldResult = harness.service.peekCurrent(harness.context(), operation.id)
  assert(oldResult !== null, 'the first pass should produce a result')
  const callsBefore = harness.calls()

  // The edit invalidates the cached entry (direct target transform change).
  const row = project.features.find((feature) => feature.id === 'f1')
  assert(row !== undefined, 'f1 row should exist')
  const changed = patchFeatureRow(project, 'f1', { transform: { ...row.transform, e: 1 } })
  harness.setContext({ project: changed, documentKey: 1 })

  // Deferred: no work is accepted at all, and the previous result keeps being
  // what the viewport draws.
  harness.service.setAutomaticDemand(harness.context(), [operation.id], true)
  await harness.settle()
  assert(harness.calls() === callsBefore, 'deferred: the generator must not be called for an invalidated operation')
  assert(harness.service.getSnapshot().queuedCount === 0, 'deferred: nothing may be queued')
  assert(
    buildDisplayToolpathMap(harness.service, harness.context(), [operation.id]).get(operation.id) === oldResult,
    'deferred: the previous result must stay in the map',
  )

  // Repeated deferred demand — a drag rewrites the project every pointermove —
  // still accumulates nothing.
  for (let index = 0; index < 5; index += 1) {
    const dragged = patchFeatureRow(project, 'f1', { transform: { ...row.transform, e: 1 + index } })
    harness.setContext({ project: dragged, documentKey: 1 })
    harness.service.setAutomaticDemand(harness.context(), [operation.id], true)
  }
  await harness.settle()
  assert(harness.calls() === callsBefore, 'deferred: a gesture must not accumulate jobs')

  // Flipping back to false runs generation exactly once for the whole gesture.
  harness.service.setAutomaticDemand(harness.context(), [operation.id], false)
  await harness.settle()
  assert(harness.calls() === callsBefore + 1, 'resuming must regenerate exactly once')
  assert(
    buildDisplayToolpathMap(harness.service, harness.context(), [operation.id]).get(operation.id) !== oldResult,
    'the resumed regeneration must replace the stale result',
  )

  harness.service.dispose()
  console.log('deferGeneration coalescing: PASSED')
}

async function main(): Promise<void> {
  try {
    await testStaleRetentionDuringRecompute()
    await testMapRebuiltFromNeededOperationIds()
    await testDeferredGeneration()
    console.log('\nAll useToolpathGeneration S4 scheduling tests PASSED.')
  } catch (e) {
    console.error(e)
    process.exit(1)
  }
}

void main()
