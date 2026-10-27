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
 * The one gate every write to `project.meta.machineDefinitions` goes through.
 *
 * The invariant (#1119): a definition the project already carries may leave
 * only when
 *
 *  1. the caller names it as an explicit user delete, or
 *  2. it is an unmodified bundled copy (the build supplies it), or
 *  3. a durable rescue stored it somewhere that survives a reload.
 *
 * With no rescue seam, or a rescue that cannot make itself durable, the
 * definition **stays in the project**. That is deliberately the safe default:
 * normalization runs on undo, sketch-cancel and in-memory repair paths where no
 * library write is possible, and the old "compact and report" behavior is how
 * two machines became one on a blocked library.
 *
 * Every direct assignment to `meta.machineDefinitions` must go through
 * {@link projectWithMachineDefinitions}. The sweep test
 * `src/store/machineDefinitionsInvariant.test.ts` proves the load/save/restore
 * paths keep two machines when the library is blocked.
 */

import type { MachineDefinition } from '../../engine/gcode/types'
import type { MachineLoadDiagnostic } from '../../machine/diagnostics'
import { getBundledMachine, isBundledMachineId, machinesFunctionallyEqual } from '../../machine/registry'
import type { Project } from '../../types/project'
import type { MachineRescuer } from './normalize'

/** The machine fields a write wants the project to end up with. */
export interface ProjectMachineDefinitionsWrite {
  machineDefinitions: readonly MachineDefinition[]
  selectedMachineId: string | null
}

export interface ProjectMachineDefinitionsOptions {
  /**
   * The durable-library seam. Omitted means "no way to rescue": every
   * definition that would leave is kept instead.
   */
  rescue?: MachineRescuer
  /**
   * IDs the user explicitly deleted from the project. Those are allowed to
   * leave without a rescue — clearing the selection is such an action.
   */
  explicitlyRemoved?: ReadonlySet<string>
}

export interface ProjectMachineDefinitionsResult {
  project: Project
  /** Diagnostics from the rescue attempt, including a kept-machine report. */
  diagnostics: MachineLoadDiagnostic[]
}

/** Same definition content under a different id (the normalization re-key move). */
function sameContentUnderAnotherId(a: MachineDefinition, b: MachineDefinition): boolean {
  return machinesFunctionallyEqual({ ...a, id: b.id }, b)
}

function keptInProjectDiagnostic(kept: readonly MachineDefinition[]): MachineLoadDiagnostic {
  return {
    severity: 'error',
    kind: 'machine-kept-in-project',
    machineId: kept[0]?.id,
    machineName: kept[0]?.name,
    message: `${kept.length === 1 ? 'A machine from this project could not be saved to My Machines, so it was' : `${kept.length} machines from this project could not be saved to My Machines, so they were`} kept in the project instead of being compacted away. Resolve the machine-library problem and save the project again to complete the move; until then the project file carries them.`,
  }
}

/** Selected definition first, matching the format's embedded-snapshot order. */
function orderSelectedFirst(
  definitions: MachineDefinition[],
  selectedMachineId: string | null,
): MachineDefinition[] {
  if (selectedMachineId === null) return definitions
  const index = definitions.findIndex((definition) => definition.id === selectedMachineId)
  if (index <= 0) return definitions
  return [definitions[index], ...definitions.slice(0, index), ...definitions.slice(index + 1)]
}

/**
 * Apply a machine write to `project`, enforcing the no-loss invariant.
 *
 * Any definition in the current project that the write would drop is rescued
 * first. A durable rescue allows the drop; a missing or non-durable one puts
 * the definition back after the requested list, so it stays in the saved file
 * and can be rescued on a later save.
 */
export function projectWithMachineDefinitions(
  project: Project,
  write: ProjectMachineDefinitionsWrite,
  options: ProjectMachineDefinitionsOptions = {},
): ProjectMachineDefinitionsResult {
  const current = project.meta.machineDefinitions ?? []
  const next = [...write.machineDefinitions]
  const explicitlyRemoved = options.explicitlyRemoved ?? new Set<string>()
  const matched = new Array<boolean>(next.length).fill(false)

  const lost: MachineDefinition[] = []
  for (const definition of current) {
    // Same machine, same content: still there. Two identical duplicates under
    // the same id collapse to the one kept by the write.
    let index = next.findIndex(
      (candidate, candidateIndex) => !matched[candidateIndex]
        && candidate.id === definition.id
        && machinesFunctionallyEqual(candidate, definition),
    )
    if (index === -1) {
      // The normalization path re-keys a colliding or bundled id. The machine
      // itself survives under the new id even though the id changed.
      index = next.findIndex(
        (candidate, candidateIndex) => !matched[candidateIndex]
          && sameContentUnderAnotherId(candidate, definition),
      )
    }
    if (index !== -1) {
      matched[index] = true
      continue
    }
    // Same id, different content: an explicit update of the project copy (the
    // machine manager's "use this version"), not a machine leaving the project.
    if (next.some((candidate) => candidate.id === definition.id)) continue
    if (explicitlyRemoved.has(definition.id)) continue
    if (isBundledMachineId(definition.id)) {
      const bundled = getBundledMachine(definition.id)
      if (bundled && machinesFunctionallyEqual(bundled, definition)) continue
    }
    lost.push(definition)
  }

  const diagnostics: MachineLoadDiagnostic[] = []
  let kept: MachineDefinition[] = []
  if (lost.length > 0) {
    if (options.rescue) {
      const outcome = options.rescue(lost)
      diagnostics.push(...(outcome.diagnostics ?? []))
      if (!outcome.durable) {
        kept = lost
        diagnostics.push(keptInProjectDiagnostic(kept))
      }
    } else {
      kept = lost
    }
  }

  const definitions = orderSelectedFirst([...next, ...kept], write.selectedMachineId)
  const selectedMachineId = write.selectedMachineId !== null
    && definitions.some((definition) => definition.id === write.selectedMachineId)
    ? write.selectedMachineId
    : null

  return {
    project: {
      ...project,
      meta: {
        ...project.meta,
        machineDefinitions: definitions,
        selectedMachineId,
      },
    },
    diagnostics,
  }
}
