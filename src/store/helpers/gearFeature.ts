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
 * Gear creation as one canned feature (issue #1112 slice E).
 *
 * Before this, a gear was a plain composite outline plus, when a bore was set,
 * a separate circle feature in a grouped folder. The gear is now a single
 * canned feature whose generator draws the outline and the bore; the canned
 * model derives each outline's Add/Subtract from nesting depth, so an Add gear
 * has a Subtract bore and a Subtract gear has an Add island (decision 2).
 *
 * The outline is still `buildGearProfile`, so the operation on a gear cuts the
 * same thing the old command's operation cut.
 */

import type { StateCreator } from 'zustand'
import type {
  FeatureOperation,
  Point,
  Project,
  SketchFeature,
} from '../../types/project'
import {
  buildGearProfile,
  validateGearProfileParams,
} from '../../sketch/gearProfile'
import { uniqueName } from '../../import'
import { cannedShapeFrame } from '../../cannedShapes'
import {
  GEAR_CANNED_KIND,
  normalizeGearCannedParams,
} from '../../cannedShapes/generators/gear'
import type { ProjectStore } from '../types'
import { buildShapeFeature } from './buildShapeFeature'
import { createDefinitionForFeature } from './featureDefinitions'
import { isMachinable, sectionForOperation } from './featureRoles'
import { resolvedProjectFeatures } from './resolveFeatures'
import { activeFace, aroundSketchAuthoringRefused } from './activeFace'

const GEAR_NAME_PATTERN = /^Gear (\d+)$/
const GEAR_BORE_NAME_PATTERN = /^Gear Bore (\d+)$/

function gearNumberFromName(name: string): number | null {
  const match = GEAR_NAME_PATTERN.exec(name) ?? GEAR_BORE_NAME_PATTERN.exec(name)
  if (!match) {
    return null
  }
  const value = Number(match[1])
  return Number.isInteger(value) && value > 0 ? value : null
}

/**
 * The next unused gear number. Old projects hold gear+bore groups, so folder
 * and bore names still reserve their number; a new canned gear skips it.
 */
function nextGearNumber(project: Project, section: ReturnType<typeof sectionForOperation>): number {
  const used = new Set<number>()
  for (const folder of project.featureFolders) {
    if ((folder.section ?? 'features') !== section) {
      continue
    }
    const value = gearNumberFromName(folder.name)
    if (value !== null) {
      used.add(value)
    }
  }
  for (const feature of resolvedProjectFeatures(project)) {
    if (sectionForOperation(feature.operation) !== section) {
      continue
    }
    const value = gearNumberFromName(feature.name)
    if (value !== null) {
      used.add(value)
    }
  }

  let candidate = 1
  while (used.has(candidate)) {
    candidate += 1
  }
  return candidate
}

/**
 * The referenced draft `addFeature` accepts: a pre-minted definition carried as
 * `_clonedDefinition` plus an instance transform. This is the same shape
 * clipboard paste uses, so insertion, the base-solid rule, folder placement and
 * the single undo step all stay in one place.
 */
function referencedCannedDraft(
  project: Project,
  draft: SketchFeature,
  center: Point,
): SketchFeature {
  const { definitionId, definition } = createDefinitionForFeature(project, draft)
  return {
    ...draft,
    definitionId,
    transform: { a: 1, b: 0, c: 0, d: 1, e: center.x, f: center.y },
    _clonedDefinition: definition,
  } as unknown as SketchFeature
}

export function createAddGearFeatureAction(
  _set: Parameters<StateCreator<ProjectStore>>[0],
  get: Parameters<StateCreator<ProjectStore>>[1],
): ProjectStore['addGearFeature'] {
  return (name, center, outsideRadius, params, depth) => {
    const state = get()
    const profileParams = { ...params, center, outsideRadius }
    const errors = validateGearProfileParams(profileParams)
    if (errors.length > 0) {
      return []
    }

    const gearFeature = buildShapeFeature(
      state.project,
      state.creationTarget,
      'composite',
      buildGearProfile(profileParams),
      name,
      depth,
    )
    // A gear is drawn on the workspace's active face, so a square blank's
    // round-only Around sheet must refuse it before any project, selection or
    // history mutation (issue #1016 C2-U1F).
    const gearFace = gearFeature.authoringFace ?? activeFace(state.project)
    if (aroundSketchAuthoringRefused(state.project, gearFace)) {
      return []
    }

    // Preserve the original creation rule exactly: the first *machining*
    // feature is Add, not "the first solid on a block project". In particular
    // a rotary bar needs no base add (`barSeedsModel`), but the old command
    // still created its first gear as Add, which is what gives the first
    // gear+bore the Add/Subtract pair it has always had (issue #1112 DE2
    // review). `addFeature`'s base-solid rule then agrees with this operation.
    //
    // Around is the one face where that Add is wrong (issue #1112 R2 item 14):
    // the bar is already the material there (#395, #1108), exactly as it is
    // for a hand-drawn outline, so a gear drawn on the unrolled sheet is a cut
    // into the bar and the classifier's Subtract stands. Top and Bottom keep
    // the historical first-gear Add.
    const isFirstMachiningFeature = gearFace !== 'around'
      && isMachinable(gearFeature)
      && !resolvedProjectFeatures(state.project).some(isMachinable)
    const operation: FeatureOperation = isFirstMachiningFeature ? 'add' : gearFeature.operation
    // A region/construction gear has no solid to bore; the old command created
    // the bore only for the features section, and that stays true.
    const boreDiameter = sectionForOperation(operation) === 'features' ? params.boreDiameter : 0

    const gearNumber = nextGearNumber(state.project, sectionForOperation(operation))
    const gearName = uniqueName(
      `Gear ${gearNumber}`,
      state.project.features.map((feature) => feature.name),
    )
    const canned = normalizeGearCannedParams({
      ...params,
      boreDiameter,
      outsideRadius,
    })
    const frame = canned ? cannedShapeFrame({ kind: GEAR_CANNED_KIND, params: canned }) : null
    if (!canned || !frame) {
      return []
    }

    const draft: SketchFeature = {
      ...gearFeature,
      name: gearName,
      operation,
      canned: { kind: GEAR_CANNED_KIND, params: canned },
      sketch: {
        ...gearFeature.sketch,
        profile: frame,
      },
    }

    const existingIds = new Set(state.project.features.map((feature) => feature.id))
    state.addFeature(referencedCannedDraft(state.project, draft, center))
    // `addFeature` refuses or is a no-op in some cases; report only the ids it
    // actually created rather than a fabricated success.
    return get().project.features
      .filter((feature) => !existingIds.has(feature.id))
      .map((feature) => feature.id)
  }
}
