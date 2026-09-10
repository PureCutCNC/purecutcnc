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
 *
 * Run with: npx tsx src/engine/toolpaths/resolverNonTargetSubtract.test.ts
 */

/**
 * Non-target subtract features in the band resolvers (issue #526).
 *
 * A subtract the operation does not target still changes the solid model, so
 * the region an operation clears must fold it in: it eats islands, it can open
 * the region past its target boundary, and it can pull bands below the
 * target's bottom Z. It is clipped to the material silhouette so the operation
 * does not follow it out into waste stock.
 *
 * Geometry is sized for the default 100 x 80 x 20 mm stock. Every fixture
 * shares one shape — a body add, a pocket subtract target inside it, and an
 * island add inside that — so each case differs only in the non-target
 * subtract under test.
 */

import { rectProfile } from '../../types/project'
import type { Operation, Point, Project, SketchFeature } from '../../types/project'
import { newProject } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { resolveInsideEdgeRegions, resolvePocketRegions } from './resolver'
import type { ResolvedPocketResult } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAIL: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-6): boolean {
  return Math.abs(left - right) <= epsilon
}

// ── Fixture helpers ────────────────────────────────────────────────

function feature(
  id: string,
  operation: SketchFeature['operation'],
  x: number,
  y: number,
  w: number,
  h: number,
  zBottom: number,
  zTop = 20,
): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation,
    z_top: zTop,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

/** Body add: x 10..90, y 10..70, full stock height. */
const body = (): SketchFeature => feature('body', 'add', 10, 10, 80, 60, 0)
/** Pocket target: x 20..80, y 20..60, floor at Z 14. */
const pocket = (): SketchFeature => feature('pocket', 'subtract', 20, 20, 60, 40, 14)
/** Island add inside the pocket: x 40..60, y 35..45. */
const island = (width = 20): SketchFeature => feature('island', 'add', 40, 35, width, 10, 0)

function makeProject(features: SketchFeature[]): Project {
  // Explicitly mm: newProject defaults to inch, whose 4 x 3 x 0.75 stock would
  // clip this geometry away wherever the silhouette falls back to the stock.
  return projectWithFeatures(newProject('non-target-subtract', 'mm'), features.map((row) => ({
    ...row,
    definitionId: row.id,
  })))
}

function makeOperation(kind: Operation['kind'], featureIds: string[]): Operation {
  return {
    id: 'op1',
    name: 'op1',
    kind,
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: null,
    stepdown: 2,
    stepover: 0.5,
    feed: 100,
    plungeFeed: 50,
    rpm: 10000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 0,
    maxCarveDepth: 0,
  }
}

function resolvePocket(features: SketchFeature[]): ResolvedPocketResult {
  return resolvePocketRegions(makeProject(features), makeOperation('pocket', ['pocket']))
}

// ── Measurement helpers ────────────────────────────────────────────

function area(points: Point[]): number {
  let total = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    total += current.x * next.y - next.x * current.y
  }
  return Math.abs(total) / 2
}

interface Bounds { minX: number; minY: number; maxX: number; maxY: number }

function bounds(points: Point[]): Bounds {
  return {
    minX: Math.min(...points.map((p) => p.x)),
    minY: Math.min(...points.map((p) => p.y)),
    maxX: Math.max(...points.map((p) => p.x)),
    maxY: Math.max(...points.map((p) => p.y)),
  }
}

function boundsText(value: Bounds): string {
  return `[${value.minX}, ${value.minY} .. ${value.maxX}, ${value.maxY}]`
}

/** Every band and region, rounded, as one comparable string. */
function serialize(result: ResolvedPocketResult): string {
  return result.bands.map((band) => [
    band.topZ,
    band.bottomZ,
    band.targetFeatureIds.join('+'),
    band.islandFeatureIds.join('+'),
    band.regions.map((region) => [
      region.outer.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).join(';'),
      region.islands.map((hole) => hole.map((p) => `${p.x.toFixed(6)},${p.y.toFixed(6)}`).join(';')).join('/'),
    ].join('|')).join('#'),
  ].join(' ')).join('\n')
}

function hasDepthWarning(result: ResolvedPocketResult): boolean {
  return result.warnings.some((warning) => warning.code === 'regionExtendedBySubtractDepth')
}

// ── Tests ──────────────────────────────────────────────────────────

// Control for the whole suite. Issue #526 records that the first probe for
// this bug passed without a control and was meaningless: if island size does
// not move the resolved region at all, every comparison below is vacuous.
{
  console.log('1. Control: island width changes the resolved region...')

  const wide = resolvePocket([body(), pocket(), island(20)])
  const narrow = resolvePocket([body(), pocket(), island(10)])

  assert(wide.bands.length === 1 && narrow.bands.length === 1, 'both controls resolve one band')
  const wideHole = area(wide.bands[0].regions[0].islands[0])
  const narrowHole = area(narrow.bands[0].regions[0].islands[0])
  assert(approx(wideHole, 200), `20 x 10 island should hole 200 mm², got ${wideHole}`)
  assert(approx(narrowHole, 100), `10 x 10 island should hole 100 mm², got ${narrowHole}`)

  console.log(`   ✓ island area reaches the region (${wideHole} vs ${narrowHole} mm²)`)
}

// The bug itself: a subtract eats part of an island, and the pocket must stop
// machining around material that is not there.
{
  console.log('2. A non-target subtract eats an island...')

  const withoutBite = resolvePocket([body(), pocket(), island()])
  // x 45..55, y 30..38, same Z span as the pocket, wholly inside it.
  const bite = feature('bite', 'subtract', 45, 30, 10, 8, 14)
  const withBite = resolvePocket([body(), pocket(), island(), bite])

  assert(withBite.bands.length === 1, `bite at pocket depth adds no band, got ${withBite.bands.length}`)
  const before = area(withoutBite.bands[0].regions[0].islands[0])
  const after = area(withBite.bands[0].regions[0].islands[0])
  // The island is 20 x 10; the bite overlaps it over x 45..55, y 35..38.
  assert(approx(before, 200), `island hole should start at 200 mm², got ${before}`)
  assert(approx(after, 170), `bite should leave 170 mm² of island, got ${after}`)

  console.log(`   ✓ island shrank 200 -> ${after} mm² where the subtract crosses it`)
}

// A subtract that carves an island the resolver already sees must resolve to
// the same region as an island that was never that large — the same shape by
// two routes, which pins the fold rather than the arithmetic above.
{
  console.log('3. Eating an island matches an island that small to begin with...')

  // Bite the right half of the island away, x 50..60 over the island's full height.
  const bite = feature('bite', 'subtract', 50, 35, 10, 10, 14)
  const eaten = resolvePocket([body(), pocket(), island(20), bite])
  const born = resolvePocket([body(), pocket(), island(10)])

  const eatenHole = area(eaten.bands[0].regions[0].islands[0])
  const bornHole = area(born.bands[0].regions[0].islands[0])
  assert(approx(eatenHole, bornHole),
    `eaten island (${eatenHole}) should match a natively half-width island (${bornHole})`)

  console.log(`   ✓ both routes resolve ${eatenHole} mm² of island`)
}

// Depth: a non-target subtract below the target's floor adds its own band.
{
  console.log('4. A deeper non-target subtract adds a band below the target...')

  // x 45..55, y 0..25, floor at Z 10 — four below the pocket's Z 14.
  const channel = feature('channel', 'subtract', 45, 0, 10, 25, 10)
  const result = resolvePocket([body(), pocket(), island(), channel])

  assert(result.bands.length === 2, `expected 2 bands, got ${result.bands.length}`)
  assert(approx(result.bands[0].topZ, 20) && approx(result.bands[0].bottomZ, 14),
    `first band should be 20 -> 14, got ${result.bands[0].topZ} -> ${result.bands[0].bottomZ}`)
  assert(approx(result.bands[1].topZ, 14) && approx(result.bands[1].bottomZ, 10),
    `second band should be 14 -> 10, got ${result.bands[1].topZ} -> ${result.bands[1].bottomZ}`)
  // No target stands in the lower band; it is machining the subtract alone.
  assert(result.bands[1].targetFeatureIds.join(',') === 'channel',
    `lower band should be attributed to the channel, got ${result.bands[1].targetFeatureIds.join(',')}`)

  console.log('   ✓ bands 20 -> 14 and 14 -> 10, the lower one owned by the subtract')
}

// Boundary: the region unions past the target wall, and the silhouette clip
// stops it at the body edge instead of following the subtract into waste stock.
{
  console.log('5. The region unions past the target, clipped to the model silhouette...')

  const channel = feature('channel', 'subtract', 45, 0, 10, 25, 10)
  const result = resolvePocket([body(), pocket(), island(), channel])

  // The pocket wall is at y 20, the body edge at y 10, the subtract reaches y 0.
  const upper = bounds(result.bands[0].regions[0].outer)
  assert(approx(upper.minY, 10),
    `upper band should open to the body edge at y 10, not the target wall (20) or the subtract (0); got ${boundsText(upper)}`)
  assert(approx(upper.minX, 20) && approx(upper.maxX, 80) && approx(upper.maxY, 60),
    `upper band should keep the pocket's other three sides, got ${boundsText(upper)}`)

  const lower = bounds(result.bands[1].regions[0].outer)
  assert(approx(lower.minX, 45) && approx(lower.maxX, 55)
    && approx(lower.minY, 10) && approx(lower.maxY, 25),
    `lower band should be the channel clipped to the body, got ${boundsText(lower)}`)

  console.log(`   ✓ upper ${boundsText(upper)}, lower ${boundsText(lower)}`)
}

// The clip is the model silhouette, not the stock — so with no add feature in
// the project there is no silhouette, and the stock footprint stands in.
{
  console.log('6. With no add feature the stock footprint is the silhouette...')

  const channel = feature('channel', 'subtract', 45, 0, 10, 25, 10)
  const result = resolvePocket([pocket(), channel])

  assert(result.bands.length === 2, `expected 2 bands, got ${result.bands.length}`)
  const lower = bounds(result.bands[1].regions[0].outer)
  assert(approx(lower.minY, 0),
    `without a model to clip against the channel keeps its own extent to y 0, got ${boundsText(lower)}`)

  console.log(`   ✓ unclipped to ${boundsText(lower)} when no add stands in the band`)
}

// Feature order is load-bearing: an add after the subtract fills it back in.
{
  console.log('7. An add after the subtract fills the void back in...')

  const channel = feature('channel', 'subtract', 45, 0, 10, 25, 10)
  // x 40..60, y 0..18 — covers the lower part of the channel, listed after it.
  const plug = feature('plug', 'add', 40, 0, 20, 18, 0)
  const result = resolvePocket([body(), pocket(), island(), channel, plug])

  assert(result.bands.length === 2, `expected 2 bands, got ${result.bands.length}`)
  const lower = bounds(result.bands[1].regions[0].outer)
  assert(approx(lower.minY, 18),
    `the plug should fill the channel below y 18, got ${boundsText(lower)}`)

  console.log(`   ✓ lower band starts at the plug's edge, ${boundsText(lower)}`)
}

// SUPERSEDED by #751 §3: qualification now chains through touching subtracts.
//
// This case asserted the opposite — that a subtract reachable only through
// another non-target subtract does not join the region — and it was a
// deliberate choice, not an oversight. #751 §3 reverses it on the maintainer's
// call: such a subtract is still unowned void the model says is gone, so a
// clearing pass machining around it leaves material that is not there, which is
// this very issue's complaint one hop further out.
//
// The assertion is inverted rather than deleted, so the reversal stays visible
// here instead of looking like coverage that quietly went missing.
// `resolverSubtractChain.test.ts` owns the new behaviour, its limit and its cost.
{
  console.log('8. Qualification chains through another subtract (#751 §3)...')

  const channel = feature('channel', 'subtract', 45, 0, 10, 25, 10)
  // x 30..70, y 0..6 — crosses the channel, never the pocket.
  const distant = feature('distant', 'subtract', 30, 0, 40, 6, 10)
  const withoutDistant = resolvePocket([body(), pocket(), island(), channel])
  const withDistant = resolvePocket([body(), pocket(), island(), channel, distant])

  assert(serialize(withoutDistant) !== serialize(withDistant),
    'a subtract touching another folded subtract must now join the region (#751 §3)')

  console.log('   ✓ chains through')
}

// The guarantee for every existing project: a non-target subtract that misses
// the target union changes nothing at all.
{
  console.log('9. A non-target subtract clear of the target changes nothing...')

  const baseline = resolvePocket([body(), pocket(), island()])
  // x 5..13, y 65..73 — outside the pocket entirely.
  const elsewhere = feature('elsewhere', 'subtract', 5, 65, 8, 8, 4)
  const withElsewhere = resolvePocket([body(), pocket(), island(), elsewhere])

  assert(serialize(baseline) === serialize(withElsewhere),
    'a subtract clear of the target must leave the resolved bands identical')
  assert(withElsewhere.warnings.length === 0,
    `no warning is owed here, got ${JSON.stringify(withElsewhere.warnings)}`)

  console.log('   ✓ bands identical, no warning')
}

// The advisory speaks only for the consequence the target cannot predict.
{
  console.log('10. The depth advisory fires on depth and stays quiet otherwise...')

  const bite = feature('bite', 'subtract', 45, 30, 10, 8, 14)
  const shallow = resolvePocket([body(), pocket(), island(), bite])
  assert(!hasDepthWarning(shallow),
    `eating an island at target depth must not warn, got ${JSON.stringify(shallow.warnings)}`)

  // Same footprint as the bite, but reaching below the pocket floor.
  const deepBite = feature('bite', 'subtract', 45, 30, 10, 8, 9)
  const deep = resolvePocket([body(), pocket(), island(), deepBite])
  const warning = deep.warnings.find((entry) => entry.code === 'regionExtendedBySubtractDepth')
  assert(warning !== undefined,
    `cutting below the target must warn, got ${JSON.stringify(deep.warnings)}`)
  assert(warning!.params?.features === 'bite' && approx(Number(warning!.params?.bottomZ), 9),
    `warning should name the feature and the depth reached, got ${JSON.stringify(warning!.params)}`)

  console.log('   ✓ quiet at target depth, names the feature and Z when it goes deeper')
}

// The inside edge-route resolver carries the identical shape and the identical
// fix (issue #526 lists both).
{
  console.log('11. resolveInsideEdgeRegions folds non-target subtracts too...')

  const channel = feature('channel', 'subtract', 45, 0, 10, 25, 10)
  const project = makeProject([body(), pocket(), island(), channel])
  const result = resolveInsideEdgeRegions(project, makeOperation('edge_route_inside', ['pocket']))

  assert(result.bands.length === 2, `expected 2 bands, got ${result.bands.length}`)
  const upper = bounds(result.bands[0].regions[0].outer)
  assert(approx(upper.minY, 10),
    `inside edge should open to the body edge at y 10, got ${boundsText(upper)}`)
  const lower = bounds(result.bands[1].regions[0].outer)
  assert(approx(lower.minX, 45) && approx(lower.maxX, 55)
    && approx(lower.minY, 10) && approx(lower.maxY, 25),
    `inside edge lower band should be the clipped channel, got ${boundsText(lower)}`)
  assert(hasDepthWarning(result), 'inside edge should raise the depth advisory too')

  console.log(`   ✓ upper ${boundsText(upper)}, lower ${boundsText(lower)}, advisory raised`)
}

console.log('\nAll non-target subtract resolver tests passed.')
