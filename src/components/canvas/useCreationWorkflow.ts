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
  type MutableRefObject,
  type RefObject,
  type SetStateAction,
} from 'react'
import type { PendingAddTool } from '../../store/types'
import type { Point, Project } from '../../types/project'
import { parseLengthInput } from '../../utils/units'
import { computeDimensionEditPreviewPoint, type DimensionEditState } from './manualEntry'
import { useCanvasWorkflowPanel } from './useCanvasWorkflowPanel'

export interface CreationWorkflowCtx {
  projectRef: MutableRefObject<Project>
  pendingAdd: PendingAddTool | null
  pendingAddRef: MutableRefObject<PendingAddTool | null>
  dimensionEdit: DimensionEditState | null
  dimensionEditRef: MutableRefObject<DimensionEditState | null>
  setDimensionEdit: Dispatch<SetStateAction<DimensionEditState | null>>
  triggerDimensionEdit: () => void
  setPendingPreviewPointRef: (nextPoint: { point: Point; session: number } | null) => void
  placePendingAddAt: (point: Point) => void
  placePendingSlotAt: (point: Point) => void
  placePendingNgonAt: (point: Point) => void
  setPendingGearRadiusAt: (point: Point) => void
  completePendingGear: () => string[]
  cancelPendingAdd: () => void
  addPendingPolygonPoint: (point: Point) => void
  addPendingCompositePoint: (point: Point) => void
  undoPendingPolygonPoint: () => void
  undoPendingCompositeStep: () => void
  completePendingOpenPath: () => void
  completePendingOpenComposite: () => void
  setPendingCompositeMode: (mode: 'line' | 'arc' | 'spline') => void
  containerRef: RefObject<HTMLDivElement | null>
  canvasRef: RefObject<HTMLCanvasElement | null>
  clearTransientCanvasState: () => void
}

type CreationPanelShape = 'rect' | 'circle' | 'ellipse' | 'tab' | 'clamp' | 'polygon' | 'spline' | 'composite' | 'slot' | 'ngon' | 'gear' | 'roundrect' | 'chamferrect' | null

export interface CreationWorkflow {
  creationPanelShape: CreationPanelShape
  creationPanelHasAnchor: boolean
  creationPanelHasPoints: boolean
  creationPanelHasStart: boolean
  creationCanDimEdit: boolean
  creationDimEditActive: boolean
  placementPanelActive: boolean
  creationWorkflowPanel: ReturnType<typeof useCanvasWorkflowPanel>
  placementWorkflowPanel: ReturnType<typeof useCanvasWorkflowPanel>
  triggerDimensionFromCreationPanel: () => void
  commitCreationDimensionEdit: () => void
  cancelCreationDimensionEdit: () => void
  cancelCreationFromPanel: () => void
  undoFromCreationPanel: () => void
  finishOpenPathFromPanel: () => void
  finishOpenCompositeFromPanel: () => void
  completeGearFromPanel: () => void
  setCompositeModeFromPanel: (mode: 'line' | 'arc' | 'spline') => void
}

export function useCreationWorkflow(ctx: CreationWorkflowCtx): CreationWorkflow {
  const {
    projectRef,
    pendingAdd,
    pendingAddRef,
    dimensionEdit,
    dimensionEditRef,
    setDimensionEdit,
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
  } = ctx

  const creationPanelShape: CreationPanelShape = pendingAdd && (
    pendingAdd.shape === 'rect' || pendingAdd.shape === 'circle' || pendingAdd.shape === 'ellipse'
    || pendingAdd.shape === 'tab' || pendingAdd.shape === 'clamp'
    || pendingAdd.shape === 'polygon' || pendingAdd.shape === 'spline' || pendingAdd.shape === 'composite'
    || pendingAdd.shape === 'slot' || pendingAdd.shape === 'ngon' || pendingAdd.shape === 'gear'
    || pendingAdd.shape === 'roundrect' || pendingAdd.shape === 'chamferrect'
  ) ? pendingAdd.shape : null
  const creationPanelHasAnchor = creationPanelShape != null && pendingAdd != null && 'anchor' in pendingAdd && !!pendingAdd.anchor
  const creationPanelHasPoints = creationPanelShape != null && pendingAdd != null && 'points' in pendingAdd && pendingAdd.points.length > 0
  const creationPanelHasStart = creationPanelShape === 'composite' && pendingAdd?.shape === 'composite' && !!pendingAdd.start
  const creationCanDimEdit = creationPanelHasAnchor
    || creationPanelHasPoints
    || (creationPanelHasStart && pendingAdd?.shape === 'composite' && !pendingAdd.closed)
  const creationDimEditActive = !!creationCanDimEdit && !!dimensionEdit

  const creationWorkflowPanel = useCanvasWorkflowPanel({
    open: !!creationPanelShape,
    phaseKey: creationDimEditActive ? 'dimensions'
      : (pendingAdd?.shape === 'slot' && 'points' in pendingAdd && pendingAdd.points.length >= 2) ? 'width'
      : (pendingAdd?.shape === 'gear' && pendingAdd.outsideRadius !== null) ? 'parameters'
      : creationPanelHasAnchor ? 'place'
      : creationPanelHasPoints ? 'adding'
      : creationPanelHasStart ? 'drawing'
      : 'start',
    containerRef,
    canvasRef,
    clearTransientCanvasState,
    focusCanvasOnOpen: !creationDimEditActive && !(pendingAdd?.shape === 'gear' && pendingAdd.outsideRadius !== null),
  })

  const placementPanelActive = !!pendingAdd && !creationPanelShape
  const placementWorkflowPanel = useCanvasWorkflowPanel({
    open: placementPanelActive,
    phaseKey: pendingAdd?.shape ?? 'place',
    containerRef,
    canvasRef,
    clearTransientCanvasState,
  })

  function triggerDimensionFromCreationPanel() {
    triggerDimensionEdit()
  }

  function commitCreationDimensionEdit() {
    const edit = dimensionEditRef.current
    if (!edit) return
    const pt = computeDimensionEditPreviewPoint(edit, projectRef.current.meta.units)
    const curr = pendingAddRef.current
    if ((edit.shape === 'polygon' || edit.shape === 'spline') && (curr?.shape === 'polygon' || curr?.shape === 'spline')) {
      addPendingPolygonPoint(pt)
      setPendingPreviewPointRef({ point: pt, session: curr.session })
      setDimensionEdit(null)
      creationWorkflowPanel.focusCanvasAfterAction()
    } else if (curr?.shape === 'composite') {
      if (curr.currentMode === 'arc' && !curr.pendingArcEnd && edit.radius) {
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
            setPendingPreviewPointRef({ point: arcEnd, session: curr.session })
          } else {
            setPendingPreviewPointRef({ point: pt, session: curr.session })
          }
          setDimensionEdit(null)
          creationWorkflowPanel.focusCanvasAfterAction()
          return
        }
      }
      if (edit.arcStart && edit.arcEnd) {
        addPendingCompositePoint(pt)
        const arcEnd = edit.arcEnd
        setPendingPreviewPointRef({ point: arcEnd, session: curr.session })
        setDimensionEdit(null)
        creationWorkflowPanel.focusCanvasAfterAction()
      } else {
        addPendingCompositePoint(pt)
        setPendingPreviewPointRef({ point: pt, session: curr.session })
        setDimensionEdit(null)
        creationWorkflowPanel.focusCanvasAfterAction()
      }
    } else if (curr?.shape === 'slot' && 'points' in curr && curr.points.length === 1 && edit.arcStart && !edit.arcEnd) {
      const units = projectRef.current.meta.units
      const len = parseLengthInput(edit.length, units)
      const angleDeg = parseFloat(edit.angle)
      const slotWidth = parseLengthInput(edit.radius, units)
      if (len != null && len > 0 && !Number.isNaN(angleDeg) && slotWidth != null && slotWidth > 0) {
        const angleRad = angleDeg * Math.PI / 180
        const p1 = curr.points[0]
        const p2 = { x: p1.x + len * Math.cos(angleRad), y: p1.y + len * Math.sin(angleRad) }
        const axisX = p2.x - p1.x
        const axisY = p2.y - p1.y
        const axisLen = Math.hypot(axisX, axisY)
        const perpX = -axisY / axisLen
        const perpY = axisX / axisLen
        const perpPoint = { x: p1.x + (slotWidth / 2) * perpX, y: p1.y + (slotWidth / 2) * perpY }
        addPendingPolygonPoint(p2)
        placePendingSlotAt(perpPoint)
        setPendingPreviewPointRef(null)
        setDimensionEdit(null)
        creationWorkflowPanel.focusCanvasAfterAction()
      }
    } else if (curr?.shape === 'slot' && 'points' in curr && curr.points.length >= 2) {
      placePendingSlotAt(pt)
      setPendingPreviewPointRef(null)
      setDimensionEdit(null)
      creationWorkflowPanel.focusCanvasAfterAction()
    } else if (curr?.shape === 'ngon' && 'anchor' in curr && curr.anchor) {
      placePendingNgonAt(pt)
      setPendingPreviewPointRef(null)
      setDimensionEdit(null)
      creationWorkflowPanel.focusCanvasAfterAction()
    } else if (curr?.shape === 'gear' && curr.anchor) {
      setPendingGearRadiusAt(pt)
      setPendingPreviewPointRef({ point: pt, session: curr.session })
      setDimensionEdit(null)
    } else {
      placePendingAddAt(pt)
      setPendingPreviewPointRef(null)
      setDimensionEdit(null)
      creationWorkflowPanel.focusCanvasAfterAction()
    }
  }

  function cancelCreationDimensionEdit() {
    setDimensionEdit(null)
    creationWorkflowPanel.focusCanvasAfterAction()
  }

  function cancelCreationFromPanel() {
    cancelPendingAdd()
    setDimensionEdit(null)
    creationWorkflowPanel.focusCanvasAfterAction()
  }

  function undoFromCreationPanel() {
    const curr = pendingAddRef.current
    if (curr?.shape === 'polygon' || curr?.shape === 'spline') {
      undoPendingPolygonPoint()
    } else if (curr?.shape === 'composite') {
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

  function completeGearFromPanel() {
    const createdIds = completePendingGear()
    if (createdIds.length > 0) {
      setPendingPreviewPointRef(null)
      creationWorkflowPanel.focusCanvasAfterAction()
    }
  }

  function setCompositeModeFromPanel(mode: 'line' | 'arc' | 'spline') {
    setPendingCompositeMode(mode)
    creationWorkflowPanel.focusCanvasAfterAction()
  }

  return {
    creationPanelShape,
    creationPanelHasAnchor,
    creationPanelHasPoints,
    creationPanelHasStart,
    creationCanDimEdit,
    creationDimEditActive,
    placementPanelActive,
    creationWorkflowPanel,
    placementWorkflowPanel,
    triggerDimensionFromCreationPanel,
    commitCreationDimensionEdit,
    cancelCreationDimensionEdit,
    cancelCreationFromPanel,
    undoFromCreationPanel,
    finishOpenPathFromPanel,
    finishOpenCompositeFromPanel,
    completeGearFromPanel,
    setCompositeModeFromPanel,
  }
}
