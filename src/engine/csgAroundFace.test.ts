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

/// <reference types="node" />

/**
 * Around features in the 3D scene (#395 slice E).
 *
 * An Around feature's coordinates live on the bar's surface unrolled flat, so
 * carving one into the round solid would cut the top of the bar with sheet
 * geometry. The agreed rule is that an Around feature takes no part in the
 * solid, the feature meshes or the scene's other feature-derived output.
 *
 * The comparison is deliberately differential — the whole `SceneObjects` of a
 * project with a Top pad, a Top pocket and an Around pocket, against the same
 * project without the Around pocket — so the assertion says "the Around
 * feature changed nothing" rather than recording what the correct solid is.
 * Position arrays are compared exactly, which is what the sibling round-stock
 * tests compare.
 *
 * Run with: npx tsx src/engine/csgAroundFace.test.ts
 */

import * as THREE from 'three'
import {
  newProject,
  rectProfile,
  roundStock,
  type MachiningSetup,
  type Project,
  type SketchFeature,
  type SketchProfile,
} from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { THEME_PALETTES } from '../theme/palette'
import { buildScene, type SceneObjects } from './csg'

const threePalette = THEME_PALETTES.dark.three

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function positionsOf(object: THREE.Object3D): number[] {
  const attribute = (object as THREE.Mesh).geometry.getAttribute('position')
  return Array.from(attribute.array as ArrayLike<number>)
}

function draft(id: string, kind: SketchFeature['kind'], profile: SketchProfile, operation: SketchFeature['operation']): SketchFeature {
  return {
    id, name: id, kind, folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation, z_top: 40, z_bottom: 0, authoringFace: 'top', visible: true, locked: false,
  }
}

const AROUND_SETUP: MachiningSetup = {
  id: 'setup-around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 },
  indexing: 'manual', registration: [], notes: '', operationIds: [],
}

// A 40 mm bar 200 mm long, off the origin like the sibling round-stock tests.
const BAR = roundStock(40, 200, 'x', { x: 10, y: 30 })

/**
 * A bar with a Top pad (the base solid), a Top pocket and — when
 * `withAroundPocket` — a third pocket whose unrolled coordinates sit over the
 * bar's centreline. That third feature is the only difference between the two
 * projects the test compares.
 */
function barProject(withAroundPocket: boolean): Project {
  const features: SketchFeature[] = [
    draft('pad', 'rect', rectProfile(20, 40, 60, 30), 'add'),
    draft('top-pocket', 'rect', rectProfile(40, 45, 20, 20), 'subtract'),
  ]
  if (withAroundPocket) {
    // Sheet space: x along the bar, y across from the sheet's zero line
    // (stock min Y = 30), depth stored Top-style from the surface (z = 40).
    features.push({ ...draft('around-pocket', 'rect', rectProfile(100, 35, 20, 15), 'subtract'), authoringFace: 'around' })
  }
  const base = projectWithFeatures({ ...newProject('around-face'), stock: BAR }, features)
  return {
    ...base,
    setups: [...base.setups, AROUND_SETUP],
    activeSetupId: base.activeSetupId,
  }
}

function sceneSummary(scene: SceneObjects): Record<string, unknown> {
  return {
    stock: positionsOf(scene.stockMesh),
    wireframe: positionsOf(scene.stockWireframe),
    // `null` is meaningful here: it says no boolean solid was produced at all.
    model: scene.modelMesh ? positionsOf(scene.modelMesh) : null,
    featureMeshIds: [...scene.featureMeshes.keys()].sort(),
    batchedLines: scene.batchedLines.map(positionsOf),
    batchedLinesMeta: scene.batchedLinesMeta,
  }
}

const withAround = await buildScene(barProject(true), threePalette)
const withoutAround = await buildScene(barProject(false), threePalette)

// A vacuous pass would be the failure mode of a differential test, so first
// prove the shared fixture really builds the model and the top pocket.
assert(withoutAround.modelMesh, 'fixture: the bar without the Around pocket builds a boolean solid')
assert(withoutAround.stockMesh !== undefined, 'fixture: the bar builds a stock mesh')
assert(withoutAround.featureMeshes.size === 0, 'fixture: no feature gets its own mesh in the successful boolean path')

const actual = sceneSummary(withAround)
const expected = sceneSummary(withoutAround)
assert(
  JSON.stringify(actual) === JSON.stringify(expected),
  'the Around pocket changes nothing in the scene',
)
assert(
  (actual.model as number[]).length > 0,
  'fixture: the shared solid is not empty, so the comparison is not vacuous',
)
assert(
  (actual.stock as number[]).length > 0,
  'fixture: the round bar is drawn, so the comparison covers it',
)

// The Around feature is still in the project: this is the scene excluding it,
// not a fixture that dropped it.
const aroundFeature = barProject(true).features.find((feature) => feature.id === 'around-pocket')
assert(aroundFeature?.authoringFace === 'around', 'fixture: the Around feature is present and tagged')

// The other half of the rule: an Around feature on its own leaves the bar
// exactly as it is — no boolean solid and no feature mesh of its own.
const aroundOnly = projectWithFeatures(
  { ...newProject('around-only'), stock: BAR },
  [{ ...draft('around-pocket', 'rect', rectProfile(100, 35, 20, 15), 'subtract'), authoringFace: 'around' }],
)
const aroundOnlyScene = await buildScene(aroundOnly, threePalette)
assert(aroundOnlyScene.modelMesh === null, 'an Around feature alone produces no boolean solid')
assert(aroundOnlyScene.featureMeshes.size === 0, 'and no feature mesh of its own')
assert(positionsOf(aroundOnlyScene.stockMesh).length > 0, 'while the bar still draws as it did')

console.log('csgAroundFace.test.ts passed')
