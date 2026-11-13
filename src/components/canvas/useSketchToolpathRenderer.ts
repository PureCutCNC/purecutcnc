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

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { useLocalStorageState } from '../../hooks/useLocalStorageState'
import { useToolpathGpuSuggestion } from './useToolpathGpuSuggestion'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { GpuToolpathRenderer } from './gpuToolpathRenderer'
import { useToolpathRendererStore } from '../../store/toolpathRendererStore'
import { DEFAULT_TOOLPATH_RENDERER, TOOLPATH_RENDERER_CODEC, TOOLPATH_RENDERER_STORAGE_KEY,
  toolpathRendererOverride, type ToolpathRendererChoice, type ToolpathRendererStatus } from './toolpathRendererPreference'

export interface SketchToolpathSurface {
  gpu: GpuToolpathRenderer
  foreground: CanvasRenderingContext2D
  failed: boolean
  report: (active: boolean, error?: unknown) => void
}

/** Application-local renderer choice and one cancellable GPU resource owner. */
export function useSketchToolpathRenderer(canvasRef: RefObject<HTMLCanvasElement | null>,
  invalidate: () => void, toolpaths: readonly ToolpathResult[]) {
  const override = toolpathRendererOverride(typeof location === 'undefined' ? '' : location.search, import.meta.env.DEV)
  const [choice, setChoice] = useLocalStorageState<ToolpathRendererChoice>(
    TOOLPATH_RENDERER_STORAGE_KEY, override ?? DEFAULT_TOOLPATH_RENDERER,
    { codec: TOOLPATH_RENDERER_CODEC, enabled: override === null },
  )
  const [attempt, setAttempt] = useState(0)
  const [reported, setReported] = useState<{ attempt: number; status: ToolpathRendererStatus } | null>(null)
  const surface = useRef<SketchToolpathSurface | null>(null)
  const status = choice === 'canvas' ? 'canvas'
    : reported?.attempt === attempt ? reported.status : 'loading'
  const suggestion = useToolpathGpuSuggestion(choice === 'canvas' && override === null, toolpaths)
  const changeRenderer = (next: ToolpathRendererChoice) => {
    suggestion.dismiss()
    setChoice(next)
    setAttempt(value => value + 1)
  }
  const retry = useCallback(() => setAttempt(value => value + 1), [])

  // The gear in the CAM panel owns the GPU/Canvas switch now (issue #1102 slice
  // D1), so the sketch publishes its state instead of drawing the control. The
  // callbacks go through a ref and are exported as stable functions: a fresh
  // function identity in the published object would republish it on every
  // render, and the gear would re-render for no change at all.
  const publish = useToolpathRendererStore(state => state.publish)
  const clear = useToolpathRendererStore(state => state.clear)
  const changeRendererRef = useRef(changeRenderer)
  changeRendererRef.current = changeRenderer
  const publishSetChoice = useCallback(
    (next: ToolpathRendererChoice) => changeRendererRef.current(next),
    [],
  )

  useEffect(() => {
    publish({ choice, status, setChoice: publishSetChoice, retry })
  }, [choice, status, publishSetChoice, retry, publish])

  // Nothing left to display: the gear falls back to the status and actions.
  useEffect(() => clear, [clear])

  useEffect(() => {
    const base = canvasRef.current
    if (!base) return
    let cancelled = false
    let cleanup: (() => void) | undefined
    const report = (status: ToolpathRendererStatus, error?: unknown) => {
      if (cancelled) return
      base.dataset.toolpathRenderer = status === 'fallback' ? 'canvas-fallback' : status
      if (error !== undefined) base.dataset.toolpathRendererError = String(error)
      else delete base.dataset.toolpathRendererError
      setReported(previous => previous?.attempt === attempt && previous.status === status ? previous : { attempt, status })
    }
    base.dataset.toolpathRenderer = choice === 'gpu' ? 'loading' : 'canvas'
    delete base.dataset.toolpathRendererError
    invalidate()
    if (choice === 'gpu') {
      void import('./gpuToolpathRenderer').then(({ GpuToolpathRenderer }) => {
        if (cancelled || !base.parentElement) return
        const gpuCanvas = document.createElement('canvas')
        const foregroundCanvas = document.createElement('canvas')
        gpuCanvas.className = 'sketch-toolpath-gpu'
        foregroundCanvas.className = 'sketch-toolpath-foreground'
        for (const canvas of [gpuCanvas, foregroundCanvas]) {
          canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none'
          canvas.setAttribute('aria-hidden', 'true')
        }
        const foreground = foregroundCanvas.getContext('2d')
        if (!foreground) throw new Error('Toolpath foreground canvas is unavailable')
        const gpu = new GpuToolpathRenderer(gpuCanvas, () => {
          if (cancelled) return
          if (surface.current) surface.current.failed = false
          report(gpu.available ? 'loading' : 'fallback')
          invalidate()
        })
        base.after(gpuCanvas, foregroundCanvas)
        surface.current = {
          gpu, foreground, failed: false,
          report: (active, error) => report(active ? 'gpu' : 'fallback', error),
        }
        cleanup = () => {
          surface.current = null
          gpu.dispose()
          gpuCanvas.remove()
          foregroundCanvas.remove()
        }
        invalidate()
      }).catch((error: unknown) => { report('fallback', error); if (!cancelled) invalidate() })
    }
    return () => {
      cancelled = true
      cleanup?.()
      delete base.dataset.toolpathRendererError
    }
  }, [attempt, canvasRef, choice, invalidate])

  useEffect(() => { surface.current?.gpu.retain(toolpaths) }, [toolpaths])

  // Workspace panes stay mounted and keep their dimensions when hidden.
  // Resume through the existing frame owner when the sketch becomes active.
  useEffect(() => {
    const panel = canvasRef.current?.closest('[role="tabpanel"]')
    if (!panel) return
    const observer = new MutationObserver(invalidate)
    observer.observe(panel, { attributes: true, attributeFilter: ['aria-hidden'] })
    return () => observer.disconnect()
  }, [canvasRef, invalidate])

  return {
    surface,
    observeCanvasDraw: suggestion.observe,
    control: {
      choice, status,
      onChange: changeRenderer,
      onRetry: retry,
      suggestion: suggestion.visible ? { onEnable: () => changeRenderer('gpu'), onDismiss: suggestion.dismiss } : undefined,
    },
  }
}
