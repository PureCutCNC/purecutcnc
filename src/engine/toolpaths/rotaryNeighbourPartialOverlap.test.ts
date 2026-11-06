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
import type { ToolpathMove } from './types'
import { deepestCutterGouge } from '../../test/rotaryCutterGouge'

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

console.log('rotary partial-overlap neighbour tests passed')
