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

// ---- wheel-zoom pointer anchoring ----

type ListenerStore = Record<string, Array<(e: Event) => void>>

function makeListeningElement(listeners: ListenerStore): HTMLElement {
  return {
    addEventListener(type: string, fn: (e: Event) => void) {
      (listeners[type] ??= []).push(fn)
    },
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
}

function dispatchWheel(listeners: ListenerStore, clientX: number, clientY: number, deltaY: number) {
  const event = {
    clientX,
    clientY,
    deltaY,
    preventDefault() {},
    stopPropagation() {},
  } as unknown as WheelEvent
  listeners['wheel']?.forEach(fn => fn(event))
}

/** Returns the screen-space projection of a world point through the camera
 *  (pixel coords in the fake 800×600 viewport). */
function projectToScreen(point: THREE.Vector3, camera: THREE.Camera): { x: number; y: number } {
  const ndc = point.clone().project(camera)
  return {
    x: (ndc.x + 1) / 2 * 800,
    y: (1 - ndc.y) / 2 * 600,
  }
}

/** Compute the world-space focus point: intersection of the pointer ray at
 *  (clientX,clientY) with the camera-aligned plane through `target`. */
function computeFocusPoint(
  clientX: number,
  clientY: number,
  camera: THREE.Camera,
  target: THREE.Vector3,
): THREE.Vector3 {
  const bounds = { left: 0, top: 0, width: 800, height: 600 }
  const ndc = new THREE.Vector2(
    ((clientX - bounds.left) / bounds.width) * 2 - 1,
    -(((clientY - bounds.top) / bounds.height) * 2 - 1),
  )
  const raycaster = new THREE.Raycaster()
  raycaster.setFromCamera(ndc, camera)
  const camDir = new THREE.Vector3()
  camera.getWorldDirection(camDir)
  const plane = new THREE.Plane(camDir, camDir.dot(target))
  const point = new THREE.Vector3()
  raycaster.ray.intersectPlane(plane, point)
  return point
}

test('wheel zoom anchors focus point under off-center pointer – iso view', () => {
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const listeners: ListenerStore = {}
  const el = makeListeningElement(listeners)
  createOrbitControls(cam, el, {
    onChange: () => {},
    onPresetChange: () => {},
    isInteractionBlocked: () => false,
  })

  const px = 600
  const py = 200
  const focusPoint = computeFocusPoint(px, py, cam, new THREE.Vector3(0, 0, 0))

  dispatchWheel(listeners, px, py, 100)

  const screen = projectToScreen(focusPoint, cam)
  assert.ok(
    Math.abs(screen.x - px) < 1,
    `focus point anchored at screen X: expected ${px}, got ${screen.x.toFixed(1)}`,
  )
  assert.ok(
    Math.abs(screen.y - py) < 1,
    `focus point anchored at screen Y: expected ${py}, got ${screen.y.toFixed(1)}`,
  )
})

test('wheel zoom anchors focus point under off-center pointer – zoom out', () => {
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const listeners: ListenerStore = {}
  const el = makeListeningElement(listeners)
  createOrbitControls(cam, el, {
    onChange: () => {},
    onPresetChange: () => {},
    isInteractionBlocked: () => false,
  })

  const px = 200
  const py = 400
  const focusPoint = computeFocusPoint(px, py, cam, new THREE.Vector3(0, 0, 0))

  dispatchWheel(listeners, px, py, -120)

  const screen = projectToScreen(focusPoint, cam)
  assert.ok(
    Math.abs(screen.x - px) < 1,
    `focus point anchored at screen X: expected ${px}, got ${screen.x.toFixed(1)}`,
  )
  assert.ok(
    Math.abs(screen.y - py) < 1,
    `focus point anchored at screen Y: expected ${py}, got ${screen.y.toFixed(1)}`,
  )
})

test('wheel zoom anchors focus point under off-center pointer – front view', () => {
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const listeners: ListenerStore = {}
  const el = makeListeningElement(listeners)
  const controls = createOrbitControls(cam, el, {
    onChange: () => {},
    onPresetChange: () => {},
    isInteractionBlocked: () => false,
  })

  controls.setPreset('front')
  const px = 150
  const py = 450
  const focusPoint = computeFocusPoint(px, py, cam, new THREE.Vector3(0, 0, 0))

  dispatchWheel(listeners, px, py, 80)

  const screen = projectToScreen(focusPoint, cam)
  assert.ok(
    Math.abs(screen.x - px) < 1,
    `focus point anchored at screen X in front view: expected ${px}, got ${screen.x.toFixed(1)}`,
  )
  assert.ok(
    Math.abs(screen.y - py) < 1,
    `focus point anchored at screen Y in front view: expected ${py}, got ${screen.y.toFixed(1)}`,
  )
})

test('wheel zoom anchors focus point under off-center pointer – right view', () => {
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const listeners: ListenerStore = {}
  const el = makeListeningElement(listeners)
  const controls = createOrbitControls(cam, el, {
    onChange: () => {},
    onPresetChange: () => {},
    isInteractionBlocked: () => false,
  })

  controls.setPreset('right')
  const px = 650
  const py = 150
  const focusPoint = computeFocusPoint(px, py, cam, new THREE.Vector3(0, 0, 0))

  dispatchWheel(listeners, px, py, 90)

  const screen = projectToScreen(focusPoint, cam)
  assert.ok(
    Math.abs(screen.x - px) < 1,
    `focus point anchored at screen X in right view: expected ${px}, got ${screen.x.toFixed(1)}`,
  )
  assert.ok(
    Math.abs(screen.y - py) < 1,
    `focus point anchored at screen Y in right view: expected ${py}, got ${screen.y.toFixed(1)}`,
  )
})

test('wheel zoom anchors focus point with non-origin target after fitToBounds', () => {
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const listeners: ListenerStore = {}
  const el = makeListeningElement(listeners)
  const controls = createOrbitControls(cam, el, {
    onChange: () => {},
    onPresetChange: () => {},
    isInteractionBlocked: () => false,
  })

  const box = new THREE.Box3(
    new THREE.Vector3(50, 50, 50),
    new THREE.Vector3(150, 100, 150),
  )
  controls.fitToBounds(box)
  const target = box.getCenter(new THREE.Vector3())

  const px = 400
  const py = 300
  const focusPoint = computeFocusPoint(px, py, cam, target)

  dispatchWheel(listeners, px, py, 100)

  const screen = projectToScreen(focusPoint, cam)
  assert.ok(
    Math.abs(screen.x - px) < 1,
    `focus point anchored after fitToBounds: expected X ${px}, got ${screen.x.toFixed(1)}`,
  )
  assert.ok(
    Math.abs(screen.y - py) < 1,
    `focus point anchored after fitToBounds: expected Y ${py}, got ${screen.y.toFixed(1)}`,
  )
})

test('wheel zoom at radius limit does not move target', () => {
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const listeners: ListenerStore = {}
  const el = makeListeningElement(listeners)
  createOrbitControls(cam, el, {
    onChange: () => {},
    onPresetChange: () => {},
    isInteractionBlocked: () => false,
  })

  // Zoom in aggressively to hit the minimum radius clamp.
  dispatchWheel(listeners, 400, 300, -50000)

  // Record the screen position of the origin after hitting the limit.
  const originScreenBefore = projectToScreen(new THREE.Vector3(0, 0, 0), cam)

  // Try to zoom in even more — should be clamped with no change.
  dispatchWheel(listeners, 600, 200, -100)

  const originScreenAfter = projectToScreen(new THREE.Vector3(0, 0, 0), cam)
  assert.ok(
    Math.abs(originScreenAfter.x - originScreenBefore.x) < 1,
    'origin screen X must not jump when zoom is clamped',
  )
  assert.ok(
    Math.abs(originScreenAfter.y - originScreenBefore.y) < 1,
    'origin screen Y must not jump when zoom is clamped',
  )
})
// ---- orbit direction (issue #493) ----

/** Fires a complete left-button drag: pointerdown, one pointermove, pointerup. */
function dispatchDrag(
  listeners: ListenerStore,
  dx: number,
  dy: number,
  startX = 400,
  startY = 300,
) {
  const base = {
    pointerType: 'mouse',
    pointerId: 1,
    button: 0,
    shiftKey: false,
    preventDefault() {},
  }
  const down = { ...base, clientX: startX, clientY: startY } as unknown as Event
  const moved = { ...base, clientX: startX + dx, clientY: startY + dy } as unknown as Event
  listeners['pointerdown']?.forEach(fn => fn(down))
  listeners['pointermove']?.forEach(fn => fn(moved))
  listeners['pointerup']?.forEach(fn => fn(moved))
}

function makeListeningControls(cam: THREE.PerspectiveCamera) {
  const listeners: ListenerStore = {}
  const el = makeListeningElement(listeners)
  const controls = createOrbitControls(cam, el, {
    onChange: () => {},
    onPresetChange: () => {},
    isInteractionBlocked: () => false,
  })
  return { listeners, controls }
}

test('orbit follows the cursor: dragging down raises the camera', () => {
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const { listeners } = makeListeningControls(cam)

  const heightBefore = cam.position.y
  dispatchDrag(listeners, 0, 60)

  // Direct manipulation: drag down tips the model towards the viewer, which
  // lifts the camera. The inverted sign sends it under the table instead.
  assert.ok(
    cam.position.y > heightBefore,
    `dragging down must raise the camera (was ${heightBefore}, now ${cam.position.y})`,
  )
})

test('orbit follows the cursor: dragging right moves the model right', () => {
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const { listeners } = makeListeningControls(cam)

  // Probe off the vertical orbit axis, on the near side so it is the point the
  // user feels they have grabbed.
  const probe = new THREE.Vector3(30, 0, 30)
  const before = projectToScreen(probe, cam)
  dispatchDrag(listeners, 40, 0)
  const after = projectToScreen(probe, cam)

  assert.ok(
    after.x > before.x,
    `dragging right must move the near face right (was ${before.x}, now ${after.x})`,
  )
})

test('orbiting away from the top preset never mirrors the view', () => {
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const { listeners, controls } = makeListeningControls(cam)
  controls.setPreset('top')

  // A point on +X, off the orbit axis. Screen right stays +X for every polar
  // angle in the clamped range, so this must remain right of centre the whole
  // way down. A stale top-view `up` puts it left of centre once the camera
  // crosses eye level.
  const probe = new THREE.Vector3(40, 0, 0)
  assert.ok(
    projectToScreen(probe, cam).x > 400,
    'probe must start right of centre at the top preset',
  )

  // Drag up to descend from top-down, through eye level, to the bottom clamp.
  for (let step = 0; step < 40; step++) {
    dispatchDrag(listeners, 0, -10)
    const screen = projectToScreen(probe, cam)
    assert.ok(
      screen.x > 400,
      `view mirrored while orbiting from top (step ${step}, screen x ${screen.x})`,
    )
  }
})

test('horizontal drag at the top preset spins the plan view instead of orbiting', () => {
  const cam = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  const { listeners, controls } = makeListeningControls(cam)
  controls.setPreset('top')

  // Two marks on the material, both well clear of the view axis looking down.
  const a = new THREE.Vector3(40, 0, 0)
  const b = new THREE.Vector3(0, 0, 40)
  const screenAngle = () => {
    const pa = projectToScreen(a, cam)
    const pb = projectToScreen(b, cam)
    return Math.atan2(pb.y - pa.y, pb.x - pa.x)
  }

  const forwardBefore = new THREE.Vector3()
  cam.getWorldDirection(forwardBefore)
  const angleBefore = screenAngle()

  dispatchDrag(listeners, 50, 0)

  const forwardAfter = new THREE.Vector3()
  cam.getWorldDirection(forwardAfter)
  let spinDeg = THREE.MathUtils.radToDeg(screenAngle() - angleBefore)
  while (spinDeg > 180) spinDeg -= 360
  while (spinDeg < -180) spinDeg += 360

  // Looking straight down, "turn left" has no meaning beyond roll, so a fixed-up
  // orbit spins the image in place. Verified against SketchUp; three.js
  // OrbitControls does the same. This is intended behaviour, not a defect.
  //
  // It is guarded because the obvious way to "fix" a spinning top view is to let
  // a preset up-vector survive into free orbit, which pins screen-right — and
  // that is exactly the stale-up bug the mirror test above covers. Restoring one
  // silently restores the other. Issue #493.
  assert.ok(
    Math.abs(spinDeg) > 20,
    `top view must spin under a horizontal drag (spun ${spinDeg}°)`,
  )
  assert.ok(
    THREE.MathUtils.radToDeg(forwardBefore.angleTo(forwardAfter)) < 5,
    'top view must keep looking essentially straight down while it spins',
  )
})
