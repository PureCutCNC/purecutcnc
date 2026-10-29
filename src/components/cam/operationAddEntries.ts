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
 * What the CAM panel's "Add operation" menu offers, as data (issue #1112 slice
 * K). Extracted from `CAMPanel.tsx` so the menu's contents can be tested
 * without a browser and so the face/stock rules live in one place:
 *
 * - **Around offers only what Around can do.** The three 3D surface strategies
 *   machine an imported model from a flat face and have no Around form, so
 *   they are not listed there at all (decision 5: hide what does not belong to
 *   where you are). The flat plasma cut is left out for the same reason: it
 *   cuts a flat plate, not a wrapped face. The rotary rough/finish rows lead
 *   the Around menu.
 * - **Round-only rows stay listed on a square blank, disabled with the
 *   reason.** On a square blank only a rotary rough/finish against a model may
 *   cut the Around face, so every wrapped 2D kind is offered with "Needs a
 *   round bar" instead of disappearing (decision 5: disable what belongs there
 *   but is blocked by something the user can change — here, the stock shape).
 *   `blockedInPlace` marks those rows so the menu renders them in place rather
 *   than behind the collapsed "not available for this selection" disclosure:
 *   the disclosure is for the selection, and the stock reason must be seen.
 * - The other family's kinds are left out entirely, as before (`machineMode`),
 *   and a plasma cut on a flat face is offered as blocked with the
 *   project-type reason.
 *
 * `validQuickOperationsForFeatureOnActiveFace` answers the feature-context menu's
 * "Create operation" list from the same table when the feature is authored on
 * another face (issue #1112 F2), so the two surfaces cannot offer a different
 * set of operations for the same face and stock.
 */

import { isRotaryOperationKind, type OperationKind, type OperationPass, type Project, type SetupFace } from '../../types/project'
import type { SelectionState } from '../../store/types'
import { isSquareStock } from '../../types/barStock'
import {
  getOperationAddHint,
  operationSelectionHint,
  quickOperationGroup,
  quickOperationLabel,
  rotaryAddKindsForFace,
  selectAllCompatibleFeatureIds,
  singleFeatureSelection,
  type QuickOperation,
} from './operationValidity'
import { operationOffer, machineMode, type MachineMode } from './machineMode'
import { resolvedFeatureMap } from '../../store/helpers/resolveFeatures'
import { activeFace } from '../../store/helpers/activeFace'
import { camT } from './camI18n'

export interface OperationAddEntry {
  kind: OperationKind
  label: string
  hint?: string
  /** Features "Select all" would select; empty when the affordance is unavailable. */
  selectAllFeatureIds: string[]
  /**
   * The kind belongs on this face but the stock shape blocks it, so the row
   * stays visible (disabled, with its reason) instead of joining the
   * selection's collapsed disclosure.
   */
  blockedInPlace: boolean
}

/**
 * The 3D surface strategies: they machine an imported model from a flat face
 * and have no wrapped form, so the Around menu does not offer them.
 */
const SURFACE_KINDS: ReadonlySet<OperationKind> = new Set<OperationKind>([
  'rough_surface',
  'finish_surface',
  'finish_surface_cleanup',
])

/** Kinds that do not belong on the Around face at all (decision 5). */
const AROUND_HIDDEN_KINDS: ReadonlySet<OperationKind> = new Set<OperationKind>([
  ...SURFACE_KINDS,
  // A plasma cut goes through a flat plate; wrapping it has no meaning.
  'plasma_profile',
])

/** Every kind the panel can author, in catalogue order (the 2D kinds first). */
const ADD_MENU_KINDS: readonly OperationKind[] = [
  'pocket',
  'v_carve',
  'v_carve_medial',
  'edge_route_inside',
  'edge_route_outside',
  'surface_clean',
  'follow_line',
  'drilling',
  'rough_surface',
  'finish_surface_cleanup',
  'finish_surface',
  'plasma_profile',
]

/** Friendly "Add" label for a kind, named as the panel names the operation. */
export function operationAddButtonLabel(kind: OperationKind): string {
  switch (kind) {
    case 'plasma_profile':
      return camT('cam.plasma.title')
    case 'pocket':
      return camT('cam.opButton.pocket')
    case 'v_carve':
      return camT('cam.opButton.vCarve')
    case 'v_carve_medial':
      return camT('cam.opButton.vCarveMedial')
    case 'edge_route_inside':
      return camT('cam.opButton.edgeIn')
    case 'edge_route_outside':
      return camT('cam.opButton.edgeOut')
    case 'surface_clean':
      return camT('cam.opButton.surface')
    case 'rotary_rough':
      return camT('cam.opLabel.rotaryRough')
    case 'rotary_finish':
      return camT('cam.opLabel.rotaryFinish')
    case 'rough_surface':
      return camT('cam.opButton.roughSurface')
    case 'finish_surface':
      return camT('cam.opButton.finishSurface')
    case 'finish_surface_cleanup':
      return camT('cam.opButton.finishSurfaceCleanup')
    case 'follow_line':
      return camT('cam.opButton.engrave')
    case 'drilling':
      return camT('cam.opButton.drill')
  }
}

/** The kinds the menu lists on `face`, before the machine filter and validity. */
export function operationAddKinds(project: Project, face: SetupFace): OperationKind[] {
  const flat = ADD_MENU_KINDS.filter((kind) => face !== 'around' || !AROUND_HIDDEN_KINDS.has(kind))
  const rotary = rotaryAddKindsForFace(project, face)
  // The model lives in the bar: on Around the rotary rows lead, because that
  // is the work the face exists for (issue #1015).
  return face === 'around' ? [...rotary, ...flat] : [...flat, ...rotary]
}

interface OperationAddBlock {
  hint: string | null
  /** True when the hint is about the selection, so "Select all" could clear it. */
  selectionBlocked: boolean
  /** See {@link OperationAddEntry.blockedInPlace}. */
  blockedInPlace: boolean
}

/**
 * The blocking reason for one kind, and where the reason comes from. The
 * project type is stated first, then a stock shape the user can change, and
 * only then the selection: on a square blank's Around face a round-only row
 * says "Needs a round bar" whatever is selected.
 */
function operationAddBlock(
  project: Project,
  selection: SelectionState,
  machine: MachineMode,
  face: SetupFace,
  kind: OperationKind,
): OperationAddBlock {
  if (operationOffer(machine, kind) === 'needs-plasma-project') {
    return { hint: camT('cam.addMenu.needsPlasmaProject'), selectionBlocked: false, blockedInPlace: false }
  }
  if (face === 'around' && isSquareStock(project.stock) && !isRotaryOperationKind(kind)) {
    return { hint: camT('cam.addMenu.needsRoundBar'), selectionBlocked: false, blockedInPlace: true }
  }
  const hint = getOperationAddHint(project, selection, kind)
  return { hint, selectionBlocked: hint !== null, blockedInPlace: false }
}

/** The blocking reason for one kind, or null when the current selection can take it. */
export function operationAddHint(
  project: Project,
  selection: SelectionState,
  machine: MachineMode,
  face: SetupFace,
  kind: OperationKind,
): string | null {
  return operationAddBlock(project, selection, machine, face, kind).hint
}

/** The menu's rows: every offered kind with its label, hint and "Select all" set. */
export function operationAddEntries(
  project: Project,
  selection: SelectionState,
  machine: MachineMode,
  face: SetupFace,
): OperationAddEntry[] {
  return operationAddKinds(project, face)
    .filter((kind) => operationOffer(machine, kind) !== 'hidden')
    .map((kind) => {
      const block = operationAddBlock(project, selection, machine, face, kind)
      return {
        kind,
        label: operationAddButtonLabel(kind),
        hint: block.hint ?? undefined,
        blockedInPlace: block.blockedInPlace,
        // "Select all" is the recovery path out of a *selection* failure, so
        // scan only then. A project-type refusal on a flat face returned no
        // ids before this module was extracted, and still must (issue #1112 K
        // review); a stock refusal cannot be fixed by selecting anything.
        selectAllFeatureIds: block.selectionBlocked ? selectAllCompatibleFeatureIds(project, kind) : [],
      }
    })
}

/**
 * The operations a *single* feature can be given from the face in view — the
 * feature's own "Create operation" list when it is authored on another face
 * (issue #1112 F2), where the Add menu is the only authority on what belongs
 * there. The face is the active setup's, exactly as the Add menu's is; a
 * caller with another face in mind makes that face active first.
 *
 * Three filters, and each is load-bearing:
 *
 * - the Add menu's kinds for that face and stock (`operationAddKinds` plus the
 *   square-blank rule), so a wrapped 2D path is not offered on a blank's
 *   Around face and a flat plasma cut is not offered on the sheet at all;
 * - the selection half of the hint, judged on this one feature — the rotary
 *   rows skip the selection when Add creates them from the panel, so without
 *   this a wrapped feature would be offered a rotary operation that targets
 *   the bar's model instead of itself;
 * - the face half, so a feature this face cannot reach offers nothing.
 *
 * A feature outside the project, or one every kind refuses, answers `[]` — the
 * caller then knows the current face has no operation for it at all.
 */
export function validQuickOperationsForFeatureOnActiveFace(
  project: Project,
  featureId: string,
): QuickOperation[] {
  const face = activeFace(project)
  const featureById = resolvedFeatureMap(project)
  if (!featureById.has(featureId)) return []
  const selection = singleFeatureSelection(featureId)
  const machine = machineMode(project)
  return operationAddKinds(project, face)
    .filter((kind) => operationOffer(machine, kind) === 'available')
    .filter((kind) => operationAddHint(project, selection, machine, face, kind) === null)
    .filter((kind) => operationSelectionHint(selection, kind, featureById) === null)
    .map((kind) => ({
      kind,
      pass: 'rough' as OperationPass,
      label: quickOperationLabel(kind),
      group: quickOperationGroup(kind),
    }))
}
