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
import type { ToolpathResult } from '../../engine/toolpaths/types'
import { ToolpathVisibilityPanel } from '../ToolpathVisibilityPanel'
import type { ToolpathVisibility } from '../toolpathVisibility'
import type { SnapMode, SnapSettings } from '../../sketch/snapping'
import type { OpenProfileEndpoint, SketchControlRef, SketchEditTool } from '../../store/types'
import { useProjectStore } from '../../store/projectStore'
import { previewOffsetFeatures } from '../../store/helpers/derivedFeatures'
import { chamferDistanceFromPoint, chamferFeatureFromDistance, chamferFeatureFromPoint, filletFeatureFromPoint, filletFeatureFromRadius, filletRadiusFromPoint, mirrorFeatureFromReference, resizeBackdropFromReference, resizeFeatureFromReference, rotateBackdropFromReference, rotateFeatureFromReference } from '../../store/helpers/referenceTransforms'
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
  computeRotateDegreesFromPreview,
  computeScaleFactorFromPreview,
} from './manualEntry'
import type { OperationDimEdit } from './manualEntry'
import { useDimensionEditWorkflow } from './useDimensionEditWorkflow'
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
import { drawDimensions, drawPendingDimensionPreview, drawTapeMeasure } from './dimensionRendering'
import {
  drawFeature,
  drawMoveGuide,
  drawPendingPathLoop,
  drawPendingPoint,
  drawPendingSplineLoop,
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
} from './hitTest'
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
import type { Clamp, OperationKind, Point, SketchFeature, Tab } from '../../types/project'
import { compatibleFeatureIdsForOperation } from '../cam/operationValidity'
import { formatLength, parseLengthInput } from '../../utils/units'
import { useAxisLock, lockModeGuideColor } from '../../sketch/useAxisLock'
import { useCanvasGestures } from '../../sketch/useCanvasGestures'
import { useStableEvent } from '../../hooks/useStableEvent'
import { useRafScheduler } from '../../hooks/useRafScheduler'
import { useShellMode, isTabletMode } from '../layout/useShellMode'
import { CanvasWorkflowPanel } from './CanvasWorkflowPanel'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

const NODE_HIT_RADIUS = 9
const HANDLE_HIT_RADIUS = 7
const POLYGON_CLOSE_RADIUS = 12
const OPEN_ENDPOINT_JOIN_HIT_RADIUS = 14
const MIN_SKETCH_ZOOM = 0.02

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

export interface SketchCanvasHandle {
  zoomToModel: () => void
}

interface SketchCanvasProps {
  onFeatureContextMenu?: (featureId: string, x: number, y: number) => void
  onTabContextMenu?: (tabId: string, x: number, y: number) => void
  onClampContextMenu?: (clampId: string, x: number, y: number) => void
  toolpaths?: ToolpathResult[]
  selectedOperationId?: string | null
  collidingClampIds?: string[]
  snapSettings: SnapSettings
  zoomWindowActive?: boolean
  onZoomWindowComplete?: () => void
  onActiveSnapModeChange?: (mode: SnapMode | null) => void
  depthLegendCollapsed?: boolean
  onToggleDepthLegend?: () => void
  toolpathVisibility?: ToolpathVisibility
  onToolpathVisibilityChange?: (visibility: ToolpathVisibility) => void
  /**
   * A1.3: when an operation kind is armed/hovered in the CAM "Add operation"
   * menu, the canvas highlights features that operation could act on and dims
   * the rest. Null when nothing is armed.
   */
  operationHighlightKind?: OperationKind | null
}

function drawStlTopViewImage(
  ctx: CanvasRenderingContext2D,
  feature: SketchFeature,
  image: HTMLImageElement,
  vt: ViewTransform,
  selected: boolean,
  hovered: boolean,
  editing: boolean,
): void {
  if (!image.complete || image.naturalWidth <= 0 || image.naturalHeight <= 0) return

  const verts = profileVertices(feature.sketch.profile)
  if (verts.length < 3) return

  const angle = ((feature.sketch.orientationAngle ?? 0) * Math.PI) / 180
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  const vx = -Math.sin(angle)
  const vy = Math.cos(angle)

  let minU = Infinity, maxU = -Infinity
  let minV = Infinity, maxV = -Infinity
  for (const point of verts) {
    const projectedU = point.x * ux + point.y * uy
    const projectedV = point.x * vx + point.y * vy
    if (projectedU < minU) minU = projectedU
    if (projectedU > maxU) maxU = projectedU
    if (projectedV < minV) minV = projectedV
    if (projectedV > maxV) maxV = projectedV
  }

  const width = maxU - minU
  const height = maxV - minV
  if (!(width > 1e-9) || !(height > 1e-9)) return

  const centerU = minU + width / 2
  const centerV = minV + height / 2
  const center = worldToCanvas({
    x: ux * centerU + vx * centerV,
    y: uy * centerU + vy * centerV,
  }, vt)
  const drawW = width * vt.scale
  const drawH = height * vt.scale

  ctx.save()
  traceProfilePath(ctx, feature.sketch.profile, vt)
  ctx.clip('evenodd')
  ctx.translate(center.cx, center.cy)
  ctx.rotate(angle)
  ctx.globalAlpha = selected || hovered || editing ? 0.72 : 0.86
  ctx.drawImage(image, -drawW / 2, -drawH / 2, drawW, drawH)
  ctx.restore()

  ctx.save()
  traceProfilePath(ctx, feature.sketch.profile, vt)
  ctx.strokeStyle = selected
    ? '#efbc7a'
    : hovered
      ? '#d2a064'
      : editing
        ? '#f7cd87'
        : '#bcc8d4'
  ctx.lineWidth = selected || editing ? 2.5 : 1.8
  ctx.stroke()
  ctx.restore()
}

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
  const pendingSketchFilletRef = useRef<PendingSketchFillet | null>(null)
  const pendingPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingMovePreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingTransformPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingOffsetPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingOffsetRawPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
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

  const shellMode = useShellMode()
  const isTablet = isTabletMode(shellMode)
  const [multiSelectMode, setMultiSelectMode] = useState(false)

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
    moveTabControl,
    moveClampControl,
    setPendingAddAnchor,
    placePendingAddAt,
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

  projectRef.current = project
  selectionRef.current = selection
  pendingAddRef.current = pendingAdd
  creationTargetRef.current = creationTarget
  pendingMoveRef.current = pendingMove
  pendingTransformRef.current = pendingTransform
  pendingOffsetRef.current = pendingOffset
  pendingShapeActionRef.current = pendingShapeAction
  pendingConstraintRef.current = pendingConstraint
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
  const dimensionTitle = pendingDimension
    ? `${pendingDimension.type.charAt(0).toUpperCase()}${pendingDimension.type.slice(1)} dimension`
    : ''
  const dimensionStep = (() => {
    if (!pendingDimension) return ''
    const t = pendingDimension.type
    const n = dimensionPickedCount
    if (t === 'radius' || t === 'diameter') {
      return n === 0 ? 'Click the circle / arc center' : 'Click a point on the edge'
    }
    if (t === 'angle') {
      return n === 0 ? 'Click the vertex'
        : n === 1 ? 'Click the first ray point'
        : n === 2 ? 'Click the second ray point'
        : 'Click to place'
    }
    return n === 0 ? 'Click the first point' : n === 1 ? 'Click the second point' : 'Click to set the offset'
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

  function sameControl(a: SketchControlRef | null, b: SketchControlRef | null): boolean {
    return a?.kind === b?.kind && a?.index === b?.index && a?.t === b?.t
  }

  const setHoveredEditControl = useStableEvent((nextControl: SketchControlRef | null) => {
    if (sameControl(hoveredEditControlRef.current, nextControl)) {
      return
    }
    hoveredEditControlRef.current = nextControl
    if (!nextControl) dimEdit.setArmedForDimension(false)
    scheduleDraw()
  })

  function clearTransientCanvasState() {
    suppressClickRef.current = false
    didPanRef.current = false
    gestures.stopPan()
    marqueeStartRef.current = null
    marqueeCurrentRef.current = null
    touchDragPendingRef.current = null
    livePointerWorldRef.current = null
  }

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

  function confirmCutCuttersFromTabletPanel() {
    confirmCutCutters()
    cutWorkflowPanel.focusCanvasAfterAction()
  }

  function completeCutFromTabletPanel() {
    completePendingShapeAction()
    cutWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelCutFromTabletPanel() {
    cancelPendingShapeAction()
    cutWorkflowPanel.focusCanvasAfterAction()
  }

  function completeJoinFromPanel() {
    completePendingShapeAction()
    joinWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelJoinFromPanel() {
    cancelPendingShapeAction()
    joinWorkflowPanel.focusCanvasAfterAction()
  }

  function applyEditFromPanel() {
    gestures.stopNodeDrag()
    resetLock()
    applySketchEdit()
    editWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelEditFromPanel() {
    gestures.stopNodeDrag()
    resetLock()
    cancelSketchEdit()
    editWorkflowPanel.focusCanvasAfterAction()
  }

  function commitEditDimensionFromPanel() {
    dimEdit.commitEditDimension()
    editWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelEditDimensionFromPanel() {
    dimEdit.cancelEditDimension()
    editWorkflowPanel.focusCanvasAfterAction()
  }

  function commitFilletFromPanel() {
    fillet.commitFilletDimension()
    editWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelFilletFromPanel() {
    fillet.cancelFilletDimension()
    editWorkflowPanel.focusCanvasAfterAction()
  }

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
      project.features
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
  }, [project.features])

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
  }, [scheduleDraw, project, selection, pendingAdd, pendingMove, pendingTransform, pendingOffset, viewState, backdropImage, stlImageRevision, toolpaths, selectedOperationId, collidingClampIds, snapSettings, copyCountDraft, dimEdit.dimensionEdit, toolpathVisibility, operationHighlightKind])

  useEffect(() => {
    sketchEditPreviewRef.current = null
    pendingSketchExtensionRef.current = null
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
    ctx.fillStyle = '#0f151d'
    ctx.fillRect(0, 0, width, height)

    drawGrid(ctx, vt, width, height, project.stock, project.grid)

    if (project.backdrop?.visible && backdropImage) {
      drawBackdropImage(
        ctx,
        project.backdrop,
        backdropImage,
        vt,
        selection.selectedNode?.type === 'backdrop',
        project.backdrop.name,
      )
    }

    if (project.stock.visible) {
      const anyFeatureExceedsStock = project.features.some(
        (feature) => feature.visible
          && feature.kind !== 'text'
          && profileExceedsStock(feature.sketch.profile, project.stock),
      )
      drawStockOutline(ctx, project.stock, vt, project.meta.units, anyFeatureExceedsStock)
    }

    if (project.origin.visible) {
      drawOriginMarker(ctx, project.origin, vt)
    }

    for (const feature of project.features) {
      if (!feature.visible) continue

      const selected = selection.selectedFeatureIds.includes(feature.id)
      const hovered = feature.id === selection.hoveredFeatureId
      const editing = selection.mode === 'sketch_edit' && feature.id === selection.selectedFeatureId

      drawFeature(ctx, feature, vt, project.meta.units, project.meta.showFeatureInfo, selected, hovered, editing)

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
          ctx.fillStyle = 'rgba(8, 12, 18, 0.5)'
          ctx.fill()
        }
        ctx.restore()
      }

      const stlTopViewUrl = feature.kind === 'stl' ? feature.stl?.topViewDataUrl : null
      const stlTopViewImage = stlTopViewUrl ? stlImageCacheRef.current.get(stlTopViewUrl) : null
      if (feature.kind === 'stl' && stlTopViewImage) {
        drawStlTopViewImage(ctx, feature, stlTopViewImage, vt, selected, hovered, editing)
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
        drawSketchControls(ctx, feature.sketch.profile, vt, editControl)
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
    for (const feature of project.features) {
      if (!feature.visible) continue
      for (const c of feature.sketch.constraints) {
        if (c.type !== 'fixed_distance' || !c.anchor_point || !c.reference_point) continue
        const isInvalid = !!c.is_invalid
        const lineColor = isInvalid ? 'rgba(220, 60, 60, 0.85)' : 'rgba(91, 165, 216, 0.8)'
        const dotColor = isInvalid ? 'rgba(220, 60, 60, 0.9)' : 'rgba(91, 165, 216, 0.9)'
        const labelColor = isInvalid ? 'rgba(255, 180, 180, 0.95)' : 'rgba(200, 220, 240, 0.95)'
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
          ctx.fillStyle = isInvalid ? 'rgba(80, 20, 20, 0.9)' : 'rgba(18, 26, 36, 0.85)'
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
        drawSketchControls(ctx, rectProfile(clamp.x, clamp.y, clamp.w, clamp.h), vt, selection.activeControl)
      }
    }

    for (const tab of project.tabs) {
      if (!tab.visible) continue
      const selected = selection.selectedNode?.type === 'tab' && selection.selectedNode.tabId === tab.id
      drawTabFootprint(ctx, tab, vt, selected)
      if (selection.mode === 'sketch_edit' && selection.selectedNode?.type === 'tab' && selection.selectedNode.tabId === tab.id) {
        drawSketchControls(ctx, rectProfile(tab.x, tab.y, tab.w, tab.h), vt, selection.activeControl)
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
            'Move preview',
          )
        } else if (currentMovePreviewPoint) {
          drawPendingPoint(ctx, currentMovePreviewPoint, vt, snap.isActiveSnapPoint(currentMovePreviewPoint))
        }
      } else if (pendingMove.entityType === 'feature') {
        const features = pendingMove.entityIds
          .map((featureId) => project.features.find((entry) => entry.id === featureId) ?? null)
          .filter((feature): feature is SketchFeature => feature !== null)
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
              pendingTransform.mode === 'resize' ? 'Resize preview' : 'Rotate preview',
            )
          }
        } else if (currentTransformPreviewPoint) {
          drawPendingPoint(ctx, currentTransformPreviewPoint, vt, snap.isActiveSnapPoint(currentTransformPreviewPoint))
        }

        return
      }

      const features = pendingTransform.entityIds
        .map((featureId) => project.features.find((entry) => entry.id === featureId) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)

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
      const features = pendingOffset.entityIds
        .map((featureId) => project.features.find((entry) => entry.id === featureId) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)
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
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setFilletDimensionEdit is a stable useState setter; the hook return object is recreated each render
  }, [selection.mode, selection.sketchEditTool])

  useEffect(() => {
    if (!pendingAdd && selection.mode !== 'sketch_edit') {
      dimEdit.setDimensionEdit(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setDimensionEdit is a stable useState setter; the hook return object is recreated each render
  }, [pendingAdd, selection.mode])

  useEffect(() => {
    if (!pendingMove) setOperationDimEdit(null)
  }, [pendingMove])

  useEffect(() => {
    if (!pendingTransform) setOperationDimEdit(null)
  }, [pendingTransform])

  useEffect(() => {
    if (!pendingOffset) setOperationDimEdit(null)
  }, [pendingOffset])

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
  // eslint-disable-next-line react-hooks/exhaustive-deps -- file-wide React-Compiler bail; masks forward-refs + ref-mirror writes + hot-path render-time ref reads (see comment above; planning/archive/LINT_HOOK_TYPING_DEBT_Plan.md)
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
    // Check features array first, then stock source feature
    return (
      project.features.find((feature) => feature.id === selection.selectedFeatureId) ??
      (project.stock.sourceFeatureId === selection.selectedFeatureId && project.stock.sourceFeature
        ? project.stock.sourceFeature
        : null)
    )
  }

  function openEndpointAnchor(feature: SketchFeature, endpoint: OpenProfileEndpoint): Point {
    return endpoint === 'start'
      ? feature.sketch.profile.start
      : anchorPointForIndex(feature.sketch.profile, feature.sketch.profile.segments.length)
  }

  function endpointFromSketchExtension(kind: PendingSketchExtension['kind']): OpenProfileEndpoint {
    return kind === 'extend_start' ? 'start' : 'end'
  }


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

    for (let index = project.features.length - 1; index >= 0; index -= 1) {
      const feature = project.features[index]
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
    const selection = selectionRef.current
    const project = projectRef.current
    if (selection.mode !== 'sketch_edit') return null
    const selectedNode = selection.selectedNode
    if (selectedNode?.type !== 'clamp') return null
    return project.clamps.find((clamp) => clamp.id === selectedNode.clampId) ?? null
  }

  function editableTab(): Tab | null {
    const selection = selectionRef.current
    const project = projectRef.current
    if (selection.mode !== 'sketch_edit') return null
    const selectedNode = selection.selectedNode
    if (selectedNode?.type !== 'tab') return null
    return project.tabs.find((tab) => tab.id === selectedNode.tabId) ?? null
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
      || (selection.mode === 'sketch_edit' && (sketchEditTool === 'add_point' || sketchEditTool === 'fillet' || sketchEditTool === 'chamfer'))
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
    const project = projectRef.current
    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingOffset = pendingOffsetRef.current
    const selection = selectionRef.current
    const units = project.meta.units

    if (pendingAdd) {
      if (
        (pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'ellipse' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp')
        && pendingAdd.anchor
      ) {
        const previewPoint = pendingPreviewPointRef.current?.point ?? pendingAdd.anchor
        if (pendingAdd.shape === 'circle') {
          const r = Math.hypot(previewPoint.x - pendingAdd.anchor.x, previewPoint.y - pendingAdd.anchor.y)
          dimEdit.setDimensionEdit({ shape: 'circle', anchor: pendingAdd.anchor, signX: 1, signY: 1, activeField: 'radius', width: '', height: '', radius: formatLength(r, units), length: '', angle: '' })
        } else {
          const w = Math.abs(previewPoint.x - pendingAdd.anchor.x)
          const h = Math.abs(previewPoint.y - pendingAdd.anchor.y)
          dimEdit.setDimensionEdit({ shape: pendingAdd.shape, anchor: pendingAdd.anchor, signX: previewPoint.x >= pendingAdd.anchor.x ? 1 : -1, signY: previewPoint.y >= pendingAdd.anchor.y ? 1 : -1, activeField: 'width', width: formatLength(w, units), height: formatLength(h, units), radius: '', length: '', angle: '' })
        }
        return
      }
      if ((pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline') && pendingAdd.points.length >= 1) {
        const fromPoint = pendingAdd.points[pendingAdd.points.length - 1]
        const previewPoint = pendingPreviewPointRef.current?.point ?? fromPoint
        const dx = previewPoint.x - fromPoint.x
        const dy = previewPoint.y - fromPoint.y
        dimEdit.setDimensionEdit({ shape: pendingAdd.shape, anchor: fromPoint, signX: 1, signY: 1, activeField: 'length', width: '', height: '', radius: '', length: formatLength(Math.hypot(dx, dy), units), angle: (Math.atan2(dy, dx) * (180 / Math.PI)).toFixed(2).replace(/\.?0+$/, '') })
        return
      }
      if (pendingAdd.shape === 'composite' && pendingAdd.start && !pendingAdd.closed) {
        if (pendingAdd.currentMode === 'arc' && pendingAdd.pendingArcEnd) {
          const arcStart = pendingAdd.lastPoint ?? pendingAdd.start
          const arcEnd = pendingAdd.pendingArcEnd
          const previewPoint = pendingPreviewPointRef.current?.point
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
        const previewPoint = pendingPreviewPointRef.current?.point ?? fromPoint
        const dx = previewPoint.x - fromPoint.x
        const dy = previewPoint.y - fromPoint.y
        const len = Math.hypot(dx, dy)
        const angleDeg = (Math.atan2(dy, dx) * (180 / Math.PI)).toFixed(2).replace(/\.?0+$/, '')
        const defaultRadius = pendingAdd.currentMode === 'arc' ? formatLength(len > 1e-9 ? len : 0.5, units) : ''
        dimEdit.setDimensionEdit({ shape: 'composite', anchor: fromPoint, signX: 1, signY: 1, activeField: 'length', width: '', height: '', radius: defaultRadius, length: formatLength(len, units), angle: angleDeg })
        return
      }
    }

    if (pendingMove?.fromPoint && !pendingMove.toPoint) {
      const previewPoint = pendingMovePreviewPointRef.current?.point ?? pendingMove.fromPoint
      move.beginMoveDistanceEntry(previewPoint)
      return
    }

    if (pendingTransform?.mode === 'resize' && pendingTransform.referenceStart && pendingTransform.referenceEnd) {
      let factor = '1'
      const previewPoint = pendingTransformPreviewPointRef.current?.point
      if (previewPoint) factor = computeScaleFactorFromPreview(pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)
      setOperationDimEdit({ kind: 'scale', factor })
      return
    }

    if (pendingTransform?.mode === 'rotate' && pendingTransform.referenceStart && pendingTransform.referenceEnd) {
      let angle = '0'
      const previewPoint = pendingTransformPreviewPointRef.current?.point
      if (previewPoint) angle = computeRotateDegreesFromPreview(pendingTransform.referenceStart, pendingTransform.referenceEnd, previewPoint)
      setOperationDimEdit({ kind: 'rotate', angle })
      return
    }

    if (pendingOffset) {
      let distance = '0'
      const rawOffsetPoint = pendingOffsetRawPreviewPointRef.current?.point
      const snappedOffsetPoint = pendingOffsetPreviewPointRef.current?.point
      if (rawOffsetPoint && snappedOffsetPoint) {
        const canvas = canvasRef.current
        if (canvas) {
          const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewStateRef.current)
          const sourceFeatures = pendingOffset.entityIds
            .map((id) => project.features.find((f) => f.id === id) ?? null)
            .filter((f): f is SketchFeature => f !== null)
            .filter((f) => f.sketch.profile.closed)
          const previewInput = resolveOffsetPreview(sourceFeatures, rawOffsetPoint, snappedOffsetPoint, snap.activeSnapRef.current?.mode ?? null, vt)
          if (previewInput) distance = formatLength(previewInput.signedDistance, units)
        }
      }
      setOperationDimEdit({ kind: 'offset', distance })
      return
    }

    if (selection.mode === 'sketch_edit' && !pendingAdd && pendingSketchFilletRef.current && sketchEditPreviewRef.current) {
      const featureId = selection.selectedFeatureId
      const feature = featureId ? project.features.find((f) => f.id === featureId) ?? null : null
      if (!feature) return
      const radius = selection.sketchEditTool === 'chamfer'
        ? chamferDistanceFromPoint(feature, pendingSketchFilletRef.current.anchorIndex, sketchEditPreviewRef.current.point)
        : filletRadiusFromPoint(feature, pendingSketchFilletRef.current.anchorIndex, sketchEditPreviewRef.current.point)
      fillet.setFilletDimensionEdit({ anchorIndex: pendingSketchFilletRef.current.anchorIndex, corner: pendingSketchFilletRef.current.corner, radius: radius ? formatLength(radius, units) : '' })
      return
    }

    if (selection.mode === 'sketch_edit' && !pendingAdd && !fillet.filletDimensionEditRef.current) {
      const currentEdit = dimEdit.dimensionEditRef.current
      if (!currentEdit && dimEdit.dimensionEditControlRef.current) {
        dimEdit.advanceTabInEditMode()
      }
    }
  }

  const keyboard = useCanvasKeyboard({
    projectRef,
    selectionRef,
    pendingAddRef,
    pendingMoveRef,
    pendingTransformRef,
    pendingOffsetRef,
    pendingShapeActionRef,
    viewStateRef,
    tapeMeasureRef,
    pendingDimensionRef,
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
    dimEdit,
    constraint,
    move,
    transformExact,
    fillet,
    clearTapeMeasure,
    cancelPendingDimension,
    setDimensionDeleteArmed,
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
    setPendingPreviewPointRef,
    setPendingMovePreviewPointRef,
    setPendingTransformPreviewPointRef,
    setPendingOffsetPreviewPointRef,
    setPendingOffsetRawPreviewPointRef,
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
    selectionRef,
    projectRef,
    pendingAddRef,
    pendingMoveRef,
    pendingTransformRef,
    pendingOffsetRef,
    pendingShapeActionRef,
    viewStateRef,
    pendingConstraintRef,
    pendingDimensionRef,
    dimensionDeleteArmedRef,
    deleteHoverDimIdRef,
    selectedAnnotationIdRef,
    pendingSketchExtensionRef,
    pendingSketchFilletRef,
    sketchEditPreviewRef,
    originPreviewPointRef,
    tapeMeasureRef,
    constraintLabelRectsRef,
    canvasRef,
    snap,
    dimEdit,
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
    tapeMeasureClick,
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
    setPendingAddAnchor,
    placePendingAddAt,
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
      ? project.features.find((feature) => feature.id === selection.selectedFeatureId) ??
        (project.stock.sourceFeatureId === selection.selectedFeatureId && project.stock.sourceFeature
          ? project.stock.sourceFeature
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
        className={`sketch-canvas ${pendingAdd || pendingMove || pendingTransform || pendingOffset || pendingShapeAction ? 'sketch-canvas--placing' : ''}`}
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
      {!depthLegendCollapsed ? (
        <div className="sketch-depth-legend">
          <div className="sketch-depth-legend__header">
            <span>Feature Colors</span>
            <button
              className="sketch-depth-legend__toggle tree-action-btn"
              type="button"
              onClick={onToggleDepthLegend}
              aria-label="Collapse feature color legend"
              title="Collapse legend"
            >
              ▾
            </button>
          </div>
          <div className="sketch-depth-legend__items">
            <div className="sketch-depth-legend__item">
              <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--subtract-shallow" />
              <span>Subtract shallow</span>
            </div>
            <div className="sketch-depth-legend__item">
              <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--subtract-deep" />
              <span>Subtract deep</span>
            </div>
            <div className="sketch-depth-legend__item">
              <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--add" />
              <span>Add feature</span>
            </div>
            <div className="sketch-depth-legend__item">
              <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--region" />
              <span>Region</span>
            </div>
            <div className="sketch-depth-legend__item">
              <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--imported-model" />
              <span>Imported model</span>
            </div>
            <div className="sketch-depth-legend__item">
              <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--selected" />
              <span>Selected</span>
            </div>
          </div>
        </div>
      ) : null}
      {(toolpaths && toolpaths.some((tp) => tp.moves.length > 0)) && toolpathVisibility && onToolpathVisibilityChange && (
        <ToolpathVisibilityPanel
          visibility={toolpathVisibility}
          onChange={onToolpathVisibilityChange}
          className="sketch-toolpath-vis"
        />
      )}
      {constraint.constraintEdit && (
        <CanvasWorkflowPanel
          title="Edit Constraint"
          step="Set distance"
          position={constraint.constraintEditWorkflowPanel.position}
          panelRef={constraint.constraintEditWorkflowPanel.panelRef}
          handleProps={constraint.constraintEditWorkflowPanel.handleProps}
          actionRowProps={constraint.constraintEditWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--constraint-edit"
          moveLabel="Move constraint edit controls"
          actions={(
            <>
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--confirm"
                onClick={constraint.commitConstraintEditFromPanel}
              >Apply</button>
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={constraint.cancelConstraintEditFromPanel}
              >Cancel</button>
            </>
          )}
        >
          <label className="canvas-workflow-panel__field">
            <span>Distance</span>
            <input
              key={`constraint-edit-${constraint.constraintEdit.constraintId}`}
              ref={constraint.constraintEditInputRef}
              className="canvas-workflow-panel__count-input canvas-workflow-panel__distance-input"
              type="text"
              inputMode="decimal"
              value={constraint.constraintEdit.value}
              onChange={(e) => constraint.setConstraintEdit((prev) => prev ? { ...prev, value: e.target.value } : null)}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  constraint.commitConstraintEditFromPanel()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  constraint.cancelConstraintEditFromPanel()
                }
              }}
              autoFocus
            />
          </label>
        </CanvasWorkflowPanel>
      )}
      {pendingOffset && (
        <CanvasWorkflowPanel
          title="Offset"
          step={offset.offsetDistanceEditActive ? 'Set distance' : 'Preview distance'}
          position={offset.offsetWorkflowPanel.position}
          panelRef={offset.offsetWorkflowPanel.panelRef}
          handleProps={offset.offsetWorkflowPanel.handleProps}
          actionRowProps={offset.offsetWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--offset"
          moveLabel="Move offset controls"
          actions={(
            <>
              {offset.offsetDistanceEditActive ? (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={offset.commitOffsetDistanceEditFromPanel}
                >Confirm</button>
              ) : (
                <button
                  type="button"
                  className="tablet-cmd-btn"
                  onClick={offset.triggerDimensionFromOffsetPanel}
                >Distance</button>
              )}
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={offset.cancelOffsetFromPanel}
              >Cancel</button>
            </>
          )}
        >
          {offset.offsetDistanceEditActive && operationDimEdit?.kind === 'offset' ? (
            <div className="canvas-workflow-panel__meta">
              <label className="canvas-workflow-panel__field">
                <span>Distance</span>
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
              Move inside or outside the feature to preview. Click to commit.
            </div>
          )}
        </CanvasWorkflowPanel>
      )}
      {showJoinFlowPanel && pendingShapeAction?.kind === 'join' && (
        <CanvasWorkflowPanel
          title="Join"
          step="Select features"
          position={joinWorkflowPanel.position}
          panelRef={joinWorkflowPanel.panelRef}
          handleProps={joinWorkflowPanel.handleProps}
          actionRowProps={joinWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--join"
          moveLabel="Move join controls"
          actions={(
            <>
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--confirm"
                disabled={pendingShapeAction.entityIds.length < 2}
                onClick={completeJoinFromPanel}
              >Confirm</button>
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={cancelJoinFromPanel}
              >Cancel</button>
            </>
          )}
        >
          <div className="canvas-workflow-panel__summary">
            {pendingShapeAction.entityIds.length < 2
              ? 'Select at least two closed features.'
              : `${pendingShapeAction.entityIds.length} closed features selected.`}
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
              <span>Keep originals</span>
            </label>
          </div>
        </CanvasWorkflowPanel>
      )}
      {showCutFlowPanel && pendingShapeAction?.kind === 'cut' && (
        <CanvasWorkflowPanel
          title="Cut"
          step={pendingShapeAction.phase === 'cutters' ? 'Select cutters' : 'Select targets'}
          position={cutWorkflowPanel.position}
          panelRef={cutWorkflowPanel.panelRef}
          handleProps={cutWorkflowPanel.handleProps}
          actionRowProps={cutWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--cut"
          moveLabel="Move cut controls"
          actions={(
            <>
              {pendingShapeAction.phase === 'cutters' ? (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  disabled={pendingShapeAction.cutterIds.length === 0}
                  onClick={confirmCutCuttersFromTabletPanel}
                >Next</button>
              ) : (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  disabled={pendingShapeAction.targetIds.length === 0}
                  onClick={completeCutFromTabletPanel}
                >Confirm</button>
              )}
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={cancelCutFromTabletPanel}
              >Cancel</button>
            </>
          )}
        >
          <div className="canvas-workflow-panel__summary">
            {pendingShapeAction.phase === 'cutters'
              ? pendingShapeAction.cutterIds.length === 0
                ? 'Select features to mark cutters.'
                : `${pendingShapeAction.cutterIds.length} cutter${pendingShapeAction.cutterIds.length === 1 ? '' : 's'} selected.`
              : pendingShapeAction.targetIds.length === 0
                ? `${pendingShapeAction.cutterIds.length} cutter${pendingShapeAction.cutterIds.length === 1 ? '' : 's'} locked. Select target features.`
                : `${pendingShapeAction.targetIds.length} target${pendingShapeAction.targetIds.length === 1 ? '' : 's'} selected.`}
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
              <span>Keep originals</span>
            </label>
          </div>
        </CanvasWorkflowPanel>
      )}
      {creation.creationPanelShape && pendingAdd && (
        <CanvasWorkflowPanel
          title={
            creation.creationPanelShape === 'rect' ? 'Rectangle'
            : creation.creationPanelShape === 'circle' ? 'Circle'
            : creation.creationPanelShape === 'ellipse' ? 'Ellipse'
            : creation.creationPanelShape === 'tab' ? 'Tab'
            : creation.creationPanelShape === 'clamp' ? 'Clamp'
            : creation.creationPanelShape === 'polygon' ? 'Polygon'
            : creation.creationPanelShape === 'spline' ? 'Spline'
            : 'Composite'
          }
          step={
            creation.creationDimEditActive ? 'Enter dimensions'
            : creation.creationPanelShape === 'composite'
              ? (pendingAdd.shape === 'composite' && pendingAdd.start
                ? (pendingAdd.currentMode === 'arc' && pendingAdd.pendingArcEnd
                  ? 'Click arc curvature point'
                  : `Add ${pendingAdd.currentMode} points`)
                : 'Click first point')
            : (creation.creationPanelShape === 'polygon' || creation.creationPanelShape === 'spline')
              ? (creation.creationPanelHasPoints
                ? ('points' in pendingAdd && pendingAdd.points.length < 2
                  ? 'Add one more point'
                  : 'Add points or close')
                : 'Click first point')
            : creation.creationPanelHasAnchor
              ? (creation.creationPanelShape === 'circle'
                ? 'Click to set radius or enter dimensions'
                : creation.creationPanelShape === 'ellipse'
                  ? 'Click to set radii or enter dimensions'
                  : 'Click opposite corner or enter dimensions')
              : (creation.creationPanelShape === 'circle' || creation.creationPanelShape === 'ellipse')
                ? 'Click center point'
                : 'Click first corner'
          }
          position={creation.creationWorkflowPanel.position}
          panelRef={creation.creationWorkflowPanel.panelRef}
          handleProps={creation.creationWorkflowPanel.handleProps}
          actionRowProps={creation.creationWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--creation"
          moveLabel="Move creation controls"
          actions={(
            <>
              {creation.creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={creation.commitCreationDimensionEdit}
                >Confirm</button>
              )}
              {(pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline') && 'points' in pendingAdd && pendingAdd.points.length >= 2 && creationTarget !== 'region' && !creation.creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={creation.finishOpenPathFromPanel}
                >Finish</button>
              )}
              {pendingAdd.shape === 'composite' && pendingAdd.segments.length >= 1 && !pendingAdd.pendingArcEnd && creationTarget !== 'region' && !creation.creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={creation.finishOpenCompositeFromPanel}
                >Finish</button>
              )}
              {creation.creationCanDimEdit && !creation.creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn"
                  onClick={creation.triggerDimensionFromCreationPanel}
                >Dimensions</button>
              )}
              {(creation.creationPanelHasPoints || (pendingAdd.shape === 'composite' && pendingAdd.start)) && !creation.creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn"
                  onClick={creation.undoFromCreationPanel}
                >Undo</button>
              )}
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={creation.cancelCreationFromPanel}
              >Cancel</button>
            </>
          )}
        >
          {pendingAdd.shape === 'composite' && pendingAdd.start && !pendingAdd.closed && !creation.creationDimEditActive && (
            <div className="canvas-workflow-panel__meta canvas-workflow-panel__mode-row">
              <button
                type="button"
                className={`tablet-cmd-btn ${pendingAdd.currentMode === 'line' ? 'tablet-cmd-btn--active' : ''}`}
                onClick={() => creation.setCompositeModeFromPanel('line')}
              >Line</button>
              <button
                type="button"
                className={`tablet-cmd-btn ${pendingAdd.currentMode === 'arc' ? 'tablet-cmd-btn--active' : ''}`}
                onClick={() => creation.setCompositeModeFromPanel('arc')}
              >Arc</button>
              <button
                type="button"
                className={`tablet-cmd-btn ${pendingAdd.currentMode === 'spline' ? 'tablet-cmd-btn--active' : ''}`}
                onClick={() => creation.setCompositeModeFromPanel('spline')}
              >Spline</button>
            </div>
          )}
          {creation.creationDimEditActive && dimEdit.dimensionEdit && (
            <div className="canvas-workflow-panel__meta">
              {dimEdit.dimensionEdit.shape === 'circle' ? (
                <label className="canvas-workflow-panel__field">
                  <span>Radius</span>
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
                  <span>Radius</span>
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
                    <span>Length</span>
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
                    <span>Angle</span>
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
                      <span>Radius</span>
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
              ) : (
                <>
                  <label className="canvas-workflow-panel__field">
                    <span>Width</span>
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
                    <span>Height</span>
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
          {pendingDraftHasSelfIntersection ? (
            <div className="sketch-banner-warning">This profile self-intersects. 3D/CAM results may be invalid.</div>
          ) : null}
          {pendingDraftExceedsStock ? (
            <div className="sketch-banner-warning">This profile extends outside the stock boundary.</div>
          ) : null}
        </CanvasWorkflowPanel>
      )}
      {creation.placementPanelActive && (
        <CanvasWorkflowPanel
          title={pendingAdd!.shape === 'origin' ? 'Place Origin' : 'Place Text'}
          step={
            pendingAdd!.shape === 'origin'
              ? 'Click the sketch to place machine X0 Y0. Z remains manual in Properties.'
              : 'Tap the sketch to place the text.'
          }
          position={creation.placementWorkflowPanel.position}
          panelRef={creation.placementWorkflowPanel.panelRef}
          handleProps={creation.placementWorkflowPanel.handleProps}
          actions={
            <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={cancelPendingAdd}>Cancel</button>
          }
        >
          {null}
        </CanvasWorkflowPanel>
      )}
      {pendingConstraint && (
        <CanvasWorkflowPanel
          title="Constraint"
          step={
            !pendingConstraint.anchor
              ? 'Pick anchor point'
              : !pendingConstraint.reference
                ? 'Pick reference point'
                : 'Set distance'
          }
          position={constraint.constraintWorkflowPanel.position}
          panelRef={constraint.constraintWorkflowPanel.panelRef}
          handleProps={constraint.constraintWorkflowPanel.handleProps}
          actions={constraint.constraintDistanceReady ? (
            <>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={constraint.commitConstraintFromPanel}>Confirm</button>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={constraint.cancelConstraintFromPanel}>Cancel</button>
            </>
          ) : (
            <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={constraint.cancelConstraintFromPanel}>Cancel</button>
          )}
        >
          {constraint.constraintDistanceReady && constraint.constraintDistanceInput != null && (
            <label className="canvas-workflow-panel__field">
              <span>Distance</span>
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
            <div className="canvas-workflow-panel__summary">Tap a snap point on this feature.</div>
          )}
          {pendingConstraint.anchor && !pendingConstraint.reference && (
            <div className="canvas-workflow-panel__summary">Tap a snap point on another feature.</div>
          )}
        </CanvasWorkflowPanel>
      )}
      {pendingMove && (
        <CanvasWorkflowPanel
          title={pendingMove.mode === 'copy' ? 'Copy' : 'Move'}
          step={move.moveDistanceEditActive
            ? 'Set distance'
            : !pendingMove.fromPoint
              ? 'Select from point'
              : !pendingMove.toPoint
                ? 'Select target point'
                : pendingMove.mode === 'copy'
                  ? 'Set copy count'
                  : undefined}
          position={move.moveWorkflowPanel.position}
          panelRef={move.moveWorkflowPanel.panelRef}
          handleProps={move.moveWorkflowPanel.handleProps}
          actionRowProps={move.moveWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--move"
          moveLabel={`Move ${pendingMove.mode} controls`}
          actions={(
            <>
              {move.moveDistanceEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={move.commitMoveDistanceEditFromPanel}
                >Confirm</button>
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
                >Confirm</button>
              )}
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={move.cancelMoveFromPanel}
              >Cancel</button>
            </>
          )}
        >
          {pendingMove.fromPoint && !pendingMove.toPoint && (
            <div className="canvas-workflow-panel__summary">
              Select a target point to set the direction and default distance.
            </div>
          )}
          {move.moveDistanceEditActive && (operationDimEdit?.kind === 'move' || operationDimEdit?.kind === 'copy') && (
            <div className="canvas-workflow-panel__meta">
              <label className="canvas-workflow-panel__field">
                <span>Distance</span>
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
                <span>Copies</span>
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
          title={pendingTransform.mode === 'resize' ? 'Resize' : pendingTransform.mode === 'mirror' ? 'Mirror' : 'Rotate'}
          step={transformExact.transformExactEditActive
            ? transformExact.transformScaleEditActive ? 'Set scale' : 'Set angle'
            : transformExact.rotateCopyCountPromptActive
            ? 'Set copy count'
            : pendingTransform.mode === 'resize'
              ? !pendingTransform.referenceStart
                ? 'Select first reference'
                : !pendingTransform.referenceEnd
                  ? 'Select second reference'
                  : 'Scale to commit'
              : pendingTransform.mode === 'mirror'
                ? !pendingTransform.referenceStart
                  ? 'Select first line point'
                  : 'Select second line point'
                : !pendingTransform.referenceStart
                  ? 'Select origin'
                  : !pendingTransform.referenceEnd
                    ? 'Select reference direction'
                    : 'Rotate to commit'}
          position={transformExact.transformWorkflowPanel.position}
          panelRef={transformExact.transformWorkflowPanel.panelRef}
          handleProps={transformExact.transformWorkflowPanel.handleProps}
          actionRowProps={transformExact.transformWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--transform"
          moveLabel={`Move ${pendingTransform.mode} controls`}
          actions={(
            <>
              {transformExact.transformExactEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={transformExact.commitTransformExactEditFromPanel}
                >Confirm</button>
              )}
              {!transformExact.transformExactEditActive && !transformExact.rotateCopyCountPromptActive
                && ((pendingTransform.mode === 'resize' && pendingTransform.referenceStart && pendingTransform.referenceEnd)
                  || (pendingTransform.mode === 'rotate' && pendingTransform.referenceStart && pendingTransform.referenceEnd)) && (
                <button
                  type="button"
                  className="tablet-cmd-btn"
                  onClick={transformExact.triggerDimensionFromTransformPanel}
                >{pendingTransform.mode === 'resize' ? 'Scale' : 'Angle'}</button>
              )}
              {!transformExact.transformExactEditActive && transformExact.rotateCopyCountPromptActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={transformExact.commitRotateCopyFromPanel}
                >Confirm</button>
              )}
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={transformExact.cancelTransformFromPanel}
              >Cancel</button>
            </>
          )}
        >
          {transformExact.transformExactEditActive && (operationDimEdit?.kind === 'scale' || operationDimEdit?.kind === 'rotate') ? (
            <div className="canvas-workflow-panel__meta">
              <label className="canvas-workflow-panel__field">
                <span>{operationDimEdit.kind === 'scale' ? 'Scale' : 'Angle'}</span>
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
                  <span>Copies</span>
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
                    ? 'Move along the reference line to preview, then click to commit.'
                    : pendingTransform.mode === 'mirror'
                      ? 'Move to preview, then click the second mirror line point.'
                      : pendingTransform.keepOriginals
                        ? 'Move to preview the rotated copy, then click to set angle.'
                        : 'Move to preview, then click to commit.'}
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
                    <span>Keep originals</span>
                  </label>
                </div>
              )}
            </>
          )}
        </CanvasWorkflowPanel>
      )}
      {tapeMeasure && (
        <CanvasWorkflowPanel
          title="Tape measure"
          step={tapeMeasure.first ? 'Click the second point' : 'Click the first point'}
          position={tapeWorkflowPanel.position}
          panelRef={tapeWorkflowPanel.panelRef}
          handleProps={tapeWorkflowPanel.handleProps}
          actions={(
            <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={() => { clearTapeMeasure(); tapeWorkflowPanel.focusCanvasAfterAction() }}>Done</button>
          )}
        >
          <div className="canvas-workflow-panel__summary">
            Snaps to geometry. The measurement stays until your next click — Esc or Done to exit.
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
            <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={() => { cancelPendingDimension(); dimensionWorkflowPanel.focusCanvasAfterAction() }}>Cancel</button>
          )}
        >
          <div className="canvas-workflow-panel__summary">
            Click points to anchor the dimension to geometry. Esc to cancel.
          </div>
        </CanvasWorkflowPanel>
      )}
      {dimensionDeleteArmed && (
        <CanvasWorkflowPanel
          title="Delete dimension"
          step="Click a dimension to delete"
          position={dimensionDeleteWorkflowPanel.position}
          panelRef={dimensionDeleteWorkflowPanel.panelRef}
          handleProps={dimensionDeleteWorkflowPanel.handleProps}
          actions={(
            <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={() => { setDimensionDeleteArmed(false); dimensionDeleteWorkflowPanel.focusCanvasAfterAction() }}>Done</button>
          )}
        >
          <div className="canvas-workflow-panel__summary">
            Click each dimension you want to remove. Esc or Done to finish.
          </div>
        </CanvasWorkflowPanel>
      )}
      {editModeActive && (
        <CanvasWorkflowPanel
          title="Edit"
          step={
            editFilletActive ? selection.sketchEditTool === 'chamfer' ? 'Enter distance' : 'Enter radius'
            : editDimEditActive ? 'Enter dimensions'
            : selection.sketchEditTool === 'add_point' ? 'Click to add points'
            : selection.sketchEditTool === 'delete_point' ? 'Click to delete points'
            : selection.sketchEditTool === 'delete_segment' ? 'Click to delete segments'
            : selection.sketchEditTool === 'disconnect' ? 'Click an anchor to split'
            : selection.sketchEditTool === 'fillet' ? (fillet.filletCornerPicked ? 'Click second point or enter radius' : 'Click a corner')
            : selection.sketchEditTool === 'chamfer' ? (fillet.filletCornerPicked ? 'Click second point or enter distance' : 'Click a corner')
            : 'Drag nodes or click segments'
          }
          position={editWorkflowPanel.position}
          panelRef={editWorkflowPanel.panelRef}
          handleProps={editWorkflowPanel.handleProps}
          actions={editFilletActive ? (
            <>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={commitFilletFromPanel}>Apply</button>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={cancelFilletFromPanel}>Cancel</button>
            </>
          ) : editDimEditActive ? (
            <>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={commitEditDimensionFromPanel}>Confirm</button>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={cancelEditDimensionFromPanel}>Cancel</button>
            </>
          ) : (
            <>
              {dimEdit.armedForDimension && (
                <button type="button" className="tablet-cmd-btn" onClick={() => { triggerDimensionEdit(); dimEdit.setArmedForDimension(false) }}>Dimension</button>
              )}
              {fillet.filletCornerPicked && !editFilletActive && (
                <button type="button" className="tablet-cmd-btn" onClick={() => fillet.enterFilletRadiusEdit()}>{selection.sketchEditTool === 'chamfer' ? 'Distance' : 'Radius'}</button>
              )}
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={applyEditFromPanel}>Apply</button>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={cancelEditFromPanel}>Cancel</button>
            </>
          )}
        >
          {editFilletActive ? (
            <label className="canvas-workflow-panel__field">
              <span>{selection.sketchEditTool === 'chamfer' ? 'Distance' : 'Radius'}</span>
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
                <span>Radius</span>
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
                  <span>Length</span>
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
                  <span>Angle</span>
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
                <div className="canvas-workflow-panel__summary" style={{ color: 'var(--warning)' }}>Self-intersecting profile</div>
              )}
              {editingFeatureExceedsStock && (
                <div className="canvas-workflow-panel__summary" style={{ color: 'var(--warning)' }}>Extends outside stock</div>
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
          title="Click to cycle axis lock (Alt)"
        >{lockMode === 'x' ? 'Lock X' : 'Lock Y'}</button>
      )}
      {isTablet && (
        <div className="tablet-command-bar">
          <button
            type="button"
            className={`tablet-cmd-btn ${lockMode !== 'none' ? 'tablet-cmd-btn--active' : ''}`}
            style={{ borderColor: lockModeGuideColor(lockMode) }}
            onClick={cycleLock}
          >{lockMode === 'none' ? 'Lock' : lockMode === 'x' ? 'Lock X' : 'Lock Y'}</button>
          {/* Multi-select toggle */}
          {selection.mode === 'feature' && !pendingAdd && !pendingMove && !pendingTransform && !pendingOffset && (
            <button
              type="button"
              className={`tablet-cmd-btn ${(multiSelectMode || !!pendingShapeAction) ? 'tablet-cmd-btn--active' : ''}`}
              disabled={!!pendingShapeAction}
              title={pendingShapeAction ? 'Multi-select is automatic for Join and Cut' : 'Toggle multi-select'}
              onClick={() => setMultiSelectMode((prev) => !prev)}
            >Multi</button>
          )}
        </div>
      )}
    </div>
  )
})
