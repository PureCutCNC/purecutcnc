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
 * Dragging a canned ellipse's radius handles on the canvas (issue #1112 slice
 * w3e-a).
 *
 * The gesture belongs to the selected feature, not to a sketch-edit session: a
 * canned shape has no editable sketch, so its handles appear while it is
 * selected and are read through the instance transform. The drag itself is the
 * preview in `cannedRadiusDrag.ts`; this hook owns the refs the pointer handlers
 * and the draw loop share, and the single write on release.
 */

import { useRef } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import type { CannedShapeData, Point, Project } from '../../types/project'
import type { SelectionState } from '../../store/types'
import { resolveFeatureInstance, type ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { ELLIPSE_CANNED_KIND } from '../../cannedShapes/generators/kinds'
import {
  ellipseRadiusAxisAt,
  ellipseRadiusHandles,
  type EllipseRadiusAxis,
} from '../../cannedShapes/ellipseHandles'
import { computeSketchViewTransform, worldToCanvas } from './viewTransform'
import type { CanvasPoint, SketchViewState, ViewTransform } from './viewTransform'
import { distance2 } from './hitTest'
import {
  beginCannedRadiusDrag,
  cannedRadiusDrawParams,
  commitCannedRadiusDrag,
  updateCannedRadiusDrag,
  type CannedRadiusDragState,
} from './cannedRadiusDrag'

/** How close to a handle, in canvas pixels, a press must land to grab it. */
const RADIUS_HANDLE_HIT_RADIUS = 9

export interface CannedRadiusDragCtx {
  projectRef: MutableRefObject<Project>
  selectionRef: MutableRefObject<SelectionState>
  canvasRef: RefObject<HTMLCanvasElement | null>
  viewStateRef: MutableRefObject<SketchViewState>
  updateFeature: (id: string, patch: { canned?: CannedShapeData | null }) => void
  scheduleDraw: () => void
}

export interface UseCannedRadiusDrag {
  /** The live drag, or null when no handle is being dragged. */
  dragRef: MutableRefObject<CannedRadiusDragState | null>
  /** The handle highlighted under the pointer, for the hover readout. */
  hoveredAxisRef: MutableRefObject<EllipseRadiusAxis | null>
  /** The handle a press at this canvas point grabs; null when there is none. */
  hitHandle: (point: CanvasPoint) => number | null
  /** Highlight the handle under the pointer and redraw when that changes. */
  hover: (point: CanvasPoint) => void
  /** Drop the highlight, e.g. when the pointer leaves the canvas. */
  clearHover: () => void
  /** Grab a handle; false when there is nothing to grab. */
  begin: (axisIndex: number) => boolean
  /** Move the dragged handle to `worldPoint` (already snapped and axis-locked). */
  update: (worldPoint: Point) => void
  /** Release: write the dragged parameters once and clear the preview. */
  finish: () => void
}

export function useCannedRadiusDrag(ctx: CannedRadiusDragCtx): UseCannedRadiusDrag {
  const { projectRef, selectionRef, canvasRef, viewStateRef, updateFeature, scheduleDraw } = ctx
  const dragRef = useRef<CannedRadiusDragState | null>(null)
  const hoveredAxisRef = useRef<EllipseRadiusAxis | null>(null)

  /** The selected canned ellipse, which is the only feature with these handles. */
  function selectedEllipse(): ResolvedSketchFeature | null {
    const selection = selectionRef.current
    if (selection.mode !== 'feature' || !selection.selectedFeatureId) return null
    const feature = resolveFeatureInstance(projectRef.current, selection.selectedFeatureId)
    if (!feature || feature.locked || feature.canned?.kind !== ELLIPSE_CANNED_KIND) return null
    return feature
  }

  function viewTransform(): ViewTransform | null {
    const canvas = canvasRef.current
    if (!canvas) return null
    return computeSketchViewTransform(projectRef.current, canvas.width, canvas.height, viewStateRef.current)
  }

  function hitHandle(point: CanvasPoint): number | null {
    const feature = selectedEllipse()
    const vt = viewTransform()
    if (!feature || !vt) return null
    const params = cannedRadiusDrawParams(feature, dragRef.current)
    if (!params) return null
    const handles = ellipseRadiusHandles(params, feature.transform)
    let best: number | null = null
    let bestDistanceSq = RADIUS_HANDLE_HIT_RADIUS * RADIUS_HANDLE_HIT_RADIUS
    for (let index = 0; index < handles.length; index += 1) {
      const canvasPoint = worldToCanvas(handles[index].world, vt)
      const distanceSq = distance2(point, canvasPoint)
      if (distanceSq <= bestDistanceSq) {
        bestDistanceSq = distanceSq
        best = index
      }
    }
    return best
  }

  function hover(point: CanvasPoint): void {
    const index = hitHandle(point)
    const axis = index === null ? null : ellipseRadiusAxisAt(index)
    if (axis === hoveredAxisRef.current) return
    hoveredAxisRef.current = axis
    scheduleDraw()
  }

  function clearHover(): void {
    if (hoveredAxisRef.current === null) return
    hoveredAxisRef.current = null
    scheduleDraw()
  }

  function begin(axisIndex: number): boolean {
    const feature = selectedEllipse()
    if (!feature) return false
    const started = beginCannedRadiusDrag(feature, axisIndex)
    if (!started) return false
    // The press itself changes nothing — the first move is the first radius, the
    // way a circle's handle behaves, so a grab that never moves is not an edit.
    dragRef.current = started
    hoveredAxisRef.current = started.axis
    scheduleDraw()
    return true
  }

  function update(worldPoint: Point): void {
    const drag = dragRef.current
    if (!drag) return
    const next = updateCannedRadiusDrag(drag, worldPoint)
    if (next === drag) return
    dragRef.current = next
    scheduleDraw()
  }

  function finish(): void {
    const drag = dragRef.current
    if (!drag) return
    dragRef.current = null
    hoveredAxisRef.current = null
    commitCannedRadiusDrag(drag, (featureId, canned) => updateFeature(featureId, { canned }))
    scheduleDraw()
  }

  return { dragRef, hoveredAxisRef, hitHandle, hover, clearHover, begin, update, finish }
}
