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
 * The Simulation tab's plasma kerf selection (issue #961, slice B).
 *
 * The selection is pure, so it is pinned without a hook or a renderer: a
 * plasma operation with a torch and a path in hand yields an item, a milling
 * operation or a missing path yields none, and the mode decides between the
 * selected operation and every enabled, shown plasma cut of the setup.
 *
 * Mutations these assertions were checked against:
 * - dropping the `plasmaKerfWidth` check → a milling operation with a path in
 *   hand appears in `'visible'` mode (and in `'selected'` mode when selected);
 * - reading the toolpath map without the setup's `operations` filter (the
 *   enabled/shown gate) → a disabled plasma operation appears.
 *
 * Run with: npx tsx src/app/simulationPlasmaKerf.test.ts
 */

import assert from 'node:assert/strict'
import { generatePlasmaProfileToolpath } from '../engine/toolpaths/plasma'
import type { ToolpathResult } from '../engine/toolpaths/types'
import { defaultOperationForTarget } from '../store/helpers/operationDefaults'
import { defaultPlasmaTool } from '../toolPolicy'
import { projectWithFeatures } from '../test/projectFixtures'
import { defaultTool, newProject, type Operation, type Project, type SketchFeature, type SketchProfile } from '../types/project'
import { DEFAULT_TOOLPATH_VISIBILITY } from '../components/toolpathVisibility'
import { selectSimulationPlasmaKerf } from './simulationPlasmaKerf'
import type { SimulationSetupInput } from './simulationSetup'

function square(x: number, y: number, w: number, h = w): SketchProfile {
  return {
    start: { x, y },
    segments: [
      { type: 'line', to: { x: x + w, y } },
      { type: 'line', to: { x: x + w, y: y + h } },
      { type: 'line', to: { x, y: y + h } },
      { type: 'line', to: { x, y } },
    ],
    closed: true,
  }
}

function feature(id: string, operation: SketchFeature['operation']): SketchFeature {
  return {
    id, name: id, kind: 'rect', operation, folderId: null, visible: true, locked: false, z_top: 6, z_bottom: 0,
    sketch: { profile: square(20, 20, 60), dimensions: [], constraints: [], origin: { x: 0, y: 0 }, orientationAngle: 0 },
  }
}

function fixture(): Project {
  const project = newProject('Plasma simulation fixture', 'mm')
  project.stock.thickness = 6
  project.tools = [
    { ...defaultPlasmaTool('mm'), id: 'torch', name: 'Torch', diameter: 2, cutHeight: 1.5, defaultFeed: 2200 },
    defaultTool('mm'),
  ]
  return projectWithFeatures(project, [feature('part', 'add')])
}

function plasmaOperation(project: Project, index = 0, patch: Partial<Operation> = {}): Operation {
  return {
    ...defaultOperationForTarget(project, 'plasma_profile', 'rough', { source: 'features', featureIds: ['part'] }, index),
    ...patch,
  }
}

function millingOperation(project: Project): Operation {
  return defaultOperationForTarget(project, 'pocket', 'rough', { source: 'features', featureIds: ['part'] }, 1)
}

/** A non-empty path, so a dropped plasma guard has something to draw. */
function cutPath(operationId: string): ToolpathResult {
  return {
    operationId,
    moves: [{ kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } }],
    warnings: [],
    bounds: null,
  }
}

const base = fixture()
const plasma = plasmaOperation(base)
const plasmaPath = generatePlasmaProfileToolpath(base, plasma)
assert.ok(plasmaPath.moves.length > 0, 'the plasma fixture generates a toolpath')

const milling = millingOperation(base)
const millingPath = cutPath(milling.id)
const project: Project = { ...base, operations: [plasma, milling] }

function setupInput(overrides: Partial<SimulationSetupInput> = {}): SimulationSetupInput {
  return {
    project,
    operations: [plasma, milling],
    toolpaths: new Map([[plasma.id, plasmaPath], [milling.id, millingPath]]),
    ...overrides,
  }
}

// ── The tab and the setup input gate everything ──────────────────────────

assert.deepEqual(selectSimulationPlasmaKerf(false, setupInput(), 'visible', null), [], 'another centre tab shows no kerf')
assert.deepEqual(selectSimulationPlasmaKerf(true, null, 'visible', null), [], 'no setup input shows no kerf')
assert.deepEqual(selectSimulationPlasmaKerf(true, setupInput(), 'visible', null).length, 1, 'one plasma band in visible mode')
assert.deepEqual(selectSimulationPlasmaKerf(true, setupInput(), 'selected', null), [], 'nothing selected shows no kerf')

// ── 'visible' mode: the plasma cuts only ─────────────────────────────────

{
  const items = selectSimulationPlasmaKerf(true, setupInput(), 'visible', null)
  assert.equal(items.length, 1, 'a milling operation does not contribute a band')
  assert.equal(items[0].operationId, plasma.id, 'the plasma operation is the one item')
  assert.equal(items[0].width, 2, 'the width is the torch diameter')
  assert.ok(items[0].geometry.contour.length > 0, 'the item carries the generated contour geometry')
  assert.ok(
    items.every((item) => Number.isFinite(item.width) && item.width > 0),
    'every item has a finite positive kerf width',
  )
  assert.ok(
    items.every((item) => item.operationId === plasma.id),
    'the non-plasma operation with a path in hand never appears',
  )
}

// ── 'selected' mode: the selected operation alone ────────────────────────

{
  const items = selectSimulationPlasmaKerf(true, setupInput(), 'selected', plasma.id)
  assert.equal(items.length, 1, 'the selected plasma operation shows its band')
  assert.equal(items[0].operationId, plasma.id)

  assert.deepEqual(
    selectSimulationPlasmaKerf(true, setupInput(), 'selected', milling.id),
    [],
    'a selected milling operation gives no band',
  )
  assert.deepEqual(
    selectSimulationPlasmaKerf(true, setupInput(), 'selected', 'missing'),
    [],
    'a selected unknown operation gives no band',
  )
}

// ── Eligibility: enabled, shown, torch and path all required ─────────────

{
  const disabled = plasmaOperation(base, 0, { enabled: false })
  const disabledInput = setupInput({
    operations: [disabled],
    project: { ...base, operations: [disabled] },
  })
  assert.deepEqual(
    selectSimulationPlasmaKerf(true, disabledInput, 'visible', null),
    [],
    'a disabled plasma operation is not drawn',
  )
  // The selected operation is drawn whatever its enabled flag says — the
  // mode's own contract, not the visible-set gate.
  assert.equal(
    selectSimulationPlasmaKerf(true, disabledInput, 'selected', disabled.id).length,
    1,
    'the selected operation is drawn in selected mode',
  )

  const hidden = plasmaOperation(base, 0, { showToolpath: false })
  assert.deepEqual(
    selectSimulationPlasmaKerf(
      true,
      setupInput({ operations: [hidden], project: { ...base, operations: [hidden] } }),
      'visible',
      null,
    ),
    [],
    'a plasma operation with its toolpath hidden is not drawn',
  )

  const noTool = plasmaOperation(base, 0, { toolRef: null })
  assert.deepEqual(
    selectSimulationPlasmaKerf(
      true,
      setupInput({ operations: [noTool], project: { ...base, operations: [noTool] } }),
      'visible',
      null,
    ),
    [],
    'a plasma operation without a torch is not drawn',
  )

  const noPath = setupInput({ toolpaths: new Map() })
  assert.deepEqual(
    selectSimulationPlasmaKerf(true, noPath, 'visible', null),
    [],
    'a plasma operation with no path in hand is read, never generated',
  )
  assert.deepEqual(
    selectSimulationPlasmaKerf(true, noPath, 'selected', plasma.id),
    [],
    'selected mode also skips a missing path',
  )
}

// ── Order follows the setup's cut order ──────────────────────────────────

{
  const second = plasmaOperation(base, 1)
  const reversed = setupInput({
    operations: [second, plasma],
    project: { ...base, operations: [second, plasma] },
    toolpaths: new Map([[plasma.id, plasmaPath], [second.id, plasmaPath]]),
  })
  const items = selectSimulationPlasmaKerf(true, reversed, 'visible', null)
  assert.deepEqual(
    items.map((item) => item.operationId),
    [second.id, plasma.id],
    'items keep the setup operations order',
  )
}

// The default visibility is not consulted here — the Simulation tab always
// draws its bands when the list says so. Pinned so a future gate is a
// deliberate decision, not an accident.
assert.ok(DEFAULT_TOOLPATH_VISIBILITY.cuts, 'the default visibility has cuts on')

console.log('simulationPlasmaKerf tests passed')
