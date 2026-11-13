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
 * Clearing a Top or Bottom face of a bar skips the air beside it (#1054
 * slice 3).
 *
 * A round bar is narrower near its crown, so the old clearing pass cut the
 * feature's whole XY footprint at every level — most of that path in air
 * beside the bar. The approved plan intersects each clearing level with the
 * bar's real horizontal section, and starts the first entry from the bar's
 * surface over its region instead of from the box top. The clip is on the
 * **material** region, before the generator insets by the cutter radius, so
 * the pocket's own walls do not move and the surface clean pass keeps its
 * existing "tool centre one radius outside the material" semantics.
 *
 * ## The independent reference
 *
 * `barSectionHalfWidth` is the analytic section `sqrt(R^2 - (z - pivot)^2)`
 * computed here from the stock's own dimensions, never from
 * `src/engine/toolpaths/barSection.ts`. A cut move whose tool centre falls
 * outside that half-width at its own Z is a pass through air. `surfaceAt` is
 * the analytic bar surface at a point, used to check the entry start.
 *
 * The "before" reference is a **square blank of the same box** (or a milling
 * block): a square's section is the full side at every Z, so the generator's
 * output there is the pre-change output byte for byte — the base worktree
 * produces the identical `BASE_CLEARING_HASH` for a round bar, a square blank
 * and a block on this fixture. That gives a real before/after move count
 * without a stale golden, and pins the block/square path as unchanged.
 *
 * ## Mutations this file bites
 *
 * - **skip the section clip** (`barSectionAtZ` returns `null`): the round
 *   pocket and surface clean cut straight through the air beside the bar, and
 *   the air assertions fail with hundreds of points;
 * - **start every entry at the box top** (drop the level-0 `barEntryStartZ`):
 *   the first descent still begins at safe Z, and the entry assertion fails;
 * - **drop the cutter radius** from `barEntryStartZ` (find the surface at the
 *   tool centre only): the entry starts below the material under its rim, and
 *   the footprint assertion fails;
 * - **clip the tool-centre region instead of the material region**: the pocket
 *   wall moves a cutter radius inward, and the floor/wall comparison fails;
 * - **apply the clip to a square blank or a block** (`barSectionAtZ` stops
 *   returning `null` for them): the frozen clearing hashes fail.
 *
 * Run with: npx tsx src/engine/toolpaths/barSkipAir.test.ts
 */

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  defaultTool,
  getStockBounds,
  newProject,
  rectProfile,
  roundStock,
} from '../../types/project'
import type { Point, Project, Stock, StockAxis } from '../../types/project'
import { squareStock } from '../../types/barStock'
import { projectWithFeatures, withBottomSetup } from '../../test/projectFixtures'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { syncProjectSetups } from '../../store/helpers/setups'
import { getOperationSafeZ } from './geometry'
import { computeOperationToolpath } from './generateOperation'
import { computeMeshBounds, serializeImportedMesh } from '../importedMesh'
import type { SketchFeature } from '../../types/project'
import type { ToolpathMove, ToolpathPoint, ToolpathResult } from './types'

function assertTrue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(actual: number, expected: number, tolerance: number, label: string): void {
  assertTrue(Math.abs(actual - expected) <= tolerance, `${label}: got ${actual}, expected ${expected} +- ${tolerance}`)
}

/**
 * The frozen clearing output of this fixture's block/square path — the base
 * worktree's value, shared there by a round bar, a square blank and a block.
 * Pinned so the "no bar section" path cannot drift.
 */
const BASE_CLEARING_HASH: Record<string, string> = {
  'mm:x': '9f1459f84507bd1f',
  'mm:y': 'bfe938c039d480a8',
  'inch:x': 'ec198655025cbeaa',
  'inch:y': 'b66a661856a11d87',
}

function baseClearingHash(units: 'mm' | 'inch', axis: StockAxis): string {
  return BASE_CLEARING_HASH[`${units}:${axis}`]
}

function moveHash(result: ToolpathResult): string {
  return createHash('sha256').update(JSON.stringify(result.moves)).digest('hex').slice(0, 16)
}

// ── Fixtures ──────────────────────────────────────────────────

interface FixtureGeometry {
  diameter: number
  length: number
  toolDiameter: number
  stepdown: number
  acrossMin: number
  acrossMax: number
  alongMin: number
  alongMax: number
}

/** Scaled so the mm and inch cases are the same shape, not two shapes. */
function fixtureGeometry(units: 'mm' | 'inch'): FixtureGeometry {
  return units === 'mm'
    ? { diameter: 40, length: 120, toolDiameter: 6, stepdown: 2, acrossMin: 2, acrossMax: 38, alongMin: 20, alongMax: 80 }
    : { diameter: 1.5, length: 4, toolDiameter: 0.25, stepdown: 0.075, acrossMin: 0.1, acrossMax: 1.4, alongMin: 0.8, alongMax: 3.2 }
}

type Shape = 'round' | 'square' | 'block'

function stockFor(shape: Shape, fixture: FixtureGeometry, axis: StockAxis, units: 'mm' | 'inch'): Stock {
  if (shape === 'round') return roundStock(fixture.diameter, fixture.length, axis)
  if (shape === 'square') return squareStock(fixture.diameter, fixture.length, axis)
  const width = axis === 'x' ? fixture.length : fixture.diameter
  const height = axis === 'x' ? fixture.diameter : fixture.length
  return { ...newProject('stock', units).stock, profile: rectProfile(0, 0, width, height), thickness: fixture.diameter }
}

interface PocketFixtureOptions {
  units: 'mm' | 'inch'
  axis: StockAxis
  shape: Shape
  face: 'top' | 'bottom'
  pass: 'rough' | 'finish'
  /** A helix entry makes the descent's start Z observable; a plunge has none. */
  helixEntry?: boolean
  /** Across coordinates override, for the off-centre entry fixture. */
  across?: { min: number; max: number }
  zSpan?: { top: number; bottom: number }
  stepdown?: number
}

function pocketProject(options: PocketFixtureOptions): Project {
  const fixture = fixtureGeometry(options.units)
  const base = newProject(`bar-skip-air-${options.face}`, options.units)
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  if (options.shape !== 'block') base.meta.projectType = 'rotary'
  base.stock = stockFor(options.shape, fixture, options.axis, options.units)
  base.tools = [{ ...defaultTool(options.units, 1), id: 't1', name: 'Flat', diameter: fixture.toolDiameter, maxCutDepth: fixture.diameter }]
  const across = options.across ?? { min: fixture.acrossMin, max: fixture.acrossMax }
  const span = options.zSpan ?? (options.face === 'top'
    ? { top: fixture.diameter, bottom: fixture.diameter / 2 }
    : { top: fixture.diameter / 2, bottom: 0 })
  const profile = options.axis === 'x'
    ? rectProfile(fixture.alongMin, across.min, fixture.alongMax - fixture.alongMin, across.max - across.min)
    : rectProfile(across.min, fixture.alongMin, across.max - across.min, fixture.alongMax - fixture.alongMin)
  const pocket: SketchFeature = {
    id: 'pocket',
    name: 'Pocket',
    kind: 'rect',
    folderId: null,
    sketch: { profile, origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    operation: 'subtract',
    z_top: span.top,
    z_bottom: span.bottom,
    visible: true,
    locked: false,
    authoringFace: options.face,
  }
  const project = projectWithFeatures(base, [pocket])
  const operation = defaultOperationForTarget(project, 'pocket', options.pass, { source: 'features', featureIds: ['pocket'] }, 0)
  operation.stepdown = options.stepdown ?? fixture.stepdown
  operation.stepover = 0.4
  if (options.helixEntry) {
    operation.entryStrategy = 'helix'
    operation.entryRampAngle = 5
  }
  project.operations = [operation]
  const synced = syncProjectSetups(project)
  return options.face === 'bottom'
    ? withBottomSetup(synced, { axis: options.axis, operationIds: [operation.id] })
    : synced
}

function surfaceCleanProject(shape: Shape): Project {
  const fixture = fixtureGeometry('mm')
  const base = newProject('bar-skip-air-surface', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  base.stock = stockFor(shape, fixture, 'x', 'mm')
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Flat', diameter: fixture.toolDiameter, maxCutDepth: fixture.diameter }]
  const boss: SketchFeature = {
    id: 'boss',
    name: 'Boss',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(fixture.alongMin, fixture.acrossMin, fixture.alongMax - fixture.alongMin, fixture.acrossMax - fixture.acrossMin),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: fixture.diameter - 4,
    z_bottom: 0,
    visible: true,
    locked: false,
    authoringFace: 'top',
  }
  const project = projectWithFeatures(base, [boss])
  const operation = defaultOperationForTarget(project, 'surface_clean', 'rough', { source: 'features', featureIds: ['boss'] }, 0)
  operation.stepdown = 1
  operation.stepover = 0.4
  project.operations = [operation]
  return syncProjectSetups(project)
}

function boxMesh(minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number) {
  const positions = new Float32Array([
    minX, minY, minZ, maxX, minY, minZ, maxX, maxY, minZ, minX, maxY, minZ,
    minX, minY, maxZ, maxX, minY, maxZ, maxX, maxY, maxZ, minX, maxY, maxZ,
  ])
  const index = new Uint32Array([
    0, 1, 2, 0, 2, 3, 4, 6, 5, 4, 7, 6,
    0, 4, 5, 0, 5, 1, 1, 5, 6, 1, 6, 2,
    2, 6, 7, 2, 7, 3, 3, 7, 4, 3, 4, 0,
  ])
  return serializeImportedMesh({ positions, index, bounds: computeMeshBounds(positions) }, 'stl')
}

function roughSurfaceProject(shape: Shape): Project {
  const diameter = 20
  const base = newProject('bar-skip-air-rough', 'mm')
  base.meta.created = base.meta.modified = '2026-01-01T00:00:00.000Z'
  base.meta.projectType = 'rotary'
  base.stock = shape === 'round' ? roundStock(diameter, 30, 'x') : squareStock(diameter, 30, 'x')
  base.tools = [{ ...defaultTool('mm', 1), id: 't1', name: 'Flat', diameter: 2, maxCutDepth: diameter }]
  base.modelAssets = { asset: boxMesh(8, 16, 2, 8, 2, 10) }
  const model: SketchFeature = {
    id: 'model',
    name: 'Model',
    kind: 'stl',
    operation: 'model',
    authoringFace: 'top',
    folderId: null,
    sketch: { profile: rectProfile(8, 2, 8, 6), origin: { x: 0, y: 0 }, orientationAngle: 0, dimensions: [], constraints: [] },
    stl: { format: 'stl', meshAssetId: 'asset', scale: 1, axisSwap: 'none' },
    z_top: 10,
    z_bottom: 2,
    visible: true,
    locked: false,
  }
  const project = projectWithFeatures(base, [model])
  const operation = defaultOperationForTarget(project, 'rough_surface', 'rough', { source: 'features', featureIds: ['model'] }, 0)
  operation.stepdown = 1
  operation.stepover = 0.4
  project.operations = [operation]
  return syncProjectSetups(project)
}

function generate(project: Project): ToolpathResult {
  const envelope = computeOperationToolpath(project, project.operations[0])
  assertTrue(envelope, 'the operation kind is generated')
  return envelope.result
}

// ── The independent analytic reference ────────────────────────

function acrossOf(axis: StockAxis, point: { x: number; y: number }): number {
  return axis === 'x' ? point.y : point.x
}

/** The stock's centreline across the bar — or across the block, which has none. */
function centreAcross(stock: Stock, axis: StockAxis): number {
  const bounds = getStockBounds(stock)
  return axis === 'x' ? (bounds.minY + bounds.maxY) / 2 : (bounds.minX + bounds.maxX) / 2
}

/** `sqrt(R^2 - (z - pivot)^2)`, or the full side for a square blank. */
function barSectionHalfWidth(stock: Stock, z: number): number {
  const halfSide = stock.thickness / 2
  if (stock.shape !== 'round') return halfSide
  const dz = z - halfSide
  const remaining = halfSide * halfSide - dz * dz
  return remaining > 0 ? Math.sqrt(remaining) : 0
}

/** The bar's surface height at a point: `pivot + sqrt(R^2 - (across - centre)^2)`. */
function surfaceAt(stock: Stock, axis: StockAxis, point: { x: number; y: number }): number {
  const halfSide = stock.thickness / 2
  if (stock.shape !== 'round') return stock.thickness
  const distance = Math.abs(acrossOf(axis, point) - centreAcross(stock, axis))
  return halfSide + Math.sqrt(Math.max(0, halfSide * halfSide - distance * distance))
}

/**
 * The highest bar surface under a cutter of `cutterRadius` centred at `point`
 * (#1054 fix 1, finding 5): the rim reaches the radius towards the centreline,
 * so the surface there is the analytic surface at
 * `max(0, |across - centre| - radius)`. Written from the stock's dimensions
 * alone, never from `barSection.ts`, and deliberately larger than
 * `surfaceAt(point)` — the entry assertion must check material under the rim,
 * not only under the axis.
 */
function surfaceUnderCutter(
  stock: Stock,
  axis: StockAxis,
  point: { x: number; y: number },
  cutterRadius: number,
): number {
  const halfSide = stock.thickness / 2
  if (stock.shape !== 'round') return stock.thickness
  const reach = Math.max(
    0,
    Math.abs(acrossOf(axis, point) - centreAcross(stock, axis)) - cutterRadius,
  )
  return halfSide + Math.sqrt(Math.max(0, halfSide * halfSide - reach * reach))
}

/**
 * Cut moves whose tool centre lies outside the bar's section at their own Z,
 * with `reach` project units of allowance for a generator whose tool-centre
 * domain is the material expanded by the cutter radius (surface clean).
 */
function airCutPoints(result: ToolpathResult, stock: Stock, axis: StockAxis, reach = 0, tolerance = 1e-5): ToolpathPoint[] {
  const centre = centreAcross(stock, axis)
  const bad: ToolpathPoint[] = []
  for (const move of result.moves) {
    if (move.kind !== 'cut') continue
    approx(move.from.z, move.to.z, 1e-9, 'a cut move is horizontal')
    const halfWidth = barSectionHalfWidth(stock, move.from.z)
    const samples: Point[] = [
      move.from,
      move.to,
      { x: (move.from.x + move.to.x) / 2, y: (move.from.y + move.to.y) / 2 },
    ]
    for (const point of samples) {
      if (Math.abs(acrossOf(axis, point) - centre) > halfWidth + reach + tolerance) {
        bad.push({ ...point, z: move.from.z })
      }
    }
  }
  return bad
}

/**
 * The first entry's descent start: the plunge that `rapidToEntryStart` emits
 * from safe Z down to the entry start height. `null` when every descent starts
 * at safe Z (the plunge strategy, or the mutation this file guards against).
 */
function entryDescentStart(result: ToolpathResult, safeZ: number): { z: number; at: ToolpathPoint } | null {
  for (const move of result.moves) {
    if (move.kind === 'rapid') continue
    // The entry start is the *plunge* the emitter puts between safe Z and the
    // ramp/helix start. Without a lowered start that move does not exist and
    // the descent begins with the lead-in itself.
    if (move.kind !== 'plunge') return null
    if (Math.abs(move.from.z - safeZ) <= 1e-9 && move.to.z < safeZ - 1e-9) {
      return { z: move.to.z, at: move.to }
    }
    return null
  }
  return null
}

/** The box top plus clearance — the height the plan replaces for a bar. */
function safeZOf(project: Project): number {
  return getOperationSafeZ(project)
}

// ── Tests ────────────────────────────────────────────────────

function testPocketTopAir(): void {
  console.log('Pocket rough on Top: no cut move outside the bar, fewer moves than the square reference...')
  for (const axis of ['x', 'y'] as const) {
    for (const units of ['mm', 'inch'] as const) {
      const round = generate(pocketProject({ units, axis, shape: 'round', face: 'top', pass: 'rough' }))
      const square = generate(pocketProject({ units, axis, shape: 'square', face: 'top', pass: 'rough' }))
      const label = `${units} ${axis} bar`
      assertTrue(round.moves.length > 0, `${label}: the round pocket clears something`)
      const air = airCutPoints(round, stockFor('round', fixtureGeometry(units), axis, units), axis)
      assertTrue(air.length === 0, `${label}: ${air.length} cut points beside the bar, first ${JSON.stringify(air[0])}`)
      assertTrue(
        round.moves.length < square.moves.length,
        `${label}: ${round.moves.length} moves, expected fewer than the square reference's ${square.moves.length}`,
      )
      // The square is the pre-change path, so it must be exactly that.
      assertTrue(
        moveHash(square) === baseClearingHash(units, axis),
        `${label}: the square blank's clearing drifted (${moveHash(square)} != ${baseClearingHash(units, axis)})`,
      )
    }
  }
}

function testPocketFloorAndWalls(): void {
  console.log('Pocket finish on Top: the finished floor and walls are where they were...')
  for (const axis of ['x', 'y'] as const) {
    const round = generate(pocketProject({ units: 'mm', axis, shape: 'round', face: 'top', pass: 'finish' }))
    const square = generate(pocketProject({ units: 'mm', axis, shape: 'square', face: 'top', pass: 'finish' }))
    const fixture = fixtureGeometry('mm')
    const floorZ = fixture.diameter / 2
    const floorCuts = (result: ToolpathResult): ToolpathMove[] => result.moves.filter(
      (move) => move.kind === 'cut' && Math.abs(move.from.z - floorZ) <= 1e-9 && Math.abs(move.to.z - floorZ) <= 1e-9,
    )
    const roundFloor = floorCuts(round)
    const squareFloor = floorCuts(square)
    assertTrue(roundFloor.length > 0, `${axis}: the finish pass cuts the floor at ${floorZ}`)
    assert.deepEqual(
      roundFloor,
      squareFloor,
      `${axis}: the clipped finish pass moved the floor or a wall (${roundFloor.length} vs ${squareFloor.length} floor moves)`,
    )
  }
}

function testPocketBottom(): void {
  console.log('Pocket rough on Bottom: the same result in the flipped (stock) frame...')
  for (const axis of ['x', 'y'] as const) {
    const round = generate(pocketProject({ units: 'mm', axis, shape: 'round', face: 'bottom', pass: 'rough' }))
    const square = generate(pocketProject({ units: 'mm', axis, shape: 'square', face: 'bottom', pass: 'rough' }))
    const stock = stockFor('round', fixtureGeometry('mm'), axis, 'mm')
    const air = airCutPoints(round, stock, axis)
    assertTrue(air.length === 0, `bottom ${axis}: ${air.length} cut points beside the bar, first ${JSON.stringify(air[0])}`)
    assertTrue(
      round.moves.length < square.moves.length,
      `bottom ${axis}: ${round.moves.length} moves, expected fewer than ${square.moves.length}`,
    )
    assertTrue(round.bounds !== null && round.bounds.minZ < round.bounds.maxZ, `bottom ${axis}: the path has a Z range`)
  }
}

function testSquareBlank(): void {
  console.log('Square blank: the full side is the section, so nothing is clipped...')
  for (const face of ['top', 'bottom'] as const) {
    const result = generate(pocketProject({ units: 'mm', axis: 'x', shape: 'square', face, pass: 'rough' }))
    const stock = stockFor('square', fixtureGeometry('mm'), 'x', 'mm')
    const air = airCutPoints(result, stock, 'x')
    assertTrue(air.length === 0, `square ${face}: ${air.length} cut points outside the blank's side`)
    if (face === 'top') {
      // The square's Top path is the frozen pre-change path; a Bottom path is
      // that same path mirrored through mid-thickness, so its hash differs.
      assertTrue(
        moveHash(result) === baseClearingHash('mm', 'x'),
        `square ${face}: the blank's clearing drifted (${moveHash(result)} != ${baseClearingHash('mm', 'x')})`,
      )
    }
  }
}

function testBlockByteIdentical(): void {
  console.log('Block project: byte-identical clearing...')
  const result = generate(pocketProject({ units: 'mm', axis: 'x', shape: 'block', face: 'top', pass: 'rough' }))
  assertTrue(
    moveHash(result) === baseClearingHash('mm', 'x'),
    `block: the clearing drifted (${moveHash(result)} != ${baseClearingHash('mm', 'x')})`,
  )
  const stock = stockFor('block', fixtureGeometry('mm'), 'x', 'mm')
  assertTrue(airCutPoints(result, stock, 'x').length === 0, 'block: every cut is inside the block')
}

function testEntryStartsAtTheBarSurface(): void {
  console.log('Entry: the first descent starts at the bar surface over its region, not the box top...')
  // A single deep step so the shallowest level is already off the crown: the
  // pocket spans across 30..39 near the side of a 40 mm bar, and one 10 mm step
  // puts the only level at z = 30, where the section band is [2.68, 37.32].
  const fixture = fixtureGeometry('mm')
  const project = pocketProject({
    units: 'mm',
    axis: 'x',
    shape: 'round',
    face: 'top',
    pass: 'rough',
    helixEntry: true,
    across: { min: 30, max: 39 },
    zSpan: { top: fixture.diameter, bottom: 30 },
    stepdown: 10,
  })
  const safeZ = safeZOf(project)
  const result = generate(project)
  assertTrue(result.moves.length > 0, 'the entry fixture cuts something')
  const entry = entryDescentStart(result, safeZ)
  assertTrue(entry, `the first entry descends from safe Z (${safeZ}) in one plunge, so it starts at the box top`)
  const stock = stockFor('round', fixture, 'x', 'mm')
  const levelZ = 30
  const band = (() => {
    const half = barSectionHalfWidth(stock, levelZ)
    return { min: centreAcross(stock, 'x') - half, max: centreAcross(stock, 'x') + half }
  })()
  const across = entry.at.y
  assertTrue(
    across >= band.min - 1e-6 && across <= band.max + 1e-6,
    `the entry point ${across} is outside the bar's section at z=${levelZ}: [${band.min}, ${band.max}]`,
  )
  // The independent analytic surface at the point the entry actually starts.
  const surface = surfaceAt(stock, 'x', entry.at)
  assertTrue(
    entry.z >= surface + project.meta.operationClearanceZ - 1e-6,
    `the entry starts at ${entry.z}, below the bar surface ${surface} plus clearance`,
  )
  // The cutter is not a point (#1054 fix 1, finding 5). The rim reaches
  // `toolRadius` towards the crown, where the 40 mm bar stands higher than at
  // the axis: the entry must clear the material under the whole footprint, not
  // only under the tool centre. This is the reviewer's repro — Ø40 bar, Ø6
  // cutter, a shoulder pocket across 30..39, floor Z30, 0.1 clearance — and
  // omitting the radius from `barEntryStartZ` fails it.
  const toolRadius = fixture.toolDiameter / 2
  const underRim = surfaceUnderCutter(stock, 'x', entry.at, toolRadius)
  assertTrue(
    entry.z >= underRim + project.meta.operationClearanceZ - 1e-6,
    `the entry starts at ${entry.z}, below the material under its rim ${underRim} plus clearance`,
  )
  assertTrue(
    underRim > surface + 1e-6,
    `fixture: the bar really stands higher under the rim (${underRim}) than at the axis (${surface})`,
  )
  assertTrue(
    entry.z < safeZ - 1.5,
    `the entry still starts at ${entry.z}, effectively the box top ${safeZ} (surface ${underRim})`,
  )
  assertTrue(
    entry.z > levelZ + 1,
    `the "entry start" at ${entry.z} is the cut level itself, not a lowered start above it`,
  )
}

function testSurfaceClean(): void {
  console.log('Surface clean: clipped to the bar section, tool centre within one radius of it...')
  const round = generate(surfaceCleanProject('round'))
  const square = generate(surfaceCleanProject('square'))
  const stock = stockFor('round', fixtureGeometry('mm'), 'x', 'mm')
  const toolRadius = fixtureGeometry('mm').toolDiameter / 2
  const air = airCutPoints(round, stock, 'x', toolRadius, 1e-3)
  assertTrue(air.length === 0, `surface clean: ${air.length} cut points beyond the bar plus the cutter, first ${JSON.stringify(air[0])}`)
  assertTrue(
    round.moves.length < square.moves.length,
    `surface clean: ${round.moves.length} moves, expected fewer than ${square.moves.length}`,
  )
}

function testRoughSurface(): void {
  console.log('Rough surface: clipped to the bar section...')
  const round = generate(roughSurfaceProject('round'))
  const square = generate(roughSurfaceProject('square'))
  const stock = roundStock(20, 30, 'x')
  const air = airCutPoints(round, stock, 'x')
  assertTrue(air.length === 0, `rough surface: ${air.length} cut points beside the bar, first ${JSON.stringify(air[0])}`)
  assertTrue(
    round.moves.length < square.moves.length,
    `rough surface: ${round.moves.length} moves, expected fewer than ${square.moves.length}`,
  )
}

function main(): void {
  testPocketTopAir()
  testPocketFloorAndWalls()
  testPocketBottom()
  testSquareBlank()
  testBlockByteIdentical()
  testEntryStartsAtTheBarSurface()
  testSurfaceClean()
  testRoughSurface()
  console.log('All barSkipAir tests PASSED.')
}

main()
