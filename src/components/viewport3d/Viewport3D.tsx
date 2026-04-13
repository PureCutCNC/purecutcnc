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
import type { ToolpathResult } from '../../engine/toolpaths/types'
import { useProjectStore } from '../../store/projectStore'
import { buildOriginTriad, buildScene } from '../../engine/csg'
import { getStockBounds, rectProfile } from '../../types/project'
import { getFeatureGeometryProfiles } from '../../text'

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

interface Viewport3DProps {
  toolpaths?: ToolpathResult[]
  selectedOperationId?: string | null
  collidingClampIds?: string[]
  originVisible?: boolean
  zoomWindowActive?: boolean
  onZoomWindowComplete?: () => void
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
  return new THREE.Vector3(point.x, point.z, point.y)
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function buildToolpathEndpointMarkers(toolpath: ToolpathResult, emphasized: boolean): THREE.Object3D[] {
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
    0xd583df,
    headLength,
    headWidth,
  )
  const endArrow = new THREE.ArrowHelper(
    new THREE.Vector3(0, 1, 0),
    lastPoint,
    markerLength,
    0x78b8de,
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

function buildToolpathDirectionMarkers(toolpath: ToolpathResult, emphasized: boolean): THREE.Object3D[] {
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
    const color = move.kind === 'rapid' ? 0x78b8de : 0xff735c
    const arrow = new THREE.ArrowHelper(
      direction,
      origin,
      markerLength,
      color,
      headLength,
      headWidth,
    )

    arrow.traverse((entry) => {
      if (entry instanceof THREE.Line || entry instanceof THREE.Mesh) {
        const material = Array.isArray(entry.material) ? entry.material : [entry.material]
        material.forEach((item) => {
          item.transparent = true
          item.opacity = 0.95
          item.depthWrite = false
          item.depthTest = false
        })
      }
    })

    objects.push(arrow)
    distanceSinceLastArrowByKind[move.kind] = 0
  }

  return objects
}

function buildToolpathOverlay(toolpath: ToolpathResult, emphasized: boolean): THREE.Object3D[] {
  const layers: Array<{
    kinds: ToolpathResult['moves'][number]['kind'][]
    color: number
    opacity: number
  }> = [
    { kinds: ['rapid'], color: 0x78b8de, opacity: 0.75 },
    { kinds: ['plunge'], color: 0xd583df, opacity: 0.9 },
    { kinds: ['lead_in', 'lead_out'], color: 0xffb15c, opacity: 0.92 },
    { kinds: ['cut'], color: 0xff735c, opacity: 0.98 },
  ]

  const objects: THREE.Object3D[] = []
  for (const layer of layers) {
    const moves = toolpath.moves.filter((move) => layer.kinds.includes(move.kind))
    if (moves.length === 0) {
      continue
    }

    const positions = new Float32Array(moves.length * 2 * 3)
    let offset = 0
    for (const move of moves) {
      const from = toolpathPointToWorld(move.from)
      const to = toolpathPointToWorld(move.to)
      positions[offset] = from.x
      positions[offset + 1] = from.y
      positions[offset + 2] = from.z
      positions[offset + 3] = to.x
      positions[offset + 4] = to.y
      positions[offset + 5] = to.z
      offset += 6
    }

    const geometry = new THREE.BufferGeometry()
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    geometry.computeBoundingSphere()

    const material = new THREE.LineBasicMaterial({
      color: layer.color,
      transparent: true,
      opacity: emphasized ? layer.opacity : Math.max(layer.opacity * 0.55, 0.45),
      depthWrite: false,
      depthTest: false,
    })

    objects.push(new THREE.LineSegments(geometry, material))
  }

  if (emphasized) {
    objects.push(...buildToolpathDirectionMarkers(toolpath, emphasized))
    objects.push(...buildToolpathEndpointMarkers(toolpath, emphasized))
  }

  return objects
}

function createOrbitControls(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
  onChange: () => void,
  onPresetChange: (preset: ViewPreset | null) => void,
  isInteractionBlocked: () => boolean,
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
    if (isInteractionBlocked()) {
      return
    }

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
    if (isInteractionBlocked()) {
      return
    }

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
    if (isInteractionBlocked()) {
      return
    }

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

      onPresetChange(null)
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

export const Viewport3D = forwardRef<Viewport3DHandle, Viewport3DProps>(function Viewport3D({
  toolpaths = [],
  selectedOperationId = null,
  collidingClampIds = [],
  originVisible = true,
  zoomWindowActive = false,
  onZoomWindowComplete,
}, ref) {
  const mountRef = useRef<HTMLDivElement>(null)
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null)
  const sceneRef = useRef<THREE.Scene | null>(null)
  const gridRef = useRef<THREE.Group | null>(null)
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null)
  const controlsRef = useRef<ReturnType<typeof createOrbitControls> | null>(null)
  const frameRef = useRef<number>(0)
  const objectsRef = useRef<THREE.Object3D[]>([])
  const toolpathObjectsRef = useRef<THREE.Object3D[]>([])
  const originObjectRef = useRef<THREE.Object3D | null>(null)
  const buildRequestRef = useRef(0)
  const activePresetRef = useRef<ViewPreset | null>('iso')
  const zoomWindowActiveRef = useRef(zoomWindowActive)
  const [zoomWindowBox, setZoomWindowBox] = useState<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)
  const zoomWindowBoxRef = useRef<{ startX: number; startY: number; currentX: number; currentY: number } | null>(null)

  const { project, selection } = useProjectStore()
  zoomWindowActiveRef.current = zoomWindowActive
  zoomWindowBoxRef.current = zoomWindowBox

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
    }, () => zoomWindowActiveRef.current)
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

  const clearToolpathObjects = useCallback((scene: THREE.Scene) => {
    for (const object of toolpathObjectsRef.current) {
      scene.remove(object)
      if (object instanceof THREE.LineSegments) {
        object.geometry.dispose()
        disposeObjectMaterial(object.material)
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
          selection.selectedNode?.type === 'clamp' ? selection.selectedNode.clampId : null,
          selection.selectedNode?.type === 'tab' ? selection.selectedNode.tabId : null,
          collidingClampIds,
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
          for (const tabMesh of nextSceneObjects.tabMeshes.values()) {
            tabMesh.geometry.dispose()
            disposeObjectMaterial(tabMesh.material)
          }
          for (const clampMesh of nextSceneObjects.clampMeshes.values()) {
            clampMesh.geometry.dispose()
            disposeObjectMaterial(clampMesh.material)
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

        for (const tabMesh of nextSceneObjects.tabMeshes.values()) {
          scene.add(tabMesh)
          objectsRef.current.push(tabMesh)
        }

        for (const clampMesh of nextSceneObjects.clampMeshes.values()) {
          scene.add(clampMesh)
          objectsRef.current.push(clampMesh)
        }

          const controls = controlsRef.current
        if (controls) {
          const visibleFeatures = project.features.filter((feature) => feature.visible)
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
  }, [clearRenderedObjects, collidingClampIds, disposeObjectMaterial, originVisible, project, rebuildGridHelpers, selection.selectedNode])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) {
      return
    }

    clearToolpathObjects(scene)

    const nextObjects = toolpaths.flatMap((toolpath) => (
      toolpath.moves.length > 0 ? buildToolpathOverlay(toolpath, toolpath.operationId === selectedOperationId) : []
    ))
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
  }, [clearToolpathObjects, selectedOperationId, toolpaths])

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
    const triad = buildOriginTriad(project.origin, axisSize)
    scene.add(triad)
    originObjectRef.current = triad

    return () => {
      clearOriginObject(scene)
    }
  }, [clearOriginObject, originVisible, project.origin, project.stock])

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
      <div className="viewport-presets">
        <div className="preset-btn-panel">
          <button className="preset-btn preset-btn--icon" onClick={() => controlsRef.current?.setPreset('top')} title="Top view" type="button">
            <Icon id="view-top" size={16} />
          </button>
          <button className="preset-btn preset-btn--icon" onClick={() => controlsRef.current?.setPreset('bottom')} title="Bottom view" type="button">
            <Icon id="view-bottom" size={16} />
          </button>
          <button className="preset-btn preset-btn--icon" onClick={() => controlsRef.current?.setPreset('front')} title="Front view" type="button">
            <Icon id="view-front" size={16} />
          </button>
          <button className="preset-btn preset-btn--icon" onClick={() => controlsRef.current?.setPreset('back')} title="Back view" type="button">
            <Icon id="view-back" size={16} />
          </button>
          <button className="preset-btn preset-btn--icon" onClick={() => controlsRef.current?.setPreset('right')} title="Right view" type="button">
            <Icon id="view-right" size={16} />
          </button>
          <button className="preset-btn preset-btn--icon" onClick={() => controlsRef.current?.setPreset('left')} title="Left view" type="button">
            <Icon id="view-left" size={16} />
          </button>
          <button className="preset-btn preset-btn--icon" onClick={() => controlsRef.current?.setPreset('iso')} title="Isometric view" type="button">
            <Icon id="view-iso" size={16} />
          </button>
        </div>
      </div>
    </div>
  )
})
