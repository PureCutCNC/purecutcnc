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

import {
  type MutableRefObject,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react'
import type { Point, Project } from '../../types/project'
import { formatLength, parseLengthInput } from '../../utils/units'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'
import { anchorPointForIndex, arcControlPoint } from './profilePrimitives'
import { arcHandleFromRadius } from './manualEntry'
import {
  resolveStockDimensionEdit,
  flipAngleDrivingEdit,
  flipLinearDrivingEdit,
  type AngleDrivingEdit,
  type DrivingDimensionEdit,
  type HeldSide,
  type LinearDrivingEdit,
} from '../../sketch/drivingDimensionResolver'
import { resolvedFeatureMap } from '../../store/helpers/resolveFeatures'

// ── Re-export anchor-to-control-index so the canvas can use it ──

/**
 * Map a dimension anchor to an anchor index within a feature profile,
 * suitable for passing to moveFeatureControl as { kind: 'anchor', index }.
 * Returns null for unsupported anchor kinds.
 */
export function anchorToControlIndex(
  anchor: { kind: string; vertexIndex?: number; segmentIndex?: number },
  profile: { closed: boolean; segments: readonly { type: string }[] },
): number | null {
  if (anchor.kind === 'vertex' && typeof anchor.vertexIndex === 'number') return anchor.vertexIndex
  if (anchor.kind === 'midpoint' && typeof anchor.segmentIndex === 'number') {
    if (profile.closed) {
      return (anchor.segmentIndex + 1) % profile.segments.length
    }
    return anchor.segmentIndex + 1
  }
  return null
}

function oppositeStockHeldSide(heldSide: HeldSide): HeldSide {
  switch (heldSide) {
    case 'left': return 'right'
    case 'right': return 'left'
    case 'top': return 'bottom'
    case 'bottom': return 'top'
  }
}

function formatPlainNumber(value: number): string {
  return value.toFixed(2).replace(/\.?0+$/, '')
}

function parseAngleInput(value: string): number | null {
  const parsed = Number(value.trim().replace(/°$/, ''))
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 180) return null
  return parsed
}

function rotateAround(center: Point, angleRadians: number, radius: number): Point {
  return {
    x: center.x + Math.cos(angleRadians) * radius,
    y: center.y + Math.sin(angleRadians) * radius,
  }
}

// ── Workflow state ──

export interface DrivingEditState {
  edit: DrivingDimensionEdit
  value: string
}

export interface DrivingDimensionWorkflowCtx {
  projectRef: MutableRefObject<Project>
  canvasRef: RefObject<HTMLCanvasElement | null>
  containerRef: RefObject<HTMLDivElement | null>
  moveFeatureControl: (featureId: string, control: { kind: 'anchor' | 'arc_handle'; index: number }, point: Point) => void
  setRectStockDimension: (axis: 'width' | 'height', value: number, heldSide: 'left' | 'right' | 'top' | 'bottom') => void
  beginHistoryTransaction: () => void
  commitHistoryTransaction: () => void
  cancelHistoryTransaction: () => void
  clearTransientCanvasState: () => void
  scheduleDraw: () => void
}

export interface DrivingDimensionWorkflow {
  drivingEdit: DrivingEditState | null
  drivingEditRef: MutableRefObject<DrivingEditState | null>
  drivingEditInputRef: RefObject<HTMLInputElement | null>
  drivingDimensionWorkflowPanel: ReturnType<typeof useCanvasWorkflowPanel>
  beginDrivingEdit: (edit: DrivingDimensionEdit) => void
  commitDrivingEdit: () => void
  cancelDrivingEdit: () => void
  flipDrivingHeldSide: () => void
  handleDrivingValueChange: (value: string) => void
  commitDrivingFromPanel: () => void
  cancelDrivingFromPanel: () => void
  /** Resolve a stock label click into a driving edit, or null. */
  resolveStockLabelClick: (axis: 'width' | 'height', defaultHeldSide: HeldSide) => DrivingDimensionEdit | null
}

export function useDrivingDimensionWorkflow(ctx: DrivingDimensionWorkflowCtx): DrivingDimensionWorkflow {
  const {
    projectRef,
    canvasRef,
    containerRef,
    moveFeatureControl,
    setRectStockDimension,
    beginHistoryTransaction,
    commitHistoryTransaction,
    cancelHistoryTransaction,
    clearTransientCanvasState,
    scheduleDraw,
  } = ctx

  const [drivingEdit, setDrivingEdit] = useState<DrivingEditState | null>(null)
  const drivingEditRef = useRef<DrivingEditState | null>(null)
  const drivingEditInputRef = useRef<HTMLInputElement>(null)

  useLayoutEffect(() => {
    drivingEditRef.current = drivingEdit
  })

  const drivingDimensionWorkflowPanel = useCanvasWorkflowPanel({
    open: !!drivingEdit,
    phaseKey: drivingEdit ? drivingEdit.edit.kind : null,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
    focusCanvasOnOpen: false,
  })

  const drivingFocusKey = drivingEdit
    ? 'annotationId' in drivingEdit.edit ? drivingEdit.edit.annotationId : `${drivingEdit.edit.axis}:${drivingEdit.edit.heldSide}`
    : null

  function focusDrivingInputSoon() {
    window.requestAnimationFrame(() => {
      drivingEditInputRef.current?.focus({ preventScroll: true })
      drivingEditInputRef.current?.select()
    })
  }

  useEffect(() => {
    if (drivingFocusKey === null) return
    const frame = window.requestAnimationFrame(() => {
      drivingEditInputRef.current?.focus({ preventScroll: true })
      drivingEditInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [drivingFocusKey])

  // ── New driven point for a linear edit at a target distance ──

  function computeNewDrivenPoint(edit: LinearDrivingEdit, targetDistance: number): Point {
    const { heldPoint, drivenPoint } = edit
    // Infer the annotation type from held-side labels
    const heldLabel = edit.heldSideLabel

    if (heldLabel === 'Hold left' || heldLabel === 'Hold right') {
      // Horizontal
      const sign = heldLabel === 'Hold left' ? 1 : -1
      return { x: heldPoint.x + sign * targetDistance, y: drivenPoint.y }
    }
    if (heldLabel === 'Hold top' || heldLabel === 'Hold bottom') {
      // Vertical
      const sign = heldLabel === 'Hold top' ? 1 : -1
      return { x: drivenPoint.x, y: heldPoint.y + sign * targetDistance }
    }
    // Aligned — move along the held→driven direction
    const dx = drivenPoint.x - heldPoint.x
    const dy = drivenPoint.y - heldPoint.y
    const cur = Math.hypot(dx, dy)
    if (cur < 1e-9) return drivenPoint
    return {
      x: heldPoint.x + (dx / cur) * targetDistance,
      y: heldPoint.y + (dy / cur) * targetDistance,
    }
  }

  function computeNewAngleDrivenPoint(edit: AngleDrivingEdit, targetDegrees: number): Point | null {
    const heldDx = edit.heldPoint.x - edit.vertexPoint.x
    const heldDy = edit.heldPoint.y - edit.vertexPoint.y
    const drivenDx = edit.drivenPoint.x - edit.vertexPoint.x
    const drivenDy = edit.drivenPoint.y - edit.vertexPoint.y
    const heldAngle = Math.atan2(heldDy, heldDx)
    const signedCurrent = Math.atan2(
      heldDx * drivenDy - heldDy * drivenDx,
      heldDx * drivenDx + heldDy * drivenDy,
    )
    const drivenRadius = Math.hypot(drivenDx, drivenDy)
    if (drivenRadius <= 1e-9) return null
    const sign = signedCurrent < 0 ? -1 : 1
    return rotateAround(
      edit.vertexPoint,
      heldAngle + sign * targetDegrees * Math.PI / 180,
      drivenRadius,
    )
  }

  // ── Live preview: move the driven anchor to match the entered value ──

  function applyLivePreview(edit: DrivingEditState) {
    if (edit.edit.kind === 'linear') {
      const parsed = parseLengthInput(edit.value, projectRef.current.meta.units)
      if (parsed === null || parsed <= 0) return
      const linearEdit = edit.edit
      const resolved = resolvedFeatureMap(projectRef.current).get(linearEdit.featureId)
      const feature = resolved ?? projectRef.current.features.find((f) => f.id === linearEdit.featureId)
      if (!feature) return

      const profile = feature.sketch.profile
      const drivenIndex = anchorToControlIndex(linearEdit.drivenAnchor, profile)
      if (drivenIndex === null) return

      const newPoint = computeNewDrivenPoint(linearEdit, parsed)
      moveFeatureControl(linearEdit.featureId, { kind: 'anchor', index: drivenIndex }, newPoint)
      scheduleDraw()
      return
    }

    if (edit.edit.kind === 'angle') {
      const parsed = parseAngleInput(edit.value)
      if (parsed === null) return
      const angleEdit = edit.edit
      const resolved = resolvedFeatureMap(projectRef.current).get(angleEdit.featureId)
      const feature = resolved ?? projectRef.current.features.find((f) => f.id === angleEdit.featureId)
      if (!feature) return

      const drivenIndex = anchorToControlIndex(angleEdit.drivenAnchor, feature.sketch.profile)
      if (drivenIndex === null) return
      const newPoint = computeNewAngleDrivenPoint(angleEdit, parsed)
      if (!newPoint) return
      moveFeatureControl(angleEdit.featureId, { kind: 'anchor', index: drivenIndex }, newPoint)
      scheduleDraw()
      return
    }

    if (edit.edit.kind !== 'radius' && edit.edit.kind !== 'diameter') return

    const parsed = parseLengthInput(edit.value, projectRef.current.meta.units)
    if (parsed === null || parsed <= 0) return
    const radiusEdit = edit.edit
    const targetRadius = radiusEdit.kind === 'diameter' ? parsed / 2 : parsed
    if (targetRadius <= 0) return

    const feature = projectRef.current.features.find((f) => f.id === radiusEdit.featureId)
    if (!feature) return

    const profile = feature.sketch.profile
    const segment = profile.segments[radiusEdit.segmentIndex]
    if (segment?.type === 'circle') {
      moveFeatureControl(
        radiusEdit.featureId,
        { kind: 'anchor', index: 0 },
        { x: segment.center.x + targetRadius, y: segment.center.y },
      )
    } else if (segment?.type === 'arc') {
      const arcStart = anchorPointForIndex(profile, radiusEdit.segmentIndex)
      const currentHandle = arcControlPoint(arcStart, segment)
      const newHandle = arcHandleFromRadius(arcStart, segment, targetRadius)
      moveFeatureControl(
        radiusEdit.featureId,
        { kind: 'arc_handle', index: radiusEdit.segmentIndex },
        newHandle ?? currentHandle,
      )
    }
    scheduleDraw()
  }

  // ── Public actions ──

  function beginDrivingEdit(edit: DrivingDimensionEdit) {
    beginHistoryTransaction()
    const state: DrivingEditState = {
      edit,
      value: edit.kind === 'angle'
        ? formatPlainNumber(edit.currentValue)
        : formatLength(edit.currentValue, projectRef.current.meta.units),
    }
    setDrivingEdit(state)
    // Apply initial preview for linear edits (moves to no-op since value == current)
  }

  function commitDrivingEdit() {
    const state = drivingEditRef.current
    if (!state) return

    if (state.edit.kind === 'stock_dimension') {
      const parsed = parseLengthInput(state.value, projectRef.current.meta.units)
      if (parsed !== null && parsed > 0) {
        setRectStockDimension(state.edit.axis, parsed, state.edit.heldSide)
      }
      commitHistoryTransaction()
    } else if (state.edit.kind === 'linear' || state.edit.kind === 'radius' || state.edit.kind === 'diameter' || state.edit.kind === 'angle') {
      // Live preview already moved the geometry; commit the transaction.
      commitHistoryTransaction()
    }
    setDrivingEdit(null)
    canvasRef.current?.focus({ preventScroll: true })
  }

  function cancelDrivingEdit() {
    cancelHistoryTransaction()
    setDrivingEdit(null)
    canvasRef.current?.focus({ preventScroll: true })
  }

  function flipDrivingHeldSide() {
    const state = drivingEditRef.current
    if (!state) return

    if (state.edit.kind === 'stock_dimension') {
      const newState: DrivingEditState = {
        ...state,
        edit: {
          ...state.edit,
          heldSide: oppositeStockHeldSide(state.edit.heldSide),
        },
      }
      setDrivingEdit(newState)
      focusDrivingInputSoon()
      return
    }

    if (state.edit.kind === 'angle') {
      const newState: DrivingEditState = {
        edit: flipAngleDrivingEdit(state.edit),
        value: state.value,
      }
      cancelHistoryTransaction()
      beginHistoryTransaction()
      setDrivingEdit(newState)
      focusDrivingInputSoon()
      window.setTimeout(() => {
        if (drivingEditRef.current === newState) {
          applyLivePreview(newState)
        }
      }, 0)
      return
    }

    if (state.edit.kind !== 'linear') return

    // Cancel current preview (restore original geometry)
    cancelHistoryTransaction()

    const flipped = flipLinearDrivingEdit(state.edit)
    const newState: DrivingEditState = {
      edit: flipped,
      value: state.value,
    }

    // Start fresh transaction and apply preview on flipped edit
    beginHistoryTransaction()
    setDrivingEdit(newState)
    focusDrivingInputSoon()
    // applyLivePreview will run on next render when drivingEditRef is synced
    // via the value change handler. Trigger it now.
    setTimeout(() => {
      if (drivingEditRef.current === newState) {
        applyLivePreview(newState)
      }
    }, 0)
  }

  function handleDrivingValueChange(value: string) {
    const prev = drivingEditRef.current
    if (!prev) return
    const next: DrivingEditState = { ...prev, value }
    setDrivingEdit(next)
    applyLivePreview(next)
  }

  function resolveStockLabelClick(axis: 'width' | 'height', defaultHeldSide: HeldSide): DrivingDimensionEdit | null {
    const stock = projectRef.current.stock
    const result = resolveStockDimensionEdit(axis, stock, defaultHeldSide)
    if ('disabled' in result) return null
    return result
  }

  function commitDrivingFromPanel() {
    commitDrivingEdit()
    drivingDimensionWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelDrivingFromPanel() {
    cancelDrivingEdit()
    drivingDimensionWorkflowPanel.focusCanvasAfterAction()
  }

  return {
    drivingEdit,
    drivingEditRef,
    drivingEditInputRef,
    drivingDimensionWorkflowPanel,
    beginDrivingEdit,
    commitDrivingEdit,
    cancelDrivingEdit,
    flipDrivingHeldSide,
    handleDrivingValueChange,
    commitDrivingFromPanel,
    cancelDrivingFromPanel,
    resolveStockLabelClick,
  }
}
