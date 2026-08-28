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
 * The fragmentation signature and the path store (issue #661).
 *
 * The signature is the whole risk of level sharing: two levels that merely look
 * alike but differ must never collide, because reusing a path that was never
 * safe at that Z is the bug class guide-domain fragmentation exists to prevent.
 * These tests pin that the key separates on every input `buildTrochoidalContour`
 * reads, and that the store never hands back a path for a guide it was not
 * generated from.
 *
 * The integration side — that the safety backstop still runs per level on a
 * shared path, and that the emitted program does not move — lives in
 * `trochoidalLevelSharing.test.ts`.
 *
 * Run with: npx tsx src/engine/toolpaths/trochoidalLevelPaths.test.ts
 */

import type { Point } from '../../types/project'
import type { TrochoidalContourResult } from './trochoidalEdge'
import {
  createTrochoidalPathStore,
  trochoidalGuideSignature,
  type TrochoidalPathParams,
} from './trochoidalLevelPaths'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

const guide: Point[] = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 30 },
  { x: 0, y: 30 },
]

const params: TrochoidalPathParams = {
  orbitRadius: 1.5,
  advance: 3,
  toolDiameter: 6,
  angularDirection: 1,
}

/** Distinct enough to tell apart, cheap enough to build thousands of. */
function stubResult(tag: number): TrochoidalContourResult {
  return { points: [{ x: tag, y: tag }, { x: tag + 1, y: tag }], entryCenter: { x: tag, y: tag }, loopCount: 1, actualAdvance: 1 }
}

// ── The signature separates on every generator input ──────────────────

test('structurally identical guides share a signature', () => {
  const copy = guide.map((point) => ({ x: point.x, y: point.y }))
  assert(
    trochoidalGuideSignature(guide, true, params) === trochoidalGuideSignature(copy, true, params),
    'equal geometry built from different objects must produce the same key',
  )
})

test('a single moved coordinate splits the signature', () => {
  const nudged = guide.map((point, index) => (index === 2 ? { x: point.x + 1e-9, y: point.y } : point))
  assert(
    trochoidalGuideSignature(guide, true, params) !== trochoidalGuideSignature(nudged, true, params),
    'a 1e-9 difference in one guide point must not collide',
  )
})

test('a dropped guide point splits the signature', () => {
  assert(
    trochoidalGuideSignature(guide, true, params) !== trochoidalGuideSignature(guide.slice(0, 3), true, params),
    'a shorter guide must not collide with a longer one',
  )
})

test('reordered guide points split the signature', () => {
  const rotated = [...guide.slice(1), guide[0]]
  assert(
    trochoidalGuideSignature(guide, true, params) !== trochoidalGuideSignature(rotated, true, params),
    'the same points in a different order start the orbit elsewhere and must not collide',
  )
})

test('the closed flag splits the signature', () => {
  assert(
    trochoidalGuideSignature(guide, true, params) !== trochoidalGuideSignature(guide, false, params),
    'a closed guide and an open one generate different paths',
  )
})

test('every build parameter splits the signature', () => {
  const base = trochoidalGuideSignature(guide, true, params)
  const variants: Array<[string, TrochoidalPathParams]> = [
    ['orbitRadius', { ...params, orbitRadius: params.orbitRadius + 1e-9 }],
    ['advance', { ...params, advance: params.advance + 1e-9 }],
    ['toolDiameter', { ...params, toolDiameter: params.toolDiameter + 1e-9 }],
    ['angularDirection', { ...params, angularDirection: -1 }],
  ]
  for (const [name, variant] of variants) {
    assert(
      trochoidalGuideSignature(guide, true, variant) !== base,
      `${name} must participate in the key`,
    )
  }
})

/**
 * `String(-0)` is `'0'`, so the naive encoding collides the two. They are very
 * nearly interchangeable arithmetically, which is not the standard this key is
 * held to — over-splitting costs one generated path, colliding costs a gouge.
 */
test('negative zero does not collide with zero', () => {
  const positive: Point[] = [{ x: 0, y: 0 }, ...guide.slice(1)]
  const negative: Point[] = [{ x: -0, y: 0 }, ...guide.slice(1)]
  assert(
    trochoidalGuideSignature(positive, true, params) !== trochoidalGuideSignature(negative, true, params),
    '-0 and 0 must produce different keys',
  )
})

// ── The store ────────────────────────────────────────────────────────

test('repeated levels of one guide generate exactly once', () => {
  const store = createTrochoidalPathStore()
  let calls = 0
  for (let level = 0; level < 15; level += 1) {
    const lookup = store.resolve(guide, true, params, () => {
      calls += 1
      return stubResult(calls)
    })
    assert(lookup.generated === (level === 0), `level ${level} reported the wrong generated flag`)
    assert(lookup.built.points[0].x === 1, `level ${level} must receive the first generated path`)
  }
  assert(calls === 1, `expected 1 generator call across 15 levels, got ${calls}`)
  assert(store.generatedCount === 1, `expected generatedCount 1, got ${store.generatedCount}`)
})

test('a different guide generates again', () => {
  const store = createTrochoidalPathStore()
  let calls = 0
  const generate = () => {
    calls += 1
    return stubResult(calls)
  }
  store.resolve(guide, true, params, generate)
  store.resolve(guide.slice(0, 3), true, params, generate)
  store.resolve(guide, false, params, generate)
  store.resolve(guide, true, params, generate)
  assert(calls === 3, `expected 3 generator calls for 3 distinct guides, got ${calls}`)
  assert(store.generatedCount === 3, `expected generatedCount 3, got ${store.generatedCount}`)
})

/**
 * `move-budget` is a function of the budget remaining at that moment, not of
 * the guide. Caching it would let a later fragment inherit an earlier one's
 * budget state and refuse a path it could afford.
 */
test('a failed build is never cached', () => {
  const store = createTrochoidalPathStore()
  let calls = 0
  const first = store.resolve(guide, true, params, () => {
    calls += 1
    return { points: [], entryCenter: null, loopCount: 0, actualAdvance: 0, error: 'move-budget' as const }
  })
  assert(first.built.error === 'move-budget', 'expected the failure to be returned')
  const second = store.resolve(guide, true, params, () => {
    calls += 1
    return stubResult(9)
  })
  assert(calls === 2, `a refused build must not be cached, got ${calls} calls`)
  assert(second.built.error === undefined, 'the retry must not inherit the earlier failure')
})

console.log(`\ntrochoidalLevelPaths: ${passed} passed, ${failed} failed`)
if (failed > 0) throw new Error(`${failed} test(s) failed`)
