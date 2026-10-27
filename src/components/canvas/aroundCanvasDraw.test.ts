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
import { resolvedProjectFeatures } from '../../store/helpers/resolveFeatures'
import { canvasColors, hexToRgba } from './canvasPalette'
import { drawAroundModelBands } from './scenePrimitives'

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
  const strokes: { stroke: string; fill: string; width: number }[] = []
  const ctx = {
    canvas: { width: 800, height: 600 }, strokeStyle: '', fillStyle: '', lineWidth: 0,
    save() {}, restore() {}, setLineDash() {}, fillRect() {}, fillText() {},
    measureText: () => ({ width: 10 }),
    strokeRect() { strokes.push({ stroke: this.strokeStyle, fill: this.fillStyle, width: this.lineWidth }) },
  } as unknown as CanvasRenderingContext2D
  const dependencies = {
    ctx, sheet, features, project: f.project, selection: f.selection,
    vt: { scale: 1, offsetX: 0, offsetY: 100 },
    t: (_key: string, values: { name: string }) => values.name,
    drawAroundModelBands, hiddenDistributionSourceIds: null, operationHighlightIds: null,
    drawOtherFace: () => new Set(), useFaceViewStore: { getState: () => ({ showOtherSide: false }) },
    drawOriginMarker() {}, activeOriginInStock() {}, canvasPalette: canvasColors(),
    drawFeature: (_ctx: unknown, feature: { id: string }) => flatDraws.push(feature.id),
    drawLineFeatureBatch() {}, stlImageCacheRef: { current: new Map() },
  }
  const draw = new Function(...Object.keys(dependencies), script) as (...args: unknown[]) => void
  const run = () => { strokes.length = 0; flatDraws.length = 0; draw(...Object.values(dependencies)); return [...strokes] }
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
  dependencies.sheet = null as unknown as typeof sheet
  run()
  assert.deepEqual(flatDraws, ['first', 'second'], 'Top still draws model silhouettes')
}
console.log('aroundCanvasDraw: hover, selection and silhouette probes passed')
