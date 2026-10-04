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
 * Setup target rules, the Move plan and verified reach (issue #946).
 *
 * The stock is 100 × 80 × 20. Features, by where they are drawn and how far
 * they go:
 *
 * - `tray`   — Top, blind: stock Z 14 → 20
 * - `recess` — Bottom, blind: stock Z 0 → 6
 * - `pinA`   — Top, through: 0 → 20
 * - `slot`   — Bottom, through: 0 → 20
 * - `almost` — Top, stops 0.01 short of the bottom face: not through
 *
 * Run with: npx tsx src/engine/setupTargets.test.ts
 */

import { circleProfile, defaultTool, newProject, rectProfile } from '../types/project'
import type { Operation, Project, SetupFace, SketchFeature, SketchProfile } from '../types/project'
import { BOTTOM_SETUP_ID, projectWithFeatures, withBottomSetup } from '../test/projectFixtures'
import { syncProjectSetups } from '../store/helpers/setups'
import { applyOperationMove, planOperationMove } from './setupOperationMove'
import { operationCutRange, throughFeatureCoverage } from './setupReach'
import {
  crossFaceTargetIds,
  isThroughFeature,
  judgeTargetFromFace,
  operationTargetVerdicts,
  rejectedOperationTargets,
  setupGenerationBlock,
  targetAllowedInSetup,
} from './setupTargets'
import { computeOperationToolpath } from './toolpaths/generateOperation'
import { camPlanProjectFingerprint, createCamPlan } from './operations/camPlan/createCamPlan'
import { materializeCamPlan } from '../store/helpers/camPlanApply'
import type { ToolpathMove, ToolpathResult } from './toolpaths/types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label}: got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
  )
}

const TOP_SETUP_ID = 'setup-top'

function feature(
  id: string,
  kind: SketchFeature['kind'],
  profile: SketchProfile,
  zTop: number | string,
  zBottom: number | string,
  authoringFace: SetupFace,
): SketchFeature {
  return {
    id,
    name: id,
    kind,
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: zTop,
    z_bottom: zBottom,
    authoringFace,
    visible: true,
    locked: false,
  }
}

function operation(id: string, featureIds: string[], overrides: Partial<Operation> = {}): Operation {
  return {
    id,
    name: `Op ${id}`,
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: 't1',
    stepdown: 4,
    stepover: 0.4,
    feed: 600,
    plungeFeed: 180,
    rpm: 12000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    ...overrides,
  }
}

/** The fixture project with two setups; `operations` name their setup through `setupId`. */
function makeProject(operations: Operation[]): Project {
  const base = newProject('Targets', 'mm')
  base.stock = { ...base.stock, profile: rectProfile(0, 0, 100, 80), thickness: 20 }
  base.origin = { name: 'Origin', x: 0, y: 80, z: 20, visible: true }
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Flat 4', diameter: 4, maxCutDepth: 25 }]
  base.dimensions = { thickness: { id: 'thickness', name: 'thickness', value: 20, formula: null } }
  const project = projectWithFeatures(base, [
    feature('tray', 'rect', rectProfile(8, 8, 30, 20), 20, 14, 'top'),
    feature('recess', 'rect', rectProfile(55, 45, 30, 20), 6, 0, 'bottom'),
    feature('pinA', 'circle', circleProfile(20, 60, 6), 'thickness', 0, 'top'),
    feature('slot', 'rect', rectProfile(60, 10, 24, 16), 20, 0, 'bottom'),
    feature('almost', 'rect', rectProfile(40, 60, 10, 10), 20, 0.01, 'top'),
  ])
  return withBottomSetup(syncProjectSetups({ ...project, operations }), {
    operationIds: operations.filter((entry) => entry.setupId === BOTTOM_SETUP_ID).map((entry) => entry.id),
  })
}

const inBottom = { setupId: BOTTOM_SETUP_ID }

// ── Target rules ──────────────────────────────────────────────

function testThroughFeature(): void {
  console.log('Testing what counts as a through-feature...')
  const project = makeProject([])
  const through = (id: string) => isThroughFeature(project, project.features.find((entry) => entry.id === id)!)
  assert(!through('tray') && !through('recess'), 'a blind pocket is not through, from either face')
  assert(through('pinA'), 'a span given by a named dimension resolves and is through')
  assert(through('slot'), 'a Bottom-drawn through slot is through')
  assert(!through('almost'), 'a span that stops short of a face is not through')
  // Past the faces still reaches them.
  assert(isThroughFeature(project, { z_top: 21, z_bottom: -1 }), 'a span past both faces is through')
  assert(isThroughFeature(project, { z_top: 0, z_bottom: 20 }), 'a span stored bottom-first is still judged by its extent')
  assert(!isThroughFeature(project, { z_top: 'unknown', z_bottom: 0 }), 'an unresolvable span is not through')
  // Computed spans: thickness − depth can land a hair inside the face.
  assert(isThroughFeature(project, { z_top: 20 - 1e-9, z_bottom: 1e-9 }), 'rounding noise does not unmake a through-feature')
}

function testVerdicts(): void {
  console.log('Testing same-face, cross-face and rejected targets...')
  const project = makeProject([
    operation('top', ['tray', 'pinA', 'slot', 'recess', 'almost']),
    operation('bottom', ['tray', 'pinA', 'slot', 'recess', 'almost'], inBottom),
  ])
  const statuses = (id: string) => operationTargetVerdicts(project, project.operations.find((entry) => entry.id === id)!)
    .map((verdict) => `${verdict.featureId}:${verdict.status}`)

  assertEqual(statuses('top'), [
    'tray:same-face', 'pinA:same-face', 'slot:cross-face', 'recess:rejected', 'almost:same-face',
  ], 'from Top')
  assertEqual(statuses('bottom'), [
    'tray:rejected', 'pinA:cross-face', 'slot:same-face', 'recess:same-face', 'almost:rejected',
  ], 'from Bottom')

  const top = project.operations[0]
  const bottom = project.operations[1]
  assertEqual(crossFaceTargetIds(project, top), ['slot'], 'cross-face targets from Top are marked')
  assertEqual(crossFaceTargetIds(project, bottom), ['pinA'], 'cross-face targets from Bottom are marked')
  const rejected = rejectedOperationTargets(project, bottom)
  assertEqual(rejected.map((verdict) => [verdict.featureId, verdict.rejection]), [
    ['tray', 'crossFaceNotThrough'], ['almost', 'crossFaceNotThrough'],
  ], 'a rejection carries its reason')
  assert(operationTargetVerdicts(project, top).every((verdict) => (verdict.status === 'rejected') === (verdict.rejection !== null)), 'a reason exactly when rejected')

  // Depth as entered from the operation's face, alongside the verdict.
  const depth = (id: string, face: SetupFace) => judgeTargetFromFace(project, project.features.find((entry) => entry.id === id)!, face).depth
  assertEqual(depth('tray', 'top'), { start: 0, end: 6 }, 'the tray is 6 deep from Top')
  assertEqual(depth('recess', 'bottom'), { start: 0, end: 6 }, 'the recess is 6 deep from Bottom')
  assertEqual(depth('recess', 'top'), { start: 14, end: 20 }, 'and starts 14 down from Top')
  assertEqual(depth('pinA', 'bottom'), { start: 0, end: 20 }, 'a through pin is the full thickness from either face')

  console.log('Testing the store-facing questions...')
  assert(targetAllowedInSetup(project, { source: 'features', featureIds: ['tray', 'pinA', 'slot'] }, TOP_SETUP_ID), 'Top may take Top features and through-features')
  assert(!targetAllowedInSetup(project, { source: 'features', featureIds: ['pinA', 'recess'] }, TOP_SETUP_ID), 'Top may not take a blind Bottom feature')
  assert(targetAllowedInSetup(project, { source: 'features', featureIds: ['recess', 'pinA'] }, BOTTOM_SETUP_ID), 'Bottom may take Bottom features and through-features')
  assert(!targetAllowedInSetup(project, { source: 'features', featureIds: ['tray'] }, BOTTOM_SETUP_ID), 'Bottom may not take a blind Top feature')
  assert(targetAllowedInSetup(project, { source: 'stock' }, BOTTOM_SETUP_ID), 'a stock target has no face')
  assert(targetAllowedInSetup(project, { source: 'features', featureIds: ['tray'] }, undefined), 'no setup reads as Top')
  assert(!targetAllowedInSetup(project, { source: 'features', featureIds: ['recess'] }, undefined), 'no setup reads as Top, and Top refuses a blind Bottom feature')
}

function testGenerationBlock(): void {
  console.log('Testing what generation refuses...')
  const project = makeProject([
    operation('ok', ['tray', 'slot']),
    operation('bad', ['pinA', 'tray'], inBottom),
    operation('fine', ['pinA', 'recess'], inBottom),
  ])
  assert(setupGenerationBlock(project, project.operations[0]) === null, 'a valid Top operation is not blocked')
  assert(setupGenerationBlock(project, project.operations[2]) === null, 'a valid Bottom operation is not blocked')
  const block = setupGenerationBlock(project, project.operations[1])
  assert(block?.reason === 'crossFaceNotThrough', 'a blind Top feature from Bottom is blocked')
  assertEqual(block.features.map((verdict) => verdict.featureName), ['tray'], 'and only the offending feature is named')

  // An imported model is not turned with the stock.
  const definitionId = project.features[0].definitionId
  const withModel: Project = {
    ...project,
    featureDefinitions: {
      ...project.featureDefinitions,
      [definitionId]: { ...project.featureDefinitions[definitionId], kind: 'stl' },
    },
  }
  assertEqual(setupGenerationBlock(withModel, withModel.operations[2])?.reason, 'modelNotTurned', 'a turned setup refuses a project holding an imported model')
  const generated = computeOperationToolpath(withModel, withModel.operations[2])
  assertEqual(generated?.result.warnings.map((warning) => warning.code), ['setupModelNotTurned'], 'and generation says so')
  assert(generated?.result.moves.length === 0, 'with no motion')
  // …but Top is not refused for it: the block is about the turn.
  const topOnly = operation('top-only', ['slot'])
  const withTop = { ...withModel, operations: [...withModel.operations, { ...topOnly, setupId: TOP_SETUP_ID }] }
  assert(setupGenerationBlock(withTop, withTop.operations[3]) === null, 'the Top setup still generates beside a model')
}

// ── Move ──────────────────────────────────────────────────────

function testMovePlan(): void {
  console.log('Testing Move between setups...')
  const project = makeProject([
    operation('mixed', ['tray', 'pinA', 'slot']),
    operation('blind', ['tray']),
    operation('through', ['pinA']),
    operation('facing', [], { kind: 'surface_clean', target: { source: 'stock' } }),
    operation('under', ['recess', 'slot'], inBottom),
  ])

  // Tray stays behind; the pin and the slot go, the pin now cross-face.
  const mixed = planOperationMove(project, 'mixed', BOTTOM_SETUP_ID)
  assertEqual(mixed.blocked, null, 'a move that keeps a valid target goes ahead')
  assertEqual(mixed.toFace, 'bottom', 'the plan names the destination face')
  assertEqual(mixed.removed.map((verdict) => verdict.featureId), ['tray'], 'the blind Top feature is listed for removal')
  assertEqual(mixed.kept.map((verdict) => `${verdict.featureId}:${verdict.status}`), ['pinA:cross-face', 'slot:same-face'], 'kept targets are re-judged from the new face')
  assertEqual(mixed.target, { source: 'features', featureIds: ['pinA', 'slot'] }, 'the target after the move')
  assertEqual(mixed.kept[0].depth, { start: 0, end: 20 }, 'kept targets carry their depth from the new face')

  const moved = applyOperationMove(project, mixed)
  assert(moved, 'the plan applies')
  const after = moved.operations.find((entry) => entry.id === 'mixed')!
  assertEqual([after.setupId, after.target], [BOTTOM_SETUP_ID, { source: 'features', featureIds: ['pinA', 'slot'] }], 'the operation takes the setup and the planned target')
  assertEqual({ ...after, setupId: undefined, target: undefined }, { ...project.operations[0], setupId: undefined, target: undefined }, 'and nothing else about it changes')
  assert(moved.operations.filter((entry) => entry.id !== 'mixed').every((entry, index) => entry === project.operations.filter((op) => op.id !== 'mixed')[index]), 'other operations are untouched')
  assertEqual(rejectedOperationTargets(moved, after), [], 'the moved operation has no target its setup cannot reach')

  // Nothing valid would be left: blocked.
  const blind = planOperationMove(project, 'blind', BOTTOM_SETUP_ID)
  assertEqual([blind.blocked, blind.removed.map((verdict) => verdict.featureId)], ['noValidTargets', ['tray']], 'a move that would empty the target is blocked, and says what would go')
  assert(applyOperationMove(project, blind) === null, 'a blocked plan is not applied')

  // Nothing to remove: a plain move.
  const through = planOperationMove(project, 'through', BOTTOM_SETUP_ID)
  assertEqual([through.blocked, through.removed.length, through.kept[0].status], [null, 0, 'cross-face'], 'a through-feature moves and becomes cross-face')
  assert(through.target === project.operations[2].target, 'an unchanged target keeps its identity')

  const facing = planOperationMove(project, 'facing', BOTTOM_SETUP_ID)
  assertEqual([facing.blocked, facing.kept, facing.removed], [null, [], []], 'a stock-targeted operation moves freely')

  // Back the other way.
  const under = planOperationMove(project, 'under', TOP_SETUP_ID)
  assertEqual([under.blocked, under.removed.map((v) => v.featureId), under.kept.map((v) => `${v.featureId}:${v.status}`)], [null, ['recess'], ['slot:cross-face']], 'Bottom to Top drops the blind Bottom feature')

  assertEqual(planOperationMove(project, 'mixed', TOP_SETUP_ID).blocked, 'sameSetup', 'moving to its own setup is refused')
  assertEqual(planOperationMove(project, 'mixed', 'gone').blocked, 'unknownSetup', 'an unknown setup is refused')
  assertEqual(planOperationMove(project, 'gone', BOTTOM_SETUP_ID).blocked, 'unknownOperation', 'an unknown operation is refused')

  const definitionId = project.features[0].definitionId
  const withModel: Project = {
    ...project,
    featureDefinitions: { ...project.featureDefinitions, [definitionId]: { ...project.featureDefinitions[definitionId], kind: 'stl' } },
  }
  assertEqual(planOperationMove(withModel, 'through', BOTTOM_SETUP_ID).blocked, 'modelNotTurned', 'a move into a turned setup is refused beside an imported model')
  assertEqual(planOperationMove(withModel, 'under', TOP_SETUP_ID).blocked, null, 'but a move to Top is not')
}

// ── Reach ─────────────────────────────────────────────────────

function cutAt(x: number, y: number, z: number, kind: ToolpathMove['kind'] = 'cut'): ToolpathMove {
  return { kind, from: { x, y, z }, to: { x, y, z } }
}

function toolpath(operationId: string, moves: ToolpathMove[]): ToolpathResult {
  return { operationId, moves, warnings: [], bounds: null }
}

function testCutRange(): void {
  console.log('Testing the verified cut range, in stock Z...')
  const project = makeProject([
    operation('fromTop', ['pinA']),
    operation('fromBottom', ['pinA'], inBottom),
  ])
  const [fromTop, fromBottom] = project.operations
  // pinA is the circle at (20, 60), radius 6; the tool is 4 wide.
  const top = toolpath('fromTop', [
    cutAt(20, 60, 25, 'rapid'),      // clearance: not a cut
    cutAt(20, 60, 22, 'plunge'),     // still above the top face
    cutAt(20, 60, 12, 'plunge'),
    cutAt(22, 60, 8),
    cutAt(90, 10, 1),                // deeper, but at another feature
    cutAt(20, 60, 2, 'rapid'),       // a rapid is never a cut
  ])
  assertEqual(operationCutRange(project, fromTop, top, 'pinA'), { min: 8, max: 20 }, 'from Top: the deepest tip position at the feature, up to the top face')

  const bottom = toolpath('fromBottom', [
    cutAt(20, 60, -5, 'rapid'),
    cutAt(20, 60, -1, 'plunge'),     // still under the bottom face
    cutAt(20, 60, 5, 'plunge'),
    cutAt(18, 62, 9),
    cutAt(90, 10, 19),
  ])
  assertEqual(operationCutRange(project, fromBottom, bottom, 'pinA'), { min: 0, max: 9 }, 'from Bottom: the bottom face up to the highest tip position')

  // One tool diameter of margin around the outline, no more.
  assertEqual(operationCutRange(project, fromTop, toolpath('fromTop', [cutAt(30, 60, 3)]), 'pinA'), { min: 3, max: 20 }, 'a cut one diameter outside the outline still counts')
  assert(operationCutRange(project, fromTop, toolpath('fromTop', [cutAt(30.5, 60, 3)]), 'pinA') === null, 'a cut beyond that does not')
  assert(operationCutRange(project, fromTop, toolpath('fromTop', []), 'pinA') === null, 'no moves: nothing is cut')
  // A feed move that never enters the stock cuts nothing.
  assert(operationCutRange(project, fromTop, toolpath('fromTop', [cutAt(20, 60, 22, 'plunge'), cutAt(20, 60, 20)]), 'pinA') === null, 'from Top: motion at or above the top face is air')
  assert(operationCutRange(project, fromBottom, toolpath('fromBottom', [cutAt(20, 60, -1, 'plunge'), cutAt(20, 60, 0)]), 'pinA') === null, 'from Bottom: motion at or under the bottom face is air')
  assert(operationCutRange(project, fromTop, top, 'gone') === null, 'an unknown feature: nothing is cut')
  assertEqual(operationCutRange(project, fromTop, toolpath('fromTop', [cutAt(20, 60, -2)]), 'pinA'), { min: 0, max: 20 }, 'a cut past the far face is the whole thickness, not more')
}

function testThroughCoverage(): void {
  console.log('Testing a through-feature cut from both sides...')
  const project = makeProject([
    operation('fromTop', ['pinA']),
    operation('fromBottom', ['pinA'], inBottom),
    operation('disabled', ['pinA'], { ...inBottom, enabled: false }),
    operation('trayOnly', ['tray']),
  ])
  const coverage = (topZ: number | null, bottomZ: number | null) => {
    const paths = new Map<string, ToolpathResult>()
    if (topZ !== null) paths.set('fromTop', toolpath('fromTop', [cutAt(20, 60, topZ)]))
    if (bottomZ !== null) paths.set('fromBottom', toolpath('fromBottom', [cutAt(20, 60, bottomZ)]))
    // Would close any gap if a disabled operation were counted.
    paths.set('disabled', toolpath('disabled', [cutAt(20, 60, 20)]))
    return throughFeatureCoverage(project, 'pinA', paths)
  }

  const overlap = coverage(8, 9)
  assertEqual([overlap?.status, overlap?.overlap, overlap?.gap], ['meets', 1, null], 'Top down to 8 and Bottom up to 9 overlap by 1')
  assertEqual([overlap?.top, overlap?.bottom], [
    { operationIds: ['fromTop'], range: { min: 8, max: 20 } },
    { operationIds: ['fromBottom'], range: { min: 0, max: 9 } },
  ], 'each side reports its operations and range; a disabled operation is not among them')

  const touching = coverage(10, 10)
  assertEqual([touching?.status, touching?.overlap], ['meets', 0], 'ranges that just touch meet')

  const short = coverage(12, 9)
  assertEqual([short?.status, short?.gap, short?.overlap], ['gap', 3, null], 'Top down to 12 and Bottom up to 9 leave 3')
  assertEqual(coverage(10.001, 10)?.status, 'gap', 'a thousandth short is a gap, not complete')

  // Never complete without a measurement for every operation involved.
  assertEqual(coverage(8, null)?.status, 'unverified', 'no Bottom toolpath: unverified')
  assertEqual(coverage(null, 9)?.status, 'unverified', 'no Top toolpath: unverified')
  assertEqual(coverage(null, null)?.status, 'unverified', 'no toolpaths: unverified')

  // A measured side that cuts nothing there reaches nothing.
  const idle = throughFeatureCoverage(project, 'pinA', new Map([
    ['fromTop', toolpath('fromTop', [cutAt(20, 60, 8)])],
    ['fromBottom', toolpath('fromBottom', [])],
  ]))
  assertEqual([idle?.status, idle?.gap, idle?.bottom.range], ['gap', 8, null], 'a side that cuts nothing leaves everything the other side did not cut')

  // One face only: nothing to compare.
  const oneSide = makeProject([operation('fromTop', ['pinA'])])
  assertEqual(throughFeatureCoverage(oneSide, 'pinA', new Map())?.status, 'singleSide', 'targeted from one face only')
  const onlyDisabledOther = makeProject([operation('fromTop', ['pinA']), operation('off', ['pinA'], { ...inBottom, enabled: false })])
  assertEqual(throughFeatureCoverage(onlyDisabledOther, 'pinA', new Map())?.status, 'singleSide', 'a disabled operation does not make it two-sided')

  assert(throughFeatureCoverage(project, 'tray', new Map()) === null, 'a blind feature has no through coverage')
  assert(throughFeatureCoverage(project, 'slot', new Map()) === null, 'an untargeted feature has none either')

  // Several operations on a side: the furthest reach counts.
  const two = makeProject([
    operation('rough', ['pinA']),
    operation('finish', ['pinA']),
    operation('fromBottom', ['pinA'], inBottom),
  ])
  const combined = throughFeatureCoverage(two, 'pinA', new Map([
    ['rough', toolpath('rough', [cutAt(20, 60, 13)])],
    ['finish', toolpath('finish', [cutAt(20, 60, 9)])],
    ['fromBottom', toolpath('fromBottom', [cutAt(20, 60, 9.5)])],
  ]))
  assertEqual([combined?.status, combined?.top.range, combined?.overlap], ['meets', { min: 9, max: 20 }, 0.5], 'the deepest of a side\'s operations is its reach')
  const oneMissing = throughFeatureCoverage(two, 'pinA', new Map([
    ['finish', toolpath('finish', [cutAt(20, 60, 2)])],
    ['fromBottom', toolpath('fromBottom', [cutAt(20, 60, 9.5)])],
  ]))
  assertEqual(oneMissing?.status, 'unverified', 'one unmeasured operation on a side leaves the feature unverified')
}

function testCoverageFromGeneratedToolpaths(): void {
  console.log('Testing coverage against real generated toolpaths...')
  // The pin cut half-way from each side: 11 from Top leaves 9, 11 from Bottom overlaps by 2.
  const build = (topLeave: number, bottomLeave: number) => makeProject([
    operation('fromTop', ['pinA'], { stockToLeaveAxial: topLeave }),
    operation('fromBottom', ['pinA'], { ...inBottom, stockToLeaveAxial: bottomLeave }),
  ])
  const measure = (project: Project) => {
    const paths = new Map<string, ToolpathResult>()
    for (const entry of project.operations) {
      const generated = computeOperationToolpath(project, entry)
      assert(generated && generated.result.moves.length > 0, `fixture: ${entry.id} generates`)
      paths.set(entry.id, generated.result)
    }
    return throughFeatureCoverage(project, 'pinA', paths)
  }

  const meeting = measure(build(9, 9))
  assertEqual([meeting?.status, meeting?.top.range, meeting?.bottom.range], ['meets', { min: 9, max: 20 }, { min: 0, max: 11 }], 'Top to stock Z 9 and Bottom to stock Z 11 overlap')
  assert(meeting?.overlap !== null && Math.abs(meeting!.overlap! - 2) < 1e-9, 'by 2')

  // 12 left on each side: Top stops at stock Z 12, Bottom at stock Z 8.
  const apart = measure(build(12, 12))
  assertEqual([apart?.status, apart?.top.range, apart?.bottom.range], ['gap', { min: 12, max: 20 }, { min: 0, max: 8 }], 'Top to stock Z 12 and Bottom to stock Z 8 do not meet')
  assert(apart?.gap !== null && Math.abs(apart!.gap! - 4) < 1e-9, 'they leave 4')
}

// ── CAM Plan ──────────────────────────────────────────────────

function testCamPlanFollowsTheActiveSetup(): void {
  console.log('Testing CAM Plan proposes only what the active setup may cut...')
  const project = makeProject([])
  const targeted = (plan: ReturnType<typeof createCamPlan>) => new Set(plan.operations.flatMap((draft) => (
    draft.operation.target.source === 'features' ? draft.operation.target.featureIds : []
  )))

  const TURNED = /Top setup only/
  /** The plan with only its creatable proposals enabled (a 4 mm cutter does not fit every proposal). */
  const creatable = (plan: ReturnType<typeof createCamPlan>) => ({
    ...plan,
    operations: plan.operations.map((draft) => ({ ...draft, enabled: draft.hardError === null })),
  })

  // Top is active: the blind Bottom recess is not planned; through-features are.
  const onTop = createCamPlan(project, [])
  const topTargets = targeted(onTop)
  assert(topTargets.has('tray') && topTargets.has('pinA') && topTargets.has('slot'), `Top plans its own features and through-features: ${[...topTargets].join(', ')}`)
  assert(!topTargets.has('recess'), 'Top does not plan a blind Bottom feature')
  assert(onTop.operations.every((draft) => !TURNED.test(draft.hardError ?? '')), 'no Top proposal is refused for its setup')
  assert(onTop.operations.some((draft) => draft.hardError === null), 'fixture: some Top proposal can be created')
  const applied = materializeCamPlan(project, creatable(onTop))
  assert(applied.ok, 'and the Top plan applies')
  assert(applied.operationIds.length > 0, 'creating operations')
  assert(applied.project.operations.every((operation) => rejectedOperationTargets(applied.project, operation).length === 0), 'every one of which its setup can cut')

  // Bottom is active: nothing can be created, and each proposal says why.
  const bottomActive: Project = { ...project, activeSetupId: BOTTOM_SETUP_ID }
  const onBottom = createCamPlan(bottomActive, [])
  const bottomTargets = targeted(onBottom)
  assert(bottomTargets.has('recess') && !bottomTargets.has('tray'), `Bottom plans its own features, not a blind Top one: ${[...bottomTargets].join(', ')}`)
  assert(onBottom.operations.every((draft) => draft.hardError !== null), 'no Bottom proposal can be created')
  assert(onBottom.operations.some((draft) => TURNED.test(draft.hardError ?? '')), 'and the reason is the setup')
  assert(creatable(onBottom).operations.every((draft) => !draft.enabled), 'so nothing is left to apply')

  // A plan belongs to the setup it was made for.
  assert(camPlanProjectFingerprint(project) !== camPlanProjectFingerprint(bottomActive), 'switching setups makes a plan stale')
  const stale = materializeCamPlan(bottomActive, onTop)
  assert(!stale.ok && stale.reason === 'stale', 'a Top plan is not applied to the Bottom setup')
  const turnedAxis: Project = { ...project, setups: project.setups.map((setup) => (setup.id === BOTTOM_SETUP_ID ? { ...setup, orientation: { axis: 'y', angleDeg: 180 } } : setup)) }
  assert(camPlanProjectFingerprint(project) === camPlanProjectFingerprint(turnedAxis), 'another setup\'s turn does not')

  // Even a hand-edited draft cannot put an unreachable target in the active setup.
  const [first] = onTop.operations
  const tampered = {
    ...onTop,
    operations: [{ ...first, operation: { ...first.operation, kind: 'pocket' as const, target: { source: 'features' as const, featureIds: ['recess'] } } }],
  }
  assert(!materializeCamPlan(project, tampered).ok, 'a draft targeting the other face is refused when the plan is applied')
}

testThroughFeature()
testCamPlanFollowsTheActiveSetup()
testVerdicts()
testGenerationBlock()
testMovePlan()
testCutRange()
testThroughCoverage()
testCoverageFromGeneratedToolpaths()

console.log('setup target tests passed')
