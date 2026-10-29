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

import { clearCannedShapeCache, getCannedShapeGenerator, resolveCannedShapeProfiles } from './index'
import { cachedCannedShapeOutlines, cannedParamsKey } from './cache'
import { defaultGearCreationParams } from '../sketch/gearProfile'
import type { CannedShapeParams } from '../types/project'
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

// ── Every parameter of every kind is part of the cache key ─────────
//
// A preview edits one field at a time, so a parameter missing from the key is a
// shape that will not move when that field changes: the generator would hand
// back the previous outlines from the cache. One representative parameter set
// per kind is mutated at every leaf (including inside the stored bar frame) and
// must both serialize to a different key and miss the entry.

const BAR_FRAME = { axis: 'x' as const, thickness: 40, alongMin: 10, alongMax: 210, acrossCentre: 30 }
const PATTERN_FRAME = {
  axis: 'x' as const,
  zero: 0,
  circumference: 2 * Math.PI * 20,
  radius: 20,
  alongOrigin: 10,
  alongDirection: 1 as const,
}

/** One complete, valid parameter set per registered kind. */
const KIND_PARAMS: Record<string, CannedShapeParams> = {
  ellipse: { rx: 30, ry: 20 },
  slot: { length: 60, width: 10 },
  ngon: { sides: 6, size: 20, rotation: 15 },
  roundrect: { width: 60, height: 30, radius: 6 },
  chamferrect: { width: 60, height: 30, chamfer: 6 },
  gear: { ...defaultGearCreationParams(30), outsideRadius: 30 },
  thread: { start: 5, length: 20, pitch: 2, starts: 1, depth: 1, hand: 'right', frame: PATTERN_FRAME },
  flutes: { start: 5, length: 20, count: 4, twist: 0, depth: 1, frame: PATTERN_FRAME },
  turn: { start: 0, length: 40, diameter: 20, segments: 64, frame: BAR_FRAME },
  polygon: { start: 10, length: 20, sides: 6, acrossFlats: 15, rotation: 0, frame: BAR_FRAME },
}

type ParamContainer = Record<string, unknown>

/** Every leaf of a parameter set as a key path, nested objects and arrays included. */
function leafPaths(value: ParamContainer): string[][] {
  const paths: string[][] = []
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== null && typeof entry === 'object') {
      for (const path of leafPaths(entry as ParamContainer)) paths.push([key, ...path])
    } else {
      paths.push([key])
    }
  }
  return paths
}

/** A copy of `params` with one leaf replaced by a different value. */
function withLeafChanged(params: CannedShapeParams, path: string[], index: number): CannedShapeParams {
  const copy = structuredClone(params) as ParamContainer
  let container = copy
  for (const key of path.slice(0, -1)) container = container[key] as ParamContainer
  const leaf = path[path.length - 1]
  const current = container[leaf]
  // A distinct, still well-shaped value: a unit larger for numbers, the other
  // choice for the enum-like strings a generator stores.
  container[leaf] = typeof current === 'number'
    ? current + 1 + index / 100
    : typeof current === 'boolean'
      ? !current
      : current === 'left' ? 'right' : current === 'right' ? 'left' : `${String(current)}-other`
  return copy as CannedShapeParams
}

for (const [kind, sample] of Object.entries(KIND_PARAMS)) {
  test(`${kind}: every parameter reaches the cache key`, () => {
    const generator = getCannedShapeGenerator(kind)
    assert(generator, `${kind} is a registered generator`)
    const normalized = generator.normalizeParams
      ? generator.normalizeParams(sample)
      : sample
    assert(normalized, `${kind}: the representative parameter set is valid`)
    assert(
      JSON.stringify(Object.keys(normalized).sort()) === JSON.stringify(Object.keys(sample).sort()),
      `${kind}: the sample carries every parameter (stored ${Object.keys(normalized).sort().join(',')}, `
        + `sample ${Object.keys(sample).sort().join(',')})`,
    )

    const primed = cachedCannedShapeOutlines(generator, normalized)
    const primedKey = cannedParamsKey(normalized)
    const paths = leafPaths(sample as ParamContainer)
    assert(paths.length > 0, `${kind}: the sample has parameters to change`)
    paths.forEach((path, index) => {
      const changed = withLeafChanged(sample, path, index)
      const changedKey = cannedParamsKey(changed)
      assert(
        changedKey !== primedKey,
        `${kind}.${path.join('.')} is missing from the cache key`,
      )
      const cached = cachedCannedShapeOutlines(generator, changed)
      assert(
        cached !== primed,
        `${kind}.${path.join('.')}: the changed parameter served the cached outlines`,
      )
    })
  })
}

if (failCount > 0) {
  console.error(`\n${failCount} test(s) failed, ${passCount} passed`)
  process.exit(1)
}
console.log(`\nAll ${passCount} canned-shape cache tests passed`)
