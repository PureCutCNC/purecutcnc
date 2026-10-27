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
 * The five flat canned generators (issue #1112 slice D).
 *
 * Run with: npx tsx src/cannedShapes/generators/shapes.test.ts
 *
 * The generator-level properties: the outline is the same profile constructor
 * the old one-shot command used (at local coordinates), parameter validation
 * refuses nonsense instead of drawing a degenerate shape, unit conversion
 * converts exactly the length fields, and generation is deterministic so a
 * saved file regenerates the same geometry.
 *
 * Equivalence through the real creation path (store action → resolved world
 * geometry) lives in `src/store/cannedShapeCreation.test.ts`.
 */

import {
  ellipseProfile,
  ngonProfile,
  slotProfile,
  type CannedShapeParams,
  type SketchProfile,
} from '../../types/project'
import { chamferedRectProfile, roundedRectProfile } from '../../store/helpers/cannedRectProfiles'
import { ellipseCannedShape } from './ellipse'
import { slotCannedShape } from './slot'
import { ngonCannedShape } from './ngon'
import { roundRectCannedShape } from './roundRect'
import { chamferRectCannedShape } from './chamferRect'
import { BUILT_IN_CANNED_SHAPES } from './index'
import { editorInitialValues, editorParamsFromValues } from './editorForm'
import { ELLIPSE_EDITOR_REQUEST } from './ellipse'
import { SLOT_EDITOR_REQUEST } from './slot'
import { NGON_EDITOR_REQUEST } from './ngon'
import { ROUND_RECT_EDITOR_REQUEST } from './roundRect'
import { CHAMFER_RECT_EDITOR_REQUEST } from './chamferRect'

let passCount = 0
let failCount = 0

function test(name: string, fn: () => void): void {
  try {
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

function assertEqual<T>(actual: T, expected: T, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${message}\n  Expected: ${JSON.stringify(expected)}\n  Actual: ${JSON.stringify(actual)}`)
  }
}

/** Same segment kinds and same coordinates; generation must not drift. */
function assertSameProfile(actual: SketchProfile, expected: SketchProfile, label: string): void {
  assertEqual(actual.segments.map((segment) => segment.type), expected.segments.map((segment) => segment.type), `${label}: segment kinds`)
  assertEqual(actual.closed, expected.closed, `${label}: closed`)
  assertEqual(actual, expected, `${label}: profile`)
}

const params = (value: Record<string, number>): CannedShapeParams => value

test('the built-in list registers every flat shape once', () => {
  // Other slices append their own generators (slice E adds the gear), so assert
  // on the flat shapes rather than on the whole list.
  const kinds = BUILT_IN_CANNED_SHAPES.map((generator) => generator.kind)
  for (const kind of ['chamferrect', 'ellipse', 'ngon', 'roundrect', 'slot']) {
    assertEqual(kinds.filter((registered) => registered === kind).length, 1, `${kind} registered once`)
  }
  assertEqual(new Set(kinds).size, kinds.length, 'no kind registered twice')
})

test('ellipse generates the four-Bézier ellipse and refuses non-positive radii', () => {
  const paramsValue = params({ rx: 30, ry: 20 })
  const generated = ellipseCannedShape.generate(paramsValue)
  assertSameProfile(generated[0].profile, ellipseProfile(0, 0, 30, 20), 'ellipse')
  assert(ellipseCannedShape.normalizeParams!(params({ rx: 0, ry: 20 })) === null, 'zero radius refused')
  assert(ellipseCannedShape.normalizeParams!(params({ rx: -1, ry: 20 })) === null, 'negative radius refused')
  assert(ellipseCannedShape.normalizeParams!(params({ rx: 30 })) === null, 'missing radius refused')
  assertEqual(ellipseCannedShape.summary(paramsValue).key, 'canned.ellipse.summary', 'summary key')
})

test('slot draws the stadium along local +X and refuses a zero length or width', () => {
  const generated = slotCannedShape.generate(params({ length: 80, width: 10 }))
  assertSameProfile(generated[0].profile, slotProfile({ x: -40, y: 0 }, { x: 40, y: 0 }, 10), 'slot')
  assert(slotCannedShape.normalizeParams!(params({ length: 0, width: 10 })) === null, 'zero length refused')
  assert(slotCannedShape.normalizeParams!(params({ length: 80, width: 0 })) === null, 'zero width refused')
})

test('regular polygon draws ngonProfile at the stored rotation and rounds its side count', () => {
  const generated = ngonCannedShape.generate(params({ sides: 6, size: 20, rotation: 30 }))
  assertSameProfile(
    generated[0].profile,
    ngonProfile(0, 0, 6, 20, (30 * Math.PI) / 180),
    'polygon',
  )
  const rounded = ngonCannedShape.normalizeParams!(params({ sides: 6.4, size: 20, rotation: 0 }))
  assert(rounded !== null && rounded.sides === 6, 'side count is rounded')
  assert(ngonCannedShape.normalizeParams!(params({ sides: 2, size: 20, rotation: 0 })) === null, 'too few sides refused')
  assert(ngonCannedShape.normalizeParams!(params({ sides: 51, size: 20, rotation: 0 })) === null, 'too many sides refused')
})

test('rounded rectangle uses roundedRectProfile from the local origin', () => {
  const generated = roundRectCannedShape.generate(params({ width: 80, height: 40, radius: 5 }))
  assertSameProfile(generated[0].profile, roundedRectProfile({ x: 0, y: 0 }, { x: 80, y: 40 }, 5), 'rounded rect')
  // The helper clamps the radius; the generator must keep that clamp.
  const clamped = roundRectCannedShape.generate(params({ width: 10, height: 10, radius: 100 }))
  assertSameProfile(clamped[0].profile, roundedRectProfile({ x: 0, y: 0 }, { x: 10, y: 10 }, 100), 'clamped radius')
  assert(roundRectCannedShape.normalizeParams!(params({ width: 10, height: 10, radius: -1 })) === null, 'negative radius refused')
})

test('chamfered rectangle uses chamferedRectProfile from the local origin', () => {
  const generated = chamferRectCannedShape.generate(params({ width: 80, height: 40, chamfer: 5 }))
  assertSameProfile(generated[0].profile, chamferedRectProfile({ x: 0, y: 0 }, { x: 80, y: 40 }, 5), 'chamfered rect')
  const clamped = chamferRectCannedShape.generate(params({ width: 10, height: 10, chamfer: 100 }))
  assertSameProfile(clamped[0].profile, chamferedRectProfile({ x: 0, y: 0 }, { x: 10, y: 10 }, 100), 'clamped chamfer')
})

test('unit conversion changes lengths only, never a side count or an angle', () => {
  const mmToInch = (value: number): number => value / 25.4
  assertEqual(
    ellipseCannedShape.convertParams!(params({ rx: 25.4, ry: 50.8 }), mmToInch),
    { rx: 1, ry: 2 },
    'ellipse radii',
  )
  assertEqual(
    slotCannedShape.convertParams!(params({ length: 25.4, width: 12.7 }), mmToInch),
    { length: 1, width: 0.5 },
    'slot length and width',
  )
  assertEqual(
    ngonCannedShape.convertParams!(params({ sides: 6, size: 25.4, rotation: 30 }), mmToInch),
    { sides: 6, size: 1, rotation: 30 },
    'polygon size only',
  )
  assertEqual(
    roundRectCannedShape.convertParams!(params({ width: 25.4, height: 50.8, radius: 12.7 }), mmToInch),
    { width: 1, height: 2, radius: 0.5 },
    'rounded rect lengths',
  )
  assertEqual(
    chamferRectCannedShape.convertParams!(params({ width: 25.4, height: 50.8, chamfer: 12.7 }), mmToInch),
    { width: 1, height: 2, chamfer: 0.5 },
    'chamfered rect lengths',
  )
})

test('generation is deterministic for the same parameters', () => {
  // This file covers the five flat shapes; the gear and the rotary shapes have
  // their own generator tests (gear.test.ts, thread.test.ts, flutes.test.ts).
  const flatKinds = new Set(['ngon', 'ellipse', 'slot', 'roundrect', 'chamferrect'])
  let checked = 0
  for (const generator of BUILT_IN_CANNED_SHAPES) {
    if (!flatKinds.has(generator.kind)) continue
    checked += 1
    const value = generator.kind === 'ngon'
      ? params({ sides: 7, size: 12, rotation: 15 })
      : generator.kind === 'ellipse'
        ? params({ rx: 12, ry: 7 })
        : generator.kind === 'slot'
          ? params({ length: 30, width: 6 })
          : generator.kind === 'roundrect'
            ? params({ width: 30, height: 20, radius: 4 })
            : params({ width: 30, height: 20, chamfer: 4 })
    assertEqual(
      JSON.stringify(generator.generate(value)),
      JSON.stringify(generator.generate(value)),
      `${generator.kind}: same input, same outline`,
    )
  }
  assertEqual(checked, flatKinds.size, 'every flat shape was checked')
})

// ── The Edit <shape>… form (pure half) ──────────────────────────────

test('the edit form opens with the stored values, for every shape', () => {
  const cases: Array<[typeof ELLIPSE_EDITOR_REQUEST, Record<string, number>, Record<string, string>]> = [
    [ELLIPSE_EDITOR_REQUEST, { rx: 30, ry: 20 }, { rx: '30', ry: '20' }],
    [SLOT_EDITOR_REQUEST, { length: 80, width: 10 }, { length: '80', width: '10' }],
    [NGON_EDITOR_REQUEST, { sides: 6, size: 20, rotation: 15 }, { sides: '6', size: '20', rotation: '15' }],
    [ROUND_RECT_EDITOR_REQUEST, { width: 80, height: 40, radius: 5 }, { width: '80', height: '40', radius: '5' }],
    [CHAMFER_RECT_EDITOR_REQUEST, { width: 80, height: 40, chamfer: 5 }, { width: '80', height: '40', chamfer: '5' }],
  ]
  for (const [request, stored, expected] of cases) {
    assertEqual(editorInitialValues(request, params(stored)), expected, `${request.kind}: current values`)
  }
})

test('the edit form reads numbers back, rounds an integer field, and refuses an empty field', () => {
  assertEqual(
    editorParamsFromValues(NGON_EDITOR_REQUEST, { sides: '7.6', size: '20', rotation: '15' }),
    { sides: 8, size: 20, rotation: 15 },
    'side count is rounded',
  )
  assertEqual(
    editorParamsFromValues(ELLIPSE_EDITOR_REQUEST, { rx: '30', ry: '20' }),
    { rx: 30, ry: 20 },
    'plain numbers',
  )
  assert(editorParamsFromValues(ELLIPSE_EDITOR_REQUEST, { rx: '', ry: '20' }) === null, 'empty field refused')
  assert(editorParamsFromValues(ELLIPSE_EDITOR_REQUEST, { rx: 'wide', ry: '20' }) === null, 'non-number refused')
})

test('the edit form cannot save a value the generator would refuse', () => {
  const values = editorParamsFromValues(NGON_EDITOR_REQUEST, { sides: '2', size: '20', rotation: '0' })
  assert(values !== null, 'the fields parse')
  assert(NGON_EDITOR_REQUEST.normalize(values!) === null, 'two sides is refused by the generator rule')
  const good = editorParamsFromValues(NGON_EDITOR_REQUEST, { sides: '6', size: '20', rotation: '0' })
  assert(NGON_EDITOR_REQUEST.normalize(good!) !== null, 'six sides is accepted')
})

console.log(`\n${passCount} passed, ${failCount} failed`)
if (failCount > 0) {
  process.exitCode = 1
}
