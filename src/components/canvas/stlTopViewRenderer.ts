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

import type { SketchFeature } from '../../types/project'
import { profileVertices } from '../../types/project'
import type { ViewTransform } from './viewTransform'
import { worldToCanvas } from './viewTransform'
import { traceProfilePath } from './profilePrimitives'

/**
 * Draw an STL/imported-model feature's top-view silhouette image —
 * the image mapped inside the feature's sketch profile, clipped to
 * the profile bounds.
 */
export function drawStlTopViewImage(
  ctx: CanvasRenderingContext2D,
  feature: SketchFeature,
  image: HTMLImageElement,
  vt: ViewTransform,
  selected: boolean,
  hovered: boolean,
  editing: boolean,
): void {
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return

  const verts = profileVertices(feature.sketch.profile)
  if (verts.length < 3) return

  const angle = ((feature.sketch.orientationAngle ?? 0) * Math.PI) / 180
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  const vx = -Math.sin(angle)
  const vy = Math.cos(angle)

  let minU = Infinity, maxU = -Infinity
  let minV = Infinity, maxV = -Infinity
  for (const point of verts) {
    const projectedU = point.x * ux + point.y * uy
    const projectedV = point.x * vx + point.y * vy
    if (projectedU < minU) minU = projectedU
    if (projectedU > maxU) maxU = projectedU
    if (projectedV < minV) minV = projectedV
    if (projectedV > maxV) maxV = projectedV
  }

  const width = maxU - minU
  const height = maxV - minV
  if (!(width > 1e-9) || !(height > 1e-9)) return

  const centerU = minU + width / 2
  const centerV = minV + height / 2
  const center = worldToCanvas({
    x: ux * centerU + vx * centerV,
    y: uy * centerU + vy * centerV,
  }, vt)
  const drawW = width * vt.scale
  const drawH = height * vt.scale

  ctx.save()
  traceProfilePath(ctx, feature.sketch.profile, vt)
  ctx.clip('evenodd')
  ctx.translate(center.cx, center.cy)
  ctx.rotate(angle)
  ctx.globalAlpha = selected || hovered || editing ? 0.72 : 0.86
  ctx.drawImage(image, -drawW / 2, -drawH / 2, drawW, drawH)
  ctx.restore()

  ctx.save()
  traceProfilePath(ctx, feature.sketch.profile, vt)
  ctx.strokeStyle = selected
    ? '#efbc7a'
    : hovered
      ? '#d2a064'
      : editing
        ? '#f7cd87'
        : '#bcc8d4'
  ctx.lineWidth = selected || editing ? 2.5 : 1.8
  ctx.stroke()
  ctx.restore()
}
