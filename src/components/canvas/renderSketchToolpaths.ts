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
import type { ViewTransform } from './viewTransform'

export function renderSketchToolpaths(
  surface: SketchToolpathSurface | null, ctx: CanvasRenderingContext2D,
  project: Project, toolpaths: readonly ToolpathResult[], selectedId: string | null,
  vt: ViewTransform, visibility: ToolpathVisibility | undefined, deferArrows: boolean,
): CanvasRenderingContext2D {
  const visible = visibility ?? { cuts: true, leadIns: true, rapids: true, plunges: true, retractions: true, directions: true }
  const entries = toolpaths.filter(tp => tp.moves.length > 0).map(toolpath => {
    const percent = pocketSlotFeedPercent(project.operations.find(op => op.id === toolpath.operationId))
    return { toolpath, emphasized: toolpath.operationId === selectedId, slotScale: percent === null ? 1 : percent / 100 }
  })
  let gpuActive = false
  if (surface) {
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
  if (!gpuActive) for (const { toolpath, emphasized, slotScale } of entries) {
    drawToolpath(ctx, toolpath, vt, emphasized, visible, slotScale, { deferArrows })
  }
  return ctx
}
