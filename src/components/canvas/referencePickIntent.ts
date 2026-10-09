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

import type { ProjectStore } from '../../store/types'
import { useProjectStore } from '../../store/projectStore'
import { useFaceViewStore } from '../../store/faceViewStore'

export type ReferencePickIntent = 'point' | 'distribution-guide' | 'text-guide' | 'segment' | null
type ReferencePickState = Pick<ProjectStore,
  | 'selection' | 'pendingAdd' | 'pendingMove' | 'pendingTransform' | 'pendingOffset'
  | 'pendingConstraint' | 'pendingShapeAction' | 'pendingSketchEdit'
  | 'pendingFeatureDistribution' | 'pendingTextLayout' | 'pendingDimension' | 'tapeMeasure'
>

/** The existing workflow decides whether the next pick reads or edits geometry. */
export function referencePickIntent(state: ReferencePickState, clipboardPlacementPending = false): ReferencePickIntent {
  if (state.pendingConstraint || state.pendingShapeAction) return null
  if (state.pendingSketchEdit) return state.pendingSketchEdit.phase === 'pick-reference' ? 'segment' : null
  if (state.pendingFeatureDistribution?.pickTarget === 'guide') return 'distribution-guide'
  if (state.pendingTextLayout?.pickTarget === 'guide') return 'text-guide'
  if (clipboardPlacementPending || state.pendingAdd || state.pendingMove || state.pendingTransform || state.pendingOffset
    || state.pendingDimension || state.tapeMeasure
    || state.pendingFeatureDistribution?.pickTarget === 'radial-center'
    || state.pendingTextLayout?.pickTarget === 'center'
    || state.selection.mode === 'sketch_edit') return 'point'
  return null
}

/** Live reads keep preview, pointer-down and click on the same pending phase. */
export function createReferencePickContext(isClipboardPlacementPending: () => boolean = () => false) {
  return {
    getReferencePickIntent: () => referencePickIntent(useProjectStore.getState(), isClipboardPlacementPending()),
    showOtherSide: () => useFaceViewStore.getState().showOtherSide,
  }
}

export const referencePickContext = createReferencePickContext()
