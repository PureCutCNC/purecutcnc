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
 * #1117 slice rl-e: the round-bar rough's at-layer link, corrected on two points
 * that the real fixture (a scanned bust in a bar much larger than the model)
 * exposed after rl-a..rl-d shipped: the at-layer leftover asked the wrong
 * question, and a partial ring's link could not cross the few degrees its run
 * end drifts.
 *
 * **1. The at-layer leftover is what a layer left, not an upper bound on it.**
 * `linkLeftoverAt` used one walk for both buckets: the material above x was the
 * maximum of `cutTip + rise` over every ring position the body reaches, which is
 * the right bound for sizing the **raised** link and the wrong answer for the
 * at-layer test. With a ball, the ring one radius away contributes
 * `cutTip + radius`, so the "leftover" never falls below the bar radius, and past
 * the first layer every candidate is refused against the uncut blank (measured on
 * busto-round layer 2: leftover 1.000 in, layer cut to 0.925 in, allowance
 * 0.0966 in). The at-layer bucket now takes the **lowest** pass over the ring
 * positions -- the material actually left -- and the highest of those per-row
 * envelopes across the body's window.
 *
 * **2. A partial ring's ends do not share an angle.** On a model that is not a
 * solid of revolution a ring cuts only the arc where the material stands below
 * the previous layer's radius, and the boundary of that arc moves along the bar.
 * The link that joins one ring's run end to the next ring's run start is one
 * straight move that changes along **and** A; it is now proved on its whole swept
 * path instead of being refused for the angle change.
 *
 * The raised link keeps its own computation byte for byte, so a link that does
 * not qualify is the motion it was before this slice; the existing byte-identical
 * and raised-budget suites (`rotaryAroundPasses.test.ts`,
 * `rotarySquareAroundPasses.test.ts`, `rotaryRegion.test.ts`) are what pin that.
 *
 * Mutations each block catches:
 *  - restore the maximum-of-contacts walk for the `atLayer` bucket -> block 1:
 *    no layer after the first links at the layer (`raised links` back to a full
 *    set, `layer two` links zero);
 *  - restore `from.a !== to.a -> null` in `linkAtLayer` -> block 2: no diagonal
 *    cut is emitted at all;
 *  - drop the at-layer one-band check from the A-changing path (`leftover[i] -
 *    height > allowance`) -> block 3: the wide slanted band emits 12 diagonal
 *    cuts instead of the 4 that clear the material the earlier layers left;
 *  - drop the whole-path region test (`rotaryRegionSlopeContains`) from the
 *    A-changing path, keeping only the waypoint point checks -> block 4: the
 *    masked fixture emits the 14.5 -> 15.5 cut across the excluded slit at
 *    X14.87 again (4 A-changing links instead of 3).
 */

import assert from 'node:assert/strict'
import { barCentre, barMaxRadius, barPivotZ } from '../../types/barStock'
import { polygonProfile, roundStock } from '../../types/project'
import type { BarStock, SketchFeature, SketchProfile } from '../../types/project'
import { buildRegionMask } from './regions'
import { generateRotaryRough } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import type { NormalizedTool, ToolpathMove } from './types'

const BALL: NormalizedTool = {
  id: 'ball-2', name: '2 mm ball nose', sourceUnits: 'mm', units: 'mm',
  type: 'ball_endmill', diameter: 2, radius: 1, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 1.5, defaultStepover: 0.4, maxCutDepth: 0,
}

const PARAMS = {
  stepover: 0.4, sampleSpacing: 0.4, stockToLeave: 0, alongStart: 0, alongEnd: 20,
  safeRadius: 30, requestedCellSize: 0.3, stepdown: 1.5, passDirection: 'around' as const,
}

/** A closed surface of revolution around the bar axis: `radiusAt` per (along, angle). */
function surface(
  stock: BarStock,
  radiusAt: (along: number, angleDeg: number) => number,
  alongFrom: number,
  alongTo: number,
  steps: number,
  segments: number,
): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (let step = 0; step <= steps; step++) {
    const along = alongFrom + (alongTo - alongFrom) * step / steps
    for (let j = 0; j < segments; j++) {
      const angle = 360 * j / segments
      const radius = radiusAt(along, angle)
      const radians = angle * Math.PI / 180
      if (stock.axis === 'x') {
        positions.push(along, centre + radius * Math.cos(radians), pivot + radius * Math.sin(radians))
      } else {
        positions.push(centre + radius * Math.cos(radians), along, pivot + radius * Math.sin(radians))
      }
    }
  }
  for (let step = 0; step < steps; step++) {
    for (let j = 0; j < segments; j++) {
      const j2 = (j + 1) % segments
      const a = step * segments + j
      const b = step * segments + j2
      const c = (step + 1) * segments + j2
      const d = (step + 1) * segments + j
      index.push(a, b, c, a, c, d)
    }
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

const alongOf = (point: { x: number; y: number }): number => point.x

/** A cut that changes the along coordinate: a ring-to-ring link, not a ring chord. */
const isLinkCut = (move: ToolpathMove): boolean =>
  move.kind === 'cut' && alongOf(move.from) !== alongOf(move.to)

/** A link cut that also changes A: the partial-ring transition this slice adds. */
const isAcrossAngleCut = (move: ToolpathMove): boolean =>
  isLinkCut(move) && move.from.a !== undefined && move.to.a !== undefined && move.from.a !== move.to.a

/** The raised link's own traverse: a rapid at one angle and height, forward along the bar. */
const isRaisedLink = (move: ToolpathMove): boolean =>
  move.kind === 'rapid' && move.from.a !== undefined && move.to.a !== undefined
  && move.from.a === move.to.a && move.from.z === move.to.z && alongOf(move.to) > alongOf(move.from)

/**
 * Split a rough's moves into its layers at the layer-boundary traverse: a rapid
 * back along the bar is the one move every layer ends with.
 */
function perLayer(moves: readonly ToolpathMove[]): ToolpathMove[][] {
  const bounds: number[] = [0]
  for (let i = 0; i < moves.length; i++) {
    const move = moves[i]
    if (move.kind === 'rapid' && alongOf(move.to) < alongOf(move.from) - 1e-12) bounds.push(i + 1)
  }
  bounds.push(moves.length)
  const layers: ToolpathMove[][] = []
  for (let i = 0; i + 1 < bounds.length; i++) layers.push(moves.slice(bounds[i], bounds[i + 1]))
  return layers
}

/** The link boundaries of one layer: a maximal group of consecutive link cuts. */
function linkBoundaries(moves: readonly ToolpathMove[]): number {
  let count = 0
  let inLink = false
  for (const move of moves) {
    if (isLinkCut(move)) {
      if (!inLink) count++
      inLink = true
    } else {
      inLink = false
    }
  }
  return count
}

function diag(moves: readonly ToolpathMove[]): ToolpathMove[] {
  return moves.filter(isAcrossAngleCut)
}

// ---------------------------------------------------------------------------
// 1. #1117 rl-e: past the first layer, a large bar still links at the layer.
//
//    A Ø10 model in a Ø20 bar with a Ø2 ball: layer 1's left over material is
//    the uncut blank, so its links remove one band; layer 2's is the 8.5 mm the
//    first layer cut, one stepdown above its own 7 mm radius. The maximum-of-
//    contacts walk never sees below the 10 mm bar radius during the ball's rise,
//    so every candidate past layer 1 was refused against the blank.
// ---------------------------------------------------------------------------
{
  const stock = roundStock(20, 20, 'x', { x: 0, y: 0 })
  const mesh = surface(stock, () => 5, 0, 20, 40, 180)
  const result = generateRotaryRough('rl-e-envelope', mesh, stock, BALL, PARAMS, {})
  assert.deepEqual(result.warnings, [], 'the large-bar rough warns about nothing')
  const layers = perLayer(result.moves)
  assert.ok(layers.length >= 3, `the fixture has several layers (${layers.length})`)
  const pivot = barPivotZ(stock)
  const counts = layers.map(linkBoundaries)
  for (let layer = 1; layer < layers.length; layer++) {
    assert.ok(counts[layer] > 0,
      `layer ${layer + 1} links its ring boundaries at the layer (${counts[layer]} of ${counts[0]}); `
      + `counts ${JSON.stringify(counts)}`)
  }
  // Every link on a layer past the first is a *cut* at or below that layer's
  // previous radius -- the one band this layer removes -- never the old raised
  // traverse. Layer 2's radius is 7 and its previous radius 8.5.
  const second = layers[1].filter(isLinkCut)
  const tipMax = Math.max(...second.map((move) => Math.max(move.from.z, move.to.z) - pivot))
  assert.ok(tipMax <= 8.5 + PARAMS.requestedCellSize + 1e-6,
    `layer two's links stay inside its own band (${tipMax.toFixed(3)} <= 8.5 + one cell)`)
  assert.equal(layers[1].filter(isRaisedLink).length, 0,
    'layer two keeps no raised link between these rings')
  console.log(`  rl-e envelope: layers ${JSON.stringify(counts)} link boundaries, `
    + `layer two tip ${tipMax.toFixed(3)} mm`)
}

// ---------------------------------------------------------------------------
// 2. #1117 rl-e: a partial ring's drifting run end links **across the A change**.
//
//    The model is a cylinder with one smooth lobe whose height grows along the
//    bar, so the angle where the lobe crosses the layer -- the end of a partial
//    ring's run -- moves with the along position. Two neighbouring rings then end
//    and start a couple of degrees apart, and the link that joins them is one
//    straight cut in both along and A. Before this slice it was refused for the
//    angle change and the transition retracted.
// ---------------------------------------------------------------------------
{
  const stock = roundStock(20, 20, 'x', { x: 0, y: 0 })
  const mesh = surface(stock, (along, angle) => {
    const height = 3.6 + 0.02 * along
    // The Around frame measures A from the bar's +Y, so the mesh's 90 degree
    // direction is the seam the rings start and end on: the lobe's crest sits
    // there and a partial ring's arc is one run.
    let delta = ((angle - 90) % 360 + 360) % 360
    if (delta > 180) delta -= 360
    const u = Math.abs(delta)
    if (u >= 70) return 5
    const c = Math.cos(u * Math.PI / 140)
    return 5 + height * c * c
  }, 0, 20, 200, 240)
  const result = generateRotaryRough('rl-e-across', mesh, stock, BALL, PARAMS, {})
  assert.deepEqual(result.warnings, [], 'the lobe rough warns about nothing')
  const pivot = barPivotZ(stock)
  const moves = diag(result.moves)
  assert.ok(moves.length > 0,
    `the drifting partial-ring boundaries link across A (${moves.length} diagonal cut moves)`)
  for (const move of moves) {
    const delta = move.to.a! - move.from.a!
    assert.ok(Math.abs(delta) > 0 && Math.abs(delta) <= 45,
      `an A-changing link's own step stays inside the slice's bound (${delta.toFixed(3)} deg)`)
    // It is a stay-down cut, not the raised traverse: it follows the model at
    // the boundary (at most the previous layer's radius), never the bar surface
    // the travel height clears.
    assert.ok(Math.max(move.from.z, move.to.z) - pivot < barMaxRadius(stock) - 1e-6,
      `a diagonal link stays below the bar surface (${(Math.max(move.from.z, move.to.z) - pivot).toFixed(3)})`)
  }
  const raised = result.moves.filter(isRaisedLink).length
  console.log(`  rl-e across A: ${moves.length} diagonal cut moves, ${raised} raised links left`)
}

// ---------------------------------------------------------------------------
// 3. #1117 rl-e: a swept path that leaves the cleared region keeps the raised link.
//
//    The region is a slanted band; its across boundary moves with the along
//    position, so two neighbouring rings' runs end a few degrees apart and the
//    transition is an A-changing link. The mask is wide enough that the link is
//    proved and emitted; narrowed to a strip the cutter body cannot clear, the
//    same transition is refused and the pre-slice retract stays.
// ---------------------------------------------------------------------------
{
  const stock = roundStock(12, 30, 'x')
  const centre = barCentre(stock)
  const tool: NormalizedTool = { ...BALL, id: 'ball-3', diameter: 3, radius: 1.5 }
  const mesh = surface(stock, () => 4, 3, 27, 40, 192)
  const narrowParams = {
    stepover: 1, sampleSpacing: 1, stockToLeave: 0, alongStart: 3, alongEnd: 27,
    safeRadius: 25, requestedCellSize: 0.5, stepdown: 1, passDirection: 'around' as const,
  }
  const band = (halfWidth: number): SketchFeature => ({
    id: 'slant', name: 'slant', kind: 'polygon', operation: 'region', authoringFace: 'around', folderId: null,
    sketch: {
      profile: polygonProfile([
        { x: 3, y: centre - halfWidth }, { x: 27, y: centre + halfWidth },
        { x: 27, y: centre + halfWidth + 1 }, { x: 3, y: centre - halfWidth + 1 },
      ]) as SketchProfile,
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    z_top: 0, z_bottom: 0, visible: true, locked: false,
  } as SketchFeature)
  const wide = buildRegionMask([band(2)])
  const narrow = buildRegionMask([band(0.4)])
  assert.ok(wide && narrow, 'both slanted masks build')
  const accepted = generateRotaryRough('rl-e-region-wide', mesh, stock, tool,
    { ...narrowParams, region: wide! }, {})
  const refused = generateRotaryRough('rl-e-region-narrow', mesh, stock, tool,
    { ...narrowParams, region: narrow! }, {})
  assert.deepEqual(accepted.warnings, [], 'the wide-band rough warns about nothing')
  assert.deepEqual(refused.warnings, [], 'the narrow-band rough warns about nothing')
  // Pinned, not just positive: the same fixture with the one-band check removed
  // emits 12 of these (measured), so a slice that stops refusing them fails here.
  assert.equal(diag(accepted.moves).length, 4,
    `the wide band's across-A transitions link only where one band remains `
    + `(${diag(accepted.moves).length} diagonals, baseline 4)`)
  assert.equal(diag(refused.moves).length, 0,
    `the narrow band keeps the raised transition (${diag(refused.moves).length} diagonals)`)
  console.log(`  rl-e region: wide band ${diag(accepted.moves).length} diagonals, `
    + `narrow band ${diag(refused.moves).length}`)
}

// ---------------------------------------------------------------------------
// 4. #1117 rl-e correction: an A-changing link never crosses an excluded strip.
//
//    The same slanted-band fixture, now with a 0.02 mm wide **excluded** slit at
//    X14.87. The dense row's waypoints either side of the slit are all inside the
//    mask, so a point-by-point check accepts the 14.5 -> 15.5 transition and the
//    commanded cut crosses the slit. The link's path is one straight segment in
//    (along, A) -- across is affine in A -- so the mask's own boundary test must
//    decide that segment, not its waypoints.
// ---------------------------------------------------------------------------
{
  const stock = roundStock(12, 30, 'x')
  const centre = barCentre(stock)
  const tool: NormalizedTool = { ...BALL, id: 'ball-3', diameter: 3, radius: 1.5 }
  const mesh = surface(stock, () => 4, 3, 27, 40, 192)
  const params = {
    stepover: 1, sampleSpacing: 1, stockToLeave: 0, alongStart: 3, alongEnd: 27,
    safeRadius: 25, requestedCellSize: 0.5, stepdown: 1, passDirection: 'around' as const,
  }
  const feature = (id: string, points: Array<{ x: number; y: number }>, mode?: 'include' | 'exclude'): SketchFeature => ({
    id, name: id, kind: 'polygon', operation: 'region', authoringFace: 'around', folderId: null,
    sketch: {
      profile: polygonProfile(points) as SketchProfile,
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    z_top: 0, z_bottom: 0, visible: true, locked: false,
    ...(mode === undefined ? {} : { regionMaskMode: mode }),
  } as SketchFeature)
  // The slanted band of block 3, and a slit 0.02 mm wide across the whole sheet,
  // narrower than any sample of the dense row that crosses it.
  const band = [
    { x: 3, y: centre - 2 }, { x: 27, y: centre + 2 },
    { x: 27, y: centre + 3 }, { x: 3, y: centre - 1 },
  ]
  const slit = [
    { x: 14.87, y: centre - 6 }, { x: 14.89, y: centre - 6 },
    { x: 14.89, y: centre + 6 }, { x: 14.87, y: centre + 6 },
  ]
  const plain = buildRegionMask([feature('slant', band)])
  const sliced = buildRegionMask([feature('slant', band), feature('slit', slit, 'exclude')])
  assert.ok(plain && sliced, 'both masks build')
  const segment = sliced!.containsSegment
  assert.ok(segment, 'the slit mask exposes its whole-segment test')
  /** One point of the commanded path on the Around sheet, as `rotaryRegionContains` maps it. */
  const sheet = (along: number, angle: number): { x: number; y: number } =>
    ({ x: along, y: centre + angle * Math.PI * stock.thickness / 360 })
  const unsliced = generateRotaryRough('rl-e-slit-control', mesh, stock, tool,
    { ...params, region: plain! }, {})
  const refused = generateRotaryRough('rl-e-slit', mesh, stock, tool,
    { ...params, region: sliced! }, {})
  assert.deepEqual(unsliced.warnings, [], 'the unsliced control warns about nothing')
  assert.deepEqual(refused.warnings, [], 'the slit rough warns about nothing')
  // The control proves the slit is what removes the transition: without it the
  // same fixture emits 4 A-changing links, with it 3.
  assert.equal(diag(unsliced.moves).length, 4,
    `the unsliced control links 4 A-changing transitions (${diag(unsliced.moves).length})`)
  assert.equal(diag(refused.moves).length, 3,
    `the slit refuses the one transition that crosses it (${diag(refused.moves).length} of 4)`)
  // Pinned on the emitted motion: every A-changing cut's **whole** commanded
  // segment is inside the mask, so the slit is never stepped over. A waypoint
  // check alone passes this fixture with the crossing link emitted.
  for (const move of diag(refused.moves)) {
    assert.ok(segment!(sheet(move.from.x, move.from.a!), sheet(move.to.x, move.to.a!)),
      `an A-changing link crosses the excluded slit (X${move.from.x.toFixed(3)} -> `
      + `${move.to.x.toFixed(3)}, A${move.from.a!.toFixed(3)} -> ${move.to.a!.toFixed(3)})`)
  }
  console.log(`  rl-e slit: ${diag(unsliced.moves).length} A-changing links unsliced, `
    + `${diag(refused.moves).length} with the 0.02 mm excluded slit`)
}

console.log('engine/toolpaths/rotaryAcrossAngleLinks.test.ts passed')
