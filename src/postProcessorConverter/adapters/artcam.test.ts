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
 * Tests for the ArtCAM (.con) adapter.
 *
 * Run with: npx tsx src/postProcessorConverter/adapters/artcam.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { artcamAdapter } from './artcam'
import { buildMachineDefinition } from '../draft'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../__fixtures__/artcam/${name}`, import.meta.url)), 'utf8')
}

// --- edingcnc-mm.con ---
{
  const text = loadFixture('edingcnc-mm.con')
  const result = artcamAdapter.convert(text, 'edingcnc-mm.con')
  const definition = buildMachineDefinition(result.overrides, {
    id: 'test-artcam-mm',
    name: 'Test ArtCAM MM',
    description: 'Converted from edingcnc-mm.con',
  })

  assert(definition.fileExtension === 'CNC', `fileExtension: ${definition.fileExtension}`)
  assert(definition.program.lineNumbers === false, 'lineNumbers should be false: [N] is declared but never used in a template')
  assert(definition.motion.rapidCommand === 'G0', `rapidCommand: ${definition.motion.rapidCommand}`)
  assert(definition.motion.linearCommand === 'G1', `linearCommand: ${definition.motion.linearCommand}`)
  assert(definition.motion.cwArcCommand === 'G2', `cwArcCommand: ${definition.motion.cwArcCommand}`)
  assert(definition.motion.ccwArcCommand === 'G3', `ccwArcCommand: ${definition.motion.ccwArcCommand}`)
  assert(definition.motion.arcFormat === 'r', `arcFormat: ${definition.motion.arcFormat} (source uses R[Radius], not I/J)`)
  assert(definition.units.mmCommand === 'G21', `mmCommand: ${definition.units.mmCommand}`)
  assert(definition.program.commentPrefix === '(', `commentPrefix: ${definition.program.commentPrefix}`)
  assert(definition.program.commentSuffix === ')', `commentSuffix: ${definition.program.commentSuffix}`)
  assert(definition.program.header.some((line) => line.includes('G21')), `header should include the literal G90G80G21G49 line: ${JSON.stringify(definition.program.header)}`)

  assert(
    definition.toolChange.commands.some((line) => line.includes('{toolNumber}') && /M0?6/.test(line)),
    `toolChange.commands should reference {toolNumber} and M6: ${JSON.stringify(definition.toolChange.commands)}`,
  )
  assert(definition.toolChange.stopSpindleFirst === true, 'stopSpindleFirst should be true: M5 precedes M6 T[T] in TOOLCHANGE')
  assert(definition.coolant?.floodOnCommand === 'M8', `floodOnCommand: ${definition.coolant?.floodOnCommand}`)
  assert(definition.coolant?.coolantOffCommand === 'M9', `coolantOffCommand: ${definition.coolant?.coolantOffCommand}`)
  assert(definition.cannedCycles === null, 'cannedCycles should be null: source has no canned-drill-cycle records')
  assert(definition.program.footer.some((line) => line.includes('M30')), `footer: ${JSON.stringify(definition.program.footer)}`)

  assert(
    result.findings.some((f) => f.status === 'unsupported' && f.sourceField.includes('USER')),
    'expected a finding about the unknown USER1U..USER8U macro slots',
  )
  assert(
    result.findings.some((f) => f.status === 'omitted' && f.targetField === 'units.inchCommand'),
    'expected an omitted finding for the un-declared inch command',
  )
  for (const finding of result.findings) {
    assert(finding.message.length > 0, `finding for ${finding.sourceField} has an empty message`)
  }

  console.log('artcam.test: edingcnc-mm.con assertions passed')
}

// --- edingcnc-inch.con: same structure, inch-flavoured ---
{
  const text = loadFixture('edingcnc-inch.con')
  const result = artcamAdapter.convert(text, 'edingcnc-inch.con')
  const definition = buildMachineDefinition(result.overrides, {
    id: 'test-artcam-inch',
    name: 'Test ArtCAM Inch',
    description: 'Converted from edingcnc-inch.con',
  })

  assert(definition.units.inchCommand === 'G20', `inchCommand: ${definition.units.inchCommand}`)
  assert(
    result.findings.some((f) => f.status === 'omitted' && f.targetField === 'units.mmCommand'),
    'expected an omitted finding for the un-declared metric command',
  )

  console.log('artcam.test: edingcnc-inch.con assertions passed')
}
