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
 * A rotary rough or finish runs to the **ends of its target's surface**
 * (#1155 slice rn-e).
 *
 * Frank's decision of 2026-11-06 replaced the old rule: the plain bar beyond a
 * model's end is material the operation **may cut into**, so a rotary rough or
 * finish runs the tool to the edge of its target at both ends along the bar. A
 * ball's or flat's centre may go up to the model's end, so the cutter reaches
 * the edge, and the cutter body may cut the plain bar beyond it. Only another
 * model, an end support, the chuck and tailstock keep-outs and the bar's
 * outside still stop it, exactly as #1155 rn-a..rn-d established.
 *
 * The defect this fixes: `rotaryCutterSpan` pulled the cutter centre one radius
 * **inside** each band end and `withRetainedBar` stood a retained cylinder of the
 * bar's own radius at that end, so every sample in the last tool radius of the
 * target read the wall and lifted. A ball left a ridge about one tool radius
 * wide at each of the Hex's ends.
 *
 * The checks sweep the **real cutter body** (`src/test/rotaryWallFootSweep.ts`,
 * the sweep #1155 rn-d's wall-foot tests use) -- one radial material profile per
 * whole degree of A, cut by every cutter pose the operation emits -- and read the
 * leftover beside each of the target's ends off it. Measured before this slice
 * (mutation: put the one-radius clamp back) and after, on the fixture below:
 *
 * | case | ridge before (in) | ridge after (in) |
 * | --- | --- | --- |
 * | Hex ball rough, leave 0.02, near end 0.75 | 0.12500 | 0.00000 |
 * | Hex ball rough, leave 0.02, far end 1.25 | 0.12500 | 0.00000 |
 * | Hex 1/8" ball finish on the rough's material, near end | 0.06250 | 0.00000 |
 * | Hex flat finish, leave 0, both ends | 0.12500 | 0.00000 |
 *
 * The second case Frank found is here too: the Turn starting exactly at the
 * Hex's face (1.25) must not extend its band into the Hex. The Hex is a
 * neighbour, so the centre keeps its one-radius pull and the wall-foot ring
 * `rotaryWallFeet` places (`face + leave + radius`) is where the first cut to the
 * Turn's own surface sits -- 1.375 at leave 0 and 1.395 at 0.02 -- while the
 * cutter body never enters the Hex.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryTargetEnds.test.ts
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
import { deepestCutterGouge } from '../../test/rotaryCutterGouge'
import {
  blankProfile, cutterPosesByAngle, sweepProfile,
} from '../../test/rotaryWallFootSweep'
import type { WallFootProfile } from '../../test/rotaryWallFootSweep'
import { normalizeToolForProject } from './geometry'
import { computeOperationToolpath } from './generateOperation'
import { rotaryAlongRange } from './rotaryModel'
import type { NormalizedTool, ToolpathMove } from './types'

// ── fixture: Frank's bolt, in code ────────────────────────────────────────

/** The planner's selection argument, unused by the canned-solid path. */
const EMPTY_SELECTION = {
  mode: 'feature', selectedFeatureId: null, selectedFeatureIds: [], selectedTabIds: [],
  selectedClampIds: [], selectedNode: null, hoveredFeatureId: null, sketchEditTool: null,
  activeControl: null, groupFolderId: null,
} as unknown as SelectionState

const BAR_DIAMETER = 2
const BAR_LENGTH = 4
const HEX_START = 0.75
const HEX_LENGTH = 0.5
const HEX_ACROSS_FLATS = 1.5
const HEX_END = HEX_START + HEX_LENGTH
/** The Hex's apothem: the flat radius its rough and finish turn down to. */
const HEX_APOTHEM = HEX_ACROSS_FLATS / 2
const TURN_START = 1.2
const TURN_DIAMETER = 1
const FLAT_TOOL_ID = 'flat-025'
const BALL_TOOL_ID = 'ball-025'
const SMALL_BALL_TOOL_ID = 'ball-0125'

function boltTools(): Tool[] {
  return [
    {
      ...defaultTool('inch', 1), id: FLAT_TOOL_ID, name: '1/4" Endmill', type: 'flat_endmill',
      diameter: 0.25, defaultStepover: 0.32, defaultStepdown: 0.125,
    },
    {
      ...defaultTool('inch', 1), id: BALL_TOOL_ID, name: '1/4" Ball Endmill', type: 'ball_endmill',
      diameter: 0.25, defaultStepover: 0.16, defaultStepdown: 0.075,
    },
    {
      ...defaultTool('inch', 1), id: SMALL_BALL_TOOL_ID, name: '1/8" Ball Endmill', type: 'ball_endmill',
      diameter: 0.125, defaultStepover: 0.16, defaultStepdown: 0.03,
    },
  ] as Tool[]
}

function boltProject(name: string): Project {
  const base = newProject(name, 'inch')
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 2
  base.stock = roundStock(BAR_DIAMETER, BAR_LENGTH, 'x')
  base.tools = boltTools()
  base.setups.push({
    ...base.setups[0], id: 'around', name: 'Around', kind: 'around',
    orientation: { axis: 'x', angleDeg: 0 },
  })
  base.activeSetupId = 'around'
  return base
}

/**
 * The Hex over 0.75..1.25 and a Turn that starts at `turnStart` and runs to
 * 3.75. `turnStart` 1.2 is Frank's file (the Turn overlaps the Hex by 0.05 in);
 * 1.25 is his second case, where the Turn begins exactly at the Hex's far face.
 */
function boltFixture(turnStart: number): { project: Project; turnId: string; hexId: string } {
  const base = boltProject('rn-e target ends')
  const turn = planRotarySolid(base, EMPTY_SELECTION, {
    kind: 'turn', start: turnStart, length: 3.75 - turnStart, diameter: TURN_DIAMETER,
  })
  if (!turn.ok) throw new Error(`the Turn must plan: ${turn.reason}`)
  const hex = planRotarySolid(turn.project, EMPTY_SELECTION, {
    kind: 'polygon', start: HEX_START, length: HEX_LENGTH, sides: 6,
    acrossFlats: HEX_ACROSS_FLATS, rotationDeg: 0,
  })
  if (!hex.ok) throw new Error(`the Hex must plan: ${hex.reason}`)
  return { project: hex.project, turnId: turn.created.featureId, hexId: hex.created.featureId }
}

function rotaryOperation(
  project: Project,
  featureIds: readonly string[],
  kind: 'rotary_rough' | 'rotary_finish',
  patch: Partial<Operation>,
): Operation {
  return {
    ...defaultOperationForTarget(
      project, kind, kind === 'rotary_rough' ? 'rough' : 'finish',
      { source: 'features', featureIds: [...featureIds] }, project.operations.length + 1,
    ),
    setupId: 'around',
    rotaryPassDirection: 'around',
    ...patch,
  }
}

function generate(project: Project, operation: Operation): ToolpathMove[] {
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, `${operation.name} dispatches to the rotary generator`)
  return envelope.result.moves
}

function toolOf(project: Project, operation: Operation): NormalizedTool {
  const record = project.tools.find((tool) => tool.id === operation.toolRef)
  assert.ok(record, `${operation.name} has its tool`)
  return normalizeToolForProject(record, project)
}

// ── the analytic Hex the cutters may not enter ────────────────────────────

/**
 * How far inside the Hex prism a point lies, or `-Infinity` outside it: the
 * apothem minus the largest facet dot product (outward normals are `sin/cos` of
 * `k * 60°` from +up at rotation 0), floored by the two end faces. Same solid
 * `rotaryNeighbourPartialOverlap.test.ts` measures against.
 */
function hexDepth(stock: BarStock, along: number, across: number, up: number): number {
  if (along < HEX_START || along > HEX_END) return Number.NEGATIVE_INFINITY
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  let largest = Number.NEGATIVE_INFINITY
  for (let k = 0; k < 6; k++) {
    const angle = (k * Math.PI) / 3
    largest = Math.max(largest, Math.sin(angle) * (across - centre) + Math.cos(angle) * (up - pivot))
  }
  return Math.min(HEX_APOTHEM - largest, along - HEX_START, HEX_END - along)
}

// ── the material each operation leaves beside the target's ends ───────────

/** One angle's swept material: its own whole degree, and the profile left. */
interface SweptAngle {
  readonly angle: number
  readonly profile: WallFootProfile
}

/**
 * Every whole degree's material profile after `moves` cut `blank` (#1155 rn-e).
 * `blank` is the untouched stock, or the profile an earlier operation left.
 */
function sweepByAngle(
  moves: readonly ToolpathMove[],
  stock: BarStock,
  tool: NormalizedTool,
  window: { from: number; to: number },
  anchor: number,
  blank?: (angle: number) => WallFootProfile | null,
): SweptAngle[] {
  return cutterPosesByAngle(moves, stock, tool).map((entry) => {
    const base = blank?.(entry.angle)
      ?? blankProfile(stock, window.from, window.to, tool, anchor)
    return { angle: entry.angle, profile: sweepProfile(base, entry.poses, tool, entry.angle) }
  })
}

/**
 * The **ridge** a target's own end still carries: the material standing there
 * that the operation's own passes leave nowhere else.
 *
 * An absolute height bound would measure the operation's stepover scallop, not
 * the defect: a 1/4 in ball advancing 0.16 in leaves a 0.03 in cusp everywhere,
 * by design. The ridge is the *extra* material beside the end face, so each
 * angle's reference is the highest material its own interior reaches
 * (`interior.from..to` from the end), and the measured height is how far the
 * end band stands above that. Taking the interior's **highest** point -- its
 * cusp crest, and a polygon target's corner -- makes the check blind to the
 * scallop and corner phase and still catches the defect by the whole step from
 * the crest to the untouched blank (0.226 in on this fixture, over the 0.111 in
 * band the handoff calls "about one tool radius wide"). `width` is the along
 * extent of the extra material.
 */
function endRidge(
  swept: readonly SweptAngle[],
  end: number,
  direction: 1 | -1,
  band: number,
  interior: { from: number; to: number },
  tolerance: number,
): { width: number; height: number; angle: number } {
  let width = 0
  let height = 0
  let angle = 0
  for (const entry of swept) {
    const { along, top } = entry.profile
    let reference = Number.NEGATIVE_INFINITY
    for (let i = 0; i < along.length; i++) {
      const distance = (along[i] - end) * direction
      if (distance < interior.from || distance > interior.to) continue
      if (top[i] > reference) reference = top[i]
    }
    if (!Number.isFinite(reference)) continue
    let worst = 0
    let extent = 0
    for (let i = 0; i < along.length; i++) {
      const distance = (along[i] - end) * direction
      if (distance < -1e-12 || distance > band) continue
      const excess = top[i] - reference
      if (excess <= tolerance) continue
      if (excess > worst) worst = excess
      if (distance > extent) extent = distance
    }
    if (worst > height + 1e-12) {
      height = worst
      width = extent
      angle = entry.angle
    }
  }
  return { width, height, angle }
}

/**
 * The operation's own between-pass cusp: the material a ball leaves standing
 * between two adjacent rings, `r - sqrt(r^2 - (step/2)^2)` for the along step
 * the operation asks for. It is a design property of the stepover, not a ridge,
 * and the end band's top sits on a cusp crest while the interior reference is
 * its trough, so the ridge check allows one of these on top of the tolerance.
 */
function passCusp(tool: NormalizedTool, operation: Operation): number {
  const step = (operation.stepover ?? 0.5) * tool.diameter
  if (!(step > 0) || step >= 2 * tool.radius) return tool.radius
  return tool.radius - Math.sqrt(tool.radius * tool.radius - (step / 2) * (step / 2))
}

/**
 * The height-map cell the operation samples with, as the adapter derives it
 * (`rotaryOperation.ts`: `min(radius / 3, stepover * 0.5)`). A cell is the one
 * discretisation the sampler documents, so the ridge check allows one on top of
 * the tolerance: a target that ends inside a cell reads its last centre.
 */
function samplingCell(tool: NormalizedTool, operation: Operation): number {
  const step = (operation.stepover ?? 0.5) * tool.diameter
  return Math.min(tool.radius / 3, step * 0.5)
}

/** Linear resampling of a material profile onto another along grid. */
function resample(profile: WallFootProfile, along: readonly number[]): WallFootProfile {
  const top: number[] = []
  let next = 0
  for (const x of along) {
    while (next + 1 < profile.along.length && profile.along[next + 1] < x) next++
    if (x <= profile.along[0]) {
      top.push(profile.top[0])
      continue
    }
    const last = profile.along.length - 1
    if (x >= profile.along[last]) {
      top.push(profile.top[last])
      continue
    }
    const span = profile.along[next + 1] - profile.along[next]
    const t = span > 0 ? (x - profile.along[next]) / span : 0
    top.push(profile.top[next] + (profile.top[next + 1] - profile.top[next]) * t)
  }
  return { along: [...along], top }
}

// ── the acceptance: both of the Hex's ends, ball and flat ─────────────────

const MIN_HEIGHT = minRenderHeight('inch')

/**
 * The Hex's rough and finish reach the model's own ends.
 *
 * The ridge is measured with the cutter body on the material the operation
 * actually runs on: the ball rough on the untouched bar, the ball finish on the
 * material the rough left (a ball's section cannot remove the overhang above its
 * own band, exactly as `src/test/rotaryWallFootSweep.ts` documents), and the
 * flat finish on the bar. Each is held to `minRenderHeight + leave`, the
 * acceptance's bound.
 */
{
  const { project, hexId } = boltFixture(TURN_START)
  const stock = project.stock as BarStock
  const rough = rotaryOperation(project, [hexId], 'rotary_rough', {
    name: 'hex ball rough', toolRef: BALL_TOOL_ID, stepover: 0.16, stepdown: 0.075, stockToLeaveRadial: 0.02,
  })
  const fineFinish = rotaryOperation(project, [hexId], 'rotary_finish', {
    name: 'hex 1/8" ball finish', toolRef: SMALL_BALL_TOOL_ID, stepover: 0.16, stepdown: 0.03, stockToLeaveRadial: 0,
  })
  const flatFinish = rotaryOperation(project, [hexId], 'rotary_finish', {
    name: 'hex flat finish', toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125, stockToLeaveRadial: 0,
  })
  const window = { from: HEX_START - 0.3, to: HEX_END + 0.3 }
  const roughTool = toolOf(project, rough)
  const roughSwept = sweepByAngle(generate(project, rough), stock, roughTool, window, HEX_START)
  const roughLeave = rough.stockToLeaveRadial ?? 0
  // The ball rough's own bound: its scallop is the operation's stepover, not a
  // node, so the acceptance's `surface tolerance + leave` is the width bound.
  // The interior reference sits clear of both ends' ridge bands and inside the
  // Hex (which is only 0.5 in long, so it cannot be "a few radii"): from 1.5
  // radii in to 1.5 radii short of the far end. The measured band is a diameter.
  const interiorOf = (radius: number) => ({ from: 1.5 * radius, to: HEX_LENGTH - 1.5 * radius })
  const interior = interiorOf(roughTool.radius)
  for (const [end, direction] of [[HEX_START, 1], [HEX_END, -1]] as const) {
    const ridge = endRidge(roughSwept, end, direction, 2 * roughTool.radius, interior, MIN_HEIGHT)
    const bound = MIN_HEIGHT + roughLeave + passCusp(roughTool, rough) + samplingCell(roughTool, rough)
    assert.ok(ridge.height <= bound,
      `the Hex ball rough reaches the Hex's end at ${end}: ridge ${ridge.height.toFixed(5)} in tall over `
      + `${ridge.width.toFixed(5)} in <= ${bound.toFixed(5)} in (worst A${ridge.angle}°)`)
  }

  // The finish runs on the rough's material: the profile the rough left at the
  // finish's own grid depends on the finish's tool radius (its profile step), so
  // the rough's material is resampled onto it per angle.
  const finishTool = toolOf(project, fineFinish)
  const roughByAngle = new Map(roughSwept.map((entry) => [entry.angle, entry.profile]))
  const finishSwept = sweepByAngle(generate(project, fineFinish), stock, finishTool, window, HEX_START,
    (angle) => {
      const left = roughByAngle.get(angle)
      return left === undefined ? null : resample(left, blankProfile(stock, window.from, window.to, finishTool, HEX_START).along)
    })
  const finishInterior = interiorOf(finishTool.radius)
  for (const [end, direction] of [[HEX_START, 1], [HEX_END, -1]] as const) {
    const ridge = endRidge(finishSwept, end, direction, 2 * finishTool.radius, finishInterior, MIN_HEIGHT)
    const bound = MIN_HEIGHT + passCusp(finishTool, fineFinish) + samplingCell(finishTool, fineFinish)
    assert.ok(ridge.height <= bound,
      `the Hex 1/8" ball finish reaches the Hex's end at ${end}: ridge ${ridge.height.toFixed(5)} in tall over `
      + `${ridge.width.toFixed(5)} in <= ${bound.toFixed(5)} in (worst A${ridge.angle}°)`)
  }

  const flatTool = toolOf(project, flatFinish)
  const flatSwept = sweepByAngle(generate(project, flatFinish), stock, flatTool, window, HEX_START)
  const flatInterior = interiorOf(flatTool.radius)
  for (const [end, direction] of [[HEX_START, 1], [HEX_END, -1]] as const) {
    const ridge = endRidge(flatSwept, end, direction, 2 * flatTool.radius, flatInterior, MIN_HEIGHT)
    const bound = MIN_HEIGHT + samplingCell(flatTool, flatFinish)
    assert.ok(ridge.height <= bound,
      `the Hex flat finish reaches the Hex's end at ${end}: ridge ${ridge.height.toFixed(5)} in tall over `
      + `${ridge.width.toFixed(5)} in <= ${bound.toFixed(5)} in (worst A${ridge.angle}°)`)
  }
}

// ── an end support still stops the tool ───────────────────────────────────

/**
 * A support covering the region beyond an end keeps the tool out of it
 * (#1155 rn-e: "with an end support covering the region beyond an end, the tool
 * still stops short there").
 *
 * The support is 1 in of the bar's chuck end, so the cut range starts inside the
 * Hex (0.75..1.25): `rotaryAlongRange` gives 1.0625, the centre pull another
 * 0.0625 for the 1/8" ball. Every non-rapid move's cutter-body edge must stay at
 * or past the support's boundary at 1.0 -- the body may never enter it, which is
 * the mutation "let the tool into an end-support length".
 */
{
  const { project, hexId } = boltFixture(TURN_START)
  const stock = project.stock as BarStock
  const support = 1
  // The saved operation carries the support; `rotaryAlongRange` reads it in the
  // adapter, so the generated motion is the supported one.
  const operation = rotaryOperation(project, [hexId], 'rotary_finish', {
    name: 'hex ball finish (supported)', toolRef: SMALL_BALL_TOOL_ID, stepover: 0.16, stepdown: 0.03,
    stockToLeaveRadial: 0, rotaryChuckSupport: support,
  })
  const tool = toolOf(project, operation)
  const range = rotaryAlongRange(stock, [], { min: HEX_START, max: HEX_END }, tool,
    { chuckEnd: support, tailEnd: 0 })
  assert.ok(range, 'the supported range exists')
  assert.ok(range.start > HEX_START,
    `the support binds the band's start (${range.start.toFixed(5)} > ${HEX_START})`)
  const moves = computeOperationToolpath(project, operation)
  assert.ok(moves, 'the supported operation dispatches')
  let nearest = Number.POSITIVE_INFINITY
  for (const move of moves.result.moves) {
    if (move.kind === 'rapid') continue
    for (const point of [move.from, move.to]) {
      nearest = Math.min(nearest, point.x - tool.radius)
    }
  }
  assert.ok(nearest >= support - MIN_HEIGHT,
    `the cutter body stops outside the support: nearest ${nearest.toFixed(5)} in >= ${support} in`)
}

// ── a neighbour at the target's end still bounds the band ─────────────────

/**
 * Frank's second case: the Turn starts exactly where the Hex ends (1.25).
 *
 * The Hex is a **neighbour**, so the band may not extend into it: the centre
 * keeps its one-radius pull and the cutter first reaches the Turn's own surface
 * at the Hex's wall foot, `face + leave + radius`, which `rotaryWallFeet` places
 * as its own ring. Before this slice the retained-stub wall stood on top of that
 * foot and the first cut sat one height-map cell past it; with the stub gone at
 * the model's own end it lands on the foot. The body must still clear the Hex.
 */
for (const leave of [0, 0.02]) {
  const { project, turnId } = boltFixture(HEX_END)
  const stock = project.stock as BarStock
  const operation = rotaryOperation(project, [turnId], 'rotary_rough', {
    name: `turn flat rough leave ${leave}`, toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125,
    stockToLeaveRadial: leave,
  })
  const tool = toolOf(project, operation)
  const moves = generate(project, operation)
  const foot = HEX_END + leave + tool.radius
  // The first cut that reaches the Turn's own surface (a cut above the Hex is
  // air over the neighbour, and the layers above the Hex's flats do cut there).
  // The band must not reach into the Hex at all: the centre keeps its one-radius
  // pull off the neighbour's face, so the nearest cutting position is the pulled
  // start (1.375 at both leaves) and never the Hex's face at 1.25.
  const cutAlong = moves
    .filter((move) => move.kind !== 'rapid')
    .map((move) => Math.min(move.from.x, move.to.x))
  const nearest = Math.min(...cutAlong)
  assert.ok(nearest >= HEX_END + tool.radius - 0.001,
    `the leave ${leave} band starts off the Hex's face: nearest cut ${nearest.toFixed(5)} in `
    + `>= ${(HEX_END + tool.radius).toFixed(5)} in`)
  const reachesTarget = moves.filter((move) => move.kind !== 'rapid'
    && move.to.z - barPivotZ(stock) <= TURN_DIAMETER / 2 + leave + MIN_HEIGHT)
  assert.ok(reachesTarget.length > 0, `the leave ${leave} rough cuts the Turn's surface`)
  const first = Math.min(...reachesTarget.map((move) => move.to.x))
  assert.ok(Math.abs(first - foot) <= 0.001,
    `every layer below the Hex's flats starts at the wall's foot: ${first.toFixed(5)} in `
    + `against ${foot.toFixed(5)} in at leave ${leave}`)
  const gouge = deepestCutterGouge(moves, stock, { radius: tool.radius, type: 'flat' },
    (along, across, up) => hexDepth(stock, along, across, up))
  assert.ok(gouge.depth <= MIN_HEIGHT,
    `the leave ${leave} rough never enters the Hex: deepest ${gouge.depth.toFixed(5)} in at ${gouge.where}`)
}

console.log('rotaryTargetEnds.test.ts: the target\'s ends are cut, a support and a neighbour still stop the tool')
