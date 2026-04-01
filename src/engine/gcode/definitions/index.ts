import type { MachineDefinition } from '../types'
import type { Project } from '../../../types/project'
import grbl from './grbl.json'
import mach3 from './mach3.json'
import linuxcnc from './linuxcnc.json'

export const BUNDLED_DEFINITIONS: MachineDefinition[] = [
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
