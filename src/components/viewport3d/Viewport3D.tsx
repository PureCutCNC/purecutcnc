import { useCallback, useEffect, useRef } from 'react'
import * as THREE from 'three'
import { useProjectStore } from '../../store/projectStore'
import { buildScene } from '../../engine/csg'

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

function createOrbitControls(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
  onChange: () => void
) {
  let isPointerDown = false
  let lastX = 0
  let lastY = 0
  let spherical = { theta: Math.PI / 4, phi: Math.PI / 3, radius: 250 }
  const target = new THREE.Vector3(50, 0, 40)

  function updateCamera() {
    camera.position.set(
      target.x + spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta),
      target.y + spherical.radius * Math.cos(spherical.phi),
      target.z + spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta)
    )
    camera.lookAt(target)
    onChange()
  }

  function onPointerDown(e: PointerEvent) {
    e.preventDefault()
    isPointerDown = true
    lastX = e.clientX
    lastY = e.clientY
  }

  function onPointerUp() {
    isPointerDown = false
  }

  function onPointerMove(e: PointerEvent) {
    if (!isPointerDown) return
    e.preventDefault()
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    spherical.theta -= dx * 0.01
    spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi + dy * 0.01))
    updateCamera()
  }

  function onWheel(e: WheelEvent) {
    e.preventDefault()
    e.stopPropagation()
    spherical.radius = Math.max(50, Math.min(800, spherical.radius + e.deltaY * 0.3))
    updateCamera()
  }

  domElement.addEventListener('pointerdown', onPointerDown)
  domElement.addEventListener('pointerup', onPointerUp)
  domElement.addEventListener('pointermove', onPointerMove)
  domElement.addEventListener('wheel', onWheel, { passive: false })

  updateCamera()

  return {
    dispose: () => {
      domElement.removeEventListener('pointerdown', onPointerDown)
      domElement.removeEventListener('pointerup', onPointerUp)
      domElement.removeEventListener('pointermove', onPointerMove)
      domElement.removeEventListener('wheel', onWheel)
    },
    reset: () => {
      spherical = { theta: Math.PI / 4, phi: Math.PI / 3, radius: 250 }
      updateCamera()
    },
    setTarget: (x: number, y: number, z: number) => {
      target.set(x, y, z)
      updateCamera()
    },
  }
}

export function Viewport3D() {
  const mountRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const gridRef = useRef<THREE.Group | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<ReturnType<typeof createOrbitControls> | null>(null)
  const frameRef = useRef<number>(0)
  const objectsRef = useRef<THREE.Object3D[]>([])
  const buildRequestRef = useRef(0)

  const { project } = useProjectStore()

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
  }, [])

  const disposeObjectMaterial = useCallback((material: THREE.Material | THREE.Material[]) => {
    if (Array.isArray(material)) {
      material.forEach((entry) => entry.dispose())
      return
    }

    material.dispose()
  }, [])

  const rebuildGridHelpers = useCallback((centerX: number, centerZ: number) => {
    const gridGroup = gridRef.current
    if (!gridGroup) return

    for (const child of [...gridGroup.children]) {
      gridGroup.remove(child)
      if (child instanceof THREE.LineSegments) {
        child.geometry.dispose()
        disposeObjectMaterial(child.material)
      }
    }

    gridGroup.position.set(centerX, -0.05, centerZ)
    gridGroup.visible = project.grid.visible
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
  }, [disposeObjectMaterial, project.grid.extent, project.grid.majorSpacing, project.grid.minorSpacing, project.grid.visible])

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
          const minWorldZ = Math.min(...points.map((point) => -point.y))
          const maxWorldZ = Math.max(...points.map((point) => -point.y))
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
          rebuildGridHelpers(centerX, centerZ)
        }
      })()
    }, 150)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [clearRenderedObjects, disposeObjectMaterial, project, rebuildGridHelpers])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={mountRef} style={{ width: '100%', height: '100%' }} />
      <div className="viewport-presets">
        <button className="preset-btn" onClick={() => controlsRef.current?.reset()} title="Reset view">
          ⟳
        </button>
      </div>
    </div>
  )
}
