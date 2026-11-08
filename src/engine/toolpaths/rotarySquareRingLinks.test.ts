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

/**
 * The moves that belong to a **continuous helix** (#1103 slice ca-j).
 *
 * A square blank's whole-ring band is a helix now, and a helix move advances
 * along the bar *and* turns A, which is also the shape of an at-layer link. The
 * generator merges a collinear helix into a few multi-turn commands, and one the
 * surface does not make collinear stays a run of short segments at one pitch;
 * both shapes are recognised here so the link proofs keep judging links.
 */
function helixMovesOf(moves: readonly ToolpathMove[]): Set<ToolpathMove> {
  const set = new Set<ToolpathMove>()
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    const along = alongOf(move.to) - alongOf(move.from)
    const turn = (move.to.a ?? 0) - (move.from.a ?? 0)
    if (Math.abs(along) > 1e-12 && Math.abs(turn) >= 360 - 1e-9) set.add(move)
  }
  let run: ToolpathMove[] = []
  let pitch = 0
  const flush = (): void => {
    if (run.length >= 6) for (const move of run) set.add(move)
    run = []
  }
  for (const move of moves) {
    const along = move.kind === 'cut' ? alongOf(move.to) - alongOf(move.from) : 0
    const turn = move.kind === 'cut' ? (move.to.a ?? 0) - (move.from.a ?? 0) : 0
    if (Math.abs(along) > 1e-12 && Math.abs(turn) > 1e-9) {
      const next = along / turn
      if (run.length === 0
        || Math.abs(next - pitch) <= 1e-6 * Math.max(Math.abs(next), Math.abs(pitch))) {
        run.push(move)
        pitch = next
        continue
      }
    }
    flush()
  }
  flush()
  return set
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
//
//    #1103 slice ca-j: the **whole-ring bands** of this fixture are helices now
//    (five bands; the square blank's round layers became admissible), so the
//    links this block recorded on them are gone -- a band is one continuous cut.
//    The links that remain are the ones around the rings that are *not* a band:
//    the forward seam links of single whole rings, the corner arcs, the wide
//    gate-gap transitions and the skipped-ring retracts. The A-changing (wide)
//    link proof that used to run here is still proved by the property suite
//    (`atLayerLinkCounts.acrossAngle`, `drawLinkAcrossCase` and `drawTwistCase`)
//    and by the corner-arc and split-ring blocks above; this block keeps the
//    adjacent-ring rule and re-records what the helix left.
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
  // A **helix** move advances along and turns A by design, so it is not a link:
  // it is the band's own cut (`helixMovesOf`).
  const helixMoves = helixMovesOf(rough.moves)
  assert.ok(helixMoves.size > 50,
    `the fixture's whole-ring bands are helices (#1103 ca-j: ${helixMoves.size} helix moves)`)
  const links = rough.moves.filter((move) => isAtLayerLink(move) && !helixMoves.has(move))
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
  // #1103 ca-j: the whole-ring bands became helices, so these are the wide
  // gate-gap transitions of the layers that still cut rings -- fewer than before
  // (38 -> 41 across the two classes), but the rule is the same one.
  assert.ok(across.length > 0, `adjacent rings still link across an A change (${across.length})`)
  // #1103 ca-d fix 1 (review P2): a wide square transition has two proofs now.
  // The gate's **air sector** still gives one straight cut at the layer (the
  // blank stands below it through the gap), and a gap the layer below already
  // cleared goes through the at-layer row proof, which rides `max(model,
  // layer)` and emits the sampled steps. Both are cuts below the blank, and the
  // row-proven ones must stay at or above the model they cross -- the frame
  // exposes mesh direction `90 - A`, the same mapping the link proof uses.
  const modelAt = (point: ToolpathMove['from']): number =>
    radiusAt(alongOf(point), 90 - ((((point.a ?? 0) % 360) + 360) % 360))
  let wideAir = 0
  let wideModel = 0
  for (const link of across) {
    const drift = Math.abs((link.to.a ?? 0) - (link.from.a ?? 0))
    if (drift <= 45 + 1e-9) continue
    const middle = ((link.from.a ?? 0) + (link.to.a ?? 0)) / 2
    const wrapped = ((middle % 360) + 360) % 360
    const height = Math.min(link.from.z, link.to.z) - pivot
    if (squareRotaryTouchRadius(stock, wrapped, BALL2.radius, BALL2.type) < height + 1e-6) wideAir++
    else wideModel++
    assert.ok(Math.max(link.from.z, link.to.z) - pivot <= barMaxRadius(stock) + 1e-6,
      `a wide A-changing link is a cut below the blank (${(Math.max(link.from.z, link.to.z) - pivot).toFixed(3)})`)
    for (const point of [link.from, link.to]) {
      const model = modelAt(point)
      assert.ok(point.z - pivot >= model - 1e-6,
        `a wide A-changing link stays at or above the model it crosses `
        + `(${(point.z - pivot).toFixed(3)} vs ${model.toFixed(3)} at A${(((point.a ?? 0) % 360) + 360) % 360})`)
    }
  }
  assert.ok(wideAir > 0, `the gate's air sector still keeps a wide link (${wideAir})`)
  assert.ok(wideModel > 0, `a cleared model gap keeps a wide link through the row proof (${wideModel})`)
  // A wider transition the row proof cannot cover (a skipped ring, no material
  // under the tool) still keeps its retract.
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
  // #1103 ca-j: a helix move spans the whole band by design, so it is not a
  // "transition across a skipped ring"; only the ring path's own jumps are.
  const skips = rough.moves.filter((move) => !helixMoves.has(move)
    && alongOf(move.to) - alongOf(move.from) > ringSpacing * 1.5)
  assert.ok(skips.length > 0, `the collar leaves skipped rings (${skips.length} transitions)`)
  for (const move of skips) {
    assert.notEqual(move.kind, 'cut', 'a transition across a skipped ring is not a cutting link')
  }
  // Pinned on the fixture so any change in what qualifies is a visible diff.
  // #1103 ca-j re-recorded these from the same fixture: 63 whole-ring links
  // became 32 (the rest were on bands that are now helices) and the 38
  // A-changing links became the helix. Nothing else moved.
  // #1155 rn-c re-recorded both counts once more: the conservative read reaches
  // a whole cell past each sample now, so two of these boundaries no longer
  // clear the at-layer proof's own bound and keep their raised link instead (30),
  // and one transition that used to be wider than 45 degrees no longer is (1).
  assert.equal(whole.length, 30, `whole-ring links (${whole.length})`)
  assert.equal(wideTurns.length, 1, `wide transitions that keep their retract (${wideTurns.length})`)
  console.log(`  ${whole.length} whole-ring and ${split.length} split-ring links, `
    + `${helixMoves.size} helix moves; `
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
  const plunges = layers.map((layer) => layer.filter((move) => move.kind === 'plunge').length)
  // #1103 slice ca-j: this fixture's whole-ring layers are **helices** now, so
  // the at-layer walk it used to exhaust is not asked for there at all -- the
  // per-layer counts this block recorded (392/392/392/392/392/393/353/0/0 links,
  // with the raised fallback from layer 8) described rings that no longer exist.
  // The budget mechanism itself is covered where it still runs: `linkRowBudget`'s
  // unit blocks below, and the property suite's square at-layer links. What this
  // fixture still proves is that the operation generates the rule's motion with
  // no warning and that the layers the ring path keeps still raise and retract.
  const helixMoves = rough.moves.filter((move) => move.kind === 'cut'
    && Math.abs(alongOf(move.to) - alongOf(move.from)) > 1e-12
    && Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) >= 360 - 1e-9)
  assert.ok(helixMoves.length > 0, `the whole-ring layers are helixed (${helixMoves.length} multi-turn cuts)`)
  assert.equal(layers.length, 9, `the fixture still has its nine layers (${layers.length})`)
  assert.ok(plunges.some((count) => count > 1),
    'the layers that keep rings still plunge for each of them')
  console.log(`  ${layers.length} layers, ${helixMoves.length} helix cuts; `
    + `the ring budget itself is covered by linkRowBudget below`)
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
  // #1103 ca-j: the fixture's whole-ring bands are helices, so a helix move is
  // the band's cut and is not one of the gate-gap links this block is about.
  const helixMoves = helixMovesOf(rough.moves)
  const links = rough.moves.filter((move) => isAtLayerLink(move) && !helixMoves.has(move))
  const across = links.filter((move) => move.from.a !== move.to.a)
  const widest = Math.max(0, ...across.map((move) => Math.abs((move.to.a ?? 0) - (move.from.a ?? 0))))
  assert.ok(widest > 45,
    `the gate-gap links are wider than the drift bound (widest ${widest.toFixed(2)} deg)`)
  // #1103 ca-d fix 1: the gate's air sector is one straight cut (no row), and a
  // model gap the layer below cleared is the row proof's multi-step cut. Both
  // are present on the dense grid; the shape is what distinguishes them.
  const groups: ToolpathMove[][] = []
  let inLink = false
  for (const move of rough.moves) {
    if (isAtLayerLink(move)) {
      if (!inLink) groups.push([])
      groups[groups.length - 1].push(move)
      inLink = true
    } else inLink = false
  }
  const wideGroups = groups.filter((group) => Math.abs((group[0].to.a ?? 0) - (group[0].from.a ?? 0)) > 45)
  assert.ok(wideGroups.some((group) => group.length === 1), 'a gate-gap link is one straight cut')
  assert.ok(wideGroups.some((group) => group.length > 1), 'a model-gap link is the row proof\'s sampled cut')
  // #1103 ca-j re-recorded this: the fixture's whole-ring bands are helices, so
  // the at-layer links here are the gate-gap transitions the ring layers keep
  // (42 became 64 as the bands stopped covering them). #1155 rn-c re-recorded it
  // once more: the conservative read reaches a whole cell past each sample, one
  // more gate-gap boundary clears the proof (65). #1173 re-recorded it once
  // more: the upward-only merge of the refinement's short steps joins five of
  // those links into the cuts beside them (60) -- measured on the tip, after the
  // merge's trigger was narrowed to steps finer than the base angle grid; with
  // the merge switched off the count is still 65. A merged move stands at or
  // above both of the moves it replaces, never lower.
  assert.equal(across.length, 60, `gate-gap links on the dense grid (${across.length})`)
  console.log(`  ${across.length} gate-gap links, widest ${widest.toFixed(2)} deg, `
    + `${wideGroups.filter((group) => group.length > 1).length} of them row-proven`)
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
