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
 * #1173: an around rough over a protected Hex follows the corners smoothly,
 * keeps its leave, and stays down between the corners.
 *
 * Frank's `bolt-test-02-x.camj` is built in code with the canned planner (a Ø2
 * in bar along X, a 1.5 in across-flats Hex over 0.75..1.25, a Ø1 Turn over
 * 1.2..3.75, the file's flat 1/4" endmill, stepovers and leaves), and the Turn's
 * rough and finish are generated through production `computeOperationToolpath`.
 *
 * Mutations this file is checked with (each applied, seen failing, restored):
 *   1. read the neighbour columns with the conservative cell read instead of the
 *      exact footprint (`exactTipRows` off in `prepareRotaryTargets`) -> the
 *      first ring's tips zigzag over the corners;
 *   2. sample the base grid on the mesh with the neighbours again -> the Hex
 *      raises the shank's lift at some angles and the shank tips spread;
 *   3. drop the same-ring gap feed (`feedThroughRingGaps` not called) -> the
 *      overlap rings lift to travel height between the corners;
 *   4. let the gap feed ignore the region -> the region gap is fed through;
 *   5. leave the neighbour columns out of `ringOnlyIndices` -> a helix band runs
 *      through them and the rough loses its leave beside the Hex;
 *   6. let the link rows share the base prep's workspace -> a ring-to-ring link
 *      reads the target alone and the finish cuts into the Hex;
 *   7. let `raiseShortAroundSegments` drop a point the chord passes under -> the
 *      merged path runs below an original sample.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryNeighbourOverlapJitter.test.ts
 */

import assert from 'node:assert/strict'
import { barCentre, barMaxRadius, barPivotZ } from '../../types/barStock'
import type { BarStock } from '../../types/project'
import { defaultTool, newProject, roundStock } from '../../types/project'
import type { Operation, Project, Tool } from '../../types/project'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { planRotarySolid } from '../../store/helpers/rotarySolids'
import type { SelectionState } from '../../store/types'
import { minRenderHeight } from '../csg'
import { computeOperationToolpath } from './generateOperation'
import { feedThroughRingGaps, raiseShortAroundSegments } from './rotaryModel'
import type { ToolpathMove, ToolpathPoint } from './types'
import { deepestCutterGouge } from '../../test/rotaryCutterGouge'

// ── fixture: Frank's bolt, in code ────────────────────────────────────────

const EMPTY_SELECTION = {
  mode: 'feature', selectedFeatureId: null, selectedFeatureIds: [], selectedTabIds: [],
  selectedClampIds: [], selectedNode: null, hoveredFeatureId: null, sketchEditTool: null,
  activeControl: null, groupFolderId: null,
} as unknown as SelectionState

const HEX_START = 0.75
const HEX_END = 1.25
const HEX_ACROSS_FLATS = 1.5
const TURN_START = 1.2
const TURN_LENGTH = 2.55
const TURN_DIAMETER = 1
const FLAT_TOOL_ID = 'flat-025'
const FLAT_RADIUS = 0.125
const ROUGH_LEAVE = 0.02
const MIN_HEIGHT = minRenderHeight('inch')

interface BoltFixture {
  readonly project: Project
  readonly turnId: string
}

function boltFixture(withHex = true): BoltFixture {
  const base = newProject('#1173 overlap', 'inch')
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 2
  base.stock = roundStock(2, 4, 'x')
  base.tools = [{
    ...defaultTool('inch', 1), id: FLAT_TOOL_ID, name: '1/4" Endmill', type: 'flat_endmill',
    diameter: 2 * FLAT_RADIUS, defaultStepover: 0.32, defaultStepdown: 0.125,
  }] as Tool[]
  base.setups.push({
    ...base.setups[0], id: 'around', name: 'Around', kind: 'around',
    orientation: { axis: 'x', angleDeg: 0 },
  })
  base.activeSetupId = 'around'
  const turn = planRotarySolid(base, EMPTY_SELECTION, {
    kind: 'turn', start: TURN_START, length: TURN_LENGTH, diameter: TURN_DIAMETER,
  })
  if (!turn.ok) throw new Error(`the Turn must plan: ${turn.reason}`)
  if (!withHex) return { project: turn.project, turnId: turn.created.featureId }
  const hex = planRotarySolid(turn.project, EMPTY_SELECTION, {
    kind: 'polygon', start: HEX_START, length: HEX_END - HEX_START, sides: 6,
    acrossFlats: HEX_ACROSS_FLATS, rotationDeg: 0,
  })
  if (!hex.ok) throw new Error(`the Hex must plan: ${hex.reason}`)
  return { project: hex.project, turnId: turn.created.featureId }
}

function turnOperation(project: Project, turnId: string, kind: 'rotary_rough' | 'rotary_finish'): Operation {
  return {
    ...defaultOperationForTarget(
      project, kind, kind === 'rotary_rough' ? 'rough' : 'finish',
      { source: 'features', featureIds: [turnId] }, project.operations.length + 1,
    ),
    setupId: 'around',
    rotaryPassDirection: 'around',
    name: kind === 'rotary_rough' ? 'Rotary rough 2' : 'Rotary finish 2',
    toolRef: FLAT_TOOL_ID,
    stepover: 0.32,
    stepdown: 0.125,
    stockToLeaveRadial: kind === 'rotary_rough' ? ROUGH_LEAVE : 0,
  }
}

function generate(project: Project, operation: Operation): ToolpathMove[] {
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, `${operation.name} dispatches to the rotary generator`)
  return envelope.result.moves
}

/** How far inside the Hex prism (grown by `grow`) a point lies; positive is inside. */
function hexDepth(stock: BarStock, grow: number) {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const apothem = HEX_ACROSS_FLATS / 2 + grow
  return (along: number, across: number, up: number): number => {
    if (along < HEX_START || along > HEX_END) return Number.NEGATIVE_INFINITY
    let largest = Number.NEGATIVE_INFINITY
    for (let k = 0; k < 6; k++) {
      const angle = (k * Math.PI) / 3
      largest = Math.max(largest, Math.sin(angle) * (across - centre) + Math.cos(angle) * (up - pivot))
    }
    return Math.min(apothem - largest, along - HEX_START, HEX_END - along)
  }
}

let failures = 0
function check(name: string, run: () => void): void {
  try {
    run()
    console.log(`ok   ${name}`)
  } catch (error) {
    failures += 1
    console.error(`FAIL ${name}`)
    console.error(`     ${error instanceof Error ? error.message.split('\n').join('\n     ') : String(error)}`)
  }
}

const bolt = boltFixture()
const stock = bolt.project.stock as BarStock
const pivot = barPivotZ(stock)
const rough = generate(bolt.project, turnOperation(bolt.project, bolt.turnId, 'rotary_rough'))
const finish = generate(bolt.project, turnOperation(bolt.project, bolt.turnId, 'rotary_finish'))
const tipOf = (point: ToolpathPoint): number => point.z - pivot
const isAround = (move: ToolpathMove): boolean => move.kind === 'cut' && move.from.x === move.to.x
  && move.from.a !== undefined && move.to.a !== undefined && move.from.a !== move.to.a

// ── 1. the first ring follows each corner as one smooth bump ──────────────

check('the first overlap ring rises and falls once over each corner, with no zigzag', () => {
  // The band's first ring is one cutter radius inside the Turn's start, so its
  // body reaches the Hex's end; on the first layer only the corners stand above
  // the layer radius. Its tips over each corner must climb, then descend -- the
  // conservative read made them alternate by up to 0.009 in between degrees.
  const ring = TURN_START + FLAT_RADIUS
  const firstLayer = rough.filter((move) => isAround(move) && Math.abs(move.to.x - ring) < 1e-6
    && (move.to.a ?? 0) <= 360 + 1e-9)
  assert.ok(firstLayer.length > 6, `the first ring is emitted (${firstLayer.length} moves)`)
  const layerRadius = Math.min(...firstLayer.map((move) => tipOf(move.to)))
  // Group the tips into bumps: consecutive points above the layer radius.
  const bumps: number[][] = []
  let current: number[] = []
  for (const move of firstLayer) {
    const tip = tipOf(move.to)
    if (tip > layerRadius + 1e-6) current.push(tip)
    else if (current.length > 0) { bumps.push(current); current = [] }
  }
  if (current.length > 0) bumps.push(current)
  assert.equal(bumps.length, 6, `one bump per Hex corner, found ${bumps.length}`)
  const corner = HEX_ACROSS_FLATS / Math.sqrt(3) + ROUGH_LEAVE
  for (const [b, bump] of bumps.entries()) {
    const peak = bump.indexOf(Math.max(...bump))
    for (let i = 1; i <= peak; i++) {
      assert.ok(bump[i] >= bump[i - 1] - 1e-6, `bump ${b} falls on its way up at point ${i}: ${bump.join(', ')}`)
    }
    for (let i = peak + 1; i < bump.length; i++) {
      assert.ok(bump[i] <= bump[i - 1] + 1e-6, `bump ${b} rises on its way down at point ${i}: ${bump.join(', ')}`)
    }
    // The peak is the corner plus the leave, as the exact footprint reads it --
    // not the 0.004..0.012 in above it the conservative read put there.
    assert.ok(Math.abs(bump[peak] - corner) < 0.0005, `bump ${b} peaks at ${bump[peak]}, the corner + leave is ${corner}`)
  }
})

// ── 2. a neighbour the cutter cannot reach leaves the shank alone ─────────

check('the shank tips do not change with a neighbour the shank columns cannot reach', () => {
  // Every shank column is out of the Hex's reach, so it must cut exactly the
  // tips it cuts with no Hex at all. Before #1173 the Hex's facets raised the
  // per-angle lift for A280..284 along the whole shank (0.0193 in, against
  // 0.0090 elsewhere): a 0.24 mm step on every helix turn.
  const shank = (moves: readonly ToolpathMove[]): Map<string, number> => {
    const tips = new Map<string, number>()
    for (const move of moves) {
      if (move.kind !== 'cut' || Math.min(move.from.x, move.to.x) < 2) continue
      tips.set(`${move.to.x.toFixed(6)}@${(((move.to.a ?? 0) % 360) + 360) % 360}`, tipOf(move.to))
    }
    return tips
  }
  const plain = boltFixture(false)
  const without = shank(generate(plain.project, turnOperation(plain.project, plain.turnId, 'rotary_rough')))
  const withHex = shank(rough)
  assert.ok(withHex.size > 100, `the shank is cut (${withHex.size} points)`)
  // The final layer's spread on the shank: the Turn plus the leave, flat.
  const lowest = [...withHex.values()].filter((tip) => tip < 0.6)
  const spread = Math.max(...lowest) - Math.min(...lowest)
  assert.ok(spread <= 0.001, `the shank's final tips spread over ${spread.toFixed(5)} in`)
  let compared = 0
  for (const [key, tip] of withHex) {
    const plainTip = without.get(key)
    if (plainTip === undefined) continue
    compared++
    assert.ok(Math.abs(plainTip - tip) < 1e-9, `the shank at ${key} cuts ${tip}, without the Hex ${plainTip}`)
  }
  assert.ok(compared > 100, `the two runs share shank points (${compared})`)
})

// ── 3. the overlap rings stay down between the corners ────────────────────

check('the overlap rings feed past the corners instead of lifting to travel height', () => {
  const top = barMaxRadius(stock)
  let breaks = 0
  for (let i = 0; i < rough.length; i++) {
    const up = rough[i]
    if (!(tipOf(up.to) >= top - 1e-9 && tipOf(up.from) < top - 1e-9 && up.from.x === up.to.x)) continue
    let j = i + 1
    while (j < rough.length && tipOf(rough[j].to) >= top - 1e-9) j++
    if (j < rough.length && rough[j].to.x === up.from.x && rough[j].to.a !== up.from.a) breaks++
  }
  assert.equal(breaks, 0, `${breaks} lift(s) to travel height inside a ring`)
})

check('the gap feed only crosses air that an earlier layer cleared, inside the region', () => {
  const angles = [0, 10, 20, 30, 40, 50]
  const point = (alongValue: number, tip: number, angle: number): ToolpathPoint => ({ x: alongValue, y: 0, z: tip, a: angle })
  const tips = angles.map((_, k) => [k === 2 || k === 3 ? 0.9 : 0.8])
  const make = (): (ToolpathPoint | null)[] => angles.map((angle, k) => (k === 2 || k === 3 ? null : point(1, 0.8, angle)))
  // Plain air between two runs: fed at the samples' own tips.
  const fed = make()
  feedThroughRingGaps(fed, tips, 0, angles, 0.875, 1, null, 1, point)
  assert.deepEqual(fed.map((sample) => sample?.z ?? null), [0.8, 0.8, 0.9, 0.9, 0.8, 0.8])
  // Outside the region: no layer cut there, so the gap stays a retract.
  const region = make()
  feedThroughRingGaps(region, tips, 0, angles, 0.875, 1, (_, angle) => angle !== 30, 1, point)
  assert.equal(region[3], null, 'a gap sample outside the region is fed')
  // At the blank's own radius, or with no model under the tool, it stays too.
  const blank = make()
  feedThroughRingGaps(blank, angles.map((_, k) => [k === 2 ? 1 : 0.9]), 0, angles, 0.875, 1, null, 1, point)
  assert.equal(blank[2], null, 'a gap at the blank radius is fed')
  const empty = make()
  feedThroughRingGaps(empty, angles.map((_, k) => [k === 3 ? NaN : 0.9]), 0, angles, 0.875, 1, null, 1, point)
  assert.equal(empty[3], null, 'a gap with no model under the tool is fed')
  // Wider than MAX_LINK_ACROSS_DEG: still a retract.
  const wide = [0, 10, 40, 70, 80]
  const wideSamples: (ToolpathPoint | null)[] = wide.map((angle, k) => (k === 2 ? null : point(1, 0.8, angle)))
  feedThroughRingGaps(wideSamples, wide.map(() => [0.9]), 0, wide, 0.875, 1, null, 1, point)
  assert.equal(wideSamples[2], null, 'a 60 degree gap is fed')
})

// ── 4. the leave and the Hex are kept everywhere ──────────────────────────

check('no move of the rough enters the Hex grown by its leave, and no finish move enters the Hex', () => {
  for (const [label, moves, grow] of [['rough', rough, ROUGH_LEAVE], ['finish', finish, 0]] as const) {
    const report = deepestCutterGouge(moves, stock, { radius: FLAT_RADIUS, type: 'flat' }, hexDepth(stock, grow))
    assert.ok(
      report.depth <= MIN_HEIGHT,
      `${label}: the cutter body is ${report.depth.toFixed(5)} in inside the Hex (+${grow}) at ${report.where}`,
    )
  }
})

// ── 5. the upward-only merge never cuts below a sample ────────────────────

check('raiseShortAroundSegments keeps every original sample at or under the merged path', () => {
  const cut = (from: ToolpathPoint, to: ToolpathPoint): ToolpathMove => ({ kind: 'cut', from, to })
  const at = (a: number, z: number): ToolpathPoint => ({ x: 2, y: 1, z, a })
  // A run with 0.25 degree steps around a dip and a bump.
  const zs = [1.5, 1.5004, 1.5, 1.5004, 1.5012, 1.5004, 1.5, 1.5004, 1.5]
  const points = zs.map((z, i) => at(i * 0.25, z))
  const moves = points.slice(1).map((point, i) => cut(points[i], point))
  const raise = 0.0008
  // A 1 degree base grid: every 0.25 degree step was inserted by the refinement.
  const merged = raiseShortAroundSegments(moves, 1, raise, 1e-6)
  assert.ok(merged.length < moves.length, `the short steps merge (${merged.length} of ${moves.length})`)
  for (const original of points) {
    const seg = merged.find((move) => (move.from.a ?? 0) <= (original.a ?? 0) + 1e-12 && (move.to.a ?? 0) >= (original.a ?? 0) - 1e-12)
    assert.ok(seg, `a merged move spans A${original.a}`)
    const f = ((original.a ?? 0) - (seg.from.a ?? 0)) / ((seg.to.a ?? 0) - (seg.from.a ?? 0))
    const z = seg.from.z + (seg.to.z - seg.from.z) * f
    assert.ok(z >= original.z - 1e-12, `the merged path runs ${(original.z - z).toFixed(6)} below the sample at A${original.a}`)
    assert.ok(z - original.z <= raise + 1e-12, `the merged path rises ${(z - original.z).toFixed(6)} over the sample at A${original.a}`)
  }
  // The bump's top is a sample the chord would pass under, so it stays.
  assert.ok(merged.some((move) => move.to.z === 1.5012), 'the bump top was dropped')
  // Steps of the base grid itself are left exactly as they were.
  const grid = raiseShortAroundSegments(moves, 0.25, raise, 1e-6)
  assert.deepEqual(grid, moves, 'steps of the base grid changed')
})

if (failures > 0) {
  console.error(`rotaryNeighbourOverlapJitter.test.ts: ${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('rotaryNeighbourOverlapJitter.test.ts: all checks passed')
}
