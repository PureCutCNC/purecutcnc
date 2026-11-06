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
 * Around-the-bar rotary rough and finish keep clear of neighbour models (#1155).
 *
 * An around rotary operation used to sample its **target** alone, so a Turn
 * rough or finish cut straight through a Hex standing on the same bar. The
 * approved rule is that any other STL model feature on the bar is material:
 * inside its range the operation cuts down to the higher of the target and its
 * neighbours. These cases assert that rule where it can be seen -- against the
 * Hex solid itself, not against the generator's own sampled heights.
 *
 * The fixture is built in code from canned Turn and Polygon models
 * (`planRotarySolid`, the same planner the dialogs use): a Ø20 mm round bar
 * along X, a 40 mm Turn at Ø10 from along 10, and a 15 mm across-flats Hex
 * standing on the Turn over along 10..20. The Hex's apothem (7.5) reaches
 * 2.5 mm above the Turn's surface (5), so an operation that ignores it cuts
 * that far into material that must survive.
 *
 * Mutations this file is checked with (each was applied, seen to fail, and
 * restored):
 *   1. leave the neighbours out of the sampling mesh (`prepareRotaryTargets`
 *      uses `mesh` alone) -> every gouge case, around and along, sees the
 *      cutter enter the Hex, and the shank helix runs through the head band;
 *   2. let the helix sample the target-only mesh (the ring grid keeps the
 *      neighbour) -> the head band stops falling back to rings and the helix
 *      crosses it, which the helix assertions catch;
 *   3. append the neighbours **after** the retained stubs (so the wall
 *      boundary covers their triangles) -> the sampled mesh's wall boundary no
 *      longer starts after the neighbour;
 *   4. drop the neighbours when the operation carries a #1096 region ->
 *      the region test cuts the Hex away;
 *   5. run the outside-bar check on the combined mesh -> the neighbour that
 *      pokes out of the bar warns on the Turn's operation;
 *   6. drop the along-overlap cull -> the model outside the target's range
 *      moves the operation's output;
 *   7. sample the joined mesh without `conservativeCellBounds` (a neighbour
 *      present but read at cell centres only) -> the along check fails: the
 *      margin with a neighbour is no larger than the target-only run's, which is
 *      the correction's own rule, and the along gouge case fails with it.
 *
 * The two checks added for #1155 acceptance 2 are the Hex operation's own drift.
 * With the Hex as the target the Turn is a neighbour wholly inside it, so the
 * material is the Hex; the extra mesh can still move the **conservative lift**
 * (`heightMap.cellRise` -> `min(cellRise, cellSize)`), a maximum over the
 * triangles rasterised in that angle's window (`rotaryRaster.ts`
 * `trackCellRise`) that `assembleRotarySampling` adds to every finite sample.
 * The checks pin its direction and size (a sample may only rise, a margin may
 * not shrink and may not grow past one cell) and compare every emitted point
 * with the no-neighbour run at the same along position and angle
 * (`compareRotaryDepth`, `src/test/rotaryDepthCompare.ts`): the baseline's depth
 * there is interpolated along its own segments, and a point no baseline segment
 * passes through must be in the air, so no point is skipped. Mutation 8: lower
 * the points the old exact-angle match could not pair (641 of them, to -100 mm)
 * -> that check fails; the check also lowers every third move by just over one
 * cell itself and requires the comparison to see it.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryNeighbours.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpuRatio } from '../../test/cpuRatio'
import { defaultTool, newProject, rectProfile, roundStock } from '../../types/project'
import type { Operation, Project, SketchFeature } from '../../types/project'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import type { BarStock } from '../../types/project'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { resolveFeatureInstances } from '../../store/helpers/resolveFeatures'
import { planRotarySolid } from '../../store/helpers/rotarySolids'
import { projectWithFeatures } from '../../test/projectFixtures'
import type { SelectionState } from '../../store/types'
import { minRenderHeight } from '../csg'
import { resolveFinishModelSurface, resolveRotaryNeighbourMesh } from './finishModelSurface'
import { computeOperationToolpath } from './generateOperation'
import { normalizeToolForProject } from './geometry'
import { rotaryAlongRange, rotaryConservativeSampling, rotarySampledMesh, sampleRotaryModel } from './rotaryModel'
import type { RotaryFinishParams } from './rotaryModel'
import { alongExtremes } from './rotarySampling'
import type { ToolpathMove, ToolpathResult } from './types'
import { compareRotaryDepth } from '../../test/rotaryDepthCompare'
import { deepestCutterGouge } from '../../test/rotaryCutterGouge'
import type { CutterGougeReport } from '../../test/rotaryCutterGouge'

// ── fixture ───────────────────────────────────────────────────────────────

const BAR_DIAMETER = 20
const BAR_LENGTH = 60
const TURN_START = 10
const TURN_LENGTH = 40
const TURN_DIAMETER = 10
const HEX_START = 10
const HEX_LENGTH = 10
const HEX_ACROSS_FLATS = 15
const TOOL_DIAMETER = 4
const STOCK_TO_LEAVE = 0.4
const STEPDOWN = 1.5
const STEPOVER_RATIO = 0.3
const HEX_END = HEX_START + HEX_LENGTH

/** The planner's selection argument, unused by the canned-solid path. */
const EMPTY_SELECTION = {
  mode: 'feature', selectedFeatureId: null, selectedFeatureIds: [], selectedTabIds: [],
  selectedClampIds: [], selectedNode: null, hoveredFeatureId: null, sketchEditTool: null,
  activeControl: null, groupFolderId: null,
} as unknown as SelectionState

interface BoltFixture {
  readonly project: Project
  readonly turnId: string
  readonly hexId: string
}

interface BoltOptions {
  /** The blank shape; both are inside the bar. */
  readonly shape?: 'round' | 'square'
  /** Whether the Hex stands on the Turn at all. */
  readonly neighbour?: boolean
  /** Across offset of the Hex, to push part of it out of the bar. */
  readonly hexAcrossOffset?: number
}

/**
 * The bolt: a Turn with a Hex standing on its band, built through the canned
 * model planner so the mesh assets, definitions and Z spans are the real ones.
 */
function boltFixture(options: BoltOptions = {}): BoltFixture {
  const shape = options.shape ?? 'round'
  const base = newProject('rn-a neighbours', 'mm')
  base.meta.projectType = 'rotary'
  base.meta.maxTravelZ = 40
  base.stock = shape === 'round'
    ? roundStock(BAR_DIAMETER, BAR_LENGTH, 'x')
    : squareStock(BAR_DIAMETER, BAR_LENGTH, 'x')
  base.tools = [
    {
      ...defaultTool('mm', 1), id: 'flat', name: 'Flat 4', type: 'flat_endmill',
      diameter: TOOL_DIAMETER, defaultStepover: STEPOVER_RATIO, defaultStepdown: STEPDOWN,
    },
    {
      ...defaultTool('mm', 1), id: 'ball', name: 'Ball 4', type: 'ball_endmill',
      diameter: TOOL_DIAMETER, defaultStepover: STEPOVER_RATIO, defaultStepdown: STEPDOWN,
    },
  ]
  base.setups.push({
    ...base.setups[0], id: 'around', name: 'Around', kind: 'around',
    orientation: { axis: 'x', angleDeg: 0 },
  })
  base.activeSetupId = 'around'
  const turn = planRotarySolid(base, EMPTY_SELECTION, {
    kind: 'turn', start: TURN_START, length: TURN_LENGTH, diameter: TURN_DIAMETER,
  })
  assert.ok(turn.ok, `the Turn plans (${turn.ok ? '' : turn.reason})`)
  const turnId = turn.created.featureId
  if (options.neighbour === false) return { project: turn.project, turnId, hexId: '' }
  const hex = planRotarySolid(turn.project, EMPTY_SELECTION, {
    kind: 'polygon', start: HEX_START, length: HEX_LENGTH, sides: 6,
    acrossFlats: HEX_ACROSS_FLATS, rotationDeg: 0,
  })
  assert.ok(hex.ok, `the Hex plans (${hex.ok ? '' : hex.reason})`)
  const hexId = hex.created.featureId
  if (options.hexAcrossOffset === undefined) return { project: hex.project, turnId, hexId }
  // The canned planner keeps every model inside the blank, so the sticking-out
  // case moves the instance afterwards -- the same 2D transform an imported
  // model carries.
  const offset = options.hexAcrossOffset
  const project: Project = {
    ...hex.project,
    features: hex.project.features.map((feature) => (feature.id === hexId
      ? { ...feature, transform: { ...feature.transform, f: feature.transform.f + offset } }
      : feature)),
  }
  return { project, turnId, hexId }
}

function rotaryOperation(
  project: Project,
  featureIds: readonly string[],
  kind: 'rotary_rough' | 'rotary_finish',
  patch: Partial<Operation> = {},
): Operation {
  return {
    ...defaultOperationForTarget(
      project, kind, kind === 'rotary_rough' ? 'rough' : 'finish',
      { source: 'features', featureIds: [...featureIds] }, project.operations.length + 1,
    ),
    setupId: 'around',
    stepover: STEPOVER_RATIO,
    stepdown: STEPDOWN,
    stockToLeaveRadial: kind === 'rotary_rough' ? STOCK_TO_LEAVE : 0,
    ...patch,
  }
}

/** A short identity for a move stream, so a failing comparison prints one line. */
function movesDigest(moves: readonly ToolpathMove[]): string {
  return createHash('sha256').update(JSON.stringify(moves)).digest('hex')
}

function generate(project: Project, operation: Operation): ToolpathResult {
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, 'the operation dispatches to the rotary generator')
  return envelope.result
}

// ── the analytic Hex solid ────────────────────────────────────────────────

/**
 * The Hex prism as the canned Polygon shapes it: six facets whose outward
 * normals are `sin/cos` of `k * 60°` from +up at rotation 0, at the apothem
 * `acrossFlats / 2`, centred on the bar's centreline and standing over
 * `HEX_START..HEX_END`.
 */
interface HexSolid {
  readonly alongMin: number
  readonly alongMax: number
  /** Twice the apothem grows the solid by the rough's radial stock to leave. */
  readonly apothem: number
  readonly centre: number
  readonly pivot: number
}

const HEX_NORMALS = Array.from({ length: 6 }, (_, k) => {
  const angle = k * Math.PI / 3
  return { across: Math.sin(angle), up: Math.cos(angle) }
})

function hexSolid(stock: BarStock, grow: number, acrossOffset = 0): HexSolid {
  return {
    alongMin: HEX_START, alongMax: HEX_END,
    apothem: HEX_ACROSS_FLATS / 2 + grow,
    centre: barCentre(stock) + acrossOffset, pivot: barPivotZ(stock),
  }
}

/**
 * How far inside the Hex prism a point lies, in millimetres: the apothem minus
 * the largest facet dot product. Positive is inside, so "no deeper than
 * `minRenderHeight`" is `<= minRenderHeight`.
 */
function hexDepth(along: number, across: number, up: number, hex: HexSolid): number {
  if (along < hex.alongMin || along > hex.alongMax) return Number.NEGATIVE_INFINITY
  let largest = Number.NEGATIVE_INFINITY
  for (const normal of HEX_NORMALS) {
    largest = Math.max(largest, normal.across * (across - hex.centre) + normal.up * (up - hex.pivot))
  }
  // The two end faces are faces of the prism. Without them a body point one
  // radius inside the band reads as "inside by the whole radial depth", so a
  // pass tangent to the end face looks like a gouge; with them, a point on the
  // face is depth 0 and a point behind it is negative.
  return Math.min(
    hex.apothem - largest,
    along - hex.alongMin,
    hex.alongMax - along,
  )
}

/** The same sweep the #1155 suites share, against this fixture's Hex solid. */
function deepestGouge(
  moves: readonly ToolpathMove[],
  stock: BarStock,
  tool: { readonly radius: number; readonly type: 'flat' | 'ball' },
  hex: HexSolid,
): CutterGougeReport {
  return deepestCutterGouge(moves, stock, tool, (along, across, up) => hexDepth(along, across, up, hex))
}

function assertNoGouge(
  label: string,
  moves: readonly ToolpathMove[],
  stock: BarStock,
  tool: { readonly radius: number; readonly type: 'flat' | 'ball' },
  hex: HexSolid,
  tolerance: number,
): void {
  const report = deepestGouge(moves, stock, tool, hex)
  assert.ok(
    report.depth <= tolerance,
    `${label}: the cutter body is ${report.depth.toFixed(4)} mm inside the Hex (tolerance ${tolerance}) at ${report.where}`,
  )
}

// ── checks ────────────────────────────────────────────────────────────────

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

const TOOL_RADIUS = TOOL_DIAMETER / 2
const MIN_HEIGHT = minRenderHeight('mm')
/*
 * One bound for every mode: `MIN_HEIGHT`, the 3D view's own minimum render
 * height. Along mode samples conservatively whenever a neighbour is in the
 * mesh (`prepareRotaryTargets`), so it holds the same bound around mode does;
 * before that it read each cell only at its centre and stepped 0.500 mm into a
 * neighbour's end face.
 */

check('the Hex stands above the Turn and is a neighbour of the Turn operations', () => {
  const { project, turnId, hexId } = boltFixture()
  const [turn, hex] = resolveFeatureInstances(project, [turnId, hexId])
  // The Hex's apothem is 7.5; the Turn's surface is radius 5. The Turn is the
  // operation's target, so the Hex is a neighbour, never the surface.
  assert.equal(project.features.find((feature) => feature.id === turnId)?.name, 'Turn')
  assert.equal(project.features.find((feature) => feature.id === hexId)?.name, 'Hex')
  assert.ok(turn && hex, 'both models resolve')
  const operation = rotaryOperation(project, [turnId], 'rotary_finish')
  assert.deepEqual(operation.target, { source: 'features', featureIds: [turnId] })
})

for (const toolRef of ['flat', 'ball'] as const) {
  const toolType = toolRef === 'flat' ? 'flat' as const : 'ball' as const
  check(`around rough and finish follow the Hex with a ${toolRef} cutter (no gouge)`, () => {
    const { project, turnId } = boltFixture()
    const stock = project.stock as BarStock
    for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
      const operation = rotaryOperation(project, [turnId], kind, { toolRef, rotaryPassDirection: 'around' })
      const result = generate(project, operation)
      const grow = kind === 'rotary_rough' ? STOCK_TO_LEAVE : 0
      assertNoGouge(
        `${kind} ${toolRef}`, result.moves, stock,
        { radius: TOOL_RADIUS, type: toolType }, hexSolid(stock, grow), MIN_HEIGHT,
      )
      // The cut really is over the Hex's band, so the gouge check is not
      // passing because the operation skipped the head.
      const head = result.moves.filter((move) =>
        move.kind !== 'rapid' && [move.from, move.to].some((point) => {
          const along = stock.axis === 'x' ? point.x : point.y
          return along >= HEX_START && along <= HEX_END
        }))
      assert.ok(head.length > 0, `${kind} ${toolRef} cuts over the Hex's band`)
    }
  })
}

check('the same bolt case in along mode keeps clear of the Hex', () => {
  const { project, turnId } = boltFixture()
  const stock = project.stock as BarStock
  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    const operation = rotaryOperation(project, [turnId], kind, {
      toolRef: 'flat', rotaryPassDirection: 'along',
    })
    const grow = kind === 'rotary_rough' ? STOCK_TO_LEAVE : 0
    assertNoGouge(
      `${kind} along`, generate(project, operation).moves, stock,
      { radius: TOOL_RADIUS, type: 'flat' }, hexSolid(stock, grow), MIN_HEIGHT,
    )
  }
})

check('a square blank in around mode keeps clear of the Hex', () => {
  const { project, turnId } = boltFixture({ shape: 'square' })
  const stock = project.stock as BarStock
  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    const operation = rotaryOperation(project, [turnId], kind, {
      toolRef: 'flat', rotaryPassDirection: 'around',
    })
    const grow = kind === 'rotary_rough' ? STOCK_TO_LEAVE : 0
    assertNoGouge(
      `${kind} square`, generate(project, operation).moves, stock,
      { radius: TOOL_RADIUS, type: 'flat' }, hexSolid(stock, grow), MIN_HEIGHT,
    )
  }
})

check('the neighbours are sampled before the retained stubs, not as wall triangles', () => {
  const { project, turnId, hexId } = boltFixture()
  const stock = project.stock as BarStock
  const [turn, hex] = resolveFeatureInstances(project, [turnId, hexId])
  const targetMesh = resolveFinishModelSurface(project, [turn])
  assert.ok(targetMesh, 'the target surface resolves')
  const neighbourMesh = resolveRotaryNeighbourMesh(project, [hex])
  assert.ok(neighbourMesh, 'the neighbour mesh resolves')
  const composed = rotarySampledMesh(targetMesh.mesh, [neighbourMesh], stock, project.meta.units, {
    alongStart: TURN_START, alongEnd: TURN_START + TURN_LENGTH, passDirection: 'around', stockToLeave: 0,
  })
  const targetTriangles = targetMesh.mesh.index.length / 3
  const neighbourTriangles = neighbourMesh.index.length / 3
  // The wall boundary must start **after** the neighbours: the sampler reads
  // every triangle from it on as retained stock, so a neighbour behind it is a
  // surface to follow, and one in front of it is a wall a pass is lifted off.
  assert.ok(composed.retainedTriangleStart !== undefined, 'the retained stubs are marked')
  assert.equal(
    composed.retainedTriangleStart, targetTriangles + neighbourTriangles,
    `the wall boundary starts after ${composed.retainedTriangleStart} triangles; the target alone is `
      + `${targetTriangles} and the neighbour ${neighbourTriangles}`,
  )
  assert.ok(
    composed.index.length / 3 > composed.retainedTriangleStart,
    'the retained stubs still follow the models',
  )
  // And the same composition drives real output: over the Hex's band the
  // finish follows the model surface, so its lowest cutting tip there is the
  // Hex's apothem plus at most one height-map cell, never the retained bar.
  const pivot = barPivotZ(stock)
  const result = generate(project, rotaryOperation(project, [turnId], 'rotary_finish', {
    toolRef: 'flat', rotaryPassDirection: 'around',
  }))
  let lowest = Number.POSITIVE_INFINITY
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    for (const point of [move.from, move.to]) {
      const along = stock.axis === 'x' ? point.x : point.y
      if (along < HEX_START || along > HEX_END) continue
      lowest = Math.min(lowest, point.z - pivot)
    }
  }
  const ceiling = HEX_ACROSS_FLATS / 2 + 1
  assert.ok(
    lowest <= ceiling,
    `the head band's lowest cutting tip is ${lowest.toFixed(3)} mm from the pivot; above ${ceiling.toFixed(1)} means `
      + 'the neighbour was read as retained wall and the pass was lifted off it',
  )
})

check('a #1096 include region over the Hex does not uncover the Hex', () => {
  const { project, turnId } = boltFixture()
  const stock = project.stock as BarStock
  // One sheet rectangle over the Hex's whole band, one circumference wide:
  // the region *permits* the cut there and never removes the neighbour.
  const sheetWidth = Math.PI * stock.thickness
  const region: SketchFeature = {
    id: 'region',
    name: 'Region',
    kind: 'rect',
    operation: 'region',
    authoringFace: 'around',
    folderId: null,
    sketch: {
      profile: rectProfile(HEX_START, barCentre(stock), HEX_LENGTH, sheetWidth),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    z_top: stock.thickness,
    z_bottom: 0,
    visible: true,
    locked: false,
    regionMaskMode: 'include',
  }
  const withRegion = projectWithFeatures(project, [...project.features, region])
  const operation = rotaryOperation(withRegion, [turnId, 'region'], 'rotary_finish', {
    toolRef: 'flat', rotaryPassDirection: 'around',
  })
  const result = generate(withRegion, operation)
  assertNoGouge(
    'region finish', result.moves, stock,
    { radius: TOOL_RADIUS, type: 'flat' }, hexSolid(stock, 0), MIN_HEIGHT,
  )
  // The region itself is applied to the target: nothing cuts outside the band.
  for (const move of result.moves) {
    if (move.kind === 'rapid') continue
    for (const point of [move.from, move.to]) {
      const along = stock.axis === 'x' ? point.x : point.y
      assert.ok(
        along >= HEX_START - 1e-6 && along <= HEX_END + 1e-6,
        `the region limits the target's cut, found a cut at along ${along.toFixed(3)}`,
      )
    }
  }
})

check('the shank band helices while the head band falls back to rings', () => {
  const { project, turnId } = boltFixture()
  const stock = project.stock as BarStock
  const operation = rotaryOperation(project, [turnId], 'rotary_rough', {
    toolRef: 'flat', rotaryPassDirection: 'around',
  })
  const result = generate(project, operation)
  const alongOf = (point: { x: number; y: number }) => (stock.axis === 'x' ? point.x : point.y)
  // What `buildContinuousHelix` emits: consecutive samples merged into one cut
  // move that advances along the bar while turning through whole turns, so one
  // move can carry well over 360 degrees of A. A ring turns A at one along
  // position, an along pass advances at one angle, and a link is one short
  // diagonal: none of them can carry a full turn *and* an advance, so this
  // signature identifies the builder's own output rather than inferring a
  // helix from "A and along both changed".
  const helixMoves = result.moves.filter((move) => move.kind === 'cut'
    && Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) >= 360
    && Math.abs(alongOf(move.to) - alongOf(move.from)) > 1e-9)
  // The rough has two layers on the shank; each is one continuous helix.
  assert.equal(helixMoves.length, 2, `the shank is cut by one continuous helix per layer, found ${helixMoves.length}`)
  for (const move of helixMoves) {
    const low = Math.min(alongOf(move.from), alongOf(move.to))
    const high = Math.max(alongOf(move.from), alongOf(move.to))
    assert.ok(
      low > HEX_END,
      `a helix starts at along ${low.toFixed(3)}, inside the head band (the band ends at ${HEX_END}); the head `
        + 'must fall back to rings, not be helixed through',
    )
    assert.ok(high > low, 'the helix advances along the bar')
  }
  // The head band falls back to **rings**: cut moves that turn A at one along
  // position inside the band, every one of them at or above the Hex's surface
  // (its apothem plus the rough's stock to leave), never at the Turn below it.
  const headRings = result.moves.filter((move) => move.kind === 'cut'
    && Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) > 1e-9
    && Math.abs(alongOf(move.to) - alongOf(move.from)) <= 1e-9
    && alongOf(move.from) >= HEX_START && alongOf(move.from) <= HEX_END)
  // Measured on this fixture: 415 ring moves cut the head band (441 before the
  // #1155 rn-c correction widened the conservative read to a whole cell:
  // `runRotaryAngleJob` now lifts a sample near the Hex's far face to the Hex,
  // and the extra height turns 26 of the head band's ring samples into air the
  // layer skips). What this asserts is the split, not the count: the head band
  // is cut by rings, never helixed through.
  assert.equal(headRings.length, 415, `the head band is cut by rings, found ${headRings.length}`)
  const pivot = barPivotZ(stock)
  const headFloor = HEX_ACROSS_FLATS / 2 + STOCK_TO_LEAVE - 1e-6
  for (const ring of headRings) {
    const tip = Math.min(ring.from.z - pivot, ring.to.z - pivot)
    assert.ok(
      tip >= headFloor,
      `a head-band ring cuts at tip radius ${tip.toFixed(3)}, below the Hex's apothem plus the stock to leave `
        + `(${headFloor.toFixed(3)}); the ring is following the Turn instead of the neighbour`,
    )
  }
  // And the helix body itself stays clear of the Hex, in the along direction as
  // well as radially: the shank moves pass the head band one cutter radius away.
  assertNoGouge(
    'helix moves', helixMoves, stock, { radius: TOOL_RADIUS, type: 'flat' },
    hexSolid(stock, STOCK_TO_LEAVE), MIN_HEIGHT,
  )
})

check('a neighbour that pokes out of the bar does not warn on this operation', () => {
  // The Hex moved 3 mm across: its far side leaves the blank (so the geometric
  // outside-bar test would fire on the combined mesh) while its near side still
  // stands over the Turn, so it must still be sampled as material.
  const offset = 3
  const { project, turnId } = boltFixture({ hexAcrossOffset: offset })
  const stock = project.stock as BarStock
  const pivot = barPivotZ(stock)
  // The near side of the moved Hex still stands over the Turn, so some angles
  // must still be lifted to the Hex's own surface: that is what proves the
  // neighbour stayed in the sampled mesh, and it drops to the Turn's radius (5)
  // the moment the operation samples its target alone.
  let highest = Number.NEGATIVE_INFINITY
  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    const result = generate(project, rotaryOperation(project, [turnId], kind, {
      toolRef: 'flat', rotaryPassDirection: 'around',
    }))
    assert.ok(
      result.warnings.every((warning) => warning.code !== 'rotaryModelOutsideBar'),
      `${kind}: the neighbour's outside-bar geometry must not warn for the target's operation`,
    )
    for (const move of result.moves) {
      if (move.kind !== 'cut') continue
      for (const point of [move.from, move.to]) {
        const along = stock.axis === 'x' ? point.x : point.y
        if (along < HEX_START || along > HEX_END) continue
        highest = Math.max(highest, point.z - pivot)
      }
    }
  }
  assert.ok(
    highest >= HEX_ACROSS_FLATS / 2 - 0.7,
    `the head band's highest cutting tip is ${highest.toFixed(3)} mm from the pivot; below the Hex's apothem means `
      + 'the neighbour that pokes out of the bar was dropped from the sampled mesh',
  )
})

check('a model outside the target\u2019s along range changes nothing', () => {
  const { project, turnId } = boltFixture()
  const operation = rotaryOperation(project, [turnId], 'rotary_finish', {
    toolRef: 'flat', rotaryPassDirection: 'around',
  })
  const withNeighbour = generate(project, operation).moves
  // Each fixture mints its own feature ids, so the no-neighbour control builds
  // its own operation against its own Turn.
  const alone = boltFixture({ neighbour: false })
  const aloneMoves = generate(alone.project, rotaryOperation(alone.project, [alone.turnId], 'rotary_finish', {
    toolRef: 'flat', rotaryPassDirection: 'around',
  })).moves
  assert.notEqual(
    movesDigest(withNeighbour), movesDigest(aloneMoves),
    'an overlapping neighbour must move the output (otherwise this control proves nothing)',
  )
  // The overlapping neighbour must move the output, and this pins the run it
  // produces. The count is 6798 since the #1155 rn-c correction read the height
  // map a whole cell past each sample (the fix for a neighbour's end face that
  // lands in a cell whose centre reads the target): the tips beside the Hex's
  // far face are lifted to the Hex, which both re-splits the rings there and
  // emits a few more of them. The no-neighbour control below is unchanged.
  assert.equal(withNeighbour.length, 6798, 'the overlapping neighbour moves the output: the measured bolt run')
  // Now move the Hex clear of the Turn's cut range: the retained bar stubs
  // already stand there, so the operation must be byte-identical to the run
  // with no neighbour at all.
  const away: Project = {
    ...project,
    features: project.features.map((feature) => (feature.name === 'Hex'
      ? { ...feature, transform: { ...feature.transform, e: feature.transform.e + BAR_LENGTH } }
      : feature)),
  }
  const clear = generate(away, operation).moves
  assert.equal(
    movesDigest(clear), movesDigest(aloneMoves),
    'a model outside the target\u2019s along range was not culled',
  )
})

// ── the Hex-op drift (#1155 acceptance 2) ────────────────────────────────

/**
 * The two samplings the Hex-target operation gets (#1155 acceptance 2): the
 * target alone -- what `428a285e` sampled, and what this branch still samples
 * when no neighbour reaches the range -- and the target with the Turn joined
 * through `rotarySampledMesh`, which is what this branch is.
 *
 * The Turn is a Ø10 cylinder inside the Hex's 15 mm across-flats prism over the
 * whole band, so the union the operation must respect is the Hex. The extra mesh
 * can still move a sample -- the per-angle conservative lift, mostly, plus the
 * wall-adjacent padding beside the retained stubs -- and the checks below pin
 * the direction it may move in: up, never down.
 */
function hexTargetSampling(
  project: Project,
  hexId: string,
  turnId: string,
  withNeighbour: boolean,
  passDirection: 'around' | 'along',
) {
  const stock = project.stock as BarStock
  const [hex] = resolveFeatureInstances(project, [hexId])
  const [turn] = resolveFeatureInstances(project, [turnId])
  assert.ok(hex && turn, 'the Hex and the Turn resolve')
  const surface = resolveFinishModelSurface(project, [hex])
  assert.ok(surface, 'the Hex surface resolves')
  const neighbour = resolveRotaryNeighbourMesh(project, [turn])
  assert.ok(neighbour, 'the Turn neighbour mesh resolves')
  const tool = normalizeToolForProject(project.tools.find((record) => record.id === 'flat')!, project)
  const range = rotaryAlongRange(stock, project.clamps, alongExtremes(surface.mesh.positions, stock), tool, {
    chuckEnd: 0, tailEnd: 0,
  })
  assert.ok(range, 'the Hex band is inside the bar')
  const stepover = STEPOVER_RATIO * tool.diameter
  const stockToLeave: number = STOCK_TO_LEAVE
  const params: RotaryFinishParams = {
    stepover,
    stockToLeave,
    sampleSpacing: tool.radius / 4,
    requestedCellSize: Math.min(tool.radius / 3, stepover * 0.5),
    alongStart: range.start,
    alongEnd: range.end,
    safeRadius: barPivotZ(stock) + barMaxRadius(stock) + tool.diameter,
    passDirection,
    // The adapter's own shape: the neighbour is a separate argument, never part
    // of the target surface, and `rotaryConservativeSampling` reads it.
    ...(withNeighbour ? { neighbours: [neighbour] } : {}),
  }
  const mesh = rotarySampledMesh(surface.mesh, params.neighbours, stock, tool.units, params)
  return {
    stock,
    params,
    mesh,
    range,
    // The sampler's own stock-to-leave enlargement, exactly as the generator
    // builds it.
    samplingTool: stockToLeave === 0 ? tool : {
      ...tool,
      radius: tool.radius + stockToLeave,
      diameter: tool.diameter + 2 * stockToLeave,
    },
  }
}

check('a neighbour only raises what the target samples, in either pass direction', () => {
  const { project, turnId, hexId } = boltFixture()
  for (const passDirection of ['around', 'along'] as const) {
    const alone = hexTargetSampling(project, hexId, turnId, false, passDirection)
    const joined = hexTargetSampling(project, hexId, turnId, true, passDirection)
    assert.notEqual(
      joined.mesh.positions.length, alone.mesh.positions.length,
      `${passDirection}: the Turn really is joined into the sampled mesh`,
    )
    const along: number[] = []
    for (let i = 0; i <= 120; i++) {
      along.push(alone.range.start + (alone.range.end - alone.range.start) * (i / 120))
    }
    const angles: number[] = []
    for (let k = 0; k < 24; k++) angles.push(k * 15)
    const sample = (setup: ReturnType<typeof hexTargetSampling>) => sampleRotaryModel(
      setup.mesh, setup.stock, setup.samplingTool,
      {
        anglesDeg: angles,
        along,
        requestedCellSize: setup.params.requestedCellSize,
        // The generator's own decision, not a flag this check sets itself: in
        // along mode the conservative read is the neighbour's doing.
        ...(rotaryConservativeSampling(setup.params) ? { conservativeCellBounds: true } : {}),
        ...(setup.mesh.retainedTriangleStart !== undefined
          ? { wallTriangleStart: setup.mesh.retainedTriangleStart }
          : {}),
      },
      [],
    )
    const targetOnly = sample(alone)
    const withNeighbour = sample(joined)
    const cell = alone.params.requestedCellSize
    let valueRises = 0
    let valueDrops = 0
    let maxRise = 0
    let maxDrop = 0
    let lowerLifts = 0
    let liftDelta = 0
    for (let k = 0; k < angles.length; k++) {
      for (let i = 0; i < along.length; i++) {
        const a = targetOnly.tipRadius[k][i]
        const b = withNeighbour.tipRadius[k][i]
        if (b > a) {
          valueRises += 1
          maxRise = Math.max(maxRise, b - a)
        } else if (b < a) {
          valueDrops += 1
          maxDrop = Math.max(maxDrop, a - b)
        }
      }
      if (withNeighbour.lifts[k] < targetOnly.lifts[k]) lowerLifts += 1
      liftDelta = Math.max(liftDelta, withNeighbour.lifts[k] - targetOnly.lifts[k])
    }
    // The safety property, pointwise over the whole sampled grid: a neighbour may
    // only raise a sample, never lower it. A lower sample is a tip the target-only
    // run did not take off, which is exactly the direction a gouge would come from.
    assert.equal(
      valueDrops, 0,
      `${passDirection}: ${valueDrops} sampled height(s) came out lower with the neighbour `
        + `(by up to ${maxDrop.toFixed(6)} mm)`,
    )
    // ... and the margins that do move can only move up, by at most one cell.
    assert.equal(
      lowerLifts, 0,
      `${passDirection}: ${lowerLifts} angle(s) sampled a smaller conservative margin with the `
        + 'neighbour than without it',
    )
    assert.ok(
      liftDelta <= cell,
      `${passDirection}: the lift moved ${liftDelta.toFixed(6)} mm, more than one `
        + `${cell.toFixed(6)} mm height-map cell`,
    )
    if (passDirection === 'along') {
      // The target-only along run reads cell centres (`lift` 0); a neighbour must
      // turn the conservative read on, which is the #1155 correction.
      assert.ok(
        Math.max(...withNeighbour.lifts) > Math.max(...targetOnly.lifts),
        'an along operation with a neighbour did not sample conservatively',
      )
    }
    console.log(
      `     ${passDirection}: ${angles.length} angles x ${along.length} along positions, `
        + `${valueRises} sample(s) raised (by up to ${maxRise.toFixed(6)} mm), none lowered; `
        + `lift +${liftDelta.toFixed(6)} mm at most (cell ${cell.toFixed(6)} mm)`,
    )
  }
})

/** `moves` with every point of every move lowered by `drop`, as a fresh copy. */
function lowered(moves: readonly ToolpathMove[], drop: number, every = 1): ToolpathMove[] {
  return moves.map((move, i) => (i % every === 0
    ? { ...move, from: { ...move.from, z: move.from.z - drop }, to: { ...move.to, z: move.to.z - drop } }
    : move))
}

check('the Hex operation never cuts deeper with the Turn as its neighbour', () => {
  const { project, turnId, hexId } = boltFixture()
  // The no-neighbour control is the same project with the Turn removed: for the
  // Hex's own operation that is exactly what `428a285e` sampled.
  const hexOnly: Project = {
    ...project,
    features: project.features.filter((feature) => feature.id !== turnId),
  }
  const stock = project.stock as BarStock
  for (const toolRef of ['flat', 'ball'] as const) {
    const tool = normalizeToolForProject(project.tools.find((record) => record.id === toolRef)!, project)
    const cell = Math.min(tool.radius / 3, (STEPOVER_RATIO * tool.diameter) * 0.5)
    // One stepover is the widest gap between two baseline passes over the same
    // angle (ring to ring, or one turn of a helix).
    const stepover = STEPOVER_RATIO * tool.diameter
    const options = {
      alongTolerance: 1e-6, maxAlongGap: stepover + 1e-6, depthTolerance: cell, airRadius: barMaxRadius(stock),
    }
    for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
      const joined = generate(project, rotaryOperation(project, [hexId], kind, { toolRef, rotaryPassDirection: 'around' })).moves
      const alone = generate(hexOnly, rotaryOperation(hexOnly, [hexId], kind, { toolRef, rotaryPassDirection: 'around' })).moves
      // Every point of every move, against the deepest baseline cut through the
      // same along position and angle, interpolated along the baseline's own
      // segments (`compareRotaryDepth`). A point no baseline segment passes
      // through is never skipped: it must be in the air.
      const result = compareRotaryDepth(alone, joined, stock, options)
      assert.equal(result.points, 2 * joined.length, `${kind} ${toolRef}: every point of every move is compared`)
      assert.equal(
        result.uncoveredInMaterial, 0,
        `${kind} ${toolRef}: ${result.uncoveredInMaterial} emitted point(s) in material have no baseline cut `
          + `through their along/angle (${result.where})`,
      )
      assert.equal(
        result.tooDeep, 0,
        `${kind} ${toolRef}: ${result.tooDeep} emitted point(s) cut more than one ${cell.toFixed(6)} mm cell `
          + `deeper than the baseline run, the deepest by ${result.deepest.toFixed(6)} mm at ${result.where}`,
      )
      // The comparison must be able to fail: the same run with every third move
      // lowered by just over one cell is caught at every lowered point that is in
      // material, and one lowered by 100 mm at every lowered point.
      for (const [drop, label] of [[cell * 1.01 + 1e-9, 'just over one cell'], [100, '100 mm']] as const) {
        const mutated = compareRotaryDepth(alone, lowered(joined, drop, 3), stock, options)
        assert.ok(
          mutated.tooDeep + mutated.uncoveredInMaterial > 0,
          `${kind} ${toolRef}: lowering every third move by ${label} went unnoticed`,
        )
      }
      console.log(
        `     ${kind} ${toolRef}: ${result.points} point(s) of ${joined.length} moves vs ${alone.length}; `
          + `${result.covered} on a baseline cut, ${result.bracketed} between two, ${result.uncoveredInAir} in the air, none uncovered in material; `
          + `deepest ${result.deepest.toFixed(6)} mm (positive would be deeper than the baseline)`,
      )
    }
  }
})

check('the target-only surface and the neighbour mesh never share a cache entry', () => {
  const { project, turnId, hexId } = boltFixture()
  const [turn, hex] = resolveFeatureInstances(project, [turnId, hexId])
  const targetAlone = resolveFinishModelSurface(project, [turn])
  assert.ok(targetAlone, 'the target surface resolves')
  const neighbour = resolveRotaryNeighbourMesh(project, [hex])
  assert.ok(neighbour, 'the neighbour mesh resolves')
  // The neighbour mesh holds the Hex alone, and resolving it must not leave a
  // combined mesh behind for the target's next call.
  const hexGeometry = resolveFinishModelSurface(project, [hex])
  assert.ok(hexGeometry, 'the Hex as a target resolves')
  assert.equal(neighbour.positions.length, hexGeometry.mesh.positions.length)
  assert.equal(neighbour.index.length, hexGeometry.mesh.index.length)
  const targetAgain = resolveFinishModelSurface(project, [turn])
  assert.ok(targetAgain, 'the target surface still resolves')
  assert.equal(targetAgain.mesh.positions.length, targetAlone.mesh.positions.length)
  assert.equal(targetAgain.mesh.index.length, targetAlone.mesh.index.length)
  assert.notEqual(targetAgain.mesh.positions.length, neighbour.positions.length)
  // A joined neighbour set is cached and stable across calls.
  const joined = resolveRotaryNeighbourMesh(project, resolveFeatureInstances(project, [turnId, hexId]))
  assert.ok(joined, 'two neighbours join')
  assert.equal(
    joined.positions.length,
    targetAgain.mesh.positions.length + neighbour.positions.length,
    'the neighbour join never mixes the target in',
  )
  assert.notEqual(joined.positions.length, targetAgain.mesh.positions.length)
})

check('a Turn rough with a neighbour stays within 2.5x of the same op without one', () => {
  const withNeighbour = boltFixture()
  const alone = boltFixture({ neighbour: false })
  const neighbourOp = rotaryOperation(withNeighbour.project, [withNeighbour.turnId], 'rotary_rough', {
    toolRef: 'flat', rotaryPassDirection: 'around',
  })
  const aloneOp = rotaryOperation(alone.project, [alone.turnId], 'rotary_rough', {
    toolRef: 'flat', rotaryPassDirection: 'around',
  })
  // Warm both paths once, outside the measured region.
  const neighbourRun = () => { generate(withNeighbour.project, neighbourOp) }
  const aloneRun = () => { generate(alone.project, aloneOp) }
  neighbourRun()
  aloneRun()
  // Measured on this fixture (Linux, one process, 5 subject reps / 3 reference
  // reps through `cpuRatio`): subject ~330 ms, reference ~155 ms, ratio ~2.1x
  // -- the neighbour mesh roughly doubles the height-map raster. The approved
  // cap is 2.5x, which is where the threshold sits; the numbers are printed so
  // the next reader can re-derive it.
  const ratio = cpuRatio(
    { run: neighbourRun, setup: () => neighbourRun },
    { run: aloneRun, setup: () => aloneRun },
  )
  console.log(
    `     cpuRatio ${ratio.ratio.toFixed(2)}x (${ratio.subjectMs.toFixed(1)} ms with the neighbour, `
      + `${ratio.referenceMs.toFixed(1)} ms without)`,
  )
  assert.ok(
    ratio.ratio <= 2.5,
    `neighbour rough is ${ratio.ratio.toFixed(2)}x the same op without it `
      + `(${ratio.subjectMs.toFixed(1)} ms vs ${ratio.referenceMs.toFixed(1)} ms)`,
  )
})

if (failures > 0) {
  console.error(`rotaryNeighbours.test.ts: ${failures} check(s) failed`)
  process.exitCode = 1
} else {
  console.log('rotaryNeighbours.test.ts: all checks passed')
}
