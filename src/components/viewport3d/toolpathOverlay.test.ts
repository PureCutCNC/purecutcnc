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
import type { ToolpathVisibility } from '../toolpathVisibility'
import {
  buildToolpathLinePositionChunks,
  buildToolpathOverlayLayers,
  moveMatchesZFilter,
  movesForToolpathLayer,
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

testEveryRapidLandsInExactlyOneLayer()
testDescendingRapidFollowsTheRapidsToggle()
testZFilterPredicate()

console.log('toolpathOverlay tests passed')
