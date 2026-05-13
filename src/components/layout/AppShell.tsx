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

import { useCallback, useRef, useState, type ReactNode } from 'react'
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

  const LC_STORAGE_KEY = 'panel-split:left-center'
  const CR_STORAGE_KEY = 'panel-split:center-right'
  const MIN_LEFT_WIDTH = 200
  const MIN_CENTER_WIDTH = 300
  const MIN_RIGHT_WIDTH = 200

  const [leftPanelRatio, setLeftPanelRatio] = useState<number>(() => {
    const stored = localStorage.getItem(LC_STORAGE_KEY)
    if (stored !== null) {
      const parsed = parseFloat(stored)
      if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) return parsed
    }
    return 0.17
  })

  const [rightPanelRatio, setRightPanelRatio] = useState<number>(() => {
    const stored = localStorage.getItem(CR_STORAGE_KEY)
    if (stored !== null) {
      const parsed = parseFloat(stored)
      if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) return parsed
    }
    return 0.265
  })

  const leftPanelRef = useRef<HTMLElement>(null)
  const centrePanelRef = useRef<HTMLElement>(null)
  const rightPanelRef = useRef<HTMLElement>(null)

  const showLeft = workspaceLayout === 'lcr' || workspaceLayout === 'lc'
  const showRight = workspaceLayout === 'lcr' || workspaceLayout === 'cr'

  const handleDividerPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
  }, [])

  const handleLeftDividerPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      const leftEl = leftPanelRef.current
      const centreEl = centrePanelRef.current
      if (!leftEl || !centreEl) return
      const leftRect = leftEl.getBoundingClientRect()
      const centreRect = centreEl.getBoundingClientRect()
      const totalWidth = centreRect.right - leftRect.left
      const offsetX = e.clientX - leftRect.left
      const minRatio = MIN_LEFT_WIDTH / totalWidth
      const maxRatio = 1 - MIN_CENTER_WIDTH / totalWidth
      const newRatio = Math.max(minRatio, Math.min(maxRatio, offsetX / totalWidth))
      setLeftPanelRatio(newRatio)
      localStorage.setItem(LC_STORAGE_KEY, String(newRatio))
    },
    [],
  )

  const handleRightDividerPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      const centreEl = centrePanelRef.current
      const rightEl = rightPanelRef.current
      if (!centreEl || !rightEl) return
      const centreRect = centreEl.getBoundingClientRect()
      const rightRect = rightEl.getBoundingClientRect()
      const totalWidth = rightRect.right - centreRect.left
      const offsetX = e.clientX - centreRect.left
      const minRatio = MIN_RIGHT_WIDTH / totalWidth
      const maxRatio = 1 - MIN_CENTER_WIDTH / totalWidth
      const newRatio = Math.max(minRatio, Math.min(maxRatio, 1 - offsetX / totalWidth))
      setRightPanelRatio(newRatio)
      localStorage.setItem(CR_STORAGE_KEY, String(newRatio))
    },
    [],
  )

  // left=L/(L+C), right=R/(C+R) → express as fr with centre always 1fr:
  //   L fr = leftRatio/(1-leftRatio), R fr = rightRatio/(1-rightRatio)
  const bodyStyle: React.CSSProperties = {}
  if (showLeft || showRight) {
    const railPrefix = toolbarOrientation === 'left' ? 'var(--left-toolbar-width) ' : ''
    const leftCol = showLeft
      ? `minmax(${MIN_LEFT_WIDTH}px, ${leftPanelRatio / (1 - leftPanelRatio)}fr) `
      : ''
    const rightCol = showRight
      ? ` minmax(${MIN_RIGHT_WIDTH}px, ${rightPanelRatio / (1 - rightPanelRatio)}fr)`
      : ''
    bodyStyle.gridTemplateColumns = `${railPrefix}${leftCol}minmax(${MIN_CENTER_WIDTH}px, 1fr)${rightCol}`
  }

  const {
    project,
    setGrid,
    setStock,
    setOrigin,
    updateBackdrop,
    setAllRegionsVisible,
    setAllTabsVisible,
    setAllClampsVisible,
  } = useProjectStore()
  const stockBounds = getStockBounds(project.stock)
  const stockWidth = stockBounds.maxX - stockBounds.minX
  const stockHeight = stockBounds.maxY - stockBounds.minY
  const regionCount = project.features.filter((feature) => feature.operation === 'region').length
  const anyRegionsVisible = project.features.some((feature) => feature.operation === 'region' && feature.visible)
  const anyTabsVisible = project.tabs.some((tab) => tab.visible)
  const anyClampsVisible = project.clamps.some((clamp) => clamp.visible)
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
      <div className={`app-body app-body--${workspaceLayout} app-body--toolbar-${toolbarOrientation}`} style={bodyStyle}>
        {toolbarOrientation === 'left' ? (
          <aside className="app-left-rail" aria-label="Creation tools">
            {creationToolbar}
          </aside>
        ) : null}

        <aside className="panel-left" ref={leftPanelRef}>
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
          <div
            className="panel-resize-divider"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={handleDividerPointerDown}
            onPointerMove={handleLeftDividerPointerMove}
          />
        </aside>

        <main className="panel-centre" ref={centrePanelRef}>
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
          {showRight && (
            <div
              className="panel-resize-divider"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleRightDividerPointerMove}
            />
          )}
        </main>

        <aside className="panel-right" ref={rightPanelRef} aria-label="CAM panel">
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
        <div className="statusbar-visibility" aria-label="View visibility">
          <button
            className={`statusbar-toggle ${project.grid.visible ? 'statusbar-toggle--active' : ''}`}
            type="button"
            aria-pressed={project.grid.visible}
            title={project.grid.visible ? 'Hide grid' : 'Show grid'}
            onClick={() => setGrid({ ...project.grid, visible: !project.grid.visible })}
          >
            Grid
          </button>
          <button
            className={`statusbar-toggle ${project.stock.visible ? 'statusbar-toggle--active' : ''}`}
            type="button"
            aria-pressed={project.stock.visible}
            title={project.stock.visible ? 'Hide stock' : 'Show stock'}
            onClick={() => setStock({ ...project.stock, visible: !project.stock.visible })}
          >
            Stock
          </button>
          <button
            className={`statusbar-toggle ${project.backdrop?.visible ? 'statusbar-toggle--active' : ''}`}
            type="button"
            aria-pressed={project.backdrop?.visible ?? false}
            disabled={!project.backdrop}
            title={!project.backdrop ? 'No backdrop loaded' : project.backdrop.visible ? 'Hide backdrop' : 'Show backdrop'}
            onClick={() => {
              if (project.backdrop) updateBackdrop({ visible: !project.backdrop.visible })
            }}
          >
            Backdrop
          </button>
          <button
            className={`statusbar-toggle ${project.origin.visible ? 'statusbar-toggle--active' : ''}`}
            type="button"
            aria-pressed={project.origin.visible}
            title={project.origin.visible ? 'Hide origin' : 'Show origin'}
            onClick={() => setOrigin({ ...project.origin, visible: !project.origin.visible })}
          >
            Origin
          </button>
          <button
            className={`statusbar-toggle ${anyRegionsVisible ? 'statusbar-toggle--active' : ''}`}
            type="button"
            aria-pressed={anyRegionsVisible}
            disabled={regionCount === 0}
            title={regionCount === 0 ? 'No regions in project' : anyRegionsVisible ? 'Hide regions' : 'Show regions'}
            onClick={() => setAllRegionsVisible(!anyRegionsVisible)}
          >
            Regions
          </button>
          <button
            className={`statusbar-toggle ${anyTabsVisible ? 'statusbar-toggle--active' : ''}`}
            type="button"
            aria-pressed={anyTabsVisible}
            disabled={project.tabs.length === 0}
            title={project.tabs.length === 0 ? 'No tabs in project' : anyTabsVisible ? 'Hide tabs' : 'Show tabs'}
            onClick={() => setAllTabsVisible(!anyTabsVisible)}
          >
            Tabs
          </button>
          <button
            className={`statusbar-toggle ${anyClampsVisible ? 'statusbar-toggle--active' : ''}`}
            type="button"
            aria-pressed={anyClampsVisible}
            disabled={project.clamps.length === 0}
            title={project.clamps.length === 0 ? 'No clamps in project' : anyClampsVisible ? 'Hide clamps' : 'Show clamps'}
            onClick={() => setAllClampsVisible(!anyClampsVisible)}
          >
            Clamps
          </button>
        </div>
        {statusBarExtras}
      </footer>
    </div>
  )
}
