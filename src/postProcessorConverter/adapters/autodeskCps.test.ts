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
 * Tests for the Autodesk HSM/Inventor (.cps) adapter.
 *
 * Run with: npx tsx src/postProcessorConverter/adapters/autodeskCps.test.ts
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { autodeskCpsAdapter } from './autodeskCps'
import { buildMachineDefinition } from '../draft'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function loadFixture(name: string): string {
  return readFileSync(fileURLToPath(new URL(`../__fixtures__/autodeskCps/${name}`, import.meta.url)), 'utf8')
}

assert(autodeskCpsAdapter.id === 'autodesk-cps', `id: ${autodeskCpsAdapter.id}`)
assert(autodeskCpsAdapter.label === 'Autodesk HSM/Inventor (.cps)', `label: ${autodeskCpsAdapter.label}`)
assert(
  autodeskCpsAdapter.fileExtensions.length === 1 && autodeskCpsAdapter.fileExtensions[0] === 'cps',
  `fileExtensions: ${JSON.stringify(autodeskCpsAdapter.fileExtensions)}`,
)
assert(autodeskCpsAdapter.staticAnalysisOnly === true, 'staticAnalysisOnly should be true — this adapter never evaluates the source JS')

// --- edingcnc-original-from-autodesk.cps: a 3-axis mill (capabilities = CAPABILITY_MILLING) ---
{
  const text = loadFixture('edingcnc-original-from-autodesk.cps')
  const result = autodeskCpsAdapter.convert(text, 'edingcnc-original-from-autodesk.cps')
  const definition = buildMachineDefinition(result.overrides, {
    id: 'test-autodesk-cps-mill',
    name: 'Test Eding CNC/USBCNC',
    description: 'Converted from edingcnc-original-from-autodesk.cps',
  })

  // Identity / number formatting
  assert(definition.fileExtension === 'cnc', `fileExtension: ${definition.fileExtension}`)
  assert(
    definition.numberFormat.decimalPlaces.mm === 3 && definition.numberFormat.decimalPlaces.inch === 4,
    `decimalPlaces: ${JSON.stringify(definition.numberFormat.decimalPlaces)}`,
  )

  // Motion
  assert(definition.motion.rapidCommand === 'G0', `rapidCommand: ${definition.motion.rapidCommand}`)
  assert(definition.motion.linearCommand === 'G1', `linearCommand: ${definition.motion.linearCommand}`)
  assert(definition.motion.cwArcCommand === 'G2', `cwArcCommand: ${definition.motion.cwArcCommand}`)
  assert(definition.motion.ccwArcCommand === 'G3', `ccwArcCommand: ${definition.motion.ccwArcCommand}`)
  assert(definition.motion.arcFormat === 'ij', `arcFormat: ${definition.motion.arcFormat} (useRadius: false in properties)`)

  // Feed / spindle / tool change
  assert(definition.feedSpeed.feedCommand === 'F', `feedCommand: ${definition.feedSpeed.feedCommand}`)
  assert(definition.feedSpeed.rpmCommand === 'S', `rpmCommand: ${definition.feedSpeed.rpmCommand}`)
  assert(definition.feedSpeed.spindleOnCW === 'M3', `spindleOnCW: ${definition.feedSpeed.spindleOnCW}`)
  assert(definition.feedSpeed.spindleOnCCW === 'M4', `spindleOnCCW: ${definition.feedSpeed.spindleOnCCW}`)
  assert(
    definition.toolChange.commands.length === 1 && definition.toolChange.commands[0] === 'T{toolNumber} M6',
    `toolChange.commands: ${JSON.stringify(definition.toolChange.commands)}`,
  )
  assert(definition.toolChange.stopSpindleFirst === true, 'stopSpindleFirst should be true (onSection explicitly stops the spindle before tool change)')

  // Coolant (setCoolant() switch: COOLANT_OFF -> m=9, COOLANT_FLOOD -> m=8, COOLANT_MIST -> m=7)
  assert(definition.coolant?.floodOnCommand === 'M8', `floodOnCommand: ${definition.coolant?.floodOnCommand}`)
  assert(definition.coolant?.mistOnCommand === 'M7', `mistOnCommand: ${definition.coolant?.mistOnCommand}`)
  assert(definition.coolant?.coolantOffCommand === 'M9', `coolantOffCommand: ${definition.coolant?.coolantOffCommand}`)

  // Program end / comments
  assert(definition.stop.programEndCommand === 'M30', `programEndCommand: ${definition.stop.programEndCommand}`)
  assert(definition.program.commentPrefix === '(', `commentPrefix: ${definition.program.commentPrefix}`)
  assert(definition.program.commentSuffix === ')', `commentSuffix: ${definition.program.commentSuffix}`)
  assert(definition.program.lineNumbers === true, 'lineNumbers should be true (showSequenceNumbers: true in properties)')
  assert(definition.program.lineNumberIncrement === 5, `lineNumberIncrement: ${definition.program.lineNumberIncrement}`)

  // Canned cycles
  assert(definition.cannedCycles?.drillCommand === 'G81', `drillCommand: ${definition.cannedCycles?.drillCommand}`)
  assert(definition.cannedCycles?.drillWithDwellCommand === 'G82', `drillWithDwellCommand: ${definition.cannedCycles?.drillWithDwellCommand}`)
  assert(definition.cannedCycles?.peckDrillCommand === 'G83', `peckDrillCommand: ${definition.cannedCycles?.peckDrillCommand}`)
  assert(definition.cannedCycles?.peckStepWord === 'Q', `peckStepWord: ${definition.cannedCycles?.peckStepWord}`)
  assert(definition.cannedCycles?.chipBreakDrillCommand === null, 'chipBreakDrillCommand should be null ("chip-breaking" case always expands, never emits a canned-cycle code)')
  assert(definition.cannedCycles?.cancelCommand === 'G80', `cancelCommand: ${definition.cannedCycles?.cancelCommand}`)
  assert(definition.cannedCycles?.retractMode === 'G98', `retractMode: ${definition.cannedCycles?.retractMode}`)

  // Work coordinates / units
  assert(definition.workCoordinates.selectCommand === 'G54', `selectCommand: ${definition.workCoordinates.selectCommand}`)
  assert(definition.units.inchCommand === 'G20', `inchCommand: ${definition.units.inchCommand}`)
  assert(definition.units.mmCommand === 'G21', `mmCommand: ${definition.units.mmCommand}`)

  // Report contract
  assert(result.findings.length > 15, `expected a substantial finding list, got ${result.findings.length}`)
  assert(result.findings.some((f) => f.status === 'mapped'), 'expected at least one mapped finding')
  assert(result.findings.some((f) => f.status === 'omitted'), 'expected at least one omitted finding')
  assert(
    result.findings.some((f) => f.sourceField === 'capabilities' && f.status === 'mapped'),
    'expected capabilities = CAPABILITY_MILLING to be reported as a (non-blocking) mapped finding',
  )
  assert(
    result.findings.some((f) => f.status === 'unsupported' && !f.blocksStrict && /onRapid5D|aOutput\/bOutput\/cOutput/.test(f.sourceField)),
    'expected an informational (non-blocking) finding about 5-axis scaffolding (onRapid5D/onLinear5D, aOutput/bOutput/cOutput)',
  )
  assert(
    result.findings.every((f) => !f.blocksStrict),
    `this file fully resolves as a 3-axis mill post; nothing should block --strict: ${JSON.stringify(result.findings.filter((f) => f.blocksStrict))}`,
  )
  assert(
    (result.notes ?? []).some((n) => /never evaluated, required, or run/.test(n)),
    `expected a note disclosing static-analysis-only scanning: ${JSON.stringify(result.notes)}`,
  )
  for (const finding of result.findings) {
    assert(finding.message.length > 0, `finding for ${finding.sourceField} has an empty message`)
    if (finding.status === 'unsupported' || finding.status === 'conflicting') {
      assert(typeof finding.blocksStrict === 'boolean', `finding for ${finding.sourceField} (${finding.status}) must have a blocksStrict decision`)
    }
  }

  console.log('autodeskCps.test: edingcnc-original-from-autodesk.cps (mill) assertions passed')
}

// --- edingcnc-turning.cps: a lathe (capabilities = CAPABILITY_TURNING) ---
{
  const text = loadFixture('edingcnc-turning.cps')
  const result = autodeskCpsAdapter.convert(text, 'edingcnc-turning.cps')

  // Must not throw building a definition even though this source is out of scope —
  // the adapter still extracts what it can and reports the rest, mirroring ecam.ts's lathe handling.
  const definition = buildMachineDefinition(result.overrides, {
    id: 'test-autodesk-cps-turning',
    name: 'Test Eding CNC Turning',
    description: 'Converted from edingcnc-turning.cps',
  })
  assert(definition.fileExtension === 'nc', `fileExtension: ${definition.fileExtension} (extension = "nc" in this file, extracted for transparency)`)

  const capabilityFinding = result.findings.find((f) => f.sourceField === 'capabilities')
  assert(capabilityFinding !== undefined, 'expected a finding about the capabilities assignment')
  assert(capabilityFinding?.status === 'unsupported', `capabilities finding status: ${capabilityFinding?.status}`)
  assert(capabilityFinding?.blocksStrict === true, 'expected the capabilities = CAPABILITY_TURNING finding to block --strict')
  assert(/CAPABILITY_TURNING/.test(capabilityFinding?.message ?? ''), `capabilities finding message: ${capabilityFinding?.message}`)

  assert(
    result.findings.some((f) => f.blocksStrict),
    'expected at least one strict-blocking finding for a turning-capability post',
  )

  // Still extracted for transparency even though this file is out of scope (same idiom appears in this fork of the kernel).
  assert(definition.stop.programEndCommand === 'M30', `programEndCommand: ${definition.stop.programEndCommand}`)
  assert(definition.workCoordinates.selectCommand === 'G54', `selectCommand: ${definition.workCoordinates.selectCommand}`)

  for (const finding of result.findings) {
    assert(finding.message.length > 0, `finding for ${finding.sourceField} has an empty message`)
  }

  console.log('autodeskCps.test: edingcnc-turning.cps (lathe, refused) assertions passed')
}
