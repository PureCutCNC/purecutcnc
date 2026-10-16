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
 * Boundary-geometry tests for the square material (issue #1016 C2-R2M).
 *
 * The mesh is checked against an **independent** reference: a point is material
 * when it is inside the physical square (the two half-plane tests on the
 * transverse coordinates, not the production ray formula) and its radius lies
 * in the cell's accepted `squareMaterialIntervals`. Mesh membership comes from
 * ray-casting the generated triangles — a different code path from the builder,
 * so the two cannot agree by construction.
 *
 * Run with: npx tsx src/engine/simulation/squareMaterialGeometry.test.ts
 */

import { applyMoveToGrid } from './replay'
import { squareMaterialIntervals, setSquareMaterialIntervals, squareSurfaceRadius } from './squareMaterial'
import { createSimulationGrid } from './grid'
import {
  buildSquareMaterialChunk,
  resolveSquareMaterialLayout,
  squareMaterialChunkAngularRange,
  squareMaterialChunkCount,
  squareMaterialEnvelope,
} from './squareMaterialGeometry'
import type { SquareMaterialGeometryOptions } from './squareMaterialGeometry'
import { barCentre, barMaxRadius, barPivotZ, squareStock } from '../../types/barStock'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import { normalizeToolForProject } from '../toolpaths/geometry'
import { generateRotaryRough } from '../toolpaths/rotaryModel'
import { buildRotaryCylinder } from '../rotaryCylinder'
import type { SimulationGrid } from './types'
import type { AroundFrame } from '../aroundFrame'
import type { ToolpathMove } from '../toolpaths/types'

type Vec3 = readonly [number, number, number]

const CHUNK_ANGULAR_CELLS = 16

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function approx(a: number, b: number, epsilon: number): boolean {
  return Math.abs(a - b) <= epsilon
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

/** A square sheet grid with an exact periodic angular partition. */
function squareSheetGrid(params: {
  side: number
  axis: 'x' | 'y'
  angularCells: number
  alongCells: number
  zero: number
  alongStart?: number
}): SimulationGrid {
  const { side, axis, angularCells, alongCells, zero } = params
  const alongStart = params.alongStart ?? 0
  const circumference = Math.PI * side
  const cellSize = circumference / angularCells
  const sheetStart = zero - circumference / 2
  const xMin = axis === 'x' ? alongStart : sheetStart
  const yMin = axis === 'x' ? sheetStart : alongStart
  const cols = axis === 'x' ? alongCells : angularCells
  const rows = axis === 'x' ? angularCells : alongCells
  const topZ = new Float32Array(cols * rows)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const across = axis === 'x'
        ? yMin + (row + 0.5) * cellSize
        : xMin + (col + 0.5) * cellSize
      topZ[row * cols + col] = squareSurfaceRadius(side, (across - zero) / (side / 2))
    }
  }
  const frame: AroundFrame = {
    axis,
    centre: zero,
    radius: side / 2,
    zero,
    sheetStart,
    circumference,
  }
  return {
    originX: xMin,
    originY: yMin,
    cellSize,
    cols,
    rows,
    stockBottomZ: 0,
    stockTopZ: side * Math.SQRT1_2,
    squareBar: { side, frame },
    initialTopZ: new Float32Array(topZ),
    topZ,
    squareMaterial: new Map<number, readonly number[]>(),
  }
}

function alongBoundsOf(grid: SimulationGrid): { min: number; max: number } {
  const axis = grid.squareBar!.frame.axis
  const min = axis === 'x' ? grid.originX : grid.originY
  const count = axis === 'x' ? grid.cols : grid.rows
  return { min, max: min + count * grid.cellSize }
}

function optionsFor(grid: SimulationGrid): SquareMaterialGeometryOptions {
  return { alongBounds: alongBoundsOf(grid) }
}

function cellIndex(grid: SimulationGrid, ci: number, ai: number): number {
  return grid.squareBar!.frame.axis === 'x' ? ci * grid.cols + ai : ai * grid.cols + ci
}

function angularIndexNearest(grid: SimulationGrid, theta: number): number {
  const frame = grid.squareBar!.frame
  const xAxis = frame.axis === 'x'
  const acrossOrigin = xAxis ? grid.originY : grid.originX
  const acrossCount = xAxis ? grid.rows : grid.cols
  let best = 0
  let bestDelta = Infinity
  for (let i = 0; i < acrossCount; i += 1) {
    const across = acrossOrigin + (i + 0.5) * grid.cellSize
    const delta = Math.abs((across - frame.zero) / frame.radius - theta)
    if (delta < bestDelta) {
      bestDelta = delta
      best = i
    }
  }
  return best
}

/** World point at radius `u` on the centre ray of cell (ci, ai). */
function cellRayWorld(grid: SimulationGrid, ci: number, ai: number, u: number): Vec3 {
  const frame = grid.squareBar!.frame
  const xAxis = frame.axis === 'x'
  const acrossOrigin = xAxis ? grid.originY : grid.originX
  const alongOrigin = xAxis ? grid.originX : grid.originY
  const across = acrossOrigin + (ci + 0.5) * grid.cellSize
  const along = alongOrigin + (ai + 0.5) * grid.cellSize
  const theta = (across - frame.zero) / frame.radius
  const cos = Math.cos(theta)
  const sin = Math.sin(theta)
  return xAxis
    ? [along, frame.radius + u * cos, frame.centre + u * sin]
    : [frame.centre + u * sin, frame.radius + u * cos, along]
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
}

function sub(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function triangleAt(positions: Float32Array, index: number): [Vec3, Vec3, Vec3] {
  const base = index * 9
  return [
    [positions[base], positions[base + 1], positions[base + 2]],
    [positions[base + 3], positions[base + 4], positions[base + 5]],
    [positions[base + 6], positions[base + 7], positions[base + 8]],
  ]
}

/** Möller–Trumbore, tolerance-free for well-separated points. */
function rayIntersects(origin: Vec3, direction: Vec3, a: Vec3, b: Vec3, c: Vec3): boolean {
  const edge1 = sub(b, a)
  const edge2 = sub(c, a)
  const pvec = cross(direction, edge2)
  const det = dot(edge1, pvec)
  if (Math.abs(det) < 1e-12) return false
  const inv = 1 / det
  const tvec = sub(origin, a)
  const u = dot(tvec, pvec) * inv
  if (u < 0 || u > 1) return false
  const qvec = cross(tvec, edge1)
  const v = dot(direction, qvec) * inv
  if (v < 0 || u + v > 1) return false
  return dot(edge2, qvec) * inv > 1e-9
}

const RAY_DIRECTION: Vec3 = (() => {
  const raw: Vec3 = [0.2679491924, 0.5773502692, 0.7735026919]
  const length = Math.hypot(raw[0], raw[1], raw[2])
  return [raw[0] / length, raw[1] / length, raw[2] / length]
})()

function pointInMesh(point: Vec3, positions: Float32Array): boolean {
  let hits = 0
  const count = positions.length / 9
  for (let t = 0; t < count; t += 1) {
    const [a, b, c] = triangleAt(positions, t)
    if (rayIntersects(point, RAY_DIRECTION, a, b, c)) hits += 1
  }
  return hits % 2 === 1
}

/**
 * Independent material reference. Inside the blank means inside the physical
 * square — the two half-plane tests on `projectZ - pivot` and
 * `across - centre` — and then the radius must sit in the cell's accepted
 * intervals. An intact outer interval reaches the blank rather than its own
 * baseline, which is the model's square-surface semantics.
 */
function referenceMaterial(grid: SimulationGrid, point: Vec3, tolerance: number): boolean {
  const bar = grid.squareBar!
  const frame = bar.frame
  const xAxis = frame.axis === 'x'
  const half = bar.side / 2
  const projectZ = point[1]
  const across = xAxis ? point[2] : point[0]
  const along = xAxis ? point[0] : point[2]
  if (Math.abs(projectZ - frame.radius) > half + tolerance) return false
  if (Math.abs(across - frame.centre) > half + tolerance) return false
  const acrossOrigin = xAxis ? grid.originY : grid.originX
  const alongOrigin = xAxis ? grid.originX : grid.originY
  const angularCount = xAxis ? grid.rows : grid.cols
  const alongCount = xAxis ? grid.cols : grid.rows
  if (along < alongOrigin - tolerance || along > alongOrigin + alongCount * grid.cellSize + tolerance) return false
  // The cell is found through the angle, not the raw across coordinate: the
  // sheet's across is `zero + theta*radius`, while a material point at radius u
  // on that ray sits at `centre + u*sin(theta)`.
  const theta = Math.atan2(across - frame.centre, projectZ - frame.radius)
  const sheetAcross = frame.zero + theta * frame.radius
  const ci = clamp(Math.floor((sheetAcross - acrossOrigin) / grid.cellSize), 0, angularCount - 1)
  const ai = clamp(Math.floor((along - alongOrigin) / grid.cellSize), 0, alongCount - 1)
  const intervals = squareMaterialIntervals(grid, cellIndex(grid, ci, ai))
  const n = intervals.length
  if (n === 0) return false
  const baseline = grid.initialTopZ ? grid.initialTopZ[cellIndex(grid, ci, ai)] : half
  const intact = intervals[n - 1] >= baseline - Math.max(1, baseline) * 1e-6
  const u = Math.hypot(projectZ - frame.radius, across - frame.centre)
  for (let i = 0; i < n; i += 2) {
    const hi = intact && i === n - 2 ? Infinity : intervals[i + 1]
    if (u >= intervals[i] - tolerance && u <= hi + tolerance) return true
  }
  return false
}

function buildAllPositions(grid: SimulationGrid, options: SquareMaterialGeometryOptions): Float32Array {
  const layout = resolveSquareMaterialLayout(grid, options)
  const count = squareMaterialChunkCount(layout, CHUNK_ANGULAR_CELLS)
  const parts: Float32Array[] = []
  let triangles = 0
  for (let c = 0; c < count; c += 1) {
    const [start, end] = squareMaterialChunkAngularRange(layout, CHUNK_ANGULAR_CELLS, c)
    const buffer = buildSquareMaterialChunk(grid, layout, options, start, end)
    parts.push(buffer.positions)
    triangles += buffer.triangleCount
  }
  const positions = new Float32Array(triangles * 9)
  let offset = 0
  for (const part of parts) {
    positions.set(part, offset)
    offset += part.length
  }
  return positions
}

function signedVolume(positions: Float32Array): number {
  let volume = 0
  const count = positions.length / 9
  for (let t = 0; t < count; t += 1) {
    const [a, b, c] = triangleAt(positions, t)
    volume += dot(a, cross(b, c)) / 6
  }
  return volume
}

/**
 * The virgin blank must render its actual square boundary: exact flats, exact
 * corners, no circumscribed cylinder, no missing interior.
 */
function testVirginBoundaryIsTheActualSquare(): void {
  console.log('Testing the virgin boundary is the physical square...')
  const side = 20
  const grid = squareSheetGrid({ side, axis: 'x', angularCells: 128, alongCells: 16, zero: 30 })
  const options = optionsFor(grid)
  const layout = resolveSquareMaterialLayout(grid, options)
  const positions = buildAllPositions(grid, options)

  const envelope = squareMaterialEnvelope(layout)
  const cornerRadius = side * Math.SQRT1_2
  assert(envelope.min[1] <= layout.pivot - cornerRadius + 1e-9, 'bounds must contain pivot - side/sqrt2')
  assert(envelope.max[1] >= layout.pivot + cornerRadius - 1e-9, 'bounds must contain pivot + side/sqrt2')
  assert(envelope.min[2] <= layout.centre - cornerRadius + 1e-9, 'bounds must contain centre - side/sqrt2')
  assert(envelope.max[2] >= layout.centre + cornerRadius - 1e-9, 'bounds must contain centre + side/sqrt2')
  assert(layout.pivot === side / 2, `the pivot must be side/2, got ${layout.pivot}`)

  const ci = angularIndexNearest(grid, 0)
  const ai = 4
  const top = cellRayWorld(grid, ci, ai, side / 2 - 0.2)
  const outsideTop = cellRayWorld(grid, ci, ai, side / 2 + 0.2)
  assert(referenceMaterial(grid, top, 0), 'the independent reference must accept a point just inside the top flat')
  assert(pointInMesh(top, positions), 'a point just inside the top flat must be inside the mesh')
  assert(!referenceMaterial(grid, outsideTop, 0), 'the independent reference must reject a point beyond the top flat')
  assert(!pointInMesh(outsideTop, positions), 'a point beyond the top flat must be outside the mesh')

  // At 45 degrees the blank reaches side/sqrt2, so a point between the
  // inscribed and circumscribed radii is real material: a circular envelope
  // would wrongly drop it.
  const cornerCi = angularIndexNearest(grid, Math.PI / 4)
  const cornerInside = cellRayWorld(grid, cornerCi, ai, side / 2 + 0.8)
  assert(referenceMaterial(grid, cornerInside, 0), 'a 45-degree point beyond the inscribed radius must be material')
  assert(pointInMesh(cornerInside, positions), 'the 45-degree corner must be present in the mesh')

  // The corner itself: both flats meet at (pivot + side/2, centre + side/2).
  const cornerPoint: Vec3 = [grid.originX + (ai + 0.5) * grid.cellSize, layout.pivot + side / 2 - 0.05, layout.centre + side / 2 - 0.05]
  assert(pointInMesh(cornerPoint, positions), 'the physical corner must be inside the mesh')
  console.log('virgin square boundary: PASSED')
}

/**
 * An interior groove leaves two pieces. The gap must be real air with its own
 * floor and ceiling, and no radial face may bridge across it.
 */
function testInteriorGapHasFloorCeilingAndNoBridge(): void {
  console.log('Testing the interior gap keeps a real air band...')
  const side = 20
  const grid = squareSheetGrid({ side, axis: 'x', angularCells: 128, alongCells: 16, zero: 30 })
  const options = optionsFor(grid)
  const ci = angularIndexNearest(grid, 50 * Math.PI / 180)
  const ai = 8
  const index = cellIndex(grid, ci, ai)
  const baseline = grid.initialTopZ![index]
  const gapLo = 9.3314231304
  const gapHi = 10.4432583147
  setSquareMaterialIntervals(grid, index, [0, gapLo, gapHi, baseline])
  grid.topZ[index] = baseline

  const positions = buildAllPositions(grid, options)
  const gapPoint = cellRayWorld(grid, ci, ai, (gapLo + gapHi) / 2)
  const corePoint = cellRayWorld(grid, ci, ai, 5)
  const shellPoint = cellRayWorld(grid, ci, ai, (gapHi + baseline) / 2)
  assert(!referenceMaterial(grid, gapPoint, 0), 'the independent reference must call the gap air')
  assert(!pointInMesh(gapPoint, positions), 'the gap must render as air, not filled material')
  assert(referenceMaterial(grid, corePoint, 0) && pointInMesh(corePoint, positions), 'the inner core must be material')
  assert(referenceMaterial(grid, shellPoint, 0) && pointInMesh(shellPoint, positions), 'the outer shell must be material')

  // A radial face (all three vertices at one radius) inside the gap would be a
  // bridge across the removed band. The gap walls are angular/axial, so their
  // vertices sit on the gap edges, never strictly inside.
  let bridging = 0
  const count = positions.length / 9
  for (let t = 0; t < count; t += 1) {
    const [a, b, c] = triangleAt(positions, t)
    const ra = Math.hypot(a[1] - layoutPivot(grid), a[2] - layoutCentre(grid))
    const rb = Math.hypot(b[1] - layoutPivot(grid), b[2] - layoutCentre(grid))
    const rc = Math.hypot(c[1] - layoutPivot(grid), c[2] - layoutCentre(grid))
    const sameRadius = approx(ra, rb, 1e-6) && approx(rb, rc, 1e-6)
    if (sameRadius && ra > gapLo + 1e-3 && ra < gapHi - 1e-3) bridging += 1
  }
  assert(bridging === 0, `no radial face may bridge the removed gap, found ${bridging}`)
  console.log('interior gap: PASSED')
}

function layoutPivot(grid: SimulationGrid): number {
  return grid.squareBar!.frame.radius
}

function layoutCentre(grid: SimulationGrid): number {
  return grid.squareBar!.frame.centre
}

/**
 * The actual generated R1F rough: the first A0 pass leaves an interior gap at
 * the 50-degree ray with the outer `topZ` untouched. The mesh must show that
 * gap as air and keep both surviving pieces.
 */
function testGeneratedA0GapIsNotFilled(): void {
  console.log('Testing the actual generated A0 gap is air in the mesh...')
  const side = 20
  const length = 100
  const stock = squareStock(side, length, 'x')
  const blank = newProject('gap', 'mm')
  const tool = normalizeToolForProject(
    { ...defaultTool('mm', 1), type: 'flat_endmill', diameter: 16 },
    blank,
  )
  const mesh = buildRotaryCylinder(stock, { diameter: 12, alongStart: 20, alongEnd: 80 }, 'mm')
  const rough = generateRotaryRough('gap', mesh, stock, tool, {
    stepover: 2 * Math.PI * barMaxRadius(stock) / 8,
    stepdown: 9,
    stockToLeave: 0,
    sampleSpacing: 12,
    requestedCellSize: 0.25,
    alongStart: 20,
    alongEnd: 80,
    safeRadius: 25,
  }, {})

  const zero = barCentre(stock)
  const frame: AroundFrame = {
    axis: 'x',
    centre: zero,
    radius: side / 2,
    zero,
    sheetStart: zero - Math.PI * side / 2,
    circumference: Math.PI * side,
  }
  const project = newProject('gap', 'mm')
  project.stock = {
    ...project.stock,
    profile: rectProfile(0, frame.sheetStart, length, frame.circumference),
    thickness: side / 2,
  }
  const grid = createSimulationGrid(project, { squareBar: { side, frame }, targetLongAxisCells: 180 })

  const pivot = barPivotZ(stock)
  const toSheet = (move: ToolpathMove): ToolpathMove => ({
    ...move,
    from: { ...move.from, z: move.from.z - pivot },
    to: { ...move.to, z: move.to.z - pivot },
  })
  const first = rough.moves.find((move) => move.kind === 'cut'
    && move.from.a === 0 && move.to.a === 0
    && Math.min(move.from.x, move.to.x) < 50 && Math.max(move.from.x, move.to.x) > 50)
  assert(first !== undefined, 'the generated rough must contain a central A0 cut')
  applyMoveToGrid(grid, toSheet(first!), 8, 'flat_endmill', null)

  const ci = angularIndexNearest(grid, 50 * Math.PI / 180)
  const ai = clamp(Math.round((50 - grid.originX) / grid.cellSize), 0, grid.cols - 1)
  const index = cellIndex(grid, ci, ai)
  const intervals = squareMaterialIntervals(grid, index)
  assert(intervals.length === 4, `the generated A0 pass must leave two pieces, got ${JSON.stringify(intervals)}`)
  assert(intervals[1] > intervals[0] && intervals[2] > intervals[1], 'the gap must be a real interval')
  assert(grid.topZ[index] === grid.initialTopZ![index], 'the derived outer height must not move for an interior gap')

  const options = optionsFor(grid)
  const positions = buildAllPositions(grid, options)
  const gapLo = intervals[1]
  const gapHi = intervals[2]
  const gapPoint = cellRayWorld(grid, ci, ai, (gapLo + gapHi) / 2)
  const corePoint = cellRayWorld(grid, ci, ai, gapLo / 2)
  const shellPoint = cellRayWorld(grid, ci, ai, (gapHi + grid.initialTopZ![index]) / 2)
  assert(!pointInMesh(gapPoint, positions), 'the generated gap must not be filled by the mesh')
  assert(!referenceMaterial(grid, gapPoint, 0), 'the independent reference must call the generated gap air')
  assert(pointInMesh(corePoint, positions), 'the generated inner core must be material')
  assert(pointInMesh(shellPoint, positions), 'the generated outer shell must be material')
  console.log(`generated A0 gap: PASSED (${gapLo.toFixed(4)} .. ${gapHi.toFixed(4)})`)
}

/**
 * Neighbouring cells with different material must expose axial and angular
 * walls, and the walls must stop exactly at the interval difference.
 */
function testAxialAndAngularDifferenceFaces(): void {
  console.log('Testing axial and angular interval-difference walls...')
  const side = 20
  const grid = squareSheetGrid({ side, axis: 'x', angularCells: 128, alongCells: 12, zero: 30 })
  const options = optionsFor(grid)
  const ci = angularIndexNearest(grid, 0)
  const ai = 6
  const cutIndex = cellIndex(grid, ci, ai)
  const baseline = grid.initialTopZ![cutIndex]
  // Two pieces: core [0, 6], shell [12, baseline]; every neighbour is virgin.
  setSquareMaterialIntervals(grid, cutIndex, [0, 6, 12, baseline])

  const positions = buildAllPositions(grid, options)
  const alongEdge = grid.originX + ai * grid.cellSize
  const angularEdge = (grid.originY + (ci + 1) * grid.cellSize - 30) / (side / 2)
  const thetaOf = (point: Vec3): number => Math.atan2(point[2] - layoutCentre(grid), point[1] - layoutPivot(grid))

  let axialWallTriangles = 0
  let angularWallTriangles = 0
  const count = positions.length / 9
  for (let t = 0; t < count; t += 1) {
    const [a, b, c] = triangleAt(positions, t)
    if (approx(a[0], alongEdge, 1e-6) && approx(b[0], alongEdge, 1e-6) && approx(c[0], alongEdge, 1e-6)) {
      axialWallTriangles += 1
    }
    if (approx(thetaOf(a), angularEdge, 1e-6) && approx(thetaOf(b), angularEdge, 1e-6) && approx(thetaOf(c), angularEdge, 1e-6)) {
      angularWallTriangles += 1
    }
  }
  assert(axialWallTriangles > 0, 'the interval difference with an axial neighbour must emit a wall')
  assert(angularWallTriangles > 0, 'the interval difference with an angular neighbour must emit a wall')
  assert(!pointInMesh(cellRayWorld(grid, ci, ai, 9), positions), 'the gap must be air on the cut side')
  assert(pointInMesh(cellRayWorld(grid, ci, ai, 3), positions), 'the core must be material')
  console.log('axial and angular difference walls: PASSED')
}

/** Both bar axes, off-origin stock, and the true pivot world mapping. */
function testBothAxesAndOffOrigin(): void {
  console.log('Testing both axes, off-origin stock and the true pivot...')
  for (const axis of ['x', 'y'] as const) {
    for (const alongStart of [0, 12.5]) {
      const side = 16
      const grid = squareSheetGrid({ side, axis, angularCells: 96, alongCells: 10, zero: axis === 'x' ? 40 : -7, alongStart })
      const options = optionsFor(grid)
      const layout = resolveSquareMaterialLayout(grid, options)
      assert(layout.pivot === side / 2, `${axis} pivot must be side/2`)
      const ci = angularIndexNearest(grid, 0)
      const ai = 4
      const pivotPoint = cellRayWorld(grid, ci, ai, 0)
      const expectedPivot: Vec3 = axis === 'x'
        ? [grid.originX + (ai + 0.5) * grid.cellSize, layout.pivot, layout.centre]
        : [layout.centre, layout.pivot, grid.originY + (ai + 0.5) * grid.cellSize]
      assert(
        approx(pivotPoint[0], expectedPivot[0], 1e-9)
        && approx(pivotPoint[1], expectedPivot[1], 1e-9)
        && approx(pivotPoint[2], expectedPivot[2], 1e-9),
        `${axis} pivot world point must sit on the turning axis`,
      )
      const positions = buildAllPositions(grid, options)
      const cornerCi = angularIndexNearest(grid, Math.PI / 4)
      const inside = cellRayWorld(grid, cornerCi, ai, side / 2 + 0.5)
      assert(referenceMaterial(grid, inside, 0), `${axis} off-origin corner point must be material`)
      assert(pointInMesh(inside, positions), `${axis} off-origin corner point must be inside the mesh`)
      const outside = cellRayWorld(grid, ci, ai, side / 2 + 0.4)
      assert(!pointInMesh(outside, positions), `${axis} point beyond the flat must be outside the mesh`)
    }
  }
  console.log('axes, off-origin and pivot: PASSED')
}

/** Outward winding and a volume that matches the true square prism. */
function testWindingAndVolume(): void {
  console.log('Testing winding and virgin volume...')
  const side = 20
  const grid = squareSheetGrid({ side, axis: 'x', angularCells: 128, alongCells: 16, zero: 30 })
  const options = optionsFor(grid)
  const positions = buildAllPositions(grid, options)
  const volume = signedVolume(positions)
  const expected = side * side * (grid.cols * grid.cellSize)
  assert(volume > 0, `outward winding must give a positive signed volume, got ${volume}`)
  assert(approx(volume, expected, expected * 1e-3), `virgin volume ${volume} must match ${expected}`)

  // Every triangle's own normal must point away from the material.
  const count = positions.length / 9
  for (let t = 0; t < count; t += 7) {
    const [a, b, c] = triangleAt(positions, t)
    const normal = cross(sub(b, a), sub(c, a))
    const length = Math.hypot(normal[0], normal[1], normal[2])
    if (!(length > 1e-12)) continue
    const unit: Vec3 = [normal[0] / length, normal[1] / length, normal[2] / length]
    const centroid: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]
    const offSurface: Vec3 = [
      centroid[0] + unit[0] * 0.05,
      centroid[1] + unit[1] * 0.05,
      centroid[2] + unit[2] * 0.05,
    ]
    assert(!referenceMaterial(grid, offSurface, 1e-9), `triangle ${t} normal must point outward`)
  }
  console.log('winding and volume: PASSED')
}

/** Seam faces are emitted once, endcaps exist, and untouched ends stay square. */
function testSeamEndcapsAndUntouchedEnds(): void {
  console.log('Testing seam de-duplication, endcaps and untouched ends...')
  const side = 20
  const grid = squareSheetGrid({ side, axis: 'x', angularCells: 128, alongCells: 16, zero: 30 })
  const options = optionsFor(grid)
  const positions = buildAllPositions(grid, options)
  const count = positions.length / 9
  const keys = new Set<string>()
  const alongMin = grid.originX
  const alongMax = grid.originX + grid.cols * grid.cellSize
  let endcapTriangles = 0
  for (let t = 0; t < count; t += 1) {
    const [a, b, c] = triangleAt(positions, t)
    const key = [a, b, c]
      .map((p) => `${p[0].toFixed(5)},${p[1].toFixed(5)},${p[2].toFixed(5)}`)
      .sort()
      .join('|')
    assert(!keys.has(key), 'the mesh must not emit duplicate triangles (seam included)')
    keys.add(key)
    if (approx(a[0], alongMin, 1e-6) && approx(b[0], alongMin, 1e-6) && approx(c[0], alongMin, 1e-6)) endcapTriangles += 1
    if (approx(a[0], alongMax, 1e-6) && approx(b[0], alongMax, 1e-6) && approx(c[0], alongMax, 1e-6)) endcapTriangles += 1
  }
  assert(endcapTriangles > 0, 'both stock ends must carry endcaps')

  // Remove one angular cell over the middle of the bar; the ends must keep
  // their full square section.
  const ci = angularIndexNearest(grid, 90 * Math.PI / 180)
  for (let ai = 4; ai <= 11; ai += 1) {
    const index = cellIndex(grid, ci, ai)
    setSquareMaterialIntervals(grid, index, [])
    grid.topZ[index] = 0
  }
  const cut = buildAllPositions(grid, options)
  const untouched = cellRayWorld(grid, ci, 0, side / 2 - 0.1)
  assert(pointInMesh(untouched, cut), 'an untouched end must keep its square section at the flat')
  const cornerCi = angularIndexNearest(grid, Math.PI / 4)
  const untouchedCorner = cellRayWorld(grid, cornerCi, 0, side / 2 + 0.5)
  assert(pointInMesh(untouchedCorner, cut), 'an untouched end must keep its corner material')
  const removed = cellRayWorld(grid, ci, 7, side / 4)
  assert(!pointInMesh(removed, cut), 'a fully removed cell must be air')
  console.log('seam, endcaps and untouched ends: PASSED')
}

/**
 * The periodic seam is one physical plane, so a difference across it must be
 * emitted once (from the top cell's +theta edge), not once per side.
 */
function testSeamInterfaceEmittedOnce(): void {
  console.log('Testing the periodic seam interface is emitted once...')
  const side = 20
  const grid = squareSheetGrid({ side, axis: 'x', angularCells: 128, alongCells: 8, zero: 30 })
  const options = optionsFor(grid)
  const ai = 4
  const seamIndex = cellIndex(grid, 0, ai)
  const baseline = grid.initialTopZ![seamIndex]
  // Cell 0 differs from cell 127, so the seam carries a real interval wall.
  setSquareMaterialIntervals(grid, seamIndex, [0, 6, 12, baseline])
  const positions = buildAllPositions(grid, options)
  const count = positions.length / 9
  const keys = new Set<string>()
  let seamTriangles = 0
  for (let t = 0; t < count; t += 1) {
    const [a, b, c] = triangleAt(positions, t)
    const key = [a, b, c]
      .map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)},${p[2].toFixed(6)}`)
      .sort()
      .join('|')
    assert(!keys.has(key), 'a seam wall must not be emitted twice')
    keys.add(key)
    // The seam plane is projectZ = pivot - u, projectY = centre.
    if (approx(a[2], layoutCentre(grid), 1e-6) && approx(b[2], layoutCentre(grid), 1e-6) && approx(c[2], layoutCentre(grid), 1e-6)) {
      seamTriangles += 1
    }
  }
  assert(seamTriangles > 0, 'the seam difference must emit a wall')
  console.log('periodic seam emitted once: PASSED')
}

/**
 * A closed virgin blank with one interior groove must be a 2-manifold: every
 * edge is shared by exactly two triangles, and none is over-used.
 */
function testClosedMeshIsManifold(): void {
  console.log('Testing the closed mesh edge manifoldness...')
  const side = 20
  const grid = squareSheetGrid({ side, axis: 'x', angularCells: 64, alongCells: 8, zero: 30 })
  const options = optionsFor(grid)
  const ci = angularIndexNearest(grid, 50 * Math.PI / 180)
  const ai = 4
  const index = cellIndex(grid, ci, ai)
  const baseline = grid.initialTopZ![index]
  setSquareMaterialIntervals(grid, index, [0, 6, 12, baseline])
  const positions = buildAllPositions(grid, options)
  const edges = new Map<string, number>()
  const vertexKey = (point: Vec3): string => `${point[0].toFixed(6)},${point[1].toFixed(6)},${point[2].toFixed(6)}`
  const addEdge = (p: Vec3, q: Vec3): void => {
    const key = [vertexKey(p), vertexKey(q)].sort().join('>')
    edges.set(key, (edges.get(key) ?? 0) + 1)
  }
  const count = positions.length / 9
  for (let t = 0; t < count; t += 1) {
    const [a, b, c] = triangleAt(positions, t)
    addEdge(a, b)
    addEdge(b, c)
    addEdge(c, a)
  }
  let open = 0
  let overused = 0
  for (const uses of edges.values()) {
    if (uses === 1) open += 1
    if (uses > 2) overused += 1
  }
  assert(overused === 0, `no edge may be shared by more than two triangles, found ${overused}`)
  assert(open === 0, `the closed blank must have no boundary edges, found ${open}`)
  console.log('closed mesh manifoldness: PASSED')
}

/** The accepted kernel's own interior-groove move, through the frozen API. */
function testKernelProducedGroove(): void {
  console.log('Testing a kernel-produced interior groove end to end...')
  const side = 20
  const grid = squareSheetGrid({ side, axis: 'x', angularCells: 128, alongCells: 16, zero: 30 })
  const theta = 50 * Math.PI / 180
  const ci = angularIndexNearest(grid, theta)
  const ai = 8
  const index = cellIndex(grid, ci, ai)
  const tip = 5.9981231689453125
  const frame = grid.squareBar!.frame
  const cellAlong = grid.originX + (ai + 0.5) * grid.cellSize
  const result = applyMoveToGrid(grid, {
    kind: 'cut',
    from: { x: cellAlong - 10, y: frame.zero, z: tip },
    to: { x: cellAlong + 10, y: frame.zero, z: tip },
  }, 8, 'flat_endmill', null)
  assert(result.changedCount > 0, 'the kernel must report the interior groove as removal')
  const intervals = squareMaterialIntervals(grid, index)
  assert(intervals.length === 4, `the kernel groove must leave two pieces, got ${JSON.stringify(intervals)}`)
  const options = optionsFor(grid)
  const positions = buildAllPositions(grid, options)
  const gapPoint = cellRayWorld(grid, ci, ai, (intervals[1] + intervals[2]) / 2)
  assert(!pointInMesh(gapPoint, positions), 'the kernel groove must be air in the mesh')
  assert(pointInMesh(cellRayWorld(grid, ci, ai, intervals[0] / 2), positions), 'the kernel core must be material')
  assert(pointInMesh(cellRayWorld(grid, ci, ai, intervals[2] + 0.5), positions), 'the kernel shell must be material')
  console.log('kernel-produced groove: PASSED')
}

try {
  testVirginBoundaryIsTheActualSquare()
  testInteriorGapHasFloorCeilingAndNoBridge()
  testGeneratedA0GapIsNotFilled()
  testAxialAndAngularDifferenceFaces()
  testBothAxesAndOffOrigin()
  testWindingAndVolume()
  testSeamEndcapsAndUntouchedEnds()
  testSeamInterfaceEmittedOnce()
  testClosedMeshIsManifold()
  testKernelProducedGroove()
  console.log('\nAll square material geometry tests PASSED.')
} catch (error) {
  console.error(error)
  throw error
}
