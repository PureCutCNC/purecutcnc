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
 * What the sketch draws for the face the workspace is *not* on (issue #945):
 * ghost outlines of the other face's features and the marker for where the
 * Top origin lands once the stock is turned over. Reference geometry only —
 * nothing here is filled, hit-tested or snapped to.
 */

import { activeFace, ghostFeatureIds, isThroughFeature } from '../../store/helpers/activeFace'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { getFeatureGeometryProfiles } from '../../text'
import { getProfileBounds } from '../../types/project'
import type { Point, Project, SetupFace, SketchFeature } from '../../types/project'
import { canvasColors, canvasRgba } from './canvasPalette'
import { traceProfilePath } from './profilePrimitives'
import { worldToCanvas } from './viewTransform'
import type { ViewTransform } from './viewTransform'

const GHOST_DASH = [4, 4]
const GHOST_LABEL_FONT = '11px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace'

function ghostColorKey(face: SetupFace): 'ghostTop' | 'ghostBottom' {
  return face === 'top' ? 'ghostTop' : 'ghostBottom'
}

/**
 * A feature from the other face: a dashed outline in that face's colour and
 * never a fill. `marker` is the short tag shown under a feature that reaches
 * both faces (THRU), so it reads as cuttable from here too.
 */
export function drawGhostFeature(
  ctx: CanvasRenderingContext2D,
  feature: SketchFeature,
  vt: ViewTransform,
  face: SetupFace,
  marker: string | null,
): void {
  const colorKey = ghostColorKey(face)
  ctx.save()
  ctx.setLineDash(GHOST_DASH)
  ctx.lineWidth = 1.3
  ctx.strokeStyle = canvasRgba(colorKey, 0.6)
  for (const profile of getFeatureGeometryProfiles(feature)) {
    traceProfilePath(ctx, profile, vt)
    ctx.stroke()
  }
  if (marker) {
    const bounds = getProfileBounds(feature.sketch.profile)
    const corners = [
      worldToCanvas({ x: bounds.minX, y: bounds.minY }, vt),
      worldToCanvas({ x: bounds.maxX, y: bounds.maxY }, vt),
    ]
    ctx.setLineDash([])
    ctx.font = GHOST_LABEL_FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    ctx.fillStyle = canvasRgba(colorKey, 0.85)
    ctx.fillText(
      marker,
      (corners[0].cx + corners[1].cx) / 2,
      Math.max(corners[0].cy, corners[1].cy) + 5,
    )
  }
  ctx.restore()
}

/** The faint marker for where the Top origin lands after the flip. */
export function drawTopOriginLanding(
  ctx: CanvasRenderingContext2D,
  topOrigin: Point,
  vt: ViewTransform,
  label: string,
): void {
  const anchor = worldToCanvas(topOrigin, vt)
  const arm = 22
  // The Top origin's axes, as they point once the stock is turned over.
  const alongX = worldToCanvas({ x: topOrigin.x + 1, y: topOrigin.y }, vt)
  const alongY = worldToCanvas({ x: topOrigin.x, y: topOrigin.y - 1 }, vt)
  const unit = (to: { cx: number; cy: number }) => {
    const length = Math.hypot(to.cx - anchor.cx, to.cy - anchor.cy) || 1
    return { x: (to.cx - anchor.cx) / length, y: (to.cy - anchor.cy) / length }
  }
  const dirX = unit(alongX)
  const dirY = unit(alongY)

  ctx.save()
  ctx.globalAlpha = 0.55
  ctx.strokeStyle = canvasColors().ghostTop
  ctx.lineWidth = 1.5
  ctx.setLineDash([3, 2])
  ctx.beginPath()
  ctx.moveTo(anchor.cx, anchor.cy)
  ctx.lineTo(anchor.cx + dirX.x * arm, anchor.cy + dirX.y * arm)
  ctx.moveTo(anchor.cx, anchor.cy)
  ctx.lineTo(anchor.cx + dirY.x * arm, anchor.cy + dirY.y * arm)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.arc(anchor.cx, anchor.cy, 4, 0, Math.PI * 2)
  ctx.stroke()
  ctx.globalAlpha = 0.85
  ctx.font = GHOST_LABEL_FONT
  ctx.fillStyle = canvasColors().ghostTop
  ctx.textAlign = 'left'
  ctx.textBaseline = 'alphabetic'
  // Keep the label clear of the axis stubs, on the side they do not point.
  ctx.fillText(label, anchor.cx + 10, anchor.cy + (dirY.y > 0 ? -10 : 18))
  ctx.restore()
}

/**
 * Draw everything the sketch shows of the other face and return the ids of
 * its features, which the caller then leaves out of every editable pass.
 * With the ghost hidden only the ids come back.
 */
export function drawOtherFace(
  ctx: CanvasRenderingContext2D,
  project: Project,
  features: readonly ResolvedSketchFeature[],
  vt: ViewTransform,
  showOtherSide: boolean,
  throughLabel: string,
  topOriginLabel: string,
): Set<string> {
  const ghostIds = ghostFeatureIds(project)
  if (showOtherSide && ghostIds.size > 0) {
    for (const feature of features) {
      if (!feature.visible || !ghostIds.has(feature.id)) continue
      drawGhostFeature(ctx, feature, vt, feature.authoringFace, isThroughFeature(project, feature) ? throughLabel : null)
    }
  }
  if (project.origin.visible && activeFace(project) === 'bottom') {
    drawTopOriginLanding(ctx, project.origin, vt, topOriginLabel)
  }
  return ghostIds
}
