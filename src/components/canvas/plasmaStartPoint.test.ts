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
import type { SketchFeature, SketchProfile } from '../../types/project'
import { newProject, circleProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { pickPlasmaStartPoint } from './plasmaStartPoint'
import { canvasToWorld, computeSketchViewTransform, worldToCanvas } from './viewTransform'

const square: SketchProfile = { start: { x: 20, y: 30 }, segments: [
  { type: 'line', to: { x: 80, y: 30 } }, { type: 'line', to: { x: 80, y: 90 } },
  { type: 'line', to: { x: 20, y: 90 } }, { type: 'line', to: { x: 20, y: 30 } },
], closed: true }
const feature = (id: string, profile = square): SketchFeature => ({ id, name: id, kind: 'rect', operation: 'add', folderId: null, visible: true, locked: false, z_top: 6, z_bottom: 0,
  sketch: { profile, dimensions: [], constraints: [], origin: { x: 0, y: 0 }, orientationAngle: 0 } })
const project = projectWithFeatures(newProject('Pick fixture', 'mm'), [feature('target'), feature('other', circleProfile(150, 60, 20))])
const operation = defaultOperationForTarget(project, 'plasma_profile', 'rough', { source: 'features', featureIds: ['target'] }, 0)
assert.deepEqual(pickPlasmaStartPoint(project, operation, { x: 53, y: 32 }, 3), { point: { x: 53, y: 30 }, local: { x: 53, y: 30 }, contourId: 'target' }, 'pick projects onto selected contour, not arbitrary XY')
assert.equal(pickPlasmaStartPoint(project, operation, { x: 50, y: 60 }, 3), null, 'interior click does not pick an edge')
assert.equal(pickPlasmaStartPoint(project, operation, { x: 150, y: 40 }, 3), null, 'unrelated visible contour is not a target')
assert.equal(pickPlasmaStartPoint(project, { ...operation, kind: 'pocket' }, { x: 53, y: 32 }, 3), null)
assert.equal(pickPlasmaStartPoint(project, operation, { x: NaN, y: 30 }, 3), null)
const hidden = structuredClone(project); hidden.features[0].visible = false
assert.equal(pickPlasmaStartPoint(hidden, operation, { x: 53, y: 30 }, 3), null)
const open = projectWithFeatures(newProject('Open', 'mm'), [feature('target', { ...square, closed: false })])
assert.equal(pickPlasmaStartPoint(open, operation, { x: 53, y: 30 }, 3), null)
for (const viewState of [{ zoom: 1, panX: 0, panY: 0 }, { zoom: 3, panX: -117, panY: 49 }]) {
  const vt = computeSketchViewTransform(project, 900, 600, viewState)
  const screen = worldToCanvas({ x: 53, y: 30 }, vt)
  const world = canvasToWorld(screen.cx, screen.cy, vt)
  const picked = pickPlasmaStartPoint(project, operation, world, 18 / vt.scale)
  assert.ok(picked && Math.hypot(picked.point.x - 53, picked.point.y - 30) < 1e-8, 'pan/zoom pick uses authoritative sketch transform')
}
console.log('plasma start picking: targeted contour, visibility, closed paths and pan/zoom passed')

const linked = structuredClone(project)
linked.features.push({ ...linked.features[0], id: 'linked', name: 'Linked', transform: { a: 0, b: 2, c: -2, d: 0, e: 300, f: 10 } })
const multi = { ...operation, target: { source: 'features' as const, featureIds: ['target', 'linked'] } }
assert.deepEqual(pickPlasmaStartPoint(linked, multi, { x: 240, y: 116 }, 3), {
  point: { x: 240, y: 116 }, local: { x: 53, y: 30 }, contourId: 'linked',
}, 'linked rotated/scaled target stores its own local point and ID')
const bottom = structuredClone(project)
bottom.features[0].authoringFace = 'bottom'
assert.equal(pickPlasmaStartPoint(bottom, operation, { x: 53, y: 30 }, 3), null, 'ghost feature is never pickable')
const singular = structuredClone(project); singular.features[0].transform = { a: 0, b: 0, c: 0, d: 0, e: 53, f: 30 }
assert.equal(pickPlasmaStartPoint(singular, operation, { x: 53, y: 30 }, 3), null, 'singular placement cannot attach a point')
