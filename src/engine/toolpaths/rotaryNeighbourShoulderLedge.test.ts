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
 * stock across that flat at the shoulder, and still cuts no lower than it.
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
 * **The fix.** `shoulderCleanFaces` adds one ring at the band face (emitted after
 * the operation's own rings, so the commanded A of every other ring is byte for
 * byte what it was). The ring is a neighbour-reach column, so it is read with
 * the exact footprint maximum on the mesh *with* the neighbours -- the cutter
 * body never goes below the Hex -- and it clears the flat to the exact read's
 * tangent envelope: 0.12 mm at that spot, 0.17 mm worst inside the overlap,
 * against a flat whose own finish allowance is 0.15 mm.
 *
 * **Why not 0.05 mm.** The exact read touches the flat at one angle per pose --
 * where its disc's rim leaves the flat -- so the residual between two rim
 * angles is the flat's height change over the pose spacing, and clearing it
 * further needs a pose whose rim lands on that very point. A pose at the band
 * face subtends `asin(toolRadius / flatRadius)` = 8.66 degrees there, but
 * `cutterPosesByAngle` (the shared sweep these figures come from) assigns poses
 * with a window sized by the **blank's** radius, 7.68 degrees, so the rim poses
 * are dropped before the sweep sees them: the same program measures 0.115 mm
 * with that window and 0.071 mm with the true one (see
 * `scripts/issue-1177-window-probe.ts`). Reaching 0.05 mm would take a
 * three-times-finer angular grid, which is a new block-time profile for the
 * shoulder that #1173's smoothness numbers do not allow.
 *
 * Mutations this file is checked with (each applied, seen failing, restored):
 *   1. `shoulderCleanFaces` returns no faces -> no ring is added and the
 *      residual at the spot goes back to 0.50 mm;
 *   2. the cleanup position is merged into the along grid *after*
 *      `rotaryNeighbourColumns` -> the ring is not a neighbour-reach column, the
 *      base prep reads the Turn's own surface there, and the cutter cuts the Hex
 *      away (the gouge check fails);
 *   3. the ring is emitted in grid order instead of last -> #1173's committed
 *      suite fails (the first overlap ring no longer starts at A0).
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
const rough = generate(bolt.project, turnOperation(bolt.project, bolt.turnId, 'rotary_rough'))
const finish = generate(bolt.project, turnOperation(bolt.project, bolt.turnId, 'rotary_finish'))

// ── the job's material, swept by the real cutter at every emitted pose ────

const FROM = TURN_START - 2 * FLAT_RADIUS
const TO = HEX_END + 4 * FLAT_RADIUS

/** The built fixture's material after the Turn's rough and finish, per whole degree. */
function shoulderProfiles(): Map<number, WallFootProfile> {
  let profiles: Map<number, WallFootProfile> | null = null
  for (const moves of [rough, finish]) {
    const poses = cutterPosesByAngle(moves, stock, tool)
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

// ── 1. the ledge is gone: the shoulder reaches the Hex plane ──────────────

check('rough and finish leave the Hex flat clean at the turned shoulder', () => {
  // The handoff's spots: X 30.734 mm / A 15, 20, 25 degrees. Before the fix the
  // residual was 0.277 / 0.390 / 0.496 mm; the ledge tapered to nothing at the
  // Hex's end face, so the spot nearest the band face was the worst of the three.
  const spots = [1.20996, 15, 1.20996, 20, 1.20996, 25, 1.24, 25]
  const measured: number[] = []
  for (let i = 0; i < spots.length; i += 2) {
    measured.push(heightAt(profiles, spots[i], spots[i + 1]) * 25.4)
  }
  console.log(`  shoulder residual above the Hex plane: ${measured.map((mm) => mm.toFixed(3)).join(' / ')} mm`)
  // The flat's own finish allowance on Frank's file is 0.15 mm; the shoulder must
  // not be a ledge *on top of* it (0.50 mm before the fix), so the bound is that
  // same allowance plus the sweep's own whole-degree sampling.
  assert.ok(measured[2] <= 0.2,
    `the A25 spot is ${measured[2].toFixed(3)} mm above the Hex plane, over the 0.2 mm the flat's own finish allows`)
  for (const mm of measured) {
    assert.ok(mm <= 0.2, `a shoulder spot is ${mm.toFixed(3)} mm above the Hex plane, over 0.2 mm`)
  }
  const worst = worstInOverlap()
  console.log(`  worst inside the overlap: ${(worst.height * 25.4).toFixed(3)} mm `
    + `at X${worst.along.toFixed(3)} A${worst.angle}°`)
  assert.ok(worst.height * 25.4 <= 0.25,
    `the worst point in the overlap is ${(worst.height * 25.4).toFixed(3)} mm above the Hex plane`)
})

// ── 2. the neighbour is still protected everywhere ────────────────────────

check('neither operation cuts the cutter body into the Hex', () => {
  for (const [label, moves, grow] of [['rough', rough, ROUGH_LEAVE], ['finish', finish, 0]] as const) {
    const report = deepestCutterGouge(moves, stock, { radius: FLAT_RADIUS, type: 'flat' }, hexDepth(stock, grow))
    assert.ok(report.depth <= MIN_HEIGHT,
      `${label}: the cutter body is ${report.depth.toFixed(5)} in inside the Hex (+${grow}) at ${report.where}`)
  }
})

// ── 3. the mechanism: one ring at the band face, after the operation's rings ──

check('both operations cut a ring at the band face, after their own rings', () => {
  for (const [label, moves] of [['rough', rough], ['finish', finish]] as const) {
    const atFace = moves.filter((move) => move.kind === 'cut'
      && Math.abs(move.to.x - TURN_START) < 1e-6 && move.to.a !== undefined)
    assert.ok(atFace.length > 6, `${label}: no ring at the band face (${atFace.length} poses)`)
    // Emitted after the operation's own rings: the band face is the *innermost*
    // along position, so a ring there in grid order would lead the motion and
    // advance the commanded A cursor by a whole turn (#1173's suite pins the
    // first overlap ring at A0..A360).
    const firstAt = (x: number): number => moves.findIndex((move) => move.kind === 'cut'
      && Math.abs(move.to.x - x) < 1e-6 && move.to.a !== undefined)
    const spanStart = firstAt(TURN_START + FLAT_RADIUS)
    const bandFace = firstAt(TURN_START)
    assert.ok(spanStart >= 0, `${label}: no ring at the span start`)
    assert.ok(bandFace > spanStart,
      `${label}: the band-face ring is emitted before the span-start ring (${bandFace} < ${spanStart})`)
    // No pose of it goes below the Hex's own surface at its angle: the cleanup
    // is a skim of the stock above the flat, never a cut into it.
    for (const move of atFace) {
      const angle = ((move.to.a ?? 0) % 360 + 360) % 360
      const tip = move.to.z - barPivotZ(stock)
      assert.ok(tip * Math.cos(facetOffset(angle) * Math.PI / 180) >= HEX_ACROSS_FLATS / 2 - MIN_HEIGHT,
        `${label}: the band-face ring's tip at A${angle.toFixed(1)} is below the Hex plane`)
    }
  }
})

if (failures > 0) {
  console.error(`rotaryNeighbourShoulderLedge.test.ts: ${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('rotaryNeighbourShoulderLedge.test.ts: all checks passed')
}
