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
 * Which features a setup's operations may target (issue #946). One module
 * owns the rule, and the store, the CAM panel and generation all ask it:
 *
 * - an operation targets features authored on the face its setup turns up;
 * - a **true through-feature** — one whose stock-space Z span reaches both
 *   stock faces — may also be targeted from the other setup. That use is
 *   reported as cross-face so it can be marked, never passed off as an
 *   ordinary target;
 * - anything else on the other face is rejected, with a reason.
 *
 * The rule is geometric and has no exceptions by role: a region or an add
 * feature is judged exactly like a subtract. A stock-targeted operation has
 * no feature targets and is always allowed.
 *
 * Moving an operation to another setup re-judges its targets from the new
 * face; that lives in `setupOperationMove.ts`, apart from this module, so the
 * generation path (which runs in the toolpath worker) does not pull in the
 * store's target validator.
 */

import type {
  FeatureInstance,
  Operation,
  OperationTarget,
  Project,
  SetupFace,
} from '../types/project'
import { depthFromFace, setupFace, setupForOperation } from './setupOrientation'
import type { FaceDepthSpan, StockZSpan } from './setupOrientation'

/**
 * How close to a stock face a span must come to count as reaching it, in
 * project units. Small enough to be far below anything machinable in mm or
 * inch, large enough to absorb a span computed as `thickness − depth`.
 */
export const THROUGH_FEATURE_TOLERANCE = 1e-6

/** A feature's stock-space span with named dimensions resolved, or null when a reference is unknown. */
export function featureStockSpan(
  project: Pick<Project, 'dimensions'>,
  feature: Pick<FeatureInstance, 'z_top' | 'z_bottom'>,
): StockZSpan | null {
  const resolve = (value: FeatureInstance['z_top']): number | null => (
    typeof value === 'number' ? value : project.dimensions[value]?.value ?? null
  )
  const top = resolve(feature.z_top)
  const bottom = resolve(feature.z_bottom)
  if (top === null || bottom === null || !Number.isFinite(top) || !Number.isFinite(bottom)) return null
  return { z_top: Math.max(top, bottom), z_bottom: Math.min(top, bottom) }
}

/**
 * True when the feature's span reaches both stock faces: its top at or above
 * the top face and its bottom at or below the bottom face. A span that cannot
 * be resolved is not through — unknown never earns the exception.
 */
export function isThroughFeature(
  project: Pick<Project, 'dimensions' | 'stock'>,
  feature: Pick<FeatureInstance, 'z_top' | 'z_bottom'>,
): boolean {
  const span = featureStockSpan(project, feature)
  if (!span) return false
  return span.z_top >= project.stock.thickness - THROUGH_FEATURE_TOLERANCE
    && span.z_bottom <= THROUGH_FEATURE_TOLERANCE
}

export type TargetRejection =
  /** Authored on the other face and does not reach this one. */
  | 'crossFaceNotThrough'

export type TargetFaceStatus = 'same-face' | 'cross-face' | 'rejected'

/** How one targeted feature reads from the face an operation is cut from. */
export interface TargetFaceVerdict {
  featureId: string
  featureName: string
  authoringFace: SetupFace
  /** Reaches both stock faces. */
  through: boolean
  status: TargetFaceStatus
  /** Set exactly when `status` is `'rejected'`. */
  rejection: TargetRejection | null
  /** The feature's span as depths from the operation's face; null when it cannot be resolved. */
  depth: FaceDepthSpan | null
}

/** The face an operation is cut from. An operation without a setup reads as Top. */
export function operationFace(project: Pick<Project, 'setups'>, operation: Pick<Operation, 'id' | 'setupId'>): SetupFace {
  const setup = setupForOperation(project, operation)
  return setup ? setupFace(setup) : 'top'
}

/** Judge one feature as a target from `face`. */
export function judgeTargetFromFace(
  project: Pick<Project, 'dimensions' | 'stock'>,
  feature: Pick<FeatureInstance, 'id' | 'name' | 'authoringFace' | 'z_top' | 'z_bottom'>,
  face: SetupFace,
): TargetFaceVerdict {
  // A hand-built row without the field reads as Top, like a pre-setup file.
  const authoringFace: SetupFace = feature.authoringFace ?? 'top'
  const through = isThroughFeature(project, feature)
  const span = featureStockSpan(project, feature)
  const status: TargetFaceStatus = authoringFace === face ? 'same-face' : through ? 'cross-face' : 'rejected'
  return {
    featureId: feature.id,
    featureName: feature.name,
    authoringFace,
    through,
    status,
    rejection: status === 'rejected' ? 'crossFaceNotThrough' : null,
    depth: span ? depthFromFace(span, face, project.stock) : null,
  }
}

/**
 * Judge a target list from `face`, in target order. An id that names no
 * feature is skipped: a missing target is the target validator's finding, not
 * a face question.
 */
export function judgeTargetsFromFace(
  project: Pick<Project, 'dimensions' | 'stock' | 'features'>,
  target: OperationTarget,
  face: SetupFace,
): TargetFaceVerdict[] {
  if (target.source !== 'features') return []
  const featureById = new Map(project.features.map((feature) => [feature.id, feature]))
  return target.featureIds.flatMap((featureId) => {
    const feature = featureById.get(featureId)
    return feature ? [judgeTargetFromFace(project, feature, face)] : []
  })
}

/** Every target of an operation, judged from the face its setup turns up. */
export function operationTargetVerdicts(project: Project, operation: Operation): TargetFaceVerdict[] {
  return judgeTargetsFromFace(project, operation.target, operationFace(project, operation))
}

/** The targets an operation may not have from its setup's face. Empty for a valid operation. */
export function rejectedOperationTargets(project: Project, operation: Operation): TargetFaceVerdict[] {
  return operationTargetVerdicts(project, operation).filter((verdict) => verdict.status === 'rejected')
}

/** Ids of the through-features an operation reaches from the other face — the ones to mark cross-face. */
export function crossFaceTargetIds(project: Project, operation: Operation): string[] {
  return operationTargetVerdicts(project, operation)
    .filter((verdict) => verdict.status === 'cross-face')
    .map((verdict) => verdict.featureId)
}

/**
 * Would `target` be allowed on an operation cut from `setupId`'s face? The
 * store asks this before it accepts a new or edited target, so an operation
 * can never be given a target its setup cannot reach. An unknown setup id
 * answers as Top, matching `setupForOperation`'s reading of a missing one.
 */
export function targetAllowedInSetup(project: Project, target: OperationTarget, setupId: string | undefined): boolean {
  const setup = setupId === undefined ? undefined : project.setups?.find((entry) => entry.id === setupId)
  const face: SetupFace = setup ? setupFace(setup) : 'top'
  return judgeTargetsFromFace(project, target, face).every((verdict) => verdict.status !== 'rejected')
}

// ── Generation ────────────────────────────────────────────────

/** Why an operation generates nothing in its setup. */
export type SetupGenerationBlock =
  | { reason: 'crossFaceNotThrough'; face: SetupFace; features: TargetFaceVerdict[] }
  | { reason: 'modelNotTurned'; face: SetupFace }

/** True when the project holds an imported 3D model, whose mesh a turned setup cannot use. */
export function projectHasImportedModel(project: Pick<Project, 'features' | 'featureDefinitions'>): boolean {
  return project.features.some((feature) => project.featureDefinitions[feature.definitionId]?.kind === 'stl')
}

/**
 * Whether an operation may be generated in its setup, checked at generation
 * time as well as when a target is edited: a feature's span or face can
 * change after the operation was built, and an operation left targeting the
 * wrong face must produce no motion rather than motion for the wrong side.
 *
 * Two refusals:
 *
 * - a target on the other face that is not a through-feature;
 * - a turned setup in a project that holds an imported 3D model. The mesh is
 *   not turned with the stock (see `setupFrameProject.ts`), and generators
 *   read it for more than the surface kinds, so nothing is generated against
 *   a model that would be upside down.
 */
export function setupGenerationBlock(project: Project, operation: Operation): SetupGenerationBlock | null {
  const setup = setupForOperation(project, operation)
  const face: SetupFace = setup ? setupFace(setup) : 'top'
  const rejected = judgeTargetsFromFace(project, operation.target, face).filter((verdict) => verdict.status === 'rejected')
  if (rejected.length > 0) return { reason: 'crossFaceNotThrough', face, features: rejected }
  if (setup && setup.orientation.angleDeg !== 0 && projectHasImportedModel(project)) {
    return { reason: 'modelNotTurned', face }
  }
  return null
}
