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
 * Unit tests for the tab-shape control logic: the `commonValue` generic and
 * the resolution of tab shape through `tabShape()`.
 *
 * Run with: npx tsx src/components/feature-tree/tabShapeControl.test.ts
 */

import { commonValue } from './mixedValue'
import { tabShape } from '../../types/project'
import type { Tab, TabShape } from '../../types/project'

let passed = 0
let failed = 0

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

// ── commonValue ──────────────────────────────────────────────────────

interface StringItem { label: string }

check('commonValue: null for empty array', () => {
  assert(commonValue([], (item: StringItem) => item.label) === null, 'expected null')
})

check('commonValue: returns value when all items share it', () => {
  const items: StringItem[] = [{ label: 'a' }, { label: 'a' }, { label: 'a' }]
  assert(commonValue(items, (item) => item.label) === 'a', "expected 'a'")
})

check('commonValue: null when values differ', () => {
  const items: StringItem[] = [{ label: 'a' }, { label: 'b' }, { label: 'a' }]
  assert(commonValue(items, (item) => item.label) === null, 'expected null for mixed values')
})

check('commonValue: null when first value is undefined', () => {
  interface ItemWithOptional { label?: string }
  const items: ItemWithOptional[] = [{}, { label: 'x' }]
  assert(commonValue(items, (item) => item.label) === null, 'expected null when first is undefined')
})

check('commonValue: null when first value is null', () => {
  interface ItemWithNullable { label: string | null }
  const items: ItemWithNullable[] = [{ label: null }, { label: 'x' }]
  assert(commonValue(items, (item) => item.label) === null, 'expected null when first is null')
})

check('commonValue: single-item array', () => {
  const items: StringItem[] = [{ label: 'hello' }]
  assert(commonValue(items, (item) => item.label) === 'hello', "expected 'hello'")
})

// ── tabShape resolution (the critical legacy-tab case) ───────────────

function makeTab(overrides: Partial<Tab> = {}): Tab {
  return {
    id: 't-1',
    name: 'Test Tab',
    x: 0,
    y: 0,
    w: 10,
    h: 10,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    ...overrides,
  }
}

check('tabShape: legacy tab (no shape field) resolves to rect', () => {
  const tab = makeTab()
  // delete shape to simulate a legacy tab
  delete (tab as { shape?: TabShape }).shape
  assert(tabShape(tab) === 'rect', 'legacy tab must be rect')
})

check('tabShape: explicit rect resolves to rect', () => {
  const tab = makeTab({ shape: 'rect' })
  assert(tabShape(tab) === 'rect', 'explicit rect')
})

check('tabShape: explicit smooth resolves to smooth', () => {
  const tab = makeTab({ shape: 'smooth' })
  assert(tabShape(tab) === 'smooth', 'explicit smooth')
})

check('tabShape: undefined shape resolves to rect', () => {
  const tab = makeTab({ shape: undefined })
  assert(tabShape(tab) === 'rect', 'undefined shape → rect')
})

check('commonValue via tabShape: legacy + explicit rect = homogeneous rect, not mixed', () => {
  // This is the case a naive commonValue(tabs, t => t.shape) gets wrong:
  // legacy tab has no shape field, explicit-rect tab has shape='rect'.
  // Through tabShape(), both resolve to 'rect', so the panel must show
  // Rectangular, not mixed.
  const tabs: Tab[] = [
    makeTab({ id: 't-legacy' }),
    makeTab({ id: 't-rect', shape: 'rect' }),
  ]
  delete (tabs[0] as { shape?: TabShape }).shape
  // Verify the raw .shape accessor would see mixed (undefined vs 'rect')
  assert(commonValue(tabs, (t) => t.shape ?? null) === null, 'raw shape is mixed')
  // But through tabShape() it must be homogeneous 'rect'
  assert(commonValue(tabs, (t) => tabShape(t)) === 'rect', 'tabShape() resolves both to rect')
})

check('commonValue via tabShape: smooth + rect = mixed', () => {
  const tabs: Tab[] = [
    makeTab({ id: 't-smooth', shape: 'smooth' }),
    makeTab({ id: 't-rect', shape: 'rect' }),
  ]
  assert(commonValue(tabs, (t) => tabShape(t)) === null, 'smooth + rect must be mixed')
})

check('commonValue via tabShape: two legacy tabs = homogeneous rect', () => {
  const tabs: Tab[] = [
    makeTab({ id: 't-1' }),
    makeTab({ id: 't-2' }),
  ]
  delete (tabs[0] as { shape?: TabShape }).shape
  delete (tabs[1] as { shape?: TabShape }).shape
  assert(commonValue(tabs, (t) => tabShape(t)) === 'rect', 'two legacy tabs → rect')
})

// ── Report ──────────────────────────────────────────────────────────

const total = passed + failed
console.log(`tabShapeControl.test.ts: ${passed}/${total} passed${failed > 0 ? `, ${failed} FAILED` : ''}`)
if (failed > 0) process.exit(1)
