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
 * Square-blank entry and exit: a straight plunge to the first real cut and a
 * straight retract from the last one (#1016 C2-F5).
 *
 * A square blank's retained stub holds the cutter up over the first and last
 * cutter radius of the cut range. Before F5 every finish and rough pass fed
 * those samples to the cutter as an ordinary "cut", so the program plunged to
 * the blank's surface at the range end, fed along it without removing anything,
 * and only then stepped down to the model (the manager's 25 mm reproduction:
 * plunge at x18 to r12.50, ride 18 -> 20.93 at r12.50, cut 20.93 -> 37.07, ride
 * 37.07 -> 40, retract). F5 drops a run's leading and trailing samples that the
 * blank's contact bound proves cut nothing; `emitRotaryRuns` then reaches the
 * kept run through its existing rapid / straight plunge / straight retract.
 *
 * This file proves the three things the change owes:
 *
 * 1. **No end ride survives.** On the manager's 25 mm finish (square 25 x 60,
 *    cylinder r10 along 10..40, default chuck, 6 mm flat, 0.4 mm stepover) and
 *    on the accepted `squareSimulationFixture` ball rough, the first and last
 *    material point of every pass lies strictly below
 *    `squareRotaryTouchRadius` at that pass angle -- the same contact bound the
 *    rough's layer gate uses -- with the generator's 0.001 mm tolerance. On the
 *    25 mm case the whole leading ride is gone (the first material point is
 *    past x20.5), and its move count falls from the captured pre-F5 6992.
 *
 * 2. **The removed material is unchanged.** The old path is rebuilt here from
 *    the *same* exported sampling (`rotaryTargets`), the *same* emitter
 *    (`emitRotaryRuns`) and the *same* collinear merge, with only the trim left
 *    out, and both paths are replayed through the shipped
 *    `computeSimulationResult` at detail 280. The ball fixture's grids are
 *    identical cell for cell. The 25 mm finish has 814 changed cells, each
 *    inside the sampler's own 0.2 mm cell: 770 are where the old ride's flat
 *    bottom over-cut the unrolled sheet at across cells whose square surface
 *    stands above the ride radius (a radius-mapping artefact of the sheet, not
 *    3D material; the old path cut up to 0.0947 mm lower there), and 44 are
 *    where the kept sample sits within the trim tolerance of the contact bound
 *    (the new path cuts up to 0.0023 mm lower). No cell rises above its blank
 *    baseline and no cell changes by more than 0.2 mm, so no real depth of
 *    material moved.
 *
 * 3. **Interior air is not split.** A model with a full-height rib in the middle
 *    leaves a stretch of blank surface *inside* a pass; the trim keeps it (no
 *    retract inside the pass, no bridge over the rib), so only a pass's two ends
 *    are ever shortened.
 *
 * Mutations that must fail (each applied alone and reverted):
 * - trimming applied to interior samples: the rib pass gains a retract between
 *   its first and last material point (or the bridge cuts the rib to r10, which
 *   the rib's simulated top catches);
 * - the threshold taken at the pass-ray radius instead of the contact bound:
 *   the 40 degree corner layer in `squareRotaryRoughAir.test.ts` (a real cut of
 *   blank material the ray misses) is trimmed away, so its witness assertions
 *   fail, and the 25 mm finish also drops real cells this file's simulation
 *   comparison sees;
 * - trimming applied to round bars: the round-bar path no longer equals this
 *   file's untrimmed reference (and `squareRotaryOutput.test.ts`'s captured
 *   round baseline moves).
 *
 * Run with: npx tsx src/engine/toolpaths/squareRotaryEntry.test.ts
 */

import assert from 'node:assert/strict'
import { serializeImportedMesh } from '../importedMesh'
import { buildRotaryCylinder } from '../rotaryCylinder'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { defaultRoundWorkholding } from '../../store/helpers/roundWorkholding'
import { projectWithFeatures } from '../../test/projectFixtures'
import {
  defaultTool,
  newProject,
  rectProfile,
  roundStock,
} from '../../types/project'
import type { BarStock, MachiningSetup, Operation, Project, SketchFeature, SquareStock } from '../../types/project'
import {
  barCentre,
  barMaxRadius,
  barPivotZ,
  isSquareStock,
  squareStock,
} from '../../types/barStock'
import { convertLength } from '../../utils/units'
import { buildSimulationSetupInput } from '../../app/simulationSetup'
import { computeSimulationResult } from '../../app/simulationCompute'
import { squareRotaryProject } from '../../test/squareSimulationFixture'
import { computeOperationToolpath } from './generateOperation'
import { resolveFinishModelSurface } from './finishModelSurface'
import { splitFeatureTargets } from './regions'
import { normalizeToolForProject } from './geometry'
import {
  emitRotaryRuns,
  generateRotaryFinish,
  generateRotaryRough,
  mergeCollinearCuts,
  rotaryAlongRange,
  rotaryTargets,
} from './rotaryModel'
import type { RotaryFinishParams, RotaryModelMesh, RotaryRoughParams, RotaryRun } from './rotaryModel'
import { rotaryTravelZ, squareRotaryTouchRadius } from './squareRotaryStock'
import type { NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import type { ToolpathWarning } from './warningCodes'

const FLAT_6MM: NormalizedTool = {
  id: 'flat-6', name: '6 mm flat end mill', sourceUnits: 'mm', units: 'mm',
  type: 'flat_endmill', diameter: 6, radius: 3, vBitAngle: null,
  flutes: 2, material: 'carbide', defaultRpm: 0, defaultFeed: 0,
  defaultPlungeFeed: 0, defaultStepdown: 0, defaultStepover: 0, maxCutDepth: 0,
}

/** The manager's measured case: 25 mm square, cylinder r10 along 10..40, 6 mm flat, 0.4 mm stepover. */
const ENTRY_STOCK: SquareStock = squareStock(25, 60, 'x', { x: 0, y: -12.5 })
const ENTRY_ALONG_START = 10
const ENTRY_ALONG_END = 40
const ENTRY_CYLINDER_RADIUS = 10

/** F5 trims within the generator's own 0.001 mm merge tolerance (both fixtures are mm). */
const ENTRY_TOLERANCE = convertLength(0.001, 'mm', 'mm')

function near(actual: number, expected: number, label: string, epsilon = 1e-6): void {
  assert(Math.abs(actual - expected) <= epsilon, `${label}: expected ${expected}, got ${actual}`)
}

/** A closed box filling the blank's cross-section over an along span. */
function ribMesh(stock: SquareStock, alongStart: number, alongEnd: number): RotaryModelMesh {
  const centre = barCentre(stock)
  const half = stock.thickness / 2
  const positions: number[] = []
  for (const along of [alongStart, alongEnd]) {
    for (const [across, up] of [[-1, 0], [1, 0], [1, 2], [-1, 2]] as const) {
      positions.push(along, centre + half * across, up === 0 ? 0 : 2 * half)
    }
  }
  const index = new Uint32Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5,
    2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ])
  return { positions: new Float32Array(positions), index }
}

/** The manager's 25 mm finish inputs, exactly as the app derives them. */
function entryFinishCase(): {
  project: Project
  operation: Operation
  setup: MachiningSetup
  stock: SquareStock
  tool: NormalizedTool
  mesh: RotaryModelMesh
  params: RotaryFinishParams
} {
  const project = entryProject()
  const setup = project.setups.find((entry) => entry.id === 'around')!
  const tool = normalizeToolForProject(project.tools[0], project)
  const operation = project.operations[0]
  const surface = resolveFinishModelSurface(project, modelTargets(project, operation))!
  const pivot = barPivotZ(ENTRY_STOCK)
  const maxRadius = barMaxRadius(ENTRY_STOCK)
  const rapidRadius = project.meta.maxTravelZ - pivot
  const stepover = Math.max(operation.stepover * tool.diameter, 1e-3)
  return {
    project, operation, setup, stock: ENTRY_STOCK, tool, mesh: surface.mesh,
    params: {
      stepover,
      stockToLeave: operation.stockToLeaveRadial,
      sampleSpacing: tool.radius / 4,
      requestedCellSize: Math.min(tool.radius / 3, stepover * 0.5),
      alongStart: 18,
      alongEnd: 40,
      safeRadius: rapidRadius > maxRadius ? rapidRadius : maxRadius + tool.diameter,
    },
  }
}

/** The 25 mm project, built the way the app builds a square-to-round job. */
function entryProject(): Project {
  const base = newProject('entry', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.maxTravelZ = 25
  base.meta.projectType = 'rotary'
  base.stock = ENTRY_STOCK
  base.tools = [{
    ...defaultTool('mm', 1),
    id: 't1', name: '6 mm flat', type: 'flat_endmill', diameter: FLAT_6MM.diameter,
    defaultStepover: 0.4, defaultStepdown: 1,
  }]
  const cylinder = buildRotaryCylinder(ENTRY_STOCK, {
    diameter: 2 * ENTRY_CYLINDER_RADIUS,
    alongStart: ENTRY_ALONG_START,
    alongEnd: ENTRY_ALONG_END,
  }, 'mm')
  base.modelAssets = { asset: serializeImportedMesh(cylinder, 'stl') }
  const model: SketchFeature = {
    id: 'model', name: 'Model', kind: 'stl', operation: 'model', authoringFace: 'top', folderId: null,
    sketch: {
      profile: rectProfile(ENTRY_ALONG_START, -12.5, ENTRY_ALONG_END - ENTRY_ALONG_START, 25),
      origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [],
    },
    stl: { format: 'stl', meshAssetId: 'asset', scale: 1, axisSwap: 'none' },
    z_top: cylinder.bounds.maxZ, z_bottom: cylinder.bounds.minZ, visible: true, locked: false,
  }
  const project = projectWithFeatures(base, [model])
  project.setups.push({
    ...project.setups[0],
    id: 'around', name: 'Around', kind: 'around', orientation: { axis: 'x', angleDeg: 0 },
  })
  project.activeSetupId = 'around'
  // The app's default chuck: x -40..15 on this blank, so `rotaryAlongRange`
  // starts the cut at 15 + 3 and ends it at the cylinder's own end.
  project.clamps = [{
    ...defaultRoundWorkholding('chuck', ENTRY_STOCK, 'mm'),
    id: 'chuck', name: 'Chuck', visible: true,
  }]
  const operation: Operation = {
    ...defaultOperationForTarget(project, 'rotary_finish', 'finish', { source: 'features', featureIds: ['model'] }, 0),
    setupId: 'around',
    stockToLeaveRadial: 0,
    stepover: 0.4 / FLAT_6MM.diameter,
  }
  project.operations = [operation]
  return project
}

/**
 * The pre-F5 finish path: the loop `generateRotaryFinish` runs today with the
 * end trim left out. It shares `rotaryTargets` and `emitRotaryRuns` with the
 * generator, so the only difference between the two paths is F5 itself.
 */
function legacyFinishPath(mesh: RotaryModelMesh, stock: BarStock, tool: NormalizedTool, params: RotaryFinishParams): ToolpathMove[] {
  const warnings: ToolpathWarning[] = []
  const sampling = rotaryTargets('legacy', mesh, stock, tool, params, {}, warnings)
  if (sampling.refusal || sampling.stopped) throw new Error('legacy finish: the fixture samples')
  const { angles, along } = sampling
  const pivot = barPivotZ(stock)
  const centre = barCentre(stock)
  const travelZ = rotaryTravelZ(stock, tool.units)
  const safeZ = Math.max(pivot + params.safeRadius, travelZ)
  const rowIndexAt = (pass: number, positionIndex: number): number =>
    pass % 2 === 0 ? positionIndex : along.length - 1 - positionIndex
  const tipAt = (pass: number, positionIndex: number): number => sampling.tips[pass][rowIndexAt(pass, positionIndex)]
  const alongAt = (pass: number, positionIndex: number): number => along[rowIndexAt(pass, positionIndex)]
  const point = (alongPosition: number, tip: number, angle: number): ToolpathPoint => stock.axis === 'x'
    ? { x: alongPosition, y: centre, z: pivot + tip, a: angle }
    : { x: centre, y: alongPosition, z: pivot + tip, a: angle }
  const moves: ToolpathMove[] = []
  let here: ToolpathPoint | undefined
  let previousEndedAtEnd = false
  for (let k = 0; k < angles.length; k++) {
    const runs: RotaryRun[] = []
    let i = 0
    while (i < along.length) {
      if (!Number.isFinite(tipAt(k, i))) { i++; continue }
      const start = i
      while (i + 1 < along.length && Number.isFinite(tipAt(k, i + 1))) i++
      const end = i
      const points: ToolpathPoint[] = []
      for (let j = start; j <= end; j++) points.push(point(alongAt(k, j), tipAt(k, j), angles[k]))
      runs.push({ points, atStart: start === 0, atEnd: end === along.length - 1 })
      i++
    }
    const emitted = emitRotaryRuns(moves, here, runs, safeZ, travelZ, previousEndedAtEnd)
    here = emitted.here
    previousEndedAtEnd = emitted.endedAtEnd
  }
  if (here) moves.push({ kind: 'rapid', from: here, to: { ...here, z: safeZ } })
  return mergeCollinearCuts(moves, ENTRY_TOLERANCE).moves
}

/** The pre-F5 rough path: the same layer loop, with no end trim. */
function legacyRoughPath(mesh: RotaryModelMesh, stock: BarStock, tool: NormalizedTool, params: RotaryRoughParams): ToolpathMove[] {
  const warnings: ToolpathWarning[] = []
  const sampling = rotaryTargets('legacy', mesh, stock, tool, params, {}, warnings)
  if (sampling.refusal || sampling.stopped) throw new Error('legacy rough: the fixture samples')
  const tips = sampling.tips.map((row) => row.map((tip) => Number.isFinite(tip) ? tip : 0))
  const { angles, along } = sampling
  const pivot = barPivotZ(stock)
  const maxRadius = barMaxRadius(stock)
  const centre = barCentre(stock)
  const travelZ = rotaryTravelZ(stock, tool.units)
  const safeZ = Math.max(pivot + params.safeRadius, travelZ)
  let lowest = maxRadius
  for (const row of tips) for (const tip of row) lowest = Math.min(lowest, tip)
  const layers = Math.ceil((maxRadius - lowest) / params.stepdown)
  const moves: ToolpathMove[] = []
  let here: ToolpathPoint | undefined
  const point = (position: number, tip: number, angle: number): ToolpathPoint => stock.axis === 'x'
    ? { x: position, y: centre, z: pivot + tip, a: angle }
    : { x: centre, y: position, z: pivot + tip, a: angle }
  for (let layer = 1; layer <= layers; layer++) {
    const previousRadius = maxRadius - (layer - 1) * params.stepdown
    const layerRadius = Math.max(lowest, maxRadius - layer * params.stepdown)
    let previousEndedAtEnd = false
    for (let pass = 0; pass < angles.length; pass++) {
      const angle = angles[pass] + (layer - 1) * 360
      const touchesMaterial = !isSquareStock(stock)
        || layerRadius < squareRotaryTouchRadius(stock, angle, tool.radius, tool.type)
      const indexAt = (i: number): number => pass % 2 === 0 ? i : along.length - 1 - i
      const needsCut = (i: number): boolean => touchesMaterial && tips[pass][indexAt(i)] < previousRadius
      const at = (i: number): ToolpathPoint => point(along[indexAt(i)], Math.max(tips[pass][indexAt(i)], layerRadius), angle)
      const runs: RotaryRun[] = []
      let i = 0
      while (i < along.length) {
        if (!needsCut(i)) { i++; continue }
        const start = i
        while (i + 1 < along.length && needsCut(i + 1)) i++
        const end = i
        const points: ToolpathPoint[] = []
        for (let j = start; j <= end; j++) points.push(at(j))
        runs.push({ points, atStart: start === 0, atEnd: end === along.length - 1 })
        i++
      }
      const emitted = emitRotaryRuns(moves, here, runs, safeZ, travelZ, previousEndedAtEnd)
      here = emitted.here
      previousEndedAtEnd = emitted.endedAtEnd
    }
  }
  if (here) moves.push({ kind: 'rapid', from: here, to: { ...here, z: safeZ } })
  return mergeCollinearCuts(moves, ENTRY_TOLERANCE).moves
}

interface PassEnds {
  first: ToolpathPoint
  last: ToolpathPoint
}

/** First and last material point of every pass, keyed by its program angle. */
function materialEnds(moves: readonly ToolpathMove[], pivot: number, maxRadius: number): Map<number, PassEnds> {
  const ends = new Map<number, PassEnds>()
  for (const move of moves) {
    for (const point of [move.from, move.to]) {
      if (point.a === undefined) continue
      if (point.z - pivot > maxRadius + 1e-9) continue
      const entry = ends.get(point.a)
      if (entry === undefined) ends.set(point.a, { first: point, last: point })
      else entry.last = point
    }
  }
  return ends
}

/** The moves of one program angle, in emission order. */
function passMoves(moves: readonly ToolpathMove[], angle: number): ToolpathMove[] {
  return moves.filter((move) => move.from.a === angle && move.to.a === angle)
}

function toolpathResult(operationId: string, moves: ToolpathMove[]): ToolpathResult {
  return { operationId, moves, warnings: [], bounds: null }
}

/** The shipped simulation result for one path, exactly as the app builds it. */
function simulatePath(
  project: Project,
  operation: Operation,
  setup: MachiningSetup,
  moves: ToolpathMove[],
): ReturnType<typeof computeSimulationResult> {
  const paths = new Map([[operation.id, toolpathResult(operation.id, moves)]])
  const input = buildSimulationSetupInput(project, setup, paths)
  assert(input, 'the entry fixture yields a simulation input')
  if (!input) throw new Error('unreachable')
  return computeSimulationResult({
    setupInput: input,
    project,
    simulationMode: 'visible',
    simulationDetailCells: 280,
    selectedInSetup: operation,
    paths,
  })
}

// ---------------------------------------------------------------------------
// 1. The measured 25 mm finish: the ride is gone, the ends are real cuts
// ---------------------------------------------------------------------------

function testMeasuredFinish(): { project: Project; operation: Operation; setup: MachiningSetup; oldMoves: ToolpathMove[]; newMoves: ToolpathMove[] } {
  console.log('Testing the 25 mm finish starts and ends each pass at real cuts...')
  const { project, operation, setup, stock, tool, mesh, params } = entryFinishCase()
  const appPath = computeOperationToolpath(project, operation)
  assert(appPath, 'the app dispatch answers for the 25 mm finish')
  if (!appPath) throw new Error('unreachable')
  const direct = generateRotaryFinish(operation.id, mesh, stock, tool, params, {})
  assert.deepEqual(direct.moves, appPath.result.moves, 'the fixture params reproduce the app path')

  const pivot = barPivotZ(stock)
  const maxRadius = barMaxRadius(stock)
  const tolerance = ENTRY_TOLERANCE
  assert.equal(params.alongStart, 18, 'the default chuck starts the cut at 18')
  assert.equal(params.alongEnd, 40, 'the cut ends at the cylinder end')

  const ends = materialEnds(direct.moves, pivot, maxRadius)
  assert.equal(ends.size, 278, 'every one of the 278 pass angles cuts the cylinder')
  let checked = 0
  for (const [angle, entry] of ends) {
    const touch = squareRotaryTouchRadius(stock, angle, tool.radius, tool.type)
    for (const point of [entry.first, entry.last]) {
      const radius = point.z - pivot
      checked++
      assert(radius < touch - tolerance,
        `pass ${angle}: a ${radius} tip at the pass end is not a real cut (blank contact ${touch})`)
    }
  }
  assert.ok(checked > 0, 'the end assertions walk real passes')

  // The whole leading ride at A0 (18..20.93 at r12.50) is gone, not one sample.
  const zero = ends.get(0)
  assert(zero, 'the A0 pass exists')
  if (zero) {
    assert(zero.first.x > 20.5, `the A0 ride is trimmed to its first real cut (first x ${zero.first.x})`)
    near(zero.first.z - pivot, 10, 'the first A0 cut is the cylinder radius', 0.002)
    assert(zero.last.x < 37.5, `the A0 trailing ride is trimmed too (last x ${zero.last.x})`)
    const a0 = passMoves(direct.moves, 0)
    assert.equal(a0.filter((move) => move.kind === 'plunge').length, 1, 'A0 gets one straight plunge')
    assert.equal(a0.filter((move) => move.kind === 'rapid').length, 2, 'A0 retracts at both ends')
  }

  const oldMoves = legacyFinishPath(mesh, stock, tool, params)
  const oldEnds = materialEnds(oldMoves, pivot, maxRadius)
  const oldZero = oldEnds.get(0)
  assert(oldZero, 'the pre-F5 A0 pass exists')
  if (oldZero) {
    near(oldZero.first.x, 18, 'the old A0 pass rode the blank from x18', 1e-9)
    near(oldZero.first.z - pivot, 12.5, 'the old ride sat on the blank surface', 1e-4)
  }
  // The captured pre-F5 app path for this fixture, recomputed by the reference.
  assert.equal(oldMoves.length, 6992, 'the pre-F5 reference reproduces the captured 6992 moves')
  assert(direct.moves.length < oldMoves.length, `the trim removes moves (${direct.moves.length} < ${oldMoves.length})`)
  console.log(`  ${ends.size} passes, ${checked} ends checked; moves ${oldMoves.length} -> ${direct.moves.length}`)
  return { project, operation, setup, oldMoves, newMoves: direct.moves }
}

// ---------------------------------------------------------------------------
// 2. The accepted ball rough: the same end guarantee, and the same material
// ---------------------------------------------------------------------------

function testBallRough(): { project: Project; operation: Operation; setup: MachiningSetup; oldMoves: ToolpathMove[]; newMoves: ToolpathMove[] } {
  console.log('Testing the accepted ball rough starts and ends every pass at real cuts...')
  const { project, operation, setup } = squareRotaryProject('x')
  const stock = project.stock
  assert(isSquareStock(stock), 'the accepted fixture is a square blank')
  if (!isSquareStock(stock)) throw new Error('unreachable')
  const tool = normalizeToolForProject(project.tools[0], project)
  const surface = resolveFinishModelSurface(project, modelTargets(project, operation))!
  const range = rotaryAlongRange(stock, project.clamps, alongRangeOf(surface.mesh, stock), tool, {
    chuckEnd: operation.rotaryChuckSupport ?? 0,
    tailEnd: operation.rotaryTailSupport ?? 0,
  })
  assert(range, 'the accepted fixture has a cut range')
  if (!range) throw new Error('unreachable')
  const pivot = barPivotZ(stock)
  const maxRadius = barMaxRadius(stock)
  const rapidRadius = project.meta.maxTravelZ - pivot
  const stepover = Math.max(operation.stepover * tool.diameter, 1e-3)
  const params: RotaryRoughParams = {
    stepdown: operation.stepdown,
    stockToLeave: operation.stockToLeaveRadial,
    stepover,
    sampleSpacing: tool.radius / 2,
    requestedCellSize: Math.min(tool.radius / 3, stepover * 0.5),
    alongStart: range.start,
    alongEnd: range.end,
    safeRadius: rapidRadius > maxRadius ? rapidRadius : maxRadius + tool.diameter,
  }
  const appPath = computeOperationToolpath(project, operation)
  assert(appPath, 'the app dispatch answers for the ball rough')
  if (!appPath) throw new Error('unreachable')
  const direct = generateRotaryRough(operation.id, surface.mesh, stock, tool, params, {})
  assert.deepEqual(direct.moves, appPath.result.moves, 'the fixture params reproduce the accepted app path')

  const tolerance = ENTRY_TOLERANCE
  const ends = materialEnds(direct.moves, pivot, maxRadius)
  assert(ends.size > 0, 'the ball rough has cutting passes')
  let checked = 0
  let trimmedEnds = 0
  const oldMoves = legacyRoughPath(surface.mesh, stock, tool, params)
  const oldEnds = materialEnds(oldMoves, pivot, maxRadius)
  for (const [angle, entry] of ends) {
    const touch = squareRotaryTouchRadius(stock, angle, tool.radius, tool.type)
    for (const point of [entry.first, entry.last]) {
      const radius = point.z - pivot
      checked++
      assert(radius < touch - tolerance,
        `ball pass ${angle}: a ${radius} tip at the pass end is not a real cut (blank contact ${touch})`)
    }
    const oldEntry = oldEnds.get(angle)
    if (oldEntry) {
      const oldFirst = oldEntry.first.z - pivot
      const oldTouch = squareRotaryTouchRadius(stock, angle, tool.radius, tool.type)
      if (oldFirst >= oldTouch - tolerance) trimmedEnds++
    }
  }
  assert(trimmedEnds > 0, 'the pre-F5 ball rough actually ended passes on the blank')
  assert.ok(checked > 0, 'the ball end assertions walk real passes')
  assert.equal(oldMoves.length, 2169, 'the pre-F5 reference reproduces the captured 2169 moves')
  assert(direct.moves.length < oldMoves.length, `the trim removes moves (${direct.moves.length} < ${oldMoves.length})`)
  console.log(`  ${ends.size} passes, ${checked} ends checked, ${trimmedEnds} blank-riding ends gone; `
    + `moves ${oldMoves.length} -> ${direct.moves.length}`)
  return { project, operation, setup, oldMoves, newMoves: direct.moves }
}

/** The stl model features an operation targets, as `generateRotaryOperation` reads them. */
function modelTargets(project: Project, operation: Operation): SketchFeature[] {
  const featureIds = operation.target.source === 'features' ? operation.target.featureIds : []
  return splitFeatureTargets(project, featureIds)
    .machiningFeatures.filter((feature) => feature.kind === 'stl' && feature.operation === 'model')
}

/** The model's along extent, as `generateRotaryOperation` reads it. */
function alongRangeOf(mesh: RotaryModelMesh, stock: BarStock): { min: number; max: number } {
  const axisIndex = stock.axis === 'x' ? 0 : 1
  let min = Infinity
  let max = -Infinity
  for (let i = axisIndex; i < mesh.positions.length; i += 3) {
    min = Math.min(min, mesh.positions[i])
    max = Math.max(max, mesh.positions[i])
  }
  return { min, max }
}

// ---------------------------------------------------------------------------
// 3. The removed material is unchanged, through the shipped simulation
// ---------------------------------------------------------------------------

function compareSimulatedMaterial(
  label: string,
  project: Project,
  operation: Operation,
  setup: MachiningSetup,
  oldMoves: ToolpathMove[],
  newMoves: ToolpathMove[],
  options: { requireIdentical: boolean; differenceBound: number },
): { changedCells: number; oldCutMore: number; newCutMore: number; deepest: number; deepestNew: number } {
  const before = simulatePath(project, operation, setup, oldMoves)
  const after = simulatePath(project, operation, setup, newMoves)
  assert.equal(after.grid.topZ.length, before.grid.topZ.length, `${label}: same grid size`)
  const baseline = after.grid.initialTopZ
  assert(baseline, `${label}: a square grid carries its immutable baseline`)
  if (!baseline) throw new Error('unreachable')
  assert(after.stats.removedCellCount > 0, `${label}: the new path removes material`)
  let changed = 0
  let oldCutMore = 0
  let newCutMore = 0
  let deepest = 0
  let deepestNew = 0
  for (let index = 0; index < after.grid.topZ.length; index++) {
    const now = after.grid.topZ[index]
    const then = before.grid.topZ[index]
    assert(now <= baseline[index] + 1e-9, `${label}: cell ${index} rises above its blank baseline`)
    if (now === then) continue
    changed++
    const difference = then - now
    if (difference > 0) {
      // The old path cut this cell lower: the removed ride's over-cut.
      newCutMore++
      deepestNew = Math.max(deepestNew, difference)
    } else {
      // The kept sample sat slightly under the contact bound.
      oldCutMore++
      deepest = Math.max(deepest, -difference)
    }
    // Every difference is inside the sampler's own cell (0.2 mm on the 25 mm
    // case): the old ride's flat bottom over-cut the unrolled sheet at across
    // cells whose square surface stands above the ride radius, and a kept
    // sample may sit the trim tolerance under the contact bound. Neither is a
    // real depth of material; a trimmed *real* cut -- the ray-threshold
    // mutation -- would show up here at the height of the shoulder it skipped.
    assert(Math.abs(difference) <= options.differenceBound,
      `${label}: cell ${index} changes by ${difference}, beyond the sampler-cell bound ${options.differenceBound}`)
  }
  if (options.requireIdentical) {
    assert.equal(changed, 0, `${label}: the simulated material is identical cell for cell (${changed} differ)`)
  }
  console.log(`  ${label}: ${changed} cells changed, old cut more by <= ${deepest.toFixed(4)} mm, `
    + `new cut more by <= ${deepestNew.toFixed(4)} mm`)
  return { changedCells: changed, oldCutMore, newCutMore, deepest, deepestNew }
}

// ---------------------------------------------------------------------------
// 4. Interior air is kept: only the pass's two ends are shortened
// ---------------------------------------------------------------------------

function testInteriorRideKept(): void {
  console.log('Testing an interior blank-surface stretch is kept, never split...')
  const stock = ENTRY_STOCK
  const cylinder = buildRotaryCylinder(stock, {
    diameter: 2 * ENTRY_CYLINDER_RADIUS, alongStart: ENTRY_ALONG_START, alongEnd: ENTRY_ALONG_END,
  }, 'mm')
  const rib = ribMesh(stock, 25, 30)
  const positions = new Float32Array(cylinder.positions.length + rib.positions.length)
  positions.set(cylinder.positions)
  positions.set(rib.positions, cylinder.positions.length)
  const vertexOffset = cylinder.positions.length / 3
  const index = new Uint32Array(cylinder.index.length + rib.index.length)
  index.set(cylinder.index)
  for (let i = 0; i < rib.index.length; i++) index[cylinder.index.length + i] = rib.index[i] + vertexOffset
  const mesh: RotaryModelMesh = { positions, index }
  const params: RotaryFinishParams = {
    stepover: 0.4, stockToLeave: 0, sampleSpacing: 0.75,
    requestedCellSize: 0.2, alongStart: 18, alongEnd: 40, safeRadius: 23.677,
  }
  const result = generateRotaryFinish('rib', mesh, stock, FLAT_6MM, params, {})
  const a0 = passMoves(result.moves, 0)
  assert(a0.length > 3, 'the rib fixture has an A0 pass')
  const materialIndexes = a0
    .map((move, index) => ({ move, index }))
    .filter(({ move }) => move.kind !== 'rapid')
  assert(materialIndexes.length > 0, 'the A0 pass cuts')
  const first = materialIndexes[0].index
  const last = materialIndexes[materialIndexes.length - 1].index
  const between = a0.slice(first, last + 1)
  assert(between.every((move) => move.kind === 'cut' || move.kind === 'plunge'),
    'no retract splits an interior blank-surface stretch')
  assert(between.filter((move) => move.kind === 'plunge').length === 1,
    'the A0 pass plunges exactly once')
  const pivot = barPivotZ(stock)
  assert(between.some((move) => move.to.z - pivot > 12.4),
    'the rib is still visited at the blank surface')
  console.log(`  A0: ${a0.length} moves, ${between.length} from the first cut to the last, no interior retract`)
}

// ---------------------------------------------------------------------------
// 5. Round bars are untouched: the production path equals the untrimmed one
// ---------------------------------------------------------------------------

function testRoundBarUntouched(): void {
  console.log('Testing a round bar keeps the untrimmed path byte for byte...')
  const round = roundStock(25, 60, 'x', { x: 0, y: -12.5 })
  const mesh: RotaryModelMesh = buildRotaryCylinder(
    squareStock(25, 60, 'x', { x: 0, y: -12.5 }),
    { diameter: 20, alongStart: 10, alongEnd: 40 },
    'mm',
  )
  const params: RotaryFinishParams = {
    stepover: 0.4, stockToLeave: 0, sampleSpacing: 0.75,
    requestedCellSize: 0.2, alongStart: 18, alongEnd: 40, safeRadius: 23.677,
  }
  const result = generateRotaryFinish('round', mesh, round, FLAT_6MM, params, {})
  const legacy = legacyFinishPath(mesh, round, FLAT_6MM, params)
  assert.deepEqual(result.moves, legacy, 'a round bar is never trimmed')
  console.log(`  round finish ${result.moves.length} moves, identical to the untrimmed reference`)
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const entry = testMeasuredFinish()
  const ball = testBallRough()
  testInteriorRideKept()
  testRoundBarUntouched()

  console.log('Testing the removed material is unchanged through computeSimulationResult...')
  const finish = compareSimulatedMaterial(
    '25 mm finish', entry.project, entry.operation, entry.setup, entry.oldMoves, entry.newMoves,
    { requireIdentical: false, differenceBound: 0.2 },
  )
  const rough = compareSimulatedMaterial(
    'accepted ball rough', ball.project, ball.operation, ball.setup, ball.oldMoves, ball.newMoves,
    { requireIdentical: true, differenceBound: 0.5 },
  )

  // The reference above recomputes the pre-F5 path (and pins its captured
  // counts). The new path must beat it by a margin, not just tie: each trimmed
  // ride is several moves.
  assert(entry.newMoves.length <= entry.oldMoves.length - 20,
    `the 25 mm finish drops moves by more than 20 (${entry.oldMoves.length} -> ${entry.newMoves.length})`)
  assert(ball.newMoves.length <= ball.oldMoves.length - 150,
    `the ball rough drops moves by more than 150 (${ball.oldMoves.length} -> ${ball.newMoves.length})`)
  console.log(`  moves: 25 mm finish ${entry.oldMoves.length} -> ${entry.newMoves.length}; `
    + `ball rough ${ball.oldMoves.length} -> ${ball.newMoves.length}`)
  console.log(`  simulated material: 25 mm finish ${finish.changedCells} cells differ `
    + `(${finish.oldCutMore} where the old ride cut more, ${finish.newCutMore} where the kept sample cut more), `
    + `ball rough ${rough.changedCells} (identical)`)
  console.log('square rotary entry tests passed')
}

try {
  main()
} catch (error: unknown) {
  console.error(error instanceof Error ? error.message : error)
  throw error
}
