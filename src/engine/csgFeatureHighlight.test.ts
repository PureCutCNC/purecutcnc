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
 * Selecting or hovering a canned model highlights the mesh it is drawn from
 * (issue #1112 F5, review follow-up).
 *
 * Slice F5 stopped drawing a Turn/Polygon twice, so the only thing left on
 * screen for one is its own feature mesh. Selection and hover therefore have to
 * reach that mesh: with no box around it and no combined boolean solid to tint,
 * a row that selects but paints nothing gives the user no feedback at all.
 *
 * The highlight is an in-place recolor, exactly like clamps and tabs (#261):
 * `buildScene` takes no selection, so the viewport recolors the meshes it
 * already built instead of rebuilding the CSG model. The two seams are locked
 * here:
 *   1. (runtime) `applyFeatureHighlights` colors the scene's real Turn/Polygon
 *      meshes — the exact map, helper and palette the viewport calls with.
 *      Selected and hovered are distinct, selected wins, multi-select paints
 *      every selected row, and clearing restores the colour the mesh was built
 *      in (the operation colour for an extrusion, not a palette guess).
 *   2. (structural) Viewport3D mirrors the built feature meshes into a ref,
 *      feeds it `selection.selectedFeatureIds` / `selection.hoveredFeatureId`
 *      from its own effect, and recolors fresh meshes right after a build —
 *      without adding selection to the scene-build effect's dependencies.
 *
 * Mutations (each re-broke the fix on purpose and was caught, then restored
 * from a `cp` backup):
 *   1. Drop `applyFeatureHighlightsRef.current()` from the build completion —
 *      structural check 6 fails.
 *   2. Drop the selection-keyed feature-highlight effect — structural check 5
 *      fails.
 *   3. Pass an empty selection at the Viewport3D call site — structural check 4
 *      fails.
 *   4. Ignore hover in `applyFeatureHighlights` — the hover assertions fail.
 *   5. Honor only the first selected id — the multi-select assertion fails.
 *   6. Stop recording the built colour — clearing an outline extrusion's
 *      highlight falls back to the palette default and the ellipse assertion
 *      fails.
 *   7. Match drawn ids exactly instead of by `<featureId>:` prefix — the
 *      ellipse (drawn as `<id>:canned:0`) never highlights and its assertion
 *      fails.
 *
 * Run with: npx tsx src/engine/csgFeatureHighlight.test.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import { squareStock } from '../types/barStock'
import { newProject, rectProfile, type Project, type SketchFeature } from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { THEME_PALETTES } from '../theme/palette'
import { resolvedProjectFeatures } from '../store/helpers/resolveFeatures'
import { planRotarySolid } from '../store/helpers/rotarySolids'
import type { SelectionState } from '../store/types'
import { applyFeatureHighlights, buildScene } from './csg'

const threePalette = THEME_PALETTES.dark.three

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
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

const AROUND_SETUP = {
  id: 'setup-around',
  name: 'Around',
  kind: 'around' as const,
  indexing: 'manual' as const,
  registration: [] as never[],
  notes: '',
  operationIds: [] as string[],
}

/** A rotary square blank whose workspace face is Around, as Turn/Polygon need. */
function barProject(): Project {
  const base = newProject('Feature highlight', 'mm')
  base.meta.projectType = 'rotary'
  base.stock = squareStock(25, 120, 'x')
  base.setups = [...base.setups, { ...AROUND_SETUP, orientation: { axis: 'x', angleDeg: 0 } }]
  base.activeSetupId = AROUND_SETUP.id
  return base
}

interface DrawnMesh {
  mesh: THREE.Mesh
  material: THREE.MeshStandardMaterial
  geometry: THREE.BufferGeometry
}

/** Every material-carrying mesh under an object, so a group wrapper cannot hide one. */
function drawnMeshes(object: THREE.Object3D): DrawnMesh[] {
  const found: DrawnMesh[] = []
  object.traverse((entry) => {
    if (!(entry instanceof THREE.Mesh)) return
    const materials = Array.isArray(entry.material) ? entry.material : [entry.material]
    for (const material of materials) {
      if (material instanceof THREE.MeshStandardMaterial) {
        found.push({ mesh: entry, material, geometry: entry.geometry })
      }
    }
  })
  return found
}

/** The drawn colours, as the viewport's materials actually report them. */
function drawnColors(object: THREE.Object3D): string[] {
  assert(drawnMeshes(object).length > 0, 'the drawn object carries at least one material')
  return drawnMeshes(object).map((drawn) => drawn.material.color.getHexString())
}

function expectedColor(color: number): string {
  return new THREE.Color(color).getHexString()
}

function assertEveryColor(object: THREE.Object3D, color: number, label: string): void {
  const expected = expectedColor(color)
  for (const actual of drawnColors(object)) {
    assert(actual === expected, `${label}: expected colour ${expected}, got ${actual}`)
  }
}

function assertColorsAreDistinct(a: number, b: number, label: string): void {
  assert(expectedColor(a) !== expectedColor(b), `${label}: expected distinct colours`)
}

// ── 1. A Turn and a Polygon highlight on the mesh alone ─────────────────────

{
  const turn = planRotarySolid(barProject(), EMPTY_SELECTION, {
    kind: 'turn',
    start: 10,
    length: 30,
    diameter: 20,
  })
  assert(turn.ok, `the Turn must be created (${turn.ok ? '' : turn.reason})`)
  const polygon = planRotarySolid(turn.project, EMPTY_SELECTION, {
    kind: 'polygon',
    start: 55,
    length: 30,
    sides: 6,
    acrossFlats: 20,
    rotationDeg: 0,
  })
  assert(polygon.ok, `the Polygon must be created (${polygon.ok ? '' : polygon.reason})`)
  const project = polygon.project

  const models = resolvedProjectFeatures(project)
  assert(models.length === 2, `the project holds the Turn and the Polygon, got ${models.length}`)
  const turnId = models[0].id
  const polygonId = models[1].id
  assert(turnId !== polygonId, 'the two models have distinct ids')

  const scene = await buildScene(project, threePalette)
  assert(scene.modelMesh === null, 'a models-only project has no combined boolean solid to highlight')
  const turnObject = scene.featureMeshes.get(turnId)
  const polygonObject = scene.featureMeshes.get(polygonId)
  assert(turnObject, 'the Turn is drawn as its own feature mesh')
  assert(polygonObject, 'the Polygon is drawn as its own feature mesh')

  // The built appearance is the palette's neutral model colour.
  assertEveryColor(turnObject, threePalette.meshFeatureDefault, 'Turn as built')
  assertEveryColor(polygonObject, threePalette.meshFeatureDefault, 'Polygon as built')

  // The recolor is in place: the same meshes, materials and geometry instances.
  const turnDrawn = drawnMeshes(turnObject)
  const polygonDrawn = drawnMeshes(polygonObject)

  // Selecting the Turn paints the Turn and leaves its neighbour alone.
  applyFeatureHighlights(scene.featureMeshes, { selectedFeatureIds: [turnId], hoveredFeatureId: null }, threePalette)
  assertEveryColor(turnObject, threePalette.meshFeatureSelected, 'Turn selected')
  assertEveryColor(polygonObject, threePalette.meshFeatureDefault, 'Polygon untouched by the Turn selection')
  const turnAfterSelection = drawnMeshes(turnObject)
  assert(
    turnAfterSelection.length === turnDrawn.length,
    `selecting the Turn adds no mesh (was ${turnDrawn.length}, now ${turnAfterSelection.length})`,
  )
  for (let index = 0; index < turnDrawn.length; index += 1) {
    assert(turnAfterSelection[index].mesh === turnDrawn[index].mesh, 'the selected Turn keeps its mesh instance')
    assert(turnAfterSelection[index].material === turnDrawn[index].material, 'the selected Turn keeps its material instance')
    assert(turnAfterSelection[index].geometry === turnDrawn[index].geometry, 'the selected Turn keeps its geometry instance')
  }

  assertColorsAreDistinct(threePalette.meshFeatureSelected, threePalette.meshFeatureDefault, 'selected vs neutral')
  assertColorsAreDistinct(threePalette.meshFeatureHovered, threePalette.meshFeatureDefault, 'hovered vs neutral')
  assertColorsAreDistinct(threePalette.meshFeatureSelected, threePalette.meshFeatureHovered, 'selected vs hovered')

  // Hovering the Polygon paints it and clears the Turn back to its built look.
  applyFeatureHighlights(scene.featureMeshes, { selectedFeatureIds: [], hoveredFeatureId: polygonId }, threePalette)
  assertEveryColor(polygonObject, threePalette.meshFeatureHovered, 'Polygon hovered')
  assertEveryColor(turnObject, threePalette.meshFeatureDefault, 'Turn back to neutral after hover moves')

  // Selected beats hovered for the same row.
  applyFeatureHighlights(scene.featureMeshes, { selectedFeatureIds: [polygonId], hoveredFeatureId: polygonId }, threePalette)
  assertEveryColor(polygonObject, threePalette.meshFeatureSelected, 'a selected and hovered row reads as selected')

  // A multi-selection paints every selected row.
  applyFeatureHighlights(scene.featureMeshes, { selectedFeatureIds: [turnId, polygonId], hoveredFeatureId: null }, threePalette)
  assertEveryColor(turnObject, threePalette.meshFeatureSelected, 'Turn in a multi-selection')
  assertEveryColor(polygonObject, threePalette.meshFeatureSelected, 'Polygon in a multi-selection')

  // Clearing restores the built appearance exactly, and stays idempotent.
  applyFeatureHighlights(scene.featureMeshes, { selectedFeatureIds: [], hoveredFeatureId: null }, threePalette)
  applyFeatureHighlights(scene.featureMeshes, { selectedFeatureIds: [], hoveredFeatureId: null }, threePalette)
  assertEveryColor(turnObject, threePalette.meshFeatureDefault, 'Turn restored')
  assertEveryColor(polygonObject, threePalette.meshFeatureDefault, 'Polygon restored')

  // The highlight follows the palette it is given (the viewport passes live theme).
  applyFeatureHighlights(scene.featureMeshes, { selectedFeatureIds: [turnId], hoveredFeatureId: null }, THEME_PALETTES.light.three)
  assertEveryColor(turnObject, THEME_PALETTES.light.three.meshFeatureSelected, 'Turn selected in the light theme')
  applyFeatureHighlights(scene.featureMeshes, { selectedFeatureIds: [], hoveredFeatureId: null }, threePalette)
  assertEveryColor(turnObject, threePalette.meshFeatureDefault, 'Turn restored after a light-theme highlight')

  // The Polygon's drawn meshes are untouched by the Turn work above.
  assert(polygonDrawn.length === drawnMeshes(polygonObject).length, 'highlighting adds no mesh to the Polygon')}

// ── 2. Generated meshes belong to their source row, and clearing is exact ───

{
  const base = newProject('Canned outline highlight', 'mm')
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
    operation: 'subtract',
    z_top: 5,
    z_bottom: 0,
    authoringFace: 'top',
    visible: true,
    locked: false,
  }
  const project = projectWithFeatures(base, [draft])
  const scene = await buildScene(project, threePalette)
  // A subtract with no base draws its outline extrusion, keyed by the source row.
  const drawnId = `${draft.id}:canned:0`
  const extrusion = scene.featureMeshes.get(drawnId)
  assert(extrusion, `the ellipse is drawn as ${drawnId}`)

  // It was built as a subtract outline, which is the colour clearing must restore.
  assertEveryColor(extrusion, threePalette.meshFeatureSubtract, 'ellipse extrusion as built')

  // Selecting the source row claims the generated mesh it was expanded into.
  applyFeatureHighlights(scene.featureMeshes, { selectedFeatureIds: [draft.id], hoveredFeatureId: null }, threePalette)
  assertEveryColor(extrusion, threePalette.meshFeatureSelected, 'ellipse extrusion selected through its source row')

  // Clearing restores the operation colour recorded at build time, not the
  // palette default an imported-model mesh would use.
  applyFeatureHighlights(scene.featureMeshes, { selectedFeatureIds: [], hoveredFeatureId: null }, threePalette)
  assertEveryColor(extrusion, threePalette.meshFeatureSubtract, 'ellipse extrusion restored to its subtract colour')
  assertColorsAreDistinct(threePalette.meshFeatureSubtract, threePalette.meshFeatureDefault, 'subtract vs neutral')
}

// ── 3. Structural: the viewport wires the selection into that helper ────────

{
  const here = dirname(fileURLToPath(import.meta.url))
  const root = resolve(here, '../..')
  const csgSource = readFileSync(resolve(root, 'src/engine/csg.ts'), 'utf8')
  const viewportSource = readFileSync(
    resolve(root, 'src/components/viewport3d/Viewport3D.tsx'),
    'utf8',
  )

  // 1. The helper the test above exercises is the exported one.
  assert(
    /export function applyFeatureHighlights\(/.test(csgSource),
    'csg.ts must export applyFeatureHighlights for in-place feature recolor',
  )

  // buildScene still cannot consume selection — the highlight must not be a rebuild.
  assert(
    /export async function buildScene\(project: Project, threePalette: ThreeThemePalette\): Promise<SceneObjects>/.test(csgSource),
    'buildScene must still take project + threePalette only',
  )

  // 2. Viewport3D imports it from csg.ts.
  assert(
    /import \{[^}]*\bapplyFeatureHighlights\b[^}]*\} from '\.\.\/\.\.\/engine\/csg'/.test(viewportSource),
    'Viewport3D must import applyFeatureHighlights from engine/csg',
  )

  // 3. The built feature meshes are mirrored into a ref for the recolor.
  assert(
    viewportSource.includes('featureMeshesRef.current = nextSceneObjects.featureMeshes'),
    'Viewport3D must keep the built feature meshes in featureMeshesRef',
  )

  // 4. Selection and hover are the inputs — not a hard-coded empty state.
  assert(
    viewportSource.includes('const selectedFeatureIds = selection.selectedFeatureIds'),
    'Viewport3D must read selection.selectedFeatureIds for feature highlighting',
  )
  assert(
    viewportSource.includes('const hoveredFeatureId = selection.hoveredFeatureId'),
    'Viewport3D must read selection.hoveredFeatureId for feature highlighting',
  )
  assert(
    viewportSource.includes(
      'applyFeatureHighlights(featureMeshesRef.current, { selectedFeatureIds, hoveredFeatureId }, threePalette)',
    ),
    'Viewport3D must recolor the built feature meshes with the current selection and hover',
  )

  // 5. A dedicated selection-keyed effect does the recolor (no rebuild).
  assert(
    /applyFeatureHighlightsToScene\(\)\s*\n\s*\},\s*\[applyFeatureHighlightsToScene\]/.test(viewportSource),
    'Viewport3D must recolor feature meshes in a dedicated selection-keyed effect',
  )

  // 6. A freshly built scene is recolored at once, after its meshes are tracked.
  assert(
    /featureMeshesRef\.current = nextSceneObjects\.featureMeshes\s*\n\s*applyFixtureHighlightsRef\.current\(\)\s*\n\s*applyFeatureHighlightsRef\.current\(\)/.test(
      viewportSource,
    ),
    'Viewport3D must apply the current feature highlight to freshly built meshes',
  )

  // 7. None of this may ride on the scene-build effect's dependency list.
  assert(
    viewportSource.includes(
      '}, [clearRenderedObjects, disposeObjectMaterial, originVisible, project, rebuildGridHelpers])',
    ),
    'the scene-build effect must stay keyed on geometry inputs only',
  )
}

console.log('csgFeatureHighlight.test.ts: all assertions passed')
