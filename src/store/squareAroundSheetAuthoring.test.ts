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
 * A square blank's Around sheet authors a region and a construction line
 * (issue #1112 decision 17, Frank's test round 2 slice rt2-c).
 *
 * #1016 C2-U1 made the sheet round-only for *every* hand-drawn row, which also
 * swept up the two rows that never cut it: a region is a filter on a rotary
 * operation (#1096) and construction geometry is never machined. Decision 17
 * keeps the refusal for the rows that would be cut and admits those two, so the
 * drawer's "region" and "construction" targets are not dead controls. Everything
 * that cuts — a feature, a line, a text run, an imported outline — is refused
 * exactly as before, and the exported program of a project without such a row is
 * untouched.
 *
 * The last block is decision 17's own check: a region drawn on the square
 * blank's Around sheet limits a rotary rough and finish the same way one drawn
 * on a round bar does.
 *
 * Mutations checked one at a time against these assertions:
 *  - the operation test dropped from the authoring guard (regions and
 *    construction refused again) → the "region/construction is authored"
 *    assertions fail;
 *  - the guard ignoring the operation (every row admitted) → the feature and
 *    line refusals fail;
 *  - the creation-target guard ignoring the target (arming refused whatever the
 *    target) → the "arming a region/construction rectangle" assertion fails;
 *  - the target's regions dropped from the operation's mask (`buildRegionMask`
 *    in `rotaryOperation.ts`) → the "every cut is inside the region" and "the
 *    region changes the motion" assertions fail.
 *
 * Run with: npx tsx src/store/squareAroundSheetAuthoring.test.ts
 */

import assert from 'node:assert/strict'
import { barCentre, isBarStock, isSquareStock, squareStock } from '../types/barStock'
import type { BarStock, FeatureInstance, Project, SketchFeature } from '../types/project'
import type { RotaryBarGeometry } from '../types/barStock'
import { defaultRoundWorkholding } from './helpers/roundWorkholding'
import { useProjectStore } from './projectStore'
import { resolvedProjectFeatures } from './helpers/resolveFeatures'
import { rotaryOperationFixture } from '../test/rotaryOperationFixture'
import { computeOperationToolpath } from '../engine/toolpaths/generateOperation'
import { rotaryTravelZ } from '../engine/toolpaths/squareRotaryStock'
import type { ToolpathMove, ToolpathResult } from '../engine/toolpaths/types'

const store = () => useProjectStore.getState()

/** The fixture's round bar relabelled to a square blank of the same box (#1096's own fixture). */
function squareBlank(kind: 'rotary_rough' | 'rotary_finish'): Project {
  const project = rotaryOperationFixture('x', kind)
  if (!isBarStock(project.stock)) throw new Error('the fixture ships a bar')
  const stock = squareStock(project.stock.thickness, 30, 'x', { x: 0, y: 0 })
  const chuck = { ...defaultRoundWorkholding('chuck', stock, 'mm'), id: 'chuck', name: 'Chuck', visible: true }
  return { ...project, stock, clamps: [chuck] }
}

/** The same fixture left on its round bar. */
function roundBar(kind: 'rotary_rough' | 'rotary_finish'): Project {
  return rotaryOperationFixture('x', kind)
}

/** The rectangle a region is drawn as, on the unrolled sheet: along the bar, across it. */
const SHEET_RECT = { alongMin: 8, alongMax: 18, acrossMin: 0, acrossMax: 10 } as const

function acrossOf(stock: RotaryBarGeometry, angleDeg: number): number {
  return barCentre(stock) + angleDeg * Math.PI * stock.thickness / 360
}

/** Is a tool position inside the sheet rectangle, on any turn of the sheet? */
function insideSheetRect(stock: RotaryBarGeometry, along: number, angle: number): boolean {
  if (along < SHEET_RECT.alongMin - 1e-9 || along > SHEET_RECT.alongMax + 1e-9) return false
  const circumference = Math.PI * stock.thickness
  const across = acrossOf(stock, angle)
  for (let turn = -1; turn <= 1; turn++) {
    const shifted = across + turn * circumference
    if (shifted >= SHEET_RECT.acrossMin - 1e-9 && shifted <= SHEET_RECT.acrossMax + 1e-9) return true
  }
  return false
}

function alongOf(stock: BarStock, point: { x: number; y: number }): number {
  return stock.axis === 'x' ? point.x : point.y
}

/** Moves that cut: everything but a rapid and everything already at travel height. */
function cuttingMoves(result: ToolpathResult, travelZ: number): ToolpathMove[] {
  return result.moves.filter((move) => move.kind !== 'rapid'
    && Math.min(move.from.z, move.to.z) < travelZ - 1e-9)
}

/**
 * Arm the rectangle tool for `target` and draw it through the real store,
 * returning the row it created (null when arming was refused). The tool
 * re-arms after a successful rectangle, so the pending state is cleared first
 * and the created row — not the pending clear — is what the assertions read.
 */
function drawRectangle(target: 'feature' | 'line' | 'region' | 'construction'): FeatureInstance | null {
  useProjectStore.setState({ pendingAdd: null })
  useProjectStore.getState().setCreationTarget(target)
  store().startAddRectPlacement()
  if (!store().pendingAdd) return null
  const before = new Set(store().project.features.map((feature) => feature.id))
  store().setPendingAddAnchor({ x: SHEET_RECT.alongMin, y: SHEET_RECT.acrossMin })
  store().placePendingAddAt({ x: SHEET_RECT.alongMax, y: SHEET_RECT.acrossMax })
  return store().project.features.find((feature) => !before.has(feature.id)) ?? null
}

/** A stored row's derived view, where the operation lives (format 3.3 keeps it on the definition). */
function resolve(id: string): SketchFeature {
  const feature = resolvedProjectFeatures(store().project).find((entry) => entry.id === id)
  assert.ok(feature, `${id} resolves`)
  return feature
}

/** Put `project` on the workspace with its Around setup active. */
function open(project: Project): void {
  store().loadProject(project)
}

// ── 1. A square blank's Around sheet takes a region and a construction line ──

for (const shape of ['square', 'round'] as const) {
  open(shape === 'square' ? squareBlank('rotary_rough') : roundBar('rotary_rough'))

  const region = drawRectangle('region')
  assert.ok(region, `${shape}: a region is authored on the Around sheet`)
  assert.equal(resolve(region.id).operation, 'region', `${shape}: the row is a region`)
  assert.equal(region.authoringFace, 'around', `${shape}: authored on the Around face`)

  const construction = drawRectangle('construction')
  assert.ok(construction, `${shape}: a construction line is authored on the Around sheet`)
  assert.equal(resolve(construction.id).operation, 'construction', `${shape}: the row is construction geometry`)
  assert.equal(construction.authoringFace, 'around', `${shape}: authored on the Around face`)

  assert.equal(
    resolvedProjectFeatures(store().project).filter((feature) => feature.operation === 'region').length,
    1,
    `${shape}: exactly one region row`,
  )
}

// ── 2. Everything that would cut the sheet is still refused ──────────────────

open(squareBlank('rotary_rough'))
const before = store().project
const aroundRows = before.features.filter((feature) => feature.authoringFace === 'around').length
for (const target of ['feature', 'line'] as const) {
  useProjectStore.setState({ pendingAdd: null })
  useProjectStore.getState().setCreationTarget(target)
  store().startAddRectPlacement()
  assert.equal(store().pendingAdd, null, `arming a ${target} rectangle is still refused on the square blank`)
  assert.equal(store().project, before, `and it changes no project state`)
  assert.equal(drawRectangle(target), null, `a ${target} rectangle creates no row`)
}
// A direct row of a cutting operation is refused by the same guard, before any
// id, tree, history or selection work.
const directBefore = store().project
store().addRectFeature('Around rect', SHEET_RECT.alongMin, SHEET_RECT.acrossMin, 10, 10, 2)
assert.equal(store().project, directBefore, 'a cutting row is still refused on the square blank')
assert.equal(store().project.features.filter((feature) => feature.authoringFace === 'around').length, aroundRows,
  'and nothing landed on the Around face')

// ── 3. A region drawn there limits a rotary operation, as on a round bar ─────

for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
  for (const shape of ['square', 'round'] as const) {
    const label = `${shape}/${kind}`
    open(shape === 'square' ? squareBlank(kind) : roundBar(kind))
    const region = drawRectangle('region')
    assert.ok(region, `${label}: the region is drawn on the Around sheet`)
    assert.ok(resolve(region.id).sketch.profile.closed, `${label}: and it is a closed outline, so it can be a mask`)

    const stock = store().project.stock
    if (!isBarStock(stock)) throw new Error(`${label}: the fixture kept a bar`)
    assert.equal(isSquareStock(stock), shape === 'square', `${label}: the fixture kept its blank shape`)
    const travelZ = rotaryTravelZ(stock, 'mm')
    const operation = store().project.operations[0]
    assert.ok(operation, `${label}: the fixture ships a rotary operation`)

    // The drawn region joins the operation's target as the mask, exactly the way
    // a selected region does (#1096); no other CAM state changes.
    const limited = computeOperationToolpath(store().project, {
      ...operation,
      rotaryPassDirection: 'along',
      target: { source: 'features', featureIds: ['model', region.id] },
    })!.result
    const free = computeOperationToolpath(store().project, {
      ...operation,
      rotaryPassDirection: 'along',
      target: { source: 'features', featureIds: ['model'] },
    })!.result

    const cuts = cuttingMoves(limited, travelZ)
    assert.ok(cuts.length > 0, `${label}: the region still cuts inside itself`)
    for (const move of cuts) {
      for (const point of [move.from, move.to]) {
        assert.ok(insideSheetRect(stock, alongOf(stock, point), point.a ?? 0),
          `${label}: a cut at along ${alongOf(stock, point).toFixed(3)} A${(point.a ?? 0).toFixed(3)} `
          + 'is outside the region drawn on the sheet')
      }
    }
    // Control: without the region the same operation cuts outside it, so the
    // assertions above are not vacuous.
    const freeCuts = cuttingMoves(free, travelZ)
    assert.ok(freeCuts.some((move) => [move.from, move.to].some((point) =>
      !insideSheetRect(stock, alongOf(stock, point), point.a ?? 0))),
    `${label}: the region-free program cuts outside the region (the check is live)`)
    assert.notDeepEqual(cuts, freeCuts, `${label}: the drawn region changes the emitted motion`)

    // Round → square→ round keeps the row and its mask: converting the blank
    // does not delete or re-target anything (decision 5).
    store().setStockShape('square')
    assert.ok(store().project.features.some((feature) => feature.id === region.id),
      `${label}: the region survives a blank-shape change`)
    assert.equal(resolve(region.id).operation, 'region', `${label}: still a region`)
  }
}

console.log('squareAroundSheetAuthoring: region and construction authoring on a square blank passed')
