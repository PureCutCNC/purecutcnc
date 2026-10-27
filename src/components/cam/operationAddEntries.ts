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
 *   where you are). The rotary rough/finish rows lead the Around menu.
 * - **Round-only rows stay listed on a square blank, disabled with the
 *   reason.** On a square blank only a rotary rough/finish against a model may
 *   cut the Around face, so every wrapped 2D kind is offered with "Needs a
 *   round bar" instead of disappearing (decision 5: disable what belongs there
 *   but is blocked by something the user can change — here, the stock shape).
 * - The other family's kinds are left out entirely, as before (`machineMode`),
 *   and a plasma cut is offered as blocked with the project-type reason.
 */

import { isRotaryOperationKind, type OperationKind, type Project, type SetupFace } from '../../types/project'
import type { SelectionState } from '../../store/types'
import { isSquareStock } from '../../types/barStock'
import { getOperationAddHint, rotaryAddKindsForFace, selectAllCompatibleFeatureIds } from './operationValidity'
import { operationOffer, type MachineMode } from './machineMode'
import { camT } from './camI18n'

export interface OperationAddEntry {
  kind: OperationKind
  label: string
  hint?: string
  /** Features "Select all" would select; empty when the affordance is unavailable. */
  selectAllFeatureIds: string[]
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
  const flat = ADD_MENU_KINDS.filter((kind) => face !== 'around' || !SURFACE_KINDS.has(kind))
  const rotary = rotaryAddKindsForFace(project, face)
  // The model lives in the bar: on Around the rotary rows lead, because that
  // is the work the face exists for (issue #1015).
  return face === 'around' ? [...rotary, ...flat] : [...flat, ...rotary]
}

/**
 * The blocking reason for one kind, or null when the current selection can
 * take it. The project type is stated first, then a stock shape the user can
 * change, and only then the selection: on a square blank's Around face a
 * round-only row says "Needs a round bar" whatever is selected.
 */
export function operationAddHint(
  project: Project,
  selection: SelectionState,
  machine: MachineMode,
  face: SetupFace,
  kind: OperationKind,
): string | null {
  if (operationOffer(machine, kind) === 'needs-plasma-project') {
    return camT('cam.addMenu.needsPlasmaProject')
  }
  if (face === 'around' && isSquareStock(project.stock) && !isRotaryOperationKind(kind)) {
    return camT('cam.addMenu.needsRoundBar')
  }
  return getOperationAddHint(project, selection, kind)
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
      const hint = operationAddHint(project, selection, machine, face, kind)
      return {
        kind,
        label: operationAddButtonLabel(kind),
        hint: hint ?? undefined,
        // "Select all" is only offered while the hint is showing, so skip the
        // compatibility scan when the current selection is already valid.
        selectAllFeatureIds: hint ? selectAllCompatibleFeatureIds(project, kind) : [],
      }
    })
}
