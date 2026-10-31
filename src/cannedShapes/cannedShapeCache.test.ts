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
 * Canned-shape regeneration cache (issue #1112 A2).
 *
 * Run with: npx tsx src/cannedShapes/cannedShapeCache.test.ts
 *
 * Hover, selection and redraw each resolve the same definition, so three
 * resolutions must call the generator once. A parameter change is a different
 * cache key and calls it again; registering a replacement generator clears the
 * kind's entries.
 */

import { clearCannedShapeCache, resolveCannedShapeProfiles } from './index'
import {
  registerTestCannedShapes,
  resetTestPlateGenerateCalls,
  testPlateCanned,
  testPlateGenerateCalls,
  TEST_PLATE_KIND,
} from '../test/cannedShapeFixture'

registerTestCannedShapes()

let passCount = 0
let failCount = 0

function test(name: string, fn: () => void): void {
  try {
    clearCannedShapeCache()
    fn()
    console.log(`✓ ${name}`)
    passCount += 1
  } catch (error) {
    console.error(`✗ ${name}`)
    console.error(`  ${(error as Error).message}`)
    failCount += 1
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

test('three resolutions call the generator once', () => {
  resetTestPlateGenerateCalls()
  const feature = { operation: 'add' as const, canned: testPlateCanned(100, 60, 12) }

  const first = resolveCannedShapeProfiles(feature)
  const second = resolveCannedShapeProfiles(feature)
  const third = resolveCannedShapeProfiles(feature)

  assert(first.length === 2, 'the plate resolves its two outlines')
  assert(second.length === 2 && third.length === 2, 'every resolution returns the outlines')
  assert(testPlateGenerateCalls === 1, `expected one generator call, got ${testPlateGenerateCalls}`)
})

test('the cache is keyed on the parameters, not the definition object', () => {
  resetTestPlateGenerateCalls()
  resolveCannedShapeProfiles({ operation: 'add', canned: testPlateCanned(100, 60, 12) })
  resolveCannedShapeProfiles({ operation: 'add', canned: testPlateCanned(100, 60, 12) })
  assert(testPlateGenerateCalls === 1, 'an equal parameter set reuses the entry')

  resolveCannedShapeProfiles({ operation: 'add', canned: testPlateCanned(120, 60, 12) })
  assert((testPlateGenerateCalls as number) === 2, 'changed parameters miss the cache')
})

test('a kind is invalidated when a replacement generator registers', () => {
  resetTestPlateGenerateCalls()
  resolveCannedShapeProfiles({ operation: 'add', canned: testPlateCanned(100, 60, 12) })
  assert(testPlateGenerateCalls === 1, 'primed the cache')

  registerTestCannedShapes()
  resolveCannedShapeProfiles({ operation: 'add', canned: testPlateCanned(100, 60, 12) })
  assert((testPlateGenerateCalls as number) === 2, 'registration dropped the stale entry')
})

test('parameter key order does not defeat the cache', () => {
  resetTestPlateGenerateCalls()
  resolveCannedShapeProfiles({
    operation: 'add',
    canned: { kind: TEST_PLATE_KIND, params: { width: 100, height: 60, holeRadius: 12 } },
  })
  resolveCannedShapeProfiles({
    operation: 'add',
    canned: { kind: TEST_PLATE_KIND, params: { holeRadius: 12, width: 100, height: 60 } },
  })
  assert(testPlateGenerateCalls === 1, 'reordered keys are the same parameters')
})

if (failCount > 0) {
  console.error(`\n${failCount} test(s) failed, ${passCount} passed`)
  process.exit(1)
}
console.log(`\nAll ${passCount} canned-shape cache tests passed`)
