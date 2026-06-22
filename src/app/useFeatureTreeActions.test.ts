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
    makeUnique: noopVoid,
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
  console.log('\nAll useFeatureTreeActions tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
