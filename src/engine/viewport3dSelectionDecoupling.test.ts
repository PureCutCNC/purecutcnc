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
 * Guard test: 3D-preview selection is decoupled from the CSG model rebuild
 * (issue #261).
 *
 * The expensive `buildBooleanModel` (manifold union/difference of every feature)
 * depends only on geometry, never on selection. Selecting a feature/clamp/tab
 * must therefore recolor the affected fixture in place, NOT rebuild the model.
 * This test locks that at two seams:
 *   1. (runtime) applyClampHighlight / applyTabHighlight mutate an already-built
 *      fixture mesh's material in place — same mesh, same material instance, only
 *      color + opacity change. That is the cheap update that replaces a rebuild.
 *   2. (structural) buildScene takes only `project` — it cannot consume selection
 *      or collision — and the Viewport3D scene-build effect is keyed on geometry
 *      inputs only (no `selection.selectedNode`), with a separate highlight effect.
 *
 * Run with: npx tsx src/engine/viewport3dSelectionDecoupling.test.ts
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as THREE from 'three'
import type { Clamp, Tab } from '../types/project'
import {
  applyClampHighlight,
  applyTabHighlight,
  buildClampMesh,
  buildTabMesh,
} from './csg'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function standardMaterial(mesh: THREE.Mesh): THREE.MeshStandardMaterial {
  const material = mesh.material
  assert(material instanceof THREE.MeshStandardMaterial, 'fixture mesh uses a MeshStandardMaterial')
  return material
}

// ── 1. Runtime: highlight is an in-place recolor, not a rebuild ───────────────

const clamp: Clamp = {
  id: 'clamp-1',
  name: 'Clamp 1',
  type: 'step_clamp',
  x: 0,
  y: 0,
  w: 20,
  h: 10,
  height: 15,
  visible: true,
}

// A clamp built unhighlighted (as buildScene now builds it).
const clampMesh = buildClampMesh(clamp)
const clampMaterial = standardMaterial(clampMesh)
const clampGeometry = clampMesh.geometry
const unselectedColor = clampMaterial.color.getHexString()
const unselectedOpacity = clampMaterial.opacity

// Selecting the clamp must NOT allocate a new mesh/material/geometry — it just
// recolors the existing material. That is what makes it cheaper than a rebuild.
applyClampHighlight(clampMesh, true, false)
assert(clampMesh.material === clampMaterial, 'clamp highlight reuses the same material instance (no rebuild)')
assert(clampMesh.geometry === clampGeometry, 'clamp highlight leaves geometry untouched (no rebuild)')
const selectedColor = clampMaterial.color.getHexString()
assert(selectedColor !== unselectedColor, 'selecting a clamp changes its color in place')
assert(clampMaterial.opacity !== unselectedOpacity, 'selecting a clamp changes its opacity in place')

// Collision is likewise a cheap recolor and is distinct from plain selection.
applyClampHighlight(clampMesh, false, true)
assert(
  clampMaterial.color.getHexString() !== unselectedColor,
  'a colliding clamp recolors without a rebuild',
)
assert(
  clampMaterial.color.getHexString() !== selectedColor,
  'colliding and selected clamps are visually distinct',
)

// Returning to the neutral state restores the original appearance exactly.
applyClampHighlight(clampMesh, false, false)
assert(clampMaterial.color.getHexString() === unselectedColor, 'clearing highlight restores clamp color')
assert(clampMaterial.opacity === unselectedOpacity, 'clearing highlight restores clamp opacity')

const tab: Tab = {
  id: 'tab-1',
  name: 'Tab 1',
  x: 0,
  y: 0,
  w: 8,
  h: 8,
  z_top: 4,
  z_bottom: 0,
  visible: true,
}

const tabMesh = buildTabMesh(tab)
const tabMaterial = standardMaterial(tabMesh)
const tabUnselectedColor = tabMaterial.color.getHexString()
const tabUnselectedOpacity = tabMaterial.opacity

applyTabHighlight(tabMesh, true)
assert(tabMesh.material === tabMaterial, 'tab highlight reuses the same material instance (no rebuild)')
assert(tabMaterial.color.getHexString() !== tabUnselectedColor, 'selecting a tab changes its color in place')
assert(tabMaterial.opacity !== tabUnselectedOpacity, 'selecting a tab changes its opacity in place')

applyTabHighlight(tabMesh, false)
assert(tabMaterial.color.getHexString() === tabUnselectedColor, 'clearing highlight restores tab color')
assert(tabMaterial.opacity === tabUnselectedOpacity, 'clearing highlight restores tab opacity')

// ── 2. Structural: buildScene cannot consume selection; effect is geometry-keyed ─

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '../..')
const csgSource = readFileSync(resolve(root, 'src/engine/csg.ts'), 'utf8')
const viewportSource = readFileSync(
  resolve(root, 'src/components/viewport3d/Viewport3D.tsx'),
  'utf8',
)

// buildScene takes ONLY project — no selectedClampId/selectedTabId/collidingClampIds.
assert(
  /export async function buildScene\(project: Project\): Promise<SceneObjects>/.test(csgSource),
  'buildScene must take only `project` so selection cannot feed the CSG model rebuild',
)
assert(
  !/buildScene\([^)]*selected/i.test(csgSource) && !/buildScene\([^)]*colliding/i.test(csgSource),
  'buildScene must not receive any selection/collision arguments',
)

// The cheap in-place highlight helpers must exist as the rebuild's replacement.
assert(
  /export function applyClampHighlight\(/.test(csgSource),
  'csg.ts must export applyClampHighlight for in-place clamp recolor',
)
assert(
  /export function applyTabHighlight\(/.test(csgSource),
  'csg.ts must export applyTabHighlight for in-place tab recolor',
)

// The model-rebuild path in Viewport3D calls buildScene with project alone.
assert(
  /await buildScene\(project\)/.test(viewportSource),
  'Viewport3D scene-build must call buildScene(project) with no selection arguments',
)

// The scene-build effect must be keyed on geometry inputs only — selection is
// explicitly excluded so it can never re-trigger the rebuild.
assert(
  viewportSource.includes(
    '}, [clearRenderedObjects, disposeObjectMaterial, originVisible, project, rebuildGridHelpers])',
  ),
  'Viewport3D scene-build effect must be keyed on geometry inputs only (no selection.selectedNode)',
)

// A separate lightweight effect recolors fixtures on selection/collision change.
assert(
  /applyFixtureHighlights\(\)\s*\n\s*\},\s*\[applyFixtureHighlights\]/.test(viewportSource),
  'Viewport3D must recolor fixtures in a dedicated selection-keyed effect, not by rebuilding',
)

console.log('viewport3dSelectionDecoupling.test.ts passed')
