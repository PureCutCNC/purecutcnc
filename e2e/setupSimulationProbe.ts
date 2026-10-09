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
 * Browser-side probe for the simulation's setup picker (issue #947, review of
 * PR #992). Imported by `setupPreview.smoke.spec.ts` through the dev server,
 * it renders the real `useSimulationModel` with a toolpath request the test
 * holds open, so a setup switch can be observed while its acquisition is
 * still in flight — which a static render, with no effects, cannot show.
 */

import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { useSimulationModel } from '../src/app/useSimulationModel'
import { computeOperationToolpath } from '../src/engine/toolpaths/generateOperation'
import type { SimulationGrid } from '../src/engine/simulation'
import type { ToolpathResult } from '../src/engine/toolpaths/types'
import type { Project } from '../src/types/project'

export interface ProbeSnapshot {
  setup: string
  pending: boolean
  playback: boolean
  /** Cells the playback's starting stock has cut, or null without playback. */
  baseCutCells: number | null
}

function cutCells(grid: SimulationGrid, thickness: number): number {
  let count = 0
  for (const z of grid.topZ) if (z < thickness - 1e-6) count += 1
  return count
}

/**
 * Select `selectedId` (a Bottom operation with an earlier Bottom operation),
 * then: acquire, pick `otherSetupId`, pick the selected operation's setup
 * back while its acquisition is held, and finally release it.
 */
export async function runPickerTransitionProbe(
  project: Project,
  selectedId: string,
  otherSetupId: string,
): Promise<Record<'initial' | 'acquired' | 'other' | 'backHeld' | 'backAcquired', ProbeSnapshot>> {
  const operation = (id: string) => {
    const found = project.operations.find((entry) => entry.id === id)
    if (!found) throw new Error(`probe: no operation ${id}`)
    return found
  }
  const generate = (id: string): ToolpathResult => {
    const envelope = computeOperationToolpath(project, operation(id))
    if (!envelope) throw new Error(`probe: ${id} is not generated`)
    return envelope.result
  }
  const selected = operation(selectedId)
  const selectedToolpath = generate(selectedId)
  const held: Array<{ id: string; resolve: (toolpath: ToolpathResult) => void }> = []
  const requestToolpath = (id: string) => new Promise<ToolpathResult | null>((resolve) => { held.push({ id, resolve }) })
  const release = () => {
    for (const request of held.splice(0)) request.resolve(generate(request.id))
  }

  let latest: ReturnType<typeof useSimulationModel> | null = null
  function Probe() {
    latest = useSimulationModel({
      project, centerTab: 'simulation', simulationMode: 'selected', simulationDetailCells: 120,
      selectedOperation: selected, selectedToolpath, requestToolpath,
    })
    return null
  }
  const current = () => {
    if (!latest) throw new Error('probe: the hook has not rendered')
    return latest
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 100))
  const snapshot = (): ProbeSnapshot => {
    const model = current()
    const playback = model.simulationPlaybackInput
    return {
      setup: model.simulationSetupPicker.selectedId,
      pending: model.simulationInputPending,
      playback: playback !== null,
      baseCutCells: playback ? cutCells(playback.getBaseGrid(), project.stock.thickness) : null,
    }
  }

  const root = createRoot(document.createElement('div'))
  root.render(createElement(Probe))
  try {
    await settle()
    const initial = snapshot()
    release()
    await settle()
    const acquired = snapshot()
    const selectedSetup = acquired.setup
    current().simulationSetupPicker.onChange(otherSetupId)
    await settle()
    const other = snapshot()
    current().simulationSetupPicker.onChange(selectedSetup)
    await settle()
    const backHeld = snapshot()
    release()
    await settle()
    const backAcquired = snapshot()
    return { initial, acquired, other, backHeld, backAcquired }
  } finally {
    root.unmount()
  }
}
