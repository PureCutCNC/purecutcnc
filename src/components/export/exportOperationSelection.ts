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
 * Pure helpers behind the Export G-code dialog's operation checklist
 * (issue #274). Which operations can be exported, which are in the default
 * export set (the same visible+enabled set preview and simulation use), and
 * what filename to suggest for the resulting program.
 */

import type { MachiningSetup, Operation, Project, SetupFace } from '../../types/project'
import { projectExportsPerSetup, setupProgramNumber } from '../../engine/gcode/setupPrograms'
import { setupFace, setupForOperation } from '../../engine/setupOrientation'

/**
 * Translation-key references for operation exportability reasons.
 * The component maps these to translated strings at render time.
 */
export type ExportOperationReasonKey = 'dialogs.export.operationDisabled' | 'dialogs.export.noToolAssigned'

export interface ExportOperationOption {
  operation: Operation
  /** False when the operation cannot produce G-code (disabled, or no tool). */
  exportable: boolean
  /** Translation-key reference for the non-exportable reason shown next to the operation. */
  reasonKey: ExportOperationReasonKey | null
  /** Checked by default — matches the pre-checklist export set. */
  defaultSelected: boolean
}

export function listExportOperationOptions(project: Project): ExportOperationOption[] {
  return project.operations.map((operation) => {
    const hasTool = operation.toolRef !== null
      && project.tools.some((tool) => tool.id === operation.toolRef)
    const reasonKey: ExportOperationReasonKey | null = !operation.enabled
      ? 'dialogs.export.operationDisabled'
      : !hasTool
        ? 'dialogs.export.noToolAssigned'
        : null
    return {
      operation,
      exportable: reasonKey === null,
      reasonKey,
      defaultSelected: reasonKey === null && operation.showToolpath,
    }
  })
}

/** The export checklist's operations under the setup that cuts them. */
export interface ExportOperationGroup {
  /** The setup; null for the one unlabelled group of a single-setup project. */
  setup: MachiningSetup | null
  programNumber: number
  face: SetupFace
  options: ExportOperationOption[]
}

/**
 * Group the checklist by setup (issue #946): each setup exports as its own
 * program, so the list shows which program an operation will land in. Setups
 * come in project order and keep their operations in project order; a setup
 * with no operations has no group. A project with a single setup is one
 * unlabelled group — the list it always was.
 */
export function groupExportOperationOptions(
  project: Project,
  options: readonly ExportOperationOption[],
): ExportOperationGroup[] {
  if (!projectExportsPerSetup(project)) {
    return options.length === 0 ? [] : [{ setup: null, programNumber: 1, face: 'top', options: [...options] }]
  }
  return project.setups.flatMap((setup) => {
    const members = options.filter((option) => (setupForOperation(project, option.operation) ?? project.setups[0]) === setup)
    return members.length === 0
      ? []
      : [{ setup, programNumber: setupProgramNumber(project, setup.id), face: setupFace(setup), options: members }]
  })
}

/**
 * Filename stem for the save dialog: the project name, plus the operation
 * name when exactly one operation is being exported. Whitespace collapses to
 * underscores, matching the previous project-name-only behavior.
 */
export function suggestGcodeFileName(projectName: string, selectedOperationNames: string[]): string {
  const stem = selectedOperationNames.length === 1
    ? `${projectName} ${selectedOperationNames[0]}`
    : projectName
  return stem.replace(/\s+/g, '_')
}

/**
 * The previous export's path, when this export may overwrite it in place.
 *
 * Only a file of the same kind qualifies. After a change of machine the
 * extension differs, and writing one machine's program under another's name is
 * how a `.nc` would end up holding a ShopBot part file (issue #953); the
 * caller then asks where to save instead.
 */
export function reusableExportPath(lastExportPath: string | null, extension: string): string | null {
  if (!lastExportPath) return null
  return lastExportPath.toLowerCase().endsWith(`.${extension.toLowerCase()}`) ? lastExportPath : null
}
