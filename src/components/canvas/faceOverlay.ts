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
 *
 * It also draws the one thing made on the Around sheet that a flat face can
 * show exactly (issue #1112 rt2-d): a Turn or Polygon is a solid turned around
 * the bar, so from Top or Bottom its side view is a read-only dashed outline
 * rather than nothing at all.
 */

import { cannedShapeIsModel } from '../../cannedShapes'
import { activeFace, ghostFeatureIds, isThroughFeature } from '../../store/helpers/activeFace'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { getFeatureGeometryProfiles } from '../../text'
import { getProfileBounds } from '../../types/project'
import type { FlatFace, Point, Project, SetupFace, SketchFeature } from '../../types/project'
import { canvasColors, canvasRgba } from './canvasPalette'
import { traceProfilePath } from './profilePrimitives'
import { worldToCanvas } from './viewTransform'
import type { ViewTransform } from './viewTransform'

const GHOST_DASH = [4, 4]
const GHOST_LABEL_FONT = '11px "IBM Plex Mono", "SFMono-Regular", Consolas, monospace'

function ghostColorKey(face: FlatFace): 'ghostTop' | 'ghostBottom' {
  return face === 'top' ? 'ghostTop' : 'ghostBottom'
}

/**
 * A feature from the other face: a dashed outline in that face's colour and
 * never a fill. `marker` is the short tag shown under a feature that reaches
 * both faces (THRU), so it reads as cuttable from here too.
 *
 * Only a flat face can have a ghost: a flat face and the Around sheet share no
 * plane, so a sheet feature is never drawn as reference on Top or Bottom
 * (issue #395).
 */
export function drawGhostFeature(
  ctx: CanvasRenderingContext2D,
  feature: SketchFeature,
  vt: ViewTransform,
  face: FlatFace,
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
 *
 * Around is nobody's ghost (issue #395): with the sheet in view nothing of the
 * flat faces is drawn — "other side" included — and on a flat face a sheet
 * feature is never drawn either, because the two share no plane.
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
  const face = activeFace(project)
  if (showOtherSide && face !== 'around' && ghostIds.size > 0) {
    for (const feature of features) {
      if (!feature.visible || !ghostIds.has(feature.id)) continue
      const ghostFace = feature.authoringFace ?? 'top'
      if (ghostFace === 'around') continue
      drawGhostFeature(ctx, feature, vt, ghostFace, isThroughFeature(project, feature) ? throughLabel : null)
    }
  }
  if (project.origin.visible && face === 'bottom') {
    drawTopOriginLanding(ctx, project.origin, vt, topOriginLabel)
  }
  return ghostIds
}

/** What the hover/selection pass needs to colour a solid's side view. */
export interface SideViewSelection {
  hoveredFeatureId: string | null
  selectedFeatureIds: readonly string[]
}

/** True for a Turn or Polygon: a generated model turned around the bar. */
export function isRotarySolid(feature: { canned?: SketchFeature['canned'] }): boolean {
  return cannedShapeIsModel(feature.canned)
}

/**
 * Draw a Turn or Polygon on Top or Bottom, and return the ids drawn (issue
 * #1112 rt2-d, item 19).
 *
 * Nothing made on the Around sheet is drawn on a flat face (issue #395): the
 * sheet and a flat face share no plane. A Turn or a Polygon is the exception,
 * because it is a solid of revolution about the bar's axis — the generated
 * outline is its **side view**, which is exactly what a flat face sees, and
 * the generator produces it in stock space for both faces.
 *
 * The outline is dashed and unfilled like a ghost, since nothing on the canvas
 * can be edited: there are no handles and no drag. The click target is real
 * though — the model is selectable on every face (issue #1112 I), so this
 * function does not put it in `ghostFeatureIds`; the caller only leaves it out
 * of the ordinary editable draw pass. It therefore takes the palette's hover
 * and selection colours, which the ordinary pass would have drawn.
 *
 * It is always drawn, independent of "show other side": that toggle hides the
 * *other face's* reference geometry, and this is the current face's own view
 * of a solid that belongs to the bar rather than to a face.
 */
export function drawRotarySolidSideViews(
  ctx: CanvasRenderingContext2D,
  project: Project,
  features: readonly ResolvedSketchFeature[],
  vt: ViewTransform,
  selection: SideViewSelection,
  operationHighlightIds?: ReadonlySet<string> | null,
): Set<string> {
  const drawn = new Set<string>()
  const face: SetupFace = activeFace(project)
  if (face === 'around') return drawn
  const quiet = canvasRgba(ghostColorKey(face), 0.6)
  for (const feature of features) {
    if (!feature.visible || !isRotarySolid(feature)) continue
    const selected = selection.selectedFeatureIds.includes(feature.id)
    const hovered = !selected && feature.id === selection.hoveredFeatureId
    const highlighted = operationHighlightIds?.has(feature.id) ?? false
    const stroke = selected
      ? canvasColors().active
      : hovered ? canvasColors().draft : quiet
    ctx.save()
    ctx.setLineDash(GHOST_DASH)
    ctx.lineWidth = selected ? 2.2 : hovered ? 1.9 : 1.3
    ctx.strokeStyle = stroke
    for (const profile of getFeatureGeometryProfiles(feature)) {
      // An armed operation rings what it could cut and veils the rest, the
      // one pass the ordinary feature loop would have run for this model.
      if (operationHighlightIds) {
        traceProfilePath(ctx, profile, vt)
        if (highlighted) {
          ctx.save()
          ctx.setLineDash([])
          ctx.lineWidth = 3
          ctx.strokeStyle = canvasRgba('constraintHighlight', 0.95)
          ctx.shadowColor = canvasRgba('constraintHighlight', 0.85)
          ctx.shadowBlur = 8
          ctx.stroke()
          ctx.restore()
        } else if (profile.closed) {
          ctx.fillStyle = canvasColors().veil
          ctx.fill()
        }
      }
      traceProfilePath(ctx, profile, vt)
      ctx.stroke()
    }
    ctx.restore()
    drawn.add(feature.id)
  }
  return drawn
}
