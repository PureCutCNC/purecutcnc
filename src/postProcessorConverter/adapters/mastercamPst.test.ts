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
 * Tests for the Mastercam (.pst) static extractor.
 *
 * Run with: npx tsx src/postProcessorConverter/adapters/mastercamPst.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mastercamPstAdapter } from './mastercamPst'
import { buildMachineDefinition } from '../draft'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const fixturePath = fileURLToPath(new URL('../__fixtures__/mastercamPst/edingcnc-mastercam.pst', import.meta.url))
const fixtureText = readFileSync(fixturePath, 'utf8')

const result = mastercamPstAdapter.convert(fixtureText, fixturePath)
const definition = buildMachineDefinition(result.overrides, {
  id: 'test-mastercam',
  name: 'Test Mastercam',
  description: 'Converted from edingcnc-mastercam.pst',
})

// --- Confidently derivable from the flat control-switch section and the sgXX/smXX string-select table ---
assert(definition.motion.arcFormat === 'r', `arcFormat: ${definition.motion.arcFormat} (arcoutput = 1 -> "r")`)
assert(definition.program.lineNumbers === false, `lineNumbers: ${definition.program.lineNumbers} (omitseq = yes -> line numbers off)`)
assert(definition.motion.rapidCommand === 'G0', `rapidCommand: ${definition.motion.rapidCommand} (sg00)`)
assert(definition.motion.linearCommand === 'G1', `linearCommand: ${definition.motion.linearCommand} (sg01)`)
assert(definition.motion.cwArcCommand === 'G2', `cwArcCommand: ${definition.motion.cwArcCommand} (sg02)`)
assert(definition.motion.ccwArcCommand === 'G3', `ccwArcCommand: ${definition.motion.ccwArcCommand} (sg03)`)
assert(definition.feedSpeed.spindleOnCW === 'M3', `spindleOnCW: ${definition.feedSpeed.spindleOnCW} (sm03)`)
assert(definition.feedSpeed.spindleOnCCW === 'M4', `spindleOnCCW: ${definition.feedSpeed.spindleOnCCW} (sm04)`)
assert(definition.feedSpeed.spindleOff === 'M5', `spindleOff: ${definition.feedSpeed.spindleOff} (sm05)`)
assert(definition.feedSpeed.feedCommand === 'F', `feedCommand: ${definition.feedSpeed.feedCommand} (fmt F ... feed)`)
assert(definition.feedSpeed.rpmCommand === 'S', `rpmCommand: ${definition.feedSpeed.rpmCommand} (fmt S ... speed)`)
assert(definition.units.mmCommand === 'G21', `mmCommand: ${definition.units.mmCommand} (sg21)`)
assert(definition.units.inchCommand === 'G20', `inchCommand: ${definition.units.inchCommand} (sg20)`)
assert(definition.program.commentPrefix === '(', `commentPrefix: ${definition.program.commentPrefix}`)
assert(definition.program.commentSuffix === ')', `commentSuffix: ${definition.program.commentSuffix}`)

assert(definition.coolant?.floodOnCommand === 'M8', `floodOnCommand: ${definition.coolant?.floodOnCommand} (sm08)`)
assert(definition.coolant?.mistOnCommand === 'M8', `mistOnCommand: ${definition.coolant?.mistOnCommand} (sm08_1, same literal as flood in this source)`)
assert(definition.coolant?.coolantOffCommand === 'M9', `coolantOffCommand: ${definition.coolant?.coolantOffCommand} (sm09)`)

assert(definition.cannedCycles?.drillCommand === 'G81', `drillCommand: ${definition.cannedCycles?.drillCommand} (sg81)`)
assert(definition.cannedCycles?.drillWithDwellCommand === 'G82', `drillWithDwellCommand: ${definition.cannedCycles?.drillWithDwellCommand} (sg81d)`)
assert(definition.cannedCycles?.peckDrillCommand === 'G83', `peckDrillCommand: ${definition.cannedCycles?.peckDrillCommand} (sg83)`)
assert(definition.cannedCycles?.chipBreakDrillCommand === 'G73', `chipBreakDrillCommand: ${definition.cannedCycles?.chipBreakDrillCommand} (sg73)`)
assert(definition.cannedCycles?.peckStepWord === 'Q', `peckStepWord: ${definition.cannedCycles?.peckStepWord} (fmt Q ... peck1)`)
assert(definition.cannedCycles?.cancelCommand === 'G80', `cancelCommand: ${definition.cannedCycles?.cancelCommand} (literal "G80" in pcanceldc)`)
assert(definition.stop.programEndCommand === 'M30', `programEndCommand: ${definition.stop.programEndCommand} (literal "M30" in peof)`)

// --- The defining characteristic of this adapter: most of the file is
// genuinely NOT statically resolvable (real control flow in the p*
// postblocks), and that must show up as honest unsupported/omitted findings
// rather than guessed values, especially for the toolchange sequence. ---
assert(
  result.findings.some((f) => f.status === 'unsupported' && f.targetField === 'toolChange.commands' && f.blocksStrict),
  'expected a strict-blocking finding explaining the toolchange sequence could not be statically resolved',
)
assert(result.findings.some((f) => f.blocksStrict), 'this fixture should not be strict-safe')
assert(
  result.findings.filter((f) => f.status === 'omitted').length > 5,
  'expected a substantial number of honestly-omitted fields (decimal precision, modal flags, header/footer templates) that the flat control-switch section and string-select table cannot resolve',
)
assert((result.notes ?? []).length > 0, 'expected at least one top-level note (header metadata / methodology)')
for (const finding of result.findings) {
  assert(finding.message.length > 0, `finding for ${finding.sourceField} has an empty message`)
}

console.log(`mastercamPst.test: all assertions passed (${result.findings.length} findings)`)
