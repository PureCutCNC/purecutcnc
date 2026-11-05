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
 * #1103 slice ca-j: a **square blank** helixes a band once the layer is round.
 *
 * Frank's retest of PR #1152: on a square blank (`busto-rect-stock.camj`) the
 * rotary rough never used the helix, even on the layers whose corners the
 * earlier layers had already removed. `buildContinuousHelix` refused every
 * non-round stock before sampling, so ten otherwise-eligible bands per part
 * were cut as rings. The slice admits the square blank on the same rules a round
 * bar already had:
 *
 * - the band is a whole ring at every angle under the blank's **material-touch
 *   gate** (`squareRotaryTouchRadius`) and every pose has material standing at
 *   this layer (`tip < previousRadius`) -- a band with corners still standing
 *   keeps its rings. A **finish** has no layer, so its rule is the ring grid's
 *   own: every sample of the band is the model under the tool (review P1).
 * - every sampled pose takes the blank's **retained-stub contact floor**
 *   (`squareRotaryStubContactFloor`) at its own along and angle, the same closed
 *   form `completeRotaryTargets` puts on every ring sample, so a helix point is
 *   never lower than the ring path would allow there;
 * - the turns **overlap** on a square blank (`continuousHelixStepover`): a pitch
 *   of a full cutter diameter leaves the blank's corner shell between two turns
 *   outside both flanks, and a round bar (which has no corner shell above the
 *   tip) keeps the requested stepover byte for byte;
 * - the angle-map cache is on for square-blank around operations exactly as for
 *   round ones, through the ca-i worker transport.
 *
 * ## What each block pins, and the mutation it catches
 *
 * 1. **The generator, rough and finish.** A square blank whose layers have
 *    become round cuts each band as one helix (a long run of cut moves with one
 *    constant axial advance per degree), while a layer with its corners still
 *    standing keeps its rings. The **finish** is admitted on the same slice
 *    (#1103 ca-j review P1): its whole-ring band is one helix, every pose stays
 *    the ring path's one cutter radius inside a retained face, and the turns
 *    overlap so the blank's corner shell between them is cleared, while a
 *    round bar keeps the requested stepover exactly. Mutation: re-add the shape
 *    guard (`stock.shape !== 'round'` returns `null`) -- no helix run exists;
 *    drop the square turn overlap -- the square pitch reaches a full diameter.
 * 2. **The gate at the helix pose.** `ContinuousHelixLayer.material` answers for
 *    the blank, so a pose where no material stands at this layer refuses the
 *    band (`ineligible`, no points) exactly as a pose with no model does.
 *    Mutation: drop the gate check from `sampleHelixRows` -- the refused band
 *    returns a path.
 * 3. **The retained-stub floor.** A band whose start sits inside a retained
 *    stub's reach is floored at the closed form at every pose; the same build
 *    without the floor sits on the model, below the stub. This is the shape
 *    both generators supply (no `layer` on the finish), so the mutation covers
 *    both. Mutation: skip the floor on helix points -- the floor assertions
 *    fail.
 * 4. **The cache.** With the ring grid's maps in the workspace the square
 *    blank's helix reads every row (near-zero raster work); the `'off'` control
 *    rasterises them all and cuts the same path. Mutation: keep the helix's row
 *    prep out of `read-write` -- the work figures become equal.
 * 5. **The generator installs the cache and the transport carries it.** The
 *    square-blank around rough runs through a real worker pool: the pooled
 *    program is byte-identical to the serial one and the workers hand maps back.
 *    Mutation: put the old `stock.shape === 'round'` back on the prep's
 *    `angleMaps` -- the pool returns no map, and `reusedRows` stops paying for
 *    itself on the square path.
 *
 * Run with: npx tsx src/engine/toolpaths/rotarySquareHelix.test.ts
 */

import assert from 'node:assert/strict'
import { barCentre, barMaxRadius, barPivotZ, barInscribedRadius, squareStock } from '../../types/barStock'
import { roundStock as roundBarStock } from '../../types/project'
import type { BarStock } from '../../types/project'
import {
  createRotarySamplingPrep, refineAroundSampling, sampleAnglesWithPrep,
} from './rotarySampling'
import type { RotarySamplingPrep, RotarySamplingWorkspace } from './rotarySampling'
import { buildContinuousHelix } from './rotaryContinuous'
import type { ContinuousHelix, ContinuousHelixLayer } from './rotaryContinuous'
import { generateRotaryFinish, generateRotaryRough, generateRotaryRoughAsync } from './rotaryModel'
import type { RotaryModelMesh } from './rotaryModel'
import { createRotaryAnglePool } from './rotaryAnglePool'
import { createNodeRotaryAngleWorkerSource } from '../../app/toolpathGeneration/rotaryAngleNodeTransport'
import { squareRotaryStubContactFloor, squareRotaryTouchRadius } from './squareRotaryStock'
import type { NormalizedTool, ToolpathMove, ToolpathPoint } from './types'

const BALL: NormalizedTool = {
  id: 'ball-2', name: '2 mm ball nose', sourceUnits: 'mm', units: 'mm',
  type: 'ball_endmill', diameter: 2, radius: 1, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}

/**
 * A square blank with a coaxial **cone** target inside it: round at every layer
 * (so a band of whole rings exists) and not collinear along the bar (so the
 * emitted helix is not merged into a few straight commands and every pose of it
 * can be checked).
 */
const SIDE = 20
const LENGTH = 24
const MODEL_LOW = 4
const MODEL_HIGH = 6
const STOCK = squareStock(SIDE, LENGTH, 'x')

function coaxialCone(stock: BarStock, low: number, high: number, from: number, to: number, segments = 96): RotaryModelMesh {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const positions: number[] = []
  const index: number[] = []
  for (const [along, radius] of [[from, low], [to, high]] as const) {
    for (let i = 0; i < segments; i++) {
      const t = (2 * Math.PI * i) / segments
      if (stock.axis === 'x') positions.push(along, centre + radius * Math.cos(t), pivot + radius * Math.sin(t))
      else positions.push(centre + radius * Math.cos(t), along, pivot + radius * Math.sin(t))
    }
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    index.push(i, j, segments + j, i, segments + j, segments + i)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

const MESH = coaxialCone(STOCK, MODEL_LOW, MODEL_HIGH, 3, 21)

const ROUGH = {
  stepover: 2, sampleSpacing: 2, stockToLeave: 0, alongStart: 3, alongEnd: 21,
  safeRadius: barMaxRadius(STOCK) * 2, requestedCellSize: 0.25, stepdown: 2,
  passDirection: 'around' as const,
}
const FINISH = {
  stepover: 2, sampleSpacing: 2, stockToLeave: 0, alongStart: 3, alongEnd: 21,
  safeRadius: barMaxRadius(STOCK) * 2, requestedCellSize: 0.25,
  passDirection: 'around' as const,
}

const alongOf = (point: ToolpathPoint): number => STOCK.axis === 'x' ? point.x : point.y
const angleOf = (point: ToolpathPoint): number => point.a ?? 0
const tipOf = (point: ToolpathPoint): number => point.z - barPivotZ(STOCK)

/**
 * A helix as this module emits it: consecutive cut moves that advance along the
 * bar and turn A together, at one **constant axial advance per degree**. A ring
 * link that happens to advance and turn does not have a run of them around one
 * pitch, which is what separates the helix from the ring path's corner-arc and
 * gate-gap links (the naive "changes along and A" test counts those too).
 */
interface HelixRun {
  readonly from: number
  readonly pitch: number
  readonly moves: number
}

function helixRuns(moves: readonly ToolpathMove[]): HelixRun[] {
  const runs: HelixRun[] = []
  let start = -1
  let pitch = 0
  let count = 0
  const flush = (): void => {
    if (count >= 6) runs.push({ from: start, pitch, moves: count })
    start = -1
    count = 0
  }
  for (let i = 0; i < moves.length; i++) {
    const move = moves[i]
    const along = move.kind === 'cut' ? alongOf(move.to) - alongOf(move.from) : 0
    const turn = move.kind === 'cut' ? angleOf(move.to) - angleOf(move.from) : 0
    if (Math.abs(along) > 1e-12 && Math.abs(turn) > 1e-9) {
      const next = along / turn
      if (start < 0) {
        start = i
        pitch = next
        count = 1
        continue
      }
      if (Math.abs(next - pitch) <= 1e-6 * Math.max(Math.abs(pitch), Math.abs(next))) {
        count++
        continue
      }
    }
    flush()
  }
  flush()
  return runs
}

/**
 * The axial advance per revolution of every helix the layer emits (#1103 slice
 * ca-j): the pitch of an unmerged run, and of a merged command spanning whole
 * turns. A square blank overlaps its turns (`continuousHelixStepover`); a round
 * bar keeps the requested stepover exactly.
 */
function helixPitchesPerTurn(moves: readonly ToolpathMove[]): number[] {
  const pitches = helixRuns(moves).map((run) => Math.abs(run.pitch) * 360)
  for (const move of moves) {
    if (move.kind !== 'cut') continue
    const along = alongOf(move.to) - alongOf(move.from)
    const turn = angleOf(move.to) - angleOf(move.from)
    if (Math.abs(along) > 1e-12 && Math.abs(turn) >= 360 - 1e-9) {
      pitches.push(Math.abs(along / turn) * 360)
    }
  }
  return pitches
}

/**
 * Whether a layer is cut by a **helix**: either a run of unmerged (along, A)
 * segments at one pitch, or a merged command spanning whole turns. The generator
 * merges collinear cuts, and a helix over a *linear* profile (a cylinder or a
 * cone) is exactly one straight line in (along, A, Z), so most of the fixture's
 * bands arrive as one multi-turn command.
 */
function isHelixed(layer: readonly ToolpathMove[]): boolean {
  if (helixRuns(layer).length > 0) return true
  return layer.some((move) => move.kind === 'cut'
    && Math.abs(angleOf(move.to) - angleOf(move.from)) >= 360 - 1e-9
    && Math.abs(alongOf(move.to) - alongOf(move.from)) > 1e-12)
}

/** The layers of an around rough: each ends with the rapid back along the bar. */
function layerMoves(moves: readonly ToolpathMove[]): ToolpathMove[][] {
  const layers: ToolpathMove[][] = [[]]
  for (const move of moves) {
    if (move.kind === 'rapid' && alongOf(move.to) < alongOf(move.from) - 1e-9) layers.push([])
    else layers[layers.length - 1].push(move)
  }
  return layers.filter((layer) => layer.length > 0)
}

// ── 1. the generator: a round layer of a square blank is one helix ─────────
console.log('Testing that a square blank helixes the bands its earlier layers made round...')
{
  const result = generateRotaryRough('square-helix', MESH, STOCK, BALL, ROUGH, {})
  assert.deepEqual(result.warnings, [], 'the square rough warns about nothing')
  const layers = layerMoves(result.moves)
  assert.ok(layers.length >= 5, `the fixture has several layers (${layers.length})`)
  const runsPerLayer = layers.map((layer) => helixRuns(layer))
  // The top layers are above the blank's flat face: the gate holds only near the
  // corners, so a ring is a corner arc (A turns at one along position), an
  // along-link, or at most one gate-gap link -- never a helix. The helix
  // detector below is the same one the deeper layers must pass.
  let topLayers = 0
  for (const layer of layers) {
    if (isHelixed(layer)) break
    topLayers++
    assert.ok(layer.some((move) => move.kind === 'cut'),
      'a corner layer still cuts its arcs, so the "no helix" check is not vacuous')
  }
  assert.ok(topLayers >= 1 && topLayers < layers.length,
    `the corner layers keep their rings and a deeper, round layer does not (${topLayers} of ${layers.length})`)
  // Every deeper layer that has whole rings is one helix band: the fixture is a
  // surface of revolution, so a round layer carries a single band.
  let helixLayers = 0
  let helixMoves = 0
  for (const [index, layer] of layers.entries()) {
    if (!isHelixed(layer)) continue
    helixLayers++
    const runs = runsPerLayer[index]
    assert.ok(runs.length <= 1, `a round layer is one helix band (${runs.length} runs)`)
    helixMoves += runs.reduce((count, run) => count + run.moves, 0)
      + layer.filter((move) => move.kind === 'cut'
        && Math.abs(angleOf(move.to) - angleOf(move.from)) >= 360 - 1e-9).length
  }
  assert.ok(helixLayers >= 3, `most round layers helix (${helixLayers})`)
  assert.ok(helixMoves >= 3, `the helix moves are the layer's cut, not a link (${helixMoves})`)
  // The helix cuts the layer, not the model: never below `max(model, layer)`, and
  // never above the blank's own envelope.
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    for (const point of [move.from, move.to]) {
      const tip = tipOf(point)
      assert.ok(tip >= MODEL_LOW - 0.2, `no cut dives below the model (${tip.toFixed(3)})`)
      // The emitter's at-layer links ride the blank's envelope plus its 1 mm
      // clearance, so a link's cut sits that much above the corner.
      assert.ok(tip <= barMaxRadius(STOCK) + 1.5, `no cut leaves the blank (${tip.toFixed(3)})`)
    }
  }
  // A stays forward: the helix is one-way, like the round bar's.
  let lastSign = 0
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    const turn = angleOf(move.to) - angleOf(move.from)
    if (Math.abs(turn) < 1e-12) continue
    const sign = Math.sign(turn)
    assert.ok(lastSign === 0 || sign === lastSign, 'A never reverses across a square blank helix')
    lastSign = sign
  }
  console.log(`  rough: ${layers.length} layers, ${topLayers} corner layers on rings, `
    + `${helixLayers} round layers in ${helixMoves} helix moves`)

  // The finish is admitted on the same slice (#1103 ca-j review P1): its band is
  // a whole ring of the model at every angle, so this coaxial cone's whole band
  // is one helix, and every pose takes the operation's own retained-stub floor
  // (`continuousHelixStubFloor`, the closed form the ring samples take).
  const finish = generateRotaryFinish('square-helix-finish', MESH, STOCK, BALL, FINISH, {})
  assert.deepEqual(finish.warnings, [], 'the square finish warns about nothing')
  assert.equal(isHelixed(finish.moves), true,
    'a square blank\'s finish helixes its whole-ring band (rough and finish alike)')
  const finishPitches = helixPitchesPerTurn(finish.moves)
  assert.ok(finishPitches.length > 0, `the finish emitted a helix (${finishPitches.length} runs/cuts)`)
  const pitchLimit = 2 * BALL.radius
  for (const pitch of finishPitches) {
    assert.ok(pitch < pitchLimit - 1e-9,
      `the finish overlaps its turns so the blank's corner shell between them is cleared (${pitch.toFixed(4)} < ${pitchLimit})`)
  }
  // The ring path's retained-stub protection, at every finish pose: the band is
  // pulled one cutter radius inside each stubbed end (`rotaryCutterSpan`), so
  // the centre never comes closer than a radius to a stub face. The exact
  // `squareRotaryStubContactFloor` is a tangency there and only binds where a
  // pose is closer -- that half is proved on the builder itself in block 3
  // (a band given at the stub face is floored exactly as a ring sample is).
  const pullStart = FINISH.alongStart + BALL.radius
  const pullEnd = FINISH.alongEnd - BALL.radius
  let finishPoses = 0
  let finishMinAlong = Number.POSITIVE_INFINITY
  let finishMaxAlong = Number.NEGATIVE_INFINITY
  for (const move of finish.moves) {
    if (move.kind !== 'cut') continue
    for (const point of [move.from, move.to]) {
      const along = alongOf(point)
      finishPoses++
      finishMinAlong = Math.min(finishMinAlong, along)
      finishMaxAlong = Math.max(finishMaxAlong, along)
      assert.ok(along >= pullStart - 1e-9 && along <= pullEnd + 1e-9,
        `a finish pose stays a cutter radius inside both stub faces (x ${along.toFixed(4)})`)
      const tip = tipOf(point)
      assert.ok(tip >= MODEL_LOW - 0.2, `no finish cut dives below the model (${tip.toFixed(3)})`)
    }
  }
  assert.ok(finishPoses > 0, 'the finish emitted poses')
  assert.ok(Math.abs(finishMinAlong - pullStart) < 1e-6 && Math.abs(finishMaxAlong - pullEnd) < 1e-6,
    `the finish band is the whole pulled span (${finishMinAlong.toFixed(4)}..${finishMaxAlong.toFixed(4)})`)
  // A stays forward on the finish too: the helix is one-way, like the rough's.
  let finishSign = 0
  for (const move of finish.moves) {
    if (move.kind !== 'cut') continue
    const turn = angleOf(move.to) - angleOf(move.from)
    if (Math.abs(turn) < 1e-12) continue
    const sign = Math.sign(turn)
    assert.ok(finishSign === 0 || sign === finishSign, 'A never reverses across a square blank finish helix')
    finishSign = sign
  }
  console.log(`  finish: ${finishPitches.length} helix runs, pitch ${finishPitches[0].toFixed(3)} (limit ${pitchLimit}), `
    + `${finishPoses} poses inside the pulled span ${finishMinAlong.toFixed(2)}..${finishMaxAlong.toFixed(2)}`)

  // The turn overlap is the **square blank's** rule: a round bar has no corner
  // shell standing above the tip, so its pitch stays exactly the requested
  // stepover, and its bytes do not move (the ca-i identity rows pin that).
  const roundBar = roundBarStock(20, 24, 'x')
  const roundMesh = coaxialCone(roundBar, MODEL_LOW, MODEL_HIGH, 3, 21)
  const roundRough = generateRotaryRough('round-helix-pitch', roundMesh, roundBar, BALL, {
    ...ROUGH, safeRadius: barMaxRadius(roundBar) * 2,
  }, {})
  const roundPitches = helixPitchesPerTurn(roundRough.moves)
  assert.ok(roundPitches.length > 0, 'the round control is helixed')
  for (const pitch of roundPitches) {
    assert.ok(Math.abs(pitch - pitchLimit) <= 1e-6,
      `a round bar keeps the requested stepover exactly (${pitch.toFixed(6)} = ${pitchLimit})`)
  }
  const squareRoughPitches = helixPitchesPerTurn(result.moves)
  assert.ok(squareRoughPitches.length > 0, 'the square rough is helixed')
  for (const pitch of squareRoughPitches) {
    assert.ok(pitch < pitchLimit - 1e-9,
      `the square blank overlaps its turns on the rough too (${pitch.toFixed(4)} < ${pitchLimit})`)
  }
  console.log(`  pitch: square rough ${squareRoughPitches[0].toFixed(3)} and finish ${finishPitches[0].toFixed(3)} `
    + `overlap; round ${roundPitches[0].toFixed(3)} is the requested stepover`)}

// ── 2. the material-touch gate at every helix pose ────────────────────────
console.log('Testing that a square-blank pose with no material keeps the band on rings...')
{
  const along = [8, 10, 12, 14]
  const prep = createRotarySamplingPrep(MESH, STOCK, BALL, {
    along, requestedCellSize: ROUGH.requestedCellSize, conservativeCellBounds: true, workspace: {},
  })
  const build = (layer: ContinuousHelixLayer): ContinuousHelix | null => buildContinuousHelix({
    prep, tool: BALL, band: { start: 8, end: 14 }, stepover: 2, sampleSpacing: 2,
    stockToLeave: 0, warnings: [], layer,
  })
  // A layer whose corners still stand: the ring path skips those angles as air,
  // and a pose of the helix there refuses the band rather than cutting it.
  const refused = build({
    radius: barInscribedRadius(STOCK) + 1, previousRadius: barMaxRadius(STOCK),
    material: (angle: number) => barInscribedRadius(STOCK) + 1
      < squareRotaryTouchRadius(STOCK, angle, BALL.radius, BALL.type),
  })
  assert.ok(refused !== null, 'the band reaches the builder')
  assert.equal(refused.points.length, 0, 'a corner-standing layer emits no helix')
  assert.equal(refused.ineligible, true, 'the refusal is the layer rule, not a budget')
  // The same band on a deeper layer (every pose still cuts) is a helix.
  const built = build({
    radius: MODEL_HIGH + 1, previousRadius: MODEL_HIGH + 2,
    material: (angle: number) => MODEL_HIGH + 1
      < squareRotaryTouchRadius(STOCK, angle, BALL.radius, BALL.type),
  })
  assert.ok(built !== null, 'the deeper band reaches the builder')
  assert.ok(built.points.length > 1, 'the deeper band is a helix')
  assert.equal(built.ineligible, false, 'the deeper band is eligible')
  // Nothing under the tool on one angle would refuse it the same way; the gate
  // is a second, blank-side rule and not a disguised version of that one.
  const airless = build({
    radius: MODEL_HIGH + 1, previousRadius: MODEL_HIGH + 2,
    material: () => false,
  })
  assert.equal(airless?.ineligible, true, 'a pose the gate rejects refuses the band')
  console.log(`  gate: corner layer refused (ineligible), round layer ${built.points.length} poses`)
}

// ── 3. the retained-stub floor at every helix pose ────────────────────────
console.log('Testing that a helix point inside a stub\'s reach is floored like a ring sample...')
{
  // The band opens on the stub's face: every pose inside one cutter radius of it
  // is where `squareRotaryStubContactFloor` lifts the ring path's samples too.
  const bandStart = 6
  const bandEnd = 14
  const along = [bandStart, bandStart + 2, bandStart + 4, bandStart + 6, bandEnd]
  const prep = createRotarySamplingPrep(MESH, STOCK, BALL, {
    along, requestedCellSize: ROUGH.requestedCellSize, conservativeCellBounds: true, workspace: {},
  })
  const floorAt = (alongPosition: number, angle: number): number =>
    squareRotaryStubContactFloor(STOCK, angle, BALL.radius, BALL.type, alongPosition - bandStart)
  const build = (withFloor: boolean): ContinuousHelix | null => buildContinuousHelix({
    prep, tool: BALL, band: { start: bandStart, end: bandEnd }, stepover: 2, sampleSpacing: 2,
    stockToLeave: 0, warnings: [], ...(withFloor ? { stubFloor: floorAt } : {}),
  })
  const floored = build(true)
  const raw = build(false)
  assert.ok(floored !== null && floored.points.length > 1, 'the floored band is a helix')
  assert.ok(raw !== null && raw.points.length > 1, 'the unfloored band is a helix')
  // The floor changes the tips, so the refinement's midpoints move with them: the
  // two paths share the band and the pose grid's knots, not every bisection.
  let lifted = 0
  let exact = 0
  for (let i = 0; i < floored.points.length; i++) {
    const point = floored.points[i]
    const floor = floorAt(alongOf(point), angleOf(point))
    assert.ok(tipOf(point) >= floor - 1e-6,
      `pose ${i} is at or above the ring path's stub floor (${tipOf(point).toFixed(5)} >= ${floor.toFixed(5)})`)
    if (Number.isFinite(floor) && Math.abs(tipOf(point) - floor) < 1e-5) exact++
    else lifted++
  }
  assert.ok(lifted > 0, `the floor is load-bearing on this band (${lifted} poses lifted)`)
  assert.ok(exact > 0, `a lifted pose is exactly the closed form the ring sample takes (${exact})`)
  // At the stub face the floor is the blank's own material: the raw helix sits on
  // the model there, which is the gouge this floor exists to prevent.
  const first = raw.points[0]
  assert.ok(tipOf(first) < floorAt(alongOf(first), angleOf(first)),
    'the unfloored band really would cut into the retained stub')
  console.log(`  stub floor: ${lifted} of ${floored.points.length} poses lifted, ${exact} exactly on the closed form`)
}

// ── 4. the cache serves the square blank's helix ──────────────────────────
console.log('Testing that the square blank\'s helix reads the ring grid\'s angle maps...')
{
  /** The ring grid's angles, built the way `aroundGrid` builds them. */
  function ringAngles(sampleSpacing: number): number[] {
    const radius = barMaxRadius(STOCK)
    const cap = Math.sqrt(8 * radius * 0.005)
    const step = Math.min(sampleSpacing, cap)
    const intervals = Math.ceil((2 * Math.PI * radius) / Math.max(step, 1e-9))
    return Array.from({ length: intervals + 1 }, (_, k) => 360 * k / intervals)
  }
  const along = Array.from({ length: 9 }, (_, i) => ROUGH.alongStart + (ROUGH.alongEnd - ROUGH.alongStart) * i / 8)
  const prepFor = (workspace: RotarySamplingWorkspace, mode: 'off' | 'write'): RotarySamplingPrep =>
    createRotarySamplingPrep(MESH, STOCK, BALL, {
      along, requestedCellSize: ROUGH.requestedCellSize, conservativeCellBounds: true,
      angleMaps: mode, workspace,
    })
  /** The generator's own first pass: the ring grid, then its refinement. */
  function sampleRingGrid(prep: RotarySamplingPrep): void {
    const sampled = sampleAnglesWithPrep(prep, ringAngles(ROUGH.sampleSpacing), [])
    assert.ok(sampled.valid, 'the ring grid samples on the square blank')
    const refined = refineAroundSampling({
      prep, stock: STOCK, tool: BALL, warnings: [], angles: sampled.anglesDeg, tips: sampled.tipRadius,
    })
    assert.ok(refined !== null, 'the ring refinement samples on the square blank')
  }
  const helixFor = (prep: RotarySamplingPrep): ContinuousHelix | null => buildContinuousHelix({
    prep, tool: BALL, band: { start: ROUGH.alongStart, end: ROUGH.alongEnd },
    stepover: ROUGH.stepover, sampleSpacing: ROUGH.sampleSpacing, stockToLeave: 0, warnings: [],
  })
  const write = prepFor({}, 'write')
  sampleRingGrid(write)
  const cached = helixFor(write)
  assert.ok(cached !== null && cached.points.length > 1, 'the cached band is a helix')
  assert.ok(cached.rows > 100, `the helix has rows to account for (${cached.rows})`)
  assert.ok(cached.reusedRows >= cached.rows - 1,
    `every helix row is read from the ring grid's maps (${cached.reusedRows} of ${cached.rows})`)
  const uncached = helixFor(prepFor({}, 'off'))
  assert.ok(uncached !== null && uncached.points.length > 1, 'the control band is a helix')
  assert.equal(uncached.reusedRows, 0, 'the control reuses nothing')
  assert.ok(uncached.rasterWork > 0,
    `the control rasterises its rows (${uncached.rasterWork})`)
  assert.ok(cached.rasterWork * 10 < uncached.rasterWork,
    `reuse removes almost all of the control's work (${cached.rasterWork} versus ${uncached.rasterWork})`)
  assert.equal(cached.points.length, uncached.points.length, 'the cache moves no pose')
  for (let i = 0; i < cached.points.length; i++) {
    for (const axis of ['x', 'y', 'z', 'a'] as const) {
      const left = cached.points[i][axis] ?? 0
      const right = uncached.points[i][axis] ?? 0
      assert.ok(Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(left), Math.abs(right)),
        `the cached path is the same path (pose ${i} ${axis}: ${left} versus ${right})`)
    }
  }
  console.log(`  cache: ${cached.reusedRows}/${cached.rows} rows reused, `
    + `${cached.rasterWork} versus ${uncached.rasterWork} triangle raster passes, same path`)
}

// ── 5. the generator installs the cache, and the worker transport carries it ──
console.log('Testing that the square blank\'s generator keeps maps and the pool returns them...')
{
  const serial = generateRotaryRough('square-pool', MESH, STOCK, BALL, ROUGH, {})
  const source = createNodeRotaryAngleWorkerSource({ availableParallelism: 4 })
  let pool: ReturnType<typeof createRotaryAnglePool> | null = null
  const pooled = await generateRotaryRoughAsync('square-pool', MESH, STOCK, BALL, ROUGH, {}, (prep) => {
    const created = createRotaryAnglePool(prep, source, { maxWorkers: 2 })
    pool = created
    return created.batches
  })
  assert.ok(pool !== null, 'the pool was created')
  const stats = (pool as ReturnType<typeof createRotaryAnglePool>).stats()
  await (pool as ReturnType<typeof createRotaryAnglePool>).dispose()
  assert.equal(stats.mode, 'parallel', 'the square rough ran on real workers')
  assert.ok((stats.maps ?? 0) > 0,
    `the ring grid kept its angle maps on the square blank and the workers handed them back (${stats.maps ?? 0})`)
  assert.deepEqual(pooled.moves, serial.moves, 'the pooled square program is the serial one')
  console.log(`  pool: ${stats.maps} maps, ${((stats.mapBytes ?? 0) / 1024).toFixed(0)} KB returned, `
    + `${pooled.moves.length} moves identical to serial`)
}

console.log('engine/toolpaths/rotarySquareHelix.test.ts: all assertions passed')
