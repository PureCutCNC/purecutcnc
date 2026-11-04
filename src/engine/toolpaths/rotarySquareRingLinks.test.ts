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
 * #1117 (square links): a square blank's around rough links its **whole** and
 * **model-split** rings at the layer, not only its corner arcs.
 *
 * Frank's busto-rect rough (square blank, no region) retracted between rings on
 * every layer below the corner layers. The at-layer candidate required each
 * transition to be a corner-arc boundary of the touch gate -- the sample just
 * outside the ring's run had to be one the gate no longer cuts -- and a complete
 * ring's end (A0/A360) or a run the **model** ends never is one. Without a region
 * that rule is now a choice of bound, not a refusal: a link that is not a gate
 * boundary may take one stepdown from the material it meets (the earlier layers'
 * envelope, and the ring it starts from), with no scallop or cell allowance.
 * The independent proof is `squareAroundGenerator.property.test.ts`; this file
 * pins the shapes and the fallbacks.
 *
 * Mutations, each failing here (see the slice report for the measured run):
 *  - the touch-gate rule restored as a refusal -> no whole-ring links;
 *  - `MAX_LINK_ACROSS_DEG` lifted -> a >45 deg ring transition is cut low;
 *  - the skipped-ring guards removed -> a link spans an empty ring;
 *  - the at-layer budget unbounded, charged per window instead of per new row,
 *    or shared with the raised link -> the exhaustion fixture's layers move.
 *  - the per-link row cap back to 64 -> the dense grid's widest drift drops to
 *    7.4 deg;
 *  - the link-row sample budgets shared -> the raised path gets no row once the
 *    at-layer rows have spent theirs.
 */

import assert from 'node:assert/strict'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { squareRotaryTouchRadius } from './squareRotaryStock'
import type { BarStock } from '../../types/project'
import { generateRotaryRough, linkRowBudget } from './rotaryModel'
import type { RotaryLinkRow, RotaryModelMesh } from './rotaryModel'
import type { NormalizedTool, ToolpathMove } from './types'

const BALL2: NormalizedTool = {
  id: 'ball-2', name: '2 mm ball nose', sourceUnits: 'mm', units: 'mm',
  type: 'ball_endmill', diameter: 2, radius: 1, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}
const BALL4: NormalizedTool = { ...BALL2, id: 'ball-4', name: '4 mm ball nose', diameter: 4, radius: 2 }

/** A closed surface whose radius varies along the bar and with the angle. */
function shaped(
  stock: BarStock,
  radiusAt: (along: number, aDeg: number) => number,
  from: number,
  to: number,
  steps: number,
  segments: number,
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (let s = 0; s <= steps; s++) {
    const along = from + (to - from) * s / steps
    for (let j = 0; j < segments; j++) {
      const aDeg = 360 * j / segments
      const t = (aDeg + 90) * Math.PI / 180
      const radius = radiusAt(along, aDeg)
      if (stock.axis === 'x') positions.push(along, centre + radius * Math.cos(t), pivot + radius * Math.sin(t))
      else positions.push(centre + radius * Math.cos(t), along, pivot + radius * Math.sin(t))
    }
  }
  for (let s = 0; s < steps; s++) {
    for (let j = 0; j < segments; j++) {
      const j2 = (j + 1) % segments
      const a = s * segments + j
      const b = s * segments + j2
      const c = (s + 1) * segments + j2
      const d = (s + 1) * segments + j
      index.push(a, b, c, a, c, d)
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/** A closed surface of revolution, one ring per entry. */
function revolved(stock: BarStock, rings: readonly { along: number; radius: number }[], segments: number): RotaryModelMesh {
  return shaped(stock, (along) => {
    for (let i = 0; i + 1 < rings.length; i++) {
      const a = rings[i]
      const b = rings[i + 1]
      if (along >= a.along && along <= b.along) {
        return a.radius + (b.radius - a.radius) * (along - a.along) / (b.along - a.along)
      }
    }
    return rings[rings.length - 1].radius
  }, rings[0].along, rings[rings.length - 1].along, rings.length - 1, segments)
}

/**
 * Block 1's model: a twisted lobe on a 3 mm base, two humps along the bar and a
 * 5.5 mm collar in the middle; the crest turns `twist` degrees per millimetre.
 */
function lobeRadiusAt(length: number, twist: number): (along: number, aDeg: number) => number {
  return (along, aDeg) => {
    const collar = along > length / 2 - 0.6 && along < length / 2 + 0.6 ? 5.5 : 0
    let delta = ((aDeg - twist * along) % 360 + 360) % 360
    if (delta > 180) delta -= 360
    const u = Math.abs(delta)
    if (u >= 70) return Math.max(3, collar)
    const c = Math.cos(u * Math.PI / 140)
    const humps = 0.5 - 0.5 * Math.cos(2 * Math.PI * 2 * along / length)
    return Math.max(3 + 2.4 * humps * c * c, collar)
  }
}

const alongOf = (point: ToolpathMove['from']): number => point.x
/** An at-layer link: a cut that moves along the bar (ring cuts keep along fixed). */
const isAtLayerLink = (move: ToolpathMove): boolean => move.kind === 'cut' && alongOf(move.to) > alongOf(move.from) + 1e-12
/** A commanded angle on the physical seam: a whole turn, however many turns in. */
const isSeam = (angle: number | undefined): boolean => {
  if (angle === undefined) return false
  const wrapped = ((angle % 360) + 360) % 360
  return wrapped < 1e-9 || 360 - wrapped < 1e-9
}

/** The layers of an around rough: each ends with the rapid back along the bar. */
function layersOf(moves: readonly ToolpathMove[]): ToolpathMove[][] {
  const layers: ToolpathMove[][] = [[]]
  for (const move of moves) {
    if (move.kind === 'rapid' && alongOf(move.to) < alongOf(move.from) - 1e-9) layers.push([])
    else layers[layers.length - 1].push(move)
  }
  return layers
}

// ---------------------------------------------------------------------------
// 1. A busto-rect-like square: a small model inside a square blank. A twisted
//    lobe on a base well inside the inscribed radius, two lobes along the bar
//    and a collar in the middle. The upper layers cut corner arcs, the middle
//    ones whole rings, the lower ones rings the lobe splits (run ends drifting
//    with along, so A-changing links), and the collar empties the rings over it
//    on the lowest layers (skipped rings).
// ---------------------------------------------------------------------------

console.log('Testing that a square blank links whole and model-split rings at the layer...')
{
  const side = 14
  const length = 8
  const stock = squareStock(side, length, 'x', { x: 0, y: 0 })
  const pivot = barPivotZ(stock)
  const radiusAt = lobeRadiusAt(length, 7)
  const rough = generateRotaryRough('square-ring-links', shaped(stock, radiusAt, 0, length, 80, 240), stock, BALL2, {
    stepover: 0.6, sampleSpacing: 0.6, stockToLeave: 0, alongStart: 0, alongEnd: length,
    safeRadius: barMaxRadius(stock) * 2, requestedCellSize: 0.25, stepdown: 1.5, passDirection: 'around',
  }, {})
  assert.deepEqual(rough.warnings, [], 'the rough has no warning')
  const ringAlong = [...new Set(rough.moves
    .filter((move) => move.kind === 'cut' && alongOf(move.from) === alongOf(move.to) && move.from.a !== move.to.a)
    .map((move) => alongOf(move.from)))].sort((a, b) => a - b)
  const ringSpacing = ringAlong[1] - ringAlong[0]
  const links = rough.moves.filter(isAtLayerLink)
  const whole = links.filter((move) => move.from.a === move.to.a && isSeam(move.from.a))
  const split = links.filter((move) => move.from.a === move.to.a && !isSeam(move.from.a))
  const across = links.filter((move) => move.from.a !== move.to.a)

  // Complete rings below the inscribed radius join at A0/A360. The touch-gate
  // rule refused every one: the neighbour of a whole ring's end is cut.
  assert.ok(whole.length > 0, `whole rings link at A0/A360 (${whole.length})`)
  for (const link of whole) {
    assert.equal(link.to.a, link.from.a, 'a whole-ring link keeps its angle')
    assert.ok(link.from.z - pivot <= barMaxRadius(stock), 'a whole-ring link is a cut below the blank')
  }
  // #1103 slice ca-d: every ring turns A the same way now, so a ring's first
  // cut is its arc's leading boundary and the next ring's start is a full turn
  // further on. A transition that shares an angle is therefore only ever the
  // **seam** (`whole` above); a model-split ring's boundary is an A-changing
  // transition, and `split` (an equal-angle link off the seam) is gone.
  assert.equal(split.length, 0,
    `no equal-angle link is off the seam once A is one-way (${split.length})`)
  // A drift the proof still covers (at most 45 deg) links across the A change.
  assert.ok(across.length > 0, `adjacent model-split rings link across an A change (${across.length})`)
  for (const link of across) {
    const drift = Math.abs((link.to.a ?? 0) - (link.from.a ?? 0))
    if (drift <= 45 + 1e-9) continue
    // Wider than the drift proof: only a square blank's gate **air sector** may
    // keep the link, and then it rides at the layer through the middle of the
    // gap (the blank stands below it there). See #1103 slice ca-d.
    const middle = ((link.from.a ?? 0) + (link.to.a ?? 0)) / 2
    const wrapped = ((middle % 360) + 360) % 360
    const height = Math.min(link.from.z, link.to.z) - pivot
    assert.ok(squareRotaryTouchRadius(stock, wrapped, BALL2.radius, BALL2.type) < height + 1e-6,
      `a wide A-changing link rides the gate's air sector (${squareRotaryTouchRadius(stock, wrapped, BALL2.radius, BALL2.type).toFixed(3)} at A${wrapped.toFixed(1)} vs ${height.toFixed(3)})`)
  }
  // A wider transition is a run end jumping round the bar: on the gate's air
  // sector the square-only wide rule keeps the link at the layer, and anywhere
  // else (a model protrusion, a region) the transition keeps its retract.
  const wideTurns = rough.moves.filter((move) => move.kind === 'rapid'
    && alongOf(move.to) > alongOf(move.from) + 1e-9
    && Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) > 45)
  assert.ok(wideTurns.length > 0, `a >45 deg ring transition keeps its retract (${wideTurns.length})`)
  // A ring that emits nothing (over the collar) leaves a gap no link crosses:
  // every link joins two adjacent rings.
  for (const link of links) {
    const span = alongOf(link.to) - alongOf(link.from)
    assert.ok(span <= ringSpacing + 1e-9,
      `a link joins adjacent rings (${alongOf(link.from).toFixed(3)}->${alongOf(link.to).toFixed(3)}, spacing ${ringSpacing.toFixed(3)})`)
  }
  const skips = rough.moves.filter((move) => alongOf(move.to) - alongOf(move.from) > ringSpacing * 1.5)
  assert.ok(skips.length > 0, `the collar leaves skipped rings (${skips.length} transitions)`)
  for (const move of skips) {
    assert.notEqual(move.kind, 'cut', 'a transition across a skipped ring is not a cutting link')
  }
  // Pinned on the fixture so any change in what qualifies is a visible diff.
  assert.equal(whole.length, 63, `whole-ring links (${whole.length})`)
  assert.equal(across.length, 18, `A-changing links (${across.length})`)
  assert.equal(wideTurns.length, 11, `wide transitions that keep their retract (${wideTurns.length})`)
  console.log(`  ${whole.length} whole-ring, ${split.length} split-ring and ${across.length} A-changing links; `
    + `${wideTurns.length} wide turns and ${skips.length} skipped-ring transitions keep their retract`)
}

// ---------------------------------------------------------------------------
// 2. Budget exhaustion. The at-layer walk has its own operation budget; past it
//    a boundary keeps the raised plan, which is computed first and charged to
//    its own bucket, so the fallback is the motion the operation had before the
//    at-layer candidate existed. This is #1093's long square bar at half the
//    stepdown. Layers 1-3 are corner arcs (air links since #1103 slice ca-d, so
//    they spend no at-layer row at all), layer 4 is the first whole ring, and
//    the budget now runs out on layer 8: layers 8-9 keep the raised links and
//    retracts they had before it. Re-measured for ca-d; every layer before the
//    fallback links all 392 of its boundaries at the layer.
// ---------------------------------------------------------------------------

console.log('Testing that a spent at-layer budget falls back to the unchanged raised plan...')
{
  const length = 400
  const stock = squareStock(40, length, 'x', { x: 0, y: 0 })
  const model = revolved(stock, [{ along: 2, radius: 6 }, { along: length - 2, radius: 14 }], 96)
  const rough = generateRotaryRough('at-layer-budget', model, stock, BALL4, {
    stepover: 1, sampleSpacing: 1, stockToLeave: 0, alongStart: 2, alongEnd: length - 2,
    safeRadius: barMaxRadius(stock) * 2, requestedCellSize: 0.5, stepdown: 2.5, passDirection: 'around',
  }, {})
  assert.deepEqual(rough.warnings, [], 'the rough has no warning')
  const layers = layersOf(rough.moves)
  const atLayer = layers.map((layer) => layer.filter(isAtLayerLink).length)
  const raised = layers.map((layer) => layer.filter((move) => move.kind === 'rapid'
    && move.from.a === move.to.a && move.from.z === move.to.z && alongOf(move.to) > alongOf(move.from)).length)
  const plunges = layers.map((layer) => layer.filter((move) => move.kind === 'plunge').length)
  assert.deepEqual(atLayer, [392, 392, 392, 392, 392, 393, 353, 0, 0],
    `the at-layer links stop where their budget is spent (${atLayer.join(',')})`)
  assert.deepEqual(raised.slice(4), [0, 0, 0, 228, 104],
    `past the at-layer budget the raised links are the pre-slice ones (${raised.join(',')})`)
  assert.deepEqual(plunges, [4, 4, 4, 1, 1, 1, 1, 1, 105],
    `and so are the retracts the raised budget leaves (${plunges.join(',')})`)
  // #1103 slice ca-d: A is one-way, so a whole ring's boundary is still the
  // **seam** (A = 360k), just not only A0/A360 any more. The first whole-ring
  // layer links all 392 of its boundaries at those seam angles.
  const seamLayer = layers[3].filter(isAtLayerLink)
  assert.equal(seamLayer.length, 392, `the first whole-ring layer links its boundaries (${seamLayer.length})`)
  assert.ok(seamLayer.every((move) => isSeam(move.from.a)),
    'a whole-ring layer links at the seam of its own turn')
  console.log(`  at-layer links per layer ${atLayer.join(',')}; raised ${raised.join(',')}`)
}

// ---------------------------------------------------------------------------
// 3. A dense angular grid.
//
//    #1117's per-link row cap (256) bounded the **drift** path, which samples
//    one model row per grid angle a transition crosses. #1103 slice ca-d turns
//    every ring the same way, so a square blank's ring-to-ring transition is
//    the seam gap between its last corner arc and the next ring's first: the
//    touch gate proves that sector air at the layer, the transition is one
//    straight cut, and it draws **no** model row at all. On a fine grid that is
//    exactly the case the cap used to refuse, so it now links without touching
//    the row budget. The drift path's own cap is covered on a round bar by
//    `rotaryAcrossAngleLinks.test.ts`.
// ---------------------------------------------------------------------------

console.log('Testing that a fine angular grid links the gate gap without sampling a row...')
{
  const side = 14
  const length = 8
  const stock = squareStock(side, length, 'x', { x: 0, y: 0 })
  const rough = generateRotaryRough('dense-grid', shaped(stock, lobeRadiusAt(length, 60), 0, length, 80, 240), stock, BALL2, {
    stepover: 0.6, sampleSpacing: 0.1, stockToLeave: 0, alongStart: 0, alongEnd: length,
    safeRadius: barMaxRadius(stock) * 2, requestedCellSize: 0.1, stepdown: 1.5, passDirection: 'around',
  }, {})
  assert.deepEqual(rough.warnings, [], 'the rough has no warning')
  const links = rough.moves.filter(isAtLayerLink)
  const across = links.filter((move) => move.from.a !== move.to.a)
  const widest = Math.max(0, ...across.map((move) => Math.abs((move.to.a ?? 0) - (move.from.a ?? 0))))
  assert.ok(widest > 45,
    `the gate-gap links are wider than the drift bound (widest ${widest.toFixed(2)} deg)`)
  // Every one of them is a single straight move: no interior waypoint, so no
  // row samples were needed to prove it.
  const single = across.filter((move) => move.kind === 'cut')
  assert.equal(single.length, across.length, 'the gate-gap links are single cuts')
  assert.equal(across.length, 16, `gate-gap links on the dense grid (${across.length})`)
  console.log(`  ${across.length} gate-gap links, widest ${widest.toFixed(2)} deg, no sampled row`)
}

// ---------------------------------------------------------------------------
// 4. The link-row sample budget is per path. An A-changing candidate samples a
//    model row for every grid angle it crosses, rows the raised plan never asks
//    for; on one shared total those attempts could spend the samples a later
//    raised link needs, and that link would drop to the travel height. With a
//    stub sampler of 1001-sample rows, 1998 at-layer rows exhaust the 2M budget,
//    and the raised path still gets a new row -- and a row the at-layer path
//    already sampled is shared (charged to the raised budget, not resampled).
// ---------------------------------------------------------------------------

console.log('Testing that at-layer link rows cannot spend the raised link-row budget...')
{
  const samples = 1001
  let sampled = 0
  const rowAt = linkRowBudget(samples, (key): RotaryLinkRow => {
    sampled++
    return { along: Array.from({ length: samples }, (_, i) => i), tips: Array.from({ length: samples }, () => key) }
  })
  let atLayerRows = 0
  for (let k = 0; k < 4000; k++) {
    if (rowAt(k * 0.05, 'atLayer') === null) break
    atLayerRows++
  }
  assert.equal(atLayerRows, Math.floor(2_000_000 / samples),
    `the at-layer path runs out of samples on its own budget (${atLayerRows} rows)`)
  assert.equal(rowAt(atLayerRows * 0.05 + 0.05, 'atLayer'), null, 'a further at-layer row is refused')
  const fresh = rowAt(300, 'raised')
  assert.ok(fresh !== null, 'a raised row is still affordable after the at-layer budget is spent')
  const before = sampled
  const shared = rowAt(0, 'raised')
  assert.ok(shared !== null && shared.tips[0] === 0, 'the raised path reuses a row the at-layer path sampled')
  assert.equal(sampled, before, 'without sampling the angle again')
  // A cancelled sampling is not a property of the angle, so it is not shared.
  let stop = true
  const stoppable = linkRowBudget(samples, (key) => (stop ? 'stopped' : { along: [0], tips: [key] }))
  assert.equal(stoppable(10, 'atLayer'), null, 'a stopped sampling gives no row')
  stop = false
  assert.ok(stoppable(10, 'raised') !== null, 'and the other path samples the angle afresh')
  console.log(`  ${atLayerRows} at-layer rows spent their budget; the raised path still sampled a new row`)
}

console.log('rotary square ring-link tests passed')
