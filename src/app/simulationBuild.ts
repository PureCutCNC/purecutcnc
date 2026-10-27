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
 * Which built simulation result the current inputs may show (issue #1112
 * review P1).
 *
 * The heavy replay now runs after the tab commits, so its answer arrives late.
 * It is stamped with the exact `SimulationResultInput` object it was built
 * from, and only that identity may be read: a build that finishes after the
 * selection, setup, mode, detail or document changed is dropped instead of
 * being installed over the newer request. Keeping the rule here (rather than
 * inline in the effect) is what lets the unit test drive a stale completion
 * without a browser.
 */

import type { SimulationResult } from '../engine/simulation'
import type { SimulationResultInput } from './simulationCompute'

export interface SimulationBuild {
  input: SimulationResultInput
  result: SimulationResult
}

/** The result for these exact inputs, or null while that build is pending. */
export function simulationResultForInput(
  build: SimulationBuild | null,
  input: SimulationResultInput | null,
): SimulationResult | null {
  return build !== null && input !== null && build.input === input ? build.result : null
}

/**
 * Install a completed build only when it still answers the requested inputs.
 * A late completion for older inputs leaves the current build untouched.
 */
export function applySimulationBuild(
  current: SimulationBuild | null,
  requested: SimulationResultInput | null,
  completed: SimulationResultInput,
  result: SimulationResult,
): SimulationBuild | null {
  if (requested === null || requested !== completed) {
    return current
  }
  return { input: completed, result }
}
