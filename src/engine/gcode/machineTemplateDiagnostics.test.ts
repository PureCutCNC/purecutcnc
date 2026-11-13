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
 * #1119, engine half: a machine that still breaks a template rule is kept,
 * selected, diagnosed line by line, and refused at export.
 *
 * The fixture is the untouched #1109 project. A deliberately still-invalid
 * variant of its Avid Mach4 definition (G90.1 and a motion word in the header)
 * proves the structural reader keeps the definition and the project keeps it
 * selected, while `machineTemplateDiagnostics` names every offending line and
 * `runPostProcessor` produces no program. Valid definitions stay
 * byte-identical through the structural reader.
 *
 * Mutations that must fail this file:
 * - validate a persisted snapshot with `MachineDefinitionSchema` again → the
 *   variant is dropped or the load throws;
 * - stop reporting every offending line → the two-line list loses one;
 * - remove the `runPostProcessor` guard → the invalid definition posts a
 *   program;
 * - make the guard depend on `options.emitToolChanges`/`emitCoolant` or on a
 *   non-empty operation list → the bypass case posts;
 * - use the strict schema as the structural reader → the variant is refused.
 *
 * Run with: npx tsx src/engine/gcode/machineTemplateDiagnostics.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import type { Project } from '../../types/project'
import { normalizeProject } from '../../store/helpers/projectFormat'
import { warningSeverity } from '../toolpaths/warningCodes'
import { BUNDLED_DEFINITIONS } from './definitions'
import { runPostProcessor } from './postprocessor'
import { machineTemplateDiagnostics } from './templateRules'
import {
  machineExportDiagnostics,
  readMachineDefinitionStructure,
  validateMachineDefinition,
  type MachineDefinition,
} from './types'

const FIXTURE = new URL('../test-fixtures/issue-1109-tab-ramp-original.camj', import.meta.url)
const MACHINE_ID = 'avid-mach4-inch-shop'

function fixtureProject(): Project {
  return JSON.parse(readFileSync(FIXTURE, 'utf8')) as Project
}

function fixtureMachine(): MachineDefinition {
  const project = fixtureProject()
  const definition = project.meta.machineDefinitions.find((candidate) => candidate.id === MACHINE_ID)
  assert.ok(definition, 'fixture: the #1109 snapshot carries the Avid machine')
  return definition
}

console.log('Testing the structural reader keeps every valid definition byte-identical...')

for (const bundled of BUNDLED_DEFINITIONS) {
  const strict = validateMachineDefinition(structuredClone(bundled))
  const structural = readMachineDefinitionStructure(structuredClone(bundled))
  assert.deepEqual(
    structural,
    strict,
    `${bundled.id}: the structural reader produces exactly the strict result for a valid definition`,
  )
}

console.log('Testing diagnostics name every offending line, field, word and rule...')

{
  const grbl = readMachineDefinitionStructure(
    structuredClone(BUNDLED_DEFINITIONS.find((definition) => definition.id === 'grbl')),
  )
  const diagnostics = machineTemplateDiagnostics({
    ...grbl,
    program: {
      ...grbl.program,
      operationHeader: ['G0 X0 Y0', 'M3\nG1 Z-1', 'M5'],
    },
    feedSpeed: {
      ...grbl.feedSpeed,
      spindleOnCW: 'M3\nG1 X1',
      // A command field is one line and one command: the newline itself is
      // refused and the offending line is named.
      rpmCommand: 'G91\nS',
    },
  })

  const header = diagnostics.filter((entry) => entry.field === 'program.operationHeader[0]')
  assert.equal(header.length, 1, 'the first operation-header line is refused')
  assert.equal(header[0].line, 1, 'its line number is one-based')
  assert.equal(header[0].word, 'G0', 'it names the offending word')
  assert.equal(header[0].ruleCode, 'inert.operation-header', 'it names the broken rule')
  assert.equal(header[0].text, 'G0 X0 Y0', 'it keeps the offending text')

  const embedded = diagnostics.find((entry) => entry.field === 'program.operationHeader[1]')
  assert.equal(embedded?.line, 3, 'an embedded newline is split and the program line is named')
  assert.equal(embedded?.word, 'G1', 'the embedded line names its word')

  const inert = diagnostics.find((entry) => entry.field === 'feedSpeed.spindleOnCW')
  assert.equal(inert?.line, 2, 'the line after an embedded newline carries line 2')
  assert.equal(inert?.word, 'G1', 'the line after an embedded newline names its word')

  const commandLines = diagnostics.filter((entry) => entry.field === 'feedSpeed.rpmCommand')
  assert.equal(commandLines.length, 1, 'a command field with a newline is refused once per bad line')
  assert.equal(commandLines[0].line, 1, 'the command field line is named')
  assert.equal(commandLines[0].word, 'G91', 'the injected command word is named')

  for (const entry of diagnostics) {
    assert.ok(
      entry.message.startsWith(`${entry.field}: line ${entry.line}:`),
      `${entry.field}: the message starts with the field and line: ${entry.message}`,
    )
    assert.ok(entry.message.includes(`"${entry.word}"`), `${entry.field}: the message names the word`)
  }
}

console.log('Testing a still-invalid #1109 machine is kept, selected, and diagnosed...')

const invalidDefinition: MachineDefinition = {
  ...structuredClone(fixtureMachine()),
  program: {
    ...structuredClone(fixtureMachine().program),
    header: [
      '( {programName} )',
      '( for Avid CNC Machines, PureCutCNC post from AvidCNC_inch.pp )',
      'G00 G94 {unitsCommand} G17 G90 G40 G49 G80',
      'G90.1',
      'G1 X0 Y0',
    ],
  },
}

assert.throws(
  () => validateMachineDefinition(structuredClone(invalidDefinition)),
  'the strict schema still refuses the deliberate G90.1 header',
)

const source = fixtureProject()
const project: Project = normalizeProject({
  ...source,
  meta: {
    ...source.meta,
    machineDefinitions: [invalidDefinition],
    selectedMachineId: invalidDefinition.id,
  },
})

const retained = project.meta.machineDefinitions.find((definition) => definition.id === MACHINE_ID)
assert.ok(retained, 'the still-invalid machine is retained on load')
assert.equal(project.meta.selectedMachineId, MACHINE_ID, 'the still-invalid machine stays selected')
assert.deepEqual(
  retained.program.header,
  invalidDefinition.program.header,
  'the retained definition keeps its template lines unchanged',
)

const diagnostics = machineExportDiagnostics(retained)
assert.equal(diagnostics.length, 2, `both offending header lines are reported: ${JSON.stringify(diagnostics)}`)
assert.deepEqual(
  diagnostics.map((entry) => [entry.field, entry.line, entry.word]),
  [['program.header[3]', 4, 'G90.1'], ['program.header[4]', 5, 'G1']],
  'every offending line is named with its field, one-based line and word',
)
assert.ok(
  diagnostics.every((entry) => entry.ruleCode === 'header'),
  'each diagnostic names the broken rule',
)

console.log('Testing export refuses the invalid definition and produces no program...')

for (const [label, options] of [
  ['tool changes and coolant on', { emitToolChanges: true, emitCoolant: true }],
  ['tool changes and coolant off', { emitToolChanges: false, emitCoolant: false }],
] as const) {
  const result = runPostProcessor({
    project,
    operations: [],
    definition: retained,
    options,
  })
  assert.equal(result.gcode, '', `${label}: an invalid machine produces no program`)
  assert.equal(result.stats.lineCount, 0, `${label}: no program lines are counted`)
  const warning = result.warnings.find((entry) => entry.code === 'exportMachineTemplateInvalid')
  assert.ok(warning, `${label}: the refusal is reported as a warning code`)
  assert.equal(warningSeverity('exportMachineTemplateInvalid'), 'error', `${label}: the code blocks a save`)
}

// The valid original still posts, and the structural parse is what feeds it.
const valid = readMachineDefinitionStructure(structuredClone(fixtureMachine()))
assert.equal(machineTemplateDiagnostics(valid).length, 0, 'the original #1109 machine has no diagnostics')
assert.equal(runPostProcessor({
  project,
  operations: [],
  definition: valid,
  options: { emitToolChanges: false, emitCoolant: false },
}).warnings.some((entry) => entry.code === 'exportMachineTemplateInvalid'), false, 'a valid machine is not refused')

console.log('machine-template diagnostics tests passed')
