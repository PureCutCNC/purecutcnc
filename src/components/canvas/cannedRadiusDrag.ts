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
 * A canned ellipse's radius-handle drag (issue #1112 slice w3e-a).
 *
 * Dragging is a preview: every pointer move recomputes the parameters the
 * ellipse would have (one axis changed, the placement untouched), and the
 * canvas draws those instead of the stored ones. Nothing is written until the
 * release, so the whole gesture is one `updateFeature` — one undo step, and the
 * same normalize/apply path the Edit-ellipse panel uses.
 */

import type { CannedShapeData, Matrix2D, Point } from '../../types/project'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { ELLIPSE_CANNED_KIND } from '../../cannedShapes/generators/kinds'
import {
  normalizeEllipseCannedParams,
  type EllipseCannedParams,
} from '../../cannedShapes/generators/ellipse'
import {
  dragEllipseRadius,
  ellipseRadiusAxisAt,
  type EllipseRadiusAxis,
} from '../../cannedShapes/ellipseHandles'

export interface CannedRadiusDragState {
  featureId: string
  /** The stored kind, written back with the dragged parameters. */
  kind: string
  /** The instance placement the handles are read through, fixed for the drag. */
  transform: Matrix2D
  axis: EllipseRadiusAxis
  /** The stored parameters when the gesture began: an unmoved release is no edit. */
  start: EllipseCannedParams
  /** The parameters the release would store: the live preview. */
  params: EllipseCannedParams
}

/**
 * Start a drag on one handle of a placed ellipse. `null` when the feature is
 * not a canned ellipse, its parameters do not normalize, or the index is not a
 * handle — a drag must never guess which radius it means.
 */
export function beginCannedRadiusDrag(
  feature: Pick<ResolvedSketchFeature, 'id' | 'canned' | 'transform'>,
  axisIndex: number,
): CannedRadiusDragState | null {
  if (feature.canned?.kind !== ELLIPSE_CANNED_KIND) return null
  const axis = ellipseRadiusAxisAt(axisIndex)
  if (!axis) return null
  const params = normalizeEllipseCannedParams(feature.canned.params)
  if (!params) return null
  return {
    featureId: feature.id,
    kind: ELLIPSE_CANNED_KIND,
    transform: feature.transform,
    axis,
    start: params,
    params,
  }
}

/**
 * The drag after the pointer moved. The previous state is returned unchanged
 * when the gesture changed nothing, so the caller can redraw only on a change.
 */
export function updateCannedRadiusDrag(
  state: CannedRadiusDragState,
  worldPoint: Point,
): CannedRadiusDragState {
  const params = dragEllipseRadius(state.params, state.axis, worldPoint, state.transform)
  if (!params || params === state.params) return state
  return { ...state, params }
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
 * Write the dragged parameters exactly once. Called on the release, so the
 * whole gesture is one write and therefore one undo step; the last preview is
 * what gets stored.
 *
 * A press that never moved the handle — or a drag that ended where it began —
 * is not an edit, so nothing is written and `false` is returned. Committing the
 * unchanged parameters anyway would add an undo entry and drop the redo stack
 * for a plain click (issue #1112 review).
 */
export function commitCannedRadiusDrag(
  state: CannedRadiusDragState,
  write: (featureId: string, canned: CannedShapeData) => void,
): boolean {
  if (state.params.rx === state.start.rx && state.params.ry === state.start.ry) return false
  write(state.featureId, { kind: state.kind, params: state.params })
  return true
}

/**
 * The parameters the canvas draws for one feature: the live preview while its
 * own handle is being dragged, the stored parameters otherwise. A drag never
 * leaks onto another ellipse, which can share the same kind.
 */
export function cannedRadiusDrawParams(
  feature: Pick<ResolvedSketchFeature, 'id' | 'canned'>,
  drag: CannedRadiusDragState | null,
): EllipseCannedParams | null {
  if (drag && drag.featureId === feature.id) return drag.params
  if (feature.canned?.kind !== ELLIPSE_CANNED_KIND) return null
  return normalizeEllipseCannedParams(feature.canned.params)
}
