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
 * The canned ellipse's two radius handles (issue #1112 slice w3e-a).
 *
 * An ellipse is edited by dragging the end of each radius the way a circle's
 * radius handle is dragged. The generator draws the ellipse at the definition
 * origin from `rx`/`ry`, and the instance transform places it — so the handles
 * are the local axis ends `(rx, 0)` and `(0, ry)` pushed through that same
 * transform. Following the transform, not just its translation, is what keeps
 * the handles on the placed ellipse through a rotation or a mirror.
 *
 * Dragging one handle changes one radius: the pointer is mapped back into the
 * ellipse's own frame and only the dragged axis is read, so the handle can only
 * travel along its axis and the centre never moves.
 */

import type { Matrix2D, Point } from '../types/project'
import { invertMatrix } from '../store/helpers/instanceTransforms'
import { normalizeEllipseCannedParams, type EllipseCannedParams } from './generators/ellipse'

export type EllipseRadiusAxis = 'rx' | 'ry'

/** Handle order: index 0 is the local X radius, index 1 the local Y radius. */
export const ELLIPSE_RADIUS_AXES: readonly EllipseRadiusAxis[] = ['rx', 'ry']

/**
 * The smallest radius a drag may leave. Positive so an ellipse never collapses
 * to a line or inverts through its own centre; small enough to be a gesture,
 * not a limit the user meets while dragging normally.
 */
export const ELLIPSE_RADIUS_MIN = 0.001

/** One radius handle: which radius it edits and where it sits in the world. */
export interface EllipseRadiusHandle {
  axis: EllipseRadiusAxis
  world: Point
}

/** The axis a handle index selects, or `null` for an index that is not one. */
export function ellipseRadiusAxisAt(index: number): EllipseRadiusAxis | null {
  return ELLIPSE_RADIUS_AXES[index] ?? null
}

/** Local point of one axis end: `(rx, 0)` for X, `(0, ry)` for Y. */
export function ellipseRadiusAxisEnd(params: EllipseCannedParams, axis: EllipseRadiusAxis): Point {
  return axis === 'rx' ? { x: params.rx, y: 0 } : { x: 0, y: params.ry }
}

/**
 * A point of the definition's local frame in the world. The instance transform
 * is a similarity (translate / rotate / mirror / uniform scale), so the same
 * matrix that places the outline places its handles.
 */
export function ellipseLocalToWorld(transform: Matrix2D, point: Point): Point {
  return {
    x: transform.a * point.x + transform.c * point.y + transform.e,
    y: transform.b * point.x + transform.d * point.y + transform.f,
  }
}

/** The placed centre of the ellipse — the transform's origin. */
export function ellipseRadiusCentre(transform: Matrix2D): Point {
  return { x: transform.e, y: transform.f }
}

/** Where one radius handle sits: the placed end of that radius's axis. */
export function ellipseRadiusHandlePoint(
  params: EllipseCannedParams,
  axis: EllipseRadiusAxis,
  transform: Matrix2D,
): Point {
  return ellipseLocalToWorld(transform, ellipseRadiusAxisEnd(params, axis))
}

/** Both handles, X first, in the ellipse's own placed frame. */
export function ellipseRadiusHandles(
  params: EllipseCannedParams,
  transform: Matrix2D,
): EllipseRadiusHandle[] {
  return ELLIPSE_RADIUS_AXES.map((axis) => ({
    axis,
    world: ellipseRadiusHandlePoint(params, axis, transform),
  }))
}

/**
 * The radius one axis gets when its handle is dragged to a world point.
 *
 * The point is taken back into the definition's frame and only the dragged
 * axis is read, which is the axis lock: motion across the axis, a snap point
 * off the axis, or a rotated instance all leave the result on the axis. The
 * magnitude never mirrors the ellipse, and the minimum keeps the radius
 * positive.
 */
export function ellipseRadiusFromWorldPoint(
  axis: EllipseRadiusAxis,
  worldPoint: Point,
  transform: Matrix2D,
): number {
  const inverse = invertMatrix(transform)
  const localX = inverse.a * worldPoint.x + inverse.c * worldPoint.y + inverse.e
  const localY = inverse.b * worldPoint.x + inverse.d * worldPoint.y + inverse.f
  const along = axis === 'rx' ? localX : localY
  return Math.max(ELLIPSE_RADIUS_MIN, Math.abs(along))
}

/**
 * The parameters after dragging one handle to a world point: the dragged radius
 * follows the pointer's own axis, the other radius and the placement stay as
 * they were, and the result goes through the generator's validation exactly as
 * a typed value does. `null` when the pointer maps to no usable radius.
 */
export function dragEllipseRadius(
  params: EllipseCannedParams,
  axis: EllipseRadiusAxis,
  worldPoint: Point,
  transform: Matrix2D,
): EllipseCannedParams | null {
  const radius = ellipseRadiusFromWorldPoint(axis, worldPoint, transform)
  if (!Number.isFinite(radius)) return null
  const candidate: EllipseCannedParams = { ...params, [axis]: radius }
  if (candidate.rx === params.rx && candidate.ry === params.ry) return params
  return normalizeEllipseCannedParams(candidate)
}
