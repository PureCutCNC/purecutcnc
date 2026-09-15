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
 * STEP declared-unit detection (issue #784).
 *
 * The case that matters most is the inch file: it also defines the millimetre
 * unit its inch conversion is built from. Counting every `LENGTH_UNIT` would
 * call it mixed, and a mixed file is converted to millimetres — the inch
 * default would silently disappear from the dialog.
 *
 * Run with: npx tsx src/import/stepUnits.test.ts
 */

import { stepFile, type StepFixtureUnit } from '../test/stepFixtures'
import { detectStepLengthUnits, inspectStepFileUnits, inspectStepUnits } from './stepUnits'

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
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`   ✗ ${name}: ${msg}`)
  }
}

function sameList(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, i) => value === expected[i])
}

function unitFile(unit: StepFixtureUnit): string {
  return stepFile([{ kind: 'box', min: [0, 0, 0], max: [1, 1, 1] }], { unit })
}

function dataSection(statements: readonly string[]): string {
  return ['ISO-10303-21;', 'HEADER;', 'ENDSEC;', 'DATA;', ...statements, 'ENDSEC;', 'END-ISO-10303-21;'].join('\n')
}

console.log('stepUnits')

test('SI prefixes of the metre map to their symbols', () => {
  for (const [unit, symbol] of [['mm', 'mm'], ['cm', 'cm'], ['m', 'm']] as const) {
    const detected = detectStepLengthUnits(unitFile(unit))
    assert(sameList(detected, [symbol]), `${unit}: ${JSON.stringify(detected)}`)
  }
})

test('an inch file is inch, not mixed with the millimetre its conversion is built from', () => {
  const text = unitFile('inch')
  assert(text.includes('SI_UNIT(.MILLI.,.METRE.)'), 'the fixture defines the millimetre base unit')
  const detected = detectStepLengthUnits(text)
  assert(sameList(detected, ['in']), JSON.stringify(detected))
})

test('a foot file is foot', () => {
  const detected = detectStepLengthUnits(unitFile('foot'))
  assert(sameList(detected, ['ft']), JSON.stringify(detected))
})

test('a file whose context assigns no units declares none', () => {
  const detected = detectStepLengthUnits(unitFile('none'))
  assert(detected.length === 0, JSON.stringify(detected))
})

test('units assigned by different contexts are all reported, in file order', () => {
  const text = dataSection([
    '#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
    "#2 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#1)) REPRESENTATION_CONTEXT('a','b') );",
    "#3 = ( CONVERSION_BASED_UNIT('INCH',#4) LENGTH_UNIT() NAMED_UNIT(#5) );",
    '#4 = LENGTH_MEASURE_WITH_UNIT(LENGTH_MEASURE(25.4),#1);',
    '#5 = DIMENSIONAL_EXPONENTS(1.,0.,0.,0.,0.,0.,0.);',
    "#6 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#3)) REPRESENTATION_CONTEXT('c','d') );",
  ])
  const detected = detectStepLengthUnits(text)
  assert(sameList(detected, ['mm', 'in']), JSON.stringify(detected))
})

test('a unit defined after the context that assigns it still resolves', () => {
  const text = dataSection([
    "#1 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#9)) REPRESENTATION_CONTEXT('a','b') );",
    '#9 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.CENTI.,.METRE.) );',
  ])
  const detected = detectStepLengthUnits(text)
  assert(sameList(detected, ['cm']), JSON.stringify(detected))
})

test('a semicolon or an assignment inside a quoted string is not code', () => {
  const text = dataSection([
    "#1 = PRODUCT('a;b','it''s; GLOBAL_UNIT_ASSIGNED_CONTEXT((#9))','',());",
    "#2 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#3)) REPRESENTATION_CONTEXT('Context #1; UNIT','x') );",
    '#3 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) );',
    '#9 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
  ])
  const detected = detectStepLengthUnits(text)
  assert(sameList(detected, ['m']), JSON.stringify(detected))
})

test('an apostrophe inside a comment does not swallow the statements after it', () => {
  const text = dataSection([
    "#1 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#2)) REPRESENTATION_CONTEXT('a','b') );",
    "/* the exporter's note; still a comment */",
    '#2 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
  ])
  const detected = detectStepLengthUnits(text)
  assert(sameList(detected, ['mm']), JSON.stringify(detected))
})

test('inspection: declared millimetres tessellate unconverted and default the source units', () => {
  const inspection = inspectStepUnits(unitFile('mm'))
  assert(inspection.outputUnit === 'mm', inspection.outputUnit)
  assert(inspection.defaultSourceUnits === 'mm', String(inspection.defaultSourceUnits))
  assert(!inspection.convertedToMm, 'no conversion note')
})

test('inspection: declared inches tessellate in inches and default the source units', () => {
  const inspection = inspectStepUnits(unitFile('inch'))
  assert(inspection.outputUnit === 'inch', inspection.outputUnit)
  assert(inspection.defaultSourceUnits === 'inch', String(inspection.defaultSourceUnits))
  assert(!inspection.convertedToMm, 'no conversion note')
})

test('inspection: any other declared unit converts to millimetres, and says so', () => {
  for (const [unit, symbol] of [['cm', 'cm'], ['m', 'm'], ['foot', 'ft']] as const) {
    const inspection = inspectStepUnits(unitFile(unit))
    assert(inspection.outputUnit === 'mm', `${unit}: ${inspection.outputUnit}`)
    assert(inspection.defaultSourceUnits === 'mm', `${unit}: ${String(inspection.defaultSourceUnits)}`)
    assert(inspection.convertedToMm, `${unit}: conversion note`)
    assert(sameList(inspection.declaredUnits, [symbol]), `${unit}: ${JSON.stringify(inspection.declaredUnits)}`)
  }
})

test('inspection: an undeclared file leaves the source units to the user', () => {
  const inspection = inspectStepUnits(unitFile('none'))
  assert(inspection.defaultSourceUnits === null, String(inspection.defaultSourceUnits))
  assert(!inspection.convertedToMm, 'nothing was converted')
})

test('inspection: mixed declarations convert to millimetres', () => {
  const text = dataSection([
    '#1 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) );',
    '#2 = ( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT($,.METRE.) );',
    "#3 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#1)) REPRESENTATION_CONTEXT('a','b') );",
    "#4 = ( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNIT_ASSIGNED_CONTEXT((#2)) REPRESENTATION_CONTEXT('c','d') );",
  ])
  const inspection = inspectStepUnits(text)
  assert(inspection.outputUnit === 'mm' && inspection.defaultSourceUnits === 'mm', JSON.stringify(inspection))
  assert(inspection.convertedToMm, 'conversion note')
})

test('the byte entry point reads the file', () => {
  const inspection = inspectStepFileUnits(new TextEncoder().encode(unitFile('inch')).buffer)
  assert(sameList(inspection.declaredUnits, ['in']), JSON.stringify(inspection.declaredUnits))
})

console.log(`\n${passed} passed, ${failed} failed${failed > 0 ? ' ❌' : ' ✓'}\n`)

if (failed > 0) throw new Error(`${failed} test(s) failed`)
