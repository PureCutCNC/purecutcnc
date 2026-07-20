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

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { ToolpathVisibilityPanel } from '../ToolpathVisibilityPanel'
import type { OpenProfileEndpoint, SketchControlRef } from '../../store/types'
import { useProjectStore } from '../../store/projectStore'
import { previewOffsetFeatures } from '../../store/helpers/derivedFeatures'
import { chamferFeatureFromDistance, chamferFeatureFromPoint, filletFeatureFromPoint, filletFeatureFromRadius, mirrorFeatureFromReference, resizeBackdropFromReference, resizeFeatureFromReference, rotateBackdropFromReference, rotateFeatureFromReference } from '../../store/helpers/referenceTransforms'
import {
  buildPendingDraftProfile,
  buildPendingProfile,
  drawCompositeDraft,
  drawSnapIndicator,
  findOpenProfileExtensionEndpoint,
  type PendingSketchExtension,
} from './draftHelpers'
import {
  drawActiveEditMeasurements,
  drawAngleMeasurement,
  drawArcRadiusMeasurement,
  drawLineLengthMeasurement,
  drawProfileLineMeasurements,
  drawRadiusMeasurement,
} from './measurements'
import {
  computeDimensionEditPreviewPoint,
  computeMoveDistancePreviewPoint,
} from './manualEntry'
import type { OperationDimEdit } from './manualEntry'
import { useDimensionEditWorkflow } from './useDimensionEditWorkflow'
import { ConstraintEditPanel } from './ConstraintEditPanel'
import { DrivingDimensionPanel } from './DrivingDimensionPanel'
import { NgonParameterPanel, RectCornerParameterPanel } from './CreationParameterReferences'
import { GearParameterPanel } from './GearParameterPanel'
import { useDrivingDimensionWorkflow } from './useDrivingDimensionWorkflow'
import { useConstraintWorkflow } from './useConstraintWorkflow'
import { useFilletWorkflow } from './useFilletWorkflow'
import { useMoveWorkflow } from './useMoveWorkflow'
import { useOffsetWorkflow } from './useOffsetWorkflow'
import { useTransformExactWorkflow } from './useTransformExactWorkflow'
import { useCreationWorkflow } from './useCreationWorkflow'
import { useCanvasKeyboard } from './useCanvasKeyboard'
import { useClickPlacement } from './useClickPlacement'
import { usePointerGestures } from './usePointerGestures'
import { useSnapPreview } from './useSnapPreview'
import { useCanvasContextMenu } from './useCanvasContextMenu'
import { drawDimensionAnchorDots, drawDimensions, drawPendingDimensionPreview, drawTapeMeasure } from './dimensionRendering'
import {
  drawFeature,
  drawFeatureInfo,
  drawLineFeatureBatch,
  drawMoveGuide,
  drawPendingPathLoop,
  drawPendingPoint,
  drawPendingSplineLoop,
  drawPendingSlotAxis,
  drawPendingSlotWidth,
  drawPendingNgon,
  drawPendingGear,
  drawPendingRoundRect,
  drawPendingChamferRect,
  drawPreviewProfile,
  drawToolpath,
  translateProfile,
} from './previewPrimitives'
import {
  canvasToWorld,
  computeBaseViewTransform,
  computeFitViewState,
  computeViewTransform,
  worldToCanvas,
} from './viewTransform'
import type { CanvasPoint, SketchViewState, ViewTransform } from './viewTransform'
import { findSketchInsertTarget, isLoopCloseCandidate, nearestPointOnSegmentWithT, projectPointOntoLine, resolveOffsetPreview } from './draftGeometry'
import {
  distance2,
  segmentHitTest,
} from './hitTest'
import { drawStlTopViewImage } from './stlTopViewRenderer'
import { triggerDimensionEdit as triggerDimensionEditFn } from './triggerDimensionEdit'
import { CreationTargetBadge } from './CreationTargetBadge'
import { DepthLegend } from './DepthLegend'
import { resolveProfileSegments } from '../../store/helpers/resolveProfileSegments'
import {
  HANDLE_HIT_RADIUS,
  MIN_SKETCH_ZOOM,
  NODE_HIT_RADIUS,
  OPEN_ENDPOINT_JOIN_HIT_RADIUS,
  POLYGON_CLOSE_RADIUS,
  type OpenEndpointHit,
  type PendingPreviewPoint,
  type PendingSketchFillet,
  type SegmentHit,
  type SketchCanvasHandle,
  type SketchCanvasProps,
  type SketchEditPreviewPoint,
} from './SketchCanvas.types'
import { segmentIntersections, type ResolvedSeg } from '../../store/helpers/segmentIntersection'
import { arcControlPoint, anchorPointForIndex, traceProfilePath } from './profilePrimitives'
import {
  drawBackdropImage,
  drawClampFootprint,
  drawGrid,
  drawOriginMarker,
  drawSketchControls,
  drawSketchEditPreviewPoint,
  drawStockOutline,
  drawTabFootprint,
  getFeaturesWorldBounds,
  type StockLabelRect,
} from './scenePrimitives'
import { generateTextShapes } from '../../text'
import {
  getProfileBounds,
  polygonProfile,
  profileExceedsStock,
  profileHasSelfIntersection,
  profileVertices,
  rectProfile,
} from '../../types/project'
import type { Clamp, Point, SketchFeature, Tab } from '../../types/project'
import { compatibleFeatureIdsForOperation } from '../cam/operationValidity'
import { formatLength, parseLengthInput } from '../../utils/units'
import { useAxisLock, lockModeGuideColor } from '../../sketch/useAxisLock'
import { useCanvasGestures } from '../../sketch/useCanvasGestures'
import { useStableEvent } from '../../hooks/useStableEvent'
import { useRafScheduler } from '../../hooks/useRafScheduler'
import { useShellMode, isTabletMode } from '../layout/useShellMode'
import { CanvasWorkflowPanel } from './CanvasWorkflowPanel'
import { OverlapFeaturePicker } from './OverlapFeaturePicker'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'
import { useOverlapFeaturePicker } from './useOverlapFeaturePicker'
import {
  buildPlacedClipboardFeatures,
  FEATURE_CLIPBOARD_PLACEMENT_EVENT,
  pasteClipboardFeatures,
  type FeatureClipboardPayload,
} from '../../platform/featureClipboard'
import { resolveFeatureInstance, resolveFeatureInstances, resolveFeatureRow, resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { useTheme } from '../../theme/themeContext'
import { useI18n } from '../../i18n/i18nContext'
import type { MessageKey } from '../../i18n/locales/en'

export type { SketchCanvasHandle }

export const SketchCanvas = forwardRef<SketchCanvasHandle, SketchCanvasProps>(function SketchCanvas(
  {
    onFeatureContextMenu,
    onTabContextMenu,
    onClampContextMenu,
    toolpaths = [],
    selectedOperationId = null,
    collidingClampIds = [],
    snapSettings,
    zoomWindowActive = false,
    onZoomWindowComplete,
    onActiveSnapModeChange,
    depthLegendCollapsed = false,
    onToggleDepthLegend,
    toolpathVisibility,
    onToolpathVisibilityChange,
    operationHighlightKind = null,
  },
  ref
) {
  const { palette } = useTheme()
  const { t, tPlural } = useI18n()
  const canvasPalette = palette.canvas
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isDraggingNodeRef = useRef(false)
  const dragStartWorldRef = useRef<Point | null>(null)
  const touchDragPendingRef = useRef<{ control: SketchControlRef; world: Point; canvasPoint: CanvasPoint } | null>(null)
  const isPanningRef = useRef(false)
  const didPanRef = useRef(false)
  const lastPanPointRef = useRef<CanvasPoint | null>(null)
  const marqueeStartRef = useRef<CanvasPoint | null>(null)
  const marqueeCurrentRef = useRef<CanvasPoint | null>(null)
  const zoomWindowStartRef = useRef<CanvasPoint | null>(null)
  const zoomWindowCurrentRef = useRef<CanvasPoint | null>(null)
  const suppressClickRef = useRef(false)
  const originPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const sketchEditPreviewRef = useRef<SketchEditPreviewPoint | null>(null)
  const pendingSketchExtensionRef = useRef<PendingSketchExtension | null>(null)
  const pendingExtendHitRef = useRef<Point | null>(null)
  const pendingTrimSpanRef = useRef<{ from: Point; to: Point } | null>(null)
  const pendingSketchFilletRef = useRef<PendingSketchFillet | null>(null)
  const pendingPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingMovePreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingTransformPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingOffsetPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingOffsetRawPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const clipboardPlacementPreviewPointRef = useRef<Point | null>(null)
  const livePointerWorldRef = useRef<Point | null>(null)

  function stopPan() {
    isPanningRef.current = false
    lastPanPointRef.current = null
  }

  function stopNodeDrag() {
    if (!isDraggingNodeRef.current && selection.activeControl === null) return
    isDraggingNodeRef.current = false
    dragStartWorldRef.current = null
    setActiveControl(null)
    commitHistoryTransaction()
  }

  const drawRef = useRef<() => void>(() => {})
  // Stable, frame-coalescing redraw. Replaces the former ad-hoc `scheduleDraw`
  // closure + `scheduleDrawRef`; safe to list in / omit from effect deps.
  const scheduleDraw = useRafScheduler(() => drawRef.current())
  const [copyCountDraft, setCopyCountDraft] = useState('1')

  const [viewState, setViewState] = useState<SketchViewState>({ zoom: 1, panX: 0, panY: 0 })
  const [backdropImage, setBackdropImage] = useState<HTMLImageElement | null>(null)
  const [stlImageRevision, setStlImageRevision] = useState(0)
  const copyCountInputRef = useRef<HTMLInputElement>(null)
  const hoveredEditControlRef = useRef<SketchControlRef | null>(null)
  const [operationDimEdit, setOperationDimEdit] = useState<OperationDimEdit | null>(null)
  const operationDimEditRef = useRef<OperationDimEdit | null>(null)
  operationDimEditRef.current = operationDimEdit
  // Stores label hit areas for click detection: { featureId, constraintId, cx, cy, halfW, halfH }
  const constraintLabelRectsRef = useRef<Array<{ featureId: string; constraintId: string; cx: number; cy: number; halfW: number; halfH: number }>>([])
  const stockLabelRectsRef = useRef<StockLabelRect[]>([])

  const shellMode = useShellMode()
  const isTablet = isTabletMode(shellMode)
  const [multiSelectMode, setMultiSelectMode] = useState(false)
  const [pendingClipboardPlacement, setPendingClipboardPlacement] = useState<FeatureClipboardPayload | null>(null)

  const {
    project,
    projectKey,
    pendingAdd,
    pendingMove,
    pendingTransform,
    pendingOffset,
    pendingShapeAction,
    pendingConstraint,
    tapeMeasure,
    pendingDimension,
    dimensionDeleteArmed,
    selectedAnnotationId,
    tapeMeasureClick,
    clearTapeMeasure,
    pendingDimensionPick,
    cancelPendingDimension,
    setDimensionDeleteArmed,
    addDimensionAnnotation,
    updateDimensionAnnotation,
    deleteDimensionAnnotation,
    selectAnnotation,
    creationTarget,
    selection,
    selectFeature,
    selectFeatures,
    selectBackdrop,
    selectTab,
    selectClamp,
    hoverFeature,
    enterSketchEdit,
    enterTabEdit,
    enterClampEdit,
    applySketchEdit,
    cancelSketchEdit,
    setActiveControl,
    beginHistoryTransaction,
    commitHistoryTransaction,
    cancelHistoryTransaction,
    moveFeatureControl,
    insertFeaturePoint,
    joinOpenFeatureEndpoints,
    deleteFeaturePoint,
    deleteFeatureSegment,
    disconnectFeaturePoint,
    filletFeaturePoint,
    chamferFeaturePoint,
    trimFeatureSegment,
    extendFeatureEndpoint,
    pendingSketchEdit,
    cancelPendingSketchEdit,
    setPendingSketchSubject,
    moveTabControl,
    moveClampControl,
    setPendingAddAnchor,
    placePendingAddAt,
    placePendingSlotAt,
    placePendingNgonAt,
    setPendingGearRadiusAt,
    completePendingGear,
    placePendingTextAt,
    placeOriginAt,
    addPendingPolygonPoint,
    undoPendingPolygonPoint,
    completePendingPolygon,
    completePendingOpenPath,
    cancelPendingAdd,
    setPendingCompositeMode,
    addPendingCompositePoint,
    undoPendingCompositeStep,
    completePendingComposite,
    completePendingOpenComposite,
    setPendingMoveFrom,
    setPendingMoveTo,
    completePendingMove,
    cancelPendingMove,
    setPendingTransformReferenceStart,
    setPendingTransformReferenceEnd,
    completePendingTransform,
    cancelPendingTransform,
    setPendingTransformKeepOriginals,
    completePendingOffset,
    cancelPendingOffset,
    completePendingShapeAction,
    cancelPendingShapeAction,
    confirmCutCutters,
    setPendingShapeActionKeepOriginals,
    setBackdropImageLoading,
    beginConstraint,
    setConstraintAnchor,
    setConstraintReference,
    commitConstraintDistance,
    cancelPendingConstraint,
    updateConstraintValue,
    setPendingNgonSides,
    setPendingGearParams,
    setPendingRectCorner,
    setRectStockDimension,
  } = useProjectStore()

  const projectRef = useRef(project)
  const selectionRef = useRef(selection)
  const pendingAddRef = useRef(pendingAdd)
  const creationTargetRef = useRef(creationTarget)
  const pendingMoveRef = useRef(pendingMove)
  const pendingTransformRef = useRef(pendingTransform)
  const pendingOffsetRef = useRef(pendingOffset)
  const pendingShapeActionRef = useRef(pendingShapeAction)
  const pendingConstraintRef = useRef(pendingConstraint)
  const viewStateRef = useRef(viewState)
  const backdropImageRef = useRef(backdropImage)
  const stlImageCacheRef = useRef<Map<string, HTMLImageElement>>(new Map())
  const toolpathsRef = useRef(toolpaths)
  const selectedOperationIdRef = useRef(selectedOperationId)
  const collidingClampIdsRef = useRef(collidingClampIds)
  const snapSettingsRef = useRef(snapSettings)
  const copyCountDraftRef = useRef(copyCountDraft)
  const tapeMeasureRef = useRef(tapeMeasure)
  const pendingDimensionRef = useRef(pendingDimension)
  const dimensionDeleteArmedRef = useRef(dimensionDeleteArmed)
  const selectedAnnotationIdRef = useRef(selectedAnnotationId)
  const deleteHoverDimIdRef = useRef<string | null>(null)
  const operationHighlightKindRef = useRef(operationHighlightKind)
  const pendingClipboardPlacementRef = useRef(pendingClipboardPlacement)

  projectRef.current = project
  selectionRef.current = selection
  pendingAddRef.current = pendingAdd
  creationTargetRef.current = creationTarget
  pendingMoveRef.current = pendingMove
  pendingTransformRef.current = pendingTransform
  pendingOffsetRef.current = pendingOffset
  pendingShapeActionRef.current = pendingShapeAction
  pendingConstraintRef.current = pendingConstraint
  const pendingSketchEditRef = useRef(pendingSketchEdit)
  pendingSketchEditRef.current = pendingSketchEdit
  viewStateRef.current = viewState
  backdropImageRef.current = backdropImage
  toolpathsRef.current = toolpaths
  selectedOperationIdRef.current = selectedOperationId
  collidingClampIdsRef.current = collidingClampIds
  snapSettingsRef.current = snapSettings
  copyCountDraftRef.current = copyCountDraft
  tapeMeasureRef.current = tapeMeasure
  pendingDimensionRef.current = pendingDimension
  dimensionDeleteArmedRef.current = dimensionDeleteArmed
  selectedAnnotationIdRef.current = selectedAnnotationId
  operationHighlightKindRef.current = operationHighlightKind
  pendingClipboardPlacementRef.current = pendingClipboardPlacement
  if (!dimensionDeleteArmed) deleteHoverDimIdRef.current = null

  const dimEdit = useDimensionEditWorkflow({
    projectRef,
    canvasRef,
    commitHistoryTransaction,
    cancelHistoryTransaction,
    moveFeatureControl,
  })

  const constraint = useConstraintWorkflow({
    projectRef,
    canvasRef,
    containerRef,
    pendingConstraint,
    pendingConstraintRef,
    clearTransientCanvasState,
    commitConstraintDistance,
    cancelPendingConstraint,
    updateConstraintValue,
  })

  const drivingWf = useDrivingDimensionWorkflow({ projectRef, canvasRef, containerRef, moveFeatureControl, setRectStockDimension, beginHistoryTransaction, commitHistoryTransaction, cancelHistoryTransaction, clearTransientCanvasState, scheduleDraw })

  const fillet = useFilletWorkflow({
    projectRef,
    selectionRef,
    pendingSketchFilletRef,
    sketchEditPreviewRef,
    filletFeaturePoint,
    chamferFeaturePoint,
    scheduleDraw,
  })

  // Axis lock — active whenever a move, node drag, sketch-edit drag, constraint pick, or feature creation is in progress

  const showCutFlowPanel = pendingShapeAction?.kind === 'cut'
  const cutFlowPanelPhase = pendingShapeAction?.kind === 'cut' ? pendingShapeAction.phase : null
  const { lockModeRef, lockMode, applyLock, cycleLock, reset: resetLock } = useAxisLock(scheduleDraw)
  const cutWorkflowPanel = useCanvasWorkflowPanel({
    open: showCutFlowPanel,
    phaseKey: cutFlowPanelPhase,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })
  const showJoinFlowPanel = pendingShapeAction?.kind === 'join'
  const joinWorkflowPanel = useCanvasWorkflowPanel({
    open: !!showJoinFlowPanel,
    phaseKey: 'join',
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })

  const editModeActive = selection.mode === 'sketch_edit' && !pendingAdd
  const editDimEditActive = editModeActive && !!dimEdit.dimensionEdit
  const editFilletActive = editModeActive && fillet.filletDimensionEditActive
  const editWorkflowPanel = useCanvasWorkflowPanel({
    open: editModeActive,
    phaseKey: editFilletActive ? 'fillet' : editDimEditActive ? 'dimensions' : 'editing',
    containerRef,
    canvasRef,
    clearTransientCanvasState,
    focusCanvasOnOpen: !editFilletActive && !editDimEditActive,
  })

  // ── Measure & dimension workflow panels (instruction popups) ──
  const dimensionPickedCount = pendingDimension
    ? [pendingDimension.a, pendingDimension.b, pendingDimension.c].filter(Boolean).length
    : 0
  const tapeWorkflowPanel = useCanvasWorkflowPanel({
    open: !!tapeMeasure,
    phaseKey: tapeMeasure?.first ? 'second' : 'first',
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })
  const dimensionWorkflowPanel = useCanvasWorkflowPanel({
    open: !!pendingDimension,
    phaseKey: pendingDimension ? `${pendingDimension.type}:${dimensionPickedCount}` : null,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })
  const dimensionDeleteWorkflowPanel = useCanvasWorkflowPanel({
    open: dimensionDeleteArmed,
    phaseKey: 'delete',
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })
  const clipboardPlacementWorkflowPanel = useCanvasWorkflowPanel({
    open: pendingClipboardPlacement !== null,
    phaseKey: pendingClipboardPlacement ? `features:${pendingClipboardPlacement.length}` : null,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })
  const dimensionTitleKey: MessageKey | null = pendingDimension
    ? `canvas.dimension.title.${pendingDimension.type}` as MessageKey
    : null
  const dimensionTitle = dimensionTitleKey ? t(dimensionTitleKey) : ''
  const dimensionStep = (() => {
    if (!pendingDimension) return ''
    const dimType = pendingDimension.type
    const n = dimensionPickedCount
    if (dimType === 'radius' || dimType === 'diameter') {
      return n === 0 ? t('canvas.dimension.step.radiusCenter') : t('canvas.dimension.step.radiusEdge')
    }
    if (dimType === 'angle') {
      return n === 0 ? t('canvas.dimension.step.angleVertex')
        : n === 1 ? t('canvas.dimension.step.angleFirstRay')
        : n === 2 ? t('canvas.dimension.step.angleSecondRay')
        : t('canvas.dimension.step.clickToPlace')
    }
    return n === 0 ? t('canvas.dimension.step.firstPoint') : n === 1 ? t('canvas.dimension.step.secondPoint') : t('canvas.dimension.step.setOffset')
  })()

  const snap = useSnapPreview({
    snapSettingsRef,
    projectRef,
    selectionRef,
    pendingMoveRef,
    pendingTransformRef,
    pendingAddRef,
    pendingConstraintRef,
    scheduleDraw,
    onActiveSnapModeChange: onActiveSnapModeChange ?? (() => {}),
  })

  const contextMenu = useCanvasContextMenu({
    canvasRef,
    projectRef,
    selectionRef,
    viewStateRef,
    pendingAddRef,
    pendingMoveRef,
    pendingTransformRef,
    pendingOffsetRef,
    didPanRef,
    suppressClickRef,
    zoomWindowActive,
    stopPan,
    selectClamp,
    selectTab,
    selectFeature,
    onFeatureContextMenu,
    onTabContextMenu,
    onClampContextMenu,
  })

  const setPendingPreviewPointRef = useStableEvent((nextPoint: PendingPreviewPoint | null) => {
    pendingPreviewPointRef.current = nextPoint
    scheduleDraw()
  })

  const creation = useCreationWorkflow({
    projectRef,
    pendingAdd,
    pendingAddRef,
    dimensionEdit: dimEdit.dimensionEdit,
    dimensionEditRef: dimEdit.dimensionEditRef,
    setDimensionEdit: dimEdit.setDimensionEdit,
    triggerDimensionEdit,
    setPendingPreviewPointRef,
    placePendingAddAt,
    placePendingSlotAt,
    placePendingNgonAt,
    setPendingGearRadiusAt,
    completePendingGear,
    cancelPendingAdd,
    addPendingPolygonPoint,
    addPendingCompositePoint,
    undoPendingPolygonPoint,
    undoPendingCompositeStep,
    completePendingOpenPath,
    completePendingOpenComposite,
    setPendingCompositeMode,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })
  const setPendingMovePreviewPointRef = useStableEvent((nextPoint: PendingPreviewPoint | null) => {
    pendingMovePreviewPointRef.current = nextPoint
    scheduleDraw()
  })

  const setPendingTransformPreviewPointRef = useStableEvent((nextPoint: PendingPreviewPoint | null) => {
    pendingTransformPreviewPointRef.current = nextPoint
    scheduleDraw()
  })

  const setPendingOffsetPreviewPointRef = useStableEvent((nextPoint: PendingPreviewPoint | null) => {
    pendingOffsetPreviewPointRef.current = nextPoint
    scheduleDraw()
  })

  const setPendingOffsetRawPreviewPointRef = useStableEvent((nextPoint: PendingPreviewPoint | null) => {
    pendingOffsetRawPreviewPointRef.current = nextPoint
    scheduleDraw()
  })

  const setClipboardPlacementPreviewPoint = useStableEvent((nextPoint: Point | null) => {
    clipboardPlacementPreviewPointRef.current = nextPoint
    scheduleDraw()
  })

  const cancelClipboardPlacement = useStableEvent(() => {
    setPendingClipboardPlacement(null)
    setClipboardPlacementPreviewPoint(null)
    clipboardPlacementWorkflowPanel.focusCanvasAfterAction()
  })

  const beginClipboardPlacement = useStableEvent((clipboard: FeatureClipboardPayload) => {
    if (clipboard.length === 0) {
      return
    }

    if (pendingAddRef.current) {
      originPreviewPointRef.current = null
      cancelPendingAdd()
      setPendingPreviewPointRef(null)
    }
    if (pendingMoveRef.current) {
      cancelPendingMove()
      setPendingMovePreviewPointRef(null)
      setCopyCountDraft('1')
    }
    if (pendingTransformRef.current) {
      cancelPendingTransform()
      setPendingTransformPreviewPointRef(null)
      transformExact.setPendingRotateCopyPoint(null)
      transformExact.setRotateCopyCountDraft('1')
    }
    if (pendingOffsetRef.current) {
      cancelPendingOffset()
      setPendingOffsetPreviewPointRef(null)
      setPendingOffsetRawPreviewPointRef(null)
    }
    if (pendingShapeActionRef.current) {
      cancelPendingShapeAction()
    }
    if (pendingSketchEditRef.current) {
      cancelPendingSketchEdit()
    }

    resetLock()
    setOperationDimEdit(null)
    setPendingClipboardPlacement(clipboard)
    setClipboardPlacementPreviewPoint(livePointerWorldRef.current)
    window.requestAnimationFrame(() => canvasRef.current?.focus({ preventScroll: true }))
  })

  const placeClipboardAt = useStableEvent((placementPoint: Point) => {
    const clipboard = pendingClipboardPlacementRef.current
    if (!clipboard) {
      return
    }

    pasteClipboardFeatures(useProjectStore.getState(), clipboard, placementPoint)
    setPendingClipboardPlacement(null)
    setClipboardPlacementPreviewPoint(null)
  })

  function sameControl(a: SketchControlRef | null, b: SketchControlRef | null): boolean { return a?.kind === b?.kind && a?.index === b?.index && a?.t === b?.t }

  const setHoveredEditControl = useStableEvent((nextControl: SketchControlRef | null) => {
    if (sameControl(hoveredEditControlRef.current, nextControl)) {
      return
    }
    hoveredEditControlRef.current = nextControl
    if (!nextControl) dimEdit.setArmedForDimension(false)
    scheduleDraw()
  })

  function clearTransientCanvasState() { suppressClickRef.current = false; didPanRef.current = false; gestures.stopPan(); marqueeStartRef.current = null; marqueeCurrentRef.current = null; touchDragPendingRef.current = null; livePointerWorldRef.current = null }

  const move = useMoveWorkflow({
    projectRef,
    operationDimEdit,
    setOperationDimEdit,
    operationDimEditRef,
    setCopyCountDraft,
    copyCountInputRef,
    pendingMove,
    pendingMoveRef,
    pendingMovePreviewPointRef,
    setPendingMovePreviewPointRef,
    cancelPendingMove,
    setPendingMoveTo,
    completePendingMove,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })

  const transformExact = useTransformExactWorkflow({
    operationDimEdit,
    setOperationDimEdit,
    operationDimEditRef,
    pendingTransform,
    pendingTransformRef,
    pendingTransformPreviewPointRef,
    setPendingTransformPreviewPointRef,
    cancelPendingTransform,
    completePendingTransform,
    triggerDimensionEdit,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })

  const offset = useOffsetWorkflow({
    projectRef,
    operationDimEdit,
    setOperationDimEdit,
    operationDimEditRef,
    pendingOffset,
    setPendingOffsetPreviewPointRef,
    setPendingOffsetRawPreviewPointRef,
    cancelPendingOffset,
    completePendingOffset,
    triggerDimensionEdit,
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })

  function confirmCutCuttersFromTabletPanel() { confirmCutCutters(); cutWorkflowPanel.focusCanvasAfterAction() }
  function completeCutFromTabletPanel() { completePendingShapeAction(); cutWorkflowPanel.focusCanvasAfterAction() }
  function cancelCutFromTabletPanel() { cancelPendingShapeAction(); cutWorkflowPanel.focusCanvasAfterAction() }
  function completeJoinFromPanel() { completePendingShapeAction(); joinWorkflowPanel.focusCanvasAfterAction() }
  function cancelJoinFromPanel() { cancelPendingShapeAction(); joinWorkflowPanel.focusCanvasAfterAction() }
  function applyEditFromPanel() { gestures.stopNodeDrag(); resetLock(); applySketchEdit(); editWorkflowPanel.focusCanvasAfterAction() }
  function cancelEditFromPanel() { gestures.stopNodeDrag(); resetLock(); cancelSketchEdit(); editWorkflowPanel.focusCanvasAfterAction() }
  function commitEditDimensionFromPanel() { dimEdit.commitEditDimension(); editWorkflowPanel.focusCanvasAfterAction() }
  function cancelEditDimensionFromPanel() { dimEdit.cancelEditDimension(); editWorkflowPanel.focusCanvasAfterAction() }
  function commitFilletFromPanel() { fillet.commitFilletDimension(); editWorkflowPanel.focusCanvasAfterAction() }
  function cancelFilletFromPanel() { fillet.cancelFilletDimension(); editWorkflowPanel.focusCanvasAfterAction() }
  useEffect(() => {
    function handleClipboardPlacement(event: Event) { if (event instanceof CustomEvent) beginClipboardPlacement(event.detail as FeatureClipboardPayload) }
    window.addEventListener(FEATURE_CLIPBOARD_PLACEMENT_EVENT, handleClipboardPlacement)
    return () => window.removeEventListener(FEATURE_CLIPBOARD_PLACEMENT_EVENT, handleClipboardPlacement)
  }, [beginClipboardPlacement])

  useEffect(() => {
    if (!project.backdrop?.imageDataUrl) {
      setBackdropImage(null)
      setBackdropImageLoading(false)
      return
    }

    setBackdropImage(null)
    const image = new Image()
    image.onload = () => {
      setBackdropImage(image)
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          setBackdropImageLoading(false)
        })
      })
    }
    image.onerror = () => {
      setBackdropImage(null)
      setBackdropImageLoading(false)
    }
    image.src = project.backdrop.imageDataUrl
  }, [project.backdrop?.imageDataUrl, setBackdropImageLoading])

  useEffect(() => {
    const activeUrls = new Set(
      resolvedProjectFeatures(project)
        .map((feature) => feature.kind === 'stl' ? feature.stl?.topViewDataUrl : null)
        .filter((url): url is string => !!url),
    )
    const cache = stlImageCacheRef.current

    for (const url of cache.keys()) {
      if (!activeUrls.has(url)) {
        cache.delete(url)
      }
    }

    for (const url of activeUrls) {
      if (cache.has(url)) continue

      const image = new Image()
      image.onload = () => {
        cache.set(url, image)
        setStlImageRevision((revision) => revision + 1)
      }
      image.onerror = () => {
        cache.delete(url)
      }
      cache.set(url, image)
      image.src = url
    }
  }, [project])

  useEffect(() => {
    return () => {
      onActiveSnapModeChange?.(null)
    }
  }, [onActiveSnapModeChange])

  // Redraw when measure/dimension transient state changes.
  useEffect(() => {
    scheduleDraw()
  }, [scheduleDraw, tapeMeasure, pendingDimension, dimensionDeleteArmed, selectedAnnotationId, project.annotations])

  useEffect(() => {
    scheduleDraw()
  }, [scheduleDraw, project, selection, pendingAdd, pendingMove, pendingTransform, pendingOffset, pendingClipboardPlacement, viewState, backdropImage, stlImageRevision, toolpaths, selectedOperationId, collidingClampIds, snapSettings, copyCountDraft, dimEdit.dimensionEdit, toolpathVisibility, operationHighlightKind, canvasPalette])

  useEffect(() => {
    sketchEditPreviewRef.current = null
    pendingSketchExtensionRef.current = null
    pendingExtendHitRef.current = null
    pendingTrimSpanRef.current = null
    pendingSketchFilletRef.current = null
    fillet.setFilletCornerPicked(false)
  // fillet.setFilletCornerPicked is a useState setter (stable identity), but the
  // lint rule sees `fillet` (the hook-return object) which is recreated each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.mode, selection.sketchEditTool, selection.selectedFeatureId])

  useEffect(() => {
    if (selection.mode !== 'sketch_edit') {
      hoveredEditControlRef.current = null
      dimEdit.dimensionEditControlRef.current = null
      dimEdit.dimensionEditFeatureIdRef.current = null
      dimEdit.editDimStepsRef.current = []
      dimEdit.editDimStepIndexRef.current = 0
      dimEdit.setDimensionEdit(null)
    }
  // The dimension workflow object is intentionally not a dependency here: the cleanup
  // is mode-scoped, and the hook return object is recreated on each render.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection.mode])

  useEffect(() => {
    if (
      selection.mode !== 'sketch_edit'
      || selection.selectedNode?.type !== 'feature'
      || !!selection.sketchEditTool
    ) {
      setHoveredEditControl(null)
    }
  }, [setHoveredEditControl, selection.mode, selection.selectedFeatureId, selection.selectedNode, selection.sketchEditTool])

  useEffect(() => {
    pendingOffsetPreviewPointRef.current = null
    pendingOffsetRawPreviewPointRef.current = null
  }, [pendingOffset?.session])

  useEffect(() => {
    if (!pendingClipboardPlacement) {
      clipboardPlacementPreviewPointRef.current = null
      scheduleDraw()
    }
  }, [pendingClipboardPlacement, scheduleDraw])

  useEffect(() => {
    if (zoomWindowActive) {
      return
    }

    zoomWindowStartRef.current = null
    zoomWindowCurrentRef.current = null
    scheduleDraw()
  }, [scheduleDraw, zoomWindowActive])

  drawRef.current = () => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const project = projectRef.current
    const features = resolvedProjectFeatures(project)
    const selection = selectionRef.current
    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingOffset = pendingOffsetRef.current
    const viewState = viewStateRef.current
    const backdropImage = backdropImageRef.current
    const toolpaths = toolpathsRef.current
    const selectedOperationId = selectedOperationIdRef.current
    const collidingClampIds = collidingClampIdsRef.current
    const copyCountDraft = copyCountDraftRef.current
    const operationHighlightKind = operationHighlightKindRef.current
    // A1.3: features the armed operation could act on (null = nothing armed).
    const operationHighlightIds = operationHighlightKind
      ? new Set(compatibleFeatureIdsForOperation(project, operationHighlightKind))
      : null

    const width = canvas.width
    const height = canvas.height
    const vt = computeViewTransform(project.stock, width, height, viewState)
    const collidingClampIdSet = new Set(collidingClampIds)

    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = canvasPalette.background
    ctx.fillRect(0, 0, width, height)

    drawGrid(ctx, vt, width, height, project.stock, project.grid, canvasPalette, getFeaturesWorldBounds(features))

    if (project.backdrop?.visible && backdropImage) {
      drawBackdropImage(
        ctx,
        project.backdrop,
        backdropImage,
        vt,
        selection.selectedNode?.type === 'backdrop',
        canvasPalette,
        project.backdrop.name,
      )
    }

    stockLabelRectsRef.current = []
    if (project.stock.visible) {
      const anyFeatureExceedsStock = features.some(
        (feature) => feature.visible
          && feature.kind !== 'text'
          && profileExceedsStock(feature.sketch.profile, project.stock),
      )
      drawStockOutline(ctx, project.stock, vt, project.meta.units, anyFeatureExceedsStock, canvasPalette, stockLabelRectsRef.current)
    }

    if (project.origin.visible) {
      drawOriginMarker(ctx, project.origin, vt, canvasPalette)
    }

    const batchedLineFeatures: SketchFeature[] = []
    for (const feature of features) {
      if (!feature.visible) continue

      const selected = selection.selectedFeatureIds.includes(feature.id)
      const hovered = feature.id === selection.hoveredFeatureId
      const editing = selection.mode === 'sketch_edit' && feature.id === selection.selectedFeatureId
      const groupSelected = selection.groupFolderId !== null && selected

      const batchLine = feature.operation === 'line'
        && !operationHighlightIds
        && !selected
        && !hovered
        && !editing
        && !groupSelected
      if (batchLine) {
        batchedLineFeatures.push(feature)
      } else {
        drawFeature(ctx, feature, vt, project.meta.units, project.meta.showFeatureInfo, selected, hovered, editing, groupSelected)
      }

      // A1.3: when an operation is armed in the CAM menu, ring the features it
      // could act on and veil the rest, so "what would this operate on?" is visible.
      if (operationHighlightIds) {
        traceProfilePath(ctx, feature.sketch.profile, vt)
        ctx.save()
        if (operationHighlightIds.has(feature.id)) {
          ctx.lineWidth = 3
          ctx.strokeStyle = 'rgba(123, 199, 246, 0.95)'
          ctx.shadowColor = 'rgba(123, 199, 246, 0.85)'
          ctx.shadowBlur = 8
          ctx.stroke()
        } else if (feature.sketch.profile.closed) {
          ctx.fillStyle = canvasPalette.veil
          ctx.fill()
        }
        ctx.restore()
      }

      const stlTopViewUrl = feature.kind === 'stl' ? feature.stl?.topViewDataUrl : null
      const stlTopViewImage = stlTopViewUrl ? stlImageCacheRef.current.get(stlTopViewUrl) : null
      const stlDefinition = feature.kind === 'stl'
        ? project.featureDefinitions[feature.definitionId]
        : null
      if (feature.kind === 'stl' && stlTopViewImage && stlDefinition) {
        drawStlTopViewImage(
          ctx,
          feature,
          stlDefinition.profile,
          stlTopViewImage,
          vt,
          selected,
          hovered,
          editing,
        )
      }

      if (editing) {
        const hoveredEditControl =
          !isDraggingNodeRef.current && !dimEdit.dimensionEditControlRef.current
            ? hoveredEditControlRef.current
            : null
        const editControl =
          isDraggingNodeRef.current
            ? selection.activeControl
            : (dimEdit.dimensionEditControlRef.current ?? selection.activeControl ?? hoveredEditControl)
        drawSketchControls(ctx, feature.sketch.profile, vt, editControl, canvasPalette)
        if (editControl && (isDraggingNodeRef.current || dimEdit.dimensionEditControlRef.current || hoveredEditControl)) {
          drawActiveEditMeasurements(ctx, feature.sketch.profile, vt, project.meta.units, editControl)
        }
      }

      if (feature.sketch.constraints && feature.sketch.constraints.length > 0) {
        const b = getProfileBounds(feature.sketch.profile)
        const badgeWorld = { x: b.minX, y: b.maxY }
        const badgeC = worldToCanvas(badgeWorld, vt)
        ctx.save()
        ctx.fillStyle = 'rgba(91, 165, 216, 0.85)'
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)'
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(badgeC.cx - 8, badgeC.cy - 8, 7, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
        ctx.fillStyle = '#fff'
        ctx.font = 'bold 10px sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText(String(feature.sketch.constraints.length), badgeC.cx - 8, badgeC.cy - 8)
        ctx.restore()
      }
    }
    drawLineFeatureBatch(ctx, batchedLineFeatures, vt)
    if (project.meta.showFeatureInfo) {
      for (const feature of batchedLineFeatures) {
        drawFeatureInfo(ctx, feature, vt, project.meta.units)
      }
    }

    const clipboardPlacement = pendingClipboardPlacementRef.current
    const clipboardPlacementPreviewPoint = clipboardPlacementPreviewPointRef.current
    if (clipboardPlacement && clipboardPlacementPreviewPoint) {
      const previewFeatures = buildPlacedClipboardFeatures(clipboardPlacement, project, clipboardPlacementPreviewPoint)
      for (const feature of previewFeatures) {
        drawPreviewProfile(ctx, feature.sketch.profile, vt, 'Paste preview')
      }
      drawPendingPoint(ctx, clipboardPlacementPreviewPoint, vt, snap.isActiveSnapPoint(clipboardPlacementPreviewPoint))
    }

    const pendingConstraintDraw = pendingConstraintRef.current
    if (pendingConstraintDraw && pendingConstraintDraw.anchor) {
      const anchorC = worldToCanvas(pendingConstraintDraw.anchor.point, vt)
      const constraintLineColor = lockModeGuideColor(lockModeRef.current)
      ctx.save()
      ctx.fillStyle = 'rgba(247, 211, 148, 0.95)'
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.4)'
      ctx.beginPath()
      ctx.arc(anchorC.cx, anchorC.cy, 4, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
      if (pendingConstraintDraw.reference) {
        const refC = worldToCanvas(pendingConstraintDraw.reference.point, vt)
        ctx.strokeStyle = constraintLineColor
        ctx.lineWidth = 1.5
        ctx.setLineDash([6, 4])
        ctx.beginPath()
        ctx.moveTo(refC.cx, refC.cy)
        ctx.lineTo(anchorC.cx, anchorC.cy)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = 'rgba(247, 211, 148, 0.95)'
        ctx.beginPath()
        ctx.arc(refC.cx, refC.cy, 4, 0, Math.PI * 2)
        ctx.fill()
        ctx.stroke()
      } else if (livePointerWorldRef.current) {
        // Draw live preview line from anchor to current mouse position while picking reference
        const livePoint = applyLock(livePointerWorldRef.current, pendingConstraintDraw.anchor.point)
        const liveC = worldToCanvas(livePoint, vt)
        ctx.strokeStyle = constraintLineColor
        ctx.lineWidth = 1.5
        ctx.setLineDash([6, 4])
        ctx.beginPath()
        ctx.moveTo(liveC.cx, liveC.cy)
        ctx.lineTo(anchorC.cx, anchorC.cy)
        ctx.stroke()
        ctx.setLineDash([])
      }
      ctx.restore()
    }

    // Reset label rects before rebuilding
    constraintLabelRectsRef.current = []
    for (const feature of features) {
      if (!feature.visible) continue
      for (const c of feature.sketch.constraints) {
        if (c.type !== 'fixed_distance' || !c.anchor_point || !c.reference_point) continue
        const isInvalid = !!c.is_invalid
        const lineColor = isInvalid ? 'rgba(220, 60, 60, 0.85)' : 'rgba(91, 165, 216, 0.8)'
        const dotColor = isInvalid ? 'rgba(220, 60, 60, 0.9)' : 'rgba(91, 165, 216, 0.9)'
        const labelColor = isInvalid ? 'rgba(255, 180, 180, 0.95)' : canvasPalette.labelText
        const aC = worldToCanvas(c.anchor_point, vt)
        const rC = worldToCanvas(c.reference_point, vt)
        ctx.save()
        ctx.strokeStyle = lineColor
        ctx.lineWidth = 1
        ctx.setLineDash([5, 3])
        ctx.beginPath()
        ctx.moveTo(aC.cx, aC.cy)
        ctx.lineTo(rC.cx, rC.cy)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = dotColor
        ctx.beginPath()
        ctx.arc(aC.cx, aC.cy, 3, 0, Math.PI * 2)
        ctx.fill()
        ctx.beginPath()
        ctx.arc(rC.cx, rC.cy, 3, 0, Math.PI * 2)
        ctx.fill()
        if (typeof c.value === 'number') {
          const midX = (aC.cx + rC.cx) / 2
          const midY = (aC.cy + rC.cy) / 2
          const label = isInvalid
            ? `⚠ ${formatLength(c.value, project.meta.units)}`
            : formatLength(c.value, project.meta.units)
          ctx.font = '11px sans-serif'
          const metrics = ctx.measureText(label)
          const padX = 4
          const padY = 2
          const halfW = metrics.width / 2 + padX
          const halfH = 7 + padY
          ctx.fillStyle = isInvalid ? 'rgba(80, 20, 20, 0.9)' : canvasPalette.labelBackground
          ctx.fillRect(midX - halfW, midY - halfH, halfW * 2, halfH * 2)
          ctx.fillStyle = labelColor
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(label, midX, midY)
          // Record hit area for click-to-edit
          constraintLabelRectsRef.current.push({
            featureId: feature.id,
            constraintId: c.id,
            cx: midX,
            cy: midY,
            halfW,
            halfH,
          })
        }
        ctx.restore()
      }
    }

    for (const clamp of project.clamps) {
      if (!clamp.visible) continue
      const selected = selection.selectedNode?.type === 'clamp' && selection.selectedNode.clampId === clamp.id
      drawClampFootprint(ctx, clamp, vt, selected, collidingClampIdSet.has(clamp.id))
      if (selection.mode === 'sketch_edit' && selection.selectedNode?.type === 'clamp' && selection.selectedNode.clampId === clamp.id) {
        drawSketchControls(ctx, rectProfile(clamp.x, clamp.y, clamp.w, clamp.h), vt, selection.activeControl, canvasPalette)
      }
    }

    for (const tab of project.tabs) {
      if (!tab.visible) continue
      const selected = selection.selectedNode?.type === 'tab' && selection.selectedNode.tabId === tab.id
      drawTabFootprint(ctx, tab, vt, selected)
      if (selection.mode === 'sketch_edit' && selection.selectedNode?.type === 'tab' && selection.selectedNode.tabId === tab.id) {
        drawSketchControls(ctx, rectProfile(tab.x, tab.y, tab.w, tab.h), vt, selection.activeControl, canvasPalette)
      }
    }

    for (const toolpath of toolpaths) {
      if (toolpath.moves.length > 0) {
        drawToolpath(ctx, toolpath, vt, toolpath.operationId === selectedOperationId, toolpathVisibility ?? { cuts: true, rapids: true, plunges: true, retractions: true, directions: true })
      }
    }

    if (marqueeStartRef.current && marqueeCurrentRef.current) {
      const x = Math.min(marqueeStartRef.current.cx, marqueeCurrentRef.current.cx)
      const y = Math.min(marqueeStartRef.current.cy, marqueeCurrentRef.current.cy)
      const w = Math.abs(marqueeCurrentRef.current.cx - marqueeStartRef.current.cx)
      const h = Math.abs(marqueeCurrentRef.current.cy - marqueeStartRef.current.cy)
      ctx.save()
      ctx.fillStyle = 'rgba(91, 165, 216, 0.16)'
      ctx.strokeStyle = 'rgba(123, 199, 246, 0.9)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([6, 4])
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
      ctx.restore()
    }

    if (zoomWindowStartRef.current && zoomWindowCurrentRef.current) {
      const x = Math.min(zoomWindowStartRef.current.cx, zoomWindowCurrentRef.current.cx)
      const y = Math.min(zoomWindowStartRef.current.cy, zoomWindowCurrentRef.current.cy)
      const w = Math.abs(zoomWindowCurrentRef.current.cx - zoomWindowStartRef.current.cx)
      const h = Math.abs(zoomWindowCurrentRef.current.cy - zoomWindowStartRef.current.cy)
      ctx.save()
      ctx.fillStyle = 'rgba(242, 185, 92, 0.16)'
      ctx.strokeStyle = 'rgba(247, 211, 148, 0.92)'
      ctx.lineWidth = 1.5
      ctx.setLineDash([7, 4])
      ctx.fillRect(x, y, w, h)
      ctx.strokeRect(x, y, w, h)
      ctx.restore()
    }

    const dimensionEdit = dimEdit.dimensionEditRef.current
    const currentPreviewPoint =
      dimensionEdit
        ? computeDimensionEditPreviewPoint(dimensionEdit, project.meta.units)
        : pendingAdd?.shape === 'origin'
          ? (
              originPreviewPointRef.current && originPreviewPointRef.current.session === pendingAdd.session
                ? originPreviewPointRef.current.point
                : null
            )
          : pendingAdd && pendingPreviewPointRef.current?.session === pendingAdd.session
            ? pendingPreviewPointRef.current.point
            : null

    if (pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline') {
      const closePreview =
        currentPreviewPoint && pendingAdd.points.length >= 3
          ? isLoopCloseCandidate(worldToCanvas(currentPreviewPoint, vt), pendingAdd.points, vt, POLYGON_CLOSE_RADIUS)
          : false
      if (pendingAdd.points.length > 0) {
        if (pendingAdd.shape === 'spline') {
          drawPendingSplineLoop(ctx, pendingAdd.points, currentPreviewPoint, vt, closePreview, project.meta.units, snap.isActiveSnapPoint(currentPreviewPoint), lockModeGuideColor(lockModeRef.current))
        } else {
          drawPendingPathLoop(
            ctx,
            pendingAdd.points,
            currentPreviewPoint,
            vt,
            closePreview,
            polygonProfile,
            'Pending polygon',
            project.meta.units,
            snap.isActiveSnapPoint(currentPreviewPoint),
            lockModeGuideColor(lockModeRef.current),
          )
        }
      } else if (currentPreviewPoint) {
        drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
      }
    } else if (pendingAdd?.shape === 'composite') {
      drawCompositeDraft(ctx, pendingAdd, currentPreviewPoint, vt, project.meta.units, snap.isActiveSnapPoint(currentPreviewPoint), lockModeGuideColor(lockModeRef.current))
    } else if ((pendingAdd?.shape === 'rect' || pendingAdd?.shape === 'circle' || pendingAdd?.shape === 'ellipse' || pendingAdd?.shape === 'tab' || pendingAdd?.shape === 'clamp') && pendingAdd.anchor && currentPreviewPoint) {
      const previewProfile = buildPendingProfile(pendingAdd, currentPreviewPoint, project.meta.units)
      const label =
        pendingAdd.shape === 'rect'
          ? 'Pending rectangle'
          : pendingAdd.shape === 'tab'
            ? 'Pending tab'
          : pendingAdd.shape === 'clamp'
            ? 'Pending clamp'
          : pendingAdd.shape === 'ellipse'
            ? 'Pending ellipse'
            : 'Pending circle'
      drawPreviewProfile(ctx, previewProfile, vt, label)
      drawPendingPoint(ctx, pendingAdd.anchor, vt)
      drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
      if (pendingAdd.shape === 'circle') {
        drawMoveGuide(ctx, pendingAdd.anchor, currentPreviewPoint, vt)
        drawRadiusMeasurement(ctx, pendingAdd.anchor, currentPreviewPoint, vt, project.meta.units)
      } else {
        drawProfileLineMeasurements(ctx, previewProfile, vt, project.meta.units)
      }
      if (pendingAdd.shape === 'ellipse') {
        drawMoveGuide(ctx, pendingAdd.anchor, currentPreviewPoint, vt)
      }
    } else if (pendingAdd?.shape === 'slot') {
      const slotPoints = pendingAdd.points
      if (slotPoints.length === 0) {
        if (currentPreviewPoint) {
          drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
        }
      } else if (slotPoints.length === 1) {
        drawPendingPoint(ctx, slotPoints[0], vt)
        if (currentPreviewPoint) {
          drawPendingSlotAxis(ctx, slotPoints[0], currentPreviewPoint, vt, project.meta.units)
          drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
        }
      } else {
        drawPendingPoint(ctx, slotPoints[0], vt)
        drawPendingPoint(ctx, slotPoints[1], vt)
        if (currentPreviewPoint) {
          drawPendingSlotWidth(ctx, slotPoints[0], slotPoints[1], currentPreviewPoint, vt, project.meta.units)
          drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
        } else {
          drawPendingSlotAxis(ctx, slotPoints[0], slotPoints[1], vt, project.meta.units)
        }
      }
    } else if (pendingAdd?.shape === 'ngon') {
      if (pendingAdd.anchor && currentPreviewPoint) {
        drawPendingNgon(ctx, pendingAdd.anchor, currentPreviewPoint, pendingAdd.sides, vt, project.meta.units)
        drawPendingPoint(ctx, pendingAdd.anchor, vt)
        drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
      } else if (currentPreviewPoint) {
        drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
      }
    } else if (pendingAdd?.shape === 'gear') {
      if (pendingAdd.anchor && currentPreviewPoint) {
        drawPendingGear(ctx, pendingAdd.anchor, currentPreviewPoint, pendingAdd.params, vt, project.meta.units)
        drawPendingPoint(ctx, pendingAdd.anchor, vt)
        drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
      } else if (currentPreviewPoint) {
        drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
      }
    } else if (pendingAdd?.shape === 'roundrect') {
      if (pendingAdd.anchor && currentPreviewPoint) {
        drawPendingRoundRect(ctx, pendingAdd.anchor, currentPreviewPoint, pendingAdd.corner, vt, project.meta.units)
        drawPendingPoint(ctx, pendingAdd.anchor, vt)
        drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
      } else if (currentPreviewPoint) {
        drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
      }
    } else if (pendingAdd?.shape === 'chamferrect') {
      if (pendingAdd.anchor && currentPreviewPoint) {
        drawPendingChamferRect(ctx, pendingAdd.anchor, currentPreviewPoint, pendingAdd.corner, vt, project.meta.units)
        drawPendingPoint(ctx, pendingAdd.anchor, vt)
        drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
      } else if (currentPreviewPoint) {
        drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
      }
    } else if (pendingAdd?.shape === 'text' && currentPreviewPoint) {
      const previewShapes = generateTextShapes(pendingAdd.config, currentPreviewPoint)
      for (const shape of previewShapes) {
        drawPreviewProfile(ctx, shape.profile, vt, '')
      }
      drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
    } else if (pendingAdd && currentPreviewPoint) {
      drawPendingPoint(ctx, currentPreviewPoint, vt, snap.isActiveSnapPoint(currentPreviewPoint))
    }

    const currentMovePreviewPoint =
      pendingMove && pendingMovePreviewPointRef.current?.session === pendingMove.session
        ? pendingMovePreviewPointRef.current.point
        : null
    const currentTransformPreviewPoint =
      pendingTransform && pendingTransformPreviewPointRef.current?.session === pendingTransform.session
        ? pendingTransformPreviewPointRef.current.point
        : null
    const currentOffsetPreviewPoint =
      pendingOffset && pendingOffsetPreviewPointRef.current?.session === pendingOffset.session
        ? pendingOffsetPreviewPointRef.current.point
        : null
    const currentOffsetRawPreviewPoint =
      pendingOffset && pendingOffsetRawPreviewPointRef.current?.session === pendingOffset.session
        ? pendingOffsetRawPreviewPointRef.current.point
        : null

    if (pendingMove) {
      const targetPoint = pendingMove.toPoint ?? currentMovePreviewPoint
      const guideColor = lockModeGuideColor(lockModeRef.current)

      if (pendingMove.entityType === 'backdrop') {
        if (!project.backdrop || !backdropImage) {
          return
        }

        if (pendingMove.fromPoint && targetPoint) {
          drawMoveGuide(ctx, pendingMove.fromPoint, targetPoint, vt, guideColor)
          drawPendingPoint(ctx, pendingMove.fromPoint, vt)
          drawLineLengthMeasurement(ctx, pendingMove.fromPoint, targetPoint, vt, project.meta.units)
          drawBackdropImage(
            ctx,
            {
              ...project.backdrop,
              center: {
                x: project.backdrop.center.x + (targetPoint.x - pendingMove.fromPoint.x),
                y: project.backdrop.center.y + (targetPoint.y - pendingMove.fromPoint.y),
              },
            },
            backdropImage,
            vt,
            true,
            canvasPalette,
            'Move preview',
          )
        } else if (currentMovePreviewPoint) {
          drawPendingPoint(ctx, currentMovePreviewPoint, vt, snap.isActiveSnapPoint(currentMovePreviewPoint))
        }
      } else if (pendingMove.entityType === 'feature') {
        const features = resolveFeatureInstances(project, pendingMove.entityIds)
        if (features.length === 0) {
          return
        }

        if (pendingMove.fromPoint && targetPoint) {
          drawMoveGuide(ctx, pendingMove.fromPoint, targetPoint, vt, guideColor)
          drawPendingPoint(ctx, pendingMove.fromPoint, vt)
          drawLineLengthMeasurement(ctx, pendingMove.fromPoint, targetPoint, vt, project.meta.units)
          for (const feature of features) {
            const previewProfile = translateProfile(
              feature.sketch.profile,
              targetPoint.x - pendingMove.fromPoint.x,
              targetPoint.y - pendingMove.fromPoint.y,
            )
            drawPreviewProfile(ctx, previewProfile, vt, pendingMove.mode === 'copy' ? 'Copy preview' : 'Move preview')
          }
          if (pendingMove.mode === 'copy' && pendingMove.toPoint) {
            const parsedCount = Math.max(1, Math.floor(Number(copyCountDraft) || 1))
            for (let index = 2; index <= parsedCount; index += 1) {
              for (const feature of features) {
                const repeatedPreview = translateProfile(
                  feature.sketch.profile,
                  (targetPoint.x - pendingMove.fromPoint.x) * index,
                  (targetPoint.y - pendingMove.fromPoint.y) * index,
                )
                drawPreviewProfile(ctx, repeatedPreview, vt, `Copy ${index}`)
              }
            }
          }
        } else if (currentMovePreviewPoint) {
          drawPendingPoint(ctx, currentMovePreviewPoint, vt, snap.isActiveSnapPoint(currentMovePreviewPoint))
        }
      } else if (pendingMove.entityType === 'clamp') {
        const clamps = pendingMove.entityIds
          .map((clampId) => project.clamps.find((entry) => entry.id === clampId) ?? null)
          .filter((clamp): clamp is Clamp => clamp !== null)
        if (clamps.length === 0) {
          return
        }

        const targetPoint = pendingMove.toPoint ?? currentMovePreviewPoint

        if (pendingMove.fromPoint && targetPoint) {
          drawMoveGuide(ctx, pendingMove.fromPoint, targetPoint, vt, guideColor)
          drawPendingPoint(ctx, pendingMove.fromPoint, vt)
          drawLineLengthMeasurement(ctx, pendingMove.fromPoint, targetPoint, vt, project.meta.units)
          for (const clamp of clamps) {
            drawClampFootprint(
              ctx,
              {
                ...clamp,
                x: clamp.x + (targetPoint.x - pendingMove.fromPoint.x),
                y: clamp.y + (targetPoint.y - pendingMove.fromPoint.y),
              },
              vt,
              true,
              false,
            )
          }
          if (pendingMove.mode === 'copy' && pendingMove.toPoint) {
            const parsedCount = Math.max(1, Math.floor(Number(copyCountDraft) || 1))
            for (let index = 2; index <= parsedCount; index += 1) {
              for (const clamp of clamps) {
                drawClampFootprint(
                  ctx,
                  {
                    ...clamp,
                    x: clamp.x + (targetPoint.x - pendingMove.fromPoint.x) * index,
                    y: clamp.y + (targetPoint.y - pendingMove.fromPoint.y) * index,
                  },
                  vt,
                  false,
                  false,
                )
              }
            }
          }
        } else if (currentMovePreviewPoint) {
          drawPendingPoint(ctx, currentMovePreviewPoint, vt, snap.isActiveSnapPoint(currentMovePreviewPoint))
        }
      } else {
        const tabs = pendingMove.entityIds
          .map((tabId) => project.tabs.find((entry) => entry.id === tabId) ?? null)
          .filter((tab): tab is Tab => tab !== null)
        if (tabs.length === 0) {
          return
        }

        const targetPoint = pendingMove.toPoint ?? currentMovePreviewPoint

        if (pendingMove.fromPoint && targetPoint) {
          drawMoveGuide(ctx, pendingMove.fromPoint, targetPoint, vt, guideColor)
          drawPendingPoint(ctx, pendingMove.fromPoint, vt)
          drawLineLengthMeasurement(ctx, pendingMove.fromPoint, targetPoint, vt, project.meta.units)
          for (const tab of tabs) {
            drawTabFootprint(
              ctx,
              {
                ...tab,
                x: tab.x + (targetPoint.x - pendingMove.fromPoint.x),
                y: tab.y + (targetPoint.y - pendingMove.fromPoint.y),
              },
              vt,
              true,
            )
          }
          if (pendingMove.mode === 'copy' && pendingMove.toPoint) {
            const parsedCount = Math.max(1, Math.floor(Number(copyCountDraft) || 1))
            for (let index = 2; index <= parsedCount; index += 1) {
              for (const tab of tabs) {
                drawTabFootprint(
                  ctx,
                  {
                    ...tab,
                    x: tab.x + (targetPoint.x - pendingMove.fromPoint.x) * index,
                    y: tab.y + (targetPoint.y - pendingMove.fromPoint.y) * index,
                  },
                  vt,
                  false,
                )
              }
            }
          }
        } else if (currentMovePreviewPoint) {
          drawPendingPoint(ctx, currentMovePreviewPoint, vt, snap.isActiveSnapPoint(currentMovePreviewPoint))
        }
      }
    }

    if (pendingTransform) {
      if (pendingTransform.entityType === 'backdrop') {
        if (!project.backdrop || !backdropImage) {
          return
        }

        if (pendingTransform.referenceStart) {
          drawPendingPoint(ctx, pendingTransform.referenceStart, vt)
        }

        if (pendingTransform.referenceEnd) {
          drawPendingPoint(ctx, pendingTransform.referenceEnd, vt)
          drawMoveGuide(ctx, pendingTransform.referenceStart!, pendingTransform.referenceEnd, vt)
          if (pendingTransform.mode === 'resize') {
            drawLineLengthMeasurement(
              ctx,
              pendingTransform.referenceStart!,
              pendingTransform.referenceEnd,
              vt,
              project.meta.units,
              { prefix: 'Ref' },
            )
          }
        }

        if (pendingTransform.referenceStart && pendingTransform.referenceEnd && currentTransformPreviewPoint) {
          drawPendingPoint(ctx, currentTransformPreviewPoint, vt, snap.isActiveSnapPoint(currentTransformPreviewPoint))
          drawMoveGuide(ctx, pendingTransform.referenceStart, currentTransformPreviewPoint, vt)
          if (pendingTransform.mode === 'resize') {
            drawLineLengthMeasurement(
              ctx,
              pendingTransform.referenceStart,
              currentTransformPreviewPoint,
              vt,
              project.meta.units,
              { prefix: 'Size' },
            )
          } else {
            drawAngleMeasurement(
              ctx,
              pendingTransform.referenceStart,
              pendingTransform.referenceEnd,
              currentTransformPreviewPoint,
              vt,
            )
          }
          const previewBackdrop =
            pendingTransform.mode === 'resize'
              ? resizeBackdropFromReference(project.backdrop, pendingTransform.referenceStart, pendingTransform.referenceEnd, currentTransformPreviewPoint)
              : rotateBackdropFromReference(project.backdrop, pendingTransform.referenceStart, pendingTransform.referenceEnd, currentTransformPreviewPoint)
          if (previewBackdrop) {
            drawBackdropImage(
              ctx,
              previewBackdrop,
              backdropImage,
              vt,
              true,
              canvasPalette,
              pendingTransform.mode === 'resize' ? 'Resize preview' : 'Rotate preview',
            )
          }
        } else if (currentTransformPreviewPoint) {
          drawPendingPoint(ctx, currentTransformPreviewPoint, vt, snap.isActiveSnapPoint(currentTransformPreviewPoint))
        }

        return
      }

      const features = resolveFeatureInstances(project, pendingTransform.entityIds)

      if (features.length === 0) {
        return
      }

      if (pendingTransform.referenceStart) {
        drawPendingPoint(ctx, pendingTransform.referenceStart, vt)
      }

      const mirrorPreviewEnd = pendingTransform.mode === 'mirror'
        ? pendingTransform.referenceEnd ?? currentTransformPreviewPoint
        : null
      const visibleReferenceEnd = mirrorPreviewEnd ?? pendingTransform.referenceEnd

      if (pendingTransform.referenceStart && visibleReferenceEnd) {
        drawPendingPoint(ctx, visibleReferenceEnd, vt, snap.isActiveSnapPoint(visibleReferenceEnd))
        drawMoveGuide(ctx, pendingTransform.referenceStart, visibleReferenceEnd, vt)
        if (pendingTransform.mode === 'resize') {
          drawLineLengthMeasurement(
            ctx,
            pendingTransform.referenceStart,
            visibleReferenceEnd,
            vt,
            project.meta.units,
            { prefix: 'Ref' },
          )
        }
      }

      if (pendingTransform.referenceStart && pendingTransform.referenceEnd && currentTransformPreviewPoint && pendingTransform.mode !== 'mirror') {
        drawPendingPoint(ctx, currentTransformPreviewPoint, vt, snap.isActiveSnapPoint(currentTransformPreviewPoint))
        drawMoveGuide(ctx, pendingTransform.referenceStart, currentTransformPreviewPoint, vt)
        if (pendingTransform.mode === 'resize') {
          drawLineLengthMeasurement(
            ctx,
            pendingTransform.referenceStart,
            currentTransformPreviewPoint,
            vt,
            project.meta.units,
            { prefix: 'Size' },
          )
        } else {
          drawAngleMeasurement(
            ctx,
            pendingTransform.referenceStart,
            pendingTransform.referenceEnd,
            currentTransformPreviewPoint,
            vt,
          )
        }
        for (const feature of features) {
          const previewFeature =
            pendingTransform.mode === 'resize'
              ? resizeFeatureFromReference(feature, pendingTransform.referenceStart, pendingTransform.referenceEnd, currentTransformPreviewPoint)
              : rotateFeatureFromReference(feature, pendingTransform.referenceStart, pendingTransform.referenceEnd, currentTransformPreviewPoint)
          if (previewFeature) {
            drawPreviewProfile(
              ctx,
              previewFeature.sketch.profile,
              vt,
              pendingTransform.mode === 'resize' ? 'Resize preview' : 'Rotate preview',
            )
          }
        }
      } else if (pendingTransform.mode === 'mirror' && pendingTransform.referenceStart && visibleReferenceEnd) {
        for (const feature of features) {
          const previewFeature = mirrorFeatureFromReference(feature, pendingTransform.referenceStart, visibleReferenceEnd)
          if (previewFeature) {
            drawPreviewProfile(ctx, previewFeature.sketch.profile, vt, 'Mirror preview')
          }
        }
      } else if (currentTransformPreviewPoint) {
        drawPendingPoint(ctx, currentTransformPreviewPoint, vt, snap.isActiveSnapPoint(currentTransformPreviewPoint))
      }
    }

    if (pendingOffset) {
      const features = resolveFeatureInstances(project, pendingOffset.entityIds)
        .filter((feature) => feature.sketch.profile.closed)
      const rawOffsetPoint = currentOffsetRawPreviewPoint ?? livePointerWorldRef.current ?? snap.activeSnapRef.current?.rawPoint ?? null
      const snappedOffsetPoint = currentOffsetPreviewPoint ?? snap.activeSnapRef.current?.point ?? rawOffsetPoint

      if (snappedOffsetPoint) {
        drawPendingPoint(ctx, snappedOffsetPoint, vt, snap.isActiveSnapPoint(snappedOffsetPoint))
      }

      const typedOffsetDistance =
        operationDimEdit?.kind === 'offset'
          ? parseLengthInput(operationDimEdit.distance, project.meta.units)
          : null
      const previewInput =
        typedOffsetDistance === null
          && features.length > 0
          && rawOffsetPoint
          && snappedOffsetPoint
          ? resolveOffsetPreview(features, rawOffsetPoint, snappedOffsetPoint, snap.activeSnapRef.current?.mode ?? null, vt)
          : null

      if (previewInput && typedOffsetDistance === null) {
        drawPendingPoint(ctx, previewInput.nearestPoint, vt)
        drawMoveGuide(ctx, previewInput.nearestPoint, snappedOffsetPoint!, vt)
        drawLineLengthMeasurement(ctx, previewInput.nearestPoint, snappedOffsetPoint!, vt, project.meta.units)
      }

      const previewDistance = typedOffsetDistance ?? previewInput?.signedDistance ?? null
      if (previewDistance !== null) {
        const { features: previewFeatures } = previewOffsetFeatures(project, pendingOffset.entityIds, previewDistance)
        for (const feature of previewFeatures) {
          drawPreviewProfile(
            ctx,
            feature.sketch.profile,
            vt,
            previewDistance < 0 ? 'Offset in preview' : 'Offset out preview',
          )
        }
      }
    }

    if (selection.mode === 'sketch_edit' && sketchEditPreviewRef.current) {
      if (pendingSketchExtensionRef.current) {
        drawMoveGuide(ctx, pendingSketchExtensionRef.current.anchor, sketchEditPreviewRef.current.point, vt, lockModeGuideColor(lockModeRef.current))
        drawPendingPoint(ctx, pendingSketchExtensionRef.current.anchor, vt)
      }
      if (pendingExtendHitRef.current && pendingSketchEditRef.current?.subject) {
        const subjFeature = resolveFeatureInstance(
          project,
          pendingSketchEditRef.current.subject.featureId,
        )
        if (subjFeature && !subjFeature.sketch.profile.closed) {
          const subjProfile = subjFeature.sketch.profile
          const segCount = subjProfile.segments.length
          const segIndex = pendingSketchEditRef.current.subject.segmentIndex
          const isFirst = segIndex === 0
          const isLast = segIndex === segCount - 1
          if (isFirst || isLast) {
            const subjT = pendingSketchEditRef.current.subject.t ?? 0.5
            let growFromStart: boolean
            if (isFirst && isLast) {
              growFromStart = subjT < 0.5
            } else if (isFirst) {
              growFromStart = subjT < 0.5
            } else {
              growFromStart = false
            }
            const growingPoint = growFromStart
              ? subjProfile.start
              : subjProfile.segments[segCount - 1].to
            drawMoveGuide(ctx, growingPoint, pendingExtendHitRef.current, vt, 'rgba(239, 188, 122, 0.75)')
          }
        }
      }
      if (pendingTrimSpanRef.current) {
        // Draw the span that would be removed in red dashed style
        const span = pendingTrimSpanRef.current
        const from = worldToCanvas(span.from, vt)
        const to = worldToCanvas(span.to, vt)
        ctx.beginPath()
        ctx.moveTo(from.cx, from.cy)
        ctx.lineTo(to.cx, to.cy)
        ctx.strokeStyle = 'rgba(220, 80, 60, 0.85)'
        ctx.lineWidth = 2.5
        ctx.setLineDash([6, 4])
        ctx.stroke()
        ctx.setLineDash([])
      }
      if (pendingSketchFilletRef.current && editingFeature) {
        drawPendingPoint(ctx, pendingSketchFilletRef.current.corner, vt)
        const typedRadius = fillet.filletDimensionEditRef.current
          ? parseLengthInput(fillet.filletDimensionEditRef.current.radius, project.meta.units)
          : null
        const useTyped = typedRadius !== null && typedRadius > 0
        if (!useTyped) {
          drawMoveGuide(ctx, pendingSketchFilletRef.current.corner, sketchEditPreviewRef.current.point, vt)
        }
        const isChamfer = selection.sketchEditTool === 'chamfer'
        const previewFeature = useTyped
          ? isChamfer
            ? chamferFeatureFromDistance(editingFeature, pendingSketchFilletRef.current.anchorIndex, typedRadius)
            : filletFeatureFromRadius(editingFeature, pendingSketchFilletRef.current.anchorIndex, typedRadius)
          : isChamfer
            ? chamferFeatureFromPoint(editingFeature, pendingSketchFilletRef.current.anchorIndex, sketchEditPreviewRef.current.point)
            : filletFeatureFromPoint(editingFeature, pendingSketchFilletRef.current.anchorIndex, sketchEditPreviewRef.current.point)
        if (previewFeature) {
          drawPreviewProfile(ctx, previewFeature.sketch.profile, vt, isChamfer ? 'Chamfer preview' : 'Fillet preview')
          const arcIndex = pendingSketchFilletRef.current.anchorIndex
          const arcSegment = previewFeature.sketch.profile.segments[arcIndex]
          if (!isChamfer && arcSegment?.type === 'arc') {
            const arcStart = anchorPointForIndex(previewFeature.sketch.profile, arcIndex)
            drawArcRadiusMeasurement(ctx, arcStart, arcSegment, vt, project.meta.units)
          }
        }
      }
      if (!fillet.filletDimensionEditRef.current) {
        drawSketchEditPreviewPoint(ctx, sketchEditPreviewRef.current, vt)
      }
    }

    // Permanent dimension annotations — resolved live so they follow geometry.
    // Hidden entirely when the project-level show-dimensions flag is off.
    if (project.meta.showDimensions) {
      drawDimensions(ctx, project, vt, project.meta.units, {
        selectedId: selectedAnnotationIdRef.current,
        deleteHoverId: dimensionDeleteArmedRef.current ? deleteHoverDimIdRef.current : null,
      })
      drawDimensionAnchorDots(ctx, project, vt, { selectedId: selectedAnnotationIdRef.current, drivingEdit: drivingWf.drivingEditRef.current?.edit ?? null })
    }

    // Transient tape measure overlay.
    const tape = tapeMeasureRef.current
    if (tape) {
      const liveTapePoint = snap.activeSnapRef.current?.point ?? livePointerWorldRef.current
      drawTapeMeasure(ctx, tape, liveTapePoint, vt, project.meta.units)
    }

    // In-progress permanent dimension: preview from picked anchors to cursor.
    const pendingDim = pendingDimensionRef.current
    if (pendingDim) {
      const livePreviewPoint = snap.activeSnapRef.current?.point ?? livePointerWorldRef.current
      drawPendingDimensionPreview(ctx, pendingDim, livePreviewPoint, vt, project, project.meta.units)
    }

    drawSnapIndicator(ctx, snap.activeSnapRef.current, vt)
  }

  useEffect(() => {
    // `useRafScheduler` cancels any pending redraw frame on unmount; this effect
    // only tears down the canvas backing store. Capture the node now and use the
    // local in cleanup (the ref may have changed by the time cleanup runs).
    const canvas = canvasRef.current
    return () => {
      if (!canvas) {
        return
      }

      const ctx = canvas.getContext('2d')
      if (ctx && typeof (ctx as CanvasRenderingContext2D & { reset?: () => void }).reset === 'function') {
        ;(ctx as CanvasRenderingContext2D & { reset: () => void }).reset()
      }

      canvas.width = 0
      canvas.height = 0
    }
  }, [])

  useEffect(() => {
    if (pendingAdd?.shape === 'composite' && pendingAdd.closed) {
      completePendingComposite()
    }
  }, [completePendingComposite, pendingAdd])

  // Re-focus when the active edit field changes or the edit opens/closes; the
  // derived key (null while closed) is statically checkable as a single dep.
  const dimensionEditActiveField = dimEdit.dimensionEdit?.activeField ?? null
  useEffect(() => {
    if (dimensionEditActiveField === null) return
    const inputRef =
      dimensionEditActiveField === 'width' ? dimEdit.widthInputRef
      : dimensionEditActiveField === 'height' ? dimEdit.heightInputRef
      : dimensionEditActiveField === 'radius' ? dimEdit.radiusInputRef
      : dimensionEditActiveField === 'length' ? dimEdit.widthInputRef
      : dimEdit.heightInputRef  // angle
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [dimensionEditActiveField, dimEdit.heightInputRef, dimEdit.radiusInputRef, dimEdit.widthInputRef])

  useEffect(() => {
    if (!pendingConstraint) constraint.setConstraintDistanceInput(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setConstraintDistanceInput is a stable useState setter
  }, [pendingConstraint])

  useEffect(() => {
    if (selection.mode !== 'sketch_edit' || (selection.sketchEditTool !== 'fillet' && selection.sketchEditTool !== 'chamfer')) {
      fillet.setFilletDimensionEdit(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stable setter
  }, [selection.mode, selection.sketchEditTool])
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stable setter
  useEffect(() => { if (!pendingAdd && selection.mode !== 'sketch_edit') dimEdit.setDimensionEdit(null) }, [pendingAdd, selection.mode])
  useEffect(() => { if (!pendingMove && !pendingTransform && !pendingOffset) setOperationDimEdit(null) }, [pendingMove, pendingTransform, pendingOffset])

  const operationDimEditKind = operationDimEdit?.kind ?? null
  useEffect(() => {
    if (operationDimEditKind === null) return
    const inputRef = dimEdit.widthInputRef
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [operationDimEditKind, dimEdit.widthInputRef])

  useImperativeHandle(ref, () => ({
    zoomToModel: () => {
      const canvas = canvasRef.current
      if (!canvas) return
      setViewState(computeFitViewState(projectRef.current, canvas.width, canvas.height))
    },
    getVisibleWorldBounds: () => {
      const canvas = canvasRef.current
      if (!canvas || canvas.width === 0 || canvas.height === 0) return null
      const vt = computeViewTransform(projectRef.current.stock, canvas.width, canvas.height, viewStateRef.current)
      const a = canvasToWorld(0, 0, vt)
      const b = canvasToWorld(canvas.width, canvas.height, vt)
      return {
        minX: Math.min(a.x, b.x),
        maxX: Math.max(a.x, b.x),
        minY: Math.min(a.y, b.y),
        maxY: Math.max(a.y, b.y),
      }
    },
  }), [])

  useEffect(() => {
    if (projectKey === 0) return
    const canvas = canvasRef.current
    if (!canvas) return
    setViewState(computeFitViewState(projectRef.current, canvas.width, canvas.height))
  // Load-bearing — DO NOT remove without resolving the FULL masked set first.
  // Any react-hooks eslint-disable makes the React-Compiler rules bail on the
  // ENTIRE file (all-or-nothing), so this one directive hides every react-hooks
  // issue in SketchCanvas. The "3 errors at :2242/:2247" it was first thought to
  // mask are only the first wave — a 2026-06 investigation removed it and found:
  //   1. 8 forward-referenced hoisted functions (declaration order) — mechanically
  //      fixable by reordering; runtime-neutral.
  //   2. ~27 ref-mirror WRITES during render (the state→ref block near the top of
  //      the component + the drawRef closure) — convertible to a useLayoutEffect.
  //   3. ~6 render-time ref READS of pointer-move hot-path refs (pendingPreviewPointRef,
  //      canvasRef) — the real blocker. These refs exist to avoid re-rendering the
  //      canvas on every mouse move, so lifting them to state to satisfy the rule
  //      risks a perf regression; resolving (3) is an architectural redesign, not a
  //      lint fix. Because (3) keeps the file non-compliant, removing the directive
  //      gains nothing, so it stays — and ESLint reports it as an "unused directive"
  //      warning, which is the (intentional) cost of the bail.
  // Full analysis + reproducible reorder script: planning/archive/LINT_HOOK_TYPING_DEBT_Plan.md.
  }, [projectKey])

  useEffect(() => {
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    const resizeObserver = new ResizeObserver(() => {
      canvas.width = container.clientWidth
      canvas.height = container.clientHeight
      drawRef.current()
    })

    resizeObserver.observe(container)
    canvas.width = container.clientWidth
    canvas.height = container.clientHeight
    drawRef.current()

    return () => resizeObserver.disconnect()
  }, [])

  useEffect(() => {
    if (move.copyCountPromptActive || transformExact.rotateCopyCountPromptActive) {
      return
    }

    if (operationDimEdit) {
      return
    }

    if (selection.mode !== 'sketch_edit' && !pendingMove && !pendingTransform && !pendingOffset && !pendingShapeAction) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      canvasRef.current?.focus({ preventScroll: true })
    })

    return () => window.cancelAnimationFrame(frame)
  }, [move.copyCountPromptActive, transformExact.rotateCopyCountPromptActive, operationDimEdit, pendingMove, pendingTransform, pendingOffset, pendingShapeAction, selection.mode, selection.selectedFeatureId, selection.selectedFeatureIds.length])

  // Native pointermove (not React's synthetic) so we can read coalesced events.
  const { isGestureActive: isGestureActiveRef } = useCanvasGestures({
    getCanvas: () => canvasRef.current,
    getViewState: () => viewStateRef.current,
    setViewState: (updater) => setViewState(updater),
    getBaseTransform: () => {
      const canvas = canvasRef.current
      if (!canvas) return { scale: 1, offsetX: 0, offsetY: 0 }
      const base = computeBaseViewTransform(projectRef.current.stock, canvas.width, canvas.height)
      return { scale: base.scale, offsetX: base.offsetX, offsetY: base.offsetY }
    },
    canvasToWorld: (cx, cy) => {
      const canvas = canvasRef.current
      if (!canvas) return { x: 0, y: 0 }
      const vt = computeViewTransform(projectRef.current.stock, canvas.width, canvas.height, viewStateRef.current)
      return canvasToWorld(cx, cy, vt)
    },
    minZoom: MIN_SKETCH_ZOOM,
  })

  function editableFeature(): SketchFeature | null {
    const selection = selectionRef.current
    const project = projectRef.current
    if (selection.mode !== 'sketch_edit') return null
    if (selection.selectedFeatureIds.length !== 1) return null
    if (!selection.selectedFeatureId) return null
    return resolveFeatureInstance(project, selection.selectedFeatureId)
      ?? (project.stock.sourceFeatureId === selection.selectedFeatureId && project.stock.sourceFeature
        ? resolveFeatureRow(project, project.stock.sourceFeature)
        : null)
  }

  function openEndpointAnchor(feature: SketchFeature, endpoint: OpenProfileEndpoint): Point { return endpoint === 'start' ? feature.sketch.profile.start : anchorPointForIndex(feature.sketch.profile, feature.sketch.profile.segments.length) }
  function endpointFromSketchExtension(kind: PendingSketchExtension['kind']): OpenProfileEndpoint { return kind === 'extend_start' ? 'start' : 'end' }

  function findOpenEndpointHit(
    rawPoint: Point,
    vt: ViewTransform,
    options?: {
      featureIds?: Set<string>
      exclude?: OpenEndpointHit | null
    },
  ): OpenEndpointHit | null {
    const project = projectRef.current
    const rawCanvas = worldToCanvas(rawPoint, vt)
    let best: OpenEndpointHit | null = null
    let bestDistance = OPEN_ENDPOINT_JOIN_HIT_RADIUS * OPEN_ENDPOINT_JOIN_HIT_RADIUS

    const features = resolvedProjectFeatures(project)
    for (let index = features.length - 1; index >= 0; index -= 1) {
      const feature = features[index]
      if (
        !feature
        || !feature.visible
        || feature.locked
        || feature.sketch.profile.closed
        || feature.sketch.profile.segments.length === 0
        || (options?.featureIds && !options.featureIds.has(feature.id))
      ) {
        continue
      }

      for (const endpoint of ['start', 'end'] as const) {
        if (
          options?.exclude
          && options.exclude.featureId === feature.id
          && options.exclude.endpoint === endpoint
        ) {
          continue
        }

        const anchor = openEndpointAnchor(feature, endpoint)
        const anchorCanvas = worldToCanvas(anchor, vt)
        const distance = distance2(rawCanvas, anchorCanvas)
        if (distance < bestDistance) {
          bestDistance = distance
          best = { featureId: feature.id, endpoint, anchor }
        }
      }
    }

    return best
  }

  function findSketchSegmentHit(profile: SketchFeature['sketch']['profile'], rawPoint: Point, vt: ViewTransform): SegmentHit | null {
    let best: SegmentHit | null = null
    let bestDistance = NODE_HIT_RADIUS * NODE_HIT_RADIUS

    for (let index = 0; index < profile.segments.length; index += 1) {
      const segment = profile.segments[index]
      if (segment.type === 'circle') {
        continue
      }

      const start = anchorPointForIndex(profile, index)
      const candidate = nearestPointOnSegmentWithT(rawPoint, start, segment, vt)
      if (candidate.distanceSqPx < bestDistance) {
        bestDistance = candidate.distanceSqPx
        best = { segmentIndex: index, point: candidate.point }
      }
    }

    return best
  }

  function editableClamp(): Clamp | null {
    const s = selectionRef.current; const p = projectRef.current
    if (s.mode !== 'sketch_edit') return null
    const node = s.selectedNode
    if (node?.type !== 'clamp') return null
    return p.clamps.find((c) => c.id === node.clampId) ?? null
  }

  function editableTab(): Tab | null {
    const s = selectionRef.current; const p = projectRef.current
    if (s.mode !== 'sketch_edit') return null
    const node = s.selectedNode
    if (node?.type !== 'tab') return null
    return p.tabs.find((t) => t.id === node.tabId) ?? null
  }

  function hitEditableControl(point: CanvasPoint, options?: { includeSegments?: boolean }): SketchControlRef | null {
    const feature = editableFeature()
    const clamp = editableClamp()
    const tab = editableTab()
    const canvas = canvasRef.current
    if (!canvas) return null

    const profile =
      feature
        ? feature.sketch.profile
        : clamp
          ? rectProfile(clamp.x, clamp.y, clamp.w, clamp.h)
          : tab
            ? rectProfile(tab.x, tab.y, tab.w, tab.h)
          : null
    if (!profile || (feature && feature.locked)) return null

    const vt = computeViewTransform(projectRef.current.stock, canvas.width, canvas.height, viewStateRef.current)
    const worldPoint = canvasToWorld(point.cx, point.cy, vt)
    const vertices = profileVertices(profile)
    let bestControl: SketchControlRef | null = null
    let bestDistanceSq = NODE_HIT_RADIUS * NODE_HIT_RADIUS

    for (let index = 0; index < vertices.length; index += 1) {
      const nodeCanvas = worldToCanvas(vertices[index], vt)
      const d2 = distance2(point, nodeCanvas)
      if (d2 <= bestDistanceSq) {
        bestDistanceSq = d2
        bestControl = { kind: 'anchor', index }
      }
    }

    for (let index = 0; index < profile.segments.length; index += 1) {
      const outgoingSegment = profile.segments[index]
      const incomingSegment =
        profile.closed
          ? profile.segments[(index - 1 + profile.segments.length) % profile.segments.length]
          : index > 0
            ? profile.segments[index - 1]
            : null

      if (outgoingSegment.type === 'bezier') {
        const handleCanvas = worldToCanvas(outgoingSegment.control1, vt)
        const d2 = distance2(point, handleCanvas)
        if (d2 <= Math.min(bestDistanceSq, HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS)) {
          bestDistanceSq = d2
          bestControl = { kind: 'out_handle', index }
        }
      }

      if (incomingSegment?.type === 'bezier') {
        const handleCanvas = worldToCanvas(incomingSegment.control2, vt)
        const d2 = distance2(point, handleCanvas)
        if (d2 <= Math.min(bestDistanceSq, HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS)) {
          bestDistanceSq = d2
          bestControl = { kind: 'in_handle', index }
        }
      }
    }

    for (let index = 0; index < profile.segments.length; index += 1) {
      const segment = profile.segments[index]
      if (segment.type === 'arc') {
        const handleCanvas = worldToCanvas(arcControlPoint(anchorPointForIndex(profile, index), segment), vt)
        const d2 = distance2(point, handleCanvas)
        if (d2 <= Math.min(bestDistanceSq, HANDLE_HIT_RADIUS * HANDLE_HIT_RADIUS)) {
          bestDistanceSq = d2
          bestControl = { kind: 'arc_handle', index }
        }
      }

      if (segment.type === 'circle') {
        const centerCanvas = worldToCanvas(segment.center, vt)
        const d2 = distance2(point, centerCanvas)
        if (d2 <= bestDistanceSq) {
          bestDistanceSq = d2
          bestControl = { kind: 'circle_center', index }
        }
      }
    }

    if (feature && options?.includeSegments !== false && !bestControl) {
      const segmentHitRadiusSq = NODE_HIT_RADIUS * NODE_HIT_RADIUS
      for (let index = 0; index < profile.segments.length; index += 1) {
        const segment = profile.segments[index]
        if (segment.type === 'circle') continue
        const start = anchorPointForIndex(profile, index)
        const candidate = nearestPointOnSegmentWithT(worldPoint, start, segment, vt)
        if (candidate.distanceSqPx <= Math.min(bestDistanceSq, segmentHitRadiusSq)) {
          bestDistanceSq = candidate.distanceSqPx
          bestControl = { kind: 'segment', index, t: candidate.t }
        }
      }
    }

    return bestControl
  }

  // Body of the live snap/preview effect above. Declared here (below the
  // edit-hit helpers it calls) and wrapped in `useStableEvent` so it keeps a
  // stable identity and never reads stale state.
  const runLivePointerPreview = useStableEvent(() => {
    const canvas = canvasRef.current
    const livePoint = livePointerWorldRef.current
    if (!canvas || !livePoint) {
      return
    }

    const project = projectRef.current
    const selection = selectionRef.current
    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingOffset = pendingOffsetRef.current
    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewStateRef.current)
    const pendingConstraintLive = pendingConstraintRef.current
    const constraintAnchorPicking = !!pendingConstraintLive && !pendingConstraintLive.anchor
    const constraintRefPicking = !!pendingConstraintLive && !!pendingConstraintLive.anchor && !pendingConstraintLive.reference
    const constraintPicking = constraintAnchorPicking || constraintRefPicking
    const resolvedSnap = snap.resolveCurrentSketchSnap(livePoint, vt, {
      excludeActiveEditGeometry: isDraggingNodeRef.current || constraintRefPicking,
    })
    const snapped = resolvedSnap.point
    const sketchEditTool = selection.sketchEditTool

    const shouldPreviewSnap =
      !!pendingAdd
      || !!pendingMove
      || !!pendingTransform
      || !!pendingOffset
      || (selection.mode === 'sketch_edit' && (sketchEditTool === 'add_point' || sketchEditTool === 'fillet' || sketchEditTool === 'chamfer' || sketchEditTool === 'trim' || sketchEditTool === 'extend'))
      || isDraggingNodeRef.current
      || constraintPicking

    snap.updateActiveSnap(shouldPreviewSnap ? resolvedSnap : null)

    if (pendingAdd) {
      if (pendingAdd.shape === 'origin') {
        originPreviewPointRef.current = { point: snapped, session: pendingAdd.session }
        scheduleDraw()
        return
      }
      setPendingPreviewPointRef({ point: snapped, session: pendingAdd.session })
      return
    }

    if (pendingMove) {
      const moveEdit = operationDimEditRef.current
      if ((moveEdit?.kind === 'move' || moveEdit?.kind === 'copy') && pendingMove.fromPoint) {
        const distance = parseLengthInput(moveEdit.distance, project.meta.units)
        const referencePoint = pendingMove.toPoint ?? pendingMovePreviewPointRef.current?.point ?? snapped
        setPendingMovePreviewPointRef({
          point: distance !== null
            ? computeMoveDistancePreviewPoint(pendingMove.fromPoint, referencePoint, distance)
            : referencePoint,
          session: pendingMove.session,
        })
        return
      }
      setPendingMovePreviewPointRef({ point: snapped, session: pendingMove.session })
      return
    }

    if (pendingTransform) {
      const constrainedPoint =
        pendingTransform.mode === 'resize' && pendingTransform.referenceStart && pendingTransform.referenceEnd
          ? projectPointOntoLine(snapped, pendingTransform.referenceStart, pendingTransform.referenceEnd)
          : snapped
      setPendingTransformPreviewPointRef({ point: constrainedPoint, session: pendingTransform.session })
      return
    }

    if (pendingOffset) {
      setPendingOffsetRawPreviewPointRef({ point: livePoint, session: pendingOffset.session })
      setPendingOffsetPreviewPointRef({ point: snapped, session: pendingOffset.session })
      return
    }

    if (selection.mode === 'sketch_edit' && selection.selectedNode?.type === 'feature' && selection.selectedFeatureId) {
      const feature = editableFeature()
      if (feature && sketchEditTool === 'add_point') {
        pendingSketchFilletRef.current = null
        fillet.setFilletCornerPicked(false)
        if (pendingSketchExtensionRef.current) {
          const sourceEndpoint = endpointFromSketchExtension(pendingSketchExtensionRef.current.kind)
          const targetEndpoint = findOpenEndpointHit(livePoint, vt, {
            exclude: {
              featureId: feature.id,
              endpoint: sourceEndpoint,
              anchor: pendingSketchExtensionRef.current.anchor,
            },
          })
          const lockedSnapped = applyLock(snapped, pendingSketchExtensionRef.current.anchor)
          sketchEditPreviewRef.current = { point: targetEndpoint?.anchor ?? lockedSnapped, mode: 'add_point' }
        } else {
          const endpoint = findOpenProfileExtensionEndpoint(feature.sketch.profile, livePoint, vt)
          if (endpoint) {
            sketchEditPreviewRef.current = { point: endpoint.anchor, mode: 'add_point' }
          } else {
            const target = findSketchInsertTarget(feature.sketch.profile, snapped, vt)
            sketchEditPreviewRef.current = target ? { point: target.point, mode: 'add_point' } : null
          }
        }
        scheduleDraw()
        return
      }

      if (feature && sketchEditTool === 'delete_segment') {
        pendingSketchExtensionRef.current = null
        pendingSketchFilletRef.current = null
        fillet.setFilletCornerPicked(false)
        const target = findSketchSegmentHit(feature.sketch.profile, livePoint, vt)
        sketchEditPreviewRef.current = target ? { point: target.point, mode: 'delete_segment' } : null
        scheduleDraw()
        return
      }

      if (feature && (sketchEditTool === 'trim' || sketchEditTool === 'extend')) {
        pendingSketchExtensionRef.current = null
        pendingExtendHitRef.current = null
        pendingTrimSpanRef.current = null
        pendingSketchFilletRef.current = null
        fillet.setFilletCornerPicked(false)
        const pending = pendingSketchEditRef.current
        if (pending && pending.phase === 'pick-subject') {
          const hit = segmentHitTest(livePoint, project, vt, { openOnly: true })
          sketchEditPreviewRef.current = hit
            ? { point: hit.point, mode: sketchEditTool }
            : null
        } else if (pending && pending.phase === 'pick-reference' && pending.subject) {
          // Keep subject point highlighted + show reference candidate
          const hit = segmentHitTest(livePoint, project, vt, { openOnly: false })
          sketchEditPreviewRef.current = hit
            ? { point: hit.point, mode: sketchEditTool }
            : { point: pending.subject.point, mode: sketchEditTool }

          // Extend preview: compute extension-line intersection for dashed preview
          if (sketchEditTool === 'extend' && hit) {
            const subjFeature = resolveFeatureInstance(project, pending.subject.featureId)
            if (subjFeature && !subjFeature.sketch.profile.closed) {
              const subjProfile = subjFeature.sketch.profile
              const subjSegIndex = pending.subject!.segmentIndex
              const segCount = subjProfile.segments.length
              const isFirst = subjSegIndex === 0
              const isLast = subjSegIndex === segCount - 1
              if (isFirst || isLast) {
                const subjT = pending.subject!.t ?? 0.5
                let growFromStart: boolean
                if (isFirst && isLast) {
                  growFromStart = subjT < 0.5
                } else if (isFirst) {
                  growFromStart = subjT < 0.5
                } else {
                  growFromStart = false
                }
                const growingPoint = growFromStart
                  ? subjProfile.start
                  : subjProfile.segments[segCount - 1].to
                const subjResolved = resolveProfileSegments(subjProfile)
                const subjSeg = subjResolved[subjSegIndex]
                if (subjSeg) {
                  const tgtFeature = resolveFeatureInstance(project, hit.featureId)
                  if (tgtFeature) {
                    const tgtResolved = resolveProfileSegments(
                      tgtFeature.sketch.profile,
                    )
                    const tgtSeg = tgtResolved[hit.segmentIndex]
                    if (tgtSeg) {
                      // Build extension ray
                      let extension: ResolvedSeg
                      const TWO_PI = 2 * Math.PI
                      if (subjSeg.kind === 'line') {
                        const dx = subjSeg.p1.x - subjSeg.p0.x
                        const dy = subjSeg.p1.y - subjSeg.p0.y
                        const len = Math.hypot(dx, dy)
                        if (len > 1e-9) {
                          const ux = dx / len
                          const uy = dy / len
                          if (growFromStart) {
                            extension = {
                              kind: 'line',
                              p0: growingPoint,
                              p1: {
                                x: growingPoint.x - ux * 1e5,
                                y: growingPoint.y - uy * 1e5,
                              },
                            }
                          } else {
                            extension = {
                              kind: 'line',
                              p0: growingPoint,
                              p1: {
                                x: growingPoint.x + ux * 1e5,
                                y: growingPoint.y + uy * 1e5,
                              },
                            }
                          }
                          const previewHits = segmentIntersections(
                            extension,
                            tgtSeg,
                            { rayA: true },
                          ).filter((h) => h.tA > 1e-9)
                          if (previewHits.length > 0) {
                            previewHits.sort((a, b) => a.tA - b.tA)
                            pendingExtendHitRef.current =
                              previewHits[0].point
                          }
                        }
                      } else {
                        // Arc
                        if (growFromStart) {
                          extension = {
                            ...subjSeg,
                            a0: subjSeg.a0,
                            a1: subjSeg.ccw
                              ? subjSeg.a0 - TWO_PI
                              : subjSeg.a0 + TWO_PI,
                            ccw: !subjSeg.ccw,
                          }
                        } else {
                          extension = {
                            ...subjSeg,
                            a0: subjSeg.a1,
                            a1: subjSeg.ccw
                              ? subjSeg.a1 + TWO_PI
                              : subjSeg.a1 - TWO_PI,
                          }
                        }
                        const previewHits = segmentIntersections(
                          extension,
                          tgtSeg,
                          { rayA: true },
                        ).filter((h) => h.tA > 1e-9)
                        if (previewHits.length > 0) {
                          previewHits.sort((a, b) => a.tA - b.tA)
                          pendingExtendHitRef.current =
                            previewHits[0].point
                        }
                      }
                    }
                  }
                }
              }
            }
          }

          // Trim preview: compute span that would be removed
          if (sketchEditTool === 'trim' && hit && pending.subject) {
            const trimSubjFeature = resolveFeatureInstance(project, pending.subject.featureId)
            if (trimSubjFeature && !trimSubjFeature.sketch.profile.closed) {
              const trimProfile = trimSubjFeature.sketch.profile
              const trimSegIndex = pending.subject.segmentIndex
              const segCount = trimProfile.segments.length
              const isFirst = trimSegIndex === 0
              const isLast = trimSegIndex === segCount - 1
              const trimSubjResolved = resolveProfileSegments(trimProfile)
              const trimSubjSeg = trimSubjResolved[trimSegIndex]
              if (trimSubjSeg) {
                const trimTgtFeature = resolveFeatureInstance(project, hit.featureId)
                if (trimTgtFeature) {
                  const trimTgtResolved = resolveProfileSegments(
                    trimTgtFeature.sketch.profile,
                  )
                  const trimTgtSeg = trimTgtResolved[hit.segmentIndex]
                  if (trimTgtSeg) {
                    const trimHits = segmentIntersections(trimSubjSeg, trimTgtSeg)
                    if (trimHits.length === 1) {
                      const h = trimHits[0]
                      const clickT = pending.subject.t ?? 0.5
                      const clickBefore = clickT < h.tA

                      if ((isFirst && clickBefore) || (isLast && !clickBefore)) {
                        if (isFirst && clickBefore) {
                          pendingTrimSpanRef.current = {
                            from: trimProfile.start,
                            to: h.point,
                          }
                        } else if (isLast && !clickBefore) {
                          pendingTrimSpanRef.current = {
                            from: h.point,
                            to: trimProfile.segments[segCount - 1].to,
                          }
                        }
                      }
                    } else if (trimHits.length >= 2) {
                      const sorted = [...trimHits].sort((a, b) => a.tA - b.tA)
                      const t0 = sorted[0].tA
                      const t1 = sorted[sorted.length - 1].tA
                      const clickT = pending.subject.t ?? 0.5
                      if (clickT <= t0 && isFirst) {
                        pendingTrimSpanRef.current = {
                          from: trimProfile.start,
                          to: sorted[0].point,
                        }
                      } else if (clickT >= t1 && isLast) {
                        pendingTrimSpanRef.current = {
                          from: sorted[sorted.length - 1].point,
                          to: trimProfile.segments[segCount - 1].to,
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
        scheduleDraw()
        return
      }

      if (feature && sketchEditTool === 'disconnect') {
        pendingSketchExtensionRef.current = null
        pendingSketchFilletRef.current = null
        fillet.setFilletCornerPicked(false)
        const control = hitEditableControl(worldToCanvas(livePoint, vt), { includeSegments: false })
        sketchEditPreviewRef.current =
          control?.kind === 'anchor'
            ? { point: anchorPointForIndex(feature.sketch.profile, control.index), mode: 'disconnect' }
            : null
        scheduleDraw()
        return
      }

      if (feature && (sketchEditTool === 'fillet' || sketchEditTool === 'chamfer')) {
        pendingSketchExtensionRef.current = null
        if (pendingSketchFilletRef.current) {
          sketchEditPreviewRef.current = { point: snapped, mode: 'add_point' }
        }
        scheduleDraw()
      }
    }
  })

  // Recompute the live snap/preview when interaction state changes. Declared
  // here (with its `runLivePointerPreview` body, below the edit-hit helpers it
  // calls) so the dep list stays honest without tripping the compiler's
  // "accessed before declared" rule. Effect ordering is immaterial: the body
  // only updates preview refs consumed by the next animation-frame redraw.
  useEffect(() => {
    runLivePointerPreview()
  }, [runLivePointerPreview, snapSettings, viewState, pendingAdd, pendingMove, pendingTransform, pendingOffset, selection.mode, selection.sketchEditTool, selection.selectedFeatureId, selection.selectedNode])

  // Called by the "Type" button in banners — opens dimension input without
  // the Tab toggle-close behaviour. Keyboard Tab keeps its existing logic.
  function triggerDimensionEdit() {
    triggerDimensionEditFn({
      project: projectRef.current,
      pendingAdd: pendingAddRef.current,
      pendingMove: pendingMoveRef.current,
      pendingTransform: pendingTransformRef.current,
      pendingOffset: pendingOffsetRef.current,
      selectionMode: selectionRef.current.mode,
      selectedFeatureId: selectionRef.current.selectedFeatureId,
      sketchEditTool: selectionRef.current.sketchEditTool,
      pendingPreviewPoint: pendingPreviewPointRef.current,
      pendingMovePreviewPoint: pendingMovePreviewPointRef.current,
      pendingTransformPreviewPoint: pendingTransformPreviewPointRef.current,
      pendingOffsetRawPreviewPoint: pendingOffsetRawPreviewPointRef.current,
      pendingOffsetPreviewPoint: pendingOffsetPreviewPointRef.current,
      sketchEditPreviewPoint: sketchEditPreviewRef.current,
      pendingSketchFillet: pendingSketchFilletRef.current,
      units: projectRef.current.meta.units,
      canvasWidth: canvasRef.current?.width ?? 0,
      canvasHeight: canvasRef.current?.height ?? 0,
      viewState: viewStateRef.current,
      activeSnapMode: snap.activeSnapRef.current?.mode ?? null,
      dimEdit,
      move,
      setOperationDimEdit,
      fillet,
    })
  }

  const overlapFeaturePicker = useOverlapFeaturePicker({
    containerRef,
    canvasRef,
    clearTransientCanvasState,
    selectFeature,
    hoverFeature,
  })

  const keyboard = useCanvasKeyboard({
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
    activeSnapRef: snap.activeSnapRef,
    pendingSketchFilletRef,
    sketchEditPreviewRef,
    originPreviewPointRef,
    hoveredEditControlRef,
    canvasRef,
    overlapFeaturePickerOpen: overlapFeaturePicker.isOpen,
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
    cancelOverlapFeaturePicker: overlapFeaturePicker.cancel,
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
  })

  const gestures = usePointerGestures({
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
    pendingMovePreviewPointRef,
    pendingConstraintRef,
    pendingDimensionRef,
    pendingClipboardPlacementRef,
    dimensionDeleteArmedRef,
    deleteHoverDimIdRef,
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
    pendingPreviewPointRef,
    setPendingPreviewPointRef,
    setPendingMovePreviewPointRef,
    setPendingTransformPreviewPointRef,
    setPendingOffsetPreviewPointRef,
    setPendingOffsetRawPreviewPointRef,
    setClipboardPlacementPreviewPoint,
    setHoveredEditControl,
    zoomWindowActive,
    onZoomWindowComplete,
  })

  const clickPlacement = useClickPlacement({
    suppressClickRef,
    didPanRef,
    isDraggingNodeRef,
    zoomWindowActive,
    multiSelectMode,
    clearOverlapFeaturePicker: overlapFeaturePicker.dismiss,
    openOverlapFeaturePicker: overlapFeaturePicker.open,
    selectionRef,
    projectRef,
    pendingAddRef,
    pendingMoveRef,
    pendingTransformRef,
    pendingOffsetRef,
    pendingShapeActionRef,
    viewStateRef,
    pendingConstraintRef,
    pendingSketchEditRef,
    pendingDimensionRef,
    dimensionDeleteArmedRef,
    deleteHoverDimIdRef,
    selectedAnnotationIdRef,
    pendingSketchExtensionRef,
    pendingSketchFilletRef,
    sketchEditPreviewRef,
    pendingClipboardPlacementRef,
    originPreviewPointRef,
    tapeMeasureRef,
    constraintLabelRectsRef,
    stockLabelRectsRef,
    canvasRef,
    snap,
    dimEdit,
    drivingWf,
    move,
    transformExact,
    fillet,
    constraint,
    canvasCoordinates: gestures.canvasCoordinates,
    editableFeature,
    endpointFromSketchExtension,
    findOpenEndpointHit,
    findSketchSegmentHit,
    hitEditableControl,
    scheduleDraw,
    applyLock,
    setPendingPreviewPointRef,
    setPendingMovePreviewPointRef,
    setPendingTransformPreviewPointRef,
    setPendingOffsetPreviewPointRef,
    setPendingOffsetRawPreviewPointRef,
    setClipboardPlacementPreviewPoint,
    tapeMeasureClick,
    placeClipboardAt,
    cancelPendingDimension,
    addDimensionAnnotation,
    pendingDimensionPick,
    deleteDimensionAnnotation,
    selectAnnotation,
    selectFeature,
    selectTab,
    selectClamp,
    selectBackdrop,
    setConstraintAnchor,
    setConstraintReference,
    insertFeaturePoint,
    joinOpenFeatureEndpoints,
    deleteFeaturePoint,
    deleteFeatureSegment,
    disconnectFeaturePoint,
    filletFeaturePoint,
    chamferFeaturePoint,
    setPendingSketchSubject,
    cancelPendingSketchEdit,
    trimFeatureSegment,
    extendFeatureEndpoint,
    setPendingAddAnchor,
    placePendingAddAt,
    placePendingSlotAt,
    placePendingNgonAt,
    setPendingGearRadiusAt,
    placePendingTextAt,
    placeOriginAt,
    addPendingPolygonPoint,
    completePendingPolygon,
    addPendingCompositePoint,
    completePendingComposite,
    setPendingMoveFrom,
    setPendingTransformReferenceStart,
    setPendingTransformReferenceEnd,
    completePendingTransform,
    completePendingOffset,
    cancelPendingOffset,
    beginHistoryTransaction,
  })

  const editingFeature =
    selection.mode === 'sketch_edit' && selection.selectedFeatureId
      ? resolveFeatureInstance(project, selection.selectedFeatureId) ??
        (project.stock.sourceFeatureId === selection.selectedFeatureId && project.stock.sourceFeature
          ? resolveFeatureRow(project, project.stock.sourceFeature)
          : null)
      : null
  const editingClamp = (() => {
    if (selection.mode !== 'sketch_edit') return null
    const selectedNode = selection.selectedNode
    if (selectedNode?.type !== 'clamp') return null
    return project.clamps.find((clamp) => clamp.id === selectedNode.clampId) ?? null
  })()
  const editingTab = (() => {
    if (selection.mode !== 'sketch_edit') return null
    const selectedNode = selection.selectedNode
    if (selectedNode?.type !== 'tab') return null
    return project.tabs.find((tab) => tab.id === selectedNode.tabId) ?? null
  })()
  const editingFeatureHasSelfIntersection =
    editingFeature ? profileHasSelfIntersection(editingFeature.sketch.profile) : false
  const editingFeatureExceedsStock =
    editingFeature
      ? profileExceedsStock(editingFeature.sketch.profile, project.stock)
      : editingClamp
        ? profileExceedsStock(rectProfile(editingClamp.x, editingClamp.y, editingClamp.w, editingClamp.h), project.stock)
        : editingTab
          ? profileExceedsStock(rectProfile(editingTab.x, editingTab.y, editingTab.w, editingTab.h), project.stock)
        : false
  const pendingDraftProfile =
    buildPendingDraftProfile(
      pendingAdd,
      pendingAdd && pendingPreviewPointRef.current?.session === pendingAdd.session
        ? pendingPreviewPointRef.current.point
        : null,
      project.meta.units,
    )
  const pendingDraftHasSelfIntersection =
    pendingDraftProfile ? profileHasSelfIntersection(pendingDraftProfile) : false
  const pendingDraftExceedsStock =
    pendingDraftProfile ? profileExceedsStock(pendingDraftProfile, project.stock) : false

  return (
    <div ref={containerRef} className="sketch-canvas-container">
      <canvas
        ref={canvasRef}
        className={`sketch-canvas ${pendingAdd || pendingMove || pendingTransform || pendingOffset || pendingShapeAction || pendingClipboardPlacement ? 'sketch-canvas--placing' : ''}`}
        onPointerDown={gestures.handlePointerDown}
        onPointerUp={gestures.handlePointerUp}
        onPointerCancel={gestures.handlePointerUp}
        onPointerLeave={gestures.handlePointerLeave}
        onClick={clickPlacement.handleClick}
        onDoubleClick={gestures.handleDoubleClick}
        onKeyDown={keyboard.handleKeyDown}
        onContextMenu={contextMenu.handleContextMenu}
        tabIndex={0}
      />
      <OverlapFeaturePicker picker={overlapFeaturePicker} />
      <CreationTargetBadge />
      {!depthLegendCollapsed ? <DepthLegend onToggleDepthLegend={onToggleDepthLegend} /> : null}
      {(toolpaths && toolpaths.some((tp) => tp.moves.length > 0)) && toolpathVisibility && onToolpathVisibilityChange && (
        <ToolpathVisibilityPanel
          visibility={toolpathVisibility}
          onChange={onToolpathVisibilityChange}
          className="sketch-toolpath-vis"
        />
      )}
      <ConstraintEditPanel constraint={constraint} />
      <DrivingDimensionPanel driving={drivingWf} />
      {pendingOffset && (
        <CanvasWorkflowPanel
          title={t('canvas.offset.title')}
          step={offset.offsetDistanceEditActive ? t('canvas.offset.step.setDistance') : t('canvas.offset.step.previewDistance')}
          position={offset.offsetWorkflowPanel.position}
          panelRef={offset.offsetWorkflowPanel.panelRef}
          handleProps={offset.offsetWorkflowPanel.handleProps}
          actionRowProps={offset.offsetWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--offset"
          moveLabel={t('canvas.offset.moveLabel')}
          actions={(
            <>
              {offset.offsetDistanceEditActive ? (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={offset.commitOffsetDistanceEditFromPanel}
                >{t('canvas.offset.confirm')}</button>
              ) : (
                <button
                  type="button"
                  className="tablet-cmd-btn"
                  onClick={offset.triggerDimensionFromOffsetPanel}
                >{t('canvas.offset.distanceButton')}</button>
              )}
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={offset.cancelOffsetFromPanel}
              >{t('canvas.offset.cancel')}</button>
            </>
          )}
        >
          {offset.offsetDistanceEditActive && operationDimEdit?.kind === 'offset' ? (
            <div className="canvas-workflow-panel__meta">
              <label className="canvas-workflow-panel__field">
                <span>{t('canvas.field.distance')}</span>
                <input
                  ref={dimEdit.widthInputRef}
                  className="canvas-workflow-panel__count-input"
                  type="text"
                  inputMode="decimal"
                  value={operationDimEdit.distance}
                  onChange={(event) => setOperationDimEdit({ kind: 'offset', distance: event.target.value })}
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      offset.commitOffsetDistanceEditFromPanel()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      offset.cancelOffsetFromPanel()
                    }
                  }}
                  autoFocus
                />
              </label>
            </div>
          ) : (
            <div className="canvas-workflow-panel__summary">
              {t('canvas.offset.summary')}
            </div>
          )}
        </CanvasWorkflowPanel>
      )}
      {showJoinFlowPanel && pendingShapeAction?.kind === 'join' && (
        <CanvasWorkflowPanel
          title={t('canvas.join.title')}
          step={t('canvas.join.step.selectFeatures')}
          position={joinWorkflowPanel.position}
          panelRef={joinWorkflowPanel.panelRef}
          handleProps={joinWorkflowPanel.handleProps}
          actionRowProps={joinWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--join"
          moveLabel={t('canvas.join.moveLabel')}
          actions={(
            <>
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--confirm"
                disabled={pendingShapeAction.entityIds.length < 2}
                onClick={completeJoinFromPanel}
              >{t('canvas.join.confirm')}</button>
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={cancelJoinFromPanel}
              >{t('canvas.join.cancel')}</button>
            </>
          )}
        >
          <div className="canvas-workflow-panel__summary">
            {pendingShapeAction.entityIds.length < 2
              ? t('canvas.join.summary.tooFew')
              : tPlural(pendingShapeAction.entityIds.length, 'canvas.join.summary.count.one', 'canvas.join.summary.count.other')}
          </div>
          <div className="canvas-workflow-panel__meta">
            <label className="canvas-workflow-panel__check">
              <input
                type="checkbox"
                checked={pendingShapeAction.keepOriginals}
                onChange={(event) => {
                  setPendingShapeActionKeepOriginals(event.target.checked)
                  joinWorkflowPanel.focusCanvasAfterAction()
                }}
              />
              <span>{t('canvas.join.keepOriginals')}</span>
            </label>
          </div>
        </CanvasWorkflowPanel>
      )}
      {showCutFlowPanel && pendingShapeAction?.kind === 'cut' && (
        <CanvasWorkflowPanel
          title={t('canvas.cut.title')}
          step={pendingShapeAction.phase === 'cutters' ? t('canvas.cut.step.selectCutters') : t('canvas.cut.step.selectTargets')}
          position={cutWorkflowPanel.position}
          panelRef={cutWorkflowPanel.panelRef}
          handleProps={cutWorkflowPanel.handleProps}
          actionRowProps={cutWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--cut"
          moveLabel={t('canvas.cut.moveLabel')}
          actions={(
            <>
              {pendingShapeAction.phase === 'cutters' ? (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  disabled={pendingShapeAction.cutterIds.length === 0}
                  onClick={confirmCutCuttersFromTabletPanel}
                >{t('canvas.cut.next')}</button>
              ) : (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  disabled={pendingShapeAction.targetIds.length === 0}
                  onClick={completeCutFromTabletPanel}
                >{t('canvas.cut.confirm')}</button>
              )}
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={cancelCutFromTabletPanel}
              >{t('canvas.cut.cancel')}</button>
            </>
          )}
        >
          <div className="canvas-workflow-panel__summary">
            {pendingShapeAction.phase === 'cutters'
              ? pendingShapeAction.cutterIds.length === 0
                ? t('canvas.cut.summary.noCutters')
                : tPlural(pendingShapeAction.cutterIds.length, 'canvas.cut.summary.cutters.one', 'canvas.cut.summary.cutters.other')
              : pendingShapeAction.targetIds.length === 0
                ? tPlural(pendingShapeAction.cutterIds.length, 'canvas.cut.summary.cuttersLocked.one', 'canvas.cut.summary.cuttersLocked.other')
                : tPlural(pendingShapeAction.targetIds.length, 'canvas.cut.summary.targets.one', 'canvas.cut.summary.targets.other')}
          </div>
          <div className="canvas-workflow-panel__meta">
            <label className="canvas-workflow-panel__check">
              <input
                type="checkbox"
                checked={pendingShapeAction.keepOriginals}
                onChange={(event) => {
                  setPendingShapeActionKeepOriginals(event.target.checked)
                  cutWorkflowPanel.focusCanvasAfterAction()
                }}
              />
              <span>{t('canvas.cut.keepOriginals')}</span>
            </label>
          </div>
        </CanvasWorkflowPanel>
      )}
      {creation.creationPanelShape && pendingAdd && (
        <CanvasWorkflowPanel
          title={
            creation.creationPanelShape === 'rect' ? t('canvas.shape.rectangle')
            : creation.creationPanelShape === 'circle' ? t('canvas.shape.circle')
            : creation.creationPanelShape === 'ellipse' ? t('canvas.shape.ellipse')
            : creation.creationPanelShape === 'tab' ? t('canvas.shape.tab')
            : creation.creationPanelShape === 'clamp' ? t('canvas.shape.clamp')
            : creation.creationPanelShape === 'polygon' ? t('canvas.shape.polygon')
            : creation.creationPanelShape === 'spline' ? t('canvas.shape.spline')
            : creation.creationPanelShape === 'slot' ? t('canvas.shape.slot')
            : creation.creationPanelShape === 'ngon' ? t('canvas.shape.polygon')
            : creation.creationPanelShape === 'gear' ? t('canvas.shape.gear')
            : creation.creationPanelShape === 'roundrect' ? t('canvas.shape.roundedRectangle')
            : creation.creationPanelShape === 'chamferrect' ? t('canvas.shape.chamferedRectangle')
            : t('canvas.shape.composite')
          }
          step={
            creation.creationDimEditActive ? t('canvas.creation.step.enterDimensions')
            : creation.creationPanelShape === 'composite'
              ? (pendingAdd.shape === 'composite' && pendingAdd.start
                ? (pendingAdd.currentMode === 'arc' && pendingAdd.pendingArcEnd
                  ? t('canvas.creation.step.clickArcCurvature')
                  : t('canvas.creation.step.addPoints', { mode: pendingAdd.currentMode }))
                : t('canvas.creation.step.clickFirstPoint'))
            : (creation.creationPanelShape === 'polygon' || creation.creationPanelShape === 'spline')
              ? (creation.creationPanelHasPoints
                ? ('points' in pendingAdd && pendingAdd.points.length < 2
                  ? t('canvas.creation.step.addOneMore')
                  : t('canvas.creation.step.addPointsOrClose'))
                : t('canvas.creation.step.clickFirstPoint'))
            : creation.creationPanelShape === 'slot'
              ? (pendingAdd.shape === 'slot' && pendingAdd.points.length >= 2
                ? t('canvas.creation.step.slotSetWidth')
                : pendingAdd.shape === 'slot' && pendingAdd.points.length === 1
                  ? t('canvas.creation.step.slotSecondEnd')
                  : t('canvas.creation.step.slotFirstEnd'))
            : creation.creationPanelShape === 'gear'
              ? (pendingAdd.shape === 'gear' && pendingAdd.outsideRadius !== null ? t('canvas.creation.step.gearParams') : pendingAdd.shape === 'gear' && pendingAdd.anchor ? t('canvas.creation.step.gearSetRadius') : t('canvas.creation.step.clickCenterPoint'))
            : creation.creationPanelHasAnchor
              ? (creation.creationPanelShape === 'circle'
                ? t('canvas.creation.step.setRadiusOrDimensions')
                : creation.creationPanelShape === 'ellipse'
                  ? t('canvas.creation.step.setRadiiOrDimensions')
                  : creation.creationPanelShape === 'ngon'
                    ? t('canvas.creation.step.setRadius')
                    : t('canvas.creation.step.setCornerOrDimensions'))
              : (creation.creationPanelShape === 'circle' || creation.creationPanelShape === 'ellipse' || creation.creationPanelShape === 'ngon')
                ? t('canvas.creation.step.clickCenterPoint')
                : t('canvas.creation.step.clickFirstCorner')
          }
          position={creation.creationWorkflowPanel.position}
          panelRef={creation.creationWorkflowPanel.panelRef}
          handleProps={creation.creationWorkflowPanel.handleProps}
          actionRowProps={creation.creationWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--creation"
          moveLabel={t('canvas.creation.moveLabel')}
          actions={(
            <>
              {creation.creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={creation.commitCreationDimensionEdit}
                >{t('canvas.common.confirm')}</button>
              )}
              {(pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline') && 'points' in pendingAdd && pendingAdd.points.length >= 2 && creationTarget !== 'region' && !creation.creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={creation.finishOpenPathFromPanel}
                >{t('canvas.common.finish')}</button>
              )}
              {pendingAdd.shape === 'composite' && pendingAdd.segments.length >= 1 && !pendingAdd.pendingArcEnd && creationTarget !== 'region' && !creation.creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={creation.finishOpenCompositeFromPanel}
                >{t('canvas.common.finish')}</button>
              )}
              {pendingAdd.shape === 'gear' && pendingAdd.outsideRadius !== null && !creation.creationDimEditActive && (<button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={creation.completeGearFromPanel}>{t('canvas.creation.confirmGear')}</button>)}
              {creation.creationCanDimEdit && !creation.creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn"
                  onClick={creation.triggerDimensionFromCreationPanel}
                >{pendingAdd.shape === 'slot' && 'points' in pendingAdd && pendingAdd.points.length >= 2 ? t('canvas.creation.widthButton') : (pendingAdd.shape === 'ngon' || pendingAdd.shape === 'gear') ? t('canvas.creation.radiusButton') : t('canvas.creation.dimensionsButton')}</button>
              )}
              {((creation.creationPanelHasPoints && pendingAdd.shape !== 'slot') || (pendingAdd.shape === 'composite' && pendingAdd.start)) && !creation.creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn"
                  onClick={creation.undoFromCreationPanel}
                >{t('canvas.common.undo')}</button>
              )}
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={creation.cancelCreationFromPanel}
              >{t('canvas.common.cancel')}</button>
            </>
          )}
        >
          {pendingAdd.shape === 'composite' && pendingAdd.start && !pendingAdd.closed && !creation.creationDimEditActive && (
            <div className="canvas-workflow-panel__meta canvas-workflow-panel__mode-row">
              <button
                type="button"
                className={`tablet-cmd-btn ${pendingAdd.currentMode === 'line' ? 'tablet-cmd-btn--active' : ''}`}
                onClick={() => creation.setCompositeModeFromPanel('line')}
              >{t('canvas.composite.mode.line')}</button>
              <button
                type="button"
                className={`tablet-cmd-btn ${pendingAdd.currentMode === 'arc' ? 'tablet-cmd-btn--active' : ''}`}
                onClick={() => creation.setCompositeModeFromPanel('arc')}
              >{t('canvas.composite.mode.arc')}</button>
              <button
                type="button"
                className={`tablet-cmd-btn ${pendingAdd.currentMode === 'spline' ? 'tablet-cmd-btn--active' : ''}`}
                onClick={() => creation.setCompositeModeFromPanel('spline')}
              >{t('canvas.composite.mode.spline')}</button>
            </div>
          )}
          {creation.creationDimEditActive && dimEdit.dimensionEdit && (
            <div className="canvas-workflow-panel__meta">
              {dimEdit.dimensionEdit.shape === 'circle' ? (
                <label className="canvas-workflow-panel__field">
                  <span>{t('canvas.field.radius')}</span>
                  <input
                    ref={dimEdit.radiusInputRef}
                    className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                    type="text"
                    inputMode="decimal"
                    value={dimEdit.dimensionEdit.radius}
                    onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, radius: e.target.value } : null)}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        creation.commitCreationDimensionEdit()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        creation.cancelCreationDimensionEdit()
                      }
                    }}
                    autoFocus
                  />
                </label>
              ) : (dimEdit.dimensionEdit.shape === 'composite' && dimEdit.dimensionEdit.arcStart && dimEdit.dimensionEdit.arcEnd) ? (
                <label className="canvas-workflow-panel__field">
                  <span>{t('canvas.field.radius')}</span>
                  <input
                    ref={dimEdit.radiusInputRef}
                    className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                    type="text"
                    inputMode="decimal"
                    value={dimEdit.dimensionEdit.radius}
                    onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, radius: e.target.value } : null)}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        creation.commitCreationDimensionEdit()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        creation.cancelCreationDimensionEdit()
                      }
                    }}
                    autoFocus
                  />
                </label>
              ) : (dimEdit.dimensionEdit.shape === 'polygon' || dimEdit.dimensionEdit.shape === 'spline' || dimEdit.dimensionEdit.shape === 'composite') ? (
                <>
                  <label className="canvas-workflow-panel__field">
                    <span>{t('canvas.field.length')}</span>
                    <input
                      ref={dimEdit.widthInputRef}
                      className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                      type="text"
                      inputMode="decimal"
                      value={dimEdit.dimensionEdit.length}
                      onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, length: e.target.value } : null)}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          creation.commitCreationDimensionEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          creation.cancelCreationDimensionEdit()
                        } else if (e.key === 'Tab') {
                          e.preventDefault()
                          dimEdit.heightInputRef.current?.focus({ preventScroll: true })
                        }
                      }}
                      autoFocus
                    />
                  </label>
                  <label className="canvas-workflow-panel__field">
                    <span>{t('canvas.field.angle')}</span>
                    <input
                      ref={dimEdit.heightInputRef}
                      className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                      type="text"
                      inputMode="decimal"
                      value={dimEdit.dimensionEdit.angle}
                      onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, angle: e.target.value } : null)}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          creation.commitCreationDimensionEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          creation.cancelCreationDimensionEdit()
                        } else if (e.key === 'Tab') {
                          e.preventDefault()
                          if (pendingAdd?.shape === 'composite' && pendingAdd.currentMode === 'arc' && !pendingAdd.pendingArcEnd) {
                            dimEdit.radiusInputRef.current?.focus({ preventScroll: true })
                          } else {
                            dimEdit.widthInputRef.current?.focus({ preventScroll: true })
                          }
                        }
                      }}
                    />
                  </label>
                  {pendingAdd?.shape === 'composite' && pendingAdd.currentMode === 'arc' && !pendingAdd.pendingArcEnd && (
                    <label className="canvas-workflow-panel__field">
                      <span>{t('canvas.field.radius')}</span>
                      <input
                        ref={dimEdit.radiusInputRef}
                        className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                        type="text"
                        inputMode="decimal"
                        value={dimEdit.dimensionEdit.radius}
                        onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, radius: e.target.value } : null)}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            creation.commitCreationDimensionEdit()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            creation.cancelCreationDimensionEdit()
                          } else if (e.key === 'Tab') {
                            e.preventDefault()
                            dimEdit.widthInputRef.current?.focus({ preventScroll: true })
                          }
                        }}
                      />
                    </label>
                  )}
                </>
              ) : dimEdit.dimensionEdit.shape === 'slot' ? (
                dimEdit.dimensionEdit.arcEnd ? (
                  <label className="canvas-workflow-panel__field">
                    <span>{t('canvas.field.width')}</span>
                    <input
                      ref={dimEdit.widthInputRef}
                      className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                      type="text"
                      inputMode="decimal"
                      value={dimEdit.dimensionEdit.width}
                      onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, width: e.target.value } : null)}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') { e.preventDefault(); creation.commitCreationDimensionEdit() }
                        else if (e.key === 'Escape') { e.preventDefault(); creation.cancelCreationDimensionEdit() }
                      }}
                      autoFocus
                    />
                  </label>
                ) : (
                  <>
                    <label className="canvas-workflow-panel__field">
                      <span>{t('canvas.field.length')}</span>
                      <input
                        ref={dimEdit.widthInputRef}
                        className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                        type="text"
                        inputMode="decimal"
                        value={dimEdit.dimensionEdit.length}
                        onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, length: e.target.value } : null)}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') { e.preventDefault(); creation.commitCreationDimensionEdit() }
                          else if (e.key === 'Escape') { e.preventDefault(); creation.cancelCreationDimensionEdit() }
                          else if (e.key === 'Tab') { e.preventDefault(); dimEdit.heightInputRef.current?.focus({ preventScroll: true }) }
                        }}
                        autoFocus
                      />
                    </label>
                    <label className="canvas-workflow-panel__field">
                      <span>{t('canvas.field.angleDeg')}</span>
                      <input
                        ref={dimEdit.heightInputRef}
                        className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                        type="text"
                        inputMode="decimal"
                        value={dimEdit.dimensionEdit.angle}
                        onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, angle: e.target.value } : null)}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') { e.preventDefault(); creation.commitCreationDimensionEdit() }
                          else if (e.key === 'Escape') { e.preventDefault(); creation.cancelCreationDimensionEdit() }
                          else if (e.key === 'Tab') { e.preventDefault(); dimEdit.radiusInputRef.current?.focus({ preventScroll: true }) }
                        }}
                      />
                    </label>
                    <label className="canvas-workflow-panel__field">
                      <span>{t('canvas.field.width')}</span>
                      <input
                        ref={dimEdit.radiusInputRef}
                        className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                        type="text"
                        inputMode="decimal"
                        value={dimEdit.dimensionEdit.radius}
                        onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, radius: e.target.value } : null)}
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          e.stopPropagation()
                          if (e.key === 'Enter') { e.preventDefault(); creation.commitCreationDimensionEdit() }
                          else if (e.key === 'Escape') { e.preventDefault(); creation.cancelCreationDimensionEdit() }
                          else if (e.key === 'Tab') { e.preventDefault(); creation.cancelCreationDimensionEdit() }
                        }}
                      />
                    </label>
                  </>
                )
              ) : (dimEdit.dimensionEdit.shape === 'ngon' || dimEdit.dimensionEdit.shape === 'gear') ? (
                <label className="canvas-workflow-panel__field">
                  <span>{t('canvas.field.radius')}</span>
                  <input
                    ref={dimEdit.radiusInputRef}
                    className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                    type="text"
                    inputMode="decimal"
                    value={dimEdit.dimensionEdit.radius}
                    onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, radius: e.target.value } : null)}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') { e.preventDefault(); creation.commitCreationDimensionEdit() }
                      else if (e.key === 'Escape') { e.preventDefault(); creation.cancelCreationDimensionEdit() }
                    }}
                    autoFocus
                  />
                </label>
              ) : (
                <>
                  <label className="canvas-workflow-panel__field">
                    <span>{t('canvas.field.width')}</span>
                    <input
                      ref={dimEdit.widthInputRef}
                      className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                      type="text"
                      inputMode="decimal"
                      value={dimEdit.dimensionEdit.width}
                      onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, width: e.target.value } : null)}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          creation.commitCreationDimensionEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          creation.cancelCreationDimensionEdit()
                        } else if (e.key === 'Tab') {
                          e.preventDefault()
                          dimEdit.heightInputRef.current?.focus({ preventScroll: true })
                        }
                      }}
                      autoFocus
                    />
                  </label>
                  <label className="canvas-workflow-panel__field">
                    <span>{t('canvas.field.height')}</span>
                    <input
                      ref={dimEdit.heightInputRef}
                      className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                      type="text"
                      inputMode="decimal"
                      value={dimEdit.dimensionEdit.height}
                      onChange={(e) => dimEdit.setDimensionEdit((prev) => prev ? { ...prev, height: e.target.value } : null)}
                      onFocus={(e) => e.currentTarget.select()}
                      onKeyDown={(e) => {
                        e.stopPropagation()
                        if (e.key === 'Enter') {
                          e.preventDefault()
                          creation.commitCreationDimensionEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          creation.cancelCreationDimensionEdit()
                        } else if (e.key === 'Tab') {
                          e.preventDefault()
                          dimEdit.widthInputRef.current?.focus({ preventScroll: true })
                        }
                      }}
                    />
                  </label>
                </>
              )}
            </div>
          )}
          {pendingAdd.shape === 'gear' && !creation.creationDimEditActive && (<GearParameterPanel pendingAdd={pendingAdd} units={project.meta.units} setPendingGearParams={setPendingGearParams} />)}
          {pendingAdd.shape === 'ngon' && !creation.creationDimEditActive && (
            <NgonParameterPanel pendingAdd={pendingAdd} setPendingNgonSides={setPendingNgonSides} />
          )}
          {(pendingAdd.shape === 'roundrect' || pendingAdd.shape === 'chamferrect') && !creation.creationDimEditActive && (
            <RectCornerParameterPanel pendingAdd={pendingAdd} setPendingRectCorner={setPendingRectCorner} />
          )}
          {pendingDraftHasSelfIntersection ? (
            <div className="sketch-banner-warning">{t('canvas.warning.selfIntersect')}</div>
          ) : null}
          {pendingDraftExceedsStock ? (
            <div className="sketch-banner-warning">{t('canvas.warning.exceedsStock')}</div>
          ) : null}
        </CanvasWorkflowPanel>
      )}
      {creation.placementPanelActive && (
        <CanvasWorkflowPanel
          title={pendingAdd!.shape === 'origin' ? t('canvas.placement.originTitle') : t('canvas.placement.textTitle')}
          step={
            pendingAdd!.shape === 'origin'
              ? t('canvas.placement.originStep')
              : t('canvas.placement.textStep')
          }
          position={creation.placementWorkflowPanel.position}
          panelRef={creation.placementWorkflowPanel.panelRef}
          handleProps={creation.placementWorkflowPanel.handleProps}
          actions={
            <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={cancelPendingAdd}>{t('canvas.placement.cancel')}</button>
          }
        >
          {null}
        </CanvasWorkflowPanel>
      )}
      {pendingConstraint && (
        <CanvasWorkflowPanel
          title={t('canvas.constraint.title')}
          step={
            !pendingConstraint.anchor
              ? t('canvas.constraint.step.pickAnchor')
              : !pendingConstraint.reference
                ? t('canvas.constraint.step.pickReference')
                : t('canvas.constraint.step.setDistance')
          }
          position={constraint.constraintWorkflowPanel.position}
          panelRef={constraint.constraintWorkflowPanel.panelRef}
          handleProps={constraint.constraintWorkflowPanel.handleProps}
          actions={constraint.constraintDistanceReady ? (
            <>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={constraint.commitConstraintFromPanel}>{t('canvas.constraint.confirm')}</button>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={constraint.cancelConstraintFromPanel}>{t('canvas.constraint.cancel')}</button>
            </>
          ) : (
            <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={constraint.cancelConstraintFromPanel}>{t('canvas.constraint.cancel')}</button>
          )}
        >
          {constraint.constraintDistanceReady && constraint.constraintDistanceInput != null && (
            <label className="canvas-workflow-panel__field">
              <span>{t('canvas.field.distance')}</span>
              <input
                ref={constraint.constraintDistanceInputRef}
                className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                type="text"
                inputMode="decimal"
                value={constraint.constraintDistanceInput}
                onChange={(e) => constraint.setConstraintDistanceInput(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    constraint.commitConstraintFromPanel()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    constraint.cancelConstraintFromPanel()
                  }
                }}
                autoFocus
              />
            </label>
          )}
          {!pendingConstraint.anchor && (
            <div className="canvas-workflow-panel__summary">{t('canvas.constraint.summary.anchor')}</div>
          )}
          {pendingConstraint.anchor && !pendingConstraint.reference && (
            <div className="canvas-workflow-panel__summary">{t('canvas.constraint.summary.reference')}</div>
          )}
        </CanvasWorkflowPanel>
      )}
      {pendingMove && (
        <CanvasWorkflowPanel
          title={pendingMove.mode === 'copy' ? t('canvas.move.title.copy') : t('canvas.move.title.move')}
          step={move.moveDistanceEditActive
            ? t('canvas.move.step.setDistance')
            : !pendingMove.fromPoint
              ? t('canvas.move.step.selectFrom')
              : !pendingMove.toPoint
                ? t('canvas.move.step.selectTarget')
                : pendingMove.mode === 'copy'
                  ? t('canvas.move.step.setCopyCount')
                  : undefined}
          position={move.moveWorkflowPanel.position}
          panelRef={move.moveWorkflowPanel.panelRef}
          handleProps={move.moveWorkflowPanel.handleProps}
          actionRowProps={move.moveWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--move"
          moveLabel={t('canvas.move.moveLabel', { mode: pendingMove.mode })}
          actions={(
            <>
              {move.moveDistanceEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={move.commitMoveDistanceEditFromPanel}
                >{t('canvas.move.confirm')}</button>
              )}
              {!move.moveDistanceEditActive && pendingMove.mode === 'copy' && pendingMove.fromPoint && pendingMove.toPoint && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={() => {
                    const n = Math.max(1, Math.floor(Number(copyCountDraft) || 1))
                    completePendingMove(pendingMove.toPoint!, n)
                    setPendingMovePreviewPointRef(null)
                    setCopyCountDraft('1')
                    move.moveWorkflowPanel.focusCanvasAfterAction()
                  }}
                >{t('canvas.move.confirm')}</button>
              )}
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={move.cancelMoveFromPanel}
              >{t('canvas.move.cancel')}</button>
            </>
          )}
        >
          {pendingMove.fromPoint && !pendingMove.toPoint && (
            <div className="canvas-workflow-panel__summary">
              {t('canvas.move.summary.selectTarget')}
            </div>
          )}
          {move.moveDistanceEditActive && (operationDimEdit?.kind === 'move' || operationDimEdit?.kind === 'copy') && (
            <div className="canvas-workflow-panel__meta">
              <label className="canvas-workflow-panel__field">
                <span>{t('canvas.field.distance')}</span>
                <input
                  ref={dimEdit.widthInputRef}
                  className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                  type="text"
                  inputMode="decimal"
                  value={operationDimEdit.distance}
                  onChange={(event) => setOperationDimEdit({ ...operationDimEdit, distance: event.target.value })}
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      move.commitMoveDistanceEditFromPanel()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      move.cancelMoveFromPanel()
                    }
                  }}
                  autoFocus
                />
              </label>
            </div>
          )}
          {!move.moveDistanceEditActive && pendingMove.mode === 'copy' && pendingMove.fromPoint && pendingMove.toPoint && (
            <div className="canvas-workflow-panel__meta">
              <label className="canvas-workflow-panel__field">
                <span>{t('canvas.field.copies')}</span>
                <input
                  ref={copyCountInputRef}
                  className="canvas-workflow-panel__count-input"
                  type="text"
                  inputMode="numeric"
                  value={copyCountDraft}
                  onChange={(event) => setCopyCountDraft(event.target.value.replace(/[^\d]/g, ''))}
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.key === 'Enter') {
                      const nextCount = Math.max(1, Math.floor(Number(copyCountDraft) || 1))
                      completePendingMove(pendingMove.toPoint!, nextCount)
                      setPendingMovePreviewPointRef(null)
                      setCopyCountDraft('1')
                      move.moveWorkflowPanel.focusCanvasAfterAction()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      move.cancelMoveFromPanel()
                    }
                  }}
                  autoFocus
                />
              </label>
            </div>
          )}
        </CanvasWorkflowPanel>
      )}
      {pendingTransform && (
        <CanvasWorkflowPanel
          title={pendingTransform.mode === 'resize' ? t('canvas.transform.title.resize') : pendingTransform.mode === 'mirror' ? t('canvas.transform.title.mirror') : t('canvas.transform.title.rotate')}
          step={transformExact.transformExactEditActive
            ? transformExact.transformScaleEditActive ? t('canvas.transform.step.setScale') : t('canvas.transform.step.setAngle')
            : transformExact.rotateCopyCountPromptActive
            ? t('canvas.transform.step.setCopyCount')
            : pendingTransform.mode === 'resize'
              ? !pendingTransform.referenceStart
                ? t('canvas.transform.step.selectFirstReference')
                : !pendingTransform.referenceEnd
                  ? t('canvas.transform.step.selectSecondReference')
                  : t('canvas.transform.step.scaleToCommit')
              : pendingTransform.mode === 'mirror'
                ? !pendingTransform.referenceStart
                  ? t('canvas.transform.step.selectFirstLinePoint')
                  : t('canvas.transform.step.selectSecondLinePoint')
                : !pendingTransform.referenceStart
                  ? t('canvas.transform.step.selectOrigin')
                  : !pendingTransform.referenceEnd
                    ? t('canvas.transform.step.selectReferenceDirection')
                    : t('canvas.transform.step.rotateToCommit')}
          position={transformExact.transformWorkflowPanel.position}
          panelRef={transformExact.transformWorkflowPanel.panelRef}
          handleProps={transformExact.transformWorkflowPanel.handleProps}
          actionRowProps={transformExact.transformWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--transform"
          moveLabel={t('canvas.transform.moveLabel', { mode: pendingTransform.mode })}
          actions={(
            <>
              {transformExact.transformExactEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={transformExact.commitTransformExactEditFromPanel}
                >{t('canvas.transform.confirm')}</button>
              )}
              {!transformExact.transformExactEditActive && !transformExact.rotateCopyCountPromptActive
                && ((pendingTransform.mode === 'resize' && pendingTransform.referenceStart && pendingTransform.referenceEnd)
                  || (pendingTransform.mode === 'rotate' && pendingTransform.referenceStart && pendingTransform.referenceEnd)) && (
                <button
                  type="button"
                  className="tablet-cmd-btn"
                  onClick={transformExact.triggerDimensionFromTransformPanel}
                >{pendingTransform.mode === 'resize' ? t('canvas.transform.scaleButton') : t('canvas.transform.angleButton')}</button>
              )}
              {!transformExact.transformExactEditActive && transformExact.rotateCopyCountPromptActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={transformExact.commitRotateCopyFromPanel}
                >{t('canvas.transform.confirm')}</button>
              )}
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={transformExact.cancelTransformFromPanel}
              >{t('canvas.transform.cancel')}</button>
            </>
          )}
        >
          {transformExact.transformExactEditActive && (operationDimEdit?.kind === 'scale' || operationDimEdit?.kind === 'rotate') ? (
            <div className="canvas-workflow-panel__meta">
              <label className="canvas-workflow-panel__field">
                <span>{operationDimEdit.kind === 'scale' ? t('canvas.field.scale') : t('canvas.field.angle')}</span>
                <input
                  ref={dimEdit.widthInputRef}
                  className="canvas-workflow-panel__count-input"
                  type="text"
                  inputMode="decimal"
                  value={operationDimEdit.kind === 'scale' ? operationDimEdit.factor : operationDimEdit.angle}
                  onChange={(event) => {
                    if (operationDimEdit.kind === 'scale') {
                      setOperationDimEdit({ kind: 'scale', factor: event.target.value })
                    } else {
                      setOperationDimEdit({ kind: 'rotate', angle: event.target.value })
                    }
                  }}
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    event.stopPropagation()
                    if (event.key === 'Enter') {
                      event.preventDefault()
                      transformExact.commitTransformExactEditFromPanel()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      transformExact.cancelTransformFromPanel()
                    }
                  }}
                  autoFocus
                />
              </label>
            </div>
          ) : transformExact.rotateCopyCountPromptActive ? (
            <>
              <div className="canvas-workflow-panel__meta">
                <label className="canvas-workflow-panel__field">
                  <span>{t('canvas.field.copies')}</span>
                  <input
                    ref={transformExact.rotateCopyCountInputRef}
                    className="canvas-workflow-panel__count-input"
                    type="text"
                    inputMode="numeric"
                    value={transformExact.rotateCopyCountDraft}
                    onChange={(event) => transformExact.setRotateCopyCountDraft(event.target.value.replace(/[^\d]/g, ''))}
                    onFocus={(event) => event.currentTarget.select()}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') {
                        transformExact.commitRotateCopyFromPanel()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        transformExact.cancelTransformFromPanel()
                      }
                    }}
                    autoFocus
                  />
                </label>
              </div>
            </>
          ) : (
            <>
              {((pendingTransform.mode === 'resize' && pendingTransform.referenceStart && pendingTransform.referenceEnd)
                || (pendingTransform.mode === 'rotate' && pendingTransform.referenceStart && pendingTransform.referenceEnd)
                || (pendingTransform.mode === 'mirror' && pendingTransform.referenceStart)) && (
                <div className="canvas-workflow-panel__summary">
                  {pendingTransform.mode === 'resize'
                    ? t('canvas.transform.summary.resize')
                    : pendingTransform.mode === 'mirror'
                      ? t('canvas.transform.summary.mirror')
                      : pendingTransform.keepOriginals
                        ? t('canvas.transform.summary.rotateCopy')
                        : t('canvas.transform.summary.rotate')}
                </div>
              )}
              {((pendingTransform.mode === 'rotate' && pendingTransform.referenceStart && pendingTransform.referenceEnd)
                || (pendingTransform.mode === 'mirror' && pendingTransform.referenceStart)) && (
                <div className="canvas-workflow-panel__meta">
                  <label className="canvas-workflow-panel__check">
                    <input
                      type="checkbox"
                      checked={pendingTransform.keepOriginals}
                      onChange={(event) => {
                        setPendingTransformKeepOriginals(event.target.checked)
                        transformExact.transformWorkflowPanel.focusCanvasAfterAction()
                      }}
                    />
                    <span>{t('canvas.transform.keepOriginals')}</span>
                  </label>
                </div>
              )}
            </>
          )}
        </CanvasWorkflowPanel>
      )}
      {tapeMeasure && (
        <CanvasWorkflowPanel
          title={t('canvas.tape.title')}
          step={tapeMeasure.first ? t('canvas.tape.step.second') : t('canvas.tape.step.first')}
          position={tapeWorkflowPanel.position}
          panelRef={tapeWorkflowPanel.panelRef}
          handleProps={tapeWorkflowPanel.handleProps}
          actions={(
            <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={() => { clearTapeMeasure(); tapeWorkflowPanel.focusCanvasAfterAction() }}>{t('canvas.tape.done')}</button>
          )}
        >
          <div className="canvas-workflow-panel__summary">
            {t('canvas.tape.summary')}
          </div>
        </CanvasWorkflowPanel>
      )}
      {pendingDimension && (
        <CanvasWorkflowPanel
          title={dimensionTitle}
          step={dimensionStep}
          position={dimensionWorkflowPanel.position}
          panelRef={dimensionWorkflowPanel.panelRef}
          handleProps={dimensionWorkflowPanel.handleProps}
          actions={(
            <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={() => { cancelPendingDimension(); dimensionWorkflowPanel.focusCanvasAfterAction() }}>{t('canvas.dimension.addCancel')}</button>
          )}
        >
          <div className="canvas-workflow-panel__summary">
            {t('canvas.dimension.addSummary')}
          </div>
        </CanvasWorkflowPanel>
      )}
      {dimensionDeleteArmed && (
        <CanvasWorkflowPanel
          title={t('canvas.dimension.deleteTitle')}
          step={t('canvas.dimension.deleteStep')}
          position={dimensionDeleteWorkflowPanel.position}
          panelRef={dimensionDeleteWorkflowPanel.panelRef}
          handleProps={dimensionDeleteWorkflowPanel.handleProps}
          actions={(
            <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={() => { setDimensionDeleteArmed(false); dimensionDeleteWorkflowPanel.focusCanvasAfterAction() }}>{t('canvas.dimension.deleteDone')}</button>
          )}
        >
          <div className="canvas-workflow-panel__summary">
            {t('canvas.dimension.deleteSummary')}
          </div>
        </CanvasWorkflowPanel>
      )}
      {pendingClipboardPlacement && (
        <CanvasWorkflowPanel
          title={t('canvas.paste.title')}
          step={t('canvas.paste.step')}
          position={clipboardPlacementWorkflowPanel.position}
          panelRef={clipboardPlacementWorkflowPanel.panelRef}
          handleProps={clipboardPlacementWorkflowPanel.handleProps}
          actionRowProps={clipboardPlacementWorkflowPanel.actionRowProps}
          actions={(
            <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={cancelClipboardPlacement}>{t('canvas.paste.cancel')}</button>
          )}
        >
          <div className="canvas-workflow-panel__summary">
            {t('canvas.paste.summary')}
          </div>
        </CanvasWorkflowPanel>
      )}
      {editModeActive && (
        <CanvasWorkflowPanel
          title={t('canvas.edit.title')}
          step={
            editFilletActive ? (selection.sketchEditTool === 'chamfer' ? t('canvas.edit.step.enterDistance') : t('canvas.edit.step.enterRadius'))
            : editDimEditActive ? t('canvas.edit.step.enterDimensions')
            : selection.sketchEditTool === 'add_point' ? t('canvas.edit.step.clickToAddPoints')
            : selection.sketchEditTool === 'delete_point' ? t('canvas.edit.step.clickToDeletePoints')
            : selection.sketchEditTool === 'delete_segment' ? t('canvas.edit.step.clickToDeleteSegments')
            : selection.sketchEditTool === 'disconnect' ? t('canvas.edit.step.clickAnchorToSplit')
            : selection.sketchEditTool === 'fillet' ? (fillet.filletCornerPicked ? t('canvas.edit.step.filletSecond') : t('canvas.edit.step.filletCorner'))
            : selection.sketchEditTool === 'chamfer' ? (fillet.filletCornerPicked ? t('canvas.edit.step.chamferSecond') : t('canvas.edit.step.chamferCorner'))
            : selection.sketchEditTool === 'trim' ? (pendingSketchEdit?.phase === 'pick-reference' ? t('canvas.edit.step.trimReference') : t('canvas.edit.step.trimSubject'))
            : selection.sketchEditTool === 'extend' ? (pendingSketchEdit?.phase === 'pick-reference' ? t('canvas.edit.step.extendReference') : t('canvas.edit.step.extendSubject'))
            : t('canvas.edit.step.default')
          }
          position={editWorkflowPanel.position}
          panelRef={editWorkflowPanel.panelRef}
          handleProps={editWorkflowPanel.handleProps}
          actions={editFilletActive ? (
            <>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={commitFilletFromPanel}>{t('canvas.edit.apply')}</button>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={cancelFilletFromPanel}>{t('canvas.edit.cancel')}</button>
            </>
          ) : editDimEditActive ? (
            <>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={commitEditDimensionFromPanel}>{t('canvas.edit.confirm')}</button>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={cancelEditDimensionFromPanel}>{t('canvas.edit.cancel')}</button>
            </>
          ) : (
            <>
              {dimEdit.armedForDimension && (
                <button type="button" className="tablet-cmd-btn" onClick={() => { triggerDimensionEdit(); dimEdit.setArmedForDimension(false) }}>{t('canvas.edit.dimensionButton')}</button>
              )}
              {fillet.filletCornerPicked && !editFilletActive && (
                <button type="button" className="tablet-cmd-btn" onClick={() => fillet.enterFilletRadiusEdit()}>{selection.sketchEditTool === 'chamfer' ? t('canvas.edit.distanceButton') : t('canvas.edit.radiusButton')}</button>
              )}
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={applyEditFromPanel}>{t('canvas.edit.apply')}</button>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={cancelEditFromPanel}>{t('canvas.edit.cancel')}</button>
            </>
          )}
        >
          {editFilletActive ? (
            <label className="canvas-workflow-panel__field">
              <span>{selection.sketchEditTool === 'chamfer' ? t('canvas.field.distance') : t('canvas.field.radius')}</span>
              <input
                ref={fillet.filletRadiusInputRef}
                className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                type="text"
                inputMode="decimal"
                value={fillet.filletDimensionEdit?.radius ?? ''}
                onChange={(e) => {
                  fillet.setFilletDimensionEdit((prev) => (prev ? { ...prev, radius: e.target.value } : null))
                  scheduleDraw()
                }}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  e.stopPropagation()
                  if (e.key === 'Enter') {
                    e.preventDefault()
                    commitFilletFromPanel()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    cancelFilletFromPanel()
                  }
                }}
              />
            </label>
          ) : editDimEditActive && dimEdit.dimensionEdit ? (
            dimEdit.dimensionEdit.activeField === 'radius' ? (
              <label className="canvas-workflow-panel__field">
                <span>{t('canvas.field.radius')}</span>
                <input
                  ref={dimEdit.radiusInputRef}
                  className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                  type="text"
                  inputMode="decimal"
                  value={dimEdit.dimensionEdit.radius}
                  onChange={(e) => dimEdit.handleEditDimLiveChange('radius', e.target.value)}
                  onFocus={(e) => e.currentTarget.select()}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      commitEditDimensionFromPanel()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      cancelEditDimensionFromPanel()
                    }
                  }}
                  autoFocus
                />
              </label>
            ) : (
              <>
                <label className="canvas-workflow-panel__field">
                  <span>{t('canvas.field.length')}</span>
                  <input
                    ref={dimEdit.widthInputRef}
                    className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                    type="text"
                    inputMode="decimal"
                    value={dimEdit.dimensionEdit.length}
                    onChange={(e) => dimEdit.handleEditDimLiveChange('length', e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitEditDimensionFromPanel()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancelEditDimensionFromPanel()
                      } else if (e.key === 'Tab') {
                        e.preventDefault()
                        dimEdit.heightInputRef.current?.focus({ preventScroll: true })
                      }
                    }}
                    autoFocus
                  />
                </label>
                <label className="canvas-workflow-panel__field">
                  <span>{t('canvas.field.angle')}</span>
                  <input
                    ref={dimEdit.heightInputRef}
                    className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
                    type="text"
                    inputMode="decimal"
                    value={dimEdit.dimensionEdit.angle}
                    onChange={(e) => dimEdit.handleEditDimLiveChange('angle', e.target.value)}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      e.stopPropagation()
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        commitEditDimensionFromPanel()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancelEditDimensionFromPanel()
                      } else if (e.key === 'Tab') {
                        e.preventDefault()
                        dimEdit.widthInputRef.current?.focus({ preventScroll: true })
                      }
                    }}
                  />
                </label>
              </>
            )
          ) : (
            <>
              {editingFeatureHasSelfIntersection && (
                <div className="canvas-workflow-panel__summary" style={{ color: 'var(--warning)' }}>{t('canvas.edit.warning.selfIntersecting')}</div>
              )}
              {editingFeatureExceedsStock && (
                <div className="canvas-workflow-panel__summary" style={{ color: 'var(--warning)' }}>{t('canvas.edit.warning.exceedsStock')}</div>
              )}
            </>
          )}
        </CanvasWorkflowPanel>
      )}
      {lockMode !== 'none' && !isTablet && (
        <button
          type="button"
          className="axis-lock-chip"
          style={{ borderColor: lockModeGuideColor(lockMode), color: lockModeGuideColor(lockMode) }}
          onClick={cycleLock}
          title={t('canvas.axisLock.cycleAria')}
        >{lockMode === 'x' ? t('canvas.axisLock.lockX') : t('canvas.axisLock.lockY')}</button>
      )}
      {isTablet && (
        <div className="tablet-command-bar">
          <button
            type="button"
            className={`tablet-cmd-btn ${lockMode !== 'none' ? 'tablet-cmd-btn--active' : ''}`}
            style={{ borderColor: lockModeGuideColor(lockMode) }}
            onClick={cycleLock}
          >{lockMode === 'none' ? t('canvas.axisLock.lock') : lockMode === 'x' ? t('canvas.axisLock.lockX') : t('canvas.axisLock.lockY')}</button>
          {/* Multi-select toggle */}
          {selection.mode === 'feature' && !pendingAdd && !pendingMove && !pendingTransform && !pendingOffset && (
            <button
              type="button"
              className={`tablet-cmd-btn ${(multiSelectMode || !!pendingShapeAction) ? 'tablet-cmd-btn--active' : ''}`}
              disabled={!!pendingShapeAction}
              title={pendingShapeAction ? t('canvas.axisLock.multiSelectDisabledTitle') : t('canvas.axisLock.multiSelectTitle')}
              onClick={() => setMultiSelectMode((prev) => !prev)}
            >{t('canvas.axisLock.multiSelect')}</button>
          )}
        </div>
      )}
    </div>
  )
})
