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
import { useProjectStore } from './projectStore'
import { defaultTool, newProject, rectProfile, type Project, type SketchFeature } from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { provisionalSetupId } from './helpers/provisionalSetup'
import { activeSetup, isThroughFeature } from './helpers/activeFace'
import { camSetupSections } from '../components/cam/setupSections'
import { operationTargetFromSelection } from '../components/cam/operationValidity'
import { targetAllowedInSetup } from '../engine/setupTargets'
import { createCamPlan } from '../engine/operations/camPlan'
import { resolveFeatureInstance } from './helpers/resolveFeatures'

function fixture(): Project {
  const project = newProject('Setup UI','mm')
  project.stock.thickness = 20
  project.tools = [{ ...defaultTool('mm',1), diameter:2, maxCutDepth:25 }]
  const feature = (id: string, face: 'top'|'bottom', bottom: number, role: 'subtract'|'add' = 'subtract'): SketchFeature => ({
    id, name: id, kind: 'rect', folderId: null, sketch: { profile: rectProfile(5,5,12,12), origin: { x:0,y:0 }, orientationAngle:0, dimensions:[], constraints:[] },
    authoringFace: face, operation:role,z_top:20,z_bottom:bottom,visible:true,locked:false,
  })
  return projectWithFeatures(project,[feature('through','top',0),feature('blind','top',15),feature('bottom','bottom',0),feature('island','top',0,'add')])
}
function load(project: Project) { useProjectStore.getState().loadProject(project) }
function lookedAtBottom(): Project {
  const project = fixture()
  project.features = project.features.filter((feature) => feature.authoringFace === 'top')
  load(project)
  useProjectStore.getState().setActiveSetup(provisionalSetupId('bottom'))
  return useProjectStore.getState().project
}
const before = lookedAtBottom()
assert.equal(before.setups.length,1)
const sections = camSetupSections(before)
assert.equal(sections.grouped,true)
assert.deepEqual(sections.sections.map((section) => [section.face,section.active,section.programNumber,section.operations.length]),[['top',false,1,0],['bottom',true,2,0]])
const target = { source:'features' as const, featureIds:['through'] }
assert.equal(targetAllowedInSetup(before,target,before.activeSetupId),true)
assert.equal(targetAllowedInSetup(before,{ ...target,featureIds:['blind'] },before.activeSetupId),false)
assert.equal(targetAllowedInSetup(before,{ ...target,featureIds:['island'] },before.activeSetupId),false)
const selection = { ...useProjectStore.getState().selection,selectedFeatureIds:['blind'],selectedFeatureId:'blind' }
assert.equal(operationTargetFromSelection(before,selection,'pocket'),null)
const plan = createCamPlan(before,[])
assert.ok(plan.operations.length > 0)
assert.ok(plan.operations.every((draft) => draft.hardError?.includes('Top setup only')), 'Bottom CAM Plan cannot silently propose Top cuts')
// Both UI and engine use the same tolerance and subtract rule.
const resolved = resolveFeatureInstance(before,'through')!
assert.equal(isThroughFeature(before,{ ...resolved,z_bottom:5e-7 }),true)
assert.equal(isThroughFeature(before,{ ...resolved,operation:'add' }),false)
const history = useProjectStore.getState().history.past.length
assert.equal(useProjectStore.getState().addOperation('pocket','rough',{ ...target,featureIds:['blind'] }),null)
assert.equal(useProjectStore.getState().history.past.length,history)
const operationId = useProjectStore.getState().addOperation('pocket','rough',target)
assert.ok(operationId)
const created = useProjectStore.getState().project
assert.equal(created.setups.length,2)
assert.equal(activeSetup(created).orientation.angleDeg,180)
assert.equal(created.operations[0].setupId,activeSetup(created).id)
assert.notEqual(created.operations[0].setupId,provisionalSetupId('bottom'))
useProjectStore.getState().undo()
assert.equal(useProjectStore.getState().project.setups.length,1)
assert.equal(activeSetup(useProjectStore.getState().project).orientation.angleDeg,180)

const editing = lookedAtBottom()
const initialHistory = useProjectStore.getState().history.past.length
assert.equal(useProjectStore.getState().updateSetup(editing.activeSetupId,{ name:' ',notes:'ignored' }),false)
assert.equal(useProjectStore.getState().project.setups.length,1)
const refs = [{ id:'pin',kind:'dowel' as const,target:{ type:'feature' as const,featureId:'through' } }]
assert.equal(useProjectStore.getState().updateSetup(editing.activeSetupId,{ name:'Second side',flipAxis:'y',registration:refs,notes:'Seat on pin' }),true)
const changed = activeSetup(useProjectStore.getState().project)
assert.equal(changed.name,'Second side')
assert.equal(changed.orientation.axis,'y')
assert.equal(changed.orientation.angleDeg,180)
assert.equal(changed.notes,'Seat on pin')
assert.deepEqual(changed.registration,refs)
assert.equal(useProjectStore.getState().history.past.length,initialHistory+1)
refs[0].id='mutated external'
assert.equal(changed.registration[0].id,'pin')
useProjectStore.getState().undo()
assert.equal(useProjectStore.getState().project.setups.length,1)
useProjectStore.getState().redo()
assert.equal(activeSetup(useProjectStore.getState().project).orientation.axis,'y')
assert.equal(useProjectStore.getState().updateSetup('unknown',{ notes:'ignored' }),false)
// Moving to a provisional face validates before committing or realizing it.
load(fixture())
const topOperation = useProjectStore.getState().addOperation('pocket','rough',{ ...target,featureIds:['through','blind'] })!
useProjectStore.getState().setActiveSetup(provisionalSetupId('bottom'))
useProjectStore.getState().assignOperationToSetup(topOperation,provisionalSetupId('bottom'))
const moved = useProjectStore.getState().project
assert.equal(moved.setups.length,2)
assert.deepEqual(moved.operations[0].target,target)
assert.equal(moved.operations[0].setupId,activeSetup(moved).id)
console.log('setup UI store regressions passed')
