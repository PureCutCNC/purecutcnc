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
import type { MouseEvent, PointerEvent as ReactPointerEvent } from 'react'
import type {
  PendingAddTool,
  PendingMoveTool,
  PendingOffsetTool,
  PendingTransformTool,
  SelectionState,
} from '../../store/types'
import type { Project } from '../../types/project'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import {
  findHitClampId,
  findHitFeatureId,
  findHitTabId,
} from './hitTest'
import {
  canvasToWorld,
  computeViewTransform,
} from './viewTransform'
import type { CanvasPoint, SketchViewState } from './viewTransform'

export interface CanvasContextMenuCtx {
  canvasRef: MutableRefObject<HTMLCanvasElement | null>
  projectRef: MutableRefObject<Project>
  selectionRef: MutableRefObject<SelectionState>
  viewStateRef: MutableRefObject<SketchViewState>
  pendingAddRef: MutableRefObject<PendingAddTool | null>
  pendingMoveRef: MutableRefObject<PendingMoveTool | null>
  pendingTransformRef: MutableRefObject<PendingTransformTool | null>
  pendingOffsetRef: MutableRefObject<PendingOffsetTool | null>
  didPanRef: MutableRefObject<boolean>
  suppressClickRef: MutableRefObject<boolean>
  zoomWindowActive: boolean
  stopPan: () => void
  selectClamp: (id: string) => void
  selectTab: (id: string) => void
  selectFeature: (id: string) => void
  onFeatureContextMenu?: (featureId: string, clientX: number, clientY: number) => void
  onTabContextMenu?: (tabId: string, clientX: number, clientY: number) => void
  onClampContextMenu?: (clampId: string, clientX: number, clientY: number) => void
}

export interface UseCanvasContextMenuReturn {
  startLongPress: (event: ReactPointerEvent<HTMLCanvasElement>) => void
  cancelLongPress: () => void
  handleLongPressMove: (event: PointerEvent) => void
  handleContextMenu: (event: MouseEvent<HTMLCanvasElement>) => void
  triggerContextMenuAt: (clientX: number, clientY: number) => void
}

export function useCanvasContextMenu(ctx: CanvasContextMenuCtx): UseCanvasContextMenuReturn {
  const {
    canvasRef,
    projectRef,
    selectionRef,
    viewStateRef,
    pendingAddRef,
    pendingMoveRef,
    pendingTransformRef,
    pendingOffsetRef,
    didPanRef,
    suppressClickRef,
    zoomWindowActive,
    stopPan,
    selectClamp,
    selectTab,
    selectFeature,
    onFeatureContextMenu,
    onTabContextMenu,
    onClampContextMenu,
  } = ctx

  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressStartRef = useRef<{ cx: number; cy: number; clientX: number; clientY: number } | null>(null)

  function triggerContextMenuAt(clientX: number, clientY: number) {
    if (zoomWindowActive) return
    if (pendingAddRef.current || pendingMoveRef.current || pendingTransformRef.current || pendingOffsetRef.current) return

    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const point: CanvasPoint = { cx: clientX - rect.left, cy: clientY - rect.top }
    const project = projectRef.current
    const selection = selectionRef.current
    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewStateRef.current)
    const world = canvasToWorld(point.cx, point.cy, vt)
    const hitClampId = findHitClampId(world, project.clamps)
    if (hitClampId) {
      selectClamp(hitClampId)
      onClampContextMenu?.(hitClampId, clientX, clientY)
      return
    }

    const hitTabId = findHitTabId(world, project.tabs)
    if (hitTabId) {
      selectTab(hitTabId)
      onTabContextMenu?.(hitTabId, clientX, clientY)
      return
    }

    const hitId = findHitFeatureId(world, resolvedProjectFeatures(project), vt)
    if (!hitId) return

    if (!selection.selectedFeatureIds.includes(hitId)) {
      selectFeature(hitId)
    }
    onFeatureContextMenu?.(hitId, clientX, clientY)
  }

  function handleContextMenu(event: MouseEvent<HTMLCanvasElement>) {
    event.preventDefault()

    if (didPanRef.current) {
      didPanRef.current = false
      return
    }

    triggerContextMenuAt(event.clientX, event.clientY)
  }

  function startLongPress(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }

    if (event.pointerType === 'touch' && event.button === 0) {
      const startCx = event.clientX
      const startCy = event.clientY
      const rect = canvasRef.current?.getBoundingClientRect()
      longPressStartRef.current = {
        cx: rect ? startCx - rect.left : startCx,
        cy: rect ? startCy - rect.top : startCy,
        clientX: startCx,
        clientY: startCy,
      }
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null
        if (longPressStartRef.current) {
          triggerContextMenuAt(longPressStartRef.current.clientX, longPressStartRef.current.clientY)
          suppressClickRef.current = true
          stopPan()
          longPressStartRef.current = null
        }
      }, 500)
    }
  }

  function cancelLongPress() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressStartRef.current = null
  }

  function handleLongPressMove(event: PointerEvent) {
    if (longPressTimerRef.current && longPressStartRef.current) {
      const dx = event.clientX - longPressStartRef.current.clientX
      const dy = event.clientY - longPressStartRef.current.clientY
      if (dx * dx + dy * dy > 100) {
        clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
        longPressStartRef.current = null
      }
    }
  }

  return {
    startLongPress,
    cancelLongPress,
    handleLongPressMove,
    handleContextMenu,
    triggerContextMenuAt,
  }
}
