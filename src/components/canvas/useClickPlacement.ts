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

import type { MouseEvent, MutableRefObject, RefObject } from 'react'
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
import type { DimensionAnchor, DimensionAnnotation, Point, Project, SketchFeature } from '../../types/project'
import { formatLength, parseLengthInput } from '../../utils/units'
import { filletRadiusFromPoint } from '../../store/helpers/referenceTransforms'
import {
  canvasToWorld,
  computeViewTransform,
} from './viewTransform'
import type { CanvasPoint, SketchViewState, ViewTransform } from './viewTransform'
import { findSketchInsertTarget, isLoopCloseCandidate, projectPointOntoLine, resolveOffsetPreview } from './draftGeometry'
import {
  compositeDraftPoints,
  findOpenProfileExtensionEndpoint,
  type PendingSketchExtension,
} from './draftHelpers'
import {
  findHitClampId,
  findHitFeatureId,
  findHitTabId,
} from './hitTest'
import { hitBackdrop } from './scenePrimitives'
import { anchorPointForIndex } from './profilePrimitives'
import { pickDimensionAt } from './dimensionRendering'
import { circleEdgeAnchorFromPoint, offsetForCursor } from '../../sketch/dimensions'
import type { ResolvedSnap } from './snappingHelpers'
import type { DimensionEditWorkflow } from './useDimensionEditWorkflow'
import type { ConstraintWorkflow } from './useConstraintWorkflow'
import type { MoveWorkflow } from './useMoveWorkflow'
import type { TransformExactWorkflow } from './useTransformExactWorkflow'
import type { FilletWorkflow } from './useFilletWorkflow'
import type { UseSnapPreviewReturn } from './useSnapPreview'

const POLYGON_CLOSE_RADIUS = 12

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

export interface ClickPlacementCtx {
  suppressClickRef: MutableRefObject<boolean>
  didPanRef: MutableRefObject<boolean>
  isDraggingNodeRef: MutableRefObject<boolean>
  zoomWindowActive: boolean
  multiSelectMode: boolean
  selectionRef: MutableRefObject<SelectionState>
  projectRef: MutableRefObject<Project>
  pendingAddRef: MutableRefObject<PendingAddTool | null>
  pendingMoveRef: MutableRefObject<PendingMoveTool | null>
  pendingTransformRef: MutableRefObject<PendingTransformTool | null>
  pendingOffsetRef: MutableRefObject<PendingOffsetTool | null>
  pendingShapeActionRef: MutableRefObject<PendingShapeActionTool | null>
  viewStateRef: MutableRefObject<SketchViewState>
  pendingConstraintRef: MutableRefObject<PendingConstraint | null>
  pendingDimensionRef: MutableRefObject<PendingDimensionTool | null>
  dimensionDeleteArmedRef: MutableRefObject<boolean>
  deleteHoverDimIdRef: MutableRefObject<string | null>
  selectedAnnotationIdRef: MutableRefObject<string | null>
  pendingSketchExtensionRef: MutableRefObject<PendingSketchExtension | null>
  pendingSketchFilletRef: MutableRefObject<PendingSketchFillet | null>
  sketchEditPreviewRef: MutableRefObject<SketchEditPreviewPoint | null>
  originPreviewPointRef: MutableRefObject<PendingPreviewPoint | null>
  tapeMeasureRef: MutableRefObject<TapeMeasureState | null>
  constraintLabelRectsRef: MutableRefObject<Array<{ featureId: string; constraintId: string; cx: number; cy: number; halfW: number; halfH: number }>>
  canvasRef: RefObject<HTMLCanvasElement | null>

  snap: UseSnapPreviewReturn
  dimEdit: DimensionEditWorkflow
  move: MoveWorkflow
  transformExact: TransformExactWorkflow
  fillet: FilletWorkflow
  constraint: ConstraintWorkflow

  canvasCoordinates: (event: Pick<MouseEvent<HTMLCanvasElement> | globalThis.WheelEvent, 'clientX' | 'clientY'>) => CanvasPoint
  editableFeature: () => SketchFeature | null
  endpointFromSketchExtension: (kind: PendingSketchExtension['kind']) => OpenProfileEndpoint
  findOpenEndpointHit: (
    rawPoint: Point,
    vt: ViewTransform,
    options?: { featureIds?: Set<string>; exclude?: OpenEndpointHit | null },
  ) => OpenEndpointHit | null
  findSketchSegmentHit: (
    profile: SketchFeature['sketch']['profile'],
    rawPoint: Point,
    vt: ViewTransform,
  ) => SegmentHit | null
  hitEditableControl: (point: CanvasPoint, options?: { includeSegments?: boolean }) => SketchControlRef | null

  scheduleDraw: () => void
  applyLock: (point: Point, reference: Point) => Point

  setPendingPreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void
  setPendingMovePreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void
  setPendingTransformPreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void
  setPendingOffsetPreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void
  setPendingOffsetRawPreviewPointRef: (nextPoint: PendingPreviewPoint | null) => void

  tapeMeasureClick: (point: Point) => void
  cancelPendingDimension: () => void
  addDimensionAnnotation: (annotation: {
    type: DimensionAnnotation['type']
    a: DimensionAnchor
    b?: DimensionAnchor
    c?: DimensionAnchor
    offset: number
    visible: boolean
    locked: boolean
    textOverride: string | null
    precisionOverride: number | null
  }) => void
  pendingDimensionPick: (anchor: DimensionAnchor) => void
  deleteDimensionAnnotation: (id: string) => void
  selectAnnotation: (id: string | null) => void
  selectFeature: (id: string | null, additive?: boolean) => void
  selectTab: (id: string) => void
  selectClamp: (id: string) => void
  selectBackdrop: () => void
  setConstraintAnchor: (anchor: { point: Point; snapMode: ResolvedSnap['mode'] }) => void
  setConstraintReference: (reference: {
    point: Point
    featureId: string | null
    snapMode: ResolvedSnap['mode']
    segment?: { a: Point; b: Point } | undefined
  }) => void
  insertFeaturePoint: (featureId: string, point: { kind: PendingSketchExtension['kind']; point: Point } | { kind: 'segment'; segmentIndex: number; point: Point; t: number }) => void
  joinOpenFeatureEndpoints: (
    featureId: string,
    sourceEndpoint: OpenProfileEndpoint,
    targetFeatureId: string,
    targetEndpoint: OpenProfileEndpoint,
  ) => boolean
  deleteFeaturePoint: (featureId: string, index: number) => void
  deleteFeatureSegment: (featureId: string, segmentIndex: number) => void
  disconnectFeaturePoint: (featureId: string, index: number) => void
  filletFeaturePoint: (featureId: string, anchorIndex: number, radius: number) => void
  setPendingAddAnchor: (point: Point) => void
  placePendingAddAt: (point: Point) => void
  placePendingTextAt: (point: Point) => void
  placeOriginAt: (point: Point) => void
  addPendingPolygonPoint: (point: Point) => void
  completePendingPolygon: () => void
  addPendingCompositePoint: (point: Point) => void
  completePendingComposite: () => void
  setPendingMoveFrom: (point: Point) => void
  setPendingTransformReferenceStart: (point: Point) => void
  setPendingTransformReferenceEnd: (point: Point) => void
  completePendingTransform: (point: Point) => void
  completePendingOffset: (distance: number) => void
  cancelPendingOffset: () => void
  beginHistoryTransaction: () => void
}

export interface UseClickPlacementReturn {
  handleClick: (event: MouseEvent<HTMLCanvasElement>) => void
}

export function useClickPlacement(ctx: ClickPlacementCtx): UseClickPlacementReturn {
  const {
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
    canvasCoordinates,
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
  } = ctx

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
    const resolvedSnap = snap.resolveCurrentSketchSnap(world, vt, {
      excludeActiveEditGeometry: constraintRefPickingClick,
    })
    const pickedPoint = snap.requiresResolvedSnapForPointPick() && !resolvedSnap.mode ? null : resolvedSnap.point

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
        transformExact.setPendingRotateCopyPoint(constrainedPoint)
      } else {
        completePendingTransform(constrainedPoint)
        setPendingTransformPreviewPointRef(null)
      }
      return
    }

    if (pendingOffset) {
      const sourceFeatures = pendingOffset.entityIds
        .map((id) => project.features.find((f) => f.id === id) ?? null)
        .filter((f): f is SketchFeature => f !== null)
        .filter((f) => f.sketch.profile.closed)
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

  return { handleClick }
}
