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
 * WP2 of the inlay wizard: `Operation.islandFeatureIds` scopes the islands a
 * pocket or v-carve is bounded by. These tests pin the seam:
 *
 *   - absent field is byte-identical to project-wide detection,
 *   - two operations naming different islands each get only their own,
 *   - a dangling id is ignored instead of emptying the cut,
 *   - normalization keeps the field only where a resolver reads it.
 *
 * Run with: npx tsx src/engine/toolpaths/islandOverride.test.ts
 */

import type { Operation, Project, SketchFeature, SketchProfile, Tool } from '../../types/project'
import { circleProfile, newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { normalizeOperation } from '../../store/helpers/normalize'
import { generatePocketToolpath } from './pocket'
import { resolvePocketRegions } from './resolver'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function tool(id: string, diameter: number): Tool {
  return {
    id,
    name: id,
    units: 'inch',
    type: 'flat_endmill',
    diameter,
    vBitAngle: null,
    flutes: 2,
    material: 'carbide',
    defaultRpm: 18000,
    defaultFeed: 40,
    defaultPlungeFeed: 12,
    defaultStepdown: 0.1,
    defaultStepover: 0.4,
    maxCutDepth: 1,
  }
}

function feature(
  id: string,
  operation: SketchFeature['operation'],
  profile: SketchProfile,
  zTop: number,
  zBottom: number,
  kind: SketchFeature['kind'] = 'rect',
): SketchFeature {
  return {
    id,
    name: id,
    kind,
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation,
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function islandProject(): Project {
  const base = newProject('Island scope', 'inch')
  base.stock.thickness = 1
  return projectWithFeatures({ ...base, tools: [tool('quarter', 0.25)] }, [
    feature('outer', 'add', rectProfile(0, 0, 4, 4), 1, 0),
    feature('pocket', 'subtract', rectProfile(0.5, 0.5, 3, 3), 1, 0.5),
    feature('island-a', 'add', circleProfile(1.5, 2, 0.3), 1, 0.5, 'circle'),
    feature('island-b', 'add', circleProfile(2.5, 2, 0.3), 1, 0.5, 'circle'),
  ])
}

function pocketOperation(project: Project, overrides: Partial<Operation> = {}): Operation {
  const operation = defaultOperationForTarget(
    project,
    'pocket',
    'rough',
    { source: 'features', featureIds: ['pocket'] },
    0,
  )
  return { ...operation, ...overrides }
}

function islandIds(project: Project, operation: Operation): string[] {
  return resolvePocketRegions(project, operation).bands
    .flatMap((band) => band.islandFeatureIds)
    .sort()
}

// 1. No field: both islands are discovered, exactly as before this seam.
{
  const project = islandProject()
  const operation = pocketOperation(project)
  const ids = islandIds(project, operation)
  assert(
    ids.join() === 'island-a,island-b,outer',
    `unscoped pocket sees every add island, got ${ids.join()}`,
  )
  console.log('ok 1 - absent field keeps project-wide discovery')
}

// 2. Two operations, each naming a different island: each sees only its own.
{
  const project = islandProject()
  const first = pocketOperation(project, { islandFeatureIds: ['island-a'] })
  const second = pocketOperation(project, { islandFeatureIds: ['island-b'] })
  assert(islandIds(project, first).join() === 'island-a', 'first operation is bounded by island-a only')
  assert(islandIds(project, second).join() === 'island-b', 'second operation is bounded by island-b only')
  console.log('ok 2 - explicit islands are scoped per operation')
}

// 3. Naming every discovered island changes nothing, down to the emitted moves.
{
  const project = islandProject()
  const baseline = pocketOperation(project)
  const explicit = pocketOperation(project, { islandFeatureIds: ['island-a', 'island-b', 'outer'] })
  const baselineResult = generatePocketToolpath(project, baseline)
  const explicitResult = generatePocketToolpath(project, explicit)
  assert(
    JSON.stringify(baselineResult.moves) === JSON.stringify(explicitResult.moves),
    'an explicit full set is byte-identical to project-wide discovery',
  )
  console.log('ok 3 - explicit full set is parity')
}

// 4. A dangling id is ignored: no crash, and the cut still resolves.
{
  const project = islandProject()
  const operation = pocketOperation(project, { islandFeatureIds: ['deleted-island'] })
  const resolved = resolvePocketRegions(project, operation)
  assert(resolved.bands.length > 0, 'a dangling scope still resolves a band')
  assert(resolved.bands.every((band) => band.islandFeatureIds.length === 0), 'no island is invented for a dangling id')
  console.log('ok 4 - dangling id is ignored')
}

// 5. Normalization: keep only real add instances, and only on the two kinds
//    whose resolver reads the field.
{
  const project = islandProject()
  const scoped = pocketOperation(project, { islandFeatureIds: ['island-a', 'missing', 'pocket'] })
  const normalized = normalizeOperation(scoped, project, 0)
  assert(
    normalized.islandFeatureIds?.join() === 'island-a',
    `normalization keeps only the add instance, got ${normalized.islandFeatureIds?.join()}`,
  )

  const wrongKind = normalizeOperation({ ...scoped, kind: 'surface_clean' }, project, 0)
  assert(wrongKind.islandFeatureIds === undefined, 'a non-pocket kind drops the field')

  const empty = normalizeOperation({ ...scoped, islandFeatureIds: [] }, project, 0)
  assert(empty.islandFeatureIds === undefined, 'an empty scope is absent, not an empty island list')
  console.log('ok 5 - normalization')
}

console.log('island override: all tests passed')
