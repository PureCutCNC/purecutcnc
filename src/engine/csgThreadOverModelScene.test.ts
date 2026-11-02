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
 * A Thread must not hide the Hex and the Turn it runs over (#1112 rt3-c item
 * 29).
 *
 * Frank's round 3 report: an inch round bar Ø1.5 with a Hex and a Turn (start
 * 1.5, length 2, Ø1) and a Thread on Around (5 TPI, depth 0.122, length 2).
 * With the Thread visible the 3D view showed the plain bar and the thread but
 * no Hex or Turn; hiding the Thread brought them back. With the Thread's start
 * at 1.5 — the Turn's own span — its helix lines disappeared too.
 *
 * Both are one defect: the bar-seeded boolean model was built whenever *any*
 * Around feature was visible (a Thread/Flutes line included), and with nothing
 * to fold the fold returned the bare bar. That cylinder is opaque, while the
 * stock mesh it stands in for is translucent, so it painted over every canned
 * model and every wrapped line inside the bar. Hiding the Thread left no
 * Around feature, no fold ran, and the models showed again. A Thread over a
 * Turn sits at the Turn's radius, inside the bar, and vanished the same way.
 *
 * The fix lives in `buildBarModelSolid`: a fold that applies no Add or
 * Subtract returns null, exactly as a models-only project already builds no
 * boolean mesh (issue #1112 F5). The unchanged bar is the stock mesh.
 *
 * Cases, all in inch on a Ø1.5 × 6 round bar along X:
 *   a) Hex + Turn at start 1.5, length 2, Ø1; Thread start 2 (runs past the
 *      Turn) — the reported (a);
 *   b) the same models, Thread start 1.5 (the Turn's own span) — the reported
 *      (b);
 *   c) the same Turn and Thread as (b), with the Hex moved clear of the band,
 *      so the thread sits on the Turn's surface rather than the bar's — the
 *      "helix lines aren't drawn" half of the report. Its wrapped radius is
 *      the Turn's half diameter (0.5), not the bar's (0.75).
 *
 * Mutations (each re-broke the fix on purpose and made this file fail, then the
 * file was restored from a `cp` backup):
 *   1. Hand the unchanged bar back as the model (drop the `if (!applied)
 *      return null`) → the no-opaque-bar assertion fails in all three cases.
 *   2. Drop the canned models when sheet work is visible (skip the `kind ===
 *      'stl'` feature meshes whenever `aroundFeatures.length > 0`) → the
 *      per-model assertions fail.
 *   3. Skip a Thread whose band sits on a Turn (drop Around line features whose
 *      `z_top` is below the bar surface, as a "it is inside the bar" fix would)
 *      → case c loses its line assertions.
 *
 * Run with: npx tsx src/engine/csgThreadOverModelScene.test.ts
 */

import * as THREE from 'three'
import {
  newProject,
  roundStock,
  type Project,
  type SketchFeature,
} from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { THEME_PALETTES } from '../theme/palette'
import { cannedShapeFrame, generateCannedShapeMesh, cannedShapeIsModel } from '../cannedShapes'
import { THREAD_CANNED_KIND } from '../cannedShapes/generators/kinds'
import { rotaryPatternFrame } from './rotaryPatterns'
import { rotaryPatternCannedData } from '../store/helpers/rotaryPatterns'
import { planRotarySolid } from '../store/helpers/rotarySolids'
import { resolvedProjectFeatures } from '../store/helpers/resolveFeatures'
import { rotaryPatternSurface, rotaryPatternSurfaceSpan } from '../store/helpers/rotarySurface'
import type { SelectionState } from '../store/types'
import { buildScene, type SceneObjects } from './csg'

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

/** The report's stock: a Ø1.5 inch round bar, 6 long, along X. */
const BAR_DIAMETER = 1.5
const BAR_RADIUS = BAR_DIAMETER / 2
/** The report's Turn and Hex: Ø1 over start 1.5, length 2. */
const MODEL_START = 1.5
const MODEL_LENGTH = 2
const SURFACE_DIAMETER = 1
const SURFACE_RADIUS = SURFACE_DIAMETER / 2
/** The report's Thread: 5 TPI (0.2 pitch) 2 long, 0.122 deep. */
const THREAD_LENGTH = 2
const THREAD_PITCH = 0.2
const THREAD_DEPTH = 0.122

function barProject(): Project {
  const base = newProject('Thread over models', 'inch')
  base.meta.projectType = 'rotary'
  base.stock = roundStock(BAR_DIAMETER, 6, 'x', { x: 3, y: 3 })
  return base
}

/** The bar's Hex and Turn through the real creation planner, as the dialogs do. */
function modelProject(hexStart: number): Project {
  const base = barProject()
  const turn = planRotarySolid(base, EMPTY_SELECTION, {
    kind: 'turn',
    start: MODEL_START,
    length: MODEL_LENGTH,
    diameter: SURFACE_DIAMETER,
  })
  assert(turn.ok, `the Turn must be created (${turn.ok ? '' : turn.reason})`)
  const hex = planRotarySolid(turn.project, EMPTY_SELECTION, {
    kind: 'polygon',
    start: hexStart,
    length: MODEL_LENGTH,
    sides: 6,
    acrossFlats: SURFACE_DIAMETER,
    rotationDeg: 0,
  })
  assert(hex.ok, `the Hex must be created (${hex.ok ? '' : hex.reason})`)
  return hex.project
}

/**
 * The Thread as the Around dialog writes it: the same stored canned parameters,
 * placement frame and derived Z span the store action produces, appended to the
 * models' project.
 */
function withThread(project: Project, start: number): Project {
  const frame = rotaryPatternFrame(project)
  assert(frame, 'the fixture is a round bar')
  const input = {
    kind: 'thread' as const,
    start,
    length: THREAD_LENGTH,
    pitch: THREAD_PITCH,
    depth: THREAD_DEPTH,
  }
  const canned = rotaryPatternCannedData(frame, input)
  assert(canned, 'the thread parameters are accepted')
  const profile = cannedShapeFrame(canned)
  assert(profile, 'the thread has a placement frame')
  const span = rotaryPatternSurfaceSpan(project, input, THREAD_DEPTH)
  const draft: SketchFeature = {
    id: 'thread',
    name: 'Thread',
    kind: 'composite',
    canned,
    stl: null,
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'line',
    authoringFace: 'around',
    z_top: span.zTop,
    z_bottom: span.zBottom,
    visible: true,
    locked: false,
  }
  return projectWithFeatures(project, [...project.features, draft])
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

/**
 * The distance of every drawn line endpoint from the bar's axis, in the
 * viewport's scene convention: the wrapped sheet point puts the bar's height on
 * scene Y and its across coordinate on scene Z (issue #395).
 */
function drawnLineRadii(scene: SceneObjects, centre: number, radius: number): number[] {
  const radii: number[] = []
  for (const line of scene.batchedLines) {
    const geometry = (line as unknown as THREE.Mesh).geometry
    for (const attribute of ['instanceStart', 'instanceEnd'] as const) {
      const point = geometry.getAttribute(attribute)
      for (let index = 0; index < point.count; index += 1) {
        radii.push(Math.hypot(point.getZ(index) - centre, point.getY(index) - radius))
      }
    }
  }
  return radii
}

interface SceneCase {
  label: string
  /** Where the Hex starts; its band is `MODEL_LENGTH` long. */
  hexStart: number
  threadStart: number
  /** Which surface the thread's band resolves to, and the radius it is drawn at. */
  surface: 'model' | 'turn'
  lineRadius: number
}

const SCENE_CASES: SceneCase[] = [
  {
    label: 'a: Thread start 2, running past the Turn and the Hex',
    hexStart: MODEL_START,
    threadStart: 2,
    surface: 'model',
    lineRadius: BAR_RADIUS,
  },
  {
    label: "b: Thread start 1.5, the Turn's own span",
    hexStart: MODEL_START,
    threadStart: MODEL_START,
    surface: 'model',
    lineRadius: BAR_RADIUS,
  },
  {
    label: 'c: the Thread on the Turn surface, Hex clear of the band',
    hexStart: MODEL_START + MODEL_LENGTH + 0.5,
    threadStart: MODEL_START,
    surface: 'turn',
    lineRadius: SURFACE_RADIUS,
  },
]

for (const testCase of SCENE_CASES) {
  const project = withThread(modelProject(testCase.hexStart), testCase.threadStart)
  const features = resolvedProjectFeatures(project)
  const models = features.filter((feature) => cannedShapeIsModel(feature.canned))
  const thread = features.find((feature) => feature.canned?.kind === THREAD_CANNED_KIND)
  assert(models.length === 2, `${testCase.label}: the project holds the Hex and the Turn (got ${models.length})`)
  assert(thread, `${testCase.label}: the project holds the Thread`)

  const surface = rotaryPatternSurface(project, { start: testCase.threadStart, length: THREAD_LENGTH })
  assert(
    surface.kind === testCase.surface,
    `${testCase.label}: the band resolves to the ${testCase.surface} surface, got ${surface.kind}`,
  )

  const scene = await buildScene(project, threePalette)

  // Nothing opaque stands in for the bar: the stock mesh is what draws it, so
  // the models and the thread inside it are not painted over.
  assert(
    scene.modelMesh === null,
    `${testCase.label}: an unchanged bar is not the boolean model mesh (a Thread alone cuts nothing)`,
  )
  const stockMaterial = scene.stockMesh.material as THREE.MeshStandardMaterial
  assert(
    stockMaterial.transparent === true,
    `${testCase.label}: the bar is drawn by the translucent stock mesh`,
  )

  // Every model is in the scene, drawn from its generated mesh.
  assert(
    scene.featureMeshes.size === models.length,
    `${testCase.label}: one drawn solid per model, got ${scene.featureMeshes.size} (${[...scene.featureMeshes.keys()].join(', ')})`,
  )
  for (const model of models) {
    const drawn = scene.featureMeshes.get(model.id)
    assert(drawn, `${testCase.label}: ${model.name} is in the scene under its own feature id`)
    assert(
      ![...scene.featureMeshes.keys()].some((id) => id.includes(':canned:')),
      `${testCase.label}: no model's placement frame is drawn as a solid`,
    )
    const generated = generateCannedShapeMesh(model.canned)
    assert(generated, `${testCase.label}: ${model.name} generates a mesh`)
    assert(
      vertexCount(drawn) === generated.positions.length / 3,
      `${testCase.label}: ${model.name} draws its generated mesh (${generated.positions.length / 3} vertices), not ${vertexCount(drawn)}`,
    )
  }

  // The thread's wrapped line is drawn, on the surface it is cut on.
  const frame = rotaryPatternFrame(project)
  assert(frame, `${testCase.label}: the fixture is a round bar`)
  const radii = drawnLineRadii(scene, frame.zero, frame.radius)
  assert(radii.length > 0, `${testCase.label}: the Thread puts lines in the scene`)
  // 2 long at a 0.2 pitch is 10 turns, subdivided every 5°.
  assert(
    scene.batchedLinesMeta.segmentCount === 720,
    `${testCase.label}: the 10-turn helix is drawn in full, got ${scene.batchedLinesMeta.segmentCount} segments`,
  )
  for (const radius of radii) {
    assertClose(radius, testCase.lineRadius, 1e-5, `${testCase.label}: drawn line radius`)
  }
}

console.log('Thread over canned models scene tests passed')
