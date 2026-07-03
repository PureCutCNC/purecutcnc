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
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { KeyboardEvent } from 'react'
import type { PendingConstraint } from '../../store/types'
import type { Project } from '../../types/project'
import { parseLengthInput } from '../../utils/units'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

export interface ConstraintWorkflowCtx {
  projectRef: MutableRefObject<Project>
  canvasRef: RefObject<HTMLCanvasElement | null>
  containerRef: RefObject<HTMLDivElement | null>
  pendingConstraint: PendingConstraint | null
  pendingConstraintRef: MutableRefObject<PendingConstraint | null>
  clearTransientCanvasState: () => void
  commitConstraintDistance: (distance: number) => void
  cancelPendingConstraint: () => void
  updateConstraintValue: (featureId: string, constraintId: string, value: number) => void
}

type ConstraintEditState = {
  featureId: string
  constraintId: string
  value: string
} | null

export interface ConstraintWorkflow {
  constraintEdit: ConstraintEditState
  setConstraintEdit: Dispatch<SetStateAction<ConstraintEditState>>
  constraintEditRef: MutableRefObject<ConstraintEditState>
  constraintEditInputRef: RefObject<HTMLInputElement | null>
  constraintDistanceInput: string | null
  setConstraintDistanceInput: Dispatch<SetStateAction<string | null>>
  constraintDistanceInputRef: RefObject<HTMLInputElement | null>
  constraintDistanceReady: boolean
  constraintWorkflowPanel: ReturnType<typeof useCanvasWorkflowPanel>
  constraintEditWorkflowPanel: ReturnType<typeof useCanvasWorkflowPanel>
  commitConstraintFromPanel: () => void
  cancelConstraintFromPanel: () => void
  commitConstraintEdit: () => void
  cancelConstraintEdit: () => void
  commitConstraintEditFromPanel: () => void
  cancelConstraintEditFromPanel: () => void
  handleConstraintKeyDown: (e: KeyboardEvent<HTMLCanvasElement>) => boolean
}

export function useConstraintWorkflow(ctx: ConstraintWorkflowCtx): ConstraintWorkflow {
  const {
    projectRef,
    canvasRef,
    containerRef,
    pendingConstraint,
    pendingConstraintRef,
    clearTransientCanvasState,
    commitConstraintDistance,
    cancelPendingConstraint,
    updateConstraintValue,
  } = ctx

  const [constraintEdit, setConstraintEdit] = useState<ConstraintEditState>(null)
  const constraintEditRef = useRef<ConstraintEditState>(null)
  const constraintEditInputRef = useRef<HTMLInputElement>(null)
  const [constraintDistanceInput, setConstraintDistanceInput] = useState<string | null>(null)
  const constraintDistanceInputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    constraintEditRef.current = constraintEdit
  })

  const constraintDistanceReady = !!pendingConstraint && !!pendingConstraint.anchor && !!pendingConstraint.reference

  const constraintWorkflowPanel = useCanvasWorkflowPanel({
    open: !!pendingConstraint,
    phaseKey: constraintDistanceReady
      ? 'distance'
      : pendingConstraint?.anchor
        ? 'reference'
        : 'anchor',
    containerRef,
    canvasRef,
    clearTransientCanvasState,
    focusCanvasOnOpen: constraintDistanceInput == null,
  })

  const constraintEditWorkflowPanel = useCanvasWorkflowPanel({
    open: !!constraintEdit,
    phaseKey: 'editing',
    containerRef,
    canvasRef,
    clearTransientCanvasState,
    focusCanvasOnOpen: false,
  })

  function commitConstraintFromPanel() {
    const parsed = parseLengthInput(constraintDistanceInput ?? '', projectRef.current.meta.units)
    if (parsed != null && parsed >= 0) {
      commitConstraintDistance(parsed)
      setConstraintDistanceInput(null)
    }
    constraintWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelConstraintFromPanel() {
    cancelPendingConstraint()
    setConstraintDistanceInput(null)
    constraintWorkflowPanel.focusCanvasAfterAction()
  }

  function commitConstraintEdit() {
    const edit = constraintEditRef.current
    if (!edit) return
    const parsed = parseLengthInput(edit.value, projectRef.current.meta.units)
    if (parsed != null && parsed >= 0) {
      updateConstraintValue(edit.featureId, edit.constraintId, parsed)
    }
    setConstraintEdit(null)
    canvasRef.current?.focus({ preventScroll: true })
  }

  function cancelConstraintEdit() {
    setConstraintEdit(null)
    canvasRef.current?.focus({ preventScroll: true })
  }

  function commitConstraintEditFromPanel() {
    const edit = constraintEditRef.current
    if (!edit) return
    const parsed = parseLengthInput(edit.value, projectRef.current.meta.units)
    if (parsed != null && parsed >= 0) {
      updateConstraintValue(edit.featureId, edit.constraintId, parsed)
    }
    setConstraintEdit(null)
    constraintEditWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelConstraintEditFromPanel() {
    setConstraintEdit(null)
    constraintEditWorkflowPanel.focusCanvasAfterAction()
  }

  function handleConstraintKeyDown(e: KeyboardEvent<HTMLCanvasElement>): boolean {
    const pc = pendingConstraintRef.current
    if (!pc) return false

    if (e.key === 'Escape') {
      e.preventDefault()
      cancelPendingConstraint()
      setConstraintDistanceInput(null)
      canvasRef.current?.focus({ preventScroll: true })
      return true
    }
    if (e.key === 'Enter' && pc.reference && constraintDistanceInput != null) {
      e.preventDefault()
      const parsed = parseLengthInput(constraintDistanceInput, projectRef.current.meta.units)
      if (parsed != null && parsed >= 0) {
        commitConstraintDistance(parsed)
        setConstraintDistanceInput(null)
        canvasRef.current?.focus({ preventScroll: true })
      }
      return true
    }
    return true
  }

  // Focus the distance input when it becomes non-null
  const hasConstraintDistanceInput = constraintDistanceInput != null
  useEffect(() => {
    if (!hasConstraintDistanceInput) return
    const frame = window.requestAnimationFrame(() => {
      constraintDistanceInputRef.current?.focus({ preventScroll: true })
      constraintDistanceInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [hasConstraintDistanceInput])

  // Focus the inline edit input when it becomes non-null
  const constraintEditId = constraintEdit?.constraintId ?? null
  useEffect(() => {
    if (constraintEditId == null) return
    const frame = window.requestAnimationFrame(() => {
      constraintEditInputRef.current?.focus({ preventScroll: true })
      constraintEditInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [constraintEditId])

  return {
    constraintEdit,
    setConstraintEdit,
    constraintEditRef,
    constraintEditInputRef,
    constraintDistanceInput,
    setConstraintDistanceInput,
    constraintDistanceInputRef,
    constraintDistanceReady,
    constraintWorkflowPanel,
    constraintEditWorkflowPanel,
    commitConstraintFromPanel,
    cancelConstraintFromPanel,
    commitConstraintEdit,
    cancelConstraintEdit,
    commitConstraintEditFromPanel,
    cancelConstraintEditFromPanel,
    handleConstraintKeyDown,
  }
}
