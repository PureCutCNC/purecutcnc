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

import { rectProfile } from '../../types/project'
import { resolveStlTopViewPlacement } from './stlTopViewRenderer'

function assertClose(actual: number, expected: number, message: string): void {
  if (Math.abs(actual - expected) > 1e-9) {
    throw new Error(`Assertion failed: ${message}; expected ${expected}, got ${actual}`)
  }
}

function assertTransform(
  actual: [number, number, number, number, number, number],
  expected: [number, number, number, number, number, number],
  message: string,
): void {
  actual.forEach((value, index) => assertClose(value, expected[index], `${message} at ${index}`))
}

const localProfile = rectProfile(0, 0, 2, 1)
const view = { scale: 100, offsetX: 10, offsetY: 20 }

const rotated = resolveStlTopViewPlacement(
  localProfile,
  { a: 0, b: 1, c: -1, d: 0, e: 2, f: 1.5 },
  view,
)
if (!rotated) throw new Error('Expected a rotated imported-model placement')
assertTransform(
  rotated.canvasTransform,
  [0, 100, -100, 0, 210, 170],
  'Oldman-style quarter-turn placement reaches the sketch canvas',
)
assertClose(rotated.localBounds.width, 2, 'Top-view image retains definition-local width')
assertClose(rotated.localBounds.height, 1, 'Top-view image retains definition-local height')

const affine = resolveStlTopViewPlacement(
  localProfile,
  { a: -2, b: 0.25, c: 0.5, d: 1.5, e: 3, f: -1 },
  { scale: 4, offsetX: 7, offsetY: 11 },
)
if (!affine) throw new Error('Expected an affine imported-model placement')
assertTransform(
  affine.canvasTransform,
  [-8, 1, 2, 6, 19, 7],
  'Mirror, scale, and shear are preserved in the sketch canvas transform',
)

console.log('stlTopViewRenderer.test.ts passed')
