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
 * The 2D plasma kerf band and pierce markers (issue #961, slice A).
 *
 * A recording context stands in for the canvas: it captures every stroked
 * path, its `lineWidth`, colour, alpha and the world→canvas mapping, so the
 * band's size, its two colours, each visibility switch and — through the real
 * `renderSketchToolpaths` — the paint order can all be asserted without a
 * browser.
 *
 * Mutations these assertions were checked against:
 * - `lineWidth = width` (not `width * vt.scale`) → the size assertion fails;
 * - the same colour for contour and leads → the colour assertion fails;
 * - `plasmaKerfWidth` drawn without its plasma guard → a milling entry draws;
 * - the band moved after the line renderers / the markers before them → the
 *   paint-order assertion fails.
 *
 * Run with: npx tsx src/components/canvas/plasmaKerfBand.test.ts
 */

import assert from 'node:assert/strict'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { defaultPlasmaTool } from '../../toolPolicy'
import { defaultTool, newProject, type Project } from '../../types/project'
import { PLASMA_KERF_BAND_ALPHA, PLASMA_PIERCE_MARKER_RADIUS_PX } from '../plasmaKerfPreview'
import { DEFAULT_TOOLPATH_VISIBILITY, type ToolpathVisibility } from '../toolpathVisibility'
import { canvasColors } from './canvasPalette'
import { drawPlasmaKerfBands, drawPlasmaPierceMarkers, type PlasmaKerfEntry } from './plasmaKerfBand'
import { renderSketchToolpaths } from './renderSketchToolpaths'
import { toolpathStrokeAlpha } from './toolpathStyles'
import { worldToCanvas, type ViewTransform } from './viewTransform'

const BAND_WIDTH = 2
const PLASMA_OPERATION_ID = 'op1'
const MILLING_OPERATION_ID = 'op2'

function bandProject(): Project {
  const project = newProject('Band fixture', 'mm')
  project.tools = [
    { ...defaultPlasmaTool('mm'), id: 'torch', name: 'Torch', diameter: BAND_WIDTH },
    defaultTool('mm'),
  ]
  const plasma = defaultOperationForTarget(project, 'plasma_profile', 'rough', { source: 'features', featureIds: [] }, 0)
  const milling = defaultOperationForTarget(project, 'pocket', 'rough', { source: 'features', featureIds: [] }, 1)
  assert.equal(plasma.id, PLASMA_OPERATION_ID, 'the plasma operation keeps its fixture id')
  assert.equal(milling.id, MILLING_OPERATION_ID, 'the milling operation keeps its fixture id')
  return { ...project, operations: [plasma, milling] }
}

const PLASMA_TOOLPATH: ToolpathResult = {
  operationId: PLASMA_OPERATION_ID,
  moves: [
    { kind: 'plunge', from: { x: 50, y: 30, z: 10 }, to: { x: 50, y: 30, z: 7.5 } },
    { kind: 'lead_in', from: { x: 50, y: 30, z: 7.5 }, to: { x: 50, y: 19, z: 7.5 } },
    { kind: 'cut', from: { x: 50, y: 19, z: 7.5 }, to: { x: 60, y: 19, z: 7.5 } },
    { kind: 'lead_out', from: { x: 60, y: 19, z: 7.5 }, to: { x: 60, y: 30, z: 7.5 } },
  ],
  warnings: [],
  bounds: null,
}

const MILLING_TOOLPATH: ToolpathResult = {
  operationId: MILLING_OPERATION_ID,
  moves: [
    { kind: 'plunge', from: { x: 10, y: 10, z: 2 }, to: { x: 10, y: 10, z: 0 } },
    { kind: 'cut', from: { x: 10, y: 10, z: 0 }, to: { x: 20, y: 10, z: 0 } },
  ],
  warnings: [],
  bounds: null,
}

const PLASMA_ENTRY: PlasmaKerfEntry = { toolpath: PLASMA_TOOLPATH, emphasized: false, muted: false }
const MILLING_ENTRY: PlasmaKerfEntry = { toolpath: MILLING_TOOLPATH, emphasized: false, muted: false }

interface RecordedStroke {
  type: 'stroke'
  lineWidth: number
  strokeStyle: string
  alpha: number
  points: Array<{ x: number; y: number }>
}
interface RecordedArc { type: 'arc'; x: number; y: number; radius: number }
interface RecordedFill { type: 'fill' }
type RecordedEvent = RecordedStroke | RecordedArc | RecordedFill

function recordingContext() {
  const events: RecordedEvent[] = []
  let path: Array<{ x: number; y: number }> = []
  let lineWidth = 0
  let globalAlpha = 1
  let strokeStyle = ''
  const ctx = {
    canvas: { width: 200, height: 200 },
    save: () => undefined,
    restore: () => { lineWidth = 0; globalAlpha = 1; strokeStyle = '' },
    beginPath: () => { path = [] },
    closePath: () => undefined,
    moveTo: (x: number, y: number) => { path.push({ x, y }) },
    lineTo: (x: number, y: number) => { path.push({ x, y }) },
    arc: (x: number, y: number, radius: number) => { events.push({ type: 'arc', x, y, radius }) },
    stroke: () => { events.push({ type: 'stroke', lineWidth, strokeStyle, alpha: globalAlpha, points: [...path] }) },
    fill: () => { events.push({ type: 'fill' }) },
    setLineDash: () => undefined,
    get lineWidth() { return lineWidth },
    set lineWidth(value: number) { lineWidth = value },
    get globalAlpha() { return globalAlpha },
    set globalAlpha(value: number) { globalAlpha = value },
    get strokeStyle() { return strokeStyle },
    set strokeStyle(value: string) { strokeStyle = value },
    fillStyle: '',
    lineCap: 'butt',
    lineJoin: 'miter',
  }
  return { ctx: ctx as unknown as CanvasRenderingContext2D, events }
}

function strokesOf(events: readonly RecordedEvent[]): RecordedStroke[] {
  return events.filter((event): event is RecordedStroke => event.type === 'stroke')
}

// ── Size, colours and the world→canvas mapping ───────────────────────────

{
  const project = bandProject()
  const vt: ViewTransform = { scale: 7, offsetX: 3, offsetY: 5 }
  const { ctx, events } = recordingContext()
  drawPlasmaKerfBands(ctx, project, [PLASMA_ENTRY], vt, DEFAULT_TOOLPATH_VISIBILITY)

  const strokes = strokesOf(events)
  assert.equal(strokes.length, 2, 'one path per colour: a contour band and a lead band')
  const contour = strokes[0]
  const leads = strokes[1]
  assert.equal(contour.lineWidth, BAND_WIDTH * vt.scale, `the contour band is one kerf wide on screen (got ${contour.lineWidth})`)
  assert.equal(leads.lineWidth, BAND_WIDTH * vt.scale, 'the lead band is one kerf wide on screen too')
  assert.equal(contour.strokeStyle, canvasColors().toolpathCut, 'the contour band is in the cut colour')
  assert.equal(leads.strokeStyle, canvasColors().toolpathPlunge, 'the lead band is in the plunge colour')
  assert.notEqual(contour.strokeStyle, leads.strokeStyle, 'contour and lead colours differ')
  const expectedAlpha = toolpathStrokeAlpha(false, false) * PLASMA_KERF_BAND_ALPHA
  assert.equal(contour.alpha, expectedAlpha, 'the band is translucent at the band alpha')
  assert.equal(leads.alpha, expectedAlpha, 'both parts share the band alpha')

  // Points are mapped per point through `worldToCanvas`; the context is never
  // transformed, so the coordinates here are canvas pixels.
  const canvasPoint = (point: { x: number; y: number }): { x: number; y: number } => {
    const mapped = worldToCanvas(point, vt)
    return { x: mapped.cx, y: mapped.cy }
  }
  assert.deepEqual(
    contour.points,
    [canvasPoint({ x: 50, y: 19 }), canvasPoint({ x: 60, y: 19 })],
    'the contour band follows the cut move through worldToCanvas',
  )
  assert.deepEqual(
    leads.points,
    [canvasPoint({ x: 50, y: 30 }), canvasPoint({ x: 50, y: 19 }), canvasPoint({ x: 60, y: 19 }), canvasPoint({ x: 60, y: 30 })],
    'the two lead moves share one path, in move order',
  )

  // Selected and muted entries keep the ordinary strengths the lines use.
  const selected = recordingContext()
  drawPlasmaKerfBands(selected.ctx, project, [{ ...PLASMA_ENTRY, emphasized: true }], vt, DEFAULT_TOOLPATH_VISIBILITY)
  assert.equal(strokesOf(selected.events)[0].alpha, toolpathStrokeAlpha(true) * PLASMA_KERF_BAND_ALPHA, 'a selected entry draws at full strength')
  const muted = recordingContext()
  drawPlasmaKerfBands(muted.ctx, project, [{ ...PLASMA_ENTRY, muted: true }], vt, DEFAULT_TOOLPATH_VISIBILITY)
  assert.equal(strokesOf(muted.events)[0].alpha, toolpathStrokeAlpha(false, true) * PLASMA_KERF_BAND_ALPHA, 'a muted entry draws faint')
}

// ── Each visibility switch removes exactly its own part ──────────────────

{
  const project = bandProject()
  const vt: ViewTransform = { scale: 7, offsetX: 3, offsetY: 5 }
  const cases: Array<{ visibility: ToolpathVisibility; colours: string[]; message: string }> = [
    {
      visibility: { ...DEFAULT_TOOLPATH_VISIBILITY, cuts: false },
      colours: [canvasColors().toolpathPlunge],
      message: 'Cuts off removes the contour band and leaves the leads',
    },
    {
      visibility: { ...DEFAULT_TOOLPATH_VISIBILITY, leadIns: false },
      colours: [canvasColors().toolpathCut],
      message: 'Lead-ins off removes the lead band and leaves the contour',
    },
  ]
  for (const testCase of cases) {
    const { ctx, events } = recordingContext()
    drawPlasmaKerfBands(ctx, project, [PLASMA_ENTRY], vt, testCase.visibility)
    const strokes = strokesOf(events)
    assert.deepEqual(strokes.map((stroke) => stroke.strokeStyle), testCase.colours, testCase.message)
  }

  // All three switches off: the band draws nothing.
  const allOff = recordingContext()
  const hidden: ToolpathVisibility = { ...DEFAULT_TOOLPATH_VISIBILITY, cuts: false, leadIns: false, plunges: false }
  drawPlasmaKerfBands(allOff.ctx, project, [PLASMA_ENTRY], vt, hidden)
  drawPlasmaPierceMarkers(allOff.ctx, project, [PLASMA_ENTRY], vt, hidden)
  assert.equal(allOff.events.length, 0, 'every switch off leaves the entry undrawn')
}

// ── Pierce markers: fixed screen size, plunges-gated ─────────────────────

{
  const project = bandProject()
  const vt: ViewTransform = { scale: 7, offsetX: 3, offsetY: 5 }
  const { ctx, events } = recordingContext()
  drawPlasmaPierceMarkers(ctx, project, [PLASMA_ENTRY], vt, DEFAULT_TOOLPATH_VISIBILITY)
  const arcs = events.filter((event): event is RecordedArc => event.type === 'arc')
  assert.equal(arcs.length, 2, 'one pierce draws a ring and a centre dot')
  assert.equal(arcs[0].radius, PLASMA_PIERCE_MARKER_RADIUS_PX, 'the ring is the fixed marker radius in pixels')
  assert.equal(arcs[1].radius, 1.5, 'the centre dot is 1.5 px')
  const expected = worldToCanvas({ x: 50, y: 30 }, vt)
  assert.ok(Math.abs(arcs[0].x - expected.cx) < 1e-9 && Math.abs(arcs[0].y - expected.cy) < 1e-9, 'the marker sits on the pierce')
  assert.ok(events.some((event) => event.type === 'fill'), 'the centre dot is filled')

  // The same pierce at a different zoom keeps its pixel size.
  const zoomed = recordingContext()
  drawPlasmaPierceMarkers(zoomed.ctx, project, [PLASMA_ENTRY], { scale: 40, offsetX: 0, offsetY: 0 }, DEFAULT_TOOLPATH_VISIBILITY)
  const zoomedArcs = zoomed.events.filter((event): event is RecordedArc => event.type === 'arc')
  assert.equal(zoomedArcs[0].radius, PLASMA_PIERCE_MARKER_RADIUS_PX, 'the marker never scales with zoom')

  const plungesOff = recordingContext()
  drawPlasmaPierceMarkers(plungesOff.ctx, project, [PLASMA_ENTRY], vt, { ...DEFAULT_TOOLPATH_VISIBILITY, plunges: false })
  assert.equal(plungesOff.events.length, 0, 'Plunges off removes the markers and nothing else')
}

// ── A non-plasma entry draws nothing ─────────────────────────────────────

{
  const project = bandProject()
  const vt: ViewTransform = { scale: 7, offsetX: 3, offsetY: 5 }
  const { ctx, events } = recordingContext()
  drawPlasmaKerfBands(ctx, project, [MILLING_ENTRY], vt, DEFAULT_TOOLPATH_VISIBILITY)
  drawPlasmaPierceMarkers(ctx, project, [MILLING_ENTRY], vt, DEFAULT_TOOLPATH_VISIBILITY)
  assert.equal(events.length, 0, 'a milling entry draws no band and no pierce')
}

// ── Paint order through renderSketchToolpaths ────────────────────────────

{
  const project = bandProject()
  const vt: ViewTransform = { scale: 2, offsetX: 10, offsetY: 10 }
  const { ctx, events } = recordingContext()
  renderSketchToolpaths(null, ctx, project, [PLASMA_TOOLPATH], null, null, vt, DEFAULT_TOOLPATH_VISIBILITY, false)

  const strokes = strokesOf(events)
  const bandWidth = BAND_WIDTH * vt.scale
  const arcs = events.map((event, index) => ({ event, index })).filter(({ event }) => event.type === 'arc')
  assert.equal(arcs.length, 2, 'the pierce is drawn once')
  const firstArc = arcs[0].index

  const bandIndices = strokes.map((stroke, index) => ({ stroke, index })).filter(({ stroke }) => stroke.lineWidth === bandWidth)
  assert.equal(bandIndices.length, 2, 'both band paths are stroked')
  const lineIndices = strokes
    .map((stroke, index) => ({ stroke, index }))
    .filter(({ stroke, index }) => stroke.lineWidth !== bandWidth && index < firstArc)
  assert.ok(lineIndices.length > 0, 'the ordinary line renderer strokes the toolpath')
  const firstBand = Math.min(...bandIndices.map(({ index }) => index))
  const firstLine = Math.min(...lineIndices.map(({ index }) => index))
  const lastLine = Math.max(...lineIndices.map(({ index }) => index))
  assert.ok(firstBand < firstLine, 'the band is painted beneath the centre line')
  assert.ok(arcs.every(({ index }) => index > lastLine), 'the pierce markers are painted above the centre line')
}

console.log('plasmaKerfBand tests passed')
