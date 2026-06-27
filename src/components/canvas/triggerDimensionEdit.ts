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

import type { Project, SketchFeature } from '../../types/project'
import type { PendingAddTool, PendingMoveTool, PendingOffsetTool, PendingTransformTool } from '../../store/types'
import type { SnapMode } from '../../sketch/snapping'
import type { SketchViewState } from './viewTransform'
import type { PendingPreviewPoint } from './SketchCanvas.types'
import type { DimensionEditWorkflow } from './useDimensionEditWorkflow'
import type { MoveWorkflow } from './useMoveWorkflow'
import type { FilletWorkflow } from './useFilletWorkflow'
import { formatLength } from '../../utils/units'
import { computeViewTransform } from './viewTransform'
import { resolveOffsetPreview } from './draftGeometry'
import { computeScaleFactorFromPreview, computeRotateDegreesFromPreview, type OperationDimEdit } from './manualEntry'
import { filletRadiusFromPoint, chamferDistanceFromPoint } from '../../store/helpers/referenceTransforms'

export interface TriggerDimensionEditDeps {
  project: Project
  pendingAdd: PendingAddTool | null
  pendingMove: PendingMoveTool | null
  pendingTransform: PendingTransformTool | null
  pendingOffset: PendingOffsetTool | null
  selectionMode: string
  selectedFeatureId: string | null
  sketchEditTool: string | null
  pendingPreviewPoint: PendingPreviewPoint | null
  pendingMovePreviewPoint: PendingPreviewPoint | null
  pendingTransformPreviewPoint: PendingPreviewPoint | null
  pendingOffsetRawPreviewPoint: PendingPreviewPoint | null
  pendingOffsetPreviewPoint: PendingPreviewPoint | null
  sketchEditPreviewPoint: { point: { x: number; y: number } } | null
  pendingSketchFillet: { anchorIndex: number; corner: { x: number; y: number } } | null
  units: 'mm' | 'inch'
  canvasWidth: number
  canvasHeight: number
  viewState: SketchViewState
  activeSnapMode: SnapMode | null
  dimEdit: Pick<DimensionEditWorkflow, 'setDimensionEdit' | 'advanceTabInEditMode' | 'dimensionEditRef' | 'dimensionEditControlRef'>
  move: Pick<MoveWorkflow, 'beginMoveDistanceEntry'>
  setOperationDimEdit: (dim: OperationDimEdit | null) => void
  fillet: Pick<FilletWorkflow, 'setFilletDimensionEdit' | 'filletDimensionEditRef'>
}

export function triggerDimensionEdit(deps: TriggerDimensionEditDeps): void {
  const {
    project,
    pendingAdd,
    pendingMove,
    pendingTransform,
    pendingOffset,
    selectionMode,
    selectedFeatureId,
    sketchEditTool,
    pendingPreviewPoint,
    pendingMovePreviewPoint,
    pendingTransformPreviewPoint,
    pendingOffsetRawPreviewPoint,
    pendingOffsetPreviewPoint,
    sketchEditPreviewPoint,
    pendingSketchFillet,
    units,
    canvasWidth,
    canvasHeight,
    viewState,
    dimEdit,
    move,
    setOperationDimEdit,
    fillet,
  } = deps

  if (pendingAdd) {
    if (
      (pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'ellipse' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp' || pendingAdd.shape === 'roundrect' || pendingAdd.shape === 'chamferrect')
      && pendingAdd.anchor
    ) {
      const previewPoint = pendingPreviewPoint?.point ?? pendingAdd.anchor
      if (pendingAdd.shape === 'circle') {
        const r = Math.hypot(previewPoint.x - pendingAdd.anchor.x, previewPoint.y - pendingAdd.anchor.y)
        dimEdit.setDimensionEdit({ shape: 'circle', anchor: pendingAdd.anchor, signX: 1, signY: 1, activeField: 'radius', width: '', height: '', radius: formatLength(r, units), length: '', angle: '' })
      } else {
        const w = Math.abs(previewPoint.x - pendingAdd.anchor.x)
        const h = Math.abs(previewPoint.y - pendingAdd.anchor.y)
        const dimShape = (pendingAdd.shape === 'roundrect' || pendingAdd.shape === 'chamferrect') ? 'rect' : pendingAdd.shape
        dimEdit.setDimensionEdit({ shape: dimShape, anchor: pendingAdd.anchor, signX: previewPoint.x >= pendingAdd.anchor.x ? 1 : -1, signY: previewPoint.y >= pendingAdd.anchor.y ? 1 : -1, activeField: 'width', width: formatLength(w, units), height: formatLength(h, units), radius: '', length: '', angle: '' })
      }
      return
    }
    if ((pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline') && pendingAdd.points.length >= 1) {
      const fromPoint = pendingAdd.points[pendingAdd.points.length - 1]
      const previewPoint = pendingPreviewPoint?.point ?? fromPoint
      const dx = previewPoint.x - fromPoint.x
      const dy = previewPoint.y - fromPoint.y
      dimEdit.setDimensionEdit({ shape: pendingAdd.shape, anchor: fromPoint, signX: 1, signY: 1, activeField: 'length', width: '', height: '', radius: '', length: formatLength(Math.hypot(dx, dy), units), angle: (Math.atan2(dy, dx) * (180 / Math.PI)).toFixed(2).replace(/\.?0+$/, '') })
      return
    }
    if (pendingAdd.shape === 'composite' && pendingAdd.start && !pendingAdd.closed) {
      if (pendingAdd.currentMode === 'arc' && pendingAdd.pendingArcEnd) {
        const arcStart = pendingAdd.lastPoint ?? pendingAdd.start
        const arcEnd = pendingAdd.pendingArcEnd
        const previewPoint = pendingPreviewPoint?.point
        const halfChord = Math.hypot(arcEnd.x - arcStart.x, arcEnd.y - arcStart.y) / 2
        let r = halfChord
        if (previewPoint) {
          const midX = (arcStart.x + arcEnd.x) / 2
          const midY = (arcStart.y + arcEnd.y) / 2
          const chordDx = arcEnd.x - arcStart.x
          const chordDy = arcEnd.y - arcStart.y
          const chordLen = Math.hypot(chordDx, chordDy)
          if (chordLen > 1e-9) {
            const perpX = -chordDy / chordLen
            const perpY = chordDx / chordLen
            const bulge = (previewPoint.x - midX) * perpX + (previewPoint.y - midY) * perpY
            r = Math.max(halfChord, Math.abs(bulge) > 1e-9
              ? (halfChord * halfChord + bulge * bulge) / (2 * Math.abs(bulge))
              : halfChord)
          }
        }
        const side = previewPoint ? (() => {
          const cross = (arcEnd.x - arcStart.x) * (previewPoint.y - arcStart.y)
            - (arcEnd.y - arcStart.y) * (previewPoint.x - arcStart.x)
          return cross >= 0 ? 1 : -1
        })() : 1
        dimEdit.setDimensionEdit({ shape: 'composite', anchor: arcStart, arcStart, arcEnd, arcClockwise: side < 0, signX: 1, signY: 1, activeField: 'radius', width: '', height: '', radius: formatLength(r, units), length: '', angle: '' })
        return
      }
      const fromPoint = pendingAdd.lastPoint ?? pendingAdd.start
      const previewPoint = pendingPreviewPoint?.point ?? fromPoint
      const dx = previewPoint.x - fromPoint.x
      const dy = previewPoint.y - fromPoint.y
      const len = Math.hypot(dx, dy)
      const angleDeg = (Math.atan2(dy, dx) * (180 / Math.PI)).toFixed(2).replace(/\.?0+$/, '')
      const defaultRadius = pendingAdd.currentMode === 'arc' ? formatLength(len > 1e-9 ? len : 0.5, units) : ''
      dimEdit.setDimensionEdit({ shape: 'composite', anchor: fromPoint, signX: 1, signY: 1, activeField: 'length', width: '', height: '', radius: defaultRadius, length: formatLength(len, units), angle: angleDeg })
      return
    }
    if (pendingAdd.shape === 'slot' && pendingAdd.points.length === 1) {
      const p1 = pendingAdd.points[0]
      const previewPoint = pendingPreviewPoint?.point
      const dx = previewPoint ? previewPoint.x - p1.x : 0
      const dy = previewPoint ? previewPoint.y - p1.y : 0
      const len = Math.hypot(dx, dy)
      const defaultLen = len > 1e-10 ? len : (units === 'mm' ? 20 : 1)
      const angleDeg = len > 1e-10 ? (Math.atan2(dy, dx) * (180 / Math.PI)).toFixed(2).replace(/\.?0+$/, '') : '0'
      dimEdit.setDimensionEdit({ shape: 'slot', anchor: p1, arcStart: p1, signX: 1, signY: 1, activeField: 'length', length: formatLength(defaultLen, units), angle: angleDeg, radius: formatLength(units === 'mm' ? 6 : 0.25, units), width: '', height: '' })
      return
    }
    if (pendingAdd.shape === 'slot' && pendingAdd.points.length >= 2) {
      const p1 = pendingAdd.points[0]
      const p2 = pendingAdd.points[1]
      const previewPoint = pendingPreviewPoint?.point
      const axisX = p2.x - p1.x
      const axisY = p2.y - p1.y
      const axisLen = Math.hypot(axisX, axisY)
      const currentWidth = previewPoint && axisLen > 1e-10
        ? Math.max(2 * Math.abs((previewPoint.x - p1.x) * axisY - (previewPoint.y - p1.y) * axisX) / axisLen, 0.001)
        : (units === 'mm' ? 6 : 0.25)
      dimEdit.setDimensionEdit({ shape: 'slot', anchor: p1, arcStart: p1, arcEnd: p2, signX: 1, signY: 1, activeField: 'width', width: formatLength(currentWidth, units), height: '', radius: '', length: '', angle: '' })
      return
    }
    if (pendingAdd.shape === 'ngon' && pendingAdd.anchor) {
      const previewPoint = pendingPreviewPoint?.point ?? pendingAdd.anchor
      const r = Math.hypot(previewPoint.x - pendingAdd.anchor.x, previewPoint.y - pendingAdd.anchor.y)
      const angleDeg = (Math.atan2(previewPoint.y - pendingAdd.anchor.y, previewPoint.x - pendingAdd.anchor.x) * (180 / Math.PI)).toFixed(2).replace(/\.?0+$/, '')
      dimEdit.setDimensionEdit({ shape: 'ngon', anchor: pendingAdd.anchor, signX: 1, signY: 1, activeField: 'radius', width: '', height: '', radius: formatLength(r, units), length: '', angle: angleDeg })
      return
    }
  }

  if (pendingMove?.fromPoint && !pendingMove.toPoint) {
    const previewPoint = pendingMovePreviewPoint?.point ?? pendingMove.fromPoint
    move.beginMoveDistanceEntry(previewPoint)
    return
  }

  if (pendingTransform?.mode === 'resize' && pendingTransform.referenceStart && pendingTransform.referenceEnd) {
    let factor = '1'
    const previewPoint = pendingTransformPreviewPoint?.point
    if (previewPoint) factor = computeScaleFactorFromPreview(pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)
    setOperationDimEdit({ kind: 'scale', factor })
    return
  }

  if (pendingTransform?.mode === 'rotate' && pendingTransform.referenceStart && pendingTransform.referenceEnd) {
    let angle = '0'
    const previewPoint = pendingTransformPreviewPoint?.point
    if (previewPoint) angle = computeRotateDegreesFromPreview(pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)
    setOperationDimEdit({ kind: 'rotate', angle })
    return
  }

  if (pendingOffset) {
    let distance = '0'
    const rawOffsetPoint = pendingOffsetRawPreviewPoint?.point
    const snappedOffsetPoint = pendingOffsetPreviewPoint?.point
    if (rawOffsetPoint && snappedOffsetPoint) {
      const canvasWidth_ = canvasWidth
      const canvasHeight_ = canvasHeight
      if (canvasWidth_ > 0 && canvasHeight_ > 0) {
        const vt = computeViewTransform(project.stock, canvasWidth_, canvasHeight_, viewState)
        const sourceFeatures = pendingOffset.entityIds
          .map((id) => project.features.find((f) => f.id === id) ?? null)
          .filter((f): f is SketchFeature => f !== null)
          .filter((f) => f.sketch.profile.closed)
        const previewInput = resolveOffsetPreview(sourceFeatures, rawOffsetPoint, snappedOffsetPoint, deps.activeSnapMode ?? null, vt)
        if (previewInput) distance = formatLength(previewInput.signedDistance, units)
      }
    }
    setOperationDimEdit({ kind: 'offset', distance })
    return
  }

  if (selectionMode === 'sketch_edit' && !pendingAdd && pendingSketchFillet && sketchEditPreviewPoint) {
    const featureId = selectedFeatureId
    const feature = featureId ? project.features.find((f) => f.id === featureId) ?? null : null
    if (!feature) return
    const radius = sketchEditTool === 'chamfer'
      ? chamferDistanceFromPoint(feature, pendingSketchFillet.anchorIndex, sketchEditPreviewPoint.point)
      : filletRadiusFromPoint(feature, pendingSketchFillet.anchorIndex, sketchEditPreviewPoint.point)
    fillet.setFilletDimensionEdit({ anchorIndex: pendingSketchFillet.anchorIndex, corner: pendingSketchFillet.corner, radius: radius ? formatLength(radius, units) : '' })
    return
  }

  if (selectionMode === 'sketch_edit' && !pendingAdd && !fillet.filletDimensionEditRef.current) {
    const currentEdit = dimEdit.dimensionEditRef.current
    if (!currentEdit && dimEdit.dimensionEditControlRef.current) {
      dimEdit.advanceTabInEditMode()
    }
  }
}
