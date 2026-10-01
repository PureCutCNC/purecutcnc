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

import type { OperationPass } from '../../types/project'
import { generateStepLevels } from './pocket'

/** Tolerance on "this level is that target's top or bottom", in project units. */
const LEVEL_EPSILON = 1e-6

/** What an outside route needs to know about a target to schedule it. */
export interface EdgeRunTarget {
  topZ: number
  /** Where this route stops cutting the target: its bottom, raised by axial stock to leave. */
  bottomZ: number
}

/**
 * Is `target`'s wall cut at level `z` (issue #179)?
 *
 * A rough pass cuts a target at every level from just below its top down to
 * its bottom. A finish pass cuts it once, at its bottom. A level at the top is
 * not a cut: the tip only touches the top face.
 *
 * This is also the rule that decides when another target of the same route is
 * something to steer around instead: wherever it is not being cut.
 */
export function edgeTargetCutAt(target: EdgeRunTarget, pass: OperationPass, z: number): boolean {
  if (pass === 'finish') return Math.abs(z - target.bottomZ) <= LEVEL_EPSILON
  return z >= target.bottomZ - LEVEL_EPSILON && z < target.topZ - LEVEL_EPSILON
}

/** Consecutive levels at which an outside route cuts the same set of targets. */
export interface EdgeLevelRun<T extends EdgeRunTarget> {
  targets: T[]
  levels: number[]
  /** Where material starts above this run's first level. */
  topZ: number
  /** The run's last level. */
  bottomZ: number
}

function pushDistinct(levels: number[], z: number): void {
  if (!levels.some((level) => Math.abs(level - z) <= LEVEL_EPSILON)) levels.push(z)
}

/**
 * The levels an outside route cuts its targets at, grouped into runs that cut
 * the same targets (issue #179).
 *
 * Targets whose depth spans differ used to be routed one at a time, each blind
 * to the others, which cut straight through wherever they touched. Instead
 * every level routes the outline of the targets cut there, taken together.
 *
 * A rough pass steps down from the highest top to the deepest bottom, with
 * each target's own bottom added, so every target ends exactly at its depth
 * and no step is deeper than the stepdown. A finish pass has one level per
 * distinct bottom.
 *
 * Targets that all share one span make one run with the levels a single
 * target would get, which is exactly what the route cut before.
 */
export function edgeLevelRuns<T extends EdgeRunTarget>(
  targets: T[],
  pass: OperationPass,
  stepdown: number,
): EdgeLevelRun<T>[] {
  if (targets.length === 0) return []
  const topZ = Math.max(...targets.map((target) => target.topZ))
  const levels: number[] = []
  if (pass !== 'finish') {
    const deepest = Math.min(...targets.map((target) => target.bottomZ))
    for (const z of generateStepLevels(topZ, deepest, stepdown)) pushDistinct(levels, z)
  }
  for (const target of targets) pushDistinct(levels, target.bottomZ)
  levels.sort((a, b) => b - a)

  const runs: EdgeLevelRun<T>[] = []
  let previousLevel: number | null = null
  let current: EdgeLevelRun<T> | null = null
  for (const z of levels) {
    const cut = targets.filter((target) => edgeTargetCutAt(target, pass, z))
    const sameTargets = current !== null
      && current.targets.length === cut.length
      && current.targets.every((target, index) => target === cut[index])
    if (cut.length === 0) {
      current = null
    } else if (sameTargets && current !== null) {
      current.levels.push(z)
      current.bottomZ = z
    } else {
      const cutTop = Math.max(...cut.map((target) => target.topZ))
      current = {
        targets: cut,
        levels: [z],
        topZ: pass === 'finish' || previousLevel === null ? cutTop : Math.min(previousLevel, cutTop),
        bottomZ: z,
      }
      runs.push(current)
    }
    previousLevel = z
  }
  return runs
}
