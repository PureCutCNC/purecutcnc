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

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import * as THREE from 'three'
import { createOrbitControls } from './orbitControls'
import { MIN_CAMERA_RADIUS } from './viewPresets'

const fakeElement = {
  addEventListener() {},
  removeEventListener() {},
  getBoundingClientRect: () => ({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
    right: 800,
    bottom: 600,
    x: 0,
    y: 0,
    toJSON() {},
  }),
  setPointerCapture() {},
  releasePointerCapture() {},
  hasPointerCapture: () => false,
} as unknown as HTMLElement

function makeControls(camera?: THREE.PerspectiveCamera) {
  const cam = camera ?? new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  return createOrbitControls(cam, fakeElement, {
    onChange: () => {},
    onPresetChange: () => {},
    isInteractionBlocked: () => false,
  })
}

/** Returns true if ALL 8 corners of `box` project inside the frustum
 *  (|ndc.x| <= marginNdc and |ndc.y| <= marginNdc). */
function allCornersInFrustum(box: THREE.Box3, camera: THREE.Camera, marginNdc = 0.95): boolean {
  const corner = new THREE.Vector3()
  for (let ix = 0; ix <= 1; ix++) {
    for (let iy = 0; iy <= 1; iy++) {
      for (let iz = 0; iz <= 1; iz++) {
        corner.set(
          ix === 0 ? box.min.x : box.max.x,
          iy === 0 ? box.min.y : box.max.y,
          iz === 0 ? box.min.z : box.max.z,
        )
        const ndc = corner.clone().project(camera)
        if (Math.abs(ndc.x) > marginNdc || Math.abs(ndc.y) > marginNdc) {
          return false
        }
      }
    }
  }
  return true
}

function distanceToCenter(camera: THREE.Object3D, center: THREE.Vector3): number {
  return camera.position.distanceTo(center)
}

// ---- flat wide plate at default iso orientation ----
test('fitToBounds flat wide plate – all corners in frustum (iso)', () => {
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const controls = makeControls(camera)
  const box = new THREE.Box3(new THREE.Vector3(-100, -10, -50), new THREE.Vector3(100, 10, 50))

  controls.fitToBounds(box) // alignToDefault=false, uses current (default iso)
  assert.ok(allCornersInFrustum(box, camera), 'all 8 corners must be inside frustum')
})

// ---- tall box ----
test('fitToBounds tall box – all corners in frustum (iso)', () => {
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const controls = makeControls(camera)
  const box = new THREE.Box3(new THREE.Vector3(-10, -100, -10), new THREE.Vector3(10, 100, 10))

  controls.fitToBounds(box)
  assert.ok(allCornersInFrustum(box, camera), 'all 8 corners must be inside frustum')
})

// ---- tighter than old sphere approach ----
test('fitToBounds is tighter than old sphere approach for a flat plate', () => {
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const controls = makeControls(camera)
  const box = new THREE.Box3(new THREE.Vector3(-100, -10, -50), new THREE.Vector3(100, 10, 50))
  const center = box.getCenter(new THREE.Vector3())
  const size = box.getSize(new THREE.Vector3())

  controls.fitToBounds(box)
  const dist = distanceToCenter(camera, center)

  // Old formula: sphere radius = size.length()/2, pick the larger of
  // radius / sin(vfov/2) or radius / sin(hfov/2), then × 1.15.
  const radius = size.length() / 2
  const aspect = Math.max(camera.aspect, 1e-3)
  const vfovRad = THREE.MathUtils.degToRad(camera.fov)
  const hfovRad = 2 * Math.atan(Math.tan(vfovRad / 2) * aspect)
  const oldVertical = radius / Math.sin(vfovRad / 2)
  const oldHorizontal = radius / Math.sin(hfovRad / 2)
  const oldDist = Math.max(oldVertical, oldHorizontal) * 1.15

  assert.ok(
    dist < oldDist * 0.9,
    `new distance ${dist.toFixed(1)} should be at least 10% smaller than old ${oldDist.toFixed(1)}`,
  )
})

// ---- setPreset('top') then fitToBounds still fits ----
test('fitToBounds after setPreset top – all corners in frustum', () => {
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const controls = makeControls(camera)
  const box = new THREE.Box3(new THREE.Vector3(-100, -10, -50), new THREE.Vector3(100, 10, 50))

  controls.setPreset('top')
  controls.fitToBounds(box)
  assert.ok(allCornersInFrustum(box, camera), 'all 8 corners must be inside frustum from top view')
})

// ---- alignToDefault=true uses iso orientation ----
test('fitToBounds with alignToDefault uses iso orientation', () => {
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const controls = makeControls(camera)
  const box = new THREE.Box3(new THREE.Vector3(-100, -10, -50), new THREE.Vector3(100, 10, 50))

  // Rotate away from iso first
  controls.setPreset('front')
  controls.setPreset('top')
  // Now alignToDefault should bring it back to iso and fit
  controls.fitToBounds(box, true)
  assert.ok(allCornersInFrustum(box, camera), 'all corners must fit after alignToDefault')
})

// ---- tiny box clamps to MIN_CAMERA_RADIUS ----
test('fitToBounds tiny box clamps radius to MIN_CAMERA_RADIUS', () => {
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const controls = makeControls(camera)
  const box = new THREE.Box3(new THREE.Vector3(-0.01, -0.01, -0.01), new THREE.Vector3(0.01, 0.01, 0.01))
  const center = box.getCenter(new THREE.Vector3())

  controls.fitToBounds(box)
  const dist = distanceToCenter(camera, center)
  assert.ok(
    !Number.isNaN(dist),
    'distance must not be NaN',
  )
  assert.ok(
    dist >= MIN_CAMERA_RADIUS,
    `distance ${dist} must be >= MIN_CAMERA_RADIUS ${MIN_CAMERA_RADIUS}`,
  )
})

// ---- near-degenerate flat box (zero height) ----
test('fitToBounds near-degenerate flat box still fits', () => {
  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const controls = makeControls(camera)
  const box = new THREE.Box3(new THREE.Vector3(-100, 0, -50), new THREE.Vector3(100, 0, 50))

  controls.fitToBounds(box)
  assert.ok(allCornersInFrustum(box, camera), 'zero-height box must fit')
})