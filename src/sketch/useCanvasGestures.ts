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

import { useCallback, useEffect, useRef } from 'react'
import type { SketchViewState } from '../components/canvas/viewTransform'

interface GestureCallbacks {
  getCanvas: () => HTMLCanvasElement | null
  getViewState: () => SketchViewState
  setViewState: (updater: (prev: SketchViewState) => SketchViewState) => void
  getBaseTransform: () => { scale: number; offsetX: number; offsetY: number }
  canvasToWorld: (cx: number, cy: number) => { x: number; y: number }
  minZoom: number
}

interface Pointer {
  x: number
  y: number
}

export function useCanvasGestures(callbacks: GestureCallbacks) {
  const callbacksRef = useRef(callbacks)
  useEffect(() => { callbacksRef.current = callbacks })

  const pointersRef = useRef<Map<number, Pointer>>(new Map())
  const gestureActiveRef = useRef(false)
  const prevDistRef = useRef(0)
  const prevCenterRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })

  const handlePointerDown = useCallback((e: PointerEvent) => {
    if (e.pointerType !== 'touch') return

    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointersRef.current.size === 2) {
      gestureActiveRef.current = true
      const [a, b] = [...pointersRef.current.values()]
      prevDistRef.current = Math.hypot(b.x - a.x, b.y - a.y)
      prevCenterRef.current = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    }
  }, [])

  const handlePointerMove = useCallback((e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    if (!pointersRef.current.has(e.pointerId)) return

    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointersRef.current.size < 2 || !gestureActiveRef.current) return

    const [a, b] = [...pointersRef.current.values()]
    const dist = Math.hypot(b.x - a.x, b.y - a.y)
    const center = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }

    const { getCanvas, getViewState, setViewState, getBaseTransform, canvasToWorld, minZoom } = callbacksRef.current
    const canvas = getCanvas()
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const canvasCenter = { cx: center.x - rect.left, cy: center.y - rect.top }

    const panDx = center.x - prevCenterRef.current.x
    const panDy = center.y - prevCenterRef.current.y

    if (prevDistRef.current > 0 && dist > 0) {
      const zoomFactor = dist / prevDistRef.current
      const viewState = getViewState()
      const base = getBaseTransform()
      const worldBefore = canvasToWorld(canvasCenter.cx, canvasCenter.cy)
      const nextZoom = Math.max(minZoom, viewState.zoom * zoomFactor)
      const nextScale = base.scale * nextZoom

      setViewState(() => ({
        zoom: nextZoom,
        panX: canvasCenter.cx - base.offsetX - worldBefore.x * nextScale + panDx,
        panY: canvasCenter.cy - base.offsetY - worldBefore.y * nextScale + panDy,
      }))
    } else {
      setViewState((prev) => ({
        ...prev,
        panX: prev.panX + panDx,
        panY: prev.panY + panDy,
      }))
    }

    prevDistRef.current = dist
    prevCenterRef.current = center
  }, [])

  const handlePointerUp = useCallback((e: PointerEvent) => {
    if (e.pointerType !== 'touch') return
    pointersRef.current.delete(e.pointerId)
    if (pointersRef.current.size < 2) {
      gestureActiveRef.current = false
      prevDistRef.current = 0
    }
  }, [])

  useEffect(() => {
    const canvas = callbacksRef.current.getCanvas()
    if (!canvas) return

    canvas.addEventListener('pointerdown', handlePointerDown)
    canvas.addEventListener('pointermove', handlePointerMove)
    canvas.addEventListener('pointerup', handlePointerUp)
    canvas.addEventListener('pointercancel', handlePointerUp)

    return () => {
      canvas.removeEventListener('pointerdown', handlePointerDown)
      canvas.removeEventListener('pointermove', handlePointerMove)
      canvas.removeEventListener('pointerup', handlePointerUp)
      canvas.removeEventListener('pointercancel', handlePointerUp)
    }
  }, [handlePointerDown, handlePointerMove, handlePointerUp])

  return { isGestureActive: gestureActiveRef }
}
