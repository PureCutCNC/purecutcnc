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
 * The accepted square-blank Around fixture (issue #1016 C2-R2V), shared by the
 * app wiring test and the square-simulation worker test (issue #1016 C2 P2).
 *
 * The fixture uses the same default round workholding the app mints on a square
 * blank: a chuck centred on the true pivot whose diameter clears the corner
 * envelope. A hand-written round-sized chuck is physically invalid on a square
 * and the production dispatch refuses it, so the fixture must not substitute
 * one.
 */

import { defaultOperationForTarget } from '../store/helpers/operationDefaults'
import { defaultRoundWorkholding } from '../store/helpers/roundWorkholding'
import { projectWithFeatures } from './projectFixtures'
import {
  defaultTool,
  newProject,
  rectProfile,
  type MachiningSetup,
  type Operation,
  type Project,
  type SketchFeature,
} from '../types/project'
import { squareStock } from '../types/barStock'
import { computeMeshBounds, serializeImportedMesh } from '../engine/importedMesh'
import { computeOperationToolpath } from '../engine/toolpaths/generateOperation'
import type { ToolpathResult } from '../engine/toolpaths/types'
import { buildSimulationSetupInput, type SimulationSetupInput } from '../app/simulationSetup'
import type { SimulationResultInput } from '../app/simulationCompute'

export const SIDE = 12
export const LENGTH = 30
/** Coarse enough for a focused test; the kernel-resolution parity is #1016 R1's. */
export const DETAIL = 60

/**
 * A rotary project on a square blank with one imported prism model and one real
 * rotary rough. `at` places the blank (and the model with it), so a nonzero
 * value exercises a grid origin away from zero; `axis` swaps along/across.
 */
export function squareRotaryProject(
  axis: 'x' | 'y',
  at: { x: number; y: number } = { x: 0, y: 0 },
  units: 'mm' | 'inch' = 'mm',
): { project: Project; operation: Operation; setup: MachiningSetup } {
  const base = newProject('square simulation', units)
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.maxTravelZ = 25
  base.meta.projectType = 'rotary'
  const stock = squareStock(SIDE, LENGTH, axis, at)
  base.stock = stock
  base.tools = [{
    ...defaultTool(units, 1),
    id: 't1',
    type: 'ball_endmill',
    diameter: 2,
    defaultStepover: 0.8,
    defaultStepdown: 1,
  }]

  // The accepted fixture's small closed asymmetric prism: along 3..27, across
  // -2..2 about the bar centre, top 9 / bottom 4. Placed inside the blank.
  const raw = new Float32Array([
    3, -2, 4, 27, -2, 4, 27, 2, 4, 3, 2, 4,
    3, -2, 8, 27, -2, 9, 27, 2, 9, 3, 2, 8,
  ])
  const alongAt = axis === 'x' ? at.x : at.y
  const acrossAt = axis === 'x' ? at.y : at.x
  const positions = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i += 3) {
    const along = alongAt + raw[i]
    const across = acrossAt + SIDE / 2 + raw[i + 1]
    const z = raw[i + 2]
    if (axis === 'x') {
      positions[i] = along
      positions[i + 1] = across
    } else {
      positions[i] = across
      positions[i + 1] = along
    }
    positions[i + 2] = z
  }
  const index = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
  base.modelAssets = { asset: serializeImportedMesh({ positions, index, bounds: computeMeshBounds(positions) }, 'stl') }

  const model: SketchFeature = {
    id: 'model', name: 'Model', kind: 'stl', operation: 'model', authoringFace: 'top', folderId: null,
    sketch: {
      profile: axis === 'x' ? rectProfile(at.x + 3, at.y + 4, 24, 4) : rectProfile(at.x + 4, at.y + 3, 4, 24),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    stl: { format: 'stl', meshAssetId: 'asset', scale: 1, axisSwap: 'none' },
    z_top: 9, z_bottom: 4, visible: true, locked: false,
  }
  const around: SketchFeature = {
    ...model, id: 'sketch', name: 'Sketch', kind: 'rect', operation: 'subtract',
    stl: null, authoringFace: 'around', z_top: 12, z_bottom: 10,
  }
  const project = projectWithFeatures(base, [model, around])
  project.setups.push({
    ...project.setups[0],
    id: 'around', name: 'Around', kind: 'around', orientation: { axis, angleDeg: 0 },
  })
  project.activeSetupId = 'around'
  // The real default chuck, exactly as the app mints one on a square blank:
  // centred at the true pivot and sized past the corner envelope. The
  // production dispatch's physical guard refuses anything less.
  project.clamps = [{
    ...defaultRoundWorkholding('chuck', stock, units),
    id: 'chuck',
    name: 'Chuck',
    visible: true,
  }]
  const operation: Operation = {
    ...defaultOperationForTarget(project, 'rotary_rough', 'rough', { source: 'features', featureIds: ['model'] }, 0),
    setupId: 'around',
    stockToLeaveRadial: 0.4,
  }
  project.operations = [operation]
  return { project, operation, setup: project.setups.find((entry) => entry.id === 'around')! }
}

/**
 * The accepted generated path, through the production dispatch every app
 * consumer uses. `computeOperationToolpath` admits the square blank and runs
 * the rotary generator itself; a refused setup comes back as an empty path
 * carrying `postSetupOperationRefused`, so the assertions below reject it.
 */
export function generated(project: Project, operation: Operation): ToolpathResult {
  const envelope = computeOperationToolpath(project, operation)
  if (!envelope) throw new Error('fixture: the production dispatch handles the square rotary rough')
  const result = envelope.result
  if (result.moves.length === 0) throw new Error('fixture: the generated square rough is nonempty')
  if (result.warnings.some((warning) => warning.code === 'postSetupOperationRefused')) {
    throw new Error('fixture: production admits the square setup instead of refusing it')
  }
  if (result.warnings.length !== 0) {
    throw new Error(`fixture: the generated square rough warns (${JSON.stringify(result.warnings)})`)
  }
  return result
}

/** The setup input for the fixture's Around setup, with one generated path. */
export function inputFor(
  project: Project,
  operation: Operation,
  toolpath: ToolpathResult,
  paths: ReadonlyMap<string, ToolpathResult> = new Map([[operation.id, toolpath]]),
): SimulationSetupInput {
  const input = buildSimulationSetupInput(project, project.setups.find((entry) => entry.id === 'around')!, paths)
  if (!input) throw new Error('fixture: the around setup yields a simulation input')
  return input
}

/** The synchronous result input for one mode, as `useSimulationModel` builds it. */
export function resultArgs(
  project: Project,
  operation: Operation,
  input: SimulationSetupInput,
  mode: 'selected' | 'visible',
  withOperation = true,
): SimulationResultInput {
  const paths = new Map([[operation.id, input.toolpaths.get(operation.id)!]])
  return {
    setupInput: input,
    project,
    simulationMode: mode,
    simulationDetailCells: DETAIL,
    selectedInSetup: withOperation ? operation : null,
    paths,
  }
}
