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
 * Find pockets and holes, from the model in the project to features in the
 * tree (issue #1206 slices 2 and 3): the mesh generation uses, the detector,
 * the candidates, and the store action that draws them. The last block checks
 * the strongest promise of the slice — the drawn rows recreate the model.
 *
 * Mutation checks (each made the named block fail, then was reverted):
 * - `recognizedFeatures.ts`, folder appended at the end of the tree    -> placement
 * - `recognizedFeatures.ts`, `z_top`/`z_bottom` left at the import default -> drawn spans
 * - `recognizedFeatures.ts`, `authoringFace` set to Bottom             -> drawn
 * - `recognizedFeatures.ts`, refusal check removed from the plan       -> refusals
 * - `modelRecognitionSlice.ts`, history entry not pushed               -> one undo
 * - `candidates.ts`, `markAlreadyDrawn` ignores the span               -> already drawn
 * - `candidates.ts`, `markAlreadyDrawn` always false                   -> second run
 * - `candidates.ts`, rounding step 1e-2 in both units                  -> inches
 * - `candidates.ts`, no rounding (the fitted radius is 5.499982)       -> stored values
 * - `candidates.ts`, solids emitted after the cavities                 -> candidates: offered before every cavity
 *
 * Run with: npx tsx src/store/modelRecognitionFlow.test.ts
 */

import * as THREE from 'three'
import { buildScene, loadSTLTransformedGeometry } from '../engine/csg'
import { resolveFeatureZSpan } from '../engine/toolpaths/geometry'
import {
  candidatesFromResult,
  markAlreadyDrawn,
  recognizeCavities,
  type RecognitionCandidate,
} from '../engine/modelRecognition'
import { drawnFeaturesOf, defaultCheckedIds, shapesToDraw } from '../components/modelRecognition/candidateRows'
import { PLATE_MODEL_ID, plateModelProject, plateModelProjectWithVolume } from '../test/modelPlateFixture'
import { THEME_PALETTES } from '../theme/palette'
import { rectProfile, type Project, type SketchFeature } from '../types/project'
import { modelRecognitionRefusal } from './helpers/recognizedFeatures'
import { resolveFeatureInstance, resolvedProjectFeatures } from './helpers/resolveFeatures'
import { useProjectStore } from './projectStore'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertNear(actual: number, expected: number, message: string, tolerance = 1e-6): void {
  assert(Math.abs(actual - expected) <= tolerance, `${message}: expected ${expected}, got ${actual}`)
}

/** A closed mesh's volume, in project units cubed, from the divergence theorem. */
function meshVolume(mesh: THREE.Mesh): number {
  mesh.updateMatrixWorld(true)
  const indexed = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry
  const position = indexed.getAttribute('position')
  const a = new THREE.Vector3()
  const b = new THREE.Vector3()
  const c = new THREE.Vector3()
  let volume = 0
  for (let index = 0; index < position.count; index += 3) {
    a.fromBufferAttribute(position as THREE.BufferAttribute, index).applyMatrix4(mesh.matrixWorld)
    b.fromBufferAttribute(position as THREE.BufferAttribute, index + 1).applyMatrix4(mesh.matrixWorld)
    c.fromBufferAttribute(position as THREE.BufferAttribute, index + 2).applyMatrix4(mesh.matrixWorld)
    volume += a.dot(b.clone().cross(c)) / 6
  }
  return Math.abs(volume)
}

function candidatesFor(project: Project): RecognitionCandidate[] {
  const feature = resolveFeatureInstance(project, PLATE_MODEL_ID)
  assert(feature !== null, 'the model resolves')
  const mesh = loadSTLTransformedGeometry(feature!, project)
  assert(mesh !== null, 'the model has a mesh')
  const result = recognizeCavities(mesh!)
  return markAlreadyDrawn(candidatesFromResult(result, 'top', project.meta.units), drawnFeaturesOf(project))
}

const NAMES: Record<RecognitionCandidate['kind'], string> = {
  solid: 'Solid', throughHole: 'Hole', blindHole: 'Hole', throughPocket: 'Pocket', pocket: 'Pocket', island: 'Boss',
}

function drawAll(candidates: RecognitionCandidate[]): string[] {
  return useProjectStore.getState().addRecognizedFeatures({
    modelFeatureId: PLATE_MODEL_ID,
    folderName: 'Plate pockets and holes',
    shapes: shapesToDraw(candidates, new Set(defaultCheckedIds(candidates)), (candidate) => NAMES[candidate.kind]),
  })
}

/** Draw every top-level row, solids included, as a user who wants the part would. */
function drawEverything(candidates: RecognitionCandidate[]): string[] {
  const checked = new Set(
    candidates.filter((candidate) => candidate.parentId === null).map((candidate) => candidate.id),
  )
  return useProjectStore.getState().addRecognizedFeatures({
    modelFeatureId: PLATE_MODEL_ID,
    folderName: 'Plate pockets and holes',
    shapes: shapesToDraw(candidates, checked, (candidate) => NAMES[candidate.kind]),
  })
}

function load(project: Project): void {
  useProjectStore.getState().loadProject(project)
}

function byKind(candidates: RecognitionCandidate[], kind: RecognitionCandidate['kind']): RecognitionCandidate[] {
  return candidates.filter((candidate) => candidate.kind === kind)
}

// ---------------------------------------------------------------------------
// Candidates: what the plate offers, in tree order, with clean stored values
// ---------------------------------------------------------------------------
{
  const candidates = candidatesFor(await plateModelProject())
  assert(candidates.length === 6, `candidates: six rows, got ${candidates.length}`)
  assert(byKind(candidates, 'solid').length === 1, 'candidates: one solid')
  assert(byKind(candidates, 'pocket').length === 1, 'candidates: one pocket')
  assert(byKind(candidates, 'island').length === 1, 'candidates: one boss')
  assert(byKind(candidates, 'throughHole').length === 2, 'candidates: two through holes')
  assert(byKind(candidates, 'blindHole').length === 1, 'candidates: one counterbore')
  assert(candidates.every((candidate) => !candidate.alreadyDrawn), 'candidates: nothing drawn yet')
  assert(candidates[0].kind === 'solid', 'candidates: the solid is offered before every cavity')
  assert(candidates[0].id === 's0' && candidates[1].id === 'c0', 'candidates: solids are s0, cavities c0')

  const pocket = byKind(candidates, 'pocket')[0]
  const island = byKind(candidates, 'island')[0]
  assert(island.parentId === pocket.id, 'candidates: the boss belongs to the pocket')
  assert(candidates.indexOf(island) === candidates.indexOf(pocket) + 1, 'candidates: the boss follows its pocket')
  assert(island.operation === 'add' && pocket.operation === 'subtract', 'candidates: boss adds, pocket subtracts')

  // Stored values: the mesh is float32, so the raw numbers carry a tail
  // (14.000000953…). What is offered is what will be saved.
  assert(pocket.zTop === 20 && pocket.zBottom === 12, `stored values: pocket span is exact, got ${pocket.zTop}..${pocket.zBottom}`)
  assert(island.zBottom === 12 && island.zTop === 16, 'stored values: boss span is exact')
  const counterbore = byKind(candidates, 'blindHole')[0]
  assert(counterbore.circle!.radius === 5.5, `stored values: counterbore radius is exact, got ${counterbore.circle!.radius}`)
  assert(counterbore.circle!.center.x === 40 && counterbore.circle!.center.y === 30, 'stored values: counterbore centre is exact')
  assert(counterbore.zBottom === 14 && counterbore.zTop === 20, 'stored values: counterbore span is exact')
  const bolt = byKind(candidates, 'throughHole').find((candidate) => candidate.circle!.radius === 3.3)
  assert(bolt !== undefined && bolt.zTop === 14 && bolt.zBottom === 0, 'stored values: bolt hole stops at the step')
}

// ---------------------------------------------------------------------------
// Drawing: spans, face, kind, placement directly after the model, one undo
// ---------------------------------------------------------------------------
{
  const trailing = {
    id: 'later',
    name: 'Later feature',
    kind: 'rect',
    folderId: null,
    sketch: { profile: rectProfile(100, 100, 5, 5), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'add',
    z_top: 20,
    z_bottom: 0,
    visible: true,
    locked: false,
  } as unknown as SketchFeature
  load(await plateModelProject({ after: [trailing] }))
  const before = useProjectStore.getState().project
  const historyBefore = useProjectStore.getState().history.past.length
  const createdIds = drawAll(candidatesFor(before))
  const after = useProjectStore.getState().project
  assert(createdIds.length === 5, `drawing: five features created, got ${createdIds.length}`)
  assert(after.version === before.version, 'drawing: the project format version is unchanged')

  // Placement: model, then the new folder, then whatever came after the model.
  const tree = after.featureTree
  const modelIndex = tree.findIndex((entry) => entry.type === 'feature' && entry.featureId === PLATE_MODEL_ID)
  const folderEntry = tree[modelIndex + 1]
  assert(folderEntry?.type === 'folder', 'placement: a folder sits directly after the model')
  const folderId = folderEntry.type === 'folder' ? folderEntry.folderId : ''
  assert(after.featureFolders.find((folder) => folder.id === folderId)?.name === 'Plate pockets and holes', 'placement: it is the new folder')
  assert(tree[modelIndex + 2]?.type === 'feature', 'placement: the later feature now follows the folder')
  const order = after.features.map((feature) => feature.id)
  assert(order.indexOf(PLATE_MODEL_ID) < order.indexOf(createdIds[0]), 'placement: the shapes come after the model in feature order')
  assert(order.indexOf(createdIds[createdIds.length - 1]) < order.indexOf('later'), 'placement: and before the later feature')

  // Drawn spans, face and kind.
  const drawn = resolvedProjectFeatures(after).filter((feature) => createdIds.includes(feature.id))
  assert(drawn.every((feature) => feature.folderId === folderId), 'drawn: every shape is in the folder')
  assert(drawn.every((feature) => feature.authoringFace === 'top'), 'drawn: every shape is authored on Top')
  const counterbore = drawn.find((feature) => feature.z_top === 20 && feature.z_bottom === 14)
  assert(counterbore !== undefined, 'drawn spans: the counterbore is 20..14')
  assert(counterbore!.kind === 'circle' && counterbore!.operation === 'subtract', 'drawn: the counterbore is a circle subtract')
  const bolt = drawn.find((feature) => feature.z_top === 14 && feature.z_bottom === 0)
  assert(bolt !== undefined && bolt.kind === 'circle', 'drawn spans: the bolt hole is 14..0, a circle')
  const boss = drawn.find((feature) => feature.operation === 'add')
  assert(boss !== undefined && boss.z_top === 16 && boss.z_bottom === 12, 'drawn spans: the boss is 16..12')
  const pocket = drawn.find((feature) => feature.kind !== 'circle')
  assert(pocket !== undefined && pocket.z_top === 20 && pocket.z_bottom === 12, 'drawn spans: the pocket is 20..12')
  assert(order.indexOf(pocket!.id) < order.indexOf(boss!.id), 'drawn: the boss comes after its pocket')

  // One undo.
  assert(useProjectStore.getState().history.past.length === historyBefore + 1, 'one undo: exactly one history entry')
  useProjectStore.getState().undo()
  const undone = useProjectStore.getState().project
  assert(undone.features.length === before.features.length, 'one undo: every shape is gone')
  assert(undone.featureFolders.length === before.featureFolders.length, 'one undo: the folder is gone')
}

// ---------------------------------------------------------------------------
// A second run offers nothing new
// ---------------------------------------------------------------------------
{
  load(await plateModelProject())
  drawAll(candidatesFor(useProjectStore.getState().project))
  const again = candidatesFor(useProjectStore.getState().project)
  assert(again.length === 6, 'second run: the same six rows')
  assert(
    again.filter((candidate) => candidate.kind !== 'solid').every((candidate) => candidate.alreadyDrawn),
    'second run: every cavity row is already drawn',
  )
  assert(byKind(again, 'solid').every((candidate) => !candidate.alreadyDrawn), 'second run: the solid was never checked')
  assert(defaultCheckedIds(again).length === 0, 'second run: nothing starts checked')
  assert(drawAll(again).length === 0, 'second run: adding draws nothing')

  // Already drawn means the same span, not only the same outline: a shape the
  // user made deeper is a different feature.
  const project = useProjectStore.getState().project
  const counterbore = project.features.find((feature) => feature.z_top === 20 && feature.z_bottom === 14)!
  useProjectStore.getState().updateFeature(counterbore.id, { z_bottom: 10 })
  const afterEdit = candidatesFor(useProjectStore.getState().project)
  const offered = afterEdit.filter((candidate) => !candidate.alreadyDrawn && candidate.kind !== 'solid')
  assert(offered.length === 1 && offered[0].kind === 'blindHole', 'already drawn: the edited counterbore is offered again')
}

// ---------------------------------------------------------------------------
// The model in a folder: the new folder follows that folder
// ---------------------------------------------------------------------------
{
  load(await plateModelProject())
  const modelFolderId = useProjectStore.getState().addFeatureFolder()
  useProjectStore.getState().assignFeaturesToFolder([PLATE_MODEL_ID], modelFolderId)
  const project = useProjectStore.getState().project
  assert(project.features.find((feature) => feature.id === PLATE_MODEL_ID)?.folderId === modelFolderId, 'folder: the model is in a folder')
  drawAll(candidatesFor(project))
  const tree = useProjectStore.getState().project.featureTree
  const index = tree.findIndex((entry) => entry.type === 'folder' && entry.folderId === modelFolderId)
  assert(tree[index + 1]?.type === 'folder' && tree[index + 1] !== tree[index], 'folder: the shapes folder follows the model folder')
}

// ---------------------------------------------------------------------------
// Off the origin, and in inches
// ---------------------------------------------------------------------------
{
  const placed = candidatesFor(await plateModelProject({ origin: { x: 100, y: -30 } }))
  const hole = placed.find((candidate) => candidate.circle?.radius === 3)
  assert(hole !== undefined, 'placed: the 3 mm hole is found')
  assertNear(hole!.circle!.center.x, 140, 'placed: hole centre X')
  assertNear(hole!.circle!.center.y, -20, 'placed: hole centre Y')

  const inch = 1 / 25.4
  const project = await plateModelProject({ units: 'inch' })
  const inches = candidatesFor(project)
  assert(inches.length === 6, `inches: six rows, got ${inches.length}`)
  const counterbore = byKind(inches, 'blindHole')[0]
  assertNear(counterbore.circle!.radius, 5.5 * inch, 'inches: counterbore radius', 1e-5)
  assertNear(counterbore.zBottom, 14 * inch, 'inches: counterbore floor', 1e-5)
  // Five decimals of an inch: the stored number has no float32 tail.
  assert(Number(counterbore.zBottom.toFixed(5)) === counterbore.zBottom, 'inches: stored to five decimals')
  load(project)
  assert(drawAll(inches).length === 5, 'inches: all five cavities are drawn')
  assert(
    candidatesFor(useProjectStore.getState().project)
      .filter((candidate) => candidate.kind !== 'solid')
      .every((candidate) => candidate.alreadyDrawn),
    'inches: a second run offers nothing new',
  )
}

// ---------------------------------------------------------------------------
// Refusals: nothing is drawn and nothing enters history
// ---------------------------------------------------------------------------
{
  const project = await plateModelProject()
  assert(modelRecognitionRefusal(project, PLATE_MODEL_ID) === null, 'refusals: an imported model on Top is offered')
  assert(modelRecognitionRefusal(project, 'missing') === 'notAModel', 'refusals: a missing feature')
  assert(modelRecognitionRefusal(project, null) === 'notAModel', 'refusals: no feature')

  const plasma: Project = { ...project, meta: { ...project.meta, projectType: 'plasma' } }
  assert(modelRecognitionRefusal(plasma, PLATE_MODEL_ID) === 'plasma', 'refusals: a plasma project')

  const around: Project = {
    ...project,
    features: project.features.map((feature) => (
      feature.id === PLATE_MODEL_ID ? { ...feature, authoringFace: 'around' as const } : feature
    )),
  }
  assert(modelRecognitionRefusal(around, PLATE_MODEL_ID) === 'aroundModel', 'refusals: a model on the Around sheet')

  const candidates = candidatesFor(project)
  load(plasma)
  const historyBefore = useProjectStore.getState().history.past.length
  assert(drawAll(candidates).length === 0, 'refusals: a refused model draws nothing')
  assert(useProjectStore.getState().history.past.length === historyBefore, 'refusals: and adds no history entry')
  assert(useProjectStore.getState().project.featureFolders.length === plasma.featureFolders.length, 'refusals: and no folder')

  load(project)
  const none = useProjectStore.getState().addRecognizedFeatures({
    modelFeatureId: PLATE_MODEL_ID, folderName: 'Empty', shapes: [],
  })
  assert(none.length === 0 && useProjectStore.getState().project.featureFolders.length === 0, 'refusals: no shapes, no folder')
}

// ---------------------------------------------------------------------------
// Recreating the model: the solid first, the cavities cutting it
// ---------------------------------------------------------------------------
{
  const { project, volume } = await plateModelProjectWithVolume()
  load(project)
  const candidates = candidatesFor(project)
  const solid = candidates.find((candidate) => candidate.kind === 'solid')
  assert(solid !== undefined, 'recreating: the plate is offered as a solid')
  assert(candidates.indexOf(solid!) === 0, 'recreating: the solid is offered before every cavity')

  const created = drawEverything(candidates)
  const after = useProjectStore.getState().project
  const drawnSolid = resolvedProjectFeatures(after).find((feature) => feature.id === created[0])
  assert(drawnSolid !== undefined, 'recreating: the first drawn feature is the solid')
  assert(drawnSolid!.operation === 'add', 'recreating: the solid is an add')
  const solidSpan = resolveFeatureZSpan(after, drawnSolid!)
  assertNear(solidSpan.min, 0, 'recreating: the solid starts at the underside', 1e-4)
  assertNear(solidSpan.max, 20, 'recreating: the solid is the plate height', 1e-4)

  const order = after.features.map((feature) => feature.id)
  const subtracts = resolvedProjectFeatures(after)
    .filter((feature) => created.includes(feature.id) && feature.operation === 'subtract')
  assert(subtracts.length > 0, 'recreating: the run draws subtracts too')
  for (const subtract of subtracts) {
    assert(
      order.indexOf(drawnSolid!.id) < order.indexOf(subtract.id),
      'recreating: the solid comes before every subtract of the run',
    )
  }

  // With the model taken away, the drawn shapes alone must be the part: the
  // same CSG the 3D view folds, so the volume is the model's own.
  const withoutModel: Project = {
    ...after,
    features: after.features.filter((feature) => feature.id !== PLATE_MODEL_ID),
  }
  const scene = await buildScene(withoutModel, THEME_PALETTES.dark.three)
  assert(scene.modelMesh !== null, 'recreating: the drawn shapes build a solid')
  assertNear(meshVolume(scene.modelMesh!), volume, 'recreating: the recreated part is the model', volume * 0.005)

  // A second run lists the solid as already drawn.
  const again = candidatesFor(useProjectStore.getState().project)
  const solidAgain = again.find((candidate) => candidate.kind === 'solid')!
  assert(solidAgain.alreadyDrawn, 'recreating: a second run lists the solid as already drawn')
  assert(defaultCheckedIds(again).length === 0, 'recreating: nothing starts checked on a second run')
}

console.log('store/modelRecognitionFlow.test.ts: all assertions passed')
