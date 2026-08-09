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

import { commonNumber, commonBoolean, minValue, maxValue, zDomainMax } from './mixedValue'

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

// ── Report ──────────────────────────────────────────────────────────

const total = passed + failed
console.log(`mixedValue.test.ts: ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ''}`)
if (failed > 0) process.exit(1)
