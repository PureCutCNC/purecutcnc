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
 * captured from the base commit before the feature existed.
 *
 * Mutations checked (each must fail here):
 *  - the mask ignored -> every "outside the region" assertion, and the
 *    region-free control showing cuts outside it;
 *  - the seam not wrapped -> the left-edge region emits no cut at all, and the
 *    A-range assertion fails;
 *  - a square turn taken below the travel envelope outside the region -> the
 *    square block's turn-height assertion.
 *
 * Run with: npx tsx src/engine/toolpaths/rotaryRegion.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { barCentre, barPivotZ, isBarStock, squareStock } from '../../types/barStock'
import { isRoundStock, rectProfile, roundStock } from '../../types/project'
import type { BarStock, Operation, Project, SketchFeature, SketchProfile } from '../../types/project'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import { projectWithFeatures } from '../../test/projectFixtures'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import { BUNDLED_DEFINITIONS } from '../gcode/definitions'
import { runPostProcessor } from '../gcode/postprocessor'
import { validateMachineDefinition } from '../gcode/types'
import { computeOperationToolpath } from './generateOperation'
import { normalizeToolForProject } from './geometry'
import { buildRegionMask } from './regions'
import { generateRotaryFinish } from './rotaryModel'
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

/** Is a tool position inside the rectangle, on any sheet turn? */
function insideSheetRect(stock: Parameters<typeof barCentre>[0], rect: SheetRect, along: number, angle: number): boolean {
  if (along < rect.alongMin - 1e-9 || along > rect.alongMax + 1e-9) return false
  const circumference = Math.PI * stock.thickness
  const across = acrossOf(stock, angle)
  for (let turn = -1; turn <= 1; turn++) {
    const shifted = across + turn * circumference
    if (shifted >= rect.acrossMin - 1e-9 && shifted <= rect.acrossMax + 1e-9) return true
  }
  return false
}

/** The production mask for one sheet rectangle: `buildRegionMask` with the
 *  circumferential repeat the rotary adapter asks for. */
function productionMask(stock: BarStock, rect: SheetRect, maskMode?: 'include' | 'exclude'): RotaryRegionMask {
  const region: SketchFeature = {
    id: 'region',
    name: 'region',
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
  const mask = buildRegionMask([region], {
    axis: stock.axis === 'x' ? 'y' : 'x',
    period: Math.PI * stock.thickness,
  })
  assert.ok(mask, 'the production seam mask builds')
  return mask
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
      let innerCuts = 0
      for (const move of cuts) {
        for (const point of [move.from, move.to]) {
          assert.ok(insideSheetRect(stock, ROUND_REGION, alongOf(stock, point), point.a ?? 0),
            `${label}: a cut at along ${alongOf(stock, point).toFixed(3)} A${(point.a ?? 0).toFixed(3)} `
            + 'is outside the region')
          innerCuts++
        }
      }
      assert.ok(innerCuts > 20, `${label}: the region is exercised (${innerCuts} cutting endpoints)`)
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
  let crossings = 0
  for (const move of result.moves) {
    if (move.kind !== 'rapid') continue
    if (move.from.a === undefined || move.from.a !== move.to.a) continue
    const from = alongOf(stock, move.from)
    const to = alongOf(stock, move.to)
    // The link between the two bands crosses the untouched gap at X15.
    if (!(Math.min(from, to) <= 15 && Math.max(from, to) >= 15)) continue
    crossings++
    const blank = blankZ(move.from.a)
    assert.ok(move.from.z >= blank - 1e-6 && move.to.z >= blank - 1e-6,
      `a link crossing the gap at X15, A${move.from.a.toFixed(2)} runs at `
      + `Z${Math.min(move.from.z, move.to.z).toFixed(4)}, inside the uncut blank `
      + `(top ${blank.toFixed(4)})`)
  }
  assert.ok(crossings > 0,
    'the two region bands leave a gap, so a link crossing the untouched stock exists')
  assert.ok(cuttingMoves(result, rotaryTravelZ(stock, 'mm')).length > 0,
    'the bands still cut inside themselves')
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
  const tool: NormalizedTool = {
    id: 'ball-3', name: '3 mm ball nose', sourceUnits: 'mm', units: 'mm',
    type: 'ball_endmill', diameter: 3, radius: 1.5, vBitAngle: null,
    flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
    defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
  }
  const params = {
    stepover: 1, sampleSpacing: 1.5 / 4, stockToLeave: 0,
    alongStart: 3, alongEnd: 27, safeRadius: 25, requestedCellSize: 0.5,
    passDirection: 'around' as const,
  }
  const withMask = generateRotaryFinish(
    'seam', cylinderMesh(stock, 4, 3, 27), stock, tool,
    { ...params, region: productionMask(stock, seamRect) }, {},
  )
  assert.ok(withMask.moves.length > 0, 'the left-edge region still cuts through the seam')
  const angles = withMask.moves.flatMap((move) => [move.from.a, move.to.a])
    .filter((angle): angle is number => angle !== undefined)
  assert.ok(angles.length > 0, 'the seam cuts carry an angle')
  const lowest = Math.min(...angles)
  const highest = Math.max(...angles)
  assert.ok(lowest > 180 - 1e-6 && highest < 180 + angleSpan + 1e-6,
    `the seam region covers A${lowest.toFixed(3)}..A${highest.toFixed(3)}; `
    + `the left-edge rectangle is A180..A${(180 + angleSpan).toFixed(3)}`)
  // The mutation: without the seam wrap this mask can never match, because the
  // sheet's left edge is below the zero line and every tool A maps above it.
  const unwrapped = generateRotaryFinish(
    'seam-free', cylinderMesh(stock, 4, 3, 27), stock, tool, params, {},
  )
  const unwrappedAngles = unwrapped.moves.flatMap((move) => [move.from.a, move.to.a])
    .filter((angle): angle is number => angle !== undefined)
  assert.ok(Math.max(...unwrappedAngles) > 180 + angleSpan,
    'the region-free control cuts beyond the seam band, so the wrap is what limits it')

  // A rectangle drawn straddling the right edge of the sheet covers both sides
  // of A180 directly, and the wrap must not double-count or drop either half.
  const rightEdge = centre + circumference / 2
  const straddle: SheetRect = {
    alongMin: 0, alongMax: 30,
    acrossMin: rightEdge - 3, acrossMax: rightEdge + 3,
  }
  const straddled = generateRotaryFinish(
    'straddle', cylinderMesh(stock, 4, 3, 27), stock, tool,
    { ...params, region: productionMask(stock, straddle) }, {},
  )
  const straddleAngles = straddled.moves.flatMap((move) => [move.from.a, move.to.a])
    .filter((angle): angle is number => angle !== undefined)
  assert.ok(straddleAngles.some((angle) => angle < 180), 'the seam region cuts on the A<180 side')
  assert.ok(straddleAngles.some((angle) => angle > 180), 'the seam region cuts on the A>180 side')
}

// ── no region: byte-identical output ──────────────────────────────────────

// Captured from the base commit before #1096 existed, with the same fixtures:
// the move array, the warning codes and the real postprocessor's program.
const NO_REGION_HASHES: Record<string, string> = {
  'round/rotary_rough/along': 'moves=57c161faf512400a warnings= gcode=53019c8531aafcfd',
  'round/rotary_rough/around': 'moves=297f1c51c8abcf0c warnings= gcode=24cd956fa939064e',
  'round/rotary_finish/along': 'moves=78362aad6fa56583 warnings=rotaryFinishWithoutRough gcode=0f33efd742ed58e9',
  'round/rotary_finish/around': 'moves=a7ebe0d9cd48dd07 warnings=rotaryFinishWithoutRough gcode=4cb6a2c9c5c1e547',
  'square/rotary_rough/along': 'moves=a45d9f9fbd8bd7e9 warnings= gcode=53c3d57f9a4146bb',
  'square/rotary_rough/around': 'moves=c3306cdb6ed4e634 warnings= gcode=48e6cf9c1aabb32e',
  'square/rotary_finish/along': 'moves=00b76a30aaf6601f warnings=rotaryFinishWithoutRough gcode=755a66621cb1363c',
  'square/rotary_finish/around': 'moves=d1de25da5d3cdede warnings=rotaryFinishWithoutRough gcode=a16b2707bada1bdf',
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

for (const shape of ['round', 'square'] as const) {
  for (const kind of ['rotary_rough', 'rotary_finish'] as const) {
    for (const direction of ['along', 'around'] as const) {
      const base = shape === 'round' ? rotaryOperationFixture('x', kind) : squareProject(kind)
      const operation = { ...base.operations[0], rotaryPassDirection: direction }
      const result = computeOperationToolpath(base, operation)!.result
      const label = `${shape}/${kind}/${direction}`
      const actual = `moves=${hash(JSON.stringify(result.moves))} `
        + `warnings=${result.warnings.map((warning) => warning.code).join(',')} `
        + `gcode=${hash(post(base, operation))}`
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

console.log(`rotary region tests passed (${outsideChecks} region cases, ${turnChecks} square turn cases)`)
