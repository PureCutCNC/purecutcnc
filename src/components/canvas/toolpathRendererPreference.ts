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

import type { StorageCodec } from '../../hooks/useLocalStorageState'

export type ToolpathRendererChoice = 'canvas' | 'gpu'
export type ToolpathRendererStatus = 'canvas' | 'loading' | 'gpu' | 'fallback'

/**
 * The shipped default (issue #1087).
 *
 * GPU is the path a fresh profile takes: it was built and measured as the
 * faster one (#683). A stored `canvas` choice is kept as it was, and a runtime
 * without a hardware-accelerated WebGL2 falls back automatically — the
 * renderer's strict context request refuses a software rasteriser, and Canvas
 * draws the paths instead (see `toolpathWebglSupport.ts`).
 */
export const DEFAULT_TOOLPATH_RENDERER: ToolpathRendererChoice = 'gpu'
export interface ToolpathRendererControl {
  choice: ToolpathRendererChoice
  status: ToolpathRendererStatus
  onChange: (choice: ToolpathRendererChoice) => void
  onRetry: () => void
  suggestion?: { onEnable: () => void; onDismiss: () => void }
}

export const TOOLPATH_RENDERER_STORAGE_KEY = 'purecutcnc.toolpathRenderer'
export const TOOLPATH_RENDERER_CODEC: StorageCodec<ToolpathRendererChoice> = {
  serialize: value => value,
  deserialize: value => {
    if (value === 'canvas' || value === 'gpu') return value
    throw new Error('Unknown toolpath renderer')
  },
}

/** The reproducible comparison lane must not overwrite the user's preference. */
export function toolpathRendererOverride(search: string, development: boolean): ToolpathRendererChoice | null {
  if (!development) return null
  const value = new URLSearchParams(search).get('toolpathRenderer')
  return value === 'canvas' || value === 'gpu' ? value : null
}
