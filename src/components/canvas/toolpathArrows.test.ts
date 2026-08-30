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
 * The 2D arrow-placement cache (issue #664).
 *
 * The cache exists because deciding which moves get an arrow is a full pass
 * over the toolpath, and the canvas was redoing it every frame — 93.7 ms per
 * frame on the 249,663-move fixture, against 26.7 ms to draw the arrows the
 * pass selected.
 *
 * Two claims have to hold, and they are the two halves of this file.
 *
 * 1. **Panning must hit the cache and zooming must miss it.** That is the whole
 *    point: the pass reads screen-space spacing thresholds, so the answer
 *    genuinely changes with scale but genuinely does not change with offset.
 *    Asserted through a counting wrapper rather than by timing.
 * 2. **Storing positions pan-independently must not move the arrows.** Scaled
 *    world plus offset has to equal the canvas position the old per-frame code
 *    computed, or the arrows drift as you pan — which would be worse than the
 *    slowness it replaced.
 *
 * ## What each mutation kills
 *
 * | Mutation | Killed by |
 * | --- | --- |
 * | cache ignores `scale` | `zooming rebuilds` |
 * | cache keyed on offset too (or not cached) | `panning reuses the same placements` |
 * | cache ignores a visibility flag | `each visibility flag rebuilds` |
 * | positions stored with the offset baked in | `positions are pan-independent` |
 * | `isConnectorCut` neighbour test dropped | `a sharp short connector still gets an arrow` |
 * | spacing suppression dropped | `collinear moves are thinned by spacing` |
 * | retract/non-retract rapids confused | `rapid layers gate independently` |
 *
 * Run with: npx tsx src/components/canvas/toolpathArrows.test.ts
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { generateEdgeRouteToolpath } from '../../engine/toolpaths/edge'
import type { ToolpathMove, ToolpathResult } from '../../engine/toolpaths/types'
import { normalizeProject } from '../../store/projectStore'
import type { Operation, Project } from '../../types/project'
import type { ToolpathVisibility } from '../toolpathVisibility'
import { moveMatchesZFilter } from '../viewport3d/toolpathOverlay'
import { computeToolpathArrowPlacements, toolpathArrowPlacements, type ArrowKind } from './toolpathArrows'

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

const ALL_ON: ToolpathVisibility = {
  cuts: true, leadIns: true, rapids: true, plunges: true, retractions: true, directions: true,
}

function toolpathOf(moves: ToolpathMove[]): ToolpathResult {
  let minX = Infinity, minY = Infinity, minZ = Infinity
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity
  for (const move of moves) {
    for (const p of [move.from, move.to]) {
      minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x)
      minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y)
      minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z)
    }
  }
  return {
    operationId: 'op',
    moves,
    warnings: [],
    bounds: { minX, minY, minZ, maxX, maxY, maxZ },
  }
}

/** A long straight run: every move is far past the force-arrow length. */
function straightRun(count: number): ToolpathResult {
  const moves: ToolpathMove[] = []
  for (let i = 0; i < count; i += 1) {
    moves.push({ kind: 'cut', from: { x: i * 10, y: 0, z: 0 }, to: { x: (i + 1) * 10, y: 0, z: 0 } })
  }
  return toolpathOf(moves)
}

console.log('\ntoolpathArrows')

test('panning reuses the same placements; zooming rebuilds', () => {
  const toolpath = straightRun(40)
  const first = toolpathArrowPlacements(toolpath, 1, ALL_ON)
  const samePan = toolpathArrowPlacements(toolpath, 1, ALL_ON)
  assert(first === samePan, 'the same (toolpath, scale, visibility) must return the identical object')
  assert(first.cut === samePan.cut, 'the packed array itself must be reused, not rebuilt')

  const zoomed = toolpathArrowPlacements(toolpath, 2, ALL_ON)
  assert(zoomed !== first, 'a different scale must not return the cached placements')
})

test('each visibility flag the pass reads rebuilds the cache', () => {
  const toolpath = straightRun(20)
  const base = toolpathArrowPlacements(toolpath, 1, ALL_ON)
  for (const key of ['cuts', 'rapids', 'retractions'] as const) {
    const flipped = toolpathArrowPlacements(toolpath, 1, { ...ALL_ON, [key]: false })
    assert(flipped !== base, `flipping ${key} must rebuild rather than reuse`)
  }
  // Back to the original flags: the entry was overwritten, so this recomputes,
  // but it must agree with the first answer.
  const restored = toolpathArrowPlacements(toolpath, 1, ALL_ON)
  assert(
    restored.cut.length === base.cut.length,
    `restoring the flags must give the same arrows: ${restored.cut.length} vs ${base.cut.length}`,
  )
})

test('positions are pan-independent: scaled world, no offset', () => {
  const toolpath = straightRun(10)
  const scale = 3
  const placements = computeToolpathArrowPlacements(toolpath, scale, ALL_ON)
  assert(placements.cut.length > 0, 'the run should place arrows')

  // Every stored endpoint must be exactly `world * scale`, so adding the view
  // offset at draw time reproduces the canvas position.
  const endpoints = new Set<number>()
  for (const move of toolpath.moves) {
    endpoints.add(move.from.x * scale)
    endpoints.add(move.to.x * scale)
  }
  for (let i = 0; i < placements.cut.length; i += 4) {
    assert(endpoints.has(placements.cut[i]), `fromX ${placements.cut[i]} is not a scaled world coordinate`)
    assert(endpoints.has(placements.cut[i + 2]), `toX ${placements.cut[i + 2]} is not a scaled world coordinate`)
    assert(placements.cut[i + 1] === 0 && placements.cut[i + 3] === 0, 'Y should be 0 on this run')
  }
})

test('scaling the view scales the stored positions in lockstep', () => {
  const toolpath = straightRun(10)
  const at1 = computeToolpathArrowPlacements(toolpath, 1, ALL_ON)
  const at4 = computeToolpathArrowPlacements(toolpath, 4, ALL_ON)
  assert(at1.cut.length === at4.cut.length, 'this run places an arrow per move at both scales')
  for (let i = 0; i < at1.cut.length; i += 1) {
    assert(
      Math.abs(at4.cut[i] - at1.cut[i] * 4) < 1e-3,
      `index ${i}: expected ${at1.cut[i] * 4}, got ${at4.cut[i]}`,
    )
  }
})

test('collinear moves are thinned by spacing, not one arrow each', () => {
  // Short collinear moves: no move is long enough to force an arrow and none
  // turns, so spacing alone decides and most moves must be skipped.
  const moves: ToolpathMove[] = []
  for (let i = 0; i < 400; i += 1) {
    moves.push({ kind: 'cut', from: { x: i, y: 0, z: 0 }, to: { x: i + 1, y: 0, z: 0 } })
  }
  const placements = computeToolpathArrowPlacements(toolpathOf(moves), 1, ALL_ON)
  const arrows = placements.cut.length / 4
  assert(arrows > 0, 'spacing should still place some arrows')
  assert(arrows < 400 / 4, `spacing should thin the run, got ${arrows} arrows for 400 moves`)
})

test('a sharp short connector still gets an arrow the spacing rule would skip', () => {
  // Short moves, too short to force an arrow and too soon for spacing, so only
  // the neighbour-turn test can place one. The rule takes the *minimum* of the
  // turn against each neighbour, so the middle move must differ from BOTH — a
  // zigzag qualifies, an L-bend followed by a collinear move does not.
  const straight: ToolpathMove[] = [
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } },
    { kind: 'cut', from: { x: 1, y: 0, z: 0 }, to: { x: 2, y: 0, z: 0 } },
    { kind: 'cut', from: { x: 2, y: 0, z: 0 }, to: { x: 3, y: 0, z: 0 } },
  ]
  const turning: ToolpathMove[] = [
    { kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 1, y: 0, z: 0 } },
    { kind: 'cut', from: { x: 1, y: 0, z: 0 }, to: { x: 1, y: 1, z: 0 } },
    { kind: 'cut', from: { x: 1, y: 1, z: 0 }, to: { x: 2, y: 1, z: 0 } },
  ]
  const straightArrows = computeToolpathArrowPlacements(toolpathOf(straight), 1, ALL_ON).cut.length / 4
  const turningArrows = computeToolpathArrowPlacements(toolpathOf(turning), 1, ALL_ON).cut.length / 4
  assert(
    turningArrows > straightArrows,
    `the turn should add an arrow the straight run does not get: ${turningArrows} vs ${straightArrows}`,
  )
})

test('rapid layers gate independently by Z direction', () => {
  const moves: ToolpathMove[] = [
    // A long level rapid — the `rapids` layer.
    { kind: 'rapid', from: { x: 0, y: 0, z: 5 }, to: { x: 100, y: 0, z: 5 } },
    // A long ascending rapid — the `retractions` layer.
    { kind: 'rapid', from: { x: 100, y: 0, z: 5 }, to: { x: 200, y: 0, z: 20 } },
  ]
  const toolpath = toolpathOf(moves)
  const both = computeToolpathArrowPlacements(toolpath, 1, ALL_ON).rapid.length / 4
  const levelOnly = computeToolpathArrowPlacements(toolpath, 1, { ...ALL_ON, retractions: false }).rapid.length / 4
  const retractOnly = computeToolpathArrowPlacements(toolpath, 1, { ...ALL_ON, rapids: false }).rapid.length / 4
  assert(both === 2, `both rapids should place an arrow each, got ${both}`)
  assert(levelOnly === 1, `hiding retractions should leave the level rapid, got ${levelOnly}`)
  assert(retractOnly === 1, `hiding rapids should leave the retraction, got ${retractOnly}`)
})

test('a toolpath with no bounds places nothing rather than throwing', () => {
  const placements = computeToolpathArrowPlacements(
    { operationId: 'op', moves: [], warnings: [], bounds: null },
    1,
    ALL_ON,
  )
  assert(placements.cut.length === 0 && placements.rapid.length === 0, 'no bounds means no arrows')
})

// --- The port places exactly the arrows the pre-#664 code placed ---------
//
// The rules above pin the behaviour on small hand-built fixtures. This pins
// the *port*: `computeToolpathArrowPlacements` was lifted out of `drawToolpath`
// and rewritten to store scaled-world coordinates instead of canvas ones, and
// the only claim that matters to a user is that the arrows did not move.
//
// So the oracle is the original algorithm, transcribed below from
// `previewPrimitives.ts` at 9cd0325 — canvas-space coordinates, `Math.hypot`,
// both neighbours computed eagerly — run against the real 249,663-move
// fixture at several scales and offsets. Same pattern as
// `engagementOracle.test.ts`: two independently written implementations, so
// they cannot share a bug.

/** `previewPrimitives.ts` at 9cd0325, before the placement pass was extracted. */
function originalArrowPass(
  toolpath: ToolpathResult,
  vt: { scale: number; offsetX: number; offsetY: number },
  visibility: ToolpathVisibility,
): Record<ArrowKind, number[]> {
  const bounds = toolpath.bounds!
  const span = Math.max(
    bounds.maxX - bounds.minX, bounds.maxY - bounds.minY, bounds.maxZ - bounds.minZ,
  )
  const preferredSpacing = Math.max(12, Math.min(40, span * vt.scale * 0.09))
  const preferredArrowLength = Math.max(8.5, Math.min(18, span * vt.scale * 0.03))
  const toCanvas = (x: number, y: number) => ({ cx: vt.offsetX + x * vt.scale, cy: vt.offsetY + y * vt.scale })
  const moveDelta = (move: ToolpathMove) => {
    const from = toCanvas(move.from.x, move.from.y)
    const to = toCanvas(move.to.x, move.to.y)
    return { from, dx: to.cx - from.cx, dy: to.cy - from.cy, length: Math.hypot(to.cx - from.cx, to.cy - from.cy), to }
  }
  const direction = (move: ToolpathMove | undefined) => {
    if (!move || (move.kind !== 'cut' && move.kind !== 'rapid')) return null
    const d = moveDelta(move)
    if (d.length <= 0.001) return null
    return { x: d.dx / d.length, y: d.dy / d.length }
  }

  const since: Record<ArrowKind, number> = { cut: 0, rapid: 0 }
  const out: Record<ArrowKind, number[]> = { cut: [], rapid: [] }
  for (let i = 0; i < toolpath.moves.length; i += 1) {
    const move = toolpath.moves[i]
    if (move.kind !== 'cut' && move.kind !== 'rapid') continue
    if (move.kind === 'cut' && !visibility.cuts) continue
    if (move.kind === 'rapid') {
      const isRetraction = moveMatchesZFilter(move, 'retract')
      if (isRetraction && !visibility.retractions) continue
      if (!isRetraction && !visibility.rapids) continue
    }
    const d = moveDelta(move)
    if (d.length < 0.5) continue
    since[move.kind] += d.length
    const previous = direction(toolpath.moves[i - 1])
    const next = direction(toolpath.moves[i + 1])
    const dir = { x: d.dx / d.length, y: d.dy / d.length }
    const turn = previous && next
      ? Math.min(
        Math.acos(Math.max(-1, Math.min(1, dir.x * previous.x + dir.y * previous.y))),
        Math.acos(Math.max(-1, Math.min(1, dir.x * next.x + dir.y * next.y))),
      )
      : null
    const isConnectorCut = move.kind === 'cut'
      && d.length <= preferredSpacing * 0.8
      && turn !== null && turn >= Math.PI / 10
    const shouldForceArrow = d.length >= preferredArrowLength * 1.1
    const shouldPlaceBySpacing = since[move.kind] >= preferredSpacing
    if (!shouldForceArrow && !shouldPlaceBySpacing && !isConnectorCut) continue
    out[move.kind].push(d.from.cx, d.from.cy, d.to.cx, d.to.cy)
    since[move.kind] = 0
  }
  return out
}

test('places exactly the pre-#664 arrows on the real 249,663-move fixture', () => {
  const project = normalizeProject(
    JSON.parse(readFileSync(join('src', 'engine', 'test-fixtures', 'trochoidal-249k.camj'), 'utf8')) as Project,
  )
  const operation = project.operations.find((candidate) => candidate.kind === 'edge_route_outside')
  assert(operation !== undefined, 'fixture must contain the edge_route_outside operation')
  const toolpath = generateEdgeRouteToolpath(project, operation as Operation)

  // 155.5 is roughly the app's pixels-per-inch on this part; the lower scales
  // exercise the branch where every move falls under the 0.5 px floor.
  let arrowsSeen = 0
  for (const scale of [1, 7.3, 40, 155.5]) {
    for (const [offsetX, offsetY] of [[0, 0], [137.5, -42.25]]) {
      const expected = originalArrowPass(toolpath, { scale, offsetX, offsetY }, ALL_ON)
      const actual = computeToolpathArrowPlacements(toolpath, scale, ALL_ON)
      for (const kind of ['cut', 'rapid'] as const) {
        const want = expected[kind]
        const got = actual[kind]
        assert(
          want.length === got.length,
          `scale ${scale}: ${kind} arrow count ${got.length / 4} != original ${want.length / 4}`,
        )
        arrowsSeen += got.length / 4
        // Stored scaled-world plus the offset must reproduce the canvas
        // position the original computed. Float32 storage is the only slack.
        const tolerance = 2e-3 * Math.max(1, scale)
        for (let i = 0; i < want.length; i += 4) {
          assert(Math.abs(want[i] - (got[i] + offsetX)) <= tolerance, `scale ${scale}: ${kind} fromX drifted`)
          assert(Math.abs(want[i + 1] - (got[i + 1] + offsetY)) <= tolerance, `scale ${scale}: ${kind} fromY drifted`)
          assert(Math.abs(want[i + 2] - (got[i + 2] + offsetX)) <= tolerance, `scale ${scale}: ${kind} toX drifted`)
          assert(Math.abs(want[i + 3] - (got[i + 3] + offsetY)) <= tolerance, `scale ${scale}: ${kind} toY drifted`)
        }
      }
    }
  }
  // Guards the guard: if the fixture ever stopped placing arrows this would
  // pass vacuously. 9,899 per pass at scale 155.5, twice.
  assert(arrowsSeen === 19_798, `expected 19,798 arrows across the matrix, got ${arrowsSeen}`)
})

console.log(`\ntoolpathArrows: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
