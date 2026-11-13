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
 * The stock outline's bar facts (#1016 C2-U1V): a square blank's physical
 * rectangle is drawn as it is, its turning centreline is the same true-pivot
 * line a round bar gets, and its cross dimension is the side — never a
 * diameter, so it never carries the Ø.
 *
 * Mutations checked one at a time against these assertions:
 * - the centreline drawn only for a round bar → "a square blank gets the same
 *   turning centreline" fails;
 * - the centreline back at the across corner instead of the box centre → the
 *   centred assertion fails;
 * - the Ø added to a square blank's cross dimension (or dropped from a round
 *   bar's) → the label assertions fail.
 *
 * Run with: npx tsx src/components/canvas/scenePrimitives.test.ts
 */

import { squareStock } from '../../types/barStock'
import { newProject, roundStock } from '../../types/project'
import { barCentreline, barDimensionLabels } from './scenePrimitives'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

const SQUARE_X = squareStock(12, 30, 'x', { x: 4, y: 7 })
const SQUARE_Y = squareStock(12, 30, 'y', { x: 4, y: 7 })
const ROUND_X = roundStock(12, 30, 'x', { x: 4, y: 7 })
const ROUND_Y = roundStock(12, 30, 'y', { x: 4, y: 7 })

// ── The turning centreline ───────────────────────────────────

{
  for (const [axis, stock] of [['x', SQUARE_X], ['y', SQUARE_Y]] as const) {
    const line = barCentreline(stock)
    assert(line !== null, `${axis}: a square blank gets a turning centreline`)
    const across = axis === 'x' ? line!.from.y : line!.from.x
    assert(across === (axis === 'x' ? line!.to.y : line!.to.x), `${axis}: the centreline runs straight along the blank`)
    // The pivot is the box centre: 7 + 12/2 for the X blank, 4 + 12/2 for Y.
    assert(across === (axis === 'x' ? 7 + 6 : 4 + 6), `${axis}: the centreline sits on the box centre, at the true pivot`)
    if (axis === 'x') {
      assert(line!.from.x === 4 && line!.to.x === 34, 'the X centreline spans the blank along X')
      assert(line!.from.y === 13 && line!.to.y === 13, 'the X centreline is the constant across coordinate')
    } else {
      assert(line!.from.y === 7 && line!.to.y === 37, 'the Y centreline spans the blank along Y')
      assert(line!.from.x === 10 && line!.to.x === 10, 'the Y centreline is the constant across coordinate')
    }
  }

  // A block has no bar and so no turning centreline.
  const block = newProject().stock
  assert(barCentreline(block) === null, 'a block gets no bar centreline')
}

// ── The dimension labels ─────────────────────────────────────

{
  const squareLabels = barDimensionLabels(SQUARE_X, 30, 12, 'mm')
  assert(!squareLabels.width.includes('Ø') && !squareLabels.height.includes('Ø'),
    `a square blank's dimensions are never diameters: ${JSON.stringify(squareLabels)}`)
  assert(squareLabels.height === '12 mm', `the square cross dimension is the side: ${squareLabels.height}`)
  assert(squareLabels.width === '30 mm', `the square along dimension is its length: ${squareLabels.width}`)

  const squareInch = barDimensionLabels(SQUARE_X, 2, 0.5, 'inch')
  assert(squareInch.height === '0.5 in' && !squareInch.height.includes('Ø'),
    `an inch square blank reads its side in inches: ${squareInch.height}`)

  // A round bar keeps the Ø on its cross dimension only.
  const roundX = barDimensionLabels(ROUND_X, 30, 12, 'mm')
  assert(roundX.height === 'Ø12 mm', `a round X bar's cross dimension is a diameter: ${roundX.height}`)
  assert(roundX.width === '30 mm', `a round bar's along dimension is a plain length: ${roundX.width}`)
  const roundY = barDimensionLabels(ROUND_Y, 30, 12, 'mm')
  assert(roundY.width === 'Ø30 mm', `a round Y bar's cross dimension is the width: ${roundY.width}`)
  assert(roundY.height === '12 mm', `a round Y bar's along dimension is a plain length: ${roundY.height}`)

  // A block has no bar axis, so neither side carries the Ø.
  const blockLabels = barDimensionLabels(newProject().stock, 30, 12, 'mm')
  assert(!blockLabels.width.includes('Ø') && !blockLabels.height.includes('Ø'),
    `a block's dimensions are never diameters: ${JSON.stringify(blockLabels)}`)
}

console.log('scenePrimitives: all assertions passed')
