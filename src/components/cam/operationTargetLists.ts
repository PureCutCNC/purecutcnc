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
 * Candidate lists for the feature context menu's "Add to operation" and
 * "Remove from operation" submenus (issue #519).
 *
 * Both lists are computed with `isOperationTargetValid` — the exact
 * validator the store's `updateOperation` enforces — so a menu can never
 * offer a target mutation the store would silently reject. Operations whose
 * target is the stock never appear in either list.
 */

import { isOperationTargetValid } from '../../store/helpers/operationDefaults'
import type { Operation, Project } from '../../types/project'

export interface RemoveFromOperationCandidate {
  operation: Operation
  /** False when removing the selection would leave the operation's target invalid. */
  canRemove: boolean
}

function featureTargetOperations(project: Project): Operation[] {
  return project.operations.filter((operation) => operation.target.source === 'features')
}

/**
 * Operations the given feature ids can be added to: feature-targeted
 * operations that do not already contain every selected id and that stay
 * valid with the missing ids merged into their target. Operations already
 * containing the full selection are no-ops and are excluded.
 */
export function addToOperationCandidates(project: Project, featureIds: string[]): Operation[] {
  if (featureIds.length === 0) {
    return []
  }

  return featureTargetOperations(project).filter((operation) => {
    const target = operation.target
    if (target.source !== 'features') {
      return false
    }

    const missing = featureIds.filter((id) => !target.featureIds.includes(id))
    if (missing.length === 0) {
      return false
    }

    return isOperationTargetValid(project, operation.kind, {
      source: 'features',
      featureIds: [...target.featureIds, ...missing],
    })
  })
}

/**
 * Operations whose target contains at least one of the given feature ids,
 * flagged with whether removing the whole selection keeps the target valid.
 * A `canRemove: false` entry must render disabled in the menu, because
 * `updateOperation` would reject the invalid target and the click would be a
 * silent no-op.
 */
export function removeFromOperationCandidates(
  project: Project,
  featureIds: string[],
): RemoveFromOperationCandidate[] {
  if (featureIds.length === 0) {
    return []
  }

  return featureTargetOperations(project)
    .filter((operation) => (
      operation.target.source === 'features'
      && operation.target.featureIds.some((id) => featureIds.includes(id))
    ))
    .map((operation) => {
      const target = operation.target
      if (target.source !== 'features') {
        return { operation, canRemove: false }
      }

      const remaining = target.featureIds.filter((id) => !featureIds.includes(id))
      return {
        operation,
        canRemove: isOperationTargetValid(project, operation.kind, {
          source: 'features',
          featureIds: remaining,
        }),
      }
    })
}
