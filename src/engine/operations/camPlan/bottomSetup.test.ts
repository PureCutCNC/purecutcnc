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

import assert from 'node:assert/strict'
import { circleProfile, newProject, rectProfile, defaultTool, type Project, type Operation } from '../../../types/project'
import { projectWithFeatures, withBottomSetup, BOTTOM_SETUP_ID } from '../../../test/projectFixtures'
import { defaultOperationForTarget } from '../../../store/helpers/operationDefaults'
import { materializeCamPlan } from '../../../store/helpers/camPlanApply'
import { computeOperationToolpath } from '../../toolpaths/generateOperation'
import { camPlanSetupProject } from './setupPlanning'
import { createCamPlan } from './createCamPlan'
import { reconcileCamPlanRest } from './reconcileRest'
import { resolvePocketRegions } from '../../toolpaths/resolver'
import { convertProjectUnits, convertToolUnits } from '../../../utils/units'
import { camPlanProjectFingerprint } from './createCamPlan'

function fixture(axis: 'x' | 'y' = 'x'): Project {
  const base = newProject('Asymmetric Bottom plan', 'mm')
  base.stock.thickness = 20
  base.stock.profile = rectProfile(0, 0, 100, 80)
  const mill = { ...defaultTool('mm', 1), id: 'mill', diameter: 3, maxCutDepth: 25, defaultStepdown: 3 }
  const detail = { ...mill, id: 'detail', diameter: 1 }
  const drill = { ...mill, id: 'drill', type: 'drill' as const, diameter: 6 }
  const make = (id: string, operation: 'add' | 'subtract', zTop: number, zBottom: number, bottom: boolean,
    profile = rectProfile(10, 12, 25, 18), kind: 'rect' | 'circle' = 'rect') => ({
    id, name: id, kind, operation, folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    z_top: zTop, z_bottom: zBottom, visible: true, locked: false,
    authoringFace: bottom ? 'bottom' as const : 'top' as const,
  })
  const project = withBottomSetup(projectWithFeatures({ ...base, tools: [mill, detail, drill] }, [
    make('full-add', 'add', 20, 0, true, rectProfile(2, 3, 90, 68)),
    make('bottom-pocket', 'subtract', 6, 0, true),
    make('top-pocket', 'subtract', 20, 13, false, rectProfile(55, 15, 20, 15)),
    make('hole', 'subtract', 20, 0, false, circleProfile(45, 40, 3), 'circle'),
    make('through-slot', 'subtract', 20, 0, true, rectProfile(65, 45, 15, 12)),
  ]))
  project.setups = project.setups.map(setup => setup.id === BOTTOM_SETUP_ID
    ? { ...setup, orientation: { axis, angleDeg: 180 } } : setup)
  return { ...project, activeSetupId: BOTTOM_SETUP_ID }
}

function handOperation(project: Project, kind: Operation['kind'], pass: Operation['pass'], ids: string[], toolId: string): Operation {
  const tool = project.tools.find(row => row.id === toolId)!
  return {
    ...defaultOperationForTarget(project, kind, pass, { source: 'features', featureIds: ids }, 0, { tool, toolRef: tool.id }),
    id: 'hand-added', setupId: project.activeSetupId,
  }
}

for (const axis of ['x', 'y'] as const) for (const units of ['mm', 'inch'] as const) {
  // A unit switch keeps tool records in their own units, and the plan only
  // chooses tools in the project's units — convert the records too so the inch
  // fixture is a real inch project (issue #1132).
  const inchFixture = () => {
    const converted = convertProjectUnits(fixture(axis), 'inch')
    return { ...converted, tools: converted.tools.map((record) => convertToolUnits(record, 'inch')) }
  }
  const project = units === 'mm' ? fixture(axis) : inchFixture()
  const scale = units === 'mm' ? 1 : 1 / 25.4
  const before = JSON.stringify(project)
  const top = { ...project, activeSetupId: project.setups[0]!.id }
  const topPlan = JSON.stringify(createCamPlan(top, []))
  const plan = createCamPlan(project, [])
  assert.equal(JSON.stringify(project), before, 'planning does not mutate the stock-space project')
  assert.equal(JSON.stringify(createCamPlan(top, [])), topPlan, 'Bottom planning leaves the serialized Top plan untouched')
  assert.equal(plan.sourceFingerprint, camPlanProjectFingerprint(project))
  assert(plan.operations.length > 0)
  assert(plan.operations.every(draft => draft.operation.setupId === BOTTOM_SETUP_ID && draft.hardError === null))
  for (const draft of plan.operations) {
    assert.equal(draft.operation.target.source, 'features')
    const ids = draft.coveredFeatureIds
    assert(!ids.includes('top-pocket'), 'unreachable Top pocket is excluded')
    assert(ids.length === 1, 'asymmetric fixture keeps each target separate')
    assert(Math.abs(draft.requiredCutDepth! - (ids[0] === 'bottom-pocket' ? 6 : 20) * scale) < 1e-9, 'reach is measured from Bottom')
    if (ids[0] === 'bottom-pocket') assert.equal(draft.operation.kind, 'pocket')
    if (ids[0] === 'hole') assert.equal(draft.operation.kind, 'drilling')
    if (ids[0] === 'through-slot') assert.equal(draft.operation.kind, 'edge_route_inside')
    if (ids[0] === 'full-add') assert.equal(draft.operation.kind, 'edge_route_outside')
  }
  const pocket = plan.operations.find(draft => draft.operation.kind === 'pocket' && draft.operation.pass === 'finish' && !draft.rest)!
  const hand = handOperation(project, 'pocket', 'finish', ['bottom-pocket'], pocket.operation.toolRef!)
  const generated = computeOperationToolpath(project, pocket.operation)!.result
  const manual = computeOperationToolpath(project, hand)!.result
  assert(generated.moves.length > 0, `parity compares actual generated motion: ${JSON.stringify(generated.warnings)}`)
  assert.deepEqual({ ...generated, operationId: hand.id }, manual, 'planned Bottom finish generates exactly like hand-added Bottom finish')
  const cutting = generated.moves.filter(move => move.kind !== 'rapid').flatMap(move => [move.from.z, move.to.z])
  assert(Math.abs(Math.max(...cutting) - 6 * scale) < 1e-7, 'Bottom pocket reaches canonical Z 6, not a Top-face depth')
  const applied = materializeCamPlan(project, plan)
  assert(applied.ok, `Bottom plan including rest masks and tabs applies: ${JSON.stringify(applied)}`)
  assert(applied.project.operations.every(op => op.setupId === BOTTOM_SETUP_ID))
  const rough = plan.operations.find(draft => draft.operation.kind === 'pocket' && draft.operation.pass === 'rough')!
  const reconciled = reconcileCamPlanRest(project, plan, rough.key)
  assert(reconciled.operations.every(draft => draft.operation.setupId === BOTTOM_SETUP_ID))
  const reapplied = materializeCamPlan(project, reconciled)
  assert(reapplied.ok, JSON.stringify({ tool: rough.operation.toolRef, options: rough.toolOptions, reapplied, errors: reconciled.operations.filter(draft => draft.hardError).map(draft => [draft.operation.name, draft.hardError]) }))
  // Rest masks were returned to stock XY, so after the generation transform
  // they intersect the same asymmetric pocket rather than its mirror.
  const local = camPlanSetupProject(reapplied.project)
  for (const operation of local.operations.filter(op => op.kind === 'pocket')) {
    assert(resolvePocketRegions(local, operation).bands.length > 0, 'Bottom rest and primary operations retain nonempty pocket regions')
  }
}

{
  const project = fixture()
  const topId = project.setups[0]!.id
  const topDrill = { ...handOperation(project, 'drilling', 'rough', ['hole'], 'drill'), setupId: topId }
  const covered = { ...project, operations: [topDrill] }
  const plan = createCamPlan(covered, [])
  assert.notEqual(camPlanProjectFingerprint(covered), camPlanProjectFingerprint({ ...covered, operations: [{ ...topDrill, enabled: false }] }), 'Top coverage edits invalidate the Bottom plan')
  assert(!plan.operations.some(draft => draft.coveredFeatureIds.includes('hole')), 'fully Top-covered through-hole is not proposed again')
  assert.equal(plan.coverage.find(row => row.featureId === 'hole')?.status, 'existing')
  assert.match(plan.coverage.find(row => row.featureId === 'hole')!.detail, /covered by the Top setup/i)
  for (const operation of [
    { ...topDrill, enabled: false },
    { ...topDrill, drillType: 'countersink' as const },
    { ...topDrill, toolRef: 'missing' },
  ]) {
    assert(createCamPlan({ ...project, operations: [operation] }, []).operations.some(draft => draft.coveredFeatureIds.includes('hole')), 'disabled, partial or unverified Top coverage does not suppress Bottom')
  }
  // A Top rough through-slot must not suppress either Bottom stage by kind/pass.
  const topRough = { ...handOperation(project, 'edge_route_inside', 'rough', ['through-slot'], 'mill'), setupId: topId, stockToLeaveAxial: 1 }
  assert(createCamPlan({ ...project, operations: [topRough] }, []).operations.some(draft => draft.operation.pass === 'rough' && draft.coveredFeatureIds.includes('through-slot')))
  const topFinish = { ...handOperation(project, 'edge_route_inside', 'finish', ['through-slot'], 'mill'), setupId: topId }
  assert(!createCamPlan({ ...project, operations: [topFinish] }, []).operations.some(draft => draft.coveredFeatureIds.includes('through-slot')), 'completed Top inside route is not cut through from Bottom again')
  const overlapping = {
    ...covered,
    features: covered.features.map(feature => feature.id === 'hole'
      ? { ...feature, transform: { ...feature.transform, e: -25, f: -20 } } : feature),
  }
  const overlapPlan = createCamPlan(overlapping, [])
  const bottomPocket = overlapPlan.operations.find(draft => !draft.rest && draft.operation.kind === 'pocket')!
  assert.equal(bottomPocket.requiredCutDepth, 6, 'covered Top through-hole is not folded into Bottom as a new full-depth target')
  const bottomFinish = handOperation(project, 'pocket', 'finish', ['bottom-pocket'], 'mill')
  assert(!createCamPlan({ ...project, operations: [bottomFinish] }, []).operations.some(draft => !draft.rest && draft.operation.pass === 'finish' && draft.coveredFeatureIds.includes('bottom-pocket')), 'same-side existing finish is respected')
}


{
  const project = fixture()
  // The retained outer surface is four millimetres in from Bottom. From Top
  // this is a full-height top surface and must not request cleanup.
  project.features = project.features.map(feature => feature.id === 'full-add'
    ? { ...feature, z_bottom: 4 } : feature)
  const plan = createCamPlan(project, [])
  const surfaces = plan.operations.filter(draft => draft.operation.kind === 'surface_clean')
  assert.equal(surfaces.length, 2)
  assert(surfaces.every(draft => draft.operation.setupId === BOTTOM_SETUP_ID && draft.coveredFeatureIds.join() === 'full-add'))
  const finish = surfaces.find(draft => draft.operation.pass === 'finish')!
  const generated = computeOperationToolpath(project, finish.operation)!.result
  assert(generated.moves.length > 0)
  const cutZ = generated.moves.filter(move => move.kind !== 'rapid').flatMap(move => [move.from.z, move.to.z])
  assert(Math.abs(Math.max(...cutZ) - 4) < 1e-7, 'surface cleanup uses the Bottom retained surface')
  assert(!createCamPlan({ ...project, activeSetupId: project.setups[0]!.id }, []).operations.some(draft => draft.operation.kind === 'surface_clean'))
}

{
  const project = fixture()
  project.setups = project.setups.map(setup => setup.id === BOTTOM_SETUP_ID
    ? { ...setup, kind: 'around', orientation: { axis: 'x', angleDeg: 0 } } : setup)
  project.features = project.features.map(feature => ({ ...feature, authoringFace: 'around' }))
  const plan = createCamPlan(project, [])
  assert(plan.operations.length > 0)
  assert(plan.operations.every(draft => draft.hardError !== null), 'Around remains blocked')
  assert(plan.operations.some(draft => draft.hardError?.includes('Top setup only')), 'Around retains TURNED_SETUP_ERROR')
}

console.log('Bottom CAM Plan tests passed')
