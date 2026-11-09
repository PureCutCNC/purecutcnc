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
 * Rotary projects for the exported-motion debug spec (issue #1179).
 *
 * Two fixtures, because the dialog has two distinct cases:
 *
 * - {@link seedAroundRotaryProject} is an Around **pocket** — a wrapped path at
 *   one cutting level, the case the plan view can draw and the level selector
 *   can filter. Its program carries A words, so the wrapped view is offered;
 * - {@link seedRotaryModelProject} is an imported model on a round bar with an
 *   Around setup and no operation: the spec adds a real **Rotary rough** to it.
 *   That operation's cutting Z changes on every move, which is what Frank's
 *   app check of the slice found missing from the coverage (correction round 3):
 *   the pocket alone let the spec pass while a real rotary operation could not
 *   open the dialog at all.
 */

import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { seedGcodeExportProject } from './gcodeExport.helpers'
import { getProject, seedProject } from './helpers'
import {
  defaultTool,
  newProject,
  rectProfile,
  roundStock,
  roundStockCentre,
  IDENTITY_MATRIX,
  type FeatureDefinition,
  type FeatureInstance,
  type MachineDefinition,
  type Project,
  type RoundStock,
  type SketchProfile,
} from '../src/types/project'
import { computeMeshBounds, serializeImportedMesh } from '../src/engine/importedMesh'
import { defaultRoundWorkholding } from '../src/store/helpers/roundWorkholding'

/** A 40 mm round bar along X. */
export const ROTARY_BAR: RoundStock = roundStock(40, 200, 'x', { x: 10, y: 30 })
/** The Around sheet's zero line: the bar's centreline across (issue #1026). */
const ZERO = roundStockCentre(ROTARY_BAR)

const TOOL = { ...defaultTool('mm', 1), id: 't1', name: '3 mm Flat Endmill', diameter: 3, maxCutDepth: 40 }

const IDENTITY = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }

function rect(x: number, y: number, w: number, h: number): SketchProfile {
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

/**
 * A complete bundled definition plus a rotary axis about X. The bundled GRBL
 * carries every block the schema requires, so this is the real machine shape.
 */
function rotaryMachine(): MachineDefinition {
  // Read as a file: importing the definitions module would pull JSON imports
  // into the Playwright runner, which Node refuses without an attribute.
  const grbl = JSON.parse(
    readFileSync(new URL('../src/engine/gcode/definitions/grbl.json', import.meta.url), 'utf8'),
  ) as MachineDefinition
  return {
    ...structuredClone(grbl),
    id: 'e2e-rotary',
    name: 'E2E Rotary Mill',
    builtin: false,
    rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  }
}

/** Seed a rotary project whose only operation is an Around pocket. */
export async function seedAroundRotaryProject(page: Page): Promise<Project> {
  await seedGcodeExportProject(page)
  const seeded = await getProject(page) as unknown as Project
  const project = structuredClone(seeded)
  project.meta.name = 'Around rotary'
  project.meta.units = 'mm'
  project.stock = ROTARY_BAR
  project.origin = { ...project.origin, x: ROTARY_BAR.profile.start.x, y: ROTARY_BAR.profile.start.y, z: ROTARY_BAR.thickness }
  // A rotary project is the only type with an Around face (issue #1028).
  project.meta.projectType = 'rotary'
  project.meta.machineDefinitions = [...(project.meta.machineDefinitions ?? []), rotaryMachine()]
  project.meta.selectedMachineId = 'e2e-rotary'
  project.tools = [TOOL]
  const template = project.features[0]
  const definition = project.featureDefinitions[template.definitionId]
  project.featureDefinitions = {
    ...project.featureDefinitions,
    'around-pocket': {
      ...definition,
      id: 'around-pocket',
      operation: 'subtract',
      // On the sheet: x along the bar, y across it from the zero line.
      profile: rect(50, ZERO + 12, 60, 10),
    },
  }
  project.features = [
    {
      ...template,
      id: 'around-pocket',
      name: 'Around pocket',
      definitionId: 'around-pocket',
      authoringFace: 'around',
      z_top: ROTARY_BAR.thickness,
      z_bottom: ROTARY_BAR.thickness - 4,
      transform: IDENTITY,
    },
  ]
  project.featureTree = []
  project.setups = [
    {
      id: 'setup-around',
      name: 'Around',
      kind: 'around',
      orientation: { axis: 'x', angleDeg: 0 },
      indexing: 'manual',
      registration: [],
      notes: '',
      operationIds: ['op-around'],
    },
  ]
  project.activeSetupId = 'setup-around'
  const base = project.operations[0]
  project.operations = [
    {
      ...base,
      id: 'op-around',
      name: 'Around pocket',
      kind: 'pocket',
      target: { source: 'features', featureIds: ['around-pocket'] },
      setupId: 'setup-around',
      toolRef: TOOL.id,
      stepdown: 2,
      stepover: 0.4,
      feed: 600,
      plungeFeed: 180,
      rpm: 18000,
      enabled: true,
      showToolpath: true,
    },
  ]
  await seedProject(page, JSON.stringify(project))
  return await getProject(page) as unknown as Project
}

/**
 * A round bar with one imported model inside it and the Around setup active,
 * but **no operation**: the caller adds the rotary operation through the app,
 * so the spec exercises the real generator and its real (variable-Z) motion.
 *
 * Written out here rather than imported from `src/test/rotaryOperationFixture.ts`
 * for the reason `rotaryModel.smoke.spec.ts` gives: that module reaches
 * `src/text`, whose JSON font imports the Playwright runner refuses.
 */
export async function seedRotaryModelProject(page: Page): Promise<Project> {
  const base = newProject('Rotary bar model', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.maxTravelZ = 25
  // The Around face and its rotary operations exist only on a rotary project
  // (issue #1028).
  base.meta.projectType = 'rotary'
  const bar = roundStock(12, 30, 'x')
  base.stock = bar
  base.tools = [{
    ...defaultTool('mm', 1),
    id: 't1',
    type: 'ball_endmill',
    diameter: 2,
    defaultStepover: 0.8,
    defaultStepdown: 1,
  }]
  // A small closed asymmetric prism inside the bar, the shape the rotary
  // engine tests cut.
  const positions = new Float32Array([
    3, 4, 4, 27, 4, 4, 27, 8, 4, 3, 8, 4,
    3, 4, 8, 27, 4, 9, 27, 8, 9, 3, 8, 8,
  ])
  const index = new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7])
  base.modelAssets = { asset: serializeImportedMesh({ positions, index, bounds: computeMeshBounds(positions) }, 'stl') }
  const definition: FeatureDefinition = {
    id: 'model', kind: 'stl', profile: rectProfile(3, 4, 24, 4), dimensions: [], text: null,
    stl: { format: 'stl', meshAssetId: 'asset', scale: 1, axisSwap: 'none' }, operation: 'model',
  }
  const feature: FeatureInstance = {
    id: 'model', name: 'Model', definitionId: 'model', transform: IDENTITY_MATRIX, textLayout: null,
    constraints: [], z_top: 9, z_bottom: 4, authoringFace: 'top', folderId: null, visible: true, locked: false,
  }
  base.featureDefinitions = { model: definition }
  base.features = [feature]
  base.featureTree = [{ type: 'feature', featureId: 'model' }]
  base.setups = [...base.setups, { ...base.setups[0], id: 'around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 } }]
  base.activeSetupId = 'around'
  // The app's own workholding for this bar, not an arbitrary block: a chuck
  // that did not clear the blank's envelope would make the generator refuse.
  base.clamps = [{ id: 'chuck', name: 'Chuck', visible: true, ...defaultRoundWorkholding('chuck', bar, 'mm') }]
  base.meta.machineDefinitions = [...(base.meta.machineDefinitions ?? []), rotaryMachine()]
  base.meta.selectedMachineId = 'e2e-rotary'
  await seedProject(page, JSON.stringify(base))
  return await getProject(page) as unknown as Project
}
