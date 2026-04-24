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

import { useState, type ReactNode } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { getStockBounds } from '../../types/project'
import { formatLength } from '../../utils/units'
import { PanelSplit } from '../cam/PanelSplit'
import '../../styles/layout.css'

interface AppShellProps {
  toolbar: ReactNode
  globalToolbar: ReactNode
  creationToolbar: ReactNode
  sketchCanvas: ReactNode
  featureTree: ReactNode
  propertiesPanel: ReactNode
  viewport3d: ReactNode
  simulationViewport: ReactNode
  camPanel?: ReactNode
  centerTab: 'sketch' | 'preview3d' | 'simulation'
  onCenterTabChange: (tab: 'sketch' | 'preview3d' | 'simulation') => void
  workspaceLayout: 'lcr' | 'lc' | 'c' | 'cr'
  onWorkspaceLayoutChange: (layout: 'lcr' | 'lc' | 'c' | 'cr') => void
  toolbarOrientation: 'top' | 'left'
  toolbarOrientationForced: boolean
  onToolbarOrientationChange: (orientation: 'top' | 'left') => void
  rightTab: 'operations' | 'tools'
  onRightTabChange: (tab: 'operations' | 'tools') => void
  statusBarExtras?: ReactNode
}

function nextTab<T extends string>(tabs: readonly T[], current: T, direction: 1 | -1): T {
  const currentIndex = tabs.indexOf(current)
  const nextIndex = (currentIndex + direction + tabs.length) % tabs.length
  return tabs[nextIndex]
}

export function AppShell({
  toolbar,
  globalToolbar,
  creationToolbar,
  sketchCanvas,
  featureTree,
  propertiesPanel,
  viewport3d,
  simulationViewport,
  camPanel,
  centerTab,
  onCenterTabChange,
  workspaceLayout,
  onWorkspaceLayoutChange,
  toolbarOrientation,
  toolbarOrientationForced,
  onToolbarOrientationChange,
  rightTab,
  onRightTabChange,
  statusBarExtras,
}: AppShellProps) {
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false)
  const { project } = useProjectStore()
  const stockBounds = getStockBounds(project.stock)
  const stockWidth = stockBounds.maxX - stockBounds.minX
  const stockHeight = stockBounds.maxY - stockBounds.minY
  const centerTabs = ['sketch', 'preview3d', 'simulation'] as const
  const rightTabs = ['operations', 'tools'] as const
  const workspaceLayouts = [
    { id: 'lcr', label: 'Show left, center, and right panels' },
    { id: 'lc', label: 'Show left and center panels' },
    { id: 'c', label: 'Show center panel only' },
    { id: 'cr', label: 'Show center and right panels' },
  ] as const

  return (
    <div className="app-shell" data-right-open={rightDrawerOpen ? 'true' : undefined}>
      {rightDrawerOpen && (
        <div
          className="tablet-drawer-scrim"
          aria-hidden="true"
          onClick={() => setRightDrawerOpen(false)}
        />
      )}
      {/* ── Top toolbar ── */}
      <header className={`app-toolbar app-toolbar--${toolbarOrientation}`}>
        {toolbarOrientation === 'left' ? globalToolbar : toolbar}
        <button
          className="tablet-drawer-toggle toolbar-btn"
          type="button"
          title="Open operations panel"
          aria-label="Open operations panel"
          aria-expanded={rightDrawerOpen}
          onClick={() => setRightDrawerOpen(true)}
        >
          CAM
        </button>
      </header>

      {/* Main work area */}
      <div className={`app-body app-body--${workspaceLayout} app-body--toolbar-${toolbarOrientation}`}>
        {toolbarOrientation === 'left' ? (
          <aside className="app-left-rail" aria-label="Creation tools">
            {creationToolbar}
          </aside>
        ) : null}

        <aside className="panel-left">
          <PanelSplit storageKey="project-tree" initialRatio={0.55} minFirst={160} minSecond={160}>
            <section className="panel panel-tree">
              <div className="panel-header">
                Project Tree
                <span className="feature-count">
                  {project.features.length + project.featureFolders.length + project.tabs.length + project.clamps.length + 6}
                </span>
              </div>
              <div className="panel-content">{featureTree}</div>
            </section>
            <section className="panel panel-properties">
              <div className="panel-header">Properties</div>
              <div className="panel-content">{propertiesPanel}</div>
            </section>
          </PanelSplit>
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
              <button
                id="workspace-tab-simulation"
                className={`panel-tab ${centerTab === 'simulation' ? 'panel-tab--active' : ''}`}
                onClick={() => onCenterTabChange('simulation')}
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
                aria-selected={centerTab === 'simulation'}
                aria-controls="workspace-panel-simulation"
                tabIndex={centerTab === 'simulation' ? 0 : -1}
              >
                Simulation
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
              <div className="toolbar-orientation-controls" aria-label="Toolbar orientation">
                <button
                  className={`toolbar-orientation-btn ${toolbarOrientation === 'top' ? 'toolbar-orientation-btn--active' : ''}`}
                  type="button"
                  title="Use top toolbar"
                  aria-label="Use top toolbar"
                  onClick={() => onToolbarOrientationChange('top')}
                >
                  <span className="toolbar-orientation-icon toolbar-orientation-icon--top" aria-hidden="true">
                    <span />
                    <span />
                  </span>
                </button>
                <button
                  className={`toolbar-orientation-btn ${toolbarOrientation === 'left' ? 'toolbar-orientation-btn--active' : ''}`}
                  type="button"
                  title={toolbarOrientationForced ? 'Left toolbar is disabled below 920px wide' : 'Use left toolbar'}
                  aria-label={toolbarOrientationForced ? 'Left toolbar is disabled below 920px wide' : 'Use left toolbar'}
                  onClick={() => onToolbarOrientationChange('left')}
                  disabled={toolbarOrientationForced}
                >
                  <span className="toolbar-orientation-icon toolbar-orientation-icon--left" aria-hidden="true">
                    <span />
                    <span />
                  </span>
                </button>
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
              <div
                id="workspace-panel-simulation"
                className={`centre-view ${centerTab === 'simulation' ? 'centre-view--active' : ''}`}
                role="tabpanel"
                aria-labelledby="workspace-tab-simulation"
                aria-hidden={centerTab !== 'simulation'}
              >
                {simulationViewport}
              </div>
            </div>
          </div>
        </main>

        <aside className="panel-right" aria-label="CAM panel">
          <section className="panel panel-tabs">
            <div className="panel-tabs-header" role="tablist" aria-label="Right Sidebar">
              <button
                className="tablet-drawer-close"
                type="button"
                aria-label="Close operations panel"
                onClick={() => setRightDrawerOpen(false)}
              >
                ✕
              </button>
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
            </div>
            <div
              id={rightTab === 'operations' ? 'sidebar-panel-operations' : 'sidebar-panel-tools'}
              className="panel-content"
              role="tabpanel"
              aria-labelledby={
                rightTab === 'operations'
                  ? 'sidebar-tab-operations'
                  : 'sidebar-tab-tools'
              }
            >
              {camPanel ?? (
                <div className="panel-empty">
                  CAM operations and toolpaths are scheduled for Phase 4.
                </div>
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
        {statusBarExtras}
      </footer>
    </div>
  )
}
