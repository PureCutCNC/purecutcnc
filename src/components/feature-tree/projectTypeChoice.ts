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
 * The Project type UI's pure decisions (issue #1028, slice B): the type's label
 * keys and the machine picker's grouping and option order.
 *
 * Kept out of the panel so it can be tested without a renderer: which machines
 * suit a type and come first. The type itself is chosen once, in the New
 * project dialog (issue #1046), so nothing here changes it.
 */

import { machineMatchesProjectType } from '../../store/helpers/projectType'
import type { MachineDefinition } from '../../engine/gcode/types'
import type { ProjectType } from '../../types/project'
import type { SelectOption } from '../Select'

/** The three types, in the order every picker shows them. */
export const PROJECT_TYPES: readonly ProjectType[] = ['milling', 'plasma', 'rotary']

/** The catalog key naming a type. */
export type ProjectTypeLabelKey =
  | 'featureTree.properties.projectType.milling'
  | 'featureTree.properties.projectType.plasma'
  | 'featureTree.properties.projectType.rotary'

export function projectTypeLabelKey(type: ProjectType): ProjectTypeLabelKey {
  return `featureTree.properties.projectType.${type}` as ProjectTypeLabelKey
}

/** A project's type, as the candidates a picker should show for it. */
export interface MachineOptionGroups {
  /** The machines that suit the type, in candidate order. */
  readonly matching: MachineDefinition[]
  /** The rest, in candidate order — shown under "Other machines". */
  readonly other: MachineDefinition[]
}

/**
 * Split the candidate list by whether a machine suits the type
 * (`machineMatchesProjectType`). Order within each half is the candidate
 * order, so the type's own machines read as the library already lists them.
 */
export function groupMachinesForProjectType(
  candidates: readonly MachineDefinition[],
  type: ProjectType,
): MachineOptionGroups {
  const matching: MachineDefinition[] = []
  const other: MachineDefinition[] = []
  for (const definition of candidates) {
    (machineMatchesProjectType(definition, type) ? matching : other).push(definition)
  }
  return { matching, other }
}

/**
 * The machine picker's options: "None", then the machines that suit the type,
 * then the rest under `otherGroup`. The group label rides on the first option
 * of the second half only, so the type's own machines read as the plain list
 * at the top.
 */
export function machineOptionsForType(
  candidates: readonly MachineDefinition[],
  type: ProjectType,
  noneLabel: string,
  otherGroup: string,
): SelectOption<string>[] {
  const groups = groupMachinesForProjectType(candidates, type)
  return [
    { value: '', label: noneLabel },
    ...groups.matching.map((definition) => ({ value: definition.id, label: definition.name })),
    ...groups.other.map((definition) => ({ value: definition.id, label: definition.name, group: otherGroup })),
  ]
}
