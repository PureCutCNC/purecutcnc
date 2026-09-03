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

// One source of truth for pocket-pattern dispatch (issue #609).
//
// Before this table there were two: the CAM panel's `pattern` renderer decided
// which patterns a kind OFFERS, and each generator decided independently which
// ones it IMPLEMENTS, through a chain of ternaries. Nothing tied them together,
// so a pattern could be offered by a kind whose generator had no branch for it.
// That shipped three times — #579 (pocket finish floor) and #583
// (`surface_clean`) fell through to a wrong-but-valid pattern, and
// `finish_surface_cleanup` + `seeded_offset` (#609) fell through to an EMPTY
// floor: no motion, no warning, an operation that looks like it ran.
//
// Here, both sets come from `OPERATION_PATTERN_SUPPORT`:
//
//   - `offered` is what the dropdown renders, in dropdown order.
//   - `effective` is what the generator runs, for EVERY member of
//     `PocketPattern` — offered or merely stored in an old/hand-edited file.
//
// The two exhaustiveness obligations are what stop a fourth instance, and they
// follow the technique already used by `Record<OperationFieldId, () =>
// ReactNode>` (#559) and `Record<keyof Required<Operation>, …>` (#546):
//
//   - `Record<OperationKind, …>` means a new operation kind does not compile
//     until it declares whether it takes a pattern.
//   - `Record<PocketPattern, …>` on each row means a fifth `PocketPattern`
//     member does not compile until every pattern-taking kind classifies it,
//     and `areaCoverage`'s `never` default repeats that at the generators.
//
// `offered` is not derived from `effective`, because the two genuinely differ:
// a pocket resolves a stored `waterline` to its offset rings (the fallback it
// has always taken) without offering waterline, and cleanup leaves a stored
// `waterline` inert. What must never differ is that every OFFERED pattern
// resolves to something that cuts — `pocketPatterns.test.ts` asserts that, and
// the generation matrix in `finishSurfaceCleanup.test.ts` proves it on real
// streams rather than on the table's own word.

import type { OperationKind, PocketPattern } from '../../types/project'
import { CLEARING_CONTROL_SUPPORT } from './clearingControls'

/**
 * The pattern a generator actually runs for a stored `(kind, pattern)` pair.
 *
 * `'none'` is a stored pattern the kind neither offers nor implements. It is
 * unreachable from the UI — the dropdown never offers it and operation kind is
 * read-only — and it cuts nothing, which is exactly what that combination has
 * always done. Resolving it to a working pattern instead would change the
 * emitted program for a saved file, so it stays declared rather than fixed.
 */
export type EffectivePocketPattern = PocketPattern | 'none'

export interface OperationPatternSupport {
  /** Offered in the pattern dropdown, in dropdown order. */
  readonly offered: readonly PocketPattern[]
  /** What the generator runs, for every member of `PocketPattern`. */
  readonly effective: Readonly<Record<PocketPattern, EffectivePocketPattern>>
}

/**
 * The 2.5D clearing set: concentric offset rings, the same rings preceded by a
 * seed-circle stack, or a parallel raster. Shared by `pocket`, `surface_clean`,
 * `rough_surface` (issue #618) and `finish_surface_cleanup`, whose stored
 * `waterline` predates the pattern being 3D-finishing-only and has always
 * resolved to the rings.
 */
const CLEARING_PATTERNS: OperationPatternSupport = {
  offered: ['offset', 'seeded_offset', 'parallel', 'trochoidal'],
  effective: {
    offset: 'offset',
    seeded_offset: 'seeded_offset',
    parallel: 'parallel',
    trochoidal: 'trochoidal',
    waterline: 'offset',
    constant_scallop: 'none',
  },
}

export const OPERATION_PATTERN_SUPPORT: Readonly<Record<OperationKind, OperationPatternSupport | null>> = {
  pocket: CLEARING_PATTERNS,
  surface_clean: CLEARING_PATTERNS,
  // 3D surface finishing is a choice between three strategies, none of which
  // is a 2.5D area clearing pattern; a stored offset resolves to the parallel
  // strategy, which is the branch it has always taken.
  finish_surface: {
    offered: ['parallel', 'waterline', 'constant_scallop'],
    effective: {
      offset: 'parallel',
      seeded_offset: 'parallel',
      parallel: 'parallel',
      trochoidal: 'none',
      waterline: 'waterline',
      constant_scallop: 'constant_scallop',
    },
  },
  // Cleanup clears its floor with the 2.5D set, but its floor builder has no
  // waterline branch and never had one, so a stored waterline stays inert.
  finish_surface_cleanup: {
    offered: ['offset', 'seeded_offset', 'parallel'],
    effective: {
      offset: 'offset',
      seeded_offset: 'seeded_offset',
      parallel: 'parallel',
      trochoidal: 'none',
      waterline: 'none',
      constant_scallop: 'none',
    },
  },
  v_carve: null,
  v_carve_medial: null,
  edge_route_inside: null,
  edge_route_outside: null,
  // Roughing clears area a level at a time (issue #614 measured 0% sloped cuts
  // on both committed fixtures) with the same ResolvedPocketRegion inputs the
  // other clearing kinds raster and seed from, so it takes the 2.5D set. A
  // stored `waterline` maps to the rings: the kind ignored `pocketPattern`
  // entirely before this row existed and hard-coded the rings, so every saved
  // project stays on the toolpath it already cuts.
  rough_surface: CLEARING_PATTERNS,
  follow_line: null,
  drilling: null,
}

/**
 * Whether a `(kind, pattern)` pair actually splices tangential S-links
 * (issues #545/#609/#621), and so whether `roundLinkCorners` means anything.
 *
 * One rule: every clearing kind on every non-parallel pattern. The parallel
 * raster has no rings to move between, so it is excluded for every kind.
 * `CLEARING_CONTROL_SUPPORT` owns the clearing predicate; this function owns
 * the pattern half. One definition, consumed by the CAM panel, the operation
 * booklet, and the generators.
 */
export function usesTangentLinks(kind: OperationKind, pattern: PocketPattern): boolean {
  return CLEARING_CONTROL_SUPPORT[kind].clears && pattern !== 'parallel'
}

/** The patterns `kind` offers, in dropdown order. Empty means no pattern row. */
export function offeredPocketPatterns(kind: OperationKind): readonly PocketPattern[] {
  return OPERATION_PATTERN_SUPPORT[kind]?.offered ?? []
}

/** True when `kind` renders a pattern control at all. */
export function takesPocketPattern(kind: OperationKind): boolean {
  return offeredPocketPatterns(kind).length > 0
}

/**
 * The pattern `kind`'s generator runs for a stored `pattern`.
 *
 * A kind with no pattern row resolves to `'none'`: those generators never ask,
 * and an answer that cuts would be a claim this table has no business making.
 */
export function effectivePocketPattern(
  kind: OperationKind,
  pattern: PocketPattern,
): EffectivePocketPattern {
  return OPERATION_PATTERN_SUPPORT[kind]?.effective[pattern] ?? 'none'
}

/** What a clearing generator builds for an effective pattern. */
export interface AreaCoverage {
  /** Concentric offset rings cover the area. */
  readonly rings: boolean
  /** A seed-circle stack runs ahead of the rings (issue #554). */
  readonly seedCircles: boolean
  /** A parallel raster covers the area. */
  readonly rasterSegments: boolean
  /** Rings are cut as trochoidal orbits rather than direct contours. */
  readonly trochoidal: boolean
}

const NO_COVERAGE: AreaCoverage = { rings: false, seedCircles: false, rasterSegments: false, trochoidal: false }

/**
 * The area-clearing dispatch, exhaustive over `EffectivePocketPattern`.
 *
 * The `never` default is the compile-time obligation the generators carry: a
 * fifth `PocketPattern` member widens this union and stops the file compiling
 * until the new pattern says what it covers. Returning an empty coverage from a
 * `default:` branch instead is exactly the failure #609 reported — an
 * unclassified pattern silently clearing nothing.
 */
export function areaCoverage(pattern: EffectivePocketPattern): AreaCoverage {
  switch (pattern) {
    case 'offset':
      return { rings: true, seedCircles: false, rasterSegments: false, trochoidal: false }
    case 'seeded_offset':
      return { rings: true, seedCircles: true, rasterSegments: false, trochoidal: false }
    case 'parallel':
      return { rings: false, seedCircles: false, rasterSegments: true, trochoidal: false }
    case 'trochoidal':
      return { rings: true, seedCircles: false, rasterSegments: false, trochoidal: true }
    // Waterline is a 3D constant-Z finishing strategy, not area clearing;
    // `finish_surface` dispatches it before it ever reaches this function.
    case 'waterline':
    case 'constant_scallop':
      return NO_COVERAGE
    case 'none':
      return NO_COVERAGE
    default: {
      const unhandled: never = pattern
      throw new Error(`unhandled pocket pattern: ${String(unhandled)}`)
    }
  }
}
