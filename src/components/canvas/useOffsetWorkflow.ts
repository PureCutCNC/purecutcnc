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

import {
  type Dispatch,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from 'react'
import type { PendingOffsetTool } from '../../store/types'
import type { Point, Project } from '../../types/project'
import { parseLengthInput } from '../../utils/units'
import type { OperationDimEdit } from './manualEntry'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

export interface OffsetWorkflowCtx {
  projectRef: MutableRefObject<Project>
  operationDimEdit: OperationDimEdit | null
  setOperationDimEdit: Dispatch<SetStateAction<OperationDimEdit | null>>
  operationDimEditRef: MutableRefObject<OperationDimEdit | null>
  pendingOffset: PendingOffsetTool | null
  setPendingOffsetPreviewPointRef: (nextPoint: { point: Point; session: number } | null) => void
  setPendingOffsetRawPreviewPointRef: (nextPoint: { point: Point; session: number } | null) => void
  cancelPendingOffset: () => void
  completePendingOffset: (distance: number) => void
  triggerDimensionEdit: () => void
  containerRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  clearTransientCanvasState: () => void
}

export interface OffsetWorkflow {
  offsetWorkflowPanel: ReturnType<typeof useCanvasWorkflowPanel>
  offsetDistanceEditActive: boolean
  cancelOffsetFromPanel: () => void
  triggerDimensionFromOffsetPanel: () => void
  commitOffsetDistanceEditFromPanel: () => void
}

export function useOffsetWorkflow(ctx: OffsetWorkflowCtx): OffsetWorkflow {
  const {
    projectRef,
    operationDimEdit,
    setOperationDimEdit,
    operationDimEditRef,
    pendingOffset,
    setPendingOffsetPreviewPointRef,
    setPendingOffsetRawPreviewPointRef,
    cancelPendingOffset,
    completePendingOffset,
    triggerDimensionEdit,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  } = ctx

  const offsetDistanceEditActive =
    !!pendingOffset && operationDimEdit?.kind === 'offset'

  const offsetWorkflowPanel = useCanvasWorkflowPanel({
    open: !!pendingOffset,
    phaseKey: offsetDistanceEditActive ? 'distance' : 'offset',
    containerRef,
    canvasRef,
    clearTransientCanvasState,
    focusCanvasOnOpen: !offsetDistanceEditActive,
  })

  function cancelOffsetFromPanel() {
    cancelPendingOffset()
    setPendingOffsetPreviewPointRef(null)
    setPendingOffsetRawPreviewPointRef(null)
    setOperationDimEdit(null)
    offsetWorkflowPanel.focusCanvasAfterAction()
  }

  function triggerDimensionFromOffsetPanel() {
    triggerDimensionEdit()
  }

  function commitOffsetDistanceEditFromPanel() {
    const currentEdit = operationDimEditRef.current
    if (!currentEdit || currentEdit.kind !== 'offset') return
    const distance = parseLengthInput(currentEdit.distance, projectRef.current.meta.units)
    if (distance === null) return
    completePendingOffset(distance)
    setPendingOffsetPreviewPointRef(null)
    setPendingOffsetRawPreviewPointRef(null)
    setOperationDimEdit(null)
    offsetWorkflowPanel.focusCanvasAfterAction()
  }

  return {
    offsetWorkflowPanel,
    offsetDistanceEditActive,
    cancelOffsetFromPanel,
    triggerDimensionFromOffsetPanel,
    commitOffsetDistanceEditFromPanel,
  }
}
