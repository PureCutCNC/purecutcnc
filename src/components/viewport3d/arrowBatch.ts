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

/** One arrow's placement, in the same terms `THREE.ArrowHelper` takes. */
export interface ArrowPlacement {
  origin: THREE.Vector3
  direction: THREE.Vector3
  markerLength: number
  headLength: number
  headWidth: number
}

export const ARROW_KINDS = ['cut', 'rapid'] as const

/** Scratch axis for `setArrowQuaternion`; never read outside it. */
const ARROW_AXIS = new THREE.Vector3()

/**
 * `THREE.ArrowHelper.setDirection`, reproduced.
 *
 * Not `setFromUnitVectors(+Y, direction)`: that picks a different perpendicular
 * axis, so the two agree on where the cone points but differ by a roll about
 * it. The head is a **5-segment** cone, not a smooth one, so that roll is
 * visible — the pentagon lands on different vertices. Copying the helper's own
 * construction keeps the batch pixel-identical to what it replaced, including
 * its two pole special cases.
 */
function setArrowQuaternion(quaternion: THREE.Quaternion, direction: THREE.Vector3): void {
  if (direction.y > 0.99999) {
    quaternion.set(0, 0, 0, 1)
  } else if (direction.y < -0.99999) {
    quaternion.set(1, 0, 0, 0)
  } else {
    ARROW_AXIS.set(direction.z, 0, -direction.x).normalize()
    quaternion.setFromAxisAngle(ARROW_AXIS, Math.acos(direction.y))
  }
}

/**
 * Every arrow of one colour as two objects instead of two per arrow (issue
 * #664).
 *
 * The previous code created a `THREE.ArrowHelper` per arrow, each carrying its
 * own `Line`, cone `Mesh` and pair of materials. On this issue's 249,663-move
 * fixture that was ~4,950 helpers — 29,741 scene objects and **19,835 draw
 * calls per frame**, which `Viewport3D`'s render loop then re-submitted for the
 * life of the session. Batching makes it 2 draw calls per kind, at most 4 in
 * total.
 *
 * The geometry deliberately reproduces `ArrowHelper` exactly: its shaft runs
 * from the origin to `markerLength - headLength` along the direction, and its
 * head is a 5-segment cone of base radius `headWidth / 2` and height
 * `headLength` whose apex sits at `markerLength`. Keeping those terms means the
 * rendered arrows are unchanged; only how many objects carry them differs.
 */
export function buildArrowBatch(placements: readonly ArrowPlacement[], color: number): THREE.Object3D[] {
  const shaftPositions = new Float32Array(placements.length * 2 * 3)
  const headMatrices = new THREE.InstancedMesh(
    // ArrowHelper's cone: radius 0.5 at the base, apex up, translated so the
    // base sits at the origin. Scaling by (headWidth, headLength, headWidth)
    // then gives base radius headWidth / 2, exactly as ArrowHelper does.
    new THREE.CylinderGeometry(0, 0.5, 1, 5, 1).translate(0, -0.5, 0),
    new THREE.MeshBasicMaterial({
      color, toneMapped: false, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false,
    }),
    placements.length,
  )

  const quaternion = new THREE.Quaternion()
  const scale = new THREE.Vector3()
  const apex = new THREE.Vector3()
  const matrix = new THREE.Matrix4()

  for (let i = 0; i < placements.length; i += 1) {
    const { origin, direction, markerLength, headLength, headWidth } = placements[i]
    const shaftLength = Math.max(0.0001, markerLength - headLength)
    const offset = i * 6
    shaftPositions[offset] = origin.x
    shaftPositions[offset + 1] = origin.y
    shaftPositions[offset + 2] = origin.z
    shaftPositions[offset + 3] = origin.x + direction.x * shaftLength
    shaftPositions[offset + 4] = origin.y + direction.y * shaftLength
    shaftPositions[offset + 5] = origin.z + direction.z * shaftLength

    setArrowQuaternion(quaternion, direction)
    apex.copy(origin).addScaledVector(direction, markerLength)
    scale.set(headWidth, headLength, headWidth)
    headMatrices.setMatrixAt(i, matrix.compose(apex, quaternion, scale))
  }
  headMatrices.instanceMatrix.needsUpdate = true

  const shaftGeometry = new THREE.BufferGeometry()
  shaftGeometry.setAttribute('position', new THREE.BufferAttribute(shaftPositions, 3))
  const shafts = new THREE.LineSegments(
    shaftGeometry,
    new THREE.LineBasicMaterial({
      color, toneMapped: false, transparent: true, opacity: 0.95, depthWrite: false, depthTest: false,
    }),
  )

  return [shafts, headMatrices]
}
