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
 * What a Verify run is asked (issue #1269): the comparison, the operations it
 * covers and when a finished result no longer describes the project.
 *
 * A run is made on demand and never again by itself. Its request is a
 * snapshot: the project object (every edit replaces it), the simulated setup,
 * the comparison, the operation it runs up to and the simulation detail. A
 * result whose request differs from the current one is shown as stale until
 * the user runs it again.
 */

import { findOperationTool } from '../../toolPolicy'
import type { Operation, Project } from '../../types/project'
import { visibleReplayOperations } from '../simulationCompute'

/** The three comparisons the Verify mode offers. */
export type VerifyComparison = 'modelInternal' | 'modelExported' | 'internalExported'

/** In the order the selector lists them. */
export const VERIFY_COMPARISONS: readonly VerifyComparison[] = ['modelInternal', 'modelExported', 'internalExported']

/** True for the comparisons that post and read back the exported program. */
export function comparisonUsesExport(comparison: VerifyComparison): boolean {
  return comparison !== 'modelInternal'
}

/** True for the comparisons made against the combined model. */
export function comparisonUsesModel(comparison: VerifyComparison): boolean {
  return comparison !== 'internalExported'
}

export interface VerifyRequest {
  /** The project revision the run read. */
  project: Project
  /** The simulated setup (the workspace face's). */
  setupId: string
  comparison: VerifyComparison
  /** The selected operation the run is cumulative up to, or null for the whole setup. */
  uptoOperationId: string | null
  detailCells: number
}

/**
 * `current` — the result describes the request on screen; `projectEdited` —
 * the project changed since the run; `requestChanged` — the same project, but
 * another comparison, setup, operation or detail is asked for.
 */
export type VerifyStaleness = 'current' | 'projectEdited' | 'requestChanged'

export function verifyStaleness(ran: VerifyRequest, current: VerifyRequest): VerifyStaleness {
  if (ran.project !== current.project) return 'projectEdited'
  if (
    ran.setupId !== current.setupId
    || ran.comparison !== current.comparison
    || ran.uptoOperationId !== current.uptoOperationId
    || ran.detailCells !== current.detailCells
  ) return 'requestChanged'
  return 'current'
}

/**
 * The operations a run covers, in cut order: the setup's visible operations up
 * to and including the selected one, as the play tool's starting stock plus the
 * selected cut. The selection itself is included even with its toolpath
 * hidden, as the play tool simulates it, as long as it is enabled and has a
 * tool. No selection in this setup covers the whole setup.
 */
export function verifyOperations(
  project: Project,
  setupOperations: readonly Operation[],
  selectedOperationId: string | null,
): Operation[] {
  const index = selectedOperationId === null
    ? -1
    : setupOperations.findIndex((operation) => operation.id === selectedOperationId)
  const covered = index >= 0 ? setupOperations.slice(0, index + 1) : setupOperations
  const operations = visibleReplayOperations(project, covered)
  if (index >= 0) {
    const selected = setupOperations[index]
    if (!operations.includes(selected) && selected.enabled && findOperationTool(project, selected) !== null) {
      operations.push(selected)
    }
  }
  return operations
}

/** The operation a run is cumulative up to: the selection when it is in the setup. */
export function verifyUptoOperationId(
  setupOperations: readonly Operation[],
  selectedOperationId: string | null,
): string | null {
  return selectedOperationId !== null && setupOperations.some((operation) => operation.id === selectedOperationId)
    ? selectedOperationId
    : null
}
