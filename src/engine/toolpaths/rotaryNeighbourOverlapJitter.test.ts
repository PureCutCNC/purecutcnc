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
 *   5. leave the neighbour columns out of `ringOnlyIndices` -> a helix band
 *      starts at the column the Hex's sampling cell reaches (along 1.4032
 *      instead of 1.4815) and resamples those poses on the target-only base
 *      prep;
 *   6. let the link rows share the base prep's workspace -> a ring-to-ring link
 *      reads the target alone and the finish cuts into the Hex;
 *   7. let `raiseShortAroundSegments` drop a point the chord passes under -> the
 *      merged path runs below an original sample;
 *   8. read the helix's rows with the conservative cell rise again
 *      (`readExactRows` off in `continuousRoughInput`/`continuousFinishInput`)
 *      -> the last rough layer and the finish ride a whole height-map cell
 *      above the wall-foot ring they close onto, and their Z moves with the
 *      cell alignment from angle to angle;
 *   9. plan the last layer's floor from the ring grid again (`floorPrep` not
 *      built in `prepareRotaryTargets`) -> the no-Hex control's deepest layer
 *      rides one conservative cell high (0.529432 against 0.519990 in) and the
 *      unfiltered with/without-Hex comparison fails.
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

/** The Hex's facet normals: `sin/cos` of `k * 60°` from +up at rotation 0. */
const HEX_NORMALS = Array.from({ length: 6 }, (_, k) => {
  const angle = k * Math.PI / 3
  return { across: Math.sin(angle), up: Math.cos(angle) }
})

/** The distance from a cross-section point to the Hexagon with `apothem`, 0 inside. */
function hexagonDistance(across: number, up: number, apothem: number): number {
  let largest = Number.NEGATIVE_INFINITY
  for (const normal of HEX_NORMALS) largest = Math.max(largest, normal.across * across + normal.up * up)
  if (largest <= apothem) return 0
  const corner = apothem / Math.cos(Math.PI / 6)
  const vertices = Array.from({ length: 6 }, (_, k) => {
    const angle = Math.PI / 6 + k * Math.PI / 3
    return { across: corner * Math.sin(angle), up: corner * Math.cos(angle) }
  })
  let nearest = Number.POSITIVE_INFINITY
  for (let k = 0; k < 6; k++) {
    const a = vertices[k]
    const b = vertices[(k + 1) % 6]
    const dx = b.across - a.across
    const dy = b.up - a.up
    const t = Math.min(1, Math.max(0, ((across - a.across) * dx + (up - a.up) * dy) / (dx * dx + dy * dy)))
    nearest = Math.min(nearest, Math.hypot(across - a.across - t * dx, up - a.up - t * dy))
  }
  return nearest
}

/**
 * How far inside the Hex prism's **rounded** offset by `grow` a point lies, in
 * project units; positive is inside.
 *
 * The sampler applies the rough's leave as a distance -- the tool enlarged by
 * it, then added back at the tip -- so over a corner the leave is a rounded
 * offset (#1173, the same definition the #1155 neighbour suites use). Pushing
 * each facet out instead keeps a sharp corner `grow * (1 / cos 30° - 1)`
 * further out (0.062 mm at 0.4 mm), which only the old over-read cleared: the
 * exact footprint read these columns take is tangent to the rounded offset, so
 * the sharp hexagon would report 0.0006 in of gouge on every corner. Inside the
 * prism the depth is to the nearest face (facets and the two end faces) plus
 * the leave; outside it is the leave less the Euclidean distance to the prism.
 */
function hexDepth(stock: BarStock, grow: number) {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const apothem = HEX_ACROSS_FLATS / 2
  return (along: number, across: number, up: number): number => {
    const x = across - centre
    const y = up - pivot
    const radial = hexagonDistance(x, y, apothem)
    const axial = Math.max(HEX_START - along, along - HEX_END, 0)
    if (radial === 0 && axial === 0) {
      let largest = Number.NEGATIVE_INFINITY
      for (const normal of HEX_NORMALS) largest = Math.max(largest, normal.across * x + normal.up * y)
      return grow + Math.min(apothem - largest, along - HEX_START, HEX_END - along)
    }
    return grow - Math.hypot(radial, axial)
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
  // Every corner gets its own angular window: between two of them the tip is the
  // layer radius only to within 0.0001 in (the exact read is not perfectly flat
  // there), so thresholding at the layer radius would join neighbouring bumps.
  const corner = HEX_ACROSS_FLATS / Math.sqrt(3) + ROUGH_LEAVE
  for (let k = 0; k < 6; k++) {
    const at = 30 + 60 * k
    const bump = firstLayer
      .filter((move) => Math.abs((((move.to.a ?? 0) - at + 540) % 360) - 180) <= 15)
      .sort((a, b) => (a.to.a ?? 0) - (b.to.a ?? 0))
      .map((move) => tipOf(move.to))
    assert.ok(bump.length > 3, `corner ${at}: its window is cut (${bump.length} moves)`)
    const peak = bump.indexOf(Math.max(...bump))
    for (let i = 1; i <= peak; i++) {
      assert.ok(bump[i] >= bump[i - 1] - 1e-6, `corner ${at} falls on its way up at point ${i}: ${bump.join(', ')}`)
    }
    for (let i = peak + 1; i < bump.length; i++) {
      assert.ok(bump[i] <= bump[i - 1] + 1e-6, `corner ${at} rises on its way down at point ${i}: ${bump.join(', ')}`)
    }
    // The peak is the corner plus the leave, as the exact footprint reads it --
    // not the 0.004..0.012 in above it the conservative read put there.
    assert.ok(Math.abs(bump[peak] - corner) < 0.0005, `corner ${at} peaks at ${bump[peak]}, the corner + leave is ${corner}`)
  }
})

// ── 2. a neighbour the cutter cannot reach leaves the shank alone ─────────

/**
 * The shank's helix poses, in project units above the pivot.
 *
 * A helix move advances along while it turns. With the exact read the whole
 * shank's helix is one level, so `mergeCollinearCuts` joins its turns into one
 * straight move in `(x, A, z)` -- its two ends are the only pose values the
 * emitted program still carries, and they are enough: the level *is* the
 * property.
 */
function shankHelixTips(moves: readonly ToolpathMove[]): number[] {
  // The move reaches the shank: a helix that spans the whole Turn qualifies (its
  // band starts at the Turn's own start when no neighbour is there), a ring does
  // not (it does not change along).
  return moves
    .filter((move) => move.kind === 'cut' && move.from.a !== undefined
      && Math.abs(move.to.x - move.from.x) > 1e-9
      && Math.min(move.from.x, move.to.x) < 3.6
      && Math.max(move.from.x, move.to.x) > 1.6)
    .flatMap((move) => [tipOf(move.from), tipOf(move.to)])
}

/** The distinct Z levels the shank's helix cuts at, ascending. */
function shankHelixLevels(moves: readonly ToolpathMove[]): string[] {
  return [...new Set(shankHelixTips(moves).map((tip) => tip.toFixed(6)))].sort((a, b) => Number(a) - Number(b))
}

check('the shank helix cuts the same levels with and without a neighbour it cannot reach', () => {
  // Every shank column is out of the Hex's reach, so it must cut exactly the
  // tips it cuts with no Hex at all. Before #1173 the Hex's facets raised the
  // per-angle lift for A280..284 along the whole shank (0.0193 in, against
  // 0.0090 elsewhere): a 0.24 mm step on every helix turn.
  const plain = boltFixture(false)
  const plainRough = shankHelixLevels(generate(plain.project, turnOperation(plain.project, plain.turnId, 'rotary_rough')))
  const plainFinish = shankHelixLevels(generate(plain.project, turnOperation(plain.project, plain.turnId, 'rotary_finish')))
  const withRough = shankHelixLevels(rough)
  const withFinish = shankHelixLevels(finish)
  assert.ok(withRough.length >= 4, `the rough helices the shank at its layers (${withRough.join(', ')})`)
  assert.deepEqual(withFinish, plainFinish, 'the finish shank helix changes with a neighbour it cannot reach')
  // The rough's **layer radii** are planned from the exact footprint minimum at
  // the target's own along grid (`exactLayerFloor`), so the deepest layer is
  // the Turn plus the leave in both runs. The conservative ring grid used to
  // plan it one cell high (0.529432 against 0.519990 in), and the Hex run's
  // wall-foot column -- read exactly -- pulled its own floor down instead, so
  // the two runs' deepest layers differed by 0.24 mm even though the neighbour
  // reaches no shank column. Every level compares now, the deepest included.
  assert.deepEqual(withRough, plainRough,
    `the rough's layers are the same with and without the Hex (${withRough.join(', ')} / ${plainRough.join(', ')})`)
  // One level per pass: the conservative read drifted by the cell alignment from
  // angle to angle (0.50915..0.51010 in on the finish), and each drift was a
  // separate emitted move.
  assert.equal(withFinish.length, 1, `the finish's shank helix is one level (${withFinish.join(', ')})`)
})

// ── 2b. the last rough layer and the finish sit on the target + leave ─────

check('the last rough layer and the finish helix sit level with the wall-foot ring', () => {
  // The cut that clears the Hex wall is the wall-foot ring: one ring at
  // `face + leave + radius`, read on the target's own surface, so its tip is the
  // Turn plus the leave. The helix that closes onto it must sit at that same
  // level along the whole shank, not one conservative height-map cell above it
  // with a Z that drifts by the cell alignment from angle to angle (the last
  // retest: 0.52943..0.53010 in on the rough's last layer against the ring's
  // 0.51999, and 0.50915..0.51010 on the finish against 0.49999).
  const footAt = (leave: number): number => HEX_END + leave + FLAT_RADIUS
  const footLevel = (moves: readonly ToolpathMove[], leave: number): number => {
    const ring = footAt(leave)
    const tips = moves
      .filter((move) => isAround(move) && Math.abs(move.to.x - ring) < 1e-6)
      .map((move) => tipOf(move.to))
    assert.ok(tips.length > 0, `the wall-foot ring at ${ring} is cut (${tips.length} moves)`)
    return Math.min(...tips)
  }
  const target = TURN_DIAMETER / 2

  // The finish cuts to the model itself: every shank pose is the Turn's surface.
  const finishFoot = footLevel(finish, 0)
  assert.ok(Math.abs(finishFoot - target) < 0.0005, `the finish wall-foot ring is ${finishFoot}, the Turn is ${target}`)
  const finishShank = shankHelixTips(finish)
  assert.ok(finishShank.length > 1, `the finish helices the shank (${finishShank.length} poses)`)
  const finishSpread = Math.max(...finishShank) - Math.min(...finishShank)
  assert.ok(finishSpread <= 1e-9,
    `the finish's shank helix Z is one level (spread ${finishSpread.toFixed(6)} in)`)
  // The helix reads the target-and-stubs mesh; the foot ring reads the target
  // alone at its own along position. Both are the exact surface of the same
  // cylinder, so they agree to the last Float32 bit the sampler stores, not to a
  // bit of double arithmetic.
  assert.ok(Math.abs(finishShank[0] - finishFoot) <= 1e-6,
    `the finish helix sits at ${finishShank[0]} in, its wall-foot ring at ${finishFoot} in`)

  // The rough's last layer is the lowest level it cuts on the shank, and it is
  // the same Turn plus leave the wall-foot ring reaches.
  const roughFoot = footLevel(rough, ROUGH_LEAVE)
  assert.ok(Math.abs(roughFoot - (target + ROUGH_LEAVE)) < 0.0005,
    `the rough wall-foot ring is ${roughFoot}, the Turn plus the leave is ${target + ROUGH_LEAVE}`)
  const roughShank = shankHelixTips(rough)
  assert.ok(roughShank.length >= 8, `the rough helices the shank (${roughShank.length} poses)`)
  const lastLayer = Math.min(...roughShank)
  assert.ok(Math.abs(lastLayer - roughFoot) <= 1e-6,
    `the rough's last helix layer sits at ${lastLayer} in, its wall-foot ring at ${roughFoot} in`)
  // Every shank pose is that last layer or a layer's own radius (the floor the
  // rough cuts at above it): the conservative read put a third kind of value
  // there, a cell above the surface at every angle.
  const layers = new Set(roughShank.map((tip) => tip.toFixed(6)))
  for (const level of layers) {
    const value = Number(level)
    assert.ok(Math.abs(value - lastLayer) <= 1e-6 || value - lastLayer >= 0.1 - 1e-6,
      `the rough's shank helix cuts at ${value} in, between the last layer ${lastLayer} and the next ${lastLayer + 0.1}`)
  }

  // The neighbour does not reach a shank column, so the same program without the
  // Hex cuts the same levels -- the deepest layer included. The helix reads
  // exact rows and the layer floor is the exact target minimum at the target's
  // own along grid in both runs (`exactLayerFloor`), so nothing here depends on
  // the Hex: no filtering by depth.
  const plain = boltFixture(false)
  const plainFinish = generate(plain.project, turnOperation(plain.project, plain.turnId, 'rotary_finish'))
  const plainRough = generate(plain.project, turnOperation(plain.project, plain.turnId, 'rotary_rough'))
  assert.deepEqual(shankHelixTips(plainFinish), finishShank, 'the finish shank helix is the same without the Hex')
  assert.deepEqual(shankHelixTips(plainRough), roughShank, 'the rough shank helix is the same without the Hex')
  console.log(`  shank helix: finish ${finishShank[0].toFixed(5)} in, `
    + `rough last layer ${lastLayer.toFixed(5)} in (wall-foot rings ${finishFoot.toFixed(5)} / ${roughFoot.toFixed(5)})`)
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

// ── 4. a column the neighbour can reach is its own ring ───────────────────

check('no helix band starts, ends or runs through a column the Hex can reach', () => {
  // A neighbour-reach column carries the exact footprint read on the mesh **with**
  // the neighbours, while a helix band resamples every pose of its turn on the
  // base prep (the target and stubs only). A band over such a column would read
  // the Turn where the Hex stands, so the columns are cut as their own rings
  // (`ringOnlyIndices`). The reach is the sampling tool's radius plus the cell it
  // asks for -- `rotaryOperation.ts` sets that cell to
  // `min(tool.radius / 3, stepover / 2)`, the same expression the fixture's
  // operation carries -- so the check is the rule, not a recorded position.
  const cell = Math.min(FLAT_RADIUS / 3, 0.32 / 2)
  const reachLow = HEX_START - (FLAT_RADIUS + cell)
  const reachHigh = HEX_END + (FLAT_RADIUS + cell)
  for (const [label, moves] of [['rough', rough], ['finish', finish]] as const) {
    const bands = moves.filter((move) => move.kind === 'cut'
      && Math.abs((move.from.a ?? 0) - (move.to.a ?? 0)) > 0
      && Math.abs(move.from.x - move.to.x) > 1e-9
      && Math.max(move.from.x, move.to.x) >= reachLow
      && Math.min(move.from.x, move.to.x) <= reachHigh)
    assert.equal(bands.length, 0,
      `${label}: ${bands.length} helix move(s) inside the Hex's reach, first at along ${bands[0]?.from.x.toFixed(4)}`)
  }
})

// ── 5. the leave and the Hex are kept everywhere ──────────────────────────

check('no move of the rough enters the Hex grown by its leave, and no finish move enters the Hex', () => {
  for (const [label, moves, grow] of [['rough', rough, ROUGH_LEAVE], ['finish', finish, 0]] as const) {
    const report = deepestCutterGouge(moves, stock, { radius: FLAT_RADIUS, type: 'flat' }, hexDepth(stock, grow))
    assert.ok(
      report.depth <= MIN_HEIGHT,
      `${label}: the cutter body is ${report.depth.toFixed(5)} in inside the Hex (+${grow}) at ${report.where}`,
    )
  }
})

// ── 6. the upward-only merge never cuts below a sample ────────────────────

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
