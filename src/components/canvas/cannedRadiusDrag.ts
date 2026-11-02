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
 * A canned ellipse's radius-handle drag (issue #1112 slices w3e-a, rt7-g).
 *
 * The handles belong to the **Edit ellipse…** session, not to a plain
 * selection: a drag only exists while the panel for that ellipse is open
 * (Frank, round 7: "we should only show dots when in edit ellipse mode and
 * allow point drag, and manual changes"). Dragging is not an edit of the
 * project at all — every pointer move writes the dragged radius into the
 * panel's field text (`cannedEditDraft.ts`) as a *held* field, which the canvas
 * draws (outline and handles alike) while the project keeps that field's stored
 * radius until Save (issue #1112 rt7-g review). The hold is per field and lasts
 * the session: typing the other radius previews live but does not store the
 * dragged one (issue #1112 rt7-g correction). So a dragged radius is one undo
 * step on Save and is discarded by Cancel exactly like a typed one, and there
 * is no store write here to drift from the typed path.
 */

import type { Matrix2D, Point } from '../../types/project'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { ELLIPSE_CANNED_KIND } from '../../cannedShapes/generators/kinds'
import { ELLIPSE_EDITOR_REQUEST, normalizeEllipseCannedParams } from '../../cannedShapes/generators/ellipse'
import { editorNormalizedParams } from '../../cannedShapes/generators/editorForm'
import {
  dragEllipseRadius,
  ellipseRadiusAxisAt,
  ELLIPSE_RADIUS_MIN,
  type EllipseRadiusAxis,
} from '../../cannedShapes/ellipseHandles'
import { setCannedEditDraftField, type CannedEditDraft } from './cannedEditDraft'

/**
 * The precision a dragged radius lands on: four decimals, the same precision
 * the canned generators keep their lengths at. The field shows the rounded
 * number, so the handle, the text and the stored parameters are one value.
 */
const RADIUS_FIELD_PRECISION = 10000

/** The fields an ellipse handle edits: the axis name is the editor field key. */
export interface CannedRadiusDragState {
  featureId: string
  /** The instance placement the handles are read through, fixed for the drag. */
  transform: Matrix2D
  axis: EllipseRadiusAxis
  /** The parameters the panel's fields now hold: the live preview. */
  params: { rx: number; ry: number }
}

export type CannedRadiusHandleFeature = Pick<ResolvedSketchFeature, 'id' | 'canned' | 'transform'>

/** The radius the generator accepts, at field precision and never below the minimum. */
function fieldRadius(value: number): number {
  return Math.max(ELLIPSE_RADIUS_MIN, Math.round(value * RADIUS_FIELD_PRECISION) / RADIUS_FIELD_PRECISION)
}

/** The other radius of a draft, so a drag leaves the axis it is not pulling alone. */
function storedEllipseParams(feature: Pick<ResolvedSketchFeature, 'canned'>) {
  if (feature.canned?.kind !== ELLIPSE_CANNED_KIND) return null
  return normalizeEllipseCannedParams(feature.canned.params)
}

/**
 * The parameters this feature's handles draw at, or `null` when they are not on
 * screen: a plain selection draws nothing, and only the row the open editor
 * edits has handles (issue #1112 rt7-g).
 *
 * The fields are the ellipse's parameters: the panel's text after the
 * generator's own validation, or the stored parameters while a field holds a
 * value it refuses (which is what the preview keeps showing too). Typing a
 * radius therefore moves its handle, and a drag moves the same fields.
 */
export function cannedEditHandleParams(
  feature: Pick<ResolvedSketchFeature, 'id' | 'canned'>,
  draft: CannedEditDraft | null,
  drag: CannedRadiusDragState | null,
): { rx: number; ry: number } | null {
  if (!draft || draft.featureId !== feature.id) return null
  if (draft.kind !== ELLIPSE_CANNED_KIND) return null
  if (drag && drag.featureId === feature.id) return drag.params
  if (feature.canned?.kind !== ELLIPSE_CANNED_KIND) return null
  const typed = editorNormalizedParams(ELLIPSE_EDITOR_REQUEST, draft.values)
  return (typed ? normalizeEllipseCannedParams(typed) : null) ?? storedEllipseParams(feature)
}

/**
 * Start a drag on one handle of the ellipse whose editor is open. `null` when
 * no such session exists, the feature is not a canned ellipse, its parameters
 * do not normalize, or the index is not a handle — a drag must never guess
 * which radius it means.
 */
export function beginCannedRadiusDrag(
  feature: CannedRadiusHandleFeature,
  axisIndex: number,
  draft: CannedEditDraft | null,
): CannedRadiusDragState | null {
  if (feature.canned?.kind !== ELLIPSE_CANNED_KIND) return null
  const axis = ellipseRadiusAxisAt(axisIndex)
  if (!axis) return null
  const params = cannedEditHandleParams(feature, draft, null)
  if (!params) return null
  return {
    featureId: feature.id,
    transform: feature.transform,
    axis,
    params,
  }
}

/**
 * The drag after the pointer moved. The previous state is returned unchanged
 * when the gesture changed nothing, so the caller only publishes a change.
 */
export function updateCannedRadiusDrag(
  state: CannedRadiusDragState,
  worldPoint: Point,
): CannedRadiusDragState {
  const params = dragEllipseRadius(state.params, state.axis, worldPoint, state.transform)
  if (!params || params === state.params) return state
  const radius = fieldRadius(params[state.axis])
  if (radius === state.params[state.axis]) return state
  return { ...state, params: { ...state.params, [state.axis]: radius } }
}

/**
 * One pointer move of a radius drag, as the canvas pointer handler applies it:
 * the drag's own axis lock, then the radius preview.
 *
 * `constrainedPoint` is the snap-gated point every other canvas drag follows;
 * `null` means snapping is on and nothing resolved, so the handle stays exactly
 * where it is. A radius handle obeys the same gate as a dragged circle control:
 * falling back to the raw pointer here would move the ellipse through the very
 * positions snapping exists to keep it off (issue #1112 review).
 */
export function moveCannedRadiusDrag(
  state: CannedRadiusDragState,
  constrainedPoint: Point | null,
  dragOrigin: Point | null,
  applyLock: (point: Point, reference: Point) => Point,
): CannedRadiusDragState {
  if (!constrainedPoint) return state
  return updateCannedRadiusDrag(state, applyLock(constrainedPoint, dragOrigin ?? constrainedPoint))
}

/**
 * Publish the drag as the panel's field text, which is the one edit path a typed
 * value also takes: the panel re-renders and Save commits the whole session as
 * one undo step. The write is *held*, so the canvas draws the dragged radius
 * (the outline and the handles are placed by the draft) while the project keeps
 * that field's stored radius until Save (issue #1112 rt7-g review) — the drag is
 * an edit of the panel, not of the project, and typing another field later in
 * the same session does not persist it (issue #1112 rt7-g correction). Returns
 * whether the field changed, so a gated pointer move does not churn the draft.
 */
export function publishCannedRadiusDrag(state: CannedRadiusDragState): boolean {
  return setCannedEditDraftField(state.featureId, state.axis, String(state.params[state.axis]), {
    holdPreview: true,
  })
}
