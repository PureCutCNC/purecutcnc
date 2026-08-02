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
import { drawLineFeatureBatch, drawToolpath, featureUsesSketchFill } from './previewPrimitives'
import type { ToolpathVisibility } from '../toolpathVisibility'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { ViewTransform } from './viewTransform'

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

// --- drawToolpath: lead-ins are in their own layer, gated by leadIns ---

function testDrawToolpathLayerSplit(): void {
  console.log('Testing drawToolpath separates lead_in moves into a leadIns layer...')

  const segments: Array<{ fromX: number; fromY: number; toX: number; toY: number }> = []
  const mockCtx = {
    beginPath: () => undefined,
    moveTo: (x: number, y: number) => { segments.push({ fromX: x, fromY: y, toX: -1, toY: -1 }) },
    lineTo: (x: number, y: number) => {
      const last = segments[segments.length - 1]
      if (last) { last.toX = x; last.toY = y }
    },
    stroke: () => undefined,
    setLineDash: () => undefined,
    strokeStyle: '',
    lineWidth: 0,
    globalAlpha: 1,
  } as unknown as CanvasRenderingContext2D

  const toolpath: ToolpathResult = {
    operationId: 'test-op',
    moves: [
      { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 } },
      { kind: 'lead_in', from: { x: 20, y: 0, z: 0 }, to: { x: 30, y: 0, z: 0 } },
    ],
    warnings: [],
    bounds: null,
  }

  const vt: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 }

  // Visible: cuts only. Lead-in should NOT appear.
  segments.length = 0
  const cutsOnly: ToolpathVisibility = { cuts: true, leadIns: false, rapids: false, plunges: false, retractions: false, directions: false }
  drawToolpath(mockCtx, toolpath, vt, false, cutsOnly)
  const cutSegmentIndex = segments.findIndex((s) => s.fromX === 0 && s.toX === 10)
  const leadInSegmentIndex = segments.findIndex((s) => s.fromX === 20 && s.toX === 30)
  assert(cutSegmentIndex !== -1, 'cut move renders when cuts visible and leadIns hidden')
  assert(leadInSegmentIndex === -1, 'lead_in move does NOT render when leadIns hidden')

  // Visible: leadIns only. Cut should NOT appear.
  segments.length = 0
  const leadInsOnly: ToolpathVisibility = { cuts: false, leadIns: true, rapids: false, plunges: false, retractions: false, directions: false }
  drawToolpath(mockCtx, toolpath, vt, false, leadInsOnly)
  const cutIndex2 = segments.findIndex((s) => s.fromX === 0 && s.toX === 10)
  const leadInIndex2 = segments.findIndex((s) => s.fromX === 20 && s.toX === 30)
  assert(cutIndex2 === -1, 'cut move does NOT render when cuts hidden and leadIns visible')
  assert(leadInIndex2 !== -1, 'lead_in move renders when leadIns visible and cuts hidden')

  // Both visible: both should render.
  segments.length = 0
  const bothOn: ToolpathVisibility = { cuts: true, leadIns: true, rapids: false, plunges: false, retractions: false, directions: false }
  drawToolpath(mockCtx, toolpath, vt, false, bothOn)
  assert(segments.findIndex((s) => s.fromX === 0 && s.toX === 10) !== -1, 'cut move renders when both visible')
  assert(segments.findIndex((s) => s.fromX === 20 && s.toX === 30) !== -1, 'lead_in move renders when both visible')
}

testDrawToolpathLayerSplit()

console.log('previewPrimitives.test.ts passed')
