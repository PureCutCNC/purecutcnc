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

import type { ToolpathResult } from '../engine/toolpaths'
import type { Operation, Project } from '../types/project'
import { newProject } from '../types/project'
import {
  isCacheHit,
  operationComputationEquals,
  startToolpathGenerationPipeline,
  type ToolpathCacheEntry,
} from './useToolpathGeneration'

function assert(condition: boolean, message: string) {
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
    ...overrides,
  }
}

function makeProject(operation = makeOperation()): Project {
  return {
    ...newProject('toolpath-generation-test', 'mm'),
    operations: [operation],
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

function makeEntry(project: Project, operation: Operation, result = makeResult(operation.id)): ToolpathCacheEntry {
  return {
    result,
    operation,
    stock: project.stock,
    features: project.features,
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
  assert(!isCacheHit(entry, operation, { ...project, features: [...project.features] }), 'features reference change misses')
  assert(!isCacheHit(entry, operation, { ...project, tools: [...project.tools] }), 'tools reference change misses')
  assert(!isCacheHit(entry, operation, { ...project, tabs: [...project.tabs] }), 'tabs reference change misses')
  assert(!isCacheHit(entry, operation, { ...project, clamps: [...project.clamps] }), 'clamps reference change misses')

  console.log('isCacheHit reference and operation invalidation: PASSED')
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
  testOnePerFrameScheduler()
  console.log('\nAll useToolpathGeneration tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
