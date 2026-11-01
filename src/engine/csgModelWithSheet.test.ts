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

/// <reference types="node" />

/**
 * A Turn or Polygon must stay visible beside an Around sheet feature (#1112
 * rt4-c item 36).
 *
 * Frank's report: a Ø1.5 in round bar with Turn, Turn 2, a Hex (Polygon),
 * Thread, Thread 2, Flutes and an Around pocket `Rect 6`. With `Rect 6` hidden
 * the 3D view showed the turned sections; showing it drew the bar at full
 * diameter and both Turns were gone (the thread lines stayed). The bar-seeded
 * fold only ever held Add/Subtract rows, so the pocket built an opaque
 * full-diameter bar *over* the model meshes — which were still built. That is
 * the same "opaque bar paints over the models" defect rt3-c fixed for a fold
 * with nothing to apply.
 *
 * The fix folds a canned model into the bar in tree order: the stock is turned
 * down to the model over the model's own length (`barTurningRemoval`), so the
 * bar's surface *is* the Turn/Polygon wherever one sits, and a sheet feature
 * still cuts it. Every scenario here holds one Turn and one Hex, a baseline
 * sheet pocket that keeps a boolean model in every scene, and one feature of
 * each sheet kind beside them.
 *
 * A model is still drawn from its own mesh so its row can tint it, and that
 * mesh is the model as authored: where a cut went through the model, the fold
 * carried the cut and the mesh covered it. Section 7 is the correction-round
 * guard for that (#1112 rt4-c fix 1): a pocket deep enough to cut below a
 * model's crown, both tree orders, measured on everything the view draws rather
 * than on `modelMesh` alone.
 *
 * Mutations (each re-broke the fix on purpose and made this file fail, then the
 * file was restored from a `cp` backup):
 *   1. Skip the model rows when sheet work is visible — stage a canned model
 *      only while `visibleAroundFeatures` is empty — and the turned spans stay
 *      at bar diameter: every `surfaceHeight` assertion fails.
 *   2. Drop the sheet result when a model exists — in `buildScene`, skip
 *      `buildBooleanModel` when a visible feature has operation 'model' — and
 *      the `modelMesh` assertions plus every volume comparison fail.
 *   3. Union the model into the bar instead of turning it down (replace the
 *      fold's difference with `unionClippedToBar`) and the bar keeps its full
 *      diameter: the turned-surface assertions fail, the volume ones do not.
 *   4. Add the model feature meshes only when `modelMesh` is null (the old
 *      `!modelMesh` guard around the `kind === 'stl'` meshes) and the model-mesh
 *      assertions fail in every sheet scene, while the surfaces stay right.
 *   5. Draw the model's own mesh even when the fold cut it (drop the
 *      `foldedModelMeshes` preference in `buildScene`) and every section-7
 *      `featureHeight` / `renderedHeight` assertion fails at the model's crown
 *      instead of the pocket's floor, while `modelMesh` alone stays correct.
 *   6. Trim every model unconditionally (drop the volume comparison in
 *      `buildFoldedModelMeshes`) and the untouched models stop drawing their
 *      generated meshes: `assertModelMeshes` fails on the vertex counts.
 *
 * Run with: `NODE_OPTIONS=--no-experimental-global-navigator npx tsx
 * src/engine/csgModelWithSheet.test.ts`
 */

import * as THREE from 'three'
import {
  newProject,
  rectProfile,
  roundStock,
  type Matrix2D,
  type Project,
  type SketchFeature,
} from '../types/project'
import { squareStock } from '../types/barStock'
import { projectWithFeatures } from '../test/projectFixtures'
import { THEME_PALETTES } from '../theme/palette'
import { planRotarySolid } from '../store/helpers/rotarySolids'
import { resolveFeatureInstance } from '../store/helpers/resolveFeatures'
import { GEAR_CANNED_KIND, normalizeGearCannedParams } from '../cannedShapes/generators/gear'
import { aroundFrame } from './aroundFrame'
import { applyFeatureHighlights, buildScene, type SceneObjects } from './csg'
import type { SelectionState } from '../store/types'

const threePalette = THEME_PALETTES.dark.three

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function assertClose(actual: number, expected: number, tolerance: number, label: string): void {
  assert(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ${expected}, got ${actual} (tolerance ${tolerance})`,
  )
}

const EMPTY_SELECTION: SelectionState = {
  mode: 'feature',
  selectedFeatureId: null,
  selectedFeatureIds: [],
  selectedTabIds: [],
  selectedClampIds: [],
  selectedNode: null,
  hoveredFeatureId: null,
  sketchEditTool: null,
  activeControl: null,
  groupFolderId: null,
}

/** Frank's stock: a Ø1.5 in round bar, 6 in long, along X. */
const BAR_DIAMETER = 1.5
const BAR_LENGTH = 6
/** The Turn: Ø1 over 1..2.5, so its crown sits at height 1.25. */
const TURN = { start: 1, length: 1.5, diameter: 1 }
const TURN_CROWN = BAR_DIAMETER / 2 + TURN.diameter / 2
/** The Hex: 0.8 across flats over 3..4, flat up, so its crown is 1.15. */
const POLYGON = { start: 3, length: 1, sides: 6, acrossFlats: 0.8 }
const POLYGON_CROWN = BAR_DIAMETER / 2 + POLYGON.acrossFlats / 2
/** The untouched bar's crown, and a point in the turned-down span of each. */
const BAR_CROWN = BAR_DIAMETER
const TURN_PROBE = TURN.start + TURN.length / 2
const POLYGON_PROBE = POLYGON.start + POLYGON.length / 2
/** An along point between the Hex and every sheet feature below. */
const INTACT_PROBE = 4.3

const FRAME = aroundFrame(roundStock(BAR_DIAMETER, BAR_LENGTH, 'x'))

// ── Fixtures ────────────────────────────────────────────────────────────────

function barProject(): Project {
  const base = newProject('models beside sheet', 'inch')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(BAR_DIAMETER, BAR_LENGTH, 'x')
  return base
}

function squareProject(): Project {
  const base = newProject('models beside sheet', 'inch')
  base.meta.projectType = 'rotary'
  base.stock = squareStock(BAR_DIAMETER, BAR_LENGTH, 'x')
  return base
}

interface Draft {
  profile: SketchFeature['sketch']['profile']
  operation: SketchFeature['operation']
  zTop: number
  zBottom: number
  kind?: SketchFeature['kind']
  canned?: SketchFeature['canned']
  text?: SketchFeature['text']
  transform?: Matrix2D
}

function draft(id: string, spec: Draft, face: 'top' | 'around' = 'around', visible = true): SketchFeature {
  return {
    id,
    name: id,
    kind: spec.kind ?? 'rect',
    folderId: null,
    sketch: { profile: spec.profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: spec.operation,
    z_top: spec.zTop,
    z_bottom: spec.zBottom,
    authoringFace: face,
    visible,
    locked: false,
    ...(spec.canned ? { canned: spec.canned } : {}),
    ...(spec.text ? { text: spec.text } : {}),
    ...(spec.transform ? { transform: spec.transform } : {}),
  }
}

/** A rectangle on the Around sheet around the zero line (the top of the bar). */
function sheetRect(along: number, alongLength: number, acrossLength: number): SketchFeature['sketch']['profile'] {
  return rectProfile(along, FRAME.zero - acrossLength / 2, alongLength, acrossLength)
}

const POCKET_FLOOR = 1.4
const BASE_POCKET_FLOOR = 1.42
/**
 * A cut this deep reaches below both model crowns (the Turn's 1.25 and the
 * Hex's 1.15), so the fold's floor lies under the model's own surface — which
 * is exactly what a model's authored mesh used to cover (#1112 rt4-c fix 1).
 */
const OVERLAP_FLOOR = 1.05

/** The sheet pocket every scene carries, so a boolean model always exists. */
function basePocket(): SketchFeature {
  return draft('base-pocket', {
    profile: sheetRect(4.5, 0.3, 0.5),
    operation: 'subtract',
    zTop: BAR_DIAMETER,
    zBottom: BASE_POCKET_FLOOR,
  })
}

/** A pocket wide enough to cross the bar's crown, centred on `along`. */
function overlapPocket(along: number): SketchFeature {
  return draft('overlap-pocket', {
    profile: sheetRect(along - 0.25, 0.5, 0.5),
    operation: 'subtract',
    zTop: BAR_DIAMETER,
    zBottom: OVERLAP_FLOOR,
  })
}

const gearParams = normalizeGearCannedParams({
  teeth: 12,
  outsideRadius: 0.18,
  wholeDepth: 0.04,
  flankProfile: 'involute',
  pressureAngleDeg: 20,
  rootForm: 'rounded',
  rootFilletRadius: 0.004,
  crestForm: 'flat',
  crestRadius: 0,
  boreDiameter: 0,
})
assert(gearParams, 'fixture: the gear parameters normalize')

/** One sheet kind and the features that express it. */
interface SheetKind {
  label: string
  /** The kind itself — hidden to show that its own effect goes with it. */
  feature: SketchFeature
  /** Features the kind needs in front of it (the add's host pocket). */
  hosts: SketchFeature[]
  /** How hiding the kind changes the bar, when it changes it at all. */
  effect: 'removes' | 'restores' | 'draws'
}

const SHEET_KINDS: SheetKind[] = [
  {
    label: 'Around pocket subtract',
    feature: draft('pocket', {
      profile: sheetRect(5.05, 0.5, 0.5),
      operation: 'subtract',
      zTop: BAR_DIAMETER,
      zBottom: POCKET_FLOOR,
    }),
    hosts: [],
    effect: 'removes',
  },
  {
    label: 'Around add island',
    feature: draft('island', {
      profile: sheetRect(5.15, 0.3, 0.3),
      operation: 'add',
      zTop: BAR_DIAMETER,
      zBottom: POCKET_FLOOR,
    }),
    hosts: [draft('island-host', {
      profile: sheetRect(5.0, 0.6, 0.6),
      operation: 'subtract',
      zTop: BAR_DIAMETER,
      zBottom: POCKET_FLOOR,
    })],
    effect: 'restores',
  },
  {
    label: 'Around text subtract',
    feature: draft('text', {
      profile: sheetRect(5.0, 0.5, 0.5),
      operation: 'subtract',
      zTop: BAR_DIAMETER,
      zBottom: POCKET_FLOOR,
      kind: 'text',
      text: { text: 'AB', style: 'outline', fontId: 'helvetiker_bold', size: 0.15 },
    }),
    hosts: [],
    effect: 'removes',
  },
  {
    label: 'Around gear outline subtract',
    feature: draft('gear', {
      profile: sheetRect(5.05, 0.5, 0.5),
      operation: 'subtract',
      zTop: BAR_DIAMETER,
      zBottom: POCKET_FLOOR,
      kind: 'composite',
      canned: { kind: GEAR_CANNED_KIND, params: gearParams },
      transform: { a: 1, b: 0, c: 0, d: 1, e: 5.05, f: FRAME.zero },
    }),
    hosts: [],
    effect: 'removes',
  },
  {
    label: 'Around open line',
    feature: draft('line', {
      profile: {
        start: { x: 4.9, y: FRAME.zero - 0.2 },
        segments: [{ type: 'line', to: { x: 5.4, y: FRAME.zero + 0.2 } }],
        closed: false,
      },
      operation: 'line',
      zTop: BAR_DIAMETER,
      zBottom: POCKET_FLOOR,
    }),
    hosts: [],
    effect: 'draws',
  },
]

interface ModelFixture {
  project: Project
  turnId: string
  polygonId: string
}

/** The bar with its Turn and Hex, built through the real creation planner. */
function withModels(base: Project): ModelFixture {
  const turn = planRotarySolid(base, EMPTY_SELECTION, { kind: 'turn', ...TURN })
  assert(turn.ok, `fixture: the Turn is created (${turn.ok ? '' : turn.reason})`)
  const polygon = planRotarySolid(turn.project, EMPTY_SELECTION, { kind: 'polygon', ...POLYGON })
  assert(polygon.ok, `fixture: the Polygon is created (${polygon.ok ? '' : polygon.reason})`)
  return {
    project: polygon.project,
    turnId: turn.created.featureId,
    polygonId: polygon.created.featureId,
  }
}

/** The models, the baseline pocket and one sheet kind, in tree order. */
function withSheetKind(models: ModelFixture, kind: SheetKind): Project {
  return projectWithFeatures(models.project, [
    ...models.project.features,
    basePocket(),
    ...kind.hosts,
    kind.feature,
  ])
}

/** The same project with `featureId` hidden (`visible: false`), everything else kept. */
function hiding(project: Project, featureId: string): Project {
  return {
    ...project,
    features: project.features.map((feature) => (
      feature.id === featureId ? { ...feature, visible: false } : feature
    )),
  }
}

// ── Scene readouts ──────────────────────────────────────────────────────────

/** A closed mesh's volume, in scene units, from the divergence theorem. */
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

/**
 * The height something drawn in the scene presents straight down at `along` on
 * the bar's top (the across centreline): 1.5 for the untouched Ø1.5 bar, 1.25
 * over the Ø1 Turn, 1.15 over the flat-topped Hex. Scene coordinates put the
 * project along axis in X, the height in Y and the project across axis in Z for
 * an X bar.
 */
function topDownHeight(targets: THREE.Object3D[], along: number, axis: 'x' | 'y', label: string): number {
  for (const target of targets) target.updateMatrixWorld(true)
  const origin = axis === 'x'
    ? new THREE.Vector3(along, 10, FRAME.centre)
    : new THREE.Vector3(FRAME.centre, 10, along)
  const raycaster = new THREE.Raycaster(origin, new THREE.Vector3(0, -1, 0), 0, 100)
  const hits = raycaster.intersectObjects(targets, true)
  assert(hits.length > 0, `${label}: a ray at along ${along} hits it`)
  return hits[0].point.y
}

/** The folded solid's own surface at `along`. */
function surfaceHeight(scene: SceneObjects, along: number, axis: 'x' | 'y' = 'x'): number {
  assert(scene.modelMesh, 'the scene has a boolean model mesh to measure')
  return topDownHeight([scene.modelMesh], along, axis, 'the model')
}

/**
 * What the 3D view actually presents at `along`: the highest surface of the
 * bar mesh *and* every feature mesh drawn over it. A model's own mesh is drawn
 * beside the bar, so a measurement of `modelMesh` alone cannot say what a user
 * sees — the defect this file now guards (#1112 rt4-c fix 1) was exactly a
 * model mesh covering a cut the bar carried.
 */
function renderedHeight(scene: SceneObjects, along: number, axis: 'x' | 'y' = 'x'): number {
  const targets: THREE.Object3D[] = []
  if (scene.modelMesh) targets.push(scene.modelMesh)
  for (const object of scene.featureMeshes.values()) targets.push(object)
  assert(targets.length > 0, 'the scene draws something to measure')
  return topDownHeight(targets, along, axis, 'the drawn scene')
}

/** The surface one feature's own drawn object presents at `along`. */
function featureHeight(scene: SceneObjects, featureId: string, along: number, axis: 'x' | 'y' = 'x'): number {
  const object = scene.featureMeshes.get(featureId)
  assert(object, `the scene draws the feature ${featureId}`)
  return topDownHeight([object], along, axis, `the feature ${featureId}`)
}

/** Every mesh drawn inside one feature's object. */
function drawnMeshes(object: THREE.Object3D): THREE.Mesh[] {
  const meshes: THREE.Mesh[] = []
  object.traverse((child) => {
    if ((child as THREE.Mesh).isMesh) meshes.push(child as THREE.Mesh)
  })
  return meshes
}

/** The vertex count of the canned mesh a model row stores. */
function assetVertexCount(project: Project, featureId: string): number {
  const feature = resolveFeatureInstance(project, featureId)
  assert(feature, `fixture: the model ${featureId} resolves`)
  const assetId = feature.stl?.meshAssetId
  assert(assetId, `fixture: ${featureId} stores a canned mesh asset`)
  const asset = project.modelAssets?.[assetId]
  assert(asset, `fixture: the asset ${assetId} is in the project`)
  return asset.vertexCount
}

/**
 * The Turn and Polygon are drawn from their generated meshes: one mesh with
 * every vertex of the stored canned mesh (502 for the revolved Turn, 12 for the
 * six-sided prism), and its crown at the model's own radius rather than the
 * frame rectangle's.
 */
function assertModelMeshes(
  scene: SceneObjects,
  models: ModelFixture,
  project: Project,
  label: string,
): void {
  for (const [featureId, crown] of [[models.turnId, TURN_CROWN], [models.polygonId, POLYGON_CROWN]] as const) {
    const object = scene.featureMeshes.get(featureId)
    assert(object, `${label}: the model ${featureId} is drawn`)
    const meshes = drawnMeshes(object)
    assert(meshes.length === 1, `${label}: ${featureId} draws one mesh, got ${meshes.length}`)
    const position = meshes[0].geometry.getAttribute('position')
    assert(
      position !== undefined && position.count === assetVertexCount(project, featureId),
      `${label}: ${featureId} draws its generated mesh, got ${position?.count ?? 0} vertices`,
    )
    object.updateMatrixWorld(true)
    const box = new THREE.Box3().setFromObject(object)
    assertClose(box.max.y, crown, 1e-3, `${label}: ${featureId} is drawn at its own radius`)
  }
}

/** The bar is turned down at both models and keeps its diameter between them. */
function assertTurning(scene: SceneObjects, label: string): void {
  assertClose(surfaceHeight(scene, TURN_PROBE), TURN_CROWN, 1e-3, `${label}: the Turn's span is turned down`)
  assertClose(surfaceHeight(scene, POLYGON_PROBE), POLYGON_CROWN, 1e-3, `${label}: the Hex's span is turned down`)
  assertClose(surfaceHeight(scene, INTACT_PROBE), BAR_CROWN, 1e-3, `${label}: the intact bar keeps its diameter`)
  // The models are drawn from their own meshes beside the bar, so the complete
  // scene must present the same heights the fold built and not something over
  // them.
  assertClose(renderedHeight(scene, TURN_PROBE), TURN_CROWN, 1e-3, `${label}: the Turn's crown is what is drawn`)
  assertClose(renderedHeight(scene, POLYGON_PROBE), POLYGON_CROWN, 1e-3, `${label}: the Hex's crown is what is drawn`)
  assertClose(renderedHeight(scene, INTACT_PROBE), BAR_CROWN, 1e-3, `${label}: the intact bar is what is drawn`)
}

// ── 1. Every sheet kind beside the models ───────────────────────────────────

for (const kind of SHEET_KINDS) {
  const models = withModels(barProject())
  const project = withSheetKind(models, kind)
  const hidden = hiding(project, kind.feature.id)

  const visibleScene = await buildScene(project, threePalette)
  const hiddenScene = await buildScene(hidden, threePalette)

  assert(visibleScene.modelMesh, `${kind.label}: the sheet result is drawn beside the models`)
  assert(hiddenScene.modelMesh, `${kind.label}: the other sheet work still builds a model with it hidden`)
  assertModelMeshes(visibleScene, models, project, `${kind.label} visible`)
  assertModelMeshes(hiddenScene, models, project, `${kind.label} hidden`)
  assertTurning(visibleScene, `${kind.label} visible`)
  assertTurning(hiddenScene, `${kind.label} hidden`)

  if (kind.effect === 'removes') {
    assert(
      meshVolume(visibleScene.modelMesh!) < meshVolume(hiddenScene.modelMesh!) - 1e-3,
      `${kind.label}: showing it removes material from the turned bar`,
    )
  } else if (kind.effect === 'restores') {
    assert(
      meshVolume(visibleScene.modelMesh!) > meshVolume(hiddenScene.modelMesh!) + 1e-3,
      `${kind.label}: showing the island restores material into the host pocket`,
    )
  } else {
    assertClose(
      meshVolume(visibleScene.modelMesh!),
      meshVolume(hiddenScene.modelMesh!),
      1e-4,
      `${kind.label}: a drawn line leaves the bar's volume alone`,
    )
    assert(
      visibleScene.batchedLinesMeta.segmentCount > hiddenScene.batchedLinesMeta.segmentCount,
      `${kind.label}: the line is drawn (${visibleScene.batchedLinesMeta.segmentCount} vs ${hiddenScene.batchedLinesMeta.segmentCount} segments)`,
    )
  }
}

// ── 2. Hiding one model keeps the other and the sheet result ────────────────

{
  const models = withModels(barProject())
  const project = withSheetKind(models, SHEET_KINDS[0])
  const noTurn = await buildScene(hiding(project, models.turnId), threePalette)
  const noPolygon = await buildScene(hiding(project, models.polygonId), threePalette)

  for (const [scene, kept, keptCrown, dropped, droppedCrown] of [
    [noTurn, models.polygonId, POLYGON_CROWN, models.turnId, BAR_CROWN],
    [noPolygon, models.turnId, TURN_CROWN, models.polygonId, BAR_CROWN],
  ] as const) {
    assert(scene.modelMesh, 'the sheet result survives hiding one model')
    assert(scene.featureMeshes.has(kept), 'the other model is still drawn')
    assert(!scene.featureMeshes.has(dropped), 'the hidden model is not drawn')
    // The hidden model's span goes back to the bar's own diameter; the kept
    // one is still turned down and the pocket is still cut.
    const droppedProbe = dropped === models.turnId ? TURN_PROBE : POLYGON_PROBE
    const keptProbe = kept === models.turnId ? TURN_PROBE : POLYGON_PROBE
    assertClose(surfaceHeight(scene, droppedProbe), droppedCrown, 1e-3, `hiding ${dropped} restores its span`)
    assertClose(surfaceHeight(scene, keptProbe), keptCrown, 1e-3, `hiding ${dropped} keeps ${kept} turned down`)
    assertClose(surfaceHeight(scene, INTACT_PROBE), BAR_CROWN, 1e-3, 'the intact bar is unchanged')
    // The sheet pocket is still cut into the bar it was drawn on (5.05..5.55).
    assertClose(surfaceHeight(scene, 5.2), POCKET_FLOOR, 1e-3, 'the sheet pocket is still cut')
  }
}

// ── 3. The rt3-c case is not reopened: models and a drawn sheet line ────────

{
  const models = withModels(barProject())
  const lineKind = SHEET_KINDS[SHEET_KINDS.length - 1]
  const scene = await buildScene(
    projectWithFeatures(models.project, [...models.project.features, lineKind.feature]),
    threePalette,
  )
  assert(scene.modelMesh === null, 'models beside a drawn line still build no opaque bar')
  assertModelMeshes(scene, models, models.project, 'models beside a drawn line')
  assert(scene.batchedLinesMeta.segmentCount > 0, 'the wrapped line is drawn')
}

// ── 4. A square blank: models still show beside a flat subtract ─────────────

{
  const models = withModels(squareProject())
  const project = projectWithFeatures(models.project, [
    ...models.project.features,
    draft('top-pocket', {
      profile: rectProfile(4.5, FRAME.zero - 0.25, 0.5, 0.5),
      operation: 'subtract',
      zTop: BAR_DIAMETER,
      zBottom: POCKET_FLOOR,
    }, 'top'),
  ])
  const scene = await buildScene(project, threePalette)
  assert(scene.modelMesh, 'a square blank draws its flat subtract')
  assertModelMeshes(scene, models, project, 'square blank')
  assertTurning(scene, 'square blank')
}

// ── 5. Selection and hover still tint the models beside the sheet result ────

{
  const models = withModels(barProject())
  const scene = await buildScene(withSheetKind(models, SHEET_KINDS[0]), threePalette)
  const turnMesh = drawnMeshes(scene.featureMeshes.get(models.turnId)!)[0]
  const polygonMesh = drawnMeshes(scene.featureMeshes.get(models.polygonId)!)[0]
  const turnMaterial = turnMesh.material as THREE.MeshStandardMaterial
  const polygonMaterial = polygonMesh.material as THREE.MeshStandardMaterial
  const baseTurn = turnMaterial.color.getHex()
  const basePolygon = polygonMaterial.color.getHex()

  applyFeatureHighlights(
    scene.featureMeshes,
    { selectedFeatureIds: [models.turnId], hoveredFeatureId: models.polygonId },
    threePalette,
  )
  assert(
    turnMaterial.color.getHex() === threePalette.meshFeatureSelected,
    'selecting the Turn tints its mesh beside the sheet result',
  )
  assert(
    polygonMaterial.color.getHex() === threePalette.meshFeatureHovered,
    'hovering the Hex tints its mesh beside the sheet result',
  )

  applyFeatureHighlights(scene.featureMeshes, { selectedFeatureIds: [], hoveredFeatureId: null }, threePalette)
  assert(turnMaterial.color.getHex() === baseTurn, 'clearing the selection restores the Turn colour')
  assert(polygonMaterial.color.getHex() === basePolygon, 'clearing the hover restores the Hex colour')
}

// ── 6. Both bar axes ───────────────────────────────────────────────────────

{
  // On a Y bar the chuck end is the far Y end, so both models mirror: the Turn
  // is 3.5..5 and the Hex 2..3. The sheet's along runs in the profile's Y and
  // its across in the profile's X. The pockets sit on the intact 0..2.
  const base = barProject()
  base.stock = roundStock(BAR_DIAMETER, BAR_LENGTH, 'y')
  const models = withModels(base)
  const ySheetRect = (along: number, alongLength: number, acrossLength: number): SketchFeature['sketch']['profile'] =>
    rectProfile(FRAME.zero - acrossLength / 2, along, acrossLength, alongLength)
  const project = projectWithFeatures(models.project, [
    ...models.project.features,
    draft('base-pocket', {
      profile: ySheetRect(0.5, 0.3, 0.5),
      operation: 'subtract',
      zTop: BAR_DIAMETER,
      zBottom: BASE_POCKET_FLOOR,
    }),
    draft('pocket', { profile: ySheetRect(0.9, 0.5, 0.5), operation: 'subtract', zTop: BAR_DIAMETER, zBottom: POCKET_FLOOR }),
  ])
  const scene = await buildScene(project, threePalette)
  assert(scene.modelMesh, 'a Y bar draws the sheet result beside its models')
  assertModelMeshes(scene, models, project, 'Y bar')
  assertClose(
    surfaceHeight(scene, BAR_LENGTH - TURN.start - TURN.length / 2, 'y'),
    TURN_CROWN,
    1e-3,
    'Y bar: the Turn span is turned down',
  )
  assertClose(
    surfaceHeight(scene, BAR_LENGTH - POLYGON.start - POLYGON.length / 2, 'y'),
    POLYGON_CROWN,
    1e-3,
    'Y bar: the Hex span is turned down',
  )
  assertClose(surfaceHeight(scene, 1.5, 'y'), BAR_CROWN, 1e-3, 'Y bar: the intact bar keeps its diameter')
}

// ── 7. A cut that overlaps a model stays open in what the view draws ────────

/**
 * The correction round for #1112 rt4-c (fix 1). Section 1 places its sheet work
 * beside the models, so a model's authored mesh never had anything to cover
 * there — and `surfaceHeight` reads only the folded `modelMesh`, which was
 * already right. A pocket through a model's crown is the case that failed: the
 * fold cut the pocket, and the model's own mesh, drawn at the cut's depth,
 * filled the opening back in. Every height below is measured on the scene the
 * viewport draws — the bar and every feature mesh over it.
 */
const OVERLAPS: Array<{
  label: string
  probe: number
  crown: number
  model: (models: ModelFixture) => string
}> = [
  { label: 'Turn', probe: TURN_PROBE, crown: TURN_CROWN, model: (models) => models.turnId },
  { label: 'Hex', probe: POLYGON_PROBE, crown: POLYGON_CROWN, model: (models) => models.polygonId },
]

for (const overlap of OVERLAPS) {
  // Tree order is the order the fold applies material in, and a model turns the
  // bar down over its whole span: the cut must survive in what is drawn either
  // way round, so both orders are built.
  for (const order of ['cut after the model', 'cut before the model'] as const) {
    const models = withModels(barProject())
    const pocket = overlapPocket(overlap.probe)
    const project = projectWithFeatures(
      models.project,
      order === 'cut after the model'
        ? [...models.project.features, basePocket(), pocket]
        : [pocket, basePocket(), ...models.project.features],
    )
    const label = `${overlap.label}, ${order}`
    const modelId = overlap.model(models)
    const otherId = modelId === models.turnId ? models.polygonId : models.turnId
    const scene = await buildScene(project, threePalette)
    const hidden = await buildScene(hiding(project, pocket.id), threePalette)

    // The fold cuts the pocket through the model…
    assert(scene.modelMesh, `${label}: the bar is drawn`)
    assertClose(surfaceHeight(scene, overlap.probe), OVERLAP_FLOOR, 1e-3, `${label}: the fold cuts through the model`)
    // …and the model's own drawn mesh shows that cut instead of covering it…
    assertClose(
      featureHeight(scene, modelId, overlap.probe),
      OVERLAP_FLOOR,
      1e-3,
      `${label}: the model's mesh presents the pocket's floor, not its crown`,
    )
    // …so the complete result the user sees is the pocket.
    assertClose(
      renderedHeight(scene, overlap.probe),
      OVERLAP_FLOOR,
      1e-3,
      `${label}: the drawn scene presents the pocket's floor`,
    )
    // The span the pocket does not cross still shows the model at its own radius.
    assertClose(
      renderedHeight(scene, overlap.probe + 0.4),
      overlap.crown,
      1e-3,
      `${label}: the model keeps its crown beside the cut`,
    )
    // Only the cut model is redrawn: its neighbour still uses its generated mesh.
    const otherMesh = drawnMeshes(scene.featureMeshes.get(otherId)!)[0]
    assert(
      otherMesh.geometry.getAttribute('position').count === assetVertexCount(project, otherId),
      `${label}: the untouched model still draws its generated mesh`,
    )

    // The drawn model geometry is the cut one, not merely lower at the probe.
    const cutObject = scene.featureMeshes.get(modelId)!
    const wholeObject = hidden.featureMeshes.get(modelId)!
    cutObject.updateMatrixWorld(true)
    wholeObject.updateMatrixWorld(true)
    assert(
      meshVolume(drawnMeshes(cutObject)[0]) < meshVolume(drawnMeshes(wholeObject)[0]) - 1e-3,
      `${label}: the drawn model loses the material the pocket removed`,
    )

    // With the cut hidden the model is whole again and draws its own mesh, every
    // vertex of it, at its own crown.
    assertModelMeshes(hidden, models, project, `${label} hidden`)
    assertClose(
      renderedHeight(hidden, overlap.probe),
      overlap.crown,
      1e-3,
      `${label}: hiding the pocket presents the model's crown again`,
    )

    // The cut is still the geometry selection and hover tint.
    const cutMaterial = drawnMeshes(scene.featureMeshes.get(modelId)!)[0]
      .material as THREE.MeshStandardMaterial
    applyFeatureHighlights(scene.featureMeshes, { selectedFeatureIds: [modelId], hoveredFeatureId: null }, threePalette)
    assert(
      cutMaterial.color.getHex() === threePalette.meshFeatureSelected,
      `${label}: the cut model still highlights`,
    )
  }
}

console.log('csgModelWithSheet: all assertions passed')
