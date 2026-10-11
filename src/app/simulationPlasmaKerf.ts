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
 * Which plasma kerf bands the Simulation tab shows (issue #961, slice B).
 *
 * Split out of `useSimulationModel` so the selection is a pure function of the
 * setup input and the mode — the hook has no testable seam of its own, and the
 * rule is the same one the 3D preview applies: a `plasma_profile` operation
 * with a usable torch and a toolpath already in hand, never a path this module
 * generates. Display only; nothing here reads or writes the store.
 */

import type { PlasmaKerfGeometry } from '../components/plasmaKerfPreview'
import { plasmaKerfGeometry, plasmaKerfWidth } from '../components/plasmaKerfPreview'
import type { SimulationSetupInput } from './simulationSetup'

/** One simulated plasma operation's band, in the simulated setup's frame. */
export interface SimulationPlasmaKerfItem {
  operationId: string
  width: number
  geometry: PlasmaKerfGeometry
}

/** Stable empty result, so a tab with no plasma cut does not churn a memo. */
const NO_KERF: readonly SimulationPlasmaKerfItem[] = []

/**
 * The plasma bands for the simulated setup.
 *
 * Empty unless the Simulation tab is showing (`active`) and the setup input
 * resolved. In `'selected'` mode it is the selected operation alone, when the
 * setup holds a toolpath for it; in `'visible'` mode every enabled, shown
 * plasma operation of the simulated setup, in cut order. A missing toolpath is
 * skipped rather than generated — the same "read, never generate" rule the
 * heightfield input follows.
 */
export function selectSimulationPlasmaKerf(
  active: boolean,
  setupInput: SimulationSetupInput | null,
  mode: 'selected' | 'visible',
  selectedOperationId: string | null,
): readonly SimulationPlasmaKerfItem[] {
  if (!active || !setupInput) {
    return NO_KERF
  }
  const { project, toolpaths } = setupInput
  const operationIds = mode === 'selected'
    ? (selectedOperationId === null ? [] : [selectedOperationId])
    : setupInput.operations
        .filter((operation) => operation.enabled && operation.showToolpath)
        .map((operation) => operation.id)

  const items: SimulationPlasmaKerfItem[] = []
  for (const operationId of operationIds) {
    const width = plasmaKerfWidth(project, operationId)
    if (width === null) {
      continue
    }
    const toolpath = toolpaths.get(operationId)
    if (!toolpath) {
      continue
    }
    items.push({ operationId, width, geometry: plasmaKerfGeometry(toolpath) })
  }
  return items.length === 0 ? NO_KERF : items
}
