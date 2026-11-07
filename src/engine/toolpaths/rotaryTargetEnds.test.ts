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
 * leftover beside each of the target's ends off it (`endRidge`: the extra
 * material the end band stands above the operation's own interior, so the
 * stepover scallop and the sampler's lift cancel). Measured before this slice
 * (mutation: put the one-radius clamp back) and after, on the fixture below:
 *
 * | case | ridge before (in) | ridge after (in) |
 * | --- | --- | --- |
 * | Hex ball rough, leave 0.02, near end 0.75 | 0.12500 | 0.00064 over 0.03 in |
 * | Hex ball rough, leave 0.02, far end 1.25 | 0.12500 | 0.00000 |
 * | Hex 1/8" ball finish on the rough's material, both ends | 0.06250 | 0.00000 |
 * | Hex flat finish, leave 0, both ends | 0.12500 | 0.00437 over 0.00 in |
 *
 * The cutting along span is asserted on its own as well: the ridge bound cannot
 * see a band that ends a scallop short, but the centre reaching 0.75 and 1.25 in
 * can, and that is what a restored clamp breaks (0.8125/1.1875 for the 1/8"
 * ball, 0.875/1.125 for the 1/4" tools).
 *
 * The second case Frank found is here too: the Turn starting exactly at the
 * Hex's face (1.25) must not extend its band into the Hex. The Hex is a
 * neighbour, so the centre keeps its one-radius pull and the wall-foot ring
 * `rotaryWallFeet` places (`face + leave + radius`) is where the first cut to the
 * Turn's own surface sits -- 1.375 at leave 0 and 1.395 at 0.02, cutting the
 * Turn at 0.500/0.520 in -- while the cutter body stands exactly the leave off
 * the Hex's face and the material past that boundary never stands above the
 * operation's own interior.
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
  blankProfile, endRidge, resample, sweepByAngle, sweepProfile,
} from '../../test/rotaryWallFootSweep'
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
//
// The sweep itself -- one material profile per whole degree, the cutter body
// intersected in the angle line's plane, the ridge read against the operation's
// own interior -- lives in `src/test/rotaryWallFootSweep.ts` (#1155 rn-e
// correction 1), so the probe (`scripts/issue-1155-rn-e-ends-probe.ts`) and this
// check measure the same way by construction.

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
  const roughMoves = generate(project, rough)
  const roughSwept = sweepByAngle(roughMoves, stock, roughTool, window, HEX_START)
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
  const finishMoves = generate(project, fineFinish)
  const finishSwept = sweepByAngle(finishMoves, stock, finishTool, window, HEX_START,
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
  const flatMoves = generate(project, flatFinish)
  const flatSwept = sweepByAngle(flatMoves, stock, flatTool, window, HEX_START)
  const flatInterior = interiorOf(flatTool.radius)
  for (const [end, direction] of [[HEX_START, 1], [HEX_END, -1]] as const) {
    const ridge = endRidge(flatSwept, end, direction, 2 * flatTool.radius, flatInterior, MIN_HEIGHT)
    const bound = MIN_HEIGHT + samplingCell(flatTool, flatFinish)
    assert.ok(ridge.height <= bound,
      `the Hex flat finish reaches the Hex's end at ${end}: ridge ${ridge.height.toFixed(5)} in tall over `
      + `${ridge.width.toFixed(5)} in <= ${bound.toFixed(5)} in (worst A${ridge.angle}°)`)
  }

  // The cutter **centre** reaches the model's own ends (#1155 rn-e correction 1).
  // The ridge bound above is blind to a band that ends a scallop short (the
  // interior reference sinks with it), so the extent is asserted on its own: a
  // centre left one radius inside -- the pre-slice clamp -- starts at 0.8125 and
  // stops at 1.1875 for the 1/8" ball, and at 0.875/1.125 for the 1/4" tools.
  //
  // The **far** end is worth spelling out, because the probe reads it wrongly if
  // it walks its profile in the wrong direction: the Turn neighbour starts at
  // 1.2, *inside* the Hex, but its surface (Ø1) lies **below** the Hex's
  // (apothem 0.75), so it is not a wall and does not bound the band. The Hex
  // reaches its own end at 1.25 and the cutter body cuts the plain bar (and that
  // lower Turn) beyond it, which is the rule Frank approved. A neighbour that
  // *does* rise is the case-2 check below: there the cutter body stops exactly
  // one leave off the neighbour's face.
  const cutSpan = (moves: readonly ToolpathMove[]): { min: number; max: number } => {
    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const move of moves) {
      if (move.kind === 'rapid') continue
      min = Math.min(min, move.from.x, move.to.x)
      max = Math.max(max, move.from.x, move.to.x)
    }
    return { min, max }
  }
  for (const [label, moves] of [
    ['Hex ball rough', roughMoves],
    ['Hex 1/8" ball finish', finishMoves],
    ['Hex flat finish', flatMoves],
  ] as const) {
    const span = cutSpan(moves)
    assert.ok(Math.abs(span.min - HEX_START) <= 1e-4,
      `${label} starts at the Hex's own start: ${span.min.toFixed(5)} in against ${HEX_START} in`)
    assert.ok(Math.abs(span.max - HEX_END) <= 1e-4,
      `${label} reaches the Hex's own end: ${span.max.toFixed(5)} in against ${HEX_END} in`)
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
 * Frank's second case: the Turn starts exactly where the Hex ends (1.25), at the
 * operation's **own** band start, for both pass kinds and both leaves (#1155
 * rn-e correction 1, review findings 2 and 3).
 *
 * The Hex is a **neighbour**, so the band may not extend into it: the centre
 * keeps its one-radius pull and the cutter first reaches the Turn's own surface
 * at the Hex's wall foot, `face + leave + radius`, which `rotaryWallFeet` places
 * as its own ring. Before the slice the retained-stub wall stood on top of that
 * foot and every layer below the flats started one height-map cell past it (the
 * handoff's 1.4526 in); the retained stub is what this slice removes, and the
 * foot ring is what the first cut lands on.
 *
 * The first full ring must sit on that foot and cut at the Turn's surface plus
 * the leave -- 1.375 in and 0.500 in at leave 0, 1.395 in and 0.520 in at 0.02 --
 * and the material left on the Hex's face below the flats past the leave
 * boundary must not stand above the material the operation leaves in its own
 * interior. That leftover is read off the cutter-body sweep (`endRidge`, the
 * measure `src/test/rotaryWallFootSweep.ts` shares with the probe): the
 * conservative sampler lifts every sample by up to one height-map cell, so an
 * absolute bound would measure the sampler, not the face.
 */
for (const leave of [0, 0.02]) {
  const { project, turnId } = boltFixture(HEX_END)
  const stock = project.stock as BarStock
  const pivot = barPivotZ(stock)
  const level = TURN_DIAMETER / 2 + leave
  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    const operation = rotaryOperation(project, [turnId], kind, {
      name: `turn flat ${kind} leave ${leave}`, toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125,
      stockToLeaveRadial: leave,
    })
    const tool = toolOf(project, operation)
    const moves = generate(project, operation)
    const foot = HEX_END + leave + tool.radius
    // The band must not reach into the Hex at all: the centre keeps its
    // one-radius pull off the neighbour's face, so the nearest cutting position
    // is the pulled start and never the Hex's face at 1.25.
    const cutAlong = moves
      .filter((move) => move.kind !== 'rapid')
      .map((move) => Math.min(move.from.x, move.to.x))
    const nearest = Math.min(...cutAlong)
    assert.ok(nearest >= HEX_END + tool.radius - 0.001,
      `${kind} leave ${leave} band starts off the Hex's face: nearest cut ${nearest.toFixed(5)} in `
      + `>= ${(HEX_END + tool.radius).toFixed(5)} in`)
    // A full ring at the wall's foot, cutting the Turn's own surface. A ring is
    // a cut, where a positioning feed at the travel height is not: the rough
    // still rises to the bar's surface inside the band (`min along 1.375` at
    // leave 0.02), so the first **cut** is what the acceptance means.
    const rings = moves.filter((move) => move.kind !== 'rapid'
      && Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) >= 360)
    const firstRing = Math.min(...rings.map((ring) => Math.min(ring.from.x, ring.to.x)))
    assert.ok(Math.abs(firstRing - foot) <= 0.001,
      `${kind} leave ${leave} first full ring sits on the wall's foot: ${firstRing.toFixed(5)} in `
      + `against ${foot.toFixed(5)} in`)
    // The cutter **body** keeps exactly the leave off the neighbour's face: the
    // one-radius pull plus the leave is what "the gap from the face is the leave"
    // means on a rising neighbour.
    const body = firstRing - tool.radius
    assert.ok(Math.abs(body - (HEX_END + leave)) <= 0.001,
      `${kind} leave ${leave} body gap from the Hex face: ${body.toFixed(5)} in against `
      + `${(HEX_END + leave).toFixed(5)} in`)
    const atFoot = rings.filter((ring) => Math.abs(ring.to.x - foot) <= 0.001)
    assert.ok(atFoot.length > 0,
      `${kind} leave ${leave} has a full ring at the wall's foot ${foot.toFixed(5)} in: `
      + `rings at ${[...new Set(rings.map((ring) => ring.to.x.toFixed(5)))].slice(0, 6).join(', ')}`)
    const deepest = Math.min(...atFoot.map((ring) => ring.to.z - pivot))
    assert.ok(Math.abs(deepest - level) <= 0.001,
      `${kind} leave ${leave} foot ring cuts the Turn's surface: z ${deepest.toFixed(5)} in `
      + `against ${level.toFixed(5)} in at along ${foot.toFixed(5)} in`)
    // The material left on the face: the cutter-body sweep from the blank, read
    // against the operation's own interior so the sampler's lift cancels, from
    // the leave boundary outwards. The material **inside** that boundary is the
    // leave itself -- the foot ring's one-leave gap from the neighbour's face --
    // so it is not leftover, and the 0.002 in guard is the ring's own ±0.001
    // acceptance: a blank sliver that thin is the tolerance, not a collar.
    const window = { from: HEX_END - 0.5, to: HEX_END + 0.5 }
    const swept = sweepByAngle(moves, stock, tool, window, HEX_END)
    const boundary = HEX_END + leave + 0.002
    const interior = { from: 2 * tool.radius, to: 2 * tool.radius + 0.5 }
    const ridge = endRidge(swept, boundary, 1, 2 * tool.radius, interior, MIN_HEIGHT)
    const bound = MIN_HEIGHT + samplingCell(tool, operation)
    assert.ok(ridge.height <= bound,
      `${kind} leave ${leave} leaves the Hex face clear of the Turn level past the leave: `
      + `leftover ${ridge.height.toFixed(5)} in at A${ridge.angle}° <= ${bound.toFixed(5)} in`)
    const gouge = deepestCutterGouge(moves, stock, { radius: tool.radius, type: 'flat' },
      (along, across, up) => hexDepth(stock, along, across, up))
    assert.ok(gouge.depth <= MIN_HEIGHT,
      `${kind} leave ${leave} never enters the Hex: deepest ${gouge.depth.toFixed(5)} in at ${gouge.where}`)
  }
}

// ── the sweep's own rim, which the probe reads the face through ────────────

/**
 * A pose emitted a few ulps outside the profile's rim still cuts the grid point
 * that sits exactly on the nominal rim (#1155 rn-e correction 1).
 *
 * This is the measurement bug behind the review's "highest leftover 0.50000 in
 * at A0°": the generator commands the Turn's foot ring at 1.375 in and the
 * emitted move lands on 1.3750000000012, so a strict `radius + 1e-12` axial
 * footbridged the profile point at exactly 1.25 and the whole blank column there
 * read as leftover. The guard is a **relative** epsilon, so a pose that really
 * is off the footprint still does not cut: the second point here, a thousandth
 * further out, keeps its material. Both halves are asserted, so widening the
 * footprint to pass the first cannot pass the second.
 */
{
  const tool = { type: 'flat_endmill', radius: 0.125, units: 'inch' } as unknown as NormalizedTool
  const state = { along: [1.25, 1.251, 1.2519], top: [1, 1, 1] }
  const pose = { along: 1.37500000000125, radius: 0.5, angle: 0 }
  const swept = sweepProfile(state, [pose], tool, 0)
  assert.ok(Math.abs(swept.top[0] - pose.radius) <= 1e-12,
    `a pose a few ulps off the rim still cuts the point on it: ${swept.top[0].toFixed(9)} in `
    + `against ${pose.radius} in`)
  const outside = { along: [1.25], top: [1] }
  const farther = sweepProfile(outside, [{ along: 1.375001, radius: 0.5, angle: 0 }], tool, 0)
  assert.ok(farther.top[0] === 1,
    `a pose past the rim does not cut: ${farther.top[0].toFixed(9)} in`)
}

console.log('rotaryTargetEnds.test.ts: the target\'s ends are cut, a support and a neighbour still stop the tool')
