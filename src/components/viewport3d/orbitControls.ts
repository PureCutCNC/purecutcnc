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

import * as THREE from 'three'
import {
  DEFAULT_CAMERA_SPHERICAL,
  MAX_CAMERA_RADIUS,
  MIN_CAMERA_RADIUS,
  VIEW_PRESETS,
  type ViewPreset,
} from './viewPresets'

/** Margin applied on top of the exact frustum fit, kept small since the fit
 *  is already tight (no sphere over-estimate). */
const FIT_BOUNDS_MARGIN = 1.1

/**
 * Shared orbit-camera controls for the 3D preview and simulation viewports.
 *
 * Previously duplicated (with drift) between `Viewport3D.tsx` and
 * `SimulationViewport.tsx`. The simulation copy was missing `onPresetChange`
 * entirely, so it could not track which named view was active. Issue #243.
 *
 * Behaviour notes:
 * - Any free orbit / pan / wheel sets the active preset to `null` (custom).
 * - `reset()` snaps to isometric and renders immediately (render=true) so it
 *   works with the simulation viewport's render-on-demand RAF loop. The 3D
 *   viewport previously used render=false here, but reset is only called when
 *   the scene is empty, so the extra draw is harmless.
 */

export interface OrbitControlsOptions {
  /** Called after every camera position change (render the scene). */
  onChange: () => void
  /** Called when the active named preset changes (or becomes `null` for custom). */
  onPresetChange: (preset: ViewPreset | null) => void
  /** Returns true while pointer/wheel interaction should be ignored. */
  isInteractionBlocked: () => boolean
  /** Initial orbit target. Defaults to the origin. */
  initialTarget?: THREE.Vector3Tuple
}

export interface OrbitControls {
  dispose: () => void
  /** Reset to the default isometric orientation and default radius. */
  reset: () => void
  /** Snap to a named preset, preserving the current orbit radius. */
  setPreset: (preset: ViewPreset) => void
  /** Move the orbit target and render. */
  setTarget: (x: number, y: number, z: number) => void
  /** Frame the given world-space bounds, optionally reorienting to iso first. */
  fitToBounds: (bounds: THREE.Box3, alignToDefault?: boolean) => void
  /** Zoom to a screen-space rect (window-zoom tool). */
  fitToScreenRect: (startX: number, startY: number, endX: number, endY: number) => void
}

export function createOrbitControls(
  camera: THREE.PerspectiveCamera,
  domElement: HTMLElement,
  options: OrbitControlsOptions,
): OrbitControls {
  const { onChange, onPresetChange, isInteractionBlocked } = options
  const initial = options.initialTarget ?? [0, 0, 0]

  let dragMode: 'rotate' | 'pan' | null = null
  let lastX = 0
  let lastY = 0
  let spherical = { ...DEFAULT_CAMERA_SPHERICAL }
  let cameraUp: THREE.Vector3Tuple = [...VIEW_PRESETS.iso.up]
  const target = new THREE.Vector3(initial[0], initial[1], initial[2])
  const pointerNdc = new THREE.Vector2()
  const raycaster = new THREE.Raycaster()
  const designPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0)
  const beforeZoomPoint = new THREE.Vector3()
  const afterZoomPoint = new THREE.Vector3()
  const panRight = new THREE.Vector3()
  const panUp = new THREE.Vector3()
  const cameraDirection = new THREE.Vector3()
  const touchPointers = new Map<number, { x: number; y: number }>()
  let gestureState: { centerX: number; centerY: number; distance: number } | null = null

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
      target.z + spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta),
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

  function onPointerDown(e: PointerEvent) {
    if (isInteractionBlocked()) {
      return
    }

    if (e.pointerType === 'touch') {
      touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touchPointers.size >= 2) {
        dragMode = null
        const points = [...touchPointers.values()]
        gestureState = {
          centerX: (points[0].x + points[1].x) / 2,
          centerY: (points[0].y + points[1].y) / 2,
          distance: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
        }
        onPresetChange(null)
        return
      }
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
    if (e.pointerType === 'touch') {
      touchPointers.delete(e.pointerId)
      if (touchPointers.size < 2) {
        gestureState = null
      }
    }
    dragMode = null
    if (domElement.hasPointerCapture?.(e.pointerId)) {
      domElement.releasePointerCapture(e.pointerId)
    }
  }

  function onPointerMove(e: PointerEvent) {
    if (isInteractionBlocked()) {
      return
    }

    if (e.pointerType === 'touch' && touchPointers.has(e.pointerId)) {
      touchPointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (touchPointers.size >= 2 && gestureState) {
        const points = [...touchPointers.values()]
        const newCenterX = (points[0].x + points[1].x) / 2
        const newCenterY = (points[0].y + points[1].y) / 2
        const newDistance = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)
        if (gestureState.distance > 0 && newDistance > 0) {
          spherical.radius = Math.max(
            MIN_CAMERA_RADIUS,
            Math.min(MAX_CAMERA_RADIUS, spherical.radius * (gestureState.distance / newDistance)),
          )
        }
        panByPixels(newCenterX - gestureState.centerX, newCenterY - gestureState.centerY)
        gestureState = { centerX: newCenterX, centerY: newCenterY, distance: newDistance }
        updateCamera()
        return
      }
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
    const nextRadius = Math.max(
      MIN_CAMERA_RADIUS,
      Math.min(MAX_CAMERA_RADIUS, spherical.radius * Math.exp(e.deltaY * 0.0015)),
    )
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

  function onContextMenu(e: MouseEvent) {
    e.preventDefault()
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
      applyPreset('iso', false, true)
    },
    setPreset: (preset: ViewPreset) => {
      applyPreset(preset, true)
    },
    setTarget: (x: number, y: number, z: number) => {
      target.set(x, y, z)
      updateCamera()
    },
    fitToBounds: (bounds: THREE.Box3, alignToDefault = false) => {
      const center = bounds.getCenter(new THREE.Vector3())

      if (alignToDefault) {
        applyPreset('iso', true, false)
      }

      // Compute the view direction (unit vector from target to camera).
      const viewDir = new THREE.Vector3(
        Math.sin(spherical.phi) * Math.sin(spherical.theta),
        Math.cos(spherical.phi),
        Math.sin(spherical.phi) * Math.cos(spherical.theta),
      )

      // Temporarily place the camera at unit distance in the current orientation,
      // look at the box centre, then build the view matrix so we can transform
      // the 8 box corners to camera space (camera at origin, looking down −Z).
      camera.up.set(cameraUp[0], cameraUp[1], cameraUp[2])
      camera.position.copy(center).addScaledVector(viewDir, 1)
      camera.lookAt(center)
      camera.updateMatrixWorld()
      const viewMatrix = new THREE.Matrix4().copy(camera.matrixWorld).invert()

      const aspect = Math.max(camera.aspect, 1e-3)
      const vfovRad = THREE.MathUtils.degToRad(camera.fov)
      const hfovRad = 2 * Math.atan(Math.tan(vfovRad / 2) * aspect)
      const tanH = Math.tan(hfovRad / 2)
      const tanV = Math.tan(vfovRad / 2)

      const corner = new THREE.Vector3()
      const vc = new THREE.Vector3()

      let maxReq = -Infinity
      for (let ix = 0; ix <= 1; ix++) {
        for (let iy = 0; iy <= 1; iy++) {
          for (let iz = 0; iz <= 1; iz++) {
            corner.set(
              ix === 0 ? bounds.min.x : bounds.max.x,
              iy === 0 ? bounds.min.y : bounds.max.y,
              iz === 0 ? bounds.min.z : bounds.max.z,
            )
            vc.copy(corner).applyMatrix4(viewMatrix)
            // In view space the camera is at origin looking down -Z.  A corner
            // at (vc.x, vc.y, vc.z) is inside the frustum at this distance when
            //   −vc.z ≥ |vc.x| / tanH   AND   −vc.z ≥ |vc.y| / tanV
            // If the camera is pushed back by D (relative to unit distance) the
            // view-space z of every corner increases by D−1 (x/y unchanged), so
            // the condition becomes  −(vc.z + D−1) ≥ |vc.x|/tanH which
            // rearranges to  D ≥ 1 + vc.z + |vc.x|/tanH.
            const reqH = 1 + vc.z + Math.abs(vc.x) / tanH
            const reqV = 1 + vc.z + Math.abs(vc.y) / tanV
            maxReq = Math.max(maxReq, reqH, reqV)
          }
        }
      }

      spherical.radius = Math.max(
        MIN_CAMERA_RADIUS,
        Math.min(MAX_CAMERA_RADIUS, maxReq * FIT_BOUNDS_MARGIN),
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
