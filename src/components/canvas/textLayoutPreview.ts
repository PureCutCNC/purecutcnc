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
import { textArcDragPlacement } from '../../sketch/textPlacement'
import { resolveFeatureInstance } from '../../store/helpers/resolveFeatures'
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

  const base = {
    text: target.text.text,
    style: target.text.style,
    fontId: target.text.fontId,
    size: target.text.size,
    operation: target.operation,
  }
  const layout = pending.layout
  const config = { ...base, layout }

  const preview = layout?.kind === 'path'
    ? { config, anchor: { x: 0, y: 0 } }
    : layout?.kind === 'arc' && pending.center
      ? currentPreviewPoint
        ? textArcDragPlacement(config, pending.center, currentPreviewPoint, pending.directionPinned)
        : { config, anchor: pending.center }
      : null

  if (preview) {
    for (const shape of generateTextShapes(preview.config, preview.anchor)) {
      drawPreviewProfile(ctx, shape.profile, vt, '')
    }
  }
  if (pending.center) {
    drawPendingPoint(ctx, pending.center, vt)
  }
}
