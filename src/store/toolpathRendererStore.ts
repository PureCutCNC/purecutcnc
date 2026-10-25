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
 * The sketch's toolpath renderer, published for the generation gear (issue
 * #1102 slice D1).
 *
 * The renderer state lives inside the sketch canvas, and the gear that now owns
 * the GPU/Canvas switch and the GPU-fallback notice sits in the CAM panel. This
 * store is the seam between those two trees, so neither has to know about the
 * other's mount point.
 *
 * It carries the callbacks beside the state rather than deriving them on read:
 * the sketch keeps them stable for its lifetime, so a consumer re-renders only
 * when the choice or the status actually changes.
 *
 * Nothing here is part of the project: the renderer choice is a machine-local
 * view preference and never dirties a file or enters undo history.
 */

import { create } from 'zustand'
import type {
  ToolpathRendererChoice,
  ToolpathRendererStatus,
} from '../components/canvas/toolpathRendererPreference'

export interface PublishedToolpathRenderer {
  /** The renderer the user chose. */
  choice: ToolpathRendererChoice
  /** What the sketch is actually drawing with right now. */
  status: ToolpathRendererStatus
  /** Stable for the life of the sketch: switches between GPU and Canvas. */
  setChoice: (choice: ToolpathRendererChoice) => void
  /** Stable for the life of the sketch: asks for GPU again after a fallback. */
  retry: () => void
}

interface ToolpathRendererStore {
  /**
   * Null until a sketch publishes one, and again when it unmounts. The gear
   * shows no Display section while there is nothing to display.
   */
  renderer: PublishedToolpathRenderer | null
  publish: (renderer: PublishedToolpathRenderer) => void
  clear: () => void
}

export const useToolpathRendererStore = create<ToolpathRendererStore>((set) => ({
  renderer: null,
  publish: (renderer) => set({ renderer }),
  clear: () => set({ renderer: null }),
}))
