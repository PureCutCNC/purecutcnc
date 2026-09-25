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
 * job runs on, the gap floor, presets, form validation, and what counts as an
 * edit under the keep-improving search (#864).
 *
 * Run with: npx tsx src/components/nesting/nestForm.test.ts
 */

import { nest } from '../../engine/nesting'
import { buildNestJob } from '../../store/helpers/nestPart'
import { applyNestToProject } from '../../store/helpers/nestApply'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { normalizeProject, type ProjectFormatInput } from '../../store/helpers/projectFormat'
import { requestFromJob } from '../../engine/nesting'
import { useProjectStore } from '../../store/projectStore'
import { projectWithFeatures } from '../../test/projectFixtures'
import { resolveFeatureInstance } from '../../store/helpers/resolveFeatures'
import { defaultStock, defaultTool, newProject, rectProfile, type Project, type SketchFeature } from '../../types/project'
import {
  NEST_ROTATION_STEPS,
  NEST_ROTATIONS,
  NO_MARGINS,
  initialNestForm,
  marginsLeaveRoom,
  nestSettingsFromForm,
  nestSubject,
  presetForRotations,
  rotationsForStep,
  stepOfPreset,
  validateNestForm,
  watchForEdits,
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
  assert(subject.parts.ok && subject.parts.parts.length === 1 && subject.parts.parts[0].featureIds.join() === 'plate,pocket', 'the pocket joins the part')
  assert(subject.gapFloor === 4.5, `gap floor is 4 + 2 × 0.25, got ${subject.gapFloor}`)
  const form = initialNestForm(subject)
  assert(form.gap === 4.5 && form.quantities.join() === '10' && form.rotation === 'quarter' && !form.keepOriginals, 'defaults')
  assert(validateNestForm(form, subject.gapFloor) === null, 'defaults are valid')
  assert(validateNestForm({ ...form, gap: 4 }, subject.gapFloor) === 'gap-below-tool', 'the gap cannot go below the tool')
  assert(validateNestForm({ ...form, gap: 6 }, subject.gapFloor) === null, 'the gap can be raised')
  assert(validateNestForm({ ...form, quantities: [0] }, subject.gapFloor) === 'quantity', 'at least one part')
  assert(validateNestForm({ ...form, quantities: [2.5] }, subject.gapFloor) === 'quantity', 'whole parts only')
  assert(validateNestForm({ ...form, quantities: [1], keepOriginals: true }, subject.gapFloor) === 'quantity', 'keeping the original needs a copy to make')
  assert(validateNestForm({ ...form, quantities: [1] }, subject.gapFloor) === null, 'one part moved in place is a valid arrangement')

  const noTool = nestSubject(makeProject(false), ['plate'])
  assert(noTool.gapFloor === null, 'no edge route, no floor')
  const noToolForm = initialNestForm(noTool)
  assert(validateNestForm(noToolForm, null) === 'gap-missing', 'the user must enter a gap')
  assert(validateNestForm({ ...noToolForm, gap: 3 }, null) === null, 'any positive gap then works')
  console.log('fresh subject and validation: PASSED')
}

function testSeveralPartsDefaultToArranging(): void {
  const base = makeProject(true)
  const project = normalizeProject(JSON.parse(JSON.stringify(projectWithFeatures(base, [
    ...base.features.map((feature) => resolveFeatureInstance(base, feature.id)!),
    rect('bracket', 'add', 60, 5, 20, 20),
  ]))) as ProjectFormatInput)
  const subject = nestSubject(project, ['plate', 'bracket'])
  assert(subject.parts.ok && subject.parts.parts.length === 2, 'two parts')
  const form = initialNestForm(subject)
  assert(form.quantities.join() === '1,1', 'several parts default to one each, which arranges them')
  assert(validateNestForm({ ...form, keepOriginals: true }, subject.gapFloor) === 'quantity', 'keeping every original with nothing to copy is empty')
  assert(validateNestForm({ ...form, quantities: [1, 3], keepOriginals: true }, subject.gapFloor) === null, 'one part with copies is enough')
  console.log('several parts: PASSED')
}

function testNestedSubjectTargetsTheNest(): void {
  const project = makeProject(true)
  const subject = nestSubject(project, ['plate'])
  assert(subject.parts.ok, 'part resolves')
  const settings = { ...nestSettingsFromForm(initialNestForm(subject)), rotations: NEST_ROTATIONS.grain }
  const job = buildNestJob(subject.base, subject.parts.parts, [3], settings)
  assert(job, 'job builds')
  const applied = applyNestToProject(project, {
    parts: [{ featureIds: subject.parts.parts[0].featureIds, quantity: 3 }],
    placements: nest(requestFromJob(job)).placements,
    settings,
  })
  assert(applied, 'nest applies')
  const copyId = applied.copyIds[0]

  // Selecting any copy re-targets the nest: the base drops it again.
  const again = nestSubject(applied.project, [copyId])
  assert(again.replaceNest?.id === applied.nestId, 'a copy selects its nest')
  assert(again.parts.ok && again.parts.parts[0].featureIds.join() === 'plate,pocket', 'the part is the nest sources, not the copy')
  assert(!again.base.nests && again.base.features.length === 2, 'the job runs on the project without that nest')
  const form = initialNestForm(again)
  assert(form.quantities.join() === '3' && form.rotation === 'grain', 'the form reopens with the nest settings')
  console.log('nested subject: PASSED')
}

function testJobSurvivesStructuredClone(): void {
  const project = makeProject(true)
  const subject = nestSubject(project, ['plate'])
  assert(subject.parts.ok, 'part resolves')
  const form = initialNestForm(subject)
  const job = buildNestJob(subject.base, subject.parts.parts, form.quantities, nestSettingsFromForm(form))
  assert(job, 'job builds')
  // What postMessage does to it: functions would throw here.
  const cloned = structuredClone(job)
  assert(JSON.stringify(nest(requestFromJob(cloned))) === JSON.stringify(nest(requestFromJob(job))), 'a cloned job packs identically')
  assert(presetForRotations([270, 0, 180, 90]) === 'quarter' && presetForRotations([180, 0]) === 'grain', 'presets round-trip')
  console.log('job crosses postMessage: PASSED')
}

function testRotationStepsRoundTrip(): void {
  assert(rotationsForStep(45).join() === '0,45,90,135,180,225,270,315', 'a step lists every multiple below a full turn')
  assert(NEST_ROTATION_STEPS.every((step) => Number.isInteger(360 / step)), 'every offered step divides a full turn')
  for (const preset of Object.keys(NEST_ROTATIONS) as (keyof typeof NEST_ROTATIONS)[]) {
    const shuffled = [...NEST_ROTATIONS[preset]].reverse()
    assert(presetForRotations(shuffled) === preset, `${preset} round-trips in any order`)
  }
  assert(stepOfPreset('step15') === 15 && stepOfPreset('quarter') === null, 'a step preset names its angle')
  assert(presetForRotations([0, 45]) === 'quarter', 'an unknown list falls back to quarter turns')

  // A nest made with a step reopens with that step.
  const project = makeProject(true)
  const subject = nestSubject(project, ['plate'])
  assert(subject.parts.ok, 'part resolves')
  const settings = nestSettingsFromForm({ ...initialNestForm(subject), rotation: 'step30' })
  assert(settings.rotations.length === 12, 'a 30° step tries twelve angles')
  const job = buildNestJob(subject.base, subject.parts.parts, [3], settings)
  assert(job, 'job builds')
  const applied = applyNestToProject(project, {
    parts: [{ featureIds: subject.parts.parts[0].featureIds, quantity: 3 }],
    placements: nest(requestFromJob(job)).placements,
    settings,
  })
  assert(applied, 'nest applies')
  assert(initialNestForm(nestSubject(applied.project, [applied.copyIds[0]])).rotation === 'step30', 'the form reopens on the step')
  console.log('rotation steps round-trip: PASSED')
}

function testMarginsFormAndRecord(): void {
  const project = makeProject(true)
  const subject = nestSubject(project, ['plate'])
  assert(subject.parts.ok, 'part resolves')
  const fresh = initialNestForm(subject)
  assert(JSON.stringify(fresh.margins) === JSON.stringify(NO_MARGINS), 'a new nest starts without margins')
  assert(!('margins' in nestSettingsFromForm(fresh)), 'no margins are stored as none')

  const check = (margins: typeof NO_MARGINS) => validateNestForm({ ...fresh, margins }, subject.gapFloor, marginsLeaveRoom(subject, margins))
  assert(check({ ...NO_MARGINS, left: -1 }) === 'margin-invalid', 'a negative margin is refused')
  assert(check({ ...NO_MARGINS, top: Number.NaN }) === 'margin-invalid', 'an empty margin is refused')
  assert(check({ ...NO_MARGINS, left: 120, right: 120 }) === 'margins-no-room', 'margins wider than the stock leave no room')
  assert(check({ top: 5, bottom: 10, left: 15, right: 20 }) === null, 'sensible margins pass')

  // A nest made with margins stores them, survives save and load, and reopens with them.
  const margins = { top: 5, bottom: 10, left: 15, right: 20 }
  const settings = nestSettingsFromForm({ ...fresh, quantities: [2], margins })
  const job = buildNestJob(subject.base, subject.parts.parts, [2], settings)
  assert(job, 'job builds')
  const applied = applyNestToProject(project, {
    parts: [{ featureIds: subject.parts.parts[0].featureIds, quantity: 2 }],
    placements: nest(requestFromJob(job)).placements,
    settings,
  })
  assert(applied, 'nest applies')
  const saved = JSON.parse(JSON.stringify(applied.project)) as ProjectFormatInput
  const loaded = normalizeProject(JSON.parse(JSON.stringify(saved)) as ProjectFormatInput)
  assert(JSON.stringify(loaded.nests?.[0].settings.margins) === JSON.stringify(margins), 'margins survive save and load')
  assert(JSON.stringify(initialNestForm(nestSubject(loaded, [applied.copyIds[0]])).margins) === JSON.stringify(margins), 'the form reopens with them')

  // Records from before margins, and partial or bad ones, read side by side as 0.
  const reload = (value: unknown) => {
    const copy = JSON.parse(JSON.stringify(saved)) as { nests: { settings: Record<string, unknown> }[] }
    copy.nests[0].settings.margins = value
    return normalizeProject(copy as unknown as ProjectFormatInput).nests?.[0].settings.margins
  }
  assert(reload(undefined) === undefined, 'a record without margins has none')
  assert(JSON.stringify(reload({ top: 5, left: 'x', right: -2 })) === JSON.stringify({ top: 5, bottom: 0, left: 0, right: 0 }), 'missing or bad sides read as 0')
  assert(reload({ top: 0, bottom: 0 }) === undefined, 'all-zero margins are none')
  console.log('margins in the form and the record: PASSED')
}

function testRevealingAFolderIsNotAnEdit(): void {
  useProjectStore.setState({ project: makeProject(true), history: { past: [], future: [], transactionStart: null }, dirty: false })
  const store = () => useProjectStore.getState()
  const subject = nestSubject(store().project, ['plate'])
  const form = initialNestForm(subject)
  const parts = subject.parts.ok ? subject.parts.parts : []
  const job = buildNestJob(subject.base, parts, [3], nestSettingsFromForm(form))!
  const apply = (amend: boolean, replaceNestId?: string) => store().applyNest({
    parts: parts.map((part) => ({ featureIds: part.featureIds, quantity: 3 })),
    placements: nest(requestFromJob(job)).placements,
    settings: nestSettingsFromForm(form),
    replaceNestId,
    amend,
  })
  const nestId = apply(false)!

  const edits = watchForEdits(() => store().history)
  const folder = store().project.featureFolders.find((entry) => entry.name === store().project.nests![0].name)!
  assert(folder.collapsed, 'a nest folder starts collapsed')
  // What FeatureTree does when the nest's copies get selected.
  const before = store().project
  store().revealFeatureFolder(folder.id)
  assert(store().project !== before, 'revealing the folder writes the project')
  assert(!edits.edited(), 'a revealed folder is not an edit')

  const amendedId = apply(true, nestId)
  edits.accept()
  assert(!edits.edited(), 'the search accepts its own layout')
  store().discardNest(amendedId!)
  assert(edits.edited(), 'discarding the nest is an edit')
  edits.accept()
  store().undo()
  assert(edits.edited(), 'undo is an edit')
  console.log('revealing a folder is not an edit: PASSED')
}

testFreshSubject()
testSeveralPartsDefaultToArranging()
testNestedSubjectTargetsTheNest()
testJobSurvivesStructuredClone()
testRotationStepsRoundTrip()
testMarginsFormAndRecord()
testRevealingAFolderIsNotAnEdit()
console.log('All nest panel state tests passed')
