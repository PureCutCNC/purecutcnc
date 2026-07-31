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
 * Tests for the Vectric/Estlcam (.pp) adapter.
 *
 * Run with: npx tsx src/postProcessorConverter/adapters/vectricEstlcam.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { vectricEstlcamAdapter } from './vectricEstlcam'
import { buildMachineDefinition } from '../draft'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../__fixtures__/vectricEstlcam/${name}`, import.meta.url)), 'utf8')
}

// --- estlcam-eding-vectric-v11.pp: the rich fixture with a HEADER-embedded toolchange ---
{
  const text = loadFixture('estlcam-eding-vectric-v11.pp')
  const result = vectricEstlcamAdapter.convert(text, 'estlcam-eding-vectric-v11.pp')
  const definition = buildMachineDefinition(result.overrides, {
    id: 'test-vectric',
    name: 'Test Vectric',
    description: 'Converted from estlcam-eding-vectric-v11.pp',
  })

  assert(definition.fileExtension === 'nc', `fileExtension: ${definition.fileExtension}`)
  assert(definition.program.lineNumbers === false, 'lineNumbers should be false: no block ever emits [N]')
  assert(definition.motion.rapidCommand === 'G00', `rapidCommand: ${definition.motion.rapidCommand}`)
  assert(definition.motion.linearCommand === 'G01', `linearCommand: ${definition.motion.linearCommand}`)
  assert(definition.motion.cwArcCommand === 'G02', `cwArcCommand: ${definition.motion.cwArcCommand}`)
  assert(definition.motion.ccwArcCommand === 'G03', `ccwArcCommand: ${definition.motion.ccwArcCommand}`)
  assert(definition.motion.arcFormat === 'ij', `arcFormat: ${definition.motion.arcFormat}`)
  assert(definition.motion.modalMotion === true, 'modalMotion should be true (X_POSITION flag = C)')
  assert(definition.feedSpeed.feedCommand === 'F', `feedCommand: ${definition.feedSpeed.feedCommand}`)
  assert(definition.feedSpeed.rpmCommand === 'S', `rpmCommand: ${definition.feedSpeed.rpmCommand}`)
  assert(definition.feedSpeed.spindleOnCW === 'M03', `spindleOnCW: ${definition.feedSpeed.spindleOnCW}`)
  assert(definition.feedSpeed.spindleOff === 'M05', `spindleOff: ${definition.feedSpeed.spindleOff}`)

  assert(
    definition.toolChange.commands.some((line) => line.includes('{toolNumber}') && line.includes('M06')),
    `toolChange.commands should reference {toolNumber} and M06: ${JSON.stringify(definition.toolChange.commands)}`,
  )
  assert(definition.toolChange.commands.includes('M05'), `toolChange.commands should include a spindle-stop: ${JSON.stringify(definition.toolChange.commands)}`)
  assert(definition.program.header.some((line) => line.includes('{programName}')), `header: ${JSON.stringify(definition.program.header)}`)
  assert(definition.program.header.includes('%'), `header should include the "%" program-start marker: ${JSON.stringify(definition.program.header)}`)

  // This source omits M04, an explicit units command, and a couple of live
  // per-move values (Z-home, inline spindle speed, operator prompt) in its
  // toolchange sequence — real gaps that should surface, some strict-blocking.
  assert(result.findings.some((f) => f.status === 'omitted' && f.targetField === 'feedSpeed.spindleOnCCW'), 'expected an omitted finding for missing M04')
  assert(
    result.findings.some((f) => f.status === 'conflicting' && f.targetField === 'program.header' && f.blocksStrict),
    'expected a strict-blocking finding about the missing G90/units preamble',
  )
  assert(
    result.findings.some((f) => f.status === 'unsupported' && f.targetField === 'toolChange.commands' && f.blocksStrict),
    'expected a strict-blocking finding about untranslatable toolchange lines',
  )
  assert(result.findings.some((f) => f.blocksStrict), 'this fixture should NOT be strict-safe')
  for (const finding of result.findings) {
    assert(finding.message.length > 0, `finding for ${finding.sourceField} has an empty message`)
  }

  console.log('vectricEstlcam.test: estlcam-eding-vectric-v11.pp assertions passed')
}

// --- cut3d-usbcnc-mm.pp: a second, simpler fixture that DOES use [N] line numbers ---
{
  const text = loadFixture('cut3d-usbcnc-mm.pp')
  const result = vectricEstlcamAdapter.convert(text, 'cut3d-usbcnc-mm.pp')
  const definition = buildMachineDefinition(result.overrides, {
    id: 'test-vectric-cut3d',
    name: 'Test Vectric Cut3D',
    description: 'Converted from cut3d-usbcnc-mm.pp',
  })

  assert(definition.fileExtension === 'nc', `fileExtension: ${definition.fileExtension}`)
  assert(definition.program.lineNumbers === true, 'lineNumbers should be true: RAPID_MOVE emits [N]')
  assert(definition.motion.rapidCommand === 'G00', `rapidCommand: ${definition.motion.rapidCommand}`)
  assert(definition.motion.cwArcCommand === 'G2', `cwArcCommand: ${definition.motion.cwArcCommand}`)
  assert(definition.motion.arcFormat === 'ij', `arcFormat: ${definition.motion.arcFormat}`)

  console.log('vectricEstlcam.test: cut3d-usbcnc-mm.pp assertions passed')
}
