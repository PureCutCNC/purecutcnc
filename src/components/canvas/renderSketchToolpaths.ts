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

import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { Project } from '../../types/project'
import { pocketSlotFeedPercent } from '../../theme/palette'
import type { ToolpathVisibility } from '../toolpathVisibility'
import { canvasColors } from './canvasPalette'
import { drawToolpath } from './previewPrimitives'
import type { SketchToolpathSurface } from './useSketchToolpathRenderer'
import { applyViewMirror } from './viewTransform'
import type { ViewTransform } from './viewTransform'
import type { CanvasDrawSample } from './toolpathGpuSuggestion'

export function renderSketchToolpaths(
  surface: SketchToolpathSurface | null, ctx: CanvasRenderingContext2D,
  project: Project, toolpaths: readonly ToolpathResult[], selectedId: string | null, selectedLevel: number | null,
  vt: ViewTransform, visibility: ToolpathVisibility | undefined, deferArrows: boolean,
  observeCanvasDraw?: (sample: CanvasDrawSample) => void,
): CanvasRenderingContext2D {
  const visible = visibility ?? { cuts: true, leadIns: true, rapids: true, plunges: true, retractions: true, directions: true }
  const entries = toolpaths.filter(tp => tp.moves.length > 0).map(toolpath => {
    const percent = pocketSlotFeedPercent(project.operations.find(op => op.id === toolpath.operationId))
    const emphasized = toolpath.operationId === selectedId
    return { toolpath, emphasized, selectedLevel: emphasized ? selectedLevel : null, slotScale: percent === null ? 1 : percent / 100 }
  })
  // A Bottom view shows the stock turned over (issue #945). The toolpath
  // caches are built for an unmirrored view, so a mirrored one is drawn on
  // the Canvas path through a mirrored context; #947 makes the preview
  // setup-aware.
  const mirrored = vt.mirrorX !== undefined || vt.mirrorY !== undefined
  let gpuActive = false
  if (surface && mirrored) {
    surface.gpu.canvas.hidden = true
  } else if (surface) {
    const foreground = surface.foreground
    if (foreground.canvas.width !== ctx.canvas.width) foreground.canvas.width = ctx.canvas.width
    if (foreground.canvas.height !== ctx.canvas.height) foreground.canvas.height = ctx.canvas.height
    foreground.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height)
    try {
      gpuActive = !surface.failed && surface.gpu.render(entries, vt, ctx.canvas.width, ctx.canvas.height, visible, canvasColors(), deferArrows)
    } catch (error) {
      surface.failed = true
      surface.report(false, error)
    }
    surface.gpu.canvas.hidden = !gpuActive
    if (!surface.failed) surface.report(gpuActive)
    if (gpuActive) ctx = foreground
  }
  if (!gpuActive) {
    const start = observeCanvasDraw && entries.length > 0 ? performance.now() : null
    if (mirrored) {
      ctx.save()
      // Reflect about the canvas line the mirrored world axis maps onto.
      ctx.translate(
        vt.mirrorX === undefined ? 0 : 2 * vt.offsetX + vt.mirrorX * vt.scale,
        vt.mirrorY === undefined ? 0 : 2 * vt.offsetY + vt.mirrorY * vt.scale,
      )
      applyViewMirror(ctx, vt)
    }
    const plainView = mirrored ? { scale: vt.scale, offsetX: vt.offsetX, offsetY: vt.offsetY } : vt
    for (const { toolpath, emphasized, selectedLevel: entryLevel, slotScale } of entries) {
      drawToolpath(ctx, toolpath, plainView, emphasized, visible, slotScale, { deferArrows, selectedLevel: entryLevel })
    }
    if (mirrored) ctx.restore()
    if (start !== null) {
      const now = performance.now()
      observeCanvasDraw?.({ durationMs: now - start, now, navigating: deferArrows })
    }
  }
  return ctx
}
