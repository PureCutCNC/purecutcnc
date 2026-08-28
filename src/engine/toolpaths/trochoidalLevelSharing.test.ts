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
 * Sharing the Z-invariant orbit path across levels (issue #661).
 *
 * Four things have to hold, and they are the four tests below.
 *
 * 1. The emitted program does not move — including *when it refuses*. This is a
 *    representation change: the machine still cuts every level, so the move
 *    count is unchanged by design and the G-code must be byte-identical.
 *    Asserted by running the same input twice — once with the real store, once
 *    with one that never reuses — rather than against a checked-in golden, so it
 *    keeps meaning something after #662 moves the point ceiling.
 * 2. Generation happens once per distinct path, not once per level. Call count,
 *    never timing: AGENTS.md § Performance assertions, and #383/#386/#508.
 * 3. A tab activating partway down splits the signature. Levels either side of
 *    its `z_top` fragment differently and must not share.
 * 4. The verification backstop still runs per level on a shared path. A path
 *    reused from a shallower level is not a path already proven safe deeper.
 *
 * `appendTrochoidalContoursAtLevels` is driven directly because (4) has no
 * fixture: the real `isSegmentSafe` is derived from wall and obstacle geometry,
 * and anything that makes it fail at one level and pass at its neighbours also
 * changes the fragmentation, which is the case this test is not about.
 *
 * ## What each mutation kills
 *
 * Verified by breaking the code on purpose, not by a green run. Two of these
 * caught tests that were passing for the wrong reason and were rewritten.
 *
 * | Mutation | Killed by |
 * | --- | --- |
 * | key ignores guide coordinates | `congruent spans in different places` (here), 3 in `trochoidalLevelPaths.test.ts`, and the two-guide carve in `carving.test.ts` |
 * | key ignores the `closed` flag | 2 in `trochoidalLevelPaths.test.ts` |
 * | key ignores a build parameter | `every build parameter splits the signature` |
 * | backstop skipped on a cache hit | `a shared path still fails closed…` |
 * | emission mutates the shared points array | `byte-identical G-code` and the tab test |
 * | emission charged once instead of per level | `sharing does not move the point at which an operation refuses` |
 * | generator budget check skipped on a cache hit | same |
 *
 * The last two are there because the first version of this change shipped
 * without them and CI caught it: charging generation only turned a real
 * fixture's honest budget refusal into 9,873,183 moves and ~2 GB of heap.
 *
 * One limit worth naming rather than leaving to be discovered: the
 * shared-vs-unshared comparison is differential, so it catches divergence
 * *caused by sharing* and not emission bugs that would affect both runs alike —
 * the branch-against-`main` byte comparison on the real 15-level fixture covers
 * that, and lives in the PR, not here.
 *
 * Run with: npx tsx src/engine/toolpaths/trochoidalLevelSharing.test.ts
 */

import { defaultTool, newProject } from '../../types/project'
import type { Operation, Point, Project, Tab, Tool } from '../../types/project'
import { BUNDLED_DEFINITIONS } from '../gcode/definitions'
import { runPostProcessor } from '../gcode/postprocessor'
import {
  appendTrochoidalContoursAtLevels,
  createTrochoidalFragmentPlanner,
  type TrochoidalGuideFragment,
} from './edge'
import { normalizeToolForProject } from './geometry'
import type { TrochoidalContourResult } from './trochoidalEdge'
import { expandedTabFootprints } from './tabs'
import {
  createTrochoidalPathStore,
  trochoidalGuideSignature,
  type TrochoidalPathParams,
  type TrochoidalPathLookup,
  type TrochoidalPathStore,
} from './trochoidalLevelPaths'
import type { TrochoidalOperationBudget } from './trochoidalPath'
import type { ToolpathMove, ToolpathPoint } from './types'
import type { ToolpathWarning } from './warningCodes'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// ── Fixture ──────────────────────────────────────────────────────────

const TOOL_DIAMETER = 6
const CUT_WIDTH = 9
const ORBIT_RADIUS = (CUT_WIDTH - TOOL_DIAMETER) / 2
const ADVANCE_RATIO = 0.5
const TOP_Z = 0
const SAFE_Z = 5
const STEPDOWN = 1

/** Already a tool-centre path, as the generator expects its guide to be. */
const GUIDE: Point[] = [
  { x: 0, y: 0 },
  { x: 40, y: 0 },
  { x: 40, y: 30 },
  { x: 0, y: 30 },
]

const LEVELS = Array.from({ length: 15 }, (_, index) => TOP_Z - STEPDOWN * (index + 1))

const PATH_PARAMS: TrochoidalPathParams = {
  orbitRadius: ORBIT_RADIUS,
  advance: ADVANCE_RATIO * TOOL_DIAMETER,
  toolDiameter: TOOL_DIAMETER,
  angularDirection: 1,
}

/** Matches `trochoidalTabGuideClearance` in `edge.ts` for this tool and width. */
const TAB_GUIDE_CLEARANCE = CUT_WIDTH / 2 + TOOL_DIAMETER * 0.01 * 2

function operation(): Operation {
  return {
    id: 'op1',
    name: 'Edge',
    kind: 'edge_route_outside',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['f1'] },
    toolRef: 't1',
    stepdown: STEPDOWN,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    roundOutsideCorners: false,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    edgeStrategy: 'trochoidal',
    trochoidalCutWidth: CUT_WIDTH,
    trochoidalAdvance: ADVANCE_RATIO,
    entryStrategy: 'helix',
    entryRampAngle: 5,
    arcFittingEnabled: true,
  }
}

function tool(): Tool {
  return { ...defaultTool('mm', 1), id: 't1', name: 'em6', diameter: TOOL_DIAMETER }
}

function project(): Project {
  const base = newProject('trochoidal level sharing', 'mm')
  return { ...base, stock: { ...base.stock, thickness: 20 }, tools: [tool()] }
}

/**
 * The seam. `TrochoidalPathStore` is an interface precisely so a test can
 * supply this: it is the pre-#661 behaviour, one generated path per level, and
 * comparing the two runs is what "byte-identical before and after" means here.
 */
class NeverReusingPathStore implements TrochoidalPathStore {
  private generated = 0

  get generatedCount(): number {
    return this.generated
  }

  resolve(
    _points: Point[],
    _closed: boolean,
    _params: TrochoidalPathParams,
    generate: () => TrochoidalContourResult,
  ): TrochoidalPathLookup {
    this.generated += 1
    return { built: generate(), generated: true }
  }
}

interface RunResult {
  moves: ToolpathMove[]
  warnings: ToolpathWarning[]
  generatedCount: number
  finalPosition: ToolpathPoint | null
}

function run(options: {
  store: TrochoidalPathStore
  levels?: number[]
  tabs?: Tab[]
  isSegmentSafe?: (from: Point, to: Point, z: number) => boolean
  budget?: number
}): RunResult {
  const op = operation()
  const moves: ToolpathMove[] = []
  const warnings: ToolpathWarning[] = []
  const ceiling = options.budget ?? 500_000
  const budget: TrochoidalOperationBudget = {
    remainingPoints: ceiling,
    remainingMoves: ceiling,
    paths: options.store,
  }
  const tabs = options.tabs ?? []
  const planner = tabs.length > 0
    ? createTrochoidalFragmentPlanner(tabs, [], TAB_GUIDE_CLEARANCE, TOOL_DIAMETER, op, warnings)
    : null
  const finalPosition = appendTrochoidalContoursAtLevels(
    moves,
    null,
    [GUIDE],
    options.levels ?? LEVELS,
    TOP_Z,
    SAFE_Z,
    op,
    TOOL_DIAMETER,
    1,
    warnings,
    options.isSegmentSafe ?? (() => true),
    budget,
    planner,
  )
  return { moves, warnings, generatedCount: options.store.generatedCount, finalPosition }
}

function exportGcode(moves: ToolpathMove[]): string {
  const proj = project()
  return runPostProcessor({
    project: proj,
    definition: BUNDLED_DEFINITIONS.find((entry) => entry.id === 'grbl')!,
    operations: [{
      operation: operation(),
      toolpath: { operationId: 'op1', moves, warnings: [], bounds: null },
      tool: normalizeToolForProject(tool(), proj),
    }],
    options: { emitToolChanges: false, emitCoolant: false, programName: 'level-sharing' },
  }).gcode
}

/** Every cut move's XY at one Z, as a comparable string. */
function cutGeometryAtZ(moves: ToolpathMove[], z: number): string {
  return moves
    .filter((move) => move.kind === 'cut' && Math.abs(move.to.z - z) <= 1e-9)
    .map((move) => `${move.from.x},${move.from.y}->${move.to.x},${move.to.y}`)
    .join(';')
}

// ── 1. The emitted program does not move ─────────────────────────────

test('sharing emits byte-identical G-code', () => {
  const shared = run({ store: createTrochoidalPathStore() })
  const unshared = run({ store: new NeverReusingPathStore() })

  assert(shared.warnings.length === 0, `shared run warned: ${shared.warnings.map((w) => w.code).join(', ')}`)
  assert(unshared.warnings.length === 0, `unshared run warned: ${unshared.warnings.map((w) => w.code).join(', ')}`)
  assert(shared.moves.length > 10_000, `fixture must be dense enough to matter, got ${shared.moves.length} moves`)

  assert(
    shared.moves.length === unshared.moves.length,
    `move count changed: ${unshared.moves.length} -> ${shared.moves.length}`,
  )
  assert(
    JSON.stringify(shared.moves) === JSON.stringify(unshared.moves),
    'the emitted move stream must be identical with and without sharing',
  )
  assert(
    exportGcode(shared.moves) === exportGcode(unshared.moves),
    'the exported G-code must be byte-identical with and without sharing',
  )
})

// ── 2. Generation happens once per distinct path ─────────────────────

test('a deep cut with no tabs generates one path for every level', () => {
  const shared = run({ store: createTrochoidalPathStore() })
  const unshared = run({ store: new NeverReusingPathStore() })

  assert(
    shared.generatedCount === 1,
    `expected 1 generated path across ${LEVELS.length} levels, got ${shared.generatedCount}`,
  )
  assert(
    unshared.generatedCount === LEVELS.length,
    `expected the unshared run to generate per level, got ${unshared.generatedCount}`,
  )
  // The machine still cuts every level. #661 removes duplicate generation, not
  // duplicate motion — an unchanged move count here is the criterion holding.
  assert(
    cutGeometryAtZ(shared.moves, LEVELS[0]).length > 0
      && cutGeometryAtZ(shared.moves, LEVELS.at(-1)!).length > 0,
    'every level must still be cut',
  )
  assert(
    cutGeometryAtZ(shared.moves, LEVELS[0]) === cutGeometryAtZ(shared.moves, LEVELS.at(-1)!),
    'a Z-invariant guide must emit the same XY at the first and last level',
  )
})

// ── 3. A tab activating partway down splits the signature ────────────

/** Replays the planner's own `previousZ` threading to collect every fragment. */
function plannedFragments(tabs: Tab[], levels: number[]): TrochoidalGuideFragment[] {
  const warnings: ToolpathWarning[] = []
  const planner = createTrochoidalFragmentPlanner(
    tabs, [], TAB_GUIDE_CLEARANCE, TOOL_DIAMETER, operation(), warnings,
  )
  const collected: TrochoidalGuideFragment[] = []
  let previousZ = TOP_Z
  for (const z of levels) {
    const planned = planner(GUIDE, z, previousZ, ORBIT_RADIUS)
    assert(planned !== null, `planner refused at z=${z}: ${warnings.map((w) => w.code).join(', ')}`)
    collected.push(...planned)
    previousZ = z
  }
  return collected
}

test('a tab activating partway down does not share a signature across its z_top', () => {
  const tabTop = -2
  const tabs: Tab[] = [{
    id: 'tab1', name: 'Tab', x: 20, y: 0, w: 8, h: 8, z_top: tabTop, z_bottom: -20, visible: true,
  }]
  const levels = [-1, -2, -3, -4, -5]
  assert(
    expandedTabFootprints(tabs, TAB_GUIDE_CLEARANCE).length > 0,
    'the fixture tab must produce a footprint that can interrupt the guide',
  )

  const above = plannedFragments(tabs, [-1])
  const below = plannedFragments(tabs, levels).filter((fragment) => fragment.z < tabTop - 1e-9)
  assert(above.length === 1 && above[0].closed, 'above z_top the guide must still be one closed loop')
  assert(below.length > 0, 'below z_top the tab must interrupt the guide')

  const aboveKeys = new Set(above.map((f) => trochoidalGuideSignature(f.points, f.closed, PATH_PARAMS)))
  const belowKeys = new Set(below.map((f) => trochoidalGuideSignature(f.points, f.closed, PATH_PARAMS)))
  for (const key of belowKeys) {
    assert(!aboveKeys.has(key), 'a fragment below z_top must not share a signature with one above it')
  }

  // And the store must actually split on that: distinct signatures generate,
  // repeats reuse. Comparing against the planner's own output means the numbers
  // are derived, not pinned.
  const fragments = plannedFragments(tabs, levels)
  const keys = fragments.map((f) => trochoidalGuideSignature(f.points, f.closed, PATH_PARAMS))
  const shared = run({ store: createTrochoidalPathStore(), levels, tabs })
  const unshared = run({ store: new NeverReusingPathStore(), levels, tabs })
  assert(shared.warnings.length === 0, `tab run warned: ${shared.warnings.map((w) => w.code).join(', ')}`)
  assert(
    new Set(keys).size > 1,
    'the tab fixture must produce more than one distinct guide, or it proves nothing',
  )
  assert(
    shared.generatedCount === new Set(keys).size,
    `expected ${new Set(keys).size} generated paths, got ${shared.generatedCount}`,
  )
  assert(
    unshared.generatedCount === keys.length,
    `expected ${keys.length} unshared generations, got ${unshared.generatedCount}`,
  )
  assert(
    JSON.stringify(shared.moves) === JSON.stringify(unshared.moves),
    'tabbed output must also be identical with and without sharing',
  )
  // The integration-visible half: levels either side of z_top cut different XY.
  assert(
    cutGeometryAtZ(shared.moves, -1) !== cutGeometryAtZ(shared.moves, -3),
    'the level below z_top must not cut the path from above it',
  )
})

/**
 * The case the tab test above does *not* catch, found by mutating the key.
 *
 * Two tabs placed symmetrically leave two spans that are congruent: same point
 * count, same open flag, different coordinates. A key built from anything less
 * than the geometry — a shape summary, a fragment count, an "it looks the same"
 * heuristic — collapses them, and the emitted program then cuts one span twice
 * and the other never. That is the gouge, not a slow path, so the collision has
 * to be impossible rather than unlikely.
 */
test('congruent spans in different places never share a path', () => {
  const tabs: Tab[] = [
    { id: 'a', name: 'A', x: 20, y: 0, w: 8, h: 8, z_top: -2, z_bottom: -20, visible: true },
    { id: 'b', name: 'B', x: 20, y: 30, w: 8, h: 8, z_top: -2, z_bottom: -20, visible: true },
  ]
  const levels = [-1, -3]
  const spans = plannedFragments(tabs, levels).filter((fragment) => !fragment.closed && fragment.z === -3)
  assert(spans.length === 2, `expected two open spans below z_top, got ${spans.length}`)
  assert(
    spans[0].points.length === spans[1].points.length,
    `the fixture must produce congruent spans to be worth anything, got ${spans[0].points.length} vs ${spans[1].points.length}`,
  )
  assert(
    trochoidalGuideSignature(spans[0].points, false, PATH_PARAMS)
      !== trochoidalGuideSignature(spans[1].points, false, PATH_PARAMS),
    'two spans of the same shape in different places must not share a signature',
  )

  const shared = run({ store: createTrochoidalPathStore(), levels, tabs })
  const unshared = run({ store: new NeverReusingPathStore(), levels, tabs })
  assert(shared.warnings.length === 0, `two-tab run warned: ${shared.warnings.map((w) => w.code).join(', ')}`)
  assert(
    JSON.stringify(shared.moves) === JSON.stringify(unshared.moves),
    'congruent spans must each be cut where they are',
  )
})

/**
 * The regression this file exists to prevent, and the one that got through:
 * sharing the *generated* path must not stop the *emitted* moves being charged.
 *
 * It reached CI. Charging generation only, an operation that refused with
 * `edgeTrochoidalMoveBudget` on a real fixture instead ran to completion at
 * 9,873,183 moves and ~2 GB of heap — in the browser, a dead tab rather than a
 * warning. The machine cuts every level whether or not one array of points was
 * reused to describe them, so emission is charged per level and the depth at
 * which an operation refuses is exactly where it was before #661.
 */
test('sharing does not move the point at which an operation refuses', () => {
  // Sized to refuse partway down rather than at the first level, so the test
  // distinguishes "refuses in the same place" from "refuses at all".
  const perLevel = run({ store: createTrochoidalPathStore(), levels: [-1] })
  assert(perLevel.moves.length > 0, 'the calibration run must emit')
  const ceiling = Math.floor(perLevel.moves.length * 3.5)

  const shared = run({ store: createTrochoidalPathStore(), budget: ceiling })
  const unshared = run({ store: new NeverReusingPathStore(), budget: ceiling })

  assert(
    shared.warnings.some((warning) => warning.code === 'edgeTrochoidalMoveBudget'),
    `expected the shared run to refuse, got: ${shared.warnings.map((w) => w.code).join(', ') || 'none'}`,
  )
  assert(
    JSON.stringify(shared.warnings) === JSON.stringify(unshared.warnings),
    `sharing must not change which warning is raised, or where: ${JSON.stringify(shared.warnings)} vs ${JSON.stringify(unshared.warnings)}`,
  )
  assert(
    JSON.stringify(shared.moves) === JSON.stringify(unshared.moves),
    'sharing must not change what a refusing operation emits',
  )
  // And the generation account really is the cheaper one — otherwise this test
  // would pass with the sharing removed entirely.
  assert(
    shared.generatedCount < unshared.generatedCount,
    `sharing must still be in effect: ${shared.generatedCount} vs ${unshared.generatedCount}`,
  )
})

// ── 4. The backstop still runs per level on a shared path ────────────

test('a shared path still fails closed at the one level where it is unsafe', () => {
  const unsafeLevel = LEVELS[4]
  const store = createTrochoidalPathStore()
  // Unsafe only on the far side of the guide, and only at one level. The entry
  // helix orbits the guide's start point within `orbitRadius`, so it never
  // reaches x > 30 — only the generated contour does. Without that restriction
  // the entry-point check, which is per level either way, raises the same
  // warning and the test passes whether or not the backstop ran on the shared
  // path. It did, before this was narrowed.
  const result = run({
    store,
    isSegmentSafe: (from, _to, z) => Math.abs(z - unsafeLevel) > 1e-9 || from.x <= 30,
  })

  assert(
    result.warnings.some((warning) => warning.code === 'edgeTrochoidalSafetyCheck'),
    `expected edgeTrochoidalSafetyCheck, got: ${result.warnings.map((w) => w.code).join(', ') || 'none'}`,
  )
  assert(result.moves.length === 0, 'failing closed must leave no partial cut')
  // The point of the test: the path that tripped at level 5 was generated at
  // level 1 and reused. Sharing the check instead of the path would have let it
  // through on the shallower level's verdict.
  assert(
    store.generatedCount === 1,
    `the unsafe level must have been running on a shared path, got ${store.generatedCount} generations`,
  )
})

test('the same fixture passes when nothing is unsafe', () => {
  const result = run({ store: createTrochoidalPathStore() })
  assert(
    !result.warnings.some((warning) => warning.code === 'edgeTrochoidalSafetyCheck'),
    'the control run must not trip the backstop',
  )
  assert(result.moves.length > 0, 'the control run must emit motion')
})

console.log(`\ntrochoidalLevelSharing: ${passed} passed, ${failed} failed`)
if (failed > 0) throw new Error(`${failed} test(s) failed`)
