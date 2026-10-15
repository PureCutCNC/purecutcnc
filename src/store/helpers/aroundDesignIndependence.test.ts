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
 * Issue #1034 slice A: design is independent of the selected machine.
 *
 * The Around face is defined by the project type and the round bar alone
 * (`aroundFrame` reads only the bar's axis, diameter and centre), so no
 * machine, a plain router, a plasma machine, a matching rotary machine and an
 * opposite-axis rotary machine must all allow the same authoring. Machine
 * suitability is a real requirement only when a program is prepared and
 * posted, which the output-boundary suite covers
 * (`src/app/toolpathGeneration/exportRotarySafety.test.ts`).
 *
 * Run with: npx tsx src/store/helpers/aroundDesignIndependence.test.ts
 */

import assert from 'node:assert/strict'
import { useProjectStore } from '../projectStore'
import { emptySelection } from '../slices/selectionSlice'
import { switchWorkspaceFace } from '../workspaceFace'
import { activeFace, activeSetup, aroundUnavailableReason } from './activeFace'
import { provisionalSetupId } from './provisionalSetup'
import { projectType } from './projectType'
import { machineMode } from '../../components/cam/machineMode'
import { BUNDLED_DEFINITIONS } from '../../engine/gcode/definitions'
import { validateMachineDefinition, type MachineDefinition } from '../../engine/gcode/types'
import { computeOperationToolpath } from '../../engine/toolpaths/generateOperation'
import { defaultOrigin, defaultTool, newProject, rectProfile, roundStock } from '../../types/project'
import type { Project, SketchFeature, Stock } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'

const store = () => useProjectStore.getState()

function bundled(id: string): MachineDefinition {
  const found = BUNDLED_DEFINITIONS.find((definition) => definition.id === id)
  assert.ok(found, `bundled definition ${id} exists`)
  return validateMachineDefinition(structuredClone(found))
}

const PLAIN_ROUTER = validateMachineDefinition({ ...bundled('generic'), id: 'plain-router', name: 'Plain router' })
const QTPLASMAC = bundled('qtplasmac')

function rotaryRouter(about: 'x' | 'y'): MachineDefinition {
  return validateMachineDefinition({
    ...bundled('generic'),
    id: `rotary-${about}`,
    name: `Rotary ${about}`,
    rotary: { about, drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
}

/** Every machine state the acceptance matrix names, keyed by the bar axis it is built for. */
const MACHINE_VARIANTS: ReadonlyArray<{ name: string; at: (axis: 'x' | 'y') => MachineDefinition | null }> = [
  { name: 'no machine', at: () => null },
  { name: 'plain router', at: () => PLAIN_ROUTER },
  { name: 'plasma machine', at: () => QTPLASMAC },
  { name: 'matching rotary', at: (axis) => rotaryRouter(axis) },
  { name: 'opposite rotary', at: (axis) => rotaryRouter(axis === 'x' ? 'y' : 'x') },
]

function barStock(axis: 'x' | 'y', units: 'mm' | 'inch'): Stock {
  return roundStock(units === 'inch' ? 1.5 : 40, units === 'inch' ? 8 : 180, axis)
}

/** A rotary project with a round bar, optionally carrying a machine. */
function roundBarProject(axis: 'x' | 'y', units: 'mm' | 'inch', machine: MachineDefinition | null): Project {
  const base = newProject('design independent', units)
  const stock = barStock(axis, units)
  return {
    ...base,
    meta: {
      ...base.meta,
      projectType: 'rotary',
      machineDefinitions: machine ? [machine] : [],
      selectedMachineId: machine?.id ?? null,
    },
    stock,
    origin: defaultOrigin(stock),
    tools: [{ ...defaultTool(units, 1), id: 't1', diameter: units === 'inch' ? 0.125 : 2, maxCutDepth: stock.thickness }],
  }
}

/** A shallow cut into the bar surface, on the Around face. */
function aroundShape(id: string, stock: Stock, scale = 1): SketchFeature {
  const depth = stock.thickness / 8
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: { profile: rectProfile(2 * scale, 2 * scale, 4 * scale, 4 * scale), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: stock.thickness,
    z_bottom: stock.thickness - depth,
    visible: true,
    locked: false,
  }
}

function seed(project: Project): void {
  useProjectStore.setState({
    project,
    pendingAdd: null,
    selection: emptySelection(),
    history: { past: [], future: [], transactionStart: null },
  })
}

function usesAroundSetup(project: Project): boolean {
  return project.setups.some((setup) => setup.kind === 'around')
}

// ── The authoring matrix ──────────────────────────────────────

console.log('Around authoring is independent of the machine (issue #1034 slice A)')
for (const axis of ['x', 'y'] as const) {
  for (const units of ['mm', 'inch'] as const) {
    MACHINE_VARIANTS.forEach((variant, index) => {
      const label = `${axis} bar, ${units}, ${variant.name}`
      seed(roundBarProject(axis, units, variant.at(axis)))

      assert.equal(aroundUnavailableReason(store().project), null, `${label}: Around is authorable`)
      assert.equal(switchWorkspaceFace('around'), true, `${label}: the face switch enters Around`)
      assert.equal(activeFace(store().project), 'around', `${label}: the workspace is on Around`)
      assert.equal(activeSetup(store().project).kind, 'around', `${label}: seen through an Around setup`)

      // Create geometry on the face: the provisional setup becomes real in the
      // same undo step (issue #945), with no machine involved.
      store().addFeature(aroundShape('shape', store().project.stock))
      const authored = store().project
      assert.equal(
        authored.features.some((feature) => feature.id === 'shape' && feature.authoringFace === 'around'),
        true,
        `${label}: the shape is authored on Around`,
      )
      assert.equal(usesAroundSetup(authored), true, `${label}: the setup is realized`)
      assert.notEqual(activeSetup(authored).id, provisionalSetupId('around'), `${label}: no longer provisional`)

      // Changing the machine must not evict the face, its setup or its content.
      const next = MACHINE_VARIANTS[(index + 1) % MACHINE_VARIANTS.length].at(axis)
      store().setProjectMachine(next)
      assert.equal(activeFace(store().project), 'around', `${label}: the face survives the machine change`)
      assert.deepEqual(store().project.features, authored.features, `${label}: geometry survives`)
      assert.deepEqual(store().project.setups, authored.setups, `${label}: the Around setup survives`)
    })
  }
}

// ── Provisional realization, undo/redo and design preview ─────

console.log('Provisional realization, undo/redo and design preview')
seed(roundBarProject('x', 'mm', null))
assert.equal(switchWorkspaceFace('around'), true)
store().addFeature(aroundShape('shape', store().project.stock))
const realized = store().project
assert.equal(store().history.past.length, 1, 'shape and realized setup are one undo step')
assert.equal(usesAroundSetup(realized), true)

store().undo()
const undone = store().project
assert.equal(usesAroundSetup(undone), false, 'undo removes the realized setup with the shape')
assert.equal(undone.features.some((feature) => feature.id === 'shape'), false, 'and the shape')
assert.equal(activeFace(undone), 'around', 'while the workspace stays on the face it was looking at')

store().redo()
assert.equal(usesAroundSetup(store().project), true, 'redo restores the setup and the shape')

const shapeOperation = store().addOperation('pocket', 'rough', { source: 'features', featureIds: ['shape'] })
assert.ok(shapeOperation, 'a rotary project authors an operation on the Around shape with no machine')
store().updateOperation(shapeOperation, { toolRef: 't1', entryStrategy: 'plunge', stepdown: 2, carveDepth: 1 })
const preview = computeOperationToolpath(store().project, store().project.operations.find((operation) => operation.id === shapeOperation)!)
assert.ok(preview && preview.result.moves.length > 0, 'the design preview generates real motion with no machine')

// An imported rotary model is authored and previewed without a machine too.
const bar = rotaryOperationFixture('x', 'rotary_rough')
const machineFreeBar: Project = {
  ...bar,
  meta: { ...bar.meta, projectType: 'rotary', machineDefinitions: [], selectedMachineId: null },
}
const rotaryPreview = computeOperationToolpath(machineFreeBar, machineFreeBar.operations[0])
assert.ok(rotaryPreview && rotaryPreview.result.moves.length > 0, 'a rotary model previews with no machine')

// ── Save/load and machine changes keep content ────────────────

console.log('Save/load and machine changes keep authored content')
store().loadProject(machineFreeBar)
const machineFreePaths = store().project.operations.map((operation) => computeOperationToolpath(store().project, operation)!.result)
assert.ok(machineFreePaths.every((path) => path.moves.length > 0), 'the machine-free project generates before saving')
const saved = store().saveProject()
store().openProjectFromText(saved, null)
const reloadedPaths = store().project.operations.map((operation) => computeOperationToolpath(store().project, operation)!.result)
assert.deepEqual(reloadedPaths, machineFreePaths, 'reloading a machine-free rotary project generates identical paths')

const beforeMachineChange = store().project
store().setProjectMachine(rotaryRouter('y'))
assert.equal(store().project.meta.projectType, 'rotary', 'a machine change does not change the project type')
assert.deepEqual(store().project.features, beforeMachineChange.features, 'and keeps the authored features')
assert.deepEqual(store().project.operations, beforeMachineChange.operations, 'and the authored operations')

// ── Type and stock still constrain the face ───────────────────

console.log('Type and stock still constrain Around')
const rotaryBase = roundBarProject('x', 'mm', null)
// A round bar on a milling project proves the type is asked before the stock.
const milling: Project = { ...rotaryBase, meta: { ...rotaryBase.meta, projectType: 'milling' }, stock: newProject('m', 'mm').stock }
seed(milling)
assert.equal(aroundUnavailableReason(store().project), 'needsRotaryProject', 'a milling project has no Around')
assert.equal(switchWorkspaceFace('around'), false)

// A plasma project with a round bar proves the type wins over the stock too.
const plasma: Project = { ...rotaryBase, meta: { ...rotaryBase.meta, projectType: 'plasma' } }
seed(plasma)
assert.equal(aroundUnavailableReason(store().project), 'needsRotaryProject', 'a plasma project has no Around')
assert.equal(switchWorkspaceFace('around'), false)
assert.equal(store().createSetup({ kind: 'around', orientation: { axis: 'x', angleDeg: 0 } }), null, 'and cannot create the setup')

const blockRotary: Project = { ...rotaryBase, stock: newProject('b', 'mm').stock }
seed(blockRotary)
assert.equal(aroundUnavailableReason(store().project), 'needsRoundBar', 'a block is not a bar')
assert.equal(switchWorkspaceFace('around'), false)
assert.equal(store().createSetup({ kind: 'around', orientation: { axis: 'x', angleDeg: 0 } }), null)

// The busy guard is unchanged: a move in progress keeps the face where it is.
seed(roundBarProject('x', 'mm', null))
assert.equal(switchWorkspaceFace('around'), true)
store().addFeature(aroundShape('shape', store().project.stock))
store().startMoveFeature('shape')
store().setPendingMoveFrom({ x: 0, y: 0 })
assert.notEqual(store().pendingMove, null, 'a move is pending')
assert.equal(switchWorkspaceFace('top'), false, 'the face cannot change mid-move')
assert.equal(activeFace(store().project), 'around', 'the workspace stays on the face the move started on')

// ── The Plasma audit ──────────────────────────────────────────

console.log('Plasma authoring is independent of the machine')
function plasmaProject(machine: MachineDefinition | null): Project {
  const base = newProject('plasma design', 'mm')
  const withMachine: Project = {
    ...base,
    meta: { ...base.meta, projectType: 'plasma', machineDefinitions: machine ? [machine] : [], selectedMachineId: machine?.id ?? null },
  }
  return projectWithFeatures(withMachine, [{
    id: 'cut', name: 'Cut', kind: 'rect', folderId: null,
    sketch: { profile: rectProfile(0, 0, 20, 20), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract', z_top: 3, z_bottom: 0, visible: true, locked: false,
  }])
}

for (const [name, machine] of [['no machine', null], ['plain router', PLAIN_ROUTER]] as const) {
  seed(plasmaProject(machine))
  assert.equal(projectType(store().project), 'plasma', `${name}: the project stays plasma`)
  assert.equal(machineMode(store().project), 'plasma', `${name}: the CAM panel stays in plasma mode`)

  const toolId = store().addTool()
  const createdTool = store().project.tools.find((tool) => tool.id === toolId)
  assert.equal(createdTool?.type, 'plasma', `${name}: Add tool creates a plasma torch`)

  const operationId = store().addOperation('plasma_profile', 'rough', { source: 'features', featureIds: ['cut'] })
  assert.ok(operationId, `${name}: a plasma profile is authored`)
  assert.equal(
    store().project.operations.find((operation) => operation.id === operationId)?.kind,
    'plasma_profile',
    `${name}: and it is a plasma cut`,
  )

  const authored = store().project
  store().setProjectMachine(QTPLASMAC)
  assert.equal(projectType(store().project), 'plasma', `${name}: a machine change keeps the type`)
  assert.equal(machineMode(store().project), 'plasma', `${name}: and the mode`)
  assert.deepEqual(store().project.operations, authored.operations, `${name}: and every authored operation`)
  assert.deepEqual(store().project.tools, authored.tools, `${name}: and every authored tool`)
}

console.log('All design-independence tests passed')
