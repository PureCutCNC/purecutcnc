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
 * The shared pocket fixture pack for the hybrid-adaptive tier comparison
 * (issue #497, tier 2a — issue #499 corner unwinding). Slice S1: the fixtures
 * and their measurement contract, nothing else.
 *
 * Every builder returns a `Project` with exactly one `pocket` operation in
 * `pocketPattern: 'offset'` mode. The pack is parametric in tool diameter and
 * stepover: every size constant below is expressed in tool diameters `d`
 * (and, where a slot width matters, the stepover distance `s = d · stepover`),
 * so a span measured in tool diameters can be re-measured at any tool size to
 * check tool-independence. The builders are TypeScript, not `.camj` blobs,
 * and are fully deterministic: no `Math.random`, no `Date.now`, stable
 * iteration order, and a pinned creation timestamp.
 *
 * Each fixture isolates one failure mode, per the #499 amended plan:
 *
 * | Fixture      | Isolates |
 * | ------------ | -------- |
 * | rectangular  | Baseline — the 90° corner already measured in #498 |
 * | acuteCorner  | Worst-case corner engagement (untested anywhere before) |
 * | curvedCorner | Where a turn-angle qualifier must not fire (tessellated arcs) |
 * | longNeck     | #500's territory; here to keep it out of #499's numbers |
 * | islandPinch  | As above, plus the case the boundary geometry gives no hint about |
 * | multiSection | Per-section innermost loops; level-ordering effects |
 * | tinyPocket   | Degenerate — smaller than an unwind excursion would need |
 * | largeComplex | Cost and determinism at scale |
 *
 * Measurement conventions shared by every fixture (reasons documented once,
 * here, because they are the same for every builder):
 *
 * - `machiningOrder: 'level_first'` and `cutDirection: 'conventional'` —
 *   the conditions under which #498's anchor figures (straight run
 *   1.3695 rad, corner 2.9404 rad on a 60 mm square at r = 3, stepover 2.4)
 *   were measured in the generator's real `inner-first` ring order.
 * - `finishWalls: false`, `finishFloor: false` — the pack measures rough
 *   clearing ring engagement. A finish pass would recut the wall-adjacent
 *   ring at the bottom level and muddy ring attribution for no new signal.
 * - `stockToLeaveRadial: 0`, `stockToLeaveAxial: 0` — the anchor figures
 *   were measured without stock-to-leave.
 * - `pocketSlotFeedPercent: 40` — the #498 probe standard. The spike spans
 *   themselves are independent of the slot anchor (they classify engagement
 *   against the nominal wrap angle), but the emitted feed ladder and the
 *   cost/shape figures need a real anchor, and 40 is the one #498 used.
 * - One level per fixture (`stepdown === depth`) except `multiSection`,
 *   which cuts two levels to exercise level-ordering effects on a
 *   Z-invariant ring tree.
 */

import {
  circleProfile,
  defaultStock,
  defaultTool,
  newProject,
  polygonProfile,
  rectProfile,
  slotProfile,
  type FeatureKind,
  type Operation,
  type Point,
  type Project,
  type SketchFeature,
  type Tool,
} from '../types/project'
import { projectWithFeatures } from './projectFixtures'

/** Fixed creation/modification timestamp so a rebuilt fixture is byte-identical. */
const PACK_TIMESTAMP = '2026-08-16T00:00:00.000Z'

/** Fixed tool id referenced by every pack operation. */
const TOOL_ID = 'pack-tool'

/** Fixed operation id; there is exactly one pocket operation per fixture. */
const OPERATION_ID = 'pack-pocket'

export interface PocketFixtureOptions {
  /** Tool diameter in project units. Every size constant below is expressed in this. */
  toolDiameter: number
  /** Pocket stepover as a ratio of tool diameter — the `Operation.stepover` field. */
  stepover: number
  /** Slot-feed anchor in percent. Default 40, the #498 probe standard. */
  slotFeedPercent?: number
  /** Pocket depth in project units. Default 2 (one level). */
  depth?: number
  /** Stepdown in project units. Default `depth` (one level). */
  stepdown?: number
}

/** Options with every default resolved, plus the derived stepover distance. */
interface ResolvedPackOptions {
  d: number
  /** Stepover distance in project units: `toolDiameter · stepover`. */
  s: number
  slotFeedPercent: number
  depth: number
  stepdown: number
}

function resolveOptions(options: PocketFixtureOptions): ResolvedPackOptions {
  if (!(Number.isFinite(options.toolDiameter) && options.toolDiameter > 0)) {
    throw new RangeError(`pocketFixturePack: toolDiameter must be positive and finite, got ${options.toolDiameter}`)
  }
  if (!(Number.isFinite(options.stepover) && options.stepover > 0 && options.stepover <= 1)) {
    throw new RangeError(`pocketFixturePack: stepover must be in (0, 1], got ${options.stepover}`)
  }
  const depth = options.depth ?? 2
  const stepdown = options.stepdown ?? depth
  return {
    d: options.toolDiameter,
    s: options.toolDiameter * options.stepover,
    slotFeedPercent: options.slotFeedPercent ?? 40,
    depth,
    stepdown,
  }
}

function packTool(diameter: number, stepover: number): Tool {
  return {
    ...defaultTool('mm', 1),
    id: TOOL_ID,
    name: `${diameter} mm pack endmill`,
    diameter,
    defaultStepdown: 2,
    defaultStepover: stepover,
  }
}

function sketchFeature(
  id: string,
  kind: FeatureKind,
  profile: SketchFeature['sketch']['profile'],
  featureOperation: 'subtract' | 'add',
  depth: number,
): SketchFeature {
  return {
    id,
    name: id,
    kind,
    folderId: null,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: featureOperation,
    z_top: depth,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function packOperation(featureIds: string[], o: ResolvedPackOptions): Operation {
  return {
    id: OPERATION_ID,
    name: 'pocket',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: TOOL_ID,
    stepdown: o.stepdown,
    stepover: o.s / o.d,
    feed: 800,
    plungeFeed: 300,
    rpm: 18_000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    pocketSlotFeedPercent: o.slotFeedPercent,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: o.depth,
    maxCarveDepth: o.depth,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
}

/** A finished fixture: the authoritative project plus its cleared-region boundary. */
interface BuiltFixture {
  project: Project
  /**
   * Distance from (x, y) to the cleared region's boundary, including island
   * boundaries. Unsigned: the measurement only ever classifies toolpath
   * points, which lie inside the cleared region. The pack's measurement uses
   * this to tell the wall-adjacent ring (centreline at `toolRadius` from the
   * boundary — the ring whose outboard flank the estimator, without region
   * knowledge, deliberately counts as retained stock) from interior rings
   * (at `toolRadius + k · s`), so the #498 ring-0 caveat can be honoured.
   */
  boundaryDistance: (x: number, y: number) => number
}

function buildProject(
  name: string,
  o: ResolvedPackOptions,
  features: SketchFeature[],
  bounds: { minX: number; minY: number; maxX: number; maxY: number },
): Project {
  const project = projectWithFeatures(
    {
      ...newProject(name, 'mm'),
      tools: [packTool(o.d, o.s / o.d)],
    },
    features,
  )
  project.meta.created = PACK_TIMESTAMP
  project.meta.modified = PACK_TIMESTAMP
  const margin = 5 * o.d
  project.stock = {
    ...defaultStock(undefined, undefined, undefined, 'mm'),
    profile: rectProfile(
      bounds.minX - margin,
      bounds.minY - margin,
      bounds.maxX - bounds.minX + 2 * margin,
      bounds.maxY - bounds.minY + 2 * margin,
    ),
    thickness: o.depth,
  }
  project.operations = [packOperation(features.map((feature) => feature.id), o)]
  return project
}

// ── Boundary-distance helpers ─────────────────────────────────────────────
//
// Plain analytic geometry, no clipper: the pack owns the fixture constants,
// so it also owns the exact boundary these constants describe. Used by the
// measurement to classify wall-adjacent samples.

function pointSegmentDistance(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const dx = bx - ax
  const dy = by - ay
  const lengthSq = dx * dx + dy * dy
  const t = lengthSq > 0
    ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lengthSq))
    : 0
  return Math.hypot(ax + dx * t - px, ay + dy * t - py)
}

function rectBoundaryDistance(
  cx: number,
  cy: number,
  halfX: number,
  halfY: number,
): (x: number, y: number) => number {
  return (x: number, y: number): number => Math.min(
    halfX - Math.abs(x - cx),
    halfY - Math.abs(y - cy),
  )
}

function polygonBoundaryDistance(vertices: Point[]): (x: number, y: number) => number {
  const edges = vertices.map((vertex, index) => {
    const next = vertices[(index + 1) % vertices.length]
    return { ax: vertex.x, ay: vertex.y, bx: next.x, by: next.y }
  })
  return (x: number, y: number): number => {
    let best = Number.POSITIVE_INFINITY
    for (const edge of edges) {
      best = Math.min(best, pointSegmentDistance(x, y, edge.ax, edge.ay, edge.bx, edge.by))
    }
    return best
  }
}

function capsuleBoundaryDistance(
  p1x: number,
  p1y: number,
  p2x: number,
  p2y: number,
  radius: number,
): (x: number, y: number) => number {
  return (x: number, y: number): number => (
    pointSegmentDistance(x, y, p1x, p1y, p2x, p2y) - radius
  )
}

// ── Fixture builders ──────────────────────────────────────────────────────

/**
 * Baseline rectangular pocket: a square of side `10·d`.
 *
 * Constant: side `10·d` — at `d = 6` this is exactly the 60 mm square of the
 * #498 anchor measurement (r = 3, stepover 2.4, real inner-first ring order:
 * straight run 1.3695 rad, near-corner max 2.9404 rad), so the pack's
 * regression anchor reproduces those figures on the same geometry. `10·d`
 * also yields ~11 interior rings at stepover 0.4 — enough rings for stable
 * per-run statistics — and being expressed in `d` the fixture scales with
 * the tool, which is what makes span-in-diameters tool-independent.
 */
function buildRectangular(options: PocketFixtureOptions): BuiltFixture {
  const o = resolveOptions(options)
  const half = 5 * o.d
  const feature = sketchFeature(
    'rect',
    'rect',
    rectProfile(-half, -half, 2 * half, 2 * half),
    'subtract',
    o.depth,
  )
  return {
    project: buildProject('rectangular', o, [feature], { minX: -half, minY: -half, maxX: half, maxY: half }),
    boundaryDistance: rectBoundaryDistance(0, 0, half, half),
  }
}

/**
 * Acute-corner pocket: an isosceles triangle, base `10·d` horizontal, apex
 * `10·d` below the base midpoint.
 *
 * Constants: base `10·d` and height `10·d` — the apex interior angle is then
 * `2·atan((5d)/(10d)) = 2·atan(1/2) ≈ 53.13°` and each base angle
 * `(180° − 53.13°)/2 ≈ 63.43°`. Every corner is acute, so every offset ring
 * corner is a worst-case engagement site, and the apex is the sharpest one.
 * The 1:2 ratio makes the apex angle a pure function of the shape, not of
 * the tool: scale-invariant. 53° is deliberately not *too* acute — Clipper
 * miter joins stay well-conditioned, so the rings exist and the measurement
 * reflects engagement, not offset artifacts.
 */
function buildAcuteCorner(options: PocketFixtureOptions): BuiltFixture {
  const o = resolveOptions(options)
  const baseHalf = 5 * o.d
  const vertices: Point[] = [
    { x: -baseHalf, y: 5 * o.d },
    { x: baseHalf, y: 5 * o.d },
    { x: 0, y: -5 * o.d },
  ]
  const feature = sketchFeature(
    'triangle',
    'polygon',
    polygonProfile(vertices),
    'subtract',
    o.depth,
  )
  return {
    project: buildProject(
      'acute-corner',
      o,
      [feature],
      { minX: -baseHalf, minY: -5 * o.d, maxX: baseHalf, maxY: 5 * o.d },
    ),
    boundaryDistance: polygonBoundaryDistance(vertices),
  }
}

/**
 * Curved-corner pocket: a capsule (straight walls plus two semicircular
 * ends) with spine length `5·d` and width `5·d` (end radius `2.5·d`).
 *
 * Constants: spine `(−2.5d, 0) → (2.5d, 0)`, radius `2.5·d` — the offset
 * rings of the semicircular ends are tessellated arc chains with no corner
 * at all, which is exactly where a turn-angle qualifier must **not** fire.
 * The end radius is large relative to the ring spacing (2.5·d versus
 * s = 0.4·d, so ~6 rings sample each arc region) and the straight walls
 * provide the nominal-engagement reference runs inside the same fixture.
 */
function buildCurvedCorner(options: PocketFixtureOptions): BuiltFixture {
  const o = resolveOptions(options)
  const radius = 2.5 * o.d
  const p1 = { x: -2.5 * o.d, y: 0 }
  const p2 = { x: 2.5 * o.d, y: 0 }
  const feature = sketchFeature(
    'capsule',
    'polygon',
    slotProfile(p1, p2, 2 * radius),
    'subtract',
    o.depth,
  )
  return {
    project: buildProject(
      'curved-corner',
      o,
      [feature],
      { minX: -5 * o.d, minY: -radius, maxX: 5 * o.d, maxY: radius },
    ),
    boundaryDistance: capsuleBoundaryDistance(p1.x, p1.y, p2.x, p2.y, radius),
  }
}

/**
 * Long-neck pocket: two `6·d` square chambers joined by a neck `2·d` wide
 * and `4·d` long, built as one polygon (the union outline).
 *
 * Constants: neck width `2·d` — a full-width slot for a `d` cutter, so no
 * interior ring fits through it and every neck cut is boundary-adjacent
 * full engagement. Neck length `4·d` — several slot passes long, enough to
 * register as a *run* rather than a point. This is #500's territory; the
 * fixture exists so #499's numbers can be quoted excluding it.
 */
function buildLongNeck(options: PocketFixtureOptions): BuiltFixture {
  const o = resolveOptions(options)
  const vertices: Point[] = [
    { x: -8 * o.d, y: -3 * o.d },
    { x: -2 * o.d, y: -3 * o.d },
    { x: -2 * o.d, y: -o.d },
    { x: 2 * o.d, y: -o.d },
    { x: 2 * o.d, y: -3 * o.d },
    { x: 8 * o.d, y: -3 * o.d },
    { x: 8 * o.d, y: 3 * o.d },
    { x: 2 * o.d, y: 3 * o.d },
    { x: 2 * o.d, y: o.d },
    { x: -2 * o.d, y: o.d },
    { x: -2 * o.d, y: 3 * o.d },
    { x: -8 * o.d, y: 3 * o.d },
  ]
  const feature = sketchFeature(
    'dumbbell',
    'polygon',
    polygonProfile(vertices),
    'subtract',
    o.depth,
  )
  return {
    project: buildProject(
      'long-neck',
      o,
      [feature],
      { minX: -8 * o.d, minY: -3 * o.d, maxX: 8 * o.d, maxY: 3 * o.d },
    ),
    boundaryDistance: polygonBoundaryDistance(vertices),
  }
}

/**
 * Island-pinch pocket: a `12·d` square with a circular island of radius
 * `2·d` whose nearest point sits a pinch gap `2·d` from the wall.
 *
 * Constants: island centre `(2d, 0)` with radius `2·d` against the right
 * wall at `x = 6·d` leaves a corridor `6d − (2d + 2d) = 2·d` wide — a slot
 * the boundary geometry gives no hint about, because the outer outline is a
 * plain square. This is the case where only the *ring tree*, not the
 * boundary, knows the cutter will pinch; it is also #500's territory and
 * present so #499's numbers can exclude it. The square's own corners are
 * ordinary 90° corners, so the pinch stands out in the statistics rather
 * than hiding inside corner spikes.
 */
function buildIslandPinch(options: PocketFixtureOptions): BuiltFixture {
  const o = resolveOptions(options)
  const half = 6 * o.d
  const islandRadius = 2 * o.d
  const islandCx = 2 * o.d
  const outer = sketchFeature(
    'outer',
    'rect',
    rectProfile(-half, -half, 2 * half, 2 * half),
    'subtract',
    o.depth,
  )
  const island = sketchFeature(
    'island',
    'circle',
    circleProfile(islandCx, 0, islandRadius),
    'add',
    o.depth,
  )
  const outerDistance = rectBoundaryDistance(0, 0, half, half)
  return {
    project: buildProject(
      'island-pinch',
      o,
      [outer, island],
      { minX: -half, minY: -half, maxX: half, maxY: half },
    ),
    boundaryDistance: (x: number, y: number): number => Math.min(
      outerDistance(x, y),
      Math.abs(Math.hypot(x - islandCx, y) - islandRadius),
    ),
  }
}

/**
 * Multi-section pocket: three disjoint square sections of side `8·d`,
 * `4·d` and `6·d` in one band, cut over two step levels.
 *
 * Constants: section centres `(−10d, 0)`, `(0, 0)`, `(9d, 0)` with half
 * sides `4·d`, `2·d`, `3·d` — disjoint (at least `4·d` apart) so each
 * section resolves its own ring tree, and sized differently so each
 * section's innermost loop has a different perimeter (the shipped slot-feed
 * rule stamps each section's innermost loop). Depth `4`, stepdown `2` —
 * the only two-level fixture in the pack, exercising level-ordering effects
 * on a Z-invariant ring tree without multiplying every fixture's cost.
 */
function buildMultiSection(options: PocketFixtureOptions): BuiltFixture {
  // Depth 4 / stepdown 2 unless the caller set them explicitly: the pack
  // contract's only two-level fixture.
  const o = resolveOptions({
    ...options,
    depth: options.depth ?? 4,
    stepdown: options.stepdown ?? 2,
  })
  const section = (id: string, cx: number, half: number): SketchFeature => sketchFeature(
    id,
    'rect',
    rectProfile(cx - half, -half, 2 * half, 2 * half),
    'subtract',
    o.depth,
  )
  const specs: Array<{ id: string; cx: number; half: number }> = [
    { id: 'section-a', cx: -10 * o.d, half: 4 * o.d },
    { id: 'section-b', cx: 0, half: 2 * o.d },
    { id: 'section-c', cx: 9 * o.d, half: 3 * o.d },
  ]
  const features = specs.map((spec) => section(spec.id, spec.cx, spec.half))
  const distances = specs.map((spec) => rectBoundaryDistance(spec.cx, 0, spec.half, spec.half))
  return {
    project: buildProject(
      'multi-section',
      o,
      features,
      { minX: -14 * o.d, minY: -4 * o.d, maxX: 12 * o.d, maxY: 4 * o.d },
    ),
    // Unsigned distance to the nearest section boundary: the raw rect SDF is
    // negative outside its own section, so the minimum over the raw values
    // would collapse to whichever section the point is farthest from. A
    // sample always belongs to (or sits between) the sections, so |sdf| per
    // section and then the minimum is the distance to the nearest wall.
    boundaryDistance: (x: number, y: number): number => {
      let best = Number.POSITIVE_INFINITY
      for (const distance of distances) best = Math.min(best, Math.abs(distance(x, y)))
      return best
    },
  }
}

/**
 * Tiny pocket: a square of side `2.5·d` — smaller than an unwind excursion
 * would need.
 *
 * Constant: side `2.5·d`. The corner spike decays over roughly two tool
 * diameters of path either side of a corner (#498), so an excursion that
 * unwinds into already-cleared material needs ~2·d of cleared space in
 * every direction from the corner. This pocket is `2.5·d` across — after
 * the `0.5·d` wall inset the whole remaining region is `1.5·d`, about one
 * ring plus its innermost sliver — the degenerate case a qualifier must
 * decline. The fixture must still *generate*: it exists to be measured, not
 * to fail.
 */
function buildTinyPocket(options: PocketFixtureOptions): BuiltFixture {
  const o = resolveOptions(options)
  const half = 1.25 * o.d
  const feature = sketchFeature(
    'tiny',
    'rect',
    rectProfile(-half, -half, 2 * half, 2 * half),
    'subtract',
    o.depth,
  )
  return {
    project: buildProject('tiny-pocket', o, [feature], { minX: -half, minY: -half, maxX: half, maxY: half }),
    boundaryDistance: rectBoundaryDistance(0, 0, half, half),
  }
}

/**
 * Large complex boundary: a 48-vertex star polygon with a deterministic
 * two-harmonic radial profile.
 *
 * Constants: mean radius `15·d` (≈ 180 mm at d = 6, ~36 rings at stepover
 * 0.4) and the profile `r(θ) = 15d·(1 + 0.22·sin 3θ + 0.11·cos(5θ + 0.7))`
 * sampled at `θ_k = 2πk/48`. The two-harmonic formula is deterministic by
 * construction (no randomness, stable iteration order), smooth enough that
 * the polygon never self-intersects, and irregular enough that no ring is
 * congruent to another. This is the cost-and-determinism-at-scale case:
 * the point count, generation cost and measurement replay must all stay
 * bounded, and two regenerations must be byte-identical.
 */
function buildLargeComplex(options: PocketFixtureOptions): BuiltFixture {
  const o = resolveOptions(options)
  const vertexCount = 48
  const meanRadius = 15 * o.d
  const vertices: Point[] = []
  for (let k = 0; k < vertexCount; k += 1) {
    const theta = (2 * Math.PI * k) / vertexCount
    const radius = meanRadius * (1 + 0.22 * Math.sin(3 * theta) + 0.11 * Math.cos(5 * theta + 0.7))
    vertices.push({ x: radius * Math.cos(theta), y: radius * Math.sin(theta) })
  }
  const feature = sketchFeature(
    'star',
    'polygon',
    polygonProfile(vertices),
    'subtract',
    o.depth,
  )
  const maxRadius = meanRadius * (1 + 0.22 + 0.11)
  return {
    project: buildProject(
      'large-complex',
      o,
      [feature],
      { minX: -maxRadius, minY: -maxRadius, maxX: maxRadius, maxY: maxRadius },
    ),
    boundaryDistance: polygonBoundaryDistance(vertices),
  }
}

// ── Public surface ────────────────────────────────────────────────────────

/** Build the baseline rectangular pocket fixture. See the pack module doc. */
export function rectangularPocketFixture(options: PocketFixtureOptions): Project {
  return buildRectangular(options).project
}

/** Build the acute-corner triangle pocket fixture. See the pack module doc. */
export function acuteCornerPocketFixture(options: PocketFixtureOptions): Project {
  return buildAcuteCorner(options).project
}

/** Build the curved-corner capsule pocket fixture. See the pack module doc. */
export function curvedCornerPocketFixture(options: PocketFixtureOptions): Project {
  return buildCurvedCorner(options).project
}

/** Build the long-neck pocket fixture. See the pack module doc. */
export function longNeckPocketFixture(options: PocketFixtureOptions): Project {
  return buildLongNeck(options).project
}

/** Build the island-pinch pocket fixture. See the pack module doc. */
export function islandPinchPocketFixture(options: PocketFixtureOptions): Project {
  return buildIslandPinch(options).project
}

/** Build the multi-section pocket fixture. See the pack module doc. */
export function multiSectionPocketFixture(options: PocketFixtureOptions): Project {
  return buildMultiSection(options).project
}

/** Build the tiny pocket fixture. See the pack module doc. */
export function tinyPocketFixture(options: PocketFixtureOptions): Project {
  return buildTinyPocket(options).project
}

/** Build the large complex-boundary pocket fixture. See the pack module doc. */
export function largeComplexPocketFixture(options: PocketFixtureOptions): Project {
  return buildLargeComplex(options).project
}

/** One pack entry: the built project plus the boundary used by the measurement. */
export interface PocketFixtureEntry {
  id: string
  project: Project
  /** Distance from (x, y) to the cleared region's boundary (see `BuiltFixture`). */
  boundaryDistance: (x: number, y: number) => number
}

/**
 * Build the whole pack at one parameter point, in the contract's fixed
 * order, so every consumer measures the same eight fixtures.
 */
export function buildPocketFixturePack(options: PocketFixtureOptions): PocketFixtureEntry[] {
  const builders: Array<{ id: string; build: (o: PocketFixtureOptions) => BuiltFixture }> = [
    { id: 'rectangular', build: buildRectangular },
    { id: 'acuteCorner', build: buildAcuteCorner },
    { id: 'curvedCorner', build: buildCurvedCorner },
    { id: 'longNeck', build: buildLongNeck },
    { id: 'islandPinch', build: buildIslandPinch },
    { id: 'multiSection', build: buildMultiSection },
    { id: 'tinyPocket', build: buildTinyPocket },
    { id: 'largeComplex', build: buildLargeComplex },
  ]
  return builders.map(({ id, build }) => {
    const built = build(options)
    return { id, project: built.project, boundaryDistance: built.boundaryDistance }
  })
}
