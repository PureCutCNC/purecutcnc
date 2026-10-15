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
  groupExportOperationOptions,
  listExportOperationOptions,
  reusableExportPath,
  suggestGcodeFileName,
} from './exportOperationSelection'
import { newProject, roundStock, type MachiningSetup, type Operation, type Project } from '../../types/project'
import { dialogsEn } from '../../i18n/locales/en/dialogs'

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
  assert(options[0].reasonKey === null, 'exportable op should have no reasonKey')
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
  assert(options[0].reasonKey === 'dialogs.export.operationDisabled', 'disabled op reasonKey should reference operationDisabled')
  assert(dialogsEn['dialogs.export.operationDisabled'] === 'Operation is off', 'en catalog must carry the exact original reason string')
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
  assert(noRef[0].reasonKey === 'dialogs.export.noToolAssigned', 'missing tool reasonKey expected')
  assert(dialogsEn['dialogs.export.noToolAssigned'] === 'No tool assigned', 'en catalog must carry the exact original reason string')
  assert(!danglingRef[0].exportable, 'op with dangling toolRef should not be exportable')
  assert(danglingRef[0].reasonKey === 'dialogs.export.noToolAssigned', 'dangling tool reasonKey expected')
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

function testOtherFamilyOperationStaysOnTheChecklist(): void {
  const pocket = makeOperation('pocket-op')
  const plasma = makeOperation('plasma-op', { kind: 'plasma_profile' })

  // The other family's kind is not the project type's business here (issue
  // #1028 correction): it stays listed, the postprocessor skips it and the
  // dialog shows its warning (issue #960).
  const millingProject = projectWith([pocket, plasma])
  assert(
    listExportOperationOptions(millingProject).map((option) => option.operation.id).join(',') === 'pocket-op,plasma-op',
    'a plasma cut stays in the export options of a milling project',
  )

  // A milling operation in a plasma project stays in the export options too,
  // with no tool of its own needed: the warning, not the checklist, reports it.
  const plasmaProject: Project = {
    ...projectWith([pocket, plasma]),
    meta: { ...newProject('plasma', 'mm').meta, projectType: 'plasma' },
  }
  const plasmaOptions = listExportOperationOptions(plasmaProject)
  assert(
    plasmaOptions.map((option) => option.operation.id).join(',') === 'pocket-op,plasma-op',
    'a milling operation in a plasma project stays in the export options',
  )
  assert(
    plasmaOptions.every((option) => option.exportable),
    'and every listed option is exportable (the postprocessor is what skips it)',
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

// ── reusableExportPath ────────────────────────────────────────────

function testExportPathIsReusedOnlyForTheSameKindOfFile(): void {
  assert(reusableExportPath(null, 'nc') === null, 'no previous export: nothing to reuse')
  assert(
    reusableExportPath('/jobs/bracket.nc', 'nc') === '/jobs/bracket.nc',
    'the same extension overwrites the previous export in place',
  )
  assert(
    reusableExportPath('C:\\jobs\\BRACKET.NC', 'nc') === 'C:\\jobs\\BRACKET.NC',
    'extension case does not matter',
  )
  // After switching to the ShopBot machine, a part file must not be written
  // into the G-code file exported earlier (issue #953).
  assert(reusableExportPath('/jobs/bracket.nc', 'sbp') === null, 'a different extension asks where to save')
  assert(reusableExportPath('/jobs/bracket.sbp', 'nc') === null, 'and the other way round')
  assert(reusableExportPath('/jobs/part.sbp.nc', 'sbp') === null, 'only the final extension counts')
  assert(reusableExportPath('/jobs/nc', 'nc') === null, 'a name that merely ends in the letters is not that extension')
}

// ── groupExportOperationOptions (issues #946, #395) ───────────────

function testAroundOnlySetupIsItsOwnGroup(): void {
  const project = newProject('Around only', 'mm')
  const aroundSetup: MachiningSetup = {
    id: 'su-around', kind: 'around', name: 'Around',
    orientation: { axis: 'x', angleDeg: 0 }, indexing: 'manual', registration: [], notes: '', operationIds: ['op1'],
  }
  const withAround: Project = {
    ...project,
    meta: { ...project.meta, projectType: 'rotary' },
    stock: roundStock(25, 120, 'x'),
    setups: [aroundSetup],
    activeSetupId: aroundSetup.id,
    tools: [{ ...project.tools[0], id: 'tool-1' }],
    operations: [{ ...makeOperation('op1'), setupId: aroundSetup.id }],
  }
  const groups = groupExportOperationOptions(withAround, listExportOperationOptions(withAround))
  assert(groups.length === 1 && groups[0].setup?.id === aroundSetup.id, 'an Around-only project gets its named group')
  assert(groups[0].face === 'around', 'the group carries the around face')

  // The same Around-only project in a non-rotary type cuts nothing there: the
  // operation is kept in the project but left off the export checklist and out
  // of the programs (issue #1028, rule (a)).
  const aroundInMilling: Project = { ...withAround, meta: { ...withAround.meta, projectType: 'milling' } }
  assert(
    listExportOperationOptions(aroundInMilling).length === 0,
    'an Around operation is not exported in a milling project',
  )
  assert(
    groupExportOperationOptions(aroundInMilling, listExportOperationOptions(aroundInMilling)).length === 0,
    'and its setup gets no export group',
  )

  // A single flat setup keeps the unlabelled legacy group.
  const flat: Project = {
    ...project,
    tools: [{ ...project.tools[0], id: 'tool-1' }],
    operations: [makeOperation('op1')],
  }
  const flatGroups = groupExportOperationOptions(flat, listExportOperationOptions(flat))
  assert(flatGroups[0].setup === null && flatGroups[0].face === 'top', 'a single flat setup stays the unlabelled group')
}

const tests = [
  testHealthyVisibleOperationIsExportableAndDefaultSelected,
  testHiddenToolpathIsExportableButNotDefaultSelected,
  testDisabledOperationIsNotExportable,
  testMissingToolIsNotExportable,
  testOptionsPreserveExecutionOrder,
  testOtherFamilyOperationStaysOnTheChecklist,
  testFileNameUsesProjectNameForMultipleOperations,
  testFileNameAppendsSingleOperationName,
  testExportPathIsReusedOnlyForTheSameKindOfFile,
  testAroundOnlySetupIsItsOwnGroup,
]

for (const test of tests) {
  test()
}

console.log('exportOperationSelection tests passed')
