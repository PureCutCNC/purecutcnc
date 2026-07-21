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

import type { Matrix2D, SketchProfile } from '../../types/project'
import { profileVertices } from '../../types/project'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import type { ViewTransform } from './viewTransform'
import { traceProfilePath } from './profilePrimitives'
import { canvasColors } from './canvasPalette'

export interface StlTopViewPlacement {
  localBounds: {
    x: number
    y: number
    width: number
    height: number
  }
  canvasTransform: [number, number, number, number, number, number]
}

/** Map a definition-local imported-model image through its instance and view transforms. */
export function resolveStlTopViewPlacement(
  definitionProfile: SketchProfile,
  instanceTransform: Matrix2D,
  vt: ViewTransform,
): StlTopViewPlacement | null {
  const verts = profileVertices(definitionProfile)
  if (verts.length < 3) return null

  let minX = Infinity, maxX = -Infinity
  let minY = Infinity, maxY = -Infinity
  for (const point of verts) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }

  const width = maxX - minX
  const height = maxY - minY
  if (!(width > 1e-9) || !(height > 1e-9)) return null

  return {
    localBounds: { x: minX, y: minY, width, height },
    canvasTransform: [
      instanceTransform.a * vt.scale,
      instanceTransform.b * vt.scale,
      instanceTransform.c * vt.scale,
      instanceTransform.d * vt.scale,
      vt.offsetX + instanceTransform.e * vt.scale,
      vt.offsetY + instanceTransform.f * vt.scale,
    ],
  }
}

/**
 * Draw an STL/imported-model feature's top-view silhouette image —
 * the image mapped inside the feature's sketch profile, clipped to
 * the profile bounds.
 */
export function drawStlTopViewImage(
  ctx: CanvasRenderingContext2D,
  feature: ResolvedSketchFeature,
  definitionProfile: SketchProfile,
  image: HTMLImageElement,
  vt: ViewTransform,
  selected: boolean,
  hovered: boolean,
  editing: boolean,
): void {
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return

  const placement = resolveStlTopViewPlacement(definitionProfile, feature.transform, vt)
  if (!placement) return

  ctx.save()
  traceProfilePath(ctx, feature.sketch.profile, vt)
  ctx.clip('evenodd')
  ctx.transform(...placement.canvasTransform)
  ctx.globalAlpha = selected || hovered || editing ? 0.72 : 0.86
  ctx.drawImage(
    image,
    placement.localBounds.x,
    placement.localBounds.y,
    placement.localBounds.width,
    placement.localBounds.height,
  )
  ctx.restore()

  ctx.save()
  traceProfilePath(ctx, feature.sketch.profile, vt)
  ctx.strokeStyle = selected
    ? canvasColors().active
    : hovered
      ? canvasColors().draft
      : editing
        ? canvasColors().activeStrong
        : canvasColors().featureModelStroke
  ctx.lineWidth = selected || editing ? 2.5 : 1.8
  ctx.stroke()
  ctx.restore()
}
