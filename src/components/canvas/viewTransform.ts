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

import { getVisibleSceneBounds2D } from '../../sketch/sceneBounds'
import { getProfileBounds } from '../../types/project'
import type { Point, Project, Stock } from '../../types/project'

// Re-exported for existing callers; the implementation moved to
// sketch/sceneBounds.ts so the design-print engine can share it.
export { getVisibleSceneBounds2D }

const VIEW_PADDING = 42

export interface ViewTransform {
  scale: number
  offsetX: number
  offsetY: number
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
  return {
    cx: vt.offsetX + point.x * vt.scale,
    cy: vt.offsetY + point.y * vt.scale,
  }
}

export function canvasToWorld(cx: number, cy: number, vt: ViewTransform): Point {
  return {
    x: (cx - vt.offsetX) / vt.scale,
    y: (cy - vt.offsetY) / vt.scale,
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

export function computeFitViewState(
  project: Project,
  canvasW: number,
  canvasH: number,
): SketchViewState {
  const bounds = getVisibleSceneBounds2D(project)
  return computeFitViewStateForBounds(project.stock, bounds, canvasW, canvasH)
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
