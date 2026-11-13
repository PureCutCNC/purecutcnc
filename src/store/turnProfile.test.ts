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
 * Turn profile pick, Refresh and the copied outline (issue #1112 slice H,
 * decision 11).
 *
 * Run with: npx tsx src/store/turnProfile.test.ts
 *
 * Load-bearing properties:
 *
 * 1. **The copy is authoritative.** Editing the drawn spline after creation
 *    leaves the Turn's mesh byte-identical; only Refresh re-reads it. A live
 *    link instead of a copy is the first mutation this test must catch.
 * 2. **Refresh is refused with the reason when the source is gone**, and
 *    disabled the same way once the source no longer exists.
 * 3. **The revolved spline gives the drawn radii along the bar**, not a
 *    cylinder: every copied station's mesh radius equals the profile radius.
 * 4. **Save → load → regenerate is exact**, and the profile's source id
 *    survives the file.
 *
 * Other mutations checked one at a time:
 * - an axis-crossing outline accepted → the crossing refusal fails;
 * - an outline doubling back along the bar accepted → the doubling refusal
 *   fails;
 * - the profile's own along extent ignored (a cylinder drawn from start and
 *   length instead) → the mesh radius at the spline station fails;
 * - `sourceFeatureId` dropped from the stored copy → the refresh/round-trip
 *   assertions fail.
 */

import assert from 'node:assert/strict'
import {
  newProject,
  roundStock,
  type Project,
  type SketchFeature,
  type SketchProfile,
} from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { bundledMachines } from '../machine/registry'
import { validateMachineDefinition } from '../engine/gcode/types'
import { generateCannedShapeMesh } from '../cannedShapes'
import { turnProfileRadiusAt } from '../cannedShapes/generators/turnProfile'
import { rotarySolidFrame } from '../cannedShapes/generators/rotarySolidParams'
import { switchWorkspaceFace } from './workspaceFace'
import { resolveFeatureInstance } from './helpers/resolveFeatures'
import {
  rotarySolidCannedData,
  turnProfileCandidates,
  turnProfileFromFeature,
  turnProfileRefreshState,
} from './helpers/rotarySolids'
import { useProjectStore } from './projectStore'

const store = () => useProjectStore.getState()

function assertNear(actual: number, expected: number, label: string, tolerance = 1e-3): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}

// ── fixtures ──────────────────────────────────────────────────

const BAR_AT = { x: 10, y: 30 }
const CENTRE = 50
const PIVOT = 20

/** A half-profile on Top: a curved rise from the axis, a flat land, a face. */
const SPLINE: SketchProfile = {
  start: { x: 30, y: CENTRE },
  segments: [
    { type: 'bezier', control1: { x: 35, y: 45 }, control2: { x: 45, y: 40 }, to: { x: 60, y: 40 } },
    { type: 'line', to: { x: 80, y: 40 } },
    { type: 'line', to: { x: 80, y: CENTRE } },
  ],
  closed: false,
}

function rotaryProject(): Project {
  const base = newProject('Turn profile', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(40, 200, 'x', BAR_AT)
  const machine = validateMachineDefinition({
    ...structuredClone(bundledMachines()[0]),
    id: 'around-profile',
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  const draft: SketchFeature = {
    id: 'f-half-profile',
    name: 'Half profile',
    kind: 'spline',
    folderId: null,
    sketch: {
      profile: SPLINE,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'construction',
    authoringFace: 'top',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
  return projectWithFeatures(base, [draft])
}

function load(): Project {
  const project = rotaryProject()
  store().loadProject(project)
  assert.equal(switchWorkspaceFace('around'), true, 'the workspace enters Around')
  return store().project
}

function meshOf(featureId: string) {
  const project = store().project
  const feature = project.features.find((row) => row.id === featureId)
  assert.ok(feature, 'the Turn row exists')
  const definition = project.featureDefinitions[feature.definitionId]
  assert.ok(definition?.canned, 'the Turn keeps its canned parameters')
  const mesh = generateCannedShapeMesh(definition.canned)
  assert.ok(mesh, 'the Turn generates a mesh')
  return mesh
}

/** The largest radius among the mesh vertices on one along station. */
function meshRadiusAt(positions: Float32Array, along: number, tolerance = 1e-2): number {
  let radius = 0
  for (let index = 0; index < positions.length / 3; index += 1) {
    const x = positions[index * 3]
    if (Math.abs(x - along) > tolerance) continue
    const across = positions[index * 3 + 1] - CENTRE
    const up = positions[index * 3 + 2] - PIVOT
    radius = Math.max(radius, Math.hypot(across, up))
  }
  return radius
}

// ── pick ─────────────────────────────────────────────────────

const project = load()
const frame = rotarySolidFrame(project)
assert.ok(frame, 'the fixture is a bar')

const candidates = turnProfileCandidates(project)
assert.deepEqual(candidates.map((candidate) => candidate.id), ['f-half-profile'], 'the drawn profile is offered')

const picked = turnProfileFromFeature(project, frame, 'f-half-profile')
if (!picked.ok) throw new Error(`the drawn spline was refused: ${picked.reason}`)
assertNear(picked.start, 20, 'the profile start is measured from the chuck end')
assertNear(picked.length, 50, 'the profile along extent')
assertNear(picked.diameter, 20, 'the profile diameter is twice its largest radius')
assert.equal(picked.profile.sourceFeatureId, 'f-half-profile', 'the source id is copied')
assert.equal(picked.profile.contours.length, 1, 'one copied outline')

const created = store().addRotarySolid({
  kind: 'turn',
  start: picked.start,
  length: picked.length,
  diameter: picked.diameter,
  profile: picked.profile,
})
if (!created.ok) throw new Error(`the profiled Turn was refused: ${created.reason}`)

const createdMesh = meshOf(created.featureId)
// Every sampled station of the drawn spline has the drawn radius in the mesh.
const copiedPoints = picked.profile.contours[0].points
for (const point of copiedPoints) {
  const expected = turnProfileRadiusAt(picked.profile, point.along)
  assert.ok(expected !== null)
  assertNear(meshRadiusAt(createdMesh.positions, point.along), expected, `radius at along ${point.along}`)
}
assertNear(meshRadiusAt(createdMesh.positions, 60), 10, 'the spline land is Ø20')
assertNear(meshRadiusAt(createdMesh.positions, 80), 10, 'the cylindrical section keeps its diameter')

// ── the copy does not follow the source ──────────────────────

const moved: SketchProfile = {
  ...SPLINE,
  segments: [
    { type: 'bezier', control1: { x: 35, y: 45 }, control2: { x: 45, y: 44 }, to: { x: 60, y: 44 } },
    SPLINE.segments[1]!,
    SPLINE.segments[2]!,
  ],
}
store().updateFeature('f-half-profile', { sketch: { ...resolveFeatureInstance(store().project, 'f-half-profile')!.sketch, profile: moved } })
assertNear(meshRadiusAt(meshOf(created.featureId).positions, 60), 10, 'editing the source does not move the copied Turn')

const refreshed = turnProfileFromFeature(store().project, frame, 'f-half-profile')
if (!refreshed.ok) throw new Error(`Refresh refused the edited source: ${refreshed.reason}`)
assertNear(turnProfileRadiusAt(refreshed.profile, 60) ?? 0, 6, 'the refreshed copy sees the new radius')

const refreshedCanned = rotarySolidCannedData(
  frame,
  {
    kind: 'turn',
    start: refreshed.start,
    length: refreshed.length,
    diameter: refreshed.diameter,
    profile: refreshed.profile,
  },
  store().project.meta.units,
)
assert.ok(refreshedCanned, 'the refreshed profile builds stored parameters')
store().updateFeature(created.featureId, { canned: refreshedCanned })
assertNear(meshRadiusAt(meshOf(created.featureId).positions, 60), 6, 'Refresh copies the edited spline into the Turn')

// ── round-trip ───────────────────────────────────────────────

const beforeRoundTrip = meshOf(created.featureId)
const file = store().saveProject()
store().openProjectFromText(file, null)
const afterRoundTrip = meshOf(created.featureId)
assert.deepEqual(
  Array.from(afterRoundTrip.positions),
  Array.from(beforeRoundTrip.positions),
  'the saved profile regenerates the same vertices',
)
assert.deepEqual(
  Array.from(afterRoundTrip.indices),
  Array.from(beforeRoundTrip.indices),
  'the saved profile regenerates the same triangles',
)
const savedDefinition = store().project.featureDefinitions[
  store().project.features.find((row) => row.id === created.featureId)!.definitionId
]
assert.equal(
  savedDefinition.canned?.params.profile &&
    (savedDefinition.canned.params.profile as { sourceFeatureId?: string }).sourceFeatureId,
  'f-half-profile',
  'the source id survives the file',
)

// ── refusals ─────────────────────────────────────────────────

function pickWith(profile: SketchProfile): ReturnType<typeof turnProfileFromFeature> {
  store().updateFeature('f-half-profile', {
    sketch: { ...resolveFeatureInstance(store().project, 'f-half-profile')!.sketch, profile },
  })
  return turnProfileFromFeature(store().project, frame!, 'f-half-profile')
}

const crossing = pickWith({
  start: { x: 30, y: 40 },
  segments: [
    { type: 'line', to: { x: 40, y: 60 } },
    { type: 'line', to: { x: 60, y: 40 } },
  ],
  closed: false,
})
assert.equal(crossing.ok === false && crossing.reason, 'profileCrossesAxis', 'an axis-crossing outline is refused')

const doubling = pickWith({
  start: { x: 30, y: 40 },
  segments: [
    { type: 'line', to: { x: 60, y: 45 } },
    { type: 'line', to: { x: 40, y: 45 } },
  ],
  closed: false,
})
assert.equal(doubling.ok === false && doubling.reason, 'profileDoublesBack', 'an outline doubling back is refused')

const pastStock = pickWith({
  start: { x: 30, y: 40 },
  segments: [
    { type: 'line', to: { x: 60, y: 5 } },
  ],
  closed: false,
})
assert.equal(pastStock.ok === false && pastStock.reason, 'profileExceedsStock', 'a profile past the bar surface is refused')

const outOfBar = pickWith({
  start: { x: 5, y: 40 },
  segments: [
    { type: 'line', to: { x: 60, y: 45 } },
  ],
  closed: false,
})
assert.equal(outOfBar.ok === false && outOfBar.reason, 'profileOutOfBar', 'a profile past the bar ends is refused')

// ── Refresh disabled after the source is deleted ─────────────

store().deleteFeature('f-half-profile')
const storedProfile = savedDefinition.canned?.params.profile as Parameters<typeof turnProfileRefreshState>[2]
const refreshState = turnProfileRefreshState(store().project, frame, storedProfile)
assert.equal(refreshState.canRefresh, false, 'Refresh is unavailable once the source is gone')
assert.equal(
  refreshState.canRefresh === false && refreshState.reason,
  'profileMissingSource',
  'the reason names the missing source',
)
assert.ok(meshOf(created.featureId), 'the copied Turn still generates after the source is deleted')

console.log('turn profile: all assertions passed.')
