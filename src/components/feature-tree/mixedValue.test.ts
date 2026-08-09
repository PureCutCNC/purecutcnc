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

/**
 * Unit tests for the pure mixed-value aggregation helpers.
 *
 * Run with: npx tsx src/components/feature-tree/mixedValue.test.ts
 */

import { commonNumber, commonBoolean, minValue, maxValue, zDomainMax, clampDomainMax, constrainZ, validateZEdits, zHandleAriaBounds } from './mixedValue'

let passed = 0
let failed = 0

interface TestItem {
  a: number
  b?: number
  visible?: boolean
}

function check(description: string, fn: () => void): void {
  try {
    fn()
    passed += 1
  } catch (err) {
    failed += 1
    console.error(`FAIL: ${description}`)
    console.error(`  ${err instanceof Error ? err.message : String(err)}`)
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

// ── commonNumber ────────────────────────────────────────────────────

check('commonNumber: null for empty array', () => {
  assert(commonNumber([], (item: TestItem) => item.a) === null, 'expected null')
})

check('commonNumber: returns value when all items share it', () => {
  const items: TestItem[] = [{ a: 5 }, { a: 5 }, { a: 5 }]
  assert(commonNumber(items, (item) => item.a) === 5, 'expected 5')
})

check('commonNumber: null when values differ', () => {
  const items: TestItem[] = [{ a: 5 }, { a: 7 }, { a: 5 }]
  assert(commonNumber(items, (item) => item.a) === null, 'expected null for mixed values')
})

check('commonNumber: null when first value is undefined', () => {
  const items: TestItem[] = [{ a: 0, b: undefined }, { a: 0, b: 3 }]
  assert(commonNumber(items, (item) => item.b) === null, 'expected null when first is undefined')
})

check('commonNumber: null when accessor returns null', () => {
  const items: TestItem[] = [{ a: 0 }, { a: 0 }]
  assert(commonNumber(items, () => null) === null, 'expected null')
})

check('commonNumber: single-item array', () => {
  const items: TestItem[] = [{ a: 42 }]
  assert(commonNumber(items, (item) => item.a) === 42, 'expected 42')
})

check('commonNumber: zero is a valid common value', () => {
  const items: TestItem[] = [{ a: 0 }, { a: 0 }]
  assert(commonNumber(items, (item) => item.a) === 0, 'expected 0')
})

// ── commonBoolean ───────────────────────────────────────────────────

check('commonBoolean: null for empty array', () => {
  assert(commonBoolean([], (item: TestItem) => item.visible ?? false) === null, 'expected null')
})

check('commonBoolean: true when all true', () => {
  const items: TestItem[] = [
    { a: 0, visible: true },
    { a: 0, visible: true },
  ]
  assert(commonBoolean(items, (item) => item.visible ?? false) === true, 'expected true')
})

check('commonBoolean: false when all false', () => {
  const items: TestItem[] = [
    { a: 0, visible: false },
    { a: 0, visible: false },
  ]
  assert(commonBoolean(items, (item) => item.visible ?? true) === false, 'expected false')
})

check('commonBoolean: null when mixed', () => {
  const items: TestItem[] = [
    { a: 0, visible: true },
    { a: 0, visible: false },
  ]
  assert(commonBoolean(items, (item) => item.visible ?? false) === null, 'expected null for mixed')
})

// ── minValue ────────────────────────────────────────────────────────

check('minValue: null for empty array', () => {
  assert(minValue([], (item: TestItem) => item.a) === null, 'expected null')
})

check('minValue: returns minimum', () => {
  const items: TestItem[] = [{ a: 5 }, { a: 3 }, { a: 7 }]
  assert(minValue(items, (item) => item.a) === 3, 'expected 3')
})

check('minValue: skips undefined values', () => {
  const items: TestItem[] = [{ a: 5 }, { a: 0, b: undefined }, { a: 0, b: 2 }]
  assert(minValue(items, (item) => item.b) === 2, 'expected 2')
})

check('minValue: null when all null/undefined', () => {
  const items: TestItem[] = [{ a: 5 }, { a: 3 }]
  assert(minValue(items, () => null) === null, 'expected null')
})

// ── maxValue ────────────────────────────────────────────────────────

check('maxValue: returns maximum', () => {
  const items: TestItem[] = [{ a: 5 }, { a: 3 }, { a: 7 }]
  assert(maxValue(items, (item) => item.a) === 7, 'expected 7')
})

// ── zDomainMax ──────────────────────────────────────────────────────

check('zDomainMax: returns floor when no values', () => {
  assert(zDomainMax([], 10) === 10, 'expected floor 10')
})

check('zDomainMax: returns floor when all null/undefined', () => {
  assert(zDomainMax([null, undefined], 10) === 10, 'expected floor 10')
})

check('zDomainMax: returns largest value exceeding floor', () => {
  assert(zDomainMax([5, 12, 8], 10) === 12, 'expected 12')
})

check('zDomainMax: returns floor when all values <= floor', () => {
  assert(zDomainMax([3, 7, 9], 10) === 10, 'expected floor 10')
})

// ── clampDomainMax ───────────────────────────────────────────────────

check('clampDomainMax: adds headroom above largest value', () => {
  assert(clampDomainMax([5, 8], 5, 5) === 13, 'expected 8 + 5 = 13')
})

check('clampDomainMax: uses floor when values are smaller', () => {
  assert(clampDomainMax([2, 3], 10, 5) === 15, 'expected floor 10 + headroom 5 = 15')
})

check('clampDomainMax: handles empty array', () => {
  assert(clampDomainMax([], 5, 5) === 10, 'expected floor + headroom = 10')
})

check('clampDomainMax: handles null/undefined values', () => {
  assert(clampDomainMax([null, undefined, 8], 5, 5) === 13, 'expected 8 + 5 = 13')
})

check('clampDomainMax: headroom is unit-aware and independent of stock', () => {
  // 25.4 mm/inch, so 0.5 inch floor + 0.2 inch headroom = 0.7 inch → ~17.78mm
  const result = clampDomainMax([/* 10mm = ~0.394in */], 12.7, 5.08)
  // 0.394in → max is 10mm, but floor 12.7mm > 10mm, so best=12.7, result=12.7+5.08=17.78
  assert(Math.abs(result - 17.78) < 0.01, `expected ~17.78, got ${result}`)
})

// ── constrainZ ──────────────────────────────────────────────────────

// --- Top handle ---

check('constrainZ: top — respects domain bounds with null opposite', () => {
  assert(constrainZ(5, true, 0, 20, null) === 5, 'value inside range')
})

check('constrainZ: top — clamps to domainMin with null opposite', () => {
  assert(constrainZ(-3, true, 0, 20, null) === 0, 'clamped to domain min')
})

check('constrainZ: top — clamps to domainMax with null opposite', () => {
  assert(constrainZ(25, true, 0, 20, null) === 20, 'clamped to domain max')
})

check('constrainZ: top — constrained below known bottom', () => {
  // top=2, bottom=5 → top must be >= bottom, so clamped to 5
  assert(constrainZ(2, true, 0, 20, 5) === 5, 'top clamped to bottom')
})

check('constrainZ: top — value above known bottom passes through', () => {
  assert(constrainZ(10, true, 0, 20, 5) === 10, 'top above bottom passes')
})

check('constrainZ: top — equal to bottom is valid', () => {
  assert(constrainZ(5, true, 0, 20, 5) === 5, 'equality is valid')
})

check('constrainZ: top — knows bottom below domainMin, uses domainMin', () => {
  assert(constrainZ(2, true, 3, 20, 1) === 3, 'lower bound is domainMin not the out-of-bounds bottom')
})

// --- Bottom handle ---

check('constrainZ: bottom — respects domain bounds with null opposite', () => {
  assert(constrainZ(5, false, 0, 20, null) === 5, 'value inside range')
})

check('constrainZ: bottom — clamps to domainMin with null opposite', () => {
  assert(constrainZ(-3, false, 0, 20, null) === 0, 'clamped to domain min')
})

check('constrainZ: bottom — clamps to domainMax with null opposite', () => {
  assert(constrainZ(25, false, 0, 20, null) === 20, 'clamped to domain max')
})

check('constrainZ: bottom — constrained above known top', () => {
  // bottom=10, top=5 → bottom must be <= top, so clamped to 5
  assert(constrainZ(10, false, 0, 20, 5) === 5, 'bottom clamped to top')
})

check('constrainZ: bottom — value below known top passes through', () => {
  assert(constrainZ(3, false, 0, 20, 5) === 3, 'bottom below top passes')
})

check('constrainZ: bottom — equal to top is valid', () => {
  assert(constrainZ(5, false, 0, 20, 5) === 5, 'equality is valid')
})

check('constrainZ: bottom — knows top above domainMax, uses domainMax', () => {
  assert(constrainZ(15, false, 0, 10, 20) === 10, 'upper bound is domainMax not the out-of-bounds top')
})

// --- Domain bounds edge cases ---

check('constrainZ: top — domainMin = domainMax, everything clamped', () => {
  assert(constrainZ(5, true, 7, 7, null) === 7, 'clamped to the only valid value in zero-range domain')
})

check('constrainZ: bottom — domainMin = domainMax, everything clamped', () => {
  assert(constrainZ(5, false, 7, 7, null) === 7, 'clamped to the only valid value in zero-range domain')
})

// --- No-op / unchanged ───────────────────────────────────────────────

check('constrainZ: top — value at domain edge is unchanged', () => {
  assert(constrainZ(0, true, 0, 20, null) === 0, 'already at domainMin')
})

check('constrainZ: bottom — value at domain edge is unchanged', () => {
  assert(constrainZ(20, false, 0, 20, null) === 20, 'already at domainMax')
})

// ── validateZEdits ──────────────────────────────────────────────────

interface ZItem { z_top: number; z_bottom: number }

check('validateZEdits: top commit >= all bottoms passes', () => {
  const items: ZItem[] = [{ z_top: 5, z_bottom: 0 }, { z_top: 5, z_bottom: 2 }]
  assert(validateZEdits(items, (i) => i.z_top, (i) => i.z_bottom, { top: 3 }) === true, 'top=3 >= max(bottoms)=2')
})

check('validateZEdits: top commit < a bottom is rejected', () => {
  const items: ZItem[] = [{ z_top: 5, z_bottom: 0 }, { z_top: 5, z_bottom: 4 }]
  assert(validateZEdits(items, (i) => i.z_top, (i) => i.z_bottom, { top: 3 }) === false, 'top=3 < bottom=4')
})

check('validateZEdits: bottom commit <= all tops passes', () => {
  const items: ZItem[] = [{ z_top: 5, z_bottom: 0 }, { z_top: 8, z_bottom: 0 }]
  assert(validateZEdits(items, (i) => i.z_top, (i) => i.z_bottom, { bottom: 4 }) === true, 'bottom=4 <= min(tops)=5')
})

check('validateZEdits: bottom commit > a top is rejected', () => {
  const items: ZItem[] = [{ z_top: 5, z_bottom: 0 }, { z_top: 3, z_bottom: 0 }]
  assert(validateZEdits(items, (i) => i.z_top, (i) => i.z_bottom, { bottom: 4 }) === false, 'bottom=4 > top=3')
})

check('validateZEdits: top commit with equality (z_top === z_bottom) is valid', () => {
  const items: ZItem[] = [{ z_top: 3, z_bottom: 3 }]
  assert(validateZEdits(items, (i) => i.z_top, (i) => i.z_bottom, { top: 3 }) === true, 'equality passes')
})

check('validateZEdits: empty items returns true (vacuously valid)', () => {
  assert(validateZEdits([], (i: ZItem) => i.z_top, (i: ZItem) => i.z_bottom, { top: 5 }) === true, 'no items to violate')
})

check('validateZEdits: both top and bottom commit validated per-item with effective range', () => {
  const items: ZItem[] = [{ z_top: 5, z_bottom: 0 }]
  // Combined patch: effectiveTop=6, effectiveBottom=3, 6>=3 → valid
  assert(validateZEdits(items, (i) => i.z_top, (i) => i.z_bottom, { top: 6, bottom: 3 }) === true, 'both valid')
  // Combined patch: effectiveTop=6, effectiveBottom=7, 6<7 → invalid
  assert(validateZEdits(items, (i) => i.z_top, (i) => i.z_bottom, { top: 6, bottom: 7 }) === false, 'bottom > effective top')
})

check('validateZEdits: combined patch crossing opposite endpoint per-item is rejected', () => {
  // Item: z_top=5, z_bottom=2. Patch: {top:3, bottom:4}
  // Old separate check: top=3 >= bottom=2 ✓ AND bottom=4 <= top=5 ✓ → accepted (bug)
  // New per-item: effectiveTop=3, effectiveBottom=4, 3<4 → rejected ✓
  const items: ZItem[] = [{ z_top: 5, z_bottom: 2 }]
  assert(validateZEdits(items, (i) => i.z_top, (i) => i.z_bottom, { top: 3, bottom: 4 }) === false, 'crossing range rejected')
})

check('validateZEdits: combined patch crossing opposite endpoint for one item is rejected', () => {
  // Item A has z_top=2, z_bottom=1. With patch {top:3, bottom:4}:
  //   effectiveTop=3, effectiveBottom=4, 3<4 → rejected.
  // Even though item B {z_top:5, z_bottom:0} would be fine with the patch,
  // the edit fails for item A and the entire batch is rejected.
  const items: ZItem[] = [
    { z_top: 2, z_bottom: 1 },
    { z_top: 5, z_bottom: 0 },
  ]
  assert(validateZEdits(items, (i) => i.z_top, (i) => i.z_bottom, { top: 3, bottom: 4 }) === false, 'item A crossing')
})

check('validateZEdits: clamp bottom fixed at 0, top must be >= 0', () => {
  const items = [{ height: 5 }, { height: 8 }]
  assert(validateZEdits(items, (c) => c.height, () => 0, { top: 0 }) === true, 'top=0 valid')
  assert(validateZEdits(items, (c) => c.height, () => 0, { top: -1 }) === false, 'top=-1 < bottom=0 rejected')
})

// ── zHandleAriaBounds ───────────────────────────────────────────────

check('zHandleAriaBounds: top with known bottom', () => {
  const bounds = zHandleAriaBounds(true, 0, 20, 5)
  assert(bounds.valuemin === 5 && bounds.valuemax === 20, `expected 5-20, got ${bounds.valuemin}-${bounds.valuemax}`)
})

check('zHandleAriaBounds: top with null opposite', () => {
  const bounds = zHandleAriaBounds(true, 0, 20, null)
  assert(bounds.valuemin === 0 && bounds.valuemax === 20, 'falls back to domain')
})

check('zHandleAriaBounds: bottom with known top', () => {
  const bounds = zHandleAriaBounds(false, 0, 20, 7)
  assert(bounds.valuemin === 0 && bounds.valuemax === 7, `expected 0-7, got ${bounds.valuemin}-${bounds.valuemax}`)
})

check('zHandleAriaBounds: bottom with null opposite', () => {
  const bounds = zHandleAriaBounds(false, 0, 20, null)
  assert(bounds.valuemin === 0 && bounds.valuemax === 20, 'falls back to domain')
})

check('zHandleAriaBounds: bottom opposite above domainMax uses domainMax', () => {
  const bounds = zHandleAriaBounds(false, 0, 10, 25)
  assert(bounds.valuemin === 0 && bounds.valuemax === 10, 'upper is domainMax not out-of-bounds top')
})

check('zHandleAriaBounds: top opposite below domainMin uses domainMin', () => {
  const bounds = zHandleAriaBounds(true, 3, 20, 1)
  assert(bounds.valuemin === 3 && bounds.valuemax === 20, 'lower is domainMin not out-of-bounds bottom')
})

// ── Mixed opposite pointer — fabricated domainMin regression ─────────

check('constrainZ: top with null opposite (mixed bottom) — only domain constrains, not fabricated 0', () => {
  // Before the fix, a null zBottom was substituted as domainMin (0),
  // which artificially constrained the top handle to >= 0.
  // The correct behavior: only domainMin/domainMax apply, never fabricate an opposite.
  assert(constrainZ(5, true, 0, 20, null) === 5, 'top value in range passes through')
  // Even a negative value within a shifted domain should be allowed when opposite is null.
  assert(constrainZ(-2, true, -5, 20, null) === -2, 'negative top within negative-shifted domain unconstrained by opposite')
})

check('constrainZ: bottom with null opposite (mixed top) — only domain constrains, not fabricated domainMin', () => {
  // Before the fix, a null zTop was substituted as domainMin (0),
  // which constrained the bottom handle to <= 0.
  assert(constrainZ(15, false, 0, 20, null) === 15, 'bottom value in range passes through')
  // When domainMin is shifted, null opposite must NOT clamp to the wrong bound.
  assert(constrainZ(8, false, 3, 20, null) === 8, 'bottom above domainMin unconstrained by null opposite')
})

check('constrainZ: top with known opposite constrains against it, never against domainMin', () => {
  // Known bottom=5, top dragged to 2 → clamped to >=5.
  assert(constrainZ(2, true, 0, 20, 5) === 5, 'top clamped to known bottom')
})

check('constrainZ: bottom with known opposite constrains against it, never against domainMin', () => {
  // Known top=3, bottom dragged to 7 → clamped to <=3.
  assert(constrainZ(7, false, 0, 20, 3) === 3, 'bottom clamped to known top')
})

// ── validateZEdits effective-ranges per-item ─────────────────────────

check('validateZEdits: effective ranges with varied per-item getTop/getBottom', () => {
  // Item A: z_top=10, z_bottom=8 → effective range 8..10
  // Item B: z_top=5,  z_bottom=0 → effective range 0..5
  const items = [
    { closed: true, z_top: 10, z_bottom: 8 },
    { closed: true, z_top: 5, z_bottom: 0 },
  ]
  // Top patch: effectiveTop=4, effectiveBottom = item bottom → A: 4<8 REJECTED
  assert(
    validateZEdits(items, (i) => i.z_top, (i) => i.z_bottom, { top: 4 }) === false,
    'top=4 < item A effectiveBottom=8',
  )
  // Bottom-only patch: effectiveBottom=6 → A: 10>=6 OK, B: 5<6 REJECTED
  assert(
    validateZEdits(items, (i) => i.z_top, (i) => i.z_bottom, { bottom: 6 }) === false,
    'bottom=6 > item B effectiveTop=5',
  )
})

check('validateZEdits: Line features with getBottom()=>0 unblock valid bottom for closed', () => {
  // Mixed selection: one Line (bottom conceptually 0, top=2) + one closed (top=5, bottom=0).
  // Bottom-only patch: validateItems=closed only → Line excluded.
  const closed = [{ z_top: 5, z_bottom: 0 }]
  assert(
    validateZEdits(closed, (i) => i.z_top, (i) => i.z_bottom, { bottom: 3 }) === true,
    'bottom=3 for closed feature with top=5 is valid',
  )
  // If Line were included (top=2, getBottom=0): effectiveTop=2 < effectiveBottom=3 → rejected.
  // This is the exact scenario PropertiesPanel avoids by scoping validateItems to closed only.
  const mixed = [
    { z_top: 2, z_bottom: 0 },
    { z_top: 5, z_bottom: 0 },
  ]
  assert(
    validateZEdits(mixed, (i) => i.z_top, (i) => i.z_bottom, { bottom: 3 }) === false,
    'bottom=3 > Line effectiveTop=2 — rejected when Line is in validateItems',
  )
})

// ── Report ──────────────────────────────────────────────────────────

const total = passed + failed
console.log(`mixedValue.test.ts: ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ''}`)
if (failed > 0) process.exit(1)
