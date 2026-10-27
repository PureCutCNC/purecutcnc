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
 * Work that is kept but can no longer be cut (issue #1112 slice K, decision 5:
 * "Never silently skip"). Changing the stock shape does not delete anything:
 * when a round bar becomes a square blank, the Around sheet drawings and the
 * operations that cut them stay in the project. This module says why they can
 * no longer be machined, in the user's terms, so the feature tree can put a
 * warning on the row and the CAM panel on the operation.
 *
 * Two separate questions, both answered from the same rules the engine uses
 * (so a row can never warn about work that still cuts):
 *
 * - **A feature** is leftover sheet work when it was authored on Around and
 *   the stock can no longer carry wrapped 2D work (a square blank turns only a
 *   model). A model, a region and construction geometry are not sheet work.
 * - **An operation** is leftover when `setupGenerationBlock` would refuse it:
 *   its targets are no longer reachable from its face, an Around feature
 *   reaches the centreline, or a square blank cannot run it. A deliberately
 *   disabled operation is not warned about — it is off on purpose.
 */

import { isRotaryOperationKind, type Operation, type Project } from '../../types/project'
import { isBarStock, isSquareStock } from '../../types/barStock'
import { aroundFeaturesActive } from '../../store/helpers/projectType'
import { isMachinable } from '../../store/helpers/featureRoles'
import type { ResolvedSketchFeature } from '../../store/helpers/resolveFeatures'
import { operationFace, setupGenerationBlock } from '../../engine/setupTargets'
import { camT } from './camI18n'

/** A feature shape this module reads; a resolved feature satisfies it. */
type UncutFeature = Pick<ResolvedSketchFeature, 'authoringFace' | 'operation' | 'kind'>

export type UncutWorkReason =
  | 'aroundNeedsRotaryProject'
  | 'aroundNeedsBar'
  | 'aroundNeedsRoundBar'
  | 'operationNeedsRoundBar'
  | 'operationWorkholding'
  | 'operationNeedsRotaryProject'
  | 'operationNeedsAroundSetup'
  | 'operationNeedsBarAxis'
  | 'operationTargetsOtherFace'
  | 'operationReachesCentreline'

export interface UncutWork {
  reason: UncutWorkReason
  /** Feature names for a reason that names them (the centreline one). */
  features?: string
}

/** A model is turned on a square blank, so it is never leftover sheet work. */
function isModel(feature: UncutFeature): boolean {
  return feature.kind === 'stl' && feature.operation === 'model'
}

/** Why this feature is kept but cannot be cut, or null while it still can. */
export function featureUncutWork(project: Project, feature: UncutFeature): UncutWork | null {
  // Only the Around face loses work when the stock changes; Top and Bottom
  // keep their own geometry on either bar shape.
  if ((feature.authoringFace ?? 'top') !== 'around') return null
  // Regions mask a cut and construction geometry is never machined, so neither
  // is "work"; a model is turned on either bar shape.
  if (!isMachinable(feature) || isModel(feature)) return null
  if (!aroundFeaturesActive(project)) return { reason: 'aroundNeedsRotaryProject' }
  if (!isBarStock(project.stock)) return { reason: 'aroundNeedsBar' }
  if (isSquareStock(project.stock)) return { reason: 'aroundNeedsRoundBar' }
  return null
}

/** Why this operation is kept but cannot be cut, or null while it still can. */
export function operationUncutWork(project: Project, operation: Operation): UncutWork | null {
  // An operation the user switched off is not cut on purpose, not left over.
  if (!operation.enabled) return null
  const block = setupGenerationBlock(project, operation)
  if (!block) return null
  switch (block.reason) {
    case 'squareRotaryUnsupported':
      // A physical refusal (a chuck or clamp in the swept envelope) is not the
      // stock shape: the operation is the right kind and the workholding is
      // what has to change, so the note must not send the user to the stock.
      return block.refusal
        ? { reason: 'operationWorkholding' }
        : { reason: 'operationNeedsRoundBar' }
    case 'aroundCentreline':
      return {
        reason: 'operationReachesCentreline',
        features: block.features.map((feature) => feature.featureName).join(', '),
      }
    case 'crossFaceNotThrough':
      return { reason: 'operationTargetsOtherFace' }
    case 'aroundStockMismatch':
      if (!aroundFeaturesActive(project)) return { reason: 'operationNeedsRotaryProject' }
      if (isRotaryOperationKind(operation.kind) && operationFace(project, operation) !== 'around') {
        return { reason: 'operationNeedsAroundSetup' }
      }
      return { reason: 'operationNeedsBarAxis' }
  }
}

/** The warning as the user reads it, in the active language. */
export function uncutWorkText(work: UncutWork): string {
  switch (work.reason) {
    case 'aroundNeedsRotaryProject':
      return camT('cam.uncut.aroundNotRotary')
    case 'aroundNeedsBar':
      return camT('cam.uncut.aroundNeedsBar')
    case 'aroundNeedsRoundBar':
      return camT('cam.uncut.aroundNeedsRoundBar')
    case 'operationNeedsRoundBar':
      return camT('cam.uncut.operationNeedsRoundBar')
    case 'operationWorkholding':
      return camT('cam.uncut.operationWorkholding')
    case 'operationNeedsRotaryProject':
      return camT('cam.uncut.operationNeedsRotaryProject')
    case 'operationNeedsAroundSetup':
      return camT('cam.uncut.operationNeedsAroundSetup')
    case 'operationNeedsBarAxis':
      return camT('cam.uncut.operationNeedsBarAxis')
    case 'operationTargetsOtherFace':
      return camT('cam.uncut.operationTargetsOtherFace')
    case 'operationReachesCentreline':
      return camT('cam.uncut.operationReachesCentreline', { feature: work.features ?? '' })
  }
}

/** The feature row's warning text, or null when the feature still cuts. */
export function featureUncutWarning(project: Project, feature: UncutFeature): string | null {
  const work = featureUncutWork(project, feature)
  return work ? uncutWorkText(work) : null
}

/** The operation's warning text, or null when the operation still cuts. */
export function operationUncutWarning(project: Project, operation: Operation): string | null {
  const work = operationUncutWork(project, operation)
  return work ? uncutWorkText(work) : null
}
