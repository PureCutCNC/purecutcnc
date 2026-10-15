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

const GRBL_MACHINES = ['grbl', 'grblhal', 'generic', 'linuxcnc', 'grbl-plasma']
const LINUXCNC_MACHINES = ['linuxcnc', 'generic']

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
assert.deepEqual(
  restrictedCases.map((entry) => entry.name),
  ['rotary-own-axis-inverse-time', 'around-pocket-own-axis', 'rotary-model-rough-own-axis'],
  'the own-axis A programs are the only cases restricted to a validator subset',
)

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
assert.equal(ownAxis.machineId, 'linuxcnc', 'the own-axis program runs on the LinuxCNC machine definition')
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
// The rough case no longer turns while feeding (issue #1015 slice G). Its along
// range starts and ends inside the bar, so the retained-bar stubs hold the first
// and last sample of every pass at the bar's surface: no layer cuts them, each
// pass's runs stop short of the pass ends, and the tool retracts and turns there
// instead of linking. The retract is to the bar's surface plus a clearance, not
// to `safeRadius` (slice H) -- still a rapid, so still no `G93`. The wrapped form
// still reaches the export as the A word on every move. The finish cuts the
// model's own ends (a `NaN` sample is simply not cut), so it keeps its turning
// links.

const ROTARY_MODEL_CASES: ReadonlyArray<[name: string, machineId: string, angleWord: RegExp, turnsInFeed: boolean]> = [
  ['rotary-model-finish-borrowed-y', 'grbl', /\bY-?\d/, true],
  ['rotary-model-rough-own-axis', 'linuxcnc', /\bA-?\d/, false],
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
  ['rotary-own-axis-inverse-time', /\bA-?\d/],
  ['around-engrave-borrowed-y', /\bY-?\d/],
  ['around-pocket-own-axis', /\bA-?\d/],
]

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
