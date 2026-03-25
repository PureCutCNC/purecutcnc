import { useState } from 'react'
import { useProjectStore } from '../../store/projectStore'

type ToolbarIconName = 'save' | 'open' | 'fit' | 'rect' | 'circle' | 'polygon' | 'spline'

function ToolbarIcon({ name }: { name: ToolbarIconName }) {
  switch (name) {
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
  }
}

interface ToolbarActionButtonProps {
  icon: ToolbarIconName
  label: string
  active?: boolean
  onClick: () => void
}

interface ToolbarProps {
  onZoomToModel: () => void
}

function ToolbarActionButton({ icon, label, active = false, onClick }: ToolbarActionButtonProps) {
  return (
    <div className="toolbar-action">
      <button
        className={`toolbar-icon-btn ${active ? 'toolbar-icon-btn--active' : ''}`}
        onClick={onClick}
        aria-label={label}
        type="button"
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
    setProjectName,
    saveProject,
    loadProject,
    startAddRectPlacement,
    startAddCirclePlacement,
    startAddPolygonPlacement,
    startAddSplinePlacement,
    cancelPendingAdd,
  } = useProjectStore()

  const [editingName, setEditingName] = useState(false)
  const [nameVal, setNameVal] = useState(project.meta.name)

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

  function togglePlacement(shape: 'rect' | 'circle' | 'polygon' | 'spline', start: () => void) {
    if (pendingAdd?.shape === shape) {
      cancelPendingAdd()
      return
    }

    start()
  }

  return (
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
        <ToolbarActionButton icon="open" label="Open Project" onClick={handleLoad} />
        <ToolbarActionButton icon="save" label="Save Project" onClick={handleSave} />
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
      </div>
    </div>
  )
}
