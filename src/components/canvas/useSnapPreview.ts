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

import { useRef, type MutableRefObject } from 'react'
import type { SnapMode, SnapSettings } from '../../sketch/snapping'
import type {
  PendingAddTool,
  PendingConstraint,
  PendingMoveTool,
  PendingTransformTool,
  SelectionState,
} from '../../store/types'
import type { Point, Project } from '../../types/project'
import { useStableEvent } from '../../hooks/useStableEvent'
import { resolveSketchSnap } from './snappingHelpers'
import type { ResolvedSnap } from './snappingHelpers'
import { pointsEqual } from './hitTest'
import type { ViewTransform } from './viewTransform'

export interface SnapPreviewCtx {
  snapSettingsRef: MutableRefObject<SnapSettings>
  projectRef: MutableRefObject<Project>
  selectionRef: MutableRefObject<SelectionState>
  pendingMoveRef: MutableRefObject<PendingMoveTool | null>
  pendingTransformRef: MutableRefObject<PendingTransformTool | null>
  pendingAddRef: MutableRefObject<PendingAddTool | null>
  pendingConstraintRef: MutableRefObject<PendingConstraint | null>
  scheduleDraw: () => void
  onActiveSnapModeChange: (mode: SnapMode | null) => void
}

export interface UseSnapPreviewReturn {
  activeSnapRef: MutableRefObject<ResolvedSnap | null>
  updateActiveSnap: (nextSnap: ResolvedSnap | null) => void
  resolveCurrentSketchSnap: (
    rawPoint: Point,
    vt: ViewTransform,
    options?: {
      excludeActiveEditGeometry?: boolean
    },
  ) => ResolvedSnap
  isActiveSnapPoint: (point: Point | null | undefined) => boolean
  requiresResolvedSnapForPointPick: () => boolean
}

export function useSnapPreview(ctx: SnapPreviewCtx): UseSnapPreviewReturn {
  const {
    snapSettingsRef,
    projectRef,
    selectionRef,
    pendingMoveRef,
    pendingTransformRef,
    pendingAddRef,
    pendingConstraintRef,
    scheduleDraw,
    onActiveSnapModeChange,
  } = ctx

  const activeSnapRef = useRef<ResolvedSnap | null>(null)

  const updateActiveSnap = useStableEvent((nextSnap: ResolvedSnap | null) => {
    activeSnapRef.current = nextSnap?.mode ? nextSnap : null
    onActiveSnapModeChange(nextSnap?.mode ?? null)
    scheduleDraw()
  })

  function currentSnapReferencePoint(): Point | null {
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingAdd = pendingAddRef.current
    const pendingConstraintLive = pendingConstraintRef.current

    if (pendingConstraintLive?.anchor && !pendingConstraintLive.reference) {
      return pendingConstraintLive.anchor.point
    }

    if (pendingMove?.fromPoint) {
      return pendingMove.fromPoint
    }

    if (pendingTransform?.mode === 'rotate' || pendingTransform?.mode === 'mirror') {
      return pendingTransform.referenceStart
    }

    if ((pendingAdd?.shape === 'rect' || pendingAdd?.shape === 'circle' || pendingAdd?.shape === 'ellipse' || pendingAdd?.shape === 'tab' || pendingAdd?.shape === 'clamp') && pendingAdd.anchor) {
      return pendingAdd.anchor
    }

    if ((pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline') && pendingAdd.points.length > 0) {
      return pendingAdd.points[pendingAdd.points.length - 1]
    }

    if (pendingAdd?.shape === 'composite') {
      return pendingAdd.pendingArcEnd ?? pendingAdd.lastPoint ?? pendingAdd.start ?? null
    }

    return null
  }

  function requiresResolvedSnapForPointPick(): boolean {
    const snapSettings = snapSettingsRef.current
    return snapSettings.enabled && snapSettings.modes.length > 0
  }

  function resolveCurrentSketchSnap(
    rawPoint: Point,
    vt: ViewTransform,
    options?: {
      excludeActiveEditGeometry?: boolean
    },
  ): ResolvedSnap {
    const selection = selectionRef.current
    const excludeFeatureId =
      options?.excludeActiveEditGeometry && selection.selectedNode?.type === 'feature'
        ? selection.selectedNode.featureId
        : null
    const excludeTabId =
      options?.excludeActiveEditGeometry && selection.selectedNode?.type === 'tab'
        ? selection.selectedNode.tabId
        : null
    const excludeClampId =
      options?.excludeActiveEditGeometry && selection.selectedNode?.type === 'clamp'
        ? selection.selectedNode.clampId
        : null

    return resolveSketchSnap({
      rawPoint,
      vt,
      snapSettings: snapSettingsRef.current,
      project: projectRef.current,
      referencePoint: currentSnapReferencePoint(),
      excludeFeatureId,
      excludeTabId,
      excludeClampId,
    })
  }

  function isActiveSnapPoint(point: Point | null | undefined): boolean {
    return !!point && !!activeSnapRef.current?.mode && pointsEqual(point, activeSnapRef.current.point, 1e-6)
  }

  return {
    activeSnapRef,
    updateActiveSnap,
    resolveCurrentSketchSnap,
    isActiveSnapPoint,
    requiresResolvedSnapForPointPick,
  }
}
