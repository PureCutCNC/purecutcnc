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
 * Which toolpaths the preview mutes (issue #947): every operation cut in a
 * setup the workspace is not on. Toolpaths are stored in canonical stock
 * space, so the preview draws every setup's passes together, as they are,
 * with the active setup's at full strength and the others faint — the way
 * the sketch draws the other face's features as ghosts. Nothing here moves
 * a path: #946 already returns them in stock space, and turning them again
 * would draw a Bottom pass on the wrong side of the stock.
 *
 * Membership is the simulation's and the export's (`setupOperations`), so the
 * preview can never show a pass as active in one setup and export it from
 * another. A single-setup project mutes nothing.
 */

import { setupOperations, simulationSetups } from '../app/simulationSetup'
import { activeSetup } from '../store/helpers/activeFace'
import type { Project } from '../types/project'

const NOTHING_MUTED: ReadonlySet<string> = new Set()
const mutedCache = new WeakMap<Project, ReadonlySet<string>>()

/** Ids of the operations whose toolpaths draw muted, cached per project revision. */
export function mutedToolpathOperationIds(project: Project): ReadonlySet<string> {
  const cached = mutedCache.get(project)
  if (cached) return cached
  let muted = NOTHING_MUTED
  if (simulationSetups(project).length > 1) {
    try {
      const active = new Set(setupOperations(project, activeSetup(project)).map((operation) => operation.id))
      muted = new Set(project.operations.filter((operation) => !active.has(operation.id)).map((operation) => operation.id))
    } catch {
      // An operation naming a missing setup: the export refuses the project,
      // and the preview draws every path as it did before setups.
      muted = NOTHING_MUTED
    }
  }
  mutedCache.set(project, muted)
  return muted
}
