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
import type { SketchCanvasHandle } from '../components/canvas/SketchCanvas'
import type { PendingAddTool } from '../store/types'

type CenterTab = 'sketch' | 'preview3d' | 'simulation'

interface UseEmptyStateEngagementArgs {
  projectKey: number
  featureCount: number
  pendingAdd: PendingAddTool | null
  setCenterTab: (tab: CenterTab) => void
  setShowImportDialog: (show: boolean) => void
  startAddRectPlacement: () => void
  sketchCanvasRef: RefObject<SketchCanvasHandle | null>
  hasAutoFramed3DRef: RefObject<boolean>
}

export function useEmptyStateEngagement({
  projectKey,
  featureCount,
  pendingAdd,
  setCenterTab,
  setShowImportDialog,
  startAddRectPlacement,
  sketchCanvasRef,
  hasAutoFramed3DRef,
}: UseEmptyStateEngagementArgs): {
  emptyStateEngaged: boolean
  onDraw: () => void
  onImport: () => void
  frameOpenedProject: () => void
} {
  // The empty-state overlay is a one-time nudge per project. Once the user has
  // engaged (started any draw, opened import, or the project has features), it
  // stays dismissed — so cancelling a draw or deleting the last feature keeps
  // them on the sketch view instead of popping the overlay back up.
  const [emptyStateEngaged, setEmptyStateEngaged] = useState(false)

  function handleEmptyStateDraw() {
    setCenterTab('sketch')
    setEmptyStateEngaged(true)
    startAddRectPlacement()
  }

  function handleEmptyStateImport() {
    setEmptyStateEngaged(true)
    setShowImportDialog(true)
  }

  function frameOpenedProject() {
    hasAutoFramed3DRef.current = false
    setCenterTab('sketch')
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        sketchCanvasRef.current?.zoomToModel()
      })
    })
  }

  // Reset the one-time empty-state nudge for each new/opened project.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEmptyStateEngaged(false)
  }, [projectKey])

  // Latch engagement once the project has any feature or a draw is in progress
  // (covers toolbar draws too), so the overlay doesn't reappear after a cancel
  // or after deleting the last feature.
  useEffect(() => {
    if (featureCount > 0 || pendingAdd) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEmptyStateEngaged(true)
    }
  }, [featureCount, pendingAdd])

  return {
    emptyStateEngaged,
    onDraw: handleEmptyStateDraw,
    onImport: handleEmptyStateImport,
    frameOpenedProject,
  }
}
