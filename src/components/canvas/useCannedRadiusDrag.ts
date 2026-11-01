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
 * Dragging a canned ellipse's radius handles on the canvas (issue #1112 slices
 * w3e-a, rt7-g).
 *
 * The handles belong to the **Edit ellipse…** session: they are drawn only
 * while that panel is open for the ellipse, and nothing is drawn for a plain
 * selection (Frank, round 7). The drag is the preview in `cannedRadiusDrag.ts`;
 * this hook owns the refs the pointer handlers and the draw loop share, and
 * turns each pointer move into that panel's field text — there is no store
 * write here, so Save/Cancel treat a dragged radius like a typed one.
 */

import { useRef } from 'react'
import type { MutableRefObject, RefObject } from 'react'
import type { Point, Project } from '../../types/project'
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
import { getCannedEditDraft } from './cannedEditDraft'
import {
  beginCannedRadiusDrag,
  cannedEditHandleParams,
  moveCannedRadiusDrag,
  publishCannedRadiusDrag,
  type CannedRadiusDragState,
} from './cannedRadiusDrag'

/** How close to a handle, in canvas pixels, a press must land to grab it. */
const RADIUS_HANDLE_HIT_RADIUS = 9

export interface CannedRadiusDragCtx {
  projectRef: MutableRefObject<Project>
  canvasRef: RefObject<HTMLCanvasElement | null>
  viewStateRef: MutableRefObject<SketchViewState>
  scheduleDraw: () => void
}

export interface UseCannedRadiusDrag {
  /** The live drag, or null when no handle is being dragged. */
  dragRef: MutableRefObject<CannedRadiusDragState | null>
  /** The handle highlighted under the pointer, for the hover readout. */
  hoveredAxisRef: MutableRefObject<EllipseRadiusAxis | null>
  /**
   * The parameters this feature's handles draw at while its Edit panel is open;
   * `null` when it has none on screen (a plain selection draws no handles).
   */
  handleParams: (feature: Pick<ResolvedSketchFeature, 'id' | 'canned'>) => { rx: number; ry: number } | null
  /** The handle a press at this canvas point grabs; null when there is none. */
  hitHandle: (point: CanvasPoint) => number | null
  /** Highlight the handle under the pointer and redraw when that changes. */
  hover: (point: CanvasPoint) => void
  /** Drop the highlight, e.g. when the pointer leaves the canvas. */
  clearHover: () => void
  /** Grab a handle; false when there is nothing to grab. */
  begin: (axisIndex: number) => boolean
  /**
   * Move the dragged handle to the snap-gated pointer point (already gated by
   * snapping and locked onto the drag's axis). `null` — snapping is required and
   * nothing resolved — leaves the handle where it is, like a circle control.
   */
  update: (constrainedPoint: Point | null, dragOrigin: Point | null, applyLock: (point: Point, reference: Point) => Point) => void
  /** Release: the panel already holds the dragged field, so only the drag ends. */
  finish: () => void
}

export function useCannedRadiusDrag(ctx: CannedRadiusDragCtx): UseCannedRadiusDrag {
  const { projectRef, canvasRef, viewStateRef, scheduleDraw } = ctx
  const dragRef = useRef<CannedRadiusDragState | null>(null)
  const hoveredAxisRef = useRef<EllipseRadiusAxis | null>(null)

  /** The row the open editor edits, which is the only feature with these handles. */
  function editedEllipse(): ResolvedSketchFeature | null {
    const draft = getCannedEditDraft()
    if (!draft || draft.kind !== ELLIPSE_CANNED_KIND) return null
    const feature = resolveFeatureInstance(projectRef.current, draft.featureId)
    if (!feature || feature.locked || feature.canned?.kind !== ELLIPSE_CANNED_KIND) return null
    return feature
  }

  function viewTransform(): ViewTransform | null {
    const canvas = canvasRef.current
    if (!canvas) return null
    return computeSketchViewTransform(projectRef.current, canvas.width, canvas.height, viewStateRef.current)
  }

  function handleParams(feature: Pick<ResolvedSketchFeature, 'id' | 'canned'>): { rx: number; ry: number } | null {
    return cannedEditHandleParams(feature, getCannedEditDraft(), dragRef.current)
  }

  function hitHandle(point: CanvasPoint): number | null {
    const feature = editedEllipse()
    const vt = viewTransform()
    if (!feature || !vt) return null
    const params = handleParams(feature)
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
    const feature = editedEllipse()
    if (!feature) return false
    const started = beginCannedRadiusDrag(feature, axisIndex, getCannedEditDraft())
    if (!started) return false
    // The press itself changes nothing — the first move is the first radius, the
    // way a circle's handle behaves, so a grab that never moves is not an edit.
    dragRef.current = started
    hoveredAxisRef.current = started.axis
    scheduleDraw()
    return true
  }

  function update(
    constrainedPoint: Point | null,
    dragOrigin: Point | null,
    applyLock: (point: Point, reference: Point) => Point,
  ): void {
    const drag = dragRef.current
    if (!drag) return
    const next = moveCannedRadiusDrag(drag, constrainedPoint, dragOrigin, applyLock)
    if (next !== drag) {
      dragRef.current = next
      // The panel's field is the edit: its own preview and Save/Cancel path
      // carries the dragged radius into the project (issue #1112 rt7-g).
      publishCannedRadiusDrag(next)
    }
    // Redraw either way: a gated move still refreshes the snap readout.
    scheduleDraw()
  }

  function finish(): void {
    if (dragRef.current === null && hoveredAxisRef.current === null) return
    dragRef.current = null
    hoveredAxisRef.current = null
    scheduleDraw()
  }

  return { dragRef, hoveredAxisRef, handleParams, hitHandle, hover, clearHover, begin, update, finish }
}
