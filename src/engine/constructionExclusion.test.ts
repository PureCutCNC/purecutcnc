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
 * Guard test for the construction-geometry hard exclusion (issue #199).
 *
 * Construction geometry must NEVER be consumed as a machining target, a
 * region mask, or a CSG/boolean input. This test locks that guarantee at the
 * seams:
 *   1. splitFeatureTargets — construction lands in neither the machining nor
 *      the region list.
 *   2. perFeatureOperations — construction ids are dropped from per-feature
 *      operation targets.
 *   3. isOperationTargetValid / fallbackOperationTarget — construction can
 *      never be (or become) an operation target.
 *   4. getOperationAddHint — a selection containing construction is rejected
 *      for every operation kind.
 *   5. isFirstFeatureValid — construction and line features do not count as
 *      the first solid feature.
 *   6. (structural) csg.ts buildScene and Viewport3D route their feature
 *      lists through modelFeatures(), which strips construction.
 *
 * Run with: npx tsx src/engine/constructionExclusion.test.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Operation, OperationKind, Project, SketchFeature } from '../types/project'
import { newProject, polygonProfile, rectProfile } from '../types/project'
import { splitFeatureTargets } from './toolpaths/regions'
import { perFeatureOperations } from './toolpaths/multiFeature'
import { fallbackOperationTarget, isOperationTargetValid } from '../store/helpers/operationDefaults'
import { isFirstFeatureValid } from '../store/helpers/normalize'
import { getOperationAddHint } from '../components/cam/operationValidity'
import type { SelectionState } from '../store/types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeFeature(id: string, operation: SketchFeature['operation'], circle = false): SketchFeature {
  return {
    id,
    name: id,
    kind: circle ? 'circle' : 'polygon',
    folderId: null,
    sketch: {
      profile: circle
        ? rectProfile(0, 0, 6, 6)
        : polygonProfile([
          { x: 0, y: 0 },
          { x: 10, y: 0 },
          { x: 10, y: 10 },
          { x: 0, y: 10 },
        ]),
      origin: { x: 0, y: 0 },
      orientationAngle: 90,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeProject(): Project {
  const project = newProject('Construction Guard', 'mm')
  project.features = [
    makeFeature('f-add', 'add'),
    makeFeature('f-subtract', 'subtract'),
    makeFeature('f-region', 'region'),
    makeFeature('f-construction', 'construction'),
  ]
  project.featureTree = project.features.map((feature) => ({ type: 'feature', featureId: feature.id }))
  return project
}

const project = makeProject()

// ── 1. splitFeatureTargets: construction is neither machining nor region ──

const split = splitFeatureTargets(project, ['f-subtract', 'f-region', 'f-construction'])
assert(split.machiningFeatures.every((f) => f.id !== 'f-construction'), 'construction must not be a machining target')
assert(split.regionFeatures.every((f) => f.id !== 'f-construction'), 'construction must not be a region mask')
assert(split.machiningFeatures.some((f) => f.id === 'f-subtract'), 'subtract stays machinable')
assert(split.regionFeatures.some((f) => f.id === 'f-region'), 'region stays a mask')

// ── 2. perFeatureOperations drops construction ids ────────────────

const multiOperation: Operation = {
  id: 'op-1',
  kind: 'pocket',
  pass: 'rough',
  name: 'Pocket',
  target: { source: 'features', featureIds: ['f-add', 'f-subtract', 'f-region', 'f-construction'] },
  toolRef: null,
  stepdown: 1,
  stepover: 0.4,
  feed: 800,
  plungeFeed: 300,
  rpm: 10000,
  stockToLeave: 0,
  stockToLeaveAxial: 0,
  toolpathVisible: true,
} as unknown as Operation
const perFeature = perFeatureOperations(multiOperation, project)
for (const op of perFeature) {
  assert(op.target.source === 'features', 'per-feature ops stay feature-targeted')
  assert(
    !op.target.featureIds.includes('f-construction'),
    'construction id must be dropped from per-feature operation targets',
  )
}

// ── 3. isOperationTargetValid rejects construction for every kind ─

const ALL_KINDS: OperationKind[] = [
  'pocket',
  'edge_route_inside',
  'edge_route_outside',
  'v_carve',
  'v_carve_recursive',
  'surface_clean',
  'follow_line',
  'drilling',
  'rough_surface',
  'finish_surface',
  'finish_surface_cleanup',
]
for (const kind of ALL_KINDS) {
  assert(
    !isOperationTargetValid(project, kind, { source: 'features', featureIds: ['f-subtract', 'f-construction'] }),
    `${kind}: target containing construction must be invalid`,
  )
}

// fallbackOperationTarget never picks construction: in a construction-only
// project every kind must fall back to stock or find nothing.
const constructionOnly = newProject('Construction Only', 'mm')
constructionOnly.features = [makeFeature('f-c1', 'construction'), makeFeature('f-c2', 'construction')]
constructionOnly.featureTree = constructionOnly.features.map((feature) => ({ type: 'feature', featureId: feature.id }))
for (const kind of ALL_KINDS) {
  const fallback = fallbackOperationTarget(constructionOnly, kind)
  if (fallback.source === 'features') {
    assert(
      fallback.featureIds.every((id) => id !== 'f-c1' && id !== 'f-c2'),
      `${kind}: fallback target must never pick construction`,
    )
  }
}

// ── 4. getOperationAddHint rejects any selection containing construction ──

function selectionOf(ids: string[]): SelectionState {
  return {
    mode: 'feature',
    selectedFeatureId: ids[0] ?? null,
    selectedFeatureIds: ids,
    selectedNode: null,
    hoveredFeatureId: null,
    sketchEditTool: null,
    activeControl: null,
  }
}
for (const kind of ALL_KINDS) {
  const hint = getOperationAddHint(project, selectionOf(['f-subtract', 'f-construction']), kind)
  assert(hint !== null, `${kind}: selection with construction must produce a hint`)
}
// Sanity: the same selection without construction is valid for pocket.
assert(
  getOperationAddHint(project, selectionOf(['f-subtract']), 'pocket') === null,
  'pocket on a plain subtract feature stays valid',
)

// ── 5. isFirstFeatureValid skips construction and line ────────────

assert(
  isFirstFeatureValid([makeFeature('c', 'construction'), makeFeature('a', 'add')]),
  'construction first + add second is a valid tree',
)
assert(
  !isFirstFeatureValid([makeFeature('c', 'construction'), makeFeature('s', 'subtract')]),
  'construction must not satisfy the first-solid-feature-is-add rule',
)
// Line features are path geometry, not solid — they must not gate the
// base-solid rule (issue #270).
assert(
  isFirstFeatureValid([makeFeature('l', 'line'), makeFeature('a', 'add')]),
  'line first + add second is a valid tree',
)
assert(
  !isFirstFeatureValid([makeFeature('l', 'line'), makeFeature('s', 'subtract')]),
  'line must not satisfy the first-solid-feature-is-add rule',
)
// A Lines-only project is valid.
assert(
  isFirstFeatureValid([makeFeature('l', 'line')]),
  'lines-only project is valid',
)

// ── 6. Structural: the CSG scene and 3D camera route through modelFeatures ──

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const csgSource = readFileSync(resolve(root, 'src/engine/csg.ts'), 'utf8')
assert(
  csgSource.includes("import { modelFeatures } from '../store/helpers/featureRoles'"),
  'csg.ts must import modelFeatures from featureRoles',
)
assert(
  /const visibleFeatures = modelFeatures\(project\.features\)/.test(csgSource),
  'csg.ts buildScene must filter its feature list through modelFeatures()',
)
const viewportSource = readFileSync(resolve(root, 'src/components/viewport3d/Viewport3D.tsx'), 'utf8')
assert(
  viewportSource.includes('modelFeatures(project.features)'),
  'Viewport3D camera-fit must exclude construction via modelFeatures()',
)

console.log('constructionExclusion.test.ts passed')
