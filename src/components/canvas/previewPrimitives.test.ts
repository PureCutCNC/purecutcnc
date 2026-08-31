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
import { toolpathDisplayGeometry } from './toolpathDisplay'
import { canvasColors } from './canvasPalette'

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

interface RecordedSegment { fromX: number; fromY: number; toX: number; toY: number }

/** A canvas stub that records the line segments drawToolpath strokes. */
function recordingContext(): { ctx: CanvasRenderingContext2D; segments: RecordedSegment[] } {
  const segments: RecordedSegment[] = []
  const ctx = {
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
  return { ctx, segments }
}

// --- drawToolpath: lead-ins are in their own layer, gated by leadIns ---

function testDrawToolpathLayerSplit(): void {
  console.log('Testing drawToolpath separates lead_in moves into a leadIns layer...')

  const { ctx: mockCtx, segments } = recordingContext()

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

// --- Issue #482: the 2D canvas draws descending rapids too ---

/**
 * A rapid that descends while travelling in XY is a visible diagonal in plan
 * view, and it used to be dropped: the `rapids` layer took only level moves and
 * `retractions` only ascents, so this move belonged to neither. It is the shape
 * a rapid takes when it dives into material on the way somewhere.
 */
function testDrawToolpathDrawsDescendingRapids(): void {
  console.log('Testing drawToolpath draws a descending rapid (issue #482)...')

  const descending = { kind: 'rapid' as const, from: { x: 0, y: 0, z: 10 }, to: { x: 40, y: 0, z: 2 } }
  const ascending = { kind: 'rapid' as const, from: { x: 50, y: 0, z: 2 }, to: { x: 60, y: 0, z: 10 } }
  const toolpath: ToolpathResult = {
    operationId: 'test-op',
    moves: [descending, ascending],
    warnings: [],
    bounds: null,
  }
  const vt: ViewTransform = { scale: 1, offsetX: 0, offsetY: 0 }
  const allOff: ToolpathVisibility = { cuts: false, leadIns: false, rapids: false, plunges: false, retractions: false, directions: false }
  const found = (segments: RecordedSegment[], fromX: number, toX: number): boolean =>
    segments.some((s) => s.fromX === fromX && s.toX === toX)

  // Rapids on, retractions off: the descent draws, the retraction does not.
  const rapidsOnly = recordingContext()
  drawToolpath(rapidsOnly.ctx, toolpath, vt, false, { ...allOff, rapids: true })
  assert(found(rapidsOnly.segments, 0, 40), 'descending rapid renders when rapids visible')
  assert(!found(rapidsOnly.segments, 50, 60), 'ascending rapid does NOT render when retractions hidden')

  // Retractions on, rapids off: the mirror image.
  const retractionsOnly = recordingContext()
  drawToolpath(retractionsOnly.ctx, toolpath, vt, false, { ...allOff, retractions: true })
  assert(!found(retractionsOnly.segments, 0, 40), 'descending rapid does NOT render when rapids hidden')
  assert(found(retractionsOnly.segments, 50, 60), 'ascending rapid renders when retractions visible')

  // Everything off: nothing at all, so the assertions above cannot pass by
  // some other layer happening to draw the same segment.
  const nothing = recordingContext()
  drawToolpath(nothing.ctx, toolpath, vt, false, allOff)
  assert(nothing.segments.length === 0, 'no rapid renders when both toggles are off')
}

testDrawToolpathLayerSplit()
testDrawToolpathDrawsDescendingRapids()

// Issue #683 Phase 0: interactive and full-detail booklet paths share styling.
function testSolidRapidStyles(): void {
  const toolpath: ToolpathResult = {
    operationId: 'rapid-style-test',
    moves: [
      { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 20, y: 0, z: 0 } },
      { kind: 'lead_in', from: { x: 0, y: 10, z: 0 }, to: { x: 20, y: 10, z: 0 } },
      { kind: 'rapid', from: { x: 0, y: 20, z: 5 }, to: { x: 20, y: 20, z: 5 } },
      { kind: 'plunge', from: { x: 0, y: 30, z: 5 }, to: { x: 20, y: 30, z: 0 } },
      { kind: 'rapid', from: { x: 0, y: 40, z: 0 }, to: { x: 20, y: 40, z: 5 } },
    ],
    warnings: [],
    bounds: null,
  }
  const allOff: ToolpathVisibility = {
    cuts: false, leadIns: false, rapids: false, plunges: false, retractions: false, directions: false,
  }
  const colors = canvasColors()
  const cases = [
    { key: 'cuts', stroke: colors.toolpathCut, width: 2.1, dash: [] },
    { key: 'leadIns', stroke: colors.toolpathCut, width: 2.1, dash: [] },
    { key: 'rapids', stroke: colors.toolpathRapid, width: 1.3, dash: [] },
    { key: 'plunges', stroke: colors.toolpathPlunge, width: 1.5, dash: [3, 4] },
    { key: 'retractions', stroke: colors.toolpathRapid, width: 1.3, dash: [] },
  ] as const
  for (const simplifyForDisplay of [true, false]) {
    for (const emphasized of [true, false]) {
      for (const expected of cases) {
        const { ctx: mockCtx } = recordingContext()
        let dash: number[] = []
        let strokes = 0
        mockCtx.setLineDash = value => { dash = [...value] }
        mockCtx.stroke = () => {
          strokes++
          assert(JSON.stringify(dash) === JSON.stringify(expected.dash), `${expected.key} dash pattern`)
          assert(mockCtx.strokeStyle === expected.stroke, `${expected.key} keeps its colour`)
          const width = emphasized ? expected.width + 0.35 : Math.max(1, expected.width - 0.35)
          assert(mockCtx.lineWidth === width, `${expected.key} keeps its line weight`)
          assert(mockCtx.globalAlpha === (emphasized ? 1 : 0.34), `${expected.key} keeps its emphasis`)
        }
        drawToolpath(mockCtx, toolpath, { scale: 1, offsetX: 0, offsetY: 0 }, emphasized,
          { ...allOff, [expected.key]: true }, 0.4, { simplifyForDisplay })
        assert(strokes === 1, `${expected.key} strokes exactly once when visible`)
        assert(dash.length === 0 && mockCtx.globalAlpha === 1, 'dash and alpha reset after drawing')
        drawToolpath(mockCtx, toolpath, { scale: 1, offsetX: 0, offsetY: 0 }, emphasized,
          allOff, 0.4, { simplifyForDisplay })
        assert(strokes === 1, 'hidden layers do not stroke')
      }
    }
  }
}
testSolidRapidStyles()

function testFullDetailDisplaySkipsInteractiveMerging(): void {
  const toolpath: ToolpathResult = {
    operationId: 'snapshot-detail-test',
    moves: [
      { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 0.25, y: 0, z: 0 } },
      { kind: 'cut', from: { x: 0.25, y: 0, z: 0 }, to: { x: 0.5, y: 0, z: 0 } },
    ],
    warnings: [],
    bounds: null,
  }
  const cutsOnly: ToolpathVisibility = { cuts: true, leadIns: false, rapids: false, plunges: false, retractions: false, directions: false }
  const vt = { scale: 1, offsetX: 0, offsetY: 0 }

  const interactive = recordingContext()
  drawToolpath(interactive.ctx, toolpath, vt, false, cutsOnly)
  const fullDetail = recordingContext()
  drawToolpath(fullDetail.ctx, toolpath, vt, false, cutsOnly, 0.4, { simplifyForDisplay: false })

  assert(interactive.segments.length === 1, 'interactive rendering may coalesce a short connected run')
  assert(fullDetail.segments.length === 2, 'static rendering must preserve every emitted move')
}
testFullDetailDisplaySkipsInteractiveMerging()

function testNavigationSkipsArrowWork(): void {
  const { ctx: mockCtx, segments } = recordingContext()
  let fills = 0
  mockCtx.save = () => undefined
  mockCtx.restore = () => undefined
  mockCtx.closePath = () => undefined
  mockCtx.fill = () => { fills++ }
  const moves: ToolpathResult['moves'] = [
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 30, y: 0, z: 0 }, source: 'contour' },
  ]
  let moveReads = 0
  const toolpath: ToolpathResult = {
    operationId: 'navigation-test',
    get moves() { moveReads++; return moves },
    warnings: [],
    bounds: { minX: 0, minY: 0, minZ: 0, maxX: 30, maxY: 0, maxZ: 0 },
    collidingMoveIndices: [0],
    debugToolpath: true,
  }
  const visibility: ToolpathVisibility = {
    cuts: true, leadIns: true, rapids: true, plunges: true, retractions: true,
    directions: true, feedColours: false,
  }
  const vt = { scale: 1, offsetX: 0, offsetY: 0 }
  toolpathDisplayGeometry(toolpath, vt.scale)
  moveReads = 0
  drawToolpath(mockCtx, toolpath, vt, true, { ...visibility, directions: false })
  assert(moveReads === 0 && fills === 0, 'Directions off skips the placement pass and arrow fills')
  segments.length = 0
  drawToolpath(mockCtx, toolpath, vt, true, visibility, 1, { deferArrows: true })
  assert(moveReads === 0 && fills === 0, 'navigation skips the placement pass and arrow fills')
  assert(segments.filter(s => s.fromX === 0 && s.toX === 30).length === 2, 'cut and collision remain visible during navigation')
  assert(segments.length > 2, 'source-tag debug markers remain visible during navigation')
  drawToolpath(mockCtx, toolpath, vt, true, visibility, 1, { deferArrows: false })
  assert(moveReads > 0 && fills > 0, 'settling calculates and draws arrows again')
  assert(visibility.directions, 'transient suppression never changes the user setting')
}
testNavigationSkipsArrowWork()

console.log('previewPrimitives.test.ts passed')
