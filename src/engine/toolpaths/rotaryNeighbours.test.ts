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
 *      uses `mesh` alone) -> every gouge case sees the cutter 3+ mm inside the
 *      Hex, and the shank helix runs through the head band;
 *   2. append the neighbours **after** the retained stubs (so the wall
 *      boundary covers their triangles) -> the sampled mesh's wall boundary no
 *      longer starts after the neighbour;
 *   3. drop the neighbours when the operation carries a #1096 region ->
 *      the region test cuts the Hex away;
 *   4. run the outside-bar check on the combined mesh -> the neighbour that
 *      pokes out of the bar warns on the Turn's operation;
 *   5. drop the along-overlap cull -> the model outside the target's range
 *      moves the operation's output.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryNeighbours.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpuRatio } from '../../test/cpuRatio'
import { defaultTool, newProject, rectProfile, roundStock } from '../../types/project'
import type { Operation, Project, SketchFeature } from '../../types/project'
import { barCentre, barPivotZ, squareStock } from '../../types/barStock'
import type { BarStock } from '../../types/project'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { resolveFeatureInstances } from '../../store/helpers/resolveFeatures'
import { planRotarySolid } from '../../store/helpers/rotarySolids'
import { projectWithFeatures } from '../../test/projectFixtures'
import type { SelectionState } from '../../store/types'
import { minRenderHeight } from '../csg'
import { resolveFinishModelSurface, resolveRotaryNeighbourMesh } from './finishModelSurface'
import { computeOperationToolpath } from './generateOperation'
import { rotarySampledMesh } from './rotaryModel'
import type { ToolpathMove, ToolpathResult } from './types'

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
  return hex.apothem - largest
}

/** One point of the cutter body, relative to the tip: lateral offset and rise up the axis. */
interface BodyPoint {
  readonly lateral: number
  readonly rise: number
}

/**
 * The real cutter's body, sampled over the solid: a flat endmill is a cylinder
 * of the tool radius standing on the tip disc, a ball endmill a sphere whose
 * lowest point is the tip (its shank never reaches wider than the ball).
 */
function cutterBody(radius: number, type: 'flat' | 'ball'): BodyPoint[] {
  const points: BodyPoint[] = []
  if (type === 'ball') {
    for (let latitude = 0; latitude <= 4; latitude++) {
      const phi = (latitude / 4) * Math.PI / 2
      for (let longitude = 0; longitude < 24; longitude++) {
        const theta = (longitude / 24) * Math.PI * 2
        points.push({ lateral: radius * Math.sin(phi) * Math.cos(theta), rise: radius * (1 - Math.cos(phi)) })
      }
    }
    return points
  }
  for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
    for (let longitude = 0; longitude < 12; longitude++) {
      const theta = (longitude / 12) * Math.PI * 2
      points.push({ lateral: radius * fraction * Math.cos(theta), rise: 0 })
      if (fraction === 1) points.push({ lateral: radius * Math.cos(theta), rise: radius })
    }
  }
  return points
}

interface GougeReport {
  /** Deepest penetration into the Hex prism, mm; negative means wholly outside. */
  readonly depth: number
  /** Where the deepest body point was, for a failing message. */
  readonly where: string
}

/**
 * Sweep the real cutter body along `moves` and report the deepest penetration
 * into the Hex solid.
 *
 * A rotary move's motion is straight in `(along, A, tip radius)`, not in XYZ
 * (a ring's chord would cut through the bar), so the pose is interpolated in
 * those three coordinates and rebuilt in the stock frame. `A` rotates the
 * **model** into the tool's frame -- `centre + across cos - up sin` across and
 * `pivot + across sin + up cos` up, the sampler's own `turnModelInto`
 * arithmetic -- so the cutter body is mapped back by the inverse.
 *
 * The step is at most a quarter tool radius of tool-centre travel, so no gap
 * between two emitted points can hide an overlap.
 */
function deepestGouge(
  moves: readonly ToolpathMove[],
  stock: BarStock,
  tool: { readonly radius: number; readonly type: 'flat' | 'ball' },
  hex: HexSolid,
): GougeReport {
  const centre = barCentre(stock)
  const pivot = barPivotZ(stock)
  const body = cutterBody(tool.radius, tool.type)
  const step = tool.radius / 4
  let depth = Number.NEGATIVE_INFINITY
  let where = 'nowhere'
  for (let index = 0; index < moves.length; index++) {
    const move = moves[index]
    if (move.kind === 'rapid') continue
    const alongFrom = stock.axis === 'x' ? move.from.x : move.from.y
    const alongTo = stock.axis === 'x' ? move.to.x : move.to.y
    const angleFrom = (move.from.a ?? 0) * Math.PI / 180
    const angleTo = (move.to.a ?? 0) * Math.PI / 180
    const radiusFrom = move.from.z - pivot
    const radiusTo = move.to.z - pivot
    const arc = Math.abs(angleTo - angleFrom) * Math.max(Math.abs(radiusFrom), Math.abs(radiusTo))
    const steps = Math.max(1, Math.ceil(Math.hypot(alongTo - alongFrom, arc, radiusTo - radiusFrom) / step))
    for (let pose = 0; pose <= steps; pose++) {
      const t = pose / steps
      const along = alongFrom + (alongTo - alongFrom) * t
      const angle = angleFrom + (angleTo - angleFrom) * t
      const radius = radiusFrom + (radiusTo - radiusFrom) * t
      const cos = Math.cos(angle)
      const sin = Math.sin(angle)
      for (const point of body) {
        // The stock frame is the tool frame rotated by `-A`: the tip's own
        // position is `(r sin A, r cos A)` off the bar's centreline.
        const across = centre + cos * point.lateral + sin * (radius + point.rise)
        const up = pivot - sin * point.lateral + cos * (radius + point.rise)
        const candidate = hexDepth(along, across, up, hex)
        if (candidate > depth) {
          depth = candidate
          where = `move ${index} (${move.kind}) at along ${along.toFixed(3)}, A ${(angle * 180 / Math.PI).toFixed(1)}°, `
            + `tip radius ${radius.toFixed(3)}, body offset (${point.lateral.toFixed(3)}, ${point.rise.toFixed(3)})`
        }
      }
    }
  }
  return { depth, where }
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
/**
 * The along pass's own tolerance: the along sampler has no conservative cell
 * lift (`conservativeCellBounds` is an around-mode option), so a cornered
 * neighbour can be approached to within one height-map cell. Measured on the
 * **base** tree at 428a285e with the Hex joined to the target mesh instead of
 * being a neighbour: the same 0.127 mm, so this is the along sampler's
 * discretization, not the neighbour rule. Around mode holds the exact
 * `minRenderHeight` bound.
 */
const ALONG_CELL_TOLERANCE = 0.2

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
      { radius: TOOL_RADIUS, type: 'flat' }, hexSolid(stock, grow), ALONG_CELL_TOLERANCE,
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
  // What `buildContinuousHelix` emits: consecutive cut moves that each advance
  // the along position while turning A -- a helix on a cylinder merges into one
  // move that turns whole revolutions, and a band the walk splits stays several
  // shorter runs. A ring changes A alone, an along pass changes the along
  // position alone, and a link changes both in a single move.
  const helix: ToolpathMove[] = []
  for (let i = 0; i < result.moves.length;) {
    let j = i
    let turn = 0
    while (j < result.moves.length) {
      const move = result.moves[j]
      const turned = Math.abs((move.to.a ?? 0) - (move.from.a ?? 0))
      const advanced = Math.abs(alongOf(move.to) - alongOf(move.from))
      if (move.kind !== 'cut' || !(turned > 1e-9) || !(advanced > 1e-9)) break
      turn += turned
      j += 1
    }
    if (j - i >= 2 || (j - i === 1 && turn >= 360)) helix.push(...result.moves.slice(i, j))
    i = j > i ? j : i + 1
  }
  assert.ok(helix.length > 0, 'the band is cut by continuous helix pieces')
  const pivot = barPivotZ(stock)
  const shankHelix = helix.filter((move) => Math.min(alongOf(move.from), alongOf(move.to)) > HEX_END)
  assert.ok(shankHelix.length > 0, 'the shank band is cut by a continuous helix')
  // A layer **above** the Hex is a whole ring at every angle, so it may helix
  // across the head band -- but then it must run above the Hex, never into it.
  // A layer below the Hex's top has a ring that is not `full` over the head,
  // and the walk keeps its rings there instead of helixing through them.
  for (const move of helix) {
    const low = Math.min(alongOf(move.from), alongOf(move.to))
    if (low > HEX_END) continue
    const tip = Math.min(move.from.z, move.to.z) - pivot
    assert.ok(
      tip >= HEX_ACROSS_FLATS / 2 + STOCK_TO_LEAVE - 1e-6,
      `a helix crosses the head band at tip radius ${tip.toFixed(3)}; below the Hex's apothem means it is `
        + 'helixing through material the Hex stands in',
    )
  }
  assertNoGouge(
    'helix moves', helix, stock, { radius: TOOL_RADIUS, type: 'flat' }, hexSolid(stock, STOCK_TO_LEAVE), MIN_HEIGHT,
  )
  // The head band is cut as rings: cut moves that change A and keep the along
  // position.
  const rings = result.moves.filter((move) => move.kind === 'cut'
    && Math.abs((move.to.a ?? 0) - (move.from.a ?? 0)) > 1e-9
    && Math.abs(alongOf(move.to) - alongOf(move.from)) <= 1e-9)
  assert.ok(rings.length > 0, 'the head band still emits rings')
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
  assert.equal(withNeighbour.length, 6658, 'the overlapping neighbour moves the output: the measured bolt run')
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
