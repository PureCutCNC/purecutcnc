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
 * Unit tests for the light branches of useTreeContextMenu.
 * Run with: npx tsx src/app/useTreeContextMenu.test.ts
 */

import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { useProjectStore } from '../store/projectStore'
import type { Clamp, Project, SketchFeature, Tab } from '../types/project'
import { newProject, rectProfile } from '../types/project'
import { useTreeContextMenu } from './useTreeContextMenu'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

type UseTreeContextMenuArgs = Parameters<typeof useTreeContextMenu>[0]
type UseTreeContextMenuResult = ReturnType<typeof useTreeContextMenu>

function renderUseTreeContextMenu(
  args: UseTreeContextMenuArgs,
  exercise?: (result: UseTreeContextMenuResult) => void,
): UseTreeContextMenuResult {
  let captured: UseTreeContextMenuResult | null = null

  function Capture() {
    const result = useTreeContextMenu(args)
    exercise?.(result)
    // eslint-disable-next-line react-hooks/globals
    captured = result
    return null
  }

  renderToStaticMarkup(createElement(Capture))

  if (!captured) {
    throw new Error('useTreeContextMenu did not render')
  }
  return captured
}

function makeFeature(id: string, overrides: Partial<SketchFeature> = {}): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    text: null,
    stl: null,
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 10, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 0,
    z_bottom: -3,
    visible: true,
    locked: false,
    ...overrides,
  }
}

function makeTab(id: string): Tab {
  return {
    id,
    name: id,
    x: 1,
    y: 2,
    w: 3,
    h: 4,
    z_top: 0,
    z_bottom: -1,
    visible: true,
  }
}

function makeClamp(id: string): Clamp {
  return {
    id,
    name: id,
    type: 'step_clamp',
    x: 1,
    y: 2,
    w: 3,
    h: 4,
    height: 5,
    visible: true,
  }
}

function makeProject({
  features = [makeFeature('feature-1')],
  tabs = [],
  clamps = [],
}: {
  features?: SketchFeature[]
  tabs?: Tab[]
  clamps?: Clamp[]
} = {}): Project {
  return {
    ...newProject('tree-context-menu-test', 'mm'),
    features,
    tabs,
    clamps,
  }
}

function setSelectedFeatureIds(featureIds: string[]) {
  const previous = useProjectStore.getState().selection
  useProjectStore.setState({
    selection: {
      ...previous,
      mode: 'feature',
      selectedFeatureId: featureIds[0] ?? null,
      selectedFeatureIds: featureIds,
      selectedNode: featureIds[0] ? { type: 'feature', featureId: featureIds[0] } : null,
    },
  })
}

function testOpenFeatureContextMenuDerivesFeatureAndSelection() {
  console.log('Testing feature context menu entity and selection derivation...')

  const feature1 = makeFeature('feature-1')
  const feature2 = makeFeature('feature-2')
  const project = makeProject({ features: [feature1, feature2] })
  setSelectedFeatureIds(['feature-1', 'feature-2'])

  let didOpen = false
  const result = renderUseTreeContextMenu({ project }, (current) => {
    if (!didOpen) {
      didOpen = true
      current.openFeatureContextMenu('feature-1', 12, 34)
    }
  })

  const contextMenu = result.treeContextMenu
  if (contextMenu?.entityType !== 'feature') {
    throw new Error('Assertion failed: feature context menu opens')
  }
  assert(result.menuFeature?.id === 'feature-1', 'menuFeature resolves the primary feature')
  assert(contextMenu.ids.length === 2, 'context menu keeps the selected feature ids')
  assert(result.menuHasMultipleSelection === true, 'multiple-selection flag reflects selected ids')

  console.log('feature context menu derivation: PASSED')
}

function testCloseTreeContextMenuResetsState() {
  console.log('Testing context menu close reset...')

  const project = makeProject()
  setSelectedFeatureIds(['feature-1'])

  let didOpen = false
  let didClose = false
  const result = renderUseTreeContextMenu({ project }, (current) => {
    if (!didOpen) {
      didOpen = true
      current.openFeatureContextMenu('feature-1', 12, 34)
      return
    }
    if (!didClose && current.treeContextMenu) {
      didClose = true
      current.closeTreeContextMenu()
    }
  })

  assert(result.treeContextMenu === null, 'treeContextMenu resets to null')
  assert(result.menuFeature === null, 'menuFeature resets to null')
  assert(result.quickOpsSubmenu === null, 'quickOpsSubmenu resets to null')

  console.log('context menu close reset: PASSED')
}

function testEntityRouting() {
  console.log('Testing context menu entity routing...')

  const feature = makeFeature('feature-1')
  const tab = makeTab('tab-1')
  const clamp = makeClamp('clamp-1')
  const project = makeProject({ features: [feature], tabs: [tab], clamps: [clamp] })
  setSelectedFeatureIds([])

  let didOpenTab = false
  const tabResult = renderUseTreeContextMenu({ project }, (current) => {
    if (!didOpenTab) {
      didOpenTab = true
      current.openTabContextMenu('tab-1', 12, 34)
    }
  })
  assert(tabResult.treeContextMenu?.entityType === 'tab', 'tab context menu opens')
  assert(tabResult.menuTab?.id === 'tab-1', 'menuTab resolves the primary tab')
  assert(tabResult.menuFeature === null, 'feature entity stays null for a tab menu')
  assert(tabResult.menuClamp === null, 'clamp entity stays null for a tab menu')

  let didOpenClamp = false
  const clampResult = renderUseTreeContextMenu({ project }, (current) => {
    if (!didOpenClamp) {
      didOpenClamp = true
      current.openClampContextMenu('clamp-1', 12, 34)
    }
  })
  assert(clampResult.treeContextMenu?.entityType === 'clamp', 'clamp context menu opens')
  assert(clampResult.menuClamp?.id === 'clamp-1', 'menuClamp resolves the primary clamp')
  assert(clampResult.menuFeature === null, 'feature entity stays null for a clamp menu')
  assert(clampResult.menuTab === null, 'tab entity stays null for a clamp menu')

  console.log('context menu entity routing: PASSED')
}

try {
  testOpenFeatureContextMenuDerivesFeatureAndSelection()
  testCloseTreeContextMenuResetsState()
  testEntityRouting()
  console.log('\nAll useTreeContextMenu tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
