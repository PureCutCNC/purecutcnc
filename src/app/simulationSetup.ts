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
 * One setup's simulation input (issue #947).
 *
 * Simulation runs one setup at a time, in that setup's own frame, on fresh
 * stock. The operator does not load a new blank between setups — they turn
 * the same part over — so fresh stock is this simulation's approximation, not
 * the shop floor: what another setup removed is simply not shown. The
 * simulation panel says so wherever more than one setup exists. This module
 * is the whole of that decision. It is pure: it reads the project, the
 * generated stock-space toolpaths and the selected setup, and returns what
 * the existing heightfield engine consumes — a project in the setup-local
 * frame, that setup's operations in cut order, and those operations' paths
 * turned out of canonical stock space once.
 *
 * Nothing here generates, acquires or invents motion. A path the caller did
 * not hand in stays missing, exactly as a missing path is the consumer's
 * signal to wait or to skip; a display-only placeholder must never reach the
 * engine. The engine itself is unchanged: it only ever sees the top-down
 * frame, which for a Bottom setup is the stock turned over.
 *
 * The original project, map and path objects are never written to. For a Top
 * setup the project and every individual path come back as the same objects,
 * so a project without a turned setup simulates exactly what it did before
 * setups existed; the returned map is always a new one, scoped to the
 * setup's operations, so another setup's paths cannot leak through it.
 */

import type { MachiningSetup, Operation, Project } from '../types/project'
import type { ToolpathResult } from '../engine/toolpaths/types'
import { setupForOperation, setupFrame } from '../engine/setupOrientation'
import type { SetupFrame } from '../engine/setupOrientation'
import { projectInSetupFrame, toolpathInSetupFrame } from '../engine/setupFrameProject'
import { activeSetup } from '../store/helpers/activeFace'

/** Everything one setup's simulation needs, all of it in that setup's frame. */
export interface SimulationSetupInput {
  /** The project turned into the setup's frame; the same object for Top. */
  project: Project
  /** The setup's operations, in the order they are cut, disabled and hidden included. */
  operations: Operation[]
  /** The acquired stock-space paths of those operations, turned once. Missing paths stay missing. */
  toolpaths: ReadonlyMap<string, ToolpathResult>
}

/**
 * The frame a setup turns the stock through, or undefined for Top. Reuses
 * `setupFrame`, so an orientation this build cannot machine is refused here
 * exactly as it is everywhere else.
 */
function frameForSetup(setup: MachiningSetup, project: Pick<Project, 'stock'>): SetupFrame | undefined {
  return setup.orientation.angleDeg === 0 ? undefined : setupFrame(setup.orientation, project.stock)
}

/**
 * Prepare one setup's simulation input.
 *
 * `toolpaths` holds every generated operation's result in canonical stock
 * space, by operation id — the map the preview and export already share. Only
 * the selected setup's operations are returned, and only the paths that are
 * actually in the map; the caller owns eligibility (`enabled`,
 * `showToolpath`, tool) exactly as it does today.
 *
 * A setup that is not one of `project.setups` — the provisional face the
 * workspace looks at before content lands on it — is valid and has no
 * operations of its own. Membership follows the same rule as the export and
 * the CAM panel: an operation whose `setupId` names a setup belongs to it,
 * and one with no `setupId` at all reads as Top. A `setupId` that names no
 * setup is an error, not a silent Top operation.
 */
export function buildSimulationSetupInput(
  project: Project,
  setup: MachiningSetup,
  toolpaths: ReadonlyMap<string, ToolpathResult>,
): SimulationSetupInput {
  const operations = setupOperations(project, setup)

  const frame = frameForSetup(setup, project)
  const localToolpaths = new Map<string, ToolpathResult>()
  for (const operation of operations) {
    const toolpath = toolpaths.get(operation.id)
    if (toolpath) localToolpaths.set(operation.id, toolpathInSetupFrame(toolpath, frame))
  }

  return {
    project: projectInSetupFrame(project, frame),
    operations,
    toolpaths: localToolpaths,
  }
}

/**
 * The setups a simulation can run: the project's own, in program order, plus
 * the provisional one the workspace is looking at when the project has no
 * setup for that face yet — the same list the CAM panel shows as sections.
 */
export function simulationSetups(project: Project): MachiningSetup[] {
  const saved = project.setups ?? []
  const current = activeSetup(project)
  return saved.some((entry) => entry.id === current.id) ? saved : [...saved, current]
}

/**
 * A setup's operations in cut order. Membership follows the export and the
 * CAM panel: an operation whose `setupId` names a setup belongs to it, and
 * one with no `setupId` reads as the project's first setup (Top). Throws for
 * a `setupId` that names no setup.
 */
export function setupOperations(project: Project, setup: MachiningSetup): Operation[] {
  const saved = project.setups ?? []
  // The legacy fallback is the project's first setup, matching the export and
  // the CAM panel. A provisional setup the project does not hold yet is
  // appended so it can still be told apart from that first setup.
  const setups = saved.some((entry) => entry.id === setup.id) ? saved : [...saved, setup]
  const topSetup = setups[0]
  return project.operations.filter((operation) => {
    // Throws for an operation naming a setup the project does not define.
    const operationSetup = setupForOperation(project, operation)
    return (operationSetup ?? topSetup)?.id === setup.id
  })
}

/**
 * Which setup the simulation shows. An explicit pick wins while that setup
 * still exists; otherwise the simulation follows the selected operation's
 * setup, so selecting a Bottom operation simulates Bottom, and with nothing
 * selected it follows the face the workspace is on. An operation naming a
 * missing setup is left to the paths that refuse it; here it simply does not
 * steer the choice.
 */
export function resolveSimulationSetup(
  project: Project,
  chosenSetupId: string | null,
  selectedOperation: Pick<Operation, 'id'> | null,
): MachiningSetup {
  const setups = simulationSetups(project)
  const chosen = chosenSetupId === null ? undefined : setups.find((entry) => entry.id === chosenSetupId)
  if (chosen) return chosen
  if (selectedOperation) {
    const owner = setups.find((entry) => {
      try {
        return setupOperations(project, entry).some((operation) => operation.id === selectedOperation.id)
      } catch {
        return false
      }
    })
    if (owner) return owner
  }
  return activeSetup(project)
}
