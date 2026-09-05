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
 * A curved text run keeps its baseline through unrelated edits (issue #726).
 *
 * #671 moved the baseline onto the instance, but three functions build a
 * `FeatureInstance` field by field and none carried the new field. Because every
 * action in `featureGeometrySlice` rebuilds *all* rows through
 * `instanceFromResolved`, editing any feature anywhere straightened every curved
 * run in the project; `createFeatureInstance` did the same to copies.
 *
 * `textLayout` is optional, so a constructor that omits it is still a well-typed
 * `FeatureInstance` — nothing but a test can catch this.
 *
 * Both assertions read the *resolved* baseline, not the stored row, so they fail
 * if any layer along the path drops it.
 *
 * Run with: npx tsx src/store/textLayoutPersistence.test.ts
 */

import { newProject, rectProfile, type Project, type TextLayout } from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import { useProjectStore } from './projectStore'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeProject(): Project {
  return projectWithFeatures(newProject(), [
    {
      id: 'guide', name: 'Guide', kind: 'rect', operation: 'add', visible: true, locked: false,
      z_top: 5, z_bottom: 0, folderId: null, text: null, stl: null,
      sketch: { origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [], profile: rectProfile(0, 0, 40, 20) },
    },
    {
      id: 'run', name: 'ABC', kind: 'text', operation: 'subtract', visible: true, locked: false,
      z_top: 5, z_bottom: 0, folderId: null, stl: null,
      text: { text: 'ABC', style: 'skeleton', fontId: 'simple_stroke', size: 10 },
      sketch: { origin: { x: 0, y: 0 }, orientationAngle: 90, dimensions: [], constraints: [], profile: rectProfile(200, 200, 30, 10) },
    },
  ])
}

const arcLayout: Extract<TextLayout, { kind: 'arc' }> = {
  kind: 'arc', center: { x: 0, y: 0 }, radius: 30, angleDegrees: 270, sweepDegrees: 120,
  anchor: 'center', fit: 'natural', direction: 'cw', orientation: 'follow',
}

function resetStore(): void {
  useProjectStore.setState({
    project: makeProject(),
    pendingAdd: null,
    history: { past: [], future: [], transactionStart: null },
    dirty: false,
  } as never)
}

/** Wrap the run on an arc through the real panel path, as the canvas does. */
function wrapRunOnArc(): void {
  useProjectStore.setState((s) => ({
    selection: { ...s.selection, selectedFeatureId: 'run', selectedFeatureIds: ['run'], mode: 'feature' },
  } as never))
  useProjectStore.getState().startTextLayout('arc')
  useProjectStore.getState().updateTextLayout(arcLayout)
  useProjectStore.getState().setTextLayoutCenter({ x: 215, y: 305 })
  assert(useProjectStore.getState().completeTextLayout().length === 1, 'the arc applies to the run')
  assert(baselineKindOf('run') === 'arc', 'the run is wrapped before the edit under test')
}

function baselineKindOf(featureId: string): string {
  const feature = resolveFeatureInstance(useProjectStore.getState().project, featureId)
  assert(feature, `feature ${featureId} resolves`)
  return feature.textLayout?.kind ?? 'straight'
}

// ── Editing a different feature leaves the baseline alone ──────────

{
  resetStore()
  wrapRunOnArc()

  // Drag a corner of the *rect*, which has nothing to do with the run. Every
  // featureGeometrySlice action rebuilds all rows, so this is the wide case.
  useProjectStore.getState().moveFeatureControl('guide', { kind: 'anchor', index: 1 }, { x: 50, y: 0 })
  assert(baselineKindOf('run') === 'arc', 'editing another feature must not straighten the run')

  // A patch on the run itself must not lose it either.
  useProjectStore.getState().updateFeature('run', { name: 'Renamed' })
  assert(baselineKindOf('run') === 'arc', 'patching the run must not straighten it')
}

// ── A copy of a wrapped run is wrapped, and so is the original ─────

{
  resetStore()
  wrapRunOnArc()

  useProjectStore.getState().startCopyFeature('run', 'reference')
  useProjectStore.getState().setPendingMoveFrom({ x: 215, y: 205 })
  useProjectStore.getState().completePendingMove({ x: 300, y: 300 }, 1)

  const copyId = useProjectStore.getState().project.features
    .map((feature) => feature.id)
    .find((id) => id !== 'run' && id !== 'guide')
  assert(copyId, 'the copy lands as a new row')
  assert(baselineKindOf(copyId) === 'arc', 'a copy of a wrapped run is wrapped')
  assert(baselineKindOf('run') === 'arc', 'copying does not straighten the original')
}

console.log('✓ All text layout persistence tests passed.')
