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
 * #1119: the untouched #1109 snapshot is a migration fixture.
 *
 * `issue-1109-tab-ramp-original.camj` is
 * `git show 9e2bb374:src/engine/test-fixtures/issue-1109-tab-ramp.camj`,
 * byte-for-byte. It keeps the reporter's 0.5.x Avid Mach4 post exactly as
 * saved: the header spells `G00` and `G91.1`, and the tool change joins
 * `T{toolNumber}M6` and `G43Z0.8000H{toolNumber}`. Before #1119 the #1057
 * template rules refused three of those lines, so the machine was dropped on
 * load. These assertions pin that the original bytes now load with their
 * machine selected and post a program, and that the posted template lines are
 * the saved ones rather than a rewrite.
 *
 * Run with: npx tsx src/engine/gcode/issue1109MachineMigration.test.ts
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import type { Project } from '../../types/project'
import { normalizeProject } from '../../store/helpers/projectFormat'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { computeOperationToolpath } from '../toolpaths/generateOperation'
import { runPostProcessor } from './postprocessor'
import { validateMachineDefinition } from './types'
import type { MachineDefinition } from './types'

const FIXTURE = new URL('../test-fixtures/issue-1109-tab-ramp-original.camj', import.meta.url)
const MACHINE_ID = 'avid-mach4-inch-shop'

console.log('Testing the untouched #1109 snapshot loads with its machine selected...')

const project: Project = normalizeProject(JSON.parse(readFileSync(FIXTURE, 'utf8')))

assert.equal(
  project.meta.selectedMachineId,
  MACHINE_ID,
  'the 0.5.x snapshot keeps its selected machine instead of falling back',
)

const definition = project.meta.machineDefinitions.find(
  (candidate: MachineDefinition) => candidate.id === MACHINE_ID,
)
assert.ok(definition !== undefined, 'the snapshot keeps its custom Avid Mach4 definition')
validateMachineDefinition(structuredClone(definition))

assert.deepEqual(
  definition.program.header.slice(2),
  ['G00 G94 {unitsCommand} G17 G90 G40 G49 G80', 'G91.1'],
  'the saved header lines survive loading unchanged',
)
assert.deepEqual(
  definition.toolChange.commands,
  ['T{toolNumber}M6', 'M07', 'G00 G43Z0.8000H{toolNumber}'],
  'the saved joined tool-change lines survive loading unchanged',
)

console.log('Testing the untouched #1109 snapshot posts a program...')

const operation = project.operations.find((candidate) => candidate.kind === 'edge_route_outside')
assert.ok(operation !== undefined, 'the snapshot has an outside edge route to post')
const tool = normalizeToolForProject(
  project.tools.find((candidate) => candidate.id === operation.toolRef)!,
  project,
)
const envelope = computeOperationToolpath(project, operation)
assert.ok(envelope !== null, 'the production chain generates the operation')
assert.ok(envelope.result.moves.length > 0, 'the toolpath has moves to post')

const posted = runPostProcessor({
  project,
  operations: [{ operation, tool, toolpath: envelope.result }],
  definition,
  options: { emitToolChanges: true, emitCoolant: true },
}).gcode

assert.ok(posted.includes('G20'), 'the program posts in inch mode from the saved {unitsCommand} line')
assert.ok(
  posted.includes('G00 G94 G20 G17 G90 G40 G49 G80'),
  `the saved header rapid line posts unchanged:\n${posted.split('\n').slice(0, 12).join('\n')}`,
)
assert.ok(posted.includes('G91.1'), 'the saved relative-arc-centre line posts unchanged')
assert.ok(posted.includes('T1M6'), 'the saved joined tool-select line posts unchanged')
assert.ok(posted.includes('G00 G43Z0.8000H1'), 'the saved joined tool-length line posts unchanged')
assert.ok(
  posted.split('\n').some((line) => /^G0?[123]?\s+X-?[\d.]+/.test(line)),
  'the program carries a posted motion line',
)

console.log('issue #1109 machine migration tests passed')
