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
  useEffect,
  useRef,
  useState,
} from 'react'
import type { PendingTransformTool } from '../../store/types'
import type { Point } from '../../types/project'
import { computeRotatePreviewPoint, computeScalePreviewPoint } from './manualEntry'
import type { OperationDimEdit } from './manualEntry'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

interface TransformPreviewPoint {
  point: Point
  session: number
}

export interface TransformExactWorkflowCtx {
  operationDimEdit: OperationDimEdit | null
  setOperationDimEdit: Dispatch<SetStateAction<OperationDimEdit | null>>
  operationDimEditRef: MutableRefObject<OperationDimEdit | null>
  pendingTransform: PendingTransformTool | null
  pendingTransformRef: MutableRefObject<PendingTransformTool | null>
  pendingTransformPreviewPointRef: MutableRefObject<TransformPreviewPoint | null>
  setPendingTransformPreviewPointRef: (nextPoint: TransformPreviewPoint | null) => void
  cancelPendingTransform: () => void
  completePendingTransform: (previewPoint: Point, copyCount?: number) => void
  triggerDimensionEdit: () => void
  containerRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  clearTransientCanvasState: () => void
}

export interface TransformExactWorkflow {
  transformWorkflowPanel: ReturnType<typeof useCanvasWorkflowPanel>
  transformScaleEditActive: boolean
  transformRotateEditActive: boolean
  transformExactEditActive: boolean
  rotateCopyCountPromptActive: boolean
  pendingRotateCopyPoint: Point | null
  setPendingRotateCopyPoint: Dispatch<SetStateAction<Point | null>>
  rotateCopyCountDraft: string
  setRotateCopyCountDraft: Dispatch<SetStateAction<string>>
  rotateCopyCountInputRef: RefObject<HTMLInputElement | null>
  cancelTransformFromPanel: () => void
  triggerDimensionFromTransformPanel: () => void
  commitTransformExactEditFromPanel: () => void
  commitRotateCopyFromPanel: () => void
}

export function useTransformExactWorkflow(ctx: TransformExactWorkflowCtx): TransformExactWorkflow {
  const {
    operationDimEdit,
    setOperationDimEdit,
    operationDimEditRef,
    pendingTransform,
    pendingTransformRef,
    setPendingTransformPreviewPointRef,
    cancelPendingTransform,
    completePendingTransform,
    triggerDimensionEdit,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  } = ctx

  const [rotateCopyCountDraft, setRotateCopyCountDraft] = useState('1')
  const [pendingRotateCopyPoint, setPendingRotateCopyPoint] = useState<Point | null>(null)
  const rotateCopyCountInputRef = useRef<HTMLInputElement>(null)

  const transformScaleEditActive =
    !!pendingTransform
    && pendingTransform.mode === 'resize'
    && !!pendingTransform.referenceStart
    && !!pendingTransform.referenceEnd
    && operationDimEdit?.kind === 'scale'
  const transformRotateEditActive =
    !!pendingTransform
    && pendingTransform.mode === 'rotate'
    && !!pendingTransform.referenceStart
    && !!pendingTransform.referenceEnd
    && operationDimEdit?.kind === 'rotate'
  const transformExactEditActive = transformScaleEditActive || transformRotateEditActive
  const rotateCopyCountPromptActive = !!pendingRotateCopyPoint

  const transformWorkflowPanel = useCanvasWorkflowPanel({
    open: !!pendingTransform,
    phaseKey: transformExactEditActive ? 'exact' : pendingTransform?.referenceEnd ? 'commit' : (pendingTransform?.referenceStart ? 'end' : 'start'),
    containerRef,
    canvasRef,
    clearTransientCanvasState,
    focusCanvasOnOpen: !transformExactEditActive && !rotateCopyCountPromptActive,
  })

  function cancelTransformFromPanel() {
    cancelPendingTransform()
    setPendingTransformPreviewPointRef(null)
    setPendingRotateCopyPoint(null)
    setRotateCopyCountDraft('1')
    setOperationDimEdit(null)
    transformWorkflowPanel.focusCanvasAfterAction()
  }

  function triggerDimensionFromTransformPanel() {
    triggerDimensionEdit()
  }

  function commitTransformExactEditFromPanel() {
    const currentEdit = operationDimEditRef.current
    const pt = pendingTransformRef.current
    if (!currentEdit || !pt?.referenceStart || !pt.referenceEnd) return

    if (currentEdit.kind === 'scale') {
      if (pt.mode !== 'resize') return
      const factor = Number(currentEdit.factor)
      if (!Number.isFinite(factor) || factor <= 0) return
      const previewPoint = computeScalePreviewPoint(
        pt.referenceStart,
        pt.referenceEnd,
        factor,
      )
      completePendingTransform(previewPoint)
      setPendingTransformPreviewPointRef(null)
      setOperationDimEdit(null)
      transformWorkflowPanel.focusCanvasAfterAction()
      return
    }

    if (currentEdit.kind === 'rotate') {
      if (pt.mode !== 'rotate') return
      const angleDegrees = Number(currentEdit.angle)
      if (!Number.isFinite(angleDegrees)) return
      const previewPoint = computeRotatePreviewPoint(
        pt.referenceStart,
        pt.referenceEnd,
        angleDegrees,
      )
      if (pt.keepOriginals) {
        setPendingRotateCopyPoint(previewPoint)
      } else {
        completePendingTransform(previewPoint)
        setPendingTransformPreviewPointRef(null)
      }
      setOperationDimEdit(null)
      transformWorkflowPanel.focusCanvasAfterAction()
    }
  }

  function commitRotateCopyFromPanel() {
    const n = Math.max(1, Math.floor(Number(rotateCopyCountDraft) || 1))
    completePendingTransform(pendingRotateCopyPoint!, n)
    setPendingTransformPreviewPointRef(null)
    setPendingRotateCopyPoint(null)
    setRotateCopyCountDraft('1')
    transformWorkflowPanel.focusCanvasAfterAction()
  }

  // Focus the rotate-copy count input when it becomes active
  useEffect(() => {
    if (!rotateCopyCountPromptActive) {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      rotateCopyCountInputRef.current?.focus({ preventScroll: true })
      rotateCopyCountInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [rotateCopyCountPromptActive])

  // Update the transform preview point as the user types a scale factor or angle
  useEffect(() => {
    const pt = pendingTransformRef.current
    if (
      !operationDimEdit
      || (operationDimEdit.kind !== 'scale' && operationDimEdit.kind !== 'rotate')
      || !pt
      || !pt.referenceStart
      || !pt.referenceEnd
    ) {
      return
    }

    if (operationDimEdit.kind === 'scale') {
      if (pt.mode !== 'resize') {
        return
      }
      const factor = Number(operationDimEdit.factor)
      if (!Number.isFinite(factor) || factor <= 0) {
        return
      }
      setPendingTransformPreviewPointRef({
        point: computeScalePreviewPoint(
          pt.referenceStart,
          pt.referenceEnd,
          factor,
        ),
        session: pt.session,
      })
      return
    }

    if (pt.mode !== 'rotate') {
      return
    }

    const angleDegrees = Number(operationDimEdit.angle)
    if (!Number.isFinite(angleDegrees)) {
      return
    }
    setPendingTransformPreviewPointRef({
      point: computeRotatePreviewPoint(
        pt.referenceStart,
        pt.referenceEnd,
        angleDegrees,
      ),
      session: pt.session,
    })
  }, [operationDimEdit, pendingTransformRef, setPendingTransformPreviewPointRef])

  return {
    transformWorkflowPanel,
    transformScaleEditActive,
    transformRotateEditActive,
    transformExactEditActive,
    rotateCopyCountPromptActive,
    pendingRotateCopyPoint,
    setPendingRotateCopyPoint,
    rotateCopyCountDraft,
    setRotateCopyCountDraft,
    rotateCopyCountInputRef,
    cancelTransformFromPanel,
    triggerDimensionFromTransformPanel,
    commitTransformExactEditFromPanel,
    commitRotateCopyFromPanel,
  }
}
