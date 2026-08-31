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

import { useEffect, useRef, type RefObject } from 'react'
import type { GpuToolpathPoc } from './gpuToolpathPoc'

export interface GpuPocSurface {
  gpu: GpuToolpathPoc
  foreground: CanvasRenderingContext2D
  failed: boolean
}

/** DEV-only URL opt-in. Never persisted in projects or enabled in production. */
export function useGpuToolpathPoc(canvasRef: RefObject<HTMLCanvasElement | null>, invalidate: () => void) {
  const surface = useRef<GpuPocSurface | null>(null)
  useEffect(() => {
    if (!import.meta.env.DEV || new URLSearchParams(location.search).get('toolpathRenderer') !== 'gpu') return
    let cancelled = false
    let cleanup: (() => void) | undefined
    void import('./gpuToolpathPoc').then(({ GpuToolpathPoc }) => {
      const base = canvasRef.current
      if (cancelled || !base?.parentElement) return
      const gpuCanvas = document.createElement('canvas')
      const foregroundCanvas = document.createElement('canvas')
      gpuCanvas.className = 'sketch-toolpath-gpu-poc'
      foregroundCanvas.className = 'sketch-toolpath-foreground-poc'
      for (const canvas of [gpuCanvas, foregroundCanvas]) {
        canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
        canvas.setAttribute('aria-hidden', 'true')
      }
      const foreground = foregroundCanvas.getContext('2d')
      if (!foreground) return
      let gpu: GpuToolpathPoc
      try { gpu = new GpuToolpathPoc(gpuCanvas, invalidate) } catch (error) {
        base.dataset.toolpathRenderer = 'canvas-fallback'
        base.dataset.toolpathRendererError = String(error)
        return
      }
      base.after(gpuCanvas, foregroundCanvas)
      surface.current = { gpu, foreground, failed: false }
      cleanup = () => {
        surface.current = null
        gpu.dispose()
        gpuCanvas.remove()
        foregroundCanvas.remove()
        delete base.dataset.toolpathRenderer
      }
      invalidate()
    }).catch((error: unknown) => {
      const canvas = canvasRef.current
      if (!cancelled && canvas) {
        canvas.dataset.toolpathRenderer = 'canvas-fallback'
        canvas.dataset.toolpathRendererError = String(error)
      }
    })
    return () => { cancelled = true; cleanup?.() }
  }, [canvasRef, invalidate])
  return surface
}

