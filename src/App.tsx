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
import { applyClampWarnings, applyTabsToEdgeRoute, applyTabWarnings, generateDrillingToolpath, generateEdgeRouteToolpath, generateFinishSurfaceCleanupToolpath, generateFinishSurfaceToolpath, generateFollowLineToolpath, generatePocketToolpath, generateRoughSurfaceToolpath, generateSurfaceCleanToolpath, generateVCarveToolpath, generateVCarveRecursiveToolpath } from './engine/toolpaths'
import { normalizeToolForProject } from './engine/toolpaths/geometry'
import type { ToolpathResult } from './engine/toolpaths'
import type { Clamp, Operation, OperationKind, Project, SketchFeature, Stock, Tab, Tool } from './types/project'
import { createSimulationGrid, simulateOperationHeightfield, simulateReplayItemsHeightfield, type SimulationReplayItem } from './engine/simulation'
import type { SimulationPlaybackInput } from './components/simulation/SimulationViewport'
import { FeatureTree } from './components/feature-tree/FeatureTree'
import { PropertiesPanel } from './components/feature-tree/PropertiesPanel'
import { AppShell } from './components/layout/AppShell'
import { isTabletMode, useShellMode } from './components/layout/useShellMode'
import { CreationToolbar, GlobalToolbar, Toolbar } from './components/layout/Toolbar'
import { SimulationViewport, type SimulationViewportHandle } from './components/simulation/SimulationViewport'
import { Viewport3D, type Viewport3DHandle } from './components/viewport3d/Viewport3D'
import { type ToolpathVisibility, DEFAULT_TOOLPATH_VISIBILITY } from './components/ToolpathVisibilityPanel'
import { ExportDialog } from './components/export/ExportDialog'
import { ModelExportDialog } from './components/export/ModelExportDialog'
import { NewProjectDialog } from './components/project/NewProjectDialog'
import { ImportGeometryDialog } from './components/project/ImportGeometryDialog'
import { EmptyStateOverlay } from './components/onboarding/EmptyStateOverlay'
import { AboutDialog } from './components/about/AboutDialog'
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

interface MenuPosition {
  left: number
  top: number
}

interface ToolpathCacheEntry {
  result: ToolpathResult
  operation: Operation
  stock: Stock
  features: SketchFeature[]
  tools: Tool[]
  tabs: Tab[]
  clamps: Clamp[]
}

// Compare only fields that affect toolpath geometry. Excluded (display-only):
//   name, enabled, showToolpath
// Any new computation-relevant field added to Operation must be listed here.
function operationComputationEquals(a: Operation, b: Operation): boolean {
  if (a === b) return true
  return (
    a.kind === b.kind
    && a.pass === b.pass
    && a.target === b.target
    && a.toolRef === b.toolRef
    && a.stepdown === b.stepdown
    && a.stepover === b.stepover
    && a.feed === b.feed
    && a.plungeFeed === b.plungeFeed
    && a.rpm === b.rpm
    && a.pocketPattern === b.pocketPattern
    && a.pocketAngle === b.pocketAngle
    && a.stockToLeaveRadial === b.stockToLeaveRadial
    && a.stockToLeaveAxial === b.stockToLeaveAxial
    && a.finishWalls === b.finishWalls
    && a.finishFloor === b.finishFloor
    && a.carveDepth === b.carveDepth
    && a.maxCarveDepth === b.maxCarveDepth
    && a.cutDirection === b.cutDirection
    && a.machiningOrder === b.machiningOrder
    && a.drillType === b.drillType
    && a.peckDepth === b.peckDepth
    && a.dwellTime === b.dwellTime
    && a.retractHeight === b.retractHeight
    && a.debugToolpath === b.debugToolpath
    && a.debugShowRejectedCorners === b.debugShowRejectedCorners
    && a.waterlineAdaptiveRefinement === b.waterlineAdaptiveRefinement
    && a.waterlineMicroStepover === b.waterlineMicroStepover
    && a.waterlineRefinementThreshold === b.waterlineRefinementThreshold
    && a.waterlineMaxRingsPerBand === b.waterlineMaxRingsPerBand
    && a.waterlineTipStepdown === b.waterlineTipStepdown
  )
}

function isCacheHit(entry: ToolpathCacheEntry, operation: Operation, project: Project): boolean {
  return (
    operationComputationEquals(entry.operation, operation)
    && entry.stock === project.stock
    && entry.features === project.features
    && entry.tools === project.tools
    && entry.tabs === project.tabs
    && entry.clamps === project.clamps
  )
}

function scheduleAfterPaint(fn: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(fn))
}

type ToolbarOrientation = 'top' | 'left'

const TOOLBAR_ORIENTATION_STORAGE_KEY = 'camcam.toolbarOrientation'
const DEPTH_LEGEND_COLLAPSED_STORAGE_KEY = 'camcam.depthLegendCollapsed'
const TOOLBAR_LEFT_BREAKPOINT = 920
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
  const toolpathCacheRef = useRef<Map<string, ToolpathCacheEntry>>(new Map())
  const [toolpathMap, setToolpathMap] = useState<Map<string, ToolpathResult>>(new Map())
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

  const effectiveToolbarOrientation: ToolbarOrientation = isToolbarForcedTop ? 'top' : toolbarOrientationPreference

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

  const generateToolpathForOperation = useMemo(
    () => (operation: typeof selectedOperation): ToolpathResult | null => {
      if (!operation) {
        return null
      }

      const cached = toolpathCacheRef.current.get(operation.id)
      if (cached && isCacheHit(cached, operation, project)) {
        return cached.result
      }

      let result: ToolpathResult | null = null

      if (operation.kind === 'pocket') {
        result = applyClampWarnings(project, applyTabWarnings(project, operation, generatePocketToolpath(project, operation)), operation)
      } else if (operation.kind === 'v_carve') {
        result = applyClampWarnings(project, generateVCarveToolpath(project, operation), operation)
      } else if (operation.kind === 'v_carve_recursive') {
        result = applyClampWarnings(project, generateVCarveRecursiveToolpath(project, operation), operation)
      } else if (operation.kind === 'edge_route_inside' || operation.kind === 'edge_route_outside') {
        const tabAware = applyTabsToEdgeRoute(project, operation, generateEdgeRouteToolpath(project, operation))
        result = applyClampWarnings(project, applyTabWarnings(project, operation, tabAware), operation)
      } else if (operation.kind === 'surface_clean') {
        result = applyClampWarnings(project, applyTabWarnings(project, operation, generateSurfaceCleanToolpath(project, operation)), operation)
      } else if (operation.kind === 'rough_surface') {
        result = applyClampWarnings(project, applyTabWarnings(project, operation, generateRoughSurfaceToolpath(project, operation)), operation)
      } else if (operation.kind === 'finish_surface') {
        const tabAware = applyTabsToEdgeRoute(project, operation, generateFinishSurfaceToolpath(project, operation))
        result = applyClampWarnings(project, applyTabWarnings(project, operation, tabAware), operation)
      } else if (operation.kind === 'finish_surface_cleanup') {
        const tabAware = applyTabsToEdgeRoute(project, operation, generateFinishSurfaceCleanupToolpath(project, operation))
        result = applyClampWarnings(project, applyTabWarnings(project, operation, tabAware), operation)
      } else if (operation.kind === 'follow_line') {
        result = applyClampWarnings(project, generateFollowLineToolpath(project, operation), operation)
      } else if (operation.kind === 'drilling') {
        result = applyClampWarnings(project, generateDrillingToolpath(project, operation), operation)
      }

      if (result) {
        toolpathCacheRef.current.set(operation.id, {
          result,
          operation,
          stock: project.stock,
          features: project.features,
          tools: project.tools,
          tabs: project.tabs,
          clamps: project.clamps,
        })
      }

      return result
    },
    [project]
  )

  // Operations that need toolpath computation (selected first for priority)
  const neededOperationIds = useMemo(() => {
    const ids: string[] = []
    const seen = new Set<string>()
    if (selectedOperation) {
      ids.push(selectedOperation.id)
      seen.add(selectedOperation.id)
    }
    for (const op of project.operations) {
      if (op.showToolpath && !seen.has(op.id)) {
        ids.push(op.id)
      }
    }
    return ids
  }, [selectedOperation, project.operations])

  // Derived during render by checking cache validity — the spinner shows on
  // the very first render after a parameter change, not one frame late.
  // toolpathMap is included as a dependency so the memo recomputes when the
  // async pipeline finishes and updates the map (which also updates the cache).
  const generatingOperationIds = useMemo(() => {
    const ids = new Set<string>()
    for (const id of neededOperationIds) {
      const op = project.operations.find((o) => o.id === id)
      if (!op) continue
      const entry = toolpathCacheRef.current.get(id)
      if (!entry || !isCacheHit(entry, op, project)) {
        ids.add(id)
      }
    }
    return ids
  }, [neededOperationIds, project, toolpathMap])

  // Async toolpath pipeline: resolves cached results immediately, defers
  // uncached operations one-per-frame with a paint gap in between so the
  // spinner (derived from cache staleness above) stays animated.
  useEffect(() => {
    const immediateResults = new Map<string, ToolpathResult>()
    const toCompute: string[] = []

    for (const id of neededOperationIds) {
      const op = project.operations.find((o) => o.id === id)
      if (!op) continue

      const entry = toolpathCacheRef.current.get(id)
      if (entry && isCacheHit(entry, op, project)) {
        immediateResults.set(id, entry.result)
      } else {
        toCompute.push(id)
      }
    }

    setToolpathMap(immediateResults)

    if (toCompute.length === 0) {
      return
    }

    let cancelled = false
    let idx = 0

    function computeNext() {
      if (cancelled || idx >= toCompute.length) return

      const op = project.operations.find((o) => o.id === toCompute[idx])
      if (op && !cancelled) {
        const result = generateToolpathForOperation(op)
        if (!cancelled) {
          setToolpathMap((prev) => {
            const next = new Map(prev)
            if (result) next.set(op.id, result)
            return next
          })
        }
      }

      idx++
      if (idx < toCompute.length && !cancelled) {
        scheduleAfterPaint(computeNext)
      }
    }

    // Double-rAF: the first rAF fires before the current paint, the second
    // fires in the next frame — guaranteeing one browser paint in between.
    // This ensures the spinner is visually rendered before computation blocks.
    requestAnimationFrame(() => {
      if (!cancelled) requestAnimationFrame(computeNext)
    })
    return () => { cancelled = true }
  }, [neededOperationIds, generateToolpathForOperation, project])

  const selectedToolpath = selectedOperation
    ? toolpathMap.get(selectedOperation.id) ?? null
    : null

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
      .map((operation) => toolpathMap.get(operation.id))
      .filter((toolpath): toolpath is ToolpathResult => toolpath != null)
  }, [project.operations, toolpathMap])
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
      setMenuPosition(null)
      setQuickOpsSubmenu(null)
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setTreeContextMenu(null)
        setMenuPosition(null)
        setQuickOpsSubmenu(null)
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
        toolbar={
          <Toolbar
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
            toolpathWarnings={selectedToolpath?.warnings ?? null}
            generatingOperationIds={generatingOperationIds}
            onOperationHighlightChange={setOperationHighlightKind}
          />
        }
        centerTab={centerTab}
        onCenterTabChange={handleCenterTabChange}
        workspaceLayout={workspaceLayout}
        onWorkspaceLayoutChange={setWorkspaceLayout}
        toolbarOrientation={effectiveToolbarOrientation}
        toolbarOrientationForced={isToolbarForcedTop}
        onToolbarOrientationChange={setToolbarOrientationPreference}
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
