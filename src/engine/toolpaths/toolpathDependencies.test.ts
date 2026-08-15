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
 *
 * Run with: npx tsx src/engine/toolpaths/toolpathDependencies.test.ts
 */

/**
 * Tests for the pure change-detection module behind the per-operation
 * toolpath cache (issue #518, slices S1 + S1b + S2's `name` correction + S2b's
 * machining-relevant `meta` fields + S3a's operation footprint model + S6's
 * non-target region exemption).
 *
 * `diffToolpathInputs` must report exactly the feature ids whose
 * toolpath-relevant input changed, and must raise `invalidatesEveryOperation`
 * for every input that no per-feature narrowing can cover. Display-only
 * instance fields (`visible`, `locked`, `folderId`) must never invalidate
 * anything; `name` is computation-relevant because it is embedded in
 * user-visible toolpath warnings. `modelAssets` is compared by key set plus
 * reference identity — a deep-equal but distinct asset is a change
 * (conservative), and the megabyte base64 payloads are never read.
 * `meta` is compared only through the `MACHINING_META_FIELDS` allowlist —
 * never wholesale, because `meta.modified` churns on nearly every store
 * action. `operationFootprint` must be generous by construction (unknown →
 * `bounds: null` → invalidate) and `operationAffectedByChange` must return
 * true exactly when a changed feature can reach the operation, treating
 * construction-only changes, non-target region changes, and far-away changes
 * as irrelevant.
 */

import { defaultTool, getProfileBounds, getStockBounds, rectProfile } from '../../types/project'
import type {
  Bounds2D,
  FeatureInstance,
  LocalConstraint,
  Operation,
  PersistedImportedMesh,
  Project,
  SketchFeature,
  Tool,
} from '../../types/project'
import { newProject } from '../../types/project'
import type { LegacyFeatureRow } from '../../store/helpers/projectFormat'
import { projectWithFeatures, resolvedFeature } from '../../test/projectFixtures'
import { projectsEqual } from '../../store/helpers/normalize'
import { getFeatureGeometryProfiles } from '../../text'
import {
  diffToolpathInputs,
  featureInstanceComputationEquals,
  operationAffectedByChange,
  operationFootprint,
  type ToolpathInputDiff,
} from './toolpathDependencies'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function setEquals(actual: Set<string>, expected: string[]): boolean {
  return actual.size === expected.length && expected.every((id) => actual.has(id))
}

// ── Fixtures ──────────────────────────────────────────────────────

function draftFeature(id: string, overrides: Partial<SketchFeature> = {}): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 20, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
    ...overrides,
  }
}

const distanceConstraint: LocalConstraint = {
  id: 'c1',
  type: 'fixed_distance',
  segment_ids: [],
  value: 10,
}

function testMesh(overrides: Partial<PersistedImportedMesh> = {}): PersistedImportedMesh {
  return {
    storage: 'mesh-v1',
    vertexCount: 3,
    triangleCount: 1,
    positions: 'AAAA',
    indices: 'AQID',
    bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 },
    ...overrides,
  }
}

function baseProject(): Project {
  return projectWithFeatures(newProject('toolpath-deps-test', 'mm'), [
    draftFeature('f1'),
    draftFeature('f2'),
    draftFeature('f3'),
  ])
}

/** Immutable per-row edit, matching how the store updates feature rows. */
function patchFeature(project: Project, id: string, patch: Partial<FeatureInstance>): Project {
  return {
    ...project,
    features: project.features.map((feature) => (feature.id === id ? { ...feature, ...patch } : feature)),
  }
}

function featureIds(project: Project): string[] {
  return project.features.map((feature) => feature.id)
}

function expectDisplayOnly(project: Project, next: Project, label: string): void {
  const diff = diffToolpathInputs(project, next)
  assert(diff.changedFeatureIds.size === 0, `${label} change must invalidate no ids`)
  assert(!diff.invalidatesEveryOperation, `${label} change must not invalidate everything`)
}

// ── featureInstanceComputationEquals ──────────────────────────────

{
  console.log('1. featureInstanceComputationEquals compares only resolver-read fields...')
  const project = baseProject()
  const row = project.features.find((feature) => feature.id === 'f1')
  assert(row !== undefined, 'f1 row should exist')
  assert(featureInstanceComputationEquals(row, row), 'same row is equal')

  const expectDisplayOnlyEqual = (
    patch: Partial<FeatureInstance>,
    label: string,
  ): void => {
    const edited = patchFeature(project, 'f1', patch)
    const editedRow = edited.features.find((feature) => feature.id === 'f1')
    assert(editedRow !== undefined, `${label} edited row should exist`)
    assert(
      featureInstanceComputationEquals(row, editedRow),
      `${label} is display-only and must compare equal`,
    )
  }

  expectDisplayOnlyEqual({ visible: false }, 'visible')
  expectDisplayOnlyEqual({ locked: true }, 'locked')
  expectDisplayOnlyEqual({ folderId: 'some-folder' }, 'folderId')

  // `name` is NOT display-only: generators embed `feature.name` in
  // user-visible toolpath warnings (drilling.ts, carving.ts), so a rename
  // must invalidate or the CAM panel keeps showing the old name.
  const renamed = patchFeature(project, 'f1', { name: 'renamed' })
  const renamedRow = renamed.features.find((feature) => feature.id === 'f1')
  assert(renamedRow !== undefined, 'renamed row should exist')
  assert(!featureInstanceComputationEquals(row, renamedRow), 'name change must compare unequal')

  const moved = patchFeature(project, 'f1', {
    transform: { ...row.transform, e: 12 },
  })
  const movedRow = moved.features.find((feature) => feature.id === 'f1')
  assert(movedRow !== undefined, 'moved row should exist')
  assert(!featureInstanceComputationEquals(row, movedRow), 'transform change must compare unequal')

  const deepened = patchFeature(project, 'f1', { z_top: 7 })
  const deepenedRow = deepened.features.find((feature) => feature.id === 'f1')
  assert(deepenedRow !== undefined, 'deepened row should exist')
  assert(!featureInstanceComputationEquals(row, deepenedRow), 'z_top change must compare unequal')
}

// ── diffToolpathInputs ────────────────────────────────────────────

{
  console.log('2. Identical snapshots produce an empty diff...')
  const project = baseProject()
  const diff = diffToolpathInputs(project, project)
  assert(diff.changedFeatureIds.size === 0, 'same project must change no ids')
  assert(!diff.invalidatesEveryOperation, 'same project must not invalidate everything')
}

{
  console.log('3. Display-only changes invalidate nothing...')
  const project = baseProject()
  expectDisplayOnly(project, patchFeature(project, 'f2', { visible: false }), 'visible')
  expectDisplayOnly(project, patchFeature(project, 'f2', { locked: true }), 'locked')
  expectDisplayOnly(project, patchFeature(project, 'f2', { folderId: 'some-folder' }), 'folderId')
}

{
  console.log('3b. Name change reports that id only (warnings embed feature.name)...')
  const project = baseProject()
  const next = patchFeature(project, 'f2', { name: 'renamed' })
  const diff = diffToolpathInputs(project, next)
  assert(setEquals(diff.changedFeatureIds, ['f2']), `expected only f2, got ${[...diff.changedFeatureIds].join(',')}`)
  assert(!diff.invalidatesEveryOperation, 'name change must not invalidate everything')
}

{
  console.log('4. Transform change reports that id only...')
  const project = baseProject()
  const row = project.features.find((feature) => feature.id === 'f2')
  assert(row !== undefined, 'f2 row should exist')
  const next = patchFeature(project, 'f2', { transform: { ...row.transform, f: -8 } })
  const diff = diffToolpathInputs(project, next)
  assert(setEquals(diff.changedFeatureIds, ['f2']), `expected only f2, got ${[...diff.changedFeatureIds].join(',')}`)
  assert(!diff.invalidatesEveryOperation, 'transform change must not invalidate everything')
}

{
  console.log('5. z_top change reports that id only...')
  const project = baseProject()
  const next = patchFeature(project, 'f3', { z_top: 9 })
  const diff = diffToolpathInputs(project, next)
  assert(setEquals(diff.changedFeatureIds, ['f3']), `expected only f3, got ${[...diff.changedFeatureIds].join(',')}`)
  assert(!diff.invalidatesEveryOperation, 'z_top change must not invalidate everything')
}

{
  console.log('6. Constraint contents change reports that id only...')
  const project = projectWithFeatures(newProject('constraints-test', 'mm'), [
    draftFeature('f1', {
      sketch: {
        profile: rectProfile(0, 0, 20, 10),
        origin: { x: 0, y: 0 },
        orientationAngle: 0,
        dimensions: [],
        constraints: [distanceConstraint],
      },
    }),
    draftFeature('f2'),
    draftFeature('f3'),
  ])
  const next = patchFeature(project, 'f1', {
    constraints: [{ ...distanceConstraint, value: 25 }],
  })
  const diff = diffToolpathInputs(project, next)
  assert(setEquals(diff.changedFeatureIds, ['f1']), `expected only f1, got ${[...diff.changedFeatureIds].join(',')}`)
  assert(!diff.invalidatesEveryOperation, 'constraint change must not invalidate everything')
}

{
  console.log('7. Shared definition edit reports every referencing instance...')
  const sharedDraft = (id: string): LegacyFeatureRow => ({
    ...draftFeature(id),
    definitionId: 'd-shared',
  })
  const project = projectWithFeatures(newProject('defs-test', 'mm'), [
    sharedDraft('i1'),
    sharedDraft('i2'),
    draftFeature('f3'),
  ])
  assert(project.featureDefinitions['d-shared'] !== undefined, 'shared definition should exist')
  const sharedDefinition = project.featureDefinitions['d-shared']
  const previousFeatures = project.features
  const next: Project = {
    ...project,
    featureDefinitions: {
      ...project.featureDefinitions,
      'd-shared': {
        ...sharedDefinition,
        profile: rectProfile(50, 50, 8, 8),
      },
    },
  }
  // The instance rows are the very same objects — only the definition changed.
  assert(next.features === previousFeatures, 'instance rows must stay byte-identical')
  const diff = diffToolpathInputs(project, next)
  assert(
    setEquals(diff.changedFeatureIds, ['i1', 'i2']),
    `expected i1+i2, got ${[...diff.changedFeatureIds].join(',')}`,
  )
  assert(!diff.invalidatesEveryOperation, 'definition edit must not invalidate everything')
}

{
  console.log('8. Added and removed features report their ids...')
  const project = baseProject()
  const extra = projectWithFeatures(newProject('extra-test', 'mm'), [draftFeature('f-new')])
  const added: Project = {
    ...project,
    features: [...project.features, extra.features[0]],
    featureDefinitions: { ...project.featureDefinitions, ...extra.featureDefinitions },
  }
  const addedDiff = diffToolpathInputs(project, added)
  assert(setEquals(addedDiff.changedFeatureIds, ['f-new']), `expected only f-new, got ${[...addedDiff.changedFeatureIds].join(',')}`)
  assert(!addedDiff.invalidatesEveryOperation, 'adding a feature must not invalidate everything')

  const removed: Project = {
    ...project,
    features: project.features.filter((feature) => feature.id !== 'f2'),
  }
  const removedDiff = diffToolpathInputs(project, removed)
  assert(setEquals(removedDiff.changedFeatureIds, ['f2']), `expected only f2, got ${[...removedDiff.changedFeatureIds].join(',')}`)
  assert(!removedDiff.invalidatesEveryOperation, 'removing a feature must not invalidate everything')
}

{
  console.log('9. Reordering features invalidates every operation...')
  const project = baseProject()
  assert(featureIds(project).join(',') === 'f1,f2,f3', 'fixture order should be f1,f2,f3')
  const reordered: Project = {
    ...project,
    features: [project.features[0], project.features[2], project.features[1]],
  }
  const diff = diffToolpathInputs(project, reordered)
  assert(diff.invalidatesEveryOperation, 'reorder must invalidate every operation')
}

{
  console.log('10. Dimension value change invalidates every operation...')
  const project: Project = {
    ...baseProject(),
    dimensions: {
      d1: { id: 'd1', name: 'Depth', value: 5, formula: null },
    },
  }
  const changed: Project = {
    ...project,
    dimensions: {
      d1: { id: 'd1', name: 'Depth', value: 6, formula: null },
    },
  }
  const diff = diffToolpathInputs(project, changed)
  assert(diff.invalidatesEveryOperation, 'dimension change must invalidate every operation')

  // Deep-equal replacement is not a change.
  const rebuilt: Project = {
    ...project,
    dimensions: {
      d1: { id: 'd1', name: 'Depth', value: 5, formula: null },
    },
  }
  const rebuiltDiff = diffToolpathInputs(project, rebuilt)
  assert(!rebuiltDiff.invalidatesEveryOperation, 'deep-equal dimensions replacement must not invalidate')
}

{
  console.log('11. Units change invalidates every operation...')
  const project = baseProject()
  assert(project.meta.units === 'mm', 'fixture should be mm')
  const next: Project = {
    ...project,
    meta: { ...project.meta, units: 'inch' },
  }
  const diff = diffToolpathInputs(project, next)
  assert(diff.invalidatesEveryOperation, 'units change must invalidate every operation')
}

{
  console.log('12. Model asset change invalidates every operation...')
  const project: Project = {
    ...baseProject(),
    modelAssets: { a1: testMesh() },
  }
  const changed: Project = {
    ...project,
    modelAssets: { a1: testMesh({ positions: 'BBBB' }) },
  }
  const diff = diffToolpathInputs(project, changed)
  assert(diff.invalidatesEveryOperation, 'model asset change must invalidate every operation')
}

{
  console.log('13. Missing definition counts as changed...')
  const project = baseProject()
  const next: Project = { ...project, featureDefinitions: {} }
  const diff = diffToolpathInputs(project, next)
  assert(
    setEquals(diff.changedFeatureIds, ['f1', 'f2', 'f3']),
    `expected all ids, got ${[...diff.changedFeatureIds].join(',')}`,
  )
  assert(!diff.invalidatesEveryOperation, 'missing definitions must not invalidate everything')
}

{
  console.log('14. 200 features with one edit report exactly one id...')
  const drafts = Array.from({ length: 200 }, (_, index) =>
    draftFeature(`f${String(index + 1).padStart(4, '0')}`))
  const project = projectWithFeatures(newProject('bulk-test', 'mm'), drafts)
  assert(project.features.length === 200, 'bulk fixture should have 200 features')

  const targetId = project.features[137].id
  const row = project.features[137]
  const next = patchFeature(project, targetId, { transform: { ...row.transform, e: 3 } })

  const before = JSON.stringify(project)
  const diff = diffToolpathInputs(project, next)
  assert(JSON.stringify(project) === before, 'diff must not mutate its arguments')
  assert(
    setEquals(diff.changedFeatureIds, [targetId]),
    `expected exactly one id (${targetId}), got ${diff.changedFeatureIds.size}`,
  )
  assert(!diff.invalidatesEveryOperation, 'single edit must not invalidate everything')

  // Guard against an accidental all-changed fallback in the other direction:
  // a structurally equal rebuild must produce no changes at all.
  const rebuilt = projectWithFeatures(newProject('bulk-test', 'mm'), drafts)
  const rebuiltDiff: ToolpathInputDiff = diffToolpathInputs(project, rebuilt)
  assert(rebuiltDiff.changedFeatureIds.size === 0, 'deep-equal rebuild must change no ids')
  assert(!rebuiltDiff.invalidatesEveryOperation, 'deep-equal rebuild must not invalidate everything')
  // The rebuild is identical apart from `newProject`'s fresh timestamps.
  const timestampNormalized: Project = {
    ...rebuilt,
    meta: {
      ...rebuilt.meta,
      created: project.meta.created,
      modified: project.meta.modified,
    },
  }
  assert(projectsEqual(project, timestampNormalized), 'rebuild should be deep-equal modulo timestamps')
}

{
  console.log('15. Same asset references in a fresh record (addFeature spread) invalidate nothing...')
  const asset = testMesh()
  const project: Project = {
    ...baseProject(),
    modelAssets: { a1: asset },
  }
  // `addFeature` does `{ ...s.project.modelAssets }` unconditionally: the
  // record identity churns but every asset reference is preserved.
  const spread: Project = {
    ...project,
    modelAssets: { ...project.modelAssets },
  }
  assert(spread.modelAssets !== project.modelAssets, 'spread must produce a fresh record')
  assert(spread.modelAssets.a1 === project.modelAssets.a1, 'spread must keep value references')
  const diff = diffToolpathInputs(project, spread)
  assert(diff.changedFeatureIds.size === 0, 'record spread must change no ids')
  assert(!diff.invalidatesEveryOperation, 'addFeature-shaped spread must not invalidate everything')
}

{
  console.log('16. Added and removed model asset keys invalidate every operation...')
  const project: Project = {
    ...baseProject(),
    modelAssets: { a1: testMesh() },
  }
  const added: Project = {
    ...project,
    modelAssets: { ...project.modelAssets, a2: testMesh() },
  }
  const addedDiff = diffToolpathInputs(project, added)
  assert(addedDiff.invalidatesEveryOperation, 'added asset key must invalidate everything')

  const removed: Project = {
    ...project,
    modelAssets: {},
  }
  const removedDiff = diffToolpathInputs(project, removed)
  assert(removedDiff.invalidatesEveryOperation, 'removed asset key must invalidate everything')
}

{
  console.log('17. Deep-equal but distinct asset object still invalidates (conservative)...')
  const project: Project = {
    ...baseProject(),
    modelAssets: { a1: testMesh() },
  }
  const rebuilt: Project = {
    ...project,
    modelAssets: { a1: testMesh() },
  }
  assert(rebuilt.modelAssets.a1 !== project.modelAssets.a1, 'replacement must be a distinct object')
  assert(
    projectsEqual(project.modelAssets.a1, rebuilt.modelAssets.a1),
    'replacement must be deep-equal to the original',
  )
  // Deliberate behaviour change from S1's deep compare: identity is the only
  // trustable signal without reading the payload, so identity-differs
  // invalidates even when a content compare would say "equal".
  const diff = diffToolpathInputs(project, rebuilt)
  assert(diff.invalidatesEveryOperation, 'deep-equal but distinct asset must still invalidate')
}

{
  console.log('18. Asset payload is never read...')
  const payloadReads = { count: 0 }
  const mesh = {} as PersistedImportedMesh
  // `enumerable: true` matters: JSON.stringify only visits enumerable own
  // properties, so without it a deep-serialization regression would read
  // nothing and the counter below would stay 0 either way.
  Object.defineProperty(mesh, 'positions', {
    enumerable: true,
    get: () => { payloadReads.count += 1; return 'AAAA' },
  })
  Object.defineProperty(mesh, 'indices', {
    enumerable: true,
    get: () => { payloadReads.count += 1; return 'AQID' },
  })
  mesh.storage = 'mesh-v1'
  mesh.vertexCount = 3
  mesh.triangleCount = 1
  mesh.bounds = { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 }

  const project: Project = {
    ...baseProject(),
    modelAssets: { a1: mesh },
  }
  // Fresh record, same references — the diff must not touch `positions`/`indices`.
  const spread: Project = {
    ...project,
    modelAssets: { ...project.modelAssets },
  }
  const diff = diffToolpathInputs(project, spread)
  assert(!diff.invalidatesEveryOperation, 'same-reference spread must not invalidate')
  // `Object.keys` does not trigger getters, so a count of 0 proves no deep
  // serialization (JSON.stringify) happened. Timing assertions are not used
  // here because they are flaky.
  assert(payloadReads.count === 0, `payload getters were read ${payloadReads.count} times`)
}

{
  console.log('12. Machining-relevant meta field changes invalidate every operation...')
  const project = baseProject()
  const withMeta = (patch: Partial<Project['meta']>): Project => ({
    ...project,
    meta: { ...project.meta, ...patch },
  })

  // Assert each field separately — not in a loop over MACHINING_META_FIELDS,
  // which would pass even if the implementation read the same constant wrongly.
  const maxTravelZDiff = diffToolpathInputs(project, withMeta({ maxTravelZ: project.meta.maxTravelZ + 1 }))
  assert(maxTravelZDiff.invalidatesEveryOperation, 'maxTravelZ change must invalidate every operation')

  const operationClearanceZDiff = diffToolpathInputs(
    project,
    withMeta({ operationClearanceZ: project.meta.operationClearanceZ + 1 }),
  )
  assert(operationClearanceZDiff.invalidatesEveryOperation, 'operationClearanceZ change must invalidate every operation')

  const clampClearanceXYDiff = diffToolpathInputs(
    project,
    withMeta({ clampClearanceXY: project.meta.clampClearanceXY + 1 }),
  )
  assert(clampClearanceXYDiff.invalidatesEveryOperation, 'clampClearanceXY change must invalidate every operation')

  const clampClearanceZDiff = diffToolpathInputs(
    project,
    withMeta({ clampClearanceZ: project.meta.clampClearanceZ + 1 }),
  )
  assert(clampClearanceZDiff.invalidatesEveryOperation, 'clampClearanceZ change must invalidate every operation')
}

{
  // Regression guard for the wholesale-compare trap: comparing `meta` by
  // identity or deep equality would invalidate on every mutation because
  // `meta.modified` is rewritten by essentially every store action.
  console.log('13. REGRESSION GUARD: meta.modified change alone invalidates nothing...')
  const project = baseProject()
  const next: Project = {
    ...project,
    meta: { ...project.meta, modified: new Date(0).toISOString() },
  }
  const diff = diffToolpathInputs(project, next)
  assert(!diff.invalidatesEveryOperation, 'meta.modified change must not invalidate every operation')
  assert(diff.changedFeatureIds.size === 0, 'meta.modified change must invalidate no ids')
}

{
  console.log('14. meta.name change alone invalidates nothing...')
  const project = baseProject()
  const next: Project = {
    ...project,
    meta: { ...project.meta, name: 'renamed-project' },
  }
  const diff = diffToolpathInputs(project, next)
  assert(!diff.invalidatesEveryOperation, 'meta.name change must not invalidate every operation')
  assert(diff.changedFeatureIds.size === 0, 'meta.name change must invalidate no ids')
}

{
  console.log('15. selectedMachineId change alone invalidates nothing...')
  const project = baseProject()
  const next: Project = {
    ...project,
    meta: { ...project.meta, selectedMachineId: 'some-other-machine' },
  }
  const diff = diffToolpathInputs(project, next)
  assert(!diff.invalidatesEveryOperation, 'selectedMachineId change must not invalidate every operation')
  assert(diff.changedFeatureIds.size === 0, 'selectedMachineId change must invalidate no ids')
}

// ── S3a fixtures ─────────────────────────────────────────────────

function makeOperation(target: Operation['target'], overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op-1',
    name: 'Operation 1',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target,
    toolRef: 't1',
    stepdown: 2,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: false,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    drillType: 'simple',
    peckDepth: 0.5,
    dwellTime: 0.1,
    retractHeight: 3,
    debugShowRejectedCorners: false,
    waterlineAdaptiveRefinement: false,
    waterlineMicroStepover: 0.02,
    waterlineRefinementThreshold: 0.01,
    waterlineMaxRingsPerBand: 4,
    waterlineTipStepdown: 0.05,
    arcFittingEnabled: true,
    ...overrides,
  }
}

function withTool(project: Project, tool: Tool = defaultTool('mm')): Project {
  return { ...project, tools: [tool] }
}

/** A `draftFeature` rect at an explicit world position. */
function rectDraft(
  id: string,
  x: number,
  y: number,
  w = 20,
  h = 10,
  overrides: Partial<SketchFeature> = {},
): SketchFeature {
  return draftFeature(id, {
    ...overrides,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  })
}

function unionBounds(boundsList: Bounds2D[]): Bounds2D {
  return boundsList.reduce(
    (acc, next) => ({
      minX: Math.min(acc.minX, next.minX),
      maxX: Math.max(acc.maxX, next.maxX),
      minY: Math.min(acc.minY, next.minY),
      maxY: Math.max(acc.maxY, next.maxY),
    }),
  )
}

function assertClose(actual: number, expected: number, epsilon: number, message: string): void {
  assert(Math.abs(actual - expected) <= epsilon, `${message} (expected ${expected}, got ${actual})`)
}

// ── operationFootprint ───────────────────────────────────────────

{
  console.log('S3a.1 Feature-targeted pocket footprint contains every target and exceeds it by ≥ the tool diameter...')
  // Target f1 is the 20×10 rect at the origin; the tool is a 6 mm endmill.
  const project = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    draftFeature('f2'),
    draftFeature('f3'),
  ]))
  const footprint = operationFootprint(project, makeOperation({ source: 'features', featureIds: ['f1'] }))
  assert(footprint.bounds !== null, 'footprint bounds must not be null')
  const bounds = footprint.bounds
  assert(bounds.minX <= 0 && bounds.minY <= 0, 'footprint must contain the target minimums')
  assert(bounds.maxX >= 20 && bounds.maxY >= 10, 'footprint must contain the target maximums')
  assert(0 - bounds.minX >= 6, 'footprint must exceed the target by ≥ tool diameter on minX')
  assert(bounds.maxX - 20 >= 6, 'footprint must exceed the target by ≥ tool diameter on maxX')
  assert(0 - bounds.minY >= 6, 'footprint must exceed the target by ≥ tool diameter on minY')
  assert(bounds.maxY - 10 >= 6, 'footprint must exceed the target by ≥ tool diameter on maxY')
  // Pin the grow formula (S5): 2·toolDiameter + trochoidalCutWidth + stockToLeaveRadial.
  // `stepover` is deliberately not in the sum — it spaces passes inside the region.
  const grow = 2 * 6 + 0 + 0
  assertClose(bounds.minX, -grow, 1e-9, 'grow on minX')
  assertClose(bounds.maxX, 20 + grow, 1e-9, 'grow on maxX')
  assertClose(bounds.minY, -grow, 1e-9, 'grow on minY')
  assertClose(bounds.maxY, 10 + grow, 1e-9, 'grow on maxY')
  assert(setEquals(footprint.targetFeatureIds, ['f1']), 'targetFeatureIds must hold exactly the target id')
  assert(!footprint.readsWholeModel, 'a feature-targeted operation must not read the whole model')

  // The same formula with trochoidal width and radial stock leave present.
  const grownFootprint = operationFootprint(project, makeOperation(
    { source: 'features', featureIds: ['f1'] },
    { trochoidalCutWidth: 3, stockToLeaveRadial: 0.5 },
  ))
  assert(grownFootprint.bounds !== null, 'grown footprint bounds must not be null')
  assertClose(
    grownFootprint.bounds.minX,
    -(2 * 6 + 3 + 0.5),
    1e-9,
    'trochoidal + radial leave must extend the footprint',
  )
}

{
  console.log('S3a.1b Tool diameter normalizes to project units (inch tool in an mm project)...')
  const project = withTool(
    projectWithFeatures(newProject('footprint-test', 'mm'), [draftFeature('f1')]),
    { ...defaultTool('inch'), id: 't1', diameter: 0.25 },
  )
  const footprint = operationFootprint(project, makeOperation({ source: 'features', featureIds: ['f1'] }))
  assert(footprint.bounds !== null, 'footprint bounds must not be null')
  // 0.25 in = 6.35 mm → grow = 2·6.35 = 12.7 (stepover is not in the S5 sum).
  assertClose(footprint.bounds.minX, -(2 * 6.35), 1e-6, 'grow must use the project-unit diameter')
}

{
  console.log('S3a.2 Missing tool yields bounds null, and any change affects the operation...')
  const project = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [draftFeature('f1')]))
  const target = { source: 'features', featureIds: ['f1'] } satisfies Operation['target']

  const noRefFootprint = operationFootprint(project, makeOperation(target, { toolRef: null }))
  assert(noRefFootprint.bounds === null, 'toolRef null must yield bounds null')
  assert(
    operationAffectedByChange(noRefFootprint, project, project, new Set(['f1'])),
    'bounds null must return true for any change',
  )

  const danglingFootprint = operationFootprint(project, makeOperation(target, { toolRef: 'missing-tool' }))
  assert(danglingFootprint.bounds === null, 'a toolRef pointing at no tool must yield bounds null')
  assert(
    operationAffectedByChange(danglingFootprint, project, project, new Set(['f1'])),
    'bounds null must return true for any change',
  )

  const noDiameterProject = withTool(
    projectWithFeatures(newProject('footprint-test', 'mm'), [draftFeature('f1')]),
    { ...defaultTool('mm'), id: 't1', diameter: 0 },
  )
  const noDiameterFootprint = operationFootprint(noDiameterProject, makeOperation(target))
  assert(noDiameterFootprint.bounds === null, 'a tool without a usable diameter must yield bounds null')
}

{
  console.log('S3a.3 An unresolvable target id yields bounds null...')
  const project = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [draftFeature('f1')]))
  const danglingTarget = operationFootprint(
    project,
    makeOperation({ source: 'features', featureIds: ['missing'] }),
  )
  assert(danglingTarget.bounds === null, 'an unresolvable target id must yield bounds null')

  // Not in the required list: an empty target list has no spatial anchor, so
  // it must be unknown rather than a zero-size footprint.
  const emptyTarget = operationFootprint(project, makeOperation({ source: 'features', featureIds: [] }))
  assert(emptyTarget.bounds === null, 'an empty target list must yield bounds null')
}

{
  console.log('S3a.4 Text target footprint covers every glyph profile, not just the first...')
  const textDraft = draftFeature('text-1', {
    kind: 'text',
    text: { text: 'AB', style: 'skeleton', fontId: 'simple_stroke', size: 10 },
    sketch: {
      profile: rectProfile(0, 0, 100, 100),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  })
  const project = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [textDraft]))
  const glyphProfiles = getFeatureGeometryProfiles(resolvedFeature(project, 'text-1'))
  assert(glyphProfiles.length > 1, 'fixture must resolve to multiple glyph profiles')
  const glyphUnion = unionBounds(glyphProfiles.map((profile) => getProfileBounds(profile)))

  const footprint = operationFootprint(project, makeOperation({ source: 'features', featureIds: ['text-1'] }))
  assert(footprint.bounds !== null, 'footprint bounds must not be null')
  assert(
    footprint.bounds.minX <= glyphUnion.minX && footprint.bounds.maxX >= glyphUnion.maxX,
    'footprint must cover every glyph profile on X (not just the first)',
  )
  assert(
    footprint.bounds.minY <= glyphUnion.minY && footprint.bounds.maxY >= glyphUnion.maxY,
    'footprint must cover every glyph profile on Y (not just the first)',
  )
}

{
  console.log('S3a.5 Stock target reads the whole model with non-null stock bounds...')
  const project = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [draftFeature('f1')]))
  const footprint = operationFootprint(project, makeOperation({ source: 'stock' }, { toolRef: null }))
  assert(footprint.readsWholeModel, 'a stock target must read the whole model')
  assert(footprint.targetFeatureIds.size === 0, 'a stock target has no direct feature targets')
  assert(footprint.bounds !== null, 'stock footprint keeps the stock bounds so its construction-only exemption can apply')
  const stockBounds = getStockBounds(project.stock)
  assert(
    footprint.bounds.minX === stockBounds.minX
    && footprint.bounds.maxX === stockBounds.maxX
    && footprint.bounds.minY === stockBounds.minY
    && footprint.bounds.maxY === stockBounds.maxY,
    'stock footprint bounds must be the stock rectangle',
  )
}

// ── operationAffectedByChange ────────────────────────────────────

{
  console.log('S3a.6 A changed target feature always affects its operation...')
  const project = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('f2', 40, 0),
    draftFeature('f3'),
  ]))
  const footprint = operationFootprint(project, makeOperation({ source: 'features', featureIds: ['f1'] }))
  assert(footprint.bounds !== null, 'footprint bounds must not be null')
  const next = patchFeature(project, 'f1', { z_top: 9 })
  assert(
    operationAffectedByChange(footprint, project, next, new Set(['f1'])),
    'a changed target must regenerate the operation',
  )
}

{
  console.log('S3a.7 A changed non-target whose bbox overlaps the footprint affects it (island case)...')
  // f1 (target) spans 0..20; the footprint grows to -12..32, so f2 at
  // 25..45 overlaps it while f3 at 500 does not.
  const project = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('f2', 25, 0),
    rectDraft('f3', 500, 0),
  ]))
  const footprint = operationFootprint(project, makeOperation({ source: 'features', featureIds: ['f1'] }))
  assert(footprint.bounds !== null, 'footprint bounds must not be null')
  const next = patchFeature(project, 'f2', { z_bottom: -2 })
  const before = JSON.stringify(project)
  const affected = operationAffectedByChange(footprint, project, next, new Set(['f2']))
  assert(JSON.stringify(project) === before, 'operationAffectedByChange must not mutate its arguments')
  assert(affected, 'an overlapping non-target change must regenerate the operation')
}

{
  console.log('S3a.8 A changed feature far outside the footprint on both sides does not affect it...')
  const project = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('f2', 500, 0),
  ]))
  const footprint = operationFootprint(project, makeOperation({ source: 'features', featureIds: ['f1'] }))
  assert(footprint.bounds !== null, 'footprint bounds must not be null')
  const next = patchFeature(project, 'f2', { z_top: 9 })
  assert(
    !operationAffectedByChange(footprint, project, next, new Set(['f2'])),
    'a far-away change must not regenerate the operation',
  )
}

{
  console.log('S3a.9 A feature moved into or out of the footprint affects it (both directions)...')
  const inside = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('f2', 25, 0),
  ]))
  const insideRow = inside.features.find((feature) => feature.id === 'f2')
  assert(insideRow !== undefined, 'f2 row should exist')
  // Shift f2 from 25..45 to 500..520 without touching its definition.
  const outside = patchFeature(inside, 'f2', { transform: { ...insideRow.transform, e: 460 } })
  const footprint = operationFootprint(inside, makeOperation({ source: 'features', featureIds: ['f1'] }))
  assert(footprint.bounds !== null, 'footprint bounds must not be null')

  assert(
    operationAffectedByChange(footprint, outside, inside, new Set(['f2'])),
    'moving into the footprint must regenerate (previous-side bbox alone would miss it)',
  )
  assert(
    operationAffectedByChange(footprint, inside, outside, new Set(['f2'])),
    'moving out of the footprint must regenerate (next-side bbox alone would miss it)',
  )
}

{
  console.log('S3a.10 Construction-only changes affect nothing, even for stock-targeted operations...')
  // c1 sits inside the footprint on purpose: if the construction skip were
  // broken, the bbox check would return true and this test would catch it.
  const project = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('c1', 25, 0, 20, 10, { operation: 'construction' }),
  ]))
  const next = patchFeature(project, 'c1', { z_top: 8 })

  const featureFootprint = operationFootprint(project, makeOperation({ source: 'features', featureIds: ['f1'] }))
  assert(featureFootprint.bounds !== null, 'feature footprint bounds must not be null')
  assert(
    !operationAffectedByChange(featureFootprint, project, next, new Set(['c1'])),
    'a construction-only change must not affect a feature-targeted operation',
  )

  const stockFootprint = operationFootprint(project, makeOperation({ source: 'stock' }, { toolRef: null }))
  assert(stockFootprint.readsWholeModel, 'stock footprint must read the whole model')
  assert(
    !operationAffectedByChange(stockFootprint, project, next, new Set(['c1'])),
    'a construction-only change must not affect a stock-targeted operation',
  )
}

{
  console.log('S3a.11 A construction feature converted to machinable between snapshots affects the operation...')
  const previous = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('c1', 25, 0, 20, 10, { operation: 'construction' }),
  ]))
  const next = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('c1', 25, 0, 20, 10, { operation: 'subtract' }),
  ]))
  const footprint = operationFootprint(previous, makeOperation({ source: 'features', featureIds: ['f1'] }))
  assert(footprint.bounds !== null, 'footprint bounds must not be null')
  const diff = diffToolpathInputs(previous, next)
  assert(diff.changedFeatureIds.has('c1'), 'the conversion must register as a changed feature')
  assert(
    operationAffectedByChange(footprint, previous, next, diff.changedFeatureIds),
    'a construction-to-machinable conversion must regenerate the operation',
  )
}

{
  console.log('S3a.12 Footprint intersection is inclusive: an exactly-touching bbox affects the operation...')
  const project = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    draftFeature('f2'),
  ]))
  const footprint = operationFootprint(project, makeOperation({ source: 'features', featureIds: ['f1'] }))
  assert(footprint.bounds !== null, 'footprint bounds must not be null')

  // f2's maxX lands exactly on the footprint's minX.
  const touchingProject = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('f2', footprint.bounds.minX - 20, 0, 20, 10),
  ]))
  const touchingNext = patchFeature(touchingProject, 'f2', { z_top: 9 })
  assert(
    operationAffectedByChange(footprint, touchingProject, touchingNext, new Set(['f2'])),
    'a bbox exactly touching the footprint edge must count as intersecting',
  )

  // Just outside: 0.01 beyond the edge must not intersect.
  const outsideProject = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('f2', footprint.bounds.minX - 20 - 0.01, 0, 20, 10),
  ]))
  const outsideNext = patchFeature(outsideProject, 'f2', { z_top: 9 })
  assert(
    !operationAffectedByChange(footprint, outsideProject, outsideNext, new Set(['f2'])),
    'a bbox 0.01 beyond the footprint edge must not intersect',
  )
}

// ── S5.A: the right-sized footprint margin ────────────────────────

/**
 * The user's own fixture (issue #518, S5 measurements): an inch project whose
 * default stock is exactly X 0..4 (defaultStock), a 0.25" tool, a 0.32"
 * stepover, and a pocket target spanning X 0.50..3.50. With the derived
 * margin the footprint lands exactly on the stock edge, X 0.00..4.00.
 */
function userMarginProject(): { project: Project, operation: Operation } {
  const operation = makeOperation(
    { source: 'features', featureIds: ['target'] },
    { stepover: 0.32 },
  )
  const project = withTool(
    projectWithFeatures(newProject('footprint-margin-test', 'inch'), [
      rectDraft('target', 0.5, 0.5, 3, 1),
    ]),
    defaultTool('inch'),
  )
  assert(getStockBounds(project.stock).maxX === 4, 'fixture premise: the inch default stock must span X 0..4')
  return { project, operation }
}

{
  console.log('S5.A1 The user fixture footprint is exactly X 0.00..4.00 (numbers asserted, not derived)...')
  const { project, operation } = userMarginProject()
  const footprint = operationFootprint(project, operation)
  assert(footprint.bounds !== null, 'footprint bounds must not be null')
  // Assert the literal numbers so any margin change fails loudly: the old
  // 4·toolDiameter + stepover margin reached X -0.82..4.82 here.
  assertClose(footprint.bounds.minX, 0.0, 1e-9, 'footprint minX must be exactly 0.00')
  assertClose(footprint.bounds.maxX, 4.0, 1e-9, 'footprint maxX must be exactly 4.00')
}

{
  console.log('S5.A2 stepover no longer widens the footprint...')
  const project = withTool(projectWithFeatures(newProject('footprint-margin-test', 'mm'), [draftFeature('f1')]))
  const target = { source: 'features', featureIds: ['f1'] } satisfies Operation['target']
  const narrow = operationFootprint(project, makeOperation(target, { stepover: 0.4 }))
  const wide = operationFootprint(project, makeOperation(target, { stepover: 8 }))
  assert(narrow.bounds !== null && wide.bounds !== null, 'both footprints must be known')
  assertClose(wide.bounds.minX, narrow.bounds.minX, 1e-9, 'stepover must not move minX')
  assertClose(wide.bounds.maxX, narrow.bounds.maxX, 1e-9, 'stepover must not move maxX')
  assertClose(wide.bounds.minY, narrow.bounds.minY, 1e-9, 'stepover must not move minY')
  assertClose(wide.bounds.maxY, narrow.bounds.maxY, 1e-9, 'stepover must not move maxY')
}

{
  console.log('S5.A3 trochoidalCutWidth and stockToLeaveRadial still widen the footprint...')
  const project = withTool(projectWithFeatures(newProject('footprint-margin-test', 'mm'), [draftFeature('f1')]))
  const target = { source: 'features', featureIds: ['f1'] } satisfies Operation['target']
  const base = operationFootprint(project, makeOperation(target))
  const trochoidal = operationFootprint(project, makeOperation(target, { trochoidalCutWidth: 3 }))
  const radial = operationFootprint(project, makeOperation(target, { stockToLeaveRadial: 0.5 }))
  assert(
    base.bounds !== null && trochoidal.bounds !== null && radial.bounds !== null,
    'all footprints must be known',
  )
  assertClose(
    trochoidal.bounds.minX,
    base.bounds.minX - 3,
    1e-9,
    'trochoidalCutWidth must widen the footprint by its value',
  )
  assertClose(
    radial.bounds.minX,
    base.bounds.minX - 0.5,
    1e-9,
    'stockToLeaveRadial must widen the footprint by its value',
  )
}

{
  console.log('S5.A4 USER-REPORTED CASE: a feature drawn just outside the stock no longer regenerates the pocket...')
  const { operation } = userMarginProject()
  const withOutside = projectWithFeatures(newProject('footprint-margin-test', 'inch'), [
    rectDraft('target', 0.5, 0.5, 3, 1),
    rectDraft('outside', 4.2, 0.5, 1, 1),
  ])
  const outsideProject = withTool(withOutside, defaultTool('inch'))
  const footprint = operationFootprint(outsideProject, operation)
  assert(footprint.bounds !== null, 'footprint bounds must not be null')
  assertClose(footprint.bounds.maxX, 4.0, 1e-9, 'fixture premise: the footprint must reach exactly the stock edge')
  const next = patchFeature(outsideProject, 'outside', { z_top: 0.6 })
  assert(
    !operationAffectedByChange(footprint, outsideProject, next, new Set(['outside'])),
    'a feature drawn just outside the stock must not regenerate the pocket',
  )
}

{
  console.log('S5.A5 A change overlapping the target or inside the remaining margin still regenerates...')
  const { operation } = userMarginProject()
  const build = (id: string, x: number): Project => withTool(
    projectWithFeatures(newProject('footprint-margin-test', 'inch'), [
      rectDraft('target', 0.5, 0.5, 3, 1),
      rectDraft(id, x, 0.5, 0.3, 1),
    ]),
    defaultTool('inch'),
  )

  // Inside the remaining margin: between the target edge (3.5) and the
  // footprint edge (4.0).
  const marginProject = build('margin', 3.6)
  const marginFootprint = operationFootprint(marginProject, operation)
  assert(marginFootprint.bounds !== null, 'margin fixture footprint must be known')
  assert(
    operationAffectedByChange(
      marginFootprint,
      marginProject,
      patchFeature(marginProject, 'margin', { z_top: 0.6 }),
      new Set(['margin']),
    ),
    'a change inside the remaining margin must regenerate the operation',
  )

  // Overlapping the target region itself.
  const overlapProject = build('overlap', 1.0)
  const overlapFootprint = operationFootprint(overlapProject, operation)
  assert(overlapFootprint.bounds !== null, 'overlap fixture footprint must be known')
  assert(
    operationAffectedByChange(
      overlapFootprint,
      overlapProject,
      patchFeature(overlapProject, 'overlap', { z_top: 0.6 }),
      new Set(['overlap']),
    ),
    'a change overlapping the target must regenerate the operation',
  )
}

// ── S6: exempt non-target regions ─────────────────────────────────

{
  console.log('S6.1 USER-REPORTED CASE: a region over the operation area that is not a target no longer regenerates it...')
  // r1 overlaps the target's footprint on purpose: if the region skip were
  // missing, the bbox check would return true and this test would catch it.
  const project = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('r1', 10, 0, 20, 10, { operation: 'region' }),
  ]))
  const footprint = operationFootprint(project, makeOperation({ source: 'features', featureIds: ['f1'] }))
  assert(footprint.bounds !== null, 'footprint bounds must not be null')
  assert(setEquals(footprint.targetFeatureIds, ['f1']), 'fixture premise: r1 must not be a target')
  const next = patchFeature(project, 'r1', { z_top: 8 })
  assert(
    !operationAffectedByChange(footprint, project, next, new Set(['r1'])),
    'a non-target region change must not regenerate the operation (reported case)',
  )
}

{
  console.log('S6.2 A region that IS a target still invalidates when edited...')
  const project = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('r2', 0, 20, 20, 10, { operation: 'region' }),
  ]))
  const footprint = operationFootprint(
    project,
    makeOperation({ source: 'features', featureIds: ['f1', 'r2'] }),
  )
  assert(footprint.bounds !== null, 'footprint bounds must not be null')
  const next = patchFeature(project, 'r2', { z_top: 8 })
  assert(
    operationAffectedByChange(footprint, project, next, new Set(['r2'])),
    'a change to a targeted region must regenerate the operation',
  )
}

{
  console.log('S6.3 A feature converted from subtract to region between snapshots still invalidates...')
  const previous = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('x1', 25, 0, 20, 10, { operation: 'subtract' }),
  ]))
  const next = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('x1', 25, 0, 20, 10, { operation: 'region' }),
  ]))
  const footprint = operationFootprint(previous, makeOperation({ source: 'features', featureIds: ['f1'] }))
  assert(footprint.bounds !== null, 'footprint bounds must not be null')
  assert(
    operationAffectedByChange(footprint, previous, next, new Set(['x1'])),
    'a subtract-to-region conversion must regenerate (region on one side only)',
  )
}

{
  console.log('S6.4 A feature converted from region to subtract between snapshots still invalidates...')
  const previous = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('x1', 25, 0, 20, 10, { operation: 'region' }),
  ]))
  const next = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('x1', 25, 0, 20, 10, { operation: 'subtract' }),
  ]))
  const footprint = operationFootprint(previous, makeOperation({ source: 'features', featureIds: ['f1'] }))
  assert(footprint.bounds !== null, 'footprint bounds must not be null')
  assert(
    operationAffectedByChange(footprint, previous, next, new Set(['x1'])),
    'a region-to-subtract conversion must regenerate (region on one side only)',
  )
}

{
  console.log('S6.5 A stock-targeted operation ignores region changes...')
  const project = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('r1', 10, 0, 20, 10, { operation: 'region' }),
  ]))
  const footprint = operationFootprint(project, makeOperation({ source: 'stock' }, { toolRef: null }))
  assert(footprint.readsWholeModel, 'stock footprint must read the whole model')
  assert(footprint.targetFeatureIds.size === 0, 'a stock target has no ids for a region to sit in')
  const next = patchFeature(project, 'r1', { z_top: 8 })
  assert(
    !operationAffectedByChange(footprint, project, next, new Set(['r1'])),
    'a region change must not affect a stock-targeted operation',
  )
}

{
  console.log('S6.6 CONTROL: a non-region subtract over the same area still regenerates...')
  // Identical geometry to S6.1 but `operation: subtract` — the exemption is
  // region-specific and must never swallow real material.
  const project = withTool(projectWithFeatures(newProject('footprint-test', 'mm'), [
    draftFeature('f1'),
    rectDraft('s1', 10, 0, 20, 10, { operation: 'subtract' }),
  ]))
  const footprint = operationFootprint(project, makeOperation({ source: 'features', featureIds: ['f1'] }))
  assert(footprint.bounds !== null, 'footprint bounds must not be null')
  const next = patchFeature(project, 's1', { z_top: 8 })
  assert(
    operationAffectedByChange(footprint, project, next, new Set(['s1'])),
    'a subtract change over the operation area must still regenerate',
  )
}

console.log('toolpathDependencies.test.ts: all tests passed')
