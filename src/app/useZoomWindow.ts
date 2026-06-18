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

import { useCallback, useEffect, useState } from 'react'

export function useZoomWindow(): {
  zoomWindowActive: boolean
  onZoomWindow: () => void
  onZoomWindowComplete: () => void
} {
  const [zoomWindowActive, setZoomWindowActive] = useState(false)

  useEffect(() => {
    if (!zoomWindowActive) {
      return
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setZoomWindowActive(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [zoomWindowActive])

  const handleZoomWindow = useCallback(() => {
    setZoomWindowActive((previous) => !previous)
  }, [])

  const handleZoomWindowComplete = useCallback(() => {
    setZoomWindowActive(false)
  }, [])

  return {
    zoomWindowActive,
    onZoomWindow: handleZoomWindow,
    onZoomWindowComplete: handleZoomWindowComplete,
  }
}
