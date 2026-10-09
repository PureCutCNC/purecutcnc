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
 * Plasma projects exported through the real toolpath and post-processor
 * (issue #959). The unit tests and the QtPlasmaC simulator corpus build the
 * same programs from here, so the simulator always runs what we export today.
 */

import type { Operation, Project, SketchFeature, SketchProfile, Tool } from '../types/project'
import { circleProfile, newProject } from '../types/project'
import { defaultPlasmaTool } from '../toolPolicy'
import { defaultOperationForTarget } from '../store/helpers/operationDefaults'
import { generatePlasmaProfileToolpath } from '../engine/toolpaths/plasma'
import { normalizeToolForProject } from '../engine/toolpaths/geometry'
import { BUNDLED_DEFINITIONS } from '../engine/gcode/definitions'
import { runPostProcessor } from '../engine/gcode/postprocessor'
import type { MachineDefinition, PostProcessorInput, PostProcessorResult } from '../engine/gcode/types'
import { convertLength } from '../utils/units'
import { projectWithFeatures } from './projectFixtures'

export function rectangle(x: number, y: number, w: number, h: number): SketchProfile {
  return {
    start: { x, y },
    segments: [
      { type: 'line', to: { x: x + w, y } }, { type: 'line', to: { x: x + w, y: y + h } },
      { type: 'line', to: { x, y: y + h } }, { type: 'line', to: { x, y } },
    ],
    closed: true,
  }
}

export function sheetFeature(id: string, operation: SketchFeature['operation'], profile: SketchProfile, thickness: number): SketchFeature {
  return {
    id, name: id, kind: 'rect', operation, folderId: null, visible: true, locked: false, z_top: thickness, z_bottom: 0,
    sketch: { profile, dimensions: [], constraints: [], origin: { x: 0, y: 0 }, orientationAngle: 0 },
  }
}

/** One plasma operation over `featureIds`, in that cut order, with its tool. */
export interface PlasmaOperationSpec {
  featureIds: string[]
  tool?: Partial<Tool>
  operation?: Partial<Operation>
}

export interface PlasmaExportSpec {
  units: 'mm' | 'inch'
  /** Sheet thickness, in project units. */
  thickness: number
  /** In feature order: parts (`add`) before the holes cut in them. */
  features: Array<{ id: string; operation: SketchFeature['operation']; profile: SketchProfile }>
  operations: PlasmaOperationSpec[]
  machineId?: string
  definition?: (definition: MachineDefinition) => MachineDefinition
}

export interface PlasmaExport {
  input: PostProcessorInput
  result: PostProcessorResult
}

/**
 * Export a plasma project. Each operation gets its own torch tool, defaulting
 * to the bundled consumable with QtPlasmaC material 1 (the simulator reserves
 * material 0 for "nothing selected").
 */
export function exportPlasma(spec: PlasmaExportSpec): PlasmaExport {
  const base = newProject('Plasma export', spec.units)
  base.stock.thickness = spec.thickness
  // Project Y runs down the sheet; a machine origin 200 mm below the top
  // edge keeps every scenario on the positive quadrant of the sim table.
  base.origin = { ...base.origin, x: 0, y: convertLength(200, 'mm', spec.units) }
  base.tools = spec.operations.map((op, index) => ({
    ...defaultPlasmaTool(spec.units),
    id: `torch-${index + 1}`,
    name: `Torch ${index + 1}`,
    qtplasmacMaterialNumber: 1,
    ...op.tool,
  }))
  const project: Project = projectWithFeatures(base, spec.features.map((f) => sheetFeature(f.id, f.operation, f.profile, spec.thickness)))
  const machine = BUNDLED_DEFINITIONS.find((candidate) => candidate.id === (spec.machineId ?? 'qtplasmac'))
  if (!machine) throw new Error(`no bundled machine ${spec.machineId}`)
  const definition = spec.definition ? spec.definition(structuredClone(machine)) : structuredClone(machine)
  const operations = spec.operations.map((op, index) => {
    const operation: Operation = {
      ...defaultOperationForTarget(project, 'plasma_profile', 'rough', { source: 'features', featureIds: op.featureIds }, 0),
      id: `cut-${index + 1}`,
      name: `Cut ${index + 1}`,
      toolRef: `torch-${index + 1}`,
      ...op.operation,
    }
    const tool = project.tools.find((candidate) => candidate.id === operation.toolRef)!
    return { operation, tool: normalizeToolForProject(tool, project), toolpath: generatePlasmaProfileToolpath(project, operation) }
  })
  const input: PostProcessorInput = {
    project,
    definition,
    operations,
    options: { emitToolChanges: false, emitCoolant: false, programName: 'plasma' },
  }
  return { input, result: runPostProcessor(input) }
}

/** The reference shapes of the QtPlasmaC corpus, as exported programs. */
export const PLASMA_EXPORT_SCENARIOS: Record<string, () => PlasmaExportSpec> = {
  'single-outline': () => ({
    units: 'mm', thickness: 2,
    features: [{ id: 'plate', operation: 'add', profile: rectangle(20, 20, 120, 80) }],
    operations: [{ featureIds: ['plate'] }],
  }),
  'part-with-holes': () => ({
    units: 'mm', thickness: 2,
    features: [
      { id: 'plate', operation: 'add', profile: rectangle(20, 20, 120, 80) },
      { id: 'hole-1', operation: 'subtract', profile: circleProfile(55, 60, 20) },
      { id: 'hole-2', operation: 'subtract', profile: circleProfile(105, 60, 20) },
    ],
    operations: [{ featureIds: ['hole-1', 'hole-2', 'plate'] }],
  }),
  // A hole small enough for QtPlasmaC's own `#<holes>` handling: under its
  // 32 mm default it reduces the cut feed to 60%. Straight leads, as the
  // manual recommends for holes. The folded circle spells its own G3 either
  // way; this case keeps the straight-lead shape covered.
  'small-hole': () => ({
    units: 'mm', thickness: 2,
    features: [
      { id: 'plate', operation: 'add', profile: rectangle(20, 20, 120, 80) },
      { id: 'hole-1', operation: 'subtract', profile: circleProfile(70, 60, 10) },
    ],
    operations: [{ featureIds: ['hole-1', 'plate'], operation: { plasmaLeadIn: 'line', plasmaLeadOut: 'line' } }],
  }),
  // The same hole with the operation's default arc lead-in, which leaves G3
  // modal before the folded circle. The folded block still spells its own G3,
  // so QtPlasmaC recognises the hole without reconstructing modal motion.
  'small-hole-arc-lead': () => ({
    units: 'mm', thickness: 2,
    features: [
      { id: 'plate', operation: 'add', profile: rectangle(20, 20, 120, 80) },
      { id: 'hole-1', operation: 'subtract', profile: circleProfile(70, 60, 10) },
    ],
    operations: [{ featureIds: ['hole-1', 'plate'] }],
  }),
  'nested-sheet': () => ({
    units: 'mm', thickness: 2,
    features: [
      { id: 'part-a', operation: 'add', profile: rectangle(20, 20, 60, 40) },
      { id: 'part-b', operation: 'add', profile: rectangle(100, 20, 60, 40) },
      { id: 'part-c', operation: 'add', profile: rectangle(20, 80, 60, 40) },
    ],
    operations: [{ featureIds: ['part-a', 'part-b', 'part-c'] }],
  }),
  'arc-lead-ins': () => ({
    units: 'mm', thickness: 2,
    features: [{ id: 'disc', operation: 'add', profile: circleProfile(80, 80, 40) }],
    operations: [{ featureIds: ['disc'], operation: { plasmaLeadIn: 'arc', plasmaLeadOut: 'arc' } }],
  }),
  'inch-output': () => ({
    units: 'inch', thickness: convertLength(2, 'mm', 'inch'),
    features: [{ id: 'plate', operation: 'add', profile: rectangle(1, 1, 4, 3) }],
    operations: [{ featureIds: ['plate'] }],
  }),
}
