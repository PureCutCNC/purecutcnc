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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { CAMPanel } from './components/cam/CAMPanel'
import { SketchCanvas, type SketchCanvasHandle } from './components/canvas/SketchCanvas'
import { applyClampWarnings, applyTabsToEdgeRoute, applyTabWarnings, generateDrillingToolpath, generateEdgeRouteToolpath, generateFinishSurfaceToolpath, generateFollowLineToolpath, generatePocketToolpath, generateRoughSurfaceToolpath, generateSurfaceCleanToolpath, generateVCarveToolpath, generateVCarveRecursiveToolpath } from './engine/toolpaths'
import { normalizeToolForProject } from './engine/toolpaths/geometry'
import type { ToolpathResult } from './engine/toolpaths'
import { createSimulationGrid, simulateOperationHeightfield, simulateReplayItemsHeightfield, type SimulationReplayItem } from './engine/simulation'
import type { SimulationPlaybackInput } from './components/simulation/SimulationViewport'
import { FeatureTree } from './components/feature-tree/FeatureTree'
import { PropertiesPanel } from './components/feature-tree/PropertiesPanel'
import { AppShell } from './components/layout/AppShell'
import { CreationToolbar, GlobalToolbar, Toolbar } from './components/layout/Toolbar'
import { SimulationViewport, type SimulationViewportHandle } from './components/simulation/SimulationViewport'
import { Viewport3D, type Viewport3DHandle } from './components/viewport3d/Viewport3D'
import { ExportDialog } from './components/export/ExportDialog'
import { NewProjectDialog } from './components/project/NewProjectDialog'
import { DEFAULT_SNAP_SETTINGS, SNAP_SETTINGS_STORAGE_KEY, type SnapMode, type SnapSettings, normalizeSnapSettings } from './sketch/snapping'
import { useProjectStore } from './store/projectStore'
import { useDesktopIntegration } from './platform/useDesktopIntegration'

interface TreeContextMenuState {
  entityType: 'feature' | 'tab' | 'clamp'
  ids: string[]
  primaryId: string
  x: number
  y: number
}

type ToolbarOrientation = 'top' | 'left'

const TOOLBAR_ORIENTATION_STORAGE_KEY = 'camcam.toolbarOrientation'
const DEPTH_LEGEND_COLLAPSED_STORAGE_KEY = 'camcam.depthLegendCollapsed'
const TOOLBAR_LEFT_BREAKPOINT = 920

function App() {
  const [centerTab, setCenterTab] = useState<'sketch' | 'preview3d' | 'simulation'>('sketch')
  const [rightTab, setRightTab] = useState<'operations' | 'tools'>('operations')
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
  const [showNewProjectDialog, setShowNewProjectDialog] = useState(false)
  const [zoomWindowActive, setZoomWindowActive] = useState(false)

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
  const [depthLegendCollapsed, setDepthLegendCollapsed] = useState(() => {
    if (typeof window === 'undefined') {
      return false
    }

    return window.localStorage.getItem(DEPTH_LEGEND_COLLAPSED_STORAGE_KEY) === 'true'
  })
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
    startResizeFeature,
    startRotateFeature,
    startOffsetSelectedFeatures,
    startJoinSelectedFeatures,
    startCutSelectedFeatures,
    beginConstraint,
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

      if (operation.kind === 'v_carve_recursive') {
        return applyClampWarnings(project, generateVCarveRecursiveToolpath(project, operation), operation)
      }

      if (operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside') {
        const tabAware = applyTabsToEdgeRoute(project, operation, generateEdgeRouteToolpath(project, operation))
        return applyClampWarnings(project, applyTabWarnings(project, operation, tabAware), operation)
      }

      if (operation.kind === 'surface_clean') {
        return applyClampWarnings(project, applyTabWarnings(project, operation, generateSurfaceCleanToolpath(project, operation)), operation)
      }

      if (operation.kind === 'rough_surface') {
        return applyClampWarnings(project, applyTabWarnings(project, operation, generateRoughSurfaceToolpath(project, operation)), operation)
      }

      if (operation.kind === 'finish_surface') {
        return applyClampWarnings(project, applyTabWarnings(project, operation, generateFinishSurfaceToolpath(project, operation)), operation)
      }

      if (operation.kind === 'follow_line') {
        return applyClampWarnings(project, generateFollowLineToolpath(project, operation), operation)
      }

      if (operation.kind === 'drilling') {
        return applyClampWarnings(project, generateDrillingToolpath(project, operation), operation)
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

  const simulationPlaybackInput = useMemo<SimulationPlaybackInput | null>(() => {
    if (centerTab !== 'simulation' || simulationMode !== 'selected') {
      return null
    }
    if (!selectedOperation || !selectedToolpath) {
      return null
    }
    const toolRecord = selectedOperation.toolRef
      ? project.tools.find((tool) => tool.id === selectedOperation.toolRef) ?? null
      : null
    if (!toolRecord || toolRecord.type === 'drill') {
      return null
    }

    const normalizedSelectedTool = normalizeToolForProject(toolRecord, project)

    // Pre-apply only operations that come BEFORE the selected one in the feature
    // tree order — operations listed after the selection haven't run yet at this
    // point in the cycle, so their cuts shouldn't appear in the starting state.
    const selectedIndex = project.operations.findIndex((operation) => operation.id === selectedOperation.id)
    const priorOperations = selectedIndex >= 0 ? project.operations.slice(0, selectedIndex) : []

    const priorItems: SimulationReplayItem[] = priorOperations
      .filter((operation) =>
        operation.enabled
        && operation.showToolpath
        && operation.toolRef,
      )
      .map((operation): SimulationReplayItem | null => {
        const toolpath = generateToolpathForOperation(operation)
        const operationTool = operation.toolRef
          ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
          : null
        if (!toolpath || !operationTool) {
          return null
        }
        const normalizedTool = normalizeToolForProject(operationTool, project)
        return {
          operationId: operation.id,
          operationName: operation.name,
          toolRef: operationTool.id,
          toolType: operationTool.type,
          toolRadius: normalizedTool.radius,
          vBitAngle: normalizedTool.vBitAngle,
          toolpath,
        }
      })
      .filter((item): item is SimulationReplayItem => item !== null)

    const baseResult = simulateReplayItemsHeightfield(project, priorItems, {
      targetLongAxisCells: simulationDetailCells,
    })

    const diameter = normalizedSelectedTool.radius * 2
    // Both maxCutDepth and diameter come from `normalizeToolForProject`, so they're
    // already in project units — mm or inch, whichever the project uses. All the
    // derived dimensions below stay unit-agnostic by staying diameter-relative.
    const toolCutLength = normalizedSelectedTool.maxCutDepth > 0
      ? normalizedSelectedTool.maxCutDepth
      : diameter * 3
    const toolShankLength = diameter * 2
    // Split source moves longer than ~0.4× tool radius so long straights don't
    // apply a single giant cut in one shot. The playback controller also throttles
    // by distance-per-frame now, so this is belt-and-suspenders for partial-cut
    // granularity on very long segments.
    const maxSegmentLength = normalizedSelectedTool.radius * 0.4

    // Operation feed is stored in project-units-per-minute. The viewport works in
    // units-per-second, so divide by 60. This becomes the "1×" playback speed so
    // users can intuitively speed up or slow down relative to the real feed rate.
    const feedPerSecond = selectedOperation.feed > 0 ? selectedOperation.feed / 60 : undefined
    // `project.meta.units` uses 'inch'; the playback UI shows the short label 'in'.
    const units: 'mm' | 'in' = project.meta.units === 'inch' ? 'in' : 'mm'

    return {
      baseGrid: baseResult.grid,
      moves: selectedToolpath.moves,
      toolType: toolRecord.type,
      toolRadius: normalizedSelectedTool.radius,
      vBitAngle: normalizedSelectedTool.vBitAngle,
      toolCutLength,
      toolShankLength,
      maxSegmentLength,
      units,
      feedPerSecond,
    }
  }, [centerTab, generateToolpathForOperation, project, selectedOperation, selectedToolpath, simulationDetailCells, simulationMode])

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
    window.localStorage.setItem(DEPTH_LEGEND_COLLAPSED_STORAGE_KEY, String(depthLegendCollapsed))
  }, [depthLegendCollapsed])

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

  const menuPosition = treeContextMenu
    ? {
        left: Math.min(treeContextMenu.x, window.innerWidth - 188),
        top: Math.min(treeContextMenu.y, window.innerHeight - 300),
      }
    : null

  const menuHasMultipleSelection = treeContextMenu?.entityType === 'feature' && (treeContextMenu?.ids.length ?? 0) > 1
  const menuHasLockedSelection =
    treeContextMenu?.entityType === 'feature' && (treeContextMenu?.ids.some((featureId) =>
      project.features.some((feature) => feature.id === featureId && feature.locked)
    ) ?? false)

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
        <span className="sketch-depth-legend__swatch sketch-depth-legend__swatch--selected" />
      </span>
    </button>
  ) : null

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
            depthLegendCollapsed={depthLegendCollapsed}
            onToggleDepthLegend={() => setDepthLegendCollapsed((value) => !value)}
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
            stockColor={project.stock.color}
            zoomWindowActive={zoomWindowActive && centerTab === 'simulation'}
            onZoomWindowComplete={() => setZoomWindowActive(false)}
            playbackInput={simulationPlaybackInput}
          />
        }
        featureTree={<FeatureTree onFeatureContextMenu={openFeatureContextMenu} onTabContextMenu={openTabContextMenu} onClampContextMenu={openClampContextMenu} onEditFeature={handleEditSketch} onEditTab={handleEditTab} onEditClamp={handleEditClamp} />}
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
        statusBarExtras={collapsedDepthLegend}
      />
      
      {showExportDialog && (
        <ExportDialog
          onClose={() => setShowExportDialog(false)}
          generateToolpath={generateToolpathForOperation}
        />
      )}

      {showNewProjectDialog && (
        <NewProjectDialog onClose={() => setShowNewProjectDialog(false)} />
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
