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
  type Dispatch,
  type KeyboardEvent,
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from 'react'
import type {
  PendingAddTool,
  PendingDimensionTool,
  PendingMoveTool,
  PendingOffsetTool,
  PendingShapeActionTool,
  PendingSketchEdit,
  PendingTransformTool,
  SelectionState,
  SketchControlRef,
  TapeMeasureState,
} from '../../store/types'
import type { Point, Project, SketchFeature } from '../../types/project'
import type { FeatureClipboardPayload } from '../../platform/featureClipboard'
import { formatLength } from '../../utils/units'
import { buildArcSegmentFromThreePoints } from './draftHelpers'
import { resolveOffsetPreview } from './draftGeometry'
import {
  computeRotateDegreesFromPreview,
  computeScaleFactorFromPreview,
  type OperationDimEdit,
} from './manualEntry'
import type { ResolvedSnap } from './snappingHelpers'
import { computeViewTransform, type SketchViewState } from './viewTransform'
import type { ConstraintWorkflow } from './useConstraintWorkflow'
import type { DimensionEditWorkflow } from './useDimensionEditWorkflow'
import type { FilletWorkflow } from './useFilletWorkflow'
import type { MoveWorkflow } from './useMoveWorkflow'
import type { TransformExactWorkflow } from './useTransformExactWorkflow'

interface PendingPreviewPoint {
  point: Point
  session: number
}

interface SketchEditPreviewPoint {
  point: Point
  mode: string
}

interface PendingSketchFillet {
  anchorIndex: number
  corner: Point
}

export interface CanvasKeyboardCtx {
  projectRef: MutableRefObject<Project>
  selectionRef: MutableRefObject<SelectionState>
  pendingAddRef: MutableRefObject<PendingAddTool | null>
  pendingMoveRef: MutableRefObject<PendingMoveTool | null>
  pendingTransformRef: MutableRefObject<PendingTransformTool | null>
  pendingOffsetRef: MutableRefObject<PendingOffsetTool | null>
  pendingShapeActionRef: MutableRefObject<PendingShapeActionTool | null>
  pendingSketchEditRef: MutableRefObject<PendingSketchEdit | null>
  viewStateRef: MutableRefObject<SketchViewState>
  tapeMeasureRef: MutableRefObject<TapeMeasureState | null>
  pendingDimensionRef: MutableRefObject<PendingDimensionTool | null>
  pendingClipboardPlacementRef: MutableRefObject<FeatureClipboardPayload | null>
  dimensionDeleteArmedRef: MutableRefObject<boolean>
  selectedAnnotationIdRef: MutableRefObject<string | null>
  pendingPreviewPointRef: MutableRefObject<PendingPreviewPoint | null>
  operationDimEditRef: MutableRefObject<OperationDimEdit | null>
  pendingTransformPreviewPointRef: MutableRefObject<PendingPreviewPoint | null>
  pendingOffsetRawPreviewPointRef: MutableRefObject<PendingPreviewPoint | null>
  pendingOffsetPreviewPointRef: MutableRefObject<PendingPreviewPoint | null>
  activeSnapRef: MutableRefObject<ResolvedSnap | null>
  pendingSketchFilletRef: MutableRefObject<PendingSketchFillet | null>
  sketchEditPreviewRef: MutableRefObject<SketchEditPreviewPoint | null>
  originPreviewPointRef: MutableRefObject<PendingPreviewPoint | null>
  hoveredEditControlRef: MutableRefObject<SketchControlRef | null>
  canvasRef: RefObject<HTMLCanvasElement | null>

  dimEdit: DimensionEditWorkflow
  constraint: ConstraintWorkflow
  move: MoveWorkflow
  transformExact: TransformExactWorkflow
  fillet: FilletWorkflow

  clearTapeMeasure: () => void
  cancelPendingDimension: () => void
  setDimensionDeleteArmed: (armed: boolean) => void
  cancelClipboardPlacement: () => void
  deleteDimensionAnnotation: (id: string) => void
  undoPendingPolygonPoint: () => void
  completePendingOpenPath: () => void
  setPendingCompositeMode: (mode: 'line' | 'arc' | 'spline') => void
  undoPendingCompositeStep: () => void
  completePendingOpenComposite: () => void
  cancelPendingAdd: () => void
  cancelPendingMove: () => void
  cancelPendingTransform: () => void
  cancelPendingOffset: () => void
  confirmCutCutters: () => void
  cancelPendingShapeAction: () => void
  cancelPendingSketchEdit: () => void
  completePendingMove: (toPoint: Point, copyCount?: number) => void
  completePendingShapeAction: () => void
  beginHistoryTransaction: () => void
  applySketchEdit: () => void
  cancelSketchEdit: () => void
  beginConstraint: (featureId: string) => void

  setPendingPreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void
  setPendingMovePreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void
  setPendingTransformPreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void
  setPendingOffsetPreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void
  setPendingOffsetRawPreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void
  setCopyCountDraft: Dispatch<SetStateAction<string>>
  setOperationDimEdit: Dispatch<SetStateAction<OperationDimEdit | null>>
  copyCountDraft: string
  creationTarget: string
  stopNodeDrag: () => void
  resetLock: () => void
}

export function useCanvasKeyboard(ctx: CanvasKeyboardCtx): {
  handleKeyDown: (event: KeyboardEvent<HTMLCanvasElement>) => void
} {
  const {
    projectRef,
    selectionRef,
    pendingAddRef,
    pendingMoveRef,
    pendingTransformRef,
    pendingOffsetRef,
    pendingShapeActionRef,
    pendingSketchEditRef,
    viewStateRef,
    tapeMeasureRef,
    pendingDimensionRef,
    pendingClipboardPlacementRef,
    dimensionDeleteArmedRef,
    selectedAnnotationIdRef,
    pendingPreviewPointRef,
    operationDimEditRef,
    pendingTransformPreviewPointRef,
    pendingOffsetRawPreviewPointRef,
    pendingOffsetPreviewPointRef,
    activeSnapRef,
    pendingSketchFilletRef,
    sketchEditPreviewRef,
    originPreviewPointRef,
    hoveredEditControlRef,
    canvasRef,
    dimEdit,
    constraint,
    move,
    transformExact,
    fillet,
    clearTapeMeasure,
    cancelPendingDimension,
    setDimensionDeleteArmed,
    cancelClipboardPlacement,
    deleteDimensionAnnotation,
    undoPendingPolygonPoint,
    completePendingOpenPath,
    setPendingCompositeMode,
    undoPendingCompositeStep,
    completePendingOpenComposite,
    cancelPendingAdd,
    cancelPendingMove,
    cancelPendingTransform,
    cancelPendingOffset,
    confirmCutCutters,
    cancelPendingShapeAction,
    cancelPendingSketchEdit,
    completePendingMove,
    completePendingShapeAction,
    beginHistoryTransaction,
    applySketchEdit,
    cancelSketchEdit,
    beginConstraint,
    setPendingPreviewPointRef,
    setPendingMovePreviewPointRef,
    setPendingTransformPreviewPointRef,
    setPendingOffsetPreviewPointRef,
    setPendingOffsetRawPreviewPointRef,
    setCopyCountDraft,
    setOperationDimEdit,
    copyCountDraft,
    creationTarget,
    stopNodeDrag,
    resetLock,
  } = ctx

  function handleKeyDown(event: KeyboardEvent<HTMLCanvasElement>) {
    const project = projectRef.current
    const selection = selectionRef.current
    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingOffset = pendingOffsetRef.current
    const pendingShapeAction = pendingShapeActionRef.current
    const viewState = viewStateRef.current

    // ── Measure & dimension tools ──
    if (event.key === 'Escape' && tapeMeasureRef.current) {
      event.preventDefault()
      clearTapeMeasure()
      return
    }
    if (event.key === 'Escape' && pendingDimensionRef.current) {
      event.preventDefault()
      cancelPendingDimension()
      return
    }
    if (event.key === 'Escape' && dimensionDeleteArmedRef.current) {
      event.preventDefault()
      setDimensionDeleteArmed(false)
      return
    }
    if (event.key === 'Escape' && pendingClipboardPlacementRef.current) {
      event.preventDefault()
      cancelClipboardPlacement()
      return
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedAnnotationIdRef.current) {
      event.preventDefault()
      deleteDimensionAnnotation(selectedAnnotationIdRef.current)
      return
    }

    if (event.key === 'Tab' && pendingAdd) {
      const currentEdit = dimEdit.dimensionEditRef.current
      const units = projectRef.current.meta.units

      if (
        (pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'ellipse' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp' || pendingAdd.shape === 'roundrect' || pendingAdd.shape === 'chamferrect')
        && pendingAdd.anchor
      ) {
        event.preventDefault()
        const previewPoint = pendingPreviewPointRef.current?.point ?? pendingAdd.anchor

        if (!currentEdit) {
          if (pendingAdd.shape === 'circle') {
            const r = Math.hypot(previewPoint.x - pendingAdd.anchor.x, previewPoint.y - pendingAdd.anchor.y)
            dimEdit.setDimensionEdit({
              shape: 'circle',
              anchor: pendingAdd.anchor,
              signX: 1,
              signY: 1,
              activeField: 'radius',
              width: '',
              height: '',
              radius: formatLength(r, units),
              length: '',
              angle: '',
            })
          } else {
            const w = Math.abs(previewPoint.x - pendingAdd.anchor.x)
            const h = Math.abs(previewPoint.y - pendingAdd.anchor.y)
            const dimShape = (pendingAdd.shape === 'roundrect' || pendingAdd.shape === 'chamferrect') ? 'rect' : pendingAdd.shape
            dimEdit.setDimensionEdit({
              shape: dimShape,
              anchor: pendingAdd.anchor,
              signX: previewPoint.x >= pendingAdd.anchor.x ? 1 : -1,
              signY: previewPoint.y >= pendingAdd.anchor.y ? 1 : -1,
              activeField: 'width',
              width: formatLength(w, units),
              height: formatLength(h, units),
              radius: '',
              length: '',
              angle: '',
            })
          }
        } else if (currentEdit.shape !== 'circle' && currentEdit.activeField === 'width') {
          dimEdit.setDimensionEdit({ ...currentEdit, activeField: 'height' })
        } else {
          dimEdit.setDimensionEdit(null)
          canvasRef.current?.focus({ preventScroll: true })
        }
        return
      }

      if ((pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline') && pendingAdd.points.length >= 1) {
        event.preventDefault()
        const fromPoint = pendingAdd.points[pendingAdd.points.length - 1]
        const previewPoint = pendingPreviewPointRef.current?.point ?? fromPoint

        if (!currentEdit) {
          const dx = previewPoint.x - fromPoint.x
          const dy = previewPoint.y - fromPoint.y
          const len = Math.hypot(dx, dy)
          const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
          dimEdit.setDimensionEdit({
            shape: pendingAdd.shape,
            anchor: fromPoint,
            signX: 1,
            signY: 1,
            activeField: 'length',
            width: '',
            height: '',
            radius: '',
            length: formatLength(len, units),
            angle: angleDeg.toFixed(2).replace(/\.?0+$/, ''),
          })
        } else if (currentEdit.activeField === 'length') {
          dimEdit.setDimensionEdit({ ...currentEdit, activeField: 'angle' })
        } else {
          dimEdit.setDimensionEdit(null)
          canvasRef.current?.focus({ preventScroll: true })
        }
        return
      }

      if (
        pendingAdd.shape === 'composite'
        && pendingAdd.start
        && !pendingAdd.closed
        && pendingAdd.currentMode === 'arc'
        && pendingAdd.pendingArcEnd
      ) {
        // Arc phase 2: typing a radius for the arc
        event.preventDefault()
        const arcStart = pendingAdd.lastPoint ?? pendingAdd.start
        const arcEnd = pendingAdd.pendingArcEnd
        const previewPoint = pendingPreviewPointRef.current?.point ?? arcEnd

        if (!currentEdit) {
          // Estimate radius from current through-point preview
          const arcSeg = buildArcSegmentFromThreePoints(arcStart, arcEnd, previewPoint)
          const r = arcSeg && arcSeg.type === 'arc'
            ? Math.hypot(arcStart.x - arcSeg.center.x, arcStart.y - arcSeg.center.y)
            : Math.hypot(arcEnd.x - arcStart.x, arcEnd.y - arcStart.y) / 2
          // Use current preview point as anchor to determine which side of the chord the arc center lies on
          dimEdit.setDimensionEdit({
            shape: 'circle',
            anchor: previewPoint,
            arcStart,
            arcEnd,
            arcClockwise: arcSeg?.type === 'arc' ? arcSeg.clockwise : false,
            signX: 1,
            signY: 1,
            activeField: 'radius',
            width: '',
            height: '',
            radius: formatLength(r, units),
            length: '',
            angle: '',
          })
        } else {
          dimEdit.setDimensionEdit(null)
          canvasRef.current?.focus({ preventScroll: true })
        }
        return
      }

      if (
        pendingAdd.shape === 'composite'
        && pendingAdd.start
        && !pendingAdd.closed
        && (
          (pendingAdd.currentMode === 'line' && !pendingAdd.pendingArcEnd)
          || (pendingAdd.currentMode === 'arc' && !pendingAdd.pendingArcEnd)
          || pendingAdd.currentMode === 'spline'
        )
      ) {
        event.preventDefault()
        const fromPoint = pendingAdd.lastPoint ?? pendingAdd.start
        const previewPoint = pendingPreviewPointRef.current?.point ?? fromPoint

        if (!currentEdit) {
          const dx = previewPoint.x - fromPoint.x
          const dy = previewPoint.y - fromPoint.y
          const len = Math.hypot(dx, dy)
          const angleDeg = Math.atan2(dy, dx) * (180 / Math.PI)
          dimEdit.setDimensionEdit({
            shape: 'composite',
            anchor: fromPoint,
            signX: 1,
            signY: 1,
            activeField: 'length',
            width: '',
            height: '',
            radius: '',
            length: formatLength(len, units),
            angle: angleDeg.toFixed(2).replace(/\.?0+$/, ''),
          })
        } else if (currentEdit.activeField === 'length') {
          dimEdit.setDimensionEdit({ ...currentEdit, activeField: 'angle' })
        } else {
          dimEdit.setDimensionEdit(null)
          canvasRef.current?.focus({ preventScroll: true })
        }
        return
      }

      if (pendingAdd.shape === 'slot' && pendingAdd.points.length === 1) {
        event.preventDefault()
        const p1 = pendingAdd.points[0]
        if (!currentEdit) {
          const previewPoint = pendingPreviewPointRef.current?.point
          const dx = previewPoint ? previewPoint.x - p1.x : 0
          const dy = previewPoint ? previewPoint.y - p1.y : 0
          const len = Math.hypot(dx, dy)
          const defaultLen = len > 1e-10 ? len : (units === 'mm' ? 20 : 1)
          const angleDeg = len > 1e-10 ? (Math.atan2(dy, dx) * (180 / Math.PI)).toFixed(2).replace(/\.?0+$/, '') : '0'
          dimEdit.setDimensionEdit({ shape: 'slot', anchor: p1, arcStart: p1, signX: 1, signY: 1, activeField: 'length', length: formatLength(defaultLen, units), angle: angleDeg, radius: formatLength(units === 'mm' ? 6 : 0.25, units), width: '', height: '' })
        } else if (currentEdit.activeField === 'length') {
          dimEdit.setDimensionEdit({ ...currentEdit, activeField: 'angle' })
        } else if (currentEdit.activeField === 'angle') {
          dimEdit.setDimensionEdit({ ...currentEdit, activeField: 'radius' })
        } else {
          dimEdit.setDimensionEdit(null)
          canvasRef.current?.focus({ preventScroll: true })
        }
        return
      }

      if (pendingAdd.shape === 'slot' && pendingAdd.points.length >= 2) {
        event.preventDefault()
        if (!currentEdit) {
          const p1 = pendingAdd.points[0]
          const p2 = pendingAdd.points[1]
          const previewPoint = pendingPreviewPointRef.current?.point
          const axisX = p2.x - p1.x
          const axisY = p2.y - p1.y
          const axisLen = Math.hypot(axisX, axisY)
          const currentWidth = previewPoint && axisLen > 1e-10
            ? Math.max(2 * Math.abs((previewPoint.x - p1.x) * axisY - (previewPoint.y - p1.y) * axisX) / axisLen, 0.001)
            : (units === 'mm' ? 6 : 0.25)
          dimEdit.setDimensionEdit({ shape: 'slot', anchor: p1, arcStart: p1, arcEnd: p2, signX: 1, signY: 1, activeField: 'width', width: formatLength(currentWidth, units), height: '', radius: '', length: '', angle: '' })
        } else {
          dimEdit.setDimensionEdit(null)
          canvasRef.current?.focus({ preventScroll: true })
        }
        return
      }

      if (pendingAdd.shape === 'ngon' && pendingAdd.anchor) {
        event.preventDefault()
        if (!currentEdit) {
          const previewPoint = pendingPreviewPointRef.current?.point ?? pendingAdd.anchor
          const r = Math.hypot(previewPoint.x - pendingAdd.anchor.x, previewPoint.y - pendingAdd.anchor.y)
          const angleDeg = (Math.atan2(previewPoint.y - pendingAdd.anchor.y, previewPoint.x - pendingAdd.anchor.x) * (180 / Math.PI)).toFixed(2).replace(/\.?0+$/, '')
          dimEdit.setDimensionEdit({ shape: 'ngon', anchor: pendingAdd.anchor, signX: 1, signY: 1, activeField: 'radius', width: '', height: '', radius: formatLength(r, units), length: '', angle: angleDeg })
        } else {
          dimEdit.setDimensionEdit(null)
          canvasRef.current?.focus({ preventScroll: true })
        }
        return
      }
    }

    if (event.key === 'Tab' && pendingMove && pendingMove.fromPoint && !pendingMove.toPoint) {
      event.preventDefault()
      const currentEdit = operationDimEditRef.current
      if (!currentEdit) {
        move.beginMoveDistanceEntryFromPreview()
      } else if (currentEdit.kind === 'move' || currentEdit.kind === 'copy') {
        setOperationDimEdit(null)
        canvasRef.current?.focus({ preventScroll: true })
      }
      return
    }

    if (event.key === 'Tab' && pendingTransform?.mode === 'resize' && pendingTransform.referenceStart && pendingTransform.referenceEnd) {
      event.preventDefault()
      const currentEdit = operationDimEditRef.current
      if (!currentEdit) {
        let factor = '1'
        const previewPoint = pendingTransformPreviewPointRef.current?.point
        if (previewPoint) {
          factor = computeScaleFactorFromPreview(
            pendingTransform.referenceStart,
            pendingTransform.referenceEnd,
            previewPoint,
          )
        }
        setOperationDimEdit({ kind: 'scale', factor })
      } else {
        setOperationDimEdit(null)
        canvasRef.current?.focus({ preventScroll: true })
      }
      return
    }

    if (event.key === 'Tab' && pendingTransform?.mode === 'rotate' && pendingTransform.referenceStart && pendingTransform.referenceEnd) {
      event.preventDefault()
      const currentEdit = operationDimEditRef.current
      if (!currentEdit) {
        let angle = '0'
        const previewPoint = pendingTransformPreviewPointRef.current?.point
        if (previewPoint) {
          angle = computeRotateDegreesFromPreview(
            pendingTransform.referenceStart,
            pendingTransform.referenceEnd,
            previewPoint,
          )
        }
        setOperationDimEdit({ kind: 'rotate', angle })
      } else if (currentEdit.kind === 'rotate') {
        setOperationDimEdit(null)
        canvasRef.current?.focus({ preventScroll: true })
      }
      return
    }

    if (event.key === 'Tab' && pendingOffset) {
      event.preventDefault()
      const currentEdit = operationDimEditRef.current
      if (!currentEdit) {
        const units = project.meta.units
        let distance = '0'
        const rawOffsetPoint = pendingOffsetRawPreviewPointRef.current?.point
        const snappedOffsetPoint = pendingOffsetPreviewPointRef.current?.point
        if (rawOffsetPoint && snappedOffsetPoint) {
          const canvas = canvasRef.current
          if (canvas) {
            const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
            const sourceFeatures = pendingOffset.entityIds
              .map((id) => project.features.find((f) => f.id === id) ?? null)
              .filter((f): f is SketchFeature => f !== null)
              .filter((f) => f.sketch.profile.closed)
            const previewInput = resolveOffsetPreview(sourceFeatures, rawOffsetPoint, snappedOffsetPoint, activeSnapRef.current?.mode ?? null, vt)
            if (previewInput) {
              distance = formatLength(previewInput.signedDistance, units)
            }
          }
        }
        setOperationDimEdit({ kind: 'offset', distance })
      } else {
        setOperationDimEdit(null)
        canvasRef.current?.focus({ preventScroll: true })
      }
      return
    }

    if (
      event.key === 'Tab'
      && selection.mode === 'sketch_edit'
      && !pendingAdd
      && pendingSketchFilletRef.current
      && sketchEditPreviewRef.current
    ) {
      event.preventDefault()
      const current = fillet.filletDimensionEditRef.current
      if (!current) {
        fillet.enterFilletRadiusEdit()
      } else {
        fillet.setFilletDimensionEdit(null)
        canvasRef.current?.focus({ preventScroll: true })
      }
      return
    }

    if (event.key === 'Tab' && selection.mode === 'sketch_edit' && !pendingAdd) {
      event.preventDefault()
      const currentEdit = dimEdit.dimensionEditRef.current
      const units = projectRef.current.meta.units

      if (currentEdit && dimEdit.dimensionEditControlRef.current) {
        dimEdit.advanceTabInEditMode()
        return
      }

      const featureId = selection.selectedFeatureId
      if (!featureId) return
      const feature = projectRef.current.features.find((f) => f.id === featureId)
      if (!feature) return

      const profile = feature.sketch.profile
      const control = selection.activeControl ?? hoveredEditControlRef.current
      const steps = dimEdit.computeEditStepsForControl(profile, control)

      if (steps.length === 0) return

      dimEdit.editDimStepsRef.current = steps
      dimEdit.editDimStepIndexRef.current = 0
      dimEdit.dimensionEditFeatureIdRef.current = featureId
      beginHistoryTransaction()
      dimEdit.applyEditDimStep(0, steps, featureId, units)
      return
    }

    if (
      event.key === 'Backspace'
      && (pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline')
      && !event.repeat
    ) {
      event.preventDefault()
      undoPendingPolygonPoint()
      return
    }

    if (
      event.key === 'Enter'
      && (pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline')
      && pendingAdd.points.length >= 2
    ) {
      if (creationTarget === 'region') {
        return
      }
      completePendingOpenPath()
      setPendingPreviewPointRef(null)
      return
    }

    if (pendingAdd?.shape === 'composite') {
      if (event.key === 'l' || event.key === 'L') {
        setPendingCompositeMode('line')
        return
      }
      if (event.key === 'a' || event.key === 'A') {
        setPendingCompositeMode('arc')
        return
      }
      if (event.key === 's' || event.key === 'S') {
        setPendingCompositeMode('spline')
        return
      }
      if (event.key === 'Backspace') {
        if (event.repeat) {
          return
        }
        event.preventDefault()
        undoPendingCompositeStep()
        return
      }
      if (event.key === 'Enter' && pendingAdd.segments.length >= 1 && !pendingAdd.pendingArcEnd) {
        if (creationTarget === 'region') {
          return
        }
        completePendingOpenComposite()
        setPendingPreviewPointRef(null)
        return
      }
    }

    if (event.key === 'Escape' && pendingAdd) {
      originPreviewPointRef.current = null
      cancelPendingAdd()
      setPendingPreviewPointRef(null)
      dimEdit.setDimensionEdit(null)
      return
    }

    if (event.key === 'Escape' && pendingMove) {
      cancelPendingMove()
      setPendingMovePreviewPointRef(null)
      setCopyCountDraft('1')
      setOperationDimEdit(null)
      return
    }

    if (event.key === 'Escape' && pendingTransform) {
      cancelPendingTransform()
      setPendingTransformPreviewPointRef(null)
      transformExact.setPendingRotateCopyPoint(null)
      transformExact.setRotateCopyCountDraft('1')
      setOperationDimEdit(null)
      return
    }

    if (event.key === 'Escape' && pendingOffset) {
      cancelPendingOffset()
      setPendingOffsetPreviewPointRef(null)
      setPendingOffsetRawPreviewPointRef(null)
      setOperationDimEdit(null)
      return
    }

    if (event.key === 'Tab' && pendingShapeAction?.kind === 'cut' && pendingShapeAction.phase === 'cutters' && pendingShapeAction.cutterIds.length > 0) {
      event.preventDefault()
      confirmCutCutters()
      return
    }

    if (event.key === 'Escape' && pendingSketchEditRef.current) {
      cancelPendingSketchEdit()
      return
    }

    if (event.key === 'Escape' && pendingShapeAction) {
      cancelPendingShapeAction()
      return
    }

    if (
      event.key === 'Enter'
      && pendingMove?.mode === 'copy'
      && pendingMove.fromPoint
      && pendingMove.toPoint
    ) {
      const nextCount = Math.max(1, Math.floor(Number(copyCountDraft) || 1))
      completePendingMove(pendingMove.toPoint, nextCount)
      setPendingMovePreviewPointRef(null)
      setCopyCountDraft('1')
      return
    }

    if (event.key === 'Enter' && pendingShapeAction) {
      completePendingShapeAction()
      return
    }

    if (event.key === 'Enter' && selection.mode === 'sketch_edit' && fillet.filletDimensionEditRef.current && pendingSketchFilletRef.current) {
      fillet.commitFilletDimension()
      return
    }

    if (event.key === 'Escape' && selection.mode === 'sketch_edit' && fillet.filletDimensionEditRef.current && pendingSketchFilletRef.current) {
      fillet.cancelFilletDimension()
      return
    }

    if (event.key === 'Enter' && selection.mode === 'sketch_edit' && dimEdit.dimensionEditRef.current && dimEdit.dimensionEditControlRef.current) {
      dimEdit.commitEditDimension()
      return
    }

    if (event.key === 'Escape' && selection.mode === 'sketch_edit' && dimEdit.dimensionEditRef.current && dimEdit.dimensionEditControlRef.current) {
      dimEdit.cancelEditDimension()
      return
    }

    if (constraint.handleConstraintKeyDown(event)) return

    if (
      event.key === 'c'
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
      && selection.mode === 'sketch_edit'
      && selection.selectedNode?.type === 'feature'
      && selection.selectedFeatureId
      && !selection.sketchEditTool
      && !dimEdit.dimensionEditRef.current
      && !fillet.filletDimensionEditRef.current
    ) {
      event.preventDefault()
      beginConstraint(selection.selectedFeatureId)
      return
    }

    if (event.key === 'Enter' && selection.mode === 'sketch_edit') {
      stopNodeDrag()
      resetLock()
      applySketchEdit()
      return
    }

    if (event.key === 'Escape' && selection.mode === 'sketch_edit') {
      stopNodeDrag()
      resetLock()
      cancelSketchEdit()
    }
  }

  return { handleKeyDown }
}
