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
import type { KeyboardEvent, MouseEvent, PointerEvent as ReactPointerEvent, WheelEvent } from 'react'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import { ToolpathVisibilityPanel } from '../ToolpathVisibilityPanel'
import type { ToolpathVisibility } from '../toolpathVisibility'
import type { SnapMode, SnapSettings } from '../../sketch/snapping'
import type { OpenProfileEndpoint, SketchControlRef, SketchEditTool } from '../../store/types'
import { useProjectStore } from '../../store/projectStore'
import { previewOffsetFeatures } from '../../store/helpers/derivedFeatures'
import { filletFeatureFromPoint, filletFeatureFromRadius, filletRadiusFromPoint, mirrorFeatureFromReference, resizeBackdropFromReference, resizeFeatureFromReference, rotateBackdropFromReference, rotateFeatureFromReference } from '../../store/helpers/referenceTransforms'
import {
  buildArcSegmentFromThreePoints,
  buildPendingDraftProfile,
  buildPendingProfile,
  compositeDraftPoints,
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
  computeLinearInputLabel,
  computeMoveDistancePreviewPoint,
  computeRotateDegreesFromPreview,
  computeRotatePreviewPoint,
  computeScaleFactorFromPreview,
  computeScalePreviewPoint,
  unitDirection,
} from './manualEntry'
import type { OperationDimEdit } from './manualEntry'
import { useDimensionEditWorkflow } from './useDimensionEditWorkflow'
import { useConstraintWorkflow } from './useConstraintWorkflow'
import { useFilletWorkflow } from './useFilletWorkflow'
import { useMoveWorkflow } from './useMoveWorkflow'
import { resolveSketchSnap } from './snappingHelpers'
import type { ResolvedSnap } from './snappingHelpers'
import { drawDimensions, drawPendingDimensionPreview, drawTapeMeasure, pickDimensionAt } from './dimensionRendering'
import { circleEdgeAnchorFromPoint, offsetForCursor } from '../../sketch/dimensions'
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
  computeFitViewStateForBounds,
  computeViewTransform,
  worldToCanvas,
} from './viewTransform'
import type { CanvasPoint, SketchViewState, ViewTransform } from './viewTransform'
import { findSketchInsertTarget, isLoopCloseCandidate, nearestPointOnSegmentWithT, projectPointOntoLine, resolveOffsetPreview } from './draftGeometry'
import {
  distance2,
  featureFullyInsideRect,
  findHitClampId,
  findHitFeatureId,
  findHitTabId,
  pointsEqual,
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
  hitBackdrop,
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
import type { Clamp, DimensionAnchor, DimensionAnnotation, OperationKind, Point, SketchFeature, Tab } from '../../types/project'
import { compatibleFeatureIdsForOperation } from '../cam/operationValidity'
import { formatLength, parseLengthInput } from '../../utils/units'
import { useAxisLock, lockModeGuideColor } from '../../sketch/useAxisLock'
import { useCanvasGestures } from '../../sketch/useCanvasGestures'
import { useStableEvent } from '../../hooks/useStableEvent'
import { useEventListener } from '../../hooks/useEventListener'
import { useRafScheduler } from '../../hooks/useRafScheduler'
import { useShellMode, isTabletMode } from '../layout/useShellMode'
import { CanvasWorkflowPanel } from './CanvasWorkflowPanel'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

const NODE_HIT_RADIUS = 9
const HANDLE_HIT_RADIUS = 7
const POLYGON_CLOSE_RADIUS = 12
const OPEN_ENDPOINT_JOIN_HIT_RADIUS = 14
const MIN_SKETCH_ZOOM = 0.02

// Stable (module-level) so the wheel listener subscribes once; `passive: false`
// lets handleWheelEvent call preventDefault to suppress page scroll/zoom.
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
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressStartRef = useRef<{ cx: number; cy: number; clientX: number; clientY: number } | null>(null)
  const marqueeStartRef = useRef<CanvasPoint | null>(null)
  const marqueeCurrentRef = useRef<CanvasPoint | null>(null)
  const zoomWindowStartRef = useRef<CanvasPoint | null>(null)
  const zoomWindowCurrentRef = useRef<CanvasPoint | null>(null)
  const suppressClickRef = useRef(false)
  const originPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const activeSnapRef = useRef<ResolvedSnap | null>(null)
  const sketchEditPreviewRef = useRef<SketchEditPreviewPoint | null>(null)
  const pendingSketchExtensionRef = useRef<PendingSketchExtension | null>(null)
  const pendingSketchFilletRef = useRef<PendingSketchFillet | null>(null)
  const pendingPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingMovePreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingTransformPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingOffsetPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const pendingOffsetRawPreviewPointRef = useRef<PendingPreviewPoint | null>(null)
  const livePointerWorldRef = useRef<Point | null>(null)
  const drawRef = useRef<() => void>(() => {})
  // Stable, frame-coalescing redraw. Replaces the former ad-hoc `scheduleDraw`
  // closure + `scheduleDrawRef`; safe to list in / omit from effect deps.
  const scheduleDraw = useRafScheduler(() => drawRef.current())
  const [copyCountDraft, setCopyCountDraft] = useState('1')
  const [rotateCopyCountDraft, setRotateCopyCountDraft] = useState('1')
  const [pendingRotateCopyPoint, setPendingRotateCopyPoint] = useState<Point | null>(null)
  const rotateCopyCountInputRef = useRef<HTMLInputElement>(null)
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
  const transformScaleEditActive =
    !!pendingTransform
    && pendingTransform.mode === 'resize'
    && !!pendingTransform.referenceStart
    && !!pendingTransform.referenceEnd
    && operationDimEdit?.kind === 'scale'
  const transformRotateEditActive =
    !!pendingTransform
    && pendingTransform.mode === 'rotate'
    && !!pendingTransform.referenceStart
    && !!pendingTransform.referenceEnd
    && operationDimEdit?.kind === 'rotate'
  const transformExactEditActive = transformScaleEditActive || transformRotateEditActive
  const offsetDistanceEditActive = !!pendingOffset && operationDimEdit?.kind === 'offset'
  const rotateCopyCountPromptActive = !!pendingRotateCopyPoint
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
  const transformWorkflowPanel = useCanvasWorkflowPanel({
    open: !!pendingTransform,
    phaseKey: transformExactEditActive ? 'exact' : pendingTransform?.referenceEnd ? 'commit' : (pendingTransform?.referenceStart ? 'end' : 'start'),
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })
  const offsetWorkflowPanel = useCanvasWorkflowPanel({
    open: !!pendingOffset,
    phaseKey: offsetDistanceEditActive ? 'distance' : 'offset',
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })
  const creationPanelShape = pendingAdd && (
    pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'ellipse'
    || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp'
    || pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline' || pendingAdd.shape === 'composite'
  ) ? pendingAdd.shape : null
  const creationPanelHasAnchor = creationPanelShape && pendingAdd && 'anchor' in pendingAdd && !!pendingAdd.anchor
  const creationPanelHasPoints = creationPanelShape && pendingAdd && 'points' in pendingAdd && pendingAdd.points.length > 0
  const creationPanelHasStart = creationPanelShape === 'composite' && pendingAdd?.shape === 'composite' && !!pendingAdd.start
  const creationCanDimEdit = creationPanelHasAnchor || creationPanelHasPoints || (creationPanelHasStart && pendingAdd?.shape === 'composite' && !pendingAdd.closed)
  const creationDimEditActive = !!creationCanDimEdit && !!dimEdit.dimensionEdit
  const creationWorkflowPanel = useCanvasWorkflowPanel({
    open: !!creationPanelShape,
    phaseKey: creationDimEditActive ? 'dimensions'
      : creationPanelHasAnchor ? 'place'
      : creationPanelHasPoints ? 'adding'
      : creationPanelHasStart ? 'drawing'
      : 'start',
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })

  const placementPanelActive = !!pendingAdd && !creationPanelShape
  const placementWorkflowPanel = useCanvasWorkflowPanel({
    open: placementPanelActive,
    phaseKey: pendingAdd?.shape ?? 'place',
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })

  const editModeActive = selection.mode === 'sketch_edit' && !pendingAdd
  const editDimEditActive = editModeActive && !!dimEdit.dimensionEdit
  const editWorkflowPanel = useCanvasWorkflowPanel({
    open: editModeActive,
    phaseKey: editDimEditActive ? 'dimensions' : 'editing',
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

  // Transient-preview ref setters. Wrapped in `useStableEvent` so they have a
  // stable identity and can be listed as effect deps without re-subscribing
  // (the bodies only touch refs, the stable `scheduleDraw`, and props).
  const updateActiveSnap = useStableEvent((nextSnap: ResolvedSnap | null) => {
    activeSnapRef.current = nextSnap?.mode ? nextSnap : null
    onActiveSnapModeChange?.(nextSnap?.mode ?? null)
    scheduleDraw()
  })

  const setPendingPreviewPointRef = useStableEvent((nextPoint: PendingPreviewPoint | null) => {
    pendingPreviewPointRef.current = nextPoint
    scheduleDraw()
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
    stopPan()
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

  function cancelTransformFromPanel() {
    cancelPendingTransform()
    setPendingTransformPreviewPointRef(null)
    setPendingRotateCopyPoint(null)
    setRotateCopyCountDraft('1')
    setOperationDimEdit(null)
    transformWorkflowPanel.focusCanvasAfterAction()
  }

  function triggerDimensionFromTransformPanel() {
    triggerDimensionEdit()
    transformWorkflowPanel.focusCanvasAfterAction()
  }

  function commitTransformExactEditFromPanel() {
    const currentEdit = operationDimEditRef.current
    const pendingTransform = pendingTransformRef.current
    if (!currentEdit || !pendingTransform?.referenceStart || !pendingTransform.referenceEnd) return

    if (currentEdit.kind === 'scale') {
      if (pendingTransform.mode !== 'resize') return
      const factor = Number(currentEdit.factor)
      if (!Number.isFinite(factor) || factor <= 0) return
      const previewPoint = computeScalePreviewPoint(
        pendingTransform.referenceStart,
        pendingTransform.referenceEnd,
        factor,
      )
      completePendingTransform(previewPoint)
      setPendingTransformPreviewPointRef(null)
      setOperationDimEdit(null)
      transformWorkflowPanel.focusCanvasAfterAction()
      return
    }

    if (currentEdit.kind === 'rotate') {
      if (pendingTransform.mode !== 'rotate') return
      const angleDegrees = Number(currentEdit.angle)
      if (!Number.isFinite(angleDegrees)) return
      const previewPoint = computeRotatePreviewPoint(
        pendingTransform.referenceStart,
        pendingTransform.referenceEnd,
        angleDegrees,
      )
      if (pendingTransform.keepOriginals) {
        setPendingRotateCopyPoint(previewPoint)
      } else {
        completePendingTransform(previewPoint)
        setPendingTransformPreviewPointRef(null)
      }
      setOperationDimEdit(null)
      transformWorkflowPanel.focusCanvasAfterAction()
    }
  }

  function cancelOffsetFromPanel() {
    cancelPendingOffset()
    setPendingOffsetPreviewPointRef(null)
    setPendingOffsetRawPreviewPointRef(null)
    setOperationDimEdit(null)
    offsetWorkflowPanel.focusCanvasAfterAction()
  }

  function triggerDimensionFromOffsetPanel() {
    triggerDimensionEdit()
    offsetWorkflowPanel.focusCanvasAfterAction()
  }

  function commitOffsetDistanceEditFromPanel() {
    const currentEdit = operationDimEditRef.current
    if (!currentEdit || currentEdit.kind !== 'offset') return
    const distance = parseLengthInput(currentEdit.distance, projectRef.current.meta.units)
    if (distance === null) return
    completePendingOffset(distance)
    setPendingOffsetPreviewPointRef(null)
    setPendingOffsetRawPreviewPointRef(null)
    setOperationDimEdit(null)
    offsetWorkflowPanel.focusCanvasAfterAction()
  }

  function triggerDimensionFromCreationPanel() {
    triggerDimensionEdit()
  }

  function commitCreationDimensionEdit() {
    const edit = dimEdit.dimensionEditRef.current
    if (!edit) return
    const pt = computeDimensionEditPreviewPoint(edit, projectRef.current.meta.units)
    const pendingAdd = pendingAddRef.current
    if ((edit.shape === 'polygon' || edit.shape === 'spline') && (pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline')) {
      addPendingPolygonPoint(pt)
      setPendingPreviewPointRef({ point: pt, session: pendingAdd.session })
      dimEdit.setDimensionEdit(null)
      creationWorkflowPanel.focusCanvasAfterAction()
    } else if (pendingAdd?.shape === 'composite') {
      if (pendingAdd.currentMode === 'arc' && !pendingAdd.pendingArcEnd && edit.radius) {
        const units = projectRef.current.meta.units
        const r = parseLengthInput(edit.radius, units)
        if (r != null && r > 0) {
          addPendingCompositePoint(pt)
          const arcStart = edit.anchor
          const arcEnd = pt
          const midX = (arcStart.x + arcEnd.x) / 2
          const midY = (arcStart.y + arcEnd.y) / 2
          const chordDx = arcEnd.x - arcStart.x
          const chordDy = arcEnd.y - arcStart.y
          const halfChord = Math.hypot(chordDx, chordDy) / 2
          if (halfChord > 1e-9 && r >= halfChord) {
            const chordLen = halfChord * 2
            const perpX = -chordDy / chordLen
            const perpY = chordDx / chordLen
            const sagitta = r - Math.sqrt(r * r - halfChord * halfChord)
            const throughPt = { x: midX + sagitta * perpX, y: midY + sagitta * perpY }
            addPendingCompositePoint(throughPt)
            setPendingPreviewPointRef({ point: arcEnd, session: pendingAdd.session })
          } else {
            setPendingPreviewPointRef({ point: pt, session: pendingAdd.session })
          }
          dimEdit.setDimensionEdit(null)
          creationWorkflowPanel.focusCanvasAfterAction()
          return
        }
      }
      if (edit.arcStart && edit.arcEnd) {
        addPendingCompositePoint(pt)
        const arcEnd = edit.arcEnd
        setPendingPreviewPointRef({ point: arcEnd, session: pendingAdd.session })
        dimEdit.setDimensionEdit(null)
        creationWorkflowPanel.focusCanvasAfterAction()
      } else {
        addPendingCompositePoint(pt)
        setPendingPreviewPointRef({ point: pt, session: pendingAdd.session })
        dimEdit.setDimensionEdit(null)
        creationWorkflowPanel.focusCanvasAfterAction()
      }
    } else {
      placePendingAddAt(pt)
      setPendingPreviewPointRef(null)
      dimEdit.setDimensionEdit(null)
      creationWorkflowPanel.focusCanvasAfterAction()
    }
  }

  function cancelCreationDimensionEdit() {
    dimEdit.setDimensionEdit(null)
    creationWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelCreationFromPanel() {
    cancelPendingAdd()
    dimEdit.setDimensionEdit(null)
    creationWorkflowPanel.focusCanvasAfterAction()
  }

  function undoFromCreationPanel() {
    const pendingAdd = pendingAddRef.current
    if (pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline') {
      undoPendingPolygonPoint()
    } else if (pendingAdd?.shape === 'composite') {
      undoPendingCompositeStep()
    }
    creationWorkflowPanel.focusCanvasAfterAction()
  }

  function finishOpenPathFromPanel() {
    completePendingOpenPath()
    setPendingPreviewPointRef(null)
    creationWorkflowPanel.focusCanvasAfterAction()
  }

  function finishOpenCompositeFromPanel() {
    completePendingOpenComposite()
    creationWorkflowPanel.focusCanvasAfterAction()
  }

  function setCompositeModeFromPanel(mode: 'line' | 'arc' | 'spline') {
    setPendingCompositeMode(mode)
    creationWorkflowPanel.focusCanvasAfterAction()
  }

  function applyEditFromPanel() {
    stopNodeDrag()
    resetLock()
    applySketchEdit()
    editWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelEditFromPanel() {
    stopNodeDrag()
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

  function isActiveSnapPoint(point: Point | null | undefined): boolean {
    return !!point && !!activeSnapRef.current?.mode && pointsEqual(point, activeSnapRef.current.point, 1e-6)
  }

  function currentSnapReferencePoint(): Point | null {
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingAdd = pendingAddRef.current
    const pendingConstraintLive = pendingConstraintRef.current

    if (pendingConstraintLive?.anchor && !pendingConstraintLive.reference) {
      return pendingConstraintLive.anchor.point
    }

    if (pendingMove?.fromPoint) {
      return pendingMove.fromPoint
    }

    if (pendingTransform?.mode === 'rotate' || pendingTransform?.mode === 'mirror') {
      return pendingTransform.referenceStart
    }

    if ((pendingAdd?.shape === 'rect' || pendingAdd?.shape === 'circle' || pendingAdd?.shape === 'ellipse' || pendingAdd?.shape === 'tab' || pendingAdd?.shape === 'clamp') && pendingAdd.anchor) {
      return pendingAdd.anchor
    }

    if ((pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline') && pendingAdd.points.length > 0) {
      return pendingAdd.points[pendingAdd.points.length - 1]
    }

    if (pendingAdd?.shape === 'composite') {
      return pendingAdd.pendingArcEnd ?? pendingAdd.lastPoint ?? pendingAdd.start ?? null
    }

    return null
  }

  function requiresResolvedSnapForPointPick(): boolean {
    const snapSettings = snapSettingsRef.current
    return snapSettings.enabled && snapSettings.modes.length > 0
  }

  function resolveCurrentSketchSnap(
    rawPoint: Point,
    vt: ViewTransform,
    options?: {
      excludeActiveEditGeometry?: boolean
    },
  ): ResolvedSnap {
    const selection = selectionRef.current
    const excludeFeatureId =
      options?.excludeActiveEditGeometry && selection.selectedNode?.type === 'feature'
        ? selection.selectedNode.featureId
        : null
    const excludeTabId =
      options?.excludeActiveEditGeometry && selection.selectedNode?.type === 'tab'
        ? selection.selectedNode.tabId
        : null
    const excludeClampId =
      options?.excludeActiveEditGeometry && selection.selectedNode?.type === 'clamp'
        ? selection.selectedNode.clampId
        : null

    return resolveSketchSnap({
      rawPoint,
      vt,
      snapSettings: snapSettingsRef.current,
      project: projectRef.current,
      referencePoint: currentSnapReferencePoint(),
      excludeFeatureId,
      excludeTabId,
      excludeClampId,
    })
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
  }, [selection.mode, dimEdit])

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
          drawPendingSplineLoop(ctx, pendingAdd.points, currentPreviewPoint, vt, closePreview, project.meta.units, isActiveSnapPoint(currentPreviewPoint), lockModeGuideColor(lockModeRef.current))
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
            isActiveSnapPoint(currentPreviewPoint),
            lockModeGuideColor(lockModeRef.current),
          )
        }
      } else if (currentPreviewPoint) {
        drawPendingPoint(ctx, currentPreviewPoint, vt, isActiveSnapPoint(currentPreviewPoint))
      }
    } else if (pendingAdd?.shape === 'composite') {
      drawCompositeDraft(ctx, pendingAdd, currentPreviewPoint, vt, project.meta.units, isActiveSnapPoint(currentPreviewPoint), lockModeGuideColor(lockModeRef.current))
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
      drawPendingPoint(ctx, currentPreviewPoint, vt, isActiveSnapPoint(currentPreviewPoint))
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
      drawPendingPoint(ctx, currentPreviewPoint, vt, isActiveSnapPoint(currentPreviewPoint))
    } else if (pendingAdd && currentPreviewPoint) {
      drawPendingPoint(ctx, currentPreviewPoint, vt, isActiveSnapPoint(currentPreviewPoint))
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
          drawPendingPoint(ctx, currentMovePreviewPoint, vt, isActiveSnapPoint(currentMovePreviewPoint))
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
          drawPendingPoint(ctx, currentMovePreviewPoint, vt, isActiveSnapPoint(currentMovePreviewPoint))
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
          drawPendingPoint(ctx, currentMovePreviewPoint, vt, isActiveSnapPoint(currentMovePreviewPoint))
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
          drawPendingPoint(ctx, currentMovePreviewPoint, vt, isActiveSnapPoint(currentMovePreviewPoint))
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
          drawPendingPoint(ctx, currentTransformPreviewPoint, vt, isActiveSnapPoint(currentTransformPreviewPoint))
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
          drawPendingPoint(ctx, currentTransformPreviewPoint, vt, isActiveSnapPoint(currentTransformPreviewPoint))
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
        drawPendingPoint(ctx, visibleReferenceEnd, vt, isActiveSnapPoint(visibleReferenceEnd))
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
        drawPendingPoint(ctx, currentTransformPreviewPoint, vt, isActiveSnapPoint(currentTransformPreviewPoint))
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
        drawPendingPoint(ctx, currentTransformPreviewPoint, vt, isActiveSnapPoint(currentTransformPreviewPoint))
      }
    }

    if (pendingOffset) {
      const features = pendingOffset.entityIds
        .map((featureId) => project.features.find((entry) => entry.id === featureId) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)
        .filter((feature) => feature.sketch.profile.closed)
      const rawOffsetPoint = currentOffsetRawPreviewPoint ?? livePointerWorldRef.current ?? activeSnapRef.current?.rawPoint ?? null
      const snappedOffsetPoint = currentOffsetPreviewPoint ?? activeSnapRef.current?.point ?? rawOffsetPoint

      if (snappedOffsetPoint) {
        drawPendingPoint(ctx, snappedOffsetPoint, vt, isActiveSnapPoint(snappedOffsetPoint))
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
          ? resolveOffsetPreview(features, rawOffsetPoint, snappedOffsetPoint, activeSnapRef.current?.mode ?? null, vt)
          : null

      if (previewInput && typedOffsetDistance === null) {
        drawPendingPoint(ctx, previewInput.nearestPoint, vt)
        drawMoveGuide(ctx, previewInput.nearestPoint, snappedOffsetPoint!, vt)
        drawLineLengthMeasurement(ctx, previewInput.nearestPoint, snappedOffsetPoint!, vt, project.meta.units)
      }

      const previewDistance = typedOffsetDistance ?? previewInput?.signedDistance ?? null
      if (previewDistance !== null) {
        const previewFeatures = previewOffsetFeatures(project, pendingOffset.entityIds, previewDistance)
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
        const previewFeature = useTyped
          ? filletFeatureFromRadius(editingFeature, pendingSketchFilletRef.current.anchorIndex, typedRadius)
          : filletFeatureFromPoint(editingFeature, pendingSketchFilletRef.current.anchorIndex, sketchEditPreviewRef.current.point)
        if (previewFeature) {
          drawPreviewProfile(ctx, previewFeature.sketch.profile, vt, 'Fillet preview')
          const arcIndex = pendingSketchFilletRef.current.anchorIndex
          const arcSegment = previewFeature.sketch.profile.segments[arcIndex]
          if (arcSegment?.type === 'arc') {
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
      const liveTapePoint = activeSnapRef.current?.point ?? livePointerWorldRef.current
      drawTapeMeasure(ctx, tape, liveTapePoint, vt, project.meta.units)
    }

    // In-progress permanent dimension: preview from picked anchors to cursor.
    const pendingDim = pendingDimensionRef.current
    if (pendingDim) {
      const livePreviewPoint = activeSnapRef.current?.point ?? livePointerWorldRef.current
      drawPendingDimensionPreview(ctx, pendingDim, livePreviewPoint, vt, project, project.meta.units)
    }

    drawSnapIndicator(ctx, activeSnapRef.current, vt)
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

  useEffect(() => {
    if (!rotateCopyCountPromptActive) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      rotateCopyCountInputRef.current?.focus({ preventScroll: true })
      rotateCopyCountInputRef.current?.select()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [rotateCopyCountPromptActive])

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
    if (selection.mode !== 'sketch_edit' || selection.sketchEditTool !== 'fillet') {
      fillet.setFilletDimensionEdit(null)
    }
  }, [selection.mode, selection.sketchEditTool, fillet])

  useEffect(() => {
    if (!pendingAdd && selectionRef.current.mode !== 'sketch_edit') {
      dimEdit.setDimensionEdit(null)
    }
  }, [pendingAdd, dimEdit])

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

  useEffect(() => {
    const pendingTransform = pendingTransformRef.current
    if (
      !operationDimEdit
      || (operationDimEdit.kind !== 'scale' && operationDimEdit.kind !== 'rotate')
      || !pendingTransform
      || !pendingTransform.referenceStart
      || !pendingTransform.referenceEnd
    ) {
      return
    }

    if (operationDimEdit.kind === 'scale') {
      if (pendingTransform.mode !== 'resize') {
        return
      }
      const factor = Number(operationDimEdit.factor)
      if (!Number.isFinite(factor) || factor <= 0) {
        return
      }
      setPendingTransformPreviewPointRef({
        point: computeScalePreviewPoint(
          pendingTransform.referenceStart,
          pendingTransform.referenceEnd,
          factor,
        ),
        session: pendingTransform.session,
      })
      return
    }

    if (pendingTransform.mode !== 'rotate') {
      return
    }

    const angleDegrees = Number(operationDimEdit.angle)
    if (!Number.isFinite(angleDegrees)) {
      return
    }
    setPendingTransformPreviewPointRef({
      point: computeRotatePreviewPoint(
        pendingTransform.referenceStart,
        pendingTransform.referenceEnd,
        angleDegrees,
      ),
      session: pendingTransform.session,
    })
  }, [operationDimEdit, setPendingTransformPreviewPointRef])

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
    if (move.copyCountPromptActive || rotateCopyCountPromptActive) {
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
  }, [move.copyCountPromptActive, rotateCopyCountPromptActive, operationDimEdit, pendingMove, pendingTransform, pendingOffset, pendingShapeAction, selection.mode, selection.selectedFeatureId, selection.selectedFeatureIds.length])

  // Native pointermove (not React's synthetic) so we can read coalesced events.
  // Routed through useStableEvent so the listener subscribes once while the body
  // still sees the latest state — clears the exhaustive-deps warning without a
  // hand-maintained state dependency list.
  const onCanvasPointerMove = useStableEvent((event: PointerEvent) => {
    if (longPressTimerRef.current && longPressStartRef.current) {
      const dx = event.clientX - longPressStartRef.current.clientX
      const dy = event.clientY - longPressStartRef.current.clientY
      if (dx * dx + dy * dy > 100) {
        clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
        longPressStartRef.current = null
      }
    }
    const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
    const sourceEvent = coalesced.length > 0 ? coalesced[coalesced.length - 1] : event
    handleCanvasPointerMove(canvasCoordinates(sourceEvent))
  })
  useEventListener(canvasRef, 'pointermove', onCanvasPointerMove)

  const onCanvasWheel = useStableEvent((event: globalThis.WheelEvent) => {
    handleWheelEvent(event)
  })
  useEventListener(canvasRef, 'wheel', onCanvasWheel, WHEEL_LISTENER_OPTIONS)

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

  function canvasCoordinates(event: Pick<MouseEvent<HTMLCanvasElement> | WheelEvent<HTMLCanvasElement> | globalThis.WheelEvent, 'clientX' | 'clientY'>): CanvasPoint {
    const rect = canvasRef.current!.getBoundingClientRect()
    return { cx: event.clientX - rect.left, cy: event.clientY - rect.top }
  }

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
    const resolvedSnap = resolveCurrentSketchSnap(livePoint, vt, {
      excludeActiveEditGeometry: isDraggingNodeRef.current || constraintRefPicking,
    })
    const snapped = resolvedSnap.point
    const sketchEditTool = selection.sketchEditTool

    const shouldPreviewSnap =
      !!pendingAdd
      || !!pendingMove
      || !!pendingTransform
      || !!pendingOffset
      || (selection.mode === 'sketch_edit' && (sketchEditTool === 'add_point' || sketchEditTool === 'fillet'))
      || isDraggingNodeRef.current
      || constraintPicking

    updateActiveSnap(shouldPreviewSnap ? resolvedSnap : null)

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
        const target = findSketchSegmentHit(feature.sketch.profile, livePoint, vt)
        sketchEditPreviewRef.current = target ? { point: target.point, mode: 'delete_segment' } : null
        scheduleDraw()
        return
      }

      if (feature && sketchEditTool === 'disconnect') {
        pendingSketchExtensionRef.current = null
        pendingSketchFilletRef.current = null
        const control = hitEditableControl(worldToCanvas(livePoint, vt), { includeSegments: false })
        sketchEditPreviewRef.current =
          control?.kind === 'anchor'
            ? { point: anchorPointForIndex(feature.sketch.profile, control.index), mode: 'disconnect' }
            : null
        scheduleDraw()
        return
      }

      if (feature && sketchEditTool === 'fillet') {
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

  function handlePointerDown(event: ReactPointerEvent<HTMLCanvasElement>) {
    if (isGestureActiveRef.current) return

    if (event.pointerType === 'touch') {
      event.currentTarget.setPointerCapture(event.pointerId)
    }

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }

    if (event.pointerType === 'touch' && event.button === 0) {
      const startCx = event.clientX
      const startCy = event.clientY
      const rect = canvasRef.current?.getBoundingClientRect()
      longPressStartRef.current = {
        cx: rect ? startCx - rect.left : startCx,
        cy: rect ? startCy - rect.top : startCy,
        clientX: startCx,
        clientY: startCy,
      }
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null
        if (longPressStartRef.current) {
          triggerContextMenuAt(longPressStartRef.current.clientX, longPressStartRef.current.clientY)
          suppressClickRef.current = true
          stopPan()
          longPressStartRef.current = null
        }
      }, 500)
    }

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
      updateActiveSnap(null)
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
    const hitFeatureId = findHitFeatureId(world, project.features, vt)
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
      const resolvedSnap = resolveCurrentSketchSnap(world, vt)
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
      const resolvedSnap = resolveCurrentSketchSnap(world, vt)
      const targetPoint = resolvedSnap.mode ? resolvedSnap.point : world
      moveFeatureControl(selection.selectedFeatureId, nextControl, targetPoint)
      updateActiveSnap(resolvedSnap.mode ? resolvedSnap : null)
    }
  }

  function handleCanvasPointerMove(point: CanvasPoint) {
    const canvas = canvasRef.current
    if (!canvas) return

    if (isGestureActiveRef.current) {
      if (isPanningRef.current) stopPan()
      touchDragPendingRef.current = null
      if (longPressTimerRef.current) {
        clearTimeout(longPressTimerRef.current)
        longPressTimerRef.current = null
      }
      longPressStartRef.current = null
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
      updateActiveSnap(null)
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
      updateActiveSnap(null)
      scheduleDraw()
      return
    }

    if (zoomWindowStartRef.current) {
      zoomWindowCurrentRef.current = point
      sketchEditPreviewRef.current = null
      pendingSketchExtensionRef.current = null
      pendingSketchFilletRef.current = null
      hoverFeature(null)
      updateActiveSnap(null)
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
      ? resolveCurrentSketchSnap(world, vt, {
          excludeActiveEditGeometry: isDraggingNodeRef.current || constraintRefPicking,
        })
      : { rawPoint: world, point: world, mode: null as null }
    const snapped = resolvedSnap.point
    const activeEditControl = selection.activeControl
    const constrainedPoint =
      requiresResolvedSnapForPointPick() && !resolvedSnap.mode
        ? activeEditControl?.kind === 'segment'
          ? world
          : null
        : snapped
    updateActiveSnap(shouldPreviewSnap ? resolvedSnap : null)

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
      if (lockModeRef.current !== 'none' && activeSnapRef.current) {
        activeSnapRef.current = { ...activeSnapRef.current, point: lockedPoint }
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

    const hitId = findHitFeatureId(world, project.features, vt)
    hoverFeature(hitId)
  }

  function stopNodeDrag() {
    if (!isDraggingNodeRef.current && selection.activeControl === null) return
    isDraggingNodeRef.current = false
    dragStartWorldRef.current = null
    setActiveControl(null)
    commitHistoryTransaction()
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

  function stopPan() {
    isPanningRef.current = false
    lastPanPointRef.current = null
  }

  function handlePointerUp(event?: ReactPointerEvent<HTMLCanvasElement>) {
    if (event?.pointerType === 'touch') {
      try { event.currentTarget.releasePointerCapture(event.pointerId) } catch { /* already released */ }
    }

    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressStartRef.current = null

    if (touchDragPendingRef.current) {
      const pending = touchDragPendingRef.current
      touchDragPendingRef.current = null
      setHoveredEditControl(pending.control)
      dimEdit.setArmedForDimension(true)
      return
    }

    if (dimEdit.draggingDimensionIdRef.current) {
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
        const enclosedIds = project.features
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
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current)
      longPressTimerRef.current = null
    }
    longPressStartRef.current = null
    touchDragPendingRef.current = null

    if (dimEdit.draggingDimensionIdRef.current) {
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
    sketchEditPreviewRef.current = null
    pendingSketchFilletRef.current = null
    setHoveredEditControl(null)
    setPendingOffsetPreviewPointRef(null)
    setPendingOffsetRawPreviewPointRef(null)
    hoverFeature(null)
    updateActiveSnap(null)
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

  function handleClick(event: MouseEvent<HTMLCanvasElement>) {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }

    if (zoomWindowActive) {
      return
    }

    if (didPanRef.current) {
      didPanRef.current = false
      return
    }

    const selection = selectionRef.current
    const project = projectRef.current
    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingOffset = pendingOffsetRef.current
    const pendingShapeAction = pendingShapeActionRef.current
    const viewState = viewStateRef.current
    const dimensionEdit = dimEdit.dimensionEditRef.current
    if (isDraggingNodeRef.current) return

    const point = canvasCoordinates(event)
    const canvas = canvasRef.current
    if (!canvas) return

    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
    const world = canvasToWorld(point.cx, point.cy, vt)
    const pendingConstraint = pendingConstraintRef.current
    const constraintRefPickingClick = !!pendingConstraint && !!pendingConstraint.anchor && !pendingConstraint.reference
    const resolvedSnap = resolveCurrentSketchSnap(world, vt, {
      excludeActiveEditGeometry: constraintRefPickingClick,
    })
    const pickedPoint = requiresResolvedSnapForPointPick() && !resolvedSnap.mode ? null : resolvedSnap.point

    // ── Delete-dimension mode: click a dimension to remove it (stays armed) ──
    if (!pendingAdd && dimensionDeleteArmedRef.current) {
      if (project.meta.showDimensions) {
        const hit = pickDimensionAt(project, vt, point, 8)
        if (hit) {
          deleteDimensionAnnotation(hit)
          deleteHoverDimIdRef.current = null
        }
      }
      return
    }

    // ── Tape measure: each click sets/advances the transient measurement ──
    if (!pendingAdd && tapeMeasureRef.current) {
      tapeMeasureClick(resolvedSnap.point)
      return
    }

    // ── Permanent dimension placement ──
    const pendingDim = pendingAdd ? null : pendingDimensionRef.current
    if (pendingDim) {
      const anchor: DimensionAnchor = resolvedSnap.anchor ?? { kind: 'free', point: resolvedSnap.point }
      const need = pendingDim.type === 'angle' ? 3 : 2
      const picked = [pendingDim.a, pendingDim.b, pendingDim.c].filter(Boolean).length
      // Radius/diameter have no cursor-driven offset (line is always center→edge),
      // so commit immediately on the final anchor click instead of asking for an
      // extra "click to place" step.
      const isRadial = pendingDim.type === 'radius' || pendingDim.type === 'diameter'
      // For radius/diameter the first click MUST identify a circle/arc center —
      // otherwise the dimension would be measured between arbitrary points and
      // the value would be meaningless. Silently ignore non-center clicks; the
      // CanvasWorkflowPanel already says "Click the circle / arc center".
      if (isRadial && picked === 0 && anchor.kind !== 'center') {
        return
      }
      if (isRadial && picked === need - 1) {
        // If the edge click landed off-circle (or via a non-anchored snap), but
        // anchor a pins the circle's center, project onto that circle and store
        // an angle-relative anchor so the dim direction follows the feature.
        const edgeAnchor =
          anchor.kind === 'free' && pendingDim.a
            ? (circleEdgeAnchorFromPoint(anchor.point, pendingDim.a, project) ?? anchor)
            : anchor
        addDimensionAnnotation({
          type: pendingDim.type,
          a: pendingDim.a!,
          b: edgeAnchor,
          offset: 0,
          visible: true,
          locked: false,
          textOverride: null,
          precisionOverride: null,
        })
        cancelPendingDimension()
        return
      }
      if (picked < need) {
        pendingDimensionPick(anchor)
        return
      }
      // All anchors picked → this click chooses the offset and commits.
      const temp: DimensionAnnotation = {
        id: '__commit__',
        type: pendingDim.type,
        a: pendingDim.a!,
        b: pendingDim.b ?? undefined,
        c: pendingDim.c ?? undefined,
        offset: 0,
        visible: true,
        locked: false,
        textOverride: null,
        precisionOverride: null,
      }
      const off = offsetForCursor(temp, project, world) ?? 0
      addDimensionAnnotation({
        type: pendingDim.type,
        a: pendingDim.a!,
        b: pendingDim.b ?? undefined,
        c: pendingDim.c ?? undefined,
        offset: off,
        visible: true,
        locked: false,
        textOverride: null,
        precisionOverride: null,
      })
      cancelPendingDimension()
      return
    }

    // ── Select an existing dimension annotation (plain select mode) ──
    if (
      selection.mode === 'feature'
      && !pendingAdd && !pendingMove && !pendingTransform && !pendingOffset
      && !pendingShapeAction && !pendingConstraint
      && project.meta.showDimensions
    ) {
      const hitDim = pickDimensionAt(project, vt, point, 8)
      if (hitDim) {
        selectAnnotation(hitDim)
        return
      }
      if (selectedAnnotationIdRef.current) {
        selectAnnotation(null)
      }
    }

    if (pendingConstraint && !pendingConstraint.anchor) {
      if (!pickedPoint) {
        return
      }
      setConstraintAnchor({
        point: pickedPoint,
        snapMode: resolvedSnap.mode,
      })
      return
    }

    if (pendingConstraint && pendingConstraint.anchor && !pendingConstraint.reference) {
      if (!pickedPoint) {
        return
      }
      const lockedPickedPoint = applyLock(pickedPoint, pendingConstraint.anchor.point)
      const targetFeatureId = findHitFeatureId(lockedPickedPoint, project.features, vt)
      const targetId =
        targetFeatureId && targetFeatureId !== pendingConstraint.featureId
          ? targetFeatureId
          : null
      setConstraintReference({
        point: lockedPickedPoint,
        featureId: targetId,
        snapMode: resolvedSnap.mode,
        segment: resolvedSnap.mode === 'perpendicular' ? resolvedSnap.perpendicularSegment : undefined,
      })
      const dx = pendingConstraint.anchor.point.x - lockedPickedPoint.x
      const dy = pendingConstraint.anchor.point.y - lockedPickedPoint.y
      const currentDistance = Math.hypot(dx, dy)
      constraint.setConstraintDistanceInput(formatLength(currentDistance, project.meta.units))
      return
    }

    if (selection.mode === 'sketch_edit') {
      if (selection.selectedNode?.type === 'feature' && selection.selectedFeatureId) {
        const feature = editableFeature()
        if (feature && selection.sketchEditTool === 'add_point') {
          if (pendingSketchExtensionRef.current) {
            const sourceEndpoint = endpointFromSketchExtension(pendingSketchExtensionRef.current.kind)
            const targetEndpoint = findOpenEndpointHit(world, vt, {
              exclude: {
                featureId: selection.selectedFeatureId,
                endpoint: sourceEndpoint,
                anchor: pendingSketchExtensionRef.current.anchor,
              },
            })
            if (targetEndpoint) {
              const joined = joinOpenFeatureEndpoints(
                selection.selectedFeatureId,
                sourceEndpoint,
                targetEndpoint.featureId,
                targetEndpoint.endpoint,
              )
              if (joined) {
                pendingSketchExtensionRef.current = null
                sketchEditPreviewRef.current = null
                scheduleDraw()
              }
              return
            }

            if (!pickedPoint) {
              return
            }
            const lockedPickedPoint = applyLock(pickedPoint, pendingSketchExtensionRef.current.anchor)
            insertFeaturePoint(selection.selectedFeatureId, {
              kind: pendingSketchExtensionRef.current.kind,
              point: lockedPickedPoint,
            })
            pendingSketchExtensionRef.current = null
            sketchEditPreviewRef.current = null
            scheduleDraw()
            return
          }

          const endpoint = findOpenProfileExtensionEndpoint(feature.sketch.profile, world, vt)
          if (endpoint) {
            pendingSketchExtensionRef.current = endpoint
            sketchEditPreviewRef.current = { point: endpoint.anchor, mode: 'add_point' }
            scheduleDraw()
            return
          }

          if (!pickedPoint) {
            return
          }

          const target = findSketchInsertTarget(feature.sketch.profile, pickedPoint, vt)
          if (target?.kind === 'segment') {
            insertFeaturePoint(selection.selectedFeatureId, target)
          }
          return
        }

        if (feature && selection.sketchEditTool === 'delete_point') {
          const control = hitEditableControl(point, { includeSegments: false })
          if (control?.kind === 'anchor') {
            deleteFeaturePoint(selection.selectedFeatureId, control.index)
          }
          return
        }

        if (feature && selection.sketchEditTool === 'delete_segment') {
          const target = findSketchSegmentHit(feature.sketch.profile, world, vt)
          if (target) {
            deleteFeatureSegment(selection.selectedFeatureId, target.segmentIndex)
            sketchEditPreviewRef.current = null
            scheduleDraw()
          }
          return
        }

        if (feature && selection.sketchEditTool === 'disconnect') {
          const control = hitEditableControl(point, { includeSegments: false })
          if (control?.kind === 'anchor') {
            disconnectFeaturePoint(selection.selectedFeatureId, control.index)
            sketchEditPreviewRef.current = null
            scheduleDraw()
          }
          return
        }

        if (feature && selection.sketchEditTool === 'fillet') {
          if (pendingSketchFilletRef.current) {
            const typedRadius = fillet.filletDimensionEditRef.current
              ? parseLengthInput(fillet.filletDimensionEditRef.current.radius, project.meta.units)
              : null
            if (typedRadius !== null && typedRadius > 0) {
              filletFeaturePoint(selection.selectedFeatureId, pendingSketchFilletRef.current.anchorIndex, typedRadius)
            } else {
              if (!pickedPoint) {
                return
              }
              const radius = filletRadiusFromPoint(feature, pendingSketchFilletRef.current.anchorIndex, pickedPoint)
              if (radius) {
                filletFeaturePoint(selection.selectedFeatureId, pendingSketchFilletRef.current.anchorIndex, radius)
              }
            }
            pendingSketchFilletRef.current = null
            sketchEditPreviewRef.current = null
            fillet.setFilletDimensionEdit(null)
            scheduleDraw()
            return
          }

          const control = hitEditableControl(point, { includeSegments: false })
          if (control?.kind === 'anchor') {
            pendingSketchFilletRef.current = {
              anchorIndex: control.index,
              corner: anchorPointForIndex(feature.sketch.profile, control.index),
            }
            sketchEditPreviewRef.current = { point: pendingSketchFilletRef.current.corner, mode: 'add_point' }
            scheduleDraw()
          }
          return
        }
      }

      if (selection.selectedNode?.type === 'feature' && selection.selectedFeatureId && !selection.sketchEditTool && !dimensionEdit) {
        const feature = editableFeature()
        if (feature) {
          const control = hitEditableControl(point)
          if (control && (control.kind === 'segment' || control.kind === 'anchor' || control.kind === 'arc_handle')) {
            const steps = dimEdit.computeEditStepsForControl(feature.sketch.profile, control)
            if (steps.length > 0) {
              dimEdit.editDimStepsRef.current = steps
              dimEdit.editDimStepIndexRef.current = 0
              dimEdit.dimensionEditFeatureIdRef.current = selection.selectedFeatureId
              beginHistoryTransaction()
              dimEdit.applyEditDimStep(0, steps, selection.selectedFeatureId, project.meta.units)
              return
            }
          }
        }
      }

      return
    }

    if (dimensionEdit) {
      dimEdit.commitEditDimension()
      return
    }

    if (pendingAdd) {
      if (!pickedPoint) {
        return
      }

      const snapped = pickedPoint

      if (pendingAdd.shape === 'origin') {
        originPreviewPointRef.current = null
        placeOriginAt(snapped)
        setPendingPreviewPointRef(null)
        return
      }

      if (pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline') {
        const lastPoint = pendingAdd.points[pendingAdd.points.length - 1]
        if (pendingAdd.points.length >= 3 && isLoopCloseCandidate(point, pendingAdd.points, vt, POLYGON_CLOSE_RADIUS)) {
          completePendingPolygon()
          setPendingPreviewPointRef(null)
          return
        }
        const lockedSnapped = lastPoint ? applyLock(snapped, lastPoint) : snapped
        if (!lastPoint || lastPoint.x !== lockedSnapped.x || lastPoint.y !== lockedSnapped.y) {
          addPendingPolygonPoint(lockedSnapped)
        }
        setPendingPreviewPointRef({ point: lockedSnapped, session: pendingAdd.session })
      } else if ((pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'ellipse' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp') && !pendingAdd.anchor) {
        setPendingAddAnchor(snapped)
        setPendingPreviewPointRef({ point: snapped, session: pendingAdd.session })
      } else if (pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'ellipse' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp') {
        placePendingAddAt(snapped)
        setPendingPreviewPointRef(null)
      } else if (pendingAdd.shape === 'text') {
        placePendingTextAt(snapped)
        setPendingPreviewPointRef(null)
      } else if (pendingAdd.shape === 'composite') {
        const draftPoints = compositeDraftPoints(pendingAdd)
        const closeCandidate =
          pendingAdd.currentMode !== 'arc' &&
          !pendingAdd.pendingArcEnd &&
          draftPoints.length >= 3 &&
          isLoopCloseCandidate(point, draftPoints, vt, POLYGON_CLOSE_RADIUS)

        if (closeCandidate) {
          completePendingComposite()
          setPendingPreviewPointRef(null)
          return
        }

        const compositeOrigin = pendingAdd.pendingArcEnd ?? pendingAdd.lastPoint ?? pendingAdd.start
        const lockedCompositeSnapped = compositeOrigin ? applyLock(snapped, compositeOrigin) : snapped
        addPendingCompositePoint(lockedCompositeSnapped)
        setPendingPreviewPointRef({ point: lockedCompositeSnapped, session: pendingAdd.session })
      }
      return
    }

    if (pendingMove) {
      if (!pickedPoint) {
        return
      }

      const snapped = pickedPoint

      if (!pendingMove.fromPoint) {
        setPendingMoveFrom(snapped)
        setPendingMovePreviewPointRef({ point: snapped, session: pendingMove.session })
      } else if (!pendingMove.toPoint) {
        const lockedSnapped = applyLock(snapped, pendingMove.fromPoint)
        move.beginMoveDistanceEntry(lockedSnapped)
      }
      return
    }

    if (pendingTransform) {
      if (!pickedPoint) {
        return
      }

      const snapped = pickedPoint
      const constrainedPoint =
        pendingTransform.mode === 'resize' && pendingTransform.referenceStart && pendingTransform.referenceEnd
          ? projectPointOntoLine(snapped, pendingTransform.referenceStart, pendingTransform.referenceEnd)
          : snapped

      if (!pendingTransform.referenceStart) {
        setPendingTransformReferenceStart(snapped)
        setPendingTransformPreviewPointRef({ point: snapped, session: pendingTransform.session })
      } else if (!pendingTransform.referenceEnd) {
        setPendingTransformReferenceEnd(snapped)
        setPendingTransformPreviewPointRef({ point: snapped, session: pendingTransform.session })
        if (pendingTransform.mode === 'mirror') {
          completePendingTransform(snapped)
          setPendingTransformPreviewPointRef(null)
        }
      } else if (pendingTransform.mode === 'rotate' && pendingTransform.keepOriginals) {
        setPendingRotateCopyPoint(constrainedPoint)
      } else {
        completePendingTransform(constrainedPoint)
        setPendingTransformPreviewPointRef(null)
      }
      return
    }

    if (pendingOffset) {
      const sourceFeatures = pendingOffset.entityIds
        .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
        .filter((feature): feature is SketchFeature => feature !== null)
        .filter((feature) => feature.sketch.profile.closed)
      if (!pickedPoint) {
        return
      }
      const previewInput = resolveOffsetPreview(sourceFeatures, world, pickedPoint, resolvedSnap.mode, vt)
      if (previewInput) {
        completePendingOffset(previewInput.signedDistance)
      } else {
        cancelPendingOffset()
      }
      setPendingOffsetPreviewPointRef(null)
      setPendingOffsetRawPreviewPointRef(null)
      return
    }

    // Hit-test constraint labels for click-to-edit
    if (!pendingConstraint && !pendingAdd && !pendingMove && !pendingTransform && !pendingOffset) {
      for (const rect of constraintLabelRectsRef.current) {
        if (
          point.cx >= rect.cx - rect.halfW && point.cx <= rect.cx + rect.halfW &&
          point.cy >= rect.cy - rect.halfH && point.cy <= rect.cy + rect.halfH
        ) {
          const feature = project.features.find((f) => f.id === rect.featureId)
          const foundConstraint = feature?.sketch.constraints.find((c) => c.id === rect.constraintId)
          if (foundConstraint && typeof foundConstraint.value === 'number') {
            constraint.setConstraintEdit({
              featureId: rect.featureId,
              constraintId: rect.constraintId,
              value: formatLength(foundConstraint.value, project.meta.units),
              cx: rect.cx,
              cy: rect.cy,
            })
          }
          return
        }
      }
    }

    const hitClampId = findHitClampId(world, project.clamps)
    if (hitClampId) {
      selectClamp(hitClampId)
      return
    }

    const hitTabId = findHitTabId(world, project.tabs)
    if (hitTabId) {
      selectTab(hitTabId)
      return
    }

    const hitId = findHitFeatureId(world, project.features, vt)
    const additive = event.metaKey || event.ctrlKey || event.shiftKey || multiSelectMode || !!pendingShapeAction
    if (hitId) {
      selectFeature(hitId, additive)
    } else if (project.backdrop?.visible && hitBackdrop(world, project.backdrop)) {
      selectBackdrop()
    } else if (!additive) {
      selectFeature(null)
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
    const hitId = findHitFeatureId(world, project.features, vt)
    if (hitId) enterSketchEdit(hitId)
  }

  function triggerContextMenuAt(clientX: number, clientY: number) {
    if (zoomWindowActive) return
    if (pendingAddRef.current || pendingMoveRef.current || pendingTransformRef.current || pendingOffsetRef.current) return

    const canvas = canvasRef.current
    if (!canvas) return

    const rect = canvas.getBoundingClientRect()
    const point: CanvasPoint = { cx: clientX - rect.left, cy: clientY - rect.top }
    const project = projectRef.current
    const selection = selectionRef.current
    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewStateRef.current)
    const world = canvasToWorld(point.cx, point.cy, vt)
    const hitClampId = findHitClampId(world, project.clamps)
    if (hitClampId) {
      selectClamp(hitClampId)
      onClampContextMenu?.(hitClampId, clientX, clientY)
      return
    }

    const hitTabId = findHitTabId(world, project.tabs)
    if (hitTabId) {
      selectTab(hitTabId)
      onTabContextMenu?.(hitTabId, clientX, clientY)
      return
    }

    const hitId = findHitFeatureId(world, project.features, vt)
    if (!hitId) return

    if (!selection.selectedFeatureIds.includes(hitId)) {
      selectFeature(hitId)
    }
    onFeatureContextMenu?.(hitId, clientX, clientY)
  }

  function handleContextMenu(event: MouseEvent<HTMLCanvasElement>) {
    event.preventDefault()

    if (didPanRef.current) {
      didPanRef.current = false
      return
    }

    triggerContextMenuAt(event.clientX, event.clientY)
  }

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
          const previewInput = resolveOffsetPreview(sourceFeatures, rawOffsetPoint, snappedOffsetPoint, activeSnapRef.current?.mode ?? null, vt)
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
      const radius = filletRadiusFromPoint(feature, pendingSketchFilletRef.current.anchorIndex, sketchEditPreviewRef.current.point)
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
    if ((event.key === 'Delete' || event.key === 'Backspace') && selectedAnnotationIdRef.current) {
      event.preventDefault()
      deleteDimensionAnnotation(selectedAnnotationIdRef.current)
      return
    }

    if (event.key === 'Tab' && pendingAdd) {
      const currentEdit = dimEdit.dimensionEditRef.current
      const units = projectRef.current.meta.units

      if (
        (pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'ellipse' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp')
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
            dimEdit.setDimensionEdit({
              shape: pendingAdd.shape,
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
      const units = projectRef.current.meta.units
      const featureId = selection.selectedFeatureId
      const feature = featureId ? projectRef.current.features.find((f) => f.id === featureId) ?? null : null
      if (!feature) return
      const current = fillet.filletDimensionEditRef.current
      if (!current) {
        const radius = filletRadiusFromPoint(feature, pendingSketchFilletRef.current.anchorIndex, sketchEditPreviewRef.current.point)
        fillet.setFilletDimensionEdit({
          anchorIndex: pendingSketchFilletRef.current.anchorIndex,
          corner: pendingSketchFilletRef.current.corner,
          radius: radius ? formatLength(radius, units) : '',
        })
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
      setPendingRotateCopyPoint(null)
      setRotateCopyCountDraft('1')
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
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        onPointerLeave={handlePointerLeave}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        onContextMenu={handleContextMenu}
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
      {dimEdit.dimensionEdit && selection.mode === 'sketch_edit' && !pendingAdd && (() => {
        const canvas = canvasRef.current
        if (!canvas) return null
        const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
        const featureId = selection.selectedFeatureId
        if (!featureId) return null

        function makeEditInputKeyDown() {
          return (e: KeyboardEvent<HTMLInputElement>) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              dimEdit.commitEditDimension()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              dimEdit.cancelEditDimension()
            } else if (e.key === 'Tab') {
              e.preventDefault()
              dimEdit.advanceTabInEditMode()
            }
          }
        }

        const handleLiveChange = dimEdit.handleEditDimLiveChange

        // Arc radius step
        if (dimEdit.dimensionEdit.shape === 'circle') {
          const anchorC = worldToCanvas(dimEdit.dimensionEdit.anchor, vt)
          return (
            <input
              key="edit-radius"
              ref={dimEdit.radiusInputRef}
              className="sketch-dim-input"
              style={{ left: anchorC.cx, top: anchorC.cy, transform: 'translate(-50%, -50%)' }}
              value={dimEdit.dimensionEdit.radius}
              onChange={(e) => handleLiveChange('radius', e.target.value)}
              onKeyDown={makeEditInputKeyDown()}
              onFocus={(e) => e.currentTarget.select()}
            />
          )
        }

        // Endpoint (length + angle) step
        const previewPt = computeDimensionEditPreviewPoint(dimEdit.dimensionEdit, project.meta.units)
        const fromC = worldToCanvas(dimEdit.dimensionEdit.anchor, vt)
        const toC = worldToCanvas(previewPt, vt)
        const layout = computeLinearInputLabel(fromC, toC, 14, 40)
        const angleLabelX = layout.midX + layout.perpX * 36
        const angleLabelY = layout.midY + layout.perpY * 36
        return (
          <>
            <input
              key="edit-length"
              ref={dimEdit.widthInputRef}
              className="sketch-dim-input"
              style={{ left: layout.labelX, top: layout.labelY, transform: `translate(-50%, -50%) rotate(${layout.angle}rad)` }}
              value={dimEdit.dimensionEdit.length}
              onChange={(e) => handleLiveChange('length', e.target.value)}
              onKeyDown={makeEditInputKeyDown()}
              onFocus={(e) => e.currentTarget.select()}
            />
            <input
              key="edit-angle"
              ref={dimEdit.heightInputRef}
              className="sketch-dim-input"
              style={{ left: angleLabelX, top: angleLabelY, transform: `translate(-50%, -50%) rotate(${layout.angle}rad)` }}
              value={dimEdit.dimensionEdit.angle}
              onChange={(e) => handleLiveChange('angle', e.target.value)}
              onKeyDown={makeEditInputKeyDown()}
              onFocus={(e) => e.currentTarget.select()}
            />
          </>
        )
      })()}
      {fillet.filletDimensionEdit && selection.mode === 'sketch_edit' && (() => {
        const canvas = canvasRef.current
        if (!canvas) return null
        const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
        const cornerC = worldToCanvas(fillet.filletDimensionEdit.corner, vt)
        return (
          <input
            key="fillet-radius"
            ref={fillet.filletRadiusInputRef}
            className="sketch-dim-input"
            style={{ left: cornerC.cx, top: cornerC.cy, transform: 'translate(-50%, -50%)' }}
            value={fillet.filletDimensionEdit.radius}
            onChange={(e) => {
              const value = e.target.value
              fillet.setFilletDimensionEdit((prev) => (prev ? { ...prev, radius: value } : null))
              scheduleDraw()
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                fillet.commitFilletDimension()
                canvasRef.current?.focus({ preventScroll: true })
              } else if (e.key === 'Escape') {
                e.preventDefault()
                fillet.cancelFilletDimension()
                canvasRef.current?.focus({ preventScroll: true })
              } else if (e.key === 'Tab') {
                e.preventDefault()
                fillet.setFilletDimensionEdit(null)
                canvasRef.current?.focus({ preventScroll: true })
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
        )
      })()}
      {constraint.constraintEdit && (
        <input
          key={`constraint-edit-${constraint.constraintEdit.constraintId}`}
          ref={constraint.constraintEditInputRef}
          className="sketch-dim-input"
          style={{ left: constraint.constraintEdit.cx, top: constraint.constraintEdit.cy, transform: 'translate(-50%, -50%)' }}
          value={constraint.constraintEdit.value}
          onChange={(e) => constraint.setConstraintEdit((prev) => prev ? { ...prev, value: e.target.value } : null)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              constraint.commitConstraintEdit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              constraint.cancelConstraintEdit()
            }
          }}
          onBlur={() => constraint.setConstraintEdit(null)}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
      {pendingOffset && (
        <CanvasWorkflowPanel
          title="Offset"
          step={offsetDistanceEditActive ? 'Set distance' : 'Preview distance'}
          position={offsetWorkflowPanel.position}
          panelRef={offsetWorkflowPanel.panelRef}
          handleProps={offsetWorkflowPanel.handleProps}
          actionRowProps={offsetWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--offset"
          moveLabel="Move offset controls"
          actions={(
            <>
              {offsetDistanceEditActive ? (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={commitOffsetDistanceEditFromPanel}
                >Confirm</button>
              ) : (
                <button
                  type="button"
                  className="tablet-cmd-btn"
                  onClick={triggerDimensionFromOffsetPanel}
                >Distance</button>
              )}
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={cancelOffsetFromPanel}
              >Cancel</button>
            </>
          )}
        >
          {offsetDistanceEditActive && operationDimEdit?.kind === 'offset' ? (
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
                      commitOffsetDistanceEditFromPanel()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      cancelOffsetFromPanel()
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
      {creationPanelShape && pendingAdd && (
        <CanvasWorkflowPanel
          title={
            creationPanelShape === 'rect' ? 'Rectangle'
            : creationPanelShape === 'circle' ? 'Circle'
            : creationPanelShape === 'ellipse' ? 'Ellipse'
            : creationPanelShape === 'tab' ? 'Tab'
            : creationPanelShape === 'clamp' ? 'Clamp'
            : creationPanelShape === 'polygon' ? 'Polygon'
            : creationPanelShape === 'spline' ? 'Spline'
            : 'Composite'
          }
          step={
            creationDimEditActive ? 'Enter dimensions'
            : creationPanelShape === 'composite'
              ? (pendingAdd.shape === 'composite' && pendingAdd.start
                ? (pendingAdd.currentMode === 'arc' && pendingAdd.pendingArcEnd
                  ? 'Click arc curvature point'
                  : `Add ${pendingAdd.currentMode} points`)
                : 'Click first point')
            : (creationPanelShape === 'polygon' || creationPanelShape === 'spline')
              ? (creationPanelHasPoints
                ? ('points' in pendingAdd && pendingAdd.points.length < 2
                  ? 'Add one more point'
                  : 'Add points or close')
                : 'Click first point')
            : creationPanelHasAnchor
              ? (creationPanelShape === 'circle'
                ? 'Click to set radius or enter dimensions'
                : creationPanelShape === 'ellipse'
                  ? 'Click to set radii or enter dimensions'
                  : 'Click opposite corner or enter dimensions')
              : (creationPanelShape === 'circle' || creationPanelShape === 'ellipse')
                ? 'Click center point'
                : 'Click first corner'
          }
          position={creationWorkflowPanel.position}
          panelRef={creationWorkflowPanel.panelRef}
          handleProps={creationWorkflowPanel.handleProps}
          actionRowProps={creationWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--creation"
          moveLabel="Move creation controls"
          actions={(
            <>
              {creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={commitCreationDimensionEdit}
                >Confirm</button>
              )}
              {(pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline') && 'points' in pendingAdd && pendingAdd.points.length >= 2 && creationTarget !== 'region' && !creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={finishOpenPathFromPanel}
                >Finish</button>
              )}
              {pendingAdd.shape === 'composite' && pendingAdd.segments.length >= 1 && !pendingAdd.pendingArcEnd && creationTarget !== 'region' && !creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={finishOpenCompositeFromPanel}
                >Finish</button>
              )}
              {creationCanDimEdit && !creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn"
                  onClick={triggerDimensionFromCreationPanel}
                >Dimensions</button>
              )}
              {(creationPanelHasPoints || (pendingAdd.shape === 'composite' && pendingAdd.start)) && !creationDimEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn"
                  onClick={undoFromCreationPanel}
                >Undo</button>
              )}
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={cancelCreationFromPanel}
              >Cancel</button>
            </>
          )}
        >
          {pendingAdd.shape === 'composite' && pendingAdd.start && !pendingAdd.closed && !creationDimEditActive && (
            <div className="canvas-workflow-panel__meta canvas-workflow-panel__mode-row">
              <button
                type="button"
                className={`tablet-cmd-btn ${pendingAdd.currentMode === 'line' ? 'tablet-cmd-btn--active' : ''}`}
                onClick={() => setCompositeModeFromPanel('line')}
              >Line</button>
              <button
                type="button"
                className={`tablet-cmd-btn ${pendingAdd.currentMode === 'arc' ? 'tablet-cmd-btn--active' : ''}`}
                onClick={() => setCompositeModeFromPanel('arc')}
              >Arc</button>
              <button
                type="button"
                className={`tablet-cmd-btn ${pendingAdd.currentMode === 'spline' ? 'tablet-cmd-btn--active' : ''}`}
                onClick={() => setCompositeModeFromPanel('spline')}
              >Spline</button>
            </div>
          )}
          {creationDimEditActive && dimEdit.dimensionEdit && (
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
                        commitCreationDimensionEdit()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancelCreationDimensionEdit()
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
                        commitCreationDimensionEdit()
                      } else if (e.key === 'Escape') {
                        e.preventDefault()
                        cancelCreationDimensionEdit()
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
                          commitCreationDimensionEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelCreationDimensionEdit()
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
                          commitCreationDimensionEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelCreationDimensionEdit()
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
                            commitCreationDimensionEdit()
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            cancelCreationDimensionEdit()
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
                          commitCreationDimensionEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelCreationDimensionEdit()
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
                          commitCreationDimensionEdit()
                        } else if (e.key === 'Escape') {
                          e.preventDefault()
                          cancelCreationDimensionEdit()
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
      {placementPanelActive && (
        <CanvasWorkflowPanel
          title={pendingAdd!.shape === 'origin' ? 'Place Origin' : 'Place Text'}
          step={
            pendingAdd!.shape === 'origin'
              ? 'Click the sketch to place machine X0 Y0. Z remains manual in Properties.'
              : 'Tap the sketch to place the text.'
          }
          position={placementWorkflowPanel.position}
          panelRef={placementWorkflowPanel.panelRef}
          handleProps={placementWorkflowPanel.handleProps}
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
          step={transformExactEditActive
            ? transformScaleEditActive ? 'Set scale' : 'Set angle'
            : rotateCopyCountPromptActive
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
          position={transformWorkflowPanel.position}
          panelRef={transformWorkflowPanel.panelRef}
          handleProps={transformWorkflowPanel.handleProps}
          actionRowProps={transformWorkflowPanel.actionRowProps}
          className="canvas-workflow-panel--transform"
          moveLabel={`Move ${pendingTransform.mode} controls`}
          actions={(
            <>
              {transformExactEditActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={commitTransformExactEditFromPanel}
                >Confirm</button>
              )}
              {!transformExactEditActive && !rotateCopyCountPromptActive
                && ((pendingTransform.mode === 'resize' && pendingTransform.referenceStart && pendingTransform.referenceEnd)
                  || (pendingTransform.mode === 'rotate' && pendingTransform.referenceStart && pendingTransform.referenceEnd)) && (
                <button
                  type="button"
                  className="tablet-cmd-btn"
                  onClick={triggerDimensionFromTransformPanel}
                >{pendingTransform.mode === 'resize' ? 'Scale' : 'Angle'}</button>
              )}
              {!transformExactEditActive && rotateCopyCountPromptActive && (
                <button
                  type="button"
                  className="tablet-cmd-btn tablet-cmd-btn--confirm"
                  onClick={() => {
                    const n = Math.max(1, Math.floor(Number(rotateCopyCountDraft) || 1))
                    completePendingTransform(pendingRotateCopyPoint!, n)
                    setPendingTransformPreviewPointRef(null)
                    setPendingRotateCopyPoint(null)
                    setRotateCopyCountDraft('1')
                    transformWorkflowPanel.focusCanvasAfterAction()
                  }}
                >Confirm</button>
              )}
              <button
                type="button"
                className="tablet-cmd-btn tablet-cmd-btn--cancel"
                onClick={cancelTransformFromPanel}
              >Cancel</button>
            </>
          )}
        >
          {transformExactEditActive && (operationDimEdit?.kind === 'scale' || operationDimEdit?.kind === 'rotate') ? (
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
                      commitTransformExactEditFromPanel()
                    } else if (event.key === 'Escape') {
                      event.preventDefault()
                      cancelTransformFromPanel()
                    }
                  }}
                  autoFocus
                />
              </label>
            </div>
          ) : rotateCopyCountPromptActive ? (
            <>
              <div className="canvas-workflow-panel__meta">
                <label className="canvas-workflow-panel__field">
                  <span>Copies</span>
                  <input
                    ref={rotateCopyCountInputRef}
                    className="canvas-workflow-panel__count-input"
                    type="text"
                    inputMode="numeric"
                    value={rotateCopyCountDraft}
                    onChange={(event) => setRotateCopyCountDraft(event.target.value.replace(/[^\d]/g, ''))}
                    onFocus={(event) => event.currentTarget.select()}
                    onKeyDown={(event) => {
                      event.stopPropagation()
                      if (event.key === 'Enter') {
                        const n = Math.max(1, Math.floor(Number(rotateCopyCountDraft) || 1))
                        completePendingTransform(pendingRotateCopyPoint!, n)
                        setPendingTransformPreviewPointRef(null)
                        setPendingRotateCopyPoint(null)
                        setRotateCopyCountDraft('1')
                        transformWorkflowPanel.focusCanvasAfterAction()
                      } else if (event.key === 'Escape') {
                        event.preventDefault()
                        cancelTransformFromPanel()
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
                        transformWorkflowPanel.focusCanvasAfterAction()
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
            editDimEditActive ? 'Enter dimensions'
            : selection.sketchEditTool === 'add_point' ? 'Click to add points'
            : selection.sketchEditTool === 'delete_point' ? 'Click to delete points'
            : selection.sketchEditTool === 'delete_segment' ? 'Click to delete segments'
            : selection.sketchEditTool === 'disconnect' ? 'Click an anchor to split'
            : selection.sketchEditTool === 'fillet' ? (pendingSketchFilletRef.current ? 'Click second point or enter radius' : 'Click a corner')
            : 'Drag nodes or click segments'
          }
          position={editWorkflowPanel.position}
          panelRef={editWorkflowPanel.panelRef}
          handleProps={editWorkflowPanel.handleProps}
          actions={editDimEditActive ? (
            <>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={commitEditDimensionFromPanel}>Confirm</button>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={cancelEditDimensionFromPanel}>Cancel</button>
            </>
          ) : (
            <>
              {dimEdit.armedForDimension && (
                <button type="button" className="tablet-cmd-btn" onClick={() => { triggerDimensionEdit(); dimEdit.setArmedForDimension(false) }}>Dimension</button>
              )}
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--confirm" onClick={applyEditFromPanel}>Apply</button>
              <button type="button" className="tablet-cmd-btn tablet-cmd-btn--cancel" onClick={cancelEditFromPanel}>Cancel</button>
            </>
          )}
        >
          {editDimEditActive && dimEdit.dimensionEdit ? (
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
