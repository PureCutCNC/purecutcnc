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

/// <reference types="node" />
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { aroundSelectionFixture } from './aroundSelection.testSupport'
import { aroundSheet } from './aroundSheet'
import { resolvedProjectFeatures, type ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { canvasColors, canvasRgba } from './canvasPalette'
import { hexToRgba } from './previewPrimitives'
import { drawAroundModelBands } from './scenePrimitives'
import { featureDisplayProfiles } from './aroundFeatureDisplay'
import { traceProfilePath } from './profilePrimitives'
import { cannedShapeFrame } from '../../cannedShapes'
import { rotaryPatternCannedData, rotaryPatternFrame } from '../../store/helpers/rotaryPatterns'

// Execute the live band's drawing and the SketchCanvas feature pass, with only
// unrelated layers stubbed. This catches lost state at the call site as well
// as an inert renderer; a helper-only test cannot establish either contract.
const source = readFileSync(new URL('./SketchCanvas.tsx', import.meta.url), 'utf8')
const start = source.indexOf('    if (sheet) drawAroundModelBands(')
const end = source.indexOf('    const clipboardPlacement =', start)
assert(start > 0 && end > start, 'live canvas feature draw pass is present')
const script = ts.transpileModule(source.slice(start, end), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText

for (const axis of ['x', 'y'] as const) {
  const f = aroundSelectionFixture(axis)
  const sheet = aroundSheet(f.project)!
  const features = resolvedProjectFeatures(f.project)
  const flatDraws: string[] = []
  let sideViewDrawn = new Set<string>()
  const strokes: { stroke: string; fill: string; width: number }[] = []
  // Paths are captured separately: the armed-operation ring is the only code in
  // this pass that strokes a beginPath outline (the model bands use strokeRect).
  const paths: { points: { x: number; y: number }[]; stroke: string; width: number }[] = []
  let pathPoints: { x: number; y: number }[] = []
  const ctx = {
    canvas: { width: 800, height: 600 }, strokeStyle: '', fillStyle: '', lineWidth: 0,
    save() {}, restore() {}, setLineDash() {}, fillRect() {}, fillText() {},
    measureText: () => ({ width: 10 }),
    beginPath() { pathPoints = [] },
    closePath() {},
    moveTo(x: number, y: number) { pathPoints.push({ x, y }) },
    lineTo(x: number, y: number) { pathPoints.push({ x, y }) },
    stroke(this: { strokeStyle: unknown; lineWidth: number }) {
      paths.push({ points: [...pathPoints], stroke: String(this.strokeStyle), width: this.lineWidth })
    },
    strokeRect(this: CanvasRenderingContext2D) { strokes.push({ stroke: String(this.strokeStyle), fill: String(this.fillStyle), width: this.lineWidth }) },
  } as unknown as CanvasRenderingContext2D
  const dependencies = {
    ctx, sheet, features, project: f.project, selection: f.selection,
    vt: { scale: 1, offsetX: 0, offsetY: 100 },
    // The pass publishes what it drew of the Edit-ellipse handles for the
    // browser specs (issue #1112 rt7-g review); the canvas is its target.
    canvas: { dataset: {} as Record<string, string> } as unknown as HTMLCanvasElement,
    CANVAS_TEST_SEAMS: true,
    t: (key: string, values?: { name?: string }) => values?.name ?? key,
    drawAroundModelBands, hiddenDistributionSourceIds: null, operationHighlightIds: null as Set<string> | null,
    drawOtherFace: () => new Set(), useFaceViewStore: { getState: () => ({ showOtherSide: false }) },
    drawRotarySolidSideViews: () => sideViewDrawn,
    drawOriginMarker() {}, activeOriginInStock() {}, canvasPalette: canvasColors(),
    drawFeature: (_ctx: unknown, feature: { id: string }) => flatDraws.push(feature.id),
    drawLineFeatureBatch() {}, stlImageCacheRef: { current: new Map() },
    // A canned ellipse draws radius handles in the same pass, only while its
    // Edit panel is open (issue #1112 rt7-g). Neither shape in this fixture is
    // an ellipse, so the pass draws no handles.
    cannedRadius: { dragRef: { current: null }, hoveredAxisRef: { current: null }, handleParams: () => null },
    featureDisplayProfiles, traceProfilePath, canvasRgba,
  }
  const draw = new Function(...Object.keys(dependencies), script) as (...args: unknown[]) => void
  const run = () => { strokes.length = 0; flatDraws.length = 0; paths.length = 0; draw(...Object.values(dependencies)); return [...strokes] }
  const idle = run()
  assert.equal(idle.length, 2, `${axis}: both model bands drawn`)
  assert.deepEqual(flatDraws, [], `${axis}: Around draws no model flat silhouettes`)
  f.selection.hoveredFeatureId = 'first'
  const hover = run()
  assert.equal(hover[0].stroke, canvasColors().draft, `${axis}: Cuts hover reaches the model band`)
  assert.equal(hover[0].fill, hexToRgba(canvasColors().draft, 0.35))
  assert.deepEqual(hover[1], idle[1], 'other band stays quiet')
  f.selection.selectedFeatureIds = ['first']
  const selected = run()
  assert.equal(selected[0].stroke, canvasColors().active, 'selection takes precedence over hover')
  assert.equal(selected[0].fill, hexToRgba(canvasColors().active, 0.45))
  assert.equal(selected[0].width, 2.5)
  // Selection alone must highlight, and flat views retain their model drawings.
  f.selection.hoveredFeatureId = null
  assert.deepEqual(run()[0], selected[0])
  // A multi-turn canned thread armed from the CAM Add menu must ring the folded
  // stripes the sheet draws, not its stored placement frame, which would run
  // past the seam (issue #1112 L2).
  {
    const frame = rotaryPatternFrame(f.project)
    assert(frame, `${axis}: the thread fixture has a rotary frame`)
    const canned = rotaryPatternCannedData(frame, {
      kind: 'thread', start: 0, length: 200, pitch: 10, starts: 1, depth: 1, hand: 'right',
    })
    assert(canned, `${axis}: the thread fixture builds`)
    const stored = cannedShapeFrame(canned)
    assert(stored, `${axis}: the thread has a stored placement frame`)
    const base = features[0]!
    const thread: ResolvedSketchFeature = {
      ...base,
      id: 'thread',
      name: 'Thread',
      kind: 'composite',
      stl: null,
      text: null,
      canned,
      operation: 'line',
      sketch: { ...base.sketch, profile: stored },
    }
    dependencies.features = [...features, thread]
    dependencies.operationHighlightIds = new Set(['thread'])
    run()
    const expected = featureDisplayProfiles(thread, sheet).length
    assert(expected > 1, `${axis}: the 20-turn thread folds into stripes (${expected})`)
    assert.equal(paths.length, expected, `${axis}: the armed ring draws one path per folded stripe`)
    const acrossCanvas = (point: { x: number; y: number }) => (sheet.axis === 'x'
      ? point.y - dependencies.vt.offsetY
      : point.x - dependencies.vt.offsetX)
    for (const path of paths) {
      assert.equal(path.width, 3, `${axis}: the armed ring keeps its width`)
      for (const point of path.points) {
        const across = acrossCanvas(point)
        assert(
          across >= sheet.sheetStart - 1e-6 && across <= sheet.sheetStart + sheet.circumference + 1e-6,
          `${axis}: every armed stripe stays inside the sheet (${across})`,
        )
      }
    }
    // The stored frame is what the old code stroked; prove it really would run
    // off the sheet, so the containment check above bites.
    const storedAcross = [stored.start, ...stored.segments.map((segment) => segment.to)]
      .map((point) => (sheet.axis === 'x' ? point.y : point.x))
    assert(
      storedAcross.some((across) => across < sheet.sheetStart || across > sheet.sheetStart + sheet.circumference),
      `${axis}: the stored placement frame runs past the sheet`,
    )
    dependencies.features = features
    dependencies.operationHighlightIds = null
  }
  dependencies.sheet = null as unknown as typeof sheet
  run()
  assert.deepEqual(flatDraws, ['first', 'second'], 'Top still draws model silhouettes')
  // A Turn or Polygon on Top is drawn by the side-view pass instead, so the
  // editable pass must leave it out (#1112 rt2-d).
  sideViewDrawn = new Set(['first'])
  run()
  assert.deepEqual(flatDraws, ['second'], 'a solid drawn as a side view is not drawn flat as well')
  sideViewDrawn = new Set<string>()
}
console.log('aroundCanvasDraw: hover, selection and silhouette probes passed')
