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

/**
 * The 2D sketch's plasma kerf preview (issue #961, slice A): a translucent band
 * one kerf wide under the existing centre line, plus a fixed-size pierce
 * marker. Display only — nothing here changes what is generated or exported.
 *
 * The band draws in stock space, mapped per point through `worldToCanvas`, so
 * the mirrored Bottom view needs no context transform; the caller can therefore
 * lay it on the base canvas *before* the line renderers, which is what puts the
 * ordinary centre line on top of it.
 */

import type { ToolpathMove } from '../../engine/toolpaths/types'
import type { Project } from '../../types/project'
import type { ToolpathVisibility } from '../toolpathVisibility'
import {
  PLASMA_KERF_BAND_ALPHA,
  PLASMA_PIERCE_MARKER_RADIUS_PX,
  plasmaKerfGeometry,
  plasmaKerfWidth,
  type PlasmaKerfSegment,
} from '../plasmaKerfPreview'
import { canvasColors } from './canvasPalette'
import { toolpathStrokeAlpha } from './toolpathStyles'
import { worldToCanvas, type ViewTransform } from './viewTransform'

/** One toolpath preview entry, the shape `renderSketchToolpaths` already builds. */
export interface PlasmaKerfEntry {
  toolpath: { operationId: string; moves: readonly ToolpathMove[] }
  emphasized: boolean
  muted: boolean
}

function strokeSegment(
  ctx: CanvasRenderingContext2D,
  segment: PlasmaKerfSegment,
  vt: ViewTransform,
): void {
  const from = worldToCanvas({ x: segment.fromX, y: segment.fromY }, vt)
  const to = worldToCanvas({ x: segment.toX, y: segment.toY }, vt)
  ctx.moveTo(from.cx, from.cy)
  ctx.lineTo(to.cx, to.cy)
}

/**
 * Stroke one translucent band per plasma entry: the contour segments in the
 * cut colour under `visibility.cuts`, the lead segments in the plunge colour
 * under `visibility.leadIns`. One path per colour per entry; a disabled or
 * empty part of an entry leaves no path at all.
 */
export function drawPlasmaKerfBands(
  ctx: CanvasRenderingContext2D,
  project: Project,
  entries: readonly PlasmaKerfEntry[],
  vt: ViewTransform,
  visibility: ToolpathVisibility,
): void {
  for (const entry of entries) {
    const width = plasmaKerfWidth(project, entry.toolpath.operationId)
    if (width === null) continue
    const geometry = plasmaKerfGeometry(entry.toolpath)
    ctx.save()
    ctx.lineWidth = width * vt.scale
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.setLineDash([])
    ctx.globalAlpha = toolpathStrokeAlpha(entry.emphasized, entry.muted) * PLASMA_KERF_BAND_ALPHA
    if (visibility.cuts && geometry.contour.length > 0) {
      ctx.beginPath()
      for (const segment of geometry.contour) strokeSegment(ctx, segment, vt)
      ctx.strokeStyle = canvasColors().toolpathCut
      ctx.stroke()
    }
    if (visibility.leadIns && geometry.leads.length > 0) {
      ctx.beginPath()
      for (const segment of geometry.leads) strokeSegment(ctx, segment, vt)
      ctx.strokeStyle = canvasColors().toolpathPlunge
      ctx.stroke()
    }
    ctx.restore()
  }
}

/**
 * Draw one ring plus a filled centre dot at every pierce, at a fixed size in
 * screen pixels so the marker marks a place, not a size — it never scales with
 * zoom. Gated by `visibility.plunges`, the layer a pierce belongs to.
 */
export function drawPlasmaPierceMarkers(
  ctx: CanvasRenderingContext2D,
  project: Project,
  entries: readonly PlasmaKerfEntry[],
  vt: ViewTransform,
  visibility: ToolpathVisibility,
): void {
  if (!visibility.plunges) return
  for (const entry of entries) {
    const width = plasmaKerfWidth(project, entry.toolpath.operationId)
    if (width === null) continue
    const geometry = plasmaKerfGeometry(entry.toolpath)
    if (geometry.pierces.length === 0) continue
    ctx.save()
    ctx.globalAlpha = toolpathStrokeAlpha(entry.emphasized, entry.muted)
    ctx.strokeStyle = canvasColors().toolpathPlunge
    ctx.fillStyle = canvasColors().toolpathPlunge
    ctx.lineWidth = 1.5
    for (const pierce of geometry.pierces) {
      const { cx, cy } = worldToCanvas(pierce, vt)
      ctx.beginPath()
      ctx.arc(cx, cy, PLASMA_PIERCE_MARKER_RADIUS_PX, 0, Math.PI * 2)
      ctx.stroke()
      ctx.beginPath()
      ctx.arc(cx, cy, 1.5, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }
}
