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
 * What a pocket finish floor has to cut when its band sits on another one
 * (issue #757).
 *
 * An island whose `z_top` sits below the pocket top splits the pocket at that
 * Z, and the finish runs a floor pass at the split. The only material there is
 * what does not carry on downward — the island's top face, a ledge — while the
 * rest of the band is open space the rough already took deeper. A floor pass
 * over the whole band cuts air across all of it.
 *
 * Two areas, because the offset-ring construction reads one region's boundary
 * as both:
 *
 * - **domain** — where the tool centre may travel: the band's own tool-centre
 *   region, voids included. Entries, links and the wall pass keep using it.
 * - **coverage** — what must be cut: the band's area less the void below.
 *
 * The reverted attempt handed coverage to the ring builder as a region. That
 * insets from *every* edge, so each void became a keep-out a tool radius wide;
 * on an island top pierced by two deeper pockets nothing survived the inset and
 * the face went unmachined. Here a floor root is *intersected* with coverage
 * instead. Where the result meets a void its edge stays on the drop-off, so the
 * outermost ring rides it with the cutter overhanging open space, and only a
 * wall — which the root already stands off — is inset from.
 */

import ClipperLib from 'clipper-lib'
import type { Point } from '../../types/project'
import { DEFAULT_CLIPPER_SCALE, fromClipperPath, toClipperPath } from './geometry'
import { differenceClipperPaths, intersectClipperPaths, unionClipperPaths } from './modelProtection'
import type { ClipperPath, ResolvedPocketRegion } from './types'

/**
 * A missed strip thinner than twice this is arc and rounding residue, not
 * material. Relative to the reach so it means the same in mm and inch, and
 * never under a few integer units, where rounding alone lives.
 */
const RESIDUAL_NOISE_FRACTION = 1e-3
const MIN_RESIDUAL_NOISE_UNITS = 4

function residualNoiseUnits(reach: number): number {
  return Math.max(MIN_RESIDUAL_NOISE_UNITS, reach * DEFAULT_CLIPPER_SCALE * RESIDUAL_NOISE_FRACTION)
}

/** A loop wound in Clipper's positive sense, so filled areas union rather than cancel. */
function filledLoop(points: Point[]): ClipperPath {
  const path = toClipperPath(points, DEFAULT_CLIPPER_SCALE)
  return ClipperLib.Clipper.Area(path) >= 0 ? path : [...path].reverse()
}

/** Round-joined offset; `delta` in Clipper units, arcs drawn to `arcTolerance`. */
function roundOffset(paths: ClipperPath[], delta: number, arcTolerance: number): ClipperPath[] {
  if (paths.length === 0) return []
  const offset = new ClipperLib.ClipperOffset()
  offset.ArcTolerance = arcTolerance
  offset.AddPaths(paths, ClipperLib.JoinType.jtRound, ClipperLib.EndType.etClosedPolygon)
  const solution = new ClipperLib.Paths()
  offset.Execute(solution, delta)
  return solution as ClipperPath[]
}

/** The area regions cover — each outer less its islands — as one path set. */
export function regionAreaPaths(regions: ResolvedPocketRegion[]): ClipperPath[] {
  return unionClipperPaths(regions
    .filter((region) => region.outer.length >= 3)
    .flatMap((region) => differenceClipperPaths(
      [filledLoop(region.outer)],
      region.islands.filter((island) => island.length >= 3).map(filledLoop),
    )))
}

/** Material-bearing ground at a band's floor: the band's area less the void carrying on below it. */
export function floorCoverage(bandRegions: ResolvedPocketRegion[], voidBelow: ClipperPath[]): ClipperPath[] {
  return differenceClipperPaths(regionAreaPaths(bandRegions), voidBelow)
}

export type FloorRootRestriction =
  /** Cutting less of this root would miss material its full pass reaches. */
  | { kind: 'unchanged' }
  /** Cut only these paths — empty when the root reaches no material at all. */
  | { kind: 'restricted'; paths: ClipperPath[] }

/**
 * Restrict one floor root to the material it has to cut.
 *
 * `reach` is how far the pass removes material from its own centreline: the
 * tool radius for contour rings, half the channel for a trochoidal floor.
 *
 * The guard is what keeps this from ever cutting less material than the full
 * pass. The root's full ring set reaches `root ⊕ reach` and the restricted set
 * reaches `restricted ⊕ reach`; material in the first and not the second is
 * ground hugging a wall closer than the root's first ring — a ledge narrower
 * than a tool radius plus a stepover — which the full pass skims from a ring
 * standing over the void beside it. That root keeps its full pass.
 */
export function restrictFloorRoot(
  rootPaths: ClipperPath[],
  coverage: ClipperPath[],
  reach: number,
): FloorRootRestriction {
  const noise = residualNoiseUnits(reach)
  const arcTolerance = noise / 4
  const reachUnits = reach * DEFAULT_CLIPPER_SCALE
  const reachable = intersectClipperPaths(coverage, roundOffset(rootPaths, reachUnits, arcTolerance))
  if (reachable.length === 0) return { kind: 'restricted', paths: [] }
  const restricted = intersectClipperPaths(rootPaths, coverage)
  const missed = restricted.length === 0
    ? reachable
    : differenceClipperPaths(reachable, roundOffset(restricted, reachUnits, arcTolerance))
  return roundOffset(missed, -noise, arcTolerance).length > 0
    ? { kind: 'unchanged' }
    : { kind: 'restricted', paths: restricted }
}

/**
 * Where a raster centreline can still touch material: coverage grown by the
 * reach, plus the arc tolerance that growth is drawn to so no chord pulls a span
 * end short of the true boundary. A disc centred outside it removes nothing, so
 * clipping spans to it costs no coverage at all.
 */
export function coverageReachLoops(coverage: ClipperPath[], reach: number): Point[][] {
  const arcTolerance = residualNoiseUnits(reach) / 4
  return roundOffset(coverage, reach * DEFAULT_CLIPPER_SCALE + arcTolerance, arcTolerance)
    .filter((path) => path.length >= 3)
    .map((path) => fromClipperPath(path, DEFAULT_CLIPPER_SCALE))
}
