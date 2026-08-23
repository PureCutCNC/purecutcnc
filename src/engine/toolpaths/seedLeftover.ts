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

// Leftover probe for the seeded-to-offset handoff (issue #576).
//
// `seedIslandRadius` extends each seed stack's virtual island out to the stock
// boundary the stack actually reached. That is what deletes the graze rings —
// and it is also what can strand stock: an enlarged island merges with a wall
// or a real island, the ring tree collapses there, and a partial ring that
// would have cleared reachable metal is never emitted.
//
// This module recovers exactly that metal, and nothing else:
//
//   1. CANDIDATES are the contours of the tree built around the PRE-extension
//      island — the shipped behaviour. Every one of them is a legal
//      tool-centre path, which is the whole point: an excursion is a SUBPATH
//      of a path this code already emits today, so "cannot gouge" needs no new
//      geometric argument. Nothing here synthesises a path.
//   2. A candidate vertex is NEEDED when the cutter standing on it would
//      remove stock the emitted stream leaves behind. Everything within one
//      tool radius of a tool-centre-domain point is removable stock by
//      construction (the domain is the pocket already inset by
//      `toolRadius + radialLeave`), so the question is only "is that disc
//      already swept?" — the #546 swept-envelope predicate, per vertex.
//   3. Maximal runs of needed vertices become open excursions, extended by one
//      vertex at each end. That neighbour is by definition NOT needed, so its
//      own centre is inside already-swept material: the excursion starts and
//      ends in metal a previous pass removed and enters with a plain plunge —
//      no helix, no ramp, no entry budget. Only when a whole candidate loop is
//      needed does the excursion have no cleared start, and that one is
//      emitted closed, through the level's ordinary entry policy.
//
// Cost. The probe runs once per REGION (the ring tree is Z-independent, so
// this is too), never per step level, and never at all when no seed stack got
// an extension. A candidate contour the tree already emits is covered by its
// own sweep, so the wall-side rings — the bulk of the tree — pay one disc
// raster per vertex and produce nothing; the disc test only ever short-
// circuits on an UNCOVERED sample, which is the direction that matters,
// because that is the vertex an excursion has to be built around.

import { buildSweptCoverage, type SweptCoverage } from './sweptCoverage'
import type { Point } from '../../types/project'

/**
 * Sampling pitch of the per-vertex disc test, as a fraction of the tool
 * radius.
 *
 * A twelfth — 0.25 mm on a 6 mm cutter — is where the cusps stop. A sixth
 * resolves the ridges the extension opens along a wall (the thinnest measured
 * was 0.8 mm) but not the pinpoint cusps left where an excursion's envelope
 * meets a ring's, and those showed up as ~0.09 mm² of stock spread over a
 * dozen 0.1 mm spots when the whole pocket was rasterised at 0.05 mm.
 * `seedLeftover.test.ts` samples at 0.25 mm, which is what holds this honest.
 */
const DISC_SAMPLE_RATIO = 1 / 12

/**
 * Pitch the candidate contours are resampled to before probing, as a fraction
 * of the tool radius. This is the granularity of an excursion's ends, so it is
 * what decides how much air a recovered sliver is wrapped in.
 */
const PROBE_SPACING_RATIO = 1 / 2

/** One excursion: a cleanup path emitted after the ring tree. */
export interface SeedLeftoverExcursion {
  /** Tool centreline to cut, in the same space as the ring contours. */
  points: Point[]
  /**
   * True when every vertex of the candidate loop was needed, so the excursion
   * has no pre-cleared start to plunge through and must use the level's entry
   * policy. False excursions are open paths that begin in swept material.
   */
  closed: boolean
}

/**
 * True when everything a cutter standing at `centre` would remove is already
 * gone.
 *
 * No region test: the caller only ever passes points taken from a tool-centre
 * contour, and every point within one tool radius of such a point is stock by
 * construction. This is the same licence `sweptRegionIsCovered` takes, for the
 * same reason — and the reason the answer to an unanswerable question here is
 * still "no".
 */
function discIsCovered(
  centre: Point,
  coverage: SweptCoverage,
  toolRadius: number,
  cellSize: number,
): boolean {
  const radiusSquared = toolRadius * toolRadius
  for (let dx = -toolRadius; dx <= toolRadius; dx += cellSize) {
    for (let dy = -toolRadius; dy <= toolRadius; dy += cellSize) {
      if (dx * dx + dy * dy > radiusSquared) continue
      if (!coverage.covers(centre.x + dx, centre.y + dy)) return false
    }
  }
  return true
}

/**
 * Split any segment longer than `maxSpacing` into equal parts.
 *
 * Purely additive: every inserted point lies ON the segment it splits, so the
 * densified contour is the same path and every point of it is still inside the
 * tool-centre domain. What it buys is resolution — a mitered ring vertex can
 * be 5 mm from its neighbour, and a needed/not-needed verdict at that pitch
 * rounds a 6 mm sliver up to a 15 mm excursion.
 */
function densifyContour(contour: readonly Point[], maxSpacing: number): Point[] {
  const points: Point[] = []
  for (let index = 0; index < contour.length; index += 1) {
    const from = contour[index]
    const to = contour[(index + 1) % contour.length]
    points.push(from)
    const parts = Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / maxSpacing)
    for (let part = 1; part < parts; part += 1) {
      const t = part / parts
      points.push({ x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t })
    }
  }
  return points
}

/**
 * Maximal circular runs of `true` in `needed`, each grown by one index at each
 * end so an excursion starts and finishes on a vertex whose disc is covered.
 *
 * `null` means every vertex is needed — there is no covered vertex to start
 * from, so the caller emits the loop closed through the ordinary entry policy
 * instead of plunging into stock nothing has touched.
 */
function neededRuns(needed: readonly boolean[]): { start: number; length: number }[] | null {
  const count = needed.length
  const first = needed.indexOf(false)
  if (first < 0) return null

  const runs: { start: number; length: number }[] = []
  let runStart = -1
  for (let step = 0; step < count; step += 1) {
    const index = (first + step) % count
    if (needed[index]) {
      if (runStart < 0) runStart = step
      continue
    }
    if (runStart >= 0) {
      runs.push({ start: (first + runStart - 1 + count) % count, length: step - runStart + 2 })
      runStart = -1
    }
  }
  // A run still open here wraps past the end of the scan and is closed by
  // `first` itself, which is covered — so it ends where it began.
  if (runStart >= 0) {
    runs.push({ start: (first + runStart - 1 + count) % count, length: count - runStart + 2 })
  }
  return runs
}

/**
 * Plan the excursions that recover whatever the extended islands stranded.
 *
 * `candidates` are the pre-extension tree's contours, already in cut
 * direction; `emitted` is every tool centreline the seed stacks and the real
 * ring tree will cut at a level. An empty `emitted` returns nothing rather
 * than everything: with no ring tree to compare against, "already swept?" is
 * unanswerable, and re-emitting the whole candidate set would double-cut a
 * pocket rather than clean one.
 */
export function planSeedLeftovers(
  candidates: readonly Point[][],
  emitted: readonly Point[][],
  toolRadius: number,
): SeedLeftoverExcursion[] {
  if (!(toolRadius > 0) || candidates.length === 0) return []
  const swept: Point[][] = [...emitted]
  let coverage = buildSweptCoverage(swept, toolRadius)
  if (coverage.segmentCount === 0) return []

  const cellSize = toolRadius * DISC_SAMPLE_RATIO
  const spacing = toolRadius * PROBE_SPACING_RATIO
  const excursions: SeedLeftoverExcursion[] = []
  for (const candidate of candidates) {
    if (candidate.length < 3) continue
    const contour = densifyContour(candidate, spacing)
    const needed = contour.map((point) => !discIsCovered(point, coverage, toolRadius, cellSize))
    const runs = neededRuns(needed)
    const planned: SeedLeftoverExcursion[] = []
    if (runs === null) {
      planned.push({ points: [...contour], closed: true })
    } else {
      for (const run of runs) {
        const points: Point[] = []
        for (let step = 0; step < run.length; step += 1) {
          points.push(contour[(run.start + step) % contour.length])
        }
        if (points.length >= 2) planned.push({ points, closed: false })
      }
    }
    if (planned.length === 0) continue
    excursions.push(...planned)
    // Fold the new excursions into the coverage before the next candidate is
    // judged. Without this the deeper candidates re-answer "uncut?" against a
    // stream that no longer matches what will be cut, and every level of the
    // pre-extension tree emits its own pass over the same ridge — which cost
    // more than the graze rings the extension removed on a coarse stepover.
    swept.push(...planned.map((excursion) => excursion.points))
    coverage = buildSweptCoverage(swept, toolRadius)
  }
  return excursions
}
