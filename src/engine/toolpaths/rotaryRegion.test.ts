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
 * #1096: rotary rough and finish respect regions.
 *
 * A region is a closed sketch feature on the Around sheet, whose coordinates
 * are the bar unrolled: along is the bar's axis, across is
 * `zero + a * pi * thickness / 360`. The generators test each tool position
 * `(along, a)` against that mask, one sheet turn each way, so a region drawn
 * past an edge of the sheet means one continuous area of the bar.
 *
 * The region checks here are independent of `regions.ts` and of
 * `rotaryRegionContains`: the rectangle is evaluated in this file from the
 * stock's own centre and circumference. The no-region block is the byte
 * identity proof -- move hashes and the real postprocessor's program text,
 * captured from the base commit before the feature existed, with the header's
 * wall-clock date pinned to the capture day (the only non-deterministic byte).
 *
 * Mutations checked (each must fail here):
 *  - the mask ignored -> every "outside the region" assertion, and the
 *    region-free control showing cuts outside it;
 *  - the seam not wrapped -> the left-edge region emits no cut at all, and the
 *    A-range assertion fails;
 *  - a square turn taken below the travel envelope outside the region -> the
 *    square block's turn-height assertion;
 *  - a region-clipped finish ring treated as split again -> the partial-angle
 *    block's one-plunge assertion (22 plunges, one per ring, on that fixture).
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryRegion.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { barCentre, barMaxRadius, barPivotZ, isBarStock, squareStock } from '../../types/barStock'
import { isRoundStock, polygonProfile, rectProfile, roundStock } from '../../types/project'
import type { BarStock, Operation, Project, SketchFeature, SketchProfile } from '../../types/project'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import { projectWithFeatures } from '../../test/projectFixtures'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { BUNDLED_DEFINITIONS } from '../gcode/definitions'
import { runPostProcessor } from '../gcode/postprocessor'
import { validateMachineDefinition } from '../gcode/types'
import { computeOperationToolpath } from './generateOperation'
import { normalizeToolForProject, toClipperPath } from './geometry'
import { buildMaskFromClipperPaths, buildRegionMask } from './regions'
import { generateRotaryFinish, generateRotaryRough } from './rotaryModel'
import { rotaryTravelZ, squareRotaryTouchRadius } from './squareRotaryStock'
import type { RotaryModelMesh, RotaryRegionMask } from './rotaryModel'
import type { NormalizedTool, ToolpathMove, ToolpathResult } from './types'

// ── independent region geometry ───────────────────────────────────────────

/** A rectangle on the Around sheet: along the bar, and across it in mm. */
interface SheetRect {
  readonly alongMin: number
  readonly alongMax: number
  readonly acrossMin: number
  readonly acrossMax: number
}

function acrossOf(stock: Parameters<typeof barCentre>[0], angleDeg: number): number {
  return barCentre(stock) + angleDeg * Math.PI * stock.thickness / 360
}

/**
 * Is a tool position inside the rectangle, on any sheet turn?
 *
 * The physical angle is the commanded A modulo one turn: since #1103 slice ca-c
 * an around pass carries A past 360 (it never reverses or rewinds), while the
 * region is a property of the bar's surface and so repeats every turn.
 */
function insideSheetRect(stock: Parameters<typeof barCentre>[0], rect: SheetRect, along: number, angle: number): boolean {
  if (along < rect.alongMin - 1e-9 || along > rect.alongMax + 1e-9) return false
  const circumference = Math.PI * stock.thickness
  const physical = ((angle % 360) + 360) % 360
  const across = acrossOf(stock, physical)
  for (let turn = -1; turn <= 1; turn++) {
    const shifted = across + turn * circumference
    if (shifted >= rect.acrossMin - 1e-9 && shifted <= rect.acrossMax + 1e-9) return true
  }
  return false
}

/** One Around-region sketch feature for a sheet rectangle. */
function regionFeature(stock: BarStock, id: string, rect: SheetRect, maskMode?: 'include' | 'exclude'): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    operation: 'region',
    authoringFace: 'around',
    folderId: null,
    sketch: {
      profile: rectProfile(rect.alongMin, rect.acrossMin, rect.alongMax - rect.alongMin, rect.acrossMax - rect.acrossMin),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    z_top: stock.thickness,
    z_bottom: 0,
    visible: true,
    locked: false,
    ...(maskMode === undefined ? {} : { regionMaskMode: maskMode }),
  }
}

/** One Around-region sketch feature from any closed profile. */
function profileRegionFeature(id: string, profile: SketchProfile, maskMode?: 'include' | 'exclude'): SketchFeature {
  return {
    id,
    name: id,
    kind: 'polygon',
    operation: 'region',
    authoringFace: 'around',
    folderId: null,
    sketch: {
      profile,
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    z_top: 0,
    z_bottom: 0,
    visible: true,
    locked: false,
    ...(maskMode === undefined ? {} : { regionMaskMode: maskMode }),
  }
}

/** The production mask for one or more sheet rectangles: `buildRegionMask`
 *  with the circumferential repeat the rotary adapter asks for. */
function productionMaskFor(stock: BarStock, rects: readonly SheetRect[], maskMode?: 'include' | 'exclude'): RotaryRegionMask {
  const mask = buildRegionMask(
    rects.map((rect, index) => regionFeature(stock, `region-${index}`, rect, maskMode)),
    {
      axis: stock.axis === 'x' ? 'y' : 'x',
      period: Math.PI * stock.thickness,
    },
  )
  assert.ok(mask, 'the production seam mask builds')
  return mask
}

/** The production mask for one sheet rectangle. */
function productionMask(stock: BarStock, rect: SheetRect, maskMode?: 'include' | 'exclude'): RotaryRegionMask {
  return productionMaskFor(stock, [rect], maskMode)
}

type SegmentTest = (from: { x: number; y: number }, to: { x: number; y: number }) => boolean

/** The mask's whole-segment test, asserted present (#1096). */
function segmentTest(mask: RotaryRegionMask | null): SegmentTest {
  assert.ok(mask, 'the segment-test mask builds')
  const segment = mask.containsSegment
  assert.ok(segment, 'the mask exposes its whole-segment test')
  return segment
}

// ── fixtures ──────────────────────────────────────────────────────────────

function alongOf(stock: { axis: 'x' | 'y' }, point: { x: number; y: number }): number {
  return stock.axis === 'x' ? point.x : point.y
}

/** The fixture with one closed Around region added to its feature list. */
function withRegion(project: Project, id: string, profile: SketchProfile, maskMode?: 'include' | 'exclude'): Project {
  const region: SketchFeature = {
    id,
    name: id,
    kind: 'rect',
    operation: 'region',
    authoringFace: 'around',
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    z_top: project.stock.thickness,
    z_bottom: 0,
    visible: true,
    locked: false,
    ...(maskMode === undefined ? {} : { regionMaskMode: maskMode }),
  }
  return projectWithFeatures(project, [...project.features, region])
}

/** The fixture's round bar relabelled to a square blank of the same box. */
function squareProject(kind: 'rotary_rough' | 'rotary_finish'): Project {
  const project = rotaryOperationFixture('x', kind)
  const stock = project.stock
  assert.ok(isRoundStock(stock), 'the fixture ships a round bar')
  const square = squareStock(stock.thickness, 30, 'x', { x: 0, y: 0 })
  const chuck = { ...defaultRoundWorkholding('chuck', square, 'mm'), id: 'chuck', name: 'Chuck', visible: true }
  return { ...project, stock: square, clamps: [chuck] }
}

function withTarget(operation: Operation, regionId: string, direction: 'along' | 'around'): Operation {
  return {
    ...operation,
    rotaryPassDirection: direction,
    target: { source: 'features', featureIds: ['model', regionId] },
  }
}

/** Moves that cut: everything but a rapid and everything already at travel height. */
function cuttingMoves(result: ToolpathResult, travelZ: number): ToolpathMove[] {
  return result.moves.filter((move) => move.kind !== 'rapid'
    && Math.min(move.from.z, move.to.z) < travelZ - 1e-9)
}

/** A ring-to-ring surface link: a cut at one angle that changes the along
 *  coordinate. A ring's own cut turns A at one along position. */
function ringLinks(result: ToolpathResult): ToolpathMove[] {
  return result.moves.filter((move) => move.kind === 'cut'
    && move.from.a !== undefined && move.to.a !== undefined
    && move.from.a === move.to.a
    && (move.from.x !== move.to.x || move.from.y !== move.to.y))
}

/** The number of around rings: the distinct along positions of the cuts that
 *  turn A, independent of how many pieces a region or the model gives each. */
function ringCount(result: ToolpathResult): number {
  const rings = new Set<number>()
  for (const move of result.moves) {
    if (move.kind === 'cut' && move.from.a !== undefined && move.from.a !== move.to.a) rings.add(move.from.x)
  }
  return rings.size
}

function barStockOf(project: Project): BarStock {
  assert.ok(isBarStock(project.stock), 'the fixture is a bar')
  return project.stock
}

function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

// ── the region limits both pass directions on both blank shapes ───────────

// The bar is Ø12 (circumference 37.7), zero line at across = 6. The rectangle
// is along 8..20 and across 5..7: a narrow band round the top of the bar.
const ROUND_REGION: SheetRect = { alongMin: 8, alongMax: 20, acrossMin: 5, acrossMax: 7 }
const ROUND_REGION_PROFILE = rectProfile(8, 5, 12, 2)

let outsideChecks = 0
let turnChecks = 0
for (const shape of ['round', 'square'] as const) {
  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    for (const direction of ['along', 'around'] as const) {
      const label = `${shape}/${kind}/${direction}`
      const base = shape === 'round' ? rotaryOperationFixture('x', kind) : squareProject(kind)
      const project = withRegion(base, 'region', ROUND_REGION_PROFILE)
      const operation = withTarget(project.operations[0], 'region', direction)
      assert.ok(isBarStock(project.stock), `${label}: the fixture is a bar`)
      const stock: BarStock = project.stock
      const travelZ = rotaryTravelZ(stock, 'mm')

      const result = computeOperationToolpath(project, operation)!.result
      const cuts = cuttingMoves(result, travelZ)
      assert.ok(cuts.length > 0, `${label}: the region still cuts inside itself`)

      // Every cutting tool centre is inside the region: the mask keeps the
      // whole cutter path inside it, not merely the first sample of a run.
      // #1177: each cut move is sampled every 0.5 mm of its length on the bar's
      // surface, not only at its two ends, so "the region is exercised" counts
      // the path the cut covers rather than how many endpoints the emitter
      // happened to keep. A ball reads the exact sphere drop now, so collinear
      // samples merge: the round along finish crosses the region in one 12 mm
      // move where the conservative read emitted 37 short ones.
      let innerCuts = 0
      const barRadius = barMaxRadius(stock)
      for (const move of cuts) {
        const fromAlong = alongOf(stock, move.from)
        const toAlong = alongOf(stock, move.to)
        const fromA = move.from.a ?? 0
        const toA = move.to.a ?? 0
        const length = Math.hypot(toAlong - fromAlong, (toA - fromA) * Math.PI / 180 * barRadius)
        const steps = Math.max(1, Math.ceil(length / 0.5))
        for (let step = 0; step <= steps; step++) {
          const f = step / steps
          const point = { along: fromAlong + (toAlong - fromAlong) * f, a: fromA + (toA - fromA) * f }
          assert.ok(insideSheetRect(stock, ROUND_REGION, point.along, point.a),
            `${label}: a cut at along ${point.along.toFixed(3)} A${point.a.toFixed(3)} `
            + 'is outside the region')
          innerCuts++
        }
      }
      assert.ok(innerCuts > 20, `${label}: the region is exercised (${innerCuts} checked cut points)`)
      outsideChecks++

      // Control: without the region the same operation cuts outside it, so the
      // assertions above are not vacuous.
      const free = computeOperationToolpath(base, { ...base.operations[0], rotaryPassDirection: direction })!.result
      const baseStock = barStockOf(base)
      const freeCuts = cuttingMoves(free, rotaryTravelZ(baseStock, 'mm'))
      const stray = freeCuts.some((move) => [move.from, move.to].some((point) =>
        !insideSheetRect(baseStock, ROUND_REGION, alongOf(baseStock, point), point.a ?? 0)))
      assert.ok(stray, `${label}: the region-free program cuts outside the region (the check is live)`)
      assert.notDeepEqual(cuts, freeCuts, `${label}: the region changes the emitted motion`)

      // A region splits every ring, so a square blank's ring-to-ring turn is
      // an A change whose midpoint is outside the region. That turn must be at
      // the travel height: the blank's corner envelope is above every cut, and
      // a turn taken lower drives the cutter body into a corner it never
      // machined.
      if (shape === 'square' && direction === 'around') {
        let turns = 0
        for (const move of result.moves) {
          if (move.from.a === undefined || move.to.a === undefined || move.from.a === move.to.a) continue
          if (alongOf(stock, move.from) !== alongOf(stock, move.to)) continue
          const midAngle = (move.from.a + move.to.a) / 2
          if (insideSheetRect(stock, ROUND_REGION, alongOf(stock, move.from), midAngle)) continue
          assert.ok(Math.min(move.from.z, move.to.z) >= travelZ - 1e-6,
            `${label}: a turn outside the region at A${midAngle.toFixed(2)} runs at `
            + `Z${Math.min(move.from.z, move.to.z).toFixed(4)}, below the travel height ${travelZ.toFixed(4)}`)
          turns++
        }
        assert.ok(turns > 0, `${label}: the region splits a ring, so a turn outside it is exercised`)
        turnChecks++
      }
    }
  }
}

// ── a link crossing the gap between two region bands ─────────────────────

// #1096 review (P1): the reviewer's repro -- a 12 mm square blank, a 2 mm ball,
// and two bands along X8-10 and X20-22 -- produced a link between the bands
// whose height came from the model tips, not from what had actually been cut.
// Outside a region nothing is removed, so a link crossing outside must clear
// the **uncut blank**, not the model that a full-bar job would have reached.
{
  const base = squareProject('rotary_rough')
  const stock = barStockOf(base)
  const centre = barCentre(stock)
  const circumference = Math.PI * stock.thickness
  // A band spanning the whole circumference: the region is a pair of along
  // windows, exactly the reviewer's reproduction.
  const profile = (alongMin: number): SketchProfile => rectProfile(
    alongMin, centre - circumference / 2, 2, circumference,
  )
  const project = withRegion(withRegion(base, 'region-a', profile(8)), 'region-b', profile(20))
  const operation: Operation = {
    ...project.operations[0],
    rotaryPassDirection: 'around',
    target: { source: 'features', featureIds: ['model', 'region-a', 'region-b'] },
  }
  const result = computeOperationToolpath(project, operation)!.result
  const pivot = barPivotZ(stock)
  const tool = normalizeToolForProject(project.tools.find((entry) => entry.id === operation.toolRef)!, project)
  const blankZ = (angle: number): number => pivot
    + squareRotaryTouchRadius(stock, angle, tool.radius, tool.type)
  // #1103 slice ca-d: A advances one turn per ring, so a transition between two
  // region bands is a **safe gap** (retract, turn, plunge) rather than the
  // constant-A raised traverse #1093 emitted between equal angles. What matters
  // is unchanged: whatever crosses the untouched stock at X15 does it at or
  // above the blank's top, never through it.
  let crossings = 0
  for (const move of result.moves) {
    if (move.from.a === undefined || move.to.a === undefined) continue
    const from = alongOf(stock, move.from)
    const to = alongOf(stock, move.to)
    // The gap between the two bands is at X15.
    if (!(Math.min(from, to) <= 15 && Math.max(from, to) >= 15)) continue
    crossings++
    const physical = (a: number): number => ((a % 360) + 360) % 360
    const blank = Math.max(blankZ(physical(move.from.a)), blankZ(physical(move.to.a)))
    assert.ok(move.from.z >= blank - 1e-6 && move.to.z >= blank - 1e-6,
      `a ${move.kind} crossing the gap at X15, A${move.from.a.toFixed(2)}->${move.to.a.toFixed(2)} `
      + `runs at Z${Math.min(move.from.z, move.to.z).toFixed(4)}, inside the uncut blank `
      + `(top ${blank.toFixed(4)})`)
  }
  assert.ok(crossings > 0,
    'the two region bands leave a gap, so a link crossing the untouched stock exists')
  assert.ok(cuttingMoves(result, rotaryTravelZ(stock, 'mm')).length > 0,
    'the bands still cut inside themselves')
  // #1117 slice B: the at-layer link is a cut at one angle, so it may not cross
  // the gap either. This fixture is a **square** blank with a region, so its
  // rings are split by the touch gate as well and the region rule keeps the
  // raised link at every such transition; the round-bar case below is the one
  // that links inside a band.
  for (const move of result.moves) {
    if (move.kind !== 'cut' && move.kind !== 'plunge') continue
    if (move.from.a === undefined || move.from.a !== move.to.a) continue
    const from = alongOf(stock, move.from)
    const to = alongOf(stock, move.to)
    if (from === to) continue
    if (Math.min(from, to) < 15 && Math.max(from, to) > 15) {
      assert.fail(`a cutting link at A${move.from.a.toFixed(2)} crosses the untouched gap `
        + `(${from.toFixed(2)} -> ${to.toFixed(2)})`)
    }
  }
}

// An 'exclude' region masks the other way round: the area it covers is *not*
// cut. The same rectangle on the sheet, excluded, must leave every cutting
// point outside it.
{
  const base = rotaryOperationFixture('x', 'rotary_finish')
  const project = withRegion(base, 'region', rectProfile(8, 5, 12, 2), 'exclude')
  const operation = withTarget(project.operations[0], 'region', 'along')
  const result = computeOperationToolpath(project, operation)!.result
  const stock = barStockOf(project)
  const travelZ = rotaryTravelZ(stock, 'mm')
  const cuts = cuttingMoves(result, travelZ)
  assert.ok(cuts.length > 0, 'an exclude region still cuts outside itself')
  for (const move of cuts) {
    for (const point of [move.from, move.to]) {
      assert.ok(!insideSheetRect(stock, ROUND_REGION, alongOf(stock, point), point.a ?? 0),
        'an exclude region is not cut')
    }
  }
}

// ── a region across the seam ──────────────────────────────────────────────

/** An open coaxial tube: the physical reference is the analytic cylinder. */
function cylinderMesh(stock: { axis: 'x' | 'y'; thickness: number }, radius: number, alongStart: number, alongEnd: number, segments = 192): RotaryModelMesh {
  const centre = barCentre(stock as Parameters<typeof barCentre>[0])
  const pivot = stock.thickness / 2
  const positions: number[] = []
  const index: number[] = []
  for (const along of [alongStart, alongEnd]) {
    for (let i = 0; i < segments; i++) {
      const t = 2 * Math.PI * i / segments
      const across = centre + radius * Math.cos(t)
      const up = pivot + radius * Math.sin(t)
      if (stock.axis === 'x') positions.push(along, across, up)
      else positions.push(across, along, up)
    }
  }
  for (let i = 0; i < segments; i++) {
    const j = (i + 1) % segments
    index.push(i, j, segments + j, i, segments + j, segments + i)
  }
  return { positions: new Float32Array(positions), index: new Uint32Array(index) }
}

/** The seam and arc fixtures' finish tool: a 3 mm ball, whose radius sets the
 *  link row's along sample no coarser than 0.75 mm. */
const ROUND_FINISH_TOOL: NormalizedTool = {
  id: 'ball-3', name: '3 mm ball nose', sourceUnits: 'mm', units: 'mm',
  type: 'ball_endmill', diameter: 3, radius: 1.5, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}

/** Their finish parameters, around mode: 1 mm along step (22 rings over
 *  3..27) and a quarter of the ball round the bar. */
const ROUND_FINISH_PARAMS = {
  stepover: 1, sampleSpacing: 1.5 / 4, stockToLeave: 0,
  alongStart: 3, alongEnd: 27, safeRadius: 25, requestedCellSize: 0.5,
  passDirection: 'around' as const,
}

{
  const stock = roundStock(12, 30, 'x')
  const centre = barCentre(stock)
  const circumference = Math.PI * stock.thickness
  // The sheet spans one circumference from the zero line: its left edge is
  // across = centre - C/2, which is the seam at A = -180. A region drawn there
  // covers A = 180..208, and only the seam wrap can reach it -- the generator's
  // A never goes below 0.
  const leftEdge = centre - circumference / 2
  const seamRect: SheetRect = {
    alongMin: 0, alongMax: 30,
    acrossMin: leftEdge, acrossMax: leftEdge + 3,
  }
  const angleSpan = 3 * 360 / circumference
  const withMask = generateRotaryFinish(
    'seam', cylinderMesh(stock, 4, 3, 27), stock, ROUND_FINISH_TOOL,
    { ...ROUND_FINISH_PARAMS, region: productionMask(stock, seamRect) }, {},
  )
  assert.ok(withMask.moves.length > 0, 'the left-edge region still cuts through the seam')
  // #1103 slice ca-c: commanded A grows across the operation, so the region's
  // physical band is read on A modulo one turn.
  const physical = (angle: number): number => ((angle % 360) + 360) % 360
  const angles = withMask.moves.flatMap((move) => [move.from.a, move.to.a])
    .filter((angle): angle is number => angle !== undefined)
    .map(physical)
  assert.ok(angles.length > 0, 'the seam cuts carry an angle')
  const lowest = Math.min(...angles)
  const highest = Math.max(...angles)
  assert.ok(lowest > 180 - 1e-6 && highest < 180 + angleSpan + 1e-6,
    `the seam region covers A${lowest.toFixed(3)}..A${highest.toFixed(3)}; `
    + `the left-edge rectangle is A180..A${(180 + angleSpan).toFixed(3)}`)
  // The mutation: without the seam wrap this mask can never match, because the
  // sheet's left edge is below the zero line and every tool A maps above it.
  const unwrapped = generateRotaryFinish(
    'seam-free', cylinderMesh(stock, 4, 3, 27), stock, ROUND_FINISH_TOOL, ROUND_FINISH_PARAMS, {},
  )
  // #1177: the angles each cut **sweeps**, not only its ends. A ball reads the
  // exact sphere drop now, so on this cylinder the helix is exactly collinear in
  // (along, A, radius) and merges into a few long moves, each many turns long,
  // whose end angles alone can all fall inside the band.
  const sweepsBeyondBand = unwrapped.moves.some((move) => {
    if (move.kind !== 'cut' || move.from.a === undefined || move.to.a === undefined) return false
    const from = Math.min(move.from.a, move.to.a)
    const to = Math.max(move.from.a, move.to.a)
    if (to - from >= 360) return true
    for (let angle = from; ; angle += 1) {
      const at = Math.min(angle, to)
      if (physical(at) > 180 + angleSpan + 1e-6) return true
      if (at >= to) return false
    }
  })
  assert.ok(sweepsBeyondBand,
    'the region-free control cuts beyond the seam band, so the wrap is what limits it')

  // A rectangle drawn straddling the right edge of the sheet covers both sides
  // of A180 directly, and the wrap must not double-count or drop either half.
  const rightEdge = centre + circumference / 2
  const straddle: SheetRect = {
    alongMin: 0, alongMax: 30,
    acrossMin: rightEdge - 3, acrossMax: rightEdge + 3,
  }
  const straddled = generateRotaryFinish(
    'straddle', cylinderMesh(stock, 4, 3, 27), stock, ROUND_FINISH_TOOL,
    { ...ROUND_FINISH_PARAMS, region: productionMask(stock, straddle) }, {},
  )
  const straddleAngles = straddled.moves.flatMap((move) => [move.from.a, move.to.a])
    .filter((angle): angle is number => angle !== undefined)
    .map(physical)
  assert.ok(straddleAngles.some((angle) => angle < 180), 'the seam region cuts on the A<180 side')
  assert.ok(straddleAngles.some((angle) => angle > 180), 'the seam region cuts on the A>180 side')
}

// ── a partial-angle region: the rings stay forward-only, with safe gaps ───

// #1096 made a region-clipped finish ring link across the region, because the
// reversed next ring began at the arc's other end. Since #1103 slice ca-c rings
// no longer reverse: every ring cuts the same arc and the next starts a full
// turn later, so the arc's end and the next ring's start are one commanded turn
// apart and #1093's exact constant-A precondition does not hold. The plan
// accepts that: a partial ring gets the emitter's **safe gap** (a retract to the
// travel height, a traverse and a plunge) rather than a constant-A link. The
// mutation this block rejects is the old alternating traversal: it would make
// the region link fire again with a rewound A, which the no-reversal assertions
// below catch.
{
  const stock = roundStock(12, 30, 'x')
  const centre = barCentre(stock)
  const circumference = Math.PI * stock.thickness
  const travelZ = rotaryTravelZ(stock, 'mm')
  const mesh = cylinderMesh(stock, 4, 3, 27)
  // A60..A120: interior, so it never contains the ring's own A0/A360 ends.
  const arc: SheetRect = {
    alongMin: 0, alongMax: 30,
    acrossMin: centre + circumference / 6,
    acrossMax: centre + circumference / 3,
  }
  const free = generateRotaryFinish('arc-free', mesh, stock, ROUND_FINISH_TOOL, ROUND_FINISH_PARAMS, {})
  const clipped = generateRotaryFinish('arc', mesh, stock, ROUND_FINISH_TOOL, {
    ...ROUND_FINISH_PARAMS, region: productionMask(stock, arc),
  }, {})
  assert.deepEqual(clipped.warnings, [], 'the region finish has no warning')
  const rings = ringCount(clipped)
  // The ring grid is one along position every stepover over the cutter-centre
  // span. The fixture's model runs 3..27, exactly the band, so both of its ends
  // are the **model's** own ends: #1155 rn-e lets the centre reach them and the
  // plain bar beyond them be cut, so there is no retained stub and no one-radius
  // pull on either side.
  const spanStart = ROUND_FINISH_PARAMS.alongStart
  const spanEnd = ROUND_FINISH_PARAMS.alongEnd
  const expectedRings = Math.ceil((spanEnd - spanStart) / ROUND_FINISH_PARAMS.stepover) + 1
  assert.equal(rings, expectedRings, 'the region still emits one ring per along position')
  assert.ok(rings > 1, 'the fixture has several rings')
  assert.equal(free.moves.filter((move) => move.kind === 'plunge').length, 1,
    'the region-free control is one continuous helix and plunges once')
  assert.equal(clipped.moves.filter((move) => move.kind === 'plunge').length, rings,
    `every region-clipped ring takes the safe gap, one plunge per ring (${rings} rings)`)

  // The gap itself: each ring boundary retracts to the travel height and comes
  // back down, never a constant-A feed at the surface.
  assert.equal(ringLinks(clipped).length, 0,
    'an interior region arc does not keep a constant-A link after the reversal is gone')
  const gaps = clipped.moves.filter((move) => move.kind === 'rapid').length
  assert.ok(gaps >= rings, `the region rings are separated by travel-height gaps (${gaps} rapid legs)`)
  for (const move of cuttingMoves(clipped, travelZ)) {
    for (const point of [move.from, move.to]) {
      assert.ok(insideSheetRect(stock, arc, point.x, point.a ?? 0),
        `a cut stays inside the region (X${point.x.toFixed(3)} A${(point.a ?? 0).toFixed(3)})`)
    }
  }

  // Two separate angle pieces: every ring's two arcs are genuinely split, so the
  // finish retracts between them and never links across the gap.
  const piece = (angle: number): SheetRect => {
    const across = centre + angle * Math.PI * stock.thickness / 360
    const half = 30 * Math.PI * stock.thickness / 360 / 2
    return { alongMin: 0, alongMax: 30, acrossMin: across - half, acrossMax: across + half }
  }
  const two = generateRotaryFinish('arc-two', mesh, stock, ROUND_FINISH_TOOL, {
    ...ROUND_FINISH_PARAMS, region: productionMaskFor(stock, [piece(90), piece(270)]),
  }, {})
  const twoRings = ringCount(two)
  assert.ok(twoRings > 1, 'the two-piece fixture has several rings')
  assert.equal(two.moves.filter((move) => move.kind === 'plunge').length, 2 * twoRings,
    'each ring plunges into each of its two region pieces')
  assert.equal(ringLinks(two).length, 0, 'the two angle pieces are never joined by a surface link')
  const turn = two.moves.find((move) => move.kind === 'rapid'
    && move.from.a !== undefined && move.to.a !== undefined && move.from.a !== move.to.a
    && move.from.x === move.to.x && Math.min(move.from.z, move.to.z) >= travelZ - 1e-9)
  assert.ok(turn, 'the finish retracts to the travel height between the two pieces')

  // A region that wraps the A0/A360 seam arrives as two pieces per ring (the arc
  // is split by the ring's own ends), and deliberately keeps today's retract.
  const seam = generateRotaryFinish('arc-seam', mesh, stock, ROUND_FINISH_TOOL, {
    ...ROUND_FINISH_PARAMS,
    region: productionMask(stock, { alongMin: 0, alongMax: 30, acrossMin: centre - 1, acrossMax: centre + 1 }),
  }, {})
  assert.equal(ringLinks(seam).length, 0, 'a seam-wrapping region keeps the old retract, not a link')
  assert.ok(seam.moves.filter((move) => move.kind === 'plunge').length > 1,
    'the seam-wrapping region still plunges piece by piece')

  // A region covering the whole sheet drops no sample, so it is the identity on
  // the motion: the linking rule only ever fires for a ring the region actually
  // trimmed, never for one that was already whole.
  const full = generateRotaryFinish('arc-full', mesh, stock, ROUND_FINISH_TOOL, {
    ...ROUND_FINISH_PARAMS,
    region: productionMask(stock, {
      alongMin: 0, alongMax: 30,
      acrossMin: centre - circumference / 2, acrossMax: centre + circumference / 2,
    }),
  }, {})
  assert.deepEqual(full.moves, free.moves, 'a region covering the sheet changes no motion')
}

// ── the segment test: meeting points and every sub-span ───────────────────

// #1096 review of slice E (P2). `segmentInsideEntries` sampled only the spans
// between interior crossings, so the final span -- and the whole segment when
// it had no interior crossing -- was never tested, and a crossing point was
// never tested at all. Three segments were accepted although the mask excludes
// part of them: the 0.02 gap between two include boundaries that are the
// segment's own ends, a chord across a hole between its boundary points, and a
// segment touching an excluded triangle's vertex. The one rule now collects
// every meeting point (crossings, touches, collinear overlap ends, both segment
// ends), tests those points against the mask's own `containsPoint`, and tests
// the midpoint of every span between consecutive points.
{
  const stock = roundStock(12, 30, 'x')
  const rect = (id: string, minX: number, minY: number, maxX: number, maxY: number, mode?: 'include' | 'exclude'): SketchFeature =>
    regionFeature(stock, id, { alongMin: minX, alongMax: maxX, acrossMin: minY, acrossMax: maxY }, mode)

  // Segment wholly inside the include.
  const box = buildRegionMask([rect('box', 0, 0, 10, 10)])
  const boxSegment = segmentTest(box)
  assert.equal(boxSegment({ x: 1, y: 1 }, { x: 9, y: 9 }), true,
    'a segment wholly inside the include is inside')

  // Along an include edge. The mask's point test treats a boundary as inside,
  // so the whole edge is too; the collinear edge must not add a false cut.
  assert.ok(box, 'the include mask builds')
  assert.equal(box.containsPoint({ x: 5, y: 0 }), true, 'an include boundary reads as inside')
  assert.equal(boxSegment({ x: 2, y: 0 }, { x: 8, y: 0 }), true,
    'a segment along an include edge is inside')

  // Repro 1a: two includes whose facing boundaries are exactly 4.99 and 5.01.
  // Both ends are boundary points (inside), the midpoint is the excluded gap,
  // and there is no interior crossing for the old rule to split on.
  const gapSegment = segmentTest(buildRegionMask([
    rect('left', 0, 0, 4.99, 10),
    rect('right', 5.01, 0, 10, 10),
  ]))
  assert.equal(gapSegment({ x: 4.99, y: 5 }, { x: 5.01, y: 5 }), false,
    'the 0.02 gap between two include boundaries is not inside, though both ends are inside')

  // Repro 1b: an include path set with a hole (even-odd). A chord between two
  // points on the hole boundary has both ends inside the mask's point test, and
  // no boundary crossing strictly between them.
  const holed = buildMaskFromClipperPaths([
    toClipperPath([{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]),
    toClipperPath([{ x: 4, y: 4 }, { x: 6, y: 4 }, { x: 6, y: 6 }, { x: 4, y: 6 }]),
  ])
  const holeSegment = segmentTest(holed)
  assert.ok(holed, 'the holed mask builds')
  assert.equal(holed.containsPoint({ x: 4, y: 5 }), true, 'the hole boundary reads as inside')
  assert.equal(holed.containsPoint({ x: 5, y: 5 }), false, 'the hole itself reads as outside')
  assert.equal(holeSegment({ x: 4, y: 5 }, { x: 6, y: 5 }), false,
    'a chord across the hole between its boundary points is not inside')

  // A segment that crosses an exclude (its interior, not only a boundary).
  const crossedSegment = segmentTest(buildRegionMask([
    rect('outer', 0, 0, 10, 10),
    rect('strip', 4, 0, 6, 10, 'exclude'),
  ]))
  assert.equal(crossedSegment({ x: 2, y: 5 }, { x: 8, y: 5 }), false,
    'a segment crossing an exclude is not inside')

  // Repro 2: a horizontal segment touching an excluded triangle's vertex. The
  // vertex reads as outside; the old rule never tested the touch point and
  // accepted the segment because both spans beside it are inside the include.
  const notch = buildRegionMask([
    rect('outer', 0, 0, 10, 10),
    profileRegionFeature('notch', polygonProfile([{ x: 4, y: 3 }, { x: 6, y: 3 }, { x: 5, y: 6 }]), 'exclude'),
  ])
  const touchSegment = segmentTest(notch)
  assert.ok(notch, 'the notched mask builds')
  assert.equal(notch.containsPoint({ x: 5, y: 6 }), false, 'the excluded vertex is outside the mask')
  assert.equal(touchSegment({ x: 3, y: 6 }, { x: 7, y: 6 }), false,
    'a segment touching an excluded vertex is not inside')

  // The seam repeat: a region drawn at the sheet's left edge is reachable at
  // A181 only through its +one-turn copy. Without the repeat the same segment
  // is off the drawn sheet, so the test is live.
  {
    const centre = barCentre(stock)
    const circumference = Math.PI * stock.thickness
    const leftEdge = centre - circumference / 2
    const seamRect: SheetRect = {
      alongMin: 0, alongMax: 30,
      acrossMin: leftEdge, acrossMax: leftEdge + 2,
    }
    const across181 = centre + 181 * Math.PI * stock.thickness / 360
    assert.equal(
      segmentTest(productionMask(stock, seamRect))({ x: 5, y: across181 }, { x: 25, y: across181 }),
      true,
      'the +one-turn copy of the seam region covers A181',
    )
    assert.equal(
      segmentTest(buildRegionMask([regionFeature(stock, 'seam', seamRect)]))(
        { x: 5, y: across181 }, { x: 25, y: across181 },
      ),
      false,
      'without the repeat the same segment is off the drawn sheet',
    )
  }
}

// ── a surface link cannot step over a narrow excluded strip ──────────────

// #1096 review (P2): the reviewer's production mask excludes X4.99..5.01 and
// the finish links ring X4.5 to ring X5.5 as a cut at one angle. The dense link
// row samples X at 4.873 and 5.246, so testing only those samples stepped over
// the 0.02 mm strip and cut it. The mask's own boundary geometry must refuse
// the whole link, leaving the existing retract/rapid/plunge in its place.
//
// Since #1103 slice ca-c the rings of an uninterrupted band are one helix, and
// since ca-j the square blank helices too. The ring fallback the link lives on
// is now what a refused helix leaves: the region below refuses the helix (one
// of its excluded strips crosses the band) while every ring position stays
// inside, so the rings are whole and the ring-to-ring link runs -- at A0 (the
// exact constant-A precondition). The control's excluded strip sits *between*
// two ring positions so it refuses the helix but not the X4.5 -> X5.5 link; the
// tested strip sits under that link, so the mask's own segment geometry must
// refuse it.
{
  const stock = squareStock(12, 30, 'x')
  const circumference = Math.PI * stock.thickness
  const centre = barCentre(stock)
  const travelZ = rotaryTravelZ(stock, 'mm')
  const mesh = cylinderMesh(stock, 4, 3, 27)
  // The cutter-centre span 3..27 pulls in one 1.5 mm ball radius at each end,
  // so the rings land exactly on X4.5, X5.5, ...: the reviewer's link span.
  const params = ROUND_FINISH_PARAMS
  // A region covering the whole sheet keeps every ring whole and inside.
  const sheet: SheetRect = {
    alongMin: 0, alongMax: 30,
    acrossMin: centre - circumference / 2, acrossMax: centre + circumference / 2,
  }
  const strip: SheetRect = {
    alongMin: 4.99, alongMax: 5.01,
    acrossMin: centre - circumference / 2, acrossMax: centre + circumference / 2,
  }
  // #1103 slice ca-j: the control's helix refusal. It lies between the ring
  // positions X9.5 and X10.5, so no ring is trimmed (the rings stay whole and
  // link), while the helix's own poses sample it and the band falls back to
  // rings -- the path the link rule is about.
  const controlGap: SheetRect = {
    alongMin: 9.7, alongMax: 10.3,
    acrossMin: centre - circumference / 2, acrossMax: centre + circumference / 2,
  }
  const stripMask = buildRegionMask(
    [regionFeature(stock, 'sheet', sheet), regionFeature(stock, 'strip', strip, 'exclude')],
    { axis: stock.axis === 'x' ? 'y' : 'x', period: circumference },
  )
  assert.ok(stripMask, 'the reviewer repro mask builds')
  const controlMask = buildRegionMask(
    [regionFeature(stock, 'sheet', sheet), regionFeature(stock, 'gap', controlGap, 'exclude')],
    { axis: stock.axis === 'x' ? 'y' : 'x', period: circumference },
  )
  assert.ok(controlMask, 'the control mask builds')
  const linked = generateRotaryFinish('strip-free', mesh, stock, ROUND_FINISH_TOOL, {
    ...params, region: controlMask,
  }, {})
  const excluded = generateRotaryFinish('strip', mesh, stock, ROUND_FINISH_TOOL, {
    ...params, region: stripMask,
  }, {})

  /** A non-rapid move whose along span covers the whole strip. */
  const crossingCuts = (result: ToolpathResult): ToolpathMove[] => result.moves.filter((move) => {
    if (move.kind === 'rapid') return false
    const from = alongOf(stock, move.from)
    const to = alongOf(stock, move.to)
    return Math.min(from, to) < strip.alongMin - 1e-9 && Math.max(from, to) > strip.alongMax + 1e-9
  })

  // The control proves the link exists and that this fixture's samples do land
  // outside the strip, so the assertion below is not vacuous.
  const control = crossingCuts(linked)
  assert.ok(control.length > 0, 'the control links X4.5 -> X5.5 across the strip')
  for (const move of control) {
    // A full-ring link keeps the rings' shared commanded angle, A0 of the turn.
    assert.ok(Math.abs(alongOf(stock, move.from) - alongOf(stock, move.to)) > 0, 'the control is an along-bar link')
    assert.equal(((move.from.a ?? 0) % 360 + 360) % 360, 0,
      `the link uses the rings' shared angle (A${(move.from.a ?? 0).toFixed(3)})`)
  }
  assert.equal(crossingCuts(excluded).length, 0,
    'a link covering the excluded strip is not cut; the finish retracts instead')
  assert.ok(excluded.moves.some((move) => move.kind === 'cut'
    && Math.min(move.from.z, move.to.z) < travelZ - 1e-9),
  'the excluded finish still cuts inside the sheet')
}

// ── a helix never crosses an excluded region (#1103 slice ca-c) ───────────

// The band is a surface of revolution under every angle, so its rings are fully
// covered and the helix is the default motion. An excluded along-strip is the
// mutation this block guards: the helix must be refused and the band fall back
// to its forward-only rings, none of which cuts across the strip. The
// region-free control crosses the strip, so the assertion is live.
{
  const stock = roundStock(12, 30, 'x')
  const centre = barCentre(stock)
  const circumference = Math.PI * stock.thickness
  const pivot = barPivotZ(stock)
  const travelZ = rotaryTravelZ(stock, 'mm')
  const mesh = cylinderMesh(stock, 4, 3, 27)
  // The whole sheet minus a 0.02 mm along strip, so every ring is whole and
  // inside the region and only the strip is excluded.
  const sheet: SheetRect = {
    alongMin: 0, alongMax: 30,
    acrossMin: centre - circumference / 2, acrossMax: centre + circumference / 2,
  }
  const strip: SheetRect = {
    alongMin: 14.99, alongMax: 15.01,
    acrossMin: centre - circumference / 2, acrossMax: centre + circumference / 2,
  }
  const mask = buildRegionMask(
    [regionFeature(stock, 'sheet', sheet), regionFeature(stock, 'strip', strip, 'exclude')],
    { axis: stock.axis === 'x' ? 'y' : 'x', period: circumference },
  )
  assert.ok(mask, 'the sheet-minus-strip mask builds')
  const free = generateRotaryFinish('cross-free', mesh, stock, ROUND_FINISH_TOOL, ROUND_FINISH_PARAMS, {})
  const guarded = generateRotaryFinish('cross', mesh, stock, ROUND_FINISH_TOOL, {
    ...ROUND_FINISH_PARAMS, region: mask,
  }, {})
  assert.deepEqual(guarded.warnings, [], 'the strip finish has no warning')
  /** Moves whose swept path enters the excluded strip (its boundaries included). */
  const crossing = (result: ToolpathResult): ToolpathMove[] => result.moves.filter((move) => {
    if (move.kind === 'rapid') return false
    const from = alongOf(stock, move.from)
    const to = alongOf(stock, move.to)
    for (let step = 0; step <= 4; step++) {
      const along = from + (to - from) * step / 4
      if (along > strip.alongMin - 1e-9 && along < strip.alongMax + 1e-9) return true
    }
    return false
  })
  assert.ok(crossing(free).length > 0,
    'the region-free helix enters the excluded strip, so the check is live')
  assert.equal(crossing(guarded).length, 0,
    'letting a helix cross an excluded region is caught: the band falls back to rings')
  const reversals = (result: ToolpathResult): number => {
    let count = 0
    let last = 0
    for (const move of result.moves) {
      if (move.kind !== 'cut') continue
      const delta = (move.to.a ?? 0) - (move.from.a ?? 0)
      if (Math.abs(delta) < 1e-12) continue
      const sign = Math.sign(delta)
      if (last !== 0 && sign !== last) count++
      last = sign
    }
    return count
  }
  assert.equal(reversals(free), 0, 'the region-free helix is one-way')
  assert.equal(reversals(guarded), 0, 'and the ring fallback is still forward-only')

  // The safe gap's clearance: every plunge starts, and every rapid ends, at or
  // above the travel height (the bar's surface plus a clearance). The mutation
  // lowers one and the same predicate rejects it.
  const travelTip = travelZ - pivot
  const clearOfBar = (result: ToolpathResult): boolean => result.moves.every((move) => {
    if (move.kind === 'plunge') return move.from.z - pivot >= travelTip - 1e-9
    if (move.kind === 'rapid') return move.to.z - pivot >= travelTip - 1e-9
    return true
  })
  assert.ok(guarded.moves.some((move) => move.kind === 'plunge'), 'the ring fallback has plunges')
  assert.ok(clearOfBar(guarded), 'every transition of the ring fallback clears the bar')
  const plunge = guarded.moves.findIndex((move) => move.kind === 'plunge'
    && Math.abs(move.from.z - travelZ) < 1e-9)
  assert.ok(plunge >= 0, 'the fallback has a transition at the travel height to lower')
  const lowered = guarded.moves.map((move, index) => index === plunge
    ? { ...move, from: { ...move.from, z: move.from.z - 1 } }
    : move)
  assert.ok(!clearOfBar({ ...guarded, moves: lowered }),
    'lowering a transition\'s shoulder clearance is caught')
}

// ── a region-trimmed rough ring makes a safe gap (#1103 slice ca-d) ──────

// #1117 kept a region-trimmed ring's transition at the layer because both rings
// shared a commanded angle. With A one-way that angle is a full turn apart, so
// the transition is a **safe gap** -- retract, turn, plunge at the travel
// height -- and the property that matters is unchanged: no cutting move leaves
// the mask, and nothing crosses the untouched stock below the blank.
{
  const stock = roundStock(12, 30, 'x')
  const centre = barCentre(stock)
  const circumference = Math.PI * stock.thickness
  const travelZ = rotaryTravelZ(stock, 'mm')
  const mesh = cylinderMesh(stock, 4, 3, 27)
  const params = {
    stepover: 1, sampleSpacing: 1, stockToLeave: 0, alongStart: 3, alongEnd: 27,
    safeRadius: 25, requestedCellSize: 0.5, stepdown: 1, passDirection: 'around' as const,
  }
  // A60..A120: an interior arc, so every ring is trimmed to one run that ends
  // on the mask boundary.
  const arc: SheetRect = {
    alongMin: 0, alongMax: 30,
    acrossMin: centre + circumference / 6,
    acrossMax: centre + circumference / 3,
  }
  const result = generateRotaryRough('region-links', mesh, stock, ROUND_FINISH_TOOL, {
    ...params, region: productionMask(stock, arc),
  }, {})
  assert.deepEqual(result.warnings, [], 'the region rough has no warning')
  // No ring-to-ring at-layer link survives the trimmed boundary.
  assert.equal(ringLinks(result).length, 0,
    'a region-trimmed ring transition is a safe gap, not an at-layer link')
  // Every cutting move of the rough stays inside the mask.
  for (const move of result.moves) {
    if (move.kind === 'rapid') continue
    if (Math.min(move.from.z, move.to.z) >= travelZ - 1e-6) continue
    for (const point of [move.from, move.to]) {
      assert.ok(insideSheetRect(stock, arc, alongOf(stock, point), point.a ?? 0),
        `a region cut stays inside the mask (X${alongOf(stock, point).toFixed(3)} A${(point.a ?? 0).toFixed(3)})`)
    }
  }
  // The gap is turned at the travel height, above the blank.
  assert.ok(result.moves.some((move) => move.kind === 'rapid'
    && move.from.a !== undefined && move.to.a !== undefined && move.from.a !== move.to.a
    && Math.min(move.from.z, move.to.z) >= travelZ - 1e-6),
    'the trimmed boundary turns at the travel height')

  // Two along bands on the same round bar: the gap between them is crossed by a
  // rapid at the travel height, and nothing cutting covers it.
  const band = (alongMin: number, alongMax: number): SketchFeature => regionFeature(stock, `band-${alongMin}`, {
    alongMin, alongMax,
    acrossMin: centre - circumference / 2, acrossMax: centre + circumference / 2,
  })
  const bandsMask = buildRegionMask([band(3, 8), band(20, 26)], {
    axis: stock.axis === 'x' ? 'y' : 'x', period: circumference,
  })
  assert.ok(bandsMask, 'the rough two-band mask builds')
  const bands = generateRotaryRough('region-bands', mesh, stock, ROUND_FINISH_TOOL, {
    ...params, region: bandsMask,
  }, {})
  assert.deepEqual(bands.warnings, [], 'the two-band rough has no warning')
  const gapCrossings = bands.moves.filter((move) => {
    if (move.kind === 'rapid') return false
    const from = alongOf(stock, move.from)
    const to = alongOf(stock, move.to)
    return Math.min(from, to) < 14 && Math.max(from, to) > 14
  })
  assert.equal(gapCrossings.length, 0,
    'nothing cutting crosses the gap between the two bands')
  assert.ok(bands.moves.some((move) => move.kind === 'rapid'
    && Math.min(alongOf(stock, move.from), alongOf(stock, move.to)) < 14
    && Math.max(alongOf(stock, move.from), alongOf(stock, move.to)) > 14
    && Math.min(move.from.z, move.to.z) >= travelZ - 1e-6),
    'the gap is crossed by a rapid at the travel height')
  assert.ok(ringCount(bands) > 0, 'the bands still ring')
  console.log(`  region gaps: ${ringCount(result)} rings trimmed, `
    + `${ringCount(bands)} rings in two bands, no at-layer link across either gap`)
}

// ── a rough link cannot cross a narrow excluded strip ─────────────────────

// The finish's strip repro, on the rough: an excluded strip 0.02 mm wide falls
// between two dense samples. No cutting move may cover it -- the strip is
// uncut stock, not a surface a link may ride -- and the rough retracts across.
{
  const stock = roundStock(12, 30, 'x')
  const centre = barCentre(stock)
  const circumference = Math.PI * stock.thickness
  const mesh = cylinderMesh(stock, 4, 3, 27)
  const params = {
    stepover: 1, sampleSpacing: 1, stockToLeave: 0, alongStart: 3, alongEnd: 27,
    safeRadius: 25, requestedCellSize: 0.5, stepdown: 1, passDirection: 'around' as const,
  }
  const arc: SheetRect = {
    alongMin: 0, alongMax: 30,
    acrossMin: centre + circumference / 6,
    acrossMax: centre + circumference / 3,
  }
  const strip: SheetRect = { alongMin: 4.99, alongMax: 5.01, acrossMin: centre - circumference / 2, acrossMax: centre + circumference / 2 }
  const stripMask = buildRegionMask([
    regionFeature(stock, 'arc', arc),
    regionFeature(stock, 'strip', strip, 'exclude'),
  ], { axis: stock.axis === 'x' ? 'y' : 'x', period: circumference })
  assert.ok(stripMask, 'the rough strip mask builds')
  const result = generateRotaryRough('region-strip', mesh, stock, ROUND_FINISH_TOOL, {
    ...params, region: stripMask,
  }, {})
  assert.deepEqual(result.warnings, [], 'the strip rough has no warning')
  const crossesStrip = (move: ToolpathMove): boolean => {
    const from = alongOf(stock, move.from)
    const to = alongOf(stock, move.to)
    return Math.min(from, to) < strip.alongMin - 1e-9 && Math.max(from, to) > strip.alongMax + 1e-9
  }
  const cutCrossings = result.moves.filter((move) => move.kind !== 'rapid' && crossesStrip(move))
  assert.equal(cutCrossings.length, 0,
    'no cutting move covers the excluded strip; the rough retracts across it')
  assert.ok(result.moves.some((move) => move.kind === 'rapid' && crossesStrip(move)),
    'a rapid crosses the strip instead')
  assert.ok(cuttingMoves(result, rotaryTravelZ(stock, 'mm')).length > 0,
    'the band beside the strip still cuts')
  console.log(`  strip: no cutting move covers the excluded strip; the rough retracts across`)
}

// ── no region: byte-identical output ──────────────────────────────────────

// Captured from the base commit before #1096 existed, with the same fixtures:
// the move array, the warning codes and the real postprocessor's program.
// The program header stamps the wall clock (`commonContext.date` in
// postprocessor.ts), so the capture day is pinned below before hashing; the
// hashes above are the 2026-10-26 programs with only that field rewritten.
// #1117 re-recorded the one row it changes on purpose -- `round/rotary_rough/
// around` now links adjacent rings as cutting feeds at the layer instead of
// rising over them -- from the same fixture and postprocessor. The #1117 rl-a
// review fix re-recorded it again: this fixture's asymmetric prism leaves a
// standing sector that splits the rings of the later layers, and a split-ring
// transition now keeps the raised link, as the approved plan requires. #1117
// rl-b re-recorded a second row: `square/rotary_rough/around` now links the
// corner arcs of adjacent rings at the layer, which is the square half of the
// same change.
// #1103 slice ca-h re-recorded **every** row's posted hash on purpose: each
// program now ends with the forward end turn to 0 up, its machine-coordinate
// retract and the instruction. The `moves=` half of every row is unchanged —
// the slice changes the emitter, not the path.
// #1155 slice rn-c re-recorded the four **around** rows on purpose: the sampler's
// conservative read now reaches a whole cell past each sample instead of half a
// cell diagonal, which lifts the tips beside a step that falls inside a height
// map cell (a neighbour's end face, the prism's own raised edges here). All four
// along rows are byte-identical, as they must be: an along operation only reads
// that way when it has a neighbour, and these fixtures have none.
// #1155 rn-e re-recorded the four **round** rows: this fixture's prism runs
// 3..27 and its band ends exactly on the model's ends, so both ends are the
// model's own. The approved rule lets the cutter centre reach them (no
// one-radius pull) and the plain bar beyond them be cut (no retained stub), so
// every round program's grid and its end rings move. The four square rows are
// byte-identical: a square blank keeps its retained corners and both stubs, so
// the corner gate and the stub floors are untouched.
// #1177 re-recorded the four **round** rows: the fixture's tool is a ball, and a
// ball on a round bar reads the exact sphere drop instead of the conservative
// cell row, so all four programs move. The square rows are untouched.
// The around rough moved once more when the exact read's refinement took the
// 0.005 mm floor at the prism's convex corners (2291 moves; 2478 on the base).
const NO_REGION_HASHES: Record<string, string> = {
  'round/rotary_rough/along': 'moves=4aa9de8d8f6da26e warnings= gcode=b7f10baff78f8b2d',
  // #1117 rl-e re-recorded this row: the at-layer leftover is now what an
  // earlier layer actually left (the lowest pass over the ring positions)
  // instead of an upper bound on it, so this fixture's asymmetric prism keeps
  // more of its ring-to-ring links at the layer -- 29 equal-angle links became
  // 46 and the raised links fell from 31 to 18. The raised form is unchanged
  // wherever it is still emitted.
  // #1103 slice ca-f re-recorded this row: on a round bar without a region the
  // at-layer candidate now proves a split ring's boundary instead of the
  // split-ring eligibility rule refusing it outright, so #1117's same-A links
  // between the rings a helix leaves behind stay down. The links' heights and
  // material bounds are unchanged.
  // #1173 re-recorded this row on purpose, for **both** of the approved output
  // changes and for no other reason: the round-bar rough is the one no-region
  // fixture the round gap feed reaches (fix C -- a short interior gap the layer
  // below cleared is fed through instead of retracted) and the one the
  // upward-only merge of the refinement's short steps also reshapes. With the
  // merge switched off this row still differs (fix C alone); with the gap feed
  // switched off and the merge on it differs too. The other three around rows
  // below change for the merge alone.
  'round/rotary_rough/around': 'moves=3f216a2f3e5fd0c2 warnings= gcode=8164c29d897a567d',
  'round/rotary_finish/along': 'moves=e09be094ed17079a warnings=rotaryFinishWithoutRough gcode=0276b51663ba5a86',
  // #1103 slice ca-c re-recorded the two around-finish rows on purpose: a round
  // bar's uninterrupted band is now one continuous helix (A one-way, never
  // wrapped) and a square blank's rings are forward-only (A grows one turn per
  // ring). Every other row is the base commit's bytes, exactly.
  'round/rotary_finish/around': 'moves=7ee460b1b9c7d826 warnings=rotaryFinishWithoutRough gcode=1466ed53586a0114',
  'square/rotary_rough/along': 'moves=a45d9f9fbd8bd7e9 warnings= gcode=c8e19d47e3a0b8c1',
  // #1117 (square links) re-recorded this row: without a region a square
  // blank's whole rings (below its inscribed radius) now link at the layer
  // instead of only its corner arcs. 33 raised links became at-layer cuts;
  // every other move is byte-identical to the previous recording.
  // #1103 slice ca-d fix 1 re-recorded it once more, on purpose: a forward link
  // across the A0/A360 seam now samples the rows its commanded sweep crosses
  // (not the whole circumference the physical indices walked), and a wide square
  // model gap the layer below cleared is proven by the at-layer row proof
  // instead of the 45 degree drift bound. Both change which links stay down.
  // #1103 slice ca-j re-recorded this row: the square blank's whole-ring bands
  // below its flat face are one continuous helix per band now, on the **rough
  // and the finish alike** (review P1: the finish was admitted in correction
  // round 1), so the rings and their at-layer links there are replaced by the
  // helix. Every along row is unchanged.
  'square/rotary_rough/around': 'moves=cfdc12df9188c018 warnings= gcode=fe24c049898a783c',
  'square/rotary_finish/along': 'moves=00b76a30aaf6601f warnings=rotaryFinishWithoutRough gcode=91c37f814f3b176b',
  'square/rotary_finish/around': 'moves=567f8fcd6012bb1a warnings=rotaryFinishWithoutRough gcode=95a606809357ecfd',
  // #1173 re-recorded the three remaining around rows for the **approved
  // upward-only merge** alone (`raiseShortAroundSegments`, which drops a refined
  // point only when the chord over it stays 0..0.02 mm
  // above every sample it spans): measured on the tip with the merge switched
  // off, each of these rows is the bytes recorded above. No neighbor exists in
  // these fixtures, so neither the exact-neighbour columns nor the gap feed can
  // reach them.
}

const GRBL = validateMachineDefinition(BUNDLED_DEFINITIONS.find((entry) => entry.id === 'grbl')!)
const ROTARY_MACHINE = validateMachineDefinition({
  ...structuredClone(GRBL),
  id: 'grbl-rotary',
  rotary: { about: 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
})

function post(project: Project, operation: Operation): string {
  const envelope = computeOperationToolpath(project, operation)!
  const tool = normalizeToolForProject(project.tools.find((entry) => entry.id === operation.toolRef)!, project)
  return runPostProcessor({
    project,
    definition: ROTARY_MACHINE,
    operations: [{ operation, tool, toolpath: envelope.result }],
    options: { emitToolChanges: false, emitCoolant: false, programName: project.meta.name },
  }).gcode
}

/** The day `NO_REGION_HASHES` were captured (postprocessor.ts stamps today). */
const CAPTURE_DATE = '2026-10-26'

/**
 * Rewrite only the header's generated-date field to `CAPTURE_DATE`, so the
 * hashed program is the same on every UTC day. The guards keep the pin narrow:
 * exactly one date field, and the rewrite changes no other byte (same length).
 */
function pinGeneratedDate(gcode: string): string {
  const field = /Generated by PureCutCNC on \d{4}-\d{2}-\d{2}/g
  assert.equal((gcode.match(field) ?? []).length, 1,
    'the program carries exactly one generated-date field')
  const pinned = gcode.replace(field, `Generated by PureCutCNC on ${CAPTURE_DATE}`)
  assert.equal(pinned.length, gcode.length, 'pinning the date changes no other byte')
  return pinned
}

for (const shape of ['round', 'square'] as const) {
  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    for (const direction of ['along', 'around'] as const) {
      const base = shape === 'round' ? rotaryOperationFixture('x', kind) : squareProject(kind)
      const operation = { ...base.operations[0], rotaryPassDirection: direction }
      const result = computeOperationToolpath(base, operation)!.result
      const label = `${shape}/${kind}/${direction}`
      const actual = `moves=${hash(JSON.stringify(result.moves))} `
        + `warnings=${result.warnings.map((warning) => warning.code).join(',')} `
        + `gcode=${hash(pinGeneratedDate(post(base, operation)))}`
      assert.equal(actual, NO_REGION_HASHES[label],
        `${label}: a target with no region must generate the base-commit bytes exactly`)
    }
  }
}

// A region feature that is not in the target's feature list is not a filter:
// adding one to the project alone changes nothing.
{
  const base = rotaryOperationFixture('x', 'rotary_finish')
  const project = withRegion(base, 'region', rectProfile(8, 5, 12, 2))
  const operation = { ...project.operations[0], rotaryPassDirection: 'along' as const }
  const result = computeOperationToolpath(project, operation)!.result
  const baseResult = computeOperationToolpath(base, { ...base.operations[0], rotaryPassDirection: 'along' })!.result
  assert.deepEqual(result.moves, baseResult.moves, 'a region the operation does not target is not a mask')
}

// ── #1177: a deeper rough layer does not bury its flank past the region's edge ──
//
// The region bounds the cutter's centre, but a ball's body reaches further round
// the bar the lower its tip. A rough whose every layer ran to the same angular
// edge cut, at its last layer, a 2.0 mm cavity into wall no layer above it had
// opened (a D1.5 ball reaching the model at r2 under a 1.5 stepdown). This is
// measured independently of the generator: rays from the axis past each edge,
// the ball's body (sphere plus shank) at every pose of every cut move, and the
// solid each move removes from each ray that nothing before it had removed.
{
  const stock = roundStock(10, 14, 'x')
  const ballTool: NormalizedTool = {
    id: 'ball-1.5', name: '1.5 mm ball nose', sourceUnits: 'mm', units: 'mm',
    type: 'ball_endmill', diameter: 1.5, radius: 0.75, vBitAngle: null,
    flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
    defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
  }
  const modelRadius = 2
  const stepdown = 1.5
  const region: SheetRect = { alongMin: 4, alongMax: 10, acrossMin: 4, acrossMax: 6 }
  const result = generateRotaryRough('region-draft', cylinderMesh(stock, modelRadius, 2, 12), stock, ballTool, {
    stepover: 1.125, sampleSpacing: 0.375, stockToLeave: 0, alongStart: 2, alongEnd: 12,
    safeRadius: 10, requestedCellSize: 0.25, stepdown, passDirection: 'around',
    region: productionMask(stock, region),
  }, {})
  const pivot = barPivotZ(stock)
  const barRadius = stock.thickness / 2
  const r = ballTool.radius
  const DEG = Math.PI / 180
  const cuts = result.moves.filter((move) => move.kind !== 'rapid')
  // The region's angular edges, from its across bounds (across 5 is A0).
  const edge = (region.acrossMax - barCentre(stock)) / (Math.PI * stock.thickness) * 360
  const rings = [...new Set(cuts.map((move) => move.from.x))].filter((x) => x >= region.alongMin && x <= region.alongMax)
  assert.ok(rings.length >= 3, `the rough cuts rings inside the region (${rings.length})`)
  /** The ball's body on one ray, with the cutter at tip `tip` and the ray `delta` degrees off its axis. */
  const bodyOnRay = (tip: number, delta: number): [number, number] | null => {
    const c = tip + r
    const s = Math.abs(Math.sin(delta * DEG))
    const cos = Math.cos(delta * DEG)
    if (c * s > r || cos <= 0) return null
    const half = Math.sqrt(r * r - c * c * s * s)
    const low = c * cos - half
    // The shank: every point within r of the tool axis, outward of the centre.
    const high = s > 1e-12 ? Math.max(c * cos + half, Math.min(r / s, barRadius)) : barRadius
    return [Math.max(low, modelRadius), Math.min(high, barRadius)]
  }
  const removed = new Map<string, [number, number][]>()
  const fresh = (intervals: [number, number][], span: [number, number]): number => {
    let length = span[1] - span[0]
    for (const [a, b] of intervals) length -= Math.max(0, Math.min(b, span[1]) - Math.max(a, span[0]))
    return Math.max(0, length)
  }
  let worst = 0
  let worstAt = ''
  let checkedRays = 0
  for (const move of cuts) {
    const along = move.from.x
    if (!rings.includes(along) || move.to.x !== along) continue
    const fromA = move.from.a ?? 0
    const toA = move.to.a ?? 0
    const fromTip = move.from.z - pivot
    const toTip = move.to.z - pivot
    const steps = Math.max(1, Math.ceil(Math.abs(toA - fromA) / 0.25), Math.ceil(Math.abs(toTip - fromTip) / 0.05))
    for (const side of [1, -1]) {
      for (let offset = 0.05; offset <= 20; offset += 0.1) {
        const ray = side * (edge + offset)
        const key = `${along}:${ray.toFixed(2)}`
        const before = removed.get(key) ?? []
        let span: [number, number] | null = null
        for (let step = 0; step <= steps; step++) {
          const f = step / steps
          const angle = fromA + (toA - fromA) * f
          const delta = ((ray - angle) % 360 + 540) % 360 - 180
          const body = bodyOnRay(fromTip + (toTip - fromTip) * f, delta)
          if (body === null || body[1] <= body[0]) continue
          span = span === null ? body : [Math.min(span[0], body[0]), Math.max(span[1], body[1])]
        }
        if (span === null) continue
        checkedRays++
        const bite = fresh(before, span)
        if (bite > worst) {
          worst = bite
          worstAt = `along ${along.toFixed(3)} ray A${ray.toFixed(2)} (edge ${(side * edge).toFixed(2)}), `
            + `move A${fromA.toFixed(2)}->${toA.toFixed(2)} tip ${fromTip.toFixed(3)}->${toTip.toFixed(3)}`
        }
        removed.set(key, [...before, span])
      }
    }
  }
  assert.ok(checkedRays > 100, `the rays past the region's edges are reached (${checkedRays})`)
  assert.ok(worst <= stepdown + 0.02,
    `no cut removes more than one stepdown from a ray past the region's edge: ${worst.toFixed(4)} mm at ${worstAt}`)
  console.log(`  region edge draft: ${checkedRays} ray samples past the edges, worst fresh bite ${worst.toFixed(4)} mm `
    + `(stepdown ${stepdown})`)
}

console.log(`rotary region tests passed (${outsideChecks} region cases, ${turnChecks} square turn cases)`)
