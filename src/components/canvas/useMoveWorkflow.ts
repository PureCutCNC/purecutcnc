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
} from 'react'
import type { PendingMoveTool } from '../../store/types'
import type { Point, Project } from '../../types/project'
import { formatLength, parseLengthInput } from '../../utils/units'
import { computeMoveDistancePreviewPoint, type OperationDimEdit } from './manualEntry'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

interface MovePreviewPoint {
  point: Point
  session: number
}

export interface MoveWorkflowCtx {
  projectRef: MutableRefObject<Project>
  operationDimEdit: OperationDimEdit | null
  setOperationDimEdit: Dispatch<SetStateAction<OperationDimEdit | null>>
  operationDimEditRef: MutableRefObject<OperationDimEdit | null>
  setCopyCountDraft: Dispatch<SetStateAction<string>>
  copyCountInputRef: RefObject<HTMLInputElement | null>
  pendingMove: PendingMoveTool | null
  pendingMoveRef: MutableRefObject<PendingMoveTool | null>
  pendingMovePreviewPointRef: MutableRefObject<MovePreviewPoint | null>
  setPendingMovePreviewPointRef: (nextPoint: MovePreviewPoint | null) => void
  cancelPendingMove: () => void
  setPendingMoveTo: (point: Point) => void
  completePendingMove: (toPoint: Point, copyCount?: number) => void
  containerRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  clearTransientCanvasState: () => void
}

export interface MoveWorkflow {
  moveWorkflowPanel: ReturnType<typeof useCanvasWorkflowPanel>
  moveDistanceEditActive: boolean
  copyCountPromptActive: boolean
  cancelMoveFromPanel: () => void
  beginMoveDistanceEntry: (referencePoint: Point) => void
  beginMoveDistanceEntryFromPreview: () => void
  commitMoveDistanceEditFromPanel: () => void
}

export function useMoveWorkflow(ctx: MoveWorkflowCtx): MoveWorkflow {
  const {
    projectRef,
    operationDimEdit,
    setOperationDimEdit,
    operationDimEditRef,
    setCopyCountDraft,
    copyCountInputRef,
    pendingMove,
    pendingMoveRef,
    pendingMovePreviewPointRef,
    setPendingMovePreviewPointRef,
    cancelPendingMove,
    setPendingMoveTo,
    completePendingMove,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  } = ctx

  const moveDistanceEditActive =
    !!pendingMove
    && !!pendingMove.fromPoint
    && !!pendingMove.toPoint
    && (operationDimEdit?.kind === 'move' || operationDimEdit?.kind === 'copy')
  const copyCountPromptActive =
    pendingMove?.mode === 'copy' && !!pendingMove.fromPoint && !!pendingMove.toPoint && !moveDistanceEditActive

  const moveWorkflowPanel = useCanvasWorkflowPanel({
    open: !!pendingMove,
    phaseKey: pendingMove?.fromPoint
      ? (moveDistanceEditActive ? 'distance' : pendingMove.toPoint ? 'count' : 'to')
      : 'from',
    containerRef,
    canvasRef,
    clearTransientCanvasState,
    focusCanvasOnOpen: !moveDistanceEditActive && !copyCountPromptActive,
  })

  function cancelMoveFromPanel() {
    cancelPendingMove()
    setPendingMovePreviewPointRef(null)
    setCopyCountDraft('1')
    setOperationDimEdit(null)
    moveWorkflowPanel.focusCanvasAfterAction()
  }

  function beginMoveDistanceEntry(referencePoint: Point) {
    const pm = pendingMoveRef.current
    if (!pm?.fromPoint) return
    const dx = referencePoint.x - pm.fromPoint.x
    const dy = referencePoint.y - pm.fromPoint.y
    const distance = Math.hypot(dx, dy)
    setPendingMoveTo(referencePoint)
    setPendingMovePreviewPointRef({ point: referencePoint, session: pm.session })
    setOperationDimEdit({
      kind: pm.mode,
      distance: formatLength(distance, projectRef.current.meta.units),
    })
  }

  function beginMoveDistanceEntryFromPreview() {
    const pm = pendingMoveRef.current
    if (!pm?.fromPoint) return
    const previewPoint =
      pendingMovePreviewPointRef.current?.session === pm.session
        ? pendingMovePreviewPointRef.current.point
        : pm.fromPoint
    beginMoveDistanceEntry(previewPoint)
  }

  function commitMoveDistanceEditFromPanel() {
    const currentEdit = operationDimEditRef.current
    if (!currentEdit || (currentEdit.kind !== 'move' && currentEdit.kind !== 'copy')) return
    const pm = pendingMoveRef.current
    if (!pm?.fromPoint) return
    const distance = parseLengthInput(currentEdit.distance, projectRef.current.meta.units)
    if (distance === null) return
    const referencePoint = pm.toPoint ?? pendingMovePreviewPointRef.current?.point ?? pm.fromPoint
    const toPoint = computeMoveDistancePreviewPoint(pm.fromPoint, referencePoint, distance)
    if (currentEdit.kind === 'move') {
      completePendingMove(toPoint)
      setPendingMovePreviewPointRef(null)
    } else {
      setPendingMoveTo(toPoint)
      setPendingMovePreviewPointRef({ point: toPoint, session: pm.session })
      setCopyCountDraft('1')
    }
    setOperationDimEdit(null)
    moveWorkflowPanel.focusCanvasAfterAction()
  }

  // Focus the copy-count input when it becomes active
  useEffect(() => {
    if (!copyCountPromptActive) {
      return
    }
    const frame = window.requestAnimationFrame(() => {
      copyCountInputRef.current?.focus({ preventScroll: true })
      copyCountInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [copyCountPromptActive, copyCountInputRef])

  // Update the move preview point as the user types a distance
  useEffect(() => {
    const pm = pendingMoveRef.current
    if (!operationDimEdit || !pm?.fromPoint) {
      return
    }
    if (operationDimEdit.kind !== 'move' && operationDimEdit.kind !== 'copy') {
      return
    }
    const units = projectRef.current.meta.units
    const distance = parseLengthInput(operationDimEdit.distance, units)
    if (distance === null) {
      return
    }
    setPendingMovePreviewPointRef({
      point: computeMoveDistancePreviewPoint(
        pm.fromPoint,
        pm.toPoint ?? pendingMovePreviewPointRef.current?.point ?? pm.fromPoint,
        distance,
      ),
      session: pm.session,
    })
  }, [operationDimEdit, pendingMovePreviewPointRef, pendingMoveRef, projectRef, setPendingMovePreviewPointRef])

  return {
    moveWorkflowPanel,
    moveDistanceEditActive,
    copyCountPromptActive,
    cancelMoveFromPanel,
    beginMoveDistanceEntry,
    beginMoveDistanceEntryFromPreview,
    commitMoveDistanceEditFromPanel,
  }
}
