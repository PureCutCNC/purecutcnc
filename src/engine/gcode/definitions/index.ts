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

import type { MachineDefinition } from '../types'
import type { Project } from '../../../types/project'
import generic from './generic.json'
import grbl from './grbl.json'
import mach3 from './mach3.json'
import linuxcnc from './linuxcnc.json'

export const BUNDLED_DEFINITIONS: MachineDefinition[] = [
  generic as unknown as MachineDefinition,
  grbl as unknown as MachineDefinition,
  mach3 as unknown as MachineDefinition,
  linuxcnc as unknown as MachineDefinition,
]

export function copyBundledDefinitions(): MachineDefinition[] {
  return structuredClone(BUNDLED_DEFINITIONS)
}

export function getBundledDefinition(id: string): MachineDefinition | undefined {
  return BUNDLED_DEFINITIONS.find((d) => d.id === id)
}

export function getActiveMachineDefinition(project: Project): MachineDefinition | null {
  if (!project.meta.selectedMachineId) {
    return null
  }

  return project.meta.machineDefinitions.find((definition) => definition.id === project.meta.selectedMachineId) ?? null
}
