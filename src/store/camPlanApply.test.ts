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

import { createCamPlan } from '../engine/operations/camPlan'
import { projectWithFeatures } from '../test/projectFixtures'
import { newProject, rectProfile, type SketchFeature, type Tool } from '../types/project'
import { useProjectStore } from './projectStore'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function flatTool(id: string, diameter: number): Tool {
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

const outer: SketchFeature = {
  id: 'outer',
  name: 'Outer part',
  kind: 'rect',
  folderId: null,
  sketch: { profile: rectProfile(0, 0, 2, 2), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
  operation: 'add',
  z_top: 1,
  z_bottom: 0,
  visible: true,
  locked: false,
}

const base = newProject('CAM plan store', 'inch')
base.stock.thickness = 1
const project = projectWithFeatures({ ...base, tools: [flatTool('quarter', 0.25), flatTool('eighth', 0.125)] }, [outer])
useProjectStore.setState({ project, history: { past: [], future: [], transactionStart: null }, dirty: false })

const plan = createCamPlan(project, [])
const proposedTabCount = plan.sharedTabs.reduce((count, group) => count + group.tabs.length, 0)
assert(plan.sharedTabs.length === 1, 'rough and finish outside routes share one tab setup')
const result = useProjectStore.getState().applyCamPlan(plan)
assert(result.ok, 'store applies the plan')
const applied = useProjectStore.getState()
assert(applied.history.past.length === 1, 'the whole plan creates one history snapshot')
assert(applied.project.tabs.length === proposedTabCount, 'shared tabs are materialized once, not once per operation')
assert(applied.project.operations.length === plan.operations.filter((draft) => draft.enabled).length, 'all enabled operations are created')

applied.undo()
assert(JSON.stringify(useProjectStore.getState().project) === JSON.stringify(project), 'one undo restores the exact source project')

const planWithoutEdges = {
  ...plan,
  operations: plan.operations.map((draft) => (
    draft.operation.kind === 'edge_route_inside' || draft.operation.kind === 'edge_route_outside'
      ? { ...draft, enabled: false }
      : draft
  )),
}
const noEdgesResult = useProjectStore.getState().applyCamPlan(planWithoutEdges)
assert(noEdgesResult.ok, 'a plan with excluded edge operations still applies')
assert(useProjectStore.getState().project.tabs.length === 0, 'shared tabs are omitted when every related edge operation is excluded')

console.log('CAM plan store tests passed')
