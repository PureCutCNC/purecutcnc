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
 * Tests for STL import profile and bounds extraction.
 *
 * Run with: npx tsx src/import/stl.test.ts
 */

import {
  loadImportedTriangleMesh,
  normalizeImportedMeshForStorage,
  splitMeshByConnectedComponents,
} from '../engine/importedMesh'
import { extractImportedMeshProfileAndBounds, extractStlProfileAndBounds } from './stl'

type AxisSwap = 'none' | 'yz' | 'xz' | 'xy'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) < epsilon
}

export function makeFrustumStlBase64(): string {
  const vertices = {
    b0: [0, 0, 0],
    b1: [12, 0, 0],
    b2: [12, 8, 0],
    b3: [0, 8, 0],
    t0: [4, 2, 6],
    t1: [8, 2, 6],
    t2: [8, 6, 6],
    t3: [4, 6, 6],
  } as const

  const faces: Array<[keyof typeof vertices, keyof typeof vertices, keyof typeof vertices]> = [
    ['b0', 'b2', 'b1'], ['b0', 'b3', 'b2'],
    ['t0', 't1', 't2'], ['t0', 't2', 't3'],
    ['b0', 'b1', 't1'], ['b0', 't1', 't0'],
    ['b1', 'b2', 't2'], ['b1', 't2', 't1'],
    ['b2', 'b3', 't3'], ['b2', 't3', 't2'],
    ['b3', 'b0', 't0'], ['b3', 't0', 't3'],
  ]

  const lines = ['solid frustum']
  for (const face of faces) {
    lines.push('  facet normal 0 0 0')
    lines.push('    outer loop')
    for (const key of face) {
      lines.push(`      vertex ${vertices[key].join(' ')}`)
    }
    lines.push('    endloop')
    lines.push('  endfacet')
  }
  lines.push('endsolid frustum')
  return btoa(`${lines.join('\n')}\n`)
}

function makeArtifactStlBase64(): string {
  const lines = ['solid artifact']
  const faces = [
    [[0, 0, 0], [20, 0, 0], [20, 10, 0]],
    [[0, 0, 0], [20, 10, 0], [0, 10, 0]],
    [[10, 5, 1], [10.002, 5, 1], [10.002, 5.002, 1]],
  ]

  for (const face of faces) {
    lines.push('  facet normal 0 0 0')
    lines.push('    outer loop')
    for (const vertex of face) {
      lines.push(`      vertex ${vertex.join(' ')}`)
    }
    lines.push('    endloop')
    lines.push('  endfacet')
  }

  lines.push('endsolid artifact')
  return btoa(`${lines.join('\n')}\n`)
}

async function testAxisBounds(): Promise<void> {
  console.log('Testing STL import axis-oriented Z bounds...')

  const cases: Array<{ axis: AxisSwap; zTop: number }> = [
    { axis: 'none', zTop: 6 },
    { axis: 'yz', zTop: 8 },
    { axis: 'xz', zTop: 12 },
    { axis: 'xy', zTop: 6 },
  ]

  for (const { axis, zTop } of cases) {
    const result = await extractStlProfileAndBounds(makeFrustumStlBase64(), 1, axis)
    assert(result !== null, `expected extraction result for axis ${axis}`)
    assert(approx(result!.z_bottom, 0), `expected z_bottom=0 for axis ${axis}, got ${result!.z_bottom}`)
    assert(approx(result!.z_top, zTop), `expected z_top=${zTop} for axis ${axis}, got ${result!.z_top}`)
    assert(result!.profile.closed, `expected closed profile for axis ${axis}`)
    assert(result!.profile.segments.length >= 3, `expected polygon profile for axis ${axis}`)
    assert(result!.silhouettePaths.length >= 1, `expected at least one silhouette path for axis ${axis}`)
  }
}

async function testSilhouetteArtifactsAreFiltered(): Promise<void> {
  console.log('Testing STL import filters tiny silhouette artifacts...')

  const result = await extractStlProfileAndBounds(makeArtifactStlBase64(), 1, 'none')
  assert(result !== null, 'expected artifact STL extraction result')
  assert(result!.silhouettePaths.length === 1, `expected one significant silhouette path, got ${result!.silhouettePaths.length}`)
}

/**
 * Build an ASCII STL whose body is a unit axis-aligned cube at the given
 * origin and side length. 12 triangles, normals omitted (set to 0 0 0; the
 * STL loader does not require accurate normals).
 */
function makeCubeStlLines(originX: number, originY: number, originZ: number, side: number, label: string): string[] {
  const corners: Array<[number, number, number]> = [
    [0, 0, 0], [side, 0, 0], [side, side, 0], [0, side, 0],
    [0, 0, side], [side, 0, side], [side, side, side], [0, side, side],
  ]
  function world(corner: [number, number, number]): [number, number, number] {
    return [originX + corner[0], originY + corner[1], originZ + corner[2]]
  }
  const faces: Array<[number, number, number]> = [
    [0, 2, 1], [0, 3, 2],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [2, 3, 7], [2, 7, 6],
    [1, 2, 6], [1, 6, 5],
    [0, 4, 7], [0, 7, 3],
  ]
  const lines: string[] = [`solid ${label}`]
  for (const face of faces) {
    lines.push('  facet normal 0 0 0')
    lines.push('    outer loop')
    for (const cornerIdx of face) {
      const w = world(corners[cornerIdx])
      lines.push(`      vertex ${w[0]} ${w[1]} ${w[2]}`)
    }
    lines.push('    endloop')
    lines.push('  endfacet')
  }
  lines.push(`endsolid ${label}`)
  return lines
}

function makeTwoCubesStlBase64(): string {
  // Two disjoint cubes, axis-aligned, separated in X with a 10-unit gap so
  // welding at 1e-5 cannot bridge them. The "solid" wrapper for the second
  // cube is omitted because the STL loader treats multiple solids as a
  // single triangle stream anyway.
  const linesA = makeCubeStlLines(0, 0, 0, 10, 'cubeA')
  const linesB = makeCubeStlLines(20, 0, 0, 10, 'cubeB')
  return btoa([...linesA, ...linesB].join('\n') + '\n')
}

async function testMultiBodyImportSplits(): Promise<void> {
  console.log('Testing multi-body STL splits into per-body profiles...')
  const stlBase64 = makeTwoCubesStlBase64()
  const parsed = loadImportedTriangleMesh('stl', stlBase64, 'none')
  assert(parsed !== null, 'two-cube STL must parse')
  const normalized = normalizeImportedMeshForStorage(parsed!, 1)
  const bodies = splitMeshByConnectedComponents(normalized)
  assert(bodies.length === 2, `expected 2 bodies for two disjoint cubes, got ${bodies.length}`)

  // Pin order by X so the assertions are stable.
  bodies.sort((a, b) => a.bounds.minX - b.bounds.minX)

  const resultA = await extractImportedMeshProfileAndBounds(bodies[0])
  const resultB = await extractImportedMeshProfileAndBounds(bodies[1])
  assert(resultA !== null && resultB !== null, 'each body must yield a profile')

  // Per-body Z extents match the source cubes.
  assert(approx(resultA!.z_bottom, 0) && approx(resultA!.z_top, 10),
    `body A z=[${resultA!.z_bottom},${resultA!.z_top}], expected [0,10]`)
  assert(approx(resultB!.z_bottom, 0) && approx(resultB!.z_top, 10),
    `body B z=[${resultB!.z_bottom},${resultB!.z_top}], expected [0,10]`)

  // Body A's profile must live entirely within X=[0,10]; body B within X=[20,30].
  function profileBboxX(profile: { start: { x: number; y: number }; segments: Array<{ to: { x: number; y: number } }> }): { min: number; max: number } {
    let min = profile.start.x
    let max = profile.start.x
    for (const seg of profile.segments) {
      if (seg.to.x < min) min = seg.to.x
      if (seg.to.x > max) max = seg.to.x
    }
    return { min, max }
  }
  const aX = profileBboxX(resultA!.profile)
  const bX = profileBboxX(resultB!.profile)
  assert(approx(aX.min, 0, 1e-3) && approx(aX.max, 10, 1e-3),
    `body A profile X=[${aX.min},${aX.max}], expected [0,10]`)
  assert(approx(bX.min, 20, 1e-3) && approx(bX.max, 30, 1e-3),
    `body B profile X=[${bX.min},${bX.max}], expected [20,30]`)

  // Each body should produce a single outer silhouette path.
  assert(resultA!.silhouettePaths.length === 1, `body A silhouettePaths=${resultA!.silhouettePaths.length}, expected 1`)
  assert(resultB!.silhouettePaths.length === 1, `body B silhouettePaths=${resultB!.silhouettePaths.length}, expected 1`)
}

testAxisBounds()
  .then(() => testSilhouetteArtifactsAreFiltered())
  .then(() => testMultiBodyImportSplits())
  .then(() => console.log('stl import tests passed'))
  .catch((error) => {
    console.error(error)
    throw error
  })
