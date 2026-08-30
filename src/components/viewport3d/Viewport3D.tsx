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

import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import * as THREE from 'three'
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js'
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js'
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js'
import { ToolpathVisibilityPanel } from '../ToolpathVisibilityPanel'
import { toolpathHasEngagementTelemetry, feedColourLegendSteps as getFeedColourLegendSteps, type ToolpathVisibility } from '../toolpathVisibility'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import { useProjectStore } from '../../store/projectStore'
import { modelFeatures } from '../../store/helpers/featureRoles'
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { applyClampHighlight, applyTabHighlight, buildOriginTriad, buildScene } from '../../engine/csg'
import { getStockBounds, rectProfile } from '../../types/project'
import { getFeaturesWorldBounds } from '../canvas/scenePrimitives'
import { getFeatureGeometryProfiles } from '../../text'
import {
  buildToolpathLinePositionChunks,
  buildToolpathOverlayLayers,
  moveMatchesZFilter,
  toolpathLayerBuckets,
  toolpathPointToWorldTuple,
  type ToolpathLayerZFilter,
  type ToolpathOverlayLayerKey,
} from './toolpathOverlay'
import { useTheme } from '../../theme/themeContext'
import { feedColourStep, pocketSlotFeedPercent, threeFeedColour, type ThreeThemePalette } from '../../theme/palette'
import { ARROW_KINDS, buildArrowBatch, type ArrowPlacement } from './arrowBatch'
import { createOrbitControls, type OrbitControls } from './orbitControls'
import type { ViewPreset } from './viewPresets'
import { ViewPresetMenu } from './ViewPresetMenu'

function configureGridMaterial(material: THREE.Material | THREE.Material[]) {
  const materials = Array.isArray(material) ? material : [material]
  for (const entry of materials) {
    if (entry instanceof THREE.LineBasicMaterial) {
      entry.transparent = true
      entry.opacity = 0.85
      entry.depthWrite = false
    }
  }
}

export interface Viewport3DHandle {
  zoomToModel: () => void
}

interface Viewport3DProps {
  toolpaths?: ToolpathResult[]
  /** False while another centre tab is showing. Gates the render loop only —
   *  the scene stays built so a tab switch shows the current state at once. */
  isActive?: boolean
  selectedOperationId?: string | null
  collidingClampIds?: string[]
  originVisible?: boolean
  zoomWindowActive?: boolean
  onZoomWindowComplete?: () => void
  toolpathVisibility: ToolpathVisibility
  onToolpathVisibilityChange: (visibility: ToolpathVisibility) => void
  toolpathPanelExpanded: boolean
  onToolpathPanelExpandedChange: (expanded: boolean) => void
}

function disposeObject3D(object: THREE.Object3D) {
  object.traverse((entry) => {
    if (entry instanceof THREE.Mesh || entry instanceof THREE.Line) {
      entry.geometry.dispose()
      if (Array.isArray(entry.material)) {
        entry.material.forEach((material) => material.dispose())
      } else {
        entry.material.dispose()
      }
    }
  })
}

function toolpathPointToWorld(point: ToolpathResult['moves'][number]['from']): THREE.Vector3 {
  return new THREE.Vector3(...toolpathPointToWorldTuple(point))
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function buildToolpathEndpointMarkers(toolpath: ToolpathResult, emphasized: boolean, palette: ThreeThemePalette): THREE.Object3D[] {
  if (toolpath.moves.length === 0) {
    return []
  }

  const firstPoint = toolpathPointToWorld(toolpath.moves[0].from)
  const lastPoint = toolpathPointToWorld(toolpath.moves[toolpath.moves.length - 1].to)
  const bounds = toolpath.bounds
  const span = bounds
    ? Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ)
    : 10
  const markerLength = clamp(span * 0.08, 0.2, 8)
  const headLength = markerLength * 0.38
  const headWidth = markerLength * 0.16
  const lineOpacity = emphasized ? 0.96 : 0.6

  const startArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, -1, 0),
    firstPoint.clone().add(new THREE.Vector3(0, markerLength, 0)),
    markerLength,
    palette.toolpathPlunge,
    headLength,
    headWidth,
  )
  const endArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    lastPoint,
    markerLength,
    palette.toolpathRapid,
    headLength,
    headWidth,
  )

  const markers = [startArrow, endArrow]
  for (const marker of markers) {
    marker.traverse((entry) => {
      if (entry instanceof THREE.Line || entry instanceof THREE.Mesh) {
        const material = Array.isArray(entry.material) ? entry.material : [entry.material]
        material.forEach((item) => {
          item.transparent = true
          item.opacity = lineOpacity
          item.depthWrite = false
          item.depthTest = false
        })
      }
    })
  }

  return markers
}

function buildToolpathDirectionMarkers(
  toolpath: ToolpathResult,
  emphasized: boolean,
  visibility: ToolpathVisibility,
  palette: ThreeThemePalette,
): THREE.Object3D[] {
  if (!emphasized || toolpath.moves.length === 0) {
    return []
  }

  const bounds = toolpath.bounds
  const span = bounds
    ? Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ)
    : 10
  const preferredMarkerLength = clamp(span * 0.028, 0.04, 2.4)
  const preferredSpacing = clamp(span * 0.09, 0.12, 8)
  const horizontalTolerance = 1e-6
  const objects: THREE.Object3D[] = []
  const distanceSinceLastArrowByKind: Record<'cut' | 'rapid', number> = {
    cut: 0,
    rapid: 0,
  }
  const placements: Record<'cut' | 'rapid', ArrowPlacement[]> = { cut: [], rapid: [] }

  function getHorizontalDirection(move: ToolpathResult['moves'][number] | undefined): THREE.Vector3 | null {
    if (!move || (move.kind !== 'cut' && move.kind !== 'rapid')) {
      return null
    }

    const from = toolpathPointToWorld(move.from)
    const to = toolpathPointToWorld(move.to)
    const delta = to.clone().sub(from)
    if (Math.abs(delta.y) > horizontalTolerance || delta.length() <= 1e-6) {
      return null
    }

    return delta.normalize()
  }

  for (let moveIndex = 0; moveIndex < toolpath.moves.length; moveIndex += 1) {
    const move = toolpath.moves[moveIndex]
    if (move.kind !== 'cut' && move.kind !== 'rapid') {
      continue
    }

    // Respect visibility toggles
    if (move.kind === 'cut' && !visibility.cuts) continue
    if (move.kind === 'rapid') {
      // Same split as the line layers, via the same predicate — the arrow code
      // having its own copy is how the two fell out of step (issue #482).
      const isRetraction = moveMatchesZFilter(move, 'retract')
      if (isRetraction && !visibility.retractions) continue
      if (!isRetraction && !visibility.rapids) continue
    }

    const from = toolpathPointToWorld(move.from)
    const to = toolpathPointToWorld(move.to)
    const delta = to.clone().sub(from)
    if (Math.abs(delta.y) > horizontalTolerance) {
      distanceSinceLastArrowByKind[move.kind] = 0
      continue
    }

    const length = delta.length()
    if (!(length >= 0.001)) {
      continue
    }

    const direction = delta.clone().normalize()
    distanceSinceLastArrowByKind[move.kind] += length

    const previousDirection = getHorizontalDirection(toolpath.moves[moveIndex - 1])
    const nextDirection = getHorizontalDirection(toolpath.moves[moveIndex + 1])
    const directionTurn =
      previousDirection && nextDirection
        ? Math.min(
          direction.angleTo(previousDirection),
          direction.angleTo(nextDirection),
        )
        : null
    const isConnectorCut =
      move.kind === 'cut'
      && length <= preferredSpacing * 0.8
      && directionTurn !== null
      && directionTurn >= Math.PI / 10

    const shouldForceArrow = length >= preferredMarkerLength * 1.1
    const shouldPlaceBySpacing = distanceSinceLastArrowByKind[move.kind] >= preferredSpacing
    if (!shouldForceArrow && !shouldPlaceBySpacing && !isConnectorCut) {
      continue
    }

    const markerLength = clamp(Math.min(preferredMarkerLength, Math.max(length * 0.55, preferredMarkerLength * 0.45)), 0.02, 2.4)
    const headLength = markerLength * 0.45
    const headWidth = markerLength * 0.18
    const center = from.clone().add(to).multiplyScalar(0.5)
    const origin = center.clone().sub(direction.clone().multiplyScalar(markerLength * 0.5))
    placements[move.kind].push({ origin, direction, markerLength, headLength, headWidth })
    distanceSinceLastArrowByKind[move.kind] = 0
  }

  // One batch per kind rather than one `ArrowHelper` per arrow (issue #664).
  for (const kind of ARROW_KINDS) {
    const batch = placements[kind]
    if (batch.length === 0) continue
    const color = kind === 'rapid' ? palette.toolpathRapid : palette.toolpathCut
    objects.push(...buildArrowBatch(batch, color))
  }

  return objects
}

// ---------------------------------------------------------------------------
// Debug marker symbols — drawn as canvas sprites keyed to DIAG source tags.
// Only rendered when operation.debugToolpath is enabled.
// ---------------------------------------------------------------------------

function buildToolpathOverlay(
  toolpath: ToolpathResult,
  emphasized: boolean,
  visibility: ToolpathVisibility,
  palette: ThreeThemePalette,
  resolution: THREE.Vector2,
  slotScale: number,
): THREE.Object3D[] {
  const schemaLayers = buildToolpathOverlayLayers(visibility)
  const layers: Array<{
    key: ToolpathOverlayLayerKey
    kinds: ToolpathResult['moves'][number]['kind'][]
    color: number
    opacity: number
    linewidth: number
    visible: boolean
    zFilter?: ToolpathLayerZFilter
  }> = schemaLayers.map((layer) => {
    const color =
      layer.key === 'cuts' || layer.key === 'leadIns' ? palette.toolpathCut
      : layer.key === 'rapids' || layer.key === 'retractions' ? palette.toolpathRapid
      : palette.toolpathPlunge
    const opacity =
      layer.key === 'cuts' || layer.key === 'leadIns' ? 0.98
      : layer.key === 'rapids' || layer.key === 'retractions' ? 0.75
      : 0.9
    const baseLinewidth =
      layer.key === 'cuts' || layer.key === 'leadIns' ? 2.5
      : layer.key === 'rapids' || layer.key === 'retractions' ? 1.8
      : 2.0
    const linewidth = emphasized ? baseLinewidth + 0.5 : Math.max(1.2, baseLinewidth - 0.5)
    return { key: layer.key, kinds: layer.kinds, color, opacity, linewidth, visible: layer.visible, zFilter: layer.zFilter }
  })
  // Feed colours are on when the toggle says so, or by default for the
  // selected engagement-mode operation (issue #498 S4). A move whose
  // feedScale is absent or 1 maps to step 0, which is toolpathCut exactly.
  // The ladder is derived from the toolpath's own slot feed (S5), so the
  // thresholds match what the engine emitted for this toolpath.
  const feedColoursOn = visibility.feedColours ?? (emphasized && toolpathHasEngagementTelemetry(toolpath))

  // Cached by toolpath identity — see `toolpathLayerBuckets` (issue #664).
  const buckets = toolpathLayerBuckets(toolpath)
  const objects: THREE.Object3D[] = []
  for (const layer of layers) {
    if (!layer.visible) continue

    const moves = buckets[layer.key]

    if (moves.length === 0) {
      continue
    }

    const pushLines = (layerMoves: ToolpathResult['moves'], color: number): void => {
      const material = new LineMaterial({
        color,
        linewidth: layer.linewidth,
        worldUnits: false,
        resolution,
        transparent: true,
        opacity: emphasized ? layer.opacity : Math.max(layer.opacity * 0.55, 0.45),
        depthWrite: false,
        depthTest: false,
      })

      for (const chunk of buildToolpathLinePositionChunks(layerMoves)) {
        const geometry = new LineSegmentsGeometry()
        geometry.setPositions(chunk.positions)
        objects.push(new LineSegments2(geometry, material))
      }
    }

    if (layer.key === 'cuts' && feedColoursOn) {
      // One material per emitted feed bucket. Cuts only — lead-ins, rapids,
      // plunges and retractions keep their existing tokens.
      const byStep = new Map<number, ToolpathResult['moves']>()
      for (const move of moves) {
        const step = feedColourStep(move.feedScale, slotScale)
        const stepMoves = byStep.get(step)
        if (stepMoves) {
          stepMoves.push(move)
        } else {
          byStep.set(step, [move])
        }
      }
      for (const [step, stepMoves] of byStep) {
        pushLines(stepMoves, threeFeedColour(step, palette))
      }
      continue
    }

    pushLines(moves, layer.color)
  }

  if (emphasized && visibility.directions) {
    objects.push(...buildToolpathDirectionMarkers(toolpath, emphasized, visibility, palette))
    objects.push(...buildToolpathEndpointMarkers(toolpath, emphasized, palette))
  }

  return objects
}

export const Viewport3D = forwardRef<Viewport3DHandle, Viewport3DProps>(function Viewport3D({
  toolpaths = [],
  isActive = true,
  selectedOperationId = null,
  collidingClampIds = [],
  originVisible = true,
  zoomWindowActive = false,
  onZoomWindowComplete,
  toolpathVisibility,
  onToolpathVisibilityChange,
  toolpathPanelExpanded,
  onToolpathPanelExpandedChange,
}, ref) {
  const { palette } = useTheme()
  const threePalette = palette.three
  // Mirrored into a ref because the render loop is raw RAF, not React-driven.
  const isActiveRef = useRef(isActive)
  isActiveRef.current = isActive
  const threePaletteRef = useRef(threePalette)
  const mountRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const gridRef = useRef<THREE.Group | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<OrbitControls | null>(null)
  const frameRef = useRef<number>(0)
  const objectsRef = useRef<THREE.Object3D[]>([])
  // The most recently built fixture meshes, keyed by id, so selection/collision
  // highlight can recolor them in place without a full scene rebuild (issue #261).
  const clampMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map())
  const tabMeshesRef = useRef<Map<string, THREE.Mesh>>(new Map())
  const toolpathObjectsRef = useRef<THREE.Object3D[]>([])
  const originObjectRef = useRef<THREE.Object3D | null>(null)
  const buildRequestRef = useRef(0)
  const [activePreset, setActivePreset] = useState<ViewPreset | null>('iso')
  const zoomWindowActiveRef = useRef(zoomWindowActive)
  const [zoomWindowBox, setZoomWindowBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)
  const zoomWindowBoxRef = useRef<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)

  const { project, selection, projectKey } = useProjectStore()
  // The toolpath overlay effect reads the project through this ref so the
  // per-toolpath slot-feed lookup stays fresh without rebuilding overlays on
  // unrelated project edits (toolpaths already change when the slot feed does).
  const projectRef = useRef(project)
  // Mirror the zoom-window state into refs for the orbit-controls callback and
  // pointer handlers (which read them outside render). Write after commit, not
  // during render, so we don't touch refs while rendering.
  useLayoutEffect(() => {
    threePaletteRef.current = threePalette
    projectRef.current = project
    zoomWindowActiveRef.current = zoomWindowActive
    zoomWindowBoxRef.current = zoomWindowBox
  }, [threePalette, zoomWindowActive, zoomWindowBox, project])

  // Reset the zoom-window box during render when the tool deactivates (React-
  // recommended adjust-state-during-render; the ref mirror above nulls
  // zoomWindowBoxRef after commit, so we only touch state here).
  if (!zoomWindowActive && zoomWindowBox !== null) {
    setZoomWindowBox(null)
  }

  const syncGridVisibility = useCallback(() => {
    const gridGroup = gridRef.current
    if (!gridGroup) return
    gridGroup.visible = project.grid.visible
  }, [project.grid.visible])

  const zoomToModel = useCallback(() => {
    const controls = controlsRef.current
    if (!controls || objectsRef.current.length === 0) return

    const bounds = new THREE.Box3()
    let hasRenderableObject = false

    for (const object of objectsRef.current) {
      if (!object.visible) continue
      bounds.expandByObject(object)
      hasRenderableObject = true
    }

    if (!hasRenderableObject || bounds.isEmpty()) return
    controls.fitToBounds(bounds)
  }, [])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) return

    const renderer = new THREE.WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.setClearColor(threePaletteRef.current.background, 1)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.touchAction = 'none'
    mount.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    sceneRef.current = scene

    const ambient = new THREE.AmbientLight(0xffffff, 0.6) // theme-exempt: scene lighting rig
    scene.add(ambient)
    const dir = new THREE.DirectionalLight(0xffffff, 0.8) // theme-exempt: scene lighting rig
    dir.position.set(100, 200, 100)
    scene.add(dir)
    const dir2 = new THREE.DirectionalLight(0x8899ff, 0.3) // theme-exempt: scene lighting rig
    dir2.position.set(-100, 50, -100)
    scene.add(dir2)

    const grid = new THREE.Group()
    grid.position.set(50, 0, 40)
    scene.add(grid)
    gridRef.current = grid

    const camera = new THREE.PerspectiveCamera(
      45,
      mount.clientWidth / mount.clientHeight,
      0.1,
      2000
    )
    cameraRef.current = camera

    const controls = createOrbitControls(camera, renderer.domElement, {
      onChange: () => {
        renderer.render(scene, camera)
      },
      onPresetChange: (preset) => {
        setActivePreset(preset)
        syncGridVisibility()
      },
      isInteractionBlocked: () => zoomWindowActiveRef.current,
      initialTarget: [50, 0, 40],
    })
    controlsRef.current = controls

    function animate() {
      frameRef.current = requestAnimationFrame(animate)
      // Skip the GPU draw while another centre tab is showing (issue #664).
      // All three tab panels stay mounted — `AppShell` hides them with CSS —
      // so without this the 3D scene was re-submitted at 60 Hz behind the 2D
      // sketch for the life of the session. The scene itself stays built, so
      // switching back shows the current state on the very next frame.
      if (!isActiveRef.current) return
      renderer.render(scene, camera)
    }
    animate()

    const ro = new ResizeObserver(() => {
      if (!mount) return
      renderer.setSize(mount.clientWidth, mount.clientHeight)
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
    })
    ro.observe(mount)

    return () => {
      cancelAnimationFrame(frameRef.current)
      controls.dispose()
      ro.disconnect()
      for (const object of objectsRef.current) {
        scene.remove(object)
        disposeObject3D(object)
      }
      objectsRef.current = []
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [syncGridVisibility])

  const disposeObjectMaterial = useCallback((material: THREE.Material | THREE.Material[]) => {
    if (Array.isArray(material)) {
      material.forEach((entry) => entry.dispose())
      return
    }

    material.dispose()
  }, [])

  const rebuildGridHelpers = useCallback(() => {
    const gridGroup = gridRef.current
    if (!gridGroup) return

    for (const child of [...gridGroup.children]) {
      gridGroup.remove(child)
      if (child instanceof THREE.LineSegments) {
        child.geometry.dispose()
        disposeObjectMaterial(child.material)
      }
    }

    const stockBounds = getStockBounds(project.stock)
    const centerX = stockBounds.minX + (stockBounds.maxX - stockBounds.minX) / 2
    const centerZ = stockBounds.minY + (stockBounds.maxY - stockBounds.minY) / 2

    gridGroup.position.set(centerX, -0.05, centerZ)
    syncGridVisibility()
    if (!project.grid.visible) return

    const defaultExtent = Math.max(project.grid.extent, project.grid.minorSpacing)
    let extent = defaultExtent

    // Dynamically extend the grid to cover feature geometry on all sides.
    const featureWorldBounds = getFeaturesWorldBounds(resolvedProjectFeatures(project))
    if (featureWorldBounds) {
      const toLeft = Math.abs(featureWorldBounds.minX - centerX)
      const toRight = Math.abs(featureWorldBounds.maxX - centerX)
      const toTop = Math.abs(featureWorldBounds.minY - centerZ)
      const toBottom = Math.abs(featureWorldBounds.maxY - centerZ)
      const neededReach = Math.max(toLeft, toRight, toTop, toBottom)
      const padding = project.grid.majorSpacing
      extent = Math.max(defaultExtent, (neededReach + padding) * 2)
    }

    // THREE.GridHelper expects total extent, not half-extent.
    const minorDivisions = Math.max(1, Math.round(extent / project.grid.minorSpacing))
    const majorDivisions = Math.max(1, Math.round(extent / project.grid.majorSpacing))

    const palette = threePaletteRef.current
    const minorGrid = new THREE.GridHelper(extent, minorDivisions, palette.gridMinorCenter, palette.gridMinor)
    const majorGrid = new THREE.GridHelper(extent, majorDivisions, palette.gridMajorCenter, palette.gridMajor)
    configureGridMaterial(minorGrid.material)
    configureGridMaterial(majorGrid.material)
    majorGrid.position.y = 0.001

    gridGroup.add(minorGrid)
    gridGroup.add(majorGrid)
  }, [disposeObjectMaterial, project, syncGridVisibility])

  useEffect(() => {
    rendererRef.current?.setClearColor(threePalette.background, 1)
    rebuildGridHelpers()
  }, [rebuildGridHelpers, threePalette])

  const clearRenderedObjects = useCallback((scene: THREE.Scene) => {
    for (const object of objectsRef.current) {
      scene.remove(object)
      disposeObject3D(object)
    }
    objectsRef.current = []
  }, [])

  const clearToolpathObjects = useCallback((scene: THREE.Scene) => {
    for (const object of toolpathObjectsRef.current) {
      scene.remove(object)
      if (object instanceof LineSegments2) {
        object.geometry.dispose()
        disposeObjectMaterial(object.material)
      } else if (object instanceof THREE.LineSegments) {
        object.geometry.dispose()
        disposeObjectMaterial(object.material)
      } else if (object instanceof THREE.Mesh) {
        // Mesh geometries are shared/cached so only dispose material.
        disposeObjectMaterial(object.material)
      } else if (object instanceof THREE.Sprite) {
        object.material.dispose()
      }
    }
    toolpathObjectsRef.current = []
  }, [disposeObjectMaterial])

  const clearOriginObject = useCallback((scene: THREE.Scene) => {
    if (!originObjectRef.current) {
      return
    }
    scene.remove(originObjectRef.current)
    disposeObject3D(originObjectRef.current)
    originObjectRef.current = null
  }, [])

  // Selection/collision only tint fixtures — recolor the already-built clamp/tab
  // meshes in place rather than rebuilding the CSG model (issue #261). Keyed on
  // primitives so this stays cheap and never triggers the scene-build effect.
  const selectedClampId = selection.selectedNode?.type === 'clamp' ? selection.selectedNode.clampId : null
  const selectedTabId = selection.selectedNode?.type === 'tab' ? selection.selectedNode.tabId : null
  const applyFixtureHighlights = useCallback(() => {
    const collidingClampIdSet = new Set(collidingClampIds)
    for (const [id, mesh] of clampMeshesRef.current) {
      applyClampHighlight(mesh, id === selectedClampId, collidingClampIdSet.has(id), threePalette)
    }
    for (const [id, mesh] of tabMeshesRef.current) {
      applyTabHighlight(mesh, id === selectedTabId, threePalette)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- threePalette changes only on theme toggle; adding it would force fixture rebuilds
  }, [collidingClampIds, selectedClampId, selectedTabId])

  // Mirror the latest highlighter into a ref so the async scene-build callback can
  // apply the CURRENT selection/collision to freshly-built fixtures without listing
  // it as a dependency (which would rebuild the model on every selection change).
  const applyFixtureHighlightsRef = useRef(applyFixtureHighlights)
  useEffect(() => {
    applyFixtureHighlightsRef.current = applyFixtureHighlights
  }, [applyFixtureHighlights])

  // Recolor fixtures whenever selection/collision changes — no model rebuild.
  useEffect(() => {
    applyFixtureHighlights()
  }, [applyFixtureHighlights])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    let cancelled = false
    const buildRequestId = buildRequestRef.current + 1
    buildRequestRef.current = buildRequestId

    const timeout = window.setTimeout(() => {
      void (async () => {
        const nextSceneObjects = await buildScene(project, threePaletteRef.current)

        if (cancelled || buildRequestRef.current !== buildRequestId) {
          nextSceneObjects.stockMesh.geometry.dispose()
          nextSceneObjects.stockWireframe.geometry.dispose()
          disposeObjectMaterial(nextSceneObjects.stockMesh.material)
          disposeObjectMaterial(nextSceneObjects.stockWireframe.material)
          nextSceneObjects.modelMesh?.geometry.dispose()
          if (nextSceneObjects.modelMesh) {
            disposeObjectMaterial(nextSceneObjects.modelMesh.material)
          }
          for (const featureMesh of nextSceneObjects.featureMeshes.values()) {
            disposeObject3D(featureMesh)
          }
          for (const tabMesh of nextSceneObjects.tabMeshes.values()) {
            tabMesh.geometry.dispose()
            disposeObjectMaterial(tabMesh.material)
          }
          for (const clampMesh of nextSceneObjects.clampMeshes.values()) {
            clampMesh.geometry.dispose()
            disposeObjectMaterial(clampMesh.material)
          }
          for (const line of nextSceneObjects.batchedLines) {
            disposeObject3D(line)
          }
          return
        }

        clearRenderedObjects(scene)

        scene.add(nextSceneObjects.stockMesh)
        scene.add(nextSceneObjects.stockWireframe)
        objectsRef.current.push(nextSceneObjects.stockMesh, nextSceneObjects.stockWireframe)

        if (nextSceneObjects.modelMesh) {
          scene.add(nextSceneObjects.modelMesh)
          objectsRef.current.push(nextSceneObjects.modelMesh)
        }

        for (const featureMesh of nextSceneObjects.featureMeshes.values()) {
          scene.add(featureMesh)
          objectsRef.current.push(featureMesh)
        }

        for (const line of nextSceneObjects.batchedLines) {
          scene.add(line)
          objectsRef.current.push(line)
        }

        for (const tabMesh of nextSceneObjects.tabMeshes.values()) {
          scene.add(tabMesh)
          objectsRef.current.push(tabMesh)
        }

        for (const clampMesh of nextSceneObjects.clampMeshes.values()) {
          scene.add(clampMesh)
          objectsRef.current.push(clampMesh)
        }

        // Track the freshly-built fixtures and immediately tint them to the
        // current selection/collision — buildScene builds them unhighlighted,
        // and selection may not have changed since the last rebuild (issue #261).
        clampMeshesRef.current = nextSceneObjects.clampMeshes
        tabMeshesRef.current = nextSceneObjects.tabMeshes
        applyFixtureHighlightsRef.current()

          const controls = controlsRef.current
        if (controls) {
          // Construction geometry is absent from the 3D scene — keep it out of
          // the camera-fit bounds as well (issue #199).
          const visibleFeatures = modelFeatures(resolvedProjectFeatures(project)).filter((feature) => feature.visible)
          const visibleTabs = project.tabs.filter((tab) => tab.visible)
          const visibleClamps = project.clamps.filter((clamp) => clamp.visible)
          const profiles =
            visibleFeatures.length > 0 || visibleTabs.length > 0 || visibleClamps.length > 0
              ? [
                  ...visibleFeatures.flatMap((feature) => getFeatureGeometryProfiles(feature)),
                  ...visibleTabs.map((tab) => ({
                    start: { x: tab.x, y: tab.y },
                    segments: rectProfile(tab.x, tab.y, tab.w, tab.h).segments,
                  })),
                  ...visibleClamps.map((clamp) => ({
                    start: { x: clamp.x, y: clamp.y },
                    segments: rectProfile(clamp.x, clamp.y, clamp.w, clamp.h).segments,
                  })),
                ]
              : [project.stock.profile]
          const points = profiles.flatMap((profile) => [profile.start, ...profile.segments.map((segment) => segment.to)])

          const minX = Math.min(...points.map((point) => point.x))
          const maxX = Math.max(...points.map((point) => point.x))
          const minWorldZ = Math.min(...points.map((point) => point.y))
          const maxWorldZ = Math.max(...points.map((point) => point.y))
          const sceneMinX = originVisible ? Math.min(minX, project.origin.x) : minX
          const sceneMaxX = originVisible ? Math.max(maxX, project.origin.x) : maxX
          const sceneMinWorldZ = originVisible ? Math.min(minWorldZ, project.origin.y) : minWorldZ
          const sceneMaxWorldZ = originVisible ? Math.max(maxWorldZ, project.origin.y) : maxWorldZ
          const verticalValues =
            visibleFeatures.length > 0 || visibleTabs.length > 0 || visibleClamps.length > 0
              ? [
                  ...visibleFeatures.flatMap((feature) => {
                    const top = typeof feature.z_top === 'number' ? feature.z_top : 0
                    const bottom = typeof feature.z_bottom === 'number' ? feature.z_bottom : 0
                    return [top, bottom]
                  }),
                  ...visibleTabs.flatMap((tab) => [tab.z_top, tab.z_bottom]),
                  ...visibleClamps.flatMap((clamp) => [0, clamp.height]),
                ]
              : [
                0,
                project.stock.visible ? project.stock.thickness : 0,
              ]
          const minY = Math.min(...verticalValues, originVisible ? project.origin.z : Infinity)
          const maxY = Math.max(...verticalValues, originVisible ? project.origin.z : -Infinity)

          const centerX = sceneMinX + (sceneMaxX - sceneMinX) / 2
          const centerY = minY + (maxY - minY) / 2
          const centerZ = sceneMinWorldZ + (sceneMaxWorldZ - sceneMinWorldZ) / 2

          controls.setTarget(centerX, centerY, centerZ)
          rebuildGridHelpers()
        }
      })()
    }, 150)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
    // Keyed on geometry inputs only. Selection and collision no longer rebuild
    // the CSG model — a separate effect recolors fixtures via applyFixtureHighlights
    // (issue #261). applyFixtureHighlightsRef is a stable ref, so it's omitted.
  }, [clearRenderedObjects, disposeObjectMaterial, originVisible, project, rebuildGridHelpers])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) {
      return
    }

    clearToolpathObjects(scene)

    const mount = mountRef.current
    const resolution = new THREE.Vector2(
      mount?.clientWidth || window.innerWidth,
      mount?.clientHeight || window.innerHeight,
    )
    const nextObjects = toolpaths.flatMap((toolpath) => {
      if (toolpath.moves.length === 0) {
        return []
      }
      // Colour rungs derive from the toolpath's own operation slot feed so the
      // thresholds match the scales that operation emitted (issue #498 S5).
      const slotFeedPercent = pocketSlotFeedPercent(projectRef.current.operations.find((op) => op.id === toolpath.operationId))
      return buildToolpathOverlay(
        toolpath,
        toolpath.operationId === selectedOperationId,
        toolpathVisibility,
        threePalette,
        resolution,
        slotFeedPercent === null ? 1 : slotFeedPercent / 100,
      )
    })
    if (nextObjects.length === 0) {
      return
    }
    for (const object of nextObjects) {
      scene.add(object)
    }
    toolpathObjectsRef.current = nextObjects

    return () => {
      clearToolpathObjects(scene)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- threePalette is stable per theme; adding would recreate overlay on theme toggle
  }, [clearToolpathObjects, selectedOperationId, toolpaths, toolpathVisibility])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) {
      return
    }

    clearOriginObject(scene)
    if (!originVisible) {
      return
    }

    const stockBounds = getStockBounds(project.stock)
    const stockWidth = stockBounds.maxX - stockBounds.minX
    const stockHeight = stockBounds.maxY - stockBounds.minY
    const axisSize = Math.max(Math.max(stockWidth, stockHeight, project.stock.thickness) * 0.05, 0.05)
    const triad = buildOriginTriad(project.origin, axisSize, threePalette)
    scene.add(triad)
    originObjectRef.current = triad

    return () => {
      clearOriginObject(scene)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps -- threePalette is stable per theme; adding would rebuild triad on theme toggle
  }, [clearOriginObject, originVisible, project.origin, project.stock])
// Reset to default isometric view when a new project is created/loaded
useEffect(() => {
  if (projectKey === 0) return
  const controls = controlsRef.current
  if (!controls) return

  // Scene objects are rebuilt in a separate effect with a 150ms timeout.
  // Wait for them to be available before fitting to bounds.
  const timer = setTimeout(() => {
    const bounds = new THREE.Box3()
    let hasRenderableObject = false
    for (const object of objectsRef.current) {
      if (!object.visible) continue
      bounds.expandByObject(object)
      hasRenderableObject = true
    }
    if (!hasRenderableObject || bounds.isEmpty()) {
      controls.reset()
      return
    }
    controls.fitToBounds(bounds, true)
  }, 250)

  return () => clearTimeout(timer)
}, [projectKey])

useImperativeHandle(ref, () => ({
  zoomToModel,
}), [zoomToModel])

  const zoomBoxStyle = zoomWindowBox
    ? {
        left: Math.min(zoomWindowBox.startX, zoomWindowBox.currentX),
        top: Math.min(zoomWindowBox.startY, zoomWindowBox.currentY),
        width: Math.abs(zoomWindowBox.currentX - zoomWindowBox.startX),
        height: Math.abs(zoomWindowBox.currentY - zoomWindowBox.startY),
      }
    : null

  // The feed-colour toggle's auto default: on when the selected operation is
  // an engagement-mode pocket, off otherwise (issue #498 S4). The legend
  // describes only the selected operation's toolpath — one ladder, no union
  // across operations, so duplicate labels and non-monotonic ramps are
  // unreachable (issue #622). The per-toolpath scan is cached by toolpath
  // identity, so no move scan runs on this render path.
  const selectedToolpathForLegend = toolpaths.find((toolpath) => toolpath.operationId === selectedOperationId) ?? null
  const feedColoursDefault = selectedToolpathForLegend !== null && toolpathHasEngagementTelemetry(selectedToolpathForLegend)
  const feedColourLegendSteps = selectedToolpathForLegend !== null
    ? getFeedColourLegendSteps(selectedToolpathForLegend, (() => {
        const percent = pocketSlotFeedPercent(project.operations.find((op) => op.id === selectedOperationId))
        return percent === null ? 1 : percent / 100
      })())
    : []

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      {zoomWindowActive && (
        <div
          className="viewport-zoom-select-overlay"
          onPointerDown={(event) => {
            event.preventDefault()
            const bounds = event.currentTarget.getBoundingClientRect()
            const x = event.clientX - bounds.left
            const y = event.clientY - bounds.top
            const nextBox = { startX: x, startY: y, currentX: x, currentY: y }
            zoomWindowBoxRef.current = nextBox
            setZoomWindowBox(nextBox)
          }}
          onPointerMove={(event) => {
            const bounds = event.currentTarget.getBoundingClientRect()
            const nextX = event.clientX - bounds.left
            const nextY = event.clientY - bounds.top
            setZoomWindowBox((current) => {
              if (!current) {
                return current
              }
              const nextBox = {
                ...current,
                currentX: nextX,
                currentY: nextY,
              }
              zoomWindowBoxRef.current = nextBox
              return nextBox
            })
          }}
          onPointerUp={() => {
            const nextBox = zoomWindowBoxRef.current
            if (nextBox) {
              controlsRef.current?.fitToScreenRect(nextBox.startX, nextBox.startY, nextBox.currentX, nextBox.currentY)
            }
            zoomWindowBoxRef.current = null
            setZoomWindowBox(null)
            onZoomWindowComplete?.()
          }}
          onPointerLeave={() => {
            if (!zoomWindowBoxRef.current) {
              return
            }
            zoomWindowBoxRef.current = null
            setZoomWindowBox(null)
          }}
        >
          {zoomBoxStyle && <div className="viewport-zoom-select-box" style={zoomBoxStyle} />}
        </div>
      )}
      {toolpaths.length > 0 && (
        <ToolpathVisibilityPanel
          visibility={toolpathVisibility}
          onChange={onToolpathVisibilityChange}
          expanded={toolpathPanelExpanded}
          onExpandedChange={onToolpathPanelExpandedChange}
          feedColoursDefault={feedColoursDefault}
          legendSteps={feedColourLegendSteps}
        />
      )}
      <div className="viewport-presets">
        <ViewPresetMenu
          activePreset={activePreset}
          onSelect={(preset) => controlsRef.current?.setPreset(preset)}
          onFit={() => zoomToModel()}
          onReset={() => {
            controlsRef.current?.reset()
            zoomToModel()
          }}
        />
      </div>
    </div>
  )
})
