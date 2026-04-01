import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'
import * as THREE from 'three'
import { buildClampMesh, buildOriginTriad } from '../../engine/csg'
import { buildSimulationGeometry } from '../../engine/simulation/mesh'
import type { SimulationResult } from '../../engine/simulation'
import type { Clamp, MachineOrigin, Operation } from '../../types/project'

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
}

export interface SimulationViewportHandle {
  zoomToModel: () => void
}

const SIMULATION_DETAIL_MIN = 240
const SIMULATION_DETAIL_MAX = 720
const SIMULATION_DETAIL_STEP = 40

function createOrbitControls(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
  onChange: () => void,
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
  }
}

export const SimulationViewport = forwardRef<SimulationViewportHandle, SimulationViewportProps>(function SimulationViewport({
  operation,
  simulation,
  detailCells,
  onDetailCellsChange,
  mode,
  onModeChange,
  operationCount,
  clamps,
  selectedClampId,
  collidingClampIds,
  origin,
}, ref) {
  const [showOverlay, setShowOverlay] = useState(false)
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
    })
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

    disposeCurrentMesh(scene)

    if (!simulation) {
      return
    }

    const geometry = buildSimulationGeometry(simulation.grid)
    const material = new THREE.MeshStandardMaterial({
      color: 0xb5beca,
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
  }, [disposeCurrentMesh, simulation])

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
      ) * 0.08,
      1,
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

  return (
    <div className="simulation-viewport">
      <div ref={mountRef} className="simulation-viewport__canvas" />
      <div className="viewport-presets">
        <div className="viewport-presets__group viewport-presets__group--status">
          <button
            className={`preset-btn ${showOverlay ? 'preset-btn--active' : ''}`}
            onClick={() => setShowOverlay((current) => !current)}
            title="Show simulation stats"
            type="button"
          >
            Info
          </button>
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
        </div>
        <div className="viewport-presets__group viewport-presets__group--views">
          <button className="preset-btn" onClick={() => controlsRef.current?.setPreset('top')} title="Top view" type="button">Top</button>
          <button className="preset-btn" onClick={() => controlsRef.current?.setPreset('bottom')} title="Bottom view" type="button">Bottom</button>
          <button className="preset-btn" onClick={() => controlsRef.current?.setPreset('front')} title="Front view" type="button">Front</button>
          <button className="preset-btn" onClick={() => controlsRef.current?.setPreset('back')} title="Back view" type="button">Back</button>
          <button className="preset-btn" onClick={() => controlsRef.current?.setPreset('right')} title="Right view" type="button">Right</button>
          <button className="preset-btn" onClick={() => controlsRef.current?.setPreset('left')} title="Left view" type="button">Left</button>
          <button className="preset-btn" onClick={() => controlsRef.current?.setPreset('iso')} title="Isometric view" type="button">Iso</button>
        </div>
      </div>
      {showOverlay ? (
        <div className="simulation-viewport__overlay">
          <div className="simulation-viewport__overlay-header">
            <div className="simulation-viewport__title">Simulation</div>
            <button
              className="simulation-viewport__close"
              onClick={() => setShowOverlay(false)}
              title="Hide simulation stats"
              type="button"
            >
              Close
            </button>
          </div>
          {mode === 'visible' || operation ? (
            <>
              <div className="simulation-viewport__line">
                Mode: <strong>{mode === 'selected' ? 'Selected' : 'Visible'}</strong>
              </div>
              {mode === 'selected' ? (
                <div className="simulation-viewport__line">
                  Operation: <strong>{operation?.name ?? 'Selected operation'}</strong>
                </div>
              ) : (
                <div className="simulation-viewport__line">
                  Operations: <strong>{operationCount}</strong>
                </div>
              )}
              {simulation ? (
                <>
                  <div className="simulation-viewport__line">
                    Grid: <strong>{simulation.grid.cols} × {simulation.grid.rows}</strong>
                  </div>
                  <div className="simulation-viewport__line">
                    Cell size: <strong>{simulation.grid.cellSize.toFixed(4)}</strong>
                  </div>
                  <div className="simulation-viewport__line">
                    Moves: <strong>{simulation.stats.processedMoveCount}</strong>
                  </div>
                  <div className="simulation-viewport__line">
                    Removed cells: <strong>{simulation.stats.removedCellCount}</strong>
                  </div>
                  <div className="simulation-viewport__line">
                    Min top Z: <strong>{simulation.stats.minTopZ.toFixed(4)}</strong>
                  </div>
                </>
              ) : null}
              {simulation && simulation.warnings.length > 0 ? (
                <div className="simulation-viewport__warnings">
                  {simulation.warnings.map((warning, index) => (
                    <div key={`${operation?.id ?? mode}-simulation-warning-${index}`} className="simulation-viewport__warning">
                      {warning}
                    </div>
                  ))}
                </div>
              ) : null}
            </>
          ) : (
            <div className="simulation-viewport__note">Select an operation to simulate.</div>
          )}
        </div>
      ) : null}
    </div>
  )
})
