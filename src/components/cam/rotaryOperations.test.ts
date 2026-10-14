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

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { defaultOperationForTarget, isOperationTargetValid } from '../../store/helpers/operationDefaults'
import { operationTargetVerdicts, targetAllowedInSetup, setupGenerationBlock } from '../../engine/setupTargets'
import { getOperationAddHint, rotaryOperationHint, selectAllCompatibleFeatureIds, operationTargetFromSelection } from './operationValidity'
import { OPERATION_FIELD_GROUP_IDS, operationFieldsForGroup } from './operationFields'
import { operationComputationEquals } from '../../app/toolpathGeneration/cacheInputs'
import { camT } from './camI18n'
import { useProjectStore } from '../../store/projectStore'
import { convertProjectUnits } from '../../utils/units'
import { preferredToolTypes } from '../../engine/operations/toolSelection'
import { toolpathLevels } from '../toolpathLevels'
import type { SelectionState } from '../../store/types'

for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
  const project = rotaryOperationFixture('x', kind)
  const operation = project.operations[0]
  const target = operation.target
  assert.ok(isOperationTargetValid(project, kind, target))
  assert.ok(targetAllowedInSetup(project, target, 'around', kind))
  assert.equal(operationTargetVerdicts(project, operation)[0].status, 'same-face')
  assert.equal(setupGenerationBlock(project, operation), null, 'model extending below centreline is allowed for rotary sampling')
  assert.ok(!targetAllowedInSetup(project, target, project.setups[0].id, kind), 'rotary is invalid on Top')
  assert.ok(!targetAllowedInSetup(project, { source: 'features', featureIds: ['sketch'] }, 'around', kind), 'rotary refuses 2D Around targets')
  assert.ok(!isOperationTargetValid(project, kind, { source: 'features', featureIds: ['model', 'sketch'] }))
  assert.ok(!targetAllowedInSetup(project, target, 'around', 'pocket'), 'Around pockets still refuse imported models')
  assert.equal(operationTargetVerdicts(project, { ...operation, kind: 'pocket' })[0].status, 'rejected')
  assert.equal(rotaryOperationHint(project, operation), null)
  assert.equal(rotaryOperationHint({ ...project, stock: { ...project.stock, shape: undefined } }, operation), camT('cam.rotary.roundStockRequired'))
  assert.equal(rotaryOperationHint(project, { ...operation, setupId: project.setups[0].id }), camT('cam.rotary.aroundRequired'))
  assert.equal(
    rotaryOperationHint(project, { ...operation, target: { source: 'features', featureIds: [] } }),
    camT(kind === 'rotary_rough' ? 'cam.rotary.roughNoModel' : 'cam.rotary.finishNoModel'),
  )
  assert.equal(rotaryOperationHint(project, { ...operation, target: { source: 'features', featureIds: ['sketch'] } }), camT('cam.rotary.modelOnly'))
  assert.equal(rotaryOperationHint({ ...project, tools: [{ ...project.tools[0], type: 'v_bit' }] }, operation), camT('cam.rotary.toolRequired'))
  assert.equal(rotaryOperationHint(project, { ...operation, toolRef: null }), camT('cam.operation.noTool'))
  const selection: SelectionState = { ...useProjectStore.getState().selection, selectedFeatureId: 'model', selectedFeatureIds: ['model'] }
  assert.equal(getOperationAddHint(project, selection, kind), null)
  assert.deepEqual(operationTargetFromSelection(project, selection, kind), target)
  assert.deepEqual(selectAllCompatibleFeatureIds(project, kind), ['model'])
  const defaults = defaultOperationForTarget(project, kind, kind === 'rotary_finish' ? 'rough' : 'finish', target, 1)
  assert.equal(defaults.pass, kind === 'rotary_rough' ? 'rough' : 'finish')
  assert.equal(defaults.stepover, project.tools[0].defaultStepover)
  assert.equal(defaults.stepdown, project.tools[0].defaultStepdown)
  assert.equal(defaults.rotaryChuckSupport, 0)
  assert.equal(defaults.rotaryTailSupport, 0)
  assert.ok(!operationComputationEquals(operation, { ...operation, rotaryChuckSupport: 5 }))
  assert.ok(!operationComputationEquals(operation, { ...operation, rotaryTailSupport: 6 }))
  assert.ok(operationComputationEquals(operation, { ...operation, rotaryChuckSupport: undefined, rotaryTailSupport: undefined }))
  const fields = OPERATION_FIELD_GROUP_IDS.flatMap((group) => operationFieldsForGroup(group, operation, project.tools[0]).map((field) => field.id))
  assert.deepEqual(fields.sort(), ['name','description','kind','enabled','target','targetSource','tool','stepover', ...(kind === 'rotary_rough' ? ['stepdown'] : []), 'stockToLeaveRadial','feed','plungeFeed','rpm','rotaryChuckSupport','rotaryTailSupport'].sort(), 'only the specified rotary controls are visible')
  assert.deepEqual(preferredToolTypes(kind), ['ball_endmill', 'flat_endmill'])
  assert.deepEqual(toolpathLevels({ moves: [] }, operation), [])
  const converted = convertProjectUnits({ ...project, operations: [{ ...operation, rotaryChuckSupport: 25.4, rotaryTailSupport: 50.8 }] }, 'inch')
  assert.equal(converted.operations[0].rotaryChuckSupport, 1)
  assert.equal(converted.operations[0].rotaryTailSupport, 2)
  const store = useProjectStore.getState
  store().loadProject(project)
  const id = store().addOperation(kind, 'rough', target)
  assert.ok(id, 'store creates a rotary operation in Around')
  store().updateOperation(id, { rotaryChuckSupport: 9, rotaryTailSupport: 7 })
  const saved = JSON.parse(store().saveProject())
  store().openProjectFromText(JSON.stringify(saved), null)
  assert.equal(store().project.version, '3.3')
  assert.equal(store().project.operations.find((row) => row.id === id)!.kind, kind)
  assert.equal(store().project.operations.find((row) => row.id === id)!.rotaryChuckSupport, 9)
  assert.equal(store().project.operations.find((row) => row.id === id)!.rotaryTailSupport, 7)
}
// Existing 3.3 file has no new values: normal import/export must not backfill them.
const oldText = readFileSync(new URL('../../../public/examples/badge.camj', import.meta.url), 'utf8')
const store = useProjectStore.getState
store().openProjectFromText(oldText, null)
const saved = store().saveProject()
const first = JSON.parse(saved)
assert.ok(first.operations.every((operation: Record<string, unknown>) => !('rotaryChuckSupport' in operation) && !('rotaryTailSupport' in operation)))
store().openProjectFromText(saved, null)
const second = JSON.parse(store().saveProject())
second.meta.modified = first.meta.modified
assert.equal(JSON.stringify(second, null, 2), saved, 'existing CAMJ import/export is byte stable with the existing save timestamp held fixed')
console.log('rotary operation authoring tests passed')
