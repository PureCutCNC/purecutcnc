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
import type { KeyboardEvent, MouseEvent, WheelEvent } from 'react'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { SnapMode, SnapSettings } from '../../sketch/snapping'
import type { SketchControlRef, SketchEditTool } from '../../store/types'
import { filletFeatureFromPoint, filletFeatureFromRadius, filletRadiusFromPoint, previewOffsetFeatures, resizeBackdropFromReference, resizeFeatureFromReference, rotateBackdropFromReference, rotateFeatureFromReference, useProjectStore } from '../../store/projectStore'
import {
  buildArcSegmentFromThreePoints,
  buildPendingDraftProfile,
  buildPendingProfile,
  compositeDraftPoints,
  computeEditDimSteps,
  drawCompositeDraft,
  drawSnapIndicator,
  type EditDimStep,
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
  arcHandleFromRadius,
  computeDimensionEditPreviewPoint,
  computeLinearInputLabel,
  computeMoveDistancePreviewPoint,
  computeRotateDegreesFromPreview,
  computeRotatePreviewPoint,
  computeScaleFactorFromPreview,
  computeScalePreviewPoint,
  unitDirection,
} from './manualEntry'
import type { DimensionEditState, OperationDimEdit } from './manualEntry'
import { resolveSketchSnap } from './snappingHelpers'
import type { ResolvedSnap } from './snappingHelpers'
import {
  drawFeature,
  drawMoveGuide,
  drawPendingPathLoop,
  drawPendingPoint,
  drawPendingSplineLoop,
  drawPreviewProfile,
  drawToolpath,
  hexToRgba,
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
import { findSketchInsertTarget, isLoopCloseCandidate, projectPointOntoLine, resolveOffsetPreview } from './draftGeometry'
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
import type { Clamp, Point, SketchFeature, Tab } from '../../types/project'
import { formatLength, parseLengthInput } from '../../utils/units'
import { useAxisLock, lockModeGuideColor } from '../../sketch/useAxisLock'

const NODE_HIT_RADIUS = 9
const HANDLE_HIT_RADIUS = 7
const POLYGON_CLOSE_RADIUS = 12
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
  },
  ref
) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const containerRef = useRef<HTMLDivElement>(null)
  const isDraggingNodeRef = useRef(false)
  const dragStartWorldRef = useRef<Point | null>(null)
  const isPanningRef = useRef(false)
  const didPanRef = useRef(false)
  const lastPanPointRef = useRef<CanvasPoint | null>(null)
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
  const drawFrameRef = useRef<number | null>(null)
  const drawRef = useRef<() => void>(() => {})
  const [copyCountDraft, setCopyCountDraft] = useState('1')
  const [viewState, setViewState] = useState<SketchViewState>({ zoom: 1, panX: 0, panY: 0 })
  const [backdropImage, setBackdropImage] = useState<HTMLImageElement | null>(null)
  const [dimensionEdit, setDimensionEdit] = useState<DimensionEditState | null>(null)
  const copyCountInputRef = useRef<HTMLInputElement>(null)
  const hoveredEditControlRef = useRef<SketchControlRef | null>(null)
  const dimensionEditRef = useRef<DimensionEditState | null>(null)
  const dimensionEditControlRef = useRef<SketchControlRef | null>(null)
  const dimensionEditFeatureIdRef = useRef<string | null>(null)
  const editDimStepsRef = useRef<EditDimStep[]>([])
  const editDimStepIndexRef = useRef(0)
  const widthInputRef = useRef<HTMLInputElement>(null)
  const heightInputRef = useRef<HTMLInputElement>(null)
  const radiusInputRef = useRef<HTMLInputElement>(null)
  const [operationDimEdit, setOperationDimEdit] = useState<OperationDimEdit | null>(null)
  const operationDimEditRef = useRef<OperationDimEdit | null>(null)
  operationDimEditRef.current = operationDimEdit
  const [filletDimensionEdit, setFilletDimensionEdit] = useState<{ anchorIndex: number; corner: Point; radius: string } | null>(null)
  const filletDimensionEditRef = useRef<{ anchorIndex: number; corner: Point; radius: string } | null>(null)
  filletDimensionEditRef.current = filletDimensionEdit
  const filletRadiusInputRef = useRef<HTMLInputElement>(null)
  const [constraintDistanceInput, setConstraintDistanceInput] = useState<string | null>(null)
  const constraintDistanceInputRef = useRef<HTMLInputElement>(null)
  const [constraintEdit, setConstraintEdit] = useState<{ featureId: string; constraintId: string; value: string; cx: number; cy: number } | null>(null)
  const constraintEditRef = useRef<typeof constraintEdit>(null)
  const constraintEditInputRef = useRef<HTMLInputElement>(null)
  // Stores label hit areas for click detection: { featureId, constraintId, cx, cy, halfW, halfH }
  const constraintLabelRectsRef = useRef<Array<{ featureId: string; constraintId: string; cx: number; cy: number; halfW: number; halfH: number }>>([])

  const {
    project,
    pendingAdd,
    pendingMove,
    pendingTransform,
    pendingOffset,
    pendingShapeAction,
    pendingConstraint,
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
    deleteFeaturePoint,
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
    completePendingOffset,
    cancelPendingOffset,
    completePendingShapeAction,
    cancelPendingShapeAction,
    setPendingShapeActionKeepOriginals,
    setBackdropImageLoading,
    beginConstraint,
    setConstraintAnchor,
    setConstraintReference,
    commitConstraintDistance,
    cancelPendingConstraint,
    updateConstraintValue,
  } = useProjectStore()
  const copyCountPromptActive = pendingMove?.mode === 'copy' && !!pendingMove.fromPoint && !!pendingMove.toPoint
  const projectRef = useRef(project)
  const selectionRef = useRef(selection)
  const pendingAddRef = useRef(pendingAdd)
  const pendingMoveRef = useRef(pendingMove)
  const pendingTransformRef = useRef(pendingTransform)
  const pendingOffsetRef = useRef(pendingOffset)
  const pendingShapeActionRef = useRef(pendingShapeAction)
  const pendingConstraintRef = useRef(pendingConstraint)
  const viewStateRef = useRef(viewState)
  const backdropImageRef = useRef(backdropImage)
  const toolpathsRef = useRef(toolpaths)
  const selectedOperationIdRef = useRef(selectedOperationId)
  const collidingClampIdsRef = useRef(collidingClampIds)
  const snapSettingsRef = useRef(snapSettings)
  const copyCountDraftRef = useRef(copyCountDraft)

  projectRef.current = project
  selectionRef.current = selection
  pendingAddRef.current = pendingAdd
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
  dimensionEditRef.current = dimensionEdit
  constraintEditRef.current = constraintEdit

  // Axis lock — active whenever a move, node drag, sketch-edit drag, constraint pick, or feature creation is in progress
  const isDraggingAny = !!pendingMove || !!pendingAdd || !!pendingConstraint || isDraggingNodeRef.current || selection.sketchEditTool === 'add_point'
  const scheduleDrawRef = useRef<() => void>(() => {})
  const { lockModeRef, applyLock } = useAxisLock(isDraggingAny, () => scheduleDrawRef.current())

  function updateActiveSnap(nextSnap: ResolvedSnap | null) {
    activeSnapRef.current = nextSnap?.mode ? nextSnap : null
    onActiveSnapModeChange?.(nextSnap?.mode ?? null)
    scheduleDraw()
  }

  function setPendingPreviewPointRef(nextPoint: PendingPreviewPoint | null) {
    pendingPreviewPointRef.current = nextPoint
    scheduleDraw()
  }

  function setPendingMovePreviewPointRef(nextPoint: PendingPreviewPoint | null) {
    pendingMovePreviewPointRef.current = nextPoint
    scheduleDraw()
  }

  function setPendingTransformPreviewPointRef(nextPoint: PendingPreviewPoint | null) {
    pendingTransformPreviewPointRef.current = nextPoint
    scheduleDraw()
  }

  function setPendingOffsetPreviewPointRef(nextPoint: PendingPreviewPoint | null) {
    pendingOffsetPreviewPointRef.current = nextPoint
    scheduleDraw()
  }

  function setPendingOffsetRawPreviewPointRef(nextPoint: PendingPreviewPoint | null) {
    pendingOffsetRawPreviewPointRef.current = nextPoint
    scheduleDraw()
  }

  function sameControl(a: SketchControlRef | null, b: SketchControlRef | null): boolean {
    return a?.kind === b?.kind && a?.index === b?.index && a?.t === b?.t
  }

  function setHoveredEditControl(nextControl: SketchControlRef | null) {
    if (sameControl(hoveredEditControlRef.current, nextControl)) {
      return
    }
    hoveredEditControlRef.current = nextControl
    scheduleDraw()
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

    if (pendingTransform?.mode === 'rotate') {
      return pendingTransform.referenceStart
    }

    if ((pendingAdd?.shape === 'rect' || pendingAdd?.shape === 'circle' || pendingAdd?.shape === 'tab' || pendingAdd?.shape === 'clamp') && pendingAdd.anchor) {
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
    return () => {
      onActiveSnapModeChange?.(null)
    }
  }, [onActiveSnapModeChange])

  useEffect(() => {
    scheduleDraw()
  }, [project, selection, pendingAdd, pendingMove, pendingTransform, pendingOffset, viewState, backdropImage, toolpaths, selectedOperationId, collidingClampIds, snapSettings, copyCountDraft, dimensionEdit])

  useEffect(() => {
    sketchEditPreviewRef.current = null
    pendingSketchExtensionRef.current = null
    pendingSketchFilletRef.current = null
  }, [selection.mode, selection.sketchEditTool, selection.selectedFeatureId])

  useEffect(() => {
    if (selection.mode !== 'sketch_edit') {
      hoveredEditControlRef.current = null
      dimensionEditControlRef.current = null
      dimensionEditFeatureIdRef.current = null
      editDimStepsRef.current = []
      editDimStepIndexRef.current = 0
      setDimensionEdit(null)
    }
  }, [selection.mode])

  useEffect(() => {
    if (
      selection.mode !== 'sketch_edit'
      || selection.selectedNode?.type !== 'feature'
      || !!selection.sketchEditTool
    ) {
      setHoveredEditControl(null)
    }
  }, [selection.mode, selection.selectedFeatureId, selection.selectedNode, selection.sketchEditTool])

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
  }, [zoomWindowActive])

  useEffect(() => {
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
          const lockedSnapped = applyLock(snapped, pendingSketchExtensionRef.current.anchor)
          sketchEditPreviewRef.current = { point: lockedSnapped, mode: 'add_point' }
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

      if (feature && sketchEditTool === 'fillet') {
        pendingSketchExtensionRef.current = null
        if (pendingSketchFilletRef.current) {
          sketchEditPreviewRef.current = { point: snapped, mode: 'add_point' }
        }
        scheduleDraw()
      }
    }
  }, [snapSettings, viewState, pendingAdd, pendingMove, pendingTransform, pendingOffset, selection.mode, selection.sketchEditTool, selection.selectedFeatureId, selection.selectedNode])

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
      traceProfilePath(ctx, project.stock.profile, vt)
      ctx.strokeStyle = hexToRgba(project.stock.color, 0.7)
      ctx.lineWidth = 2
      ctx.setLineDash([7, 4])
      ctx.stroke()
      ctx.setLineDash([])

      traceProfilePath(ctx, project.stock.profile, vt)
      ctx.fillStyle = hexToRgba(project.stock.color, 0.12)
      ctx.fill()
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

      if (editing) {
        const hoveredEditControl =
          !isDraggingNodeRef.current && !dimensionEditControlRef.current
            ? hoveredEditControlRef.current
            : null
        const editControl =
          isDraggingNodeRef.current
            ? selection.activeControl
            : (dimensionEditControlRef.current ?? selection.activeControl ?? hoveredEditControl)
        drawSketchControls(ctx, feature.sketch.profile, vt, editControl)
        if (editControl && (isDraggingNodeRef.current || dimensionEditControlRef.current || hoveredEditControl)) {
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
        drawToolpath(ctx, toolpath, vt, toolpath.operationId === selectedOperationId)
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

    const dimensionEdit = dimensionEditRef.current
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
    } else if ((pendingAdd?.shape === 'rect' || pendingAdd?.shape === 'circle' || pendingAdd?.shape === 'tab' || pendingAdd?.shape === 'clamp') && pendingAdd.anchor && currentPreviewPoint) {
      const previewProfile = buildPendingProfile(pendingAdd, currentPreviewPoint, project.meta.units)
      const label =
        pendingAdd.shape === 'rect'
          ? 'Pending rectangle'
          : pendingAdd.shape === 'tab'
            ? 'Pending tab'
          : pendingAdd.shape === 'clamp'
            ? 'Pending clamp'
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
        const typedRadius = filletDimensionEditRef.current
          ? parseLengthInput(filletDimensionEditRef.current.radius, project.meta.units)
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
      if (!filletDimensionEditRef.current) {
        drawSketchEditPreviewPoint(ctx, sketchEditPreviewRef.current, vt)
      }
    }

    drawSnapIndicator(ctx, activeSnapRef.current, vt)
  }

  function scheduleDraw() {
    scheduleDrawRef.current = scheduleDraw
    if (drawFrameRef.current !== null) {
      return
    }

    drawFrameRef.current = window.requestAnimationFrame(() => {
      drawFrameRef.current = null
      drawRef.current()
    })
  }

  useEffect(() => {
    return () => {
      if (drawFrameRef.current !== null) {
        window.cancelAnimationFrame(drawFrameRef.current)
      }

      const canvas = canvasRef.current
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
    if (!copyCountPromptActive) {
      return
    }

    const frame = window.requestAnimationFrame(() => {
      copyCountInputRef.current?.focus({ preventScroll: true })
      copyCountInputRef.current?.select()
    })

    return () => window.cancelAnimationFrame(frame)
  }, [copyCountPromptActive])

  useEffect(() => {
    if (!dimensionEdit) return
    const inputRef =
      dimensionEdit.activeField === 'width' ? widthInputRef
      : dimensionEdit.activeField === 'height' ? heightInputRef
      : dimensionEdit.activeField === 'radius' ? radiusInputRef
      : dimensionEdit.activeField === 'length' ? widthInputRef
      : heightInputRef  // angle
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [dimensionEdit?.activeField, !dimensionEdit])

  useEffect(() => {
    if (!filletDimensionEdit) return
    const frame = window.requestAnimationFrame(() => {
      filletRadiusInputRef.current?.focus({ preventScroll: true })
      filletRadiusInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [!filletDimensionEdit])

  useEffect(() => {
    if (constraintDistanceInput == null) return
    const frame = window.requestAnimationFrame(() => {
      constraintDistanceInputRef.current?.focus({ preventScroll: true })
      constraintDistanceInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [constraintDistanceInput == null])

  useEffect(() => {
    if (!constraintEdit) return
    const frame = window.requestAnimationFrame(() => {
      constraintEditInputRef.current?.focus({ preventScroll: true })
      constraintEditInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [constraintEdit?.constraintId])

  useEffect(() => {
    if (!pendingConstraint) setConstraintDistanceInput(null)
  }, [pendingConstraint])

  useEffect(() => {
    if (selection.mode !== 'sketch_edit' || selection.sketchEditTool !== 'fillet') {
      setFilletDimensionEdit(null)
    }
  }, [selection.mode, selection.sketchEditTool])

  useEffect(() => {
    if (!pendingAdd) {
      setDimensionEdit(null)
    }
  }, [pendingAdd])

  useEffect(() => {
    if (!pendingMove) setOperationDimEdit(null)
  }, [pendingMove])

  useEffect(() => {
    if (!pendingTransform) setOperationDimEdit(null)
  }, [pendingTransform])

  useEffect(() => {
    if (!pendingOffset) setOperationDimEdit(null)
  }, [pendingOffset])

  useEffect(() => {
    if (!operationDimEdit) return
    const inputRef = widthInputRef
    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus({ preventScroll: true })
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [operationDimEdit?.kind, !operationDimEdit])

  useEffect(() => {
    const pendingMove = pendingMoveRef.current
    if (!operationDimEdit || !pendingMove?.fromPoint) {
      return
    }

    if (operationDimEdit.kind !== 'move' && operationDimEdit.kind !== 'copy') {
      return
    }

    const units = projectRef.current.meta.units
    const distance = parseLengthInput(operationDimEdit.distance, units)
    if (distance === null) {
      return
    }
    setPendingMovePreviewPointRef({
      point: computeMoveDistancePreviewPoint(
        pendingMove.fromPoint,
        pendingMovePreviewPointRef.current?.point ?? pendingMove.fromPoint,
        distance,
      ),
      session: pendingMove.session,
    })
  }, [operationDimEdit])

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
  }, [operationDimEdit])

  useImperativeHandle(ref, () => ({
    zoomToModel: () => {
      const canvas = canvasRef.current
      if (!canvas) return
      setViewState(computeFitViewState(project, canvas.width, canvas.height))
    },
  }), [project])

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
    if (copyCountPromptActive) {
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
  }, [copyCountPromptActive, operationDimEdit, pendingMove, pendingTransform, pendingOffset, pendingShapeAction, selection.mode, selection.selectedFeatureId, selection.selectedFeatureIds.length])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    function handleNativePointerMove(event: PointerEvent) {
      const coalesced = typeof event.getCoalescedEvents === 'function' ? event.getCoalescedEvents() : []
      const sourceEvent = coalesced.length > 0 ? coalesced[coalesced.length - 1] : event
      handleCanvasPointerMove(canvasCoordinates(sourceEvent))
    }

    canvas.addEventListener('pointermove', handleNativePointerMove)
    return () => {
      canvas.removeEventListener('pointermove', handleNativePointerMove)
    }
  }, [copyCountPromptActive, pendingMove, pendingTransform, selection.mode, selection.selectedFeatureId, selection.selectedFeatureIds.length, zoomWindowActive])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    function handleNativeWheel(event: globalThis.WheelEvent) {
      handleWheelEvent(event)
    }

    canvas.addEventListener('wheel', handleNativeWheel, { passive: false })
    return () => {
      canvas.removeEventListener('wheel', handleNativeWheel)
    }
  }, [zoomWindowActive])

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
    return project.features.find((feature) => feature.id === selection.selectedFeatureId) ?? null
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

  function computeEditStepsForControl(profile: SketchFeature['sketch']['profile'], control: SketchControlRef | null): EditDimStep[] {
    if (!control) {
      return []
    }

    if (control.kind === 'anchor') {
      return computeEditDimSteps(profile, control.index)
    }

    if (control.kind === 'circle_center') {
      return computeEditDimSteps(profile, 0)
    }

    if (control.kind === 'arc_handle') {
      return [{ kind: 'arc_radius', control, arcStartAnchorIndex: control.index }]
    }

    return []
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
        if (segment.type !== 'line') {
          continue
        }

        const start = anchorPointForIndex(profile, index)
        const projected = projectPointToSegment(worldPoint, start, segment.to)
        const projectedCanvas = worldToCanvas(projected.point, vt)
        const d2 = distance2(point, projectedCanvas)
        if (d2 <= Math.min(bestDistanceSq, segmentHitRadiusSq)) {
          bestDistanceSq = d2
          bestControl = { kind: 'segment', index, t: projected.t }
        }
      }
    }

    return bestControl
  }

  function handleMouseDown(event: MouseEvent<HTMLCanvasElement>) {
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

    if (selection.mode === 'sketch_edit' && selection.sketchEditTool) {
      return
    }

    const canvas = canvasRef.current
    if (!canvas) {
      return
    }

    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
    const world = canvasToWorld(point.cx, point.cy, vt)
    const control = hitEditableControl(point)
    const hitClampId = findHitClampId(world, project.clamps)
    const hitTabId = findHitTabId(world, project.tabs)
    const hitFeatureId = findHitFeatureId(world, project.features, vt)
    if (!control && !hitClampId && !hitTabId && !hitFeatureId) {
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
        if (distance !== null) {
          const direction = unitDirection(pendingMove.fromPoint, snapped)
          setPendingMovePreviewPointRef({
            point: {
              x: pendingMove.fromPoint.x + direction.x * Math.abs(distance),
              y: pendingMove.fromPoint.y + direction.y * Math.abs(distance),
            },
            session: pendingMove.session,
          })
          return
        }
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
      const steps = feature ? computeEditStepsForControl(feature.sketch.profile, hoveredControl) : []
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

  function stopPan() {
    isPanningRef.current = false
    lastPanPointRef.current = null
  }

  function handleMouseUp() {
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
    stopNodeDrag()
    stopPan()
  }

  function handleMouseLeave() {
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
    pendingSketchExtensionRef.current = null
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
    } else if ((pendingAdd?.shape === 'rect' || pendingAdd?.shape === 'circle' || pendingAdd?.shape === 'tab' || pendingAdd?.shape === 'clamp') && pendingAdd.anchor) {
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
    const viewState = viewStateRef.current
    const dimensionEdit = dimensionEditRef.current
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
      setConstraintDistanceInput(formatLength(currentDistance, project.meta.units))
      return
    }

    if (selection.mode === 'sketch_edit') {
      if (selection.selectedNode?.type === 'feature' && selection.selectedFeatureId) {
        const feature = editableFeature()
        if (feature && selection.sketchEditTool === 'add_point') {
          if (pendingSketchExtensionRef.current) {
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

        if (feature && selection.sketchEditTool === 'fillet') {
          if (pendingSketchFilletRef.current) {
            const typedRadius = filletDimensionEditRef.current
              ? parseLengthInput(filletDimensionEditRef.current.radius, project.meta.units)
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
            setFilletDimensionEdit(null)
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

      return
    }

    if (dimensionEdit) {
      commitEditDimension()
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
      } else if ((pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp') && !pendingAdd.anchor) {
        setPendingAddAnchor(snapped)
        setPendingPreviewPointRef({ point: snapped, session: pendingAdd.session })
      } else if (pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp') {
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
        setPendingMoveTo(lockedSnapped)
        setPendingMovePreviewPointRef({ point: lockedSnapped, session: pendingMove.session })
        setCopyCountDraft('1')
        if (pendingMove.mode === 'move') {
          completePendingMove(lockedSnapped)
          setPendingMovePreviewPointRef(null)
        }
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
          const constraint = feature?.sketch.constraints.find((c) => c.id === rect.constraintId)
          if (constraint && typeof constraint.value === 'number') {
            setConstraintEdit({
              featureId: rect.featureId,
              constraintId: rect.constraintId,
              value: formatLength(constraint.value, project.meta.units),
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
    if (hitId) {
      selectFeature(hitId, event.metaKey || event.ctrlKey || event.shiftKey)
    } else if (project.backdrop?.visible && hitBackdrop(world, project.backdrop)) {
      selectBackdrop()
    } else if (!(event.metaKey || event.ctrlKey || event.shiftKey)) {
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

  function handleContextMenu(event: MouseEvent<HTMLCanvasElement>) {
    event.preventDefault()

    if (zoomWindowActive) {
      return
    }

    if (didPanRef.current) {
      didPanRef.current = false
      return
    }

    const project = projectRef.current
    const selection = selectionRef.current
    const pendingAdd = pendingAddRef.current
    const pendingMove = pendingMoveRef.current
    const pendingTransform = pendingTransformRef.current
    const pendingOffset = pendingOffsetRef.current
    if (pendingAdd) {
      return
    }

    if (pendingMove) {
      return
    }

    if (pendingTransform) {
      return
    }

    if (pendingOffset) {
      return
    }

    const canvas = canvasRef.current
    if (!canvas) return

    const point = canvasCoordinates(event)
    const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewStateRef.current)
    const world = canvasToWorld(point.cx, point.cy, vt)
    const hitClampId = findHitClampId(world, project.clamps)
    if (hitClampId) {
      selectClamp(hitClampId)
      onClampContextMenu?.(hitClampId, event.clientX, event.clientY)
      return
    }

    const hitTabId = findHitTabId(world, project.tabs)
    if (hitTabId) {
      selectTab(hitTabId)
      onTabContextMenu?.(hitTabId, event.clientX, event.clientY)
      return
    }

    const hitId = findHitFeatureId(world, project.features, vt)
    if (!hitId) {
      return
    }

    if (!selection.selectedFeatureIds.includes(hitId)) {
      selectFeature(hitId)
    }
    onFeatureContextMenu?.(hitId, event.clientX, event.clientY)
  }

  function applyEditDimStep(stepIndex: number, steps: EditDimStep[], featureId: string, units: 'mm' | 'inch') {
    if (stepIndex >= steps.length) {
      cancelEditDimension()
      return
    }
    const step = steps[stepIndex]
    dimensionEditControlRef.current = step.control
    const feature = useProjectStore.getState().project.features.find((f) => f.id === featureId)
    if (!feature) return
    const profile = feature.sketch.profile

    if (step.kind === 'endpoint') {
      const fromPoint = anchorPointForIndex(profile, step.fromAnchorIndex)
      const anchorPos = anchorPointForIndex(profile, step.control.index)
      const dx = anchorPos.x - fromPoint.x
      const dy = anchorPos.y - fromPoint.y
      setDimensionEdit({
        shape: 'composite',
        anchor: fromPoint,
        signX: 1,
        signY: 1,
        activeField: 'length',
        width: '',
        height: '',
        radius: '',
        length: formatLength(Math.hypot(dx, dy), units),
        angle: (Math.atan2(dy, dx) * (180 / Math.PI)).toFixed(2).replace(/\.?0+$/, ''),
      })
    } else {
      const seg = profile.segments[step.control.index]
      if (!seg || (seg.type !== 'arc' && seg.type !== 'circle')) return
      const arcStart = anchorPointForIndex(profile, step.arcStartAnchorIndex)
      const radius = seg.type === 'arc'
        ? Math.hypot(arcStart.x - seg.center.x, arcStart.y - seg.center.y)
        : Math.hypot(profile.start.x - seg.center.x, profile.start.y - seg.center.y)
      const arcMid = seg.type === 'arc'
        ? arcControlPoint(arcStart, seg)
        : seg.center
      setDimensionEdit({
        shape: 'circle',
        anchor: arcMid,
        signX: 1,
        signY: 1,
        activeField: 'radius',
        width: '',
        height: '',
        radius: formatLength(radius, units),
        length: '',
        angle: '',
      })
    }
  }

  function advanceTabInEditMode() {
    const currentEdit = dimensionEditRef.current
    const steps = editDimStepsRef.current
    const stepIndex = editDimStepIndexRef.current
    if (!currentEdit) return

    const step = steps[stepIndex]
    if (step?.kind === 'endpoint' && currentEdit.activeField === 'length') {
      setDimensionEdit({ ...currentEdit, activeField: 'angle' })
      return
    }

    const nextIndex = stepIndex + 1
    editDimStepIndexRef.current = nextIndex
    const featureId = dimensionEditFeatureIdRef.current
    const units = projectRef.current.meta.units
    if (featureId) {
      applyEditDimStep(nextIndex, steps, featureId, units)
    }
  }

  function commitEditDimension() {
    commitHistoryTransaction()
    dimensionEditControlRef.current = null
    dimensionEditFeatureIdRef.current = null
    editDimStepsRef.current = []
    editDimStepIndexRef.current = 0
    setDimensionEdit(null)
    canvasRef.current?.focus({ preventScroll: true })
  }

  function cancelEditDimension() {
    cancelHistoryTransaction()
    dimensionEditControlRef.current = null
    dimensionEditFeatureIdRef.current = null
    editDimStepsRef.current = []
    editDimStepIndexRef.current = 0
    setDimensionEdit(null)
    canvasRef.current?.focus({ preventScroll: true })
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

    if (event.key === 'Tab' && pendingAdd) {
      const currentEdit = dimensionEditRef.current
      const units = projectRef.current.meta.units

      if (
        (pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp')
        && pendingAdd.anchor
      ) {
        event.preventDefault()
        const previewPoint = pendingPreviewPointRef.current?.point ?? pendingAdd.anchor

        if (!currentEdit) {
          if (pendingAdd.shape === 'circle') {
            const r = Math.hypot(previewPoint.x - pendingAdd.anchor.x, previewPoint.y - pendingAdd.anchor.y)
            setDimensionEdit({
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
            setDimensionEdit({
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
          setDimensionEdit({ ...currentEdit, activeField: 'height' })
        } else {
          setDimensionEdit(null)
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
          setDimensionEdit({
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
          setDimensionEdit({ ...currentEdit, activeField: 'angle' })
        } else {
          setDimensionEdit(null)
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
          setDimensionEdit({
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
          setDimensionEdit(null)
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
          setDimensionEdit({
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
          setDimensionEdit({ ...currentEdit, activeField: 'angle' })
        } else {
          setDimensionEdit(null)
          canvasRef.current?.focus({ preventScroll: true })
        }
        return
      }
    }

    if (event.key === 'Tab' && pendingMove && pendingMove.fromPoint && !pendingMove.toPoint) {
      event.preventDefault()
      const currentEdit = operationDimEditRef.current
      const units = projectRef.current.meta.units
      if (!currentEdit) {
        const previewPoint = pendingMovePreviewPointRef.current?.point ?? pendingMove.fromPoint
        const dx = previewPoint.x - pendingMove.fromPoint.x
        const dy = previewPoint.y - pendingMove.fromPoint.y
        setOperationDimEdit({
          kind: pendingMove.mode,
          distance: formatLength(Math.hypot(dx, dy), units),
        })
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
      const current = filletDimensionEditRef.current
      if (!current) {
        const radius = filletRadiusFromPoint(feature, pendingSketchFilletRef.current.anchorIndex, sketchEditPreviewRef.current.point)
        setFilletDimensionEdit({
          anchorIndex: pendingSketchFilletRef.current.anchorIndex,
          corner: pendingSketchFilletRef.current.corner,
          radius: radius ? formatLength(radius, units) : '',
        })
      } else {
        setFilletDimensionEdit(null)
        canvasRef.current?.focus({ preventScroll: true })
      }
      return
    }

    if (event.key === 'Tab' && selection.mode === 'sketch_edit' && !pendingAdd) {
      event.preventDefault()
      const currentEdit = dimensionEditRef.current
      const units = projectRef.current.meta.units

      if (currentEdit && dimensionEditControlRef.current) {
        advanceTabInEditMode()
        return
      }

      const featureId = selection.selectedFeatureId
      if (!featureId) return
      const feature = projectRef.current.features.find((f) => f.id === featureId)
      if (!feature) return

      const profile = feature.sketch.profile
      const control = selection.activeControl ?? hoveredEditControlRef.current
      const steps = computeEditStepsForControl(profile, control)

      if (steps.length === 0) return

      editDimStepsRef.current = steps
      editDimStepIndexRef.current = 0
      dimensionEditFeatureIdRef.current = featureId
      beginHistoryTransaction()
      applyEditDimStep(0, steps, featureId, units)
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
        completePendingOpenComposite()
        setPendingPreviewPointRef(null)
        return
      }
    }

    if (event.key === 'Escape' && pendingAdd) {
      originPreviewPointRef.current = null
      cancelPendingAdd()
      setPendingPreviewPointRef(null)
      setDimensionEdit(null)
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

    if (event.key === 'Enter' && selection.mode === 'sketch_edit' && filletDimensionEditRef.current && pendingSketchFilletRef.current) {
      const featureId = selection.selectedFeatureId
      const typedRadius = parseLengthInput(filletDimensionEditRef.current.radius, project.meta.units)
      if (featureId && typedRadius !== null && typedRadius > 0) {
        filletFeaturePoint(featureId, pendingSketchFilletRef.current.anchorIndex, typedRadius)
      }
      pendingSketchFilletRef.current = null
      sketchEditPreviewRef.current = null
      setFilletDimensionEdit(null)
      scheduleDraw()
      return
    }

    if (event.key === 'Escape' && selection.mode === 'sketch_edit' && filletDimensionEditRef.current && pendingSketchFilletRef.current) {
      pendingSketchFilletRef.current = null
      sketchEditPreviewRef.current = null
      setFilletDimensionEdit(null)
      scheduleDraw()
      return
    }

    if (event.key === 'Enter' && selection.mode === 'sketch_edit' && dimensionEditRef.current && dimensionEditControlRef.current) {
      commitEditDimension()
      return
    }

    if (event.key === 'Escape' && selection.mode === 'sketch_edit' && dimensionEditRef.current && dimensionEditControlRef.current) {
      cancelEditDimension()
      return
    }

    if (pendingConstraintRef.current) {
      if (event.key === 'Escape') {
        event.preventDefault()
        cancelPendingConstraint()
        setConstraintDistanceInput(null)
        canvasRef.current?.focus({ preventScroll: true })
        return
      }
      if (event.key === 'Enter' && pendingConstraintRef.current.reference && constraintDistanceInput != null) {
        event.preventDefault()
        const parsed = parseLengthInput(constraintDistanceInput, project.meta.units)
        if (parsed != null && parsed >= 0) {
          commitConstraintDistance(parsed)
          setConstraintDistanceInput(null)
          canvasRef.current?.focus({ preventScroll: true })
        }
        return
      }
      return
    }

    if (
      event.key === 'c'
      && !event.metaKey
      && !event.ctrlKey
      && !event.altKey
      && selection.mode === 'sketch_edit'
      && selection.selectedNode?.type === 'feature'
      && selection.selectedFeatureId
      && !selection.sketchEditTool
      && !dimensionEditRef.current
      && !filletDimensionEditRef.current
    ) {
      event.preventDefault()
      beginConstraint(selection.selectedFeatureId)
      return
    }

    if (event.key === 'Enter' && selection.mode === 'sketch_edit') {
      stopNodeDrag()
      applySketchEdit()
      return
    }

    if (event.key === 'Escape' && selection.mode === 'sketch_edit') {
      stopNodeDrag()
      cancelSketchEdit()
    }
  }

  const editingFeature =
    selection.mode === 'sketch_edit' && selection.selectedFeatureId
      ? project.features.find((feature) => feature.id === selection.selectedFeatureId) ?? null
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
        onMouseDown={handleMouseDown}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseLeave}
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
              <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--selected" />
              <span>Selected</span>
            </div>
          </div>
        </div>
      ) : null}
      {dimensionEdit && pendingAdd && (() => {
        const canvas = canvasRef.current
        if (!canvas) return null
        const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
        const previewPt = computeDimensionEditPreviewPoint(dimensionEdit, project.meta.units)

        function commitDimensionEdit() {
          const edit = dimensionEditRef.current
          if (!edit) return
          const pt = computeDimensionEditPreviewPoint(edit, projectRef.current.meta.units)
          const pendingAdd = pendingAddRef.current
          if ((edit.shape === 'polygon' || edit.shape === 'spline') && (pendingAdd?.shape === 'polygon' || pendingAdd?.shape === 'spline')) {
            addPendingPolygonPoint(pt)
            setPendingPreviewPointRef({ point: pt, session: pendingAdd.session })
            setDimensionEdit(null)
            canvasRef.current?.focus({ preventScroll: true })
          } else if (pendingAdd?.shape === 'composite') {
            addPendingCompositePoint(pt)
            setPendingPreviewPointRef({ point: pt, session: pendingAdd.session })
            setDimensionEdit(null)
            canvasRef.current?.focus({ preventScroll: true })
          } else {
            placePendingAddAt(pt)
            setPendingPreviewPointRef(null)
            setDimensionEdit(null)
          }
        }

        function makeDimInputKeyDown(field: 'width' | 'height' | 'radius' | 'length' | 'angle') {
          return (e: KeyboardEvent<HTMLInputElement>) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              commitDimensionEdit()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setDimensionEdit(null)
              canvasRef.current?.focus({ preventScroll: true })
            } else if (e.key === 'Tab') {
              e.preventDefault()
              const edit = dimensionEditRef.current
              if (!edit) return
              if (field === 'width') {
                setDimensionEdit({ ...edit, activeField: 'height' })
              } else if (field === 'length') {
                setDimensionEdit({ ...edit, activeField: 'angle' })
              } else {
                setDimensionEdit(null)
                canvasRef.current?.focus({ preventScroll: true })
              }
            }
          }
        }

        if (dimensionEdit.shape === 'polygon' || dimensionEdit.shape === 'spline' || dimensionEdit.shape === 'composite') {
          const fromC = worldToCanvas(dimensionEdit.anchor, vt)
          const toC = worldToCanvas(previewPt, vt)
          const layout = computeLinearInputLabel(fromC, toC, 14, 40)
          const angleLabelX = layout.midX + layout.perpX * 36
          const angleLabelY = layout.midY + layout.perpY * 36
          return (
            <>
              <input
                key="length"
                ref={widthInputRef}
                className="sketch-dim-input"
                style={{ left: layout.labelX, top: layout.labelY, transform: `translate(-50%, -50%) rotate(${layout.angle}rad)` }}
                value={dimensionEdit.length}
                onChange={(e) => setDimensionEdit((prev) => prev ? { ...prev, length: e.target.value } : null)}
                onKeyDown={makeDimInputKeyDown('length')}
                onFocus={(e) => e.currentTarget.select()}
              />
              <input
                key="angle"
                ref={heightInputRef}
                className="sketch-dim-input"
                style={{ left: angleLabelX, top: angleLabelY, transform: `translate(-50%, -50%) rotate(${layout.angle}rad)` }}
                value={dimensionEdit.angle}
                onChange={(e) => setDimensionEdit((prev) => prev ? { ...prev, angle: e.target.value } : null)}
                onKeyDown={makeDimInputKeyDown('angle')}
                onFocus={(e) => e.currentTarget.select()}
              />
            </>
          )
        }

        if (
          pendingAdd.shape !== 'rect' && pendingAdd.shape !== 'circle'
          && pendingAdd.shape !== 'tab' && pendingAdd.shape !== 'clamp'
          && pendingAdd.shape !== 'composite'
        ) return null
        if (pendingAdd.shape !== 'composite' && !pendingAdd.anchor) return null
        if (pendingAdd.shape === 'composite' && !pendingAdd.start) return null

        if (dimensionEdit.shape === 'circle') {
          const anchorC = worldToCanvas(dimensionEdit.anchor, vt)
          const previewC = worldToCanvas(previewPt, vt)
          const layout = computeLinearInputLabel(anchorC, previewC, 11, 40)
          return (
            <input
              key="radius"
              ref={radiusInputRef}
              className="sketch-dim-input"
              style={{ left: layout.labelX, top: layout.labelY, transform: `translate(-50%, -50%) rotate(${layout.angle}rad)` }}
              value={dimensionEdit.radius}
              onChange={(e) => setDimensionEdit((prev) => prev ? { ...prev, radius: e.target.value } : null)}
              onKeyDown={makeDimInputKeyDown('radius')}
              onFocus={(e) => e.currentTarget.select()}
            />
          )
        }

        const ax = dimensionEdit.anchor.x
        const ay = dimensionEdit.anchor.y
        const px = previewPt.x
        const py = previewPt.y
        const rectX = Math.min(ax, px)
        const rectY = Math.min(ay, py)
        const rectW = Math.abs(px - ax)
        const rectH = Math.abs(py - ay)

        const topLeft = worldToCanvas({ x: rectX, y: rectY }, vt)
        const topRight = worldToCanvas({ x: rectX + rectW, y: rectY }, vt)
        const widthLabelX = (topLeft.cx + topRight.cx) / 2
        const widthLabelY = topLeft.cy + 11

        const rightTop = worldToCanvas({ x: rectX + rectW, y: rectY }, vt)
        const rightBottom = worldToCanvas({ x: rectX + rectW, y: rectY + rectH }, vt)
        const heightLabelX = rightTop.cx - 11
        const heightLabelY = (rightTop.cy + rightBottom.cy) / 2

        return (
          <>
            <input
              key="width"
              ref={widthInputRef}
              className="sketch-dim-input"
              style={{ left: widthLabelX, top: widthLabelY, transform: 'translate(-50%, -50%)' }}
              value={dimensionEdit.width}
              onChange={(e) => setDimensionEdit((prev) => prev ? { ...prev, width: e.target.value } : null)}
              onKeyDown={makeDimInputKeyDown('width')}
              onFocus={(e) => e.currentTarget.select()}
            />
            <input
              key="height"
              ref={heightInputRef}
              className="sketch-dim-input sketch-dim-input--rotated"
              style={{ left: heightLabelX, top: heightLabelY, transform: 'translate(-50%, -50%) rotate(-90deg)' }}
              value={dimensionEdit.height}
              onChange={(e) => setDimensionEdit((prev) => prev ? { ...prev, height: e.target.value } : null)}
              onKeyDown={makeDimInputKeyDown('height')}
              onFocus={(e) => e.currentTarget.select()}
            />
          </>
        )
      })()}
      {dimensionEdit && selection.mode === 'sketch_edit' && !pendingAdd && (() => {
        const canvas = canvasRef.current
        if (!canvas) return null
        const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
        const featureId = selection.selectedFeatureId
        if (!featureId) return null

        function makeEditInputKeyDown(_field: 'length' | 'angle' | 'radius') {
          return (e: KeyboardEvent<HTMLInputElement>) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              commitEditDimension()
            } else if (e.key === 'Escape') {
              e.preventDefault()
              cancelEditDimension()
            } else if (e.key === 'Tab') {
              e.preventDefault()
              advanceTabInEditMode()
            }
          }
        }

        function handleLiveChange(field: 'length' | 'angle' | 'radius', value: string) {
          const prev = dimensionEditRef.current
          if (!prev) return
          const next = { ...prev, [field]: value }
          setDimensionEdit(next)
          const control = dimensionEditControlRef.current
          const fId = dimensionEditFeatureIdRef.current
          if (!control || !fId) return

          if (control.kind === 'arc_handle') {
            // Arc radius: compute new arc_handle point
            const feature = projectRef.current.features.find((f) => f.id === fId)
            if (!feature) return
            const profile = feature.sketch.profile
            const seg = profile.segments[control.index]
            if (!seg || seg.type !== 'arc') return
            const arcStart = anchorPointForIndex(profile, control.index)
            const newRadius = parseLengthInput(value, projectRef.current.meta.units) ?? 0
            if (newRadius <= 0) return
            const newHandle = arcHandleFromRadius(arcStart, seg, newRadius)
            if (newHandle) moveFeatureControl(fId, control, newHandle)
          } else {
            const pt = computeDimensionEditPreviewPoint(next, projectRef.current.meta.units)
            moveFeatureControl(fId, control, pt)
          }
        }

        // Arc radius step
        if (dimensionEdit.shape === 'circle') {
          const anchorC = worldToCanvas(dimensionEdit.anchor, vt)
          return (
            <input
              key="edit-radius"
              ref={radiusInputRef}
              className="sketch-dim-input"
              style={{ left: anchorC.cx, top: anchorC.cy, transform: 'translate(-50%, -50%)' }}
              value={dimensionEdit.radius}
              onChange={(e) => handleLiveChange('radius', e.target.value)}
              onKeyDown={makeEditInputKeyDown('radius')}
              onFocus={(e) => e.currentTarget.select()}
            />
          )
        }

        // Endpoint (length + angle) step
        const previewPt = computeDimensionEditPreviewPoint(dimensionEdit, project.meta.units)
        const fromC = worldToCanvas(dimensionEdit.anchor, vt)
        const toC = worldToCanvas(previewPt, vt)
        const layout = computeLinearInputLabel(fromC, toC, 14, 40)
        const angleLabelX = layout.midX + layout.perpX * 36
        const angleLabelY = layout.midY + layout.perpY * 36
        return (
          <>
            <input
              key="edit-length"
              ref={widthInputRef}
              className="sketch-dim-input"
              style={{ left: layout.labelX, top: layout.labelY, transform: `translate(-50%, -50%) rotate(${layout.angle}rad)` }}
              value={dimensionEdit.length}
              onChange={(e) => handleLiveChange('length', e.target.value)}
              onKeyDown={makeEditInputKeyDown('length')}
              onFocus={(e) => e.currentTarget.select()}
            />
            <input
              key="edit-angle"
              ref={heightInputRef}
              className="sketch-dim-input"
              style={{ left: angleLabelX, top: angleLabelY, transform: `translate(-50%, -50%) rotate(${layout.angle}rad)` }}
              value={dimensionEdit.angle}
              onChange={(e) => handleLiveChange('angle', e.target.value)}
              onKeyDown={makeEditInputKeyDown('angle')}
              onFocus={(e) => e.currentTarget.select()}
            />
          </>
        )
      })()}
      {filletDimensionEdit && selection.mode === 'sketch_edit' && (() => {
        const canvas = canvasRef.current
        if (!canvas) return null
        const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
        const cornerC = worldToCanvas(filletDimensionEdit.corner, vt)
        return (
          <input
            key="fillet-radius"
            ref={filletRadiusInputRef}
            className="sketch-dim-input"
            style={{ left: cornerC.cx, top: cornerC.cy, transform: 'translate(-50%, -50%)' }}
            value={filletDimensionEdit.radius}
            onChange={(e) => {
              const value = e.target.value
              setFilletDimensionEdit((prev) => (prev ? { ...prev, radius: value } : null))
              scheduleDraw()
            }}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                const current = filletDimensionEditRef.current
                const featureId = selectionRef.current.selectedFeatureId
                if (!current || !featureId) return
                const typedRadius = parseLengthInput(current.radius, projectRef.current.meta.units)
                if (typedRadius !== null && typedRadius > 0) {
                  filletFeaturePoint(featureId, current.anchorIndex, typedRadius)
                }
                pendingSketchFilletRef.current = null
                sketchEditPreviewRef.current = null
                setFilletDimensionEdit(null)
                canvasRef.current?.focus({ preventScroll: true })
                scheduleDraw()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                pendingSketchFilletRef.current = null
                sketchEditPreviewRef.current = null
                setFilletDimensionEdit(null)
                canvasRef.current?.focus({ preventScroll: true })
                scheduleDraw()
              } else if (e.key === 'Tab') {
                e.preventDefault()
                setFilletDimensionEdit(null)
                canvasRef.current?.focus({ preventScroll: true })
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
        )
      })()}
      {pendingConstraint && pendingConstraint.anchor && pendingConstraint.reference && constraintDistanceInput != null && (() => {
        const canvas = canvasRef.current
        if (!canvas) return null
        const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)
        const aC = worldToCanvas(pendingConstraint.anchor.point, vt)
        const rC = worldToCanvas(pendingConstraint.reference.point, vt)
        const midX = (aC.cx + rC.cx) / 2
        const midY = (aC.cy + rC.cy) / 2
        return (
          <input
            key="constraint-distance"
            ref={constraintDistanceInputRef}
            className="sketch-dim-input"
            style={{ left: midX, top: midY, transform: 'translate(-50%, -50%)' }}
            value={constraintDistanceInput}
            onChange={(e) => setConstraintDistanceInput(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter') {
                e.preventDefault()
                const parsed = parseLengthInput(constraintDistanceInput, project.meta.units)
                if (parsed != null && parsed >= 0) {
                  commitConstraintDistance(parsed)
                  setConstraintDistanceInput(null)
                  canvasRef.current?.focus({ preventScroll: true })
                }
              } else if (e.key === 'Escape') {
                e.preventDefault()
                cancelPendingConstraint()
                setConstraintDistanceInput(null)
                canvasRef.current?.focus({ preventScroll: true })
              }
            }}
            onFocus={(e) => e.currentTarget.select()}
          />
        )
      })()}
      {constraintEdit && (
        <input
          key={`constraint-edit-${constraintEdit.constraintId}`}
          ref={constraintEditInputRef}
          className="sketch-dim-input"
          style={{ left: constraintEdit.cx, top: constraintEdit.cy, transform: 'translate(-50%, -50%)' }}
          value={constraintEdit.value}
          onChange={(e) => setConstraintEdit((prev) => prev ? { ...prev, value: e.target.value } : null)}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') {
              e.preventDefault()
              const edit = constraintEditRef.current
              if (!edit) return
              const parsed = parseLengthInput(edit.value, project.meta.units)
              if (parsed != null && parsed >= 0) {
                updateConstraintValue(edit.featureId, edit.constraintId, parsed)
              }
              setConstraintEdit(null)
              canvasRef.current?.focus({ preventScroll: true })
            } else if (e.key === 'Escape') {
              e.preventDefault()
              setConstraintEdit(null)
              canvasRef.current?.focus({ preventScroll: true })
            }
          }}
          onBlur={() => setConstraintEdit(null)}
          onFocus={(e) => e.currentTarget.select()}
        />
      )}
      {operationDimEdit && (() => {
        const canvas = canvasRef.current
        if (!canvas) return null
        const vt = computeViewTransform(project.stock, canvas.width, canvas.height, viewState)

        if ((operationDimEdit.kind === 'move' || operationDimEdit.kind === 'copy') && pendingMove?.fromPoint) {
          const edit = operationDimEdit
          const units = project.meta.units
          const distance = parseLengthInput(edit.distance, units)
          const previewPoint =
            distance !== null
              ? computeMoveDistancePreviewPoint(
                  pendingMove.fromPoint,
                  pendingMovePreviewPointRef.current?.point ?? pendingMove.fromPoint,
                  distance,
                )
              : pendingMovePreviewPointRef.current?.point ?? pendingMove.fromPoint

          const fromC = worldToCanvas(pendingMove.fromPoint, vt)
          const toC = worldToCanvas(previewPoint, vt)
          const layout = computeLinearInputLabel(fromC, toC, 14)

          function commitMoveDistanceEdit() {
            const currentEdit = operationDimEditRef.current
            if (!currentEdit || (currentEdit.kind !== 'move' && currentEdit.kind !== 'copy')) return
            const pm = pendingMoveRef.current
            if (!pm || !pm.fromPoint) return
            const units = projectRef.current.meta.units
            const distance = parseLengthInput(currentEdit.distance, units)
            if (distance === null) return
            const toPoint = computeMoveDistancePreviewPoint(
              pm.fromPoint,
              pendingMovePreviewPointRef.current?.point ?? pm.fromPoint,
              distance,
            )
            if (currentEdit.kind === 'move') {
              completePendingMove(toPoint)
              setPendingMovePreviewPointRef(null)
            } else {
              setPendingMoveTo(toPoint)
              setPendingMovePreviewPointRef({ point: toPoint, session: pm.session })
              setCopyCountDraft('1')
            }
            setOperationDimEdit(null)
          }

          return (
            <input
              ref={widthInputRef}
              className="sketch-dim-input"
              style={{ left: layout.labelX, top: layout.labelY, transform: `translate(-50%, -50%) rotate(${layout.angle}rad)` }}
              value={edit.distance}
              onChange={(e) => setOperationDimEdit({ ...edit, distance: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  commitMoveDistanceEdit()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelPendingMove()
                  setPendingMovePreviewPointRef(null)
                  setCopyCountDraft('1')
                  setOperationDimEdit(null)
                } else if (e.key === 'Tab') {
                  e.preventDefault()
                  setOperationDimEdit(null)
                  canvasRef.current?.focus({ preventScroll: true })
                }
              }}
            />
          )
        }

        if (operationDimEdit.kind === 'scale' && pendingTransform?.mode === 'resize' && pendingTransform.referenceStart && pendingTransform.referenceEnd) {
          const factor = Number(operationDimEdit.factor)
          const previewPoint =
            Number.isFinite(factor) && factor > 0
              ? computeScalePreviewPoint(
                  pendingTransform.referenceStart,
                  pendingTransform.referenceEnd,
                  factor,
                )
              : pendingTransformPreviewPointRef.current?.point ?? pendingTransform.referenceEnd
          const fromC = worldToCanvas(pendingTransform.referenceStart, vt)
          const toC = worldToCanvas(previewPoint, vt)
          const layout = computeLinearInputLabel(fromC, toC, 14)

          return (
            <input
              ref={widthInputRef}
              className="sketch-dim-input"
              style={{ left: layout.labelX, top: layout.labelY, transform: `translate(-50%, -50%) rotate(${layout.angle}rad)` }}
              value={operationDimEdit.factor}
              onChange={(e) => setOperationDimEdit({ kind: 'scale', factor: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const edit = operationDimEditRef.current
                  if (!edit || edit.kind !== 'scale') return
                  const pt = pendingTransformRef.current
                  if (!pt || pt.mode !== 'resize' || !pt.referenceStart || !pt.referenceEnd) return
                  const factor = Number(edit.factor)
                  if (!Number.isFinite(factor) || factor <= 0) return
                  const previewPoint = computeScalePreviewPoint(
                    pt.referenceStart,
                    pt.referenceEnd,
                    factor,
                  )
                  completePendingTransform(previewPoint)
                  setPendingTransformPreviewPointRef(null)
                  setOperationDimEdit(null)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelPendingTransform()
                  setPendingTransformPreviewPointRef(null)
                  setOperationDimEdit(null)
                } else if (e.key === 'Tab') {
                  e.preventDefault()
                  setOperationDimEdit(null)
                  canvasRef.current?.focus({ preventScroll: true })
                }
              }}
            />
          )
        }

        if (operationDimEdit.kind === 'rotate' && pendingTransform?.mode === 'rotate' && pendingTransform.referenceStart && pendingTransform.referenceEnd) {
          const angleDegrees = Number(operationDimEdit.angle)
          const previewPoint =
            Number.isFinite(angleDegrees)
              ? computeRotatePreviewPoint(
                  pendingTransform.referenceStart,
                  pendingTransform.referenceEnd,
                  angleDegrees,
                )
              : pendingTransformPreviewPointRef.current?.point ?? pendingTransform.referenceEnd
          const originC = worldToCanvas(pendingTransform.referenceStart, vt)
          const previewC = worldToCanvas(previewPoint, vt)
          const layout = computeLinearInputLabel(originC, previewC, 22)

          return (
            <input
              ref={widthInputRef}
              className="sketch-dim-input"
              style={{ left: layout.labelX, top: layout.labelY, transform: `translate(-50%, -50%) rotate(${layout.angle}rad)` }}
              value={operationDimEdit.angle}
              onChange={(e) => setOperationDimEdit({ kind: 'rotate', angle: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const edit = operationDimEditRef.current
                  if (!edit || edit.kind !== 'rotate') return
                  const pt = pendingTransformRef.current
                  if (!pt || pt.mode !== 'rotate' || !pt.referenceStart || !pt.referenceEnd) return
                  const angleDegrees = Number(edit.angle)
                  if (!Number.isFinite(angleDegrees)) return
                  const previewPoint = computeRotatePreviewPoint(
                    pt.referenceStart,
                    pt.referenceEnd,
                    angleDegrees,
                  )
                  completePendingTransform(previewPoint)
                  setPendingTransformPreviewPointRef(null)
                  setOperationDimEdit(null)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelPendingTransform()
                  setPendingTransformPreviewPointRef(null)
                  setOperationDimEdit(null)
                } else if (e.key === 'Tab') {
                  e.preventDefault()
                  setOperationDimEdit(null)
                  canvasRef.current?.focus({ preventScroll: true })
                }
              }}
            />
          )
        }

        if (operationDimEdit.kind === 'offset' && pendingOffset) {
          const currentOffsetRawPreviewPoint =
            pendingOffsetRawPreviewPointRef.current?.session === pendingOffset.session
              ? pendingOffsetRawPreviewPointRef.current.point
              : null
          const currentOffsetPreviewPoint =
            pendingOffsetPreviewPointRef.current?.session === pendingOffset.session
              ? pendingOffsetPreviewPointRef.current.point
              : null
          const features = pendingOffset.entityIds
            .map((featureId) => project.features.find((entry) => entry.id === featureId) ?? null)
            .filter((feature): feature is SketchFeature => feature !== null)
            .filter((feature) => feature.sketch.profile.closed)
          const rawOffsetPoint = currentOffsetRawPreviewPoint ?? livePointerWorldRef.current ?? activeSnapRef.current?.rawPoint ?? null
          const snappedOffsetPoint = currentOffsetPreviewPoint ?? activeSnapRef.current?.point ?? rawOffsetPoint
          const previewInput =
            features.length > 0 && rawOffsetPoint && snappedOffsetPoint
              ? resolveOffsetPreview(features, rawOffsetPoint, snappedOffsetPoint, activeSnapRef.current?.mode ?? null, vt)
              : null
          const labelAnchor = previewInput?.nearestPoint ?? snappedOffsetPoint
          const labelTarget = snappedOffsetPoint ?? previewInput?.nearestPoint
          if (!labelAnchor || !labelTarget) return null

          const fromC = worldToCanvas(labelAnchor, vt)
          const toC = worldToCanvas(labelTarget, vt)
          const layout = computeLinearInputLabel(fromC, toC, 14)

          return (
            <input
              ref={widthInputRef}
              className="sketch-dim-input"
              style={{ left: layout.labelX, top: layout.labelY, transform: `translate(-50%, -50%) rotate(${layout.angle}rad)` }}
              value={operationDimEdit.distance}
              onChange={(e) => setOperationDimEdit({ kind: 'offset', distance: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                e.stopPropagation()
                if (e.key === 'Enter') {
                  e.preventDefault()
                  const edit = operationDimEditRef.current
                  if (!edit || edit.kind !== 'offset') return
                  const units = projectRef.current.meta.units
                  const dist = parseLengthInput(edit.distance, units)
                  if (dist === null) return
                  completePendingOffset(dist)
                  setPendingOffsetPreviewPointRef(null)
                  setPendingOffsetRawPreviewPointRef(null)
                  setOperationDimEdit(null)
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  cancelPendingOffset()
                  setPendingOffsetPreviewPointRef(null)
                  setPendingOffsetRawPreviewPointRef(null)
                  setOperationDimEdit(null)
                } else if (e.key === 'Tab') {
                  e.preventDefault()
                  setOperationDimEdit(null)
                  canvasRef.current?.focus({ preventScroll: true })
                }
              }}
            />
          )
        }

        return null
      })()}
      {selection.mode === 'sketch_edit' && (
        <div className="sketch-edit-banner">
          <div>
            {selection.sketchEditTool === 'add_point'
              ? 'Add Point active. Click a segment to insert a point, or click an open-path end first to start an extension. Press '
              : selection.sketchEditTool === 'delete_point'
                ? 'Delete Point active. Click anchors to remove them. Press '
                : selection.sketchEditTool === 'fillet'
                ? pendingSketchFilletRef.current
                    ? 'Fillet active. Click a second point to define the corner round, or press Tab to type the radius. Press '
                    : 'Fillet active. Click a line-line corner to start. Press '
                  : 'Drag nodes or straight segments to reshape. Hover a node and press Tab to type length/angle. Press '}
            <kbd>Enter</kbd> to apply or <kbd>Esc</kbd> to cancel.
          </div>
          {editingFeatureHasSelfIntersection ? (
            <div className="sketch-banner-warning">This profile self-intersects. 3D/CAM results may be invalid.</div>
          ) : null}
          {editingFeatureExceedsStock ? (
            <div className="sketch-banner-warning">This profile extends outside the stock boundary.</div>
          ) : null}
        </div>
      )}
      {pendingOffset && (
        <div className="sketch-place-banner">
          <>Move the mouse to preview the offset. Inside creates an inward offset, outside creates an outward offset. Press <kbd>Tab</kbd> to type exact distance, click to commit, or press <kbd>Esc</kbd> to cancel.</>
        </div>
      )}
      {pendingShapeAction && (
        <div className="sketch-place-banner">
          <span>
            {pendingShapeAction.kind === 'join'
              ? pendingShapeAction.entityIds.length < 2
                ? 'Join mode. Shift-click closed features to select at least two.'
                : `Join mode. ${pendingShapeAction.entityIds.length} closed features selected.`
              : !pendingShapeAction.cutterId
                ? 'Cut mode. Click one closed feature to use as the cutter.'
                : pendingShapeAction.targetIds.length === 0
                  ? 'Cut mode. Shift-click closed features that intersect the cutter to select targets.'
                  : `Cut mode. 1 cutter and ${pendingShapeAction.targetIds.length} target${pendingShapeAction.targetIds.length === 1 ? '' : 's'} selected.`}
            {' '}
          </span>
          <label className="sketch-place-toggle">
            <input
              type="checkbox"
              checked={pendingShapeAction.keepOriginals}
              onChange={(event) => setPendingShapeActionKeepOriginals(event.target.checked)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  completePendingShapeAction()
                } else if (event.key === 'Escape') {
                  event.preventDefault()
                  cancelPendingShapeAction()
                }
              }}
            />
            <span>Keep originals</span>
          </label>
          <span>Press <kbd>Enter</kbd> to confirm or <kbd>Esc</kbd> to cancel.</span>
        </div>
      )}
      {pendingAdd && (
        <div className="sketch-place-banner">
          <div>
            {pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline'
              ? pendingAdd.points.length === 0
                ? `Click to place the first ${pendingAdd.shape} control point.`
                : pendingAdd.points.length < 2
                  ? 'Click to add one more control point. Press Tab to type length/angle.'
                  : 'Click to add control points. Press Tab to type length/angle. Click the first point to close, or press Enter / double-click to finish open.'
            : pendingAdd.shape === 'origin'
              ? 'Click the sketch to place machine X0 Y0. Z remains manual in Properties.'
            : pendingAdd.shape === 'text'
              ? 'Move the mouse to preview the text, then click to place it.'
            : (pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp') && pendingAdd.anchor
              ? pendingAdd.shape === 'rect'
                ? 'Move the mouse to size the rectangle, then click the opposite corner. Press Tab to type dimensions.'
                : pendingAdd.shape === 'tab'
                  ? 'Move the mouse to size the tab footprint, then click the opposite corner. Press Tab to type dimensions.'
                : pendingAdd.shape === 'clamp'
                  ? 'Move the mouse to size the clamp footprint, then click the opposite corner. Press Tab to type dimensions.'
                : 'Move the mouse to set the radius, then click again to confirm the circle. Press Tab to type the radius.'
              : pendingAdd.shape === 'rect'
                ? 'Click the sketch to set the rectangle corner, then click again to size it.'
                : pendingAdd.shape === 'tab'
                  ? 'Click the sketch to set the tab corner, then click again to size it.'
                : pendingAdd.shape === 'clamp'
                  ? 'Click the sketch to set the clamp corner, then click again to size it.'
                : pendingAdd.shape === 'circle'
                  ? 'Click the sketch to set the circle center, then click again to set the radius.'
                    : !pendingAdd.start
                      ? 'Click to place the first composite point. Press L for line, A for arc, or S for spline.'
                      : pendingAdd.currentMode === 'arc'
                          ? pendingAdd.pendingArcEnd
                            ? 'Click a third point on the arc to define curvature. Press Tab to type position, Backspace to undo.'
                            : 'Click to place the arc end point, then click again to define the arc. Press Tab to type position, L or S to switch modes.'
                          : pendingAdd.currentMode === 'spline'
                            ? 'Click to add a spline segment endpoint. Press Tab to type length/angle. Click the first point to close, or press Enter to finish open.'
                            : 'Click to add connected line segments. Press Tab to type length/angle. Click the first point to close, or press Enter to finish open.'}
            {' '}Press <kbd>Esc</kbd> to cancel.
          </div>
          {pendingDraftHasSelfIntersection ? (
            <div className="sketch-banner-warning">This profile self-intersects. 3D/CAM results may be invalid.</div>
          ) : null}
          {pendingDraftExceedsStock ? (
            <div className="sketch-banner-warning">This profile extends outside the stock boundary.</div>
          ) : null}
        </div>
      )}
      {pendingConstraint && (
        <div className="sketch-place-banner">
          <div>
            <strong>Constraint:</strong>{' '}
            {!pendingConstraint.anchor
              ? 'Click a snap point on this feature to set the anchor.'
              : !pendingConstraint.reference
                ? 'Click a snap point on another feature to set the reference.'
                : 'Type the distance and press Enter.'}
            {' '}Press <kbd>Esc</kbd> to cancel.
          </div>
        </div>
      )}
      {pendingMove && (
        <div className="sketch-place-banner">
          {pendingMove.mode === 'copy' && pendingMove.fromPoint && pendingMove.toPoint ? (
            <>
              <span>Copies</span>
              <input
                ref={copyCountInputRef}
                className="sketch-place-count"
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
                  } else if (event.key === 'Escape') {
                    event.preventDefault()
                    cancelPendingMove()
                    setPendingMovePreviewPointRef(null)
                    setCopyCountDraft('1')
                  }
                }}
                autoFocus
              />
              <span>Press <kbd>Enter</kbd> to confirm, <kbd>Esc</kbd> to cancel.</span>
            </>
          ) : (
            pendingMove.fromPoint
              ? pendingMove.mode === 'copy'
                ? 'Click the copy to point, then enter the copy count. Press Tab to type exact distance. Press Esc to cancel.'
                : 'Click the destination point to complete the move. Press Tab to type exact distance. Press Esc to cancel.'
              : pendingMove.mode === 'copy'
                ? 'Click the copy from point, then click the copy to point. Press Esc to cancel.'
                : 'Click the move from point, then click the move to point. Press Esc to cancel.'
          )}
        </div>
      )}
      {pendingTransform && (
        <div className="sketch-place-banner">
          {pendingTransform.mode === 'resize'
            ? !pendingTransform.referenceStart
              ? 'Click the first resize reference point. Press Esc to cancel.'
              : !pendingTransform.referenceEnd
                ? 'Click the second resize reference point. Press Esc to cancel.'
                : 'Move along the reference line to preview the resized feature, then click to commit. Press Tab to type scale factor. Press Esc to cancel.'
            : !pendingTransform.referenceStart
              ? 'Click the rotation origin. Press Esc to cancel.'
              : !pendingTransform.referenceEnd
                ? 'Click the reference direction point. Press Esc to cancel.'
                : 'Move to preview the rotated feature, then click to commit. Press Tab to type exact angle. Press Esc to cancel.'}
        </div>
      )}
    </div>
  )
})
