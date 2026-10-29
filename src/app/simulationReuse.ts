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
 * Reuse of finished simulation work (issue #1112 rt2-h).
 *
 * Opening the Simulation tab replays the selected operation's path into a fresh
 * heightfield, and the playback starting stock replays the operations before
 * it. Neither answer depends on the tab being open, so switching back to the
 * same operation — or pressing play on the operation whose stock the previous
 * replay already produced — must not repeat the work. On Frank's
 * `turn-shape-test-01` a switch back paid 86 ms for the rough and 61 ms for the
 * finish, and pressing play on the finish replayed the rough a second time
 * (89 ms) although the rough's own result was the same heightfield.
 *
 * One result is one replay: a project, the setup whose frame it runs in, the
 * detail, and the paths replayed in cut order
 * ({@link SimulationReplayKey}). That is the unit every entry point builds —
 * the selected cut, the visible replay, and the prior-operation playback base —
 * so the same key means the same heightfield however the panel reached it
 * (`computeSimulationResult` and `priorReplayResult` share one kernel and one
 * grid initialization). Two entry points that name the same items therefore
 * share one result, which is what removes the duplicated prior replay.
 *
 * What makes a key a safe cache hit — a key that names *fewer* inputs than the
 * replay reads would serve a stale heightfield — is that every key component is
 * an immutable reference from the store (`project`), identity of the setup
 * object the project holds, or the exact generated result object for each path.
 * A regenerated path is a new object even when the project is unchanged (a
 * backend switch clears and refills the generation cache), so it can never read
 * an older replay. Every key part is also cheap to compare: no deep equality,
 * no serialization, so peeking during a render costs a handful of `===`.
 *
 * The grid a hit returns is displayed and cloned for playback but never written
 * (`PlaybackController` copies `topZ` into its own live grid, and
 * `reset` copies from the base), so one result can serve both the static view
 * and a playback rerun. This module holds no React, store or worker code: it is
 * a bounded map plus the two pure helpers that build and compare its keys.
 */

import type { SimulationResult } from '../engine/simulation'
import type { ToolpathResult } from '../engine/toolpaths/types'
import type { MachiningSetup, Operation, Project } from '../types/project'

/** One operation's generated path, by the id the replay keys it under. */
export interface SimulationPathEntry {
  operationId: string
  toolpath: ToolpathResult
}

/**
 * The exact work one simulation result is the answer to.
 *
 * `project` is the source document, not the setup-local copy: every frame,
 * blank profile, tool and operation the replay reads is derived from it (plus
 * the setup), so an edit makes a new project object and no key can match across
 * it. `setup` is compared by identity — the project holds that object, and a
 * provisional setup is one cached default per axis, so it is stable for as long
 * as the face is.
 */
export interface SimulationReplayKey {
  project: Project
  setup: MachiningSetup
  detailCells: number
  /** The replayed paths, in cut order. */
  items: readonly SimulationPathEntry[]
}

/**
 * The paths `operations` contribute to a replay: one entry per operation that
 * has a generated path, in the order given.
 *
 * Callers pass the list the mode replays — the selection alone, the operations
 * before it, or all of them. Eligibility (enabled, shown, a resolvable tool) is
 * deliberately **not** applied here: the kernel drops such an operation, so
 * naming it in the key only makes a key stricter (a miss where a hit was
 * possible), while omitting a path the kernel does read would make two
 * different replays share a key. The safe direction is the superset.
 */
export function simulationReplayEntries(
  operations: readonly Operation[],
  paths: ReadonlyMap<string, ToolpathResult>,
): SimulationPathEntry[] {
  const entries: SimulationPathEntry[] = []
  for (const operation of operations) {
    const toolpath = paths.get(operation.id)
    if (toolpath) entries.push({ operationId: operation.id, toolpath })
  }
  return entries
}

/** Same project, setup, detail and the same paths in the same order. */
export function sameSimulationReplayKey(a: SimulationReplayKey, b: SimulationReplayKey): boolean {
  if (a === b) return true
  if (a.project !== b.project || a.setup !== b.setup || a.detailCells !== b.detailCells) return false
  if (a.items.length !== b.items.length) return false
  for (let index = 0; index < a.items.length; index += 1) {
    const left = a.items[index]
    const right = b.items[index]
    if (left.operationId !== right.operationId || left.toolpath !== right.toolpath) return false
  }
  return true
}

/** How many finished replays one panel keeps. */
const DEFAULT_CAPACITY = 6

/**
 * The finished replays a simulation panel may show again, most recent last.
 *
 * Linear over a handful of entries on purpose: a switch compares the key it
 * would build against at most six, which is far cheaper than hashing a project,
 * and it cannot drift out of step with `sameSimulationReplayKey`.
 *
 * One document is kept at a time. A result's key holds its path objects, which
 * belong to that document's project snapshot, so dropping the other documents
 * on every remember bounds what a long session leaves resident.
 */
export class SimulationReplayCache {
  private readonly entries: { key: SimulationReplayKey; result: SimulationResult }[] = []
  private readonly capacity: number

  constructor(capacity: number = DEFAULT_CAPACITY) {
    this.capacity = capacity
  }

  /** The result for exactly this work, or null. Never reorders or evicts. */
  peek(key: SimulationReplayKey): SimulationResult | null {
    for (const entry of this.entries) {
      if (sameSimulationReplayKey(entry.key, key)) return entry.result
    }
    return null
  }

  remember(key: SimulationReplayKey, result: SimulationResult): void {
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (this.entries[index].key.project !== key.project) this.entries.splice(index, 1)
    }
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      if (sameSimulationReplayKey(this.entries[index].key, key)) this.entries.splice(index, 1)
    }
    this.entries.push({ key, result })
    while (this.entries.length > this.capacity) this.entries.shift()
  }

  clear(): void {
    this.entries.length = 0
  }

  get size(): number {
    return this.entries.length
  }
}

/**
 * The result for `key`, replaying it through `build` only when it is not known.
 *
 * `build` must be the replay the key describes; the caller then gets one
 * result whether this is the first time those paths are simulated or the panel
 * is returning to them. Used by the playback base grid, which runs inside a
 * frame callback and must not repeat a replay the panel already finished.
 */
export function rememberedReplay(
  cache: SimulationReplayCache,
  key: SimulationReplayKey,
  build: () => SimulationResult,
): SimulationResult {
  const cached = cache.peek(key)
  if (cached !== null) return cached
  const result = build()
  cache.remember(key, result)
  return result
}
