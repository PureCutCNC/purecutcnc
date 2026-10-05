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
 * Workspace-local state for the face workflow (issue #945). None of it is
 * part of the project: showing or hiding the other side never dirties a file
 * and is not an undo step.
 */

import { create } from 'zustand'

interface FaceViewState {
  /** Whether the other face's features are drawn as a ghost overlay. */
  showOtherSide: boolean
  setShowOtherSide: (visible: boolean) => void
  /**
   * The features whose authoring face the user asked to change, waiting for
   * the confirmation dialog. Changing a face is never done without it.
   */
  faceChangeRequest: readonly string[] | null
  requestFaceChange: (featureIds: readonly string[]) => void
  clearFaceChangeRequest: () => void
}

export const useFaceViewStore = create<FaceViewState>((set) => ({
  showOtherSide: true,
  setShowOtherSide: (visible) => set({ showOtherSide: visible }),
  faceChangeRequest: null,
  requestFaceChange: (featureIds) => set({ faceChangeRequest: featureIds.length > 0 ? [...featureIds] : null }),
  clearFaceChangeRequest: () => set({ faceChangeRequest: null }),
}))
