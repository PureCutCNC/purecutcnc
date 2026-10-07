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
 * What the CAM panel shows per machining setup (issue #946), as plain data:
 * the operations grouped under the setup that cuts them, each setup's program
 * number and registration status, which targets are cross-face, and — for a
 * through-feature cut from both sides — whether the two cuts meet.
 *
 * Kept apart from the panel so the grouping and the wording decisions can be
 * tested without rendering it. Nothing here switches setups: the workspace
 * face switch owns that, and the panel only reflects `activeSetupId`.
 */

import { activeSetup } from '../../store/helpers/activeFace'
import type { MachiningSetup, Operation, Project, SetupFace } from '../../types/project'
import { projectExportsPerSetup, setupLacksRegistration, setupProgramNumber } from '../../engine/gcode/setupPrograms'
import { setupFace, setupForOperation } from '../../engine/setupOrientation'
import { operationCutRange, throughFeatureCoverage } from '../../engine/setupReach'
import type { StockZRange, ThroughFeatureCoverage } from '../../engine/setupReach'
import { operationTargetVerdicts } from '../../engine/setupTargets'
import type { TargetFaceVerdict } from '../../engine/setupTargets'
import type { ToolpathResult } from '../../engine/toolpaths/types'

/** One setup's part of the operations list. */
export interface CamSetupSection {
  setup: MachiningSetup
  face: SetupFace
  /** 1-based program number: the setup's position in the project. */
  programNumber: number
  /** The setup the workspace is on: its section is the one new operations join. */
  active: boolean
  /** The setup's operations, in the order they are cut. */
  operations: Operation[]
  /** Stock axis the part is flipped about; null for a setup that leaves it as drawn. */
  flipAxis: MachiningSetup['orientation']['axis'] | null
  /** Number of registration references declared. */
  registrationCount: number
  /** True for a second setup with no registration: nothing records how the turned part is located. */
  registrationMissing: boolean
}

/**
 * The operations list as sections, one per setup in project order. A setup
 * with no operations still has a section — it is where the first one goes.
 *
 * `grouped` is false for a project with a single setup: the panel then shows
 * the flat list it always has, with no section header.
 */
export function camSetupSections(project: Project): { grouped: boolean; sections: CamSetupSection[] } {
  const current = activeSetup(project)
  const saved = project.setups ?? []
  const setups = current && !saved.some((setup) => setup.id === current.id) ? [...saved, current] : saved
  const sections = setups.map((setup): CamSetupSection => ({
    setup,
    face: setupFace(setup),
    programNumber: saved.includes(setup) ? setupProgramNumber(project, setup.id) : setups.length,
    active: setup.id === project.activeSetupId,
    operations: project.operations.filter((operation) => (setupForOperation(project, operation) ?? setups[0]) === setup),
    flipAxis: setup.orientation.angleDeg === 0 ? null : setup.orientation.axis,
    registrationCount: setup.registration.length,
    registrationMissing: setupLacksRegistration(project, setup) || (!saved.includes(setup) && saved.length > 0),
  }))
  return { grouped: projectExportsPerSetup(project) || setups.length > saved.length, sections }
}

/** The targets of an operation that are through-features cut from the other face. */
export function crossFaceTargets(project: Project, operation: Operation): TargetFaceVerdict[] {
  return operationTargetVerdicts(project, operation).filter((verdict) => verdict.status === 'cross-face')
}

/** The targets of an operation its setup cannot reach — shown as the reason it generates nothing. */
export function unreachableTargets(project: Project, operation: Operation): TargetFaceVerdict[] {
  return operationTargetVerdicts(project, operation).filter((verdict) => verdict.status === 'rejected')
}

/** How far one operation reaches at one of its targets, and what the other side does there. */
export interface TargetReach {
  featureId: string
  featureName: string
  /** The target as judged from the operation's face, with its depth from that face. */
  verdict: TargetFaceVerdict
  /** The stock-Z range this operation cuts at the feature; null without a toolpath or a cut. */
  range: StockZRange | null
  /**
   * For a through-feature: how this side and the other meet. Null for a
   * feature that does not reach both faces.
   */
  coverage: ThroughFeatureCoverage | null
}

/**
 * The reach of an operation at each of its targets, in stock Z, for the
 * operation's properties. `toolpaths` holds the generated result of every
 * operation that has one, by id: an operation without one has no measured
 * range, and a through-feature it shares with the other side is reported as
 * unverified rather than assumed to meet.
 */
export function operationTargetReach(
  project: Project,
  operation: Operation,
  toolpaths: ReadonlyMap<string, Pick<ToolpathResult, 'moves'>>,
): TargetReach[] {
  const own = toolpaths.get(operation.id)
  return operationTargetVerdicts(project, operation).map((verdict) => ({
    featureId: verdict.featureId,
    featureName: verdict.featureName,
    verdict,
    range: own ? operationCutRange(project, operation, own, verdict.featureId) : null,
    coverage: verdict.through ? throughFeatureCoverage(project, verdict.featureId, toolpaths) : null,
  }))
}

/** The operations a setup would lose if it were deleted — what the confirmation has to list. */
export function operationsDeletedWithSetup(project: Project, setupId: string): Operation[] {
  return project.operations.filter((operation) => operation.setupId === setupId)
}
