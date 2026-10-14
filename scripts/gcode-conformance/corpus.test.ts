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
import { CORPUS, caseRunsOnValidator } from './corpus'

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
// without one is unchanged; only the own-axis `A` program may carry a list.

const restrictedCases = CORPUS.filter((entry) => entry.validators !== undefined)
assert.deepEqual(
  restrictedCases.map((entry) => entry.name),
  ['rotary-own-axis-inverse-time'],
  'the own-axis A program is the only case restricted to a validator subset',
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

console.log('gcode-conformance corpus selection tests passed')
