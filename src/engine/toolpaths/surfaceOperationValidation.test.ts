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

import { readFileSync } from 'node:fs'
import type { Operation, Project } from '../../types/project'
import { normalizeProject } from '../../store/projectStore'
import { resolvedFeature } from '../../test/projectFixtures'
import { loadSTLTransformedGeometry } from '../csg'
import { simulateOperationHeightfield } from '../simulation/replay'
import type { SimulationGrid } from '../simulation/types'
import { generateFinishSurfaceCleanupToolpath } from './finishSurfaceCleanup'
import { generateFinishSurfaceToolpath } from './finishSurface'
import { generateRoughSurfaceToolpath } from './roughSurface'
import type { PocketToolpathResult, ToolpathMove } from './types'

const VALIDATION_GRID_CELLS = 300

interface TargetSurfaceValidation {
  grid: SimulationGrid
  targetTopZ: Float32Array
  tolerance: number
  stableInteriorCells: number
  stableInteriorGouges: number
  maxStableInteriorGouge: number
  stableInteriorResiduals: number
  maxStableInteriorResidual: number
  peakIndex: number
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function loadFixture(name: string): Project {
  const raw = readFileSync(new URL(`../test-fixtures/${name}`, import.meta.url), 'utf8')
  return normalizeProject(JSON.parse(raw) as Project)
}

function findOperation(
  project: Project,
  predicate: (operation: Operation) => boolean,
  description: string,
): Operation {
  const operation = project.operations.find(predicate)
  if (!operation) throw new Error(`expected ${description} operation`)
  return operation
}

function generateOperationToolpath(
  project: Project,
  operation: Operation,
): PocketToolpathResult {
  if (operation.kind === 'rough_surface') {
    return generateRoughSurfaceToolpath(project, operation)
  }
  if (operation.kind === 'finish_surface') {
    return generateFinishSurfaceToolpath(project, operation)
  }
  if (operation.kind === 'finish_surface_cleanup') {
    return generateFinishSurfaceCleanupToolpath(project, operation)
  }
  throw new Error(`unsupported validation operation ${operation.kind}`)
}

function cutMoves(result: PocketToolpathResult): ToolpathMove[] {
  return result.moves.filter((move) => move.kind === 'cut')
}

function resolveTargetMesh(project: Project, operation: Operation): {
  positions: Float32Array
  index: Uint32Array
} {
  if (operation.target.source !== 'features') {
    throw new Error('expected feature-targeted 3D surface operation')
  }
  for (const featureId of operation.target.featureIds) {
    const mesh = loadSTLTransformedGeometry(resolvedFeature(project, featureId), project)
    if (mesh) return mesh
  }
  throw new Error('expected an imported mesh target')
}

/**
 * Rasterize the imported mesh independently of the generator height map.
 * Each simulation cell records the highest triangle intersection at its center.
 */
function rasterizeTargetTopSurface(
  project: Project,
  operation: Operation,
  grid: SimulationGrid,
): Float32Array {
  const { positions, index } = resolveTargetMesh(project, operation)
  const targetTopZ = new Float32Array(grid.topZ.length)
  targetTopZ.fill(Number.NEGATIVE_INFINITY)

  for (let triangle = 0; triangle < index.length; triangle += 3) {
    const i0 = index[triangle] * 3
    const i1 = index[triangle + 1] * 3
    const i2 = index[triangle + 2] * 3
    const x0 = positions[i0]
    const y0 = positions[i0 + 1]
    const z0 = positions[i0 + 2]
    const x1 = positions[i1]
    const y1 = positions[i1 + 1]
    const z1 = positions[i1 + 2]
    const x2 = positions[i2]
    const y2 = positions[i2 + 1]
    const z2 = positions[i2 + 2]
    const edge0X = x1 - x0
    const edge0Y = y1 - y0
    const edge1X = x2 - x0
    const edge1Y = y2 - y0
    const denominator = edge0X * edge1Y - edge0Y * edge1X
    if (Math.abs(denominator) <= 1e-15) continue

    const minCol = Math.max(
      0,
      Math.floor((Math.min(x0, x1, x2) - grid.originX) / grid.cellSize),
    )
    const maxCol = Math.min(
      grid.cols - 1,
      Math.floor((Math.max(x0, x1, x2) - grid.originX) / grid.cellSize),
    )
    const minRow = Math.max(
      0,
      Math.floor((Math.min(y0, y1, y2) - grid.originY) / grid.cellSize),
    )
    const maxRow = Math.min(
      grid.rows - 1,
      Math.floor((Math.max(y0, y1, y2) - grid.originY) / grid.cellSize),
    )

    for (let row = minRow; row <= maxRow; row += 1) {
      const y = grid.originY + (row + 0.5) * grid.cellSize
      for (let col = minCol; col <= maxCol; col += 1) {
        const x = grid.originX + (col + 0.5) * grid.cellSize
        const relativeX = x - x0
        const relativeY = y - y0
        const u = (relativeX * edge1Y - relativeY * edge1X) / denominator
        const v = (relativeY * edge0X - relativeX * edge0Y) / denominator
        if (u < -1e-9 || v < -1e-9 || u + v > 1 + 1e-9) continue
        const z = (1 - u - v) * z0 + u * z1 + v * z2
        const targetIndex = row * grid.cols + col
        if (z > targetTopZ[targetIndex]) targetTopZ[targetIndex] = z
      }
    }
  }

  return targetTopZ
}

function validateSweptSurface(
  project: Project,
  operation: Operation,
  result: PocketToolpathResult,
): TargetSurfaceValidation {
  const simulation = simulateOperationHeightfield(
    project,
    operation,
    result,
    { targetLongAxisCells: VALIDATION_GRID_CELLS },
  )
  assert(simulation.warnings.length === 0,
    `${operation.name} simulation warnings: ${JSON.stringify(simulation.warnings)}`)
  const targetTopZ = rasterizeTargetTopSurface(project, operation, simulation.grid)
  const tolerance = simulation.grid.cellSize * 1.5
  let stableInteriorCells = 0
  let stableInteriorGouges = 0
  let maxStableInteriorGouge = 0
  let stableInteriorResiduals = 0
  let maxStableInteriorResidual = 0
  let peakIndex = -1
  let peakZ = Number.NEGATIVE_INFINITY

  for (let index = 0; index < targetTopZ.length; index += 1) {
    const targetZ = targetTopZ[index]
    if (!Number.isFinite(targetZ)) continue
    if (targetZ > peakZ) {
      peakZ = targetZ
      peakIndex = index
    }

    const row = Math.floor(index / simulation.grid.cols)
    const col = index % simulation.grid.cols
    let stableInterior = (
      row > 1
      && row < simulation.grid.rows - 2
      && col > 1
      && col < simulation.grid.cols - 2
    )
    // A height field cannot represent a vertical wall. Exclude a two-cell
    // discontinuity band, but validate every smooth-surface and plateau cell.
    for (let rowOffset = -2; rowOffset <= 2 && stableInterior; rowOffset += 1) {
      for (let colOffset = -2; colOffset <= 2; colOffset += 1) {
        const neighbor = targetTopZ[
          (row + rowOffset) * simulation.grid.cols + col + colOffset
        ]
        if (!Number.isFinite(neighbor) || Math.abs(neighbor - targetZ) > tolerance) {
          stableInterior = false
          break
        }
      }
    }
    if (!stableInterior) continue

    stableInteriorCells += 1
    const gouge = targetZ - simulation.grid.topZ[index]
    if (gouge > tolerance) {
      stableInteriorGouges += 1
      maxStableInteriorGouge = Math.max(maxStableInteriorGouge, gouge)
    }
    const residual = simulation.grid.topZ[index] - targetZ
    if (residual > tolerance) {
      stableInteriorResiduals += 1
      maxStableInteriorResidual = Math.max(maxStableInteriorResidual, residual)
    }
  }

  assert(peakIndex >= 0, `expected rasterized target cells for ${operation.name}`)
  return {
    grid: simulation.grid,
    targetTopZ,
    tolerance,
    stableInteriorCells,
    stableInteriorGouges,
    maxStableInteriorGouge,
    stableInteriorResiduals,
    maxStableInteriorResidual,
    peakIndex,
  }
}

function assertNoStableInteriorGouges(
  operation: Operation,
  validation: TargetSurfaceValidation,
): void {
  assert(validation.stableInteriorCells > 0,
    `expected stable interior validation cells for ${operation.name}`)
  assert(validation.stableInteriorGouges === 0,
    `${operation.name} gouged ${validation.stableInteriorGouges} stable target cells; `
    + `maximum gouge ${validation.maxStableInteriorGouge}`)
}

function peakCell(validation: TargetSurfaceValidation): {
  x: number
  y: number
  targetZ: number
  simulatedZ: number
} {
  const row = Math.floor(validation.peakIndex / validation.grid.cols)
  const col = validation.peakIndex % validation.grid.cols
  return {
    x: validation.grid.originX + (col + 0.5) * validation.grid.cellSize,
    y: validation.grid.originY + (row + 0.5) * validation.grid.cellSize,
    targetZ: validation.targetTopZ[validation.peakIndex],
    simulatedZ: validation.grid.topZ[validation.peakIndex],
  }
}

function assertRepeatGenerationStable(
  project: Project,
  operation: Operation,
  first: PocketToolpathResult,
): void {
  const repeated = generateOperationToolpath(project, operation)
  assert(
    JSON.stringify(repeated) === JSON.stringify(first),
    `${operation.name} fixture generation changed between identical runs`,
  )
}

function makeCleanupOperation(source: Operation): Operation {
  return {
    ...source,
    id: 'issue-401-cleanup-validation',
    name: '3D Surface cleanup validation',
    kind: 'finish_surface_cleanup',
    pass: 'finish',
    pocketPattern: 'offset',
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
  }
}

function testConeFinishStrategies(): void {
  console.log('Testing real cone fixture with independent swept-cutter validation...')
  const project = loadFixture('issue-401-cone-finish.camj')
  const parallel = findOperation(
    project,
    (operation) => operation.kind === 'finish_surface' && operation.pocketPattern === 'parallel',
    'parallel finish',
  )
  const waterline = findOperation(
    project,
    (operation) => operation.kind === 'finish_surface' && operation.pocketPattern === 'waterline',
    'waterline finish',
  )

  const parallelResult = generateOperationToolpath(project, parallel)
  const waterlineResult = generateOperationToolpath(project, waterline)
  const parallelValidation = validateSweptSurface(project, parallel, parallelResult)
  const waterlineValidation = validateSweptSurface(project, waterline, waterlineResult)
  assertNoStableInteriorGouges(parallel, parallelValidation)
  assertNoStableInteriorGouges(waterline, waterlineValidation)
  assert(parallelValidation.stableInteriorResiduals === 0,
    `parallel finish left ${parallelValidation.stableInteriorResiduals} cone cells above tolerance; `
    + `maximum residual ${parallelValidation.maxStableInteriorResidual}`)
  assert(waterlineValidation.stableInteriorResiduals === 0,
    `Waterline left ${waterlineValidation.stableInteriorResiduals} cone cells above tolerance; `
    + `maximum residual ${waterlineValidation.maxStableInteriorResidual}`)

  const projectedCuts = cutMoves(waterlineResult).filter((move) => move.source)
  assert(projectedCuts.some((move) => move.source === 'projectedBand'),
    'expected cone Waterline to exercise projectedBand moves')
  const capCuts = projectedCuts.filter((move) => move.source === 'projectedCap')
  assert(capCuts.length > 0, 'expected cone Waterline to exercise projectedCap moves')

  const parallelPeak = peakCell(parallelValidation)
  const waterlinePeak = peakCell(waterlineValidation)
  assert(Math.abs(parallelPeak.simulatedZ - parallelPeak.targetZ) <= parallelValidation.tolerance,
    `parallel finish missed cone peak by ${parallelPeak.simulatedZ - parallelPeak.targetZ}`)
  assert(Math.abs(waterlinePeak.simulatedZ - waterlinePeak.targetZ) <= waterlineValidation.tolerance,
    `Waterline missed cone peak by ${waterlinePeak.simulatedZ - waterlinePeak.targetZ}`)
  assert(capCuts.some((move) => (
    Math.min(
      Math.hypot(move.from.x - waterlinePeak.x, move.from.y - waterlinePeak.y),
      Math.hypot(move.to.x - waterlinePeak.x, move.to.y - waterlinePeak.y),
    ) <= waterlineValidation.grid.cellSize
  )), 'expected projectedCap cutter motion over the cone apex')

  assertRepeatGenerationStable(project, parallel, parallelResult)
  assertRepeatGenerationStable(project, waterline, waterlineResult)
}

function testHardEdgeOperationMatrix(): void {
  console.log('Testing hard-edged fixture across Rough, Parallel, Waterline, and Cleanup...')
  const project = loadFixture('3d-imported-block-test3.camj')
  const rough = findOperation(
    project,
    (operation) => operation.kind === 'rough_surface',
    'rough surface',
  )
  const parallel = findOperation(
    project,
    (operation) => operation.kind === 'finish_surface' && operation.pocketPattern === 'parallel',
    'parallel finish',
  )
  const waterline = findOperation(
    project,
    (operation) => operation.kind === 'finish_surface' && operation.pocketPattern === 'waterline',
    'waterline finish',
  )
  const cleanup = makeCleanupOperation(rough)
  const operations = [rough, parallel, waterline, cleanup]
  const results = operations.map((operation) => generateOperationToolpath(project, operation))
  const validations = operations.map((operation, index) => (
    validateSweptSurface(project, operation, results[index])
  ))

  for (let index = 0; index < operations.length; index += 1) {
    assertNoStableInteriorGouges(operations[index], validations[index])
    assert(cutMoves(results[index]).length > 0, `${operations[index].name} emitted no cuts`)
    assertRepeatGenerationStable(project, operations[index], results[index])
  }

  const roughPeak = peakCell(validations[0])
  const expectedRoughStock = rough.stockToLeaveAxial
  assert(Math.abs((roughPeak.simulatedZ - roughPeak.targetZ) - expectedRoughStock)
    <= validations[0].tolerance,
  `rough peak stock ${roughPeak.simulatedZ - roughPeak.targetZ} did not match ${expectedRoughStock}`)

  for (const index of [1, 3]) {
    const finishPeak = peakCell(validations[index])
    assert(Math.abs(finishPeak.simulatedZ - finishPeak.targetZ) <= validations[index].tolerance,
      `${operations[index].name} missed the hard-edge fixture peak by `
      + `${finishPeak.simulatedZ - finishPeak.targetZ}`)
  }

  const waterlineProjectedCuts = cutMoves(results[2]).filter(
    (move) => move.source === 'projectedBand',
  )
  assert(waterlineProjectedCuts.length > 0,
    'expected hard-edge Waterline to exercise projectedBand safety')

  const cleanupCutLevels = new Set(
    cutMoves(results[3]).flatMap((move) => [move.from.z.toFixed(6), move.to.z.toFixed(6)]),
  )
  assert(cleanupCutLevels.size >= 4,
    `expected Cleanup to remove multiple roughing terraces, got ${cleanupCutLevels.size} Z levels`)
}

testConeFinishStrategies()
testHardEdgeOperationMatrix()

console.log('3D surface operation validation tests passed')
