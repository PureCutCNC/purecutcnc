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

import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { createSlowCanvasDetector, GPU_SUGGESTION_CODEC, GPU_SUGGESTION_STORAGE_KEY,
  type CanvasDrawSample } from './toolpathGpuSuggestion'

/** Observes only the active Canvas choice; all state is browser-local. */
export function useToolpathGpuSuggestion(enabled: boolean, toolpaths: readonly ToolpathResult[]) {
  const [handled, setHandled] = useLocalStorageState(GPU_SUGGESTION_STORAGE_KEY, false, { codec: GPU_SUGGESTION_CODEC })
  // A new result set owns fresh evidence without retaining the previous moves.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const detector = useMemo(() => createSlowCanvasDetector(), [toolpaths])
  const [suggestedFor, setSuggestedFor] = useState<ReturnType<typeof createSlowCanvasDetector> | null>(null)
  const eligible = enabled && !handled

  useEffect(() => {
    detector.reset()
  }, [detector, eligible])

  const observe = useCallback((sample: CanvasDrawSample) => {
    if (document.hidden) { detector.reset(); return }
    if (detector.observe(sample)) setSuggestedFor(detector)
  }, [detector])
  const dismiss = useCallback(() => { setHandled(true); setSuggestedFor(null) }, [setHandled])

  return {
    visible: eligible && suggestedFor === detector,
    observe: eligible && suggestedFor !== detector ? observe : undefined,
    dismiss,
  }
}
