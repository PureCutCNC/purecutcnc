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
 * Canned models are drawn from their mesh alone (issue #1112 F5).
 *
 * Frank's screenshots: a Turn and a Polygon on a square blank each showed the
 * right shape *inside an extra green box* that flickered through it. The box
 * was the feature-mesh fallback's extrusion of the canned shape's generated
 * outline — and that outline is only the placement frame (a rectangle around
 * the mesh), so every canned model was drawn twice.
 *
 * A project of models only builds no boolean solid, so `buildScene` takes its
 * feature-mesh fallback, which is the path that extruded the frame. Every case
 * here is asserted on that path: round and square bars, along X and along Y,
 * in mm and in inch.
 *
 * Outline kinds keep their extruded solids: a canned ellipse whose subtract has
 * no base still draws its extrusion, so the exclusion cannot be widened to all
 * canned shapes.
 *
 * Mutations (each re-broke the fix on purpose and made this file fail, then the
 * file was restored with a `cp` backup):
 *   1. Re-add the extrusion for a model kind — drop the `cannedShapeIsModel`
 *      skip in `buildScene` — and a Turn/Polygon grows a second, box-shaped
 *      solid: the one-per-feature and vertex-count assertions fail.
 *   2. Widen the skip to every canned shape (`feature.canned`) and the ellipse
 *      case loses its extrusion: the outline assertion fails.
 *   3. Drop the guard in `buildFeatureMesh` and a canned model whose mesh asset
 *      is missing draws its frame box again instead of nothing.
 *
 * Run with: npx tsx src/engine/csgCannedModelDraw.test.ts
 */

import * as THREE from 'three'
import { squareStock } from '../types/barStock'
import { newProject, rectProfile, roundStock, type Project, type SketchFeature } from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { THEME_PALETTES } from '../theme/palette'
import { cannedShapeIsModel, generateCannedShapeMesh, type CannedShapeMesh } from '../cannedShapes'
import { resolvedProjectFeatures } from '../store/helpers/resolveFeatures'
import { planRotarySolid } from '../store/helpers/rotarySolids'
import type { SelectionState } from '../store/types'
import type { Units } from '../utils/units'
import { buildFeatureMesh, buildScene } from './csg'

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

interface ModelCase {
  label: string
  units: Units
  shape: 'round' | 'square'
  axis: 'x' | 'y'
}

/** Round and square bars, both axes, both unit systems. */
const MODEL_CASES: ModelCase[] = [
  { label: 'square blank along X (mm)', units: 'mm', shape: 'square', axis: 'x' },
  { label: 'square blank along Y (mm)', units: 'mm', shape: 'square', axis: 'y' },
  { label: 'round bar along X (mm)', units: 'mm', shape: 'round', axis: 'x' },
  { label: 'round bar along Y (mm)', units: 'mm', shape: 'round', axis: 'y' },
  { label: 'square blank along X (inch)', units: 'inch', shape: 'square', axis: 'x' },
  { label: 'square blank along Y (inch)', units: 'inch', shape: 'square', axis: 'y' },
  { label: 'round bar along X (inch)', units: 'inch', shape: 'round', axis: 'x' },
  { label: 'round bar along Y (inch)', units: 'inch', shape: 'round', axis: 'y' },
]

/** One length in project units: the bar and the dialog numbers scale together. */
function lengths(units: Units): { bar: number; barLength: number; start: number; length: number; size: number } {
  return units === 'mm'
    ? { bar: 25, barLength: 120, start: 10, length: 30, size: 20 }
    : { bar: 1, barLength: 5, start: 0.5, length: 1.5, size: 0.8 }
}

const AROUND_SETUP = {
  id: 'setup-around',
  name: 'Around',
  kind: 'around' as const,
  indexing: 'manual' as const,
  registration: [] as never[],
  notes: '',
  operationIds: [] as string[],
}

/** A rotary project whose workspace face is Around, with a bare bar as stock. */
function barProject(units: Units, shape: 'round' | 'square', axis: 'x' | 'y'): Project {
  const sizes = lengths(units)
  const base = newProject('Canned models', units)
  base.meta.projectType = 'rotary'
  base.stock = shape === 'square'
    ? squareStock(sizes.bar, sizes.barLength, axis)
    : roundStock(sizes.bar, sizes.barLength, axis)
  base.setups = [...base.setups, { ...AROUND_SETUP, orientation: { axis, angleDeg: 0 } }]
  base.activeSetupId = AROUND_SETUP.id
  return base
}

/** The stock-space bounds of a generated mesh, in the features' own coordinates. */
function meshBounds(mesh: CannedShapeMesh) {
  const bounds = { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity, minZ: Infinity, maxZ: -Infinity }
  for (let index = 0; index + 2 < mesh.positions.length; index += 3) {
    bounds.minX = Math.min(bounds.minX, mesh.positions[index])
    bounds.maxX = Math.max(bounds.maxX, mesh.positions[index])
    bounds.minY = Math.min(bounds.minY, mesh.positions[index + 1])
    bounds.maxY = Math.max(bounds.maxY, mesh.positions[index + 1])
    bounds.minZ = Math.min(bounds.minZ, mesh.positions[index + 2])
    bounds.maxZ = Math.max(bounds.maxZ, mesh.positions[index + 2])
  }
  return bounds
}

/**
 * A scene object's bounds in project coordinates. The viewport's own
 * convention puts project Y on the scene's Z (rotateX(-π/2) then
 * mesh.scale.z = -1), which is the mapping the sibling CSG tests read.
 */
function projectBounds(object: THREE.Object3D) {
  object.updateMatrixWorld(true)
  const box = new THREE.Box3().setFromObject(object)
  return {
    minX: box.min.x,
    maxX: box.max.x,
    minY: box.min.z,
    maxY: box.max.z,
    minZ: box.min.y,
    maxZ: box.max.y,
  }
}

/** Every mesh below an object, so a group wrapper cannot hide a second solid. */
function meshesIn(object: THREE.Object3D): THREE.Mesh[] {
  const meshes = object instanceof THREE.Mesh ? [object] : []
  for (const child of object.children) meshes.push(...meshesIn(child))
  return meshes
}

function vertexCount(object: THREE.Object3D): number {
  return meshesIn(object).reduce(
    (total, mesh) => total + (mesh.geometry.getAttribute('position')?.count ?? 0),
    0,
  )
}

function assertBoundsMatch(actual: ReturnType<typeof projectBounds>, expected: ReturnType<typeof projectBounds>, label: string): void {
  const tolerance = 1e-4 * Math.max(1, Math.abs(expected.maxX - expected.minX))
  for (const key of ['minX', 'maxX', 'minY', 'maxY', 'minZ', 'maxZ'] as const) {
    assertClose(actual[key], expected[key], tolerance, `${label} ${key}`)
  }
}

// ── 1. One solid per model feature, and it is the mesh ──────────────────────

for (const testCase of MODEL_CASES) {
  const sizes = lengths(testCase.units)
  const base = barProject(testCase.units, testCase.shape, testCase.axis)

  const turn = planRotarySolid(base, EMPTY_SELECTION, {
    kind: 'turn',
    start: sizes.start,
    length: sizes.length,
    diameter: sizes.size,
  })
  assert(turn.ok, `${testCase.label}: the Turn must be created (${turn.ok ? '' : turn.reason})`)
  const polygon = planRotarySolid(turn.project, EMPTY_SELECTION, {
    kind: 'polygon',
    start: sizes.start + sizes.length + sizes.length / 2,
    length: sizes.length,
    sides: 6,
    acrossFlats: sizes.size,
    rotationDeg: 0,
  })
  assert(polygon.ok, `${testCase.label}: the Polygon must be created (${polygon.ok ? '' : polygon.reason})`)
  const project = polygon.project

  const models = resolvedProjectFeatures(project)
  assert(models.length === 2, `${testCase.label}: the project has the Turn and the Polygon, got ${models.length}`)
  assert(
    models.every((model) => cannedShapeIsModel(model.canned)),
    `${testCase.label}: both rows are canned models`,
  )

  const scene = await buildScene(project, threePalette)

  // The models are the whole model: no add/subtract row builds a boolean
  // solid, so the feature-mesh fallback is what draws them. That fallback is
  // the path that used to extrude the frame.
  assert(scene.modelMesh === null, `${testCase.label}: a models-only project builds no boolean model mesh`)
  const drawnIds = [...scene.featureMeshes.keys()]
  assert(
    scene.featureMeshes.size === models.length,
    `${testCase.label}: exactly one solid per model feature, got ${drawnIds.length} (${drawnIds.join(', ')})`,
  )
  assert(
    !drawnIds.some((id) => id.includes(':canned:')),
    `${testCase.label}: nothing draws the generated outline as a solid (${drawnIds.join(', ')})`,
  )

  for (const model of models) {
    const drawn = scene.featureMeshes.get(model.id)
    assert(drawn, `${testCase.label}: ${model.name} is drawn under its own feature id`)
    const generated = generateCannedShapeMesh(model.canned)
    assert(generated, `${testCase.label}: ${model.name} generates a mesh`)

    const meshes = meshesIn(drawn)
    assert(
      meshes.length === 1,
      `${testCase.label}: ${model.name} draws one mesh, got ${meshes.length}`,
    )
    // A frame extrusion of the same feature is 36 vertices of rectangle; the
    // generated Turn/Polygon mesh is hundreds / a dozen. The count is what
    // tells the two apart, and the bounds say it is placed where the mesh is.
    assert(
      vertexCount(drawn) === generated.positions.length / 3,
      `${testCase.label}: ${model.name} draws the generated mesh (${generated.positions.length / 3} vertices), not ${vertexCount(drawn)}`,
    )
    assertBoundsMatch(projectBounds(drawn), meshBounds(generated), `${testCase.label}: ${model.name}`)
  }
}

// ── 2. Outline kinds keep their extruded solids ─────────────────────────────

{
  const base = newProject('Canned outline', 'mm')
  const draft: SketchFeature = {
    id: 'f-outline',
    name: 'Ellipse',
    kind: 'composite',
    canned: { kind: 'ellipse', params: { rx: 10, ry: 6 } },
    stl: null,
    folderId: null,
    sketch: {
      profile: rectProfile(-10, -6, 20, 12),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    // A subtract with no base add: no boolean solid is built, so the
    // feature-mesh fallback draws this outline, exactly as before issue #1112.
    operation: 'subtract',
    z_top: 5,
    z_bottom: 0,
    authoringFace: 'top',
    visible: true,
    locked: false,
  }
  const project = projectWithFeatures(base, [draft])
  const feature = resolvedProjectFeatures(project).find((row) => row.id === draft.id)
  assert(feature, 'the canned ellipse resolves')
  assert(!cannedShapeIsModel(feature.canned), 'an ellipse is not a model: its outline is its geometry')

  const scene = await buildScene(project, threePalette)
  assert(scene.modelMesh === null, 'a subtract with no base builds no boolean model mesh')
  const drawnIds = [...scene.featureMeshes.keys()]
  assert(
    drawnIds.length === 1 && drawnIds[0] === `${draft.id}:canned:0`,
    `the ellipse keeps its extruded solid, got ${drawnIds.join(', ') || 'nothing'}`,
  )
  const drawn = scene.featureMeshes.get(`${draft.id}:canned:0`)
  assert(drawn, 'the ellipse extrusion is drawn')
  assert(vertexCount(drawn) > 0, 'the ellipse extrusion has geometry')
  assertBoundsMatch(
    projectBounds(drawn),
    { minX: -10, maxX: 10, minY: -6, maxY: 6, minZ: 0, maxZ: 5 },
    'ellipse extrusion',
  )
}

// ── 3. A model with no mesh asset draws nothing, never its frame ────────────

{
  const sizes = lengths('mm')
  const turn = planRotarySolid(barProject('mm', 'square', 'x'), EMPTY_SELECTION, {
    kind: 'turn',
    start: sizes.start,
    length: sizes.length,
    diameter: sizes.size,
  })
  assert(turn.ok, 'the Turn must be created')
  const model = resolvedProjectFeatures(turn.project).find((row) => row.canned?.kind === 'turn')
  assert(model, 'the Turn resolves')
  // A missing asset is a real state (a pruned or hand-edited file). The frame
  // is not a fallback geometry for a model kind: drawing it is the box bug.
  const withoutAsset: Project = { ...turn.project, modelAssets: {} }
  const unresolved = resolvedProjectFeatures(withoutAsset).find((row) => row.id === model.id)
  assert(unresolved, 'the Turn still resolves without its asset')
  const drawn = buildFeatureMesh(withoutAsset, unresolved, false, false, withoutAsset.stock.thickness, threePalette)
  assert(
    vertexCount(drawn) === 0,
    `a canned model without its mesh draws nothing, got ${vertexCount(drawn)} vertices`,
  )
}

console.log('csgCannedModelDraw.test.ts: all assertions passed')
