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
 * The ghost rule after issue #1112 slice I: a ghost is a feature on the other
 * face that cannot be a target from here, and nothing else.
 *
 * Everything that can be a target is selectable, so plain selection reaches
 * every valid target and the two target checklists are gone:
 *  - a model (imported mesh or canned Turn/Polygon) is not tied to a face and
 *    is listed on every face;
 *  - a subtract that goes through the whole stock is a target on both flat
 *    faces — the same rule `judgeTargetFromFace` applies — and stays a ghost
 *    on Around, a different surface;
 *  - a blind cut, a full-height add (material, not a through cut) and an
 *    unresolvable span stay ghosts.
 *
 * Mutations checked one at a time against these assertions:
 *  - ghosts kept for every other-face feature (the old rule) → the through
 *    subtract and both model assertions fail;
 *  - models made a ghost on Around → the Around model assertions fail;
 *  - every other-face feature made selectable → the blind and full-height add
 *    assertions fail;
 *  - through-ness read without the stock span → the dangling-dimension
 *    assertion fails.
 *
 * Run with: npx tsx src/store/helpers/ghostTargets.test.ts
 */

import assert from 'node:assert/strict'
import { newProject, rectProfile } from '../../types/project'
import type { CannedShapeData, FeatureOperation, Project, SetupFace, SketchFeature } from '../../types/project'
import { BOTTOM_SETUP_ID, projectWithFeatures, withBottomSetup } from '../../test/projectFixtures'
import { DEFAULT_SETUP_ID } from '../../types/project'
import { ghostFeatureIds, isGhostFeature } from './activeFace'
import { resolveFeatureInstance } from './resolveFeatures'

function draft(
  id: string,
  kind: SketchFeature['kind'],
  operation: FeatureOperation,
  authoringFace: SetupFace,
  zTop: SketchFeature['z_top'] = 10,
  zBottom: SketchFeature['z_bottom'] = 4,
  canned: CannedShapeData | null = null,
): SketchFeature {
  return {
    id,
    name: id,
    kind,
    ...(canned ? { canned } : {}),
    folderId: null,
    sketch: { profile: rectProfile(1, 1, 3, 2), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation,
    z_top: zTop,
    z_bottom: zBottom,
    authoringFace,
    visible: true,
    locked: false,
  }
}

/** A canned polygon model, as slice G creates it: kind stl, operation model. */
const canned: CannedShapeData = { kind: 'polygon', params: {} } as unknown as CannedShapeData

function fixture(): Project {
  const base = newProject('ghost targets', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 100, 80), thickness: 20 }
  const project = projectWithFeatures(base, [
    draft('base', 'rect', 'add', 'top', 20, 0),
    draft('blind', 'rect', 'subtract', 'top', 10, 4),
    draft('through', 'rect', 'subtract', 'top', 20, 0),
    draft('dangling', 'rect', 'subtract', 'top', 20, 'missing-dimension'),
    draft('imported', 'stl', 'model', 'top', 8, 2),
    draft('canned', 'stl', 'model', 'top', 8, 2, canned),
  ])
  return withBottomSetup(project)
}

function ghostIds(project: Project): string[] {
  return [...ghostFeatureIds(project)].sort()
}

// On Top the project's own features are editable; the Bottom setup is empty.
{
  const project = fixture()
  assert.deepEqual(ghostIds(project), [], 'on Top nothing is a ghost: every feature is authored there')
  for (const id of ['base', 'blind', 'through', 'imported', 'canned']) {
    assert.equal(isGhostFeature(project, resolveFeatureInstance(project, id)!), false, `${id} is selectable on Top`)
  }
}

// On Bottom only what cannot be a target there is a ghost.
{
  const project = { ...fixture(), activeSetupId: BOTTOM_SETUP_ID }
  assert.deepEqual(
    ghostIds(project),
    ['base', 'blind', 'dangling'],
    'a full-height add, a blind cut and an unresolvable span stay ghosts; a through cut and both models are selectable',
  )
  for (const id of ['through', 'imported', 'canned']) {
    assert.equal(isGhostFeature(project, resolveFeatureInstance(project, id)!), false, `${id} is selectable on Bottom`)
  }
  for (const id of ['base', 'blind', 'dangling']) {
    assert.equal(isGhostFeature(project, resolveFeatureInstance(project, id)!), true, `${id} is a ghost on Bottom`)
  }
  // The instance row and its resolved view answer the same.
  const instance = project.features.find((feature) => feature.id === 'through')!
  assert.equal(isGhostFeature(project, instance), false, 'the stored row answers as the resolved one does')
}

// Around is a different surface: a through cut is not a target there, models are.
{
  const project = fixture()
  const around = { ...project.setups[1], id: 'setup-around', kind: 'around' as const }
  const onAround = { ...project, setups: [...project.setups, around], activeSetupId: around.id }
  assert.deepEqual(
    ghostIds(onAround),
    ['base', 'blind', 'dangling', 'through'],
    'the through cut is a ghost on Around; the models are not',
  )
  for (const id of ['imported', 'canned']) {
    assert.equal(isGhostFeature(onAround, resolveFeatureInstance(onAround, id)!), false, `${id} is selectable on Around`)
  }
}

// A top-only project is still a Top-only project: the ghost set is empty and
// the fast path in `editableFeatures` is not bypassed.
{
  const base = newProject('top only', 'mm')
  const project = projectWithFeatures(base, [draft('top', 'rect', 'add', 'top', 20, 0)])
  assert.equal(project.activeSetupId, DEFAULT_SETUP_ID, 'fixture: the project is on Top')
  assert.deepEqual(ghostIds(project), [], 'a Top-only project has no ghosts')
}

console.log('ghost target tests passed')
