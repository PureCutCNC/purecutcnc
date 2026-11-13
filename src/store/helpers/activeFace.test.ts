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
 * Which features may change their authoring face (issue #1102 slice L).
 *
 * Only a feature that goes through the whole stock has a second face to be
 * measured from: a through subtract or a full-height add. A blind pocket, a
 * partial-height add, a region and construction geometry stay on the face
 * they belong to, and Around never moves between the flat faces.
 *
 * Features on a 100 × 80 × 20 stock:
 *  - `through-hole` (Top, subtract 20 → 0), the qualifying subtract;
 *  - `blind-pocket` (Top, subtract 20 → 14), the case Frank hit;
 *  - `full-height-add` (Top, add 20 → 0), qualifying material;
 *  - `partial-add` (Top, add 20 → 8), not;
 *  - `region` (Top, region 20 → 0), never machined itself;
 *  - `construction` (Top, construction 20 → 0), sketch reference only;
 *  - `around-hole` (Around, subtract 20 → 0), a different surface.
 *
 * Mutations checked by hand:
 *  - dropping the span check from `canChangeAuthoringFace` → the
 *    `blind-pocket` assertion fails;
 *  - dropping the role check → the `region` assertion fails.
 *
 * Run with: npx tsx src/store/helpers/activeFace.test.ts
 */

import assert from 'node:assert/strict'
import { canChangeAuthoringFace, faceChangeSelection } from './activeFace'
import { projectWithFeatures, resolvedFeatures } from '../../test/projectFixtures'
import { newProject, rectProfile } from '../../types/project'
import type { FeatureOperation, Project, SetupFace, SketchFeature } from '../../types/project'

function feature(
  id: string,
  operation: FeatureOperation,
  zTop: number,
  zBottom: number,
  authoringFace: SetupFace = 'top',
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(10, 10, 20, 20),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: zTop,
    z_bottom: zBottom,
    authoringFace,
    visible: true,
    locked: false,
  }
}

function fixture(): Project {
  const base = newProject('face change', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 100, 80), thickness: 20 }
  return projectWithFeatures(base, [
    feature('through-hole', 'subtract', 20, 0),
    feature('blind-pocket', 'subtract', 20, 14),
    feature('full-height-add', 'add', 20, 0),
    feature('partial-add', 'add', 20, 8),
    feature('region', 'region', 20, 0),
    feature('construction', 'construction', 20, 0),
    feature('around-hole', 'subtract', 20, 0, 'around'),
  ])
}

function row(project: Project, id: string) {
  const found = project.features.find((feature) => feature.id === id)
  if (!found) throw new Error(`Expected test feature ${id}.`)
  return found
}

const project = fixture()

assert.equal(canChangeAuthoringFace(project, row(project, 'through-hole')), true, 'a subtract through the whole stock can change face')
assert.equal(canChangeAuthoringFace(project, row(project, 'blind-pocket')), false, 'a blind pocket cannot change face')
assert.equal(canChangeAuthoringFace(project, row(project, 'full-height-add')), true, 'a full-height add can change face')
assert.equal(canChangeAuthoringFace(project, row(project, 'partial-add')), false, 'a partial-height add cannot change face')
assert.equal(canChangeAuthoringFace(project, row(project, 'region')), false, 'a region cannot change face')
assert.equal(canChangeAuthoringFace(project, row(project, 'construction')), false, 'construction geometry cannot change face')
assert.equal(canChangeAuthoringFace(project, row(project, 'around-hole')), false, 'an Around feature cannot change face')

// The context menu asks the same rule of a resolved feature, whose role comes
// from its own `operation` rather than the definition lookup.
const resolved = resolvedFeatures(project).find((feature) => feature.id === 'through-hole')
assert(resolved, 'the through hole resolves')
assert.equal(canChangeAuthoringFace(project, resolved), true, 'a resolved through hole can change face')

// A span that cannot be resolved answers no: unknown never qualifies.
const dangling = { ...row(project, 'through-hole'), z_top: 'missing-dimension' as const }
assert.equal(canChangeAuthoringFace(project, dangling), false, 'a dangling dimension reference cannot change face')

// The confirmation's own plan: the qualifying features move, the rest are
// counted so the dialog can say how many stay behind.
const requested = ['through-hole', 'blind-pocket', 'full-height-add', 'partial-add', 'region']
  .map((id) => row(project, id))
const plan = faceChangeSelection(project, requested, 'top')
assert.deepEqual(plan.movable.map((feature) => feature.id), ['through-hole', 'full-height-add'], 'only the through features move')
assert.equal(plan.notThrough, 3, 'the blind pocket, the partial add and the region stay behind')
assert.equal(plan.locked, 0, 'nothing requested is locked')

// A locked through feature counts as locked, not as not-through.
const locked = faceChangeSelection(project, [{ ...row(project, 'through-hole'), locked: true }], 'top')
assert.deepEqual(locked.movable, [], 'a locked feature does not move')
assert.equal(locked.locked, 1, 'the locked feature is reported as locked')
assert.equal(locked.notThrough, 0, 'a locked feature is not also reported as not through')

// A confirmation only moves one way: nothing on Top moves to Bottom.
const otherWay = faceChangeSelection(project, requested, 'bottom')
assert.deepEqual(otherWay.movable, [], 'Top features do not move in a Bottom confirmation')
assert.equal(otherWay.notThrough, 0, 'features on the other face are not counted as not through')

console.log('activeFace tests passed')
