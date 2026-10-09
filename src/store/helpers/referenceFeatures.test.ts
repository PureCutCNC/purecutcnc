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

import { strict as assert } from 'node:assert'
import { BOTTOM_SETUP_ID, projectWithFeatures, withBottomSetup } from '../../test/projectFixtures'
import { DEFAULT_SETUP_ID, newProject, rectProfile, type SetupFace, type SketchFeature } from '../../types/project'
import { editableProjectFeatures } from './activeFace'
import { referenceProjectFeatures } from './referenceFeatures'

function row(id: string, face: SetupFace, operation: SketchFeature['operation']): SketchFeature {
  return { id, name: id, kind: 'rect', operation, authoringFace: face, visible: true, locked: false,
    z_top: 2, z_bottom: 0, folderId: null,
    sketch: { profile: rectProfile(13, 21, 7, 4), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] } }
}

for (const face of ['top', 'bottom'] as const) {
  const foreign = face === 'top' ? 'bottom' : 'top'
  const drafts = [row('own', face, 'add'), row('own-guide', face, 'construction'),
    row('guide', foreign, 'construction'), ...(['add', 'subtract', 'region', 'line'] as const).map(role => row(role, foreign, role))]
  drafts[2].locked = true
  const project = withBottomSetup(projectWithFeatures(newProject(), drafts))
  project.activeSetupId = face === 'top' ? DEFAULT_SETUP_ID : BOTTOM_SETUP_ID
  // Lightweight instances carry no operation; only the definition can decide eligibility.
  assert.equal('operation' in project.features[2], false)
  const snapshot = JSON.stringify(project)
  assert.deepEqual(referenceProjectFeatures(project, true).map(f => f.id), ['own', 'own-guide', 'guide'], `${face}: only foreign construction becomes a reference`)
  assert.deepEqual(referenceProjectFeatures(project, false).map(f => f.id), ['own', 'own-guide'], `${face}: hidden overlay excludes foreign references`)
  assert.deepEqual(editableProjectFeatures(project).map(f => f.id), ['own', 'own-guide'], `${face}: edit set stays unchanged`)
  assert.equal(referenceProjectFeatures(project, true)[2].locked, true, 'locked guides remain readable')
  assert.equal(JSON.stringify(project), snapshot, 'resolving reference candidates changes no document state')
}
console.log('referenceFeatures tests passed')
