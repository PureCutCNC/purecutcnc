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
 * Run with: npx tsx src/store/copyFeatureOrder.test.ts
 */

/**
 * Copying a multi-feature selection preserves authored source order (#764).
 *
 * Selection order is click order, not authored order: clicking the inner
 * pocket and then marqueeing the group leaves the pocket first, because the
 * marquee appends to the existing selection. The geometry resolver applies
 * adds and subtracts in `project.features` order, so a copy built in click
 * order describes different parent/island relationships than its source — the
 * copied pocket loses its enclosing add and resolves away entirely.
 *
 * The fixture is the shape from `work/multi-feature-plan-test.camj`: an
 * enclosing add, a blind subtract pocket inside it, a retained island inside
 * the pocket, and two through holes. Geometry is sized for the default
 * 100 x 80 x 20 mm stock, and the copy is offset +40 mm in Y so it lands on
 * bare stock where nothing but its own add can hold it up.
 */

import { newProject, rectProfile } from '../types/project'
import type { Operation, Point, Project, SketchFeature } from '../types/project'
import { projectWithFeatures } from '../test/projectFixtures'
import { resolvePocketRegions } from '../engine/toolpaths/resolver'
import type { ResolvedPocketResult } from '../engine/toolpaths/types'
import { useProjectStore } from './projectStore'
import type { ProjectStore } from './types'

// ── Assertion helpers ──────────────────────────────────────────────

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(left: number, right: number, epsilon = 1e-6): boolean {
  return Math.abs(left - right) <= epsilon
}

function area(points: Point[]): number {
  let total = 0
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]
    const next = points[(index + 1) % points.length]
    total += current.x * next.y - next.x * current.y
  }
  return Math.abs(total) / 2
}

// ── Fixture ────────────────────────────────────────────────────────

function feature(
  id: string,
  operation: SketchFeature['operation'],
  x: number,
  y: number,
  w: number,
  h: number,
  zBottom: number,
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
    z_top: 20,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

/** Authored order: the enclosing add first, everything it holds up after it. */
const SOURCE_ORDER = ['body', 'pocket', 'island', 'holeA', 'holeB']

/** Click the inner pocket, then marquee the group: the marquee appends. */
const SELECTION_ORDER = ['pocket', 'body', 'island', 'holeA', 'holeB']

const POCKET_AREA = 25 * 15
const ISLAND_AREA = 8 * 6
const COPY_OFFSET_Y = 40

function sourceProject(): Project {
  const features = [
    feature('body', 'add', 10, 10, 35, 25, 0),
    feature('pocket', 'subtract', 15, 15, 25, 15, 14),
    feature('island', 'add', 22, 19, 8, 6, 0),
    feature('holeA', 'subtract', 11.5, 31, 3, 3, 0),
    feature('holeB', 'subtract', 40.5, 31, 3, 3, 0),
  ]
  return projectWithFeatures(
    newProject('copy-feature-order', 'mm'),
    features.map((row) => ({ ...row, definitionId: row.id })),
  )
}

function resetStore(project: Project): void {
  useProjectStore.setState({
    project,
    selection: {
      selectedFeatureIds: [],
      selectedFeatureId: null,
      selectedTabIds: [],
      selectedClampIds: [],
      selectedNode: null,
      mode: 'feature' as const,
      sketchEditTool: null,
      activeControl: null,
      hoveredFeatureId: null,
    },
    history: { past: [], future: [], transactionStart: null },
    sketchEditSession: null,
    pendingAdd: null,
    pendingMove: null,
    pendingConstraint: null,
    pendingTransform: null,
    pendingOffset: null,
  } as unknown as Partial<ProjectStore>)
}

/** Drive the real copy path: select in click order, grab one, drop it +40 mm in Y. */
function copySelectionUpward(): void {
  const store = useProjectStore.getState()
  store.selectFeatures(SELECTION_ORDER)
  useProjectStore.getState().startCopyFeature('pocket', 'reference')
  useProjectStore.getState().setPendingMoveFrom({ x: 0, y: 0 })
  useProjectStore.getState().completePendingMove({ x: 0, y: COPY_OFFSET_Y })
}

function pocketOperation(featureIds: string[]): Operation {
  return {
    id: 'op1',
    name: 'op1',
    kind: 'pocket',
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

// ── Test runner ────────────────────────────────────────────────────

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`   ✗ ${name}: ${msg}`)
  }
}

// ============================================================================
// 1. Copy order
// ============================================================================

console.log('\nCopying a scrambled selection (#764)')

test('copies land in authored source order, not selection order', () => {
  resetStore(sourceProject())
  copySelectionUpward()

  const { features } = useProjectStore.getState().project
  assert(features.length === 10, `expected 5 sources + 5 copies, got ${features.length}`)
  const copies = features.slice(SOURCE_ORDER.length)
  // Reference copies keep the source definitionId, so it names the source row.
  const copiedFrom = copies.map((row) => row.definitionId)
  assert(
    copiedFrom.join(',') === SOURCE_ORDER.join(','),
    `expected copies in source order ${SOURCE_ORDER.join(',')}, got ${copiedFrom.join(',')}`,
  )
})

test('the feature tree lists the copies in the same order', () => {
  resetStore(sourceProject())
  copySelectionUpward()

  const state = useProjectStore.getState().project
  const byId = new Map(state.features.map((row) => [row.id, row]))
  const treeIds = state.featureTree.flatMap((entry) => (entry.type === 'feature' ? [entry.featureId] : []))
  const copiedFrom = treeIds
    .slice(SOURCE_ORDER.length)
    .map((id) => byId.get(id)?.definitionId ?? '?')
  assert(
    copiedFrom.join(',') === SOURCE_ORDER.join(','),
    `expected tree copies in source order ${SOURCE_ORDER.join(',')}, got ${copiedFrom.join(',')}`,
  )
})

test('the existing rows keep their saved order and identity', () => {
  resetStore(sourceProject())
  copySelectionUpward()

  const existing = useProjectStore.getState().project.features.slice(0, SOURCE_ORDER.length)
  assert(
    existing.map((row) => row.id).join(',') === SOURCE_ORDER.join(','),
    `sources moved: ${existing.map((row) => row.id).join(',')}`,
  )
})

// ============================================================================
// 2. The copy machines like its source
// ============================================================================

console.log('\nThe copied group resolves like the group it came from')

test('both blind pockets resolve, with the island retained in each', () => {
  resetStore(sourceProject())
  copySelectionUpward()

  const project = useProjectStore.getState().project
  const copiedPocket = project.features
    .slice(SOURCE_ORDER.length)
    .find((row) => row.definitionId === 'pocket')
  assert(copiedPocket !== undefined, 'the copy should contain a pocket')

  const result: ResolvedPocketResult = resolvePocketRegions(
    project,
    pocketOperation(['pocket', copiedPocket.id]),
  )

  assert(result.bands.length === 1, `both pockets share one Z band, got ${result.bands.length}`)
  const [band] = result.bands
  assert(approx(band.topZ, 20) && approx(band.bottomZ, 14), `blind pocket band, got ${band.topZ}..${band.bottomZ}`)
  assert(band.regions.length === 2, `expected a region per pocket, got ${band.regions.length}`)

  const regions = [...band.regions].sort((a, b) => area(a.outer) - area(b.outer))
  for (const region of regions) {
    assert(approx(area(region.outer), POCKET_AREA), `pocket region should be ${POCKET_AREA} mm², got ${area(region.outer)}`)
    assert(region.islands.length === 1, `pocket should retain one island, got ${region.islands.length}`)
    assert(approx(area(region.islands[0]), ISLAND_AREA), `island should be ${ISLAND_AREA} mm², got ${area(region.islands[0])}`)
  }

  const sortedByY = [...band.regions].sort(
    (a, b) => Math.min(...a.outer.map((p) => p.y)) - Math.min(...b.outer.map((p) => p.y)),
  )
  const sourceMinY = Math.min(...sortedByY[0].outer.map((p) => p.y))
  const copyMinY = Math.min(...sortedByY[1].outer.map((p) => p.y))
  assert(
    approx(copyMinY - sourceMinY, COPY_OFFSET_Y),
    `the copy should sit ${COPY_OFFSET_Y} mm above its source, got ${copyMinY - sourceMinY}`,
  )
})

// ============================================================================
// Summary
// ============================================================================

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  process.exitCode = 1
}
