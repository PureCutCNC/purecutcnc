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

import { useEffect, useRef, useState, useLayoutEffect } from 'react'
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react'

const DEFAULT_WORKFLOW_PANEL_MARGIN = 12

export interface CanvasWorkflowPanelPosition {
  x: number
  y: number
}

interface UseCanvasWorkflowPanelOptions {
  open: boolean
  phaseKey: string | null
  containerRef: RefObject<HTMLElement | null>
  canvasRef: RefObject<HTMLElement | null>
  clearTransientCanvasState: () => void
  focusCanvasOnOpen?: boolean
  margin?: number
  /**
   * Position the panel against the whole page (viewport coordinates, clamped
   * to the window) instead of the canvas container. The panel component must
   * be rendered with the matching `pageLevel` prop so it portals to
   * document.body with `position: fixed` — keep the two in sync.
   */
  pageLevel?: boolean
}

interface PanelDragState {
  pointerId: number
  startClientX: number
  startClientY: number
  startX: number
  startY: number
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

export function useCanvasWorkflowPanel({
  open,
  phaseKey,
  containerRef,
  canvasRef,
  clearTransientCanvasState,
  focusCanvasOnOpen = true,
  margin = DEFAULT_WORKFLOW_PANEL_MARGIN,
  pageLevel = false,
}: UseCanvasWorkflowPanelOptions) {
  const [position, setPosition] = useState<CanvasWorkflowPanelPosition>({ x: margin, y: margin })
  const panelRef = useRef<HTMLDivElement>(null)
  const dragRef = useRef<PanelDragState | null>(null)
  const callbacksRef = useRef({ clearTransientCanvasState, canvasRef })
  const wasOpenRef = useRef(false)
  const pagePositionInitializedRef = useRef(false)

  useEffect(() => {
    callbacksRef.current = { clearTransientCanvasState, canvasRef }
  }, [clearTransientCanvasState, canvasRef])

  // Page-level panels start at the canvas container's top-left corner, in
  // viewport coordinates, so they appear where the container-bound panel did.
  // The position persists across phases and sessions afterwards. Shaped like
  // usePortalPosition: the measured anchor is set from a local handler, the
  // legitimate "external system" effect pattern for a one-time DOM measurement.
  useLayoutEffect(() => {
    if (!pageLevel || !open || pagePositionInitializedRef.current) {
      return
    }
    function anchorToContainer() {
      const rect = containerRef.current?.getBoundingClientRect()
      if (!rect) {
        return
      }
      pagePositionInitializedRef.current = true
      setPosition({ x: rect.left + margin, y: rect.top + margin })
    }
    anchorToContainer()
  }, [pageLevel, open, containerRef, margin])

  function focusCanvasAfterAction() {
    callbacksRef.current.clearTransientCanvasState()
    callbacksRef.current.canvasRef.current?.focus({ preventScroll: true })
    window.requestAnimationFrame(() => {
      callbacksRef.current.clearTransientCanvasState()
      callbacksRef.current.canvasRef.current?.focus({ preventScroll: true })
    })
  }

  useEffect(() => {
    const wasOpen = wasOpenRef.current
    if ((open && focusCanvasOnOpen) || (!open && wasOpen)) {
      focusCanvasAfterAction()
    }
    wasOpenRef.current = open
  }, [open, phaseKey, focusCanvasOnOpen])

  function startDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startClientX: event.clientX,
      startClientY: event.clientY,
      startX: position.x,
      startY: position.y,
    }
  }

  function drag(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    const panelRect = panelRef.current?.getBoundingClientRect()

    if (pageLevel) {
      // Fixed, viewport-coordinate panels clamp to the window instead of the
      // canvas container, so they can be parked anywhere on the page.
      const maxX = Math.max(margin, window.innerWidth - (panelRect?.width ?? 0) - margin)
      const maxY = Math.max(margin, window.innerHeight - (panelRect?.height ?? 0) - margin)
      setPosition({
        x: clampNumber(dragState.startX + event.clientX - dragState.startClientX, margin, maxX),
        y: clampNumber(dragState.startY + event.clientY - dragState.startClientY, margin, maxY),
      })
      return
    }

    const containerRect = containerRef.current?.getBoundingClientRect()
    const maxX = Math.max(margin, (containerRect?.width ?? 0) - (panelRect?.width ?? 0) - margin)
    const maxY = Math.max(margin, (containerRect?.height ?? 0) - (panelRect?.height ?? 0) - margin)

    setPosition({
      x: clampNumber(dragState.startX + event.clientX - dragState.startClientX, margin, maxX),
      y: clampNumber(dragState.startY + event.clientY - dragState.startClientY, margin, maxY),
    })
  }

  function endDrag(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragRef.current
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return
    }

    event.preventDefault()
    event.stopPropagation()
    dragRef.current = null
    try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* already released */ }
  }

  function stopActionPointerPropagation(event: ReactPointerEvent<HTMLDivElement>) {
    event.stopPropagation()
  }

  return {
    position,
    panelRef,
    focusCanvasAfterAction,
    handleProps: {
      onPointerDown: startDrag,
      onPointerMove: drag,
      onPointerUp: endDrag,
      onPointerCancel: endDrag,
    },
    actionRowProps: {
      onPointerDown: stopActionPointerPropagation,
    },
  }
}
