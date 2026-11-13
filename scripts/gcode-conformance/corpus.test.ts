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
 * The corpus's per-case validator selection (issue #393).
 *
 * The selection is a pure function so it can be asserted here without running
 * the harness (whose module body exports and validates the corpus). The real
 * validator machine lists live in `run.ts`; the lists used below are synthetic,
 * because the property under test is the *rule* — a case with no `validators`
 * list runs exactly where its machine is claimed, and a restricted case runs
 * only where it is both claimed and named.
 *
 * Run with: npx tsx scripts/gcode-conformance/corpus.test.ts
 */

import assert from 'node:assert/strict'
import { CORPUS, caseRunsOnValidator, renderCase } from './corpus'

// The claims `run.ts` gives each validator, including the #1153 rotary machines.
const GRBL_MACHINES = ['grbl', 'grblhal', 'generic', 'linuxcnc', 'grbl-plasma', 'grbl-rotary']
const LINUXCNC_MACHINES = ['linuxcnc', 'generic', 'linuxcnc-rotary', 'grblhal-rotary']

// ── 1. The rule itself ────────────────────────────────────────

// No list: the machine claim alone, exactly the pre-#393 behaviour.
assert.equal(caseRunsOnValidator({ machineId: 'grbl' }, 'grbl-gvalidate', GRBL_MACHINES), true,
  'an unrestricted case runs on a validator that claims its machine')
assert.equal(caseRunsOnValidator({ machineId: 'mach3' }, 'grbl-gvalidate', GRBL_MACHINES), false,
  'an unrestricted case still runs only where its machine is claimed')

// A list restricts, and the machine claim still applies underneath.
const restricted = { machineId: 'linuxcnc', validators: ['linuxcnc-rs274'] as const }
assert.equal(caseRunsOnValidator(restricted, 'linuxcnc-rs274', LINUXCNC_MACHINES), true,
  'a named validator that claims the machine runs the case')
assert.equal(caseRunsOnValidator(restricted, 'grbl-gvalidate', GRBL_MACHINES), false,
  'a validator that claims the machine but is not named does not')
assert.equal(caseRunsOnValidator({ machineId: 'grbl', validators: ['linuxcnc-rs274'] }, 'linuxcnc-rs274', LINUXCNC_MACHINES), false,
  'naming a validator does not override the machine claim')

// ── 2. Every pre-existing case keeps today's selection ────────
//
// The old filter was `validator.machines.includes(entry.machineId)` and nothing
// else. An absent `validators` list reproduces exactly that, so every case
// without one is unchanged; only the own-axis `A` programs may carry a list
// (the #393 rotary case and the #395 Around pocket, which also writes `A`).

const restrictedCases = CORPUS.filter((entry) => entry.validators !== undefined)
// Since #1153 every own-axis case runs on a bundled rotary machine, on both bar
// axes; the restricted ones are those a validator here can read.
assert.deepEqual(
  restrictedCases.map((entry) => entry.name),
  [
    'rotary-own-axis-inverse-time', 'rotary-own-axis-bar-y-inverse-time',
    'around-pocket-own-axis', 'around-pocket-own-axis-bar-y',
    'rotary-model-rough-own-axis', 'rotary-model-rough-own-axis-bar-y',
    'rotary-grblhal-own-axis', 'rotary-grblhal-own-axis-bar-y',
  ],
  'the own-axis A programs a validator can read are the only cases restricted to a validator subset',
)
for (const entry of restrictedCases) {
  assert.deepEqual(entry.validators, ['linuxcnc-rs274'], `${entry.name} runs only on the LinuxCNC interpreter`)
  assert.equal(caseRunsOnValidator(entry, 'grbl-gvalidate', GRBL_MACHINES), false, `${entry.name} is never fed to Grbl`)
}
// The own-axis machines no interpreter here reads are exported and reported as
// not validated: no validator claims them.
for (const machineId of ['mach3-rotary', 'uccnc-rotary', 'grbl-rotary-a']) {
  const cases = CORPUS.filter((entry) => entry.machineId === machineId)
  assert.equal(cases.length, 2, `${machineId} has a case for each bar axis`)
  for (const entry of cases) {
    for (const [validator, machines] of [['grbl-gvalidate', GRBL_MACHINES], ['linuxcnc-rs274', LINUXCNC_MACHINES]] as const) {
      assert.equal(caseRunsOnValidator(entry, validator, machines), false, `${entry.name} is not claimed by ${validator}`)
    }
  }
}
// No rotary case overrides its machine: each runs on the bundled definition.
for (const entry of CORPUS.filter((candidate) => candidate.machineId.endsWith('-rotary') || candidate.machineId === 'grbl-rotary-a')) {
  assert.equal(entry.definitionOverrides, undefined, `${entry.name} runs on the bundled machine as shipped`)
}

for (const entry of CORPUS) {
  if (entry.validators !== undefined) continue
  for (const machines of [GRBL_MACHINES, LINUXCNC_MACHINES, ['shopbot']]) {
    assert.equal(
      caseRunsOnValidator(entry, 'any-validator', machines),
      machines.includes(entry.machineId),
      `${entry.name} keeps running on exactly the validators that claim ${entry.machineId}`,
    )
  }
}

// ── 3. The own-axis case, specifically ────────────────────────

const ownAxis = restrictedCases[0]
assert.equal(ownAxis.machineId, 'linuxcnc-rotary', 'the own-axis program runs on the bundled LinuxCNC rotary machine')
assert.deepEqual(ownAxis.validators, ['linuxcnc-rs274'], 'and only on the LinuxCNC validator')
assert.equal(caseRunsOnValidator(ownAxis, 'grbl-gvalidate', GRBL_MACHINES), false,
  'Grbl rejects the A word, so the own-axis program is never fed to it')
assert.equal(caseRunsOnValidator(ownAxis, 'fabmo-opensbp', ['shopbot']), false,
  'and the machine claim still keeps it away from a validator that cannot read its dialect')

// ── 4. The model-in-a-bar rotary cases (issue #1015 slice E) ──
//
// Both are generated from the fixture's own rotary toolpath, so each is
// rendered here and asserted to carry the rotary program the case describes:
// the angle word its machine's rotary block defines, and — for a case that
// turns while feeding — the inverse-time pair around that turn. A case whose
// machine lost that block — the mutation the review asked for, changing it to a
// machine without a rotary axis — exports the bar's motion as ordinary linear
// G-code: no angle word, no `G93`, and it would then be validated as if it
// proved something about rotary output.
//
// Both model cases turn while feeding. The rough's along range starts and ends
// inside the bar, and since #1045 slice D the C2-F7 cutter-centre pull starts
// and ends every pass one cutter radius inside the stubbed ends, so the first
// and last sample of a pass are no longer held at the bar's surface: the runs
// reach the pass ends, consecutive passes link at the travel height, and that
// link is a feed move that turns A -- so it needs the inverse-time pair. The
// wrapped form still reaches the export as the A word on every move. (Slice G
// recorded the opposite, no `G93`, when the un-pulled span stopped each run
// short of the pass end and the between-pass move was a rapid.)

const ROTARY_MODEL_CASES: ReadonlyArray<[name: string, machineId: string, angleWord: RegExp, turnsInFeed: boolean]> = [
  ['rotary-model-finish-borrowed-y', 'grbl-rotary', /\bY-?\d/, true],
  ['rotary-model-finish-borrowed-x-bar-y', 'grbl-rotary', /\bX-?\d/, true],
  ['rotary-model-rough-own-axis', 'linuxcnc-rotary', /\bA-?\d/, true],
  ['rotary-model-rough-own-axis-bar-y', 'linuxcnc-rotary', /\bA-?\d/, true],
]

for (const [name, machineId, angleWord, turnsInFeed] of ROTARY_MODEL_CASES) {
  const entry = CORPUS.find((candidate) => candidate.name === name)
  assert.ok(entry, `${name} is registered in the corpus`)
  assert.equal(entry.machineId, machineId, `${name} runs on the ${machineId} machine definition`)
  const { gcode, warnings } = renderCase(entry)
  assert.deepEqual(warnings, [], `${name} exports without warnings`)
  assert.match(gcode, angleWord, `${name} writes the angle under its machine's rotary word`)
  if (turnsInFeed) {
    assert.match(gcode, /\bG93\b/, `${name} turns in inverse time, so the rotary block reached the export`)
    assert.match(gcode, /\bG94\b/, `${name} leaves inverse time again (rule 4)`)
  } else {
    assert.doesNotMatch(gcode, /\bG93\b/, `${name} never turns while feeding, so it needs no inverse time`)
    const angles = new Set([...gcode.matchAll(/\bA(-?\d+(?:\.\d+)?)\b/g)].map((match) => match[1]))
    assert.ok(angles.size >= 5, `${name} turns the bar over several layers (${angles.size} distinct A values)`)
  }
}
const rotaryFinishBorrowed = CORPUS.find((entry) => entry.name === 'rotary-model-finish-borrowed-y')
const rotaryRoughOwnAxis = CORPUS.find((entry) => entry.name === 'rotary-model-rough-own-axis')
assert.ok(rotaryFinishBorrowed && rotaryRoughOwnAxis)
assert.equal(caseRunsOnValidator(rotaryFinishBorrowed, 'grbl-gvalidate', GRBL_MACHINES), true,
  'the borrowed-motor model case runs wherever Grbl is claimed')
assert.equal(caseRunsOnValidator(rotaryRoughOwnAxis, 'grbl-gvalidate', GRBL_MACHINES), false,
  'the own-axis model case is never fed to Grbl, which rejects the A word')
assert.equal(caseRunsOnValidator(rotaryRoughOwnAxis, 'linuxcnc-rs274', LINUXCNC_MACHINES), true,
  'and it runs on the LinuxCNC validator')

// ── 5. The wrapped and hand-built rotary fixtures declare their type ──
//
// Since #1028 the project type is stored on the project and read by the
// generation gate, and `newProject` defaults it to `'milling'`. A round bar
// alone no longer makes a project rotary, so a corpus fixture that set round
// stock without declaring the type generated nothing: the Around cases threw
// `aroundStockMismatch` before any export. Each fixture now declares
// `'rotary'`, and rendering the case here pins that declaration — the
// borrowed motor's angle word, the own axis's `A`, and the inverse-time pair
// around each turn.
//
// Removing a wrapped fixture's declaration makes `renderCase` throw on the
// first call, so this section is the regression that fails for that mutation.

const ROTARY_FAMILY_CASES: ReadonlyArray<[name: string, angleWord: RegExp]> = [
  ['rotary-borrowed-y-inverse-time', /\bY-?\d/],
  ['rotary-borrowed-x-bar-y-inverse-time', /\bX-?\d/],
  ['rotary-own-axis-inverse-time', /\bA-?\d/],
  ['rotary-own-axis-bar-y-inverse-time', /\bA-?\d/],
  ['around-engrave-borrowed-y', /\bY-?\d/],
  ['around-engrave-borrowed-x-bar-y', /\bX-?\d/],
  ['around-pocket-own-axis', /\bA-?\d/],
  ['around-pocket-own-axis-bar-y', /\bA-?\d/],
  ...(['', '-bar-y'] as const).flatMap((suffix): Array<[string, RegExp]> => [
    [`rotary-grblhal-own-axis${suffix}`, /\bA-?\d/],
    [`rotary-mach3-own-axis${suffix}`, /\bA-?\d/],
    [`rotary-uccnc-own-axis${suffix}`, /\bA-?\d/],
    [`rotary-grbl-fork-own-axis${suffix}`, /\bA-?\d/],
  ]),
]

// A borrowed motor's letter carries only angles, whichever axis the bar lies
// along (#1153): the turning cases write 0, 90 and the closing whole turn, and
// never the bar's 10 mm centreline as a linear word.
for (const [name, letter] of [['rotary-borrowed-y-inverse-time', 'Y'], ['rotary-borrowed-x-bar-y-inverse-time', 'X']] as const) {
  const entry = CORPUS.find((candidate) => candidate.name === name)
  assert.ok(entry, `${name} is registered in the corpus`)
  const values = [...renderCase(entry).gcode.matchAll(new RegExp(`\\b${letter}(-?\\d+(?:\\.\\d+)?)`, 'g'))].map((match) => Number(match[1]))
  assert.ok(values.length > 0, `${name} writes ${letter}`)
  assert.ok(values.every((value) => value % 90 === 0), `${name}: every ${letter} word is an angle (${values.join(', ')})`)
}

for (const [name, angleWord] of ROTARY_FAMILY_CASES) {
  const entry = CORPUS.find((candidate) => candidate.name === name)
  assert.ok(entry, `${name} is registered in the corpus`)
  const { gcode, warnings } = renderCase(entry)
  assert.deepEqual(warnings, [], `${name} exports without warnings`)
  assert.match(gcode, angleWord, `${name} writes the angle under its machine's rotary word`)
  assert.match(gcode, /\bG93\b/, `${name} turns in inverse time, so the rotary block reached the export`)
  assert.match(gcode, /\bG94\b/, `${name} leaves inverse time again (rule 4)`)
  if (name.startsWith('around-')) {
    assert.match(gcode, /SETUP 01: Around/, `${name} carries the Around setup header`)
  }
}

console.log('gcode-conformance corpus selection tests passed')
