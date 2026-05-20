import { useEffect, useState } from 'react'
import { Icon } from '../Icon'
import { useProjectStore } from '../../store/projectStore'
import { useFileActions } from '../../platform/useFileActions'
import { ImportGeometryDialog } from '../project/ImportGeometryDialog'
import { NewProjectDialog } from '../project/NewProjectDialog'
import type { SnapMode, SnapSettings } from '../../sketch/snapping'
import { SnapPopover } from './SnapPopover'

interface TopCommandBarProps {
  centerTab: 'sketch' | 'preview3d' | 'simulation'
  onCenterTabChange: (tab: 'sketch' | 'preview3d' | 'simulation') => void
  onZoomToModel: () => void
  onZoomWindow: () => void
  zoomWindowActive: boolean
  onOpenLeftDrawer: () => void
  onOpenRightDrawer: () => void
  onImportComplete?: () => void
  onExportModel: () => void
  snapSettings: SnapSettings
  activeSnapMode?: SnapMode | null
  onToggleSnapEnabled: () => void
  onToggleSnapMode: (mode: SnapMode) => void
}

export function TopCommandBar({
  centerTab,
  onCenterTabChange,
  onZoomToModel,
  onZoomWindow,
  zoomWindowActive,
  onOpenLeftDrawer,
  onOpenRightDrawer,
  onImportComplete,
  onExportModel,
  snapSettings,
  activeSnapMode,
  onToggleSnapEnabled,
  onToggleSnapMode,
}: TopCommandBarProps) {
  const fileActions = useFileActions()
  const {
    project,
    dirty,
    history,
    setProjectName,
    undo,
    redo,
  } = useProjectStore()

  const [editingName, setEditingName] = useState(false)
  const [nameVal, setNameVal] = useState(project.meta.name)
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)

  useEffect(() => {
    if (!editingName) setNameVal(project.meta.name)
  }, [editingName, project.meta.name])

  async function handleNew() {
    const ok = await fileActions.confirmDiscardIfDirty()
    if (ok) setShowNewProjectDialog(true)
  }

  return (
    <>
      <div className="top-command-bar">
        {/* Left section: project drawer + project name */}
        <div className="top-command-bar__left">
          <button
            className="top-cmd-btn"
            type="button"
            aria-label="Open project panel"
            onClick={onOpenLeftDrawer}
          >
            <Icon id="project" />
          </button>
          <div className="top-command-bar__project">
            {editingName ? (
              <input
                className="toolbar-name-input"
                value={nameVal}
                onChange={(e) => setNameVal(e.target.value)}
                onBlur={() => {
                  setProjectName(nameVal.trim() || 'Untitled')
                  setEditingName(false)
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    setProjectName(nameVal.trim() || 'Untitled')
                    setEditingName(false)
                  }
                  if (e.key === 'Escape') {
                    setNameVal(project.meta.name)
                    setEditingName(false)
                  }
                }}
                autoFocus
              />
            ) : (
              <button
                className="top-command-bar__name"
                type="button"
                title="Rename project"
                onClick={() => {
                  setNameVal(project.meta.name)
                  setEditingName(true)
                }}
              >
                {project.meta.name}
              </button>
            )}
            <span
              className={`top-command-bar__save-state ${dirty ? 'top-command-bar__save-state--dirty' : ''}`}
            >
              {dirty ? 'Unsaved' : 'Saved'}
            </span>
          </div>
        </div>

        {/* Center section: file ops + undo/redo + view tabs */}
        <div className="top-command-bar__center">
          <div className="top-cmd-group">
            <button className="top-cmd-btn" type="button" aria-label="New project" onClick={handleNew}>
              <Icon id="new" />
            </button>
            <button className="top-cmd-btn" type="button" aria-label="Open project" onClick={() => fileActions.open()}>
              <Icon id="open" />
            </button>
            <button className="top-cmd-btn" type="button" aria-label="Import geometry" onClick={() => setShowImportDialog(true)}>
              <Icon id="import" />
            </button>
            <button className="top-cmd-btn" type="button" aria-label="Export model" onClick={onExportModel}>
              <Icon id="export" />
            </button>
            <button
              className={`top-cmd-btn ${dirty ? 'top-cmd-btn--emphasized' : ''}`}
              type="button"
              aria-label="Save project"
              onClick={() => fileActions.save()}
            >
              <Icon id="save" />
            </button>
          </div>

          <div className="top-cmd-group">
            <button className="top-cmd-btn" type="button" aria-label="Undo" onClick={undo} disabled={history.past.length === 0}>
              <Icon id="undo" />
            </button>
            <button className="top-cmd-btn" type="button" aria-label="Redo" onClick={redo} disabled={history.future.length === 0}>
              <Icon id="redo" />
            </button>
          </div>

          <div className="top-cmd-group top-cmd-group--tabs">
            <button
              className={`top-cmd-tab ${centerTab === 'sketch' ? 'top-cmd-tab--active' : ''}`}
              type="button"
              onClick={() => onCenterTabChange('sketch')}
            >
              Sketch
            </button>
            <button
              className={`top-cmd-tab ${centerTab === 'preview3d' ? 'top-cmd-tab--active' : ''}`}
              type="button"
              onClick={() => onCenterTabChange('preview3d')}
            >
              3D
            </button>
            <button
              className={`top-cmd-tab ${centerTab === 'simulation' ? 'top-cmd-tab--active' : ''}`}
              type="button"
              onClick={() => onCenterTabChange('simulation')}
            >
              Sim
            </button>
          </div>
        </div>

        {/* Right section: zoom + snap + operations */}
        <div className="top-command-bar__right">
          <div className="top-cmd-group">
            <button className="top-cmd-btn" type="button" aria-label="Zoom to model" onClick={onZoomToModel}>
              <Icon id="fit" />
            </button>
            <button
              className={`top-cmd-btn ${zoomWindowActive ? 'top-cmd-btn--active' : ''}`}
              type="button"
              aria-label="Zoom selected"
              onClick={onZoomWindow}
            >
              <Icon id="fit-window" />
            </button>
          </div>
          <SnapPopover
            snapSettings={snapSettings}
            activeSnapMode={activeSnapMode}
            onToggleSnapEnabled={onToggleSnapEnabled}
            onToggleSnapMode={onToggleSnapMode}
          />
          <button
            className="top-cmd-btn top-cmd-btn--operations"
            type="button"
            aria-label="Open operations panel"
            onClick={onOpenRightDrawer}
          >
            Operations{project.operations.length > 0 ? ` ${project.operations.length}` : ''}
          </button>
        </div>
      </div>

      {showNewProjectDialog && (
        <NewProjectDialog onClose={() => {
          setNameVal(useProjectStore.getState().project.meta.name)
          setEditingName(false)
          setShowNewProjectDialog(false)
        }} />
      )}
      {showImportDialog && (
        <ImportGeometryDialog
          onClose={() => setShowImportDialog(false)}
          onImportComplete={onImportComplete}
        />
      )}
    </>
  )
}
