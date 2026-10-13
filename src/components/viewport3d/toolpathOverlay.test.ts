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
 * Tests for 3D viewport toolpath overlay helpers.
 *
 * Run with: npx tsx src/components/viewport3d/toolpathOverlay.test.ts
 */

import type { ToolpathMove } from '../../engine/toolpaths/types'
import { roundStock, type RoundStock, type Stock } from '../../types/project'
import type { ToolpathVisibility } from '../toolpathVisibility'
import {
  buildToolpathLinePositionChunks,
  buildToolpathOverlayLayers,
  moveMatchesZFilter,
  movesForToolpathLayer,
  splitMovesIntoLayers,
  stockSpaceMoves,
  stockSpaceToolpath,
  toolpathBoundsOfMoves,
  toolpathLayerBuckets,
  toolpathOverlayOpacity,
  toolpathPointToWorldTuple,
  TOOLPATH_LAYER_Z_EPSILON,
  type ToolpathOverlayLayerKey,
} from './toolpathOverlay'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeMove(index: number): ToolpathMove {
  return {
    kind: 'cut',
    from: { x: index, y: index + 10, z: index + 20 },
    to: { x: index + 0.5, y: index + 10.5, z: index + 20.5 },
  }
}

function assertArrayEquals(actual: number[], expected: number[], message: string): void {
  assert(actual.length === expected.length, `${message}: expected length ${expected.length}, got ${actual.length}`)
  for (let i = 0; i < expected.length; i += 1) {
    assert(Math.abs(actual[i] - expected[i]) <= 1e-9, `${message}: index ${i}, expected ${expected[i]}, got ${actual[i]}`)
  }
}

function testPointMapping(): void {
  console.log('Testing toolpath point maps Z to 3D vertical axis...')
  assertArrayEquals(
    toolpathPointToWorldTuple({ x: 1, y: 2, z: 3 }),
    [1, 3, 2],
    'world tuple',
  )
}

function testChunkedLinePositions(): void {
  console.log('Testing toolpath line positions are chunked and mapped...')
  const moves = [0, 1, 2, 3, 4].map(makeMove)
  const chunks = buildToolpathLinePositionChunks(moves, 2)

  assert(chunks.length === 3, `expected 3 chunks, got ${chunks.length}`)
  assert(chunks[0].segmentCount === 2, `expected first chunk to have 2 segments, got ${chunks[0].segmentCount}`)
  assert(chunks[1].segmentCount === 2, `expected second chunk to have 2 segments, got ${chunks[1].segmentCount}`)
  assert(chunks[2].segmentCount === 1, `expected third chunk to have 1 segment, got ${chunks[2].segmentCount}`)

  assertArrayEquals(
    Array.from(chunks[0].positions.slice(0, 12)),
    [
      0, 20, 10,
      0.5, 20.5, 10.5,
      1, 21, 11,
      1.5, 21.5, 11.5,
    ],
    'first chunk positions',
  )
}

function testEmptyMovesDoNotAllocateChunks(): void {
  console.log('Testing empty toolpath line positions produce no chunks...')
  const chunks = buildToolpathLinePositionChunks([], 2)
  assert(chunks.length === 0, `expected no chunks, got ${chunks.length}`)
}

testPointMapping()
testChunkedLinePositions()
testEmptyMovesDoNotAllocateChunks()

// --- buildToolpathOverlayLayers: layer kind membership and visibility gating ---

function testOverlayLayersKinds(): void {
  console.log('Testing buildToolpathOverlayLayers kind membership...')

  const vis: ToolpathVisibility = { cuts: true, leadIns: true, rapids: true, plunges: true, retractions: true, directions: true }
  const layers = buildToolpathOverlayLayers(vis)
  const byKey = new Map(layers.map((l) => [l.key, l]))

  // cuts layer
  const cutsLayer = byKey.get('cuts')
  assert(!!cutsLayer, 'cuts layer exists')
  assert(cutsLayer!.kinds.length === 1 && cutsLayer!.kinds[0] === 'cut', 'cuts layer kinds === [\'cut\']')
  assert(!cutsLayer!.kinds.includes('lead_in'), 'cuts layer does NOT include lead_in')
  assert(!cutsLayer!.kinds.includes('lead_out'), 'cuts layer does NOT include lead_out')

  // leadIns layer
  const leadInsLayer = byKey.get('leadIns')
  assert(!!leadInsLayer, 'leadIns layer exists')
  assert(leadInsLayer!.kinds.includes('lead_in'), 'leadIns layer includes lead_in')
  assert(leadInsLayer!.kinds.includes('lead_out'), 'leadIns layer includes lead_out')
  assert(!leadInsLayer!.kinds.includes('cut'), 'leadIns layer does NOT include cut')
}

function testOverlayLayersVisibilityGating(): void {
  console.log('Testing buildToolpathOverlayLayers visibility gating...')

  const visDefault: ToolpathVisibility = { cuts: true, leadIns: true, rapids: true, plunges: true, retractions: true, directions: true }
  function layerVis(vis: ToolpathVisibility, key: string): boolean {
    return buildToolpathOverlayLayers(vis).find((l) => l.key === key)?.visible ?? false
  }

  assert(layerVis(visDefault, 'cuts') === true, 'cuts visible when cuts=true')
  assert(layerVis({ ...visDefault, cuts: false }, 'cuts') === false, 'cuts hidden when cuts=false')
  assert(layerVis(visDefault, 'leadIns') === true, 'leadIns visible when leadIns=true')
  assert(layerVis({ ...visDefault, leadIns: false }, 'leadIns') === false, 'leadIns hidden when leadIns=false')

  // leadIns visible independent of cuts
  assert(
    layerVis({ ...visDefault, cuts: false, leadIns: true }, 'leadIns') === true,
    'leadIns visible when cuts=false,leadIns=true',
  )
  assert(
    layerVis({ ...visDefault, cuts: true, leadIns: false }, 'leadIns') === false,
    'leadIns hidden when cuts=true,leadIns=false',
  )
  assert(
    layerVis({ ...visDefault, cuts: false, leadIns: true }, 'cuts') === false,
    'cuts hidden when cuts=false,leadIns=true',
  )
}

testOverlayLayersKinds()
testOverlayLayersVisibilityGating()

// --- Issue #482: every rapid belongs to exactly one layer ---

function rapidFromTo(fromZ: number, toZ: number): ToolpathMove {
  return { kind: 'rapid', from: { x: 0, y: 0, z: fromZ }, to: { x: 5, y: 5, z: toZ } }
}

/**
 * The partition property. Stated over all three signs of `to.z - from.z`
 * rather than as a case for the descending one: the previous code passed for
 * level and ascending rapids and silently dropped descents, so only the
 * exhaustive form catches a predicate pair that stops covering the space.
 */
function testEveryRapidLandsInExactlyOneLayer(): void {
  console.log('Testing every rapid belongs to exactly one layer (issue #482)...')

  const vis: ToolpathVisibility = { cuts: true, leadIns: true, rapids: true, plunges: true, retractions: true, directions: true }
  const layers = buildToolpathOverlayLayers(vis)

  const cases: Array<{ label: string; move: ToolpathMove; expected: ToolpathOverlayLayerKey }> = [
    { label: 'descending rapid (plunge into material)', move: rapidFromTo(10, 2), expected: 'rapids' },
    { label: 'level rapid (traverse)', move: rapidFromTo(10, 10), expected: 'rapids' },
    { label: 'ascending rapid (retraction)', move: rapidFromTo(2, 10), expected: 'retractions' },
    // Sub-tolerance drift must not read as a retraction.
    { label: 'near-level rapid', move: rapidFromTo(10, 10 + TOOLPATH_LAYER_Z_EPSILON / 2), expected: 'rapids' },
  ]

  for (const { label, move, expected } of cases) {
    const claiming = layers.filter((layer) => movesForToolpathLayer([move], layer).length === 1)
    assert(
      claiming.length === 1,
      `${label}: expected exactly 1 layer to draw it, got ${claiming.length} (${claiming.map((l) => l.key).join(', ') || 'none'})`,
    )
    assert(
      claiming[0].key === expected,
      `${label}: expected the ${expected} layer, got ${claiming[0].key}`,
    )
  }
}

/** A descending rapid must follow the Rapids toggle, not the Retractions one. */
function testDescendingRapidFollowsTheRapidsToggle(): void {
  console.log('Testing a descending rapid is gated by the Rapids toggle...')

  const base: ToolpathVisibility = { cuts: true, leadIns: true, rapids: true, plunges: true, retractions: true, directions: true }
  const descending = rapidFromTo(10, 2)

  function drawn(vis: ToolpathVisibility): boolean {
    return buildToolpathOverlayLayers(vis)
      .filter((layer) => layer.visible)
      .some((layer) => movesForToolpathLayer([descending], layer).length === 1)
  }

  assert(drawn(base), 'drawn when rapids=true')
  assert(!drawn({ ...base, rapids: false }), 'hidden when rapids=false')
  assert(drawn({ ...base, retractions: false }), 'still drawn when only retractions=false')
}

function testZFilterPredicate(): void {
  console.log('Testing moveMatchesZFilter partitions rapids...')

  for (const [fromZ, toZ] of [[10, 2], [10, 10], [2, 10]] as const) {
    const move = rapidFromTo(fromZ, toZ)
    const inNonRetract = moveMatchesZFilter(move, 'nonRetract')
    const inRetract = moveMatchesZFilter(move, 'retract')
    assert(
      inNonRetract !== inRetract,
      `z ${fromZ}→${toZ}: the two filters must partition, got nonRetract=${inNonRetract} retract=${inRetract}`,
    )
    assert(moveMatchesZFilter(move, undefined), `z ${fromZ}→${toZ}: an absent filter takes every move`)
  }
}

// --- splitMovesIntoLayers / toolpathLayerBuckets: the one-pass split (#664) ---
//
// The one-pass split replaced five `movesForToolpathLayer` calls per animation
// frame. `movesForToolpathLayer` is kept as the primitive precisely so it can
// be the **oracle** here: the two are written differently — a per-layer
// `kinds.includes` filter against a single `switch` — so the assertion is a
// real cross-check rather than the split compared against itself.
//
// What each mutation kills:
//   lead_out dropped from leadIns          -> agrees with movesForToolpathLayer
//   retract/nonRetract branches swapped    -> agrees with movesForToolpathLayer
//   plunge routed to cuts                  -> agrees with movesForToolpathLayer
//   cache keyed on anything but identity   -> caches on toolpath identity
//   cache shared across toolpaths          -> distinct toolpaths do not share

const ALL_LAYER_KEYS: ToolpathOverlayLayerKey[] = ['cuts', 'leadIns', 'rapids', 'plunges', 'retractions']

/** Every kind, plus rapids on both sides of the Z split and a lead_out. */
function mixedMoves(): ToolpathMove[] {
  const kinds: ToolpathMove['kind'][] = ['cut', 'lead_in', 'lead_out', 'plunge', 'rapid']
  const moves: ToolpathMove[] = []
  for (let i = 0; i < 40; i += 1) {
    // Deterministic Z motion: ascending, descending, level, and a step under
    // the epsilon, so both rapid layers and the boundary are all exercised.
    const dz = [0, 1, -1, TOOLPATH_LAYER_Z_EPSILON / 2][i % 4]
    moves.push({
      kind: kinds[i % kinds.length],
      from: { x: i, y: i * 2, z: 5 },
      to: { x: i + 1, y: i * 2 + 1, z: 5 + dz },
    })
  }
  return moves
}

function testSplitAgreesWithMovesForToolpathLayer(): void {
  console.log('Testing one-pass layer split agrees with movesForToolpathLayer...')
  const moves = mixedMoves()
  const buckets = splitMovesIntoLayers(moves)
  // Visibility only gates whether a layer draws, never what it holds, so any
  // visibility yields the same kinds/zFilter per key.
  const layers = buildToolpathOverlayLayers({
    cuts: true, leadIns: true, rapids: true, plunges: true, retractions: true, directions: true,
  })

  let covered = 0
  for (const key of ALL_LAYER_KEYS) {
    const layer = layers.find((entry) => entry.key === key)
    assert(layer !== undefined, `layer ${key} should exist`)
    const expected = movesForToolpathLayer(moves, layer!)
    const actual = buckets[key]
    assert(
      actual.length === expected.length,
      `layer ${key}: expected ${expected.length} moves, got ${actual.length}`,
    )
    for (let i = 0; i < expected.length; i += 1) {
      assert(actual[i] === expected[i], `layer ${key}: move ${i} must be the same object, in the same order`)
    }
    covered += actual.length
  }
  assert(covered === moves.length, `every move must land in exactly one layer: ${covered} of ${moves.length}`)
}

function testLayerBucketsCachesOnToolpathIdentity(): void {
  console.log('Testing layer buckets cache on toolpath identity...')
  const toolpath = { moves: mixedMoves() }
  const first = toolpathLayerBuckets(toolpath)
  const second = toolpathLayerBuckets(toolpath)
  assert(first === second, 'the same toolpath must return the very same buckets object')
  for (const key of ALL_LAYER_KEYS) {
    assert(first[key] === second[key], `layer ${key}: the cached array must be reused, not rebuilt`)
  }

  const other = { moves: mixedMoves().slice(0, 5) }
  const otherBuckets = toolpathLayerBuckets(other)
  assert(otherBuckets !== first, "a different toolpath must not read another toolpath's buckets")
  const otherTotal = ALL_LAYER_KEYS.reduce((sum, key) => sum + otherBuckets[key].length, 0)
  assert(otherTotal === 5, `the second toolpath should hold its own 5 moves, got ${otherTotal}`)
}


testEveryRapidLandsInExactlyOneLayer()
testDescendingRapidFollowsTheRapidsToggle()
testZFilterPredicate()
testSplitAgreesWithMovesForToolpathLayer()
testLayerBucketsCachesOnToolpathIdentity()

// Issue #947: another setup's passes draw muted in 3D, below the ordinary
// unselected strength; the selected operation keeps full strength anywhere.
function testMutedOverlayOpacity(): void {
  for (const layer of [0.98, 0.9, 0.75]) {
    const selected = toolpathOverlayOpacity(layer, true)
    const ordinary = toolpathOverlayOpacity(layer, false)
    const muted = toolpathOverlayOpacity(layer, false, true)
    assert(selected === layer, `selected keeps the layer opacity ${layer}`)
    assert(ordinary === Math.max(layer * 0.55, 0.45), `unselected opacity is unchanged for ${layer}`)
    assert(muted > 0 && muted < ordinary / 2, `muted (${muted}) is well below unselected (${ordinary})`)
    assert(toolpathOverlayOpacity(layer, true, true) === layer, 'a selected muted operation is drawn at full strength')
  }
}

testMutedOverlayOpacity()

// ── Wrapped Around toolpaths (issue #395) ─────────────────────────────
//
// A wrapped point carries `a`, the angle the bar is turned to, and its XYZ is
// the tool over the bar's centreline. `stockSpacePoint` turns it into the
// point of the unturned bar under the tool, which is what the 3D view draws;
// a move whose angle changes is a curve on the bar and is subdivided.

// A 40 mm bar 200 mm long along x, and a 2 in bar 8 in long along y.
const AROUND_BAR_X = roundStock(40, 200, 'x', { x: 10, y: 30 })
const AROUND_BAR_Y = roundStock(2, 8, 'y', { x: 3, y: 5 })

/** The bar's centreline in the tool frame. */
function barCentre(bar: RoundStock): number {
  return bar.axis === 'x' ? bar.profile.start.y + bar.thickness / 2 : bar.profile.start.x + bar.thickness / 2
}

/** A wrapped tool point: on the centreline, `radius` from the axis, at `a`. */
function wrappedToolPoint(bar: RoundStock, along: number, radius: number, a: number) {
  return bar.axis === 'x'
    ? { x: along, y: barCentre(bar), z: bar.thickness / 2 + radius, a }
    : { x: barCentre(bar), y: along, z: bar.thickness / 2 + radius, a }
}

/** Distance of a stock-space point from the bar's axis. */
function distanceFromBarAxis(bar: RoundStock, point: { x: number; y: number; z: number }): number {
  const centre = barCentre(bar)
  const height = bar.thickness / 2
  return bar.axis === 'x'
    ? Math.hypot(point.y - centre, point.z - height)
    : Math.hypot(point.x - centre, point.z - height)
}

function testWrappedTurningMoveFollowsTheBar(): void {
  console.log('Testing a turning Around move is subdivided around the bar...')
  for (const [name, bar] of [['x', AROUND_BAR_X], ['y', AROUND_BAR_Y]] as const) {
    // A tool held 4 from the axis from a = 0 to a = 180: straight down the bar
    // in flat space, a half circle through the underside on the bar.
    const move: ToolpathMove = {
      kind: 'cut',
      from: wrappedToolPoint(bar, 60, 4, 0),
      to: wrappedToolPoint(bar, 60, 4, 180),
    }
    const drawn = stockSpaceMoves([move], bar)

    assert(drawn.length >= 36, `${name}: 180° draws as at least 36 pieces of 5°, got ${drawn.length}`)
    assert(drawn.length === 36, `${name}: 180° draws as exactly 36 pieces, got ${drawn.length}`)
    for (const piece of drawn) {
      assert(piece.kind === 'cut', `${name}: a piece keeps its move kind`)
      assert(
        Math.abs(distanceFromBarAxis(bar, piece.to) - 4) < 1e-9,
        `${name}: every drawn end stays at the tool's radius`,
      )
    }
    const last = drawn[drawn.length - 1].to
    assert(last.z < bar.thickness / 2, `${name}: the last end is below the centreline — on the underside`)
    for (let index = 1; index < drawn.length; index += 1) {
      assert(
        Math.abs(drawn[index].from.x - drawn[index - 1].to.x) < 1e-12
        && Math.abs(drawn[index].from.y - drawn[index - 1].to.y) < 1e-12
        && Math.abs(drawn[index].from.z - drawn[index - 1].to.z) < 1e-12,
        `${name}: piece ${index} starts where the last one ended`,
      )
    }
    assert(!('a' in drawn[0].from), `${name}: the drawn line carries stock points, not tool points`)
  }
}

function testConstantAngleAndAngleFreeMoves(): void {
  console.log('Testing a constant-angle move and an angle-free path draw as they are...')
  // Plunging along the bar at a fixed angle is a straight line in stock space.
  const plunge: ToolpathMove = {
    kind: 'cut',
    from: wrappedToolPoint(AROUND_BAR_X, 60, 4, 90),
    to: wrappedToolPoint(AROUND_BAR_X, 60, 2, 90),
  }
  const drawnPlunge = stockSpaceMoves([plunge], AROUND_BAR_X)
  assert(drawnPlunge.length === 1, 'a move that does not turn is not split')
  assert(Math.abs(distanceFromBarAxis(AROUND_BAR_X, drawnPlunge[0].to) - 2) < 1e-9, 'its end is at its own radius')

  const flatMoves: ToolpathMove[] = [
    { kind: 'rapid', from: { x: 12, y: 44, z: 42 }, to: { x: 20, y: 44, z: 42 } },
    { kind: 'cut', from: { x: 20, y: 44, z: 37 }, to: { x: 80, y: 44, z: 37 }, feedScale: 0.5 },
  ]
  const flatToolpath = { operationId: 'op', moves: flatMoves, warnings: [], bounds: toolpathBoundsOfMoves(flatMoves) }
  const drawnFlat = stockSpaceToolpath(flatToolpath, AROUND_BAR_X)
  assert(drawnFlat === flatToolpath, 'an angle-free toolpath keeps its own object')
  assert(drawnFlat.moves === flatMoves, 'and its own move array, so its line data cannot change')
  assert(JSON.stringify(buildToolpathLinePositionChunks(drawnFlat.moves)) === JSON.stringify(buildToolpathLinePositionChunks(flatMoves)), 'and the same chunk data')

  const block: Stock = {
    profile: AROUND_BAR_X.profile, thickness: AROUND_BAR_X.thickness, material: AROUND_BAR_X.material,
    color: AROUND_BAR_X.color, visible: AROUND_BAR_X.visible, origin: AROUND_BAR_X.origin,
  }
  const turning: ToolpathMove = {
    kind: 'cut',
    from: wrappedToolPoint(AROUND_BAR_X, 60, 4, 0),
    to: wrappedToolPoint(AROUND_BAR_X, 60, 4, 90),
  }
  const turningToolpath = { operationId: 'op', moves: [turning], warnings: [], bounds: toolpathBoundsOfMoves([turning]) }
  assert(stockSpaceToolpath(turningToolpath, block) === turningToolpath, 'a block has no bar to wrap onto')
}

function testWrappedToolpathIsADrawnCopyWithItsOwnBounds(): void {
  console.log('Testing a wrapped toolpath is a drawn copy with its own bounds...')
  const move: ToolpathMove = { kind: 'cut', from: wrappedToolPoint(AROUND_BAR_X, 60, 4, 0), to: wrappedToolPoint(AROUND_BAR_X, 60, 4, 90) }
  const toolpath = { operationId: 'op', moves: [move], warnings: [], bounds: toolpathBoundsOfMoves([move]) }
  const drawn = stockSpaceToolpath(toolpath, AROUND_BAR_X)

  assert(drawn !== toolpath, 'the drawn path is a copy')
  assert(drawn.moves !== toolpath.moves, 'with its own move array')
  assert(drawn.operationId === 'op', 'the operation is carried through')
  assert(drawn.moves.length === 18, `90° draws as 18 pieces, got ${drawn.moves.length}`)
  assert(drawn.bounds !== null, 'the drawn copy has bounds')
  const minZ = Math.min(...drawn.moves.map((piece) => piece.to.z))
  assert(drawn.bounds!.minZ === minZ, 'its bounds are measured from what is drawn')
  assert(toolpath.moves.length === 1, 'and the generated toolpath is untouched')
}

testWrappedTurningMoveFollowsTheBar()
testConstantAngleAndAngleFreeMoves()
testWrappedToolpathIsADrawnCopyWithItsOwnBounds()

console.log('toolpathOverlay tests passed')
