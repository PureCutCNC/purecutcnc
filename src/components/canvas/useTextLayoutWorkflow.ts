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

import type { RefObject } from 'react'
import type { PendingTextLayout, TextLayoutPickTarget } from '../../store/types'
import type { TextLayout } from '../../types/project'
import { createDefaultTextLayout, type TextLayoutKind } from '../../sketch/textPlacement'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

type LayoutMode = 'horizontal' | TextLayoutKind

interface TextLayoutWorkflowCtx {
  pending: PendingTextLayout | null
  runWidth: number
  updateTextLayout: (layout: TextLayout | null) => void
  setTextLayoutPickTarget: (target: TextLayoutPickTarget) => void
  completeTextLayout: () => string[]
  cancelTextLayout: () => void
  containerRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  clearTransientCanvasState: () => void
}

export interface TextLayoutWorkflow {
  textLayoutWorkflowPanel: ReturnType<typeof useCanvasWorkflowPanel>
  changeTextLayoutMode: (mode: LayoutMode) => void
  updateTextLayoutFromPanel: (layout: TextLayout) => void
  pickTextGuideFromPanel: () => void
  pickTextCenterFromPanel: () => void
  cancelTextPickFromPanel: () => void
  completeTextLayoutFromPanel: () => void
  cancelTextLayoutFromPanel: () => void
}

export function useTextLayoutWorkflow({
  pending,
  runWidth,
  updateTextLayout,
  setTextLayoutPickTarget,
  completeTextLayout,
  cancelTextLayout,
  containerRef,
  canvasRef,
  clearTransientCanvasState,
}: TextLayoutWorkflowCtx): TextLayoutWorkflow {
  const textLayoutWorkflowPanel = useCanvasWorkflowPanel({
    open: pending !== null,
    phaseKey: pending
      ? `${pending.layout?.kind ?? 'horizontal'}:${pending.pickTarget ?? (pending.center ? 'radius' : 'place')}`
      : null,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
    pageLevel: true,
  })

  function changeTextLayoutMode(mode: LayoutMode) {
    if (!pending) return
    // A fresh layout is sized from the run's own width, so switching to `arc`
    // shows a text-sized arc rather than a hairline or a full ring.
    updateTextLayout(
      mode === 'horizontal'
        ? null
        : createDefaultTextLayout(mode, runWidth),
    )
    textLayoutWorkflowPanel.focusCanvasAfterAction()
  }

  function updateTextLayoutFromPanel(layout: TextLayout) {
    updateTextLayout(layout)
  }

  function pickTextGuideFromPanel() {
    setTextLayoutPickTarget('guide')
    textLayoutWorkflowPanel.focusCanvasAfterAction()
  }

  function pickTextCenterFromPanel() {
    setTextLayoutPickTarget('center')
    textLayoutWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelTextPickFromPanel() {
    setTextLayoutPickTarget(null)
    textLayoutWorkflowPanel.focusCanvasAfterAction()
  }

  function completeTextLayoutFromPanel() {
    completeTextLayout()
    textLayoutWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelTextLayoutFromPanel() {
    cancelTextLayout()
    textLayoutWorkflowPanel.focusCanvasAfterAction()
  }

  return {
    textLayoutWorkflowPanel,
    changeTextLayoutMode,
    updateTextLayoutFromPanel,
    pickTextGuideFromPanel,
    pickTextCenterFromPanel,
    cancelTextPickFromPanel,
    completeTextLayoutFromPanel,
    cancelTextLayoutFromPanel,
  }
}
