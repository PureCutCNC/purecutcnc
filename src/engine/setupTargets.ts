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

import { isBarStock, isSquareStock } from '../types/barStock'
import { isRotaryOperationKind } from '../types/project'
import { activeSetup } from '../store/helpers/activeFace'
import { aroundFeaturesActive } from '../store/helpers/projectType'
import type {
  FeatureInstance,
  Operation,
  OperationKind,
  OperationTarget,
  Project,
  SetupFace,
} from '../types/project'
import { depthFromFace, setupFace, setupForOperation } from './setupOrientation'
import type { FaceDepthSpan, StockZSpan } from './setupOrientation'
import { squareRotarySafetyRefusal } from './squareRotarySafety'
import type { SquareRotarySafetyRefusal } from './squareRotarySafety'

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
/**
 * What the target rules read of a project. `meta` and `stock` are here for the
 * project type (issue #1028): rotary targets exist only in a rotary project.
 */
type TargetProject = Pick<Project, 'dimensions' | 'stock' | 'featureDefinitions' | 'meta'>

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
  feature: Pick<FeatureInstance, 'z_top' | 'z_bottom'> & Partial<Pick<FeatureInstance, 'authoringFace'>> & (Pick<FeatureInstance, 'definitionId'> | { operation: string }),
): boolean {
  if (feature.authoringFace === 'around') return false
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
  kind?: OperationKind,
): boolean {
  if (kind && isRotaryOperationKind(kind)) {
    return aroundFeaturesActive(project) && face === 'around' && isImportedModel(project, feature)
  }
  // A square blank has no constant-depth cylinder wrapping (#1016 C2-S4): only
  // a rotary rough/finish on a real model may target its Around face, so every
  // other kind — the wrapped 2D paths a round bar allows — is refused here.
  if (face === 'around' && isSquareStock(project.stock)) return false
  if (face === 'around' && isImportedModel(project, feature)) return false
  if ((feature.authoringFace ?? 'top') === face) return true
  if (face === 'around' || feature.authoringFace === 'around') return false
  const reach = crossFaceReach(project, feature)
  return reach.through || reach.model
}

/**
 * A project as an operation's setup reads the features the operation does not
 * target (issue #1079).
 *
 * Generation hands every toolpath resolver the whole project, so a resolver
 * that reads *related* features — the band resolver's non-target subtracts,
 * model protection's related subtracts, the edge route's obstacle holes — used
 * to see work authored on the other face as if this setup's cutter could reach
 * it. On a Top/Bottom project that is wrong: a blind void on the far face is
 * enclosed from this side, so it belongs to the other setup's program.
 *
 * The rule is exactly {@link featureReachableFromFace}, applied to related
 * features: a subtract stays only where it is reachable from the operation's
 * face — drawn on that face, a true through-cut, or an imported model.
 *
 * **Adds always stay.** An add is solid material wherever it was drawn: the
 * cutter meets that volume from either side, which is why every feature is in
 * the setup's frame project at all and why a full-height island on the other
 * face is machined around from both. Removing adds would cut through a boss
 * drawn from the far side, so only subtracts are filtered.
 *
 * Called at generation (`computeOperationToolpath`, after the setup turn) and
 * at the region entries that bypass generation — `restRegions.ts`'s two public
 * draft entries and CAM Plan's analysis project — because rest-region drafts,
 * CAM Plan's island/subtract discovery and rest reconciliation resolve regions
 * directly and used to see the other face's work. The resolver itself cannot
 * carry the gate: `setupFrameProject` deliberately zeroes every setup's turn
 * so a generator cannot turn the stock twice, which leaves an operation in the
 * turned project reading as Top. Applying the gate twice is a no-op, and a
 * project with nothing to remove is returned as the same object, which keeps a
 * single-face project byte-identical.
 */
export function withoutUnreachableSubtracts(project: Project, face: SetupFace): Project {
  // `unrolledProject` already keeps only Around-authored features, and the
  // Around targeting rule is not this one (a wrapped 2D path has no through
  // exception), so its frame is left exactly as it is.
  if (face === 'around') return project
  const features = project.features.filter((feature) => (
    project.featureDefinitions[feature.definitionId]?.operation !== 'subtract'
    || featureReachableFromFace(project, feature, face)
  ))
  return features.length === project.features.length ? project : { ...project, features }
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
  kind?: OperationKind,
): TargetFaceVerdict {
  // A hand-built row without the field reads as Top, like a pre-setup file.
  const authoringFace: SetupFace = feature.authoringFace ?? 'top'
  const { through, model } = crossFaceReach(project, feature)
  const span = featureStockSpan(project, feature)
  const status: TargetFaceStatus = kind && isRotaryOperationKind(kind)
    ? aroundFeaturesActive(project) && face === 'around' && model ? 'same-face' : 'rejected'
    : face === 'around' && model ? 'rejected'
    : authoringFace === face ? 'same-face'
    : face !== 'around' && authoringFace !== 'around' && (through || model) ? 'cross-face' : 'rejected'
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
  kind?: OperationKind,
): TargetFaceVerdict[] {
  if (target.source !== 'features') return []
  const featureById = new Map(project.features.map((feature) => [feature.id, feature]))
  return target.featureIds.flatMap((featureId) => {
    const feature = featureById.get(featureId)
    return feature ? [judgeTargetFromFace(project, feature, face, kind)] : []
  })
}

/** Every target of an operation, judged from the face its setup turns up. */
export function operationTargetVerdicts(project: Project, operation: Operation): TargetFaceVerdict[] {
  return judgeTargetsFromFace(project, operation.target, operationFace(project, operation), operation.kind)
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
export function targetAllowedInSetup(project: Project, target: OperationTarget, setupId: string | undefined, kind?: OperationKind): boolean {
  const setup = setupId === project.activeSetupId ? activeSetup(project) : project.setups?.find((entry) => entry.id === setupId)
  const face: SetupFace = setup ? setupFace(setup) : 'top'
  if (kind && isRotaryOperationKind(kind)
    && (!aroundFeaturesActive(project) || face !== 'around' || target.source !== 'features' || target.featureIds.length === 0)) return false
  // A square blank's Around face carries no wrapped 2D feature targets at all
  // (#1016 C2-S4): only an explicit rotary rough/finish may target it, so the
  // store can never hand an Engrave, thread or flute the square face the round
  // bar allows. Every other kind is refused **whatever the target source** —
  // a stock or model target is not a wrapped path either, and a caller that
  // leaves `kind` off gets the same refusal rather than a bypass.
  if (face === 'around' && isSquareStock(project.stock) && !(kind && isRotaryOperationKind(kind))) {
    return false
  }
  return judgeTargetsFromFace(project, target, face, kind).every((verdict) => verdict.status !== 'rejected')
}

// ── Generation ────────────────────────────────────────────────

/** Why an operation generates nothing in its setup. */
export interface SetupGenerationBlock {
  reason: 'crossFaceNotThrough' | 'aroundStockMismatch' | 'aroundCentreline' | 'squareRotaryUnsupported'
  face: SetupFace
  features: TargetFaceVerdict[]
  /**
   * `squareRotaryUnsupported` only, and only when the physical guard is the
   * refuser: the verdict's own reason plus the clamp it names, so generation can
   * report the actual problem (a too-small diameter, a placement error, an
   * ordinary clamp in the swept envelope) instead of one generic refusal. The
   * semantic square refusals (a wrapped 2D path, a non-model target) carry no
   * verdict and keep the generic message (#1016 C2 F3).
   */
  refusal?: SquareRotarySafetyRefusal
}

/**
 * True when every target of a rotary operation is a real imported model. A
 * square blank's Around operation exists only against such a target (#1016
 * C2-S4): the wrapped 2D paths a round bar allows have no meaning on a blank
 * whose depth around the bar changes with the angle. A missing feature, or one
 * that is not an `stl` model, is not a model.
 */
function targetsAreModels(project: Project, operation: Operation): boolean {
  const target = operation.target
  if (target.source !== 'features' || target.featureIds.length === 0) return false
  return target.featureIds.every((featureId) => {
    const feature = project.features.find((entry) => entry.id === featureId)
    if (!feature) return false
    const definition = project.featureDefinitions[feature.definitionId]
    return definition?.kind === 'stl' && definition.operation === 'model'
  })
}

/**
 * True only for the one square-blank turning job this build supports (#1016
 * C2-S4): an explicit rotary rough/finish, cut on an Around setup whose axis
 * is the blank's own, in a rotary project, against a real imported model.
 * Everything else — a wrapped 2D path, any other kind, any other face, or a
 * target that is not a model — is not square turning, whatever the stored
 * moves say.
 *
 * Generation asks this through {@link setupGenerationBlock}; output
 * (`gcode/motionPipeline.ts`) asks it again before it posts a square
 * angle-bearing path, so a stale `ToolpathResult` carrying synthetic `A`
 * motion cannot reach the program by claiming an operation the engine would
 * never have generated.
 */
export function squareRotaryWorkAdmitted(project: Project, operation: Operation): boolean {
  if (!isSquareStock(project.stock) || !isRotaryOperationKind(operation.kind)) return false
  if (!aroundFeaturesActive(project) || operationFace(project, operation) !== 'around') return false
  if (setupForOperation(project, operation)?.orientation.axis !== project.stock.axis) return false
  return targetsAreModels(project, operation)
}

/**
 * Whether an operation may be generated in its setup, checked at generation
 * time as well as when a target is edited: a feature's span or face can
 * change after the operation was built, and an operation left targeting the
 * wrong face must produce no motion rather than motion for the wrong side.
 */
export function setupGenerationBlock(project: Project, operation: Operation): SetupGenerationBlock | null {
  const face = operationFace(project, operation)
  const rotary = isRotaryOperationKind(operation.kind)
  // Around work exists only in a rotary project (issue #1028). A project whose
  // type moved away from rotary keeps its Around setup, features and
  // operations, but none of them generate: nothing is modelled or cut for a
  // face the project no longer has.
  if (!aroundFeaturesActive(project) && (face === 'around' || rotary)) {
    return { reason: 'aroundStockMismatch', face, features: [] }
  }
  if (rotary && face !== 'around') return { reason: 'aroundStockMismatch', face, features: [] }
  const verdicts = judgeTargetsFromFace(project, operation.target, face, operation.kind)
  if (face === 'around') {
    const setup = setupForOperation(project, operation)
    // A bar lying along the setup's axis is the stock an Around face exists on
    // (#1016 C2-S4 widens this from the round bar to either bar shape).
    if (!isBarStock(project.stock) || setup?.orientation.axis !== project.stock.axis) {
      return { reason: 'aroundStockMismatch', face, features: [] }
    }
    // A square blank has no constant-depth cylinder wrapping: only the two
    // rotary turning kinds exist on it, only against a real model, and only
    // when the physical workholding / clamp guard says the setup is supported.
    // Judged here, before any motion, so the same verdict refuses at generation
    // and at output (`motionPipeline.ts` asks this function again).
    if (isSquareStock(project.stock)) {
      // The physical verdict is only the *reason* once the job is admitted at
      // all. A wrapped 2D path or a non-model target is refused for its own
      // semantic reason, and a clamp that also happens to be too small must not
      // relabel that refusal (the generic code stays the fallback).
      const admitted = squareRotaryWorkAdmitted(project, operation)
      const refusal = admitted ? squareRotarySafetyRefusal(project, operation) : null
      if (!admitted || refusal) {
        // A **square**-only refusal gets its own reason, reported as an error:
        // the old `aroundStockMismatch` code keeps the warning severity it has
        // always had for round/flat mismatches (#1016 C2-S4 compatibility).
        // The physical verdict (when it is the refuser) rides along, so the
        // warning can name the clamp and the actual problem (#1016 C2 F3).
        return { reason: 'squareRotaryUnsupported', face, features: [], refusal: refusal ?? undefined }
      }
    }
    // A rejected target is reported as the face mismatch it is: it is not a
    // cut on this face, so its Z is not what blocks the Around operation.
    const centreline = verdicts.filter((verdict) => {
      if (rotary || verdict.status === 'rejected') return false
      const feature = project.features.find((entry) => entry.id === verdict.featureId)
      const span = feature && featureStockSpan(project, feature)
      return span !== null && span !== undefined && span.z_bottom <= project.stock.thickness / 2
    })
    if (centreline.length > 0) return { reason: 'aroundCentreline', face, features: centreline }
  }
  const rejected = verdicts.filter((verdict) => verdict.status === 'rejected')
  return rejected.length > 0 ? { reason: 'crossFaceNotThrough', face, features: rejected } : null
}
