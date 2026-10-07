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
 * stock: the operator turns the part between setups and loads a new blank, so
 * the material the other setup removed is simply not there yet. This module
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
 * The original project, map and path objects are never written to. A Top
 * setup returns them as they are — the same objects — so a project without a
 * turned setup takes exactly the path it took before setups existed.
 */

import type { MachiningSetup, Operation, Project } from '../types/project'
import type { ToolpathResult } from '../engine/toolpaths/types'
import { setupForOperation, setupFrame } from '../engine/setupOrientation'
import type { SetupFrame } from '../engine/setupOrientation'
import { projectInSetupFrame, toolpathInSetupFrame } from '../engine/setupFrameProject'

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
  const saved = project.setups ?? []
  // The legacy fallback is the project's first setup, matching the export and
  // the CAM panel. A provisional setup the project does not hold yet is
  // appended so it can still be told apart from that first setup.
  const setups = saved.some((entry) => entry.id === setup.id) ? saved : [...saved, setup]
  const topSetup = setups[0]

  const operations = project.operations.filter((operation) => {
    // Throws for an operation naming a setup the project does not define.
    const operationSetup = setupForOperation(project, operation)
    return (operationSetup ?? topSetup)?.id === setup.id
  })

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
