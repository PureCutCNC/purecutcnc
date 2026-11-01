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
 * The Clipper integer scale factors.
 *
 * `DEFAULT_CLIPPER_SCALE` is the engine's scale (10,000 counts per project
 * unit). The module lives on its own so a pure analysis can use the internal
 * scale without importing `toolpaths/geometry.ts`: that barrel reaches
 * `utils/units` and then `cannedShapes`, which pulls Three.js into a worker
 * that only needs Clipper. Geometry re-exports the engine scale, so every
 * existing import is unchanged.
 */
export const DEFAULT_CLIPPER_SCALE = 10_000

/**
 * The confirmation scale for the "no effect" coverage analysis (issue #1112
 * slice N): 1,000× the engine scale.
 *
 * The normal scale is too coarse in absolute terms for an inch project: a
 * 0.00004 in strip is 0.4 counts and rounds away, so a 10 in Add and a
 * 9.99996 in Subtract would look equal. The confirmation pass only runs for
 * outlines that may be covered, never for every pair.
 */
export const COVERAGE_CLIPPER_SCALE = DEFAULT_CLIPPER_SCALE * 1000

/**
 * The largest coordinate the coverage confirmation may produce.
 *
 * `Math.round(x * scale)` is only faithful while the double product is spaced
 * by well under one count. At 2^48 the spacing is 1/16 count; above it the
 * product can land on a half count and `Math.round` can move a vertex by a
 * whole count. That is how a 400000000-wide Add and a 399999999.99999994-wide
 * Subtract become identical at the confirmation scale (4e15) even though a
 * strip really survives. A coordinate beyond this range is not confirmed, and
 * the analysis stays silent rather than guessing.
 */
export const COVERAGE_MAX_COORD = 2 ** 48
