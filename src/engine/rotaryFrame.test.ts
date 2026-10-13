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
 * The rotary sign convention (issue #393): `stockSpacePoint` and its exact
 * inverse `toolSpacePoint`, on both project axes.
 *
 * The expected stock points below are computed from the convention in the
 * issue — the stock point under a tool tip straight above the centreline at
 * radius `r` is `r·sin a` across and `r·cos a` up — never by calling the
 * implementation.
 *
 * Run with: npx tsx src/engine/rotaryFrame.test.ts
 */

import assert from 'node:assert/strict'
import { roundStock } from '../types/project'
import { stockSpacePoint, toolSpacePoint } from './rotaryFrame'

const BAR_X = roundStock(20, 100, 'x')
const BAR_Y = roundStock(20, 100, 'y')

function approx(actual: number, expected: number, label: string, eps = 1e-9): void {
  assert.ok(Math.abs(actual - expected) <= eps, `${label}: got ${actual}, expected ${expected}`)
}

function approxPoint(
  actual: { x: number; y: number; z: number },
  expected: { x: number; y: number; z: number },
  label: string,
  eps = 1e-9,
): void {
  approx(actual.x, expected.x, `${label} x`, eps)
  approx(actual.y, expected.y, `${label} y`, eps)
  approx(actual.z, expected.z, `${label} z`, eps)
}

// ── 1. The convention's own landmark angles, both axes ────────

for (const stock of [BAR_X, BAR_Y]) {
  const axis = stock.axis
  // The tool straight above the centreline at radius 10 (the bar is 20 across,
  // so its centreline is at 10 and the tip at 20): for every angle the stock
  // point is 10·sin a across the bar and 10·cos a up.
  const tip = (a: number) => (axis === 'x'
    ? { x: 5, y: 10, z: 20, a }
    : { x: 10, y: 5, z: 20, a })
  const stockAt = (across: number, up: number) => (axis === 'x'
    ? { x: 5, y: 10 + across, z: 10 + up }
    : { x: 10 + across, y: 5, z: 10 + up })

  approxPoint(stockSpacePoint(tip(0), stock), stockAt(0, 10), `${axis} 0°`)
  approxPoint(stockSpacePoint(tip(90), stock), stockAt(10, 0), `${axis} 90°`)
  approxPoint(stockSpacePoint(tip(180), stock), stockAt(0, -10), `${axis} 180°`)
  approxPoint(stockSpacePoint(tip(270), stock), stockAt(-10, 0), `${axis} 270°`)
  // 360° is the identity within 1e-9, and 450° is 90° again.
  approxPoint(stockSpacePoint(tip(360), stock), stockAt(0, 10), `${axis} 360°`, 1e-9)
  approxPoint(stockSpacePoint(tip(450), stock), stockAt(10, 0), `${axis} 450°`)

  // The sign matters: as the angle grows from 0, material on the POSITIVE side
  // of the bar comes up under the tool. At 90° the stock point is +10 across a
  // bar whose centreline is 10, so it sits at 20 — not at 0.
  const at90 = stockSpacePoint(tip(90), stock)
  assert.equal(axis === 'x' ? at90.y : at90.x, 10 + 10, `${axis}: positive side comes up as the angle grows`)
}

// ── 2. A point off the centreline ─────────────────────────────

{
  // A point at (5, 17, 23): 7 across the bar and 13 above the centreline.
  // At 33°: across' = 7·cos33 + 13·sin33, up' = -7·sin33 + 13·cos33.
  const t = (33 * Math.PI) / 180
  const across = 7 * Math.cos(t) + 13 * Math.sin(t)
  const up = -7 * Math.sin(t) + 13 * Math.cos(t)
  approxPoint(
    stockSpacePoint({ x: 5, y: 17, z: 23, a: 33 }, BAR_X),
    { x: 5, y: 10 + across, z: 10 + up },
    'off-centreline point',
  )
}

// ── 3. No angle is returned unchanged ─────────────────────────

{
  const plain = { x: 3, y: 4, z: 5 }
  const result = stockSpacePoint(plain, BAR_X)
  assert.deepEqual(result, { x: 3, y: 4, z: 5 }, 'a point with no angle is returned as {x, y, z}')
  assert.ok(!('a' in result), 'no a key is added')
}

// ── 4. Round trips, both directions, both axes ────────────────

for (const stock of [BAR_X, BAR_Y]) {
  const points = [
    { x: 0, y: 10, z: 20, a: 0 },
    { x: 5, y: 10, z: 20, a: 90 },
    { x: 12, y: 17, z: 23, a: 33.5 },
    { x: 20, y: 3, z: 4, a: -197.25 },
  ]
  for (const point of points) {
    const back = toolSpacePoint(stockSpacePoint(point, stock), point.a, stock)
    approxPoint(back, point, `tool → stock → tool ${JSON.stringify(point)} (${stock.axis})`, 1e-9)
    approx(back.a ?? Number.NaN, point.a, 'round trip keeps the angle', 1e-9)
  }

  const stockPoints = [
    { x: 0, y: 0, z: 0 },
    { x: 5, y: 20, z: 10 },
    { x: 12, y: 4.5, z: 17.25 },
  ]
  for (const stockPoint of stockPoints) {
    const tip = toolSpacePoint(stockPoint, 62.5, stock)
    approxPoint(stockSpacePoint(tip, stock), stockPoint, `stock → tool → stock ${JSON.stringify(stockPoint)} (${stock.axis})`, 1e-9)
    approx(tip.a ?? Number.NaN, 62.5, 'toolSpacePoint sets the angle')
  }
}

// ── 5. The centreline itself is fixed ─────────────────────────

{
  // A tip on the centreline at the axis height turns about a line through the
  // pivot, so it does not move.
  const onCentre = { x: 7, y: 10, z: 10, a: 123 }
  approxPoint(stockSpacePoint(onCentre, BAR_X), { x: 7, y: 10, z: 10 }, 'a point on the centreline is fixed')
}

console.log('engine/rotaryFrame.test.ts: all assertions passed')
