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

import type { Operation, Project } from '../../types/project'

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
