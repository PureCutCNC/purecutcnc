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
 * Live preview for an in-progress text baseline edit.
 *
 * The run being laid out is an existing feature, so this draws what **Apply**
 * would produce rather than what a click would create. An arc follows the
 * cursor for radius and angle once its centre is picked; a baked path already
 * carries its own world position and needs no cursor at all.
 */

import type { PendingTextLayout } from '../../store/types'
import type { Point, Project } from '../../types/project'
import { generateTextShapes } from '../../text'
import { localTextLayout, textArcDragPlacement } from '../../sketch/textPlacement'
import { applyMatrixToPoint, resolveFeatureInstance, type ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { invertMatrix } from '../../store/helpers/instanceTransforms'
import { transformProfile } from '../../geometry/profile'
import { drawPendingPoint, drawPreviewProfile } from './previewPrimitives'
import type { ViewTransform } from './viewTransform'

/**
 * The text config a pending edit describes: the run's own content and font,
 * with the pending baseline swapped in. `null` when the target is gone or is
 * not a text run.
 */
export function textLayoutConfigFor(project: Project, pending: PendingTextLayout | null) {
  const target = pending ? resolveFeatureInstance(project, pending.featureId) : null
  if (!pending || !target?.text) {
    return null
  }
  return {
    text: target.text.text,
    style: target.text.style,
    fontId: target.text.fontId,
    size: target.text.size,
    operation: target.operation,
    layout: pending.layout,
  }
}

export function drawTextLayoutPreview(
  ctx: CanvasRenderingContext2D,
  pending: PendingTextLayout,
  project: Project,
  currentPreviewPoint: Point | null,
  vt: ViewTransform,
) {
  const target = resolveFeatureInstance(project, pending.featureId)
  if (!target?.text) {
    return
  }

  // Nothing to preview until an arc has its centre: without one the run would
  // be drawn around the origin, which reads as the text flying off somewhere
  // random the moment the panel opens.
  if (pending.layout?.kind === 'arc' && !pending.center) {
    return
  }

  // An arc mid-drag re-derives radius and angle from the cursor through the
  // same helper the commit uses.
  const dragged = pending.layout?.kind === 'arc' && pending.center && currentPreviewPoint
    ? textArcDragPlacement(
      { ...configOf(target), layout: pending.layout },
      pending.center,
      currentPreviewPoint,
      pending.directionPinned,
    ).config.layout ?? pending.layout
    : pending.layout

  // Then the *same* world-to-local conversion the commit does, so the preview
  // cannot show one thing and Apply produce another. Doing this by hand here
  // was the bug: preview drew the world centre against an origin-centred
  // template, which matched only for an untransformed run.
  const toLocal = invertMatrix(target.transform)
  const localLayout = localTextLayout(
    dragged,
    pending.center,
    (point) => applyMatrixToPoint(toLocal, point),
  )
  if (!localLayout) {
    return
  }

  // And resolved the way the canvas will resolve it once applied.
  for (const shape of generateTextShapes({ ...configOf(target), layout: localLayout }, { x: 0, y: 0 })) {
    drawPreviewProfile(
      ctx,
      transformProfile(shape.profile, (point) => applyMatrixToPoint(target.transform, point)),
      vt,
      '',
    )
  }
  if (pending.center) {
    drawPendingPoint(ctx, pending.center, vt)
  }
}

function configOf(target: ResolvedSketchFeature) {
  return {
    text: target.text!.text,
    style: target.text!.style,
    fontId: target.text!.fontId,
    size: target.text!.size,
    operation: target.operation,
  }
}
