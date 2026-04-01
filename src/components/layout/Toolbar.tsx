import { useEffect, useState } from 'react'
import { Icon } from '../Icon'
import { NewProjectDialog } from '../project/NewProjectDialog'
import { useProjectStore } from '../../store/projectStore'

type ToolbarIconName = 'new' | 'open' | 'save' | 'undo' | 'redo' | 'fit' | 'rect' | 'circle' | 'polygon' | 'spline' | 'composite'

interface ToolbarActionButtonProps {
  icon: ToolbarIconName
  label: string
  active?: boolean
  disabled?: boolean
  tooltipSide?: 'bottom' | 'right'
  onClick: () => void
}

interface ToolbarProps {
  onZoomToModel: () => void
}

interface CreationToolbarProps {
  layout?: 'horizontal' | 'vertical'
}

function ToolbarActionButton({
  icon,
  label,
  active = false,
  disabled = false,
  tooltipSide = 'bottom',
  onClick,
}: ToolbarActionButtonProps) {
  return (
    <div className="toolbar-action">
      <button
        className={`toolbar-icon-btn ${active ? 'toolbar-icon-btn--active' : ''}`}
        onClick={onClick}
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

function useToolbarState(onZoomToModel: () => void) {
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
    cancelPendingAdd,
  } = useProjectStore()

  const [editingName, setEditingName] = useState(false)
  const [nameVal, setNameVal] = useState(project.meta.name)
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)

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

  function togglePlacement(shape: 'rect' | 'circle' | 'polygon' | 'spline' | 'composite', start: () => void) {
    if (pendingAdd?.shape === shape) {
      cancelPendingAdd()
      return
    }

    start()
  }

  return {
    project,
    pendingAdd,
    history,
    editingName,
    nameVal,
    showNewProjectDialog,
    setProjectName,
    setEditingName,
    setNameVal,
    setShowNewProjectDialog,
    handleNewProject,
    handleSave,
    handleLoad,
    handleZoomToModel: onZoomToModel,
    handleUndo: undo,
    handleRedo: redo,
    handleRect: () => togglePlacement('rect', startAddRectPlacement),
    handleCircle: () => togglePlacement('circle', startAddCirclePlacement),
    handlePolygon: () => togglePlacement('polygon', startAddPolygonPlacement),
    handleSpline: () => togglePlacement('spline', startAddSplinePlacement),
    handleComposite: () => togglePlacement('composite', startAddCompositePlacement),
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
  onSave,
  onUndo,
  onRedo,
  onZoomToModel,
}: {
  historyLengthPast: number
  historyLengthFuture: number
  onNew: () => void
  onOpen: () => void
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

function ToolbarDialog({
  open,
  onClose,
}: {
  open: boolean
  onClose: () => void
}) {
  return open ? <NewProjectDialog onClose={onClose} /> : null
}

export function GlobalToolbar({ onZoomToModel }: ToolbarProps) {
  const toolbar = useToolbarState(onZoomToModel)

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
          onSave={toolbar.handleSave}
          onUndo={toolbar.handleUndo}
          onRedo={toolbar.handleRedo}
          onZoomToModel={toolbar.handleZoomToModel}
        />
      </div>
      <ToolbarDialog
        open={toolbar.showNewProjectDialog}
        onClose={() => {
          toolbar.setNameVal(useProjectStore.getState().project.meta.name)
          toolbar.setEditingName(false)
          toolbar.setShowNewProjectDialog(false)
        }}
      />
    </>
  )
}

export function CreationToolbar({ onZoomToModel, layout = 'horizontal' }: ToolbarProps & CreationToolbarProps) {
  const toolbar = useToolbarState(onZoomToModel)

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
    </div>
  )
}

export function Toolbar({ onZoomToModel }: ToolbarProps) {
  const toolbar = useToolbarState(onZoomToModel)

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
      </div>
      <ToolbarDialog
        open={toolbar.showNewProjectDialog}
        onClose={() => {
          toolbar.setNameVal(useProjectStore.getState().project.meta.name)
          toolbar.setEditingName(false)
          toolbar.setShowNewProjectDialog(false)
        }}
      />
    </>
  )
}
