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
 * Tests for OBJ import profile and bounds extraction.
 *
 * Run with: npx tsx src/import/obj.test.ts
 */

import { extractImportedModelProfileAndBounds } from './stl'

type AxisSwap = 'none' | 'yz' | 'xz' | 'xy'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon = 1e-6): boolean {
  return Math.abs(a - b) < epsilon
}

function makeObjBase64(text: string): string {
  return btoa(text)
}

function makeFrustumObjBase64(): string {
  return makeObjBase64(`
v 0 0 0
v 12 0 0
v 12 8 0
v 0 8 0
v 4 2 6
v 8 2 6
v 8 6 6
v 4 6 6
f 1 3 2
f 1 4 3
f 5 6 7
f 5 7 8
f 1 2 6 5
f 2 3 7 6
f 3 4 8 7
f 4 1 5 8
`)
}

function makeArtifactObjBase64(): string {
  return makeObjBase64(`
v 0 0 0
v 20 0 0
v 20 10 0
v 0 10 0
v 10 5 1
v 10.002 5 1
v 10.002 5.002 1
f 1 2 3 4
f 5 6 7
`)
}

async function testAxisBounds(): Promise<void> {
  console.log('Testing OBJ import axis-oriented Z bounds...')

  const cases: Array<{ axis: AxisSwap; zTop: number }> = [
    { axis: 'none', zTop: 6 },
    { axis: 'yz', zTop: 8 },
    { axis: 'xz', zTop: 12 },
    { axis: 'xy', zTop: 6 },
  ]

  for (const { axis, zTop } of cases) {
    const result = await extractImportedModelProfileAndBounds('obj', makeFrustumObjBase64(), 1, axis)
    assert(result !== null, `expected extraction result for axis ${axis}`)
    assert(approx(result!.z_bottom, 0), `expected z_bottom=0 for axis ${axis}, got ${result!.z_bottom}`)
    assert(approx(result!.z_top, zTop), `expected z_top=${zTop} for axis ${axis}, got ${result!.z_top}`)
    assert(result!.profile.closed, `expected closed profile for axis ${axis}`)
    assert(result!.profile.segments.length >= 3, `expected polygon profile for axis ${axis}`)
    assert(result!.silhouettePaths.length >= 1, `expected at least one silhouette path for axis ${axis}`)
  }
}

async function testSilhouetteArtifactsAreFiltered(): Promise<void> {
  console.log('Testing OBJ import filters tiny silhouette artifacts...')

  const result = await extractImportedModelProfileAndBounds('obj', makeArtifactObjBase64(), 1, 'none')
  assert(result !== null, 'expected artifact OBJ extraction result')
  assert(result!.silhouettePaths.length === 1, `expected one significant silhouette path, got ${result!.silhouettePaths.length}`)
}

testAxisBounds()
  .then(() => testSilhouetteArtifactsAreFiltered())
  .then(() => console.log('obj import tests passed'))
  .catch((error) => {
    console.error(error)
    throw error
  })
