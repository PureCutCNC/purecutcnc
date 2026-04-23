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

import { useEffect, useRef, useState } from 'react'
import { Icon } from '../Icon'
import { ImportGeometryDialog } from '../project/ImportGeometryDialog'
import { NewProjectDialog } from '../project/NewProjectDialog'
import { TextToolDialog } from '../project/TextToolDialog'
import { featureHasClosedGeometry } from '../../text'
import type { SnapMode, SnapSettings } from '../../sketch/snapping'
import type { FeatureAlignment, FeatureDistribution, SketchEditTool } from '../../store/types'
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
    <div className="toolbar-action">
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
        <Icon id={icon} size={18} />
      </button>
      <span className={`toolbar-tooltip toolbar-tooltip--${tooltipSide}`} role="tooltip">
        {label}
      </span>
    </div>
  )
}

function useToolbarState(onZoomToModel: () => void, onImportComplete?: () => void) {
  void onImportComplete
  const fileActions = useFileActions()

  const {
    project,
    pendingAdd,
    history,
    setProjectName,
    undo,
    redo,
    startAddRectPlacement,
    startAddCirclePlacement,
    startAddPolygonPlacement,
    startAddSplinePlacement,
    startAddCompositePlacement,
    startAddTextPlacement,
    startMoveFeature,
    startCopyFeature,
    startResizeFeature,
    startRotateFeature,
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

  function togglePlacement(shape: 'rect' | 'circle' | 'polygon' | 'spline' | 'composite', start: () => void) {
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
    handlePolygon: () => togglePlacement('polygon', startAddPolygonPlacement),
    handleSpline: () => togglePlacement('spline', startAddSplinePlacement),
    handleComposite: () => togglePlacement('composite', startAddCompositePlacement),
    handleTextTool,
    confirmTextTool,
    handleFeatureMove,
    handleFeatureCopy,
    handleFeatureResize,
    handleFeatureRotate,
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
  editingName,
  nameVal,
  setNameVal,
  setEditingName,
  setProjectName,
}: {
  projectName: string
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
    </div>
  )
}

function GlobalActions({
  historyLengthPast,
  historyLengthFuture,
  onNew,
  onOpen,
  onImport,
  onSave,
  onUndo,
  onRedo,
  onZoomToModel,
  onZoomWindow,
  zoomWindowActive,
}: {
  historyLengthPast: number
  historyLengthFuture: number
  onNew: () => void
  onOpen: () => void
  onImport: () => void
  onSave: () => void
  onUndo: () => void
  onRedo: () => void
  onZoomToModel: () => void
  onZoomWindow: () => void
  zoomWindowActive: boolean
}) {
  return (
    <>
      <div className="toolbar-group">
        <ToolbarActionButton icon="new" label="New project" onClick={onNew} />
        <ToolbarActionButton icon="open" label="Open project" onClick={onOpen} />
        <ToolbarActionButton icon="import" label="Import geometry" onClick={onImport} />
        <ToolbarActionButton icon="save" label="Save project" onClick={onSave} />
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
  tooltipSide,
  onRect,
  onCircle,
  onPolygon,
  onSpline,
  onComposite,
  onText,
}: {
  pendingShape: string | null
  tooltipSide?: 'bottom' | 'right'
  onRect: () => void
  onCircle: () => void
  onPolygon: () => void
  onSpline: () => void
  onComposite: () => void
  onText: () => void
}) {
  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="rect"
        label={pendingShape === 'rect' ? 'Cancel rectangle tool' : 'Add rectangle'}
        active={pendingShape === 'rect'}
        tooltipSide={tooltipSide}
        onClick={onRect}
      />
      <ToolbarActionButton
        icon="circle"
        label={pendingShape === 'circle' ? 'Cancel circle tool' : 'Add circle'}
        active={pendingShape === 'circle'}
        tooltipSide={tooltipSide}
        onClick={onCircle}
      />
      <ToolbarActionButton
        icon="polygon"
        label={pendingShape === 'polygon' ? 'Cancel polygon tool' : 'Add polygon'}
        active={pendingShape === 'polygon'}
        tooltipSide={tooltipSide}
        onClick={onPolygon}
      />
      <ToolbarActionButton
        icon="spline"
        label={pendingShape === 'spline' ? 'Cancel spline tool' : 'Add spline'}
        active={pendingShape === 'spline'}
        tooltipSide={tooltipSide}
        onClick={onSpline}
      />
      <ToolbarActionButton
        icon="composite"
        label={pendingShape === 'composite' ? 'Cancel composite tool' : 'Add composite'}
        active={pendingShape === 'composite'}
        tooltipSide={tooltipSide}
        onClick={onComposite}
      />
      <ToolbarActionButton
        icon="text"
        label={pendingShape === 'text' ? 'Cancel text tool' : 'Add text'}
        active={pendingShape === 'text'}
        tooltipSide={tooltipSide}
        onClick={onText}
      />
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
  onOffset,
  onConstraint,
  constraintActive,
}: {
  enabled: boolean
  hasLockedSelection: boolean
  hasClosedSelection: boolean
  pendingMoveMode: 'move' | 'copy' | null
  pendingTransformMode: 'resize' | 'rotate' | null
  pendingOffset: boolean
  tooltipSide?: 'bottom' | 'right'
  onCopy: () => void
  onMove: () => void
  onDelete: () => void
  onResize: () => void
  onRotate: () => void
  onOffset: () => void
  onConstraint: () => void
  constraintActive: boolean
}) {
  return (
    <>
      <div className="toolbar-group">
        <ToolbarActionButton
          icon="copy"
          label={pendingMoveMode === 'copy' ? 'Cancel copy' : 'Copy selected features'}
          active={pendingMoveMode === 'copy'}
          disabled={!enabled}
          tooltipSide={tooltipSide}
          onClick={onCopy}
        />
        <ToolbarActionButton
          icon="move"
          label={pendingMoveMode === 'move' ? 'Cancel move' : 'Move selected features'}
          active={pendingMoveMode === 'move'}
          disabled={!enabled || hasLockedSelection}
          tooltipSide={tooltipSide}
          onClick={onMove}
        />
        <ToolbarActionButton
          icon="trash"
          label="Delete selected features"
          disabled={!enabled}
          tooltipSide={tooltipSide}
          onClick={onDelete}
        />
        <ToolbarActionButton
          icon="resize"
          label={pendingTransformMode === 'resize' ? 'Cancel resize' : 'Resize selected features'}
          active={pendingTransformMode === 'resize'}
          disabled={!enabled || hasLockedSelection}
          tooltipSide={tooltipSide}
          onClick={onResize}
        />
        <ToolbarActionButton
          icon="rotate"
          label={pendingTransformMode === 'rotate' ? 'Cancel rotate' : 'Rotate selected features'}
          active={pendingTransformMode === 'rotate'}
          disabled={!enabled || hasLockedSelection}
          tooltipSide={tooltipSide}
          onClick={onRotate}
        />
        <ToolbarActionButton
          icon="offset"
          label={pendingOffset ? 'Cancel offset' : 'Create offset feature'}
          active={pendingOffset}
          disabled={!enabled || hasLockedSelection || !hasClosedSelection}
          tooltipSide={tooltipSide}
          onClick={onOffset}
        />
        <ToolbarActionButton
          icon="constraint"
          label={constraintActive ? 'Cancel constraint' : 'Add constraint'}
          active={constraintActive}
          disabled={!enabled || hasLockedSelection}
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
  const effectiveOpen = open && enabled

  useEffect(() => {
    if (!effectiveOpen) {
      return
    }
    function handlePointerDown(event: PointerEvent) {
      if (!containerRef.current) {
        return
      }
      if (!containerRef.current.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
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

  return (
    <div className="toolbar-group toolbar-popover-host" ref={containerRef}>
      <ToolbarActionButton
        icon={triggerIcon}
        label={effectiveOpen ? triggerLabelOpen : triggerLabelClosed}
        active={effectiveOpen}
        disabled={!enabled}
        tooltipSide={tooltipSide}
        onClick={() => setOpen((prev) => !prev)}
      />
      {effectiveOpen ? (
        <div
          className={`toolbar-popover toolbar-popover--${tooltipSide ?? 'bottom'}`}
          style={{ gridTemplateColumns: `repeat(${columns}, auto)` }}
          role="menu"
        >
          {options.map((option) => (
            <ToolbarActionButton
              key={option.value}
              icon={option.icon}
              label={option.label}
              tooltipSide="bottom"
              onClick={() => {
                onSelect(option.value)
                setOpen(false)
              }}
            />
          ))}
        </div>
      ) : null}
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
  onFillet,
}: {
  enabled: boolean
  activeTool: SketchEditTool | null
  tooltipSide?: 'bottom' | 'right'
  onAddPoint: () => void
  onDeletePoint: () => void
  onFillet: () => void
}) {
  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="point-add"
        label={activeTool === 'add_point' ? 'Cancel add point' : 'Add point'}
        active={activeTool === 'add_point'}
        disabled={!enabled}
        tooltipSide={tooltipSide}
        onClick={onAddPoint}
      />
      <ToolbarActionButton
        icon="point-delete"
        label={activeTool === 'delete_point' ? 'Cancel delete point' : 'Delete point'}
        active={activeTool === 'delete_point'}
        disabled={!enabled}
        tooltipSide={tooltipSide}
        onClick={onDeletePoint}
      />
      <ToolbarActionButton
        icon="fillet"
        label={activeTool === 'fillet' ? 'Cancel fillet' : 'Round corner / fillet'}
        active={activeTool === 'fillet'}
        disabled={!enabled}
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
  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="move"
        label={pendingMoveMode === 'move' ? 'Cancel move backdrop' : 'Move backdrop'}
        active={pendingMoveMode === 'move'}
        disabled={!enabled}
        tooltipSide={tooltipSide}
        onClick={onMove}
      />
      <ToolbarActionButton
        icon="trash"
        label="Delete backdrop"
        disabled={!enabled}
        tooltipSide={tooltipSide}
        onClick={onDelete}
      />
      <ToolbarActionButton
        icon="resize"
        label={pendingTransformMode === 'resize' ? 'Cancel resize backdrop' : 'Resize backdrop'}
        active={pendingTransformMode === 'resize'}
        disabled={!enabled}
        tooltipSide={tooltipSide}
        onClick={onResize}
      />
      <ToolbarActionButton
        icon="rotate"
        label={pendingTransformMode === 'rotate' ? 'Cancel rotate backdrop' : 'Rotate backdrop'}
        active={pendingTransformMode === 'rotate'}
        disabled={!enabled}
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
  return (
    <>
      {showNewProjectDialog ? <NewProjectDialog onClose={onCloseNewProject} /> : null}
      {showImportDialog ? <ImportGeometryDialog onClose={onCloseImport} onImportComplete={onImportComplete} /> : null}
      {showTextDialog ? <TextToolDialog onClose={onCloseText} onConfirm={onConfirmText} /> : null}
    </>
  )
}

export function GlobalToolbar({
  onZoomToModel,
  onZoomWindow,
  zoomWindowActive = false,
  onImportComplete,
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
          onSave={toolbar.handleSave}
          onUndo={toolbar.handleUndo}
          onRedo={toolbar.handleRedo}
          onZoomToModel={toolbar.handleZoomToModel}
          onZoomWindow={onZoomWindow}
          zoomWindowActive={zoomWindowActive}
        />
        <SnapActions
          snapSettings={snapSettings}
          activeSnapMode={activeSnapMode}
          onToggleSnapEnabled={onToggleSnapEnabled}
          onToggleSnapMode={onToggleSnapMode}
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
          tooltipSide={layout === 'vertical' ? 'right' : 'bottom'}
          onRect={toolbar.handleRect}
          onCircle={toolbar.handleCircle}
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
          onFillet={toolbar.handleSketchEditFillet}
        />
        <BackdropEditActions
          enabled={toolbar.hasSelectedBackdrop}
          pendingMoveMode={toolbar.pendingMove?.entityType === 'backdrop' && toolbar.pendingMove.mode === 'move' ? 'move' : null}
          pendingTransformMode={toolbar.pendingTransform?.entityType === 'backdrop' ? toolbar.pendingTransform.mode : null}
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
          onSave={toolbar.handleSave}
          onUndo={toolbar.handleUndo}
          onRedo={toolbar.handleRedo}
          onZoomToModel={toolbar.handleZoomToModel}
          onZoomWindow={onZoomWindow}
          zoomWindowActive={zoomWindowActive}
        />
        <SnapActions
          snapSettings={snapSettings}
          activeSnapMode={activeSnapMode}
          onToggleSnapEnabled={onToggleSnapEnabled}
          onToggleSnapMode={onToggleSnapMode}
        />
        <CreationActions
          pendingShape={toolbar.pendingAdd?.shape ?? null}
          onRect={toolbar.handleRect}
          onCircle={toolbar.handleCircle}
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
          onFillet={toolbar.handleSketchEditFillet}
        />
        <BackdropEditActions
          enabled={toolbar.hasSelectedBackdrop}
          pendingMoveMode={toolbar.pendingMove?.entityType === 'backdrop' && toolbar.pendingMove.mode === 'move' ? 'move' : null}
          pendingTransformMode={toolbar.pendingTransform?.entityType === 'backdrop' ? toolbar.pendingTransform.mode : null}
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
