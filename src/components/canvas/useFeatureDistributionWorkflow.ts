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
import type { FeatureDistributionPickTarget, PendingFeatureDistribution } from '../../store/types'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

interface FeatureDistributionWorkflowCtx {
  pendingFeatureDistribution: PendingFeatureDistribution | null
  setFeatureDistributionPickTarget: (target: FeatureDistributionPickTarget) => void
  cancelFeatureDistribution: () => void
  completeFeatureDistribution: () => string[]
  containerRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  clearTransientCanvasState: () => void
}

export interface FeatureDistributionWorkflow {
  featureDistributionWorkflowPanel: ReturnType<typeof useCanvasWorkflowPanel>
  pickGuideFromPanel: () => void
  pickRadialCenterFromPanel: () => void
  cancelFeatureDistributionPickFromPanel: () => void
  cancelFeatureDistributionFromPanel: () => void
  completeFeatureDistributionFromPanel: () => void
}

export function useFeatureDistributionWorkflow({
  pendingFeatureDistribution,
  setFeatureDistributionPickTarget,
  cancelFeatureDistribution,
  completeFeatureDistribution,
  containerRef,
  canvasRef,
  clearTransientCanvasState,
}: FeatureDistributionWorkflowCtx): FeatureDistributionWorkflow {
  const featureDistributionWorkflowPanel = useCanvasWorkflowPanel({
    open: pendingFeatureDistribution !== null,
    phaseKey: pendingFeatureDistribution
      ? `${pendingFeatureDistribution.spec.mode}:${pendingFeatureDistribution.pickTarget ?? 'configure'}`
      : null,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })

  function pickGuideFromPanel() {
    setFeatureDistributionPickTarget('guide')
    featureDistributionWorkflowPanel.moveAsideForSketchPick()
    featureDistributionWorkflowPanel.focusCanvasAfterAction()
  }

  function pickRadialCenterFromPanel() {
    setFeatureDistributionPickTarget('radial-center')
    featureDistributionWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelFeatureDistributionPickFromPanel() {
    setFeatureDistributionPickTarget(null)
    featureDistributionWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelFeatureDistributionFromPanel() {
    cancelFeatureDistribution()
    featureDistributionWorkflowPanel.focusCanvasAfterAction()
  }

  function completeFeatureDistributionFromPanel() {
    completeFeatureDistribution()
    featureDistributionWorkflowPanel.focusCanvasAfterAction()
  }

  return {
    featureDistributionWorkflowPanel,
    pickGuideFromPanel,
    pickRadialCenterFromPanel,
    cancelFeatureDistributionPickFromPanel,
    cancelFeatureDistributionFromPanel,
    completeFeatureDistributionFromPanel,
  }
}
