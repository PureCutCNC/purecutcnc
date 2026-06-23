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

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { CAMPanel } from './components/cam/CAMPanel'
import { SketchCanvas, type SketchCanvasHandle } from './components/canvas/SketchCanvas'
import type { OperationKind } from './types/project'
import { FeatureContextMenu } from './components/feature-tree/FeatureContextMenu'
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
import { useProjectStore } from './store/projectStore'
import { useDesktopIntegration } from './platform/useDesktopIntegration'
import { useLocalStorageState } from './hooks/useLocalStorageState'
import { useToolpathGeneration } from './app/useToolpathGeneration'
import { useSimulationModel } from './app/useSimulationModel'
import { useTreeContextMenu } from './app/useTreeContextMenu'
import { useFeatureTreeActions } from './app/useFeatureTreeActions'
import { useSnapSettings } from './app/useSnapSettings'
import { useZoomWindow } from './app/useZoomWindow'
import { useEmptyStateEngagement } from './app/useEmptyStateEngagement'

const DEPTH_LEGEND_COLLAPSED_STORAGE_KEY = 'camcam.depthLegendCollapsed'

// Persist the depth-legend collapsed flag as the literal "true"/"false" string
// the previous hand-rolled site wrote (`String(bool)` / `=== 'true'`), not JSON,
// so existing stored values keep working unchanged.
const DEPTH_LEGEND_CODEC = {
  serialize: (collapsed: boolean): string => String(collapsed),
  deserialize: (raw: string): boolean => raw === 'true',
}

function App() {
  const [centerTab, setCenterTab] = useState<'sketch' | 'preview3d' | 'simulation'>('sketch')
  const [rightTab, setRightTab] = useState<'operations' | 'tools'>('operations')
  const [workspaceLayout, setWorkspaceLayout] = useState<'lcr' | 'lc' | 'c' | 'cr'>('lcr')
  const tabletShell = isTabletMode(useShellMode())
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null)
  const [simulationDetailCells, setSimulationDetailCells] = useState(280)
  const [isSimulationPending, startSimulationTransition] = useTransition()
  const [simulationMode, setSimulationMode] = useState<'selected' | 'visible'>('selected')
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [showModelExportDialog, setShowModelExportDialog] = useState(false)
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [showImportDialog, setShowImportDialog] = useState(false)
  const [showAboutDialog, setShowAboutDialog] = useState(false)
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
  const { snapSettings, activeSnapMode, setActiveSnapMode, onToggleSnapEnabled, onToggleSnapMode } = useSnapSettings()
  const { zoomWindowActive, onZoomWindow, onZoomWindowComplete } = useZoomWindow()
  const [depthLegendCollapsed, setDepthLegendCollapsed] = useLocalStorageState<boolean>(
    DEPTH_LEGEND_COLLAPSED_STORAGE_KEY,
    false,
    { codec: DEPTH_LEGEND_CODEC },
  )
  const sketchCanvasRef = useRef<SketchCanvasHandle>(null)
  const viewport3dRef = useRef<Viewport3DHandle>(null)
  const simulationViewportRef = useRef<SimulationViewportHandle>(null)
  const hasAutoFramed3DRef = useRef(false)
  const {
    project,
    projectKey,
    projectLoading,
    loadWarning,
    clearLoadWarning,
    selection,
    startAddRectPlacement,
    pendingAdd,
  } = useProjectStore()

  const {
    treeContextMenu,
    menuRef,
    resolvedMenuPosition,
    menuFeature,
    menuTab,
    menuClamp,
    menuQuickOperations,
    quickOpsSubmenu,
    setQuickOpsSubmenu,
    addToFolderSubmenu,
    setAddToFolderSubmenu,
    menuFeatureFolders,
    menuSelectionInGroupedFolder,
    menuHasMultipleSelection,
    menuCanUseAsStock,
    menuHasLockedSelection,
    menuFeatureHasLinkedInstances,
    openFeatureContextMenu,
    openClampContextMenu,
    openTabContextMenu,
    closeTreeContextMenu,
    openQuickOpsSubmenu,
    openAddToFolderSubmenu,
  } = useTreeContextMenu({ project })

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

  const featureActions = useFeatureTreeActions({
    setCenterTab,
    setRightTab,
    closeTreeContextMenu,
    onSelectedOperationIdChange: handleSelectedOperationIdChange,
  })

  const {
    emptyStateEngaged,
    onDraw: handleEmptyStateDraw,
    onImport: handleEmptyStateImport,
    frameOpenedProject,
  } = useEmptyStateEngagement({
    projectKey,
    featureCount: project.features.length,
    pendingAdd,
    setCenterTab,
    setShowImportDialog,
    startAddRectPlacement,
    sketchCanvasRef,
    hasAutoFramed3DRef,
  })

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

  // Surface a one-time warning when a loaded file is newer than this build supports.
  useEffect(() => {
    if (loadWarning) {
      window.alert(loadWarning)
      clearLoadWarning()
    }
  }, [loadWarning, clearLoadWarning])

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
            onZoomWindow={onZoomWindow}
            zoomWindowActive={zoomWindowActive}
            onImportComplete={handleImportComplete}
            onExportModel={() => setShowModelExportDialog(true)}
            snapSettings={snapSettings}
            activeSnapMode={activeSnapMode}
            onToggleSnapEnabled={onToggleSnapEnabled}
            onToggleSnapMode={onToggleSnapMode}
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
              onZoomWindowComplete={onZoomWindowComplete}
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
            onZoomWindowComplete={onZoomWindowComplete}
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
            onZoomWindowComplete={onZoomWindowComplete}
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
        onZoomWindow={onZoomWindow}
        zoomWindowActive={zoomWindowActive}
        onImportComplete={handleImportComplete}
        onExportModel={() => setShowModelExportDialog(true)}
        snapSettings={snapSettings}
        activeSnapMode={activeSnapMode}
        onToggleSnapEnabled={onToggleSnapEnabled}
        onToggleSnapMode={onToggleSnapMode}
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

      <FeatureContextMenu
        menuRef={menuRef}
        position={resolvedMenuPosition}
        menuFeature={menuFeature}
        menuTab={menuTab}
        menuClamp={menuClamp}
        menuHasMultipleSelection={menuHasMultipleSelection}
        menuCanUseAsStock={menuCanUseAsStock}
        menuHasLockedSelection={menuHasLockedSelection}
        menuFeatureHasLinkedInstances={menuFeatureHasLinkedInstances}
        menuQuickOperations={menuQuickOperations}
        quickOpsSubmenu={quickOpsSubmenu}
        menuFeatureFolders={menuFeatureFolders}
        addToFolderSubmenu={addToFolderSubmenu}
        menuSelectionInGroupedFolder={menuSelectionInGroupedFolder}
        tabletShell={tabletShell}
        primaryId={treeContextMenu?.primaryId ?? null}
        ids={treeContextMenu?.ids ?? []}
        actions={featureActions}
        onOpenQuickOpsSubmenu={openQuickOpsSubmenu}
        onCloseQuickOpsSubmenu={() => setQuickOpsSubmenu(null)}
        onOpenAddToFolderSubmenu={openAddToFolderSubmenu}
        onCloseAddToFolderSubmenu={() => setAddToFolderSubmenu(null)}
      />
    </>
  )
}

export default App
