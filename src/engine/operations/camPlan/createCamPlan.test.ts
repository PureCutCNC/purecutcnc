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

import { circleProfile, newProject, rectProfile, type Project, type SketchFeature, type SketchProfile, type Tool } from '../../../types/project'
import { projectWithFeatures } from '../../../test/projectFixtures'
import { materializeCamPlan } from '../../../store/helpers/camPlanApply'
import { convertProjectUnits } from '../../../utils/units'
import { createCamPlan } from './createCamPlan'

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

testRepresentativePlan()
testDeterministicAndAtomicApply()
testDepthRolesAndUnsupportedCoverage()
testFallbackNoToolAndUnits()
testResolvedWorldTransformAndOrdering()
console.log('CAM plan POC tests passed')
