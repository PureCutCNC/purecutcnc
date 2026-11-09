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
 * A rotary project with one Around operation, for the exported-motion debug
 * spec (issue #1179).
 *
 * The project is seeded through the page's store, as `around3d.smoke.spec.ts`
 * does: the export fixture, then a bar, a rotary machine and an Around pocket
 * whose wrapped program carries A words. That makes the debug dialog's 3D
 * wrapped view available — and, because the pocket is the only operation, the
 * Export dialog's "Inspect exported motion" action is offered for it.
 */

import { readFileSync } from 'node:fs'
import type { Page } from '@playwright/test'
import { seedGcodeExportProject } from './gcodeExport.helpers'
import { getProject, seedProject } from './helpers'
import {
  defaultTool,
  roundStock,
  roundStockCentre,
  type MachineDefinition,
  type Project,
  type RoundStock,
  type SketchProfile,
} from '../src/types/project'

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
