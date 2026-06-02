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
 * Canvas rendering + hit-testing for permanent dimension annotations and the
 * transient tape measure. Pure geometry/value logic lives in
 * `src/sketch/dimensions.ts`; this module turns a layout into pixels.
 */

import type { Point, Project } from '../../types/project'
import type { Units } from '../../utils/units'
import { formatAngle, formatLength } from '../../utils/units'
import {
  dimensionLabelText,
  dimensionLayout,
  isDimensionDangling,
  measureValue,
  offsetForCursor,
  resolveAnchor,
} from '../../sketch/dimensions'
import type { DimensionLayout } from '../../sketch/dimensions'
import type { DimensionAnnotation, DimensionAnchor } from '../../types/project'
import { drawMeasurementLabel } from './measurements'
import { worldToCanvas } from './viewTransform'
import type { CanvasPoint, ViewTransform } from './viewTransform'

const ACTIVE_COLOR = 'rgba(239, 188, 122, 0.95)'
const LINE_COLOR = 'rgba(180, 200, 224, 0.85)'
const EXT_COLOR = 'rgba(180, 200, 224, 0.45)'
const SELECTED_COLOR = 'rgba(120, 200, 255, 0.98)'
const WARNING_COLOR = 'rgba(240, 120, 120, 0.9)'
const ARROW_PX = 7

function fmtLen(units: Units): (v: number) => string {
  return (v: number) => formatLength(v, units)
}

function lineTo(ctx: CanvasRenderingContext2D, a: CanvasPoint, b: CanvasPoint): void {
  ctx.beginPath()
  ctx.moveTo(a.cx, a.cy)
  ctx.lineTo(b.cx, b.cy)
  ctx.stroke()
}

/** Draw a filled arrowhead at `tip`, pointing away from `from`. */
function drawArrow(ctx: CanvasRenderingContext2D, tip: CanvasPoint, from: CanvasPoint, color: string): void {
  const dx = tip.cx - from.cx
  const dy = tip.cy - from.cy
  const len = Math.hypot(dx, dy)
  if (len < 1e-3) return
  const ux = dx / len
  const uy = dy / len
  const baseX = tip.cx - ux * ARROW_PX
  const baseY = tip.cy - uy * ARROW_PX
  const nx = -uy
  const ny = ux
  const half = ARROW_PX * 0.42
  ctx.fillStyle = color
  ctx.beginPath()
  ctx.moveTo(tip.cx, tip.cy)
  ctx.lineTo(baseX + nx * half, baseY + ny * half)
  ctx.lineTo(baseX - nx * half, baseY - ny * half)
  ctx.closePath()
  ctx.fill()
}

function drawLayout(
  ctx: CanvasRenderingContext2D,
  layout: DimensionLayout,
  vt: ViewTransform,
  units: Units,
  labelText: string,
  color: string,
): void {
  const start = worldToCanvas(layout.lineStart, vt)
  const end = worldToCanvas(layout.lineEnd, vt)

  // Extension/witness lines
  ctx.strokeStyle = EXT_COLOR
  ctx.lineWidth = 1
  for (const [from, to] of layout.extensions) {
    lineTo(ctx, worldToCanvas(from, vt), worldToCanvas(to, vt))
  }

  // Dimension line
  ctx.strokeStyle = color
  ctx.lineWidth = 1.25
  if (layout.type === 'angle' && layout.vertex && layout.startAngle !== undefined && layout.endAngle !== undefined) {
    const vc = worldToCanvas(layout.vertex, vt)
    const radiusPx = Math.hypot(start.cx - vc.cx, start.cy - vc.cy)
    let delta = layout.endAngle - layout.startAngle
    while (delta <= -Math.PI) delta += Math.PI * 2
    while (delta > Math.PI) delta -= Math.PI * 2
    ctx.beginPath()
    ctx.arc(vc.cx, vc.cy, radiusPx, layout.startAngle, layout.startAngle + delta, delta < 0)
    ctx.stroke()
  } else {
    lineTo(ctx, start, end)
    drawArrow(ctx, start, end, color)
    drawArrow(ctx, end, start, color)
  }

  const labelCanvas = worldToCanvas(layout.labelPos, vt)
  drawMeasurementLabel(ctx, labelText, labelCanvas.cx, labelCanvas.cy, layout.labelAngle)
  void units
}

/** Draw all persistent dimension annotations. */
export function drawDimensions(
  ctx: CanvasRenderingContext2D,
  project: Project,
  vt: ViewTransform,
  units: Units,
  opts?: { selectedId?: string | null },
): void {
  const selectedId = opts?.selectedId ?? null
  const lenFmt = fmtLen(units)

  for (const dim of project.annotations) {
    if (!dim.visible) continue

    if (isDimensionDangling(dim, project)) {
      // Dangling: draw a warning marker at whatever anchor still resolves.
      const fallback = resolveAnchor(dim.a, project)
        ?? (dim.b ? resolveAnchor(dim.b, project) : null)
      if (fallback) {
        const c = worldToCanvas(fallback, vt)
        ctx.strokeStyle = WARNING_COLOR
        ctx.fillStyle = WARNING_COLOR
        ctx.lineWidth = 1.5
        ctx.beginPath()
        ctx.arc(c.cx, c.cy, 5, 0, Math.PI * 2)
        ctx.stroke()
        drawMeasurementLabel(ctx, '⚠ dim', c.cx + 22, c.cy, 0)
      }
      continue
    }

    const layout = dimensionLayout(dim, project)
    if (!layout) continue
    const value = measureValue(dim, project)
    if (value === null) continue
    const labelText = dimensionLabelText(dim, value, lenFmt, formatAngle)
    const color = dim.id === selectedId ? SELECTED_COLOR : LINE_COLOR
    drawLayout(ctx, layout, vt, units, labelText, color)
  }
}

/** Draw the transient tape-measure overlay (in-progress + frozen). */
export function drawTapeMeasure(
  ctx: CanvasRenderingContext2D,
  tape: { first: Point | null; frozen: { a: Point; b: Point } | null },
  livePoint: Point | null,
  vt: ViewTransform,
  units: Units,
): void {
  const drawSpan = (a: Point, b: Point, dashed: boolean): void => {
    const ca = worldToCanvas(a, vt)
    const cb = worldToCanvas(b, vt)
    ctx.save()
    ctx.strokeStyle = ACTIVE_COLOR
    ctx.lineWidth = 1.25
    if (dashed) ctx.setLineDash([5, 4])
    lineTo(ctx, ca, cb)
    ctx.restore()
    drawArrow(ctx, ca, cb, ACTIVE_COLOR)
    drawArrow(ctx, cb, ca, ACTIVE_COLOR)

    const dx = b.x - a.x
    const dy = b.y - a.y
    const dist = Math.hypot(dx, dy)
    const angle = Math.abs((Math.atan2(dy, dx) * 180) / Math.PI)
    const text = `${formatLength(dist, units)}  ·  Δx ${formatLength(Math.abs(dx), units)}  Δy ${formatLength(Math.abs(dy), units)}  ·  ${formatAngle(angle)}`
    const mid = { cx: (ca.cx + cb.cx) / 2, cy: (ca.cy + cb.cy) / 2 }
    drawMeasurementLabel(ctx, text, mid.cx, mid.cy - 16, 0)
  }

  if (tape.frozen) {
    drawSpan(tape.frozen.a, tape.frozen.b, false)
  }
  if (tape.first && livePoint) {
    drawSpan(tape.first, livePoint, true)
  } else if (tape.first) {
    const c = worldToCanvas(tape.first, vt)
    ctx.fillStyle = ACTIVE_COLOR
    ctx.beginPath()
    ctx.arc(c.cx, c.cy, 4, 0, Math.PI * 2)
    ctx.fill()
  }
}

/**
 * Preview the in-progress permanent-dimension placement. Draws picked anchor
 * dots, a rubber-band to the cursor while collecting anchors, and — once enough
 * anchors are picked — a live preview of the dimension with the cursor-driven
 * offset (the offset-pick phase).
 */
export function drawPendingDimensionPreview(
  ctx: CanvasRenderingContext2D,
  pending: { type: DimensionAnnotation['type']; a: DimensionAnchor | null; b: DimensionAnchor | null; c: DimensionAnchor | null },
  livePoint: Point | null,
  vt: ViewTransform,
  project: Project,
  units: Units,
): void {
  const dot = (p: Point): void => {
    const c = worldToCanvas(p, vt)
    ctx.fillStyle = ACTIVE_COLOR
    ctx.beginPath()
    ctx.arc(c.cx, c.cy, 4, 0, Math.PI * 2)
    ctx.fill()
  }
  const a = pending.a ? resolveAnchor(pending.a, project) : null
  const b = pending.b ? resolveAnchor(pending.b, project) : null
  const c = pending.c ? resolveAnchor(pending.c, project) : null
  if (a) dot(a)
  if (b) dot(b)
  if (c) dot(c)

  const need = pending.type === 'angle' ? 3 : 2
  const picked = [pending.a, pending.b, pending.c].filter(Boolean).length

  if (picked < need) {
    // Rubber-band from the last picked anchor to the cursor.
    const last = c ?? b ?? a
    if (last && livePoint) {
      ctx.save()
      ctx.strokeStyle = ACTIVE_COLOR
      ctx.lineWidth = 1
      ctx.setLineDash([5, 4])
      lineTo(ctx, worldToCanvas(last, vt), worldToCanvas(livePoint, vt))
      ctx.restore()
    }
    return
  }

  // Offset-pick phase: synthesize a temp dimension and preview it at the cursor.
  if (!livePoint) return
  const temp: DimensionAnnotation = {
    id: '__preview__',
    type: pending.type,
    a: pending.a!,
    b: pending.b ?? undefined,
    c: pending.c ?? undefined,
    offset: 0,
    visible: true,
    locked: false,
    textOverride: null,
    precisionOverride: null,
  }
  const offset = offsetForCursor(temp, project, livePoint)
  if (offset !== null) temp.offset = offset
  const layout = dimensionLayout(temp, project)
  const value = measureValue(temp, project)
  if (layout && value !== null) {
    drawLayout(ctx, layout, vt, units, dimensionLabelText(temp, value, fmtLen(units), formatAngle), ACTIVE_COLOR)
  }
}

/**
 * Hit-test the dimension annotations at a canvas point. Returns the id of the
 * nearest dimension whose line or label is within `tolerancePx`, or null.
 */
export function pickDimensionAt(
  project: Project,
  vt: ViewTransform,
  point: CanvasPoint,
  tolerancePx = 8,
): string | null {
  let bestId: string | null = null
  let bestDist = tolerancePx

  for (const dim of project.annotations) {
    if (!dim.visible) continue
    const layout = dimensionLayout(dim, project)
    if (!layout) continue
    const a = worldToCanvas(layout.lineStart, vt)
    const b = worldToCanvas(layout.lineEnd, vt)
    const dLine = distanceToSegment(point, a, b)
    const labelC = worldToCanvas(layout.labelPos, vt)
    const dLabel = Math.hypot(point.cx - labelC.cx, point.cy - labelC.cy)
    const d = Math.min(dLine, dLabel)
    if (d <= bestDist) {
      bestDist = d
      bestId = dim.id
    }
  }
  return bestId
}

function distanceToSegment(p: CanvasPoint, a: CanvasPoint, b: CanvasPoint): number {
  const dx = b.cx - a.cx
  const dy = b.cy - a.cy
  const lenSq = dx * dx + dy * dy
  if (lenSq < 1e-6) return Math.hypot(p.cx - a.cx, p.cy - a.cy)
  let t = ((p.cx - a.cx) * dx + (p.cy - a.cy) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.cx - (a.cx + t * dx), p.cy - (a.cy + t * dy))
}
