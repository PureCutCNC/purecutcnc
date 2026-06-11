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

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { ReactNode } from 'react'
import { Icon } from '../Icon'
import { ImportGeometryDialog } from '../project/ImportGeometryDialog'
import { NewProjectDialog } from '../project/NewProjectDialog'
import { TextToolDialog } from '../project/TextToolDialog'
import { featureHasClosedGeometry } from '../../text'
import type { SnapMode, SnapSettings } from '../../sketch/snapping'
import type { CreationTarget, FeatureAlignment, FeatureDistribution, SketchEditTool } from '../../store/types'
import type { DimensionType } from '../../types/project'
import { useProjectStore } from '../../store/projectStore'
import type { TextToolConfig } from '../../text'
import { useFileActions } from '../../platform/useFileActions'

interface ToolbarActionButtonProps {
  icon: string
  label: string
  active?: boolean
  emphasized?: boolean
  disabled?: boolean
  tooltipSide?: 'bottom' | 'right'
  onClick: () => void
}

interface ToolbarProps {
  onZoomToModel: () => void
  onZoomWindow: () => void
  zoomWindowActive?: boolean
  onImportComplete?: () => void
  onExportModel: () => void
}

interface SnapToolbarProps {
  snapSettings: SnapSettings
  activeSnapMode?: SnapMode | null
  onToggleSnapEnabled: () => void
  onToggleSnapMode: (mode: SnapMode) => void
}

interface CreationToolbarProps {
  layout?: 'horizontal' | 'vertical'
}

const CREATION_SHAPE_OPTIONS = [
  { value: 'rect', icon: 'rect', noun: 'rectangle' },
  { value: 'circle', icon: 'circle', noun: 'circle' },
  { value: 'ellipse', icon: 'ellipse', noun: 'ellipse' },
  { value: 'polygon', icon: 'polygon', noun: 'polygon' },
  { value: 'spline', icon: 'spline', noun: 'spline' },
  { value: 'composite', icon: 'composite', noun: 'composite' },
  { value: 'text', icon: 'text', noun: 'text' },
] as const

type CreationShape = typeof CREATION_SHAPE_OPTIONS[number]['value']
type PopoverOpenMode = 'hover' | 'click'

const TOOLBAR_POPOVER_HOVER_OPEN_DELAY_MS = 320
const TOOLBAR_POPOVER_HOVER_CLOSE_DELAY_MS = 240

function ToolbarAction({
  label,
  tooltipSide = 'bottom',
  children,
}: {
  label: string
  tooltipSide?: 'bottom' | 'right'
  children: ReactNode
}) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const tooltipRef = useRef<HTMLSpanElement | null>(null)
  const [tooltipVisible, setTooltipVisible] = useState(false)
  const [tooltipCoords, setTooltipCoords] = useState<{ top: number; left: number } | null>(null)

  useLayoutEffect(() => {
    if (!tooltipVisible) {
      setTooltipCoords(null)
      return
    }

    function reposition() {
      const trigger = containerRef.current
      const tooltip = tooltipRef.current
      if (!trigger || !tooltip) {
        return
      }

      const triggerRect = trigger.getBoundingClientRect()
      const tooltipRect = tooltip.getBoundingClientRect()
      const margin = 8
      let top: number
      let left: number

      if (tooltipSide === 'right') {
        left = triggerRect.right + 8
        top = triggerRect.top + triggerRect.height / 2 - tooltipRect.height / 2
      } else {
        top = triggerRect.bottom + 8
        left = triggerRect.left + triggerRect.width / 2 - tooltipRect.width / 2
      }

      left = Math.max(margin, Math.min(left, window.innerWidth - tooltipRect.width - margin))
      top = Math.max(margin, Math.min(top, window.innerHeight - tooltipRect.height - margin))
      setTooltipCoords((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }))
    }

    reposition()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [label, tooltipSide, tooltipVisible])

  return (
    <div
      className="toolbar-action"
      ref={containerRef}
      onMouseEnter={() => setTooltipVisible(true)}
      onMouseLeave={() => setTooltipVisible(false)}
      onFocusCapture={() => setTooltipVisible(true)}
      onBlurCapture={(event) => {
        const nextTarget = event.relatedTarget
        if (!(nextTarget instanceof Node) || !event.currentTarget.contains(nextTarget)) {
          setTooltipVisible(false)
        }
      }}
    >
      {children}
      {tooltipVisible && typeof document !== 'undefined'
        ? createPortal(
            <span
              className={`toolbar-tooltip toolbar-tooltip--${tooltipSide} toolbar-tooltip--floating`}
              ref={tooltipRef}
              role="tooltip"
              style={{
                top: tooltipCoords?.top ?? -9999,
                left: tooltipCoords?.left ?? -9999,
                visibility: tooltipCoords ? 'visible' : 'hidden',
              }}
            >
              {label}
            </span>,
            document.body,
          )
        : null}
    </div>
  )
}

function ToolbarActionButton({
  icon,
  label,
  active = false,
  emphasized = false,
  disabled = false,
  tooltipSide = 'bottom',
  onClick,
}: ToolbarActionButtonProps) {
  return (
    <ToolbarAction label={label} tooltipSide={tooltipSide}>
      <button
        className={`toolbar-icon-btn ${active ? 'toolbar-icon-btn--active' : ''} ${emphasized ? 'toolbar-icon-btn--live' : ''}`}
        onClick={(event) => {
          onClick()
          event.currentTarget.blur()
        }}
        aria-label={label}
        type="button"
        disabled={disabled}
      >
        <Icon id={icon} />
      </button>
    </ToolbarAction>
  )
}

function useToolbarState(onZoomToModel: () => void, onImportComplete?: () => void) {
  void onImportComplete
  const fileActions = useFileActions()

  const {
    project,
    dirty,
    pendingAdd,
    history,
    setProjectName,
    undo,
    redo,
    startAddRectPlacement,
    startAddCirclePlacement,
    startAddEllipsePlacement,
    startAddPolygonPlacement,
    startAddSplinePlacement,
    startAddCompositePlacement,
    startAddTextPlacement,
    creationTarget,
    setCreationTarget,
    startMoveFeature,
    startCopyFeature,
    startResizeFeature,
    startRotateFeature,
    startMirrorFeature,
    startJoinSelectedFeatures,
    startCutSelectedFeatures,
    startOffsetSelectedFeatures,
    alignFeatures,
    distributeFeatures,
    startMoveBackdrop,
    startResizeBackdrop,
    startRotateBackdrop,
    deleteBackdrop,
    deleteFeatures,
    setSketchEditTool,
    beginConstraint,
    pendingConstraint,
    cancelPendingConstraint,
    cancelPendingAdd,
    pendingMove,
    pendingTransform,
    pendingOffset,
    pendingShapeAction,
    cancelPendingMove,
    cancelPendingTransform,
    cancelPendingOffset,
    cancelPendingShapeAction,
    selection,
    tapeMeasure,
    pendingDimension,
    startTapeMeasure,
    clearTapeMeasure,
    startDimensionTool,
    cancelPendingDimension,
    dimensionDeleteArmed,
    setDimensionDeleteArmed,
    setShowDimensions,
    selectedAnnotationId,
    deleteDimensionAnnotation,
  } = useProjectStore()

  const [editingName, setEditingName] = useState(false)
  const [nameVal, setNameVal] = useState(project.meta.name)
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [showTextDialog, setShowTextDialog] = useState(false)

  useEffect(() => {
    if (!editingName) {
      setNameVal(project.meta.name)
    }
  }, [editingName, project.meta.name])

  async function handleNewProject() {
    const ok = await fileActions.confirmDiscardIfDirty()
    if (ok) setShowNewProjectDialog(true)
  }

  async function handleSave() {
    await fileActions.save()
  }

  async function handleLoad() {
    await fileActions.open()
  }

  function handleImport() {
    setShowImportDialog(true)
  }

  function togglePlacement(shape: 'rect' | 'circle' | 'ellipse' | 'polygon' | 'spline' | 'composite', start: () => void) {
    if (pendingAdd?.shape === shape) {
      cancelPendingAdd()
      return
    }

    start()
  }

  function handleTextTool() {
    if (pendingAdd) {
      cancelPendingAdd()
    }
    setShowTextDialog(true)
  }

  function confirmTextTool(config: TextToolConfig) {
    startAddTextPlacement(config)
    setShowTextDialog(false)
  }

  function handleTapeMeasure() {
    if (tapeMeasure) {
      clearTapeMeasure()
      return
    }
    if (pendingAdd) cancelPendingAdd()
    startTapeMeasure()
  }

  function handleDimensionType(type: DimensionType) {
    if (pendingDimension?.type === type) {
      cancelPendingDimension()
      return
    }
    if (pendingAdd) cancelPendingAdd()
    startDimensionTool(type)
  }

  function handleToggleShowDimensions() {
    setShowDimensions(!project.meta.showDimensions)
  }

  function handleDeleteDimension() {
    if (pendingAdd) cancelPendingAdd()
    // If a dimension is already selected, just delete it — no need to arm the
    // pick-a-dimension mode for a second click.
    if (selectedAnnotationId) {
      deleteDimensionAnnotation(selectedAnnotationId)
      if (dimensionDeleteArmed) setDimensionDeleteArmed(false)
      return
    }
    setDimensionDeleteArmed(!dimensionDeleteArmed)
  }

  const selectedFeatureIds = selection.mode === 'feature' ? selection.selectedFeatureIds : []
  const primarySelectedFeatureId = selection.selectedFeatureId ?? selectedFeatureIds[0] ?? null
  const selectedFeatures = selectedFeatureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is NonNullable<typeof project.features[number]> => feature !== null)
  const hasSelectedFeatures = selectedFeatureIds.length > 0
  const hasSelectedBackdrop = selection.selectedNode?.type === 'backdrop' && !!project.backdrop
  const hasLockedSelectedFeatures = selectedFeatures.some((feature) => feature.locked)
  const hasClosedSelectedFeatures = selectedFeatures.length > 0 && selectedFeatures.every((feature) => featureHasClosedGeometry(feature))
  const hasOffsetEligibleSelectedFeatures =
    hasClosedSelectedFeatures && selectedFeatures.every((feature) => feature.kind !== 'text')
  const alignableFeatureCount = selectedFeatures.filter((feature) => !feature.locked).length
  const canAlignSelectedFeatures = alignableFeatureCount >= 2
  const canDistributeSelectedFeatures = alignableFeatureCount >= 3
  const featureSketchEditActive =
    selection.mode === 'sketch_edit'
    && selection.selectedNode?.type === 'feature'
    && !!selection.selectedFeatureId

  function handleFeatureMove() {
    if (!primarySelectedFeatureId) {
      return
    }

    if (pendingMove?.entityType === 'feature' && pendingMove.mode === 'move') {
      cancelPendingMove()
      return
    }

    startMoveFeature(primarySelectedFeatureId)
  }

  function handleFeatureCopy() {
    if (!primarySelectedFeatureId) {
      return
    }

    if (pendingMove?.entityType === 'feature' && pendingMove.mode === 'copy') {
      cancelPendingMove()
      return
    }

    startCopyFeature(primarySelectedFeatureId)
  }

  function handleFeatureResize() {
    if (!primarySelectedFeatureId) {
      return
    }

    if (pendingTransform?.mode === 'resize') {
      cancelPendingTransform()
      return
    }

    startResizeFeature(primarySelectedFeatureId)
  }

  function handleFeatureRotate() {
    if (!primarySelectedFeatureId) {
      return
    }

    if (pendingTransform?.mode === 'rotate') {
      cancelPendingTransform()
      return
    }

    startRotateFeature(primarySelectedFeatureId)
  }

  function handleFeatureMirror() {
    if (!primarySelectedFeatureId) {
      return
    }

    if (pendingTransform?.mode === 'mirror') {
      cancelPendingTransform()
      return
    }

    startMirrorFeature(primarySelectedFeatureId)
  }

  function handleDeleteSelectedFeatures() {
    if (!hasSelectedFeatures) {
      return
    }

    deleteFeatures(selectedFeatureIds)
  }

  function handleBackdropMove() {
    if (!project.backdrop) {
      return
    }

    if (pendingMove?.entityType === 'backdrop' && pendingMove.mode === 'move') {
      cancelPendingMove()
      return
    }

    startMoveBackdrop()
  }

  function handleBackdropResize() {
    if (!project.backdrop) {
      return
    }

    if (pendingTransform?.entityType === 'backdrop' && pendingTransform.mode === 'resize') {
      cancelPendingTransform()
      return
    }

    startResizeBackdrop()
  }

  function handleBackdropRotate() {
    if (!project.backdrop) {
      return
    }

    if (pendingTransform?.entityType === 'backdrop' && pendingTransform.mode === 'rotate') {
      cancelPendingTransform()
      return
    }

    startRotateBackdrop()
  }

  function handleBackdropDelete() {
    deleteBackdrop()
  }

  function handleJoinSelectedFeatures() {
    if (pendingShapeAction?.kind === 'join') {
      cancelPendingShapeAction()
      return
    }
    startJoinSelectedFeatures()
  }

  function handleCutSelectedFeatures() {
    if (pendingShapeAction?.kind === 'cut') {
      cancelPendingShapeAction()
      return
    }
    startCutSelectedFeatures()
  }

  function handleOffsetSelectedFeatures() {
    if (pendingOffset) {
      cancelPendingOffset()
      return
    }

    startOffsetSelectedFeatures()
  }

  function handleAlignSelectedFeatures(alignment: FeatureAlignment) {
    const eligibleIds = selectedFeatures
      .filter((feature) => !feature.locked)
      .map((feature) => feature.id)
    if (eligibleIds.length < 2) {
      return
    }
    alignFeatures(eligibleIds, alignment)
  }

  function handleDistributeSelectedFeatures(distribution: FeatureDistribution) {
    const eligibleIds = selectedFeatures
      .filter((feature) => !feature.locked)
      .map((feature) => feature.id)
    if (eligibleIds.length < 3) {
      return
    }
    distributeFeatures(eligibleIds, distribution)
  }

  function toggleSketchEditTool(tool: SketchEditTool) {
    if (!featureSketchEditActive) {
      return
    }
    setSketchEditTool(selection.sketchEditTool === tool ? null : tool)
  }

  return {
    project,
    dirty,
    pendingAdd,
    pendingMove,
    pendingTransform,
    pendingOffset,
    history,
    selection,
    editingName,
    nameVal,
    showNewProjectDialog,
    showImportDialog,
    showTextDialog,
    pendingShapeAction,
    hasSelectedFeatures,
    hasSelectedBackdrop,
    hasLockedSelectedFeatures,
    hasClosedSelectedFeatures,
    hasOffsetEligibleSelectedFeatures,
    canAlignSelectedFeatures,
    canDistributeSelectedFeatures,
    featureSketchEditActive,
    sketchEditTool: selection.sketchEditTool,
    setProjectName,
    setEditingName,
    setNameVal,
    setShowNewProjectDialog,
    setShowImportDialog,
    setShowTextDialog,
    handleNewProject,
    handleSave,
    handleLoad,
    handleImport,
    handleZoomToModel: onZoomToModel,
    handleUndo: undo,
    handleRedo: redo,
    handleRect: () => togglePlacement('rect', startAddRectPlacement),
    handleCircle: () => togglePlacement('circle', startAddCirclePlacement),
    handleEllipse: () => togglePlacement('ellipse', startAddEllipsePlacement),
    handlePolygon: () => togglePlacement('polygon', startAddPolygonPlacement),
    handleSpline: () => togglePlacement('spline', startAddSplinePlacement),
    handleComposite: () => togglePlacement('composite', startAddCompositePlacement),
    handleTextTool,
    tapeActive: tapeMeasure !== null,
    pendingDimensionType: pendingDimension?.type ?? null,
    dimensionDeleteArmed,
    showDimensions: project.meta.showDimensions,
    dimensionCount: project.annotations.length,
    handleTapeMeasure,
    handleDimensionType,
    handleDeleteDimension,
    handleToggleShowDimensions,
    creationTarget,
    setCreationTarget,
    confirmTextTool,
    handleFeatureMove,
    handleFeatureCopy,
    handleFeatureResize,
    handleFeatureRotate,
    handleFeatureMirror,
    handleDeleteSelectedFeatures,
    handleBackdropMove,
    handleBackdropResize,
    handleBackdropRotate,
    handleBackdropDelete,
    handleJoinSelectedFeatures,
    handleCutSelectedFeatures,
    handleOffsetSelectedFeatures,
    handleAlignSelectedFeatures,
    handleDistributeSelectedFeatures,
    handleSketchEditAddPoint: () => toggleSketchEditTool('add_point'),
    handleSketchEditDeletePoint: () => toggleSketchEditTool('delete_point'),
    handleSketchEditDeleteSegment: () => toggleSketchEditTool('delete_segment'),
    handleSketchEditDisconnect: () => toggleSketchEditTool('disconnect'),
    handleSketchEditFillet: () => toggleSketchEditTool('fillet'),
    handleFeatureConstraint: () => {
      if (pendingConstraint) {
        cancelPendingConstraint()
        return
      }
      const featureId =
        (selection.selectedNode?.type === 'feature' ? selection.selectedNode.featureId : null) ??
        selection.selectedFeatureId
      if (!featureId) return
      if (featureSketchEditActive) setSketchEditTool(null)
      beginConstraint(featureId)
    },
    constraintActive: !!pendingConstraint,
  }
}

function ProjectNameControl({
  projectName,
  dirty,
  editingName,
  nameVal,
  setNameVal,
  setEditingName,
  setProjectName,
}: {
  projectName: string
  dirty: boolean
  editingName: boolean
  nameVal: string
  setNameVal: (value: string) => void
  setEditingName: (value: boolean) => void
  setProjectName: (value: string) => void
}) {
  return (
    <div className="toolbar-project-block">
      <span className="toolbar-project-label">Project</span>
      {editingName ? (
        <input
          className="toolbar-name-input"
          value={nameVal}
          onChange={(event) => setNameVal(event.target.value)}
          onBlur={() => {
            setProjectName(nameVal.trim() || 'Untitled')
            setEditingName(false)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              setProjectName(nameVal.trim() || 'Untitled')
              setEditingName(false)
            }
            if (event.key === 'Escape') {
              setNameVal(projectName)
              setEditingName(false)
            }
          }}
          autoFocus
        />
      ) : (
        <button
          className="toolbar-project-name"
          onClick={() => {
            setNameVal(projectName)
            setEditingName(true)
          }}
          title="Rename project"
          type="button"
        >
          {projectName}
        </button>
      )}
      <span
        className={`toolbar-save-state ${dirty ? 'toolbar-save-state--dirty' : 'toolbar-save-state--saved'}`}
        aria-live="polite"
        title={dirty ? 'Project has unsaved changes' : 'Project is saved'}
      >
        {dirty ? 'Unsaved' : 'Saved'}
      </span>
    </div>
  )
}

function GlobalActions({
  historyLengthPast,
  historyLengthFuture,
  onNew,
  onOpen,
  onImport,
  onExportModel,
  onSave,
  onUndo,
  onRedo,
  onZoomToModel,
  onZoomWindow,
  zoomWindowActive,
  projectDirty,
}: {
  historyLengthPast: number
  historyLengthFuture: number
  onNew: () => void
  onOpen: () => void
  onImport: () => void
  onExportModel: () => void
  onSave: () => void
  onUndo: () => void
  onRedo: () => void
  onZoomToModel: () => void
  onZoomWindow: () => void
  zoomWindowActive: boolean
  projectDirty: boolean
}) {
  return (
    <>
      <div className="toolbar-group">
        <ToolbarActionButton icon="new" label="New project" onClick={onNew} />
        <ToolbarActionButton icon="open" label="Open project" onClick={onOpen} />
        <ToolbarActionButton icon="import" label="Import geometry" onClick={onImport} />
        <ToolbarActionButton icon="export" label="Export model" onClick={onExportModel} />
        <ToolbarActionButton
          icon="save"
          label={projectDirty ? 'Save project with unsaved changes' : 'Save project'}
          emphasized={projectDirty}
          onClick={onSave}
        />
      </div>
      <div className="toolbar-group">
        <ToolbarActionButton icon="undo" label="Undo" onClick={onUndo} disabled={historyLengthPast === 0} />
        <ToolbarActionButton icon="redo" label="Redo" onClick={onRedo} disabled={historyLengthFuture === 0} />
      </div>
      <div className="toolbar-group">
        <ToolbarActionButton icon="fit" label="Zoom to model" onClick={onZoomToModel} />
        <ToolbarActionButton
          icon="fit-window"
          label={zoomWindowActive ? 'Cancel zoom selected' : 'Zoom selected'}
          active={zoomWindowActive}
          onClick={onZoomWindow}
        />
      </div>
    </>
  )
}

function CreationActions({
  pendingShape,
  creationTarget,
  tooltipSide,
  onCreationTargetChange,
  onRect,
  onCircle,
  onEllipse,
  onPolygon,
  onSpline,
  onComposite,
  onText,
}: {
  pendingShape: string | null
  creationTarget: CreationTarget
  tooltipSide?: 'bottom' | 'right'
  onCreationTargetChange: (target: CreationTarget) => void
  onRect: () => void
  onCircle: () => void
  onEllipse: () => void
  onPolygon: () => void
  onSpline: () => void
  onComposite: () => void
  onText: () => void
}) {
  const [lastShape, setLastShape] = useState<CreationShape>('rect')
  const [drawerOpen, setDrawerOpen] = useState(false)
  const pickerRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const openModeRef = useRef<PopoverOpenMode | null>(null)
  const [drawerCoords, setDrawerCoords] = useState<{ top: number; left: number } | null>(null)
  const side = tooltipSide ?? 'bottom'
  const availableShapeOptions = creationTarget === 'region'
    ? CREATION_SHAPE_OPTIONS.filter((option) => option.value !== 'text')
    : CREATION_SHAPE_OPTIONS
  const lastShapeOption = availableShapeOptions.find((option) => option.value === lastShape) ?? availableShapeOptions[0]

  function clearDrawerTimers() {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  function runShapeTool(shape: CreationShape) {
    if (shape === 'rect') {
      onRect()
    } else if (shape === 'circle') {
      onCircle()
    } else if (shape === 'ellipse') {
      onEllipse()
    } else if (shape === 'polygon') {
      onPolygon()
    } else if (shape === 'spline') {
      onSpline()
    } else if (shape === 'composite') {
      onComposite()
    } else {
      onText()
    }
  }

  function selectShape(shape: CreationShape) {
    setLastShape(shape)
    openModeRef.current = null
    setDrawerOpen(false)
    runShapeTool(shape)
  }

  function scheduleDrawerOpen() {
    if (openModeRef.current === 'click') {
      return
    }
    clearDrawerTimers()
    openTimerRef.current = window.setTimeout(() => {
      openModeRef.current = 'hover'
      setDrawerOpen(true)
      openTimerRef.current = null
    }, TOOLBAR_POPOVER_HOVER_OPEN_DELAY_MS)
  }

  function scheduleDrawerClose() {
    if (openModeRef.current === 'click') {
      return
    }
    clearDrawerTimers()
    closeTimerRef.current = window.setTimeout(() => {
      openModeRef.current = null
      setDrawerOpen(false)
      closeTimerRef.current = null
    }, TOOLBAR_POPOVER_HOVER_CLOSE_DELAY_MS)
  }

  useLayoutEffect(() => {
    if (!drawerOpen) {
      return
    }
    function reposition() {
      const trigger = pickerRef.current
      const popover = popoverRef.current
      if (!trigger || !popover) {
        return
      }
      const t = trigger.getBoundingClientRect()
      const p = popover.getBoundingClientRect()
      const margin = 8
      let top: number
      let left: number
      if (side === 'right') {
        left = t.right + 6
        top = t.top + t.height / 2 - p.height / 2
      } else {
        top = t.bottom + 6
        left = t.left + t.width / 2 - p.width / 2
      }
      left = Math.max(margin, Math.min(left, window.innerWidth - p.width - margin))
      top = Math.max(margin, Math.min(top, window.innerHeight - p.height - margin))
      setDrawerCoords({ top, left })
    }
    reposition()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [drawerOpen, side])

  useEffect(() => {
    if (!drawerOpen) {
      return
    }
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (pickerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return
      }
      openModeRef.current = null
      setDrawerOpen(false)
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        openModeRef.current = null
        setDrawerOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [drawerOpen])

  useEffect(() => () => clearDrawerTimers(), [])

  function renderCreationTargetButton(target: CreationTarget, icon: string, label: string) {
    const active = creationTarget === target
    return (
      <ToolbarAction label={label} tooltipSide={tooltipSide}>
        <button
          type="button"
          className={[
            'toolbar-icon-btn',
            'toolbar-target-btn',
            target === 'region' ? 'toolbar-target-btn--region' : '',
            active ? 'toolbar-icon-btn--active toolbar-target-btn--active' : '',
          ].join(' ')}
          onClick={() => onCreationTargetChange(target)}
          title={label}
          aria-label={label}
          aria-pressed={active}
        >
          <Icon id={icon} />
        </button>
      </ToolbarAction>
    )
  }

  return (
    <div className={`toolbar-creation-block toolbar-creation-block--${creationTarget}`}>
      <div className="toolbar-target-toggle" role="group" aria-label="Creation target">
        {renderCreationTargetButton('feature', 'plus', 'Create features')}
        {renderCreationTargetButton('region', 'pocket', 'Create regions')}
      </div>
      <div
        className="toolbar-group toolbar-group--drawing toolbar-creation-picker"
        ref={pickerRef}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') {
            scheduleDrawerOpen()
          }
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') {
            scheduleDrawerClose()
          }
        }}
      >
        <ToolbarAction label={drawerOpen ? 'Close shape drawer' : `Choose ${creationTarget} shape`} tooltipSide={tooltipSide}>
          <button
            type="button"
            className={`toolbar-icon-btn toolbar-creation-picker__drawer-btn ${drawerOpen ? 'toolbar-icon-btn--active' : ''}`}
            onClick={(event) => {
              clearDrawerTimers()
              if (drawerOpen && openModeRef.current === 'click') {
                openModeRef.current = null
                setDrawerOpen(false)
              } else {
                openModeRef.current = 'click'
                setDrawerOpen(true)
              }
              event.currentTarget.blur()
            }}
            aria-label={drawerOpen ? 'Close shape drawer' : `Choose ${creationTarget} shape`}
            aria-haspopup="menu"
            aria-expanded={drawerOpen}
          >
            <Icon id="feature-drawer" />
          </button>
        </ToolbarAction>
        <ToolbarActionButton
          icon={lastShapeOption.icon}
          label={pendingShape === lastShapeOption.value ? `Cancel ${lastShapeOption.noun} tool` : `Add ${creationTarget} ${lastShapeOption.noun}`}
          active={pendingShape === lastShapeOption.value}
          tooltipSide={tooltipSide}
          onClick={() => runShapeTool(lastShapeOption.value)}
        />
        {drawerOpen
          ? createPortal(
              <div
                ref={popoverRef}
                className="toolbar-popover toolbar-popover--floating toolbar-creation-picker__drawer"
                style={{
                  position: 'fixed',
                  top: drawerCoords?.top ?? -9999,
                  left: drawerCoords?.left ?? -9999,
                  visibility: drawerCoords ? 'visible' : 'hidden',
                  gridTemplateColumns: `repeat(${availableShapeOptions.length}, auto)`,
                }}
                role="menu"
                onPointerEnter={(event) => {
                  if (event.pointerType === 'mouse') {
                    clearDrawerTimers()
                  }
                }}
                onPointerLeave={(event) => {
                  if (event.pointerType === 'mouse') {
                    scheduleDrawerClose()
                  }
                }}
              >
                {availableShapeOptions.map((option) => (
                  <ToolbarActionButton
                    key={option.value}
                    icon={option.icon}
                    label={`Add ${creationTarget} ${option.noun}`}
                    active={lastShapeOption.value === option.value}
                    tooltipSide="bottom"
                    onClick={() => {
                      selectShape(option.value)
                    }}
                  />
                ))}
              </div>,
              document.body,
            )
          : null}
      </div>
    </div>
  )
}

function FeatureEditActions({
  enabled,
  hasLockedSelection,
  hasClosedSelection,
  pendingMoveMode,
  pendingTransformMode,
  pendingOffset,
  tooltipSide,
  onCopy,
  onMove,
  onDelete,
  onResize,
  onRotate,
  onMirror,
  onOffset,
  onConstraint,
  constraintActive,
}: {
  enabled: boolean
  hasLockedSelection: boolean
  hasClosedSelection: boolean
  pendingMoveMode: 'move' | 'copy' | null
  pendingTransformMode: 'resize' | 'rotate' | 'mirror' | null
  pendingOffset: boolean
  tooltipSide?: 'bottom' | 'right'
  onCopy: () => void
  onMove: () => void
  onDelete: () => void
  onResize: () => void
  onRotate: () => void
  onMirror: () => void
  onOffset: () => void
  onConstraint: () => void
  constraintActive: boolean
}) {
  if (!enabled) return null

  return (
    <>
      <div className="toolbar-group">
        <ToolbarActionButton
          icon="copy"
          label={pendingMoveMode === 'copy' ? 'Cancel copy' : 'Copy selected features'}
          active={pendingMoveMode === 'copy'}
          tooltipSide={tooltipSide}
          onClick={onCopy}
        />
        <ToolbarActionButton
          icon="move"
          label={pendingMoveMode === 'move' ? 'Cancel move' : 'Move selected features'}
          active={pendingMoveMode === 'move'}
          disabled={hasLockedSelection}
          tooltipSide={tooltipSide}
          onClick={onMove}
        />
        <ToolbarActionButton
          icon="trash"
          label="Delete selected features"
          tooltipSide={tooltipSide}
          onClick={onDelete}
        />
        <ToolbarActionButton
          icon="resize"
          label={pendingTransformMode === 'resize' ? 'Cancel resize' : 'Resize selected features'}
          active={pendingTransformMode === 'resize'}
          disabled={hasLockedSelection}
          tooltipSide={tooltipSide}
          onClick={onResize}
        />
        <ToolbarActionButton
          icon="rotate"
          label={pendingTransformMode === 'rotate' ? 'Cancel rotate' : 'Rotate selected features'}
          active={pendingTransformMode === 'rotate'}
          disabled={hasLockedSelection}
          tooltipSide={tooltipSide}
          onClick={onRotate}
        />
        <ToolbarActionButton
          icon="mirror"
          label={pendingTransformMode === 'mirror' ? 'Cancel mirror' : 'Mirror selected features'}
          active={pendingTransformMode === 'mirror'}
          disabled={hasLockedSelection}
          tooltipSide={tooltipSide}
          onClick={onMirror}
        />
        <ToolbarActionButton
          icon="offset"
          label={pendingOffset ? 'Cancel offset' : 'Create offset feature'}
          active={pendingOffset}
          disabled={hasLockedSelection || !hasClosedSelection}
          tooltipSide={tooltipSide}
          onClick={onOffset}
        />
        <ToolbarActionButton
          icon="constraint"
          label={constraintActive ? 'Cancel constraint' : 'Add constraint'}
          active={constraintActive}
          disabled={hasLockedSelection}
          tooltipSide={tooltipSide}
          onClick={onConstraint}
        />
      </div>
    </>
  )
}

interface PopoverMenuOption<T extends string> {
  value: T
  icon: string
  label: string
}

function ToolbarPopoverMenu<T extends string>({
  triggerIcon,
  triggerLabelOpen,
  triggerLabelClosed,
  enabled,
  tooltipSide,
  columns,
  options,
  onSelect,
}: {
  triggerIcon: string
  triggerLabelOpen: string
  triggerLabelClosed: string
  enabled: boolean
  tooltipSide?: 'bottom' | 'right'
  columns: number
  options: PopoverMenuOption<T>[]
  onSelect: (value: T) => void
}) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement | null>(null)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const openTimerRef = useRef<number | null>(null)
  const closeTimerRef = useRef<number | null>(null)
  const openModeRef = useRef<PopoverOpenMode | null>(null)
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null)
  const effectiveOpen = open && enabled
  const side = tooltipSide ?? 'bottom'

  function clearHoverTimers() {
    if (openTimerRef.current !== null) {
      window.clearTimeout(openTimerRef.current)
      openTimerRef.current = null
    }
    if (closeTimerRef.current !== null) {
      window.clearTimeout(closeTimerRef.current)
      closeTimerRef.current = null
    }
  }

  function scheduleOpen() {
    if (!enabled) {
      return
    }
    if (openModeRef.current === 'click') {
      return
    }
    clearHoverTimers()
    openTimerRef.current = window.setTimeout(() => {
      openModeRef.current = 'hover'
      setOpen(true)
      openTimerRef.current = null
    }, TOOLBAR_POPOVER_HOVER_OPEN_DELAY_MS)
  }

  function scheduleClose() {
    if (openModeRef.current === 'click') {
      return
    }
    clearHoverTimers()
    closeTimerRef.current = window.setTimeout(() => {
      openModeRef.current = null
      setOpen(false)
      closeTimerRef.current = null
    }, TOOLBAR_POPOVER_HOVER_CLOSE_DELAY_MS)
  }

  // The popover is rendered in a portal on document.body (below) so the
  // scrollable left rail — whose overflow clips its absolutely-positioned
  // descendants — cannot cut it off. Position it from the trigger's bounding
  // rect, recomputing while it is open in case the rail scrolls or resizes.
  useLayoutEffect(() => {
    if (!effectiveOpen) {
      setCoords(null)
      return
    }
    function reposition() {
      const trigger = containerRef.current
      const popover = popoverRef.current
      if (!trigger || !popover) {
        return
      }
      const t = trigger.getBoundingClientRect()
      const p = popover.getBoundingClientRect()
      const margin = 8
      let top: number
      let left: number
      if (side === 'right') {
        left = t.right + 6
        top = t.top + t.height / 2 - p.height / 2
      } else {
        top = t.bottom + 6
        left = t.left + t.width / 2 - p.width / 2
      }
      left = Math.max(margin, Math.min(left, window.innerWidth - p.width - margin))
      top = Math.max(margin, Math.min(top, window.innerHeight - p.height - margin))
      setCoords({ top, left })
    }
    reposition()
    window.addEventListener('scroll', reposition, true)
    window.addEventListener('resize', reposition)
    return () => {
      window.removeEventListener('scroll', reposition, true)
      window.removeEventListener('resize', reposition)
    }
  }, [effectiveOpen, side])

  useEffect(() => {
    if (!effectiveOpen) {
      return
    }
    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (containerRef.current?.contains(target) || popoverRef.current?.contains(target)) {
        return
      }
      openModeRef.current = null
      setOpen(false)
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        openModeRef.current = null
        setOpen(false)
      }
    }
    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [effectiveOpen])

  useEffect(() => () => clearHoverTimers(), [])

  return (
    <div
      className="toolbar-group toolbar-popover-host"
      ref={containerRef}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') {
          scheduleOpen()
        }
      }}
      onPointerLeave={(event) => {
        if (event.pointerType === 'mouse') {
          scheduleClose()
        }
      }}
    >
      <ToolbarActionButton
        icon={triggerIcon}
        label={effectiveOpen ? triggerLabelOpen : triggerLabelClosed}
        active={effectiveOpen}
        disabled={!enabled}
        tooltipSide={tooltipSide}
        onClick={() => {
          clearHoverTimers()
          if (open && openModeRef.current === 'click') {
            openModeRef.current = null
            setOpen(false)
          } else {
            openModeRef.current = 'click'
            setOpen(true)
          }
        }}
      />
      {effectiveOpen
        ? createPortal(
            <div
              ref={popoverRef}
              className="toolbar-popover toolbar-popover--floating"
              style={{
                position: 'fixed',
                top: coords?.top ?? -9999,
                left: coords?.left ?? -9999,
                visibility: coords ? 'visible' : 'hidden',
                gridTemplateColumns: `repeat(${columns}, auto)`,
              }}
              role="menu"
              onPointerEnter={(event) => {
                if (event.pointerType === 'mouse') {
                  clearHoverTimers()
                }
              }}
              onPointerLeave={(event) => {
                if (event.pointerType === 'mouse') {
                  scheduleClose()
                }
              }}
            >
              {options.map((option) => (
                <ToolbarActionButton
                  key={option.value}
                  icon={option.icon}
                  label={option.label}
                  tooltipSide="bottom"
                  onClick={() => {
                    onSelect(option.value)
                    openModeRef.current = null
                    setOpen(false)
                  }}
                />
              ))}
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}

const ALIGNMENT_OPTIONS: PopoverMenuOption<FeatureAlignment>[] = [
  { value: 'left', icon: 'align-left', label: 'Align left' },
  { value: 'center_horizontal', icon: 'align-center-horizontal', label: 'Align center horizontally' },
  { value: 'right', icon: 'align-right', label: 'Align right' },
  { value: 'top', icon: 'align-top', label: 'Align top' },
  { value: 'center_vertical', icon: 'align-center-vertical', label: 'Align center vertically' },
  { value: 'bottom', icon: 'align-bottom', label: 'Align bottom' },
]

const DISTRIBUTION_OPTIONS: PopoverMenuOption<FeatureDistribution>[] = [
  { value: 'horizontal_gaps', icon: 'distribute-horizontal-gaps', label: 'Distribute horizontally (equal gaps)' },
  { value: 'horizontal_centers', icon: 'distribute-horizontal-centers', label: 'Distribute horizontally (equal centers)' },
  { value: 'vertical_gaps', icon: 'distribute-vertical-gaps', label: 'Distribute vertically (equal gaps)' },
  { value: 'vertical_centers', icon: 'distribute-vertical-centers', label: 'Distribute vertically (equal centers)' },
]

function AlignmentActions({
  enabled,
  tooltipSide,
  onAlign,
}: {
  enabled: boolean
  tooltipSide?: 'bottom' | 'right'
  onAlign: (alignment: FeatureAlignment) => void
}) {
  if (!enabled) return null

  return (
    <ToolbarPopoverMenu
      triggerIcon="align"
      triggerLabelOpen="Close alignment menu"
      triggerLabelClosed="Align selected features"
      enabled={enabled}
      tooltipSide={tooltipSide}
      columns={3}
      options={ALIGNMENT_OPTIONS}
      onSelect={onAlign}
    />
  )
}

function DistributionActions({
  enabled,
  tooltipSide,
  onDistribute,
}: {
  enabled: boolean
  tooltipSide?: 'bottom' | 'right'
  onDistribute: (distribution: FeatureDistribution) => void
}) {
  if (!enabled) return null

  return (
    <ToolbarPopoverMenu
      triggerIcon="distribute"
      triggerLabelOpen="Close distribute menu"
      triggerLabelClosed="Distribute selected features"
      enabled={enabled}
      tooltipSide={tooltipSide}
      columns={2}
      options={DISTRIBUTION_OPTIONS}
      onSelect={onDistribute}
    />
  )
}

function ShapeToolActions({
  pendingShapeAction,
  tooltipSide,
  onJoin,
  onCut,
}: {
  pendingShapeAction: 'join' | 'cut' | null
  tooltipSide?: 'bottom' | 'right'
  onJoin: () => void
  onCut: () => void
}) {
  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="merge"
        label={pendingShapeAction === 'join' ? 'Cancel join' : 'Join closed features'}
        active={pendingShapeAction === 'join'}
        tooltipSide={tooltipSide}
        onClick={onJoin}
      />
      <ToolbarActionButton
        icon="cut"
        label={pendingShapeAction === 'cut' ? 'Cancel cut' : 'Cut features'}
        active={pendingShapeAction === 'cut'}
        tooltipSide={tooltipSide}
        onClick={onCut}
      />
    </div>
  )
}

function SketchEditActions({
  enabled,
  activeTool,
  tooltipSide,
  onAddPoint,
  onDeletePoint,
  onDeleteSegment,
  onDisconnect,
  onFillet,
}: {
  enabled: boolean
  activeTool: SketchEditTool | null
  tooltipSide?: 'bottom' | 'right'
  onAddPoint: () => void
  onDeletePoint: () => void
  onDeleteSegment: () => void
  onDisconnect: () => void
  onFillet: () => void
}) {
  if (!enabled) return null

  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="point-add"
        label={activeTool === 'add_point' ? 'Cancel add point' : 'Add point'}
        active={activeTool === 'add_point'}
        tooltipSide={tooltipSide}
        onClick={onAddPoint}
      />
      <ToolbarActionButton
        icon="point-delete"
        label={activeTool === 'delete_point' ? 'Cancel delete point' : 'Delete point'}
        active={activeTool === 'delete_point'}
        tooltipSide={tooltipSide}
        onClick={onDeletePoint}
      />
      <ToolbarActionButton
        icon="segment-delete"
        label={activeTool === 'delete_segment' ? 'Cancel delete segment' : 'Delete segment'}
        active={activeTool === 'delete_segment'}
        tooltipSide={tooltipSide}
        onClick={onDeleteSegment}
      />
      <ToolbarActionButton
        icon="disconnect"
        label={activeTool === 'disconnect' ? 'Cancel disconnect' : 'Disconnect point'}
        active={activeTool === 'disconnect'}
        tooltipSide={tooltipSide}
        onClick={onDisconnect}
      />
      <ToolbarActionButton
        icon="fillet"
        label={activeTool === 'fillet' ? 'Cancel fillet' : 'Round corner / fillet'}
        active={activeTool === 'fillet'}
        tooltipSide={tooltipSide}
        onClick={onFillet}
      />
    </div>
  )
}

function BackdropEditActions({
  enabled,
  pendingMoveMode,
  pendingTransformMode,
  tooltipSide,
  onMove,
  onDelete,
  onResize,
  onRotate,
}: {
  enabled: boolean
  pendingMoveMode: 'move' | null
  pendingTransformMode: 'resize' | 'rotate' | null
  tooltipSide?: 'bottom' | 'right'
  onMove: () => void
  onDelete: () => void
  onResize: () => void
  onRotate: () => void
}) {
  if (!enabled) return null

  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="move"
        label={pendingMoveMode === 'move' ? 'Cancel move backdrop' : 'Move backdrop'}
        active={pendingMoveMode === 'move'}
        tooltipSide={tooltipSide}
        onClick={onMove}
      />
      <ToolbarActionButton
        icon="trash"
        label="Delete backdrop"
        tooltipSide={tooltipSide}
        onClick={onDelete}
      />
      <ToolbarActionButton
        icon="resize"
        label={pendingTransformMode === 'resize' ? 'Cancel resize backdrop' : 'Resize backdrop'}
        active={pendingTransformMode === 'resize'}
        tooltipSide={tooltipSide}
        onClick={onResize}
      />
      <ToolbarActionButton
        icon="rotate"
        label={pendingTransformMode === 'rotate' ? 'Cancel rotate backdrop' : 'Rotate backdrop'}
        active={pendingTransformMode === 'rotate'}
        tooltipSide={tooltipSide}
        onClick={onRotate}
      />
    </div>
  )
}

function SnapActions({
  snapSettings,
  activeSnapMode,
  tooltipSide,
  onToggleSnapEnabled,
  onToggleSnapMode,
}: SnapToolbarProps & {
  tooltipSide?: 'bottom' | 'right'
}) {
  const hasMode = (mode: SnapMode) => snapSettings.modes.includes(mode)

  return (
    <>
      <div className="toolbar-group">
        <ToolbarActionButton
          icon="snap"
          label={snapSettings.enabled ? 'Disable snapping' : 'Enable snapping'}
          active={snapSettings.enabled}
          tooltipSide={tooltipSide}
          onClick={onToggleSnapEnabled}
        />
        <ToolbarActionButton
          icon="snap-grid"
          label="Snap to grid"
          active={snapSettings.enabled && hasMode('grid')}
          emphasized={snapSettings.enabled && activeSnapMode === 'grid'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('grid')}
        />
        <ToolbarActionButton
          icon="snap-point"
          label="Snap to point"
          active={snapSettings.enabled && hasMode('point')}
          emphasized={snapSettings.enabled && activeSnapMode === 'point'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('point')}
        />
        <ToolbarActionButton
          icon="snap-line"
          label="Snap to line"
          active={snapSettings.enabled && hasMode('line')}
          emphasized={snapSettings.enabled && activeSnapMode === 'line'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('line')}
        />
        <ToolbarActionButton
          icon="snap-midpoint"
          label="Snap to midpoint"
          active={snapSettings.enabled && hasMode('midpoint')}
          emphasized={snapSettings.enabled && activeSnapMode === 'midpoint'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('midpoint')}
        />
        <ToolbarActionButton
          icon="snap-center"
          label="Snap to center"
          active={snapSettings.enabled && hasMode('center')}
          emphasized={snapSettings.enabled && activeSnapMode === 'center'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('center')}
        />
        <ToolbarActionButton
          icon="snap-perpendicular"
          label="Snap perpendicular"
          active={snapSettings.enabled && hasMode('perpendicular')}
          emphasized={snapSettings.enabled && activeSnapMode === 'perpendicular'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('perpendicular')}
        />
      </div>
    </>
  )
}

const DIMENSION_TYPE_OPTIONS: PopoverMenuOption<DimensionType>[] = [
  { value: 'aligned', icon: 'dim-aligned', label: 'Aligned dimension' },
  { value: 'horizontal', icon: 'dim-horizontal', label: 'Horizontal dimension' },
  { value: 'vertical', icon: 'dim-vertical', label: 'Vertical dimension' },
  { value: 'radius', icon: 'dim-radius', label: 'Radius dimension' },
  { value: 'diameter', icon: 'dim-diameter', label: 'Diameter dimension' },
  { value: 'angle', icon: 'dim-angle', label: 'Angle dimension' },
]

function MeasureActions({
  tapeActive,
  pendingDimensionType,
  dimensionDeleteArmed,
  showDimensions,
  dimensionCount,
  tooltipSide,
  onTapeMeasure,
  onDimensionType,
  onDeleteDimension,
  onToggleShowDimensions,
}: {
  tapeActive: boolean
  pendingDimensionType: DimensionType | null
  dimensionDeleteArmed: boolean
  showDimensions: boolean
  dimensionCount: number
  tooltipSide?: 'bottom' | 'right'
  onTapeMeasure: () => void
  onDimensionType: (type: DimensionType) => void
  onDeleteDimension: () => void
  onToggleShowDimensions: () => void
}) {
  // Reflect a pending dimension placement in the popover trigger so the user
  // can see which type is in progress without expanding the menu.
  const activeDimOption = pendingDimensionType
    ? DIMENSION_TYPE_OPTIONS.find((option) => option.value === pendingDimensionType) ?? null
    : null
  const triggerIcon = activeDimOption?.icon ?? 'measure'
  const triggerLabelClosed = activeDimOption
    ? `Cancel ${activeDimOption.label.toLowerCase()}`
    : 'Add dimension'
  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="tape-measure"
        label={tapeActive ? 'Tape measure (on)' : 'Tape measure'}
        active={tapeActive}
        tooltipSide={tooltipSide}
        onClick={onTapeMeasure}
      />
      <ToolbarPopoverMenu
        triggerIcon={triggerIcon}
        triggerLabelOpen="Close dimension menu"
        triggerLabelClosed={triggerLabelClosed}
        enabled
        tooltipSide={tooltipSide}
        columns={3}
        options={DIMENSION_TYPE_OPTIONS}
        onSelect={onDimensionType}
      />
      <ToolbarActionButton
        icon="trash"
        label={dimensionDeleteArmed ? 'Delete dimension (click one)' : 'Delete dimension'}
        active={dimensionDeleteArmed}
        disabled={dimensionCount === 0}
        tooltipSide={tooltipSide}
        onClick={onDeleteDimension}
      />
      <ToolbarActionButton
        icon={showDimensions ? 'eye' : 'eye-off'}
        label={dimensionCount === 0
          ? 'Show/hide dimensions'
          : showDimensions ? `Hide dimensions (${dimensionCount})` : `Show dimensions (${dimensionCount})`}
        active={showDimensions}
        tooltipSide={tooltipSide}
        onClick={onToggleShowDimensions}
      />
    </div>
  )
}

function ToolbarDialog({
  showNewProjectDialog,
  showImportDialog,
  showTextDialog,
  onCloseNewProject,
  onCloseImport,
  onCloseText,
  onConfirmText,
  onImportComplete,
}: {
  showNewProjectDialog: boolean
  showImportDialog: boolean
  showTextDialog: boolean
  onCloseNewProject: () => void
  onCloseImport: () => void
  onCloseText: () => void
  onConfirmText: (config: TextToolConfig) => void
  onImportComplete?: () => void
}) {
  const dialogs = (
    <>
      {showNewProjectDialog ? <NewProjectDialog onClose={onCloseNewProject} /> : null}
      {showImportDialog ? <ImportGeometryDialog onClose={onCloseImport} onImportComplete={onImportComplete} /> : null}
      {showTextDialog ? <TextToolDialog onClose={onCloseText} onConfirm={onConfirmText} /> : null}
    </>
  )

  if (typeof document === 'undefined') {
    return dialogs
  }

  return createPortal(dialogs, document.body)
}

export function GlobalToolbar({
  onZoomToModel,
  onZoomWindow,
  zoomWindowActive = false,
  onImportComplete,
  onExportModel,
  snapSettings,
  activeSnapMode,
  onToggleSnapEnabled,
  onToggleSnapMode,
}: ToolbarProps & SnapToolbarProps) {
  const toolbar = useToolbarState(onZoomToModel, onImportComplete)

  return (
    <>
      <div className="toolbar toolbar--global">
        <ProjectNameControl
          projectName={toolbar.project.meta.name}
          dirty={toolbar.dirty}
          editingName={toolbar.editingName}
          nameVal={toolbar.nameVal}
          setNameVal={toolbar.setNameVal}
          setEditingName={toolbar.setEditingName}
          setProjectName={toolbar.setProjectName}
        />
        <GlobalActions
          historyLengthPast={toolbar.history.past.length}
          historyLengthFuture={toolbar.history.future.length}
          onNew={toolbar.handleNewProject}
          onOpen={toolbar.handleLoad}
          onImport={toolbar.handleImport}
          onExportModel={onExportModel}
          onSave={toolbar.handleSave}
          onUndo={toolbar.handleUndo}
          onRedo={toolbar.handleRedo}
          onZoomToModel={toolbar.handleZoomToModel}
          onZoomWindow={onZoomWindow}
          zoomWindowActive={zoomWindowActive}
          projectDirty={toolbar.dirty}
        />
        <SnapActions
          snapSettings={snapSettings}
          activeSnapMode={activeSnapMode}
          onToggleSnapEnabled={onToggleSnapEnabled}
          onToggleSnapMode={onToggleSnapMode}
        />
        <MeasureActions
          tapeActive={toolbar.tapeActive}
          pendingDimensionType={toolbar.pendingDimensionType}
          dimensionDeleteArmed={toolbar.dimensionDeleteArmed}
          showDimensions={toolbar.showDimensions}
          dimensionCount={toolbar.dimensionCount}
          onTapeMeasure={toolbar.handleTapeMeasure}
          onDimensionType={toolbar.handleDimensionType}
          onDeleteDimension={toolbar.handleDeleteDimension}
          onToggleShowDimensions={toolbar.handleToggleShowDimensions}
        />
      </div>
      <ToolbarDialog
        showNewProjectDialog={toolbar.showNewProjectDialog}
        showImportDialog={toolbar.showImportDialog}
        showTextDialog={toolbar.showTextDialog}
        onCloseNewProject={() => {
          toolbar.setNameVal(useProjectStore.getState().project.meta.name)
          toolbar.setEditingName(false)
          toolbar.setShowNewProjectDialog(false)
        }}
        onCloseImport={() => toolbar.setShowImportDialog(false)}
        onCloseText={() => toolbar.setShowTextDialog(false)}
        onConfirmText={toolbar.confirmTextTool}
        onImportComplete={onImportComplete}
      />
    </>
  )
}

export function CreationToolbar({
  onZoomToModel,
  onImportComplete,
  layout = 'horizontal',
}: Pick<ToolbarProps, 'onZoomToModel' | 'onImportComplete'> & CreationToolbarProps) {
  const toolbar = useToolbarState(onZoomToModel, onImportComplete)

  return (
    <>
      <div className={`toolbar toolbar--creation toolbar--${layout}`}>
        <CreationActions
          pendingShape={toolbar.pendingAdd?.shape ?? null}
          creationTarget={toolbar.creationTarget}
          tooltipSide={layout === 'vertical' ? 'right' : 'bottom'}
          onCreationTargetChange={toolbar.setCreationTarget}
          onRect={toolbar.handleRect}
          onCircle={toolbar.handleCircle}
          onEllipse={toolbar.handleEllipse}
          onPolygon={toolbar.handlePolygon}
          onSpline={toolbar.handleSpline}
          onComposite={toolbar.handleComposite}
          onText={toolbar.handleTextTool}
        />
        <ShapeToolActions
          pendingShapeAction={toolbar.pendingShapeAction?.kind ?? null}
          tooltipSide={layout === 'vertical' ? 'right' : 'bottom'}
          onJoin={toolbar.handleJoinSelectedFeatures}
          onCut={toolbar.handleCutSelectedFeatures}
        />
        <FeatureEditActions
          enabled={toolbar.hasSelectedFeatures}
          hasLockedSelection={toolbar.hasLockedSelectedFeatures}
          hasClosedSelection={toolbar.hasOffsetEligibleSelectedFeatures}
          pendingMoveMode={toolbar.pendingMove?.entityType === 'feature' ? toolbar.pendingMove.mode : null}
          pendingTransformMode={toolbar.pendingTransform?.entityType === 'feature' ? toolbar.pendingTransform.mode : null}
          pendingOffset={!!toolbar.pendingOffset}
          tooltipSide={layout === 'vertical' ? 'right' : 'bottom'}
          onCopy={toolbar.handleFeatureCopy}
          onMove={toolbar.handleFeatureMove}
          onDelete={toolbar.handleDeleteSelectedFeatures}
          onResize={toolbar.handleFeatureResize}
          onRotate={toolbar.handleFeatureRotate}
          onMirror={toolbar.handleFeatureMirror}
          onOffset={toolbar.handleOffsetSelectedFeatures}
          onConstraint={toolbar.handleFeatureConstraint}
          constraintActive={toolbar.constraintActive}
        />
        <AlignmentActions
          enabled={toolbar.canAlignSelectedFeatures}
          tooltipSide={layout === 'vertical' ? 'right' : 'bottom'}
          onAlign={toolbar.handleAlignSelectedFeatures}
        />
        <DistributionActions
          enabled={toolbar.canDistributeSelectedFeatures}
          tooltipSide={layout === 'vertical' ? 'right' : 'bottom'}
          onDistribute={toolbar.handleDistributeSelectedFeatures}
        />
        <SketchEditActions
          enabled={toolbar.featureSketchEditActive}
          activeTool={toolbar.sketchEditTool}
          tooltipSide={layout === 'vertical' ? 'right' : 'bottom'}
          onAddPoint={toolbar.handleSketchEditAddPoint}
          onDeletePoint={toolbar.handleSketchEditDeletePoint}
          onDeleteSegment={toolbar.handleSketchEditDeleteSegment}
          onDisconnect={toolbar.handleSketchEditDisconnect}
          onFillet={toolbar.handleSketchEditFillet}
        />
        <BackdropEditActions
          enabled={toolbar.hasSelectedBackdrop}
          pendingMoveMode={toolbar.pendingMove?.entityType === 'backdrop' && toolbar.pendingMove.mode === 'move' ? 'move' : null}
          pendingTransformMode={toolbar.pendingTransform?.entityType === 'backdrop' && toolbar.pendingTransform.mode !== 'mirror' ? toolbar.pendingTransform.mode : null}
          tooltipSide={layout === 'vertical' ? 'right' : 'bottom'}
          onMove={toolbar.handleBackdropMove}
          onDelete={toolbar.handleBackdropDelete}
          onResize={toolbar.handleBackdropResize}
          onRotate={toolbar.handleBackdropRotate}
        />
      </div>
      <ToolbarDialog
        showNewProjectDialog={toolbar.showNewProjectDialog}
        showImportDialog={toolbar.showImportDialog}
        showTextDialog={toolbar.showTextDialog}
        onCloseNewProject={() => {
          toolbar.setNameVal(useProjectStore.getState().project.meta.name)
          toolbar.setEditingName(false)
          toolbar.setShowNewProjectDialog(false)
        }}
        onCloseImport={() => toolbar.setShowImportDialog(false)}
        onCloseText={() => toolbar.setShowTextDialog(false)}
        onConfirmText={toolbar.confirmTextTool}
        onImportComplete={onImportComplete}
      />
    </>
  )
}

export function Toolbar({
  onZoomToModel,
  onZoomWindow,
  zoomWindowActive = false,
  onImportComplete,
  onExportModel,
  snapSettings,
  activeSnapMode,
  onToggleSnapEnabled,
  onToggleSnapMode,
}: ToolbarProps & SnapToolbarProps) {
  const toolbar = useToolbarState(onZoomToModel, onImportComplete)

  return (
    <>
      <div className="toolbar toolbar--combined">
        <ProjectNameControl
          projectName={toolbar.project.meta.name}
          dirty={toolbar.dirty}
          editingName={toolbar.editingName}
          nameVal={toolbar.nameVal}
          setNameVal={toolbar.setNameVal}
          setEditingName={toolbar.setEditingName}
          setProjectName={toolbar.setProjectName}
        />
        <GlobalActions
          historyLengthPast={toolbar.history.past.length}
          historyLengthFuture={toolbar.history.future.length}
          onNew={toolbar.handleNewProject}
          onOpen={toolbar.handleLoad}
          onImport={toolbar.handleImport}
          onExportModel={onExportModel}
          onSave={toolbar.handleSave}
          onUndo={toolbar.handleUndo}
          onRedo={toolbar.handleRedo}
          onZoomToModel={toolbar.handleZoomToModel}
          onZoomWindow={onZoomWindow}
          zoomWindowActive={zoomWindowActive}
          projectDirty={toolbar.dirty}
        />
        <SnapActions
          snapSettings={snapSettings}
          activeSnapMode={activeSnapMode}
          onToggleSnapEnabled={onToggleSnapEnabled}
          onToggleSnapMode={onToggleSnapMode}
        />
        <MeasureActions
          tapeActive={toolbar.tapeActive}
          pendingDimensionType={toolbar.pendingDimensionType}
          dimensionDeleteArmed={toolbar.dimensionDeleteArmed}
          showDimensions={toolbar.showDimensions}
          dimensionCount={toolbar.dimensionCount}
          onTapeMeasure={toolbar.handleTapeMeasure}
          onDimensionType={toolbar.handleDimensionType}
          onDeleteDimension={toolbar.handleDeleteDimension}
          onToggleShowDimensions={toolbar.handleToggleShowDimensions}
        />
        <CreationActions
          pendingShape={toolbar.pendingAdd?.shape ?? null}
          creationTarget={toolbar.creationTarget}
          onCreationTargetChange={toolbar.setCreationTarget}
          onRect={toolbar.handleRect}
          onCircle={toolbar.handleCircle}
          onEllipse={toolbar.handleEllipse}
          onPolygon={toolbar.handlePolygon}
          onSpline={toolbar.handleSpline}
          onComposite={toolbar.handleComposite}
          onText={toolbar.handleTextTool}
        />
        <ShapeToolActions
          pendingShapeAction={toolbar.pendingShapeAction?.kind ?? null}
          onJoin={toolbar.handleJoinSelectedFeatures}
          onCut={toolbar.handleCutSelectedFeatures}
        />
        <FeatureEditActions
          enabled={toolbar.hasSelectedFeatures}
          hasLockedSelection={toolbar.hasLockedSelectedFeatures}
          hasClosedSelection={toolbar.hasOffsetEligibleSelectedFeatures}
          pendingMoveMode={toolbar.pendingMove?.entityType === 'feature' ? toolbar.pendingMove.mode : null}
          pendingTransformMode={toolbar.pendingTransform?.entityType === 'feature' ? toolbar.pendingTransform.mode : null}
          pendingOffset={!!toolbar.pendingOffset}
          onCopy={toolbar.handleFeatureCopy}
          onMove={toolbar.handleFeatureMove}
          onDelete={toolbar.handleDeleteSelectedFeatures}
          onResize={toolbar.handleFeatureResize}
          onRotate={toolbar.handleFeatureRotate}
          onMirror={toolbar.handleFeatureMirror}
          onOffset={toolbar.handleOffsetSelectedFeatures}
          onConstraint={toolbar.handleFeatureConstraint}
          constraintActive={toolbar.constraintActive}
        />
        <AlignmentActions
          enabled={toolbar.canAlignSelectedFeatures}
          onAlign={toolbar.handleAlignSelectedFeatures}
        />
        <DistributionActions
          enabled={toolbar.canDistributeSelectedFeatures}
          onDistribute={toolbar.handleDistributeSelectedFeatures}
        />
        <SketchEditActions
          enabled={toolbar.featureSketchEditActive}
          activeTool={toolbar.sketchEditTool}
          onAddPoint={toolbar.handleSketchEditAddPoint}
          onDeletePoint={toolbar.handleSketchEditDeletePoint}
          onDeleteSegment={toolbar.handleSketchEditDeleteSegment}
          onDisconnect={toolbar.handleSketchEditDisconnect}
          onFillet={toolbar.handleSketchEditFillet}
        />
        <BackdropEditActions
          enabled={toolbar.hasSelectedBackdrop}
          pendingMoveMode={toolbar.pendingMove?.entityType === 'backdrop' && toolbar.pendingMove.mode === 'move' ? 'move' : null}
          pendingTransformMode={toolbar.pendingTransform?.entityType === 'backdrop' && toolbar.pendingTransform.mode !== 'mirror' ? toolbar.pendingTransform.mode : null}
          onMove={toolbar.handleBackdropMove}
          onDelete={toolbar.handleBackdropDelete}
          onResize={toolbar.handleBackdropResize}
          onRotate={toolbar.handleBackdropRotate}
        />
      </div>
      <ToolbarDialog
        showNewProjectDialog={toolbar.showNewProjectDialog}
        showImportDialog={toolbar.showImportDialog}
        showTextDialog={toolbar.showTextDialog}
        onCloseNewProject={() => {
          toolbar.setNameVal(useProjectStore.getState().project.meta.name)
          toolbar.setEditingName(false)
          toolbar.setShowNewProjectDialog(false)
        }}
        onCloseImport={() => toolbar.setShowImportDialog(false)}
        onCloseText={() => toolbar.setShowTextDialog(false)}
        onConfirmText={toolbar.confirmTextTool}
        onImportComplete={onImportComplete}
      />
    </>
  )
}

export function SnapToolbar({
  snapSettings,
  activeSnapMode,
  onToggleSnapEnabled,
  onToggleSnapMode,
}: SnapToolbarProps) {
  return (
    <div className="toolbar toolbar--snap">
      <SnapActions
        snapSettings={snapSettings}
        activeSnapMode={activeSnapMode}
        onToggleSnapEnabled={onToggleSnapEnabled}
        onToggleSnapMode={onToggleSnapMode}
      />
    </div>
  )
}
