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
 *  3. a durable rescue stored it somewhere that survives a reload, or
 *  4. the caller explicitly authorized replacing it in place (the user
 *     accepted a newer copy of that same machine).
 *
 * With no rescue seam, or a rescue that cannot make itself durable, the
 * definition **stays in the project**. That is deliberately the safe default:
 * normalization runs on undo, sketch-cancel and in-memory repair paths where no
 * library write is possible, and the old "compact and report" behavior is how
 * two machines became one on a blocked library.
 *
 * Every direct assignment to `meta.machineDefinitions` must go through
 * {@link projectWithMachineDefinitions}, except the load/normalization paths,
 * which go through `normalizeMachineDefinitions` — that function is itself the
 * one rescue-or-keep gate for those paths and must not be re-run through this
 * one. The sweep test `src/store/machineDefinitionsInvariant.test.ts` proves
 * both gateways keep every machine's content when the library is blocked.
 */

import type { MachineDefinition } from '../../engine/gcode/types'
import type { MachineLoadDiagnostic } from '../../machine/diagnostics'
import {
  allocateMachineId,
  getBundledMachine,
  isBundledMachineId,
  machinesFunctionallyEqual,
} from '../../machine/registry'
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
  /**
   * IDs whose project copy the caller may replace with different content under
   * the same id — the user accepting an update of that machine. Every other
   * same-ID collision is a loss like a dropped definition: the existing
   * content is rescued, or kept under a re-keyed id. Omitted means no write is
   * authorized to overwrite a machine in place.
   */
  authorizedUpdates?: ReadonlySet<string>
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
  const authorizedUpdates = options.authorizedUpdates ?? new Set<string>()
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
    // Same id, different content: only an explicitly authorized update (the
    // user accepting a newer copy of that machine) may replace the project
    // copy. Any other collision is a loss: the existing content is rescued or
    // kept below, never silently discarded.
    if (next.some((candidate) => candidate.id === definition.id)
      && authorizedUpdates.has(definition.id)) continue
    if (explicitlyRemoved.has(definition.id)) continue
    if (isBundledMachineId(definition.id)) {
      const bundled = getBundledMachine(definition.id)
      if (bundled && machinesFunctionallyEqual(bundled, definition)) continue
    }
    lost.push(definition)
  }

  const diagnostics: MachineLoadDiagnostic[] = []
  let kept: MachineDefinition[] = []
  let rescueFailed = false
  if (lost.length > 0) {
    if (options.rescue) {
      const outcome = options.rescue(lost)
      diagnostics.push(...(outcome.diagnostics ?? []))
      if (!outcome.durable) {
        kept = lost
        rescueFailed = true
      }
    } else {
      kept = lost
    }
  }

  // A kept definition that shares an id with a requested one cannot coexist
  // with it unchanged. Re-key the kept copy (the requested definition keeps the
  // id, so the selection and its library link stay meaningful) and report it.
  const usedIds = new Set(next.map((definition) => definition.id))
  kept = kept.map((definition) => {
    if (!usedIds.has(definition.id)) {
      usedIds.add(definition.id)
      return definition
    }
    const id = allocateMachineId(definition.name || definition.id, usedIds)
    usedIds.add(id)
    diagnostics.push({
      severity: 'warning',
      kind: 'machine-rekeyed',
      machineId: definition.id,
      machineName: definition.name,
      nextId: id,
      message: `Machine "${definition.name}" was kept as "${id}" because "${definition.id}" is now used by a different machine.`,
    })
    return { ...definition, id }
  })
  if (rescueFailed && kept.length > 0) diagnostics.push(keptInProjectDiagnostic(kept))

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
