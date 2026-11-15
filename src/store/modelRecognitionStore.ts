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
 * Workspace-local state for Find pockets and holes (issue #1206): which model
 * the dialog is open for. Not part of the project and not an undo step.
 */

import { create } from 'zustand'

interface ModelRecognitionState {
  /** The model feature the dialog is open for, or null when it is closed. */
  requestedModelId: string | null
  requestModelRecognition: (featureId: string) => void
  clearModelRecognitionRequest: () => void
}

export const useModelRecognitionStore = create<ModelRecognitionState>((set) => ({
  requestedModelId: null,
  requestModelRecognition: (featureId) => set({ requestedModelId: featureId }),
  clearModelRecognitionRequest: () => set({ requestedModelId: null }),
}))
