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

// #957 attached starts: generator output, linked instances, transforms, units/history/save/open and safety.
import assert from 'node:assert/strict'
import type { Matrix2D, Operation, SketchFeature, SketchProfile } from '../../types/project'
import { newProject } from '../../types/project'
import { defaultPlasmaTool } from '../../toolPolicy'
import { projectWithFeatures } from '../../test/projectFixtures'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { useProjectStore } from '../../store/projectStore'
import { decodeProjectFormat } from '../../store/helpers/projectFormat'
import { mergeCamjFolders } from '../../import/camj'
import { resolveProject } from '../../store/helpers/resolveFeatures'
import { expandFeatureGeometry } from '../../text'
import { flattenProfile } from './geometry'
import { pickPlasmaStartPoint } from '../../components/canvas/plasmaStartPoint'
import { convertProjectUnits } from '../../utils/units'
import { generatePlasmaProfileToolpath } from './plasma'
import { localPlasmaStartPoint } from './plasmaStartPoint'
const square: SketchProfile = { start: { x: 20, y: 20 }, segments: [
  { type: 'line', to: { x: 80, y: 20 } }, { type: 'line', to: { x: 80, y: 80 } },
  { type: 'line', to: { x: 20, y: 80 } }, { type: 'line', to: { x: 20, y: 20 } },
], closed: true }
const feature: SketchFeature = { id: 'part', name: 'Part', kind: 'rect', operation: 'add', folderId: null, visible: true, locked: false, z_top: 6, z_bottom: 0,
  sketch: { profile: square, dimensions: [], constraints: [], origin: { x: 0, y: 0 }, orientationAngle: 0 } }
const base = newProject('Attached starts', 'mm'); base.stock.thickness = 6
base.tools = [{ ...defaultPlasmaTool('mm'), id: 'torch', name: 'Torch', diameter: 2, cutHeight: 1.5 }]
const project = projectWithFeatures(base, [feature])
const op: Operation = { ...defaultOperationForTarget(project, 'plasma_profile', 'rough', { source: 'features', featureIds: ['part'] }, 0), plasmaLeadIn: 'line', plasmaLeadOutLength: 0, plasmaStartPoints: { part: { x: 50, y: 20 } } }
const firstCut = (p = project, operation = op) => generatePlasmaProfileToolpath(p, operation).moves.find((move) => move.kind === 'cut')!.from
assert.deepEqual(firstCut(), { x: 50, y: 19, z: 7.5 }, 'attached start controls actual kerf-offset contour entry')
for (const [matrix, world, entry] of [
  [{ a: 1, b: 0, c: 0, d: 1, e: 100, f: 80 }, { x: 150, y: 100 }, { x: 150, y: 99 }],
  [{ a: 0, b: 2, c: -2, d: 0, e: 300, f: 50 }, { x: 260, y: 150 }, { x: 261, y: 150 }],
  [{ a: 2, b: 0, c: 0, d: 2, e: 40, f: 30 }, { x: 140, y: 70 }, { x: 140, y: 69 }],
] as [Matrix2D, { x: number; y: number }, { x: number; y: number }][]) {
  const moved = structuredClone(project); moved.features[0].transform = matrix
  assert.deepEqual(localPlasmaStartPoint(matrix, world), { x: 50, y: 20 }, 'inverse placement stores local attachment')
  assert.deepEqual(firstCut(moved), { ...entry, z: 7.5 }, 'move/rotate/scale carries actual generated entry')
  assert.deepEqual(generatePlasmaProfileToolpath(moved, op).moves,
    generatePlasmaProfileToolpath(moved, { ...op, plasmaStartPoints: undefined, plasmaStartPoint: world }).moves, 'legacy absolute reads remain byte-identical')
}
const linked = structuredClone(project)
linked.features.push({ ...linked.features[0], id: 'linked', name: 'Linked', transform: { a: 1, b: 0, c: 0, d: 1, e: 150, f: 0 } })
const both = { ...op, target: { source: 'features' as const, featureIds: ['part', 'linked'] }, plasmaStartPoints: { part: { x: 37, y: 20 } } }
const automaticLinked = generatePlasmaProfileToolpath(linked, { ...op, target: { source: 'features', featureIds: ['linked'] }, plasmaStartPoints: undefined }).moves.filter((m) => m.kind === 'cut')
assert.deepEqual(generatePlasmaProfileToolpath(linked, both).moves.filter((m) => m.kind === 'cut' && m.from.x > 150), automaticLinked, 'unpicked linked instance stays automatic')
const independent = { ...both, plasmaStartPoints: { ...op.plasmaStartPoints, linked: { x: 20, y: 50 } } }
const result = generatePlasmaProfileToolpath(linked, independent)
assert.equal(result.moves.filter((m) => m.kind === 'plunge').length, 2)
assert.deepEqual(result.moves.find((m) => m.kind === 'cut' && m.from.x > 150)!.from, { x: 169, y: 50, z: 7.5 }, 'linked instances have independent choices')
const different = projectWithFeatures(base, [feature, { ...feature, id: 'small', name: 'Small', sketch: { ...feature.sketch, profile: {
  start: { x: 300, y: 20 }, segments: [{ type: 'line', to: { x: 340, y: 20 } }, { type: 'line', to: { x: 340, y: 40 } }, { type: 'line', to: { x: 300, y: 40 } }, { type: 'line', to: { x: 300, y: 20 } }], closed: true,
} } }])
const sizes = generatePlasmaProfileToolpath(different, { ...op, target: { source: 'features', featureIds: ['part', 'small'] }, plasmaStartPoints: { ...op.plasmaStartPoints, small: { x: 330, y: 20 } } })
assert.deepEqual(sizes.moves.find((m) => m.kind === 'cut' && m.from.x > 250)!.from, { x: 330, y: 19, z: 7.5 }, 'different-sized targets retain their own picks')
assert.equal(generatePlasmaProfileToolpath(project, { ...op, plasmaStartPoints: { part: { x: NaN, y: 20 } } }).moves.length, 0, 'invalid attachment refuses the contour')
const damaged = decodeProjectFormat(JSON.parse(JSON.stringify({ ...project, operations: [op] }).replace('"part":{"x":50,"y":20}', '"part":null'))).project
assert.equal(generatePlasmaProfileToolpath(damaged, damaged.operations[0]).moves.length, 0, 'a malformed saved override cannot silently become automatic')
const milling = { ...project, operations: [defaultOperationForTarget(project, 'pocket', 'rough', op.target, 0)] }
assert.equal(Object.hasOwn(convertProjectUnits(milling, 'inch').operations[0], 'plasmaStartPoints'), false, 'units do not backfill absent attached starts into milling')

const unsafe = projectWithFeatures(base, [feature, { ...feature, id: 'neighbour', sketch: { ...feature.sketch, profile: {
  start: { x: 48, y: 10 }, segments: [{ type: 'line', to: { x: 52, y: 10 } }, { type: 'line', to: { x: 52, y: 12 } }, { type: 'line', to: { x: 48, y: 12 } }, { type: 'line', to: { x: 48, y: 10 } }], closed: true,
} } }])
const refused = generatePlasmaProfileToolpath(unsafe, op)
assert.equal(refused.moves.length, 0, 'unsafe attached entry cannot silently relocate or cut a neighbour')
assert.ok(refused.warnings.some((warning) => warning.code === 'plasmaNoLead'))
const tiny = projectWithFeatures(base, [{ ...feature, operation: 'subtract', sketch: { ...feature.sketch, profile: {
  start: { x: 35, y: 35 }, segments: [{ type: 'line', to: { x: 43, y: 35 } }, { type: 'line', to: { x: 43, y: 43 } }, { type: 'line', to: { x: 35, y: 43 } }, { type: 'line', to: { x: 35, y: 35 } }], closed: true,
} } }])
const pickedTiny = generatePlasmaProfileToolpath(tiny, { ...op, plasmaStartPoints: { part: { x: 39, y: 35 } } })
assert.equal(pickedTiny.moves.length, 0, 'picked tiny-hole entry cannot silently become a centre pierce')
assert.ok(pickedTiny.warnings.some((warning) => warning.code === 'plasmaNoLead'))
assert.ok(generatePlasmaProfileToolpath(tiny, { ...op, plasmaStartPoints: undefined }).moves.length, 'unpicked tiny hole retains automatic warned centre fallback')
useProjectStore.setState({ project: linked, dirty: false, history: { past: [], future: [], transactionStart: null } })
const store = useProjectStore.getState()
const id = store.addOperation('plasma_profile', 'rough', both.target)!
store.updateOperation(id, { plasmaStartPoints: independent.plasmaStartPoints })
store.undo(); assert.equal(useProjectStore.getState().project.operations[0].plasmaStartPoints, undefined)
store.redo(); assert.deepEqual(useProjectStore.getState().project.operations[0].plasmaStartPoints, independent.plasmaStartPoints)
const saved = store.saveProject(); store.openProjectFromText(saved, null)
const reopened = useProjectStore.getState().project
assert.equal(reopened.version, '3.3')
assert.deepEqual(reopened.operations[0].plasmaStartPoints, independent.plasmaStartPoints, 'format 3.3 save/open preserves every local override')
assert.deepEqual(decodeProjectFormat(JSON.parse(saved)).project.operations[0].plasmaStartPoints, independent.plasmaStartPoints)
const inch = convertProjectUnits(reopened, 'inch')
assert.deepEqual(inch.operations[0].plasmaStartPoints, { part: { x: 50 / 25.4, y: 20 / 25.4 }, linked: { x: 20 / 25.4, y: 50 / 25.4 } })
assert.ok(Math.abs(firstCut(inch, { ...inch.operations[0], plasmaLeadIn: 'line' }).x * 25.4 - 50) < 0.01, 'unit conversion preserves the physical attached entry')
const restored = convertProjectUnits(inch, 'mm')
assert.ok(Math.abs(restored.operations[0].plasmaStartPoints!.linked.y - 50) < 1e-10)
const legacy = { ...op, plasmaStartPoints: undefined, plasmaStartPoint: { x: 50, y: 20 } }
assert.deepEqual(generatePlasmaProfileToolpath(project, legacy).moves, generatePlasmaProfileToolpath(project, op).moves)

const source = structuredClone(linked)
source.featureFolders = [{ id: 'source-folder', name: 'Parts', collapsed: false }]
source.features.forEach((feature) => { feature.folderId = 'source-folder' })
source.featureTree = [{ type: 'folder', folderId: 'source-folder' }]
source.operations = [independent]
const imported = mergeCamjFolders({ currentProject: newProject('Destination', 'inch'), sourceProject: source, selectedFolderIds: ['source-folder'] }).project
const importedOp = imported.operations[0]
assert.ok(importedOp, 'plasma operation imports with all of its features')
assert.equal(Object.hasOwn(importedOp.plasmaStartPoints!, 'part'), false, 'old feature IDs are remapped')
for (const feature of imported.features) {
  const original = source.features.find((candidate) => candidate.name === feature.name)!
  const expected = independent.plasmaStartPoints[original.id as keyof typeof independent.plasmaStartPoints]!
  assert.deepEqual(importedOp.plasmaStartPoints![feature.id], { x: expected.x / 25.4, y: expected.y / 25.4 }, 'import remaps attached point IDs after converting source units')
}
assert.ok(Math.abs(firstCut(imported, { ...importedOp, plasmaLeadIn: 'line' }).x * 25.4 - 50) < 0.01, 'imported override still controls the physical entry')

const lettering = projectWithFeatures(base, [{ ...feature, id: 'letter', name: 'Letter', kind: 'text', text: { text: 'I', style: 'outline', fontId: 'helvetiker_regular', size: 80 } }])
const letter = resolveProject(lettering).features[0]
const contour = expandFeatureGeometry(letter, false).find((shape) => shape.operation === 'add' && shape.sketch.profile.closed)!
assert.ok(contour, 'outline text provides a real closed contour')
const ring = flattenProfile(contour.sketch.profile).points
const textEntry = { x: (ring[0].x + ring[1].x) / 2, y: (ring[0].y + ring[1].y) / 2 }
const textOp = { ...op, target: { source: 'features' as const, featureIds: ['letter'] }, plasmaStartPoints: { [contour.id]: localPlasmaStartPoint(letter.transform, textEntry)! } }
assert.equal(pickPlasmaStartPoint(lettering, textOp, textEntry, 0.01)!.contourId, contour.id, 'pick identifies the expanded text contour')
const textResult = generatePlasmaProfileToolpath(lettering, textOp)
assert.ok(textResult.moves.length, 'picked outline text generates safely')
assert.deepEqual(textResult.moves, generatePlasmaProfileToolpath(lettering, { ...textOp, plasmaStartPoints: undefined, plasmaStartPoint: textEntry }).moves)
lettering.featureFolders = source.featureFolders
lettering.features[0].folderId = 'source-folder'
lettering.featureTree = source.featureTree
lettering.operations = [textOp]
const importedText = mergeCamjFolders({ currentProject: { ...newProject('Text destination', 'mm'), stock: structuredClone(lettering.stock) }, sourceProject: lettering, selectedFolderIds: ['source-folder'] }).project
const importedContourId = expandFeatureGeometry(resolveProject(importedText).features[0], false)[0].id
assert.notEqual(importedContourId, contour.id)
assert.deepEqual(importedText.operations[0].plasmaStartPoints, { [importedContourId]: textOp.plasmaStartPoints[contour.id] }, 'import preserves expanded text contour attachment under the new instance ID')
assert.deepEqual(generatePlasmaProfileToolpath(importedText, importedText.operations[0]).moves, textResult.moves)
console.log('attached plasma starts: transforms, linked defaults, safety, units/history/format 3.3, legacy, import and text passed')
