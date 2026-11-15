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
 * tree (issue #1206 slice 2): the mesh generation uses, the detector, the
 * candidates, and the store action that draws them.
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
 *
 * Run with: npx tsx src/store/modelRecognitionFlow.test.ts
 */

import { loadSTLTransformedGeometry } from '../engine/csg'
import {
  candidatesFromResult,
  markAlreadyDrawn,
  recognizeCavities,
  type RecognitionCandidate,
} from '../engine/modelRecognition'
import { drawnFeaturesOf, defaultCheckedIds, shapesToDraw } from '../components/modelRecognition/candidateRows'
import { PLATE_MODEL_ID, plateModelProject } from '../test/modelPlateFixture'
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

function candidatesFor(project: Project): RecognitionCandidate[] {
  const feature = resolveFeatureInstance(project, PLATE_MODEL_ID)
  assert(feature !== null, 'the model resolves')
  const mesh = loadSTLTransformedGeometry(feature!, project)
  assert(mesh !== null, 'the model has a mesh')
  const result = recognizeCavities(mesh!)
  return markAlreadyDrawn(candidatesFromResult(result, 'top', project.meta.units), drawnFeaturesOf(project))
}

const NAMES: Record<RecognitionCandidate['kind'], string> = {
  throughHole: 'Hole', blindHole: 'Hole', throughPocket: 'Pocket', pocket: 'Pocket', island: 'Boss',
}

function drawAll(candidates: RecognitionCandidate[]): string[] {
  return useProjectStore.getState().addRecognizedFeatures({
    modelFeatureId: PLATE_MODEL_ID,
    folderName: 'Plate pockets and holes',
    shapes: shapesToDraw(candidates, new Set(defaultCheckedIds(candidates)), (candidate) => NAMES[candidate.kind]),
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
  assert(candidates.length === 5, `candidates: five rows, got ${candidates.length}`)
  assert(byKind(candidates, 'pocket').length === 1, 'candidates: one pocket')
  assert(byKind(candidates, 'island').length === 1, 'candidates: one boss')
  assert(byKind(candidates, 'throughHole').length === 2, 'candidates: two through holes')
  assert(byKind(candidates, 'blindHole').length === 1, 'candidates: one counterbore')
  assert(candidates.every((candidate) => !candidate.alreadyDrawn), 'candidates: nothing drawn yet')

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
  assert(again.length === 5, 'second run: the same five rows')
  assert(again.every((candidate) => candidate.alreadyDrawn), 'second run: every row is already drawn')
  assert(defaultCheckedIds(again).length === 0, 'second run: nothing starts checked')
  assert(drawAll(again).length === 0, 'second run: adding draws nothing')

  // Already drawn means the same span, not only the same outline: a shape the
  // user made deeper is a different feature.
  const project = useProjectStore.getState().project
  const counterbore = project.features.find((feature) => feature.z_top === 20 && feature.z_bottom === 14)!
  useProjectStore.getState().updateFeature(counterbore.id, { z_bottom: 10 })
  const afterEdit = candidatesFor(useProjectStore.getState().project)
  const offered = afterEdit.filter((candidate) => !candidate.alreadyDrawn)
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
  assert(inches.length === 5, `inches: five rows, got ${inches.length}`)
  const counterbore = byKind(inches, 'blindHole')[0]
  assertNear(counterbore.circle!.radius, 5.5 * inch, 'inches: counterbore radius', 1e-5)
  assertNear(counterbore.zBottom, 14 * inch, 'inches: counterbore floor', 1e-5)
  // Five decimals of an inch: the stored number has no float32 tail.
  assert(Number(counterbore.zBottom.toFixed(5)) === counterbore.zBottom, 'inches: stored to five decimals')
  load(project)
  assert(drawAll(inches).length === 5, 'inches: all five are drawn')
  assert(candidatesFor(useProjectStore.getState().project).every((candidate) => candidate.alreadyDrawn), 'inches: a second run offers nothing')
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

console.log('store/modelRecognitionFlow.test.ts: all assertions passed')
