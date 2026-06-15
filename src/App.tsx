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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useTransition } from 'react'
import { CAMPanel } from './components/cam/CAMPanel'
import { validQuickOperationsForFeature, type QuickOperation } from './components/cam/operationValidity'
import { loadBundledToolLibrary } from './toolLibrary'
import { SketchCanvas, type SketchCanvasHandle } from './components/canvas/SketchCanvas'
import type { OperationKind } from './types/project'
import { FeatureTree } from './components/feature-tree/FeatureTree'
import { PropertiesPanel } from './components/feature-tree/PropertiesPanel'
import { AppShell } from './components/layout/AppShell'
import { isTabletMode, useShellMode } from './components/layout/useShellMode'
import { CreationToolbar, GlobalToolbar } from './components/layout/Toolbar'
import { SimulationViewport, type SimulationViewportHandle } from './components/simulation/SimulationViewport'
import { Viewport3D, type Viewport3DHandle } from './components/viewport3d/Viewport3D'
import { type ToolpathVisibility, DEFAULT_TOOLPATH_VISIBILITY } from './components/toolpathVisibility'
import { ExportDialog } from './components/export/ExportDialog'
import { ModelExportDialog } from './components/export/ModelExportDialog'
import { NewProjectDialog } from './components/project/NewProjectDialog'
import { ImportGeometryDialog } from './components/project/ImportGeometryDialog'
import { EmptyStateOverlay } from './components/onboarding/EmptyStateOverlay'
import { AboutDialog } from './components/about/AboutDialog'
import { DEFAULT_SNAP_SETTINGS, SNAP_SETTINGS_STORAGE_KEY, type SnapMode, type SnapSettings, normalizeSnapSettings } from './sketch/snapping'
import { useProjectStore } from './store/projectStore'
import { useDesktopIntegration } from './platform/useDesktopIntegration'
import { useLocalStorageState } from './hooks/useLocalStorageState'
import { useOutsideDismiss } from './hooks/useOutsideDismiss'
import { useToolpathGeneration } from './app/useToolpathGeneration'
import { useSimulationModel } from './app/useSimulationModel'

interface TreeContextMenuState {
  entityType: 'feature' | 'tab' | 'clamp'
  ids: string[]
  primaryId: string
  x: number
  y: number
}

interface MenuPosition {
  left: number
  top: number
}

const DEPTH_LEGEND_COLLAPSED_STORAGE_KEY = 'camcam.depthLegendCollapsed'

// Persist the depth-legend collapsed flag as the literal "true"/"false" string
// the previous hand-rolled site wrote (`String(bool)` / `=== 'true'`), not JSON,
// so existing stored values keep working unchanged.
const DEPTH_LEGEND_CODEC = {
  serialize: (collapsed: boolean): string => String(collapsed),
  deserialize: (raw: string): boolean => raw === 'true',
}

// Snap settings persist as JSON, run through normalizeSnapSettings on read so a
// stored value from an older schema is upgraded; a parse failure falls back to
// DEFAULT_SNAP_SETTINGS via the hook's deserialize-error handling.
const SNAP_SETTINGS_CODEC = {
  serialize: (settings: SnapSettings): string => JSON.stringify(settings),
  deserialize: (raw: string): SnapSettings => normalizeSnapSettings(JSON.parse(raw)),
}

const CONTEXT_MENU_VIEWPORT_PADDING = 8
const CONTEXT_MENU_INITIAL_WIDTH = 188
const CONTEXT_MENU_INITIAL_HEIGHT = 300

function clampMenuPosition(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): MenuPosition {
  const minLeft = CONTEXT_MENU_VIEWPORT_PADDING
  const minTop = CONTEXT_MENU_VIEWPORT_PADDING
  const maxLeft = Math.max(minLeft, viewportWidth - menuWidth - CONTEXT_MENU_VIEWPORT_PADDING)
  const maxTop = Math.max(minTop, viewportHeight - menuHeight - CONTEXT_MENU_VIEWPORT_PADDING)

  return {
    left: Math.min(Math.max(x, minLeft), maxLeft),
    top: Math.min(Math.max(y, minTop), maxTop),
  }
}

function App() {
  const [centerTab, setCenterTab] = useState<'sketch' | 'preview3d' | 'simulation'>('sketch')
  const [rightTab, setRightTab] = useState<'operations' | 'tools'>('operations')
  const [workspaceLayout, setWorkspaceLayout] = useState<'lcr' | 'lc' | 'c' | 'cr'>('lcr')
  const [treeContextMenu, setTreeContextMenu] = useState<TreeContextMenuState | null>(null)
  const [menuPosition, setMenuPosition] = useState<MenuPosition | null>(null)
  const [quickOpsSubmenu, setQuickOpsSubmenu] = useState<{ top: number; left: number; side: 'right' | 'left' } | null>(null)
  const tabletShell = isTabletMode(useShellMode())
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null)
  const [simulationDetailCells, setSimulationDetailCells] = useState(280)
  const [isSimulationPending, startSimulationTransition] = useTransition()
  const [simulationMode, setSimulationMode] = useState<'selected' | 'visible'>('selected')
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [showModelExportDialog, setShowModelExportDialog] = useState(false)
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  // The empty-state overlay is a one-time nudge per project. Once the user has
  // engaged (started any draw, opened import, or the project has features), it
  // stays dismissed — so cancelling a draw or deleting the last feature keeps
  // them on the sketch view instead of popping the overlay back up.
  const [emptyStateEngaged, setEmptyStateEngaged] = useState(false)
  const [showAboutDialog, setShowAboutDialog] = useState(false)
  const [zoomWindowActive, setZoomWindowActive] = useState(false)
  const [toolpathVisibility, setToolpathVisibility] = useState<ToolpathVisibility>(DEFAULT_TOOLPATH_VISIBILITY)
  // A1.3: operation kind armed in the CAM "Add operation" menu (on hover), so the
  // sketch canvas can highlight the features that operation could act on.
  const [operationHighlightKind, setOperationHighlightKind] = useState<OperationKind | null>(null)

  // Native menu "New" dispatches this after the dirty check — handled once here
  // rather than in each toolbar variant (GlobalToolbar / CreationToolbar / Toolbar).
  useEffect(() => {
    function handleMenuNew() { setShowNewProjectDialog(true) }
    window.addEventListener('purecutcnc:new-project', handleMenuNew)
    return () => window.removeEventListener('purecutcnc:new-project', handleMenuNew)
  }, [])

  const handleExportGcode = useCallback(() => setShowExportDialog(true), [])
  useDesktopIntegration({ onExportGcode: handleExportGcode })
  const [activeSnapMode, setActiveSnapMode] = useState<SnapMode | null>(null)
  const [depthLegendCollapsed, setDepthLegendCollapsed] = useLocalStorageState<boolean>(
    DEPTH_LEGEND_COLLAPSED_STORAGE_KEY,
    false,
    { codec: DEPTH_LEGEND_CODEC },
  )
  const [snapSettings, setSnapSettings] = useLocalStorageState<SnapSettings>(
    SNAP_SETTINGS_STORAGE_KEY,
    DEFAULT_SNAP_SETTINGS,
    { codec: SNAP_SETTINGS_CODEC },
  )
  const sketchCanvasRef = useRef<SketchCanvasHandle>(null)
  const viewport3dRef = useRef<Viewport3DHandle>(null)
  const simulationViewportRef = useRef<SimulationViewportHandle>(null)
  const hasAutoFramed3DRef = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const {
    project,
    projectKey,
    projectLoading,
    selection,
    selectFeature,
    enterSketchEdit,
    enterTabEdit,
    enterClampEdit,
    deleteFeatures,
    deleteTab,
    deleteClamp,
    startMoveFeature,
    startCopyFeature,
    startResizeFeature,
    startRotateFeature,
    startMirrorFeature,
    startOffsetSelectedFeatures,
    startJoinSelectedFeatures,
    startCutSelectedFeatures,
    beginConstraint,
    startMoveTab,
    startCopyTab,
    startMoveClamp,
    startCopyClamp,
    setStockSourceFeature,
    addOperation,
    startAddRectPlacement,
    pendingAdd,
  } = useProjectStore()

  const menuFeature = useMemo(
    () =>
      treeContextMenu?.entityType === 'feature'
        ? project.features.find((feature) => feature.id === treeContextMenu.primaryId) ?? null
        : null,
    [treeContextMenu, project.features]
  )

  const menuClamp = useMemo(
    () =>
      treeContextMenu?.entityType === 'clamp'
        ? project.clamps.find((clamp) => clamp.id === treeContextMenu.primaryId) ?? null
        : null,
    [treeContextMenu, project.clamps]
  )

  const menuTab = useMemo(
    () =>
      treeContextMenu?.entityType === 'tab'
        ? project.tabs.find((tab) => tab.id === treeContextMenu.primaryId) ?? null
        : null,
    [treeContextMenu, project.tabs]
  )

  const menuQuickOperations = useMemo<QuickOperation[]>(
    () =>
      menuFeature && (treeContextMenu?.ids.length ?? 1) <= 1
        ? validQuickOperationsForFeature(project, menuFeature.id)
        : [],
    [menuFeature, treeContextMenu, project]
  )

  const effectiveSelectedOperationId =
    selectedOperationId && project.operations.some((operation) => operation.id === selectedOperationId)
      ? selectedOperationId
      : null

  const selectedOperation = useMemo(
    () => project.operations.find((operation) => operation.id === effectiveSelectedOperationId) ?? null,
    [effectiveSelectedOperationId, project.operations]
  )

  const visibleClamps = useMemo(
    () => project.clamps.filter((clamp) => clamp.visible),
    [project.clamps]
  )

  const selectedClampId =
    selection.selectedNode?.type === 'clamp'
      ? selection.selectedNode.clampId
      : null

  const handleCenterTabChange = useCallback(
    (tab: 'sketch' | 'preview3d' | 'simulation') => {
      if (tab === 'simulation') {
        startSimulationTransition(() => setCenterTab(tab))
      } else {
        setCenterTab(tab)
      }
    },
    [startSimulationTransition]
  )

  // Selecting a different operation while the simulation tab is active drives
  // the heavy simulationResult/playbackInput recompute. Wrapping in a
  // transition shows the existing isComputing spinner; in other views the
  // selection is cheap so we don't pay the transition overhead.
  const handleSelectedOperationIdChange = useCallback(
    (id: string | null) => {
      if (centerTab === 'simulation') {
        startSimulationTransition(() => setSelectedOperationId(id))
      } else {
        setSelectedOperationId(id)
      }
    },
    [centerTab, startSimulationTransition],
  )

  const {
    toolpathMap,
    generateToolpathForOperation,
    generatingOperationIds,
    selectedToolpath,
    visibleToolpaths,
    collidingClampIds,
  } = useToolpathGeneration(project, selectedOperation)
  void toolpathMap

  const { simulationResult, simulationOperationCount, simulationPlaybackInput } = useSimulationModel({
    project,
    centerTab,
    simulationMode,
    simulationDetailCells,
    selectedOperation,
    selectedToolpath,
    generateToolpathForOperation,
  })

  useEffect(() => {
    if (centerTab !== 'preview3d' || hasAutoFramed3DRef.current) {
      return
    }

    let frame1 = 0
    let frame2 = 0
    frame1 = window.requestAnimationFrame(() => {
      frame2 = window.requestAnimationFrame(() => {
        viewport3dRef.current?.zoomToModel()
        hasAutoFramed3DRef.current = true
      })
    })

    return () => {
      window.cancelAnimationFrame(frame1)
      window.cancelAnimationFrame(frame2)
    }
  }, [centerTab])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null
      if (
        target instanceof HTMLInputElement
        || target instanceof HTMLTextAreaElement
        || target instanceof HTMLSelectElement
        || target?.isContentEditable
      ) {
        return
      }

      const isPrimaryModifier = event.metaKey || event.ctrlKey
      if (!isPrimaryModifier) {
        return
      }

      if (event.key.toLowerCase() === 'a') {
        event.preventDefault()
        const { project, selectFeatures } = useProjectStore.getState()
        selectFeatures(project.features.filter((f) => f.visible).map((f) => f.id))
        return
      }

      if (event.key.toLowerCase() === 'z' && !event.shiftKey) {
        event.preventDefault()
        useProjectStore.getState().undo()
        return
      }

      if (
        (event.key.toLowerCase() === 'z' && event.shiftKey)
        || (event.ctrlKey && !event.metaKey && event.key.toLowerCase() === 'y')
      ) {
        event.preventDefault()
        useProjectStore.getState().redo()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    if (!zoomWindowActive) {
      return
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setZoomWindowActive(false)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [zoomWindowActive])

  useOutsideDismiss({
    open: treeContextMenu !== null,
    refs: menuRef,
    target: 'window',
    onDismiss: () => {
      setTreeContextMenu(null)
      setMenuPosition(null)
      setQuickOpsSubmenu(null)
    },
  })

  function handleZoomToModel() {
    if (centerTab === 'preview3d') {
      viewport3dRef.current?.zoomToModel()
      return
    }

    if (centerTab === 'simulation') {
      simulationViewportRef.current?.zoomToModel()
      return
    }

    sketchCanvasRef.current?.zoomToModel()
  }

  function handleImportComplete() {
    setCenterTab('sketch')
    window.requestAnimationFrame(() => {
      sketchCanvasRef.current?.zoomToModel()
    })
  }

  function handleZoomWindow() {
    setZoomWindowActive((previous) => !previous)
  }

  function handleToggleSnapEnabled() {
    setSnapSettings((previous) => ({ ...previous, enabled: !previous.enabled }))
  }

  function handleToggleSnapMode(mode: SnapMode) {
    setSnapSettings((previous) => {
      const modes = previous.modes.includes(mode)
        ? previous.modes.filter((entry) => entry !== mode)
        : [...previous.modes, mode]
      return { ...previous, modes }
    })
  }

  function openFeatureContextMenu(featureId: string, x: number, y: number) {
    const nextSelection = useProjectStore.getState().selection
    const featureIds = nextSelection.selectedFeatureIds.includes(featureId)
      ? nextSelection.selectedFeatureIds
      : [featureId]
    setMenuPosition(null)
    setTreeContextMenu({ entityType: 'feature', ids: featureIds, primaryId: featureId, x, y })
  }

  function openClampContextMenu(clampId: string, x: number, y: number) {
    setMenuPosition(null)
    setTreeContextMenu({ entityType: 'clamp', ids: [clampId], primaryId: clampId, x, y })
  }

  function openTabContextMenu(tabId: string, x: number, y: number) {
    setMenuPosition(null)
    setTreeContextMenu({ entityType: 'tab', ids: [tabId], primaryId: tabId, x, y })
  }

  function closeTreeContextMenu() {
    setTreeContextMenu(null)
    setMenuPosition(null)
    setQuickOpsSubmenu(null)
  }

  function openQuickOpsSubmenu(trigger: HTMLElement) {
    const rect = trigger.getBoundingClientRect()
    const openLeft = rect.right + 200 > window.innerWidth
    setQuickOpsSubmenu({
      top: rect.top,
      left: openLeft ? rect.left : rect.right,
      side: openLeft ? 'left' : 'right',
    })
  }

  function handleEditSketch(featureId: string) {
    selectFeature(featureId)
    enterSketchEdit(featureId)
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  async function handleCreateQuickOperation(featureId: string, quickOp: QuickOperation) {
    closeTreeContextMenu()
    // Load the bundled library so addOperation can auto-pick/import a proper tool.
    const libraryTools = await loadBundledToolLibrary().then((library) => library.tools).catch(() => [])
    const operationId = addOperation(quickOp.kind, quickOp.pass, { source: 'features', featureIds: [featureId] }, libraryTools)
    if (!operationId) {
      return
    }
    setRightTab('operations')
    handleSelectedOperationIdChange(operationId)
  }

  function frameOpenedProject() {
    hasAutoFramed3DRef.current = false
    setCenterTab('sketch')
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        sketchCanvasRef.current?.zoomToModel()
      })
    })
  }

  function handleEmptyStateDraw() {
    setCenterTab('sketch')
    setEmptyStateEngaged(true)
    startAddRectPlacement()
  }

  function handleEmptyStateImport() {
    setEmptyStateEngaged(true)
    setShowImportDialog(true)
  }

  // Reset the one-time empty-state nudge for each new/opened project.
  useEffect(() => {
    setEmptyStateEngaged(false)
  }, [projectKey])

  // Latch engagement once the project has any feature or a draw is in progress
  // (covers toolbar draws too), so the overlay doesn't reappear after a cancel
  // or after deleting the last feature.
  useEffect(() => {
    if (project.features.length > 0 || pendingAdd) {
      setEmptyStateEngaged(true)
    }
  }, [project.features.length, pendingAdd])

  function handleEditClamp(clampId: string) {
    enterClampEdit(clampId)
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  function handleEditTab(tabId: string) {
    enterTabEdit(tabId)
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  function handleDeleteFeatures(featureIds: string[]) {
    deleteFeatures(featureIds)
    closeTreeContextMenu()
  }

  function handleMoveFeature(featureId: string) {
    startMoveFeature(featureId)
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  function handleCopyFeature(featureId: string) {
    startCopyFeature(featureId)
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  function handleResizeFeature(featureId: string) {
    startResizeFeature(featureId)
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  function handleRotateFeature(featureId: string) {
    startRotateFeature(featureId)
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  function handleMirrorFeature(featureId: string) {
    startMirrorFeature(featureId)
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  function handleOffsetFeatures() {
    startOffsetSelectedFeatures()
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  function handleJoinFeatures() {
    startJoinSelectedFeatures()
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  function handleCutFeatures() {
    startCutSelectedFeatures()
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  function handleConstraint(featureId: string) {
    selectFeature(featureId)
    enterSketchEdit(featureId)
    beginConstraint(featureId)
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  function handleDeleteClamp(clampId: string) {
    deleteClamp(clampId)
    closeTreeContextMenu()
  }

  function handleDeleteTab(tabId: string) {
    deleteTab(tabId)
    closeTreeContextMenu()
  }

  function handleMoveClamp(clampId: string) {
    startMoveClamp(clampId)
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  function handleMoveTab(tabId: string) {
    startMoveTab(tabId)
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  function handleCopyClamp(clampId: string) {
    startCopyClamp(clampId)
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  function handleCopyTab(tabId: string) {
    startCopyTab(tabId)
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

  const menuHasMultipleSelection = treeContextMenu?.entityType === 'feature' && (treeContextMenu?.ids.length ?? 0) > 1
  const menuCanUseAsStock =
    treeContextMenu?.entityType === 'feature' &&
    !menuHasMultipleSelection &&
    menuFeature !== null &&
    menuFeature.operation === 'add' &&
    menuFeature.sketch.profile.closed === true &&
    menuFeature.kind !== 'text' &&
    menuFeature.kind !== 'stl'
  const menuHasLockedSelection =
    treeContextMenu?.entityType === 'feature' && (treeContextMenu?.ids.some((featureId) =>
      project.features.some((feature) => feature.id === featureId && feature.locked)
    ) ?? false)
  const fallbackMenuPosition = treeContextMenu
    ? clampMenuPosition(
        treeContextMenu.x,
        treeContextMenu.y,
        CONTEXT_MENU_INITIAL_WIDTH,
        CONTEXT_MENU_INITIAL_HEIGHT,
        window.innerWidth,
        window.innerHeight,
      )
    : null
  const resolvedMenuPosition = menuPosition ?? fallbackMenuPosition

  const updateTreeContextMenuPosition = useCallback(() => {
    if (!treeContextMenu || !menuRef.current) {
      return
    }

    const rect = menuRef.current.getBoundingClientRect()
    const nextPosition = clampMenuPosition(
      treeContextMenu.x,
      treeContextMenu.y,
      rect.width,
      rect.height,
      window.innerWidth,
      window.innerHeight,
    )
    setMenuPosition((previous) => (
      previous?.left === nextPosition.left && previous.top === nextPosition.top
        ? previous
        : nextPosition
    ))
  }, [treeContextMenu])

  useLayoutEffect(() => {
    updateTreeContextMenuPosition()
  }, [
    updateTreeContextMenuPosition,
    menuFeature,
    menuTab,
    menuClamp,
    menuHasMultipleSelection,
    menuCanUseAsStock,
    menuHasLockedSelection,
  ])

  useEffect(() => {
    if (!treeContextMenu) {
      return
    }

    window.addEventListener('resize', updateTreeContextMenuPosition)
    return () => window.removeEventListener('resize', updateTreeContextMenuPosition)
  }, [treeContextMenu, updateTreeContextMenuPosition])

  const collapsedDepthLegend = centerTab === 'sketch' && depthLegendCollapsed ? (
    <button
      className="statusbar-depth-legend"
      type="button"
      onClick={() => setDepthLegendCollapsed(false)}
      title="Expand feature color legend"
      aria-label="Expand feature color legend"
    >
      <span className="statusbar-depth-legend__label">Feature Colors</span>
      <span className="statusbar-depth-legend__swatches" aria-hidden="true">
        <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--subtract-shallow" />
        <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--subtract-deep" />
        <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--add" />
        <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--region" />
        <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--imported-model" />
        <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--selected" />
      </span>
    </button>
  ) : null

  return (
    <>
      <AppShell
        globalToolbar={
          <GlobalToolbar
            onZoomToModel={handleZoomToModel}
            onZoomWindow={handleZoomWindow}
            zoomWindowActive={zoomWindowActive}
            onImportComplete={handleImportComplete}
            onExportModel={() => setShowModelExportDialog(true)}
            snapSettings={snapSettings}
            activeSnapMode={activeSnapMode}
            onToggleSnapEnabled={handleToggleSnapEnabled}
            onToggleSnapMode={handleToggleSnapMode}
          />
        }
        creationToolbar={
          <CreationToolbar
            onZoomToModel={handleZoomToModel}
            layout="vertical"
          />
        }
        sketchCanvas={
          <>
            <SketchCanvas
              ref={sketchCanvasRef}
              onFeatureContextMenu={openFeatureContextMenu}
              onTabContextMenu={openTabContextMenu}
              onClampContextMenu={openClampContextMenu}
              toolpaths={visibleToolpaths}
              selectedOperationId={effectiveSelectedOperationId}
              collidingClampIds={collidingClampIds}
              snapSettings={snapSettings}
              zoomWindowActive={zoomWindowActive && centerTab === 'sketch'}
              onZoomWindowComplete={() => setZoomWindowActive(false)}
              onActiveSnapModeChange={setActiveSnapMode}
              depthLegendCollapsed={depthLegendCollapsed}
              onToggleDepthLegend={() => setDepthLegendCollapsed((value) => !value)}
              toolpathVisibility={toolpathVisibility}
              onToolpathVisibilityChange={setToolpathVisibility}
              operationHighlightKind={operationHighlightKind}
            />
            {project.features.length === 0 && !pendingAdd && !emptyStateEngaged ? (
              <EmptyStateOverlay
                onDraw={handleEmptyStateDraw}
                onImport={handleEmptyStateImport}
                onExampleOpened={frameOpenedProject}
              />
            ) : null}
          </>
        }
        viewport3d={
          <Viewport3D
            ref={viewport3dRef}
            toolpaths={visibleToolpaths}
            selectedOperationId={effectiveSelectedOperationId}
            collidingClampIds={collidingClampIds}
            originVisible={project.origin.visible}
            zoomWindowActive={zoomWindowActive && centerTab === 'preview3d'}
            onZoomWindowComplete={() => setZoomWindowActive(false)}
            toolpathVisibility={toolpathVisibility}
            onToolpathVisibilityChange={setToolpathVisibility}
          />
        }
        simulationViewport={
          <SimulationViewport
            ref={simulationViewportRef}
            operation={selectedOperation}
            simulation={simulationResult}
            isActive={centerTab === 'simulation'}
            detailCells={simulationDetailCells}
            onDetailCellsChange={(cells: number) => startSimulationTransition(() => setSimulationDetailCells(cells))}
            isComputing={isSimulationPending}
            mode={simulationMode}
            onModeChange={(mode) => startSimulationTransition(() => setSimulationMode(mode))}
            operationCount={simulationOperationCount}
            clamps={visibleClamps}
            selectedClampId={selectedClampId}
            collidingClampIds={collidingClampIds}
            origin={project.origin}
            stockColor={project.stock.color}
            stockHasProfile={!!project.stock.sourceFeatureId}
            zoomWindowActive={zoomWindowActive && centerTab === 'simulation'}
            onZoomWindowComplete={() => setZoomWindowActive(false)}
            playbackInput={simulationPlaybackInput}
            projectKey={projectKey}
          />
        }
        featureTree={<FeatureTree onFeatureContextMenu={openFeatureContextMenu} onTabContextMenu={openTabContextMenu} onClampContextMenu={openClampContextMenu} />}
        propertiesPanel={<PropertiesPanel />}
        camPanel={
          <CAMPanel
            mode={rightTab === 'tools' ? 'tools' : 'operations'}
            selectedOperationId={effectiveSelectedOperationId}
            onSelectedOperationIdChange={handleSelectedOperationIdChange}
            onExport={() => setShowExportDialog(true)}
            generateToolpath={generateToolpathForOperation}
            toolpathWarnings={selectedToolpath?.warnings ?? null}
            generatingOperationIds={generatingOperationIds}
            onOperationHighlightChange={setOperationHighlightKind}
          />
        }
        centerTab={centerTab}
        onCenterTabChange={handleCenterTabChange}
        workspaceLayout={workspaceLayout}
        onWorkspaceLayoutChange={setWorkspaceLayout}
        rightTab={rightTab}
        onRightTabChange={setRightTab}
        statusBarExtras={collapsedDepthLegend}
        onZoomToModel={handleZoomToModel}
        onZoomWindow={handleZoomWindow}
        zoomWindowActive={zoomWindowActive}
        onImportComplete={handleImportComplete}
        onExportModel={() => setShowModelExportDialog(true)}
        snapSettings={snapSettings}
        activeSnapMode={activeSnapMode}
        onToggleSnapEnabled={handleToggleSnapEnabled}
        onToggleSnapMode={handleToggleSnapMode}
        onShowAbout={() => setShowAboutDialog(true)}
      />

      {showAboutDialog && <AboutDialog onClose={() => setShowAboutDialog(false)} />}

      {showImportDialog && (
        <ImportGeometryDialog
          onClose={() => setShowImportDialog(false)}
          onImportComplete={handleImportComplete}
        />
      )}

      {showModelExportDialog && (
        <ModelExportDialog onClose={() => setShowModelExportDialog(false)} />
      )}

      {showExportDialog && (
        <ExportDialog
          onClose={() => setShowExportDialog(false)}
          generateToolpath={generateToolpathForOperation}
        />
      )}

      {showNewProjectDialog && (
        <NewProjectDialog
          onClose={() => setShowNewProjectDialog(false)}
          onCreated={() => {
            hasAutoFramed3DRef.current = false
            setCenterTab('sketch')
            window.requestAnimationFrame(() => {
              window.requestAnimationFrame(() => {
                sketchCanvasRef.current?.zoomToModel()
              })
            })
          }}
        />
      )}

      {projectLoading && (
        <div className="toolpath-loading-overlay">
          <div className="toolpath-loading-content">
            <span className="toolpath-loading-spinner" />
            <span className="toolpath-loading-text">Opening project…</span>
          </div>
        </div>
      )}

      {treeContextMenu && resolvedMenuPosition && (menuFeature || menuTab || menuClamp) ? (
        <div
          ref={menuRef}
          className="feature-context-menu"
          style={resolvedMenuPosition}
          onContextMenu={(event) => event.preventDefault()}
        >
          {menuFeature ? (
            <>
              {menuQuickOperations.length > 0 ? (
                <>
                  <div
                    className="feature-context-menu__submenu-host"
                    onMouseEnter={tabletShell ? undefined : (event) => openQuickOpsSubmenu(event.currentTarget)}
                    onMouseLeave={tabletShell ? undefined : () => setQuickOpsSubmenu(null)}
                  >
                    <button
                      className="feature-context-menu__item feature-context-menu__item--submenu"
                      type="button"
                      aria-haspopup="menu"
                      aria-expanded={quickOpsSubmenu !== null}
                      onClick={(event) => {
                        // Touch has no hover, so tap toggles the flyout. On desktop
                        // hover drives it and a click just keeps it open.
                        if (tabletShell && quickOpsSubmenu) {
                          setQuickOpsSubmenu(null)
                        } else {
                          openQuickOpsSubmenu(event.currentTarget)
                        }
                      }}
                    >
                      <span>Create operation</span>
                      <span className="feature-context-menu__submenu-caret" aria-hidden="true">›</span>
                    </button>
                    {quickOpsSubmenu ? (
                      <div
                        className={`feature-context-menu feature-context-menu__submenu feature-context-menu__submenu--${quickOpsSubmenu.side}`}
                        style={{ top: quickOpsSubmenu.top, left: quickOpsSubmenu.left }}
                        onContextMenu={(event) => event.preventDefault()}
                      >
                        {menuQuickOperations.map((quickOp) => (
                          <button
                            key={quickOp.kind}
                            className="feature-context-menu__item"
                            type="button"
                            onClick={() => handleCreateQuickOperation(menuFeature.id, quickOp)}
                          >
                            {quickOp.label}
                          </button>
                        ))}
                      </div>
                    ) : null}
                  </div>
                  <div className="feature-context-menu__separator" />
                </>
              ) : null}
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => handleEditSketch(menuFeature.id)}
                disabled={menuHasMultipleSelection}
                title={menuHasMultipleSelection ? 'Edit Sketch is only available for a single selected feature' : undefined}
              >
                Edit Sketch
              </button>
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => handleConstraint(menuFeature.id)}
                disabled={menuHasMultipleSelection || menuHasLockedSelection}
              >
                Add Constraint
              </button>
              <div className="feature-context-menu__separator" />
              <button className="feature-context-menu__item" type="button" onClick={() => handleCopyFeature(menuFeature.id)}>
                {menuHasMultipleSelection ? 'Copy Selected' : 'Copy'}
              </button>
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => handleMoveFeature(menuFeature.id)}
                disabled={menuHasLockedSelection}
                title={menuHasLockedSelection ? 'Locked features cannot be moved' : undefined}
              >
                {menuHasMultipleSelection ? 'Move Selected' : 'Move'}
              </button>
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => handleResizeFeature(menuFeature.id)}
                disabled={menuHasLockedSelection}
              >
                Resize
              </button>
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => handleRotateFeature(menuFeature.id)}
                disabled={menuHasLockedSelection}
              >
                Rotate
              </button>
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => handleMirrorFeature(menuFeature.id)}
                disabled={menuHasLockedSelection}
              >
                Mirror
              </button>
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => handleOffsetFeatures()}
                disabled={menuHasLockedSelection}
              >
                Offset
              </button>
              <div className="feature-context-menu__separator" />
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => handleJoinFeatures()}
                disabled={!menuHasMultipleSelection || menuHasLockedSelection}
                title={!menuHasMultipleSelection ? 'Select two or more features to join' : undefined}
              >
                Join
              </button>
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => handleCutFeatures()}
                disabled={menuHasLockedSelection}
              >
                Cut
              </button>
              <div className="feature-context-menu__separator" />
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => setStockSourceFeature(treeContextMenu.primaryId)}
                disabled={!menuCanUseAsStock}
                title={!menuCanUseAsStock ? 'Feature must be an add operation with a closed profile' : undefined}
              >
                Use as Stock
              </button>
              <div className="feature-context-menu__separator" />
              <button
                className="feature-context-menu__item feature-context-menu__item--danger"
                type="button"
                onClick={() => handleDeleteFeatures(treeContextMenu.ids)}
              >
                {menuHasMultipleSelection ? 'Delete Selected' : 'Delete'}
              </button>
            </>
          ) : menuTab ? (
            <>
              <button className="feature-context-menu__item" type="button" onClick={() => handleEditTab(menuTab.id)}>
                Edit Sketch
              </button>
              <button className="feature-context-menu__item" type="button" onClick={() => handleCopyTab(menuTab.id)}>
                Copy
              </button>
              <button className="feature-context-menu__item" type="button" onClick={() => handleMoveTab(menuTab.id)}>
                Move
              </button>
              <button
                className="feature-context-menu__item feature-context-menu__item--danger"
                type="button"
                onClick={() => handleDeleteTab(menuTab.id)}
              >
                Delete
              </button>
            </>
          ) : menuClamp ? (
            <>
              <button className="feature-context-menu__item" type="button" onClick={() => handleEditClamp(menuClamp.id)}>
                Edit Sketch
              </button>
              <button className="feature-context-menu__item" type="button" onClick={() => handleCopyClamp(menuClamp.id)}>
                Copy
              </button>
              <button className="feature-context-menu__item" type="button" onClick={() => handleMoveClamp(menuClamp.id)}>
                Move
              </button>
              <button
                className="feature-context-menu__item feature-context-menu__item--danger"
                type="button"
                onClick={() => handleDeleteClamp(menuClamp.id)}
              >
                Delete
              </button>
            </>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

export default App
