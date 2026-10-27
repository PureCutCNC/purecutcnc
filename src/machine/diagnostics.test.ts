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
 * The one-string load-warning surface (#1119). Run with:
 *   npx tsx src/machine/diagnostics.test.ts
 *
 * The alert is the only place a machine that was rescued, re-keyed or
 * consolidated is named at open time, so `info` reports belong in it.
 */

import { machineLoadWarning, type MachineLoadDiagnostic } from './diagnostics'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const retained: MachineLoadDiagnostic = {
  severity: 'warning',
  kind: 'machine-retained-invalid',
  machineId: 'avid-mach4',
  machineName: 'Avid Mach4',
  message: 'The machine "Avid Mach4" was kept and stays selected, but its templates break a machine-template rule. G-code export is blocked until it is corrected.',
}

const moved: MachineLoadDiagnostic = {
  severity: 'info',
  kind: 'machine-moved-to-library',
  message: 'Machine "Shop Router" was moved to My Machines so opening this project cannot lose it.',
}

const consolidated: MachineLoadDiagnostic = {
  severity: 'info',
  kind: 'machine-consolidated',
  message: 'Machine "Shop Router" appears more than once in this project; the duplicate was merged.',
}

assert(machineLoadWarning([]) === null, 'no diagnostics produce no warning')

const warning = machineLoadWarning([retained, moved, consolidated])
assert(warning !== null, 'the warning exists')
assert(warning!.includes('Avid Mach4'), 'the retained-invalid machine is named')
assert(warning!.includes('export is blocked'), 'the warning says export needs a fix')
assert(warning!.includes('moved to My Machines'), 'a rescue move is named')
assert(warning!.includes('duplicate was merged'), 'a consolidation is named')
assert(
  warning!.split('\n\n').length === 3,
  'each report is its own paragraph, not one run-on line',
)

console.log('machine load warning tests passed')
