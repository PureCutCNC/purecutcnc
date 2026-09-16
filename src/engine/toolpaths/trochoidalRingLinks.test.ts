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
 * Orbited straight links between trochoidal rings (issue #790).
 *
 * Consecutive rings of one offset tree used to be joined by a retract, a rapid
 * and a fresh helical entry. They are now joined at depth by a straight guide
 * cut as an open trochoid. These tests hold the issue's acceptance criteria on
 * the emitted move stream: the join happens, its channel stays inside the
 * pocket (measured on the cutter body against the real outline), it cuts no
 * harder than the orbit it joins, and it is refused wherever the plan says a
 * retract must stay — across branches of the tree and between rings that turn
 * opposite ways.
 *
 * Run with: npx tsx src/engine/toolpaths/trochoidalRingLinks.test.ts
 */

import type { Operation, Point, SketchFeature, SketchProfile, Tool } from '../../types/project'
import { defaultTool, newProject, polygonProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { SweptMaterialIndex } from './engagement'
import { generatePocketToolpath } from './pocket'
import type { ToolpathMove } from './types'

function assert(condition: boolean, message: string): asserts condition {
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

// ── Fixtures ─────────────────────────────────────────────────────────

const TOOL_DIAMETER = 6
const TOOL_RADIUS = TOOL_DIAMETER / 2
/** The default channel, `1.5 x D`. */
const CHANNEL = TOOL_DIAMETER * 1.5
/** Ring spacing at the operation's 0.5 stepover. */
const PITCH = CHANNEL * 0.5

const LINK = 'trochoidal-link'
const ENTRY = 'trochoidal-entry'

function makeTool(): Tool {
  return { ...defaultTool('mm', 1), id: 'tool-1', name: '6 mm endmill', diameter: TOOL_DIAMETER }
}

function feature(id: string, profile: SketchProfile, operation: 'subtract' | 'add', zBottom = 0): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation,
    z_top: 2,
    z_bottom: zBottom,
    visible: true,
    locked: false,
  }
}

function operation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'op-1',
    name: 'op',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['pocket'] },
    toolRef: 'tool-1',
    stepdown: 2,
    stepover: 0.5,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'trochoidal',
    pocketAngle: 0,
    pocketSlotFeedPercent: 100,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: false,
    finishFloor: false,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    ...overrides,
  }
}

interface Shape {
  name: string
  outer: Point[]
  islands: Point[][]
}

function rect(x: number, y: number, w: number, h: number): Point[] {
  return [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
}

function generate(shape: Shape, overrides: Partial<Operation> = {}, zBottom = 0): ToolpathMove[] {
  const features = [
    feature('pocket', polygonProfile(shape.outer), 'subtract', zBottom),
    ...shape.islands.map((island, index) => feature(`island-${index}`, polygonProfile(island), 'add', zBottom)),
  ]
  const project = projectWithFeatures({ ...newProject('ring-links', 'mm'), tools: [makeTool()] }, features)
  const result = generatePocketToolpath(project, operation(overrides))
  assert(result.moves.length > 0, `${shape.name} must generate (${result.warnings.map((w) => w.code).join(', ')})`)
  return result.moves
}

const SQUARE: Shape = { name: 'square', outer: rect(-30, -30, 60, 60), islands: [] }

/**
 * An island 12 mm off the wall on one side: the root keeps it as a hole, and
 * one inset later the hole merges into the outer boundary, so every deeper
 * ring is a C wrapped round it.
 */
const OFFSET_ISLAND: Shape = { name: 'off-centre island', outer: rect(-30, -30, 60, 60), islands: [rect(4, -7, 14, 14)] }

/** A 24-gon, standing in for a round island. */
function roundIsland(cx: number, cy: number, radius: number): Point[] {
  return Array.from({ length: 24 }, (_, index) => ({
    x: cx + radius * Math.cos(index * Math.PI / 12),
    y: cy + radius * Math.sin(index * Math.PI / 12),
  }))
}

/**
 * Two small islands side by side. Their loops belong to one node and turn the
 * same way, so a link between them is a candidate. Square islands in four
 * orientations exercise the ordinary joins; round ones put a loop's seam where
 * the straight line to the other island runs 1.3 mm into the island just
 * circled — the case the domain check exists for.
 */
function twoIslands(angle: number, round = false): Shape {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const island = (cx: number): Point[] => (round ? roundIsland(cx, 0, 2) : rect(cx - 2, -2, 4, 4))
    .map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }))
  return {
    name: `two ${round ? 'round' : 'square'} islands at ${Math.round(angle * 180 / Math.PI)} deg`,
    outer: rect(-30, -30, 60, 60),
    islands: [island(-7.5), island(7.5)],
  }
}

const ISLAND_PAIRS: Shape[] = [
  ...[0, 0.5, 1, 1.5].map((quarter) => twoIslands(quarter * Math.PI)),
  twoIslands(0, true),
]

/**
 * A U: the bar between the arms survives the guide inset and vanishes one
 * pitch later, so the tree branches into one subtree per arm.
 */
const U_SHAPE: Shape = {
  name: 'U',
  outer: [
    { x: -30, y: -20 }, { x: 30, y: -20 }, { x: 30, y: 25 }, { x: 4, y: 25 },
    { x: 4, y: -2 }, { x: -4, y: -2 }, { x: -4, y: 25 }, { x: -30, y: 25 },
  ],
  islands: [],
}

/**
 * A slab with a notch in the middle of each long side. The neck between the
 * notches closes two levels before the ends do, so the tree branches into two
 * lobes that still see each other straight across the neck — a jump the domain
 * check allows and only the length cap turns into a retract.
 */
const NOTCHED: Shape = {
  name: 'notched slab',
  outer: [
    { x: -40, y: -20 }, { x: -8, y: -20 }, { x: -8, y: -12 }, { x: 8, y: -12 }, { x: 8, y: -20 }, { x: 40, y: -20 },
    { x: 40, y: 20 }, { x: 8, y: 20 }, { x: 8, y: 12 }, { x: -8, y: 12 }, { x: -8, y: 20 }, { x: -40, y: 20 },
  ],
  islands: [],
}

const CONTAINMENT_SHAPES: Shape[] = [SQUARE, OFFSET_ISLAND, ...ISLAND_PAIRS, U_SHAPE, NOTCHED]

// ── Stream helpers ───────────────────────────────────────────────────

/** Maximal runs of consecutive moves carrying `source`. */
function runs(moves: readonly ToolpathMove[], source: string): ToolpathMove[][] {
  const found: ToolpathMove[][] = []
  let current: ToolpathMove[] | null = null
  for (const move of moves) {
    if (move.source === source) {
      if (!current) {
        current = []
        found.push(current)
      }
      current.push(move)
    } else {
      current = null
    }
  }
  return found
}

/**
 * A link's guide length, read off its orbit. A straight guide keeps one frame,
 * so the orbit's first and last points sit at the same phase round the two
 * guide ends and their distance is exactly the guide's.
 */
function linkLength(run: readonly ToolpathMove[]): number {
  const first = run[0].from
  const last = run[run.length - 1].to
  return Math.hypot(last.x - first.x, last.y - first.y)
}

function levels(moves: readonly ToolpathMove[]): number[] {
  return [...new Set(moves.filter((m) => m.kind === 'cut').map((m) => m.to.z))].sort((a, b) => b - a)
}

function insidePolygon(point: Point, polygon: readonly Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i]
    const b = polygon[j]
    if ((a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside
}

function distanceToLoop(point: Point, loop: readonly Point[]): number {
  let best = Infinity
  for (let index = 0; index < loop.length; index += 1) {
    const a = loop[index]
    const b = loop[(index + 1) % loop.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / (dx * dx + dy * dy)))
    best = Math.min(best, Math.hypot(point.x - (a.x + dx * t), point.y - (a.y + dy * t)))
  }
  return best
}

/**
 * How far the cutter BODY at `point` stays from the part: distance from the
 * tool centre to the nearest wall or island edge, minus the tool radius.
 * Negative means the cutter is in material the pocket must keep.
 */
function bodyClearance(point: Point, shape: Shape): number {
  if (!insidePolygon(point, shape.outer)) return -Infinity
  if (shape.islands.some((island) => insidePolygon(point, island))) return -Infinity
  const edges = [shape.outer, ...shape.islands].map((loop) => distanceToLoop(point, loop))
  return Math.min(...edges) - TOOL_RADIUS
}

/** Worst body clearance over the swept path of `moves`, sampled every 0.05 mm. */
function worstClearance(moves: readonly ToolpathMove[], shape: Shape): { clearance: number; at: Point } {
  let worst = { clearance: Infinity, at: { x: 0, y: 0 } }
  for (const move of moves) {
    const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
    const samples = Math.max(1, Math.ceil(length / 0.05))
    for (let sample = 0; sample <= samples; sample += 1) {
      const t = sample / samples
      const at = { x: move.from.x + (move.to.x - move.from.x) * t, y: move.from.y + (move.to.y - move.from.y) * t }
      const clearance = bodyClearance(at, shape)
      if (clearance < worst.clearance) worst = { clearance, at }
    }
  }
  return worst
}

/**
 * The cut stream in pieces: split wherever the tool stops cutting (a new
 * `stretch`) and wherever it changes between a link and a ring. The chords
 * either end of a link are untagged, so they ride with the rings.
 */
function cutPieces(moves: readonly ToolpathMove[]): { link: boolean; stretch: number; moves: ToolpathMove[] }[] {
  const pieces: { link: boolean; stretch: number; moves: ToolpathMove[] }[] = []
  let stretch = 0
  let current: { link: boolean; stretch: number; moves: ToolpathMove[] } | null = null
  for (const move of moves) {
    if (move.kind !== 'cut') {
      if (current) stretch += 1
      current = null
      continue
    }
    const link = move.source === LINK
    if (!current || current.link !== link) {
      current = { link, stretch, moves: [] }
      pieces.push(current)
    }
    current.moves.push(move)
  }
  return pieces
}

/** Net turning of a cut path; its sign is the orbit sense. */
function turning(moves: readonly ToolpathMove[]): number {
  let sum = 0
  for (let index = 0; index + 1 < moves.length; index += 1) {
    const a = moves[index]
    const b = moves[index + 1]
    sum += (a.to.x - a.from.x) * (b.to.y - b.from.y) - (a.to.y - a.from.y) * (b.to.x - b.from.x)
  }
  return sum
}

/**
 * Length-weighted 95th percentile engagement of link moves and of every other
 * cut, measured level by level on a fresh swept index — the swept index is
 * two-dimensional, so a shared one would see each deeper level as already cut.
 */
function engagementByRole(moves: readonly ToolpathMove[]): { link: number; other: number } {
  const link: { e: number; l: number }[] = []
  const other: { e: number; l: number }[] = []
  let index = new SweptMaterialIndex(TOOL_RADIUS)
  let z: number | null = null
  for (const move of moves) {
    if (move.kind !== 'cut' || move.from.z !== move.to.z) continue
    if (move.to.z !== z) {
      index = new SweptMaterialIndex(TOOL_RADIUS)
      z = move.to.z
    }
    const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
    if (length > TOOL_RADIUS / 50) {
      const dx = (move.to.x - move.from.x) / length
      const dy = (move.to.y - move.from.y) / length
      let worst = 0
      for (let p = 1; p <= 3; p += 1) {
        const t = p / 4
        worst = Math.max(worst, index.engagementAt(
          move.from.x + (move.to.x - move.from.x) * t,
          move.from.y + (move.to.y - move.from.y) * t,
          dx,
          dy,
        ))
      }
      ;(move.source === LINK ? link : other).push({ e: worst, l: length })
    }
    index.addSweptSegment(move.from.x, move.from.y, move.to.x, move.to.y)
  }
  const p95 = (samples: { e: number; l: number }[]): number => {
    const sorted = [...samples].sort((a, b) => a.e - b.e)
    const total = sorted.reduce((sum, sample) => sum + sample.l, 0)
    let walked = 0
    for (const sample of sorted) {
      walked += sample.l
      if (walked >= total * 0.95) return sample.e
    }
    return sorted.at(-1)?.e ?? 0
  }
  return { link: p95(link), other: p95(other) }
}

// ── Tests ────────────────────────────────────────────────────────────

console.log('Testing trochoidal ring links (#790)...')

test('acceptance: consecutive rings of one tree are joined at depth, not re-entered', () => {
  const moves = generate(SQUARE, {}, -2)
  const zs = levels(moves)
  assert(zs.length === 2, `two levels expected, got ${zs.join(', ')}`)
  for (const z of zs) {
    const first = moves.findIndex((move) => move.source === ENTRY && move.to.z === z)
    const last = moves.findLastIndex((move) => move.kind === 'cut' && move.to.z === z)
    assert(first >= 0 && last > first, `level ${z} must have an entry and cuts`)
    const between = moves.slice(first, last + 1).filter((move) => move.source !== ENTRY)
    const offDepth = between.filter((move) => move.kind !== 'cut' || move.from.z !== z || move.to.z !== z)
    assert(
      offDepth.length === 0,
      `level ${z}: ${offDepth.length} moves leave depth between the first ring and the last `
      + `(first: ${offDepth[0]?.kind} ${JSON.stringify(offDepth[0]?.to)})`,
    )
    const entries = runs(moves.slice(first, last + 1), ENTRY).length
    const links = runs(between, LINK).length
    assert(entries === 1, `level ${z}: one tree takes one entry, got ${entries}`)
    assert(links >= 3, `level ${z}: the square's rings must be linked, got ${links} links`)
  }
})

test('links run one pitch radially, not corner to corner', () => {
  // Nested square rings sit one pitch apart, and a seam placed at the point of
  // the next ring nearest the last one keeps every link that short. Seaming at
  // the nearest VERTEX instead joins corner to corner, a sqrt(2) pitch diagonal.
  const links = runs(generate(SQUARE), LINK)
  assert(links.length >= 3, `the square must link its rings, got ${links.length}`)
  const lengths = links.map(linkLength)
  assert(
    lengths.every((length) => length > 0 && length <= PITCH + 1e-6),
    `every link must be at most one pitch (${PITCH} mm), got ${lengths.map((l) => l.toFixed(3)).join(', ')}`,
  )
})

test('acceptance: the swept channel never leaves the pocket', () => {
  let totalLinks = 0
  const failures: string[] = []
  for (const shape of CONTAINMENT_SHAPES) {
    const moves = generate(shape)
    totalLinks += runs(moves, LINK).length
    const cuts = moves.filter((move) => move.kind === 'cut')
    const { clearance, at } = worstClearance(cuts, shape)
    if (clearance < -1e-6) {
      failures.push(`${shape.name}: cutter body ${(-clearance).toFixed(3)} mm into the part at (${at.x.toFixed(2)}, ${at.y.toFixed(2)})`)
    }
  }
  assert(totalLinks >= CONTAINMENT_SHAPES.length, `the fixtures must actually link, got ${totalLinks}`)
  assert(failures.length === 0, `links left the pocket:\n    ${failures.join('\n    ')}`)
})

test('a jump between branches of the tree retracts instead of linking', () => {
  // Both shapes split into one subtree per side. Finishing one side and
  // starting the other is not a ring-to-ring step: across the U the straight
  // line leaves the pocket, and across the notched slab it is 43 mm of orbit
  // where a retract and a helix are cheaper.
  for (const shape of [U_SHAPE, NOTCHED]) {
    const moves = generate(shape)
    const entries = runs(moves, ENTRY).length
    assert(entries >= 2, `${shape.name}: each branch must be entered on its own, got ${entries} entries`)
    const lengths = runs(moves, LINK).map(linkLength)
    assert(lengths.length > 0, `${shape.name}: each branch must still link its own rings`)
    assert(
      lengths.every((length) => length <= CHANNEL * 2 + 1e-9),
      `${shape.name}: no link may exceed two channels, got ${Math.max(...lengths).toFixed(3)} mm`,
    )
  }
})

test('a link turns the same way as the rings it joins', () => {
  // An outer ring and an island loop orbit in opposite senses. A link can turn
  // only one way, so joining them would reverse the tool mid-cut.
  let checked = 0
  for (const shape of [OFFSET_ISLAND, ...ISLAND_PAIRS]) {
    const pieces = cutPieces(generate(shape))
    pieces.forEach((piece, index) => {
      if (!piece.link) return
      const before = pieces[index - 1]
      const after = pieces[index + 1]
      assert(
        before?.stretch === piece.stretch && after?.stretch === piece.stretch,
        `${shape.name}: a link must have a ring on either side of it, at depth`,
      )
      const sense = Math.sign(turning(piece.moves))
      const senses = [Math.sign(turning(before.moves)), Math.sign(turning(after.moves))]
      assert(sense !== 0, `${shape.name}: a link must orbit`)
      assert(
        senses.every((other) => other === sense),
        `${shape.name}: a link turning ${sense} joins rings turning ${senses.join(' and ')}`,
      )
      checked += 1
    })
  }
  assert(checked > 0, 'the island fixtures must link some rings')
})

test('acceptance: a link cuts no harder than the orbit it joins', () => {
  for (const shape of [SQUARE, U_SHAPE]) {
    const moves = generate(shape)
    assert(runs(moves, LINK).length > 0, `${shape.name} must link`)
    const { link, other } = engagementByRole(moves)
    console.log(`      ${shape.name}: link p95 ${link.toFixed(3)} rad, orbit p95 ${other.toFixed(3)} rad`)
    assert(link <= other + 1e-9, `${shape.name}: link p95 ${link.toFixed(3)} is above the orbit's ${other.toFixed(3)}`)
  }
})

test('non-trochoidal patterns never carry a link', () => {
  for (const pocketPattern of ['offset', 'seeded_offset', 'parallel'] as const) {
    const moves = generate(OFFSET_ISLAND, { pocketPattern, stepover: 0.4 })
    assert(runs(moves, LINK).length === 0, `${pocketPattern} emitted a trochoidal link`)
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) throw new Error(`${failed} test(s) failed`)
