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

/**
 * Batched direction arrows draw what `ArrowHelper` drew (issue #664).
 *
 * `buildArrowBatch` replaced one `THREE.ArrowHelper` per arrow — 29,741 scene
 * objects and 19,835 draw calls per frame on this issue's fixture — with two
 * objects per colour. That is only a safe trade if the geometry is the same
 * geometry, so this file does not assert against numbers copied out of the new
 * implementation: it **builds a real `ArrowHelper` for each case and compares
 * against it**. The oracle is three.js itself, so the two cannot share a bug,
 * and a future three.js version that changes `ArrowHelper` fails here rather
 * than silently moving the preview.
 *
 * The comparison is on resolved world geometry, not on the object graph:
 * `ArrowHelper` carries its shaft as a unit `Line` scaled by a matrix and its
 * head as a translated cone, while the batch carries explicit shaft endpoints
 * and a per-instance matrix. Both are reduced to "where does the shaft start
 * and end, and where does the cone sit, in world space" before comparing.
 *
 * ## What each mutation kills
 *
 * | Mutation | Killed by |
 * | --- | --- |
 * | shaft runs the full `markerLength` (head not subtracted) | `shaft endpoints match ArrowHelper` |
 * | cone placed at the shaft end instead of the tip | `head transform matches ArrowHelper` |
 * | cone scaled by `headWidth / 2` instead of `headWidth` | `head transform matches ArrowHelper` |
 * | rotation composed from the wrong axis | `head transform matches ArrowHelper`, `arrows along -Y` |
 * | instance matrices not flushed | `instanceMatrix is flagged for upload` |
 * | one object per arrow again | `batches every arrow into two objects` |
 *
 * Run with: npx tsx src/components/viewport3d/arrowBatch.test.ts
 */

import * as THREE from 'three'

import { ARROW_KINDS, buildArrowBatch, type ArrowPlacement } from './arrowBatch'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const TOLERANCE = 1e-6

function close(a: number, b: number, tolerance = TOLERANCE): boolean {
  return Math.abs(a - b) <= tolerance
}

function vectorsClose(a: THREE.Vector3, b: THREE.Vector3, tolerance = TOLERANCE): boolean {
  return close(a.x, b.x, tolerance) && close(a.y, b.y, tolerance) && close(a.z, b.z, tolerance)
}

/** The placements below span axis-aligned, diagonal, and antiparallel directions. */
function placement(
  origin: [number, number, number],
  direction: [number, number, number],
  markerLength: number,
): ArrowPlacement {
  const dir = new THREE.Vector3(...direction).normalize()
  return {
    origin: new THREE.Vector3(...origin),
    direction: dir,
    markerLength,
    headLength: markerLength * 0.45,
    headWidth: markerLength * 0.18,
  }
}

const CASES: ArrowPlacement[] = [
  placement([0, 0, 0], [1, 0, 0], 1),
  placement([3, -2, 7], [0, 0, 1], 0.4),
  placement([-1.5, 0.25, 2], [1, 0, 1], 2.4),
  placement([10, 4, -6], [-3, 0, 5], 0.08),
  // Antiparallel to the build axis — the case `setFromUnitVectors` has to
  // special-case, and the one a naive cross-product rotation gets wrong.
  placement([0, 1, 0], [0, -1, 0], 1.2),
  placement([0, 1, 0], [0, 1, 0], 1.2),
]

/** The shaft's world start/end, as `ArrowHelper` resolves them. */
function arrowHelperShaft(p: ArrowPlacement): { start: THREE.Vector3; end: THREE.Vector3 } {
  const helper = new THREE.ArrowHelper(
    p.direction, p.origin, p.markerLength, 0xffffff, p.headLength, p.headWidth,
  )
  helper.updateMatrixWorld(true)
  const geometry = helper.line.geometry
  const position = geometry.getAttribute('position')
  const start = new THREE.Vector3().fromBufferAttribute(position, 0).applyMatrix4(helper.line.matrixWorld)
  const end = new THREE.Vector3().fromBufferAttribute(position, 1).applyMatrix4(helper.line.matrixWorld)
  return { start, end }
}

function batchOf(placements: ArrowPlacement[]): { shafts: THREE.LineSegments; heads: THREE.InstancedMesh } {
  const objects = buildArrowBatch(placements, 0xffffff)
  assert(objects.length === 2, `expected 2 objects, got ${objects.length}`)
  const [shafts, heads] = objects
  assert(shafts instanceof THREE.LineSegments, 'first object should be the shaft LineSegments')
  assert(heads instanceof THREE.InstancedMesh, 'second object should be the head InstancedMesh')
  return { shafts, heads }
}

console.log('\narrowBatch')

test('batches every arrow into two objects, whatever the count', () => {
  for (const count of [1, 6, 500]) {
    const many = Array.from({ length: count }, (_, i) => placement([i, 0, 0], [1, 0, 0], 1))
    const objects = buildArrowBatch(many, 0xffffff)
    assert(objects.length === 2, `${count} arrows should still be 2 objects, got ${objects.length}`)
    const heads = objects[1] as THREE.InstancedMesh
    assert(heads.count === count, `expected ${count} instances, got ${heads.count}`)
  }
})

test('shaft endpoints match ArrowHelper', () => {
  const { shafts } = batchOf(CASES)
  const position = shafts.geometry.getAttribute('position')
  assert(position.count === CASES.length * 2, `expected ${CASES.length * 2} vertices, got ${position.count}`)

  for (let i = 0; i < CASES.length; i += 1) {
    const expected = arrowHelperShaft(CASES[i])
    const start = new THREE.Vector3().fromBufferAttribute(position, i * 2)
    const end = new THREE.Vector3().fromBufferAttribute(position, i * 2 + 1)
    assert(
      vectorsClose(start, expected.start),
      `arrow ${i} shaft start ${start.toArray().join(',')} != ArrowHelper ${expected.start.toArray().join(',')}`,
    )
    assert(
      vectorsClose(end, expected.end),
      `arrow ${i} shaft end ${end.toArray().join(',')} != ArrowHelper ${expected.end.toArray().join(',')}`,
    )
  }
})

test('head transform matches ArrowHelper', () => {
  const { heads } = batchOf(CASES)
  const actual = new THREE.Matrix4()

  for (let i = 0; i < CASES.length; i += 1) {
    const p = CASES[i]
    const helper = new THREE.ArrowHelper(
      p.direction, p.origin, p.markerLength, 0xffffff, p.headLength, p.headWidth,
    )
    helper.updateMatrixWorld(true)
    heads.getMatrixAt(i, actual)

    // Compare where the cone actually lands: its own local apex and base ring
    // pushed through each transform. This is insensitive to how the rotation
    // was represented and catches position, scale and orientation together.
    for (const local of [
      new THREE.Vector3(0, 0, 0),      // apex, in ArrowHelper's cone space
      new THREE.Vector3(0, -1, 0),     // base centre
      new THREE.Vector3(0.5, -1, 0),   // a point on the base rim
      new THREE.Vector3(0, -1, 0.5),
    ]) {
      const expected = local.clone().applyMatrix4(helper.cone.matrixWorld)
      const got = local.clone().applyMatrix4(actual)
      assert(
        vectorsClose(got, expected, 1e-5),
        `arrow ${i} cone point ${local.toArray().join(',')}: ${got.toArray().join(',')} != ${expected.toArray().join(',')}`,
      )
    }
  }
})

test('arrows along -Y are placed correctly (the antiparallel case)', () => {
  const down = placement([0, 5, 0], [0, -1, 0], 1)
  const { shafts, heads } = batchOf([down])
  const position = shafts.geometry.getAttribute('position')
  const start = new THREE.Vector3().fromBufferAttribute(position, 0)
  const end = new THREE.Vector3().fromBufferAttribute(position, 1)
  assert(vectorsClose(start, new THREE.Vector3(0, 5, 0)), `shaft should start at the origin, got ${start.toArray().join(',')}`)
  assert(
    vectorsClose(end, new THREE.Vector3(0, 5 - (1 - down.headLength), 0)),
    `shaft should run down by markerLength - headLength, got ${end.toArray().join(',')}`,
  )
  const matrix = new THREE.Matrix4()
  heads.getMatrixAt(0, matrix)
  const apex = new THREE.Vector3(0, 0, 0).applyMatrix4(matrix)
  assert(vectorsClose(apex, new THREE.Vector3(0, 4, 0)), `cone apex should sit at the arrow tip, got ${apex.toArray().join(',')}`)
})

test('instanceMatrix is flagged for upload', () => {
  const { heads } = batchOf(CASES)
  // `needsUpdate` is write-only on a BufferAttribute — the setter bumps
  // `version` and there is no getter. Assert on what it actually moves.
  assert(
    heads.instanceMatrix.version > 0,
    'instance matrices must be flagged for upload, or nothing renders',
  )
})

test('materials are the depth-independent overlay materials', () => {
  const { shafts, heads } = batchOf(CASES)
  for (const [label, material] of [['shaft', shafts.material], ['head', heads.material]] as const) {
    const mat = material as THREE.Material
    assert(mat.transparent, `${label} material should be transparent`)
    assert(close(mat.opacity, 0.95), `${label} opacity should be 0.95, got ${mat.opacity}`)
    assert(mat.depthWrite === false, `${label} should not write depth`)
    assert(mat.depthTest === false, `${label} should not depth-test — the overlay draws on top`)
  }
})

test('ARROW_KINDS covers exactly the two kinds that get arrows', () => {
  assert(ARROW_KINDS.length === 2, `expected 2 kinds, got ${ARROW_KINDS.length}`)
  assert(ARROW_KINDS.includes('cut'), 'cut moves get arrows')
  assert(ARROW_KINDS.includes('rapid'), 'rapid moves get arrows')
})

console.log(`\narrowBatch: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
