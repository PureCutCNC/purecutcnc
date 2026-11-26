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
 * #1237: the continuous helix is an operation setting, and its exact rows are
 * priced by the stretch of the bar they read.
 *
 * - An exact read wanted at a stretch of poses turns only the facets that
 *   stretch reaches, reports that count as its raster work, and the helix's
 *   price ({@link rotaryExactStretchWork}) is the same count -- below the
 *   whole-angle price that refused every band of a round-bar ball rough.
 * - The read's values are the whole row's at those poses.
 * - A round-bar ball rough around the bar cuts a helix with the setting on, and
 *   none at all with it off (the default).
 *
 * The whole-angle price only refused bands on a mesh with ~171 k candidates per
 * angle (Frank's busto); a turned fixture has a few thousand, so the budget
 * itself is measured on the busto, not here. What this file pins is that the
 * price and the read count the same facets, so the two cannot drift apart.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryHelixOption.test.ts
 */

import assert from 'node:assert/strict'
import { barMaxRadius, barPivotZ } from '../../types/barStock'
import { roundStock } from '../../types/project'
import type { BarStock } from '../../types/project'
import { generateRotaryRough } from './rotaryModel'
import {
  createRotarySamplingPrep,
  rotaryAngleRowWork,
  rotaryExactStretchWork,
  sampleAnglesWithPrep,
} from './rotarySampling'
import type { RotaryModelMesh } from './rotarySampling'
import type { NormalizedTool } from './types'

const BALL: NormalizedTool = {
  id: 'b2', name: '2 mm ball', sourceUnits: 'mm', units: 'mm', type: 'ball_endmill',
  diameter: 2, radius: 1, vBitAngle: null, flutes: 2, material: 'carbide',
  defaultRpm: 0, defaultFeed: 0, defaultPlungeFeed: 0, defaultStepdown: 0,
  defaultStepover: 0, maxCutDepth: 0,
}

// A 30 mm bar, 44 mm long: the 40 mm vase (radius 6..12) stands inside it.
const STOCK = roundStock(30, 44, 'x')

/** A turned profile in many sections along the bar, so a stretch drops facets. */
function vase(stock: BarStock, sections = 41, sides = 48): RotaryModelMesh {
  const centre = stock.thickness / 2
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (let k = 0; k < sections; k++) {
    const along = (40 * k) / (sections - 1)
    const radius = 9 + 3 * Math.sin(along / 6)
    for (let j = 0; j < sides; j++) {
      const t = 2 * Math.PI * j / sides
      positions.push(along, centre + radius * Math.cos(t), pivot + radius * Math.sin(t))
    }
  }
  for (let k = 0; k + 1 < sections; k++) {
    for (let j = 0; j < sides; j++) {
      const next = (j + 1) % sides
      const a = k * sides + j
      const b = k * sides + next
      index.push(a, b, b + sides, a, b + sides, a + sides)
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

function testStretchPriceIsTheReadsWork(): void {
  const mesh = vase(STOCK)
  const along = [10, 10.5, 11, 11.5, 12]
  const prep = createRotarySamplingPrep(mesh, STOCK, BALL, {
    along, requestedCellSize: 0.25, conservativeCellBounds: true, exactTipRows: true,
  })
  const wholePrep = createRotarySamplingPrep(mesh, STOCK, BALL, {
    along: Array.from({ length: 81 }, (_, i) => i / 2),
    requestedCellSize: 0.25, conservativeCellBounds: true, exactTipRows: true,
  })
  const columns = along.map((_, i) => i)
  for (const angle of [0, 37.5, 200]) {
    const warnings: never[] = []
    const stretch = sampleAnglesWithPrep(prep, [angle], warnings, {}, [columns])
    const whole = sampleAnglesWithPrep(prep, [angle], warnings)
    assert.ok(stretch.valid && whole.valid)
    const price = rotaryExactStretchWork(prep, angle, along, BALL.radius)
    assert.equal(stretch.rasterWork, price, `A${angle}: the price is the facets the read turned`)
    const full = rotaryAngleRowWork(prep, angle, false)
    assert.ok(price > 0 && price < full / 3, `A${angle}: the stretch (${price}) is a fraction of the angle (${full})`)
    assert.equal(whole.rasterWork, full, `A${angle}: a whole-row exact read still turns every candidate`)
    for (let i = 0; i < along.length; i++) {
      assert.equal(stretch.tipRadius[0][i], whole.tipRadius[0][i], `A${angle} X${along[i]}: the stretch read's value is the row's`)
    }
    // Pricing never depends on the prep's own along grid, only on the poses.
    assert.equal(rotaryExactStretchWork(wholePrep, angle, along, BALL.radius), price,
      `A${angle}: the price is the poses' stretch, not the prep's`)
  }
  console.log('stretch price: equals the read\'s turned facets at three angles, values unchanged')
}

function helixCuts(continuousHelix: boolean | undefined): { cuts: number; helix: number } {
  const mesh = vase(STOCK)
  const result = generateRotaryRough('vase', mesh, STOCK, BALL, {
    stepover: 0.5, stepdown: 1.5, sampleSpacing: 0.5, stockToLeave: 0.2,
    alongStart: 2, alongEnd: 38, safeRadius: barMaxRadius(STOCK) + 2,
    requestedCellSize: 0.25, passDirection: 'around',
    ...(continuousHelix !== undefined ? { continuousHelix } : {}),
  }, {})
  assert.deepEqual(result.warnings, [], 'the vase rough raises no warning')
  // A helix move turns A and advances along the bar at once, in an unbroken run
  // of such cuts that covers at least a whole turn. A ring-to-ring surface link
  // also moves both, but over a few degrees, so it is not counted.
  let cuts = 0
  let helix = 0
  let runMoves = 0
  let runTurn = 0
  const closeRun = (): void => {
    if (runTurn >= 360 - 1e-6) helix += runMoves
    runMoves = 0
    runTurn = 0
  }
  for (const move of result.moves) {
    const both = move.kind === 'cut' && (move.from.a ?? 0) !== (move.to.a ?? 0) && move.from.x !== move.to.x
    if (move.kind === 'cut') cuts++
    if (!both) {
      closeRun()
      continue
    }
    runMoves++
    runTurn += Math.abs((move.to.a ?? 0) - (move.from.a ?? 0))
  }
  closeRun()
  return { cuts, helix }
}

function testTheSettingChoosesTheHelix(): void {
  const off = helixCuts(undefined)
  const offExplicit = helixCuts(false)
  const on = helixCuts(true)
  assert.equal(off.helix, 0, 'a rough without the setting attempts no helix')
  assert.deepEqual(offExplicit, off, 'false is the same as missing')
  assert.ok(on.helix > 0, 'a round-bar ball rough with the setting on cuts a helix')
  assert.ok(on.helix / on.cuts > 0.05, `the helix share is real (${on.helix} of ${on.cuts} cuts)`)
  console.log(`helix setting: off ${off.helix} of ${off.cuts} cuts, on ${on.helix} of ${on.cuts} cuts`)
}

testStretchPriceIsTheReadsWork()
testTheSettingChoosesTheHelix()
console.log('rotaryHelixOption.test.ts: all checks passed')
