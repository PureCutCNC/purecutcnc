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

export interface ExportOperationOption {
  operation: Operation
  /** False when the operation cannot produce G-code (disabled, or no tool). */
  exportable: boolean
  /** Human-readable reason shown next to a non-exportable operation. */
  reason: string | null
  /** Checked by default — matches the pre-checklist export set. */
  defaultSelected: boolean
}

export function listExportOperationOptions(project: Project): ExportOperationOption[] {
  return project.operations.map((operation) => {
    const hasTool = operation.toolRef !== null
      && project.tools.some((tool) => tool.id === operation.toolRef)
    const reason = !operation.enabled
      ? 'Operation is off'
      : !hasTool
        ? 'No tool assigned'
        : null
    return {
      operation,
      exportable: reason === null,
      reason,
      defaultSelected: reason === null && operation.showToolpath,
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
