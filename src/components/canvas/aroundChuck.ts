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

import type { Clamp } from '../../types/project'
import type { AroundFrame } from '../../engine/aroundFrame'
import type { ViewTransform } from './viewTransform'
import { drawClampFootprint } from './scenePrimitives'
import { worldToCanvas } from './viewTransform'

/** Display clipping only: never change the sheet's snap subjects or CAM bands. */
export function aroundChuckFootprint(clamp: Clamp, frame: Pick<AroundFrame, 'axis' | 'sheetStart' | 'circumference'>): Clamp {
  return frame.axis === 'x'
    ? { ...clamp, y: frame.sheetStart, h: frame.circumference }
    : { ...clamp, x: frame.sheetStart, w: frame.circumference }
}

export function drawAroundChuck(ctx: CanvasRenderingContext2D, clamp: Clamp,
  frame: Pick<AroundFrame, 'axis' | 'sheetStart' | 'circumference'>, vt: ViewTransform,
  selected: boolean, colliding: boolean): boolean {
  if (clamp.type !== 'chuck') return false
  const footprint = aroundChuckFootprint(clamp, frame)
  drawClampFootprint(ctx, footprint, vt, selected, colliding)
  const at = worldToCanvas({ x: footprint.x + footprint.w / 2, y: footprint.y + footprint.h / 2 }, vt)
  ctx.save()
  ctx.fillStyle = ctx.strokeStyle
  ctx.font = '11px sans-serif'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(clamp.name, at.cx, at.cy, Math.max(1, footprint.w * vt.scale))
  ctx.restore()
  return true
}
