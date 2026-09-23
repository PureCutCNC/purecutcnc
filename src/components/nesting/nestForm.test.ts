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
 * Nest panel state (issue #848): which nest a selection targets, the base the
 * job runs on, the gap floor, presets, and form validation.
 *
 * Run with: npx tsx src/components/nesting/nestForm.test.ts
 */

import { nest } from '../../engine/nesting'
import { buildNestJob } from '../../store/helpers/nestPart'
import { applyNestToProject } from '../../store/helpers/nestApply'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { normalizeProject, type ProjectFormatInput } from '../../store/helpers/projectFormat'
import { requestFromJob } from '../../engine/nesting'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultStock, defaultTool, newProject, rectProfile, type Project, type SketchFeature } from '../../types/project'
import {
  NEST_ROTATIONS,
  initialNestForm,
  nestSettingsFromForm,
  nestSubject,
  presetForRotations,
  validateNestForm,
} from './nestForm'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function rect(id: string, operation: SketchFeature['operation'], x: number, y: number, w: number, h: number): SketchFeature {
  const profile = rectProfile(x, y, w, h)
  return {
    id, name: id, kind: 'rect', operation, visible: true, locked: false, z_top: 10, z_bottom: 0,
    folderId: null, text: null, stl: null,
    sketch: { origin: { x, y }, orientationAngle: 0, dimensions: [], constraints: [], profile },
  }
}

function makeProject(withEdgeRoute: boolean): Project {
  const base = newProject()
  base.meta = { ...base.meta, units: 'mm' }
  base.stock = defaultStock(200, 100, 12, 'mm')
  base.tools = [{ ...defaultTool('mm', 1), id: 'tool-4', diameter: 4 }]
  const project = projectWithFeatures(base, [
    rect('plate', 'add', 5, 5, 30, 20),
    rect('pocket', 'subtract', 10, 10, 8, 8),
  ])
  if (withEdgeRoute) {
    const edge = defaultOperationForTarget(project, 'edge_route_outside', 'finish', { source: 'features', featureIds: ['plate'] }, 0)
    project.operations = [{ ...edge, id: 'op-edge', toolRef: 'tool-4', stockToLeaveRadial: 0.25 }]
  }
  return normalizeProject(JSON.parse(JSON.stringify(project)) as ProjectFormatInput)
}

function testFreshSubject(): void {
  const subject = nestSubject(makeProject(true), ['plate'])
  assert(subject.replaceNest === null, 'nothing nested yet')
  assert(subject.part.ok && subject.part.featureIds.join() === 'plate,pocket', 'the pocket joins the part')
  assert(subject.gapFloor === 4.5, `gap floor is 4 + 2 × 0.25, got ${subject.gapFloor}`)
  const form = initialNestForm(subject)
  assert(form.gap === 4.5 && form.quantity === 10 && form.rotation === 'quarter' && !form.keepOriginals, 'defaults')
  assert(validateNestForm(form, subject.gapFloor) === null, 'defaults are valid')
  assert(validateNestForm({ ...form, gap: 4 }, subject.gapFloor) === 'gap-below-tool', 'the gap cannot go below the tool')
  assert(validateNestForm({ ...form, gap: 6 }, subject.gapFloor) === null, 'the gap can be raised')
  assert(validateNestForm({ ...form, quantity: 0 }, subject.gapFloor) === 'quantity', 'at least one part')
  assert(validateNestForm({ ...form, quantity: 2.5 }, subject.gapFloor) === 'quantity', 'whole parts only')
  assert(validateNestForm({ ...form, quantity: 1, keepOriginals: true }, subject.gapFloor) === 'quantity', 'keeping the original needs a copy to make')

  const noTool = nestSubject(makeProject(false), ['plate'])
  assert(noTool.gapFloor === null, 'no edge route, no floor')
  const noToolForm = initialNestForm(noTool)
  assert(validateNestForm(noToolForm, null) === 'gap-missing', 'the user must enter a gap')
  assert(validateNestForm({ ...noToolForm, gap: 3 }, null) === null, 'any positive gap then works')
  console.log('fresh subject and validation: PASSED')
}

function testNestedSubjectTargetsTheNest(): void {
  const project = makeProject(true)
  const subject = nestSubject(project, ['plate'])
  assert(subject.part.ok, 'part resolves')
  const settings = { ...nestSettingsFromForm(initialNestForm(subject)), quantity: 3, rotations: NEST_ROTATIONS.grain }
  const job = buildNestJob(subject.base, subject.part, settings)
  assert(job, 'job builds')
  const applied = applyNestToProject(project, {
    featureIds: subject.part.featureIds,
    placements: nest(requestFromJob(job)).placements,
    settings,
  })
  assert(applied, 'nest applies')
  const copyId = applied.copyIds[0]

  // Selecting any copy re-targets the nest: the base drops it again.
  const again = nestSubject(applied.project, [copyId])
  assert(again.replaceNest?.id === applied.nestId, 'a copy selects its nest')
  assert(again.part.ok && again.part.featureIds.join() === 'plate,pocket', 'the part is the nest sources, not the copy')
  assert(!again.base.nests && again.base.features.length === 2, 'the job runs on the project without that nest')
  const form = initialNestForm(again)
  assert(form.quantity === 3 && form.rotation === 'grain', 'the form reopens with the nest settings')
  console.log('nested subject: PASSED')
}

function testJobSurvivesStructuredClone(): void {
  const project = makeProject(true)
  const subject = nestSubject(project, ['plate'])
  assert(subject.part.ok, 'part resolves')
  const job = buildNestJob(subject.base, subject.part, nestSettingsFromForm(initialNestForm(subject)))
  assert(job, 'job builds')
  // What postMessage does to it: functions would throw here.
  const cloned = structuredClone(job)
  assert(JSON.stringify(nest(requestFromJob(cloned))) === JSON.stringify(nest(requestFromJob(job))), 'a cloned job packs identically')
  assert(presetForRotations([270, 0, 180, 90]) === 'quarter' && presetForRotations([180, 0]) === 'grain', 'presets round-trip')
  console.log('job crosses postMessage: PASSED')
}

testFreshSubject()
testNestedSubjectTargetsTheNest()
testJobSurvivesStructuredClone()
console.log('All nest panel state tests passed')
