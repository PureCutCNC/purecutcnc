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

/** Display-only 2D toolpath geometry (issue #679). */

import type { ToolpathMove, ToolpathResult } from '../../engine/toolpaths/types'
import {
  canvasDisplayViewport,
  toolpathDisplayGeometry,
  visibleDisplaySegments,
  visiblePackedSegmentOffsets,
  type DisplayViewport,
} from './toolpathDisplay'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function toolpathOf(
  moves: ToolpathMove[],
  options: Pick<ToolpathResult, 'collidingMoveIndices' | 'debugToolpath'> = {},
): ToolpathResult {
  return {
    operationId: 'display-test',
    moves,
    warnings: [],
    bounds: { minX: -1_000, minY: -1_000, minZ: 0, maxX: 1_000, maxY: 1_000, maxZ: 10 },
    ...options,
  }
}

const smallViewport: DisplayViewport = { minX: 0, minY: -10, maxX: 20, maxY: 10 }

console.log('\ntoolpathDisplay')

test('coalesces only connected same-feed paths that stay below one pixel', () => {
  const toolpath = toolpathOf([
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 0.25, y: 0, z: 0 }, feedScale: 0.5 },
    { kind: 'cut', from: { x: 0.25, y: 0, z: 0 }, to: { x: 0.5, y: 0, z: 0 }, feedScale: 0.5 },
    { kind: 'cut', from: { x: 0.5, y: 0, z: 0 }, to: { x: 0.75, y: 0, z: 0 }, feedScale: 0.5 },
    { kind: 'cut', from: { x: 0.75, y: 0, z: 0 }, to: { x: 1.25, y: 0, z: 0 }, feedScale: 0.5 },
  ])

  const segments = toolpathDisplayGeometry(toolpath, 1).layers.cuts.segments
  assert(segments.length === 2, `expected a sub-pixel run plus one distinct segment, got ${segments.length}`)
  assert(segments[0].fromX === 0 && segments[0].toX === 0.75, 'the first sub-pixel run should retain its endpoints')
  assert(segments[1].fromX === 0.75 && segments[1].toX === 1.25, 'a run beyond the threshold must start a new segment')
})

test('does not merge display paths with different feed styles', () => {
  const toolpath = toolpathOf([
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 0.2, y: 0, z: 0 }, feedScale: 0.4 },
    { kind: 'cut', from: { x: 0.2, y: 0, z: 0 }, to: { x: 0.4, y: 0, z: 0 }, feedScale: 0.8 },
  ])

  assert(toolpathDisplayGeometry(toolpath, 1).layers.cuts.segments.length === 2, 'feed-colour boundaries must remain separate')
})

test('culls offscreen segments without dropping one that crosses the viewport', () => {
  const toolpath = toolpathOf([
    { kind: 'cut', from: { x: -100, y: 0, z: 0 }, to: { x: 100, y: 0, z: 0 } },
    { kind: 'cut', from: { x: 300, y: 0, z: 0 }, to: { x: 400, y: 0, z: 0 } },
    { kind: 'cut', from: { x: 0, y: 300, z: 0 }, to: { x: 10, y: 300, z: 0 } },
  ])

  const visible = visibleDisplaySegments(toolpathDisplayGeometry(toolpath, 1).layers.cuts, smallViewport)
  assert(visible.length === 1, `expected only the crossing segment, got ${visible.length}`)
  assert(visible[0].fromX === -100 && visible[0].toX === 100, 'the segment crossing the viewport edge must render')
})

test('pans reuse display geometry while zooming rebuilds it', () => {
  const toolpath = toolpathOf([
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 } },
  ])
  const atOne = toolpathDisplayGeometry(toolpath, 1)
  const sameScale = toolpathDisplayGeometry(toolpath, 1)
  const atTwo = toolpathDisplayGeometry(toolpath, 2)

  assert(atOne === sameScale, 'a pan does not change the cached scale-specific geometry')
  assert(atTwo !== atOne, 'a zoom must rebuild screen-space display geometry')
})

test('collisions and debug source markers use the same viewport index', () => {
  const toolpath = toolpathOf(
    [
      { kind: 'cut', from: { x: -100, y: 0, z: 0 }, to: { x: 100, y: 0, z: 0 }, source: 'contour' },
      { kind: 'cut', from: { x: 300, y: 0, z: 0 }, to: { x: 400, y: 0, z: 0 }, source: 'bootstrap' },
    ],
    { collidingMoveIndices: [0, 1], debugToolpath: true },
  )
  const geometry = toolpathDisplayGeometry(toolpath, 1)

  assert(visibleDisplaySegments(geometry.collisions, smallViewport).length === 1, 'only the visible collision should redraw')
  assert(visibleDisplaySegments(geometry.debug, smallViewport).length === 1, 'only the visible debug marker should redraw')
})

test('culls cached arrow placements by their segment bounds', () => {
  const packed = new Float32Array([
    -100, 0, 100, 0,
    300, 0, 400, 0,
    0, 300, 10, 300,
  ])
  const offsets = visiblePackedSegmentOffsets(packed, smallViewport)

  assert(offsets !== null, 'a partial viewport should return a subset rather than the full placement array')
  assert(offsets?.length === 1 && offsets[0] === 0, `expected only the crossing arrow, got ${offsets?.join(', ')}`)
})

test('derives a pan-independent viewport from canvas dimensions', () => {
  const viewport = canvasDisplayViewport({ width: 200, height: 100 }, { scale: 2, offsetX: 30, offsetY: -40 })

  assert(viewport?.minX === -30 && viewport.maxX === 170, 'X bounds should only remove the current pan offset')
  assert(viewport?.minY === 40 && viewport.maxY === 140, 'Y bounds should only remove the current pan offset')
})

console.log(`\ntoolpathDisplay: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
