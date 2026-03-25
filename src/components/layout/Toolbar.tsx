import { useState } from 'react'
import { useProjectStore } from '../../store/projectStore'

export function Toolbar() {
  const {
    project,
    pendingAdd,
    setProjectName,
    saveProject,
    loadProject,
    startAddRectPlacement,
    startAddCirclePlacement,
    startAddPolygonPlacement,
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

  function handleAddRect() {
    if (pendingAdd?.shape === 'rect') {
      cancelPendingAdd()
      return
    }
    startAddRectPlacement()
  }

  function handleAddCircle() {
    if (pendingAdd?.shape === 'circle') {
      cancelPendingAdd()
      return
    }
    startAddCirclePlacement()
  }

  function handleAddPolygon() {
    if (pendingAdd?.shape === 'polygon') {
      cancelPendingAdd()
      return
    }
    startAddPolygonPlacement()
  }

  return (
    <div className="toolbar">
      <div className="toolbar-group">
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
          >
            {project.meta.name}
          </button>
        )}
      </div>

      <div className="toolbar-group">
        <button className="toolbar-btn" onClick={handleSave}>Save</button>
        <button className="toolbar-btn" onClick={handleLoad}>Open</button>
      </div>

      <div className="toolbar-group">
        <button
          className={`toolbar-btn ${pendingAdd?.shape === 'rect' ? 'toolbar-btn--active' : ''}`}
          onClick={handleAddRect}
        >
          {pendingAdd?.shape === 'rect' ? 'Cancel Rect' : 'Add Rect'}
        </button>
        <button
          className={`toolbar-btn ${pendingAdd?.shape === 'circle' ? 'toolbar-btn--active' : ''}`}
          onClick={handleAddCircle}
        >
          {pendingAdd?.shape === 'circle' ? 'Cancel Circle' : 'Add Circle'}
        </button>
        <button
          className={`toolbar-btn ${pendingAdd?.shape === 'polygon' ? 'toolbar-btn--active' : ''}`}
          onClick={handleAddPolygon}
        >
          {pendingAdd?.shape === 'polygon' ? 'Cancel Polygon' : 'Add Polygon'}
        </button>
      </div>
    </div>
  )
}
