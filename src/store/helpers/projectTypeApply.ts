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
 * Applying a project type to a project (issue #1028).
 *
 * One pure function, shared by the store's `setProjectType` action and the New
 * Project dialog: it sets `meta.projectType`, gives the stock a shape the type
 * offers through the same block/bar conversion `setStockShape` takes, and
 * selects the first matching candidate machine when the current one no longer
 * suits the type. It deletes nothing; features and operations of the other
 * kind stay in the project, inert.
 *
 * The workspace face is part of the change: a project that leaves rotary has no
 * Around face, so an Around setup in view would be left unreachable. The active
 * setup moves to Top in the same step.
 */

import { setupFace } from '../../engine/setupOrientation'
import type { MachineDefinition } from '../../engine/gcode/types'
import type { Project, ProjectType } from '../../types/project'
import { activeSetup, findSetupForFace } from './activeFace'
import { provisionalSetupId } from './provisionalSetup'
import {
  aroundFeaturesActive,
  machineMatchesProjectType,
  projectMachineMismatch,
  stockShapesForProjectType,
} from './projectType'
import { projectWithStockShape } from './stockShape'
import { machineSnapshot, projectWithMachine } from '../slices/machineDefsSlice'

/**
 * The project as `type`: the stored type, the stock shape the type offers, the
 * first candidate machine that suits it, and the workspace off an Around setup
 * a non-rotary type has no face for. Returns `project` itself when nothing
 * changes, so the store's no-op and one-undo-step checks keep working.
 */
export function projectWithProjectType(
  project: Project,
  type: ProjectType,
  candidates: readonly MachineDefinition[],
): Project {
  const shaped = projectWithStockShape(project, stockShapesForProjectType(type)[0])
  // The stored-field comparison is deliberate: a hand-built project without the
  // field takes the write, so saving always carries the type (issue #1028).
  const typed = project.meta.projectType === type ? shaped : { ...shaped, meta: { ...shaped.meta, projectType: type } }
  const replacement = projectMachineMismatch(typed) === null
    ? null
    : candidates.find((definition) => machineMatchesProjectType(definition, type)) ?? null
  const machined = replacement ? projectWithMachine(typed, machineSnapshot(replacement)) : typed
  const placed = moveWorkspaceOffAround(machined)
  if (placed === project) return project
  return { ...placed, meta: { ...placed.meta, modified: new Date().toISOString() } }
}

/** The workspace on Top when the project type has no Around face (issue #1028). */
function moveWorkspaceOffAround(project: Project): Project {
  if (aroundFeaturesActive(project)) return project
  if (setupFace(activeSetup(project)) !== 'around') return project
  const top = findSetupForFace(project, 'top')
  return { ...project, activeSetupId: top?.id ?? provisionalSetupId('top') }
}
