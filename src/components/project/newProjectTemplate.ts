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
 * The New project dialog's template → new project step (issue #1112, item 24).
 *
 * A template is the template **project's setup**: units, stock and origin,
 * workholding, the machine snapshot it carries, and — the part this module
 * fixes — its **project type**. Only the two blank templates take the
 * dialog's type tiles; a rotary template creates a rotary project, a plasma
 * template a plasma one, a milling template a milling one, each with the stock
 * the template has.
 *
 * Before this, every template was handed the tiles' choice (milling by
 * default). The template's own type was overwritten, a rotary template's bar
 * was converted into a milling block, its chuck went with it, and — because a
 * plasma machine does not suit a milling project — a plasma template's machine
 * was replaced by the first router in the library. Everything a template
 * brings now survives.
 *
 * Pure by design: the dialog only holds state. `setupOnlyTemplate` strips the
 * template to its setup, `newProjectType` says which type the dialog will use,
 * and `templateChosenProject` is the project the dialog hands to the store.
 */

import { getActiveMachineDefinition } from '../../engine/gcode/definitions'
import type { MachineDefinition } from '../../engine/gcode/types'
import { machineCandidates } from '../../machine/registry'
import { normalizeMachineDefinitions } from '../../store/helpers/normalize'
import { projectType } from '../../store/helpers/projectType'
import { projectWithProjectType } from '../../store/helpers/projectTypeApply'
import { isBarStock } from '../../types/barStock'
import type { Clamp, Project, ProjectType } from '../../types/project'

/** The four templates the dialog offers. */
export type TemplateKind = 'blank_metric' | 'blank_imperial' | 'current' | 'file'

/** Whether `kind` is one of the two blank templates. */
export function isBlankTemplateKind(kind: TemplateKind): boolean {
  return kind === 'blank_metric' || kind === 'blank_imperial'
}

/**
 * The chucks a template brings. A chuck is the rotary setup itself and its
 * size, jaw count, clamping range and placement are the operator's equipment
 * (issue #1112, item 24), so it comes with the template. Every other clamp
 * stays dropped, exactly as before, and so does a chuck left on a block — there
 * is nothing for it to hold, and a block that the type turns into a bar gets
 * its own minted one instead.
 */
function templateChucks(template: Project): Clamp[] {
  if (!isBarStock(template.stock)) return []
  return template.clamps.filter((clamp) => clamp.type === 'chuck')
}

/**
 * The template reduced to its setup: no geometry, features, tools, operations,
 * tabs, dimensions or history, and no clamp but the chuck (item 24). The
 * machine list is reduced to the one snapshot the template selected — the
 * picker always reads the current application library, so a template can't
 * decide which bundled machines exist.
 */
export function setupOnlyTemplate(template: Project): Project {
  const cloned = structuredClone(template)
  const machines = normalizeMachineDefinitions(cloned)
  return {
    ...cloned,
    meta: {
      ...cloned.meta,
      machineDefinitions: machines.machineDefinitions,
      selectedMachineId: machines.selectedMachineId,
    },
    dimensions: {},
    features: [],
    featureFolders: [],
    featureTree: [],
    global_constraints: [],
    operations: [],
    tabs: [],
    clamps: templateChucks(cloned),
    ai_history: [],
  }
}

/**
 * The type the dialog will create: the template's stored type (or, for a file
 * that predates the field, the type its machine and stock imply) for
 * `current` and `file`, and the tiles' choice for a blank template — the blank
 * template is the only one without a type of its own.
 */
export function newProjectType(
  kind: TemplateKind,
  choice: ProjectType,
  template: Pick<Project, 'meta' | 'stock'> | null,
): ProjectType {
  if (isBlankTemplateKind(kind) || template === null) return choice
  return projectType(template)
}

/**
 * The project a template creates, as the dialog hands it to the store: the
 * template's setup under its own type, with the first candidate machine that
 * suits that type when the template's own snapshot does not. Its stock, its
 * origin, its chuck and its machine are the template's.
 */
export function templateChosenProject(
  kind: Exclude<TemplateKind, 'blank_metric' | 'blank_imperial'>,
  template: Project,
  choice: ProjectType,
  library: readonly MachineDefinition[],
): Project {
  const setup = setupOnlyTemplate(template)
  return projectWithProjectType(
    setup,
    newProjectType(kind, choice, setup),
    machineCandidates(library, getActiveMachineDefinition(setup)),
  )
}
