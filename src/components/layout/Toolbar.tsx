import { useState } from 'react'
import { NewProjectDialog } from '../project/NewProjectDialog'
import { useProjectStore } from '../../store/projectStore'

type ToolbarIconName = 'new' | 'open' | 'save' | 'undo' | 'redo' | 'fit' | 'rect' | 'circle' | 'polygon' | 'spline' | 'composite'

function ToolbarIcon({ name }: { name: ToolbarIconName }) {
  switch (name) {
    case 'new':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 4.5h7l5 5V19.5H7z" />
          <path d="M14 4.5v5h5" />
          <path d="M12 10v6" />
          <path d="M9 13h6" />
        </svg>
      )
    case 'save':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 4.5h11l3 3v12H5z" />
          <path d="M8 4.5h7v4.5H8z" />
          <path d="M8 14.5h8v4H8z" />
        </svg>
      )
    case 'open':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 8h5l2 2h9" />
          <path d="M4 10.5h16l-2.1 7H6.1z" />
        </svg>
      )
    case 'undo':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 8 5 12l4 4" />
          <path d="M6 12h8a5 5 0 1 1 0 10h-2" />
        </svg>
      )
    case 'redo':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="m15 8 4 4-4 4" />
          <path d="M18 12h-8a5 5 0 1 0 0 10h2" />
        </svg>
      )
    case 'fit':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M9 4H4v5" />
          <path d="M15 4h5v5" />
          <path d="M20 15v5h-5" />
          <path d="M4 15v5h5" />
          <path d="M4 9l6-6" />
          <path d="M20 9l-6-6" />
          <path d="M20 15l-6 6" />
          <path d="M4 15l6 6" />
        </svg>
      )
    case 'rect':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <rect x="5" y="7" width="14" height="10" rx="1.5" />
        </svg>
      )
    case 'circle':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="6.5" />
        </svg>
      )
    case 'polygon':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M7 6h10l4 6-6 6H7L3 10z" />
        </svg>
      )
    case 'spline':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 15c2.5 0 2.5-6 5-6s2.5 8 5 8 2.5-5 6-5" />
          <circle cx="4" cy="15" r="1.2" />
          <circle cx="9" cy="9" r="1.2" />
          <circle cx="14" cy="17" r="1.2" />
          <circle cx="20" cy="12" r="1.2" />
        </svg>
      )
    case 'composite':
      return (
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M5 17 9 8l5 3" />
          <path d="M14 11c2 0 3.5 1.2 5 4" />
          <path d="M19 15c-1.2 2.2-3.2 3.4-6 3.4H5z" />
          <circle cx="5" cy="17" r="1.2" />
          <circle cx="9" cy="8" r="1.2" />
          <circle cx="14" cy="11" r="1.2" />
        </svg>
      )
  }
}

interface ToolbarActionButtonProps {
  icon: ToolbarIconName
  label: string
  active?: boolean
  disabled?: boolean
  onClick: () => void
}

interface ToolbarProps {
  onZoomToModel: () => void
}

function ToolbarActionButton({ icon, label, active = false, disabled = false, onClick }: ToolbarActionButtonProps) {
  return (
    <div className="toolbar-action">
      <button
        className={`toolbar-icon-btn ${active ? 'toolbar-icon-btn--active' : ''}`}
        onClick={onClick}
        aria-label={label}
        type="button"
        disabled={disabled}
      >
        <ToolbarIcon name={icon} />
      </button>
      <span className="toolbar-tooltip" role="tooltip">
        {label}
      </span>
    </div>
  )
}

export function Toolbar({ onZoomToModel }: ToolbarProps) {
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

  return (
    <>
      <div className="toolbar">
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
                  setNameVal(project.meta.name)
                  setEditingName(false)
                }
              }}
              autoFocus
            />
          ) : (
            <button
              className="toolbar-project-name"
              onClick={() => {
                setNameVal(project.meta.name)
                setEditingName(true)
              }}
              title="Rename project"
              type="button"
            >
              {project.meta.name}
            </button>
          )}
        </div>

        <div className="toolbar-group">
          <ToolbarActionButton icon="new" label="New Project" onClick={handleNewProject} />
          <ToolbarActionButton icon="open" label="Open Project" onClick={handleLoad} />
          <ToolbarActionButton icon="save" label="Save Project" onClick={handleSave} />
          <ToolbarActionButton
            icon="undo"
            label="Undo"
            onClick={undo}
            disabled={history.past.length === 0}
          />
          <ToolbarActionButton
            icon="redo"
            label="Redo"
            onClick={redo}
            disabled={history.future.length === 0}
          />
          <ToolbarActionButton icon="fit" label="Zoom to Model" onClick={onZoomToModel} />
        </div>

        <div className="toolbar-group">
          <ToolbarActionButton
            icon="rect"
            label={pendingAdd?.shape === 'rect' ? 'Cancel Rectangle Tool' : 'Add Rectangle'}
            active={pendingAdd?.shape === 'rect'}
            onClick={() => togglePlacement('rect', startAddRectPlacement)}
          />
          <ToolbarActionButton
            icon="circle"
            label={pendingAdd?.shape === 'circle' ? 'Cancel Circle Tool' : 'Add Circle'}
            active={pendingAdd?.shape === 'circle'}
            onClick={() => togglePlacement('circle', startAddCirclePlacement)}
          />
          <ToolbarActionButton
            icon="polygon"
            label={pendingAdd?.shape === 'polygon' ? 'Cancel Polygon Tool' : 'Add Polygon'}
            active={pendingAdd?.shape === 'polygon'}
            onClick={() => togglePlacement('polygon', startAddPolygonPlacement)}
          />
          <ToolbarActionButton
            icon="spline"
            label={pendingAdd?.shape === 'spline' ? 'Cancel Spline Tool' : 'Add Spline'}
            active={pendingAdd?.shape === 'spline'}
            onClick={() => togglePlacement('spline', startAddSplinePlacement)}
          />
          <ToolbarActionButton
            icon="composite"
            label={pendingAdd?.shape === 'composite' ? 'Cancel Composite Tool' : 'Add Composite'}
            active={pendingAdd?.shape === 'composite'}
            onClick={() => togglePlacement('composite', startAddCompositePlacement)}
          />
        </div>
      </div>
      {showNewProjectDialog ? (
        <NewProjectDialog
          onClose={() => {
            setNameVal(useProjectStore.getState().project.meta.name)
            setEditingName(false)
            setShowNewProjectDialog(false)
          }}
        />
      ) : null}
    </>
  )
}
