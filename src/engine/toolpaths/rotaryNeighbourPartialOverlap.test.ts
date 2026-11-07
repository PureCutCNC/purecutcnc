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
 * Around-the-bar rotary rough and finish keep clear of a neighbour that only
 * **partly** overlaps their cut range (#1155 slice rn-c).
 *
 * `rotaryNeighbours.test.ts` proves the rule on a Hex that covers the Turn's
 * whole cut range from its start, where every ring is sampled over the head and
 * the tool body is never near an end face. Frank's retest found the other
 * shape: the Turn starts 0.05 in **inside** the Hex, so the Hex's far end face
 * (at 1.25) sits just inside the Turn's cut range, and the finish's cutter body
 * entered that face. A partial overlap leaves the higher neighbour's face in a
 * height-map cell whose centre reads the **target's** surface: the cell
 * straddling the face holds the Turn, and the last cell centre that holds the
 * Hex is up to a whole cell before the face. The conservative read used half a
 * cell diagonal, so it lifted the tip only to `lastCentre + radius + half a
 * cell diagonal`, and the cutter body stepped up to half a cell into the face
 * (`rotarySampling.ts`, `runRotaryAngleJob`).
 *
 * The fixture is Frank's `bolt-test-02-x.camj` built in code with the same
 * canned planner the dialogs use -- a Ø2 in round bar along X, a 1.5 in
 * across-flats Hex over 0.75..1.25 and a Ø1 Turn over 1.2..3.75 -- so the
 * committed case and the file his retest used are the same geometry, in inches
 * and with his tools, stepovers and stock-to-leave. Both directions of the
 * partial overlap are covered: the Turn's start inside the Hex's far end, and
 * the Turn ending 0.05 in inside the Hex's near end.
 *
 * Every check sweeps the **real cutter body** (`src/test/rotaryCutterGouge.ts`,
 * the same sweep `rotaryNeighbours.test.ts` runs) along every emitted move at no
 * more than a quarter tool radius of travel and measures it against the
 * analytic solid the operation must not cut. On the branch before the fix the
 * Turn finish's body sat 0.00288 in inside the Hex (0.073 mm) and the tip
 * sampling read 0.5134 in at 1.3721 in along, where the Hex's facing surface is
 * 0.8354 in; after it the same pose reads 0.8766 in and the body clears the Hex
 * by 0.00409 in. The mirrored partial overlap -- the Turn's far end 0.05 in
 * inside the Hex's near end -- fails on the branch the same way (0.00285 in
 * inside, 0.00409 in clear after), and the Turn rough is covered at the saved
 * file's 0.02 in of radial leave and at the zero the handoff specifies (0.00407
 * in clear; the rough's passes stop short of the face, so it is regression
 * coverage of the required setting rather than a second reproducer).
 *
 * ## The wall's foot (#1155 rn-d, Frank's second retest)
 *
 * Clearing the face is not enough. The finish's band begins one cutter radius
 * inside its along range, so its first ring sits beside the Hex's far face and
 * **rides** the Hex: at 1.325 in the ring spans 1.200..1.450 and the Hex is what
 * the tool follows. The tool first reaches the Turn's own surface at 1.375, one
 * cutter radius past the face, and from there the helix advances about one
 * stepover per turn -- so every angle crosses 1.375 on a different turn and the
 * material between the face and that crossing is left standing: a stair-step
 * ledge up to one stepover wide, which is what Frank saw in the simulation. The
 * rough has the same wall but its layers' first full rings land a grid position
 * past the reach, leaving a smaller version of the same step.
 *
 * The rule now is one ring at the wall's foot, at `face + leave + radius`: the
 * cutter's body is **tangent** to the face there, so that ring may read the
 * target's own surface (`wallFootPreps` samples it on the mesh without the
 * neighbour it is tangent to) and it clears everything above the target from
 * `face + leave` on, at the **target surface + leave** (`removeLift` -- the
 * conservative cell pad is taken back off a ring that has nothing but the target
 * under it). The ring is cut as its own ring, never as a helix boundary, because
 * the helix resamples each pose on the operation's mesh and a helix starting at
 * the tangent pose rides the wall for a turn. The sections below measure it with
 * `src/test/rotaryWallFootSweep.ts` -- one radial material profile per degree of
 * A, cut by the real cutter body intersected at the profile's own angle -- and
 * read the leftover beside the face per angle against that specified level.
 * Measured on the first rn-d cut (`3cdf1f78`), whose ring kept the pad, and on
 * this correction:
 *
 * | op | foot cut before (in) | foot cut after (in) | ledge before | ledge after |
 * | --- | --- | --- | --- | --- |
 * | flat finish, leave 0 | 0.50915..0.51001 | 0.49959..0.50000 | 0.25000 | 0.00000 |
 * | flat rough, leave 0.02 | 0.52945..0.52998 | 0.51959..0.52000 | 0.25000 | 0.00000 |
 * | flat rough, leave 0 | 0.50945..0.50998 | 0.49959..0.50000 | 0.25000 | 0.00000 |
 * | ball finish on the rough's material | 0.50916..0.77983 | 0.49959..0.77983 | 0.25000 | 0.11570 |
 *
 * The before figures are the review's: the foot ring was read through the
 * conservative cell pad, so it cut 0.00915..0.01001 in above the target and
 * nothing in the foot zone reached the specified level (a 0.25 in zone, the
 * whole of it, which is the "nothing is cleared" reading that the first cut's
 * `leftoverLevel` hid by comparing the profile with itself). The ball's after
 * figure is its own fillet at the foot -- a ball's section cannot reach below
 * `tip + r - sqrt(r² - d²)`, so it leaves a band at a wall that no placement
 * removes (0.115 in for this 1/4 in ball) -- which is why the ball is held to
 * `<= its own radius` and to the ring's position, while the flat cutters are
 * held to the surface tolerance.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryNeighbourPartialOverlap.test.ts
 */

import assert from 'node:assert/strict'
import { barCentre, barPivotZ } from '../../types/barStock'
import type { BarStock } from '../../types/project'
import { defaultTool, newProject, roundStock } from '../../types/project'
import type { Operation, Project, Tool } from '../../types/project'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { planRotarySolid } from '../../store/helpers/rotarySolids'
import { resolveFeatureInstances } from '../../store/helpers/resolveFeatures'
import type { SelectionState } from '../../store/types'
import { minRenderHeight } from '../csg'
import { normalizeToolForProject } from './geometry'
import { computeOperationToolpath } from './generateOperation'
import { resolveFinishModelSurface, resolveRotaryNeighbourMesh } from './finishModelSurface'
import { rotarySampledMesh } from './rotaryModel'
import { createRotarySamplingPrep, runRotaryAngleJob } from './rotarySampling'
import type { NormalizedTool, ToolpathMove } from './types'
import { deepestCutterGouge } from '../../test/rotaryCutterGouge'
import {
  blankProfile, cutterPosesByAngle, sweepProfile, wallFootLeftover, wallFootWindow,
} from '../../test/rotaryWallFootSweep'
import type { WallFootProfile } from '../../test/rotaryWallFootSweep'

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
/** The Hex's band as the file stores it. */
const HEX_END = HEX_START + HEX_LENGTH
const TURN_START = 1.2
const TURN_LENGTH = 2.55
const TURN_DIAMETER = 1
const TURN_END = TURN_START + TURN_LENGTH
const FLAT_TOOL_ID = 'flat-025'
const BALL_TOOL_ID = 'ball-025'
const SMALL_BALL_TOOL_ID = 'ball-0125'

interface BoltFixture {
  readonly project: Project
  readonly turnId: string
  readonly hexId: string
}

/** The flat and ball cutters Frank's file carries. */
function boltTools() {
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

/**
 * A Ø2 in round bar along X with the Around setup active -- the file's bar and
 * setup, and its tools.
 */
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
 * Frank's `bolt-test-02-x.camj` through the canned planner: the Hex over
 * 0.75..1.25 and the Turn over 1.2..3.75, so the Turn starts 0.05 in inside the
 * Hex.
 */
function boltFixture(): BoltFixture {
  const base = boltProject('rn-c partial overlap')
  const turn = planRotarySolid(base, EMPTY_SELECTION, {
    kind: 'turn', start: TURN_START, length: TURN_LENGTH, diameter: TURN_DIAMETER,
  })
  if (!turn.ok) throw new Error(`the Turn must plan: ${turn.reason}`)
  const hex = planRotarySolid(turn.project, EMPTY_SELECTION, {
    kind: 'polygon', start: HEX_START, length: HEX_LENGTH, sides: 6,
    acrossFlats: HEX_ACROSS_FLATS, rotationDeg: 0,
  })
  if (!hex.ok) throw new Error(`the Hex must plan: ${hex.reason}`)
  return { project: hex.project, turnId: turn.created.featureId, hexId: hex.created.featureId }
}

/** The mirrored Turn's end: 0.05 in inside the Hex's near face. */
const MIRROR_TURN_END = HEX_START + 0.05
const MIRROR_TURN_START = 0.25

/** The mirrored bolt: a Turn over 0.25..0.8 whose **far end** is inside the Hex. */
function mirroredBoltFixture(): BoltFixture {
  const base = boltProject('rn-c mirrored partial overlap')
  // The Hex still runs 0.75..1.25 and the Turn approaches from the other side,
  // ending at 0.8: 0.05 in inside the Hex's near face at 0.75, the mirror of
  // Frank's file, so the bands overlap by 0.05 in and not the 0.45 in a Turn
  // that covers most of the Hex.
  const turn = planRotarySolid(base, EMPTY_SELECTION, {
    kind: 'turn', start: MIRROR_TURN_START, length: MIRROR_TURN_END - MIRROR_TURN_START,
    diameter: TURN_DIAMETER,
  })
  if (!turn.ok) throw new Error(`the mirror Turn must plan: ${turn.reason}`)
  const hex = planRotarySolid(turn.project, EMPTY_SELECTION, {
    kind: 'polygon', start: HEX_START, length: HEX_LENGTH, sides: 6,
    acrossFlats: HEX_ACROSS_FLATS, rotationDeg: 0,
  })
  if (!hex.ok) throw new Error(`the mirror Hex must plan: ${hex.reason}`)
  return { project: hex.project, turnId: turn.created.featureId, hexId: hex.created.featureId }
}

/** A rotary rough or finish on `featureIds` in the Around setup, saved as the file saves it. */
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

/** The four operations Frank's file carries, by the fields that decide their motion. */
function fileOperations(project: Project, turnId: string, hexId: string): Operation[] {
  return [
    // Rotary rough 2 / finish 2: the Turn, with the flat 1/4" endmill.
    rotaryOperation(project, [turnId], 'rotary_rough', {
      name: 'Rotary rough 2', toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125, stockToLeaveRadial: 0.02,
    }),
    rotaryOperation(project, [turnId], 'rotary_finish', {
      name: 'Rotary finish 2', toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125, stockToLeaveRadial: 0,
    }),
    // Rotary rough / finish: the Hex, with the 1/4" and 1/8" ball.
    rotaryOperation(project, [hexId], 'rotary_rough', {
      name: 'Rotary rough', toolRef: BALL_TOOL_ID, stepover: 0.16, stepdown: 0.075, stockToLeaveRadial: 0.02,
    }),
    rotaryOperation(project, [hexId], 'rotary_finish', {
      name: 'Rotary finish', toolRef: SMALL_BALL_TOOL_ID, stepover: 0.16, stepdown: 0.03, stockToLeaveRadial: 0,
    }),
  ]
}

function generate(project: Project, operation: Operation): ToolpathMove[] {
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, `${operation.name} dispatches to the rotary generator`)
  return envelope.result.moves
}

function toolOf(project: Project, operation: Operation) {
  const record = project.tools.find((tool) => tool.id === operation.toolRef)
  assert.ok(record, `${operation.name} has its tool`)
  return normalizeToolForProject(record, project)
}

// ── the analytic solids the operations must not cut ──────────────────────

/**
 * The Hex prism as the canned Polygon shapes it: six facets whose outward
 * normals are `sin/cos` of `k * 60°` from +up at rotation 0, at the apothem
 * `acrossFlats / 2`, centred on the bar's centreline over
 * `HEX_START..HEX_END`. `grow` is the rough's radial stock to leave, which the
 * surface its motion must hold off is enlarged by.
 */
interface HexSolid {
  readonly alongMin: number
  readonly alongMax: number
  readonly apothem: number
  readonly normals: readonly { readonly across: number; readonly up: number }[]
  readonly centre: number
  readonly pivot: number
}

function hexSolid(stock: BarStock, grow: number): HexSolid {
  const normals = Array.from({ length: 6 }, (_, k) => {
    const angle = (k * Math.PI) / 3
    return { across: Math.sin(angle), up: Math.cos(angle) }
  })
  return {
    alongMin: HEX_START,
    alongMax: HEX_END,
    apothem: HEX_ACROSS_FLATS / 2 + grow,
    normals,
    centre: barCentre(stock),
    pivot: barPivotZ(stock),
  }
}

/**
 * How far inside the Hex prism a point lies: the apothem minus the largest facet
 * dot product, floored by the two end faces. Positive is inside, so "no deeper
 * than `minRenderHeight`" is `<= minRenderHeight`; the end faces are why a pass
 * tangent to a face reads 0 rather than the whole radial depth.
 */
function hexDepth(along: number, across: number, up: number, hex: HexSolid): number {
  if (along < hex.alongMin || along > hex.alongMax) return Number.NEGATIVE_INFINITY
  let largest = Number.NEGATIVE_INFINITY
  for (const normal of hex.normals) {
    largest = Math.max(largest, normal.across * (across - hex.centre) + normal.up * (up - hex.pivot))
  }
  return Math.min(hex.apothem - largest, along - hex.alongMin, hex.alongMax - along)
}

/**
 * The Turn as a cylinder about the bar's axis: depth is the radius minus the
 * distance from the axis, floored by its two end faces. `alongMin` is the part
 * of the Turn an operation may cut -- for the Hex's own operations that is from
 * the Hex's far face on, because the Turn's 1.2..1.25 overlap is Hex material.
 */
function turnCylinder(
  stock: BarStock, alongMin: number, alongMax: number, radius: number,
): (along: number, across: number, up: number) => number {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  return (along, across, up) => {
    if (along < alongMin || along > alongMax) return Number.NEGATIVE_INFINITY
    const radial = Math.hypot(across - centre, up - pivot)
    return Math.min(radius - radial, along - alongMin, alongMax - along)
  }
}

/** The Hex's surface radius along one tool direction, in the bar's own frame. */
function hexRayRadius(hex: HexSolid, angleDeg: number): number {
  const angle = ((angleDeg % 360) * Math.PI) / 180
  let largest = Number.NEGATIVE_INFINITY
  for (const normal of hex.normals) {
    largest = Math.max(largest, normal.across * Math.sin(angle) + normal.up * Math.cos(angle))
  }
  return hex.apothem / largest
}

// ── checks ────────────────────────────────────────────────────────────────

const MIN_HEIGHT = minRenderHeight('inch')

/** The fixture is the file's geometry: the Turn starts 0.05 in inside the Hex. */
{
  const { project, turnId, hexId } = boltFixture()
  const definitions = [turnId, hexId].map((id) => {
    const feature = project.features.find((candidate) => candidate.id === id)
    assert.ok(feature, `${id} is a feature`)
    return project.featureDefinitions[feature.definitionId]
  })
  assert.equal(definitions[0].canned?.kind, 'turn')
  assert.equal(definitions[1].canned?.kind, 'polygon')
  const overlap = HEX_END - TURN_START
  assert.ok(
    Math.abs(overlap - 0.05) < 1e-9,
    `the Hex's far end is 0.05 in inside the Turn's range, found ${overlap}`,
  )
  // The Hex stands above the Turn: apothem 0.75 against the Turn's 0.5 radius.
  assert.ok(HEX_ACROSS_FLATS / 2 > TURN_DIAMETER / 2, 'the Hex stands above the Turn')
}

/**
 * The Turn's rough and finish never put the cutter body inside the Hex.
 *
 * The rough carries 0.02 in of radial stock to leave, so it is checked both
 * against the Hex's own surface and against the Hex grown by that leave -- the
 * surface its motion is actually holding off. Both must hold at
 * `minRenderHeight`, the 3D view's own smallest height.
 */
for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
  const { project, turnId, hexId } = boltFixture()
  const operation = fileOperations(project, turnId, hexId).find((candidate) => candidate.kind === kind
    && candidate.target.source === 'features' && candidate.target.featureIds[0] === turnId)
  assert.ok(operation, `the fixture has its ${kind}`)
  const stock = project.stock as BarStock
  const tool = toolOf(project, operation)
  const moves = generate(project, operation)
  assert.ok(moves.length > 0, `${operation.name} emits motion`)
  const grow = operation.stockToLeaveRadial ?? 0
  for (const [label, solid] of [
    ['its own surface', hexSolid(stock, 0)],
    ['its own surface plus the stock to leave', hexSolid(stock, grow)],
  ] as const) {
    const report = deepestCutterGouge(moves, stock, { radius: tool.radius, type: 'flat' }, (along, across, up) =>
      hexDepth(along, across, up, solid))
    assert.ok(
      report.depth <= MIN_HEIGHT,
      `${operation.name}: the cutter body is ${report.depth.toFixed(5)} in inside the Hex (${label}, `
        + `tolerance ${MIN_HEIGHT.toFixed(6)}) at ${report.where}`,
    )
  }
  // The cut really does reach the Hex's far face -- a cutter centre within one
  // radius of it has its body over the face -- so the clearance is not the
  // operation having stopped short of the head.
  const atFace = moves.filter((move) => move.kind !== 'rapid'
    && [move.from, move.to].some((point) => point.x <= HEX_END + tool.radius))
  assert.ok(atFace.length > 0, `${operation.name} cuts within one cutter radius of the Hex's far face`)
}

/**
 * The Hex's own rough and finish never put the cutter body inside the Turn.
 *
 * The Turn is protected from the Hex's far face (1.25) on: the Turn's
 * 1.2..1.25 stretch is inside the Hex, so the Hex's operations are entitled to
 * cut it. The check covers the whole Turn beyond that, not only the part beside
 * the Hex's band.
 */
for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
  const { project, turnId, hexId } = boltFixture()
  const operation = fileOperations(project, turnId, hexId).find((candidate) => candidate.kind === kind
    && candidate.target.source === 'features' && candidate.target.featureIds[0] === hexId)
  assert.ok(operation, `the fixture has its Hex ${kind}`)
  const stock = project.stock as BarStock
  const tool = toolOf(project, operation)
  const moves = generate(project, operation)
  const depth = turnCylinder(stock, HEX_END, TURN_END, TURN_DIAMETER / 2)
  const report = deepestCutterGouge(moves, stock, {
    radius: tool.radius, type: tool.type === 'ball_endmill' ? 'ball' : 'flat',
  }, depth)
  assert.ok(
    report.depth <= MIN_HEIGHT,
    `${operation.name}: the cutter body is ${report.depth.toFixed(5)} in inside the Turn `
      + `(tolerance ${MIN_HEIGHT.toFixed(6)}) at ${report.where}`,
  )
}

/**
 * The mechanism, at the sampler: the Turn finish's tip must be lifted to the
 * Hex's surface at every along position within one cutter radius before the
 * Hex's far face.
 *
 * This is the check that fails before the fix -- 0.5134 in at 1.3721 in along,
 * where the Hex's facing surface is 0.8354 in -- and it is asserted on the
 * generator's own sampling, one angle row at a time, so a failure names the
 * pose rather than only the body point. The cell straddling the face holds the
 * Turn, and the last cell centre that holds the Hex is up to a whole cell
 * before the face; the conservative read must reach a whole cell past the
 * sample to cover it.
 */
{
  const { project, turnId, hexId } = boltFixture()
  const stock = project.stock as BarStock
  const [turn, hex] = resolveFeatureInstances(project, [turnId, hexId])
  assert.ok(turn && hex, 'the Turn and Hex resolve')
  const surface = resolveFinishModelSurface(project, [turn])
  assert.ok(surface, 'the Turn surface resolves')
  // The adapter's own composition: the Turn's surface, then the Hex as a
  // neighbour, then the retained stubs -- the neighbour is a separate argument
  // and `rotarySampledMesh` joins it before the walls (#1155).
  const neighbour = resolveRotaryNeighbourMesh(project, [hex])
  assert.ok(neighbour, 'the Hex neighbour mesh resolves')
  const finish = fileOperations(project, turnId, hexId)
    .find((candidate) => candidate.kind === 'rotary_finish' && candidate.target.source === 'features'
      && candidate.target.featureIds[0] === turnId)
  assert.ok(finish, 'the fixture has its Turn finish')
  const tool = toolOf(project, finish)
  const stepover = 0.32 * tool.diameter
  const params = {
    stepover,
    stockToLeave: 0,
    sampleSpacing: tool.radius / 4,
    requestedCellSize: Math.min(tool.radius / 3, stepover * 0.5),
    alongStart: TURN_START,
    alongEnd: TURN_END,
    safeRadius: barPivotZ(stock) + BAR_DIAMETER / 2 + tool.diameter,
    passDirection: 'around' as const,
    neighbours: [neighbour],
  }
  const mesh = rotarySampledMesh(surface.mesh, params.neighbours, stock, project.meta.units, params)
  const solid = hexSolid(stock, 0)
  // Every pose from the face out to one cutter radius: the body reaches the
  // face from all of them, so none may cut below the Hex's own surface. The
  // step is fine enough that a reach that stops even a few thousandths short of
  // the cutter radius is sampled (the observed failure read 0.5134 in at
  // 1.3721 in along, against a facing surface of 0.8354 in).
  const along: number[] = []
  for (let x = HEX_END; x <= HEX_END + tool.radius + 1e-9; x += 0.002) along.push(x)
  let read = 0
  for (const angle of [0, 33.86, 90, 180, 213.86, 300]) {
    const prep = createRotarySamplingPrep(mesh, stock, tool, {
      along,
      requestedCellSize: params.requestedCellSize,
      conservativeCellBounds: true,
      ...(mesh.retainedTriangleStart !== undefined ? { wallTriangleStart: mesh.retainedTriangleStart } : {}),
    })
    const row = runRotaryAngleJob(prep, prep.planFor([angle]), { index: 0, angle })
    for (let i = 0; i < along.length; i++) {
      const tip = row.row[i] + row.lift
      assert.ok(Number.isFinite(tip), `A ${angle}° at along ${along[i]} has a surface under the tool`)
      const facing = hexRayRadius(solid, angle)
      assert.ok(
        tip >= facing - MIN_HEIGHT,
        `the Turn finish's tip at along ${along[i].toFixed(4)}, A ${angle}° is ${tip.toFixed(4)} in, below the Hex `
          + `facing surface ${facing.toFixed(4)} in; the cutter body reaches the Hex's end face from there`,
      )
      read++
    }
  }
  assert.ok(read === along.length * 6, `every pose was read, found ${read}`)
}

/**
 * The mirror: a Turn whose **far end** is 0.05 in inside the Hex's near end.
 *
 * Same rule, same sweep. The Turn runs 0.25..0.8 and the Hex 0.75..1.25, so the
 * Turn's own end is inside the Hex and the Hex's near face at 0.75 is what the
 * cutter body must stay off. The overlap is the mirrored 0.05 in -- the Turn's
 * range covers 0.75..0.8 of the Hex, not 0.75..1.2 -- so the fixture first
 * proves the partial overlap, then sweeps the rough and the finish. It is a
 * second reproducer, not only coverage: on the branch before the fix the mirror
 * finish's body sat 0.00285 in inside the Hex and clears it by 0.00409 in after.
 */
{
  const { project, turnId } = mirroredBoltFixture()
  // The fixture really is the mirrored partial overlap: the Hex's near face at
  // 0.75 sits 0.05 in inside the Turn's own range.
  const overlap = MIRROR_TURN_END - HEX_START
  assert.ok(
    Math.abs(overlap - 0.05) < 1e-9,
    `the Turn's end is 0.05 in inside the Hex, found ${overlap.toFixed(5)} in of overlap`,
  )
  assert.ok(
    MIRROR_TURN_END > HEX_START && MIRROR_TURN_END < HEX_END,
    'the Turn ends inside the Hex band, so the bands overlap partially',
  )
  const stock = project.stock as BarStock
  for (const [kind, grow] of [['rotary_rough', 0.02], ['rotary_finish', 0]] as const) {
    const operation = rotaryOperation(project, [turnId], kind, {
      name: `mirror ${kind}`, toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125,
      stockToLeaveRadial: grow,
    })
    const tool = toolOf(project, operation)
    const moves = generate(project, operation)
    assert.ok(moves.length > 0, `the mirror ${kind} emits motion`)
    for (const [label, solid] of [
      ['its own surface', hexSolid(stock, 0)],
      ['its own surface plus the stock to leave', hexSolid(stock, grow)],
    ] as const) {
      const report = deepestCutterGouge(moves, stock, { radius: tool.radius, type: 'flat' }, (along, across, up) =>
        hexDepth(along, across, up, solid))
      assert.ok(
        report.depth <= MIN_HEIGHT,
        `the mirror ${kind}: the cutter body is ${report.depth.toFixed(5)} in inside the Hex `
          + `(${label}, tolerance ${MIN_HEIGHT.toFixed(6)}) at ${report.where}`,
      )
    }
    // And the neighbour is engaged: the operation really does cut towards the
    // Hex's near face, so the clearance is not the operation having stopped
    // early.
    const approaching = moves.filter((move) => move.kind !== 'rapid'
      && [move.from, move.to].some((point) => point.x <= HEX_START && point.x > HEX_START - tool.radius))
    assert.ok(approaching.length > 0, `the mirror ${kind} cuts within one cutter radius of the Hex`)
  }
}

/**
 * The Turn rough with **zero** stock to leave, the setting the handoff specifies
 * for op0197.
 *
 * The four operations above are the file's own, and the saved file carries
 * 0.02 in on the Turn rough, so that case stays. Zero leave is a separate
 * setting and the one the handoff requires: the cutter body is meant to reach
 * the Turn's surface, so the only thing it must still clear is the higher
 * neighbour, and it is checked against the Hex's own surface.
 */
{
  const { project, turnId } = boltFixture()
  const operation = rotaryOperation(project, [turnId], 'rotary_rough', {
    name: 'Rotary rough 2, zero leave', toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125,
    stockToLeaveRadial: 0,
  })
  const stock = project.stock as BarStock
  const tool = toolOf(project, operation)
  const moves = generate(project, operation)
  assert.ok(moves.length > 0, 'the zero-leave Turn rough emits motion')
  const report = deepestCutterGouge(moves, stock, { radius: tool.radius, type: 'flat' }, (along, across, up) =>
    hexDepth(along, across, up, hexSolid(stock, 0)))
  assert.ok(
    report.depth <= MIN_HEIGHT,
    `the zero-leave Turn rough: the cutter body is ${report.depth.toFixed(5)} in inside the Hex `
      + `(tolerance ${MIN_HEIGHT.toFixed(6)}) at ${report.where}`,
  )
  // The rough really does reach the Hex's far face, so the clearance is not the
  // operation having stopped short of the head.
  const atFace = moves.filter((move) => move.kind !== 'rapid'
    && [move.from, move.to].some((point) => point.x <= HEX_END + tool.radius))
  assert.ok(atFace.length > 0, 'the zero-leave Turn rough cuts within one cutter radius of the Hex')
}

// ── the wall's foot (#1155 rn-d) ──────────────────────────────────────────

/** The Turn's own surface radius: the level these operations leave at the foot. */
const TURN_RADIUS = TURN_DIAMETER / 2

/**
 * How much commanded A the operation turns at each along position where it does
 * **not** move along: one whole turn (360 degrees) is a full ring there.
 */
function ringTurns(moves: readonly ToolpathMove[]): Map<number, number> {
  const turns = new Map<number, number>()
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    if (Math.abs(move.to.x - move.from.x) > 1e-12 || Math.abs(move.to.y - move.from.y) > 1e-12) continue
    const delta = Math.abs((move.to.a ?? 0) - (move.from.a ?? 0))
    if (!(delta > 1e-9)) continue
    const key = Math.round(move.from.x * 1e6) / 1e6
    turns.set(key, (turns.get(key) ?? 0) + delta)
  }
  return turns
}

/** The leftover beside a wall, over every angle, and the material it was read from. */
interface WallFootSweepResult {
  readonly ledge: number
  readonly edgeOffset: number
  readonly depth: number
  readonly highest: number
  readonly worstAngle: number
  readonly angles: number
  readonly profile: WallFootProfile
}

/**
 * The material left beside a neighbour's wall, per angle (#1155 rn-d).
 *
 * `previous` is the material an earlier operation of the job leaves, so a finish
 * is measured on what its rough left rather than on a blank no real job starts
 * from. `direction` is the side the operation cuts on: `+1` past the face (the
 * Turn's band starting beside the Hex's far face) or `-1` before it (the mirror).
 * `level` is the surface the operation must reach there -- the **specified**
 * target surface plus its stock to leave, passed in by the caller. It is never
 * read off the swept profile: doing that compared the material with itself and
 * reported zero ledge for an untouched blank and for a ring that cut 0.00915 in
 * high (#1155 rn-d correction 2).
 */
function sweepWallFoot(
  project: Project,
  operation: Operation,
  face: number,
  direction: 1 | -1,
  previous: WallFootProfile | null,
  level: number,
): WallFootSweepResult {
  const stock = project.stock as BarStock
  const tool = toolOf(project, operation)
  const tolerance = minRenderHeight(project.meta.units)
  const leave = operation.stockToLeaveRadial ?? 0
  const moves = generate(project, operation)
  const window = wallFootWindow(face, tool, direction)
  const boundary = face + direction * leave
  const angles = cutterPosesByAngle(moves, stock, tool)
  let ledge = Number.NEGATIVE_INFINITY
  let edgeOffset = 0
  let depth = Number.POSITIVE_INFINITY
  let highest = Number.NEGATIVE_INFINITY
  let worstAngle = 0
  let profile: WallFootProfile | null = null
  for (const entry of angles) {
    const base = previous === null
      ? blankProfile(stock, window.from, window.to, tool, boundary)
      : { along: previous.along, top: [...previous.top] }
    const swept = sweepProfile(base, entry.poses, tool, entry.angle)
    const leftover = wallFootLeftover(swept, face, direction, level, leave, tolerance, 2 * tool.radius)
    if (leftover.ledge > ledge) {
      ledge = leftover.ledge
      worstAngle = entry.angle
    }
    const offset = Math.abs(leftover.edge - boundary)
    if (offset > edgeOffset) edgeOffset = offset
    if (leftover.depth < depth) depth = leftover.depth
    if (leftover.highest > highest) highest = leftover.highest
    profile ??= swept
  }
  return {
    ledge,
    edgeOffset,
    depth,
    highest,
    worstAngle,
    angles: angles.length,
    profile: profile ?? blankProfile(stock, window.from, window.to, tool, boundary),
  }
}

/**
 * The sweep's own along resolution (#1155 rn-d): `blankProfile` builds one grid
 * point every 128th of a cutter radius, so a boundary that is not a grid point
 * (`previous` profiles carry their own anchor) and the first tangent cut can each
 * read one step late. The leftover checks allow that step and nothing more.
 */
function sweepStep(project: Project, operation: Operation): number {
  return Math.max(toolOf(project, operation).radius / 128, 1e-5)
}

/** The cutter-centre position the wall's foot is cut from: `face + leave + radius`. */
function wallFoot(face: number, leave: number, direction: 1 | -1, tool: NormalizedTool): number {
  return face + direction * (leave + tool.radius)
}

/**
 * A full ring sits at the wall's foot, and the material the operation leaves
 * beside the face ends on the leave boundary at **every** angle (#1155 rn-d).
 *
 * The Turn's own band starts 0.05 in inside the Hex's far face, so the tool's
 * first ring rides the Hex and the helix has to reach the Turn's surface a turn
 * at a time; the foot ring exists to cut the step that leaves. The numbers are in
 * the file header.
 */
for (const item of [
  { kind: 'rotary_finish' as const, leave: 0, toolRef: FLAT_TOOL_ID, label: 'flat finish' },
  { kind: 'rotary_rough' as const, leave: 0.02, toolRef: FLAT_TOOL_ID, label: 'flat rough, 0.02 leave' },
  { kind: 'rotary_rough' as const, leave: 0, toolRef: FLAT_TOOL_ID, label: 'flat rough, zero leave' },
]) {
  const { project, turnId } = boltFixture()
  const operation = rotaryOperation(project, [turnId], item.kind, {
    name: item.label, toolRef: item.toolRef, stepover: 0.32, stepdown: 0.125, stockToLeaveRadial: item.leave,
  })
  const tool = toolOf(project, operation)
  const tolerance = minRenderHeight(project.meta.units)
  const moves = generate(project, operation)
  const foot = wallFoot(HEX_END, item.leave, 1, tool)
  // The ring is there, at the exact cutter-centre position, and it is a full turn.
  const turns = ringTurns(moves)
  let atFoot = 0
  for (const [along, total] of turns) {
    if (Math.abs(along - foot) < 1e-6) atFoot = total
  }
  assert.ok(
    atFoot >= 360 - 1e-6,
    `${item.label}: a full ring at the wall's foot ${foot.toFixed(4)} in (found ${atFoot.toFixed(3)}° of turn)`,
  )
  // The depth acceptance, against the **specified** surface: target radius plus
  // the operation's own leave. `highest` is what still stands in the foot zone
  // (nothing, after the fix), `depth` is what the ring actually reached there (the
  // surface, after the fix). Reading either against the profile's own lowest
  // value instead would accept a ring that cut 0.00915 in high on Frank's file.
  const level = TURN_RADIUS + item.leave
  const report = sweepWallFoot(project, operation, HEX_END, 1, null, level)
  const step = sweepStep(project, operation)
  assert.ok(
    report.depth <= level + tolerance,
    `${item.label}: the wall's foot is cut down to ${report.depth.toFixed(5)} in from the axis, above the `
      + `${level.toFixed(5)} in target surface plus the ${item.leave} leave at A${report.worstAngle}°`,
  )
  assert.ok(
    report.highest <= level + tolerance,
    `${item.label}: ${(report.highest - level).toFixed(5)} in of material still stands above the `
      + `${level.toFixed(5)} in target surface plus the ${item.leave} leave at A${report.worstAngle}° `
      + `(tolerance ${tolerance.toFixed(6)} in) -- the ledge #1155 rn-d removes`,
  )
  assert.ok(
    report.edgeOffset <= tolerance + step,
    `${item.label}: the leftover beside the Hex ends ${report.edgeOffset.toFixed(5)} in off the `
      + `${item.leave} leave's boundary at A${report.worstAngle}° (one sweep step is ${step.toFixed(6)} in)`,
  )
  assert.ok(
    report.ledge <= tolerance + step,
    `${item.label}: ${report.ledge.toFixed(5)} in of material left past the leave at A${report.worstAngle}° `
      + `(tolerance ${tolerance.toFixed(6)} in plus the sweep's ${step.toFixed(6)} in step)`,
  )
}

/**
 * The ball finish, measured on the material the flat rough leaves.
 *
 * A ball's section cannot reach below `tip + r - sqrt(r² - d²)`, so at a wall's
 * foot it always leaves a fillet of its own; what the fix owes the ball is that
 * the leftover is **that fillet** and not a placement error. The measured 0.11570
 * in is the fillet's own 0.115 in and inside one cutter radius, where a foot left
 * one helix turn late would put it a stepover wider than the ball's own shape
 * leaves. Its depth is held to the target surface like the flat cutters': the
 * first rn-d cut read the ring at 0.50915..0.77983 in, the correction at
 * 0.49959..0.77983 in.
 */
{
  const { project, turnId } = boltFixture()
  const stock = project.stock as BarStock
  const rough = rotaryOperation(project, [turnId], 'rotary_rough', {
    name: 'ball case rough', toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125, stockToLeaveRadial: 0.02,
  })
  const finish = rotaryOperation(project, [turnId], 'rotary_finish', {
    name: 'ball finish', toolRef: BALL_TOOL_ID, stepover: 0.32, stepdown: 0.125, stockToLeaveRadial: 0,
  })
  const tool = toolOf(project, finish)
  const tolerance = minRenderHeight(project.meta.units)
  const foot = wallFoot(HEX_END, 0, 1, tool)
  const turns = ringTurns(generate(project, finish))
  let atFoot = 0
  for (const [along, total] of turns) {
    if (Math.abs(along - foot) < 1e-6) atFoot = total
  }
  assert.ok(
    atFoot >= 360 - 1e-6,
    `the ball finish cuts a full ring at the wall's foot ${foot.toFixed(4)} in (found ${atFoot.toFixed(3)}° of turn)`,
  )
  const roughLevel = TURN_RADIUS + 0.02
  const roughProfile = sweepWallFoot(project, rough, HEX_END, 1, null, roughLevel)
  assert.ok(
    roughProfile.highest <= roughLevel + tolerance,
    `the ball case's rough leaves ${(roughProfile.highest - roughLevel).toFixed(5)} in above its own `
      + `${roughLevel.toFixed(5)} in surface plus leave (tolerance ${tolerance.toFixed(6)} in), so the ball's `
      + `figure is its own fillet`,
  )
  const step = sweepStep(project, finish)
  const report = sweepWallFoot(project, finish, HEX_END, 1, roughProfile.profile, TURN_RADIUS)
  // The ball's fillet is its own shape: its section cannot reach below the tip
  // radius anywhere but on the ring's own axis, so the leftover spans one cutter
  // radius. It must be that fillet and no placement error on top of it.
  assert.ok(
    report.depth <= TURN_RADIUS + tolerance,
    `the ball finish reaches only ${report.depth.toFixed(5)} in from the axis at the foot, above the `
      + `${TURN_RADIUS.toFixed(3)} in target surface`,
  )
  assert.ok(
    report.ledge <= tool.radius + tolerance + step,
    `the ball finish leaves ${report.ledge.toFixed(5)} in past the leave at A${report.worstAngle}°, wider than `
      + `its own fillet (one cutter radius, ${tool.radius} in, plus the sweep's ${step.toFixed(6)} in step)`,
  )
  // And it still comes to the face: the ring at the foot is a real cut at the
  // target's surface, not a lift onto the Hex. This is the depth acceptance the
  // first cut bypassed: the ring read 0.50915..0.51001 in, not 0.5.
  const atFootMoves = generate(project, finish).filter((move) => Math.abs(move.from.x - foot) < 1e-6)
  assert.ok(atFootMoves.length > 0, 'the ball finish emits cut moves at the wall foot')
  const lowest = Math.min(...atFootMoves.map((move) => move.from.z - barPivotZ(stock)))
  assert.ok(
    lowest <= TURN_RADIUS + tolerance,
    `the ball ring at the foot cuts to ${lowest.toFixed(5)} in from the axis, above the Turn's `
      + `${TURN_RADIUS.toFixed(3)} in surface (tolerance ${tolerance.toFixed(6)} in) -- the lift the `
      + `first cut put on it read 0.50915..0.51001 in`,
  )
  // The other side of the same check: the sampler's own one-cent grid can read a
  // ball tip a few ten-thousandths low, but not a whole cell.
  assert.ok(
    lowest >= TURN_RADIUS - 0.001,
    `the ball ring at the foot cuts to ${lowest.toFixed(5)} in from the axis, more than the sampler's `
      + `grid below the Turn's ${TURN_RADIUS.toFixed(3)} in surface`,
  )
}

/**
 * The mirror: a Turn whose **far end** is 0.05 in inside the Hex's near face, so
 * the neighbour rises at the band's far end and the foot is
 * `Hex near face - leave - radius`.
 */
for (const item of [
  { kind: 'rotary_finish' as const, leave: 0 },
  { kind: 'rotary_rough' as const, leave: 0.02 },
]) {
  const { project, turnId } = mirroredBoltFixture()
  const operation = rotaryOperation(project, [turnId], item.kind, {
    name: `mirror ${item.kind}`, toolRef: FLAT_TOOL_ID, stepover: 0.32, stepdown: 0.125,
    stockToLeaveRadial: item.leave,
  })
  const tool = toolOf(project, operation)
  const tolerance = minRenderHeight(project.meta.units)
  const foot = wallFoot(HEX_START, item.leave, -1, tool)
  const turns = ringTurns(generate(project, operation))
  let atFoot = 0
  for (const [along, total] of turns) {
    if (Math.abs(along - foot) < 1e-6) atFoot = total
  }
  assert.ok(
    atFoot >= 360 - 1e-6,
    `the mirror ${item.kind}: a full ring at the far wall's foot ${foot.toFixed(4)} in `
      + `(found ${atFoot.toFixed(3)}° of turn)`,
  )
  const level = TURN_RADIUS + item.leave
  const step = sweepStep(project, operation)
  const report = sweepWallFoot(project, operation, HEX_START, -1, null, level)
  assert.ok(
    report.depth <= level + tolerance,
    `the mirror ${item.kind}: the far foot is cut down to ${report.depth.toFixed(5)} in from the axis, `
      + `above the ${level.toFixed(5)} in target surface plus leave`,
  )
  assert.ok(
    report.highest <= level + tolerance,
    `the mirror ${item.kind}: ${(report.highest - level).toFixed(5)} in of material still stands above the `
      + `${level.toFixed(5)} in target surface plus leave at A${report.worstAngle}° `
      + `(tolerance ${tolerance.toFixed(6)} in)`,
  )
  assert.ok(
    report.ledge <= tolerance + step,
    `the mirror ${item.kind}: ${report.ledge.toFixed(5)} in of material left past the leave on the band's `
      + `far side at A${report.worstAngle}° (tolerance ${tolerance.toFixed(6)} in plus the sweep's `
      + `${step.toFixed(6)} in step)`,
  )
  assert.ok(
    report.edgeOffset <= tolerance + step,
    `the mirror ${item.kind}: the leftover ends ${report.edgeOffset.toFixed(5)} in off the `
      + `${item.leave} leave's boundary`,
  )
}

/**
 * The control: a neighbour that does **not** rise out of the band adds no foot.
 *
 * The Hex's own operations have the Turn as a neighbour, and its surface is
 * 0.25 in below the Hex's apothem, so nothing steps up inside the Hex's band --
 * the emitted rings must stay on the plain stepover grid the operation has always
 * sampled.
 */
{
  const { project, turnId, hexId } = boltFixture()
  const operation = rotaryOperation(project, [hexId], 'rotary_finish', {
    name: 'the Hex finish', toolRef: SMALL_BALL_TOOL_ID, stepover: 0.16, stepdown: 0.03, stockToLeaveRadial: 0,
  })
  const tool = toolOf(project, operation)
  const moves = generate(project, operation)
  assert.ok(moves.length > 0, 'the Hex finish emits motion')
  // The cutter span of the Hex's band, exactly as `rotaryCutterSpan` pulls it in,
  // and the uniform grid `aroundGrid` builds over it: the operation's own
  // `ceil(span / stepover)` intervals, both endpoints included.
  const start = HEX_START + tool.radius
  const end = HEX_END - tool.radius
  const stepover = operation.stepover * tool.diameter
  const intervals = Math.ceil((end - start) / stepover)
  const onGrid = (along: number): boolean => {
    const index = Math.round(((along - start) / (end - start)) * intervals)
    return Math.abs(start + ((end - start) * index) / intervals - along) <= 1e-6
  }
  for (const along of ringTurns(moves).keys()) {
    assert.ok(onGrid(along), `the Hex finish's ring at ${along.toFixed(4)} in is on its stepover grid`)
  }
  // And its own band starts at the Hex's near face, where the Turn below it is
  // no wall at all.
  const wallFootRing = [...ringTurns(moves).keys()].some((along) =>
    Math.abs(along - wallFoot(HEX_END, 0, 1, tool)) < 1e-6)
  assert.ok(!wallFootRing, "no wall-foot ring is cut where the neighbour does not rise")
  void turnId
}

// ── a wall that rises only out of the flats (#1155 rn-d correction 1) ─────

/** A wall that rises only out of the target's flats, and the controls around it. */
interface FlatWallFixture {
  readonly project: Project
  readonly targetId: string
  readonly neighbourId: string
  /** The neighbour's outer radius. */
  readonly neighbourRadius: number
}

/**
 * A **polygon** target with a **cylinder** neighbour whose end face sits inside
 * the target's band: the shape the first wall test missed (#1155 rn-d
 * correction 1, review P1).
 *
 * The polygon is the handoff's Hex, apothem 0.75 and corners 0.866, run from
 * 1.2 to 3.75. The neighbour is a cylinder of radius `radius` over 0.75..1.25,
 * so its end face at 1.25 is inside the target's band and the tool reaches the
 * target's own surface at 1.25 + 0.125 = 1.375. With `radius = 0.8` the
 * neighbour stands 0.05 in above the target's **flats** and 0.066 in below its
 * corners: the surface the tool follows steps up at every angle over a flat, but
 * a comparison of the two meshes' largest radii sees only 0.8 < 0.866 and
 * reports no wall at all.
 */
function flatWallFixture(radius: number): FlatWallFixture {
  const base = boltProject(`rn-d flat wall ${radius}`)
  const neighbour = planRotarySolid(base, EMPTY_SELECTION, {
    kind: 'turn', start: HEX_START, length: HEX_LENGTH, diameter: 2 * radius,
  })
  if (!neighbour.ok) throw new Error(`the neighbour must plan: ${neighbour.reason}`)
  const target = planRotarySolid(neighbour.project, EMPTY_SELECTION, {
    kind: 'polygon', start: TURN_START, length: TURN_LENGTH, sides: 6,
    acrossFlats: HEX_ACROSS_FLATS, rotationDeg: 0,
  })
  if (!target.ok) throw new Error(`the target must plan: ${target.reason}`)
  return {
    project: target.project,
    targetId: target.created.featureId,
    neighbourId: neighbour.created.featureId,
    neighbourRadius: radius,
  }
}

/**
 * The target's nominal surface radius at one angle of the polygon: the apothem
 * over the largest facet dot product, exactly as the solid's facet is cut.
 */
function polygonRayRadius(angleDeg: number): number {
  const apothem = HEX_ACROSS_FLATS / 2
  const angle = (angleDeg * Math.PI) / 180
  let largest = Number.NEGATIVE_INFINITY
  for (let k = 0; k < 6; k++) {
    const normal = (k * Math.PI) / 3
    largest = Math.max(largest, Math.sin(normal) * Math.sin(angle) + Math.cos(normal) * Math.cos(angle))
  }
  return apothem / largest
}

/**
 * The fixture's own geometry: the neighbour is above the flats and below the
 * corners, so the largest-radius comparison can only see the corners.
 */
{
  const { project, neighbourId, targetId, neighbourRadius } = flatWallFixture(0.8)
  const definitions = [neighbourId, targetId].map((id) => {
    const feature = project.features.find((candidate) => candidate.id === id)
    assert.ok(feature, `${id} is a feature`)
    return project.featureDefinitions[feature.definitionId]
  })
  assert.equal(definitions[0].canned?.kind, 'turn')
  assert.equal(definitions[1].canned?.kind, 'polygon')
  const targetCorner = polygonRayRadius(30)
  assert.ok(Math.abs(targetCorner - HEX_ACROSS_FLATS / Math.sqrt(3)) < 1e-9, `the corner radius is ${targetCorner}`)
  assert.ok(neighbourRadius > HEX_ACROSS_FLATS / 2 + MIN_HEIGHT, 'the neighbour rises above the flats')
  assert.ok(neighbourRadius < targetCorner - MIN_HEIGHT, 'the neighbour stays below the corners')
}

/**
 * A full ring is cut at the wall's foot even though the neighbour only rises out
 * of the flats (#1155 rn-d correction 1, review P1).
 *
 * The foot is `1.25 + 0.125 = 1.375`. The first cut compared the two meshes'
 * largest radii -- the neighbour's 0.8 against the polygon's corner 0.866 -- and
 * emitted no ring there; the ring is what puts the material at the flat angles on
 * the target's own surface instead of on the stair-step the helix leaves.
 */
{
  const { project, targetId } = flatWallFixture(0.8)
  const operation = rotaryOperation(project, [targetId], 'rotary_finish', {
    name: 'polygon finish against a rising cylinder', toolRef: FLAT_TOOL_ID, stepover: 0.32,
    stepdown: 0.125, stockToLeaveRadial: 0,
  })
  const tool = toolOf(project, operation)
  const stock = project.stock as BarStock
  const tolerance = minRenderHeight(project.meta.units)
  const foot = wallFoot(HEX_END, 0, 1, tool)
  const moves = generate(project, operation)
  const turns = ringTurns(moves)
  const atFoot = turns.get(Math.round(foot * 1e6) / 1e6) ?? 0
  assert.ok(
    atFoot >= 360 - 1e-6,
    `a full ring at the wall's foot ${foot.toFixed(4)} in where the neighbour rises only out of the flats `
      + `(found ${atFoot.toFixed(3)}° of turn)`,
  )
  // And the ring follows the **target**, not the neighbour: its lowest radius is
  // the polygon's apothem, not the cylinder's 0.8 in. A ring lifted onto the
  // neighbour would read 0.8 in at every angle.
  const pivot = barPivotZ(stock)
  const radii = moves
    .filter((move) => move.kind !== 'rapid' && Math.abs(move.from.x - foot) < 1e-6)
    .map((move) => move.from.z - pivot)
  assert.ok(radii.length > 0, 'the wall-foot ring emits motion')
  const lowest = Math.min(...radii)
  assert.ok(
    lowest <= HEX_ACROSS_FLATS / 2 + tolerance,
    `the wall-foot ring cuts no lower than ${lowest.toFixed(5)} in from the axis, above the polygon's `
      + `${(HEX_ACROSS_FLATS / 2).toFixed(3)} in flat`,
  )
  assert.ok(
    lowest >= HEX_ACROSS_FLATS / 2 - tolerance - 0.01,
    `the wall-foot ring reaches ${lowest.toFixed(5)} in from the axis, below the polygon's `
      + `${(HEX_ACROSS_FLATS / 2).toFixed(3)} in flat`,
  )
}

/**
 * The control: the same polygon target with a cylinder that stays **below** every
 * angle of it (radius 0.7 against the 0.75 flat) adds no foot ring. The wall test
 * must not fire merely because a neighbour is present.
 */
{
  const { project, targetId } = flatWallFixture(0.7)
  const operation = rotaryOperation(project, [targetId], 'rotary_finish', {
    name: 'polygon finish against a lower cylinder', toolRef: FLAT_TOOL_ID, stepover: 0.32,
    stepdown: 0.125, stockToLeaveRadial: 0,
  })
  const tool = toolOf(project, operation)
  const foot = wallFoot(HEX_END, 0, 1, tool)
  const turns = ringTurns(generate(project, operation))
  assert.ok(
    ![...turns.keys()].some((along) => Math.abs(along - foot) < 1e-6),
    `no wall-foot ring at ${foot.toFixed(4)} in where the neighbour stays below the target's flats`,
  )
}

/**
 * The level is the **specified** target surface, not the profile's own lowest
 * value (#1155 rn-d correction 2, review P1): an untouched blank must report the
 * whole foot zone as leftover, where the first cut's `leftoverLevel` reported
 * zero because the blank's lowest value was the blank itself.
 */
{
  const { project } = boltFixture()
  const record = project.tools.find((candidate) => candidate.id === FLAT_TOOL_ID)
  assert.ok(record, 'the fixture has its 1/4" flat')
  const stock = project.stock as BarStock
  const tool = normalizeToolForProject(record, project)
  const tolerance = minRenderHeight(project.meta.units)
  const profile = blankProfile(stock, HEX_END - 4 * tool.radius, HEX_END + 6 * tool.radius, tool, HEX_END)
  const untouched = wallFootLeftover(profile, HEX_END, 1, TURN_RADIUS, 0, tolerance, 2 * tool.radius)
  assert.ok(
    untouched.ledge >= 2 * tool.radius - 1e-9,
    `an untouched blank reports ${untouched.ledge.toFixed(5)} in of ledge, not the whole ${(2 * tool.radius).toFixed(5)} in `
      + 'foot zone: the level is the specified target, so nothing is vacuous',
  )
}

// ── the sweep's cutter body (#1155 rn-d correction 3) ─────────────────────

/**
 * The sweep intersects the **actual** cutter body at the profile's angle, not its
 * axial footprint at a zero angular offset (#1155 rn-d correction 3, review P2).
 *
 * The first cut threw the pose's own angle away and applied its whole axial
 * footprint to every angle inside its subtended arc. This point stands 0.13547 in
 * from a radius-0.125 cutter's axis -- outside the body -- and was credited as
 * cut: the axial offset is 0.1 in, inside the 0.125 in footprint, and the pose's
 * whole section was applied as if it were on the point's own radial line. With
 * the angular offset kept, the body's surface at 7 degrees reaches only 0.6153 in
 * from the bar's axis, below the 0.75 in material there.
 */
{
  const { project } = boltFixture()
  const record = project.tools.find((candidate) => candidate.id === FLAT_TOOL_ID)
  assert.ok(record, 'the fixture has its 1/4" flat')
  const tool = normalizeToolForProject(record, project)
  const along = 0.1
  const tip = 0.5
  const angle = 7
  const material = 0.75
  const profile: WallFootProfile = { along: [0], top: [material] }
  const distance = Math.hypot(along, material * Math.sin((angle * Math.PI) / 180))
  assert.ok(
    distance > tool.radius,
    `the reproducer's point is ${distance.toFixed(5)} in from the cutter's axis, outside its `
      + `${tool.radius} in radius`,
  )
  const off = sweepProfile(profile, [{ along, radius: tip, angle: 0 }], tool, angle)
  assert.equal(
    off.top[0], material,
    `a pose 7 degrees off the material's line leaves the ${material} in top alone: the point is `
      + `${distance.toFixed(5)} in from its axis, outside the ${tool.radius} in body`,
  )
  // The same pose on the point's own line does cut it, so the check is the angle
  // and not the pose being ignored altogether.
  const onLine = sweepProfile(profile, [{ along, radius: tip, angle }], tool, angle)
  assert.ok(
    onLine.top[0] <= tip + MIN_HEIGHT,
    `the pose on the material's own line cuts the ${material} in top down to ${onLine.top[0].toFixed(5)} in, `
      + `at the ${tip} in tip`,
  )
}

console.log('rotary partial-overlap neighbour tests passed')
