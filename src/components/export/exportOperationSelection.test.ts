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
 * Tests for the Export G-code operation-checklist helpers (issue #274):
 * exportability/default-selection rules and the suggested-filename stem.
 *
 * Run with: npx tsx src/components/export/exportOperationSelection.test.ts
 */

import {
  listExportOperationOptions,
  suggestGcodeFileName,
} from './exportOperationSelection'
import { newProject, type Operation, type Project } from '../../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeOperation(id: string, overrides: Partial<Operation> = {}): Operation {
  return {
    id,
    name: id,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: [] },
    toolRef: 'tool-1',
    stepdown: 1,
    stepover: 0.5,
    feed: 100,
    plungeFeed: 50,
    rpm: 10000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 0,
    maxCarveDepth: 0,
    ...overrides,
  }
}

function projectWith(operations: Operation[]): Project {
  const project = newProject()
  return {
    ...project,
    tools: [{ ...project.tools[0], id: 'tool-1' }],
    operations,
  }
}

// ── listExportOperationOptions ────────────────────────────────────

function testHealthyVisibleOperationIsExportableAndDefaultSelected(): void {
  const options = listExportOperationOptions(projectWith([makeOperation('op1')]))

  assert(options.length === 1, 'expected one option per operation')
  assert(options[0].exportable, 'enabled op with tool should be exportable')
  assert(options[0].reason === null, 'exportable op should have no reason')
  assert(options[0].defaultSelected, 'visible op should be in the default set')
}

function testHiddenToolpathIsExportableButNotDefaultSelected(): void {
  const options = listExportOperationOptions(
    projectWith([makeOperation('op1', { showToolpath: false })]),
  )

  assert(options[0].exportable, 'hidden-toolpath op should still be exportable')
  assert(!options[0].defaultSelected, 'hidden-toolpath op should not be default-selected')
}

function testDisabledOperationIsNotExportable(): void {
  const options = listExportOperationOptions(
    projectWith([makeOperation('op1', { enabled: false })]),
  )

  assert(!options[0].exportable, 'disabled op should not be exportable')
  assert(options[0].reason === 'Operation is off', 'disabled op reason should say it is off')
  assert(!options[0].defaultSelected, 'disabled op should not be default-selected')
}

function testMissingToolIsNotExportable(): void {
  const noRef = listExportOperationOptions(
    projectWith([makeOperation('op1', { toolRef: null })]),
  )
  const danglingRef = listExportOperationOptions(
    projectWith([makeOperation('op1', { toolRef: 'missing-tool' })]),
  )

  assert(!noRef[0].exportable, 'op without toolRef should not be exportable')
  assert(noRef[0].reason === 'No tool assigned', 'missing tool reason expected')
  assert(!danglingRef[0].exportable, 'op with dangling toolRef should not be exportable')
  assert(danglingRef[0].reason === 'No tool assigned', 'dangling tool reason expected')
}

function testOptionsPreserveExecutionOrder(): void {
  const options = listExportOperationOptions(
    projectWith([
      makeOperation('first', { enabled: false }),
      makeOperation('second'),
      makeOperation('third', { showToolpath: false }),
    ]),
  )

  assert(
    options.map((option) => option.operation.id).join(',') === 'first,second,third',
    'options should list operations in project execution order',
  )
}

// ── suggestGcodeFileName ──────────────────────────────────────────

function testFileNameUsesProjectNameForMultipleOperations(): void {
  assert(
    suggestGcodeFileName('My Part', ['Pocket 1', 'Profile 2']) === 'My_Part',
    'multi-op export should keep the project-name stem',
  )
  assert(
    suggestGcodeFileName('My Part', []) === 'My_Part',
    'empty selection should keep the project-name stem',
  )
}

function testFileNameAppendsSingleOperationName(): void {
  assert(
    suggestGcodeFileName('My Part', ['Pocket 1']) === 'My_Part_Pocket_1',
    'single-op export should append the operation name',
  )
}

const tests = [
  testHealthyVisibleOperationIsExportableAndDefaultSelected,
  testHiddenToolpathIsExportableButNotDefaultSelected,
  testDisabledOperationIsNotExportable,
  testMissingToolIsNotExportable,
  testOptionsPreserveExecutionOrder,
  testFileNameUsesProjectNameForMultipleOperations,
  testFileNameAppendsSingleOperationName,
]

for (const test of tests) {
  test()
}

console.log('exportOperationSelection tests passed')
