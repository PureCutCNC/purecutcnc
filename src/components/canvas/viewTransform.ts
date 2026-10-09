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

import { canonicalToSetupPoint, setupFrame } from '../../engine/setupOrientation'
import { getVisibleSceneBounds2D } from '../../sketch/sceneBounds'
import { activeSetup } from '../../store/helpers/activeFace'
import { getProfileBounds } from '../../types/project'
import type { Point, Project, SetupOrientation, Stock } from '../../types/project'

// Re-exported for existing callers; the implementation moved to
// sketch/sceneBounds.ts so the design-print engine can share it.
export { getVisibleSceneBounds2D }

const VIEW_PADDING = 42

/**
 * World (stock-space) → canvas. `scale` and the offsets place the stock as it
 * sits on the machine — the setup-local frame. For a Bottom setup the stock
 * is turned over, so one axis is mirrored: a world coordinate `w` on that
 * axis is drawn where `mirror − w` would be (issue #945). Both mirrors are
 * absent for Top, and every Top code path is then exactly what it was.
 */
export interface ViewTransform {
  scale: number
  offsetX: number
  offsetY: number
  /** World X is drawn at `mirrorX − x`. */
  mirrorX?: number
  /** World Y is drawn at `mirrorY − y`. */
  mirrorY?: number
}

export interface CanvasPoint {
  cx: number
  cy: number
}

export interface SketchViewState {
  zoom: number
  panX: number
  panY: number
}

export function worldToCanvas(point: Point, vt: ViewTransform): CanvasPoint {
  const x = vt.mirrorX === undefined ? point.x : vt.mirrorX - point.x
  const y = vt.mirrorY === undefined ? point.y : vt.mirrorY - point.y
  return {
    cx: vt.offsetX + x * vt.scale,
    cy: vt.offsetY + y * vt.scale,
  }
}

export function canvasToWorld(cx: number, cy: number, vt: ViewTransform): Point {
  const x = (cx - vt.offsetX) / vt.scale
  const y = (cy - vt.offsetY) / vt.scale
  return {
    x: vt.mirrorX === undefined ? x : vt.mirrorX - x,
    y: vt.mirrorY === undefined ? y : vt.mirrorY - y,
  }
}

/** True when the view shows the stock turned over, so handedness is reversed. */
export function viewIsMirrored(vt: ViewTransform): boolean {
  return (vt.mirrorX === undefined) !== (vt.mirrorY === undefined)
}

/** A world-space direction angle as it reads on the canvas. */
export function worldAngleToCanvas(angle: number, vt: ViewTransform): number {
  const flippedY = vt.mirrorY === undefined ? angle : -angle
  return vt.mirrorX === undefined ? flippedY : Math.PI - flippedY
}

/**
 * `ctx.arc` arguments for an arc given by world-space angles. A mirrored view
 * reverses the sweep, so the direction flag flips with the angles.
 */
export function worldArcToCanvas(
  startAngle: number,
  endAngle: number,
  counterclockwise: boolean,
  vt: ViewTransform,
): [startAngle: number, endAngle: number, counterclockwise: boolean] {
  if (vt.mirrorX === undefined && vt.mirrorY === undefined) return [startAngle, endAngle, counterclockwise]
  const start = worldAngleToCanvas(startAngle, vt)
  // Carry the sweep rather than the end angle, so a full circle stays one.
  const sweep = endAngle - startAngle
  return viewIsMirrored(vt)
    ? [start, start - sweep, !counterclockwise]
    : [start, start + sweep, counterclockwise]
}

/** Flip the drawing context the way the view is mirrored, about its current origin. */
export function applyViewMirror(ctx: CanvasRenderingContext2D, vt: ViewTransform): void {
  if (vt.mirrorX === undefined && vt.mirrorY === undefined) return
  ctx.scale(vt.mirrorX === undefined ? 1 : -1, vt.mirrorY === undefined ? 1 : -1)
}

/**
 * Reflect a context so geometry placed by scale and offset alone — as the
 * toolpath caches place it — lands where a mirrored view draws it: about the
 * canvas line each mirrored world axis maps onto. A no-op for an unmirrored
 * view. The caller saves and restores the context around it.
 */
export function reflectContextForView(ctx: CanvasRenderingContext2D, vt: ViewTransform): void {
  if (vt.mirrorX === undefined && vt.mirrorY === undefined) return
  ctx.translate(
    vt.mirrorX === undefined ? 0 : 2 * vt.offsetX + vt.mirrorX * vt.scale,
    vt.mirrorY === undefined ? 0 : 2 * vt.offsetY + vt.mirrorY * vt.scale,
  )
  applyViewMirror(ctx, vt)
}

/**
 * The view as a per-axis linear map, canvas = world × scale + offset, with a
 * mirrored axis carrying a negative scale. The GPU renderer takes this form,
 * so a mirrored view needs no second set of buffers.
 */
export function viewLinearMap(vt: ViewTransform): { scaleX: number; scaleY: number; offsetX: number; offsetY: number } {
  return {
    scaleX: vt.mirrorX === undefined ? vt.scale : -vt.scale,
    scaleY: vt.mirrorY === undefined ? vt.scale : -vt.scale,
    offsetX: vt.mirrorX === undefined ? vt.offsetX : vt.offsetX + vt.mirrorX * vt.scale,
    offsetY: vt.mirrorY === undefined ? vt.offsetY : vt.offsetY + vt.mirrorY * vt.scale,
  }
}

/**
 * The mirrors a setup's turn puts on the view, read off the #944 transform:
 * where the stock-space origin and unit axes land in the setup-local frame.
 */
export function viewMirrorForOrientation(
  orientation: SetupOrientation,
  stock: Stock,
): Pick<ViewTransform, 'mirrorX' | 'mirrorY'> {
  if (orientation.angleDeg === 0) return {}
  const frame = setupFrame(orientation, stock)
  const origin = canonicalToSetupPoint({ x: 0, y: 0, z: 0 }, frame)
  const unitX = canonicalToSetupPoint({ x: 1, y: 0, z: 0 }, frame)
  const unitY = canonicalToSetupPoint({ x: 0, y: 1, z: 0 }, frame)
  return {
    ...(unitX.x < origin.x ? { mirrorX: origin.x } : {}),
    ...(unitY.y < origin.y ? { mirrorY: origin.y } : {}),
  }
}

export function computeBaseViewTransform(stock: Stock, canvasW: number, canvasH: number): ViewTransform {
  const bounds = getProfileBounds(stock.profile)
  const stockW = Math.max(bounds.maxX - bounds.minX, 1)
  const stockH = Math.max(bounds.maxY - bounds.minY, 1)

  const scale = Math.min(
    (canvasW - VIEW_PADDING * 2) / stockW,
    (canvasH - VIEW_PADDING * 2) / stockH,
  )

  return {
    scale,
    offsetX: (canvasW - stockW * scale) / 2 - bounds.minX * scale,
    offsetY: (canvasH - stockH * scale) / 2 - bounds.minY * scale,
  }
}

export function computeViewTransform(
  stock: Stock,
  canvasW: number,
  canvasH: number,
  viewState: SketchViewState,
): ViewTransform {
  const base = computeBaseViewTransform(stock, canvasW, canvasH)
  return {
    scale: base.scale * viewState.zoom,
    offsetX: base.offsetX + viewState.panX,
    offsetY: base.offsetY + viewState.panY,
  }
}

/**
 * The sketch view of a project: the stock as the active setup turns it. Pan
 * and zoom live in the setup-local frame, so switching face keeps the stock
 * where it is on screen.
 */
export function computeSketchViewTransform(
  project: Project,
  canvasW: number,
  canvasH: number,
  viewState: SketchViewState,
): ViewTransform {
  const vt = computeViewTransform(project.stock, canvasW, canvasH, viewState)
  const mirror = viewMirrorForOrientation(activeSetup(project).orientation, project.stock)
  return mirror.mirrorX === undefined && mirror.mirrorY === undefined ? vt : { ...vt, ...mirror }
}

export function computeFitViewState(
  project: Project,
  canvasW: number,
  canvasH: number,
): SketchViewState {
  const bounds = getVisibleSceneBounds2D(project)
  const { mirrorX, mirrorY } = viewMirrorForOrientation(activeSetup(project).orientation, project.stock)
  // The fit is computed in the setup-local frame the view is drawn in.
  const local = {
    minX: mirrorX === undefined ? bounds.minX : mirrorX - bounds.maxX,
    maxX: mirrorX === undefined ? bounds.maxX : mirrorX - bounds.minX,
    minY: mirrorY === undefined ? bounds.minY : mirrorY - bounds.maxY,
    maxY: mirrorY === undefined ? bounds.maxY : mirrorY - bounds.minY,
  }
  // The origin is placed relative to the face that is up, so in the local
  // frame it sits at its stored position rather than at the mirrored one.
  if (project.origin.visible && (mirrorX !== undefined || mirrorY !== undefined)) {
    local.minX = Math.min(local.minX, project.origin.x)
    local.maxX = Math.max(local.maxX, project.origin.x)
    local.minY = Math.min(local.minY, project.origin.y)
    local.maxY = Math.max(local.maxY, project.origin.y)
  }
  return computeFitViewStateForBounds(project.stock, local, canvasW, canvasH)
}

export function computeFitViewStateForBounds(
  stock: Stock,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  canvasW: number,
  canvasH: number,
): SketchViewState {
  const base = computeBaseViewTransform(stock, canvasW, canvasH)
  const contentW = Math.max(bounds.maxX - bounds.minX, 1)
  const contentH = Math.max(bounds.maxY - bounds.minY, 1)
  const desiredScale = Math.min(
    (canvasW - VIEW_PADDING * 2) / contentW,
    (canvasH - VIEW_PADDING * 2) / contentH,
  )
  const desiredOffsetX = (canvasW - contentW * desiredScale) / 2 - bounds.minX * desiredScale
  const desiredOffsetY = (canvasH - contentH * desiredScale) / 2 - bounds.minY * desiredScale

  return {
    zoom: desiredScale / base.scale,
    panX: desiredOffsetX - base.offsetX,
    panY: desiredOffsetY - base.offsetY,
  }
}
