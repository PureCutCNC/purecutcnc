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
 * This module is pure: no React, no store access, no mutation. The type is
 * chosen when the project is created, in the New Project dialog
 * (`projectTypeApply.ts`), and never changes afterwards (issue #1046), so
 * nothing here writes it.
 */

import { isRotaryOperationKind } from '../../types/project'
import { isBarStock, isSquareStock } from '../../types/barStock'
import { resolveMachineKind } from '../../engine/gcode/types'
import { setupFace } from '../../engine/setupOrientation'
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
  // Either bar shape is a turning job (#1016 C2-S1); a block is milling.
  return isBarStock(project.stock) ? 'rotary' : 'milling'
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
 * Why a machine does not suit the project type (issue #1112, item 35).
 *
 * `wrong-kind` is a machine of the wrong family: a plasma table on a milling
 * project, or any non-plasma machine on a plasma one. `missing-rotary` is the
 * narrower case of a **router on a rotary project that has no rotary block**:
 * the right family of machine, short one piece of hardware. The two are kept
 * apart because the operator's fix differs — "choose a machine of the other
 * kind" versus "give this machine a rotary axis" — and telling a router owner
 * their machine "does not match this rotary project" reads as a wrong choice
 * rather than a missing axis.
 */
export type MachineMismatchReason = 'wrong-kind' | 'missing-rotary'

export interface MachineMismatch {
  reason: MachineMismatchReason
  /** The project's own type: it is the machine that has to change. */
  expected: ProjectType
  machineName: string
}

/**
 * `null` when the active machine suits the project type (or there is no
 * machine). `expected` is the project's own type: it is the machine that has
 * to change, and the warning says so.
 */
export function projectMachineMismatch(project: Project): MachineMismatch | null {
  const definition = activeMachine(project)
  if (!definition) return null
  const type = projectType(project)
  if (machineMatchesProjectType(definition, type)) return null
  // A rotary project is the only type that asks for hardware a router of the
  // right family can simply be missing; every other refusal is a family
  // mismatch (a plasma table is not a router and a router is not a plasma
  // table).
  const reason: MachineMismatchReason = type === 'rotary' && resolveMachineKind(definition) !== 'plasma'
    ? 'missing-rotary'
    : 'wrong-kind'
  return { reason, expected: type, machineName: definition.name }
}

/**
 * Stock shapes a type offers: milling and plasma cut a block, rotary turns a
 * bar. A type's first entry is the shape it wants.
 *
 * Rotary offers both bar shapes (issue #1016 C2-U1): a round bar, and the real
 * square blank whose finished round target is generated as an ordinary model.
 * Round stays first, so a project newly switched to rotary gets a round bar
 * unless it already carries a square blank. No other type offers a square.
 */
export function stockShapesForProjectType(type: ProjectType): ReadonlyArray<'block' | 'round' | 'square'> {
  return type === 'rotary' ? ['round', 'square'] : ['block']
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
 * Whether the bar itself is the part's material on every face (#1054 slice 1).
 *
 * A rotary project's stock is its model: a Top or Bottom subtract cuts the bar
 * directly, so the first solid feature needs no base add and the 3D model
 * starts from the bar solid (round or square). A block project — milling or
 * plasma — keeps the base-add rule exactly as it was. A rotary project that
 * carries a block has no bar to seed from and is treated as a block too.
 */
export function barSeedsModel(project: Pick<Project, 'meta' | 'stock'>): boolean {
  return aroundFeaturesActive(project) && isBarStock(project.stock)
}

/**
 * Whether Top and Bottom are manual-indexing faces of the project (#1054
 * slice 2): a rotary project whose stock is a bar — round or square — turns
 * the bar by hand to A0 for a Top program and A180 for a Bottom one, about
 * the bar's own axis. Every Top/Bottom program and setup sheet of such a
 * project must state that angle and the retract before turning A, and a new
 * Bottom setup flips about the bar's axis. A block (milling, plasma) has no A
 * and no bar axis, so nothing about it changes.
 */
export function manualIndexingApplies(project: Pick<Project, 'meta' | 'stock'>): boolean {
  return projectType(project) === 'rotary' && isBarStock(project.stock)
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

/**
 * Whether the project type hides an operation because of its setup's face
 * (issue #1028). Only an **Around** setup in a project that is not rotary: the
 * face does not exist for the type, so the operation is kept in the project but
 * is not part of the job (rule (a), keep and hide).
 *
 * Deliberately narrower than {@link operationCutsInProject}: it says nothing
 * about the operation's *kind*. An operation of the other family — a milling
 * cut in a plasma project, a plasma cut in a milling one — is **not** hidden
 * here; it stays listed and the postprocessor skips it with its warning
 * (issue #960). The export checklist and the export use this one, while the
 * wider predicate stays for callers that must count every operation the type
 * does not cut.
 */
export function operationHiddenByProjectType(
  project: Pick<Project, 'meta' | 'stock' | 'setups'>,
  operation: Pick<Operation, 'setupId'>,
): boolean {
  if (aroundFeaturesActive(project)) return false
  const setup = project.setups?.find((entry) => entry.id === operation.setupId) ?? project.setups?.[0] ?? null
  return setup !== null && setupFace(setup) === 'around'
}

/**
 * Whether an operation is cut in the project as it stands (issue #1028).
 *
 * The kind rule ({@link operationCutsUnderProjectType}) plus the setup's face
 * ({@link operationHiddenByProjectType}), plus the square blank's Around sheet
 * (issue #1016 C2-U1): a rotary project on a square blank machines generated
 * rotary models there, so an operation of another kind sitting in an Around
 * setup is kept in the project and the tree but is not part of the job. The
 * wider of the predicates: it answers for "does this operation contribute to
 * the job", so it counts the other family's kind. The export checklist and the
 * export deliberately do **not** use it — they use the narrower
 * hidden-by-type predicate, which the output slice owns.
 */
export function operationCutsInProject(
  project: Pick<Project, 'meta' | 'stock' | 'setups'>,
  operation: Pick<Operation, 'kind' | 'setupId'>,
): boolean {
  if (!operationCutsUnderProjectType(projectType(project), operation.kind)) return false
  if (operationHiddenByProjectType(project, operation)) return false
  return !nonRotaryOperationOnSquareAround(project, operation)
}

/**
 * Whether an operation of another kind sits in an Around setup of a rotary
 * square-blank project (issue #1016 C2-U1). The Around sheet of a square blank
 * is authored by generated rotary models alone, so a stored 2D operation there
 * is disabled — it stays exactly where it is, with its geometry and history,
 * and cuts again if the blank is converted back to round.
 */
function nonRotaryOperationOnSquareAround(
  project: Pick<Project, 'meta' | 'stock' | 'setups'>,
  operation: Pick<Operation, 'kind' | 'setupId'>,
): boolean {
  if (projectType(project) !== 'rotary' || !isSquareStock(project.stock)) return false
  if (isRotaryOperationKind(operation.kind)) return false
  const setup = project.setups?.find((entry) => entry.id === operation.setupId) ?? project.setups?.[0] ?? null
  return setup !== null && setupFace(setup) === 'around'
}
