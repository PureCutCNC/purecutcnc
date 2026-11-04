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
 *    X14.87 again (4 A-changing links instead of 3);
 *  - build block 5's mesh with the pre-rl-f `radiusAt(along, meshAngle - 90)`
 *    mapping -> block 5's oracle-versus-ray-intersection assertion: the meshes
 *    differ by more than half a millimetre at the twisted crest, which is what
 *    the rl-e review mistook for a gouge.
 *
 * rl-f removed block 5's window-height assertion (rl-e's fix round 3). The
 * check it made cannot fail: `linkRowAt`'s tips are already footprint-convolved
 * `safeToolTipZAt` samples, and removing the window lift changes five links out
 * of the 361 property cases. The lift stays in production as defence in depth
 * and no test is required to fail without it; the links' safety is the rl-c
 * protected-solid replay, which rl-f runs on this same corrected model
 * (`drawTwistCase` in `squareAroundGenerator.property.test.ts`).
 */

import assert from 'node:assert/strict'
import { barCentre, barMaxRadius, barPivotZ } from '../../types/barStock'
import { roundStock } from '../../types/project'
import type { BarStock } from '../../types/project'
import { generateRotaryRough, rotaryLinkRowSweep } from './rotaryModel'
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

/**
 * The outermost radius the mesh itself has along one ray in the bar's
 * cross-section: the ray leaves the bar axis at `along` towards the mesh's own
 * direction `angleDeg` (0 is the bar's +across, 90 its +up) and every triangle
 * it crosses is intersected, the farthest hit winning.
 *
 * This reads the **fixture's mesh**, not the `radiusAt` function that built it,
 * so it is what checks an angular mapping rather than restating it: a mesh
 * whose rings were laid out with the wrong sign intersects a ray somewhere else
 * than the model function claims (#1117 rl-f).
 */
function meshRadiusOnRay(
  mesh: RotaryModelMesh,
  stock: BarStock,
  along: number,
  angleDeg: number,
): number {
  const positions = mesh.positions
  const index = mesh.index
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const radians = angleDeg * Math.PI / 180
  const originX = stock.axis === 'x' ? along : centre
  const originY = stock.axis === 'x' ? centre : along
  const originZ = pivot
  const directionX = stock.axis === 'x' ? 0 : Math.cos(radians)
  const directionY = stock.axis === 'x' ? Math.cos(radians) : 0
  const directionZ = Math.sin(radians)
  let farthest = Number.NaN
  for (let triangle = 0; triangle < index.length; triangle += 3) {
    const a = index[triangle] * 3
    const b = index[triangle + 1] * 3
    const c = index[triangle + 2] * 3
    // Möller-Trumbore, in doubles over the mesh's own Float32 vertices.
    const edge1X = positions[b] - positions[a]
    const edge1Y = positions[b + 1] - positions[a + 1]
    const edge1Z = positions[b + 2] - positions[a + 2]
    const edge2X = positions[c] - positions[a]
    const edge2Y = positions[c + 1] - positions[a + 1]
    const edge2Z = positions[c + 2] - positions[a + 2]
    const hX = directionY * edge2Z - directionZ * edge2Y
    const hY = directionZ * edge2X - directionX * edge2Z
    const hZ = directionX * edge2Y - directionY * edge2X
    const determinant = edge1X * hX + edge1Y * hY + edge1Z * hZ
    if (Math.abs(determinant) < 1e-12) continue
    const inverse = 1 / determinant
    const sX = originX - positions[a]
    const sY = originY - positions[a + 1]
    const sZ = originZ - positions[a + 2]
    const u = (sX * hX + sY * hY + sZ * hZ) * inverse
    if (u < -1e-9 || u > 1 + 1e-9) continue
    const qX = sY * edge1Z - sZ * edge1Y
    const qY = sZ * edge1X - sX * edge1Z
    const qZ = sX * edge1Y - sY * edge1X
    const v = (directionX * qX + directionY * qY + directionZ * qZ) * inverse
    if (v < -1e-9 || u + v > 1 + 1e-9) continue
    const distance = (edge2X * qX + edge2Y * qY + edge2Z * qZ) * inverse
    // The model is star-shaped about the bar axis, so every hit is the same
    // surface; the farthest one is the outermost solid.
    if (distance > 0 && !(distance <= farthest)) farthest = distance
  }
  return farthest
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
  // #1103 slice ca-d: layer 1 is one continuous helix (every ring of the blank's
  // first layer is full), so its along-changing cuts are helix segments, not
  // ring links. The partial rings start at layer 2.
  const layersOfResult = perLayer(result.moves)
  const moves = layersOfResult.slice(1).flatMap((layer) => diag(layer))
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
// 3. #1103 slice ca-d: the region variants of the A-changing link are gone.
//
//    rl-e's blocks 3 and 4 proved that an A-changing link's whole swept path
//    stayed inside the operation's region. Forward-only rings change the shape
//    of every region-clipped transition: a ring the region trims to an arc ends
//    where the mask ends and the next ring starts a full turn further on, so the
//    transition is a wide A change rather than the few-degree drift those blocks
//    built. `linkAtLayer` also keeps a region's split rings on the raised plan
//    (#1117 slice B), so the at-layer candidate never sees one. Region safety is
//    covered by `rotaryRegion.test.ts`, including the helix's whole-slope proof
//    (`rotaryRegionSlopeContains`), which is the same boundary test the link path
//    used. The wide gate-gap branch keeps the same region check as defence.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 5. #1117 rl-f: the twisted-ridge fixture's angular mapping, checked against
//    the mesh itself.
//
//    A small twisted ridge: a V-lobe whose crest rotates six degrees per
//    millimetre, so every ring's run end drifts and the transition is an
//    A-changing link. A positive machine A turns the stock by +A about the bar
//    axis (`turnStripTriangles`, `rotarySampling.ts`), so the direction the tool
//    meets at A is the mesh's `90 - A`: the fixture builds its mesh with
//    exactly that mapping, and the oracle-versus-mesh probes below catch a sign
//    error coming back.
//
//    Before rl-f this block built the mesh with `radiusAt(along, meshAngle -
//    90)`, which mirrors the ridge. The oracle then claimed 3.4909 mm where the
//    mesh stood at 2.6805 mm (at X2.895 / A14.391), and the four links rl-e's
//    review read as gouges were that mismatch -- every emitted A-changing
//    segment passes the unchanged rl-c proof once the oracle is right.
//
//    The fixture's own job is now only the geometry: the corrected model emits
//    A-changing links, and its oracle *is* the mesh. The links' safety is the
//    rl-c protected-solid replay, which rl-f runs on this same model as
//    `drawTwistCase` in `squareAroundGenerator.property.test.ts`: the replay
//    proves every link it emits (35 of them change A) with 0 mm protected-solid
//    shortfall.
//
//    rl-e's fix round 3 asserted each link's height against the body's window
//    read off this fixture. rl-f settled that the check cannot bite: the sampled
//    pose is already `linkRowAt`'s footprint-convolved `safeToolTipZAt` tip, and
//    removing the window lift from `linkAcrossAngle` changes five links out of
//    the 361 property cases. The window assertion is gone; the lift stays in
//    production as defence in depth, and no test is required to fail without it.
// ---------------------------------------------------------------------------
{
  const stock = roundStock(8, 6, 'x', { x: 0, y: 0 })
  const flat: NormalizedTool = {
    id: 'flat-1', name: '1 mm flat end mill', sourceUnits: 'mm', units: 'mm',
    type: 'flat_endmill', diameter: 1, radius: 0.5, vBitAngle: null,
    flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
    defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
  }
  const base = 2
  const lobe = 1.5
  const twist = 6
  const halfWidth = 60
  /** The model in the **Around** frame: A0 is the mesh's +up, so the crest is at A = twist * along. */
  const radiusAt = (along: number, aDeg: number): number => {
    let delta = ((aDeg - twist * along) % 360 + 360) % 360
    if (delta > 180) delta -= 360
    const u = Math.abs(delta)
    if (u >= halfWidth) return base
    const c = Math.cos(u * Math.PI / (2 * halfWidth))
    return base + lobe * c * c
  }
  const params = {
    stepover: 0.5, sampleSpacing: 0.5, stockToLeave: 0, alongStart: 0, alongEnd: 6,
    safeRadius: 12, requestedCellSize: 0.12, stepdown: 1, passDirection: 'around' as const,
  }
  // Machine A exposes mesh direction `90 - A`, so the mesh radius at a mesh
  // direction is the Around-frame radius at `90 - meshDirection`. The pre-rl-f
  // fixture used `meshAngle - 90` here, which mirrors the ridge.
  const mesh = surface(stock, (along, meshAngle) => radiusAt(along, 90 - meshAngle), 0, 6, 120, 240)
  // (1) The oracle is the mesh's own surface, not the function that built it.
  // Every probe sits halfway between two mesh rings (so the ray meets a quad's
  // interior) and on the crest and off it, where the mirrored mapping differs
  // most. The residual is the fixture's own discretisation: half an angular
  // facet (1.5 degrees at radius 3.5 gives 3e-4 mm) and the along chord of a
  // 0.05 mm ring spacing. The mirrored mapping differs by a whole millimetre.
  const probes = [
    { along: 1.025, a: twist * 1.025 },
    { along: 1.025, a: twist * 1.025 - 30 },
    { along: 3.025, a: twist * 3.025 },
    { along: 3.025, a: twist * 3.025 + 30 },
    { along: 5.025, a: twist * 5.025 },
  ]
  let worstResidual = 0
  let worstMirror = 0
  for (const probe of probes) {
    const oracle = radiusAt(probe.along, probe.a)
    const measured = meshRadiusOnRay(mesh, stock, probe.along, 90 - probe.a)
    const residual = Math.abs(measured - oracle)
    worstResidual = Math.max(worstResidual, residual)
    worstMirror = Math.max(worstMirror, Math.abs(radiusAt(probe.along, -probe.a) - oracle))
    assert.ok(residual <= 2e-3,
      `the twisted fixture's oracle and its mesh disagree at X${probe.along.toFixed(3)} `
      + `A${probe.a.toFixed(3)}: the mesh's ray intersection reads ${measured.toFixed(4)} mm, the `
      + `Around-frame model ${oracle.toFixed(4)} mm (${residual.toFixed(4)} mm apart, allowed 0.002; `
      + `the mirrored reading would be ${radiusAt(probe.along, -probe.a).toFixed(4)} mm)`)
  }
  // The probes are only load-bearing if the mapping they check matters: the
  // mirrored reading has to be far enough away to fail the assertion above.
  assert.ok(worstMirror > 0.5,
    `the probes distinguish the two angular mappings (${worstMirror.toFixed(3)} mm apart)`)
  // (2) The fixture's own coverage: the crest turns with the along position, so
  // an uninterrupted band cannot follow it and the layer splits into rings and
  // helices rather than one continuous path. Since #1103 slice ca-d the layer's
  // full rings become a helix and its partial ones retract across the crest, so
  // the along-changing cuts here are helix segments, not at-layer links. The
  // emitted motion is still proved against the reference's whole standing solid
  // in the property suite's `drawTwistCase`, not here.
  const result = generateRotaryRough('rl-f-twist', mesh, stock, flat, params, {})
  assert.deepEqual(result.warnings, [], 'the twisted-ridge rough warns about nothing')
  const alongCuts = result.moves.filter(isLinkCut)
  assert.ok(alongCuts.length > 0,
    `the twisted ridge emits continuous along-and-A cutting motion (${alongCuts.length} cuts)`)
  console.log(`  rl-f twisted ridge: ${probes.length} oracle/mesh probes agree to `
    + `${worstResidual.toFixed(5)} mm (the mirrored mapping differs by ${worstMirror.toFixed(3)} mm), `
    + `${alongCuts.length} along-and-A cutting moves`)
}

// ---------------------------------------------------------------------------
// 6. #1103 ca-d fix 1 (review P1): a forward link across the A0/A360 seam
//    samples the rows its **commanded** sweep crosses, not the long way round.
//
//    A ridge centred on the seam splits each ring below the layer that reaches
//    its crest, so the only ring-to-ring transition is the forward gap from the
//    ring's last cut (just below A360) to the next ring's first (just above A0).
//    On this fine grid (0.57 deg) walking physical indices from the first to the
//    second crosses most of the circumference -- 582 rows, past the 256-row
//    per-link budget the drift proof applies -- so the link used to retract even
//    though the commanded step is a few dozen rows forward. The corrected walk
//    crosses the seam rows and keeps the link, and the link rides the crest it
//    actually crosses.
// ---------------------------------------------------------------------------
{
  // The sweep's own contract. On a 0.573 deg grid a forward step from A346.3
  // to A373.7 (the same rotation as A13.7) crosses 49 rows in the commanded
  // direction; the physical-index walk crosses 582, past the per-link budget,
  // and the rows behind the sweep (A344/A342) are never sampled. The angles are
  // unwrapped, so the pose just past A360 is bracketed by the seam rows and not
  // by the A344/A346 pair the physical walk visited.
  const grid = Array.from({ length: 630 }, (_, k) => 360 * k / 629)
  const fromK = 605
  const toK = 24
  const fromA = grid[fromK]
  const toA = 360 + grid[toK]
  const sweep = rotaryLinkRowSweep(grid, fromK, toK, fromA, toA - fromA)
  assert.ok(sweep !== null, 'the forward seam sweep resolves')
  assert.equal(sweep.rows.length, 49, 'the seam step crosses 49 rows, not the 582 physical ones')
  assert.equal(sweep.rows[0], fromK, 'the sweep starts at the link\'s own row')
  assert.equal(sweep.rows[sweep.rows.length - 1], toK, 'the sweep ends at the destination row')
  assert.ok(!sweep.rows.includes(fromK - 1) && !sweep.rows.includes(fromK - 2),
    'the rows behind the sweep (A344/A342) are not sampled')
  for (let i = 1; i < sweep.angles.length; i++) {
    assert.ok(sweep.angles[i] > sweep.angles[i - 1],
      `the swept row angles are unwrapped and monotone (row ${i}: `
      + `${sweep.angles[i - 1].toFixed(3)} -> ${sweep.angles[i].toFixed(3)})`)
  }
  const pose = fromA + (toA - fromA) * 0.51
  const bracket = sweep.angles.findIndex((angle, i) => i + 1 < sweep.angles.length
    && angle <= pose && sweep.angles[i + 1] > pose)
  assert.ok(bracket >= 0, `the commanded pose A${pose.toFixed(3)} is bracketed by two rows`)
  assert.ok(Math.abs(sweep.angles[bracket] - 360) < 1e-9
    && Math.abs(sweep.angles[bracket + 1] - (360 + grid[1])) < 1e-9,
    `the pose at commanded A${pose.toFixed(3)} is bracketed by the seam rows `
    + `(A${(sweep.angles[bracket] % 360).toFixed(3)}/A${(sweep.angles[bracket + 1] % 360).toFixed(3)})`)

  const stock = roundStock(20, 20, 'x', { x: 0, y: 0 })
  const base = 5
  const crest = 3.6
  const halfWidth = 30
  /**
   * A narrow along-varying spike centred on the seam and **between** the ring
   * along positions. The link's dense row samples it, but the ring-grid tips the
   * body window reads do not, so the link's own bracketing rows are the only
   * thing that can size the move over it -- exactly what the unwrap decides.
   */
  const spikeHeight = 0.8
  const spikeAlong = 1
  const spikeAlongWidth = 0.25
  const spikeAngleWidth = 2
  /** The model in the **Around** frame: A0 is the mesh's +up, as in block 2. */
  const radiusAt = (along: number, aDeg: number): number => {
    let delta = ((aDeg - 90) % 360 + 360) % 360
    if (delta > 180) delta -= 360
    const u = Math.abs(delta)
    const ridge = u >= halfWidth
      ? 0
      : crest * Math.cos(u * Math.PI / (2 * halfWidth)) ** 2
    const alongFall = Math.exp(-(((along - spikeAlong) / spikeAlongWidth) ** 2) / 2)
    const angleFall = Math.exp(-((u / spikeAngleWidth) ** 2) / 2)
    return base + ridge + spikeHeight * alongFall * angleFall
  }
  const mesh = surface(stock, (along, meshAngle) => radiusAt(along, meshAngle), 0, 4, 80, 360)
  const params = {
    stepover: 2, sampleSpacing: 0.2, stockToLeave: 0, alongStart: 0, alongEnd: 4,
    safeRadius: 30, requestedCellSize: 0.2, stepdown: 1.5, passDirection: 'around' as const,
  }
  const result = generateRotaryRough('ca-d-seam-rows', mesh, stock, BALL, params, {})
  assert.deepEqual(result.warnings, [], 'the seam-ridge rough warns about nothing')
  const pivot = barPivotZ(stock)
  /** A cut whose commanded A crosses the seam: the forward ring-to-ring gap. */
  const crossesSeam = (move: ToolpathMove): boolean => isAcrossAngleCut(move)
    && Math.floor(move.from.a! / 360) !== Math.floor(move.to.a! / 360)
  const layers = perLayer(result.moves)
  const seamByLayer = layers.map((layer) => layer.filter(crossesSeam).length)
  // The first layer's full rings are a helix, which crosses the seam by turning;
  // the partial-ring layers below the crest are the ring-to-ring links. Each of
  // those used to retract: the physical-index walk charged 582 rows against the
  // 256-row per-link budget, although the commanded step is 48 rows forward.
  const linkedLayers = seamByLayer.slice(1).filter((count) => count > 0).length
  assert.ok(linkedLayers >= 2,
    `the partial-ring layers keep their forward seam link (${JSON.stringify(seamByLayer)} seam `
    + `cuts per layer; the physical-index walk crosses 582 rows against the 256-row budget)`)
  const seam = layers.slice(1).flatMap((layer) => layer.filter(crossesSeam))
  let checkedSeamPoints = 0
  let spikePoses = 0
  for (const move of seam) {
    for (const point of [move.from, move.to]) {
      const physical = ((point.a! % 360) + 360) % 360
      const along = alongOf(point)
      const model = radiusAt(along, physical)
      checkedSeamPoints++
      if (Math.abs(along - spikeAlong) <= 0.3) spikePoses++
      assert.ok(point.z - pivot >= model - 1e-6,
        `a seam link stays at or above the model at X${along.toFixed(3)} A${physical.toFixed(3)} `
        + `(${(point.z - pivot).toFixed(4)} against ${model.toFixed(4)})`)
    }
  }
  // The spike's along support has to appear in the emitted link, or the check
  // above never meets the pose the unwrap decides.
  assert.ok(spikePoses > 0,
    `the seam link samples the spike's along position (${checkedSeamPoints} seam link points)`)
  console.log(`  ca-d seam rows: ${seam.length} forward seam link cuts`)
}

// ---------------------------------------------------------------------------
// 7. #1103 ca-d correction 2 (review P1): a forward sweep **wider than 180
//    degrees** keeps its rows unwrapped in traversal order.
//
//    Shifting each row to the turn nearest the start angle is monotone only
//    while the sweep stays inside half a turn. Past 180 degrees, adjacent rows
//    fall on opposite sides of the rounding boundary and the later one is moved
//    a whole turn back, so the sequence jumps from A190.3 to A-169.1. The
//    emitter's monotone cursor (`linkAcrossAngle`) then stops at the jump and
//    brackets the pose with rows it never crosses -- the square ring suite's
//    A17967.115 -> A18235.385 link sampled A18145.385 -> A17788.846 that way.
// ---------------------------------------------------------------------------
{
  // The square ring suite's grid, and a 249.4 degree forward step: 437 rows,
  // inside the 1 024-row per-link budget, so the link is accepted and its rows
  // are what the proof reads.
  const grid = Array.from({ length: 630 }, (_, k) => 360 * k / 629)
  const fromK = 18
  const toK = 454
  const fromA = grid[fromK]
  const toA = grid[toK]
  const delta = toA - fromA
  const sweep = rotaryLinkRowSweep(grid, fromK, toK, fromA, delta)
  assert.ok(sweep !== null, 'the wide forward sweep resolves')
  assert.ok(delta > 180, `the regression sweep is wider than half a turn (${delta.toFixed(3)} deg)`)
  assert.equal(sweep.rows.length, toK - fromK + 1, 'the sweep crosses the forward rows only')
  assert.equal(sweep.rows[0], fromK, 'the sweep starts at the link\'s own row')
  assert.equal(sweep.rows[sweep.rows.length - 1], toK, 'the sweep ends at the destination row')
  for (let i = 1; i < sweep.angles.length; i++) {
    assert.ok(sweep.angles[i] > sweep.angles[i - 1],
      `the swept row angles stay monotone past 180 degrees (row ${i}: `
      + `${sweep.angles[i - 1].toFixed(3)} -> ${sweep.angles[i].toFixed(3)})`)
  }
  assert.ok(Math.abs(sweep.angles[0] - fromA) < 1e-9
    && Math.abs(sweep.angles[sweep.angles.length - 1] - toA) < 1e-9,
    `the sweep spans the commanded A${fromA.toFixed(3)} -> A${toA.toFixed(3)} `
    + `(rows A${sweep.angles[0].toFixed(3)} -> A${sweep.angles[sweep.angles.length - 1].toFixed(3)})`)
  // The emitter's own monotone cursor, run over the sweep exactly as
  // `linkAcrossAngle` runs it: at every pose the two bracketing rows must be the
  // grid rows immediately below and above the commanded angle.
  let cursor = 0
  for (const fraction of [0.1, 0.25, 0.5, 0.75, 0.9, 0.99]) {
    const pose = fromA + delta * fraction
    while (cursor + 1 < sweep.rows.length && sweep.angles[cursor + 1] < pose) cursor++
    assert.ok(sweep.angles[cursor] <= pose + 1e-9 && sweep.angles[cursor + 1] > pose - 1e-9,
      `the cursor brackets the commanded pose A${pose.toFixed(3)} with rows `
      + `A${sweep.angles[cursor].toFixed(3)}/A${sweep.angles[cursor + 1].toFixed(3)}`)
  }
  console.log(`  ca-d wide sweep: ${sweep.rows.length} rows monotone across ${delta.toFixed(3)} deg`)
}

console.log('engine/toolpaths/rotaryAcrossAngleLinks.test.ts passed')
