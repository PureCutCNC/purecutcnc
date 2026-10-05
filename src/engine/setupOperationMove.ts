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
 * Moving an operation to another setup (issue #946). An explicit action with
 * its own validation: the operation's targets are re-judged from the
 * destination's face by the rule in `setupTargets.ts`. Targets the new face
 * cannot reach are dropped — and listed, so the user confirms what goes — and
 * the move is blocked outright when nothing valid would be left.
 *
 * Nothing else about the operation changes. Depths are entered from the
 * setup's face, so the kept targets carry their span as depths from the new
 * face for the confirmation to show.
 */

import type { MachiningSetup, Operation, OperationTarget, Project, SetupFace } from '../types/project'
import { isOperationTargetValid } from '../store/helpers/operationDefaults'
import { setupFace } from './setupOrientation'
import { judgeTargetsFromFace } from './setupTargets'
import type { TargetFaceVerdict } from './setupTargets'

export type OperationMoveBlock =
  | 'unknownOperation'
  | 'unknownSetup'
  /** Already in that setup: there is nothing to move. */
  | 'sameSetup'
  /** Dropping the targets the new face cannot reach leaves no valid target. */
  | 'noValidTargets'

/** What moving one operation to another setup would do. Nothing is changed by planning it. */
export interface OperationMovePlan {
  operationId: string
  toSetupId: string
  /** The face the destination setup turns up; null when the setup is unknown. */
  toFace: SetupFace | null
  /** Targets the operation keeps, judged from the new face (cross-face ones marked). */
  kept: TargetFaceVerdict[]
  /** Targets the new face cannot reach. The move drops them. */
  removed: TargetFaceVerdict[]
  /** The operation's target after the move. */
  target: OperationTarget
  /** Set when the move must not go ahead as planned. */
  blocked: OperationMoveBlock | null
}

/**
 * Plan moving an operation to another setup. Targets are re-judged from the
 * destination's face: a through-feature stays (as a cross-face target when it
 * was authored on the other face), a feature authored on the destination's
 * face stays, and any other is listed in `removed`. If what is left is not a
 * valid target for the operation's kind the move is blocked — the user has to
 * retarget the operation first rather than end up with one that cuts nothing.
 */
export function planOperationMove(project: Project, operationId: string, toSetupId: string): OperationMovePlan {
  const operation: Operation | undefined = project.operations.find((entry) => entry.id === operationId)
  const toSetup: MachiningSetup | undefined = project.setups?.find((entry) => entry.id === toSetupId)
  const base = { operationId, toSetupId, toFace: toSetup ? setupFace(toSetup) : null }
  if (!operation) {
    return { ...base, kept: [], removed: [], target: { source: 'stock' }, blocked: 'unknownOperation' }
  }
  if (!toSetup) {
    return { ...base, kept: [], removed: [], target: operation.target, blocked: 'unknownSetup' }
  }

  const face = setupFace(toSetup)
  const verdicts = judgeTargetsFromFace(project, operation.target, face)
  const kept = verdicts.filter((verdict) => verdict.status !== 'rejected')
  const removed = verdicts.filter((verdict) => verdict.status === 'rejected')
  const removedIds = new Set(removed.map((verdict) => verdict.featureId))
  const target: OperationTarget = operation.target.source === 'features' && removed.length > 0
    ? { source: 'features', featureIds: operation.target.featureIds.filter((id) => !removedIds.has(id)) }
    : operation.target

  let blocked: OperationMoveBlock | null = null
  if (operation.setupId === toSetupId) {
    blocked = 'sameSetup'
  } else if (removed.length > 0 && !isOperationTargetValid(project, operation.kind, target)) {
    blocked = 'noValidTargets'
  }
  return { ...base, kept, removed, target, blocked }
}

/**
 * Apply a move plan to a project. Returns null when the plan is blocked.
 * The operation takes the destination's `setupId` and the planned target;
 * every other field is left as the user set it.
 */
export function applyOperationMove(project: Project, plan: OperationMovePlan): Project | null {
  if (plan.blocked) return null
  return {
    ...project,
    operations: project.operations.map((operation) => (
      operation.id === plan.operationId
        ? { ...operation, setupId: plan.toSetupId, target: plan.target }
        : operation
    )),
  }
}
