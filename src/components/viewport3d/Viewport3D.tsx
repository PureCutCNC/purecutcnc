import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef } from 'react'
import * as THREE from 'three'
import { useProjectStore } from '../../store/projectStore'
import { buildScene } from '../../engine/csg'
import { getStockBounds } from '../../types/project'

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

export interface Viewport3DHandle {
  zoomToModel: () => void
}

function createOrbitControls(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
  onChange: () => void,
  onPresetChange: (preset: ViewPreset | null) => void
) {
  let dragMode: 'rotate' | 'pan' | null = null
  let lastX = 0
  let lastY = 0
  let spherical = { ...DEFAULT_CAMERA_SPHERICAL }
  let cameraUp: THREE.Vector3Tuple = [...VIEW_PRESETS.iso.up]
  const target = new THREE.Vector3(50, 0, 40)
  const pointerNdc = new THREE.Vector2()
  const raycaster = new THREE.Raycaster()
  const designPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const beforeZoomPoint = new THREE.Vector3()
  const afterZoomPoint = new THREE.Vector3()
  const panRight = new THREE.Vector3()
  const panUp = new THREE.Vector3()
  const cameraDirection = new THREE.Vector3()

  function applyDefaultOrientation(preserveRadius = true) {
    applyPreset('iso', preserveRadius, false)
  }

  function applyPreset(preset: ViewPreset, preserveRadius = true, render = true) {
    const presetState = VIEW_PRESETS[preset]
    spherical = {
      theta: presetState.theta,
      phi: presetState.phi,
      radius: preserveRadius ? spherical.radius : DEFAULT_CAMERA_SPHERICAL.radius,
    }
    cameraUp = [...presetState.up]
    onPresetChange(preset)
    if (render) {
      updateCamera()
    }
  }

  function updateCamera() {
    camera.up.set(cameraUp[0], cameraUp[1], cameraUp[2])
    camera.position.set(
      target.x + spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta),
      target.y + spherical.radius * Math.cos(spherical.phi),
      target.z + spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta)
    )
    camera.lookAt(target)
    camera.updateMatrixWorld()
    onChange()
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

  function onContextMenu(e: MouseEvent) {
    e.preventDefault()
  }

  function onPointerDown(e: PointerEvent) {
    const nextDragMode =
      e.button === 0 && !e.shiftKey ? 'rotate'
      : e.button === 1 || e.button === 2 || (e.button === 0 && e.shiftKey) ? 'pan'
      : null

    if (!nextDragMode) {
      return
    }

    e.preventDefault()
    dragMode = nextDragMode
    lastX = e.clientX
    lastY = e.clientY
    domElement.setPointerCapture?.(e.pointerId)
  }

  function onPointerUp(e: PointerEvent) {
    dragMode = null
    if (domElement.hasPointerCapture?.(e.pointerId)) {
      domElement.releasePointerCapture(e.pointerId)
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (!dragMode) return
    e.preventDefault()
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY

    if (dragMode === 'rotate') {
      onPresetChange(null)
      spherical.theta -= dx * 0.01
      spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi + dy * 0.01))
    } else {
      onPresetChange(null)
      panByPixels(dx, dy)
    }

    updateCamera()
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault()
    e.stopPropagation()
    onPresetChange(null)

    const hadAnchor = getPointerDesignPlanePoint(e.clientX, e.clientY, beforeZoomPoint)
    const nextRadius = Math.max(MIN_CAMERA_RADIUS, Math.min(MAX_CAMERA_RADIUS, spherical.radius * Math.exp(e.deltaY * 0.0015)))
    if (Math.abs(nextRadius - spherical.radius) < 0.001) {
      return
    }

    spherical.radius = nextRadius
    updateCamera()

    if (hadAnchor && getPointerDesignPlanePoint(e.clientX, e.clientY, afterZoomPoint)) {
      target.add(beforeZoomPoint).sub(afterZoomPoint)
    }

    updateCamera()
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
    reset: () => {
      applyDefaultOrientation(false)
    },
    setPreset: (preset: ViewPreset) => {
      applyPreset(preset, true)
    },
    setTarget: (x: number, y: number, z: number) => {
      target.set(x, y, z)
      updateCamera()
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
        applyDefaultOrientation(true)
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

export const Viewport3D = forwardRef<Viewport3DHandle>(function Viewport3D(_props, ref) {
  const mountRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const gridRef = useRef<THREE.Group | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<ReturnType<typeof createOrbitControls> | null>(null)
  const frameRef = useRef<number>(0)
  const objectsRef = useRef<THREE.Object3D[]>([])
  const buildRequestRef = useRef(0)
  const activePresetRef = useRef<ViewPreset | null>('iso')

  const { project } = useProjectStore()

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
    controls.fitToBounds(bounds, true)
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
    renderer.setClearColor(0x141820, 1)
    renderer.domElement.style.display = 'block'
    renderer.domElement.style.touchAction = 'none'
    mount.appendChild(renderer.domElement)
    rendererRef.current = renderer

    const scene = new THREE.Scene()
    sceneRef.current = scene

    const ambient = new THREE.AmbientLight(0xffffff, 0.6)
    scene.add(ambient)
    const dir = new THREE.DirectionalLight(0xffffff, 0.8)
    dir.position.set(100, 200, 100)
    scene.add(dir)
    const dir2 = new THREE.DirectionalLight(0x8899ff, 0.3)
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

    const controls = createOrbitControls(camera, renderer.domElement, () => {
      renderer.render(scene, camera)
    }, (preset) => {
      activePresetRef.current = preset
      syncGridVisibility()
    })
    controlsRef.current = controls

    function animate() {
      frameRef.current = requestAnimationFrame(animate)
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

    const extent = Math.max(project.grid.extent, project.grid.minorSpacing)
    const minorDivisions = Math.max(1, Math.round(extent / project.grid.minorSpacing))
    const majorDivisions = Math.max(1, Math.round(extent / project.grid.majorSpacing))

    const minorGrid = new THREE.GridHelper(extent, minorDivisions, 0x223344, 0x223344)
    const majorGrid = new THREE.GridHelper(extent, majorDivisions, 0x334455, 0x51657a)
    configureGridMaterial(minorGrid.material)
    configureGridMaterial(majorGrid.material)
    majorGrid.position.y = 0.001

    gridGroup.add(minorGrid)
    gridGroup.add(majorGrid)
  }, [disposeObjectMaterial, project.grid.extent, project.grid.majorSpacing, project.grid.minorSpacing, project.grid.visible, project.stock, syncGridVisibility])

  const clearRenderedObjects = useCallback((scene: THREE.Scene) => {
    for (const object of objectsRef.current) {
      scene.remove(object)
      if (object instanceof THREE.Mesh) {
        object.geometry.dispose()
        disposeObjectMaterial(object.material)
      }
      if (object instanceof THREE.LineSegments) {
        object.geometry.dispose()
        disposeObjectMaterial(object.material)
      }
    }
    objectsRef.current = []
  }, [disposeObjectMaterial])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return

    let cancelled = false
    const buildRequestId = buildRequestRef.current + 1
    buildRequestRef.current = buildRequestId

    const timeout = window.setTimeout(() => {
      void (async () => {
        const nextSceneObjects = await buildScene(
          project,
        )

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
            featureMesh.geometry.dispose()
            disposeObjectMaterial(featureMesh.material)
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

        const controls = controlsRef.current
        if (controls) {
          const visibleFeatures = project.features.filter((feature) => feature.visible)
          const profiles =
            visibleFeatures.length > 0
              ? visibleFeatures.map((feature) => feature.sketch.profile)
              : [project.stock.profile]
          const points = profiles.flatMap((profile) => [profile.start, ...profile.segments.map((segment) => segment.to)])

          const minX = Math.min(...points.map((point) => point.x))
          const maxX = Math.max(...points.map((point) => point.x))
          const minWorldZ = Math.min(...points.map((point) => point.y))
          const maxWorldZ = Math.max(...points.map((point) => point.y))
          const verticalValues =
            visibleFeatures.length > 0
              ? visibleFeatures.flatMap((feature) => {
                const top = typeof feature.z_top === 'number' ? feature.z_top : 0
                const bottom = typeof feature.z_bottom === 'number' ? feature.z_bottom : 0
                return [top, bottom]
              })
              : [
                0,
                project.stock.visible ? project.stock.thickness : 0,
              ]
          const minY = Math.min(...verticalValues)
          const maxY = Math.max(...verticalValues)

          const centerX = minX + (maxX - minX) / 2
          const centerY = minY + (maxY - minY) / 2
          const centerZ = minWorldZ + (maxWorldZ - minWorldZ) / 2

          controls.setTarget(centerX, centerY, centerZ)
          rebuildGridHelpers()
        }
      })()
    }, 150)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [clearRenderedObjects, disposeObjectMaterial, project, rebuildGridHelpers])

  useImperativeHandle(ref, () => ({
    zoomToModel,
  }), [zoomToModel])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      <div className="viewport-presets">
        <button className="preset-btn" onClick={() => controlsRef.current?.setPreset('top')} title="Top view" type="button">
          Top
        </button>
        <button className="preset-btn" onClick={() => controlsRef.current?.setPreset('bottom')} title="Bottom view" type="button">
          Bottom
        </button>
        <button className="preset-btn" onClick={() => controlsRef.current?.setPreset('front')} title="Front view" type="button">
          Front
        </button>
        <button className="preset-btn" onClick={() => controlsRef.current?.setPreset('back')} title="Back view" type="button">
          Back
        </button>
        <button className="preset-btn" onClick={() => controlsRef.current?.setPreset('right')} title="Right view" type="button">
          Right
        </button>
        <button className="preset-btn" onClick={() => controlsRef.current?.setPreset('left')} title="Left view" type="button">
          Left
        </button>
        <button className="preset-btn" onClick={() => controlsRef.current?.setPreset('iso')} title="Isometric view" type="button">
          Iso
        </button>
      </div>
    </div>
  )
})
