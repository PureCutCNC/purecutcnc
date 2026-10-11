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
 * Machine mode for the CAM panel (issue #960).
 *
 * Plasma mode is derived, never stored: a project is in plasma mode when the
 * machine definition it has selected has `machineKind: 'plasma'`, and in router
 * mode otherwise. A project with no machine selected is a router project.
 *
 * The mode decides what the CAM panel offers to *add*: plasma mode offers only
 * plasma operations and torch tools, router mode offers only the milling
 * family. It must restrict what can be added, never hide what the project
 * already has — an operation or tool of the other family stays listed,
 * selectable and editable as exactly what it already is.
 */

import { projectMachineKind } from '../../engine/gcode/definitions'
import type { Operation, OperationKind, Project, ToolType } from '../../types/project'

export type MachineMode = 'router' | 'plasma'

/** How the Add operation menu treats a kind. */
export type OperationOffer = 'available' | 'hidden' | 'needs-plasma-machine'

/** The canonical order every offered tool-type list keeps, whatever the mode. */
const CANONICAL_TOOL_TYPES: readonly ToolType[] = ['flat_endmill', 'ball_endmill', 'v_bit', 'drill', 'plasma']

/** The milling family: every tool type a router CAM panel authors. */
const MILLING_TOOL_TYPES: readonly ToolType[] = ['flat_endmill', 'ball_endmill', 'v_bit', 'drill']

/** The project's mode, derived from its selected machine definition. */
export function machineMode(project: Project): MachineMode {
  return projectMachineKind(project)
}

/**
 * How the Add operation menu treats a kind in this mode. In router mode a
 * plasma operation is not hidden but offered as blocked, so the menu can say
 * what would make it available instead of dropping it silently.
 */
export function operationOffer(mode: MachineMode, kind: OperationKind): OperationOffer {
  if (mode === 'plasma') {
    return kind === 'plasma_profile' ? 'available' : 'hidden'
  }
  return kind === 'plasma_profile' ? 'needs-plasma-machine' : 'available'
}

/** Whether an operation of this kind can actually cut on the selected machine. */
export function operationCutOnMachine(mode: MachineMode, kind: OperationKind): boolean {
  return mode === 'plasma' ? kind === 'plasma_profile' : kind !== 'plasma_profile'
}

/** How many enabled operations the selected machine cannot run. */
export function uncutOperationCount(
  mode: MachineMode,
  operations: readonly Pick<Operation, 'kind' | 'enabled'>[],
): number {
  return operations.filter((operation) => operation.enabled && !operationCutOnMachine(mode, operation.kind)).length
}

/**
 * The tool types this mode offers, in canonical order and without duplicates.
 * `current` is the type of the tool already being edited: a tool of the other
 * family stays selectable as what it already is, so changing it is never
 * forced by a machine change.
 */
export function selectableToolTypes(mode: MachineMode, current?: ToolType): ToolType[] {
  const offered = new Set<ToolType>(mode === 'plasma' ? ['plasma'] : MILLING_TOOL_TYPES)

  if (mode === 'plasma') {
    if (current !== undefined && MILLING_TOOL_TYPES.includes(current)) {
      offered.add(current)
    }
  } else if (current === 'plasma') {
    offered.add('plasma')
  }

  return CANONICAL_TOOL_TYPES.filter((type) => offered.has(type))
}

/** Whether the tool library offers an entry of this type in this mode. */
export function libraryEntryOffered(mode: MachineMode, type: ToolType): boolean {
  return mode === 'plasma' ? type === 'plasma' : type !== 'plasma'
}

/**
 * Whether the workspace face switch is shown. A plasma project hides it unless
 * the project already has content on both faces, so that content stays reachable.
 */
export function showsFaceSwitch(mode: MachineMode, usesBothFaces: boolean): boolean {
  return mode === 'plasma' ? usesBothFaces : true
}

/** Whether the CAM panel authors new milling work (the Auto plan button and Add tab). */
export function showsMillingAuthoring(mode: MachineMode): boolean {
  return mode === 'router'
}
