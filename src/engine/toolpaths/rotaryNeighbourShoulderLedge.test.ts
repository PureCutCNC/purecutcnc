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
 * #1177: a rotary Turn whose band starts **inside** a neighbour's flat clears the
 * stock across that flat at the shoulder within the handoff's 0.05 mm -- over the
 * whole overlap, not only at the handoff's spots -- and still cuts no lower
 * than it.
 *
 * Frank's `bolt-test-02-x.camj` is built in code with the canned planner (a Ø2
 * in bar along X, a 1.5 in across-flats Hex over 0.75..1.25, a Ø1 Turn over
 * 1.2..3.75, the file's flat 1/4" endmill, stepovers and leaves), so the Turn's
 * band starts 0.05 in inside the Hex -- the overlap that leaves the ledge. Its
 * rough and finish are generated through production `computeOperationToolpath`.
 *
 * **The defect.** `rotaryBandEnds` sees the taller Hex across the Turn's start
 * and keeps the one-radius pull, so the first ring's centre sits at 1.325 and
 * only its rim reaches the band face at 1.2. The exact footprint read keeps the
 * cutter out of the Hex, and the flat stock the rim does not reach is left as a
 * wedge tapering to nothing at the Hex's end face: 0.50 mm above the Hex plane
 * at (X 1.21, A 25°) before this fix.
 *
 * **The sweep.** `shoulderCleanFaces` puts two rings on the overlap's quarters
 * (1.2125 and 1.2375 in), so every along position in the overlap is within
 * `0.0125 in` of one of them. That distance is the sweep's parameter, not a
 * detail: a flat disc reaches only radii up to `sqrt(r^2 - d^2) / sin(delta)` at
 * angular offset `delta` from its own pose, and the pose that clears the corner
 * of the Hex's flat is the one at that limit. A single ring on the overlap's
 * middle leaves `d = 0.025` at the band face, where the limit falls 0.4 per cent
 * short of the pose the chain needs and the shoulder stalls at 0.080 mm -- the
 * correction this file's bound was written for.
 *
 * The rings are neighbour-reach columns: their positions are merged into the
 * along grid before `rotaryNeighbourColumns`, so each takes the exact footprint
 * read on the mesh *with* the neighbours. That is the neighbour protection --
 * the cutter body never goes below the Hex -- and it is why the cleanup needs no
 * new sampling code. They are emitted **right after the first ring**, at that
 * ring's own end angle and height: the move back is a short cut along the
 * neighbour's surface, not a retract, so the operation keeps its one G0 Z lift
 * (the final retract) and #1173's first-ring A0..A360 is untouched.
 *
 * **Three spring passes per ring.** The exact read sets each pose's tip by the
 * **uphill rim** of its disc, and a forward ring can only *spend* the one pose
 * per angle whose rim reaches furthest: the material at angle A is cut by the
 * pose about 8.4 degrees behind it, and if that pose's reach has not cleared the
 * material the pose still standing -- a step or so later in the sweep -- cuts
 * less. So one pass lowers the shoulder by one landing step, and the passes that
 * follow, on grids a third of a step on, spend the poses the pass before could
 * not (`RotaryTargets.shoulderCleanRings`). Three passes on the two quarter
 * rings reach the corner scallop's floor: 0.033 mm worst in the overlap, against
 * 0.047 with either half alone and 0.080 with the correction's single middle
 * ring and its two spring passes. Each pass is a 0.4 degree step -- a 10.5 ms
 * block at the flat's 0.75 in radius and a 30 ipm feed, over the 10 ms #1173's
 * smoothness rule names -- and the seam between two passes is more than a step,
 * so the sweep adds no short block anywhere.
 *
 * The sweep's pose window matters here. `cutterPosesByAngle`'s default is
 * `asin(toolRadius / barMaxRadius) + 0.5` = 7.68 degrees, sized by the
 * **blank**; the shoulder is on the Hex, whose 0.75 in flat subtends
 * `asin(0.125 / 0.75)` = 9.59 degrees. The default drops the rim poses that
 * physically touch the flat, so the same program reads 0.11 mm with it and
 * 0.017 mm with the flat's own window. This test passes the real window; the
 * reach check inside `sweepProfile` still decides per along position whether a
 * pose's body covers the sample, so the wider window credits nothing that does
 * not reach.
 *
 * Mutations this file is checked with (each applied, seen failing, restored):
 *   1. `shoulderCleanFaces` returns no faces -> no ring is added and the
 *      residual at the spots goes back to 0.28-0.50 mm;
 *   2. the cleanup positions are merged into the along grid *after*
 *      `rotaryNeighbourColumns` -> they are not neighbour-reach columns, the
 *      base prep reads the Turn's own surface there, and the cutter cuts the Hex
 *      away (the gouge check fails);
 *   3. the rings are emitted in grid order instead of after the first ring -> the
 *      finish's first ring no longer leads at A0 (the placement check here
 *      fails); the #1173 suite's A0..A360 pin is on the **rough**, which still
 *      emits its rings last, so that suite stays green;
 *   4. the third spring pass is dropped -> the worst in the overlap goes back to
 *      0.047 mm, six per cent inside the bound, and the entry check fails (the
 *      last pass no longer ends on the turn the next unit starts at);
 *   5. the single middle ring is restored, with the two spring passes it was
 *      written with -> the worst goes back to 0.080 mm and the 0.05 bound fails
 *      (the correction round 1 review's finding);
 *   6. the ring is emitted last (the pre-correction placement) -> the finish
 *      gains a second upward rapid and the short-block check fails;
 *   7. the 0.4 degree grid is replaced by the refined grid -> the ring's
 *      0.11-0.22 degree steps are sub-10 ms blocks and the block check fails.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryNeighbourShoulderLedge.test.ts
 */

import assert from 'node:assert/strict'
import { barCentre, barPivotZ } from '../../types/barStock'
import type { BarStock } from '../../types/project'
import { defaultTool, newProject, roundStock } from '../../types/project'
import type { Operation, Project, Tool } from '../../types/project'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { planRotarySolid } from '../../store/helpers/rotarySolids'
import type { SelectionState } from '../../store/types'
import { minRenderHeight } from '../csg'
import { computeOperationToolpath } from './generateOperation'
import { normalizeToolForProject } from './geometry'
import type { ToolpathMove } from './types'
import { deepestCutterGouge } from '../../test/rotaryCutterGouge'
import { blankProfile, cutterPosesByAngle, sweepProfile } from '../../test/rotaryWallFootSweep'
import type { WallFootProfile } from '../../test/rotaryWallFootSweep'

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
/**
 * Where the cleanup rings sit: the overlap's quarters, so every along position in
 * 1.2..1.25 is within `(HEX_END - TURN_START) / 4` of one of them. See
 * `shoulderCleanFaces`.
 */
const OVERLAP = HEX_END - TURN_START
const CLEANUP_POSITIONS = [TURN_START + OVERLAP / 4, TURN_START + 3 * OVERLAP / 4]
/**
 * The sweep's pose window for the shoulder. The default is sized by the blank's
 * radius (7.68 degrees); the flat being cleaned subtends
 * `asin(radius / flatRadius)` = 9.59, so the rim poses that physically touch it
 * are inside this window. `sweepProfile`'s own reach check still decides every
 * pose, so the wider window cannot credit a pose the body does not reach.
 */
const POSE_WINDOW_DEG = Math.asin(FLAT_RADIUS / (HEX_ACROSS_FLATS / 2)) * 180 / Math.PI + 0.5

interface BoltFixture {
  readonly project: Project
  readonly turnId: string
}

function boltFixture(): BoltFixture {
  const base = newProject('#1177 shoulder ledge', 'inch')
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

/** The angle from the nearest Hex facet normal, degrees in `[0, 30]`. */
function facetOffset(angle: number): number {
  const wrapped = ((angle % 60) + 60) % 60
  return Math.min(wrapped, 60 - wrapped)
}

/** How far the material top at `top` stands above the Hex's flat plane, project units. */
function aboveHexPlane(top: number, angle: number): number {
  return top * Math.cos((facetOffset(angle) * Math.PI) / 180) - HEX_ACROSS_FLATS / 2
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
 * How far inside the Hex prism a point lies, project units; positive is inside.
 * The same solid #1173's suite uses: the cutter body must never enter it.
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
const tool = normalizeToolForProject(
  bolt.project.tools.find((candidate) => candidate.id === FLAT_TOOL_ID)!, bolt.project,
)
const roughOperation = turnOperation(bolt.project, bolt.turnId, 'rotary_rough')
const finishOperation = turnOperation(bolt.project, bolt.turnId, 'rotary_finish')
const rough = generate(bolt.project, roughOperation)
const finish = generate(bolt.project, finishOperation)

// ── the job's material, swept by the real cutter at every emitted pose ────

const FROM = TURN_START - 2 * FLAT_RADIUS
const TO = HEX_END + 4 * FLAT_RADIUS

/** The built fixture's material after the Turn's rough and finish, per whole degree. */
function shoulderProfiles(): Map<number, WallFootProfile> {
  let profiles: Map<number, WallFootProfile> | null = null
  for (const moves of [rough, finish]) {
    const poses = cutterPosesByAngle(moves, stock, tool, POSE_WINDOW_DEG)
    if (profiles === null) {
      const blank = blankProfile(stock, FROM, TO, tool, HEX_END)
      profiles = new Map(poses.map((entry) => [entry.angle, sweepProfile(blank, entry.poses, tool, entry.angle)]))
      continue
    }
    for (const entry of poses) {
      const current = profiles.get(entry.angle)
      if (!current) continue
      profiles.set(entry.angle, sweepProfile(current, entry.poses, tool, entry.angle))
    }
  }
  return profiles!
}

/** The material's height above the Hex plane at (`along`, `angle`), project units. */
function heightAt(profiles: Map<number, WallFootProfile>, along: number, angle: number): number {
  const profile = profiles.get(angle)
  assert.ok(profile, `A${angle} is in the sweep`)
  let best = 0
  let distance = Number.POSITIVE_INFINITY
  for (let i = 0; i < profile.along.length; i++) {
    const candidate = Math.abs(profile.along[i] - along)
    if (candidate < distance) {
      distance = candidate
      best = i
    }
  }
  return aboveHexPlane(profile.top[best], angle)
}

const profiles = shoulderProfiles()

/** The worst point inside the overlap band `TURN_START..HEX_END`, per whole degree. */
function worstInOverlap(): { height: number; along: number; angle: number } {
  let worst = Number.NEGATIVE_INFINITY
  let along = 0
  let angle = 0
  for (const [degree, profile] of profiles) {
    for (let i = 0; i < profile.along.length; i++) {
      if (profile.along[i] < TURN_START - 1e-9 || profile.along[i] > HEX_END + 1e-9) continue
      const height = aboveHexPlane(profile.top[i], degree)
      if (height > worst) {
        worst = height
        along = profile.along[i]
        angle = degree
      }
    }
  }
  return { height: worst, along, angle }
}

/** The block time of one around cut at the operation's feed, seconds. */
function blockTime(move: ToolpathMove, feed: number, pivot: number): number {
  const radius = Math.max(move.from.z, move.to.z) - pivot
  const arc = radius * Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) * Math.PI / 180
  return Math.hypot(move.to.x - move.from.x, arc, move.to.z - move.from.z) / feed * 60
}

// ── 1. the ledge is gone: the shoulder reaches the Hex plane within 0.05 ──

check('rough and finish leave the Hex flat within 0.05 mm of the plane at the shoulder', () => {
  // The handoff's spots: X 30.734 mm / A 15, 20, 25 degrees and X 31.496 mm.
  // Before the fix the residual was 0.277 / 0.390 / 0.496 mm (0.98 mm worst).
  const spots = [1.20996, 15, 1.20996, 20, 1.20996, 25, 1.24, 25]
  const measured: number[] = []
  for (let i = 0; i < spots.length; i += 2) {
    measured.push(heightAt(profiles, spots[i], spots[i + 1]) * 25.4)
  }
  console.log(`  shoulder residual above the Hex plane: ${measured.map((mm) => mm.toFixed(3)).join(' / ')} mm`)
  for (const [index, mm] of measured.entries()) {
    assert.ok(mm <= 0.05,
      `spot ${index + 1} is ${mm.toFixed(3)} mm above the Hex plane, over the handoff's 0.05 mm`)
  }
  const worst = worstInOverlap()
  console.log(`  worst inside the overlap: ${(worst.height * 25.4).toFixed(3)} mm `
    + `at X${worst.along.toFixed(3)} A${worst.angle}°`)
  // The handoff's bound, with no exception for the corners: the flat disc's
  // scallop against the Hex's corners is the same 0.05 mm the flat itself gets,
  // and the sweep is held to it everywhere inside the overlap.
  assert.ok(worst.height * 25.4 <= 0.05,
    `the worst point in the overlap is ${(worst.height * 25.4).toFixed(3)} mm above the Hex plane, `
    + `over the handoff's 0.05 mm (X${worst.along.toFixed(3)} A${worst.angle}°)`)
})

// ── 2. the neighbour is still protected everywhere ────────────────────────

check('neither operation cuts the cutter body into the Hex', () => {
  for (const [label, moves, grow] of [['rough', rough, ROUGH_LEAVE], ['finish', finish, 0]] as const) {
    const report = deepestCutterGouge(moves, stock, { radius: FLAT_RADIUS, type: 'flat' }, hexDepth(stock, grow))
    assert.ok(report.depth <= MIN_HEIGHT,
      `${label}: the cutter body is ${report.depth.toFixed(5)} in inside the Hex (+${grow}) at ${report.where}`)
  }
})

// ── 3. the mechanism: two rings on the quarters, entered after ring 1 ────

check('both operations cut a cleanup ring on each quarter of the overlap', () => {
  for (const [label, moves] of [['rough', rough], ['finish', finish]] as const) {
    for (const position of CLEANUP_POSITIONS) {
      const ring = moves.filter((move) => move.kind === 'cut'
        && Math.abs(move.to.x - position) < 1e-6 && move.to.a !== undefined
        && Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) > 1e-9)
      assert.ok(ring.length > 6,
        `${label}: no cleanup ring at X${position} (${ring.length} poses)`)
      // No pose of it goes below the Hex's own surface at its angle: the cleanup
      // is a skim of the stock above the flat, never a cut into it.
      for (const move of ring) {
        const angle = ((move.to.a ?? 0) % 360 + 360) % 360
        const tip = move.to.z - barPivotZ(stock)
        assert.ok(tip * Math.cos(facetOffset(angle) * Math.PI / 180) >= HEX_ACROSS_FLATS / 2 - MIN_HEIGHT,
          `${label}: the cleanup ring's tip at A${angle.toFixed(1)} is below the Hex plane`)
      }
    }
  }
})

check('the finish enters the cleanup rings right after the first ring, without a retract', () => {
  const pivot = barPivotZ(stock)
  const isAroundCut = (move: ToolpathMove): boolean => move.kind === 'cut'
    && move.from.a !== undefined && move.to.a !== undefined
    && Math.abs(move.from.a - move.to.a) > 1e-9
  const firstRing = finish.filter((move) => isAroundCut(move) && Math.abs(move.to.x - (TURN_START + FLAT_RADIUS)) < 1e-6)
  const rings = CLEANUP_POSITIONS.map((position) =>
    finish.filter((move) => isAroundCut(move) && Math.abs(move.to.x - position) < 1e-6))
  assert.ok(firstRing.length > 6, `the first ring is emitted (${firstRing.length} moves)`)
  for (const [index, ring] of rings.entries()) {
    assert.ok(ring.length > 6, `cleanup ring ${index + 1} is emitted (${ring.length} moves)`)
    assert.ok(finish.indexOf(ring[0]) > finish.indexOf(firstRing[0]),
      `cleanup ring ${index + 1} follows the first ring`)
  }
  // #1173's committed suite pins the first overlap ring at A0..A360; the ring
  // must still *lead* the operation (the cleanup comes after it, not before).
  assert.ok(Math.abs((firstRing[0].from.a ?? -1) - 0) < 1e-9, 'the first ring still starts at A0')
  assert.ok((firstRing[firstRing.length - 1].to.a ?? 0) <= 360 + 1e-9, 'the first ring still ends by A360')
  // The move into the first of them is a cut from the first ring's own end back
  // to the band face at that angle -- not a rapid and not a plunge, so no G0 Z
  // lift; the move on to the second is a cut along the same angle.
  const entry = finish[finish.indexOf(rings[0][0]) - 1]
  assert.equal(entry.kind, 'cut', 'the cleanup rings are entered by a cut, not a rapid/plunge')
  assert.ok(Math.abs(entry.from.x - (TURN_START + FLAT_RADIUS)) < 1e-6, 'the entry starts at the first ring')
  assert.ok(Math.abs(entry.to.x - CLEANUP_POSITIONS[0]) < 1e-6, 'the entry ends at the first cleanup ring')
  const step = finish[finish.indexOf(rings[1][0]) - 1]
  assert.equal(step.kind, 'cut', 'the move on to the second cleanup ring is a cut')
  assert.ok(Math.abs(step.from.x - CLEANUP_POSITIONS[0]) < 1e-6, 'it starts at the first cleanup ring')
  assert.ok(Math.abs(step.to.x - CLEANUP_POSITIONS[1]) < 1e-6, 'it ends at the second cleanup ring')
  // #1173's smoothness numbers: one upward rapid (the final retract), no new
  // blocks under 10 ms from the cleanup rings.
  const up = finish.filter((move) => move.kind === 'rapid' && move.to.z - move.from.z > 1e-9)
  assert.equal(up.length, 1, `the finish has one upward rapid (the final retract), not ${up.length}`)
  const feed = finishOperation.feed ?? 30
  const times = rings.flat().map((move) => blockTime(move, feed, pivot))
  const shortest = Math.min(...times)
  console.log(`  cleanup rings: ${times.length} cuts, shortest block ${(shortest * 1000).toFixed(1)} ms`)
  assert.ok(shortest >= 0.01,
    `the cleanup rings have a ${(shortest * 1000).toFixed(1)} ms block, under the 10 ms #1173 forbids adding`)
  // Every ring's angular steps are its own uniform grid, not the refined one.
  for (const [index, ring] of rings.entries()) {
    const steps = ring.map((move) => Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)))
    assert.ok(Math.min(...steps) >= 0.4,
      `cleanup ring ${index + 1}'s finest step is ${Math.min(...steps).toFixed(3)} degrees`)
  }
})

if (failures > 0) {
  console.error(`rotaryNeighbourShoulderLedge.test.ts: ${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('rotaryNeighbourShoulderLedge.test.ts: all checks passed')
}
