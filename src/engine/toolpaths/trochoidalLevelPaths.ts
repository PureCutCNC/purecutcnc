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
 * Sharing one generated trochoidal path across the Z levels that produce the
 * same guide (issue #661).
 *
 * A deep cut fragments its guide identically at every level unless something
 * Z-dependent enters — a tab active below its `z_top`, an obstacle overlapping
 * the level's Z span, a region mask. Where nothing does, every level asks
 * `buildTrochoidalContour` for the same XY path and only Z differs, so the
 * generator runs N times for N levels and N copies are stored.
 *
 * ## Why the key is the planned geometry, not the reasons it changed
 *
 * The obvious signature is the set of causes: which tabs are active, which
 * obstacles overlap. That means re-deriving by hand a conclusion the fragment
 * planner already reached, and every future input to fragmentation becomes a
 * place the key can fall silently behind — region masks are already a third
 * input beyond the two the design doc names.
 *
 * So the key is the planner's *output*: the guide points plus the parameters
 * the generator reads. `buildTrochoidalContour` is a pure function of exactly
 * those; its only other option, `maxPoints`, selects between a result and a
 * `move-budget` error and never moves a point. Identical key therefore means
 * provably identical output, and any difference in what the planner produced —
 * whatever caused it — is a different key by construction.
 *
 * ## What sharing a path must not share
 *
 * The Z-dependent work stays per level: the verification backstop
 * (`planning/TROCHOIDAL_EDGE_DESIGN.md`, "The verification backstop") runs at
 * each level's own Z on the shared points, and entry synthesis runs from each
 * level's own `entryStartZ`. This module only answers "has this exact path been
 * generated already"; it has no opinion about Z and is never given one.
 */

import type { Point } from '../../types/project'
import type { TrochoidalContourResult } from './trochoidalEdge'

/**
 * The generator inputs that are not the guide itself. Constant across the
 * levels of one call today, and in the key anyway: the store's lifetime is the
 * whole operation, so the key must not depend on that staying true.
 */
export interface TrochoidalPathParams {
  orbitRadius: number
  advance: number
  toolDiameter: number
  angularDirection: 1 | -1
}

/**
 * `String(n)` is the shortest representation that round-trips a double, so two
 * distinct doubles never produce the same characters — with one exception:
 * `-0` and `0` both print `0`. Distinguish them explicitly. The pair is
 * arithmetically almost interchangeable, but "almost" is not the standard this
 * key is held to, and splitting costs one extra generated path at worst.
 */
function coordinate(value: number): string {
  return Object.is(value, -0) ? '-0' : String(value)
}

/**
 * Every input `buildTrochoidalContour` reads, in one string. Guide points last
 * so the cheap discriminators sort first in a debugger.
 */
export function trochoidalGuideSignature(
  points: Point[],
  closed: boolean,
  params: TrochoidalPathParams,
): string {
  const head = [
    closed ? 'closed' : 'open',
    coordinate(params.orbitRadius),
    coordinate(params.advance),
    coordinate(params.toolDiameter),
    String(params.angularDirection),
    String(points.length),
  ].join('|')
  const guide = points.map((point) => `${coordinate(point.x)},${coordinate(point.y)}`).join(';')
  return `${head}|${guide}`
}

export interface TrochoidalPathLookup {
  built: TrochoidalContourResult
  /** False when an earlier level's path was reused, i.e. no generator call was made. */
  generated: boolean
}

/**
 * Per-operation store of generated trochoidal paths.
 *
 * Deliberately an interface rather than a concrete class: the level-sharing
 * tests pass an implementation that never reuses, which is how "the emitted
 * program is byte-identical with and without sharing" is asserted as a computed
 * invariant instead of a checked-in golden that goes stale.
 */
export interface TrochoidalPathStore {
  /** Paths actually generated — one per `buildTrochoidalContour` call made. */
  readonly generatedCount: number
  resolve(
    points: Point[],
    closed: boolean,
    params: TrochoidalPathParams,
    generate: () => TrochoidalContourResult,
  ): TrochoidalPathLookup
}

class ReusingTrochoidalPathStore implements TrochoidalPathStore {
  private readonly paths = new Map<string, TrochoidalContourResult>()
  private generated = 0

  get generatedCount(): number {
    return this.generated
  }

  resolve(
    points: Point[],
    closed: boolean,
    params: TrochoidalPathParams,
    generate: () => TrochoidalContourResult,
  ): TrochoidalPathLookup {
    const key = trochoidalGuideSignature(points, closed, params)
    const hit = this.paths.get(key)
    if (hit) return { built: hit, generated: false }

    const built = generate()
    this.generated += 1
    // A failed build is never cached. `move-budget` is a function of the budget
    // remaining at that moment, not of the guide, so caching it would make a
    // later fragment inherit an earlier one's budget state.
    if (!built.error) this.paths.set(key, built)
    return { built, generated: true }
  }
}

export function createTrochoidalPathStore(): TrochoidalPathStore {
  return new ReusingTrochoidalPathStore()
}
