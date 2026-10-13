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
import { useProjectStore } from '../projectStore'
import { switchWorkspaceFace, requestAuthoringFaceChange } from '../workspaceFace'
import { defaultTool, newProject, rectProfile, roundStock } from '../../types/project'
import type { Project, SketchFeature } from '../../types/project'
import { bundledMachines } from '../../machine/registry'
import { projectWithFeatures } from '../../test/projectFixtures'
import { activeFace, activeSetup, aroundUnavailableReason, newFeatureSpan, faceArtworkMirror, activeOriginInStock, originPlacementFromStock, faceAngles, faceOffsets, projectUsesBothFaces, featuresAtActiveFace } from './activeFace'
import { provisionalSetupId } from './provisionalSetup'
import { decodeProjectFormat } from './projectFormat'
import { decodeSetups, findSetupWithTurn, syncProjectSetups } from './setups'
import { featureReachableFromFace, targetAllowedInSetup, setupGenerationBlock, isThroughFeature } from '../../engine/setupTargets'
import { computeOperationToolpath } from '../../engine/toolpaths/generateOperation'
import { planOperationMove } from '../../engine/setupOperationMove'
import { operationCutRange, throughFeatureCoverage } from '../../engine/setupReach'
import { createCamPlan } from '../../engine/operations/camPlan'
import { materializeCamPlan } from './camPlanApply'
import { selectedVisibleClipboardFeatures, pasteClipboardFeatures } from '../../platform/featureClipboard'
import { resolveFeatureInstance } from './resolveFeatures'
import { referenceProjectFeatures } from './referenceFeatures'
import { inferLineTopZFromEnclosingFeature } from './manualFeatureOperation'

const store = () => useProjectStore.getState()
function feature(id: string, bottom = 35): SketchFeature {
  return { id, name: id, kind: 'rect', folderId: null, sketch: { profile: rectProfile(40, 10, 15, 12), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] }, operation: 'subtract', z_top: 40, z_bottom: bottom, visible: true, locked: false }
}
function fixture(axis: 'x' | 'y' = 'x'): Project {
  const base = newProject('Around model', 'mm')
  base.stock = roundStock(40, 180, axis)
  const machine = { ...structuredClone(bundledMachines()[0]), id: 'around-machine', rotary: { about: axis, drive: 'own' as const, reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } } }
  base.meta.machineDefinitions = [machine]
  base.meta.selectedMachineId = machine.id
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', diameter: 2, maxCutDepth: 25 }]
  return projectWithFeatures(base, [{ ...feature('base'), operation: 'add', z_bottom: 0 }, { ...feature('through', 0), authoringFace: 'top' }])
}
function load(project = fixture()): void { store().loadProject(project) }

console.log('Around store creation, generation and file round trip')
load()
assert.equal(aroundUnavailableReason(store().project), null)
assert.equal(switchWorkspaceFace('around'), true)
assert.equal(store().project.setups.length, 1)
assert.equal(activeSetup(store().project).id, provisionalSetupId('around'))
assert.equal(activeSetup(store().project).kind, 'around')
assert.deepEqual(newFeatureSpan(store().project, 35), { z_top: 35, z_bottom: 0 }, 'Around new span is Top-style')
store().addFeature(feature('around'))
const aroundProject = store().project
const setup = activeSetup(aroundProject)
assert.equal(setup.kind, 'around')
assert.notEqual(setup.id, provisionalSetupId('around'))
assert.deepEqual(setup.orientation, { axis: 'x', angleDeg: 0 })
assert.equal(setup.indexing, 'manual')
assert.equal(aroundProject.features.at(-1)!.authoringFace, 'around')
assert.equal(store().createSetup({ kind: 'around', orientation: { axis: 'x', angleDeg: 0 } }), null, 'at most one Around setup')
assert.equal(store().updateSetup(setup.id, { flipAxis: 'y' }), false)
const target = { source: 'features' as const, featureIds: ['around'] }
const pocket = store().addOperation('pocket', 'rough', target)!
const engrave = store().addOperation('follow_line', 'finish', target)!
assert.ok(pocket && engrave)
for (const id of [pocket, engrave]) store().updateOperation(id, { toolRef: 't1', entryStrategy: 'plunge', stepdown: 2, carveDepth: 1 })
const beforeSave = store().project
const paths = beforeSave.operations.map((operation) => computeOperationToolpath(beforeSave, operation)!.result)
for (const path of paths) {
  assert.ok(path.moves.length > 0, 'nonempty rotary motion')
  assert.ok(path.moves.every((move) => move.from.a !== undefined && move.to.a !== undefined), 'A on every point')
}
const file = JSON.parse(store().saveProject()) as Project
assert.equal(file.version, '3.3')
assert.equal(file.setups.find(row => row.id === setup.id)!.kind, 'around', 'saved Around kind is retained')
const decoded = decodeProjectFormat(file).project
assert.deepEqual(JSON.parse(JSON.stringify(decoded)), file, 'file round trip retains all model fields including kind')
store().openProjectFromText(JSON.stringify(file), null)
assert.deepEqual(JSON.parse(JSON.stringify(store().project)), file, 'store reload retains model')
assert.deepEqual(store().project.operations.map((operation) => computeOperationToolpath(store().project, operation)!.result), paths, 'reload generates identical paths')
const current = store().project
assert.deepEqual(operationCutRange(current, current.operations[0], paths[0], 'around'), { min: 35, max: 40 }, 'wrapped reach uses unrolled footprint and Top heights')
assert.equal(projectUsesBothFaces(current), true)
assert.equal(faceArtworkMirror(current, { x: 5, y: 6 }), null)
assert.deepEqual(activeOriginInStock(current), current.origin)
assert.deepEqual(originPlacementFromStock(current, { x: 5, y: 6 }), { x: 5, y: 6 })
assert.equal(faceAngles(current).turn(30), 30)
assert.equal(faceAngles(current).direction(30), 30)
assert.equal(faceOffsets(current).y(12), 12)
assert.equal(inferLineTopZFromEnclosingFeature(current, rectProfile(42, 12, 2, 2), 40), 35)
assert.deepEqual(featuresAtActiveFace(current, current.features).map((row) => row.id), ['around'])
assert.deepEqual(referenceProjectFeatures(current, true).map((row) => row.id), ['around'])

console.log('Around model refusals and generation blocks')
const aroundFeature = current.features.find((row) => row.id === 'around')!
const topFeature = current.features.find((row) => row.id === 'through')!
assert.equal(featureReachableFromFace(current, topFeature, 'around'), false, 'through Top never enters Around')
assert.equal(featureReachableFromFace(current, aroundFeature, 'top'), false)
assert.equal(isThroughFeature(current, { ...aroundFeature, z_bottom: 0 }), false)
assert.equal(targetAllowedInSetup(current, { source: 'features', featureIds: ['through'] }, setup.id), false)
assert.equal(targetAllowedInSetup(current, target, current.setups[0].id), false)
assert.equal(store().addOperation('pocket', 'rough', { source: 'features', featureIds: ['through'] }), null)
assert.equal(requestAuthoringFaceChange(['around']), false)
store().setFeatureAuthoringFace(['around'], 'top')
assert.equal(store().project, current)
store().setFeatureAuthoringFace(['through'], 'around')
assert.equal(store().project, current)
store().assignOperationToSetup(pocket, current.setups[0].id)
assert.equal(store().project, current)
store().startAddTabPlacement()
assert.equal(store().pendingAdd, null)
store().autoPlaceTabsForOperation(pocket)
assert.deepEqual(store().project.tabs, [])
store().addFeature({ ...feature('model'), kind: 'stl', operation: 'model' })
assert.equal(store().project, current, 'model import refused')
const cam = createCamPlan(current, [])
assert.ok(cam.operations.length > 0)
assert.ok(cam.operations.every((operation) => operation.hardError?.includes('Top setup only')))
assert.equal(materializeCamPlan(current, cam).ok, false)
assert.equal(throughFeatureCoverage(current, 'around', new Map()), null)
assert.throws(() => decodeSetups([{ ...setup, kind: 'sideways' }]), /kind/)
assert.throws(() => decodeSetups([{ ...setup, orientation: { axis: 'x', angleDeg: 180 } }]), /orientation/)
assert.throws(() => decodeSetups([{ ...setup, indexing: 'automatic' }]), /indexing/)
assert.throws(() => decodeSetups([setup, { ...setup, id: 'second' }]), /more than one/)
assert.equal(findSetupWithTurn([current.setups[0]], setup.orientation, 'around'), undefined, 'Around never matches Top')
assert.equal(findSetupWithTurn([setup], setup.orientation), undefined, 'Top never matches Around')
const tooDeep = { ...current, features: current.features.map((row) => row.id === 'around' ? { ...row, z_bottom: 20 } : row) }
assert.equal(setupGenerationBlock(tooDeep, current.operations[0])?.reason, 'aroundCentreline')
assert.deepEqual(computeOperationToolpath(tooDeep, current.operations[0])!.result.moves, [])
assert.equal(computeOperationToolpath(tooDeep, current.operations[0])!.result.warnings[0].code, 'aroundCentreline')
// A target on the wrong face is reported as that mismatch, not as the
// centreline block its low Z would otherwise trigger.
const flatTarget = { ...current, operations: current.operations.map((row, index) => index === 0
  ? { ...row, target: { source: 'features' as const, featureIds: ['through'] } } : row) }
assert.equal(setupGenerationBlock(flatTarget, flatTarget.operations[0])?.reason, 'crossFaceNotThrough', 'a rejected flat target reports the face, not the centreline')
const blockStock = { ...current, stock: newProject().stock }
assert.equal(setupGenerationBlock(blockStock, current.operations[0])?.reason, 'aroundStockMismatch')
assert.equal(computeOperationToolpath(blockStock, current.operations[0])!.result.warnings[0].code, 'aroundStockMismatch')
assert.deepEqual(syncProjectSetups(blockStock).features, current.features)
assert.deepEqual(syncProjectSetups(blockStock).operations, current.operations)
const wrongAxis = { ...current, stock: roundStock(40, 180, 'y') }
assert.equal(setupGenerationBlock(wrongAxis, current.operations[0])?.reason, 'aroundStockMismatch')
assert.equal(syncProjectSetups(wrongAxis).setups.find((row) => row.kind === 'around')!.orientation.axis, 'y')
for (const [project, reason] of [
  [ { ...fixture(), stock: newProject().stock }, 'needsRoundBar' ],
  [ { ...fixture(), meta: { ...fixture().meta, machineDefinitions: [], selectedMachineId: null } }, 'needsRotaryMachine' ],
  [ { ...fixture(), stock: roundStock(40, 180, 'y') }, 'machineAxisMismatch' ],
] satisfies Array<[Project, string]>) {
  load(project)
  assert.equal(aroundUnavailableReason(store().project), reason)
  assert.equal(switchWorkspaceFace('around'), false)
  assert.equal(store().createSetup({ kind: 'around', orientation: { axis: 'x', angleDeg: 0 } }), null)
  store().setActiveSetup(provisionalSetupId('around'))
  assert.equal(activeFace(store().project), 'top')
}
load(fixture('y'))
assert.equal(switchWorkspaceFace('around'), true)
assert.equal(activeSetup(store().project).orientation.axis, 'y', 'provisional axis follows bar')

console.log('Cross-domain paste preserves drawing and depth')
load()
store().addFeature({ ...feature('text'), kind: 'text', operation: 'line' })
const source = resolveFeatureInstance(store().project, 'text')!
const clipboard = selectedVisibleClipboardFeatures(store().project, ['text'])
const point = { x: 47.5, y: 16 }
assert.equal(switchWorkspaceFace('around'), true)
const [pasted] = pasteClipboardFeatures(store(), clipboard, point)
const onAround = resolveFeatureInstance(store().project, pasted)!
assert.deepEqual(onAround.sketch.profile, source.sketch.profile, 'paste applies no Bottom mirror')
assert.deepEqual(onAround.transform, source.transform)
assert.equal(onAround.authoringFace, 'around')
assert.equal(onAround.z_top, 40)
assert.equal(onAround.z_bottom, 35)
const reverse = selectedVisibleClipboardFeatures(store().project, [pasted])
assert.equal(switchWorkspaceFace('top'), true)
const [back] = pasteClipboardFeatures(store(), reverse, point)
const onTop = resolveFeatureInstance(store().project, back)!
assert.deepEqual(onTop.sketch.profile, source.sketch.profile)
assert.deepEqual(onTop.transform, source.transform)
assert.equal(onTop.z_top, 40)
assert.equal(onTop.z_bottom, 35)
assert.equal(onTop.authoringFace, 'top')
// No-kind files retain their exact file form, with save's timestamp held fixed.
const noKind = fixture()
const normalized = decodeProjectFormat(noKind).project
assert.equal(JSON.stringify(decodeProjectFormat(JSON.parse(JSON.stringify(normalized))).project), JSON.stringify(normalized), '3.3 no-kind file is byte-stable')
assert.ok(normalized.setups.every((row) => !('kind' in row)))
load(noKind)
const firstSave = JSON.parse(store().saveProject()) as Project
assert.ok(firstSave.setups.every((row) => !('kind' in row)), 'saving a flat setup writes no kind')
store().openProjectFromText(JSON.stringify(firstSave), null)
const secondSave = JSON.parse(store().saveProject()) as Project
assert.deepEqual(
  { ...secondSave, meta: { ...secondSave.meta, modified: 'fixed' } },
  { ...firstSave, meta: { ...firstSave.meta, modified: 'fixed' } },
  'a 3.3 file with no kind re-encodes identically',
)
console.log('All Around model tests passed')

// Bottom exchanges with Around under the same no-mirror, Top-height paste rule.
load()
assert.equal(switchWorkspaceFace('bottom'), true)
store().addFeature({ ...feature('bottom-text'), kind: 'text', operation: 'line', z_top: 5, z_bottom: 0 })
const bottomCopy = selectedVisibleClipboardFeatures(store().project, ['bottom-text'])
const bottomSource = resolveFeatureInstance(store().project, 'bottom-text')!
assert.equal(switchWorkspaceFace('around'), true)
const [fromBottom] = pasteClipboardFeatures(store(), bottomCopy, point)
const bottomOnAround = resolveFeatureInstance(store().project, fromBottom)!
assert.deepEqual(bottomOnAround.sketch.profile, bottomSource.sketch.profile)
assert.equal(bottomOnAround.z_top, 40)
assert.equal(bottomOnAround.z_bottom, 35)
const bottomReturn = selectedVisibleClipboardFeatures(store().project, [fromBottom])
assert.equal(switchWorkspaceFace('bottom'), true)
const [toBottom] = pasteClipboardFeatures(store(), bottomReturn, point)
assert.deepEqual(resolveFeatureInstance(store().project, toBottom)!.sketch.profile, bottomSource.sketch.profile)
assert.equal(store().project.features.find(row => row.id === toBottom)!.z_top, 40)
assert.equal(store().project.features.find(row => row.id === toBottom)!.z_bottom, 35)
// Stock-targeted operations are also barred from moving between domains.
load(current)
assert.equal(switchWorkspaceFace('top'), true)
assert.equal(store().addOperation('pocket', 'rough', target), null, 'Top store refuses an Around target')
// A stock target judges no feature, so without the domain guard the move would
// look free; the guard refuses it before any target is judged.
const stockOperation = { ...current.operations[0], id: 'stock-op', setupId: undefined, target: { source: 'stock' as const } }
const stockMove = planOperationMove({ ...current, operations: [...current.operations, stockOperation] }, 'stock-op', setup.id)
assert.equal(stockMove.blocked, 'noValidTargets', 'stock-target move between domains is blocked')
assert.deepEqual(stockMove.kept, [])
const topOperation = store().addOperation('pocket', 'rough', { source: 'features', featureIds: ['through'] })!
assert.ok(topOperation, 'Top move fixture exists')
const beforeMove = store().project
store().assignOperationToSetup(topOperation, setup.id)
assert.equal(store().project, beforeMove)
store().setFeatureAuthoringFace(['through'], 'around')
assert.equal(store().project, beforeMove)
assert.equal(requestAuthoringFaceChange(['around']), false)
const model = { ...current, featureDefinitions: { ...current.featureDefinitions, [aroundFeature.definitionId]: { ...current.featureDefinitions[aroundFeature.definitionId], kind: 'stl' as const } } }
assert.equal(featureReachableFromFace(model, aroundFeature, 'around'), false, 'even same-face imported models are not Around targets')
assert.equal(targetAllowedInSetup(model, target, setup.id), false)

// A provisional view cannot become a new setup after its availability is lost.
load()
assert.equal(switchWorkspaceFace('around'), true)
store().setProjectMachine(null)
const unavailableProvisional = store().project
store().addFeature(feature('unavailable-feature'))
assert.equal(store().project, unavailableProvisional)
assert.equal(store().project.setups.some(row => row.kind === 'around'), false)
