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
 * The project type and the rules that read it (issue #1028).
 *
 * Before this, the kind of project was inferred from other settings at every
 * read: plasma vs milling from the selected machine (`projectMachineKind`),
 * and rotary from the stock plus a rotary-capable machine
 * (`aroundUnavailableReason`). The user now chooses a **project type** and
 * everything else follows it.
 *
 * This module is pure: no React, no store access, no mutation. The store
 * action that changes the type lives in `workpieceSlice.ts` and the confirm
 * dialog's summary is built here.
 */

import { isRotaryOperationKind, isRoundStock } from '../../types/project'
import { resolveMachineKind } from '../../engine/gcode/types'
import type { MachineDefinition } from '../../engine/gcode/types'
import type { Operation, Project, ProjectMeta, ProjectType, Stock } from '../../types/project'

/** The machine snapshot the project selected, read exactly as `getActiveMachineDefinition` does. */
function activeMachine(project: { meta: Pick<ProjectMeta, 'machineDefinitions' | 'selectedMachineId'> }): MachineDefinition | null {
  const id = project.meta.selectedMachineId
  if (!id) return null
  return project.meta.machineDefinitions?.find((definition) => definition.id === id) ?? null
}

/**
 * The type today's rules imply, for a file that predates the field. Plasma
 * wins over rotary, matching `machineMode`: a plasma machine has no rotary and
 * a round bar on one is still a plasma project with an unusable Around face.
 *
 * Used once, on load, by `normalizeProject` — everything afterwards reads the
 * stored field.
 */
export function inferProjectType(project: Project): ProjectType {
  return inferType(project)
}

/**
 * {@link inferProjectType} against the machine data and the stock alone. The
 * load migration runs before the project's `meta` is complete, so it cannot
 * hand over a whole `Project`.
 */
export function inferProjectTypeFrom(
  meta: Pick<ProjectMeta, 'machineDefinitions' | 'selectedMachineId'>,
  stock: Stock,
): ProjectType {
  return inferType({ meta, stock })
}

/** {@link inferProjectType} against the only things it reads. */
function inferType(project: {
  meta: Pick<ProjectMeta, 'machineDefinitions' | 'selectedMachineId'>
  stock: Stock
}): ProjectType {
  const definition = activeMachine(project)
  if (definition && resolveMachineKind(definition) === 'plasma') return 'plasma'
  return isRoundStock(project.stock) ? 'rotary' : 'milling'
}

/**
 * The stored type; a hand-built project without it reads as what its machine
 * and stock imply, so no caller has to know which files carry the field.
 */
export function projectType(project: Pick<Project, 'meta' | 'stock'>): ProjectType {
  return project.meta.projectType ?? inferType(project)
}

/**
 * Whether a machine suits a type.
 *
 * - plasma ↔ a plasma machine;
 * - rotary ↔ a router with a `rotary` block (the block is what makes the
 *   Around face and the rotary operations possible at all);
 * - milling ↔ any router, rotary-capable included: a milling project is
 *   allowed to keep a rotary-capable machine selected.
 */
export function machineMatchesProjectType(definition: MachineDefinition, type: ProjectType): boolean {
  const kind = resolveMachineKind(definition)
  if (type === 'plasma') return kind === 'plasma'
  if (type === 'rotary') return kind !== 'plasma' && definition.rotary !== undefined
  return kind !== 'plasma'
}

/**
 * The first machine in `candidates` that suits `type`, or null when none does.
 * `candidates` is the list the machine picker shows.
 */
function firstMatchingMachine(
  candidates: readonly MachineDefinition[],
  type: ProjectType,
): MachineDefinition | null {
  return candidates.find((definition) => machineMatchesProjectType(definition, type)) ?? null
}

/**
 * `null` when the active machine suits the project type (or there is no
 * machine). `expected` is the project's own type: it is the machine that has
 * to change, and the warning says so.
 */
export function projectMachineMismatch(project: Project): null | { expected: ProjectType; machineName: string } {
  const definition = activeMachine(project)
  if (!definition) return null
  const type = projectType(project)
  return machineMatchesProjectType(definition, type) ? null : { expected: type, machineName: definition.name }
}

/**
 * Stock shapes a type offers: milling and plasma cut a block, rotary turns a
 * round bar. A type's first entry is the shape it wants.
 */
export function stockShapesForProjectType(type: ProjectType): ReadonlyArray<'block' | 'round'> {
  return type === 'rotary' ? ['round'] : ['block']
}

/**
 * Whether the project's Around features are part of the job (issue #1028).
 * Only a rotary project machines the Around face; in any other type those
 * features stay in the project and the tree but are not modelled, generated
 * or exported.
 */
export function aroundFeaturesActive(project: Pick<Project, 'meta' | 'stock'>): boolean {
  return projectType(project) === 'rotary'
}

/**
 * Whether an operation of `kind` is cut under `type` (issue #1028).
 *
 * - a plasma cut only in a plasma project;
 * - a rotary operation only in a rotary project;
 * - every other (milling) kind except in a plasma project.
 */
export function operationCutsUnderProjectType(type: ProjectType, kind: Operation['kind']): boolean {
  if (kind === 'plasma_profile') return type === 'plasma'
  if (isRotaryOperationKind(kind)) return type === 'rotary'
  return type !== 'plasma'
}

/** What changing the type would do, for the confirm dialog (slice B). Nothing is deleted. */
export interface ProjectTypeChangeSummary {
  readonly from: ProjectType
  readonly to: ProjectType
  /** enabled operations that would not be cut under the new type (plasma ops in milling/rotary, milling ops in plasma, rotary ops outside rotary) */
  readonly inactiveOperations: number
  /** Around features kept but hidden and not exported (leaving rotary) */
  readonly hiddenAroundFeatures: number
  readonly stockConversion: null | 'toBlock' | 'toRound'
  /** the machine that will be selected, or null when the current one matches or none matches */
  readonly machineChange: null | { id: string; name: string }
}

/** {@link ProjectTypeChangeSummary}, read off the project without changing it. */
export function projectTypeChangeSummary(
  project: Project,
  to: ProjectType,
  candidates: readonly MachineDefinition[],
): ProjectTypeChangeSummary {
  const from = projectType(project)
  const wantsRound = stockShapesForProjectType(to).includes('round')
  const round = isRoundStock(project.stock)
  const current = activeMachine(project)
  const replacement = current && !machineMatchesProjectType(current, to)
    ? firstMatchingMachine(candidates, to)
    : null
  return {
    from,
    to,
    inactiveOperations: project.operations.filter((operation) => (
      operation.enabled && !operationCutsUnderProjectType(to, operation.kind)
    )).length,
    // Only leaving rotary hides anything: a project that is already not
    // rotary has its Around features hidden whatever this change does.
    hiddenAroundFeatures: from === 'rotary' && to !== 'rotary'
      ? project.features.filter((feature) => feature.authoringFace === 'around').length
      : 0,
    stockConversion: wantsRound === round ? null : wantsRound ? 'toRound' : 'toBlock',
    machineChange: replacement ? { id: replacement.id, name: replacement.name } : null,
  }
}
