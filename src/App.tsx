import { useEffect, useMemo, useRef, useState } from 'react'
import { AIPanel } from './components/ai/AIPanel'
import { CAMPanel } from './components/cam/CAMPanel'
import { SketchCanvas, type SketchCanvasHandle } from './components/canvas/SketchCanvas'
import { applyClampWarnings, applyTabsToEdgeRoute, applyTabWarnings, generateEdgeRouteToolpath, generateFollowLineToolpath, generateGeometricVCarveToolpath, generatePocketToolpath, generateSurfaceCleanToolpath, generateVCarveToolpath } from './engine/toolpaths'
import { normalizeToolForProject } from './engine/toolpaths/geometry'
import type { ToolpathResult } from './engine/toolpaths'
import { createSimulationGrid, simulateOperationHeightfield, simulateReplayItemsHeightfield } from './engine/simulation'
import { FeatureTree } from './components/feature-tree/FeatureTree'
import { PropertiesPanel } from './components/feature-tree/PropertiesPanel'
import { AppShell } from './components/layout/AppShell'
import { CreationToolbar, GlobalToolbar, Toolbar } from './components/layout/Toolbar'
import { SimulationViewport, type SimulationViewportHandle } from './components/simulation/SimulationViewport'
import { Viewport3D, type Viewport3DHandle } from './components/viewport3d/Viewport3D'
import { ExportDialog } from './components/export/ExportDialog'
import { DEFAULT_SNAP_SETTINGS, SNAP_SETTINGS_STORAGE_KEY, type SnapMode, type SnapSettings, normalizeSnapSettings } from './sketch/snapping'
import { useProjectStore } from './store/projectStore'

interface TreeContextMenuState {
  entityType: 'feature' | 'tab' | 'clamp'
  ids: string[]
  primaryId: string
  x: number
  y: number
}

type ToolbarOrientation = 'top' | 'left'

const TOOLBAR_ORIENTATION_STORAGE_KEY = 'camcam.toolbarOrientation'
const TOOLBAR_LEFT_BREAKPOINT = 1100

function App() {
  const [centerTab, setCenterTab] = useState<'sketch' | 'preview3d' | 'simulation'>('sketch')
  const [rightTab, setRightTab] = useState<'operations' | 'tools' | 'ai'>('operations')
  const [toolbarOrientationPreference, setToolbarOrientationPreference] = useState<ToolbarOrientation>(() => {
    if (typeof window === 'undefined') {
      return 'top'
    }

    const saved = window.localStorage.getItem(TOOLBAR_ORIENTATION_STORAGE_KEY)
    return saved === 'left' ? 'left' : 'top'
  })
  const [isToolbarForcedTop, setIsToolbarForcedTop] = useState(() => (
    typeof window !== 'undefined' ? window.innerWidth <= TOOLBAR_LEFT_BREAKPOINT : false
  ))
  const [workspaceLayout, setWorkspaceLayout] = useState<'lcr' | 'lc' | 'c' | 'cr'>('lcr')
  const [treeContextMenu, setTreeContextMenu] = useState<TreeContextMenuState | null>(null)
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null)
  const [simulationDetailCells, setSimulationDetailCells] = useState(280)
  const [simulationMode, setSimulationMode] = useState<'selected' | 'visible'>('selected')
  const [showExportDialog, setShowExportDialog] = useState(false)
  const [zoomWindowActive, setZoomWindowActive] = useState(false)
  const [activeSnapMode, setActiveSnapMode] = useState<SnapMode | null>(null)
  const [snapSettings, setSnapSettings] = useState<SnapSettings>(() => {
    if (typeof window === 'undefined') {
      return DEFAULT_SNAP_SETTINGS
    }

    const saved = window.localStorage.getItem(SNAP_SETTINGS_STORAGE_KEY)
    if (!saved) {
      return DEFAULT_SNAP_SETTINGS
    }

    try {
      return normalizeSnapSettings(JSON.parse(saved))
    } catch {
      return DEFAULT_SNAP_SETTINGS
    }
  })
  const sketchCanvasRef = useRef<SketchCanvasHandle>(null)
  const viewport3dRef = useRef<Viewport3DHandle>(null)
  const simulationViewportRef = useRef<SimulationViewportHandle>(null)
  const hasAutoFramed3DRef = useRef(false)
  const menuRef = useRef<HTMLDivElement>(null)
  const {
    project,
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
    startMoveTab,
    startCopyTab,
    startMoveClamp,
    startCopyClamp,
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

  const effectiveToolbarOrientation: ToolbarOrientation = isToolbarForcedTop ? 'top' : toolbarOrientationPreference

  const generateToolpathForOperation = useMemo(
    () => (operation: typeof selectedOperation): ToolpathResult | null => {
      if (!operation) {
        return null
      }

      if (operation.kind === 'pocket') {
        return applyClampWarnings(project, applyTabWarnings(project, operation, generatePocketToolpath(project, operation)), operation)
      }

      if (operation.kind === 'v_carve') {
        return applyClampWarnings(project, generateVCarveToolpath(project, operation), operation)
      }

      if (operation.kind === 'v_carve_skeleton') {
        return applyClampWarnings(project, generateGeometricVCarveToolpath(project, operation), operation)
      }

      if (operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside') {
        const tabAware = applyTabsToEdgeRoute(project, operation, generateEdgeRouteToolpath(project, operation))
        return applyClampWarnings(project, applyTabWarnings(project, operation, tabAware), operation)
      }

      if (operation.kind === 'surface_clean') {
        return applyClampWarnings(project, applyTabWarnings(project, operation, generateSurfaceCleanToolpath(project, operation)), operation)
      }

      if (operation.kind === 'follow_line') {
        return applyClampWarnings(project, generateFollowLineToolpath(project, operation), operation)
      }

      return null
    },
    [project]
  )

  const selectedToolpath = useMemo<ToolpathResult | null>(() => {
    return generateToolpathForOperation(selectedOperation)
  }, [generateToolpathForOperation, selectedOperation])

  const simulationResult = useMemo(() => {
    if (centerTab !== 'simulation') {
      return null
    }

    const emptySimulationResult = {
      grid: createSimulationGrid(project, {
        targetLongAxisCells: simulationDetailCells,
      }),
      stats: {
        removedCellCount: 0,
        minTopZ: project.stock.thickness,
        maxRemovedDepth: 0,
        processedMoveCount: 0,
      },
      warnings: [],
    }

    if (simulationMode === 'selected') {
      if (!selectedOperation || !selectedToolpath) {
        return emptySimulationResult
      }

      return simulateOperationHeightfield(project, selectedOperation, selectedToolpath, {
        targetLongAxisCells: simulationDetailCells,
      })
    }

    const replayItems = project.operations
      .filter((operation) => operation.enabled && operation.showToolpath && operation.toolRef)
      .map((operation) => {
        const toolpath = generateToolpathForOperation(operation)
        const toolRecord = operation.toolRef
          ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
          : null

        if (!toolpath || !toolRecord) {
          return null
        }

        const normalizedTool = normalizeToolForProject(toolRecord, project)
        return {
          operationId: operation.id,
          operationName: operation.name,
          toolRef: toolRecord.id,
          toolType: toolRecord.type,
          toolRadius: normalizedTool.radius,
          vBitAngle: normalizedTool.vBitAngle,
          toolpath,
        }
      })
      .filter((item) => item !== null)

    if (replayItems.length === 0) {
      return emptySimulationResult
    }

    return simulateReplayItemsHeightfield(project, replayItems, {
      targetLongAxisCells: simulationDetailCells,
    })
  }, [centerTab, generateToolpathForOperation, project, selectedOperation, selectedToolpath, simulationDetailCells, simulationMode])

  const simulationOperationCount = useMemo(() => {
    if (simulationMode === 'selected') {
      return selectedOperation && selectedToolpath ? 1 : 0
    }

    return project.operations.filter((operation) => operation.enabled && operation.showToolpath).length
  }, [project.operations, selectedOperation, selectedToolpath, simulationMode])

  const visibleToolpaths = useMemo<ToolpathResult[]>(() => {
    return project.operations
      .filter((operation) => operation.showToolpath)
      .map((operation) => generateToolpathForOperation(operation))
      .filter((toolpath): toolpath is ToolpathResult => toolpath !== null)
  }, [generateToolpathForOperation, project.operations])
  const collidingClampIds = useMemo(
    () => [
      ...new Set([
        ...visibleToolpaths.flatMap((toolpath) => toolpath.collidingClampIds ?? []),
        ...(selectedToolpath?.collidingClampIds ?? []),
      ]),
    ],
    [selectedToolpath, visibleToolpaths],
  )

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
    function updateForcedToolbarState() {
      setIsToolbarForcedTop(window.innerWidth <= TOOLBAR_LEFT_BREAKPOINT)
    }

    updateForcedToolbarState()
    window.addEventListener('resize', updateForcedToolbarState)
    return () => window.removeEventListener('resize', updateForcedToolbarState)
  }, [])

  useEffect(() => {
    window.localStorage.setItem(TOOLBAR_ORIENTATION_STORAGE_KEY, toolbarOrientationPreference)
  }, [toolbarOrientationPreference])

  useEffect(() => {
    window.localStorage.setItem(SNAP_SETTINGS_STORAGE_KEY, JSON.stringify(snapSettings))
  }, [snapSettings])

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

  useEffect(() => {
    if (!treeContextMenu) {
      return
    }

    function handlePointerDown(event: PointerEvent) {
      const target = event.target as Node | null
      if (menuRef.current?.contains(target)) {
        return
      }
      setTreeContextMenu(null)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setTreeContextMenu(null)
      }
    }

    window.addEventListener('pointerdown', handlePointerDown)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('pointerdown', handlePointerDown)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [treeContextMenu])

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
    setTreeContextMenu({ entityType: 'feature', ids: featureIds, primaryId: featureId, x, y })
  }

  function openClampContextMenu(clampId: string, x: number, y: number) {
    setTreeContextMenu({ entityType: 'clamp', ids: [clampId], primaryId: clampId, x, y })
  }

  function openTabContextMenu(tabId: string, x: number, y: number) {
    setTreeContextMenu({ entityType: 'tab', ids: [tabId], primaryId: tabId, x, y })
  }

  function closeTreeContextMenu() {
    setTreeContextMenu(null)
  }

  function handleEditSketch(featureId: string) {
    selectFeature(featureId)
    enterSketchEdit(featureId)
    setCenterTab('sketch')
    closeTreeContextMenu()
  }

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

  const menuPosition = treeContextMenu
    ? {
        left: Math.min(treeContextMenu.x, window.innerWidth - 188),
        top: Math.min(treeContextMenu.y, window.innerHeight - 180),
      }
    : null

  const menuHasMultipleSelection = treeContextMenu?.entityType === 'feature' && (treeContextMenu?.ids.length ?? 0) > 1
  const menuHasLockedSelection =
    treeContextMenu?.entityType === 'feature' && (treeContextMenu?.ids.some((featureId) =>
      project.features.some((feature) => feature.id === featureId && feature.locked)
    ) ?? false)

  return (
    <>
      <AppShell
        toolbar={
          <Toolbar 
            onZoomToModel={handleZoomToModel}
            onZoomWindow={handleZoomWindow}
            zoomWindowActive={zoomWindowActive}
            onImportComplete={handleImportComplete}
            snapSettings={snapSettings}
            activeSnapMode={activeSnapMode}
            onToggleSnapEnabled={handleToggleSnapEnabled}
            onToggleSnapMode={handleToggleSnapMode}
          />
        }
        globalToolbar={
          <GlobalToolbar
            onZoomToModel={handleZoomToModel}
            onZoomWindow={handleZoomWindow}
            zoomWindowActive={zoomWindowActive}
            onImportComplete={handleImportComplete}
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
        aiPanel={<AIPanel />}
        sketchCanvas={
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
          />
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
          />
        }
        simulationViewport={
          <SimulationViewport
            ref={simulationViewportRef}
            operation={selectedOperation}
            simulation={simulationResult}
            detailCells={simulationDetailCells}
            onDetailCellsChange={setSimulationDetailCells}
            mode={simulationMode}
            onModeChange={setSimulationMode}
            operationCount={simulationOperationCount}
            clamps={visibleClamps}
            selectedClampId={selectedClampId}
            collidingClampIds={collidingClampIds}
            origin={project.origin}
            zoomWindowActive={zoomWindowActive && centerTab === 'simulation'}
            onZoomWindowComplete={() => setZoomWindowActive(false)}
          />
        }
        featureTree={<FeatureTree onFeatureContextMenu={openFeatureContextMenu} onTabContextMenu={openTabContextMenu} onClampContextMenu={openClampContextMenu} />}
        propertiesPanel={<PropertiesPanel />}
        camPanel={
          <CAMPanel
            mode={rightTab === 'tools' ? 'tools' : 'operations'}
            selectedOperationId={effectiveSelectedOperationId}
            onSelectedOperationIdChange={setSelectedOperationId}
            onExport={() => setShowExportDialog(true)}
            toolpathWarnings={selectedToolpath?.warnings ?? null}
          />
        }
        centerTab={centerTab}
        onCenterTabChange={setCenterTab}
        workspaceLayout={workspaceLayout}
        onWorkspaceLayoutChange={setWorkspaceLayout}
        toolbarOrientation={effectiveToolbarOrientation}
        toolbarOrientationForced={isToolbarForcedTop}
        onToolbarOrientationChange={setToolbarOrientationPreference}
        rightTab={rightTab}
        onRightTabChange={setRightTab}
      />
      
      {showExportDialog && (
        <ExportDialog 
          onClose={() => setShowExportDialog(false)} 
          generateToolpath={generateToolpathForOperation}
        />
      )}

      {treeContextMenu && menuPosition && (menuFeature || menuTab || menuClamp) ? (
        <div
          ref={menuRef}
          className="feature-context-menu"
          style={menuPosition}
          onContextMenu={(event) => event.preventDefault()}
        >
          {menuFeature ? (
            <>
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => handleEditSketch(menuFeature.id)}
                disabled={menuHasMultipleSelection}
                title={menuHasMultipleSelection ? 'Edit Sketch is only available for a single selected feature' : undefined}
              >
                Edit Sketch
              </button>
              <button className="feature-context-menu__item" type="button" onClick={() => handleCopyFeature(menuFeature.id)}>
                {menuHasMultipleSelection ? 'Copy Selected' : 'Copy'}
              </button>
              <button
                className="feature-context-menu__item"
                type="button"
                onClick={() => handleMoveFeature(menuFeature.id)}
                disabled={menuHasLockedSelection}
                title={menuHasLockedSelection ? 'Locked features cannot be moved as part of a selection' : undefined}
              >
                {menuHasMultipleSelection ? 'Move Selected' : 'Move'}
              </button>
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
