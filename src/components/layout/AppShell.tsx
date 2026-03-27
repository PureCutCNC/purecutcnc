import type { ReactNode } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { getStockBounds } from '../../types/project'
import { formatLength } from '../../utils/units'
import '../../styles/layout.css'

interface AppShellProps {
  toolbar: ReactNode
  sketchCanvas: ReactNode
  featureTree: ReactNode
  propertiesPanel: ReactNode
  viewport3d: ReactNode
  aiPanel: ReactNode
  camPanel?: ReactNode
  centerTab: 'sketch' | 'preview3d'
  onCenterTabChange: (tab: 'sketch' | 'preview3d') => void
  workspaceLayout: 'lcr' | 'lc' | 'c' | 'cr'
  onWorkspaceLayoutChange: (layout: 'lcr' | 'lc' | 'c' | 'cr') => void
  rightTab: 'operations' | 'tools' | 'ai'
  onRightTabChange: (tab: 'operations' | 'tools' | 'ai') => void
}

function nextTab<T extends string>(tabs: readonly T[], current: T, direction: 1 | -1): T {
  const currentIndex = tabs.indexOf(current)
  const nextIndex = (currentIndex + direction + tabs.length) % tabs.length
  return tabs[nextIndex]
}

export function AppShell({
  toolbar,
  sketchCanvas,
  featureTree,
  propertiesPanel,
  viewport3d,
  aiPanel,
  camPanel,
  centerTab,
  onCenterTabChange,
  workspaceLayout,
  onWorkspaceLayoutChange,
  rightTab,
  onRightTabChange,
}: AppShellProps) {
  const { project } = useProjectStore()
  const stockBounds = getStockBounds(project.stock)
  const stockWidth = stockBounds.maxX - stockBounds.minX
  const stockHeight = stockBounds.maxY - stockBounds.minY
  const centerTabs = ['sketch', 'preview3d'] as const
  const rightTabs = ['operations', 'tools', 'ai'] as const
  const workspaceLayouts = [
    { id: 'lcr', label: 'Show left, center, and right panels' },
    { id: 'lc', label: 'Show left and center panels' },
    { id: 'c', label: 'Show center panel only' },
    { id: 'cr', label: 'Show center and right panels' },
  ] as const

  return (
    <div className="app-shell">
      {/* ── Top toolbar ── */}
      <header className="app-toolbar">
        {toolbar}
      </header>

      {/* Main work area */}
      <div className={`app-body app-body--${workspaceLayout}`}>
        <aside className="panel-left">
          <section className="panel panel-tree">
            <div className="panel-header">
              Feature Tree
              <span className="feature-count">
                {project.features.length + 3}
              </span>
            </div>
            <div className="panel-content">{featureTree}</div>
          </section>
          <section className="panel panel-properties">
            <div className="panel-header">Properties</div>
            <div className="panel-content">{propertiesPanel}</div>
          </section>
        </aside>

        <main className="panel-centre">
          <div className="panel centre-workspace">
            <div className="panel-tabs-header" role="tablist" aria-label="Workspace Views">
              <button
                id="workspace-tab-sketch"
                className={`panel-tab ${centerTab === 'sketch' ? 'panel-tab--active' : ''}`}
                onClick={() => onCenterTabChange('sketch')}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight') {
                    event.preventDefault()
                    onCenterTabChange(nextTab(centerTabs, centerTab, 1))
                  } else if (event.key === 'ArrowLeft') {
                    event.preventDefault()
                    onCenterTabChange(nextTab(centerTabs, centerTab, -1))
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    onCenterTabChange(centerTabs[0])
                  } else if (event.key === 'End') {
                    event.preventDefault()
                    onCenterTabChange(centerTabs[centerTabs.length - 1])
                  }
                }}
                type="button"
                role="tab"
                aria-selected={centerTab === 'sketch'}
                aria-controls="workspace-panel-sketch"
                tabIndex={centerTab === 'sketch' ? 0 : -1}
              >
                Sketch
              </button>
              <button
                id="workspace-tab-preview3d"
                className={`panel-tab ${centerTab === 'preview3d' ? 'panel-tab--active' : ''}`}
                onClick={() => onCenterTabChange('preview3d')}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight') {
                    event.preventDefault()
                    onCenterTabChange(nextTab(centerTabs, centerTab, 1))
                  } else if (event.key === 'ArrowLeft') {
                    event.preventDefault()
                    onCenterTabChange(nextTab(centerTabs, centerTab, -1))
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    onCenterTabChange(centerTabs[0])
                  } else if (event.key === 'End') {
                    event.preventDefault()
                    onCenterTabChange(centerTabs[centerTabs.length - 1])
                  }
                }}
                type="button"
                role="tab"
                aria-selected={centerTab === 'preview3d'}
                aria-controls="workspace-panel-preview3d"
                tabIndex={centerTab === 'preview3d' ? 0 : -1}
              >
                3D View
              </button>
              <div className="panel-tabs-spacer" />
              <div className="workspace-layout-controls" aria-label="Workspace layout presets">
                {workspaceLayouts.map((layout) => (
                  <button
                    key={layout.id}
                    className={`workspace-layout-btn ${workspaceLayout === layout.id ? 'workspace-layout-btn--active' : ''}`}
                    type="button"
                    title={layout.label}
                    aria-label={layout.label}
                    onClick={() => onWorkspaceLayoutChange(layout.id)}
                  >
                    <span className={`workspace-layout-icon workspace-layout-icon--${layout.id}`} aria-hidden="true">
                      <span />
                      <span />
                      <span />
                    </span>
                  </button>
                ))}
              </div>
            </div>
            <div className="centre-stage">
              <div
                id="workspace-panel-sketch"
                className={`centre-view ${centerTab === 'sketch' ? 'centre-view--active' : ''}`}
                role="tabpanel"
                aria-labelledby="workspace-tab-sketch"
                aria-hidden={centerTab !== 'sketch'}
              >
                {sketchCanvas}
              </div>
              <div
                id="workspace-panel-preview3d"
                className={`centre-view ${centerTab === 'preview3d' ? 'centre-view--active' : ''}`}
                role="tabpanel"
                aria-labelledby="workspace-tab-preview3d"
                aria-hidden={centerTab !== 'preview3d'}
              >
                {viewport3d}
              </div>
            </div>
          </div>
        </main>

        <aside className="panel-right">
          <section className="panel panel-tabs">
            <div className="panel-tabs-header" role="tablist" aria-label="Right Sidebar">
              <button
                id="sidebar-tab-operations"
                className={`panel-tab ${rightTab === 'operations' ? 'panel-tab--active' : ''}`}
                onClick={() => onRightTabChange('operations')}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight') {
                    event.preventDefault()
                    onRightTabChange(nextTab(rightTabs, rightTab, 1))
                  } else if (event.key === 'ArrowLeft') {
                    event.preventDefault()
                    onRightTabChange(nextTab(rightTabs, rightTab, -1))
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    onRightTabChange(rightTabs[0])
                  } else if (event.key === 'End') {
                    event.preventDefault()
                    onRightTabChange(rightTabs[rightTabs.length - 1])
                  }
                }}
                type="button"
                role="tab"
                aria-selected={rightTab === 'operations'}
                aria-controls="sidebar-panel-operations"
                tabIndex={rightTab === 'operations' ? 0 : -1}
              >
                Operations
              </button>
              <button
                id="sidebar-tab-tools"
                className={`panel-tab ${rightTab === 'tools' ? 'panel-tab--active' : ''}`}
                onClick={() => onRightTabChange('tools')}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight') {
                    event.preventDefault()
                    onRightTabChange(nextTab(rightTabs, rightTab, 1))
                  } else if (event.key === 'ArrowLeft') {
                    event.preventDefault()
                    onRightTabChange(nextTab(rightTabs, rightTab, -1))
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    onRightTabChange(rightTabs[0])
                  } else if (event.key === 'End') {
                    event.preventDefault()
                    onRightTabChange(rightTabs[rightTabs.length - 1])
                  }
                }}
                type="button"
                role="tab"
                aria-selected={rightTab === 'tools'}
                aria-controls="sidebar-panel-tools"
                tabIndex={rightTab === 'tools' ? 0 : -1}
              >
                Tools
              </button>
              <button
                id="sidebar-tab-ai"
                className={`panel-tab ${rightTab === 'ai' ? 'panel-tab--active' : ''}`}
                onClick={() => onRightTabChange('ai')}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowRight') {
                    event.preventDefault()
                    onRightTabChange(nextTab(rightTabs, rightTab, 1))
                  } else if (event.key === 'ArrowLeft') {
                    event.preventDefault()
                    onRightTabChange(nextTab(rightTabs, rightTab, -1))
                  } else if (event.key === 'Home') {
                    event.preventDefault()
                    onRightTabChange(rightTabs[0])
                  } else if (event.key === 'End') {
                    event.preventDefault()
                    onRightTabChange(rightTabs[rightTabs.length - 1])
                  }
                }}
                type="button"
                role="tab"
                aria-selected={rightTab === 'ai'}
                aria-controls="sidebar-panel-ai"
                tabIndex={rightTab === 'ai' ? 0 : -1}
              >
                AI Chat
              </button>
            </div>
            <div
              id={rightTab === 'operations' ? 'sidebar-panel-operations' : rightTab === 'tools' ? 'sidebar-panel-tools' : 'sidebar-panel-ai'}
              className="panel-content"
              role="tabpanel"
              aria-labelledby={
                rightTab === 'operations'
                  ? 'sidebar-tab-operations'
                  : rightTab === 'tools'
                    ? 'sidebar-tab-tools'
                    : 'sidebar-tab-ai'
              }
            >
              {rightTab === 'ai' ? (
                aiPanel
              ) : (
                camPanel ?? (
                  <div className="panel-empty">
                    CAM operations and toolpaths are scheduled for Phase 4.
                  </div>
                )
              )}
            </div>
          </section>
        </aside>

      </div>

      <footer className="app-statusbar">
        <span>{project.meta.name}</span>
        <span>{project.meta.units.toUpperCase()}</span>
        <span>
          Stock: {formatLength(stockWidth, project.meta.units)} × {formatLength(stockHeight, project.meta.units)} × {formatLength(project.stock.thickness, project.meta.units)} {project.meta.units}
        </span>
        <span>{project.grid.visible ? 'Grid Visible' : 'Grid Hidden'}</span>
        <span>{project.stock.visible ? 'Stock Visible' : 'Stock Hidden'}</span>
      </footer>
    </div>
  )
}
