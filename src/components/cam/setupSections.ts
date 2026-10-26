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
import { isRotaryOperationKind } from '../../types/project'
import type { MachiningSetup, Operation, OperationKind, Project, SetupFace } from '../../types/project'
import { projectExportsPerSetup, setupLacksRegistration, setupProgramNumber } from '../../engine/gcode/setupPrograms'
import { setupFace, setupForOperation } from '../../engine/setupOrientation'
import { operationCutRange, throughFeatureCoverage } from '../../engine/setupReach'
import type { StockZRange, ThroughFeatureCoverage } from '../../engine/setupReach'
import { operationTargetVerdicts } from '../../engine/setupTargets'
import type { TargetFaceVerdict } from '../../engine/setupTargets'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import type { MessageParams } from '../../i18n/catalog'
import type { camEn } from '../../i18n/locales/en/cam'

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
  return { grouped: setupListGrouped(project, setups), sections }
}

/**
 * Whether the operations list is split into one section per setup — what
 * `camSetupSections` reports as `grouped`. An Around setup is always its own
 * section (issue #395), even as the project's only setup, so its "Around
 * operations" heading and "Add to Around" target are never the flat,
 * unlabelled list. `listed` is the setup list the sections are built from,
 * which may include a provisional setup the project does not hold yet.
 */
function setupListGrouped(project: Pick<Project, 'setups'>, listed: readonly MachiningSetup[]): boolean {
  const saved = project.setups ?? []
  return projectExportsPerSetup(project) || listed.length > saved.length || listed.some((setup) => setup.kind === 'around')
}

/**
 * Whether an operation is on the setup the workspace is on (issue #1102).
 *
 * The operations list shows every setup's operations, but only the active
 * setup's can be used from the face in view: an operation from another face is
 * listed as a ghost row, like a feature from the other face in the feature
 * tree. A project that is not grouped has one flat setup, so every operation
 * in it is on the active setup.
 *
 * Membership follows the panel's own: an operation belongs to the setup its
 * `setupId` names, and one with no `setupId` reads as the first setup listed —
 * the provisional setup the workspace is on is listed too, since it is the
 * card being shown. Setups are compared by the face they turn up, as the
 * feature tree compares features: switching face is the only way the user
 * changes setup, so a second setup on the same face must stay usable from it.
 */
export function operationOnActiveSetup(project: Project, operation: Operation): boolean {
  const active = activeSetup(project)
  const saved = project.setups ?? []
  const listed = saved.some((setup) => setup.id === active.id) ? saved : [...saved, active]
  if (!setupListGrouped(project, listed)) return true
  const owner = setupForOperation(project, operation) ?? listed[0]
  return owner !== undefined && setupFace(owner) === setupFace(active)
}

/** What one setup card's header shows (issue #1102). */
export interface SetupCardHeader {
  /** The face name as shown: Top, Bottom, or the Around setup's own name. */
  label: string
  /** What the header toggle announces: the longer wording the header used to show. */
  ariaLabel: string
  /** The short program chip, `P01`. */
  programChip: string
  /** A second setup with no registration: its card carries the warning. */
  warn: boolean
  /** No operations: the card is one header row, with no body at all. */
  empty: boolean
}

/**
 * What one setup card's header reads (issue #1102): the face name, its
 * operation count and program, and whether it warns about registration.
 *
 * The visible name is short so the row fits one line at the panel's width;
 * `ariaLabel` keeps the longer wording the header used before, because that
 * is the accessible name the e2e specs and screen readers match on. An Around
 * setup never warns: the chuck locates the bar, so it has nothing to register.
 */
export function setupCardHeader(
  section: CamSetupSection,
  t: (key: keyof typeof camEn, params?: MessageParams) => string,
): SetupCardHeader {
  const label = section.face === 'top'
    ? t('cam.setup.top')
    : section.face === 'bottom'
      ? t('cam.setup.bottom')
      : section.setup.name
  const operations = t(section.face === 'top'
    ? 'cam.setup.topOperations'
    : section.face === 'bottom'
      ? 'cam.setup.bottomOperations'
      : 'cam.setup.aroundOperations')
  const number = String(section.programNumber).padStart(2, '0')
  const programChip = t('cam.setup.program', { number })
  const programNumber = t('cam.setup.programFull', { number })
  return {
    label,
    ariaLabel: `${operations} ${section.operations.length} ${programNumber}`,
    programChip,
    warn: section.face !== 'around' && section.registrationMissing,
    empty: section.operations.length === 0,
  }
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

/**
 * The reach cards worth showing for a setup's face (issue #1102): only where
 * the two faces meet, or where the setup cannot reach a target at all. A
 * single-sided target — a blind pocket, an Around feature, a rotary pass — has
 * nothing on the other side to measure, so its card could only ever read
 * "unverified". Rejected targets stay: "cannot reach" is an error to see.
 */
export function visibleTargetReach(face: SetupFace, reaches: readonly TargetReach[]): TargetReach[] {
  if (face === 'around') return []
  return reaches.filter((entry) => (
    entry.verdict.through || entry.verdict.status === 'cross-face' || entry.verdict.status === 'rejected'
  ))
}

/**
 * The folded cross-face list's `<summary>` line (issue #1102): what the list
 * holds, then every ticked target's name followed by ⇄, so the picks stay
 * visible while the list is closed.
 */
export function crossFaceSummaryLine(
  summary: string,
  candidates: readonly { id: string; name: string }[],
  selectedIds: readonly string[],
): string {
  const picked = candidates
    .filter((feature) => selectedIds.includes(feature.id))
    .map((feature) => `${feature.name} ⇄`)
  return picked.length > 0 ? `${summary}: ${picked.join(' ')}` : summary
}

/**
 * Whether an operation may be moved to another setup (issue #1102). A rotary
 * pass only ever lives on the Around setup, so there is nowhere to move it.
 */
export function canMoveOperation(kind: OperationKind): boolean {
  return !isRotaryOperationKind(kind)
}

/** The operations a setup would lose if it were deleted — what the confirmation has to list. */
export function operationsDeletedWithSetup(project: Project, setupId: string): Operation[] {
  return project.operations.filter((operation) => operation.setupId === setupId)
}
