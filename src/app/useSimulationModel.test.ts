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
 * Unit tests for the light branches of useSimulationModel.
 * Run with: npx tsx src/app/useSimulationModel.test.ts
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { ToolpathResult } from '../engine/toolpaths'
import type { Operation, Project, Tool } from '../types/project'
import { newProject } from '../types/project'
import { useSimulationModel } from './useSimulationModel'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

type UseSimulationModelArgs = Parameters<typeof useSimulationModel>[0]
type UseSimulationModelResult = ReturnType<typeof useSimulationModel>

function renderUseSimulationModel(args: UseSimulationModelArgs): UseSimulationModelResult {
  let captured: UseSimulationModelResult | null = null

  function Capture() {
    // eslint-disable-next-line react-hooks/globals
    captured = useSimulationModel(args)
    return null
  }

  renderToStaticMarkup(createElement(Capture))

  if (!captured) {
    throw new Error('useSimulationModel did not render')
  }
  return captured
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

function makeProject(operations: Operation[]): Project {
  return {
    ...newProject('simulation-model-test', 'mm'),
    operations,
  }
}

function makeToolpath(operationId: string): ToolpathResult {
  return {
    operationId,
    moves: [],
    warnings: [],
    bounds: null,
  }
}

function makeArgs(overrides: Partial<UseSimulationModelArgs> = {}): UseSimulationModelArgs {
  const selectedOperation = makeOperation()
  const project = makeProject([selectedOperation])
  return {
    project,
    centerTab: 'sketch',
    simulationMode: 'selected',
    simulationDetailCells: 280,
    selectedOperation,
    selectedToolpath: makeToolpath(selectedOperation.id),
    generateToolpathForOperation: () => null,
    ...overrides,
  }
}

function testSimulationResultIsNullOffSimulationTab() {
  console.log('Testing simulationResult is null off the simulation tab...')

  const result = renderUseSimulationModel(makeArgs({ centerTab: 'sketch' }))

  assert(result.simulationResult === null, 'simulationResult is null when centerTab is sketch')
  assert(result.simulationPlaybackInput === null, 'simulationPlaybackInput is null when centerTab is sketch')

  console.log('simulationResult off-tab null branch: PASSED')
}

function testSelectedOperationCount() {
  console.log('Testing selected simulation operation count...')

  const selectedOperation = makeOperation({ id: 'selected-op' })
  const result = renderUseSimulationModel(makeArgs({
    project: makeProject([selectedOperation]),
    simulationMode: 'selected',
    selectedOperation,
    selectedToolpath: makeToolpath(selectedOperation.id),
  }))

  assert(result.simulationOperationCount === 1, 'selected mode counts selected operation with toolpath')

  const emptyResult = renderUseSimulationModel(makeArgs({
    project: makeProject([selectedOperation]),
    simulationMode: 'selected',
    selectedOperation,
    selectedToolpath: null,
  }))

  assert(emptyResult.simulationOperationCount === 0, 'selected mode counts zero without selected toolpath')

  console.log('selected simulation operation count: PASSED')
}

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    id: 'tool-1',
    name: 'Test endmill',
    units: 'mm',
    type: 'flat_endmill',
    diameter: 6,
    vBitAngle: null,
    flutes: 2,
    material: 'carbide',
    defaultRpm: 18000,
    defaultFeed: 800,
    defaultPlungeFeed: 300,
    defaultStepdown: 2,
    defaultStepover: 0.4,
    maxCutDepth: 20,
    ...overrides,
  }
}

function testPlaybackBaseGridIsLazyAndCached() {
  console.log('Testing playback base grid computes lazily and caches...')

  const selectedOperation = makeOperation()
  const project = { ...makeProject([selectedOperation]), tools: [makeTool()] }
  const result = renderUseSimulationModel(makeArgs({
    project,
    centerTab: 'simulation',
    simulationMode: 'selected',
    selectedOperation,
    selectedToolpath: makeToolpath(selectedOperation.id),
  }))

  const playbackInput = result.simulationPlaybackInput
  assert(playbackInput !== null, 'playback input should exist for a selected op with a tool')

  const first = playbackInput!.getBaseGrid()
  assert(first.cols > 0 && first.rows > 0, 'base grid should have a real resolution')
  assert(first.topZ.length === first.cols * first.rows, 'base grid heightfield should match its dimensions')

  const second = playbackInput!.getBaseGrid()
  assert(second === first, 'repeat calls must return the cached grid, not replay again')

  console.log('lazy cached playback base grid: PASSED')
}

function testVisibleOperationCount() {
  console.log('Testing visible simulation operation count...')

  const operations = [
    makeOperation({ id: 'visible-enabled', enabled: true, showToolpath: true }),
    makeOperation({ id: 'visible-disabled', enabled: false, showToolpath: true }),
    makeOperation({ id: 'visible-hidden', enabled: true, showToolpath: false }),
    makeOperation({ id: 'visible-enabled-2', enabled: true, showToolpath: true }),
  ]

  const result = renderUseSimulationModel(makeArgs({
    project: makeProject(operations),
    simulationMode: 'visible',
    selectedOperation: operations[0],
    selectedToolpath: makeToolpath(operations[0].id),
  }))

  assert(result.simulationOperationCount === 2, 'visible mode counts enabled operations with shown toolpaths')

  console.log('visible simulation operation count: PASSED')
}

try {
  testSimulationResultIsNullOffSimulationTab()
  testSelectedOperationCount()
  testPlaybackBaseGridIsLazyAndCached()
  testVisibleOperationCount()
  console.log('\nAll useSimulationModel tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
