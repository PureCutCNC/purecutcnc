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

import { useEffect, useState } from 'react'
import type { RefObject } from 'react'
import type { FeatureKind } from '../../types/project'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

export interface OverlapFeatureCandidate {
  id: string
  name: string
  kind: FeatureKind
}

interface PendingOverlapFeatureSelection {
  candidates: readonly OverlapFeatureCandidate[]
  additive: boolean
}

interface UseOverlapFeaturePickerOptions {
  containerRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  clearTransientCanvasState: () => void
  selectFeature: (id: string | null, additive?: boolean) => void
}

export interface OverlapFeaturePickerController {
  isOpen: boolean
  candidates: readonly OverlapFeatureCandidate[]
  workflowPanel: ReturnType<typeof useCanvasWorkflowPanel>
  open: (candidates: readonly OverlapFeatureCandidate[], additive: boolean) => void
  dismiss: () => void
  cancel: () => void
  selectCandidate: (id: string) => void
}

/**
 * Keeps the temporary UI state for choosing one feature among overlapping
 * canvas hits. It does not own project selection; that stays in the store.
 */
export function useOverlapFeaturePicker({
  containerRef,
  canvasRef,
  clearTransientCanvasState,
  selectFeature,
}: UseOverlapFeaturePickerOptions): OverlapFeaturePickerController {
  const [pendingSelection, setPendingSelection] = useState<PendingOverlapFeatureSelection | null>(null)
  const workflowPanel = useCanvasWorkflowPanel({
    open: pendingSelection !== null,
    phaseKey: pendingSelection?.candidates.map((candidate) => candidate.id).join(',') ?? null,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })

  useEffect(() => {
    if (!pendingSelection) return undefined

    function dismissForOutsideAction(event: PointerEvent) {
      const target = event.target
      if (target instanceof Node && !workflowPanel.panelRef.current?.contains(target)) {
        setPendingSelection(null)
      }
    }

    document.addEventListener('pointerdown', dismissForOutsideAction, true)
    return () => document.removeEventListener('pointerdown', dismissForOutsideAction, true)
    // useCanvasWorkflowPanel keeps its panel ref stable, while its return object
    // is intentionally recreated each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingSelection])

  function open(candidates: readonly OverlapFeatureCandidate[], additive: boolean) {
    if (candidates.length < 2) return
    setPendingSelection({ candidates, additive })
  }

  function dismiss() {
    setPendingSelection(null)
  }

  function selectCandidate(id: string) {
    if (!pendingSelection?.candidates.some((candidate) => candidate.id === id)) return
    selectFeature(id, pendingSelection.additive)
    dismiss()
  }

  return {
    isOpen: pendingSelection !== null,
    candidates: pendingSelection?.candidates ?? [],
    workflowPanel,
    open,
    dismiss,
    cancel: dismiss,
    selectCandidate,
  }
}
