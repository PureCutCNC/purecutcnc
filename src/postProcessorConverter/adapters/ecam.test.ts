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
 * Tests for the ECam (.xml) adapter.
 *
 * Run with: npx tsx src/postProcessorConverter/adapters/ecam.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ecamAdapter } from './ecam'
import { buildMachineDefinition } from '../draft'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../__fixtures__/ecam/${name}`, import.meta.url)), 'utf8')
}

// --- fe1510-edingcnc-fraesmaschine-mm.xml: a mill (MachineType = VerticalMill) ---
{
  const text = loadFixture('fe1510-edingcnc-fraesmaschine-mm.xml')
  const result = ecamAdapter.convert(text, 'fe1510-edingcnc-fraesmaschine-mm.xml')
  const definition = buildMachineDefinition(result.overrides, {
    id: 'test-ecam-fe1510',
    name: 'Test ECam FE1510',
    description: 'Converted from fe1510-edingcnc-fraesmaschine-mm.xml',
  })

  assert(definition.numberFormat.decimalPlaces.mm === 3 && definition.numberFormat.decimalPlaces.inch === 3, `decimalPlaces: ${JSON.stringify(definition.numberFormat.decimalPlaces)}`)
  assert(definition.program.lineNumbers === true, 'lineNumbers should be true: {LINE_N} is referenced in Template_InitOperation_With_Toolchange')
  assert(definition.program.lineNumberIncrement === 5, `lineNumberIncrement: ${definition.program.lineNumberIncrement}`)
  assert(definition.motion.modalMotion === true, 'modalMotion should be true: COO_X/COO_Y are not in CodeAlwaysRepeated')
  assert(definition.motion.rapidCommand === 'G0', `rapidCommand: ${definition.motion.rapidCommand}`)
  assert(definition.motion.linearCommand === 'G1', `linearCommand: ${definition.motion.linearCommand}`)
  assert(definition.motion.cwArcCommand === 'G2', `cwArcCommand: ${definition.motion.cwArcCommand}`)
  assert(definition.motion.ccwArcCommand === 'G3', `ccwArcCommand: ${definition.motion.ccwArcCommand}`)
  assert(definition.motion.arcFormat === 'ij', `arcFormat: ${definition.motion.arcFormat}`)
  assert(definition.feedSpeed.feedCommand === 'F', `feedCommand: ${definition.feedSpeed.feedCommand}`)
  assert(definition.feedSpeed.rpmCommand === 'S', `rpmCommand: ${definition.feedSpeed.rpmCommand}`)
  assert(definition.feedSpeed.spindleOnCW === 'M3', `spindleOnCW: ${definition.feedSpeed.spindleOnCW}`)
  assert(definition.feedSpeed.spindleOnCCW === 'M4', `spindleOnCCW: ${definition.feedSpeed.spindleOnCCW}`)
  assert(definition.feedSpeed.spindleOff === 'M5', `spindleOff: ${definition.feedSpeed.spindleOff}`)
  assert(definition.coolant?.floodOnCommand === 'M8', `floodOnCommand: ${definition.coolant?.floodOnCommand}`)
  assert(definition.coolant?.coolantOffCommand === 'M9', `coolantOffCommand: ${definition.coolant?.coolantOffCommand}`)
  assert(definition.workCoordinates.selectCommand === 'G54', `selectCommand: ${definition.workCoordinates.selectCommand}`)
  assert(definition.cannedCycles === null, 'cannedCycles should be null: source expresses drilling as full macro templates')

  assert(definition.program.header.includes('%'), `header should include "%": ${JSON.stringify(definition.program.header)}`)
  assert(definition.program.header.some((line) => line.includes('{programName}')), `header: ${JSON.stringify(definition.program.header)}`)
  assert(definition.program.footer.some((line) => line.includes('M30')), `footer: ${JSON.stringify(definition.program.footer)}`)

  assert(
    result.findings.every((f) => f.sourceField !== 'MachineType'),
    'a VerticalMill file should not raise the lathe MachineType finding',
  )
  assert(
    result.findings.some((f) => f.status === 'unsupported' && f.sourceField.startsWith('Post/Macro_Lathe')),
    'expected a finding about inert lathe-only fields in the shared schema',
  )
  assert(
    result.findings.some((f) => f.status === 'unsupported' && f.targetField === 'toolChange.commands' && f.blocksStrict),
    'expected a strict-blocking finding about the unresolvable toolchange template',
  )
  for (const finding of result.findings) {
    assert(finding.message.length > 0, `finding for ${finding.sourceField} has an empty message`)
  }

  console.log('ecam.test: fe1510 (mill) assertions passed')
}

// --- d6000-edingcnc-drehmaschine-mm.xml: a lathe (MachineType = Lathe2Axis) ---
{
  const text = loadFixture('d6000-edingcnc-drehmaschine-mm.xml')
  const result = ecamAdapter.convert(text, 'd6000-edingcnc-drehmaschine-mm.xml')
  const definition = buildMachineDefinition(result.overrides, {
    id: 'test-ecam-d6000',
    name: 'Test ECam D6000',
    description: 'Converted from d6000-edingcnc-drehmaschine-mm.xml',
  })

  assert(definition.coolant?.floodOnCommand === 'M7', `floodOnCommand: ${definition.coolant?.floodOnCommand} (this lathe post uses M7, not M8)`)
  assert(
    result.findings.some((f) => f.status === 'unsupported' && f.sourceField === 'MachineType' && f.blocksStrict),
    'expected a strict-blocking finding flagging this as a lathe file',
  )

  console.log('ecam.test: d6000 (lathe) assertions passed')
}
