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
import type { SketchFeature } from '../../types/project'
import { drawLineFeatureBatch, featureUsesSketchFill } from './previewPrimitives'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

assert(!featureUsesSketchFill('line'), 'Line geometry must be stroke-only in Sketch')
assert(!featureUsesSketchFill('construction'), 'Construction geometry must be stroke-only in Sketch')
assert(featureUsesSketchFill('add'), 'Add geometry remains filled')
assert(featureUsesSketchFill('subtract'), 'Subtract geometry remains filled')
assert(featureUsesSketchFill('region'), 'Region geometry remains filled')
assert(featureUsesSketchFill('model'), 'Model silhouette geometry remains filled')

let beginPathCount = 0
let strokeCount = 0
const ctx = {
  beginPath: () => { beginPathCount += 1 },
  moveTo: () => undefined,
  lineTo: () => undefined,
  closePath: () => undefined,
  stroke: () => { strokeCount += 1 },
  setLineDash: () => undefined,
  strokeStyle: '',
  lineWidth: 0,
} as unknown as CanvasRenderingContext2D
const lineFeature = (id: string, x: number): SketchFeature => ({
  id,
  name: id,
  kind: 'rect',
  folderId: null,
  sketch: {
    profile: rectProfile(x, 0, 10, 10),
    origin: { x: 0, y: 0 },
    orientationAngle: 90,
    dimensions: [],
    constraints: [],
  },
  operation: 'line',
  z_top: 5,
  z_bottom: 0,
  visible: true,
  locked: false,
})
drawLineFeatureBatch(ctx, [lineFeature('a', 0), lineFeature('b', 20)], {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
})
assert(beginPathCount === 1, 'Line batch starts one canvas path')
assert(strokeCount === 1, 'Line batch issues one stroke for multiple features')

console.log('previewPrimitives.test.ts passed')
