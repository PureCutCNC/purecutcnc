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
import { test } from 'node:test'
import { normalizeProject, useProjectStore } from './projectStore'
import { operationComputationEquals } from '../app/useToolpathGeneration'
import { surfaceTestProject, slopeTestMesh, mixedSlopeHeight } from '../test/surfaceSlopeFixtures'
import { generateFinishSurfaceToolpath } from '../engine/toolpaths/finishSurface'

test('slope settings survive normalization, save/open, undo/redo and explicit clearing', () => {
  const { project, operation } = surfaceTestProject(slopeTestMesh(mixedSlopeHeight))
  useProjectStore.getState().loadProject(project)
  const before = useProjectStore.getState().project.operations[0]
  assert.equal(before.finishSlopeMin, undefined)
  assert.equal(before.finishSlopeMax, undefined)
  useProjectStore.getState().updateOperation(operation.id, { finishSlopeMin: 5, finishSlopeMax: 30 })
  const filtered = useProjectStore.getState().project.operations[0]
  assert(!operationComputationEquals(before, filtered))
  useProjectStore.getState().undo()
  assert.equal(useProjectStore.getState().project.operations[0].finishSlopeMax, undefined)
  useProjectStore.getState().redo()
  const saved = useProjectStore.getState().saveProject()
  useProjectStore.getState().openProjectFromText(saved, null)
  assert.equal(useProjectStore.getState().project.operations[0].finishSlopeMin, 5)
  assert.equal(useProjectStore.getState().project.operations[0].finishSlopeMax, 30)
  useProjectStore.getState().updateOperation(operation.id, { finishSlopeMin: undefined, finishSlopeMax: undefined })
  const cleared = useProjectStore.getState().project.operations[0]
  assert(!operationComputationEquals(filtered, cleared))
  assert.equal(cleared.finishSlopeMin, undefined)
  assert.equal(cleared.finishSlopeMax, undefined)
  const clearedSave = JSON.parse(useProjectStore.getState().saveProject())
  assert(!('finishSlopeMin' in clearedSave.operations[0]))
  assert(!('finishSlopeMax' in clearedSave.operations[0]))
  for (const bad of [null, '30', 91, -1]) {
    const raw = JSON.parse(saved)
    raw.operations[0].finishSlopeMax = bad
    const loaded = normalizeProject(raw)
    const result = generateFinishSurfaceToolpath(loaded, loaded.operations[0])
    assert.equal(result.moves.length, 0)
    assert.deepEqual(result.warnings, [{ code: 'finishSlopeInvalid' }])
  }
})
