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

import { useMemo } from 'react'
import type { QuickOperation } from '../components/cam/operationValidity'
import { useProjectStore } from '../store/projectStore'
import type { ProjectStore } from '../store/types'
import { getDefinitionId, getInstanceIdsForDefinition } from '../store/helpers/featureDefinitions'
import { loadBundledToolLibrary } from '../toolLibrary'

type CenterTab = 'sketch' | 'preview3d' | 'simulation'
type RightTab = 'operations' | 'tools'

interface UseFeatureTreeActionsArgs {
  setCenterTab: (tab: CenterTab) => void
  setRightTab: (tab: RightTab) => void
  closeTreeContextMenu: () => void
  onSelectedOperationIdChange: (id: string | null) => void
}

type FeatureTreeActionStore = Pick<
  ProjectStore,
  | 'selectFeature'
  | 'selectFeatures'
  | 'enterSketchEdit'
  | 'enterTabEdit'
  | 'enterClampEdit'
  | 'deleteFeatures'
  | 'deleteTab'
  | 'deleteClamp'
  | 'startMoveFeature'
  | 'startCopyFeature'
  | 'startResizeFeature'
  | 'startRotateFeature'
  | 'startMirrorFeature'
  | 'startOffsetSelectedFeatures'
  | 'startJoinSelectedFeatures'
  | 'startCutSelectedFeatures'
  | 'beginConstraint'
  | 'startMoveTab'
  | 'startCopyTab'
  | 'startMoveClamp'
  | 'startCopyClamp'
  | 'setStockSourceFeature'
  | 'addOperation'
  | 'makeUnique'
  | 'project'
>

interface CreateFeatureTreeActionsArgs extends UseFeatureTreeActionsArgs {
  storeActions: FeatureTreeActionStore
}

export interface FeatureTreeActions {
  editSketch: (featureId: string) => void
  constraint: (featureId: string) => void
  copyFeature: (featureId: string) => void
  duplicateAsReference: (featureId: string) => void
  duplicateIndependent: (featureId: string) => void
  makeUnique: (featureId: string) => void
  selectLinkedInstances: (featureId: string) => void
  moveFeature: (featureId: string) => void
  resizeFeature: (featureId: string) => void
  rotateFeature: (featureId: string) => void
  mirrorFeature: (featureId: string) => void
  offsetFeatures: () => void
  joinFeatures: () => void
  cutFeatures: () => void
  useAsStock: (featureId: string) => void
  deleteFeatures: (featureIds: string[]) => void
  createQuickOperation: (featureId: string, quickOp: QuickOperation) => Promise<void>
  editTab: (tabId: string) => void
  copyTab: (tabId: string) => void
  moveTab: (tabId: string) => void
  deleteTab: (tabId: string) => void
  editClamp: (clampId: string) => void
  copyClamp: (clampId: string) => void
  moveClamp: (clampId: string) => void
  deleteClamp: (clampId: string) => void
}

export function createFeatureTreeActions({
  setCenterTab,
  setRightTab,
  closeTreeContextMenu,
  onSelectedOperationIdChange,
  storeActions,
}: CreateFeatureTreeActionsArgs): FeatureTreeActions {
  const {
    selectFeature,
    selectFeatures,
    enterSketchEdit,
    enterTabEdit,
    enterClampEdit,
    deleteFeatures,
    deleteTab,
    deleteClamp,
    startMoveFeature,
    startCopyFeature,
    startResizeFeature,
    startRotateFeature,
    startMirrorFeature,
    startOffsetSelectedFeatures,
    startJoinSelectedFeatures,
    startCutSelectedFeatures,
    beginConstraint,
    startMoveTab,
    startCopyTab,
    startMoveClamp,
    startCopyClamp,
    setStockSourceFeature,
    addOperation,
    makeUnique: storeMakeUnique,
    project,
  } = storeActions

  const runSketchAction = (action: () => void) => {
    action()
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  return {
    editSketch: (featureId: string) => {
      selectFeature(featureId)
      enterSketchEdit(featureId)
      setCenterTab('sketch')
      closeTreeContextMenu()
    },
    constraint: (featureId: string) => {
      selectFeature(featureId)
      enterSketchEdit(featureId)
      beginConstraint(featureId)
      setCenterTab('sketch')
      closeTreeContextMenu()
    },
    copyFeature: (featureId: string) => {
      runSketchAction(() => startCopyFeature(featureId))
    },
    duplicateAsReference: (featureId: string) => {
      runSketchAction(() => startCopyFeature(featureId, 'reference'))
    },
    duplicateIndependent: (featureId: string) => {
      runSketchAction(() => startCopyFeature(featureId, 'independent'))
    },
    makeUnique: (featureId: string) => {
      storeMakeUnique(featureId)
      closeTreeContextMenu()
    },
    selectLinkedInstances: (featureId: string) => {
      const defId = getDefinitionId(project.features.find((f) => f.id === featureId)!)
      if (defId) {
        const siblingIds = getInstanceIdsForDefinition(project, defId)
        selectFeatures(siblingIds)
      }
      closeTreeContextMenu()
    },
    moveFeature: (featureId: string) => {
      runSketchAction(() => startMoveFeature(featureId))
    },
    resizeFeature: (featureId: string) => {
      runSketchAction(() => startResizeFeature(featureId))
    },
    rotateFeature: (featureId: string) => {
      runSketchAction(() => startRotateFeature(featureId))
    },
    mirrorFeature: (featureId: string) => {
      runSketchAction(() => startMirrorFeature(featureId))
    },
    offsetFeatures: () => {
      runSketchAction(startOffsetSelectedFeatures)
    },
    joinFeatures: () => {
      runSketchAction(startJoinSelectedFeatures)
    },
    cutFeatures: () => {
      runSketchAction(startCutSelectedFeatures)
    },
    useAsStock: (featureId: string) => {
      setStockSourceFeature(featureId)
    },
    deleteFeatures: (featureIds: string[]) => {
      deleteFeatures(featureIds)
      closeTreeContextMenu()
    },
    createQuickOperation: async (featureId: string, quickOp: QuickOperation) => {
      closeTreeContextMenu()
      // Load the bundled library so addOperation can auto-pick/import a proper tool.
      const libraryTools = await loadBundledToolLibrary().then((library) => library.tools).catch(() => [])
      const operationId = addOperation(quickOp.kind, quickOp.pass, { source: 'features', featureIds: [featureId] }, libraryTools)
      if (!operationId) {
        return
      }
      setRightTab('operations')
      onSelectedOperationIdChange(operationId)
    },
    editTab: (tabId: string) => {
      enterTabEdit(tabId)
      setCenterTab('sketch')
      closeTreeContextMenu()
    },
    copyTab: (tabId: string) => {
      runSketchAction(() => startCopyTab(tabId))
    },
    moveTab: (tabId: string) => {
      runSketchAction(() => startMoveTab(tabId))
    },
    deleteTab: (tabId: string) => {
      deleteTab(tabId)
      closeTreeContextMenu()
    },
    editClamp: (clampId: string) => {
      enterClampEdit(clampId)
      setCenterTab('sketch')
      closeTreeContextMenu()
    },
    copyClamp: (clampId: string) => {
      runSketchAction(() => startCopyClamp(clampId))
    },
    moveClamp: (clampId: string) => {
      runSketchAction(() => startMoveClamp(clampId))
    },
    deleteClamp: (clampId: string) => {
      deleteClamp(clampId)
      closeTreeContextMenu()
    },
  }
}

export function useFeatureTreeActions({
  setCenterTab,
  setRightTab,
  closeTreeContextMenu,
  onSelectedOperationIdChange,
}: UseFeatureTreeActionsArgs): FeatureTreeActions {
  const {
    selectFeature,
    selectFeatures,
    enterSketchEdit,
    enterTabEdit,
    enterClampEdit,
    deleteFeatures,
    deleteTab,
    deleteClamp,
    startMoveFeature,
    startCopyFeature,
    startResizeFeature,
    startRotateFeature,
    startMirrorFeature,
    startOffsetSelectedFeatures,
    startJoinSelectedFeatures,
    startCutSelectedFeatures,
    beginConstraint,
    startMoveTab,
    startCopyTab,
    startMoveClamp,
    startCopyClamp,
    setStockSourceFeature,
    addOperation,
    makeUnique: storeMakeUnique,
    project,
  } = useProjectStore()

  return useMemo(() => createFeatureTreeActions({
    setCenterTab,
    setRightTab,
    closeTreeContextMenu,
    onSelectedOperationIdChange,
    storeActions: {
      selectFeature,
      selectFeatures,
      enterSketchEdit,
      enterTabEdit,
      enterClampEdit,
      deleteFeatures,
      deleteTab,
      deleteClamp,
      startMoveFeature,
      startCopyFeature,
      startResizeFeature,
      startRotateFeature,
      startMirrorFeature,
      startOffsetSelectedFeatures,
      startJoinSelectedFeatures,
      startCutSelectedFeatures,
      beginConstraint,
      startMoveTab,
      startCopyTab,
      startMoveClamp,
      startCopyClamp,
      setStockSourceFeature,
      addOperation,
      makeUnique: storeMakeUnique,
      project,
    },
  }), [
    addOperation,
    beginConstraint,
    closeTreeContextMenu,
    deleteClamp,
    deleteFeatures,
    deleteTab,
    enterClampEdit,
    enterSketchEdit,
    enterTabEdit,
    onSelectedOperationIdChange,
    project,
    selectFeature,
    selectFeatures,
    setCenterTab,
    setRightTab,
    setStockSourceFeature,
    startCopyClamp,
    startCopyFeature,
    startCopyTab,
    startCutSelectedFeatures,
    startJoinSelectedFeatures,
    startMirrorFeature,
    startMoveClamp,
    startMoveFeature,
    startMoveTab,
    startOffsetSelectedFeatures,
    startResizeFeature,
    startRotateFeature,
    storeMakeUnique,
  ])
}
