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
  operationTargetFromSelection,
  operationTargetsRegion,
  quickOperationGroup,
  quickOperationLabel,
  rotaryAddKindsForFace,
  rotaryOperationHint,
  rotaryTargetModels,
  rotaryTargetToggle,
  selectAllCompatibleFeatureIds,
  validQuickOperationsForFeature,
} from './operationValidity'
import type { SelectionState } from '../../store/types'
import { squareStock } from '../../types/barStock'
import { operationCutsInProject } from '../../store/helpers/projectType'
import { projectWithFeatures } from '../../test/projectFixtures'
import { rotaryMultiModelFixture, rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { camT } from './camI18n'
import { getTextFontOptions } from '../../text'
import { BUNDLED_DEFINITIONS } from '../../engine/gcode/definitions'
import type { MachineDefinition } from '../../engine/gcode/types'
import {
  newProject,
  rectProfile,
  type FeatureKind,
  type FeatureOperation,
  type Operation,
  type OperationKind,
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
  return projectWithFeatures(newProject(), features)
}

function selectionFor(featureIds: string[]): SelectionState {
  return {
    mode: 'feature',
    selectedFeatureId: featureIds[0] ?? null,
    selectedFeatureIds: featureIds,
    selectedTabIds: [],
    selectedClampIds: [],
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
  assert(pocket?.label === 'Create pocket', `expected friendly label, got ${pocket?.label}`)
  assert(pocket?.group === '2d', 'pocket is a 2D quick operation')
  assert(quickOperationLabel('edge_route_outside') === 'Create outside route', 'outside-route label mismatch')
}

// ── 2D/3D grouping (issue #398) ───────────────────────────────────

/**
 * The 3D group is exactly the three kinds that machine an imported model
 * surface. `edge_route_outside` and `surface_clean` accept a model feature as a
 * target but remain 2.5D passes, so they must stay in the 2D group.
 */
function testQuickOperationGroupClassification(): void {
  const threeD: OperationKind[] = ['rough_surface', 'finish_surface', 'finish_surface_cleanup']
  const twoD: OperationKind[] = [
    'pocket',
    'edge_route_inside',
    'edge_route_outside',
    'v_carve',
    'v_carve_medial',
    'surface_clean',
    'follow_line',
    'drilling',
  ]

  for (const kind of threeD) {
    assert(quickOperationGroup(kind) === '3d', `${kind} should be a 3D quick operation`)
  }
  for (const kind of twoD) {
    assert(quickOperationGroup(kind) === '2d', `${kind} should be a 2D quick operation`)
  }
}

/** The menu renders the array in order, so 2D entries must all precede 3D. */
function testStlModelQuickOperationsAreGroupedTwoDFirst(): void {
  const project = projectWith([makeFeature('model', 'model', 'stl')])
  const groups = validQuickOperationsForFeature(project, 'model').map((op) => op.group)

  assert(groups.includes('2d') && groups.includes('3d'), 'stl model should offer both groups')
  assert(
    groups.indexOf('3d') === groups.lastIndexOf('2d') + 1,
    `2D entries must all precede 3D, got ${groups.join(',')}`,
  )
}

/** The 3D labels are the CAM panel's own names, not a second vocabulary. */
function testThreeDLabelsMatchCamPanelNames(): void {
  assert(
    quickOperationLabel('rough_surface') === 'Create 3D surface rough',
    `rough-surface label mismatch, got ${quickOperationLabel('rough_surface')}`,
  )
  assert(
    quickOperationLabel('finish_surface') === 'Create 3D surface finish',
    `finish-surface label mismatch, got ${quickOperationLabel('finish_surface')}`,
  )
  assert(
    quickOperationLabel('finish_surface_cleanup') === 'Create 3D surface cleanup',
    `cleanup label mismatch, got ${quickOperationLabel('finish_surface_cleanup')}`,
  )
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
      === 'V-carve offset only accepts closed subtract or line features plus optional closed regions',
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

function testSelectAllOffersEveryModelForFinish(): void {
  // Several models finish together as one surface (issue #934), so select-all
  // offers every model; it used to offer none, since the kind took exactly one.
  const project = projectWith([
    makeFeature('model1', 'model', 'stl'),
    makeFeature('model2', 'model', 'stl'),
  ])

  for (const kind of ['finish_surface', 'finish_surface_cleanup'] as const) {
    assert(
      JSON.stringify(selectAllCompatibleFeatureIds(project, kind)) === JSON.stringify(['model1', 'model2']),
      `${kind} select-all should offer both models`,
    )
    assert(
      getOperationAddHint(project, selectionFor(['model1', 'model2']), kind) === null,
      `${kind} should accept two models`,
    )
  }
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
    getOperationAddHint(project, selectionFor(['line1']), 'v_carve_medial') === null,
    'closed line should be valid for v_carve_medial',
  )
}

function testOpenLineIsInvalidVCarveTarget(): void {
  const project = projectWith([makeFeature('openLine', 'line', 'polygon', false)])
  const hint = getOperationAddHint(project, selectionFor(['openLine']), 'v_carve')
  assert(hint !== null, 'open line should be invalid for v_carve')
  assert(
    hint === 'V-carve offset only accepts closed subtract or line features plus optional closed regions',
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
  assert(kinds.includes('v_carve_medial'), 'closed line should offer v_carve_medial quick op')
  assert(kinds.includes('follow_line'), 'closed line should offer engrave quick op')
  assert(!kinds.includes('pocket'), 'line should not offer pocket')
}

function testOpenLineNotInQuickOperations(): void {
  const project = projectWith([makeFeature('openLine', 'line', 'polygon', false)])
  const kinds = validQuickOperationsForFeature(project, 'openLine').map((op) => op.kind)
  assert(!kinds.includes('v_carve'), 'open line should not offer v_carve')
  assert(!kinds.includes('v_carve_medial'), 'open line should not offer v_carve_medial')
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

function testLargeCompatibilityScanResolvesEachInstanceOnce(): void {
  const featureCount = 250
  const project = projectWith(Array.from(
    { length: featureCount },
    (_, index) => makeFeature(`line-${index}`, 'line'),
  ))
  const definitions = project.featureDefinitions
  let definitionReads = 0
  project.featureDefinitions = new Proxy(definitions, {
    get(target, property, receiver) {
      if (typeof property === 'string') definitionReads += 1
      return Reflect.get(target, property, receiver)
    },
  })

  const compatibleIds = selectAllCompatibleFeatureIds(project, 'v_carve')

  assert(compatibleIds.length === featureCount, 'all closed lines should be compatible with V-carve')
  assert(
    definitionReads <= featureCount * 2,
    `compatibility scan should resolve each instance once, got ${definitionReads} definition reads for ${featureCount} features`,
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

function makeTextFeature(id: string, text: string, operation: 'add' | 'subtract'): SketchFeature {
  return {
    ...makeFeature(id, operation, 'text'),
    text: { text, style: 'outline', fontId: getTextFontOptions('outline')[0].id, size: 1 },
    sketch: {
      profile: rectProfile(0, 0, 1, 1.4),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }
}

// An add text's counters are subtracts, so pocket and inside route can cut
// them without exploding the text (issue #861).
function testAddTextWithCountersOffersInsideRouteAndPocket(): void {
  const project = projectWith([makeTextFeature('text', 'O', 'add')])
  const kinds = validQuickOperationsForFeature(project, 'text').map((op) => op.kind)

  assert(kinds.includes('edge_route_inside'), 'add "O" should offer inside route for its counter')
  assert(kinds.includes('pocket'), 'add "O" should offer pocket for its counter')
  assert(kinds.includes('edge_route_outside'), 'add "O" should still offer outside route')
}

function testAddTextWithoutCountersIsRefusedForInsideRoute(): void {
  const project = projectWith([makeTextFeature('text', 'L', 'add')])
  const kinds = validQuickOperationsForFeature(project, 'text').map((op) => op.kind)

  assert(!kinds.includes('edge_route_inside'), 'add "L" has no counter, so no inside route')
  assert(!kinds.includes('pocket'), 'add "L" has no counter, so no pocket')
  assert(
    getOperationAddHint(project, selectionFor(['text']), 'edge_route_inside') === getOperationAddHint(
      projectWith([makeFeature('add', 'add')]),
      selectionFor(['add']),
      'edge_route_inside',
    ),
    'add "L" should get the same "only subtract" hint as a plain add',
  )
}

// The mirror case: a subtract text's islands are adds an outside route walks.
function testSubtractTextWithIslandsOffersOutsideRoute(): void {
  const project = projectWith([makeTextFeature('text', 'O', 'subtract')])
  const kinds = validQuickOperationsForFeature(project, 'text').map((op) => op.kind)

  assert(kinds.includes('edge_route_outside'), 'subtract "O" should offer outside route for its island')
  assert(kinds.includes('edge_route_inside'), 'subtract "O" should still offer inside route')
}

// The CAM panel's Add button and "Use current selection" take their target
// from this, so a multi-selection must follow the same rule as a single
// feature does in the quick-operation menu (issue #861).
function testTargetFromMultiSelectionOfAddTexts(): void {
  const project = projectWith([
    makeTextFeature('o', 'O', 'add'),
    makeTextFeature('p', 'P', 'add'),
    makeTextFeature('l', 'L', 'add'),
  ])

  const target = operationTargetFromSelection(project, selectionFor(['o', 'p']), 'edge_route_inside')
  assert(
    target !== null && target.source === 'features' && target.featureIds.join(',') === 'o,p',
    `add "O" + "P" should give an inside route target, got ${JSON.stringify(target)}`,
  )
  assert(
    operationTargetFromSelection(project, selectionFor(['o', 'p']), 'pocket') !== null,
    'add "O" + "P" should give a pocket target',
  )
  assert(
    operationTargetFromSelection(project, selectionFor(['o', 'l']), 'edge_route_inside') === null,
    'a selection with a counterless add "L" is refused, as a plain add would be',
  )
}

function testTargetFromSelectionRefusesUnknownIds(): void {
  const project = projectWith([makeFeature('sub', 'subtract')])

  assert(
    operationTargetFromSelection(project, selectionFor(['sub']), 'pocket') !== null,
    'a subtract should give a pocket target',
  )
  assert(
    operationTargetFromSelection(project, selectionFor(['sub', 'gone']), 'pocket') === null,
    'a selection naming a missing feature should give no target',
  )
  assert(
    operationTargetFromSelection(project, selectionFor([]), 'pocket') === null,
    'an empty selection should give no target',
  )
}

// ── quick operations follow the machine (issue #960) ──────────────

/**
 * The feature context menu's "Create operation" submenu used to offer the
 * eleven milling kinds on every machine and never the plasma cut. It now takes
 * the machine from the same derived mode the CAM panel's Add menu uses
 * (`machineMode` + `operationOffer`), so plasma mode offers only the plasma
 * cut and router mode only the milling family. The underlying feature rules
 * (`getOperationAddHintWithMap`) are unchanged — the mode is an extra gate.
 */
function bundled(id: string): MachineDefinition {
  const definition = BUNDLED_DEFINITIONS.find((candidate) => candidate.id === id)
  assert(definition !== undefined, `expected the bundled ${id} definition`)
  return definition
}

function projectWithMachine(definition: MachineDefinition | null, features: SketchFeature[]): Project {
  const project = projectWith(features)
  return {
    ...project,
    meta: {
      ...project.meta,
      // A coherent fixture: the project type suits the machine it selects, as
      // `inferProjectType` would give it on load (issue #1028).
      projectType: definition?.machineKind === 'plasma' ? 'plasma' : 'milling',
      machineDefinitions: definition ? [definition] : [],
      selectedMachineId: definition?.id ?? null,
    },
  }
}

const ROUTER_MACHINE = bundled('generic')
const PLASMA_MACHINES = [bundled('qtplasmac'), bundled('grbl-plasma')]

/** The milling menu each feature offered before the plasma kind existed. */
const MILLING_MENU_BY_FEATURE: Record<'add' | 'subtract' | 'model', OperationKind[]> = {
  add: ['edge_route_outside', 'surface_clean', 'follow_line'],
  subtract: ['pocket', 'edge_route_inside', 'v_carve', 'v_carve_medial', 'follow_line'],
  model: [
    'edge_route_outside',
    'surface_clean',
    'follow_line',
    'rough_surface',
    'finish_surface',
    'finish_surface_cleanup',
  ],
}

function testPlasmaMachineOffersOnlyThePlasmaCut(): void {
  for (const machine of PLASMA_MACHINES) {
    for (const operation of ['add', 'subtract'] as const) {
      const project = projectWithMachine(machine, [makeFeature('f', operation)])
      const ops = validQuickOperationsForFeature(project, 'f')
      const kinds = ops.map((op) => op.kind)

      assert(
        JSON.stringify(kinds) === JSON.stringify(['plasma_profile']),
        `plasma (${machine.id}) + closed ${operation} should offer exactly the plasma cut, got ${JSON.stringify(kinds)}`,
      )

      const plasma = ops[0]
      assert(plasma.pass === 'rough', `plasma quick op on ${machine.id} should default to the rough pass`)
      assert(plasma.group === '2d', `plasma quick op on ${machine.id} should be a 2D quick operation`)
      assert(
        plasma.label === quickOperationLabel('plasma_profile'),
        `plasma quick op label should be quickOperationLabel('plasma_profile'), got ${plasma.label}`,
      )
      assert(
        plasma.label === 'Create plasma through-cut',
        `plasma quick op label mismatch, got ${plasma.label}`,
      )
    }
  }
}

function testPlasmaMachineRejectsFeaturesThePlasmaHintRejects(): void {
  for (const machine of PLASMA_MACHINES) {
    const openLine = projectWithMachine(machine, [makeFeature('openLine', 'line', 'polygon', false)])
    assert(
      validQuickOperationsForFeature(openLine, 'openLine').length === 0,
      `plasma (${machine.id}) + open line should offer nothing`,
    )

    const model = projectWithMachine(machine, [makeFeature('model', 'model', 'stl')])
    assert(
      validQuickOperationsForFeature(model, 'model').length === 0,
      `plasma (${machine.id}) + stl model should offer nothing`,
    )
  }
}

function testRouterAndMachineLessProjectsKeepTheMillingMenu(): void {
  const features: Record<'add' | 'subtract' | 'model', SketchFeature> = {
    add: makeFeature('add', 'add'),
    subtract: makeFeature('sub', 'subtract'),
    model: makeFeature('model', 'model', 'stl'),
  }

  for (const key of ['add', 'subtract', 'model'] as const) {
    for (const machine of [ROUTER_MACHINE, null]) {
      const project = projectWithMachine(machine, [features[key]])
      const kinds = validQuickOperationsForFeature(project, features[key].id).map((op) => op.kind)
      const where = machine === null ? 'no machine' : `router ${machine.id}`

      assert(
        !kinds.includes('plasma_profile'),
        `${where} should not offer the plasma cut on a ${key} feature`,
      )
      assert(
        JSON.stringify(kinds) === JSON.stringify(MILLING_MENU_BY_FEATURE[key]),
        `${where} + ${key} quick operations must be unchanged, got ${JSON.stringify(kinds)}`,
      )
    }
  }
}

// ── rotary add-menu rows (issue #1015) ────────────────────────────

/**
 * The slice-D rotary fixture holds one imported model and one 2D Around
 * feature. Adding a second model (a clone of the first) makes "one of two
 * selected" and "target every model" distinguishable.
 */
function withSecondModel(project: Project): Project {
  const model = project.features.find((feature) => feature.id === 'model')
  const definition = model && project.featureDefinitions[model.definitionId]
  assert(model !== undefined && definition !== undefined, 'rotary fixture should hold its model')
  project.featureDefinitions = { ...project.featureDefinitions, 'model-2': { ...definition, id: 'model-2' } }
  project.features = [...project.features, { ...model, id: 'model-2', definitionId: 'model-2', name: 'Model 2' }]
  return project
}

/** The same fixture with its imported models removed: only the 2D feature is left. */
function withoutModels(project: Project): Project {
  project.features = project.features.filter(
    (feature) => project.featureDefinitions[feature.definitionId]?.kind !== 'stl',
  )
  return project
}

/**
 * The rotary rows do not depend on the selection: on a round bar in Around any
 * imported model makes them available, the selection only narrows which model
 * Add targets, and with nothing suitable selected every model is targeted.
 */
function testRotaryAddRowsTargetModelsWithoutASelection(): void {
  const project = withSecondModel(rotaryOperationFixture('x', 'rotary_finish'))
  const allModels = ['model', 'model-2']

  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    assert(
      getOperationAddHint(project, selectionFor([]), kind) === null,
      `${kind} should be available with nothing selected`,
    )
    assert(
      JSON.stringify(operationTargetFromSelection(project, selectionFor([]), kind))
        === JSON.stringify({ source: 'features', featureIds: allModels }),
      `${kind} with nothing selected should target every model`,
    )
    assert(
      JSON.stringify(operationTargetFromSelection(project, selectionFor(['model-2']), kind))
        === JSON.stringify({ source: 'features', featureIds: ['model-2'] }),
      `${kind} with one model selected should target that model`,
    )
    assert(
      JSON.stringify(operationTargetFromSelection(project, selectionFor(['sketch']), kind))
        === JSON.stringify({ source: 'features', featureIds: allModels }),
      `${kind} with a non-model selected should still target every model`,
    )
  }
}

/** Without an imported model the rows stay unavailable, with their own tooltip. */
function testRotaryAddRowsNeedAnImportedModel(): void {
  const project = withoutModels(rotaryOperationFixture('x', 'rotary_rough'))

  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    const key = kind === 'rotary_rough' ? 'cam.rotary.roughNoModel' : 'cam.rotary.finishNoModel'
    assert(
      getOperationAddHint(project, selectionFor([]), kind) === camT(key),
      `${kind} without a model should show its own hint`,
    )
    assert(
      operationTargetFromSelection(project, selectionFor([]), kind) === null,
      `${kind} without a model should give no target`,
    )
  }
}

/** The rows belong to Around alone, and to a rotary project alone (issue #1028). */
function testRotaryAddRowsAreOfferedOnlyOnAround(): void {
  const project = rotaryOperationFixture('x', 'rotary_rough')
  assert(
    JSON.stringify(rotaryAddKindsForFace(project, 'around')) === JSON.stringify(['rotary_rough', 'rotary_finish']),
    'Around should offer both rotary rows',
  )
  assert(JSON.stringify(rotaryAddKindsForFace(project, 'top')) === '[]', 'Top should offer no rotary row')
  assert(JSON.stringify(rotaryAddKindsForFace(project, 'bottom')) === '[]', 'Bottom should offer no rotary row')

  const milling = { ...project, meta: { ...project.meta, projectType: 'milling' as const } }
  assert(
    JSON.stringify(rotaryAddKindsForFace(milling, 'around')) === '[]',
    'a project that is not rotary should offer no rotary row even on Around',
  )

  const onTop = withSecondModel(rotaryOperationFixture('x', 'rotary_finish'))
  const topSetup = { ...onTop, activeSetupId: onTop.setups[0].id }
  assert(
    getOperationAddHint(topSetup, selectionFor([]), 'rotary_rough') === camT('cam.rotary.aroundRequired'),
    'a Top setup should refuse the rotary rows',
  )
  assert(
    getOperationAddHint(milling, selectionFor([]), 'rotary_rough') === camT('cam.rotary.aroundRequired'),
    'a non-rotary project should refuse the rotary rows',
  )
}

// ── rotary target picker (issue #1015 slice K) ────────────────────
//
// The rotary operation's properties carry a checklist of the project's
// imported models (the model is not selectable on the Around sheet), and since
// #1096 the standard "Use current selection" control beside it adds a region
// filter. `rotaryTargetToggle` is the checklist's whole rule;
// mutations checked one at a time against these assertions:
// - the result written in click order instead of project order → "the write is
//   in project order, not click order" fails;
// - the last ticked model removable → "the last ticked model cannot be
//   removed" fails;
// - a stale id carried into the write → "an id that names no model is
//   dropped" fails.

/** The fixture plus a clone of its model, so one-of-two and both are distinguishable. */
function pickerProject(): Project {
  return withSecondModel(rotaryOperationFixture('x', 'rotary_finish'))
}

function testRotaryTargetModelsListTheProject(): void {
  const project = pickerProject()
  assert(
    JSON.stringify(rotaryTargetModels(project))
      === JSON.stringify([{ id: 'model', name: 'Model' }, { id: 'model-2', name: 'Model 2' }]),
    `the picker lists the models in project order: ${JSON.stringify(rotaryTargetModels(project))}`,
  )
}

function testRotaryTargetToggleKeepsProjectOrder(): void {
  const project = pickerProject()
  assert(
    JSON.stringify(rotaryTargetToggle(project, { source: 'features', featureIds: ['model'] }, 'model-2'))
      === JSON.stringify({ source: 'features', featureIds: ['model', 'model-2'] }),
    'ticking a second model adds it',
  )
  assert(
    JSON.stringify(rotaryTargetToggle(project, { source: 'features', featureIds: ['model-2'] }, 'model'))
      === JSON.stringify({ source: 'features', featureIds: ['model', 'model-2'] }),
    'the write is in project order, not click order',
  )
}

function testRotaryTargetToggleOffAndLastBox(): void {
  const project = pickerProject()
  assert(
    JSON.stringify(rotaryTargetToggle(project, { source: 'features', featureIds: ['model', 'model-2'] }, 'model-2'))
      === JSON.stringify({ source: 'features', featureIds: ['model'] }),
    'unticking a model removes it',
  )
  assert(
    JSON.stringify(rotaryTargetToggle(project, { source: 'features', featureIds: ['model'] }, 'model'))
      === JSON.stringify({ source: 'features', featureIds: ['model'] }),
    'the last ticked model cannot be removed',
  )
}

function testRotaryTargetToggleDropsStaleIds(): void {
  const project = pickerProject()
  assert(
    JSON.stringify(rotaryTargetToggle(project, { source: 'features', featureIds: ['model', 'gone'] }, 'model-2'))
      === JSON.stringify({ source: 'features', featureIds: ['model', 'model-2'] }),
    'an id that names no model is dropped from the next write',
  )
  assert(
    JSON.stringify(rotaryTargetToggle(project, { source: 'features', featureIds: ['model', 'gone'] }, 'model'))
      === JSON.stringify({ source: 'features', featureIds: ['model'] }),
    'a stale id is not a ticked model: the last real one still cannot be removed',
  )
  assert(
    JSON.stringify(rotaryTargetToggle(project, { source: 'stock' }, 'model'))
      === JSON.stringify({ source: 'features', featureIds: ['model'] }),
    'ticking a model from a stock target writes a feature target',
  )
}

testSubtractFeatureOffersPocketingNotSurface()
testAddFeatureOffersOutsideRouteAndSurfaceClean()
testStlModelOffersSurfaceOperations()
testRegionFeatureOffersNothing()
testMissingFeatureOffersNothing()
testQuickOperationCarriesDefaultPassAndLabel()
testQuickOperationGroupClassification()
testStlModelQuickOperationsAreGroupedTwoDFirst()
testThreeDLabelsMatchCamPanelNames()
testGetOperationAddHintGoldenValues()
testCompatibleFeatureIdsReuseValidityRules()
testCompatibleFeatureIdsMatchAddHint()
testSelectAllReturnsCompatibleIdsWhenJointlyValid()
testSelectAllReturnsEmptyWhenNothingCompatible()
testSelectAllOffersEveryModelForFinish()
testOperationTargetsRegion()
testClosedLineIsValidVCarveTarget()
testOpenLineIsInvalidVCarveTarget()
testClosedLineInCompatibleFeatureIds()
testClosedLineInQuickOperations()
testOpenLineNotInQuickOperations()
testVCarveSelectAllIncludesLines()
testLargeCompatibilityScanResolvesEachInstanceOnce()
testEmptySelectionVCarveHintMentionsLines()
testMixedSubtractAndLineIsValid()
testAddTextWithCountersOffersInsideRouteAndPocket()
testAddTextWithoutCountersIsRefusedForInsideRoute()
testSubtractTextWithIslandsOffersOutsideRoute()
testTargetFromMultiSelectionOfAddTexts()
testTargetFromSelectionRefusesUnknownIds()
testPlasmaMachineOffersOnlyThePlasmaCut()
testPlasmaMachineRejectsFeaturesThePlasmaHintRejects()
testRouterAndMachineLessProjectsKeepTheMillingMenu()
testRotaryAddRowsTargetModelsWithoutASelection()
testRotaryAddRowsNeedAnImportedModel()
testRotaryAddRowsAreOfferedOnlyOnAround()
testRotaryTargetModelsListTheProject()
testRotaryTargetToggleKeepsProjectOrder()
testRotaryTargetToggleOffAndLastBox()
/** #1096: a region filter riding on a rotary target survives the model checklist. */
function testRotaryTargetToggleKeepsRegionFilters(): void {
  const project = rotaryMultiModelFixture('x', 'rotary_finish')
  assert(
    JSON.stringify(rotaryTargetToggle(project, { source: 'features', featureIds: ['model', 'region'] }, 'second'))
      === JSON.stringify({ source: 'features', featureIds: ['model', 'second', 'region'] }),
    'ticking a model keeps the region filter',
  )
  assert(
    JSON.stringify(rotaryTargetToggle(project, { source: 'features', featureIds: ['model', 'second', 'region'] }, 'second'))
      === JSON.stringify({ source: 'features', featureIds: ['model', 'region'] }),
    'unticking a model keeps the region filter',
  )
  assert(
    JSON.stringify(rotaryTargetToggle(project, { source: 'features', featureIds: ['model', 'region'] }, 'gone'))
      === JSON.stringify({ source: 'features', featureIds: ['model', 'region'] }),
    'a stale id is dropped and the region filter stays',
  )
}
testRotaryTargetToggleKeepsRegionFilters()
testRotaryTargetToggleDropsStaleIds()

// ── square rotary model hints (issue #1016 C2-U1) ─────────────────

/** The slice-D rotary fixture with a real square blank in place of its bar. */
function squareRotaryFixture(axis: 'x' | 'y', kind: OperationKind): Project {
  const project = rotaryOperationFixture(axis, kind)
  project.stock = squareStock(12, 30, axis)
  return project
}

/**
 * A generated rotary model on a **square** blank is a legitimate target: the
 * rough/finish hints are clear on both axes, with either usable cutter, and
 * never say the round bar is required. Non-rotary kinds on that Around sheet
 * stay disabled (`operationCutsInProject`), and the model / tool errors are
 * still truthful.
 */
function testSquareRotaryModelHints(): void {
  const roundStockRequired = camT('cam.rotary.roundStockRequired')
  for (const axis of ['x', 'y'] as const) {
    const project = squareRotaryFixture(axis, 'rotary_rough')
    const operation = project.operations[0]
    assert(
      rotaryOperationHint(project, operation) === null,
      `${axis}: a square-blank rotary model with a ball cutter has no hint`,
    )
    assert(
      rotaryOperationHint(project, operation) !== roundStockRequired,
      `${axis}: the square blank never reports the round-stock requirement`,
    )
    for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
      assert(
        getOperationAddHint(project, selectionFor([]), kind) === null,
        `${axis}: ${kind} is offered on the square blank`,
      )
      assert(
        JSON.stringify(operationTargetFromSelection(project, selectionFor([]), kind))
          === JSON.stringify({ source: 'features', featureIds: ['model'] }),
        `${axis}: ${kind} targets the generated model`,
      )
    }

    // A flat cutter is as usable as the ball one.
    const flat = { ...project, tools: [{ ...project.tools[0], type: 'flat_endmill' as const }] }
    assert(rotaryOperationHint(flat, flat.operations[0]) === null, `${axis}: a flat cutter is usable`)

    // The model requirement is still truthful.
    const onSketch = { ...project, operations: [{ ...operation, target: { source: 'features' as const, featureIds: ['sketch'] } }] }
    assert(
      rotaryOperationHint(onSketch, onSketch.operations[0]) === camT('cam.rotary.modelOnly'),
      `${axis}: a non-model target is still refused`,
    )
    // The tool requirement is still truthful.
    const noTool = { ...project, operations: [{ ...operation, toolRef: null }] }
    assert(rotaryOperationHint(noTool, noTool.operations[0]) === camT('cam.operation.noTool'), `${axis}: a missing tool is still refused`)

    // Non-rotary operations on that Around sheet stay disabled.
    assert(
      operationCutsInProject(project, { kind: 'pocket', setupId: project.activeSetupId }) === false,
      `${axis}: a non-rotary Around operation stays disabled`,
    )
    assert(
      operationCutsInProject(project, { kind: 'rotary_rough', setupId: project.activeSetupId }) === true,
      `${axis}: the rotary model operation still cuts`,
    )

    // A block still needs a round bar: the widened check did not drop it.
    const block = { ...project, stock: { ...project.stock, shape: undefined } }
    assert(rotaryOperationHint(block, block.operations[0]) === roundStockRequired, `${axis}: a block still needs a bar`)
  }
}
testSquareRotaryModelHints()

console.log('operationValidity tests passed')
