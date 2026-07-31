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
 * Tests for the Visual Mill (.spm) adapter.
 *
 * Run with: npx tsx src/postProcessorConverter/adapters/visualMill.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { visualMillAdapter } from './visualMill'
import { buildMachineDefinition } from '../draft'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const fixturePath = fileURLToPath(new URL('../__fixtures__/visualMill/usbcnc.spm', import.meta.url))
const fixtureText = readFileSync(fixturePath, 'utf8')

const result = visualMillAdapter.convert(fixtureText, fixturePath)
const definition = buildMachineDefinition(result.overrides, {
  id: 'test-visual-mill',
  name: 'Test Visual Mill',
  description: 'Converted from usbcnc.spm',
})

// --- Direct field mappings from the real fixture ---
assert(definition.fileExtension === 'txt', `fileExtension: ${definition.fileExtension}`)
assert(definition.motion.rapidCommand === 'G0', `rapidCommand: ${definition.motion.rapidCommand}`)
assert(definition.motion.linearCommand === 'G1', `linearCommand: ${definition.motion.linearCommand}`)
assert(definition.motion.cwArcCommand === 'G02', `cwArcCommand: ${definition.motion.cwArcCommand}`)
assert(definition.motion.ccwArcCommand === 'G03', `ccwArcCommand: ${definition.motion.ccwArcCommand}`)
assert(definition.motion.arcFormat === 'ij', `arcFormat: ${definition.motion.arcFormat}`)
assert(definition.motion.modalMotion === true, 'modalMotion should be true (GENERAL_ModalGCode = 1)')

assert(definition.feedSpeed.feedCommand === 'F', `feedCommand: ${definition.feedSpeed.feedCommand}`)
assert(definition.feedSpeed.rpmCommand === 'S', `rpmCommand: ${definition.feedSpeed.rpmCommand}`)
assert(definition.feedSpeed.spindleOnCW === 'M3', `spindleOnCW: ${definition.feedSpeed.spindleOnCW}`)
assert(definition.feedSpeed.spindleOnCCW === 'M4', `spindleOnCCW: ${definition.feedSpeed.spindleOnCCW}`)
assert(definition.feedSpeed.spindleOff === 'M5', `spindleOff: ${definition.feedSpeed.spindleOff}`)

assert(definition.units.mmCommand === 'G21', `mmCommand: ${definition.units.mmCommand}`)
assert(definition.units.inchCommand === 'G20', `inchCommand: ${definition.units.inchCommand}`)

assert(definition.numberFormat.leadingZero === false, 'leadingZero should be false (GENERAL_ShowLeadingZeros = 0)')
assert(definition.numberFormat.trailingZeros === false, 'trailingZeros should be false (MOTION_ShowMotionTrailingZeros = 0)')
assert(
  definition.numberFormat.decimalPlaces.mm === 5 && definition.numberFormat.decimalPlaces.inch === 5,
  `decimalPlaces: ${JSON.stringify(definition.numberFormat.decimalPlaces)}`,
)

assert(definition.coolant?.floodOnCommand === 'M08', `floodOnCommand: ${definition.coolant?.floodOnCommand}`)
assert(definition.coolant?.mistOnCommand === 'M07', `mistOnCommand: ${definition.coolant?.mistOnCommand}`)
assert(definition.coolant?.coolantOffCommand === 'M09', `coolantOffCommand: ${definition.coolant?.coolantOffCommand}`)

assert(definition.cannedCycles?.drillCommand === 'G81', `drillCommand: ${definition.cannedCycles?.drillCommand}`)
assert(definition.cannedCycles?.drillWithDwellCommand === 'G82', `drillWithDwellCommand: ${definition.cannedCycles?.drillWithDwellCommand}`)
assert(definition.cannedCycles?.peckDrillCommand === 'G83', `peckDrillCommand: ${definition.cannedCycles?.peckDrillCommand}`)
assert(definition.cannedCycles?.chipBreakDrillCommand === null, 'chipBreakDrillCommand should be null (CYCLES_BreakChip is blank)')
assert(definition.cannedCycles?.peckStepWord === 'Q', `peckStepWord: ${definition.cannedCycles?.peckStepWord}`)
assert(definition.cannedCycles?.cancelCommand === 'G80', `cancelCommand: ${definition.cannedCycles?.cancelCommand}`)

assert(
  definition.toolChange.commands.some((line) => line.includes('{toolNumber}') && line.includes('M06')),
  `toolChange.commands should reference {toolNumber} and M06: ${JSON.stringify(definition.toolChange.commands)}`,
)

assert(definition.program.header.some((line) => line.includes('{unitsCommand}')), `header: ${JSON.stringify(definition.program.header)}`)
assert(definition.program.footer.some((line) => line.includes('M30')), `footer: ${JSON.stringify(definition.program.footer)}`)
assert(definition.stop.programEndCommand === 'M30', `programEndCommand: ${definition.stop.programEndCommand}`)

// --- Report contract ---
assert(result.findings.length > 10, `expected a substantial finding list, got ${result.findings.length}`)
assert(result.findings.some((f) => f.status === 'mapped'), 'expected at least one mapped finding')
assert(result.findings.some((f) => f.status === 'omitted'), 'expected at least one omitted finding')
assert(
  result.findings.some((f) => f.status === 'conflicting' && f.sourceField === 'CIRCLE_Modal'),
  'expected the GENERAL_ModalGCode/CIRCLE_Modal conflict to be reported',
)
assert(
  result.findings.every((f) => !f.blocksStrict),
  `usbcnc.spm fully resolves 3-axis motion; nothing should block --strict: ${JSON.stringify(result.findings.filter((f) => f.blocksStrict))}`,
)
for (const finding of result.findings) {
  assert(finding.message.length > 0, `finding for ${finding.sourceField} has an empty message`)
}

console.log('visualMill.test: all assertions passed')
