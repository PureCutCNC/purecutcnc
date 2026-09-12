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

import type { ToolLibraryEntry } from '../../../toolLibrary'
import { circleProfile, newProject, rectProfile, type Project, type SketchFeature, type SketchProfile, type Tool } from '../../../types/project'
import { projectWithFeatures } from '../../../test/projectFixtures'
import { materializeCamPlan } from '../../../store/helpers/camPlanApply'
import { convertProjectUnits } from '../../../utils/units'
import { resolvePocketRegions } from '../../toolpaths/resolver'
import { createCamPlan } from './createCamPlan'
import { reconcileCamPlanDownstream, reconcileCamPlanRest } from './reconcileRest'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function tool(id: string, type: Tool['type'], diameter: number): Tool {
  return {
    id,
    name: id,
    units: 'inch',
    type,
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

function libraryTool(key: string, source: Tool): ToolLibraryEntry {
  const { id: _id, ...entry } = source
  return { ...entry, key }
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

function exampleProject(): Project {
  const base = newProject('CAM plan POC', 'inch')
  base.stock.thickness = 1
  return projectWithFeatures({
    ...base,
    tools: [
      tool('three-quarter', 'flat_endmill', 0.75),
      tool('quarter', 'flat_endmill', 0.25),
      tool('eighth', 'flat_endmill', 0.125),
      tool('sixteenth', 'flat_endmill', 0.0625),
      tool('quarter-drill', 'drill', 0.25),
    ],
  }, [
    feature('outer', 'add', rectProfile(0, 0, 2, 2), 0.75, 0),
    feature('raised', 'add', rectProfile(0.3, 0.3, 0.5, 0.5), 0.9, 0.75),
    feature('blind', 'subtract', rectProfile(1.1, 0.3, 0.45, 0.45), 1, 0.45),
    feature('through', 'subtract', rectProfile(0.35, 1.15, 0.5, 0.45), 1, 0),
    feature('drillable', 'subtract', circleProfile(1.45, 1.45, 0.125), 1, 0, 'circle'),
  ])
}

function testRepresentativePlan(): void {
  const project = exampleProject()
  const plan = createCamPlan(project, [])
  const kinds = plan.operations.map((draft) => draft.operation.kind)
  assert(kinds.includes('surface_clean'), 'lowered add surface produces surface clean')
  assert(kinds.includes('pocket'), 'blind subtract produces pocket')
  assert(kinds.includes('edge_route_inside'), 'through subtract produces inside edge route')
  assert(kinds.includes('drilling'), 'matching circular subtract produces drilling')
  assert(kinds.includes('edge_route_outside'), 'outer add produces outside edge route')
  assert(
    !plan.operations.some((draft) => draft.operation.kind === 'pocket' && draft.coveredFeatureIds.includes('drillable')),
    'drillable circle is not pocketed as well',
  )
  const outside = plan.operations.filter((draft) => draft.operation.kind === 'edge_route_outside')
  assert(outside.length >= 2, 'outside route has rough and finish passes')
  assert(outside.every((draft) => draft.operation.toolRef !== 'three-quarter'), '3/4 inch tool is rejected for 2 inch outside profile')
  assert(plan.sharedTabs.length === 2, 'inside and outside targets each receive one shared tab setup')
  assert(plan.sharedTabs.every((tabs) => tabs.operationKeys.length >= 2), 'tab setup is shared by rough and finish operations')
  assert(plan.coverage.every((coverage) => coverage.status !== 'unsupported'), 'representative features are all explained')
}

function testMatchingHolesShareOneDrillingOperation(): void {
  const base = newProject('CAM plan drill grouping', 'inch')
  base.stock.thickness = 1
  const project = projectWithFeatures({
    ...base,
    tools: [
      tool('quarter-drill', 'drill', 0.25),
      tool('eighth-drill', 'drill', 0.125),
    ],
  }, [
    feature('quarter-one', 'subtract', circleProfile(0.5, 0.5, 0.125), 1, 0, 'circle'),
    feature('quarter-two', 'subtract', circleProfile(1.5, 0.5, 0.125), 1, 0, 'circle'),
    feature('quarter-shallow', 'subtract', circleProfile(2.5, 0.5, 0.125), 1, 0.5, 'circle'),
    feature('eighth', 'subtract', circleProfile(3.5, 0.5, 0.0625), 1, 0, 'circle'),
  ])
  const drills = createCamPlan(project, []).operations.filter((draft) => draft.operation.kind === 'drilling')
  assert(drills.length === 3, 'different hole diameters or Z spans remain separate drilling operations')
  assert(
    drills.some((draft) => draft.operation.target.source === 'features' && draft.operation.target.featureIds.join() === 'quarter-one,quarter-two'),
    'same-diameter holes with the same Z span share one drilling operation',
  )
  assert(
    drills.some((draft) => draft.operation.target.source === 'features' && draft.operation.target.featureIds.join() === 'quarter-shallow'),
    'a same-diameter hole at a different depth remains independent',
  )
}

function testCompatiblePocketsShareOneOperationAcrossDepths(): void {
  const base = newProject('CAM plan pocket grouping', 'inch')
  base.stock.thickness = 1
  const project = projectWithFeatures({
    ...base,
    tools: [tool('three-eighth', 'flat_endmill', 0.375), tool('eighth', 'flat_endmill', 0.125)],
  }, [
    feature('deep-pocket', 'subtract', rectProfile(0, 0, 2, 2), 1, 0.25),
    feature('shallow-pocket', 'subtract', rectProfile(3, 0, 2, 2), 1, 0.5),
  ])
  const pockets = createCamPlan(project, []).operations.filter((draft) =>
    draft.operation.kind === 'pocket' && !draft.rest,
  )
  const rough = pockets.find((draft) => draft.operation.pass === 'rough')
  const finish = pockets.find((draft) => draft.operation.pass === 'finish')
  assert(pockets.length === 2, 'compatible blind pockets share one rough/finish pair despite different depths')
  assert(rough?.operation.toolRef === 'three-eighth', 'the grouped rough pocket keeps its common selected tool')
  assert(
    rough?.operation.target.source === 'features' && rough.operation.target.featureIds.join() === 'deep-pocket,shallow-pocket',
    'one rough pocket operation carries both direct targets',
  )
  assert(
    finish?.operation.target.source === 'features' && finish.operation.target.featureIds.join() === 'deep-pocket,shallow-pocket',
    'one finish pocket operation carries both direct targets',
  )
  assert(rough?.targetLabel.includes('multiple depths'), 'the grouped target label does not falsely claim one shared depth')
}

function testCompatibleOutsideProfilesShareOneOperation(): void {
  const base = newProject('CAM plan outside grouping', 'inch')
  base.stock.thickness = 1
  const project = projectWithFeatures({
    ...base,
    tools: [tool('quarter', 'flat_endmill', 0.25), tool('eighth', 'flat_endmill', 0.125)],
  }, [
    feature('outer-left', 'add', rectProfile(0, 0, 2, 2), 1, 0),
    feature('left-pocket', 'subtract', rectProfile(0.5, 0.5, 1, 1), 1, 0.5),
    feature('outer-right', 'add', rectProfile(3, 0, 2, 2), 1, 0),
  ])
  const plan = createCamPlan(project, [])
  const outside = plan.operations.filter((draft) => draft.operation.kind === 'edge_route_outside' && !draft.rest)
  const rough = outside.find((draft) => draft.operation.pass === 'rough')
  const finish = outside.find((draft) => draft.operation.pass === 'finish')
  const outsideTargets = 'outer-left,outer-right'

  assert(outside.length === 2, 'compatible outside profiles share one rough/finish pair')
  assert(
    rough?.operation.target.source === 'features' && rough.operation.target.featureIds.join() === outsideTargets,
    'the grouped outside rough operation carries both outer targets',
  )
  assert(
    finish?.operation.target.source === 'features' && finish.operation.target.featureIds.join() === outsideTargets,
    'the grouped outside finish operation carries both outer targets',
  )
  assert(
    rough?.operation.toolRef !== null && rough?.operation.toolRef === finish?.operation.toolRef,
    'the pair keeps the common selected cutter',
  )
  assert(
    rough && plan.operations.findIndex((draft) => draft.key === rough.key) > plan.operations.findLastIndex((draft) => draft.operation.kind !== 'edge_route_outside'),
    'internal work remains ordered before the grouped outside rough pass',
  )
  assert(plan.sharedTabs.length === 1, 'the grouped outside pair receives one shared tab proposal')
  assert(plan.sharedTabs[0]?.targetFeatureIds.join() === outsideTargets, 'shared tabs span both outside targets')
  assert(
    plan.sharedTabs[0]?.operationKeys.join() === `${rough?.key},${finish?.key}`,
    'the shared tab proposal is referenced by the grouped rough and finish operations',
  )
}

function testOutsideProfilesWithDifferentToolsStaySeparate(): void {
  const base = newProject('CAM plan outside tool grouping', 'inch')
  base.stock.thickness = 1
  const project = projectWithFeatures({
    ...base,
    tools: [tool('three-eighth', 'flat_endmill', 0.375), tool('eighth', 'flat_endmill', 0.125)],
  }, [
    feature('large-outer', 'add', rectProfile(0, 0, 4, 4), 1, 0),
    feature('small-outer', 'add', rectProfile(5, 0, 1, 1), 1, 0),
  ])
  const rough = createCamPlan(project, []).operations.filter((draft) =>
    draft.operation.kind === 'edge_route_outside' && draft.operation.pass === 'rough' && !draft.rest,
  )

  assert(rough.length === 2, 'outside profiles that select different cutters remain separate rough operations')
  assert(
    rough.some((draft) => draft.operation.toolRef === 'three-eighth' && draft.coveredFeatureIds.join() === 'large-outer'),
    'the large outside profile keeps its larger selected cutter',
  )
  assert(
    rough.some((draft) => draft.operation.toolRef === 'eighth' && draft.coveredFeatureIds.join() === 'small-outer'),
    'the smaller outside profile stays with its smaller selected cutter',
  )
}

function testExistingOperationsOnlySuppressExactRecommendations(): void {
  const base = newProject('CAM plan existing operations', 'inch')
  base.stock.thickness = 1
  const project = projectWithFeatures({
    ...base,
    tools: [tool('quarter', 'flat_endmill', 0.25), tool('eighth', 'flat_endmill', 0.125)],
  }, [feature('pocket', 'subtract', rectProfile(0, 0, 2, 2), 1, 0.5)])
  const initial = createCamPlan(project, [])
  const rough = initial.operations.find((draft) => draft.operation.kind === 'pocket' && draft.operation.pass === 'rough' && !draft.rest)
  assert(rough, 'initial plan includes a pocket roughing operation')
  const withExistingRough = { ...project, operations: [rough.operation] }
  const replanned = createCamPlan(withExistingRough, [])
  assert(
    !replanned.operations.some((draft) => draft.operation.kind === 'pocket' && draft.operation.pass === 'rough' && !draft.rest),
    'an existing matching rough operation is not proposed again',
  )
  assert(
    replanned.operations.some((draft) => draft.operation.kind === 'pocket' && draft.operation.pass === 'finish' && !draft.rest),
    'an existing rough operation does not suppress the missing finish recommendation',
  )
}

function testDeterministicAndAtomicApply(): void {
  const project = exampleProject()
  const first = createCamPlan(project, [])
  const second = createCamPlan(project, [])
  assert(JSON.stringify(first) === JSON.stringify(second), 'same project produces the same plan')
  const result = materializeCamPlan(project, first)
  assert(result.ok, 'valid plan materializes')
  assert(result.operationIds.length === first.operations.filter((draft) => draft.enabled).length, 'all enabled operations are created')
  if (!result.ok) return
  assert(result.project.tabs.length > 0, 'shared tab drafts are created once')
  assert(result.project.operations.length === result.operationIds.length, 'operations are appended together')
  const replanned = createCamPlan(result.project, [])
  assert(replanned.operations.length === 0, 'enabled existing operations prevent duplicate recommendations')
  assert(replanned.coverage.some((entry) => entry.featureId === 'outer' && entry.status === 'existing'), 'existing coverage is visible in the next plan')
  const stale = materializeCamPlan({ ...project, meta: { ...project.meta, modified: 'changed' } }, first)
  assert(!stale.ok && stale.reason === 'stale', 'changed project rejects stale plan')
}

function testDepthRolesAndUnsupportedCoverage(): void {
  const base = newProject('CAM plan roles', 'inch')
  base.stock.thickness = 1
  const project = projectWithFeatures({ ...base, tools: [tool('quarter', 'flat_endmill', 0.25)] }, [
    feature('stock-top', 'add', rectProfile(0, 0, 2, 2), 1, 0),
    feature('region', 'region', rectProfile(0.2, 0.2, 0.3, 0.3), 1, 0),
    feature('construction', 'construction', rectProfile(0.6, 0.2, 0.3, 0.3), 1, 0),
    feature('line', 'line', rectProfile(1, 0.2, 0.3, 0.3), 1, 0),
  ])
  const plan = createCamPlan(project, [])
  assert(!plan.operations.some((draft) => draft.operation.kind === 'surface_clean'), 'add at stock top does not produce redundant surface cleaning')
  assert(!plan.operations.some((draft) => draft.coveredFeatureIds.some((id) => id === 'region' || id === 'construction')), 'regions and construction are never standalone targets')
  assert(plan.coverage.some((entry) => entry.featureId === 'line' && entry.status === 'unsupported'), 'deferred line intent stays visibly unsupported')
}

function testRetainedIslandsDoNotNeedCoverageAcknowledgement(): void {
  const base = newProject('CAM plan retained island', 'inch')
  base.stock.thickness = 1
  const project = projectWithFeatures({ ...base, tools: [tool('quarter', 'flat_endmill', 0.25), tool('eighth', 'flat_endmill', 0.125)] }, [
    feature('outer', 'add', rectProfile(0, 0, 2, 2), 1, 0),
    feature('pocket', 'subtract', rectProfile(0.25, 0.25, 1.5, 1.5), 1, 0.5),
    feature('island', 'add', circleProfile(1, 1, 0.2), 1, 0.5, 'circle'),
  ])
  const plan = createCamPlan(project, [])
  const pocket = plan.operations.find((draft) => draft.operation.kind === 'pocket' && draft.operation.pass === 'rough')
  assert(pocket, 'pocket roughing operation exists')
  const resolved = resolvePocketRegions(project, pocket.operation)
  assert(resolved.bands.some((band) => band.islandFeatureIds.includes('island')), 'pocket resolver includes the retained circle as an island')
  const islandCoverage = plan.coverage.find((entry) => entry.featureId === 'island')
  assert(islandCoverage?.status === 'not_needed', 'resolver-accounted island is not reported as uncovered work')
  assert(islandCoverage.detail.includes('island'), 'coverage explains that the retained island informs the cut')
}

function testSurfaceCleanOnlyTargetsLoweredOuterMaterial(): void {
  const base = newProject('CAM plan lowered outer material', 'inch')
  base.stock.thickness = 1
  const project = projectWithFeatures({ ...base, tools: [tool('quarter', 'flat_endmill', 0.25), tool('eighth', 'flat_endmill', 0.125)] }, [
    feature('outer', 'add', rectProfile(0, 0, 4, 3), 0.75, 0),
    feature('pocket', 'subtract', rectProfile(0.25, 0.25, 3.5, 2.5), 0.75, 0.5),
    feature('island', 'add', rectProfile(1.25, 1, 1, 0.75), 0.75, 0.5),
  ])
  const plan = createCamPlan(project, [])
  const surfaceRough = plan.operations.find((draft) =>
    draft.operation.kind === 'surface_clean' && draft.operation.pass === 'rough',
  )
  const surfaceFinish = plan.operations.find((draft) =>
    draft.operation.kind === 'surface_clean' && draft.operation.pass === 'finish',
  )
  assert(surfaceRough?.operation.target.source === 'features' && surfaceRough.operation.target.featureIds.join() === 'outer', 'only the lowered outer Add receives surface cleaning')
  assert(surfaceRough.operation.stockToLeaveRadial === 0.005, 'surface-clean rough leaves radial finishing stock')
  assert(surfaceRough.operation.stockToLeaveAxial === 0.005, 'surface-clean rough leaves axial finishing stock')
  assert(surfaceFinish?.operation.target.source === 'features' && surfaceFinish.operation.target.featureIds.join() === 'outer', 'surface-clean finish shares the outer target')
  assert(surfaceFinish.operation.stockToLeaveRadial === 0, 'surface-clean finish removes radial finishing stock')
  assert(surfaceFinish.operation.stockToLeaveAxial === 0, 'surface-clean finish removes axial finishing stock')
  assert(!plan.operations.some((draft) => draft.operation.kind === 'surface_clean' && draft.coveredFeatureIds.includes('island')), 'the retained pocket island does not receive a separate surface-clean operation')
  const pocket = plan.operations.find((draft) => draft.operation.kind === 'pocket' && draft.operation.pass === 'rough')
  assert(pocket && resolvePocketRegions(project, pocket.operation).bands.some((band) => band.islandFeatureIds.includes('island')), 'the pocket resolver owns the lowered island')
  assert(plan.coverage.find((entry) => entry.featureId === 'island')?.status === 'not_needed', 'the island remains visibly accounted for by the pocket')
}

function testNestedSubtractsStayWithTheirParentPocket(): void {
  const base = newProject('CAM plan overlapping pockets', 'inch')
  base.stock.thickness = 1
  const project = projectWithFeatures({
    ...base,
    tools: [tool('quarter', 'flat_endmill', 0.25), tool('eighth', 'flat_endmill', 0.125)],
  }, [
    feature('outer', 'add', rectProfile(0, 0, 4.5, 2), 1, 0),
    feature('parent-pocket', 'subtract', rectProfile(0.25, 0.25, 3.75, 1.5), 1, 0.5),
    feature('nested-pocket', 'subtract', rectProfile(1.5, 0.75, 1, 0.75), 1, 0.25),
    feature('through-cutout', 'subtract', rectProfile(3.25, 0.75, 0.5, 0.5), 1, 0),
  ])
  const plan = createCamPlan(project, [])
  const roughPockets = plan.operations.filter((draft) =>
    draft.operation.kind === 'pocket' && draft.operation.pass === 'rough' && !draft.rest,
  )
  assert(roughPockets.length === 1, 'the surrounding blind pocket owns its nested subtract without a duplicate pocket operation')
  assert(
    roughPockets[0]?.operation.target.source === 'features' && roughPockets[0].operation.target.featureIds.join() === 'parent-pocket',
    'only the parent pocket is a direct target',
  )
  const parentPocket = roughPockets[0]
  assert(
    parentPocket && resolvePocketRegions(project, parentPocket.operation).bands.some((band) => band.targetFeatureIds.includes('nested-pocket')),
    'the parent resolver includes the nested blind subtract at its deeper level',
  )
  const nestedCoverage = plan.coverage.find((entry) => entry.featureId === 'nested-pocket')
  assert(
    nestedCoverage?.status === 'not_needed' && nestedCoverage.detail.includes('surrounding pocket'),
    'nested blind subtract coverage explains that the parent pocket machines it',
  )
  assert(
    plan.operations.some((draft) => (
      draft.operation.kind === 'edge_route_inside'
      && draft.operation.pass === 'rough'
      && draft.operation.target.source === 'features'
      && draft.operation.target.featureIds.join() === 'through-cutout'
    )),
    'a nested through subtract remains a direct inside-edge cutout target',
  )
}

function testEdgeSharingSubtractChainsStayWithTheirParentPocket(): void {
  const base = newProject('CAM plan edge-sharing pocket chain', 'inch')
  base.stock.thickness = 1
  const project = projectWithFeatures({
    ...base,
    tools: [tool('quarter', 'flat_endmill', 0.25), tool('eighth', 'flat_endmill', 0.125)],
  }, [
    feature('outer', 'add', rectProfile(0, 0, 5, 2.5), 1, 0),
    feature('parent-pocket', 'subtract', rectProfile(0.25, 0.25, 2, 1.5), 1, 0.5),
    feature('edge-linked-pocket', 'subtract', rectProfile(2.25, 0.75, 1, 0.75), 1, 0.35),
    feature('chain-linked-pocket', 'subtract', rectProfile(3.25, 1, 0.75, 0.5), 1, 0.2),
  ])
  const plan = createCamPlan(project, [])
  const roughPockets = plan.operations.filter((draft) => (
    draft.operation.kind === 'pocket' && draft.operation.pass === 'rough' && !draft.rest
  ))

  assert(roughPockets.length === 1, 'edge-sharing subtracts stay with the parent instead of receiving pocket operations')
  assert(
    roughPockets[0]?.operation.target.source === 'features' && roughPockets[0].operation.target.featureIds.join() === 'parent-pocket',
    'only the parent pocket remains a direct target when subtracts share its edge or its chain',
  )

  const parentPocket = roughPockets[0]
  const resolvedIds = parentPocket
    ? new Set(resolvePocketRegions(project, parentPocket.operation).bands.flatMap((band) => band.targetFeatureIds))
    : new Set<string>()
  assert(resolvedIds.has('edge-linked-pocket'), 'the resolver folds the partial shared-edge subtract into the parent pocket')
  assert(resolvedIds.has('chain-linked-pocket'), 'the resolver follows the shared-edge subtract chain into the parent pocket')

  for (const featureId of ['edge-linked-pocket', 'chain-linked-pocket']) {
    const coverage = plan.coverage.find((entry) => entry.featureId === featureId)
    assert(
      coverage?.status === 'not_needed' && coverage.detail.includes('surrounding pocket'),
      `${featureId} coverage explains that the parent pocket machines it`,
    )
  }
}

function testConnectedPocketsShareOneOperationWhenTheResolverOwnershipIsDirectional(): void {
  const base = newProject('CAM plan connected pockets', 'inch')
  base.stock.thickness = 0.75
  const project = projectWithFeatures({
    ...base,
    tools: [tool('three-quarter', 'flat_endmill', 0.75), tool('quarter', 'flat_endmill', 0.25)],
  }, [
    feature('outer', 'add', rectProfile(0.25, 0.25, 3.5, 2.5), 0.75, 0),
    feature('parent-pocket', 'subtract', rectProfile(0.5, 0.5, 2, 2), 0.75, 0.42),
    feature('edge-pocket', 'subtract', rectProfile(2.5, 2, 0.75, 0.5), 0.75, 0.55),
    feature('overlap-pocket', 'subtract', rectProfile(1.875, 1, 1.125, 0.75), 0.75, 0.36),
  ])
  const plan = createCamPlan(project, [])
  const roughPockets = plan.operations.filter((draft) => (
    draft.operation.kind === 'pocket' && draft.operation.pass === 'rough' && !draft.rest
  ))

  assert(roughPockets.length === 1, 'a partial shared-edge pocket does not create a second rough/finish pair')
  assert(
    roughPockets[0]?.operation.target.source === 'features'
      && roughPockets[0].operation.target.featureIds.join() === 'parent-pocket,edge-pocket',
    'the connected pocket is attached to the parent operation target when resolver ownership is directional',
  )
  assert(roughPockets[0]?.operation.toolRef === 'quarter', 'the shared operation keeps the parent cutter that physically fits both pockets')
  assert(
    plan.coverage.find((entry) => entry.featureId === 'edge-pocket')?.status === 'planned',
    'the edge-connected pocket is visibly covered by the shared recommendation',
  )
  assert(
    plan.coverage.find((entry) => entry.featureId === 'overlap-pocket')?.status === 'not_needed',
    'the overlapping subtract remains resolver-owned rather than becoming another direct target',
  )
}

function testFixtureScaleAndFinishAllowances(): void {
  const base = newProject('CAM plan fixture scale', 'inch')
  base.stock.thickness = 0.75
  const project = projectWithFeatures({
    ...base,
    tools: [
      tool('three-quarter', 'flat_endmill', 0.75),
      tool('half', 'flat_endmill', 0.5),
      tool('three-eighth', 'flat_endmill', 0.375),
      tool('quarter', 'flat_endmill', 0.25),
      tool('eighth', 'flat_endmill', 0.125),
    ],
  }, [
    feature('outer', 'add', rectProfile(0.25, 0.25, 3.5, 2.5), 0.75, 0),
    feature('pocket', 'subtract', rectProfile(0.5, 0.5, 3, 2), 0.75, 0.55),
    feature('island-top', 'add', circleProfile(2, 1.625, 0.4506939094329985), 0.75, 0, 'circle'),
    feature('island-right', 'add', circleProfile(2.375, 1.375, 0.3535533905932738), 0.75, 0, 'circle'),
    feature('island-left', 'add', circleProfile(1.625, 1.375, 0.3952847075210474), 0.75, 0, 'circle'),
  ])
  const plan = createCamPlan(project, [])
  const pocket = plan.operations.filter((draft) =>
    draft.operation.kind === 'pocket' && draft.coveredFeatureIds.includes('pocket'),
  )
  const outside = plan.operations.filter((draft) =>
    draft.operation.kind === 'edge_route_outside' && draft.coveredFeatureIds.includes('outer'),
  )
  const pocketRough = pocket.find((draft) => draft.operation.pass === 'rough' && !draft.rest)
  const pocketRest = pocket.find((draft) => draft.rest)
  const pocketFinish = pocket.find((draft) => draft.operation.pass === 'finish' && !draft.rest)
  const outsideRough = outside.find((draft) => draft.operation.pass === 'rough')
  const outsideFinish = outside.find((draft) => draft.operation.pass === 'finish')
  assert(pocketRough?.operation.toolRef === 'three-eighth', 'fixture pocket starts with a conservative 3/8 inch cutter')
  assert(pocketRest?.operation.pass === 'finish', 'fixture rest proposal is a finish-rest pass')
  assert(pocketRest?.operation.toolRef === 'eighth', 'fixture finish rest uses a half-diameter-or-smaller detail cutter')
  assert(pocketFinish?.operation.toolRef === 'three-eighth', 'fixture primary finish follows the primary roughing cutter')
  assert(pocketRest?.dependencies.includes(pocketFinish?.key ?? ''), 'fixture finish rest runs after the primary finish')
  assert(outsideRough?.operation.toolRef === 'three-eighth', 'fixture outside route is not oversized for the part')
  assert(
    ![...pocket, ...outside].some((draft) => draft.operation.toolRef === 'three-quarter' || draft.operation.toolRef === 'half'),
    'fixture recommendations exclude the 3/4 and 1/2 inch cutters',
  )
  assert(pocketRough?.operation.stockToLeaveRadial === 0.005, 'pocket rough leaves radial finishing stock')
  assert(pocketRough?.operation.stockToLeaveAxial === 0.005, 'pocket rough leaves axial finishing stock')
  assert(outsideRough?.operation.stockToLeaveRadial === 0.005, 'outside rough leaves radial finishing stock')
  assert(outsideRough?.operation.stockToLeaveAxial === 0.005, 'outside rough leaves axial finishing stock')
  assert(pocketFinish?.operation.stockToLeaveRadial === 0, 'pocket finish removes radial finishing stock')
  assert(pocketFinish?.operation.stockToLeaveAxial === 0, 'pocket finish removes axial finishing stock')
  assert(pocketRest?.operation.stockToLeaveRadial === 0, 'pocket finish rest does not leave another radial allowance')
  assert(pocketRest?.operation.stockToLeaveAxial === 0, 'pocket finish rest does not leave another axial allowance')
  assert(outsideFinish?.operation.stockToLeaveRadial === 0, 'outside finish removes radial finishing stock')
  assert(outsideFinish?.operation.stockToLeaveAxial === 0, 'outside finish removes axial finishing stock')
}

function testBundledToolUnitPreference(): void {
  const base = newProject('CAM plan library units', 'inch')
  base.stock.thickness = 0.75
  const project = projectWithFeatures({ ...base, tools: [] }, [
    feature('pocket', 'subtract', rectProfile(0.5, 0.5, 2, 2), 0.75, 0.5),
  ])
  const metric = { ...tool('ten-mm', 'flat_endmill', 10), units: 'mm' as const, maxCutDepth: 25.4 }
  const library = [
    libraryTool('inch-three-eighth', tool('three-eighth', 'flat_endmill', 0.375)),
    libraryTool('metric-ten', metric),
    libraryTool('inch-quarter', tool('quarter', 'flat_endmill', 0.25)),
  ]
  const plan = createCamPlan(project, library)
  const rough = plan.operations.find((draft) => draft.operation.kind === 'pocket' && draft.operation.pass === 'rough')
  assert(rough?.operation.toolRef === 'cam-plan-tool:inch-three-eighth', 'inch projects prefer an equally suitable inch library tool')
  const materialized = materializeCamPlan(project, plan)
  assert(materialized.ok, 'a plan can create its selected bundled tool without preloading it')
  if (!materialized.ok) return
  assert(
    materialized.project.tools.length === 1
      && materialized.project.tools[0]?.name === 'three-eighth'
      && materialized.project.tools[0]?.diameter === 0.375,
    'materializing the plan imports only the selected bundled tool into the project',
  )
}

function testFallbackNoToolAndUnits(): void {
  const base = newProject('CAM plan no tool', 'inch')
  base.stock.thickness = 1
  const project = projectWithFeatures(base, [
    feature('circle', 'subtract', circleProfile(0.5, 0.5, 0.125), 1, 0, 'circle'),
  ])
  const noToolPlan = createCamPlan(project, [])
  assert(!noToolPlan.operations.some((draft) => draft.operation.kind === 'drilling'), 'circle without a feasible drill or boring tool falls back from drilling')
  assert(noToolPlan.operations.some((draft) => draft.operation.kind === 'edge_route_inside' && draft.hardError), 'fallback inside route remains visibly unresolved when it also has no tool')

  const inchProject = exampleProject()
  const millimetreProject = convertProjectUnits(inchProject, 'mm')
  const inchPlan = createCamPlan(inchProject, [])
  const millimetrePlan = createCamPlan(millimetreProject, [])
  const decisionKeys = (plan: ReturnType<typeof createCamPlan>) => plan.operations.map((draft) => `${draft.operation.kind}:${draft.operation.pass}`)
  assert(JSON.stringify(decisionKeys(inchPlan)) === JSON.stringify(decisionKeys(millimetrePlan)), 'inch and millimetre projects produce equivalent operation decisions')
  assert(
    millimetrePlan.operations.filter((draft) => draft.operation.kind === 'edge_route_outside').every((draft) => draft.operation.toolRef !== 'three-quarter'),
    'outside cutter scale policy remains unit-invariant',
  )
}

function testResolvedWorldTransformAndOrdering(): void {
  const project = exampleProject()
  const translated: Project = {
    ...project,
    features: project.features.map((instance) => ({
      ...instance,
      transform: { ...instance.transform, e: instance.transform.e + 10, f: instance.transform.f + 7 },
    })),
  }
  const originalPlan = createCamPlan(project, [])
  const translatedPlan = createCamPlan(translated, [])
  const decisions = (plan: ReturnType<typeof createCamPlan>) => plan.operations.map((draft) => `${draft.operation.kind}:${draft.operation.pass}`)
  assert(JSON.stringify(decisions(originalPlan)) === JSON.stringify(decisions(translatedPlan)), 'resolved world translation does not change machining decisions')
  const firstOutside = originalPlan.operations.findIndex((draft) => draft.operation.kind === 'edge_route_outside')
  const lastInternal = originalPlan.operations.findLastIndex((draft) => draft.operation.kind !== 'edge_route_outside')
  assert(firstOutside > lastInternal, 'internal work is ordered before outside separation')
}

function testReactiveRestReconciliation(): void {
  const base = newProject('CAM plan reactive rest', 'inch')
  base.stock.thickness = 1
  const project = projectWithFeatures({
    ...base,
    tools: [
      tool('half', 'flat_endmill', 0.5),
      tool('three-eighth', 'flat_endmill', 0.375),
      tool('quarter', 'flat_endmill', 0.25),
      tool('eighth', 'flat_endmill', 0.125),
      tool('sixteenth', 'flat_endmill', 0.0625),
      tool('thirty-second', 'flat_endmill', 0.03125),
    ],
  }, [
    feature('outer', 'add', rectProfile(0, 0, 2.5, 2.5), 1, 0),
    feature('pocket', 'subtract', rectProfile(0.25, 0.25, 2, 2), 1, 0.5),
  ])
  const plan = createCamPlan(project, [])
  const existingRest = plan.operations.find((draft) => draft.rest)
  assert(existingRest?.rest, 'roughing source has a finish-rest proposal')
  const source = plan.operations.find((draft) => draft.key === existingRest.rest?.sourceOperationKey)
  assert(source, 'rest proposal resolves its roughing source')
  assert(source.operation.toolRef === 'three-eighth', 'initial roughing source uses the larger cutter')
  assert(existingRest.operation.pass === 'finish', 'initial rest proposal is a finish pass')
  assert(existingRest.operation.toolRef === 'eighth', 'initial finish rest uses a meaningfully smaller cutter')
  const initialFinish = plan.operations.find((draft) =>
    draft.operation.kind === source.operation.kind && draft.operation.pass === 'finish' && !draft.rest,
  )
  assert(
    initialFinish?.operation.toolRef === 'three-eighth',
    'initial primary finish follows the roughing cutter',
  )
  assert(existingRest.dependencies.includes(initialFinish?.key ?? ''), 'initial finish rest follows the primary finish')

  const withoutRest = {
    ...plan,
    operations: plan.operations
      .filter((draft) => draft.key !== existingRest.key)
      .map((draft) => draft.dependencies.includes(existingRest.key)
        ? { ...draft, dependencies: draft.dependencies.map((key) => key === existingRest.key ? source.key : key) }
        : draft),
  }
  const restored = reconcileCamPlanRest(project, withoutRest, source.key)
  const restoredRest = restored.operations.find((draft) => draft.rest?.sourceOperationKey === source.key)
  assert(restoredRest?.operation.toolRef === 'eighth', 'missing dependent rest proposal is recreated from the source operation')
  const restoredFinish = restored.operations.find((draft) =>
    draft.operation.kind === source.operation.kind && draft.operation.pass === 'finish' && !draft.rest,
  )
  assert(restoredRest?.dependencies.includes(restoredFinish?.key ?? ''), 'recreated finish rest follows the primary finish')
  assert(restoredFinish?.operation.toolRef === 'three-eighth', 'recreated primary finish keeps the primary cutter')

  const unrelated = plan.operations.find((draft) =>
    draft.operation.kind === 'pocket' && draft.operation.pass === 'finish' && !draft.rest,
  )
  assert(unrelated, 'primary finish proposal exists')
  const frozenPrefix = {
    ...source,
    key: 'cam-plan-frozen-prefix',
    operation: {
      ...source.operation,
      id: 'cam-plan-frozen-prefix',
      name: 'Earlier Pocket Rough',
      toolRef: 'half',
    },
    userOverrides: [],
  }
  const planWithPrefix = {
    ...plan,
    operations: [frozenPrefix, ...plan.operations],
  }
  const corrected = {
    ...planWithPrefix,
    operations: planWithPrefix.operations.map((draft) => {
      if (draft.key === source.key) {
        return {
          ...draft,
          operation: { ...draft.operation, toolRef: 'quarter' },
          userOverrides: ['toolRef'] satisfies Array<keyof typeof draft.operation>,
        }
      }
      if (draft.key === existingRest.key) {
        return {
          ...draft,
          operation: { ...draft.operation, stockToLeaveRadial: 0.007 },
          userOverrides: ['stockToLeaveRadial'] satisfies Array<keyof typeof draft.operation>,
        }
      }
      if (draft.key === unrelated.key) return { ...draft, enabled: false }
      return draft
    }),
  }
  const revised = reconcileCamPlanDownstream(project, corrected, source.key)
  assert(
    revised.operations.find((draft) => draft.key === frozenPrefix.key)?.operation.toolRef === 'half',
    'operations before the corrected row stay frozen during a forward replan',
  )
  const revisedRest = revised.operations.find((draft) => draft.rest?.sourceOperationKey === source.key)
  assert(revisedRest, 'rest proposal remains when corrected source still leaves residual stock')
  assert(revisedRest.operation.toolRef === 'eighth', 'suggested rest tool moves below the corrected source tool')
  assert(revisedRest.operation.stockToLeaveRadial === 0.007, 'explicit rest setting survives reactive regeneration')
  assert(revisedRest.staleReason === null, 'reactive regeneration produces a ready rest proposal')
  assert(
    JSON.stringify(revisedRest.rest?.regions) !== JSON.stringify(existingRest.rest?.regions),
    'residual regions are regenerated from the corrected source cutter',
  )
  assert(
    revised.operations.find((draft) =>
      draft.operation.kind === source.operation.kind && draft.operation.pass === 'finish' && !draft.rest,
    )?.operation.toolRef === 'quarter',
    'automatic primary finish follows the corrected source cutter during a forward replan',
  )
  assert(revised.operations.find((draft) => draft.key === unrelated.key)?.enabled === false, 'unrelated include choice survives reactive regeneration')

  const conflicting = {
    ...revised,
    operations: revised.operations.map((draft) => draft.key === revisedRest.key
      ? {
        ...draft,
        operation: { ...draft.operation, toolRef: 'quarter' },
        userOverrides: [...new Set([...draft.userOverrides, 'toolRef' as const])],
      }
      : draft),
  }
  const preserved = reconcileCamPlanRest(project, conflicting, source.key)
  const preservedRest = preserved.operations.find((draft) => draft.key === revisedRest.key)
  assert(preservedRest?.operation.toolRef === 'quarter', 'incompatible explicit rest tool is not silently replaced')
  assert(Boolean(preservedRest?.hardError), 'incompatible explicit rest tool becomes a focused blocking conflict')
}

function testReactiveRestRemoval(): void {
  const base = newProject('CAM plan reactive removal', 'inch')
  base.stock.thickness = 1
  const project = projectWithFeatures({
    ...base,
    tools: [tool('quarter', 'flat_endmill', 0.25), tool('eighth', 'flat_endmill', 0.125)],
  }, [
    feature('round-pocket', 'subtract', circleProfile(0.5, 0.5, 0.5), 1, 0.5),
  ])
  const plan = createCamPlan(project, [])
  const source = plan.operations.find((draft) => draft.operation.kind === 'pocket' && draft.operation.pass === 'rough')
  assert(source, 'round pocket roughing source exists')
  assert(!plan.operations.some((draft) => draft.rest?.sourceOperationKey === source.key), 'round pocket initially needs no rest proposal')
  const fakeRest = {
    ...source,
    key: 'cam-plan-test-rest',
    operation: {
      ...source.operation,
      id: 'cam-plan-test-rest',
      name: `${source.operation.name} Finish Rest`,
      pass: 'finish' as const,
      toolRef: 'eighth',
      stockToLeaveRadial: 0,
      stockToLeaveAxial: 0,
    },
    dependencies: [source.key],
    userOverrides: [],
    rest: { sourceOperationKey: source.key, sourceFeatureIds: ['round-pocket'], regions: [] },
  }
  const withObsoleteRest = {
    ...plan,
    operations: plan.operations.flatMap((draft) => {
      if (draft.key === source.key) return [draft, fakeRest]
      if (draft.operation.kind === 'pocket' && draft.operation.pass === 'finish') {
        return [{ ...draft, dependencies: [fakeRest.key] }]
      }
      return [draft]
    }),
  }
  const revised = reconcileCamPlanRest(project, withObsoleteRest, source.key)
  assert(!revised.operations.some((draft) => draft.key === fakeRest.key), 'obsolete rest proposal is removed when no residual remains')
  const finish = revised.operations.find((draft) => draft.operation.kind === 'pocket' && draft.operation.pass === 'finish')
  assert(finish?.dependencies.includes(source.key), 'finish dependency returns to the source after rest removal')
}

testRepresentativePlan()
testMatchingHolesShareOneDrillingOperation()
testCompatiblePocketsShareOneOperationAcrossDepths()
testCompatibleOutsideProfilesShareOneOperation()
testOutsideProfilesWithDifferentToolsStaySeparate()
testExistingOperationsOnlySuppressExactRecommendations()
testDeterministicAndAtomicApply()
testDepthRolesAndUnsupportedCoverage()
testRetainedIslandsDoNotNeedCoverageAcknowledgement()
testSurfaceCleanOnlyTargetsLoweredOuterMaterial()
testNestedSubtractsStayWithTheirParentPocket()
testEdgeSharingSubtractChainsStayWithTheirParentPocket()
testConnectedPocketsShareOneOperationWhenTheResolverOwnershipIsDirectional()
testFixtureScaleAndFinishAllowances()
testBundledToolUnitPreference()
testFallbackNoToolAndUnits()
testResolvedWorldTransformAndOrdering()
testReactiveRestReconciliation()
testReactiveRestRemoval()
console.log('CAM plan POC tests passed')
