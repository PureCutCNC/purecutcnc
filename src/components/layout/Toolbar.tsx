import { useEffect, useState } from 'react'
import { Icon } from '../Icon'
import { ImportGeometryDialog } from '../project/ImportGeometryDialog'
import { NewProjectDialog } from '../project/NewProjectDialog'
import type { SnapMode, SnapSettings } from '../../sketch/snapping'
import { useProjectStore } from '../../store/projectStore'

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
  const {
    project,
    pendingAdd,
    history,
    setProjectName,
    saveProject,
    loadProject,
    undo,
    redo,
    startAddRectPlacement,
    startAddCirclePlacement,
    startAddPolygonPlacement,
    startAddSplinePlacement,
    startAddCompositePlacement,
    startMoveFeature,
    startCopyFeature,
    startResizeFeature,
    startRotateFeature,
    startMoveBackdrop,
    startResizeBackdrop,
    startRotateBackdrop,
    deleteBackdrop,
    deleteFeatures,
    cancelPendingAdd,
    pendingMove,
    pendingTransform,
    cancelPendingMove,
    cancelPendingTransform,
    selection,
  } = useProjectStore()

  const [editingName, setEditingName] = useState(false)
  const [nameVal, setNameVal] = useState(project.meta.name)
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)

  useEffect(() => {
    if (!editingName) {
      setNameVal(project.meta.name)
    }
  }, [editingName, project.meta.name])

  function handleNewProject() {
    setShowNewProjectDialog(true)
  }

  function handleSave() {
    const json = saveProject()
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `${project.meta.name.replace(/\s+/g, '_')}.camj`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  function handleLoad() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.camj,.json'
    input.onchange = (event) => {
      const file = (event.target as HTMLInputElement).files?.[0]
      if (!file) return
      const reader = new FileReader()
      reader.onload = (readerEvent) => {
        try {
          const parsed = JSON.parse(readerEvent.target?.result as string)
          loadProject(parsed)
          setNameVal(parsed.meta?.name ?? 'Untitled')
        } catch {
          alert('Failed to parse project file.')
        }
      }
      reader.readAsText(file)
    }
    input.click()
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

  const selectedFeatureIds = selection.mode === 'feature' ? selection.selectedFeatureIds : []
  const primarySelectedFeatureId = selection.selectedFeatureId ?? selectedFeatureIds[0] ?? null
  const selectedFeatures = selectedFeatureIds
    .map((featureId) => project.features.find((feature) => feature.id === featureId) ?? null)
    .filter((feature): feature is NonNullable<typeof project.features[number]> => feature !== null)
  const hasSelectedFeatures = selectedFeatureIds.length > 0
  const hasSelectedBackdrop = selection.selectedNode?.type === 'backdrop' && !!project.backdrop
  const hasLockedSelectedFeatures = selectedFeatures.some((feature) => feature.locked)

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

  return {
    project,
    pendingAdd,
    pendingMove,
    pendingTransform,
    history,
    editingName,
    nameVal,
    showNewProjectDialog,
    showImportDialog,
    hasSelectedFeatures,
    hasSelectedBackdrop,
    hasLockedSelectedFeatures,
    setProjectName,
    setEditingName,
    setNameVal,
    setShowNewProjectDialog,
    setShowImportDialog,
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
    handleFeatureMove,
    handleFeatureCopy,
    handleFeatureResize,
    handleFeatureRotate,
    handleDeleteSelectedFeatures,
    handleBackdropMove,
    handleBackdropResize,
    handleBackdropRotate,
    handleBackdropDelete,
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
}) {
  return (
    <>
      <div className="toolbar-group">
        <ToolbarActionButton icon="new" label="New Project" onClick={onNew} />
        <ToolbarActionButton icon="open" label="Open Project" onClick={onOpen} />
        <ToolbarActionButton icon="import" label="Import Geometry" onClick={onImport} />
        <ToolbarActionButton icon="save" label="Save Project" onClick={onSave} />
      </div>
      <div className="toolbar-group">
        <ToolbarActionButton icon="undo" label="Undo" onClick={onUndo} disabled={historyLengthPast === 0} />
        <ToolbarActionButton icon="redo" label="Redo" onClick={onRedo} disabled={historyLengthFuture === 0} />
      </div>
      <div className="toolbar-group">
        <ToolbarActionButton icon="fit" label="Zoom to Model" onClick={onZoomToModel} />
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
}: {
  pendingShape: string | null
  tooltipSide?: 'bottom' | 'right'
  onRect: () => void
  onCircle: () => void
  onPolygon: () => void
  onSpline: () => void
  onComposite: () => void
}) {
  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="rect"
        label={pendingShape === 'rect' ? 'Cancel Rectangle Tool' : 'Add Rectangle'}
        active={pendingShape === 'rect'}
        tooltipSide={tooltipSide}
        onClick={onRect}
      />
      <ToolbarActionButton
        icon="circle"
        label={pendingShape === 'circle' ? 'Cancel Circle Tool' : 'Add Circle'}
        active={pendingShape === 'circle'}
        tooltipSide={tooltipSide}
        onClick={onCircle}
      />
      <ToolbarActionButton
        icon="polygon"
        label={pendingShape === 'polygon' ? 'Cancel Polygon Tool' : 'Add Polygon'}
        active={pendingShape === 'polygon'}
        tooltipSide={tooltipSide}
        onClick={onPolygon}
      />
      <ToolbarActionButton
        icon="spline"
        label={pendingShape === 'spline' ? 'Cancel Spline Tool' : 'Add Spline'}
        active={pendingShape === 'spline'}
        tooltipSide={tooltipSide}
        onClick={onSpline}
      />
      <ToolbarActionButton
        icon="composite"
        label={pendingShape === 'composite' ? 'Cancel Composite Tool' : 'Add Composite'}
        active={pendingShape === 'composite'}
        tooltipSide={tooltipSide}
        onClick={onComposite}
      />
    </div>
  )
}

function FeatureEditActions({
  hasLockedSelection,
  pendingMoveMode,
  pendingTransformMode,
  tooltipSide,
  onCopy,
  onMove,
  onDelete,
  onResize,
  onRotate,
}: {
  hasLockedSelection: boolean
  pendingMoveMode: 'move' | 'copy' | null
  pendingTransformMode: 'resize' | 'rotate' | null
  tooltipSide?: 'bottom' | 'right'
  onCopy: () => void
  onMove: () => void
  onDelete: () => void
  onResize: () => void
  onRotate: () => void
}) {
  return (
    <div className="toolbar-group">
      <ToolbarActionButton
        icon="copy"
        label={pendingMoveMode === 'copy' ? 'Cancel Copy' : 'Copy Selected Features'}
        active={pendingMoveMode === 'copy'}
        tooltipSide={tooltipSide}
        onClick={onCopy}
      />
      <ToolbarActionButton
        icon="move"
        label={pendingMoveMode === 'move' ? 'Cancel Move' : 'Move Selected Features'}
        active={pendingMoveMode === 'move'}
        disabled={hasLockedSelection}
        tooltipSide={tooltipSide}
        onClick={onMove}
      />
      <ToolbarActionButton
        icon="trash"
        label="Delete Selected Features"
        tooltipSide={tooltipSide}
        onClick={onDelete}
      />
      <ToolbarActionButton
        icon="resize"
        label={pendingTransformMode === 'resize' ? 'Cancel Resize' : 'Resize Selected Features'}
        active={pendingTransformMode === 'resize'}
        disabled={hasLockedSelection}
        tooltipSide={tooltipSide}
        onClick={onResize}
      />
      <ToolbarActionButton
        icon="rotate"
        label={pendingTransformMode === 'rotate' ? 'Cancel Rotate' : 'Rotate Selected Features'}
        active={pendingTransformMode === 'rotate'}
        disabled={hasLockedSelection}
        tooltipSide={tooltipSide}
        onClick={onRotate}
      />
    </div>
  )
}

function BackdropEditActions({
  pendingMoveMode,
  pendingTransformMode,
  tooltipSide,
  onMove,
  onDelete,
  onResize,
  onRotate,
}: {
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
        label={pendingMoveMode === 'move' ? 'Cancel Move Backdrop' : 'Move Backdrop'}
        active={pendingMoveMode === 'move'}
        tooltipSide={tooltipSide}
        onClick={onMove}
      />
      <ToolbarActionButton
        icon="trash"
        label="Delete Backdrop"
        tooltipSide={tooltipSide}
        onClick={onDelete}
      />
      <ToolbarActionButton
        icon="resize"
        label={pendingTransformMode === 'resize' ? 'Cancel Resize Backdrop' : 'Resize Backdrop'}
        active={pendingTransformMode === 'resize'}
        tooltipSide={tooltipSide}
        onClick={onResize}
      />
      <ToolbarActionButton
        icon="rotate"
        label={pendingTransformMode === 'rotate' ? 'Cancel Rotate Backdrop' : 'Rotate Backdrop'}
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
  const snapActive = snapSettings.enabled && snapSettings.modes.length > 0
  const hasMode = (mode: SnapMode) => snapSettings.modes.includes(mode)

  return (
    <>
      <div className="toolbar-group">
        <ToolbarActionButton
          icon="snap"
          label={snapSettings.enabled ? 'Disable Snapping' : 'Enable Snapping'}
          active={snapActive}
          tooltipSide={tooltipSide}
          onClick={onToggleSnapEnabled}
        />
        <ToolbarActionButton
          icon="snap-grid"
          label="Snap to Grid"
          active={snapSettings.enabled && hasMode('grid')}
          emphasized={snapSettings.enabled && activeSnapMode === 'grid'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('grid')}
        />
        <ToolbarActionButton
          icon="snap-point"
          label="Snap to Point"
          active={snapSettings.enabled && hasMode('point')}
          emphasized={snapSettings.enabled && activeSnapMode === 'point'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('point')}
        />
        <ToolbarActionButton
          icon="snap-line"
          label="Snap to Line"
          active={snapSettings.enabled && hasMode('line')}
          emphasized={snapSettings.enabled && activeSnapMode === 'line'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('line')}
        />
        <ToolbarActionButton
          icon="snap-midpoint"
          label="Snap to Midpoint"
          active={snapSettings.enabled && hasMode('midpoint')}
          emphasized={snapSettings.enabled && activeSnapMode === 'midpoint'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('midpoint')}
        />
        <ToolbarActionButton
          icon="snap-center"
          label="Snap to Center"
          active={snapSettings.enabled && hasMode('center')}
          emphasized={snapSettings.enabled && activeSnapMode === 'center'}
          tooltipSide={tooltipSide}
          onClick={() => onToggleSnapMode('center')}
        />
        <ToolbarActionButton
          icon="snap-perpendicular"
          label="Snap Perpendicular"
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
  onCloseNewProject,
  onCloseImport,
  onImportComplete,
}: {
  showNewProjectDialog: boolean
  showImportDialog: boolean
  onCloseNewProject: () => void
  onCloseImport: () => void
  onImportComplete?: () => void
}) {
  return (
    <>
      {showNewProjectDialog ? <NewProjectDialog onClose={onCloseNewProject} /> : null}
      {showImportDialog ? <ImportGeometryDialog onClose={onCloseImport} onImportComplete={onImportComplete} /> : null}
    </>
  )
}

export function GlobalToolbar({ onZoomToModel, onImportComplete }: ToolbarProps) {
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
        />
      </div>
      <ToolbarDialog
        showNewProjectDialog={toolbar.showNewProjectDialog}
        showImportDialog={toolbar.showImportDialog}
        onCloseNewProject={() => {
          toolbar.setNameVal(useProjectStore.getState().project.meta.name)
          toolbar.setEditingName(false)
          toolbar.setShowNewProjectDialog(false)
        }}
        onCloseImport={() => toolbar.setShowImportDialog(false)}
        onImportComplete={onImportComplete}
      />
    </>
  )
}

export function CreationToolbar({
  onZoomToModel,
  onImportComplete,
  layout = 'horizontal',
  snapSettings,
  activeSnapMode,
  onToggleSnapEnabled,
  onToggleSnapMode,
}: ToolbarProps & CreationToolbarProps & SnapToolbarProps) {
  const toolbar = useToolbarState(onZoomToModel, onImportComplete)

  return (
    <div className={`toolbar toolbar--creation toolbar--${layout}`}>
      <CreationActions
        pendingShape={toolbar.pendingAdd?.shape ?? null}
        tooltipSide={layout === 'vertical' ? 'right' : 'bottom'}
        onRect={toolbar.handleRect}
        onCircle={toolbar.handleCircle}
        onPolygon={toolbar.handlePolygon}
        onSpline={toolbar.handleSpline}
        onComposite={toolbar.handleComposite}
      />
      {toolbar.hasSelectedFeatures ? (
        <FeatureEditActions
          hasLockedSelection={toolbar.hasLockedSelectedFeatures}
          pendingMoveMode={toolbar.pendingMove?.entityType === 'feature' ? toolbar.pendingMove.mode : null}
          pendingTransformMode={toolbar.pendingTransform?.entityType === 'feature' ? toolbar.pendingTransform.mode : null}
          tooltipSide={layout === 'vertical' ? 'right' : 'bottom'}
          onCopy={toolbar.handleFeatureCopy}
          onMove={toolbar.handleFeatureMove}
          onDelete={toolbar.handleDeleteSelectedFeatures}
          onResize={toolbar.handleFeatureResize}
          onRotate={toolbar.handleFeatureRotate}
        />
      ) : toolbar.hasSelectedBackdrop ? (
        <BackdropEditActions
          pendingMoveMode={toolbar.pendingMove?.entityType === 'backdrop' && toolbar.pendingMove.mode === 'move' ? 'move' : null}
          pendingTransformMode={toolbar.pendingTransform?.entityType === 'backdrop' ? toolbar.pendingTransform.mode : null}
          tooltipSide={layout === 'vertical' ? 'right' : 'bottom'}
          onMove={toolbar.handleBackdropMove}
          onDelete={toolbar.handleBackdropDelete}
          onResize={toolbar.handleBackdropResize}
          onRotate={toolbar.handleBackdropRotate}
        />
      ) : null}
      <SnapActions
        snapSettings={snapSettings}
        activeSnapMode={activeSnapMode}
        tooltipSide={layout === 'vertical' ? 'right' : 'bottom'}
        onToggleSnapEnabled={onToggleSnapEnabled}
        onToggleSnapMode={onToggleSnapMode}
      />
    </div>
  )
}

export function Toolbar({
  onZoomToModel,
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
        />
        <CreationActions
          pendingShape={toolbar.pendingAdd?.shape ?? null}
          onRect={toolbar.handleRect}
          onCircle={toolbar.handleCircle}
          onPolygon={toolbar.handlePolygon}
          onSpline={toolbar.handleSpline}
          onComposite={toolbar.handleComposite}
        />
        {toolbar.hasSelectedFeatures ? (
          <FeatureEditActions
            hasLockedSelection={toolbar.hasLockedSelectedFeatures}
            pendingMoveMode={toolbar.pendingMove?.entityType === 'feature' ? toolbar.pendingMove.mode : null}
            pendingTransformMode={toolbar.pendingTransform?.entityType === 'feature' ? toolbar.pendingTransform.mode : null}
            onCopy={toolbar.handleFeatureCopy}
            onMove={toolbar.handleFeatureMove}
            onDelete={toolbar.handleDeleteSelectedFeatures}
            onResize={toolbar.handleFeatureResize}
            onRotate={toolbar.handleFeatureRotate}
          />
        ) : toolbar.hasSelectedBackdrop ? (
          <BackdropEditActions
            pendingMoveMode={toolbar.pendingMove?.entityType === 'backdrop' && toolbar.pendingMove.mode === 'move' ? 'move' : null}
            pendingTransformMode={toolbar.pendingTransform?.entityType === 'backdrop' ? toolbar.pendingTransform.mode : null}
            onMove={toolbar.handleBackdropMove}
            onDelete={toolbar.handleBackdropDelete}
            onResize={toolbar.handleBackdropResize}
            onRotate={toolbar.handleBackdropRotate}
          />
        ) : null}
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
        onCloseNewProject={() => {
          toolbar.setNameVal(useProjectStore.getState().project.meta.name)
          toolbar.setEditingName(false)
          toolbar.setShowNewProjectDialog(false)
        }}
        onCloseImport={() => toolbar.setShowImportDialog(false)}
        onImportComplete={onImportComplete}
      />
    </>
  )
}
