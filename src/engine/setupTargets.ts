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
 * - a **true through-feature** — a subtract whose stock-space Z span reaches
 *   both stock faces — may also be targeted from the other setup;
 * - an **imported 3D model** may be targeted from either setup: it has a back
 *   face, and a Bottom setup machines it;
 * - anything else on the other face is rejected, with a reason.
 *
 * A target reached from the other face is reported as cross-face so it can be
 * marked, never passed off as an ordinary target.
 *
 * Only a *cut* that goes through earns the exception. Material that happens
 * to fill the stock's height — an add standing from top to bottom as an
 * island on both sides — is not a through-feature and stays a target of its
 * own face. It is still in every setup's project when toolpaths are generated
 * (`setupFrameProject.ts` turns every feature), so both sides machine around
 * it; it just cannot be picked as a target from the other one. A
 * stock-targeted operation has no feature targets and is always allowed.
 *
 * Moving an operation to another setup re-judges its targets from the new
 * face; that lives in `setupOperationMove.ts`, apart from this module, so the
 * generation path (which runs in the toolpath worker) does not pull in the
 * store's target validator.
 */

import { activeSetup } from '../store/helpers/activeFace'
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

/** What the rule reads of a feature: its row, whose definition says what it is. */
type TargetFeature = Pick<FeatureInstance, 'definitionId' | 'z_top' | 'z_bottom'>
type TargetProject = Pick<Project, 'dimensions' | 'stock' | 'featureDefinitions'>

/** True when a span reaches both stock faces: its top at or above the top face, its bottom at or below the bottom one. */
export function spanReachesBothFaces(span: StockZSpan, stock: Pick<Project['stock'], 'thickness'>): boolean {
  return span.z_top >= stock.thickness - THROUGH_FEATURE_TOLERANCE
    && span.z_bottom <= THROUGH_FEATURE_TOLERANCE
}

/**
 * True for a cut that goes right through the stock: a **subtract** whose span
 * reaches both stock faces. A span that cannot be resolved is not through —
 * unknown never earns the exception — and neither is a feature of any other
 * role, however tall.
 */
export function isThroughFeature(
  project: Pick<Project, 'dimensions' | 'stock'> & Partial<Pick<Project, 'featureDefinitions'>>,
  feature: Pick<FeatureInstance, 'z_top' | 'z_bottom'> & (Pick<FeatureInstance, 'definitionId'> | { operation: string }),
): boolean {
  const role = 'operation' in feature ? feature.operation : project.featureDefinitions?.[feature.definitionId]?.operation
  const span = featureStockSpan(project, feature)
  return role === 'subtract' && span !== null && spanReachesBothFaces(span, project.stock)
}

/** True for an imported 3D model, which both setups may machine. */
export function isImportedModel(project: Pick<Project, 'featureDefinitions'>, feature: Pick<FeatureInstance, 'definitionId'>): boolean {
  return project.featureDefinitions[feature.definitionId]?.kind === 'stl'
}

/**
 * The two ways a feature can be reached from the face it was not drawn on.
 * One definition read answers both: the rule runs once per feature whenever
 * the CAM panel scans a whole project.
 */
function crossFaceReach(project: TargetProject, feature: TargetFeature): { through: boolean; model: boolean } {
  const definition = project.featureDefinitions[feature.definitionId]
  const model = definition?.kind === 'stl'
  return { through: isThroughFeature(project, feature), model }
}

/**
 * Whether `face` may target a feature at all. The same answer as
 * `judgeTargetFromFace(...).status !== 'rejected'`, without building the
 * verdict — and without reading anything for a feature drawn on that face,
 * so a project that uses one face pays nothing for the question.
 */
export function featureReachableFromFace(
  project: TargetProject,
  feature: TargetFeature & Pick<FeatureInstance, 'authoringFace'>,
  face: SetupFace,
): boolean {
  if ((feature.authoringFace ?? 'top') === face) return true
  const reach = crossFaceReach(project, feature)
  return reach.through || reach.model
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
  /** A subtract that reaches both stock faces. */
  through: boolean
  /** An imported 3D model: machined from either face. */
  model: boolean
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
  project: TargetProject,
  feature: TargetFeature & Pick<FeatureInstance, 'id' | 'name' | 'authoringFace'>,
  face: SetupFace,
): TargetFaceVerdict {
  // A hand-built row without the field reads as Top, like a pre-setup file.
  const authoringFace: SetupFace = feature.authoringFace ?? 'top'
  const { through, model } = crossFaceReach(project, feature)
  const span = featureStockSpan(project, feature)
  const status: TargetFaceStatus = authoringFace === face ? 'same-face' : through || model ? 'cross-face' : 'rejected'
  return {
    featureId: feature.id,
    featureName: feature.name,
    authoringFace,
    through,
    model,
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
  project: TargetProject & Pick<Project, 'features'>,
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
  const setup = setupId === project.activeSetupId ? activeSetup(project) : project.setups?.find((entry) => entry.id === setupId)
  const face: SetupFace = setup ? setupFace(setup) : 'top'
  return judgeTargetsFromFace(project, target, face).every((verdict) => verdict.status !== 'rejected')
}

// ── Generation ────────────────────────────────────────────────

/** Why an operation generates nothing in its setup. */
export interface SetupGenerationBlock {
  reason: 'crossFaceNotThrough'
  face: SetupFace
  features: TargetFaceVerdict[]
}

/**
 * Whether an operation may be generated in its setup, checked at generation
 * time as well as when a target is edited: a feature's span or face can
 * change after the operation was built, and an operation left targeting the
 * wrong face must produce no motion rather than motion for the wrong side.
 */
export function setupGenerationBlock(project: Project, operation: Operation): SetupGenerationBlock | null {
  const face = operationFace(project, operation)
  const rejected = judgeTargetsFromFace(project, operation.target, face).filter((verdict) => verdict.status === 'rejected')
  return rejected.length > 0 ? { reason: 'crossFaceNotThrough', face, features: rejected } : null
}
