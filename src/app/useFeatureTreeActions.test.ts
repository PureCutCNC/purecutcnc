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
 * Unit tests for the dispatch shape of useFeatureTreeActions.
 * Run with: npx tsx src/app/useFeatureTreeActions.test.ts
 */

import type { ProjectStore } from '../store/types'
import { newProject, type Operation } from '../types/project'
import { createFeatureTreeActions, type FeatureTreeActions } from './useFeatureTreeActions'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

type CreateFeatureTreeActionsArgs = Parameters<typeof createFeatureTreeActions>[0]
type FeatureTreeActionStore = CreateFeatureTreeActionsArgs['storeActions']

function makeActions(
  calls: string[],
  storeOverrides: Partial<FeatureTreeActionStore>,
): FeatureTreeActions {
  const noop = () => undefined
  const noopVoid = () => {}
  const storeActions: FeatureTreeActionStore = {
    selectFeature: noop,
    selectFeatures: noopVoid,
    enterSketchEdit: noop,
    enterTabEdit: noop,
    enterClampEdit: noop,
    deleteFeatures: noop,
    deleteTab: noop,
    deleteClamp: noop,
    deleteTabs: noop,
    deleteClamps: noop,
    startMoveFeature: noop,
    startCopyFeature: noop,
    startResizeFeature: noop,
    startRotateFeature: noop,
    startMirrorFeature: noop,
    startOffsetSelectedFeatures: noop,
    startJoinSelectedFeatures: noop,
    startCutSelectedFeatures: noop,
    beginConstraint: noop,
    startMoveTab: noop,
    startCopyTab: noop,
    startMoveClamp: noop,
    startCopyClamp: noop,
    setStockSourceFeature: noop,
    addOperation: (() => null) satisfies ProjectStore['addOperation'],
    updateOperation: noopVoid,
    makeUnique: noopVoid,
    groupSelectedFeaturesIntoNewFolder: () => '',
    assignFeaturesToFolder: noopVoid,
    addFeatureFolder: (() => '') satisfies ProjectStore['addFeatureFolder'],
    project: undefined as unknown as ProjectStore['project'],
    ...storeOverrides,
  }

  return createFeatureTreeActions({
    setCenterTab: (tab) => calls.push(`setCenterTab:${tab}`),
    setRightTab: (tab) => calls.push(`setRightTab:${tab}`),
    closeTreeContextMenu: () => calls.push('closeTreeContextMenu'),
    onSelectedOperationIdChange: (id) => calls.push(`onSelectedOperationIdChange:${id ?? 'null'}`),
    storeActions,
  })
}

function testMoveFeatureDispatchShape() {
  console.log('Testing moveFeature dispatch shape...')

  const calls: string[] = []
  const actions = makeActions(calls, {
    startMoveFeature: (featureId) => calls.push(`startMoveFeature:${featureId}`),
  })
  actions.moveFeature('feature-1')

  assert(
    calls.join('|') === 'startMoveFeature:feature-1|setCenterTab:sketch|closeTreeContextMenu',
    'moveFeature calls store start, switches to sketch, and closes the menu',
  )

  console.log('moveFeature dispatch shape: PASSED')
}

function testDeleteFeaturesDoesNotSwitchTabs() {
  console.log('Testing deleteFeatures dispatch shape...')

  const calls: string[] = []
  const actions = makeActions(calls, {
    deleteFeatures: (featureIds) => calls.push(`deleteFeatures:${featureIds.join(',')}`),
  })
  actions.deleteFeatures(['feature-1', 'feature-2'])

  assert(
    calls.join('|') === 'deleteFeatures:feature-1,feature-2|closeTreeContextMenu',
    'deleteFeatures deletes and closes without switching tabs',
  )
  assert(!calls.some((call) => call.startsWith('setCenterTab:')), 'deleteFeatures does not call setCenterTab')

  console.log('deleteFeatures dispatch shape: PASSED')
}

function makeOperation(id: string, featureIds: string[]): Operation {
  return {
    id,
    name: id,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: null,
    stepdown: 1,
    stepover: 0.5,
    feed: 100,
    plungeFeed: 50,
    rpm: 10000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 0,
    maxCarveDepth: 0,
  }
}

function testAddToOperationDispatchShape() {
  console.log('Testing addToOperation dispatch shape...')

  const calls: string[] = []
  const patches: Array<Partial<Operation>> = []
  const actions = makeActions(calls, {
    project: { ...newProject('test'), operations: [makeOperation('op-1', ['feature-1'])] },
    updateOperation: (id, patch) => {
      calls.push(`updateOperation:${id}`)
      patches.push(patch)
    },
  })
  actions.addToOperation(['feature-2'], 'op-1')

  assert(
    calls.join('|') === 'updateOperation:op-1|closeTreeContextMenu',
    'addToOperation updates the operation and closes the menu',
  )
  const target = patches[0]?.target
  assert(
    target?.source === 'features'
      && Array.isArray(target.featureIds)
      && target.featureIds.join() === 'feature-1,feature-2',
    'addToOperation merges the selection into the operation target',
  )

  console.log('addToOperation dispatch shape: PASSED')
}

function testRemoveFromOperationDispatchShape() {
  console.log('Testing removeFromOperation dispatch shape...')

  const calls: string[] = []
  const patches: Array<Partial<Operation>> = []
  const actions = makeActions(calls, {
    project: { ...newProject('test'), operations: [makeOperation('op-1', ['feature-1', 'feature-2'])] },
    updateOperation: (id, patch) => {
      calls.push(`updateOperation:${id}`)
      patches.push(patch)
    },
  })
  actions.removeFromOperation(['feature-1'], 'op-1')

  assert(
    calls.join('|') === 'updateOperation:op-1|closeTreeContextMenu',
    'removeFromOperation updates the operation and closes the menu',
  )
  const target = patches[0]?.target
  assert(
    target?.source === 'features'
      && Array.isArray(target.featureIds)
      && target.featureIds.join() === 'feature-2',
    'removeFromOperation drops the selection from the operation target',
  )

  console.log('removeFromOperation dispatch shape: PASSED')
}

function testOperationTargetActionsGuardMissingOperations() {
  console.log('Testing operation-target action guards...')

  const calls: string[] = []
  const stockOp = { ...makeOperation('op-1', []), target: { source: 'stock' as const } }
  const actions = makeActions(calls, {
    project: { ...newProject('test'), operations: [stockOp] },
    updateOperation: (id) => calls.push(`updateOperation:${id}`),
  })
  actions.addToOperation(['feature-1'], 'missing')
  actions.removeFromOperation(['feature-1'], 'op-1')

  assert(
    calls.join('|') === 'closeTreeContextMenu|closeTreeContextMenu',
    'missing and stock-target operations close the menu without updating',
  )

  console.log('operation-target action guards: PASSED')
}

function testUseAsStockLeavesMenuOpen() {
  console.log('Testing useAsStock dispatch shape...')

  const calls: string[] = []
  const actions = makeActions(calls, {
    setStockSourceFeature: (featureId) => calls.push(`setStockSourceFeature:${featureId ?? 'null'}`),
  })
  actions.useAsStock('feature-1')

  assert(calls.join('|') === 'setStockSourceFeature:feature-1', 'useAsStock only sets the stock source feature')
  assert(!calls.includes('closeTreeContextMenu'), 'useAsStock does not close the menu')

  console.log('useAsStock dispatch shape: PASSED')
}

try {
  testMoveFeatureDispatchShape()
  testDeleteFeaturesDoesNotSwitchTabs()
  testUseAsStockLeavesMenuOpen()
  testAddToOperationDispatchShape()
  testRemoveFromOperationDispatchShape()
  testOperationTargetActionsGuardMissingOperations()
  console.log('\nAll useFeatureTreeActions tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
