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

import type { Dispatch, MouseEvent, MutableRefObject, PointerEvent as ReactPointerEvent, RefObject, SetStateAction } from 'react'
import type {
  OpenProfileEndpoint,
  PendingAddTool,
  PendingConstraint,
  PendingDimensionTool,
  PendingMoveTool,
  PendingOffsetTool,
  PendingShapeActionTool,
  PendingTransformTool,
  SelectionState,
  SketchControlRef,
  SketchEditTool,
  TapeMeasureState,
} from '../../store/types'
import type { Point, Project, SketchFeature } from '../../types/project'
import { parseLengthInput } from '../../utils/units'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import {
  canvasToWorld,
  computeBaseViewTransform,
  computeFitViewStateForBounds,
  computeViewTransform,
} from './viewTransform'
import type { CanvasPoint, SketchViewState, ViewTransform } from './viewTransform'
import { findSketchInsertTarget, projectPointOntoLine } from './draftGeometry'
import {
  findOpenProfileExtensionEndpoint,
  type PendingSketchExtension,
} from './draftHelpers'
import {
  featureFullyInsideRect,
  findHitClampId,
  findHitFeatureId,
  findHitTabId,
} from './hitTest'
import { anchorPointForIndex } from './profilePrimitives'
import { pickDimensionAt } from './dimensionRendering'
import { offsetForCursor } from '../../sketch/dimensions'
import { useStableEvent } from '../../hooks/useStableEvent'
import { useEventListener } from '../../hooks/useEventListener'
import {
  unitDirection,
  type OperationDimEdit,
} from './manualEntry'
import { profileVertices } from '../../types/project'
import type { DimensionEditWorkflow } from './useDimensionEditWorkflow'
import type { UseSnapPreviewReturn } from './useSnapPreview'
import type { UseCanvasContextMenuReturn } from './useCanvasContextMenu'

const MIN_SKETCH_ZOOM = 0.02

const WHEEL_LISTENER_OPTIONS = { passive: false } as const

interface PendingPreviewPoint {
  point: Point
  session: number
}

interface SketchEditPreviewPoint {
  point: Point
  mode: SketchEditTool
}

interface PendingSketchFillet {
  anchorIndex: number
  corner: Point
}

interface OpenEndpointHit {
  featureId: string
  endpoint: OpenProfileEndpoint
  anchor: Point
}

interface SegmentHit {
  segmentIndex: number
  point: Point
}

export interface PointerGesturesCtx {
  // Gesture refs (shell-owned)
  isDraggingNodeRef: MutableRefObject<boolean>
  dragStartWorldRef: MutableRefObject<Point | null>
  touchDragPendingRef: MutableRefObject<{ control: SketchControlRef; world: Point; canvasPoint: CanvasPoint } | null>
  isPanningRef: MutableRefObject<boolean>
  didPanRef: MutableRefObject<boolean>
  lastPanPointRef: MutableRefObject<CanvasPoint | null>
  marqueeStartRef: MutableRefObject<CanvasPoint | null>
  marqueeCurrentRef: MutableRefObject<CanvasPoint | null>
  zoomWindowStartRef: MutableRefObject<CanvasPoint | null>
  zoomWindowCurrentRef: MutableRefObject<CanvasPoint | null>
  suppressClickRef: MutableRefObject<boolean>

  // Other refs
  projectRef: MutableRefObject<Project>
  selectionRef: MutableRefObject<SelectionState>
  viewStateRef: MutableRefObject<SketchViewState>
  canvasRef: RefObject<HTMLCanvasElement | null>
  livePointerWorldRef: MutableRefObject<Point | null>
  pendingAddRef: MutableRefObject<PendingAddTool | null>
  pendingMoveRef: MutableRefObject<PendingMoveTool | null>
  pendingTransformRef: MutableRefObject<PendingTransformTool | null>
  pendingOffsetRef: MutableRefObject<PendingOffsetTool | null>
  pendingShapeActionRef: MutableRefObject<PendingShapeActionTool | null>
  pendingConstraintRef: MutableRefObject<PendingConstraint | null>
  pendingDimensionRef: MutableRefObject<PendingDimensionTool | null>
  dimensionDeleteArmedRef: MutableRefObject<boolean>
  deleteHoverDimIdRef: MutableRefObject<string | null>
  pendingSketchExtensionRef: MutableRefObject<PendingSketchExtension | null>
  pendingSketchFilletRef: MutableRefObject<PendingSketchFillet | null>
  sketchEditPreviewRef: MutableRefObject<SketchEditPreviewPoint | null>
  pendingMovePreviewPointRef: MutableRefObject<PendingPreviewPoint | null>
  originPreviewPointRef: MutableRefObject<PendingPreviewPoint | null>
  tapeMeasureRef: MutableRefObject<TapeMeasureState | null>
  creationTargetRef: MutableRefObject<string | null>
  operationDimEditRef: MutableRefObject<OperationDimEdit | null>
  lockModeRef: MutableRefObject<string>

  // Hook instances
  snap: UseSnapPreviewReturn
  contextMenu: UseCanvasContextMenuReturn
  dimEdit: DimensionEditWorkflow
  isGestureActiveRef: MutableRefObject<boolean>

  // Shell-local helpers (stay in shell, passed via ctx)
  hitEditableControl: (point: CanvasPoint, options?: { includeSegments?: boolean }) => SketchControlRef | null
  editableFeature: () => SketchFeature | null
  findSketchSegmentHit: (profile: SketchFeature['sketch']['profile'], rawPoint: Point, vt: ViewTransform) => SegmentHit | null
  findOpenEndpointHit: (
    rawPoint: Point,
    vt: ViewTransform,
    options?: { featureIds?: Set<string>; exclude?: OpenEndpointHit | null },
  ) => OpenEndpointHit | null
  openEndpointAnchor: (feature: SketchFeature, endpoint: OpenProfileEndpoint) => Point

  // Store actions
  setViewState: Dispatch<SetStateAction<SketchViewState>>
  moveFeatureControl: (featureId: string, control: SketchControlRef, point: Point) => void
  beginHistoryTransaction: () => void
  commitHistoryTransaction: () => void
  setActiveControl: (control: SketchControlRef | null) => void
  completePendingOpenPath: () => void
  enterClampEdit: (id: string) => void
  enterTabEdit: (id: string) => void
  enterSketchEdit: (id: string) => void
  hoverFeature: (id: string | null) => void
  selectFeatures: (ids: string[]) => void
  selectAnnotation: (id: string | null) => void
  updateDimensionAnnotation: (id: string, update: { offset?: number; textOverride?: string | null }) => void
  moveClampControl: (clampId: string, control: SketchControlRef, point: Point) => void
  moveTabControl: (tabId: string, control: SketchControlRef, point: Point) => void
  joinOpenFeatureEndpoints: (
    featureId: string,
    sourceEndpoint: OpenProfileEndpoint,
    targetFeatureId: string,
    targetEndpoint: OpenProfileEndpoint,
  ) => boolean

  // Shell-owned gesture functions (hoisted in shell, passed via ctx to resolve circular dependency with contextMenu)
  stopPan: () => void
  stopNodeDrag: () => void

  // Shell closures
  scheduleDraw: () => void
  applyLock: (point: Point, reference: Point) => Point
  setPendingPreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void
  setPendingMovePreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void
  setPendingTransformPreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void
  setPendingOffsetPreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void
  setPendingOffsetRawPreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void
  setHoveredEditControl: (nextControl: SketchControlRef | null) => void

  // Props
  zoomWindowActive: boolean
  onZoomWindowComplete?: () => void
}

export interface UsePointerGesturesReturn {
  handlePointerDown: (event: ReactPointerEvent<HTMLCanvasElement>) => void
  handlePointerUp: (event?: ReactPointerEvent<HTMLCanvasElement>) => void
  handlePointerLeave: () => void
  handleDoubleClick: (event: MouseEvent<HTMLCanvasElement>) => void
  stopPan: () => void
  stopNodeDrag: () => void
  canvasCoordinates: (event: Pick<MouseEvent<HTMLCanvasElement> | globalThis.WheelEvent, 'clientX' | 'clientY'>) => CanvasPoint
}

function projectPointToSegment(point: Point, start: Point, end: Point): { point: Point; t: number; distance: number } {
  const dx = end.x - start.x
  const dy = end.y - start.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq <= 1e-12) {
    return {
      point: start,
      t: 0,
      distance: Math.hypot(point.x - start.x, point.y - start.y),
    }
  }

  const rawT = ((point.x - start.x) * dx + (point.y - start.y) * dy) / lengthSq
  const t = Math.max(0, Math.min(1, rawT))
  const projectedPoint = {
    x: start.x + dx * t,
    y: start.y + dy * t,
  }

  return {
    point: projectedPoint,
    t,
    distance: Math.hypot(point.x - projectedPoint.x, point.y - projectedPoint.y),
  }
}

function openEndpointForAnchorControl(feature: SketchFeature, control: SketchControlRef): OpenProfileEndpoint | null {
  if (control.kind !== 'anchor' || feature.sketch.profile.closed || feature.sketch.profile.segments.length === 0) {
    return null
  }

  const lastAnchorIndex = profileVertices(feature.sketch.profile).length - 1
  if (control.index === 0) {
    return 'start'
  }
  if (control.index === lastAnchorIndex) {
    return 'end'
  }
  return null
}

export function usePointerGestures(ctx: PointerGesturesCtx): UsePointerGesturesReturn {
  const {
    isDraggingNodeRef,
    dragStartWorldRef,
    touchDragPendingRef,
    isPanningRef,
    didPanRef,
    lastPanPointRef,
    marqueeStartRef,
    marqueeCurrentRef,
    zoomWindowStartRef,
    zoomWindowCurrentRef,
    suppressClickRef,
    projectRef,
    selectionRef,
    viewStateRef,
    canvasRef,
    livePointerWorldRef,
    pendingAddRef,
    pendingMoveRef,
    pendingTransformRef,
    pendingOffsetRef,
    pendingShapeActionRef,
    pendingConstraintRef,
    pendingDimensionRef,
    dimensionDeleteArmedRef,
    deleteHoverDimIdRef,
    pendingMovePreviewPointRef,
    pendingSketchExtensionRef,
    pendingSketchFilletRef,
    sketchEditPreviewRef,
    originPreviewPointRef,
    tapeMeasureRef,
    creationTargetRef,
    operationDimEditRef,
    lockModeRef,
    snap,
    contextMenu,
    dimEdit,
    isGestureActiveRef,
    hitEditableControl,
    editableFeature,
    findSketchSegmentHit,
    findOpenEndpointHit,
    openEndpointAnchor,
    setViewState,
    moveFeatureControl,
    beginHistoryTransaction,
    commitHistoryTransaction,
    setActiveControl,
    completePendingOpenPath,
    enterClampEdit,
    enterTabEdit,
    enterSketchEdit,
    hoverFeature,
    selectFeatures,
    selectAnnotation,
    updateDimensionAnnotation,
    moveClampControl,
    moveTabControl,
    joinOpenFeatureEndpoints,
    stopPan,
    stopNodeDrag,
    scheduleDraw,
    applyLock,
    setPendingPreviewPointRef,
    setPendingMovePreviewPointRef,
    setPendingTransformPreviewPointRef,
    setPendingOffsetPreviewPointRef,
    setPendingOffsetRawPreviewPointRef,
    setHoveredEditControl,
    zoomWindowActive,
    onZoomWindowComplete,
  } = ctx

  function canvasCoordinates(event: Pick<MouseEvent<HTMLCanvasElement> | globalThis.WheelEvent, 'clientX' | 'clientY'>): CanvasPoint {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { cx: event.clientX - rect.left, cy: event.clientY - rect.top }
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (isGestureActiveRef.current) return

    if (event.pointerType === 'touch') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }

    contextMenu.startLongPress(event)

    const project = projectRef.current
    const selection = selectionRef.current
    const pendingOffset = pendingOffsetRef.current
    const pendingShapeAction = pendingShapeActionRef.current
    const viewState = viewStateRef.current
    const point = canvasCoordinates(event)

    if (zoomWindowActive && event.button === 0) {
      zoomWindowStartRef.current = point
      zoomWindowCurrentRef.current = point
      setHoveredEditControl(null)
      hoverFeature(null)
      snap.updateActiveSnap(null)
      scheduleDraw()
      return
    }

    const shiftStartsPan = event.button === 0 && event.shiftKey && !pendingShapeAction
    const isTouch = event.pointerType === 'touch'
    if (event.button === 1 || event.button === 2 || shiftStartsPan) {
      isPanningRef.current = true
      didPanRef.current = false
      lastPanPointRef.current = point
      setHoveredEditControl(null)
      return
    }

    if (pendingOffset) {
      return
    }

    // Measure/dimension placement is handled on click — don't start marquee here.
    if (event.button === 0 && !pendingAddRef.current && (tapeMeasureRef.current || pendingDimensionRef.current || dimensionDeleteArmedRef.current)) {
      return
    }

    if (selection.mode === 'sketch_edit' && selection.sketchEditTool) {
      return
    }

    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
    const world = canvasToWorld(point.cx, point.cy, vt)

    // ── Begin dragging a dimension annotation to reposition it ──
    if (
      event.button === 0 && selection.mode === 'feature'
      && !pendingAddRef.current && !pendingMoveRef.current && !pendingTransformRef.current
      && !pendingOffset && !pendingShapeAction && !pendingConstraintRef.current
      && !tapeMeasureRef.current && !pendingDimensionRef.current
      && project.meta.showDimensions
    ) {
      const hitDim = pickDimensionAt(project, vt, point, 8)
      if (hitDim) {
        const dim = project.annotations.find((d) => d.id === hitDim)
        if (dim && !dim.locked && offsetForCursor(dim, project, world) !== null) {
          selectAnnotation(hitDim)
          // eslint-disable-next-line react-hooks/immutability
          dimEdit.draggingDimensionIdRef.current = hitDim
          beginHistoryTransaction()
          suppressClickRef.current = true
          return
        }
      }
    }

    const control = hitEditableControl(point)
    const hitClampId = findHitClampId(world, project.clamps)
    const hitTabId = findHitTabId(world, project.tabs)
    const hitFeatureId = findHitFeatureId(world, resolvedProjectFeatures(project), vt)
    if (!control && !hitClampId && !hitTabId && !hitFeatureId) {
      if (isTouch) {
        isPanningRef.current = true
        didPanRef.current = false
        lastPanPointRef.current = point
        setHoveredEditControl(null)
        return
      }
      marqueeStartRef.current = point
      marqueeCurrentRef.current = point
      setHoveredEditControl(null)
      scheduleDraw()
      return
    }

    if (!control) {
      return
    }

    let nextControl = control
    if (control.kind === 'segment' && selection.selectedFeatureId) {
      const resolvedSnap = snap.resolveCurrentSketchSnap(world, vt)
      const targetPoint = resolvedSnap.mode ? resolvedSnap.point : world
      const feature = editableFeature()
      const segment = feature?.sketch.profile.segments[control.index]
      if (feature && segment?.type === 'line') {
        const segmentStart = anchorPointForIndex(feature.sketch.profile, control.index)
        const projected = projectPointToSegment(targetPoint, segmentStart, segment.to)
        nextControl = {
          kind: 'segment',
          index: control.index,
          t: projected.t,
        }
      }
    }

    if (isTouch && selection.mode === 'sketch_edit' && !selection.sketchEditTool) {
      touchDragPendingRef.current = { control: nextControl, world, canvasPoint: point }
      return
    }

    if (dimEdit.dimensionEditRef.current) dimEdit.cancelEditDimension()
    beginHistoryTransaction()
    setActiveControl(nextControl)
    isDraggingNodeRef.current = true
    dragStartWorldRef.current = world

    if (nextControl.kind === 'segment' && selection.selectedFeatureId) {
      const resolvedSnap = snap.resolveCurrentSketchSnap(world, vt)
      const targetPoint = resolvedSnap.mode ? resolvedSnap.point : world
      moveFeatureControl(selection.selectedFeatureId, nextControl, targetPoint)
      snap.updateActiveSnap(resolvedSnap.mode ? resolvedSnap : null)
    }
  }

  function handleCanvasPointerMove(point: CanvasPoint) {
    const canvas = canvasRef.current
    if (!canvas) return

    if (isGestureActiveRef.current) {
      if (isPanningRef.current) stopPan()
      touchDragPendingRef.current = null
      contextMenu.cancelLongPress()
      return
    }

    const project = projectRef.current
    const selection = selectionRef.current
    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingOffset = pendingOffsetRef.current
    const viewState = viewStateRef.current
    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
    const world = canvasToWorld(point.cx, point.cy, vt)
    livePointerWorldRef.current = world
    const sketchEditTool = selection.sketchEditTool

    // ── Delete-dimension mode: highlight the dimension under the cursor ──
    if (dimensionDeleteArmedRef.current) {
      const hit = project.meta.showDimensions ? pickDimensionAt(project, vt, point, 8) : null
      if (hit !== deleteHoverDimIdRef.current) {
        deleteHoverDimIdRef.current = hit
        scheduleDraw()
      }
      return
    }

    // ── Dragging a dimension: update its offset to follow the cursor ──
    if (dimEdit.draggingDimensionIdRef.current) {
      const dim = project.annotations.find((d) => d.id === dimEdit.draggingDimensionIdRef.current)
      if (dim) {
        const off = offsetForCursor(dim, project, world)
        if (off !== null) {
          updateDimensionAnnotation(dim.id, { offset: off })
        }
      }
      scheduleDraw()
      return
    }

    if (touchDragPendingRef.current) {
      const pending = touchDragPendingRef.current
      const dx = point.cx - pending.canvasPoint.cx
      const dy = point.cy - pending.canvasPoint.cy
      if (dx * dx + dy * dy > 25) {
        touchDragPendingRef.current = null
        if (dimEdit.dimensionEditRef.current) dimEdit.cancelEditDimension()
        beginHistoryTransaction()
        setActiveControl(pending.control)
        isDraggingNodeRef.current = true
        dragStartWorldRef.current = pending.world
        if (pending.control.kind === 'segment' && selection.selectedFeatureId) {
          moveFeatureControl(selection.selectedFeatureId, pending.control, world)
        }
      }
      return
    }

    if (isPanningRef.current && lastPanPointRef.current) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      setHoveredEditControl(null)
      snap.updateActiveSnap(null)
      const dx = point.cx - lastPanPointRef.current.cx
      const dy = point.cy - lastPanPointRef.current.cy
      if (dx !== 0 || dy !== 0) {
        didPanRef.current = true
      }
      lastPanPointRef.current = point
      setViewState((previous) => ({
        ...previous,
        panX: previous.panX + dx,
        panY: previous.panY + dy,
      }))
      return
    }

    if (marqueeStartRef.current) {
      marqueeCurrentRef.current = point
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      hoverFeature(null)
      snap.updateActiveSnap(null)
      scheduleDraw()
      return
    }

    if (zoomWindowStartRef.current) {
      zoomWindowCurrentRef.current = point
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      hoverFeature(null)
      snap.updateActiveSnap(null)
      scheduleDraw()
      return
    }

    const pendingConstraintLive = pendingConstraintRef.current
    const constraintAnchorPicking = !!pendingConstraintLive && !pendingConstraintLive.anchor
    const constraintRefPicking = !!pendingConstraintLive && !!pendingConstraintLive.anchor && !pendingConstraintLive.reference
    const constraintPicking = constraintAnchorPicking || constraintRefPicking
    const shouldPreviewSnap =
      !zoomWindowActive && (
        !!pendingAdd
        || !!pendingMove
        || !!pendingTransform
        || !!pendingOffset
        || !!tapeMeasureRef.current
        || !!pendingDimensionRef.current
        || (selection.mode === 'sketch_edit' && (sketchEditTool === 'add_point' || sketchEditTool === 'fillet'))
        || isDraggingNodeRef.current
        || constraintPicking
      )
    const resolvedSnap = shouldPreviewSnap
      ? snap.resolveCurrentSketchSnap(world, vt, {
          excludeActiveEditGeometry: isDraggingNodeRef.current || constraintRefPicking,
        })
      : { rawPoint: world, point: world, mode: null as null }
    const snapped = resolvedSnap.point
    const activeEditControl = selection.activeControl
    const constrainedPoint =
      snap.requiresResolvedSnapForPointPick() && !resolvedSnap.mode
        ? activeEditControl?.kind === 'segment'
          ? world
          : null
        : snapped
    snap.updateActiveSnap(shouldPreviewSnap ? resolvedSnap : null)

    if (pendingAdd) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      setHoveredEditControl(null)
      hoverFeature(null)
      if (pendingAdd.shape === 'origin') {
        originPreviewPointRef.current = { point: snapped, session: pendingAdd.session }
        scheduleDraw()
        return
      }
      // Apply axis lock to preview for polygon/spline/composite
      let previewSnapped = snapped
      if (pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline') {
        const lastPoint = pendingAdd.points[pendingAdd.points.length - 1]
        if (lastPoint) previewSnapped = applyLock(snapped, lastPoint)
      } else if (pendingAdd.shape === 'composite') {
        const compositeOrigin = pendingAdd.pendingArcEnd ?? pendingAdd.lastPoint ?? pendingAdd.start
        if (compositeOrigin) previewSnapped = applyLock(snapped, compositeOrigin)
      }
      setPendingPreviewPointRef({ point: previewSnapped, session: pendingAdd.session })
      return
    }

    if (pendingMove) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      setHoveredEditControl(null)
      hoverFeature(null)
      const moveEdit = operationDimEditRef.current
      if ((moveEdit?.kind === 'move' || moveEdit?.kind === 'copy') && pendingMove.fromPoint) {
        const distance = parseLengthInput(moveEdit.distance, project.meta.units)
        const referencePoint = pendingMove.toPoint ?? pendingMovePreviewPointRef.current?.point ?? snapped
        const direction = unitDirection(pendingMove.fromPoint, referencePoint)
        setPendingMovePreviewPointRef({
          point: distance !== null
            ? {
                x: pendingMove.fromPoint.x + direction.x * Math.abs(distance),
                y: pendingMove.fromPoint.y + direction.y * Math.abs(distance),
              }
            : referencePoint,
          session: pendingMove.session,
        })
        return
      }
      const lockedSnapped = pendingMove.fromPoint ? applyLock(snapped, pendingMove.fromPoint) : snapped
      setPendingMovePreviewPointRef({ point: lockedSnapped, session: pendingMove.session })
      return
    }

    if (pendingTransform) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      setHoveredEditControl(null)
      hoverFeature(null)
      const constrainedPoint =
        pendingTransform.mode === 'resize' && pendingTransform.referenceStart && pendingTransform.referenceEnd
          ? projectPointOntoLine(snapped, pendingTransform.referenceStart, pendingTransform.referenceEnd)
          : snapped
      setPendingTransformPreviewPointRef({ point: constrainedPoint, session: pendingTransform.session })
      return
    }

    if (pendingOffset) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      setHoveredEditControl(null)
      hoverFeature(null)
      setPendingOffsetRawPreviewPointRef({ point: world, session: pendingOffset.session })
      setPendingOffsetPreviewPointRef({ point: snapped, session: pendingOffset.session })
      return
    }

    if (isDraggingNodeRef.current && selection.selectedFeatureId && selection.activeControl) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      setHoveredEditControl(null)
      if (!constrainedPoint) {
        scheduleDraw()
        return
      }
      const dragOrigin = dragStartWorldRef.current ?? constrainedPoint
      const lockedPoint = applyLock(constrainedPoint, dragOrigin)
      // When lock is active, move the snap indicator to the locked position
      if (lockModeRef.current !== 'none' && snap.activeSnapRef.current) {
        // eslint-disable-next-line react-hooks/immutability
        snap.activeSnapRef.current = { ...snap.activeSnapRef.current, point: lockedPoint }
      }
      moveFeatureControl(selection.selectedFeatureId, selection.activeControl, lockedPoint)
      return
    }

    if (isDraggingNodeRef.current && selection.selectedNode?.type === 'clamp' && selection.activeControl) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      setHoveredEditControl(null)
      if (!constrainedPoint) {
        scheduleDraw()
        return
      }
      moveClampControl(selection.selectedNode.clampId, selection.activeControl, constrainedPoint)
      return
    }

    if (isDraggingNodeRef.current && selection.selectedNode?.type === 'tab' && selection.activeControl) {
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      setHoveredEditControl(null)
      if (!constrainedPoint) {
        scheduleDraw()
        return
      }
      moveTabControl(selection.selectedNode.tabId, selection.activeControl, constrainedPoint)
      return
    }

    if (selection.mode === 'sketch_edit' && selection.selectedNode?.type === 'feature' && selection.selectedFeatureId) {
      const feature = editableFeature()
      if (feature && sketchEditTool === 'add_point') {
        pendingSketchFilletRef.current = null
        if (pendingSketchExtensionRef.current) {
          const lockedSnapped = applyLock(snapped, pendingSketchExtensionRef.current.anchor)
          sketchEditPreviewRef.current = { point: lockedSnapped, mode: 'add_point' }
        } else {
          const endpoint = findOpenProfileExtensionEndpoint(feature.sketch.profile, world, vt)
          if (endpoint) {
            sketchEditPreviewRef.current = { point: endpoint.anchor, mode: 'add_point' }
          } else {
            const target = findSketchInsertTarget(feature.sketch.profile, snapped, vt)
            sketchEditPreviewRef.current =
              target
                ? { point: target.point, mode: 'add_point' }
                : null
          }
        }
        scheduleDraw()
        setHoveredEditControl(null)
        hoverFeature(null)
        return
      }

      if (feature && sketchEditTool === 'delete_point') {
        pendingSketchExtensionRef.current = null
        pendingSketchFilletRef.current = null
        const control = hitEditableControl(point, { includeSegments: false })
        sketchEditPreviewRef.current =
          control?.kind === 'anchor'
            ? { point: anchorPointForIndex(feature.sketch.profile, control.index), mode: 'delete_point' }
            : null
        scheduleDraw()
        setHoveredEditControl(null)
        hoverFeature(null)
        return
      }

      if (feature && sketchEditTool === 'delete_segment') {
        pendingSketchExtensionRef.current = null
        pendingSketchFilletRef.current = null
        const target = findSketchSegmentHit(feature.sketch.profile, world, vt)
        sketchEditPreviewRef.current = target ? { point: target.point, mode: 'delete_segment' } : null
        scheduleDraw()
        setHoveredEditControl(null)
        hoverFeature(null)
        return
      }

      if (feature && sketchEditTool === 'disconnect') {
        pendingSketchExtensionRef.current = null
        pendingSketchFilletRef.current = null
        const control = hitEditableControl(point, { includeSegments: false })
        sketchEditPreviewRef.current =
          control?.kind === 'anchor'
            ? { point: anchorPointForIndex(feature.sketch.profile, control.index), mode: 'disconnect' }
            : null
        scheduleDraw()
        setHoveredEditControl(null)
        hoverFeature(null)
        return
      }

      if (feature && sketchEditTool === 'fillet') {
        pendingSketchExtensionRef.current = null
        if (pendingSketchFilletRef.current) {
          sketchEditPreviewRef.current = { point: snapped, mode: 'add_point' }
        } else {
          const control = hitEditableControl(point, { includeSegments: false })
          if (control?.kind === 'anchor') {
            const corner = anchorPointForIndex(feature.sketch.profile, control.index)
            sketchEditPreviewRef.current = { point: corner, mode: 'add_point' }
          } else {
            sketchEditPreviewRef.current = null
          }
        }
        scheduleDraw()
        setHoveredEditControl(null)
        hoverFeature(null)
        return
      }
    }

    if (selection.mode === 'sketch_edit' && selection.selectedNode?.type === 'feature' && selection.selectedFeatureId) {
      const feature = editableFeature()
      const hoveredControl = feature ? hitEditableControl(point, { includeSegments: false }) : null
      const steps = feature ? dimEdit.computeEditStepsForControl(feature.sketch.profile, hoveredControl) : []
      setHoveredEditControl(steps.length > 0 ? hoveredControl : null)
      hoverFeature(null)
      return
    }

    sketchEditPreviewRef.current = null
    pendingSketchExtensionRef.current = null
    pendingSketchFilletRef.current = null
    setHoveredEditControl(null)

    const hitTabId = findHitTabId(world, project.tabs)
    if (hitTabId) {
      hoverFeature(null)
      return
    }

    const hitId = findHitFeatureId(world, resolvedProjectFeatures(project), vt)
    hoverFeature(hitId)
  }

  function tryJoinDraggedOpenEndpoint(): boolean {
    const canvas = canvasRef.current
    const rawPoint = livePointerWorldRef.current
    const selection = selectionRef.current
    const feature = editableFeature()
    if (
      !canvas
      || !rawPoint
      || !feature
      || !isDraggingNodeRef.current
      || selection.mode !== 'sketch_edit'
      || selection.selectedNode?.type !== 'feature'
      || !selection.selectedFeatureId
      || !selection.activeControl
    ) {
      return false
    }

    const sourceEndpoint = openEndpointForAnchorControl(feature, selection.activeControl)
    if (!sourceEndpoint) {
      return false
    }

    const vt = computeViewTransform(projectRef.current.stock, canvas.width, canvas.height, viewStateRef.current)
    const targetEndpoint = findOpenEndpointHit(rawPoint, vt, {
      exclude: {
        featureId: selection.selectedFeatureId,
        endpoint: sourceEndpoint,
        anchor: openEndpointAnchor(feature, sourceEndpoint),
      },
    })
    if (!targetEndpoint) {
      return false
    }

    return joinOpenFeatureEndpoints(
      selection.selectedFeatureId,
      sourceEndpoint,
      targetEndpoint.featureId,
      targetEndpoint.endpoint,
    )
  }

  function handlePointerUp(event?: ReactPointerEvent<HTMLCanvasElement>) {
    if (event?.pointerType === 'touch') {
      try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* already released */ }
    }

    contextMenu.cancelLongPress()

    if (touchDragPendingRef.current) {
      const pending = touchDragPendingRef.current
      touchDragPendingRef.current = null
      setHoveredEditControl(pending.control)
      dimEdit.setArmedForDimension(true)
      return
    }

    if (dimEdit.draggingDimensionIdRef.current) {
      // eslint-disable-next-line react-hooks/immutability
      dimEdit.draggingDimensionIdRef.current = null
      commitHistoryTransaction()
      scheduleDraw()
      return
    }

    const canvas = canvasRef.current
    const project = projectRef.current
    const selection = selectionRef.current
    const viewState = viewStateRef.current

    if (canvas && zoomWindowStartRef.current && zoomWindowCurrentRef.current) {
      const dx = zoomWindowCurrentRef.current.cx - zoomWindowStartRef.current.cx
      const dy = zoomWindowCurrentRef.current.cy - zoomWindowStartRef.current.cy
      const movedEnough = Math.hypot(dx, dy) >= 6
      if (movedEnough) {
        const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
        const startWorld = canvasToWorld(zoomWindowStartRef.current.cx, zoomWindowStartRef.current.cy, vt)
        const endWorld = canvasToWorld(zoomWindowCurrentRef.current.cx, zoomWindowCurrentRef.current.cy, vt)
        setViewState(
          computeFitViewStateForBounds(
            project.stock,
            {
              minX: Math.min(startWorld.x, endWorld.x),
              maxX: Math.max(startWorld.x, endWorld.x),
              minY: Math.min(startWorld.y, endWorld.y),
              maxY: Math.max(startWorld.y, endWorld.y),
            },
            canvas.width,
            canvas.height,
          ),
        )
      }
      suppressClickRef.current = true
      zoomWindowStartRef.current = null
      zoomWindowCurrentRef.current = null
      scheduleDraw()
      onZoomWindowComplete?.()
    }

    if (canvas && marqueeStartRef.current && marqueeCurrentRef.current) {
      const dx = marqueeCurrentRef.current.cx - marqueeStartRef.current.cx
      const dy = marqueeCurrentRef.current.cy - marqueeStartRef.current.cy
      const movedEnough = Math.hypot(dx, dy) >= 6
      if (movedEnough) {
        const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
        const startWorld = canvasToWorld(marqueeStartRef.current.cx, marqueeStartRef.current.cy, vt)
        const endWorld = canvasToWorld(marqueeCurrentRef.current.cx, marqueeCurrentRef.current.cy, vt)
        const minX = Math.min(startWorld.x, endWorld.x)
        const minY = Math.min(startWorld.y, endWorld.y)
        const maxX = Math.max(startWorld.x, endWorld.x)
        const maxY = Math.max(startWorld.y, endWorld.y)
        const enclosedIds = resolvedProjectFeatures(project)
          .filter((feature) => feature.visible)
          .filter((feature) => featureFullyInsideRect(feature, minX, minY, maxX, maxY))
          .map((feature) => feature.id)
        const nextIds = [...selection.selectedFeatureIds, ...enclosedIds]
          .filter((id, index, array) => array.indexOf(id) === index)
        if (nextIds.length > 0) {
          selectFeatures(nextIds)
        }
        suppressClickRef.current = true
      }
      marqueeStartRef.current = null
      marqueeCurrentRef.current = null
      scheduleDraw()
    }
    if (tryJoinDraggedOpenEndpoint()) {
      suppressClickRef.current = true
      scheduleDraw()
    }
    stopNodeDrag()
    stopPan()
  }

  function handlePointerLeave() {
    contextMenu.cancelLongPress()
    touchDragPendingRef.current = null

    if (dimEdit.draggingDimensionIdRef.current) {
      // eslint-disable-next-line react-hooks/immutability
      dimEdit.draggingDimensionIdRef.current = null
      commitHistoryTransaction()
    }

    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current

    marqueeStartRef.current = null
    marqueeCurrentRef.current = null
    zoomWindowStartRef.current = null
    zoomWindowCurrentRef.current = null
    stopNodeDrag()
    stopPan()
    livePointerWorldRef.current = null
    // Keep a picked fillet + its preview when the pointer leaves the canvas: the
    // radius is entered via the docked workflow panel, which the cursor must move
    // off the canvas to reach. Clearing here would cancel the fillet mid-workflow
    // (regression the panel "Radius" button exposed). Only clear when no corner is
    // pending — preview cleanup for the other sketch-edit tools. Esc/Cancel still
    // clears a pending fillet.
    if (!pendingSketchFilletRef.current) {
      sketchEditPreviewRef.current = null
    }
    setHoveredEditControl(null)
    setPendingOffsetPreviewPointRef(null)
    setPendingOffsetRawPreviewPointRef(null)
    hoverFeature(null)
    snap.updateActiveSnap(null)
    if (pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline' || pendingAdd?.shape === 'composite') {
      setPendingPreviewPointRef(null)
    } else if (pendingAdd?.shape === 'origin') {
      originPreviewPointRef.current = null
      scheduleDraw()
    } else if ((pendingAdd?.shape === 'rect' || pendingAdd?.shape === 'circle' || pendingAdd?.shape === 'ellipse' || pendingAdd?.shape === 'tab' || pendingAdd?.shape === 'clamp') && pendingAdd.anchor) {
      setPendingPreviewPointRef({ point: pendingAdd.anchor, session: pendingAdd.session })
    } else {
      setPendingPreviewPointRef(null)
    }
    if (pendingMove?.fromPoint) {
      setPendingMovePreviewPointRef({
        point: pendingMove.toPoint ?? pendingMove.fromPoint,
        session: pendingMove.session,
      })
    } else {
      setPendingMovePreviewPointRef(null)
    }
    if (pendingTransform?.referenceStart) {
      setPendingTransformPreviewPointRef({
        point: pendingTransform.referenceEnd ?? pendingTransform.referenceStart,
        session: pendingTransform.session,
      })
    } else {
      setPendingTransformPreviewPointRef(null)
    }
  }

  function handleWheelEvent(event: Pick<globalThis.WheelEvent, 'clientX' | 'clientY' | 'deltaY' | 'preventDefault'>) {
    if (zoomWindowActive) {
      return
    }

    event.preventDefault()

    const canvas = canvasRef.current
    if (!canvas) return

    const point = canvasCoordinates(event)
    const project = projectRef.current
    const currentViewState = viewStateRef.current
    const base = computeBaseViewTransform(project.stock, canvas.width, canvas.height)
    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, currentViewState)
    const worldBefore = canvasToWorld(point.cx, point.cy, vt)
    const zoomFactor = Math.exp(-event.deltaY * 0.0015)
    const nextZoom = Math.max(MIN_SKETCH_ZOOM, currentViewState.zoom * zoomFactor)
    const nextScale = base.scale * nextZoom

    setViewState({
      zoom: nextZoom,
      panX: point.cx - base.offsetX - worldBefore.x * nextScale,
      panY: point.cy - base.offsetY - worldBefore.y * nextScale,
    })
  }

  function handleDoubleClick(event: MouseEvent<HTMLCanvasElement>) {
    if (zoomWindowActive) {
      return
    }

    const project = projectRef.current
    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingOffset = pendingOffsetRef.current
    if (pendingAdd) {
      if ((pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline') && pendingAdd.points.length >= 2) {
        event.preventDefault()
        if (creationTargetRef.current === 'region') {
          return
        }
        completePendingOpenPath()
        setPendingPreviewPointRef(null)
      }
      return
    }

    if (pendingMove || pendingTransform || pendingOffset) {
      return
    }

    const point = canvasCoordinates(event)
    const canvas = canvasRef.current
    if (!canvas) return

    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewStateRef.current)
    const world = canvasToWorld(point.cx, point.cy, vt)
    const hitClampId = findHitClampId(world, project.clamps)
    if (hitClampId) {
      enterClampEdit(hitClampId)
      return
    }
    const hitTabId = findHitTabId(world, project.tabs)
    if (hitTabId) {
      enterTabEdit(hitTabId)
      return
    }
    const hitId = findHitFeatureId(world, resolvedProjectFeatures(project), vt)
    if (hitId) enterSketchEdit(hitId)
  }

  const onCanvasPointerMove = useStableEvent((event: PointerEvent) => {
    contextMenu.handleLongPressMove(event)
    const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
    const sourceEvent = coalesced.length > 0 ? coalesced[coalesced.length - 1] : event
    handleCanvasPointerMove(canvasCoordinates(sourceEvent))
  })
  useEventListener(canvasRef, 'pointermove', onCanvasPointerMove)

  const onCanvasWheel = useStableEvent((event: globalThis.WheelEvent) => {
    handleWheelEvent(event)
  })
  useEventListener(canvasRef, 'wheel', onCanvasWheel, WHEEL_LISTENER_OPTIONS)

  return {
    handlePointerDown,
    handlePointerUp,
    handlePointerLeave,
    handleDoubleClick,
    stopPan,
    stopNodeDrag,
    canvasCoordinates,
  }
}
