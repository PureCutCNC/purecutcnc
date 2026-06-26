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

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useProjectStore } from '../../store/projectStore'
import { useLocalStorageState, type StorageCodec } from '../../hooks/useLocalStorageState'
import { getStockBounds } from '../../types/project'
import { formatLength } from '../../utils/units'
import { platform } from '../../platform'
import { loadVersion } from '../../utils/version'
import { PanelSplit } from '../cam/PanelSplit'
import { isTabletMode, useShellMode } from './useShellMode'
import { TopCommandBar } from './TopCommandBar'
import { ToolRail } from './ToolRail'
import type { SnapMode, SnapSettings } from '../../sketch/snapping'
import '../../styles/layout.css'

interface AppShellProps {
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
  rightTab: 'operations' | 'tools'
  onRightTabChange: (tab: 'operations' | 'tools') => void
  statusBarExtras?: ReactNode
  onZoomToModel: () => void
  onZoomWindow: () => void
  zoomWindowActive: boolean
  onImportComplete?: () => void
  onExportModel: () => void
  snapSettings: SnapSettings
  activeSnapMode?: SnapMode | null
  onToggleSnapEnabled: () => void
  onToggleSnapMode: (mode: SnapMode) => void
  /** Web only: open the About dialog. Desktop uses the native About menu. */
  onShowAbout?: () => void
}

function nextTab<T extends string>(tabs: readonly T[], current: T, direction: 1 | -1): T {
  const currentIndex = tabs.indexOf(current)
  const nextIndex = (currentIndex + direction + tabs.length) % tabs.length
  return tabs[nextIndex]
}

// Panel-split fractions persist as a bare number string, with the same
// `parseFloat` + (0,1) range guard the panels used inline. An out-of-range or
// non-finite stored value throws on deserialize so the hook falls back to the
// panel's default ratio.
const PANEL_RATIO_CODEC: StorageCodec<number> = {
  serialize: (ratio) => String(ratio),
  deserialize: (raw) => {
    const parsed = parseFloat(raw)
    if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) {
      throw new Error('panel ratio out of range')
    }
    return parsed
  },
}

const LC_STORAGE_KEY = 'panel-split:left-center'
const CR_STORAGE_KEY = 'panel-split:center-right'

export function AppShell({
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
  rightTab,
  onRightTabChange,
  statusBarExtras,
  onZoomToModel,
  onZoomWindow,
  zoomWindowActive,
  onImportComplete,
  onExportModel,
  snapSettings,
  activeSnapMode,
  onToggleSnapEnabled,
  onToggleSnapMode,
  onShowAbout,
}: AppShellProps) {
  const shellMode = useShellMode()
  const tabletShell = isTabletMode(shellMode)
  const [rightDrawerOpen, setRightDrawerOpen] = useState(false)
  const [leftDrawerOpen, setLeftDrawerOpen] = useState(false)
  const [statusBarExpanded, setStatusBarExpanded] = useState(false)
  const [appVersion, setAppVersion] = useState<string | null>(null)

  // Web only: surface the running version as an "About" affordance. The desktop
  // build has a native About menu, so we skip it there.
  useEffect(() => {
    if (platform.isDesktop || !onShowAbout) return
    let active = true
    loadVersion().then((v) => {
      if (active) setAppVersion(v)
    })
    return () => {
      active = false
    }
  }, [onShowAbout])

  const MIN_LEFT_WIDTH = 200
  const MIN_CENTER_WIDTH = 300
  const MIN_RIGHT_WIDTH = 200

  const [leftPanelRatio, setLeftPanelRatio] = useLocalStorageState<number>(LC_STORAGE_KEY, 0.17, {
    codec: PANEL_RATIO_CODEC,
  })

  const [rightPanelRatio, setRightPanelRatio] = useLocalStorageState<number>(CR_STORAGE_KEY, 0.265, {
    codec: PANEL_RATIO_CODEC,
  })

  const leftPanelRef = useRef<HTMLElement>(null)
  const leftRailRef = useRef<HTMLElement>(null)
  const centrePanelRef = useRef<HTMLElement>(null)
  const rightPanelRef = useRef<HTMLElement>(null)
  const activeDividerRef = useRef<{ side: 'left' | 'right'; pointerId: number } | null>(null)

  // Toggle the top/bottom fade hints on the creation rail so users can tell
  // when tool buttons are scrolled out of view.
  useEffect(() => {
    const rail = leftRailRef.current
    if (!rail) {
      return
    }
    const updateFades = () => {
      rail.classList.toggle('app-left-rail--can-scroll-up', rail.scrollTop > 1)
      rail.classList.toggle(
        'app-left-rail--can-scroll-down',
        rail.scrollTop + rail.clientHeight < rail.scrollHeight - 1,
      )
    }
    updateFades()
    rail.addEventListener('scroll', updateFades, { passive: true })
    const observer = new ResizeObserver(updateFades)
    observer.observe(rail)
    return () => {
      rail.removeEventListener('scroll', updateFades)
      observer.disconnect()
    }
  }, [])

  const showLeft = workspaceLayout === 'lcr' || workspaceLayout === 'lc'
  const showRight = workspaceLayout === 'lcr' || workspaceLayout === 'cr'
  const showDockedRight = showRight && !tabletShell

  const resizeLeftPanel = useCallback(
    (clientX: number) => {
      const leftEl = leftPanelRef.current
      const centreEl = centrePanelRef.current
      if (!leftEl || !centreEl) return
      const leftRect = leftEl.getBoundingClientRect()
      const centreRect = centreEl.getBoundingClientRect()
      const totalWidth = centreRect.right - leftRect.left
      const offsetX = clientX - leftRect.left
      const minRatio = MIN_LEFT_WIDTH / totalWidth
      const maxRatio = 1 - MIN_CENTER_WIDTH / totalWidth
      const newRatio = Math.max(minRatio, Math.min(maxRatio, offsetX / totalWidth))
      // useLocalStorageState persists leftPanelRatio to LC_STORAGE_KEY on change.
      setLeftPanelRatio(newRatio)
    },
    [setLeftPanelRatio],
  )

  const resizeRightPanel = useCallback(
    (clientX: number) => {
      const centreEl = centrePanelRef.current
      const rightEl = rightPanelRef.current
      if (!centreEl || !rightEl) return
      const centreRect = centreEl.getBoundingClientRect()
      const rightRect = rightEl.getBoundingClientRect()
      const totalWidth = rightRect.right - centreRect.left
      const offsetX = clientX - centreRect.left
      const minRatio = MIN_RIGHT_WIDTH / totalWidth
      const maxRatio = 1 - MIN_CENTER_WIDTH / totalWidth
      const newRatio = Math.max(minRatio, Math.min(maxRatio, 1 - offsetX / totalWidth))
      // useLocalStorageState persists rightPanelRatio to CR_STORAGE_KEY on change.
      setRightPanelRatio(newRatio)
    },
    [setRightPanelRatio],
  )

  const startDividerResize = useCallback((side: 'left' | 'right', e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    activeDividerRef.current = { side, pointerId: e.pointerId }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      // Window-level pointer tracking below keeps resizing working if capture is unavailable.
    }
  }, [])

  const handleLeftDividerPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (activeDividerRef.current?.side !== 'left' && !e.currentTarget.hasPointerCapture(e.pointerId)) return
      resizeLeftPanel(e.clientX)
    },
    [resizeLeftPanel],
  )

  const handleRightDividerPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (activeDividerRef.current?.side !== 'right' && !e.currentTarget.hasPointerCapture(e.pointerId)) return
      resizeRightPanel(e.clientX)
    },
    [resizeRightPanel],
  )

  useEffect(() => {
    function handleWindowPointerMove(event: PointerEvent) {
      const active = activeDividerRef.current
      if (!active || active.pointerId !== event.pointerId) return
      event.preventDefault()
      if (active.side === 'left') {
        resizeLeftPanel(event.clientX)
      } else {
        resizeRightPanel(event.clientX)
      }
    }

    function handleWindowPointerEnd(event: PointerEvent) {
      const active = activeDividerRef.current
      if (active && active.pointerId === event.pointerId) {
        activeDividerRef.current = null
      }
    }

    window.addEventListener('pointermove', handleWindowPointerMove, { passive: false })
    window.addEventListener('pointerup', handleWindowPointerEnd)
    window.addEventListener('pointercancel', handleWindowPointerEnd)
    return () => {
      window.removeEventListener('pointermove', handleWindowPointerMove)
      window.removeEventListener('pointerup', handleWindowPointerEnd)
      window.removeEventListener('pointercancel', handleWindowPointerEnd)
    }
  }, [resizeLeftPanel, resizeRightPanel])

  // left=L/(L+C), right=R/(C+R) → express as fr with centre always 1fr:
  //   L fr = leftRatio/(1-leftRatio), R fr = rightRatio/(1-rightRatio)
  const bodyStyle: React.CSSProperties = {}
  if (!tabletShell && (showLeft || showDockedRight)) {
    const railPrefix = 'var(--left-toolbar-width) '
    const leftCol = showLeft
      ? `minmax(${MIN_LEFT_WIDTH}px, ${leftPanelRatio / (1 - leftPanelRatio)}fr) `
      : ''
    const rightCol = showDockedRight
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
    <div className="app-shell" data-shell-mode={shellMode} data-right-open={rightDrawerOpen ? 'true' : undefined} data-left-open={leftDrawerOpen ? 'true' : undefined}>
      <div className="tablet-rotate-overlay" aria-hidden="true">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <rect x="4" y="2" width="16" height="20" rx="2" />
          <path d="M12 18h.01" />
        </svg>
        <span>Please rotate your device to landscape mode</span>
      </div>
      {(rightDrawerOpen || leftDrawerOpen) && (
        <div
          className="tablet-drawer-scrim"
          aria-hidden="true"
          onClick={() => { setRightDrawerOpen(false); setLeftDrawerOpen(false) }}
        />
      )}
      {/* ── Top toolbar ── */}
      {tabletShell ? (
        <header className="app-toolbar app-toolbar--tablet">
          <TopCommandBar
            centerTab={centerTab}
            onCenterTabChange={onCenterTabChange}
            onZoomToModel={onZoomToModel}
            onZoomWindow={onZoomWindow}
            zoomWindowActive={zoomWindowActive}
            onOpenLeftDrawer={() => setLeftDrawerOpen(true)}
            onOpenRightDrawer={() => setRightDrawerOpen(true)}
            onImportComplete={onImportComplete}
            onExportModel={onExportModel}
            snapSettings={snapSettings}
            activeSnapMode={activeSnapMode}
            onToggleSnapEnabled={onToggleSnapEnabled}
            onToggleSnapMode={onToggleSnapMode}
          />
        </header>
      ) : (
        <header className="app-toolbar app-toolbar--left">
          {globalToolbar}
          <button
            className="tablet-drawer-toggle toolbar-btn"
            type="button"
            title="Open operations panel"
            aria-label="Open operations panel"
            aria-expanded={rightDrawerOpen}
            onClick={() => setRightDrawerOpen(true)}
          >
            Operations{project.operations.length > 0 ? ` ${project.operations.length}` : ''}
          </button>
        </header>
      )}

      {/* Main work area */}
      <div className={`app-body app-body--${workspaceLayout} app-body--toolbar-left ${tabletShell ? 'app-body--tablet' : ''}`} style={bodyStyle}>
        {tabletShell ? (
          <aside className="app-left-rail app-left-rail--tablet" aria-label="Tools">
            <ToolRail onZoomToModel={onZoomToModel} onImportComplete={onImportComplete} />
          </aside>
        ) : (
          <aside className="app-left-rail" aria-label="Creation tools" ref={leftRailRef}>
            {creationToolbar}
          </aside>
        )}

        <aside className="panel-left" ref={leftPanelRef}>
          <PanelSplit storageKey="project-tree" initialRatio={0.55} minFirst={160} minSecond={160}>
            <section className="panel panel-tree">
              <div className="panel-header">
                <button
                  className="tablet-drawer-close tablet-drawer-close--left"
                  type="button"
                  aria-label="Close project panel"
                  onClick={() => setLeftDrawerOpen(false)}
                >
                  ✕
                </button>
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
            onPointerDown={(event) => startDividerResize('left', event)}
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
              {!tabletShell && (
                <>
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
                </>
              )}
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
          {showDockedRight && (
            <div
              className="panel-resize-divider"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={(event) => startDividerResize('right', event)}
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

      <footer className={`app-statusbar ${tabletShell ? (statusBarExpanded ? 'app-statusbar--tablet-expanded' : 'app-statusbar--tablet-compact') : ''}`}>
        <span>{project.meta.name}</span>
        <span>{project.meta.units.toUpperCase()}</span>
        <span>
          Stock: {formatLength(stockWidth, project.meta.units)} × {formatLength(stockHeight, project.meta.units)} × {formatLength(project.stock.thickness, project.meta.units)} {project.meta.units}
        </span>
        {tabletShell ? (
          <button
            type="button"
            className="statusbar-expand-btn"
            onClick={() => setStatusBarExpanded((v) => !v)}
            title={statusBarExpanded ? 'Collapse status bar' : 'Expand status bar'}
            aria-label={statusBarExpanded ? 'Collapse status bar' : 'Expand status bar'}
            aria-expanded={statusBarExpanded}
          >
            {statusBarExpanded ? '▾' : '▸'}
          </button>
        ) : null}
        <div className={`statusbar-visibility ${tabletShell && !statusBarExpanded ? 'statusbar-visibility--hidden' : ''}`} aria-label="View visibility">
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
        {!platform.isDesktop && onShowAbout && (
          <button
            className="statusbar-about"
            type="button"
            onClick={onShowAbout}
            title="About PureCutCNC"
          >
            PureCutCNC{appVersion ? ` ${appVersion}` : ''}
          </button>
        )}
        {import.meta.env.DEV && (
          <span className="statusbar-shell-mode" title="Shell mode (dev only)">{shellMode}</span>
        )}
      </footer>
    </div>
  )
}
