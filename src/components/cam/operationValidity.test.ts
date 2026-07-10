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
 * Tests for the shared operation-validity helpers.
 *
 * Two concerns are covered:
 *  1. `validQuickOperationsForFeature` — the feature → quick-operation mapping
 *     that the App.tsx context menu depends on.
 *  2. `getOperationAddHint` — golden hint values, so the extraction out of
 *     CAMPanel.tsx is provably behaviour-preserving (same inputs → same hints).
 *
 * Run with: npx tsx src/components/cam/operationValidity.test.ts
 */

import {
  compatibleFeatureIdsForOperation,
  getOperationAddHint,
  operationTargetsRegion,
  quickOperationLabel,
  selectAllCompatibleFeatureIds,
  validQuickOperationsForFeature,
} from './operationValidity'
import type { SelectionState } from '../../store/types'
import {
  newProject,
  rectProfile,
  type FeatureKind,
  type FeatureOperation,
  type Operation,
  type OperationTarget,
  type Project,
  type SketchFeature,
} from '../../types/project'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function openProfile() {
  return {
    start: { x: 0, y: 0 },
    segments: [{ type: 'line' as const, to: { x: 10, y: 10 } }],
    closed: false,
  }
}

function makeFeature(
  id: string,
  operation: FeatureOperation,
  kind: FeatureKind = 'polygon',
  closed = true,
): SketchFeature {
  return {
    id,
    name: id,
    kind,
    stl: kind === 'stl' ? null : undefined,
    folderId: null,
    sketch: {
      profile: closed ? rectProfile(0, 0, 10, 10) : openProfile(),
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

function projectWith(features: SketchFeature[]): Project {
  return { ...newProject(), features }
}

function selectionFor(featureIds: string[]): SelectionState {
  return {
    mode: 'feature',
    selectedFeatureId: featureIds[0] ?? null,
    selectedFeatureIds: featureIds,
    selectedNode: null,
    hoveredFeatureId: null,
    sketchEditTool: null,
    activeControl: null,
  }
}

function makeOperation(target: OperationTarget): Operation {
  return {
    id: 'op',
    name: 'op',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target,
    toolRef: null,
    stepdown: 1,
    stepover: 0.5,
    feed: 100,
    plungeFeed: 50,
    rpm: 10000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 0,
    maxCarveDepth: 0,
  }
}

// ── validQuickOperationsForFeature ────────────────────────────────

function testSubtractFeatureOffersPocketingNotSurface(): void {
  const project = projectWith([makeFeature('sub', 'subtract')])
  const kinds = validQuickOperationsForFeature(project, 'sub').map((op) => op.kind)

  assert(kinds.includes('pocket'), 'subtract feature should offer pocket')
  assert(kinds.includes('edge_route_inside'), 'subtract feature should offer inside route')
  assert(!kinds.includes('edge_route_outside'), 'subtract feature should not offer outside route')
  assert(!kinds.includes('surface_clean'), 'subtract feature should not offer surface clean')
  assert(!kinds.includes('rough_surface'), 'subtract feature should not offer rough surface')
  assert(!kinds.includes('finish_surface'), 'subtract feature should not offer finish surface')
}

function testAddFeatureOffersOutsideRouteAndSurfaceClean(): void {
  const project = projectWith([makeFeature('add', 'add')])
  const kinds = validQuickOperationsForFeature(project, 'add').map((op) => op.kind)

  assert(kinds.includes('edge_route_outside'), 'add feature should offer outside route')
  assert(kinds.includes('surface_clean'), 'add feature should offer surface clean')
  assert(!kinds.includes('pocket'), 'add feature should not offer pocket')
  assert(!kinds.includes('edge_route_inside'), 'add feature should not offer inside route')
  assert(!kinds.includes('rough_surface'), 'add feature should not offer rough surface')
}

function testStlModelOffersSurfaceOperations(): void {
  const project = projectWith([makeFeature('model', 'model', 'stl')])
  const kinds = validQuickOperationsForFeature(project, 'model').map((op) => op.kind)

  assert(kinds.includes('rough_surface'), 'stl model should offer rough surface')
  assert(kinds.includes('finish_surface'), 'stl model should offer finish surface')
  assert(kinds.includes('finish_surface_cleanup'), 'stl model should offer finish surface cleanup')
  assert(!kinds.includes('pocket'), 'stl model should not offer pocket')
}

function testRegionFeatureOffersNothing(): void {
  const project = projectWith([makeFeature('reg', 'region')])
  assert(
    validQuickOperationsForFeature(project, 'reg').length === 0,
    'region feature should offer no quick operations',
  )
}

function testMissingFeatureOffersNothing(): void {
  const project = projectWith([makeFeature('sub', 'subtract')])
  assert(
    validQuickOperationsForFeature(project, 'does-not-exist').length === 0,
    'unknown feature id should offer no quick operations',
  )
}

function testQuickOperationCarriesDefaultPassAndLabel(): void {
  const project = projectWith([makeFeature('sub', 'subtract')])
  const ops = validQuickOperationsForFeature(project, 'sub')
  const pocket = ops.find((op) => op.kind === 'pocket')

  assert(pocket !== undefined, 'expected a pocket quick operation')
  assert(pocket?.pass === 'rough', 'quick operations should default to the rough pass')
  assert(pocket?.label === 'Create Pocket', `expected friendly label, got ${pocket?.label}`)
  assert(quickOperationLabel('edge_route_outside') === 'Create Outside Route', 'outside-route label mismatch')
}

// ── getOperationAddHint (golden, behaviour-preserving) ────────────

function testGetOperationAddHintGoldenValues(): void {
  const project = projectWith([
    makeFeature('sub', 'subtract'),
    makeFeature('add', 'add'),
    makeFeature('model', 'model', 'stl'),
    makeFeature('circle', 'subtract', 'circle'),
  ])

  // Valid selections return null.
  assert(getOperationAddHint(project, selectionFor(['sub']), 'pocket') === null, 'subtract+pocket should be valid')
  assert(getOperationAddHint(project, selectionFor(['add']), 'edge_route_outside') === null, 'add+edge-out should be valid')
  assert(getOperationAddHint(project, selectionFor(['model']), 'rough_surface') === null, 'model+rough should be valid')
  assert(getOperationAddHint(project, selectionFor(['model']), 'finish_surface') === null, 'model+finish should be valid')
  assert(getOperationAddHint(project, selectionFor(['circle']), 'drilling') === null, 'circle+drilling should be valid')

  // Invalid selections return the exact hint strings the CAM panel renders.
  assert(
    getOperationAddHint(project, selectionFor([]), 'pocket') === 'Select one or more compatible features first',
    'empty+pocket hint mismatch',
  )
  assert(
    getOperationAddHint(project, selectionFor([]), 'drilling') === 'Select one or more circle features first',
    'empty+drilling hint mismatch',
  )
  assert(
    getOperationAddHint(project, selectionFor(['sub']), 'surface_clean')
      === 'Surface clean only accepts add/model features plus optional closed regions',
    'subtract+surface-clean hint mismatch',
  )
  assert(
    getOperationAddHint(project, selectionFor(['add']), 'v_carve')
      === 'V-Carve offset only accepts closed subtract or line features plus optional closed regions',
    'add+v_carve hint mismatch',
  )
  assert(
    getOperationAddHint(project, selectionFor(['add']), 'pocket')
      === 'This operation only accepts subtract features plus optional closed regions',
    'add+pocket hint mismatch',
  )
}

// ── compatibleFeatureIdsForOperation (A1.3 canvas highlight) ──────

function testCompatibleFeatureIdsReuseValidityRules(): void {
  const project = projectWith([
    makeFeature('sub', 'subtract'),
    makeFeature('add', 'add'),
    makeFeature('reg', 'region'),
  ])

  // The highlight set must match the CAM panel's add-hint rules exactly:
  // pocket → subtract only; outside route → add (and model) only.
  assert(
    JSON.stringify(compatibleFeatureIdsForOperation(project, 'pocket')) === JSON.stringify(['sub']),
    'pocket should highlight only the subtract feature',
  )
  assert(
    JSON.stringify(compatibleFeatureIdsForOperation(project, 'edge_route_outside')) === JSON.stringify(['add']),
    'outside route should highlight only the add feature',
  )
  // A region is a filter, never a standalone machining target, so it is never
  // highlighted as the thing an operation would act on.
  for (const kind of ['pocket', 'edge_route_outside', 'surface_clean', 'drilling'] as const) {
    assert(
      !compatibleFeatureIdsForOperation(project, kind).includes('reg'),
      `region should not be highlighted as compatible for ${kind}`,
    )
  }
}

function testCompatibleFeatureIdsMatchAddHint(): void {
  // Every highlighted feature must individually pass getOperationAddHint, and
  // no non-highlighted feature may — i.e. the highlight is a faithful view of
  // the same source of truth, not a parallel rule set.
  const project = projectWith([
    makeFeature('sub', 'subtract'),
    makeFeature('add', 'add'),
    makeFeature('model', 'model', 'stl'),
  ])
  for (const kind of ['pocket', 'edge_route_outside', 'rough_surface'] as const) {
    const highlighted = new Set(compatibleFeatureIdsForOperation(project, kind))
    for (const feature of project.features) {
      const valid = getOperationAddHint(project, selectionFor([feature.id]), kind) === null
      assert(highlighted.has(feature.id) === valid, `${feature.id}/${kind} highlight must match add-hint validity`)
    }
  }
}

// ── selectAllCompatibleFeatureIds ("Select all" in the add menu) ──

function testSelectAllReturnsCompatibleIdsWhenJointlyValid(): void {
  const project = projectWith([
    makeFeature('sub1', 'subtract'),
    makeFeature('sub2', 'subtract'),
    makeFeature('add', 'add'),
  ])

  // Pocket accepts multiple subtract features together, so "Select all" offers
  // exactly the compatible set.
  assert(
    JSON.stringify(selectAllCompatibleFeatureIds(project, 'pocket')) === JSON.stringify(['sub1', 'sub2']),
    'pocket select-all should return both subtract features',
  )
}

function testSelectAllReturnsEmptyWhenNothingCompatible(): void {
  const project = projectWith([makeFeature('add', 'add')])
  assert(
    selectAllCompatibleFeatureIds(project, 'pocket').length === 0,
    'pocket select-all should be empty with no subtract features',
  )
}

function testSelectAllReturnsEmptyWhenJointSelectionInvalid(): void {
  // Two models are each individually valid for finish_surface, but the kind
  // accepts exactly one model — there is no unambiguous "all", so the
  // affordance must not be offered.
  const project = projectWith([
    makeFeature('model1', 'model', 'stl'),
    makeFeature('model2', 'model', 'stl'),
  ])

  assert(
    JSON.stringify(compatibleFeatureIdsForOperation(project, 'finish_surface'))
      === JSON.stringify(['model1', 'model2']),
    'both models should be individually compatible with finish surface',
  )
  assert(
    selectAllCompatibleFeatureIds(project, 'finish_surface').length === 0,
    'finish-surface select-all should be empty when two models exist',
  )
  assert(
    JSON.stringify(selectAllCompatibleFeatureIds(projectWith([makeFeature('model1', 'model', 'stl')]), 'finish_surface'))
      === JSON.stringify(['model1']),
    'finish-surface select-all should offer a single model',
  )
}

// ── operationTargetsRegion (A1.4 region-as-parameter note) ────────

function testOperationTargetsRegion(): void {
  const project = projectWith([
    makeFeature('sub', 'subtract'),
    makeFeature('reg', 'region'),
  ])

  assert(
    operationTargetsRegion(project, makeOperation({ source: 'features', featureIds: ['sub', 'reg'] })),
    'target including a region feature should report true',
  )
  assert(
    !operationTargetsRegion(project, makeOperation({ source: 'features', featureIds: ['sub'] })),
    'target without a region feature should report false',
  )
  assert(
    !operationTargetsRegion(project, makeOperation({ source: 'stock' })),
    'a stock target should report false',
  )
}

// ── S2: closed Line V-carve eligibility ────────────────────────────

function testClosedLineIsValidVCarveTarget(): void {
  const project = projectWith([makeFeature('line1', 'line')])
  assert(
    getOperationAddHint(project, selectionFor(['line1']), 'v_carve') === null,
    'closed line should be valid for v_carve',
  )
  assert(
    getOperationAddHint(project, selectionFor(['line1']), 'v_carve_recursive') === null,
    'closed line should be valid for v_carve_recursive',
  )
}

function testOpenLineIsInvalidVCarveTarget(): void {
  const project = projectWith([makeFeature('openLine', 'line', 'polygon', false)])
  const hint = getOperationAddHint(project, selectionFor(['openLine']), 'v_carve')
  assert(hint !== null, 'open line should be invalid for v_carve')
  assert(
    hint === 'V-Carve offset only accepts closed subtract or line features plus optional closed regions',
    `open line v_carve hint mismatch: ${hint}`,
  )
}

function testClosedLineInCompatibleFeatureIds(): void {
  const project = projectWith([
    makeFeature('sub', 'subtract'),
    makeFeature('line1', 'line'),
    makeFeature('add', 'add'),
  ])
  const vCarveIds = compatibleFeatureIdsForOperation(project, 'v_carve')
  assert(vCarveIds.includes('sub'), 'subtract should be compatible with v_carve')
  assert(vCarveIds.includes('line1'), 'closed line should be compatible with v_carve')
  assert(!vCarveIds.includes('add'), 'add should not be compatible with v_carve')
}

function testClosedLineInQuickOperations(): void {
  const project = projectWith([makeFeature('line1', 'line')])
  const kinds = validQuickOperationsForFeature(project, 'line1').map((op) => op.kind)
  assert(kinds.includes('v_carve'), 'closed line should offer v_carve quick op')
  assert(kinds.includes('v_carve_recursive'), 'closed line should offer v_carve_recursive quick op')
  assert(kinds.includes('follow_line'), 'closed line should offer engrave quick op')
  assert(!kinds.includes('pocket'), 'line should not offer pocket')
}

function testOpenLineNotInQuickOperations(): void {
  const project = projectWith([makeFeature('openLine', 'line', 'polygon', false)])
  const kinds = validQuickOperationsForFeature(project, 'openLine').map((op) => op.kind)
  assert(!kinds.includes('v_carve'), 'open line should not offer v_carve')
  assert(!kinds.includes('v_carve_recursive'), 'open line should not offer v_carve_recursive')
  assert(kinds.includes('follow_line'), 'open line should offer engrave')
}

function testVCarveSelectAllIncludesLines(): void {
  const project = projectWith([
    makeFeature('line1', 'line'),
    makeFeature('line2', 'line'),
  ])
  const allIds = selectAllCompatibleFeatureIds(project, 'v_carve')
  assert(
    JSON.stringify(allIds) === JSON.stringify(['line1', 'line2']),
    'v_carve select-all should include closed lines',
  )
}

function testEmptySelectionVCarveHintMentionsLines(): void {
  const project = projectWith([])
  const hint = getOperationAddHint(project, selectionFor([]), 'v_carve')
  assert(
    hint === 'Select one or more closed subtract or line features first',
    `empty selection v_carve hint should mention lines, got: ${hint}`,
  )
}

function testMixedSubtractAndLineIsValid(): void {
  const project = projectWith([
    makeFeature('sub', 'subtract'),
    makeFeature('line1', 'line'),
  ])
  assert(
    getOperationAddHint(project, selectionFor(['sub', 'line1']), 'v_carve') === null,
    'mixed subtract + closed line should be valid for v_carve',
  )
}

testSubtractFeatureOffersPocketingNotSurface()
testAddFeatureOffersOutsideRouteAndSurfaceClean()
testStlModelOffersSurfaceOperations()
testRegionFeatureOffersNothing()
testMissingFeatureOffersNothing()
testQuickOperationCarriesDefaultPassAndLabel()
testGetOperationAddHintGoldenValues()
testCompatibleFeatureIdsReuseValidityRules()
testCompatibleFeatureIdsMatchAddHint()
testSelectAllReturnsCompatibleIdsWhenJointlyValid()
testSelectAllReturnsEmptyWhenNothingCompatible()
testSelectAllReturnsEmptyWhenJointSelectionInvalid()
testOperationTargetsRegion()
testClosedLineIsValidVCarveTarget()
testOpenLineIsInvalidVCarveTarget()
testClosedLineInCompatibleFeatureIds()
testClosedLineInQuickOperations()
testOpenLineNotInQuickOperations()
testVCarveSelectAllIncludesLines()
testEmptySelectionVCarveHintMentionsLines()
testMixedSubtractAndLineIsValid()

console.log('operationValidity tests passed')
