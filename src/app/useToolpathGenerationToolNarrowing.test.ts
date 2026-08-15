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
 * S5 Part B tests for useToolpathGeneration (issue #518): narrowing the tools
 * gate from whole-array identity to the operation's own tool. Kept in their
 * own file because `useToolpathGeneration.test.ts` sits at the `src/app`
 * max-lines ratchet (eslint.config.js), and the repo rule is to split rather
 * than bump the cap.
 * Run with: npx tsx src/app/useToolpathGenerationToolNarrowing.test.ts
 */

import { type ToolpathResult } from '../engine/toolpaths'
import type { Operation, Project, SketchFeature, Tool } from '../types/project'
import { defaultTool, newProject, rectProfile } from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import {
  buildToolpathCacheEntry,
  isCacheHit,
  startToolpathGenerationPipeline,
  type ToolpathCacheEntry,
} from './useToolpathGeneration'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  const target = { source: 'features', featureIds: ['f1'] } satisfies Operation['target']
  return {
    id: 'op-1',
    name: 'Operation 1',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target,
    toolRef: 't1',
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

/** Attach one real tool so `operationFootprint` can resolve a toolRef. */
function withTool(project: Project, tool: Tool = defaultTool('mm')): Project {
  return { ...project, tools: [tool] }
}

/**
 * One operation targeting f1 (the 20×10 rect at the origin) with the default
 * 6 mm tool (`t1`). Built the same way as `makeFootprintProject` in
 * `useToolpathGeneration.test.ts`.
 */
function makeToolProject(): Project {
  const operation = makeOperation()
  return withTool(
    projectWithFeatures(
      { ...newProject('toolpath-generation-tool-narrowing-test', 'mm'), operations: [operation] },
      [draftFeature('f1')],
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
  return { raf, flush }
}

function testIsCacheHitToolNarrowing() {
  console.log('Testing isCacheHit tool narrowing (S5 Part B)...')

  const project = makeToolProject()
  const operation = footprintOperation(project)
  const entry = buildToolpathCacheEntry(project, operation, makeResult(operation.id))
  const unrelatedTool: Tool = { ...defaultTool('mm'), id: 't2' }

  // 6. Importing an unrelated tool must not invalidate: the operation's own
  // tool row is untouched, and no engine call site reads any other tool.
  const imported: Project = { ...project, tools: [...project.tools, unrelatedTool] }
  assert(isCacheHit(entry, operation, imported), 'importing an unrelated tool must keep the cache hit')

  // 7. Editing the operation's own tool (diameter) must invalidate.
  const ownEdited: Project = { ...project, tools: [{ ...defaultTool('mm'), diameter: 8 }] }
  assert(!isCacheHit(entry, operation, ownEdited), "editing the operation's own tool must miss")

  // 8. Removing the operation's own tool must invalidate (unknown means
  // invalidate).
  const ownRemoved: Project = { ...project, tools: [] }
  assert(!isCacheHit(entry, operation, ownRemoved), "removing the operation's own tool must miss")

  // 9. Deleting an unrelated tool must not invalidate: build the entry from a
  // two-tool snapshot, then delete the unrelated one.
  const twoTools: Project = { ...project, tools: [...project.tools, unrelatedTool] }
  const twoEntry = buildToolpathCacheEntry(twoTools, operation, makeResult(operation.id))
  const oneTool: Project = { ...project, tools: [...project.tools] }
  assert(isCacheHit(twoEntry, operation, oneTool), 'deleting an unrelated tool must keep the cache hit')

  console.log('isCacheHit tool narrowing: PASSED')
}

function testPipelineUnrelatedToolImport() {
  console.log('Testing pipeline: importing an unrelated tool must not regenerate (S5 Part B)...')

  const project = makeToolProject()
  const operation = footprintOperation(project)
  const cache = new Map<string, ToolpathCacheEntry>()
  const primedResult = makeResult(operation.id)
  cache.set(operation.id, buildToolpathCacheEntry(project, operation, primedResult))

  let generatedCalls = 0
  const generateToolpathForOperation = (op: Operation | null): ToolpathResult | null => {
    if (!op) return null
    generatedCalls += 1
    return makeResult(op.id)
  }
  const fake = makeFakeRaf()
  let currentMap = new Map<string, ToolpathResult>()
  const setToolpathMap = (
    value: Map<string, ToolpathResult> | ((prev: Map<string, ToolpathResult>) => Map<string, ToolpathResult>),
  ): void => {
    currentMap = typeof value === 'function' ? value(currentMap) : value
  }
  const scheduleAfterPaint = (fn: () => void): void => {
    fake.raf(() => fake.raf(fn))
  }

  // 10. The user-visible behaviour: with the cache primed, importing an
  // unrelated tool must leave the generator untouched and the cached result
  // on the map.
  const unrelatedTool: Tool = { ...defaultTool('mm'), id: 't2' }
  const nextProject: Project = { ...project, tools: [...project.tools, unrelatedTool] }
  startToolpathGenerationPipeline({
    neededOperationIds: [operation.id],
    project: nextProject,
    toolpathCache: cache,
    generateToolpathForOperation,
    setToolpathMap,
    requestAnimationFrameFn: fake.raf,
    scheduleAfterPaintFn: scheduleAfterPaint,
  })
  fake.flush()
  fake.flush()

  const callsAfterImport = generatedCalls
  assert(callsAfterImport === 0, 'importing an unrelated tool must not regenerate the toolpath')
  assert(currentMap.get(operation.id) === primedResult, 'the cached result must stay in the map')

  console.log('pipeline unrelated-tool import: PASSED')
}

try {
  testIsCacheHitToolNarrowing()
  testPipelineUnrelatedToolImport()
  console.log('\nAll useToolpathGeneration S5 tool-narrowing tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
