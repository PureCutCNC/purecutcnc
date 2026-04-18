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

import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as THREE from 'three'
import { Icon } from '../Icon'
import { buildClampMesh, buildOriginTriad } from '../../engine/csg'
import { buildSimulationGeometry } from '../../engine/simulation/mesh'
import { PlaybackController } from '../../engine/simulation/playback'
import { buildToolMesh, disposeToolMesh } from '../../engine/simulation/toolMesh'
import type { SimulationGrid, SimulationResult } from '../../engine/simulation'
import type { ToolpathMove } from '../../engine/toolpaths/types'
import type { Clamp, MachineOrigin, Operation, ToolType } from '../../types/project'

const DEFAULT_CAMERA_SPHERICAL = {
  theta: Math.PI / 4,
  phi: Math.PI / 3,
  radius: 250,
}

const MIN_CAMERA_RADIUS = 0.1
const MAX_CAMERA_RADIUS = 10000

type ViewPreset = 'iso' | 'top' | 'bottom' | 'front' | 'back' | 'right' | 'left'

const VIEW_PRESETS: Record<ViewPreset, { theta: number; phi: number; up: THREE.Vector3Tuple }> = {
  iso: {
    theta: DEFAULT_CAMERA_SPHERICAL.theta,
    phi: DEFAULT_CAMERA_SPHERICAL.phi,
    up: [0, 1, 0],
  },
  top: {
    theta: 0,
    phi: 0.05,
    up: [0, 0, -1],
  },
  bottom: {
    theta: 0,
    phi: Math.PI - 0.05,
    up: [0, 0, 1],
  },
  front: {
    theta: 0,
    phi: Math.PI / 2,
    up: [0, 1, 0],
  },
  back: {
    theta: Math.PI,
    phi: Math.PI / 2,
    up: [0, 1, 0],
  },
  right: {
    theta: Math.PI / 2,
    phi: Math.PI / 2,
    up: [0, 1, 0],
  },
  left: {
    theta: (3 * Math.PI) / 2,
    phi: Math.PI / 2,
    up: [0, 1, 0],
  },
}

export interface SimulationPlaybackInput {
  baseGrid: SimulationGrid
  moves: ToolpathMove[]
  toolType: ToolType
  toolRadius: number
  vBitAngle: number | null
  /** Flute / cutting portion length in project units. */
  toolCutLength?: number
  /** Shank length above the flutes in project units. */
  toolShankLength?: number
  /** Max length of any single internal sub-move. Long sources get split. */
  maxSegmentLength?: number
  /** Project units for UI labels ('mm' or 'in'). */
  units?: 'mm' | 'in'
  /**
   * Operation feed rate converted to project-units-per-second. When provided, this
   * becomes the "1×" baseline for the playback speed multiplier so the user can
   * scrub faster/slower relative to the real cutting feed. Omit (or pass 0) to
   * fall back to the generic per-unit default.
   */
  feedPerSecond?: number
}

interface SimulationViewportProps {
  operation: Operation | null
  simulation: SimulationResult | null
  detailCells: number
  onDetailCellsChange: (cells: number) => void
  mode: 'selected' | 'visible'
  onModeChange: (mode: 'selected' | 'visible') => void
  operationCount: number
  clamps: Clamp[]
  selectedClampId: string | null
  collidingClampIds: string[]
  origin: MachineOrigin
  stockColor?: string
  zoomWindowActive?: boolean
  onZoomWindowComplete?: () => void
  playbackInput: SimulationPlaybackInput | null
}

export interface SimulationViewportHandle {
  zoomToModel: () => void
}

const SIMULATION_DETAIL_MIN = 240
const SIMULATION_DETAIL_MAX = 720
const SIMULATION_DETAIL_STEP = 40

/**
 * Playback speed is a multiplier of the operation's feed rate ("1×" means "play at
 * the real cutting feed"). The UI renders a log-scaled slider so the low end (where
 * small changes matter visually) gets as much travel as the high end. When the op
 * doesn't expose a feed rate we fall back to a generic per-unit default.
 */
const PLAYBACK_MULTIPLIER_MIN = 1
// Above ~30× the per-frame Step cap and the browser's RAF cadence both saturate,
// so further increases stop translating into faster playback. Cap at 32× to keep
// the slider's range meaningful end-to-end.
const PLAYBACK_MULTIPLIER_MAX = 32
const PLAYBACK_DEFAULT_MULTIPLIER = 2
const PLAYBACK_SLIDER_STEPS = 100
const PLAYBACK_FALLBACK_FEED_MM = 50
const PLAYBACK_FALLBACK_FEED_IN = 2

/**
 * Map a linear slider position (0..STEPS) to a multiplier using a log scale so the
 * low end feels precise even when the top end reaches into the hundreds.
 */
function sliderPositionToMultiplier(position: number): number {
  const t = Math.max(0, Math.min(1, position / PLAYBACK_SLIDER_STEPS))
  const log = Math.log(PLAYBACK_MULTIPLIER_MIN) + t * (Math.log(PLAYBACK_MULTIPLIER_MAX) - Math.log(PLAYBACK_MULTIPLIER_MIN))
  return Math.exp(log)
}

function multiplierToSliderPosition(multiplier: number): number {
  const clamped = Math.max(PLAYBACK_MULTIPLIER_MIN, Math.min(PLAYBACK_MULTIPLIER_MAX, multiplier))
  const t = (Math.log(clamped) - Math.log(PLAYBACK_MULTIPLIER_MIN))
    / (Math.log(PLAYBACK_MULTIPLIER_MAX) - Math.log(PLAYBACK_MULTIPLIER_MIN))
  return Math.round(t * PLAYBACK_SLIDER_STEPS)
}

function formatMultiplierLabel(multiplier: number): string {
  if (multiplier >= 10) {
    return `${Math.round(multiplier)}×`
  }
  return `${Number(multiplier.toFixed(1))}×`
}

/**
 * Max distance the tool can advance in a single animation frame, expressed in project
 * units. Chunks are applied via partial-move cuts, so one step can span many small moves
 * or just a slice of a larger one — per your request, we throttle by distance, not count.
 */
const PLAYBACK_STEP_SIZES_MM = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]
const PLAYBACK_STEP_SIZES_IN = [0.002, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5]
// 0.1 in ≈ 2.5 mm — same visual cadence in either unit system.
const PLAYBACK_DEFAULT_STEP_MM = 2.5
const PLAYBACK_DEFAULT_STEP_IN = 0.1
const PLAYBACK_REBUILD_INTERVAL_MS = 0

function formatSpeedLabel(perSecond: number, units: 'mm' | 'in'): string {
  // Internally the sim advances by distance-per-second (it's what RAF multiplies
  // by dt), but CNC operators think in feed-per-minute — so display units/min to
  // match how the operation's feed was authored. Multiply back up by 60.
  const perMinute = perSecond * 60
  // Inches read nicer with a couple of decimals, mm can stay whole for normal feeds.
  const digits = units === 'in' ? 1 : 0
  const rounded = Number(perMinute.toFixed(digits))
  return `${rounded} ${units}/min`
}

function createOrbitControls(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
  onChange: () => void,
  isInteractionBlocked: () => boolean,
) {
  let dragMode: 'rotate' | 'pan' | null = null
  let lastX = 0
  let lastY = 0
  let spherical = { ...DEFAULT_CAMERA_SPHERICAL }
  let cameraUp: THREE.Vector3Tuple = [...VIEW_PRESETS.iso.up]
  const target = new THREE.Vector3(0, 0, 0)
  const pointerNdc = new THREE.Vector2()
  const raycaster = new THREE.Raycaster()
  const designPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const beforeZoomPoint = new THREE.Vector3()
  const afterZoomPoint = new THREE.Vector3()
  const panRight = new THREE.Vector3()
  const panUp = new THREE.Vector3()
  const cameraDirection = new THREE.Vector3()

  function updateCamera() {
    camera.up.set(cameraUp[0], cameraUp[1], cameraUp[2])
    camera.position.set(
      target.x + spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta),
      target.y + spherical.radius * Math.cos(spherical.phi),
      target.z + spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta),
    )
    camera.lookAt(target)
    camera.updateMatrixWorld()
    onChange()
  }

  function applyPreset(preset: ViewPreset, preserveRadius = true, render = true) {
    const presetState = VIEW_PRESETS[preset]
    spherical = {
      theta: presetState.theta,
      phi: presetState.phi,
      radius: preserveRadius ? spherical.radius : DEFAULT_CAMERA_SPHERICAL.radius,
    }
    cameraUp = [...presetState.up]
    if (render) {
      updateCamera()
    }
  }

  function getPointerDesignPlanePoint(clientX: number, clientY: number, out: THREE.Vector3) {
    const bounds = domElement.getBoundingClientRect()
    if (bounds.width <= 0 || bounds.height <= 0) {
      return false
    }

    pointerNdc.x = ((clientX - bounds.left) / bounds.width) * 2 - 1
    pointerNdc.y = -(((clientY - bounds.top) / bounds.height) * 2 - 1)
    raycaster.setFromCamera(pointerNdc, camera)
    return raycaster.ray.intersectPlane(designPlane, out) !== null
  }

  function panByPixels(deltaX: number, deltaY: number) {
    const bounds = domElement.getBoundingClientRect()
    if (bounds.height <= 0) {
      return
    }

    const worldUnitsPerPixel =
      (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * spherical.radius) / bounds.height

    camera.getWorldDirection(cameraDirection)
    panRight.crossVectors(cameraDirection, camera.up).normalize()
    panUp.crossVectors(panRight, cameraDirection).normalize()

    target.addScaledVector(panRight, -deltaX * worldUnitsPerPixel)
    target.addScaledVector(panUp, deltaY * worldUnitsPerPixel)
  }

  function onPointerDown(event: PointerEvent) {
    if (isInteractionBlocked()) {
      return
    }

    const nextDragMode =
      event.button === 0 && !event.shiftKey ? 'rotate'
      : event.button === 1 || event.button === 2 || (event.button === 0 && event.shiftKey) ? 'pan'
      : null

    if (!nextDragMode) {
      return
    }

    event.preventDefault()
    dragMode = nextDragMode
    lastX = event.clientX
    lastY = event.clientY
    domElement.setPointerCapture?.(event.pointerId)
  }

  function onPointerUp(event: PointerEvent) {
    dragMode = null
    if (domElement.hasPointerCapture?.(event.pointerId)) {
      domElement.releasePointerCapture(event.pointerId)
    }
  }

  function onPointerMove(event: PointerEvent) {
    if (isInteractionBlocked()) {
      return
    }

    if (!dragMode) {
      return
    }

    event.preventDefault()
    const dx = event.clientX - lastX
    const dy = event.clientY - lastY
    lastX = event.clientX
    lastY = event.clientY

    if (dragMode === 'rotate') {
      spherical.theta -= dx * 0.01
      spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi + dy * 0.01))
    } else {
      panByPixels(dx, dy)
    }

    updateCamera()
  }

  function onWheel(event: WheelEvent) {
    if (isInteractionBlocked()) {
      return
    }

    event.preventDefault()
    event.stopPropagation()

    const hadAnchor = getPointerDesignPlanePoint(event.clientX, event.clientY, beforeZoomPoint)
    const nextRadius = Math.max(MIN_CAMERA_RADIUS, Math.min(MAX_CAMERA_RADIUS, spherical.radius * Math.exp(event.deltaY * 0.0015)))
    if (Math.abs(nextRadius - spherical.radius) < 0.001) {
      return
    }

    spherical.radius = nextRadius
    updateCamera()

    if (hadAnchor && getPointerDesignPlanePoint(event.clientX, event.clientY, afterZoomPoint)) {
      target.add(beforeZoomPoint).sub(afterZoomPoint)
    }

    updateCamera()
  }

  function onContextMenu(event: MouseEvent) {
    event.preventDefault()
  }

  domElement.addEventListener('pointerdown', onPointerDown)
  domElement.addEventListener('pointerup', onPointerUp)
  domElement.addEventListener('pointercancel', onPointerUp)
  domElement.addEventListener('pointermove', onPointerMove)
  domElement.addEventListener('wheel', onWheel, { passive: false })
  domElement.addEventListener('contextmenu', onContextMenu)

  updateCamera()

  return {
    dispose: () => {
      domElement.removeEventListener('pointerdown', onPointerDown)
      domElement.removeEventListener('pointerup', onPointerUp)
      domElement.removeEventListener('pointercancel', onPointerUp)
      domElement.removeEventListener('pointermove', onPointerMove)
      domElement.removeEventListener('wheel', onWheel)
      domElement.removeEventListener('contextmenu', onContextMenu)
    },
    setPreset: (preset: ViewPreset) => {
      applyPreset(preset, true)
    },
    fitToBounds: (bounds: THREE.Box3, alignToDefault = false) => {
      const size = bounds.getSize(new THREE.Vector3())
      const center = bounds.getCenter(new THREE.Vector3())
      const radius = Math.max(size.length() / 2, 1)
      const aspect = Math.max(camera.aspect, 1e-3)
      const verticalDistance = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov) / 2)
      const horizontalFov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * aspect)
      const horizontalDistance = radius / Math.sin(horizontalFov / 2)

      if (alignToDefault) {
        applyPreset('iso', true, false)
      }

      spherical.radius = Math.max(
        MIN_CAMERA_RADIUS,
        Math.min(MAX_CAMERA_RADIUS, Math.max(verticalDistance, horizontalDistance) * 1.15),
      )
      target.copy(center)
      updateCamera()
    },
    fitToScreenRect: (startX: number, startY: number, endX: number, endY: number) => {
      const minX = Math.min(startX, endX)
      const maxX = Math.max(startX, endX)
      const minY = Math.min(startY, endY)
      const maxY = Math.max(startY, endY)
      const rectWidth = maxX - minX
      const rectHeight = maxY - minY
      if (rectWidth < 6 || rectHeight < 6) {
        return
      }

      const bounds = domElement.getBoundingClientRect()
      if (bounds.width <= 0 || bounds.height <= 0) {
        return
      }

      const viewCenterX = bounds.width / 2
      const viewCenterY = bounds.height / 2
      const rectCenterX = minX + rectWidth / 2
      const rectCenterY = minY + rectHeight / 2
      const deltaX = rectCenterX - viewCenterX
      const deltaY = rectCenterY - viewCenterY
      const scaleFactor = Math.min(bounds.width / rectWidth, bounds.height / rectHeight)
      if (!Number.isFinite(scaleFactor) || scaleFactor <= 0) {
        return
      }

      const worldUnitsPerPixel =
        (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * spherical.radius) / bounds.height

      camera.getWorldDirection(cameraDirection)
      panRight.crossVectors(cameraDirection, camera.up).normalize()
      panUp.crossVectors(panRight, cameraDirection).normalize()

      target.addScaledVector(panRight, deltaX * worldUnitsPerPixel)
      target.addScaledVector(panUp, -deltaY * worldUnitsPerPixel)
      spherical.radius = Math.max(
        MIN_CAMERA_RADIUS,
        Math.min(MAX_CAMERA_RADIUS, spherical.radius / scaleFactor),
      )
      updateCamera()
    },
  }
}

export const SimulationViewport = forwardRef<SimulationViewportHandle, SimulationViewportProps>(function SimulationViewport({
  simulation,
  detailCells,
  onDetailCellsChange,
  mode,
  onModeChange,
  clamps,
  selectedClampId,
  collidingClampIds,
  origin,
  stockColor,
  zoomWindowActive = false,
  onZoomWindowComplete,
  playbackInput,
}, ref) {
  const playbackUnits = playbackInput?.units ?? 'mm'
  const fallbackFeed = playbackUnits === 'in' ? PLAYBACK_FALLBACK_FEED_IN : PLAYBACK_FALLBACK_FEED_MM
  // Anchor the playback speed multiplier to the operation's feed (units/sec). If the
  // operation has no feed defined, anchor to a sensible per-unit fallback so the UI
  // still behaves like "1× = a reasonable starting pace".
  const baseSpeed = playbackInput?.feedPerSecond && playbackInput.feedPerSecond > 0
    ? playbackInput.feedPerSecond
    : fallbackFeed
  const stepSizes = playbackUnits === 'in' ? PLAYBACK_STEP_SIZES_IN : PLAYBACK_STEP_SIZES_MM
  const defaultStep = playbackUnits === 'in' ? PLAYBACK_DEFAULT_STEP_IN : PLAYBACK_DEFAULT_STEP_MM

  const [playbackEnabled, setPlaybackEnabled] = useState(false)
  const [isPlaying, setIsPlaying] = useState(false)
  const [playbackMultiplier, setPlaybackMultiplier] = useState<number>(PLAYBACK_DEFAULT_MULTIPLIER)
  const [playbackMaxStep, setPlaybackMaxStep] = useState(defaultStep)
  const [playbackProgress, setPlaybackProgress] = useState(0)
  const playbackControllerRef = useRef<PlaybackController | null>(null)
  const toolMeshRef = useRef<THREE.Group | null>(null)
  const playbackMaterialMeshRef = useRef<THREE.Mesh | null>(null)
  const playbackFrameRef = useRef<number>(0)
  const playbackLastTimeRef = useRef<number>(0)
  const playbackLastRebuildRef = useRef<number>(0)
  const isPlayingRef = useRef(false)
  const playbackSpeedRef = useRef(baseSpeed * PLAYBACK_DEFAULT_MULTIPLIER)
  const playbackMaxStepRef = useRef(playbackMaxStep)
  useEffect(() => {
    isPlayingRef.current = isPlaying
  }, [isPlaying])
  useEffect(() => {
    // The RAF tick reads speed from a ref so it stays current without restarting
    // the loop. Recompute on every baseSpeed or multiplier change.
    playbackSpeedRef.current = baseSpeed * playbackMultiplier
  }, [baseSpeed, playbackMultiplier])
  useEffect(() => {
    playbackMaxStepRef.current = playbackMaxStep
  }, [playbackMaxStep])
  // Reset the step default if the project units change under us — but leave the
  // multiplier alone so the user's chosen pace is preserved across operations.
  useEffect(() => {
    setPlaybackMaxStep(defaultStep)
  }, [defaultStep])
  const [zoomWindowBox, setZoomWindowBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)
  const zoomWindowBoxRef = useRef<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)
  const mountRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<ReturnType<typeof createOrbitControls> | null>(null)
  const frameRef = useRef<number>(0)
  const objectRef = useRef<THREE.Object3D | null>(null)
  const clampObjectsRef = useRef<THREE.Mesh[]>([])
  const originObjectRef = useRef<THREE.Object3D | null>(null)
  const hasAutoFramedRef = useRef(false)
  const zoomWindowActiveRef = useRef(zoomWindowActive)
  zoomWindowActiveRef.current = zoomWindowActive
  zoomWindowBoxRef.current = zoomWindowBox

  const disposeCurrentMesh = useCallback((scene: THREE.Scene) => {
    if (objectRef.current instanceof THREE.Mesh) {
      scene.remove(objectRef.current)
      objectRef.current.geometry.dispose()
      if (Array.isArray(objectRef.current.material)) {
        objectRef.current.material.forEach((entry) => entry.dispose())
      } else {
        objectRef.current.material.dispose()
      }
      objectRef.current = null
    }
  }, [])

  const disposeClampMeshes = useCallback((scene: THREE.Scene) => {
    for (const mesh of clampObjectsRef.current) {
      scene.remove(mesh)
      mesh.geometry.dispose()
      if (Array.isArray(mesh.material)) {
        mesh.material.forEach((entry) => entry.dispose())
      } else {
        mesh.material.dispose()
      }
    }
    clampObjectsRef.current = []
  }, [])

  const disposeOriginMesh = useCallback((scene: THREE.Scene) => {
    if (!originObjectRef.current) {
      return
    }
    scene.remove(originObjectRef.current)
    originObjectRef.current.traverse((entry) => {
      if (entry instanceof THREE.Mesh || entry instanceof THREE.Line) {
        entry.geometry.dispose()
        if (Array.isArray(entry.material)) {
          entry.material.forEach((material) => material.dispose())
        } else {
          entry.material.dispose()
        }
      }
    })
    originObjectRef.current = null
  }, [])

  const zoomToModel = useCallback(() => {
    const controls = controlsRef.current
    const object = objectRef.current
    if (!controls || !(object instanceof THREE.Mesh)) {
      return
    }

    const bounds = new THREE.Box3().setFromObject(object)
    for (const clamp of clampObjectsRef.current) {
      if (clamp.visible) {
        bounds.expandByObject(clamp)
      }
    }
    if (origin.visible && originObjectRef.current) {
      bounds.expandByObject(originObjectRef.current)
    }

    if (bounds.isEmpty()) {
      return
    }

    controls.fitToBounds(bounds)
  }, [origin.visible])

  useEffect(() => {
    const mount = mountRef.current
    if (!mount) {
      return
    }

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: 'high-performance' })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.setSize(mount.clientWidth, mount.clientHeight)
    renderer.setClearColor(0x141820, 1)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.touchAction = 'none'
    mount.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    sceneRef.current = scene

    const ambient = new THREE.AmbientLight(0xffffff, 0.7)
    scene.add(ambient)
    const key = new THREE.DirectionalLight(0xffffff, 0.9)
    key.position.set(120, 180, 120)
    scene.add(key)
    const fill = new THREE.DirectionalLight(0x96b6ff, 0.35)
    fill.position.set(-120, 80, -80)
    scene.add(fill)

    const camera = new THREE.PerspectiveCamera(45, mount.clientWidth / mount.clientHeight, 0.1, 5000)
    cameraRef.current = camera

    const controls = createOrbitControls(camera, renderer.domElement, () => {
      renderer.render(scene, camera)
    }, () => zoomWindowActiveRef.current)
    controlsRef.current = controls

    function animate() {
      frameRef.current = requestAnimationFrame(animate)
      renderer.render(scene, camera)
    }
    animate()

    const resizeObserver = new ResizeObserver(() => {
      renderer.setSize(mount.clientWidth, mount.clientHeight)
      camera.aspect = mount.clientWidth / mount.clientHeight
      camera.updateProjectionMatrix()
    })
    resizeObserver.observe(mount)

    return () => {
      cancelAnimationFrame(frameRef.current)
      disposeCurrentMesh(scene)
      disposeClampMeshes(scene)
      controls.dispose()
      resizeObserver.disconnect()
      renderer.dispose()
      mount.removeChild(renderer.domElement)
    }
  }, [disposeClampMeshes, disposeCurrentMesh])

  useEffect(() => {
    const scene = sceneRef.current
    const controls = controlsRef.current
    if (!scene || !controls) {
      return
    }

    if (playbackEnabled) {
      disposeCurrentMesh(scene)
      return
    }

    disposeCurrentMesh(scene)

    if (!simulation) {
      return
    }

    const geometry = buildSimulationGeometry(simulation.grid)
    const material = new THREE.MeshStandardMaterial({
      color: stockColor ? new THREE.Color(stockColor) : 0xb5beca,
      roughness: 0.86,
      metalness: 0.05,
      flatShading: true,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)
    objectRef.current = mesh

    if (!hasAutoFramedRef.current) {
      const bounds = new THREE.Box3().setFromObject(mesh)
      if (!bounds.isEmpty()) {
        controls.fitToBounds(bounds, true)
        hasAutoFramedRef.current = true
      }
    }
  }, [disposeCurrentMesh, playbackEnabled, simulation, stockColor])

  const rebuildPlaybackGeometry = useCallback(() => {
    const mesh = playbackMaterialMeshRef.current
    const controller = playbackControllerRef.current
    if (!mesh || !controller) {
      return
    }
    const nextGeometry = buildSimulationGeometry(controller.liveGrid)
    mesh.geometry.dispose()
    mesh.geometry = nextGeometry
  }, [])

  const updateToolMeshPose = useCallback(() => {
    const controller = playbackControllerRef.current
    const tool = toolMeshRef.current
    if (!controller || !tool) {
      return
    }
    const pose = controller.getPose()
    // Toolpath (x, y, z) → world (x, z, y): the viewport treats world Y as vertical.
    tool.position.set(pose.x, pose.z, pose.y)
  }, [])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) {
      return
    }

    if (!playbackEnabled || !playbackInput) {
      if (playbackMaterialMeshRef.current) {
        scene.remove(playbackMaterialMeshRef.current)
        playbackMaterialMeshRef.current.geometry.dispose()
        const material = playbackMaterialMeshRef.current.material
        if (Array.isArray(material)) {
          material.forEach((entry) => entry.dispose())
        } else {
          material.dispose()
        }
        playbackMaterialMeshRef.current = null
      }
      if (toolMeshRef.current) {
        scene.remove(toolMeshRef.current)
        disposeToolMesh(toolMeshRef.current)
        toolMeshRef.current = null
      }
      playbackControllerRef.current = null
      setIsPlaying(false)
      setPlaybackProgress(0)
      return
    }

    const controller = new PlaybackController(
      playbackInput.baseGrid,
      playbackInput.moves,
      {
        toolType: playbackInput.toolType,
        toolRadius: playbackInput.toolRadius,
        vBitAngle: playbackInput.vBitAngle,
      },
      { maxSegmentLength: playbackInput.maxSegmentLength },
    )
    playbackControllerRef.current = controller

    const geometry = buildSimulationGeometry(controller.liveGrid)
    const material = new THREE.MeshStandardMaterial({
      color: stockColor ? new THREE.Color(stockColor) : 0xb5beca,
      roughness: 0.86,
      metalness: 0.05,
      flatShading: true,
      side: THREE.DoubleSide,
    })
    const mesh = new THREE.Mesh(geometry, material)
    scene.add(mesh)
    playbackMaterialMeshRef.current = mesh

    const tool = buildToolMesh({
      toolType: playbackInput.toolType,
      toolRadius: playbackInput.toolRadius,
      vBitAngle: playbackInput.vBitAngle,
      cutLength: playbackInput.toolCutLength,
      shankLength: playbackInput.toolShankLength,
    })
    scene.add(tool)
    toolMeshRef.current = tool

    setPlaybackProgress(0)
    updateToolMeshPose()

    return () => {
      if (playbackMaterialMeshRef.current) {
        scene.remove(playbackMaterialMeshRef.current)
        playbackMaterialMeshRef.current.geometry.dispose()
        const material = playbackMaterialMeshRef.current.material
        if (Array.isArray(material)) {
          material.forEach((entry) => entry.dispose())
        } else {
          material.dispose()
        }
        playbackMaterialMeshRef.current = null
      }
      if (toolMeshRef.current) {
        scene.remove(toolMeshRef.current)
        disposeToolMesh(toolMeshRef.current)
        toolMeshRef.current = null
      }
      playbackControllerRef.current = null
    }
  }, [playbackEnabled, playbackInput, stockColor, updateToolMeshPose])

  useEffect(() => {
    if (!playbackEnabled || !isPlaying) {
      cancelAnimationFrame(playbackFrameRef.current)
      playbackFrameRef.current = 0
      return
    }

    const controller = playbackControllerRef.current
    if (!controller) {
      return
    }

    playbackLastTimeRef.current = performance.now()
    playbackLastRebuildRef.current = performance.now()

    const tick = () => {
      const controllerInner = playbackControllerRef.current
      if (!controllerInner || !isPlayingRef.current) {
        playbackFrameRef.current = 0
        return
      }

      const now = performance.now()
      const dt = Math.min((now - playbackLastTimeRef.current) / 1000, 0.1)
      playbackLastTimeRef.current = now

      // Advance by speed × dt, but never more than the user-selected "step per frame"
      // distance. This is what makes geometry-heavy operations (long straights) pace
      // the same as move-heavy ones (tight arcs) — we step by distance, not by move.
      const requested = playbackSpeedRef.current * dt
      const step = playbackMaxStepRef.current > 0
        ? Math.min(requested, playbackMaxStepRef.current)
        : requested
      const gridChanged = controllerInner.advance(step)
      updateToolMeshPose()

      if (gridChanged && now - playbackLastRebuildRef.current >= PLAYBACK_REBUILD_INTERVAL_MS) {
        rebuildPlaybackGeometry()
        playbackLastRebuildRef.current = now
      }

      setPlaybackProgress(controllerInner.totalPathLength > 0
        ? controllerInner.getDistanceTraveled() / controllerInner.totalPathLength
        : 1)

      if (controllerInner.isFinished()) {
        rebuildPlaybackGeometry()
        setIsPlaying(false)
        playbackFrameRef.current = 0
        return
      }

      playbackFrameRef.current = requestAnimationFrame(tick)
    }

    playbackFrameRef.current = requestAnimationFrame(tick)

    return () => {
      cancelAnimationFrame(playbackFrameRef.current)
      playbackFrameRef.current = 0
    }
  }, [isPlaying, playbackEnabled, rebuildPlaybackGeometry, updateToolMeshPose])

  useEffect(() => {
    if (playbackEnabled && (mode !== 'selected' || !playbackInput)) {
      setPlaybackEnabled(false)
    }
  }, [mode, playbackEnabled, playbackInput])

  const handlePlaybackToggle = useCallback(() => {
    setPlaybackEnabled((current) => !current)
  }, [])

  const handlePlayPause = useCallback(() => {
    const controller = playbackControllerRef.current
    if (!controller) {
      return
    }
    if (controller.isFinished()) {
      controller.reset()
      rebuildPlaybackGeometry()
      setPlaybackProgress(0)
      updateToolMeshPose()
    }
    setIsPlaying((current) => !current)
  }, [rebuildPlaybackGeometry, updateToolMeshPose])

  const handleStop = useCallback(() => {
    const controller = playbackControllerRef.current
    if (!controller) {
      return
    }
    setIsPlaying(false)
    controller.reset()
    rebuildPlaybackGeometry()
    updateToolMeshPose()
    setPlaybackProgress(0)
  }, [rebuildPlaybackGeometry, updateToolMeshPose])

  const handleSeek = useCallback((fraction: number) => {
    const controller = playbackControllerRef.current
    if (!controller) {
      return
    }
    controller.seekToFraction(fraction)
    rebuildPlaybackGeometry()
    updateToolMeshPose()
    setPlaybackProgress(fraction)
  }, [rebuildPlaybackGeometry, updateToolMeshPose])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) {
      return
    }

    disposeClampMeshes(scene)

    if (clamps.length === 0) {
      return
    }

    const collidingClampIdSet = new Set(collidingClampIds)
    const nextClampMeshes = clamps.map((clamp) =>
      buildClampMesh(clamp, clamp.id === selectedClampId, collidingClampIdSet.has(clamp.id)),
    )
    for (const mesh of nextClampMeshes) {
      scene.add(mesh)
    }
    clampObjectsRef.current = nextClampMeshes

    return () => {
      disposeClampMeshes(scene)
    }
  }, [clamps, collidingClampIds, disposeClampMeshes, selectedClampId])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) {
      return
    }

    disposeOriginMesh(scene)
    if (!origin.visible || !simulation) {
      return
    }

    const width = simulation.grid.cols * simulation.grid.cellSize
    const height = simulation.grid.rows * simulation.grid.cellSize
    const axisSize = Math.max(
      Math.max(
        width,
        height,
        simulation.grid.stockTopZ - simulation.grid.stockBottomZ,
      ) * 0.05,
      0.05,
    )
    const triad = buildOriginTriad(origin, axisSize)
    scene.add(triad)
    originObjectRef.current = triad

    return () => {
      disposeOriginMesh(scene)
    }
  }, [disposeOriginMesh, origin, simulation])

  useImperativeHandle(ref, () => ({
    zoomToModel,
  }), [zoomToModel])

  useEffect(() => {
    if (!zoomWindowActive) {
      zoomWindowBoxRef.current = null
      setZoomWindowBox(null)
    }
  }, [zoomWindowActive])

  const zoomBoxStyle = zoomWindowBox
    ? {
        left: Math.min(zoomWindowBox.startX, zoomWindowBox.currentX),
        top: Math.min(zoomWindowBox.startY, zoomWindowBox.currentY),
        width: Math.abs(zoomWindowBox.currentX - zoomWindowBox.startX),
        height: Math.abs(zoomWindowBox.currentY - zoomWindowBox.startY),
      }
    : null

  return (
    <div className="simulation-viewport">
      <div ref={mountRef} className="simulation-viewport__canvas" />
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
      <div className="viewport-presets">
        <div className="viewport-presets__group viewport-presets__group--status">
          <div className="simulation-mode-toggle" role="tablist" aria-label="Simulation mode">
            <button
              className={`simulation-mode-toggle__btn ${mode === 'selected' ? 'simulation-mode-toggle__btn--active' : ''}`}
              type="button"
              onClick={() => onModeChange('selected')}
            >
              Selected
            </button>
            <button
              className={`simulation-mode-toggle__btn ${mode === 'visible' ? 'simulation-mode-toggle__btn--active' : ''}`}
              type="button"
              onClick={() => onModeChange('visible')}
            >
              Visible
            </button>
          </div>
          <label className="simulation-detail-control" title="Simulation detail">
            <span className="simulation-detail-control__label">Detail</span>
            <input
              className="simulation-detail-control__slider"
              type="range"
              min={SIMULATION_DETAIL_MIN}
              max={SIMULATION_DETAIL_MAX}
              step={SIMULATION_DETAIL_STEP}
              value={detailCells}
              onChange={(event) => onDetailCellsChange(Number(event.target.value))}
            />
            <span className="simulation-detail-control__value">{detailCells}</span>
          </label>
          <button
            className={`simulation-mode-toggle__btn simulation-playback-toggle ${playbackEnabled ? 'simulation-mode-toggle__btn--active' : ''}`}
            type="button"
            onClick={handlePlaybackToggle}
            disabled={mode !== 'selected' || !playbackInput}
            title={mode !== 'selected'
              ? 'Switch to Selected mode to use Tool playback'
              : !playbackInput
                ? 'Select an operation with a valid toolpath to play'
                : 'Toggle tool playback'}
          >
            Play Tool
          </button>
        </div>
        <div className="viewport-presets__group viewport-presets__group--views">
          <div className="preset-btn-panel">
            <button className="preset-btn preset-btn--icon" onClick={() => controlsRef.current?.setPreset('top')} title="Top view" type="button"><Icon id="view-top" size={16} /></button>
            <button className="preset-btn preset-btn--icon" onClick={() => controlsRef.current?.setPreset('bottom')} title="Bottom view" type="button"><Icon id="view-bottom" size={16} /></button>
            <button className="preset-btn preset-btn--icon" onClick={() => controlsRef.current?.setPreset('front')} title="Front view" type="button"><Icon id="view-front" size={16} /></button>
            <button className="preset-btn preset-btn--icon" onClick={() => controlsRef.current?.setPreset('back')} title="Back view" type="button"><Icon id="view-back" size={16} /></button>
            <button className="preset-btn preset-btn--icon" onClick={() => controlsRef.current?.setPreset('right')} title="Right view" type="button"><Icon id="view-right" size={16} /></button>
            <button className="preset-btn preset-btn--icon" onClick={() => controlsRef.current?.setPreset('left')} title="Left view" type="button"><Icon id="view-left" size={16} /></button>
            <button className="preset-btn preset-btn--icon" onClick={() => controlsRef.current?.setPreset('iso')} title="Isometric view" type="button"><Icon id="view-iso" size={16} /></button>
          </div>
        </div>
      </div>
      {playbackEnabled && playbackInput && (
        <div className="simulation-playback-bar">
          <div className="simulation-playback-bar__controls">
            <button
              type="button"
              className="simulation-playback-bar__btn simulation-playback-bar__btn--primary"
              onClick={handlePlayPause}
              title={isPlaying ? 'Pause' : 'Play'}
            >
              {isPlaying ? '❚❚' : '▶'}
            </button>
            <button
              type="button"
              className="simulation-playback-bar__btn"
              onClick={handleStop}
              title="Stop & reset"
            >
              ■
            </button>
          </div>
          <div className="simulation-playback-bar__progress">
            <span className="simulation-playback-bar__readout">
              {Math.round(playbackProgress * 100)}%
            </span>
            <input
              type="range"
              min={0}
              max={1000}
              step={1}
              value={Math.round(playbackProgress * 1000)}
              onChange={(event) => handleSeek(Number(event.target.value) / 1000)}
              aria-label="Playback progress"
            />
          </div>
          <label
            className="simulation-playback-bar__speed simulation-playback-bar__speed--slider"
            title={
              playbackInput.feedPerSecond && playbackInput.feedPerSecond > 0
                ? `Speed multiplier of operation feed (${formatSpeedLabel(baseSpeed, playbackUnits)} = 1×). Current: ${formatMultiplierLabel(playbackMultiplier)}`
                : `Speed multiplier of fallback feed (${formatSpeedLabel(baseSpeed, playbackUnits)} = 1×). Current: ${formatMultiplierLabel(playbackMultiplier)}`
            }
          >
            <span>Speed</span>
            <input
              type="range"
              min={0}
              max={PLAYBACK_SLIDER_STEPS}
              step={1}
              value={multiplierToSliderPosition(playbackMultiplier)}
              onChange={(event) => setPlaybackMultiplier(sliderPositionToMultiplier(Number(event.target.value)))}
              aria-label="Playback speed multiplier"
            />
          </label>
          <label
            className="simulation-playback-bar__speed"
            title="Maximum distance the tool advances per frame. Smaller = smoother motion, larger = faster playback."
          >
            <span>Step</span>
            <select
              value={playbackMaxStep}
              onChange={(event) => setPlaybackMaxStep(Number(event.target.value))}
            >
              {stepSizes.map((value) => (
                <option key={value} value={value}>{value} {playbackUnits}</option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  )
})
