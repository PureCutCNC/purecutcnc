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
 * Tests for the SheetCAM (.scpost) static extractor.
 *
 * Run with: npx tsx src/postProcessorConverter/adapters/sheetcam.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { sheetcamAdapter } from './sheetcam'
import { buildMachineDefinition } from '../draft'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../__fixtures__/sheetcam/${name}`, import.meta.url)), 'utf8')
}

// --- edingcnc.scpost: a plain 3-axis mill post ---
{
  const text = loadFixture('edingcnc.scpost')
  const result = sheetcamAdapter.convert(text, 'edingcnc.scpost')
  const definition = buildMachineDefinition(result.overrides, {
    id: 'test-sheetcam',
    name: 'Test SheetCAM',
    description: 'Converted from edingcnc.scpost',
  })

  assert(definition.program.commentPrefix === '(', `commentPrefix: ${definition.program.commentPrefix}`)
  assert(definition.program.commentSuffix === ')', `commentSuffix: ${definition.program.commentSuffix}`)
  assert(definition.units.mmCommand === 'G21', `mmCommand: ${definition.units.mmCommand}`)
  assert(definition.units.inchCommand === 'G20', `inchCommand: ${definition.units.inchCommand}`)
  assert(definition.motion.rapidCommand === 'G00', `rapidCommand: ${definition.motion.rapidCommand}`)
  assert(definition.motion.linearCommand === 'G01', `linearCommand: ${definition.motion.linearCommand}`)
  assert(definition.motion.cwArcCommand === 'G02', `cwArcCommand: ${definition.motion.cwArcCommand}`)
  assert(definition.motion.ccwArcCommand === 'G03', `ccwArcCommand: ${definition.motion.ccwArcCommand}`)
  assert(definition.motion.arcFormat === 'ij', `arcFormat: ${definition.motion.arcFormat}`)
  assert(definition.feedSpeed.spindleOnCW === 'M03', `spindleOnCW: ${definition.feedSpeed.spindleOnCW}`)
  assert(definition.feedSpeed.spindleOnCCW === 'M04', `spindleOnCCW: ${definition.feedSpeed.spindleOnCCW}`)
  assert(definition.feedSpeed.spindleOff === 'M05', `spindleOff: ${definition.feedSpeed.spindleOff}`)
  assert(definition.coolant?.floodOnCommand === 'M08', `floodOnCommand: ${definition.coolant?.floodOnCommand}`)
  assert(definition.coolant?.mistOnCommand === 'M07', `mistOnCommand: ${definition.coolant?.mistOnCommand}`)
  assert(definition.coolant?.coolantOffCommand === 'M09', `coolantOffCommand: ${definition.coolant?.coolantOffCommand}`)
  assert(definition.stop.programEndCommand === 'M30', `programEndCommand: ${definition.stop.programEndCommand}`)
  assert(definition.program.lineNumbers === true, 'lineNumbers should be true: the active OnNewLine emits an N-prefixed sequence number')
  assert(definition.program.lineNumberIncrement === 10, `lineNumberIncrement: ${definition.program.lineNumberIncrement}`)
  assert(
    definition.toolChange.commands.some((line) => line.includes('{toolNumber}') && /M0?6/.test(line)),
    `toolChange.commands should reference {toolNumber} and M6: ${JSON.stringify(definition.toolChange.commands)}`,
  )
  assert(definition.cannedCycles === null, 'cannedCycles should be null: OnDrill implements a custom while-loop peck cycle, not a fixed canned cycle')
  assert(definition.numberFormat.decimalPlaces.mm === 4, `decimalPlaces: ${JSON.stringify(definition.numberFormat.decimalPlaces)} (X format string is "0.0000")`)

  assert(
    result.findings.some((f) => f.status === 'unsupported' && f.sourceField === 'OnDrill' && !f.blocksStrict),
    'expected a non-blocking unsupported finding for the custom drill loop',
  )
  assert(result.findings.every((f) => f.sourceField !== 'OnPenDown / OnPenUp'), 'a plain mill post should not raise the plasma finding')
  assert(result.findings.every((f) => !f.blocksStrict), 'the plain mill fixture should be fully strict-safe')
  for (const finding of result.findings) {
    assert(finding.message.length > 0, `finding for ${finding.sourceField} has an empty message`)
  }

  console.log('sheetcam.test: edingcnc.scpost (mill) assertions passed')
}

// --- edingcnc-plasma-thc.scpost: same base callbacks plus plasma/THC ones with no PureCutCNC equivalent ---
{
  const text = loadFixture('edingcnc-plasma-thc.scpost')
  const result = sheetcamAdapter.convert(text, 'edingcnc-plasma-thc.scpost')
  const definition = buildMachineDefinition(result.overrides, {
    id: 'test-sheetcam-plasma',
    name: 'Test SheetCAM Plasma',
    description: 'Converted from edingcnc-plasma-thc.scpost',
  })

  assert(definition.motion.rapidCommand !== undefined, 'rapidCommand should still be derived from OnRapid')
  assert(
    result.findings.some((f) => f.status === 'unsupported' && f.sourceField === 'OnPenDown / OnPenUp' && f.blocksStrict),
    'expected a strict-blocking finding for the plasma torch-control callbacks',
  )
  assert(result.findings.some((f) => f.blocksStrict), 'the plasma fixture should NOT be strict-safe')

  console.log('sheetcam.test: edingcnc-plasma-thc.scpost assertions passed')
}
