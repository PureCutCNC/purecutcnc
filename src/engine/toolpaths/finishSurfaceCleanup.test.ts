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
 * Integration tests for 3D surface cleanup toolpath generation.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurfaceCleanup.test.ts
 */

import { readFileSync } from 'fs'
import { defaultTool, newProject, rectProfile, type Operation, type Project, type SketchFeature, type Tool } from '../../types/project'
import { normalizeProject } from '../../store/projectStore'
import { replaceProjectFeatures } from '../../test/projectFixtures'
import { serializeImportedMesh } from '../importedMesh'
import { generateFinishSurfaceCleanupToolpath } from './finishSurfaceCleanup'
import type { ToolpathMove } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) {
    throw new Error(`Assertion failed: ${message}`)
  }
}

function makeFrustumStlDataUrl(): string {
  const vertices = {
    b0: [0, 0, 0],
    b1: [12, 0, 0],
    b2: [12, 8, 0],
    b3: [0, 8, 0],
    t0: [4, 2, 6],
    t1: [8, 2, 6],
    t2: [8, 6, 6],
    t3: [4, 6, 6],
  } as const

  const faces: Array<[keyof typeof vertices, keyof typeof vertices, keyof typeof vertices]> = [
    ['b0', 'b2', 'b1'], ['b0', 'b3', 'b2'],
    ['t0', 't1', 't2'], ['t0', 't2', 't3'],
    ['b0', 'b1', 't1'], ['b0', 't1', 't0'],
    ['b1', 'b2', 't2'], ['b1', 't2', 't1'],
    ['b2', 'b3', 't3'], ['b2', 't3', 't2'],
    ['b3', 'b0', 't0'], ['b3', 't0', 't3'],
  ]

  const lines = ['solid frustum']
  for (const face of faces) {
    lines.push('  facet normal 0 0 0')
    lines.push('    outer loop')
    for (const key of face) {
      lines.push(`      vertex ${vertices[key].join(' ')}`)
    }
    lines.push('    endloop')
    lines.push('  endfacet')
  }
  lines.push('endsolid frustum')
  return `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`
}

function makeTool(): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 'tool1',
    name: '0.5 mm flat endmill',
    type: 'flat_endmill',
    diameter: 0.5,
    defaultStepdown: 1,
    defaultStepover: 0.5,
    maxCutDepth: 10,
  }
}

function makeModelFeature(): SketchFeature {
  return {
    id: 'model1',
    name: 'Frustum STL',
    kind: 'stl',
    stl: {
      format: 'stl',
      fileData: makeFrustumStlDataUrl(),
      scale: 1,
      axisSwap: 'none',
    },
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 12, 8),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: 6,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeContainingAddFeature(): SketchFeature {
  return {
    id: 'base1',
    name: 'Base stock feature',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(-2, -2, 16, 12),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 6,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeContainingSubtractFeature(): SketchFeature {
  return {
    id: 'pocket1',
    name: 'Containing pocket',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(-2, -2, 16, 12),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 6,
    z_bottom: 3,
    visible: true,
    locked: false,
  }
}

function makeRegionFeature(id: string, x: number, y: number, width: number, height: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, width, height),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'region',
    z_top: 0,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeCleanupOperation(featureIds: string[]): Operation {
  return {
    id: 'cleanup1',
    name: '3D Surface cleanup',
    kind: 'finish_surface_cleanup',
    pass: 'finish',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds },
    toolRef: 'tool1',
    stepdown: 1,
    stepover: 0.5,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'parallel',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'feature_first',
  }
}

function makeFrustumProject(featureIds: string[]): { project: Project; operation: Operation } {
  const project = {
    ...newProject('finish-surface-cleanup-frustum', 'mm'),
    tools: [makeTool()],
    features: [makeModelFeature()],
  }
  project.stock.thickness = 6
  return { project: normalizeProject(project), operation: makeCleanupOperation(featureIds) }
}

function appendVerticalQuad(
  vertices: number[],
  indices: number[],
  a: [number, number],
  b: [number, number],
  minZ: number,
  maxZ: number,
): void {
  const offset = vertices.length / 3
  vertices.push(
    a[0], a[1], minZ,
    b[0], b[1], minZ,
    b[0], b[1], maxZ,
    a[0], a[1], maxZ,
  )
  indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3)
}

function appendMeshQuad(
  vertices: number[],
  indices: number[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
): void {
  const offset = vertices.length / 3
  vertices.push(
    a[0], a[1], a[2],
    b[0], b[1], b[2],
    c[0], c[1], c[2],
    d[0], d[1], d[2],
  )
  indices.push(offset, offset + 1, offset + 2, offset, offset + 2, offset + 3)
}

function makePocketBlockProject(featureIds: string[]): { project: Project; operation: Operation } {
  const vertices: number[] = []
  const indices: number[] = []
  const minX = 0
  const minY = 0
  const minZ = 0
  const maxX = 20
  const maxY = 10
  const maxZ = 4
  const pocketMinX = 6
  const pocketMinY = 3
  const pocketMaxX = 14
  const pocketMaxY = 7
  const pocketFloorZ = 2

  appendMeshQuad(vertices, indices,
    [minX, minY, minZ], [maxX, minY, minZ], [maxX, maxY, minZ], [minX, maxY, minZ],
  )
  appendVerticalQuad(vertices, indices, [minX, minY], [maxX, minY], minZ, maxZ)
  appendVerticalQuad(vertices, indices, [maxX, minY], [maxX, maxY], minZ, maxZ)
  appendVerticalQuad(vertices, indices, [maxX, maxY], [minX, maxY], minZ, maxZ)
  appendVerticalQuad(vertices, indices, [minX, maxY], [minX, minY], minZ, maxZ)

  appendMeshQuad(vertices, indices,
    [minX, minY, maxZ], [maxX, minY, maxZ], [maxX, pocketMinY, maxZ], [minX, pocketMinY, maxZ],
  )
  appendMeshQuad(vertices, indices,
    [minX, pocketMaxY, maxZ], [maxX, pocketMaxY, maxZ], [maxX, maxY, maxZ], [minX, maxY, maxZ],
  )
  appendMeshQuad(vertices, indices,
    [minX, pocketMinY, maxZ], [pocketMinX, pocketMinY, maxZ], [pocketMinX, pocketMaxY, maxZ], [minX, pocketMaxY, maxZ],
  )
  appendMeshQuad(vertices, indices,
    [pocketMaxX, pocketMinY, maxZ], [maxX, pocketMinY, maxZ], [maxX, pocketMaxY, maxZ], [pocketMaxX, pocketMaxY, maxZ],
  )

  appendMeshQuad(vertices, indices,
    [pocketMinX, pocketMinY, pocketFloorZ], [pocketMaxX, pocketMinY, pocketFloorZ],
    [pocketMaxX, pocketMaxY, pocketFloorZ], [pocketMinX, pocketMaxY, pocketFloorZ],
  )
  appendVerticalQuad(vertices, indices, [pocketMinX, pocketMinY], [pocketMaxX, pocketMinY], pocketFloorZ, maxZ)
  appendVerticalQuad(vertices, indices, [pocketMaxX, pocketMinY], [pocketMaxX, pocketMaxY], pocketFloorZ, maxZ)
  appendVerticalQuad(vertices, indices, [pocketMaxX, pocketMaxY], [pocketMinX, pocketMaxY], pocketFloorZ, maxZ)
  appendVerticalQuad(vertices, indices, [pocketMinX, pocketMaxY], [pocketMinX, pocketMinY], pocketFloorZ, maxZ)

  const mesh = serializeImportedMesh({
    positions: new Float32Array(vertices),
    index: new Uint32Array(indices),
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
  }, 'stl')

  const model: SketchFeature = {
    id: 'model1',
    name: 'Pocket Block STL',
    kind: 'stl',
    stl: {
      format: 'stl',
      meshAssetId: 'pocket-block',
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ]],
    },
    folderId: null,
    sketch: {
      profile: rectProfile(minX, minY, maxX - minX, maxY - minY),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: maxZ,
    z_bottom: minZ,
    visible: true,
    locked: false,
  }
  const project = {
    ...newProject('finish-surface-cleanup-pocket-block', 'mm'),
    tools: [makeTool()],
    modelAssets: { 'pocket-block': mesh },
    features: [model],
  }
  project.stock.thickness = maxZ
  const operation = makeCleanupOperation(featureIds)
  return { project: normalizeProject(project), operation }
}

function makeSolidBlockProject(featureIds: string[]): { project: Project; operation: Operation } {
  const vertices: number[] = []
  const indices: number[] = []
  const minX = 0
  const minY = 0
  const minZ = 0
  const maxX = 20
  const maxY = 10
  const maxZ = 4

  appendMeshQuad(vertices, indices,
    [minX, minY, minZ], [maxX, minY, minZ], [maxX, maxY, minZ], [minX, maxY, minZ],
  )
  appendVerticalQuad(vertices, indices, [minX, minY], [maxX, minY], minZ, maxZ)
  appendVerticalQuad(vertices, indices, [maxX, minY], [maxX, maxY], minZ, maxZ)
  appendVerticalQuad(vertices, indices, [maxX, maxY], [minX, maxY], minZ, maxZ)
  appendVerticalQuad(vertices, indices, [minX, maxY], [minX, minY], minZ, maxZ)
  appendMeshQuad(vertices, indices,
    [minX, minY, maxZ], [maxX, minY, maxZ], [maxX, maxY, maxZ], [minX, maxY, maxZ],
  )

  const mesh = serializeImportedMesh({
    positions: new Float32Array(vertices),
    index: new Uint32Array(indices),
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
  }, 'stl')

  const model: SketchFeature = {
    id: 'model1',
    name: 'Solid Block STL',
    kind: 'stl',
    stl: {
      format: 'stl',
      meshAssetId: 'solid-block',
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: minX, y: minY },
        { x: maxX, y: minY },
        { x: maxX, y: maxY },
        { x: minX, y: maxY },
      ]],
    },
    folderId: null,
    sketch: {
      profile: rectProfile(minX, minY, maxX - minX, maxY - minY),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: maxZ,
    z_bottom: minZ,
    visible: true,
    locked: false,
  }
  const project = {
    ...newProject('finish-surface-cleanup-solid-block', 'mm'),
    tools: [makeTool()],
    modelAssets: { 'solid-block': mesh },
    features: [model],
  }
  project.stock.thickness = maxZ
  const operation = makeCleanupOperation(featureIds)
  return { project: normalizeProject(project), operation }
}

function makeOpenSliceProject(): { project: Project; operation: Operation } {
  const vertices: number[] = []
  const indices: number[] = []
  appendMeshQuad(vertices, indices,
    [4, 2, 3], [8, 2, 3], [8, 6, 3], [4, 6, 3],
  )
  appendMeshQuad(vertices, indices,
    [4, 2, 6], [8, 2, 6], [8, 6, 6], [4, 6, 6],
  )
  appendVerticalQuad(vertices, indices, [4, 2], [8, 2], 3, 6)
  appendVerticalQuad(vertices, indices, [8, 2], [8, 6], 3, 6)
  appendVerticalQuad(vertices, indices, [8, 6], [4, 6], 3, 6)
  appendVerticalQuad(vertices, indices, [4, 6], [4, 2], 3, 6)

  appendVerticalQuad(vertices, indices, [0, 0], [12, 0], 0, 3)
  appendVerticalQuad(vertices, indices, [12, 0], [12, 8], 0, 3)
  appendVerticalQuad(vertices, indices, [12, 8], [0, 8], 0, 3)

  const mesh = serializeImportedMesh({
    positions: new Float32Array(vertices),
    index: new Uint32Array(indices),
    bounds: {
      minX: 0,
      maxX: 12,
      minY: 0,
      maxY: 8,
      minZ: 0,
      maxZ: 6,
    },
  }, 'stl')

  const model: SketchFeature = {
    ...makeModelFeature(),
    stl: {
      format: 'stl',
      meshAssetId: 'open-shell',
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: 0, y: 0 },
        { x: 12, y: 0 },
        { x: 12, y: 8 },
        { x: 0, y: 8 },
        { x: 0, y: 0 },
      ]],
    },
    sketch: {
      ...makeModelFeature().sketch,
      profile: rectProfile(0, 0, 12, 8),
    },
  }
  const project = {
    ...newProject('finish-surface-cleanup-open-shell', 'mm'),
    tools: [makeTool()],
    modelAssets: { 'open-shell': mesh },
    features: [model],
  }
  project.stock.thickness = 6
  return { project: normalizeProject(project), operation: makeCleanupOperation(['model1']) }
}

function loadTrackedImportedBlockCleanupProject(): { project: Project; operation: Operation } {
  const raw = readFileSync(new URL('../test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8')
  const project = normalizeProject(JSON.parse(raw) as Project)
  const sourceOperation = project.operations.find((candidate) => candidate.kind === 'rough_surface')
  if (!sourceOperation) {
    throw new Error('expected rough_surface operation in 3d-imported-block-test3.camj')
  }
  const operation: Operation = {
    ...sourceOperation,
    id: 'cleanup-fixture-op',
    name: '3D Surface cleanup fixture',
    kind: 'finish_surface_cleanup',
    pass: 'finish',
    pocketPattern: 'offset',
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
  }
  return { project, operation }
}

function loadTrackedModelInPocketCleanupProject(): { project: Project; operation: Operation } {
  const raw = readFileSync(new URL('../test-fixtures/model-in-pocket.camj', import.meta.url), 'utf8')
  const project = normalizeProject(JSON.parse(raw) as Project)
  const operation = project.operations.find((candidate) => candidate.kind === 'finish_surface_cleanup')
  if (!operation) {
    throw new Error('expected finish_surface_cleanup operation in model-in-pocket.camj')
  }
  return { project, operation }
}


function cutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((move) => move.kind === 'cut')
}

function distinctCutZs(moves: ToolpathMove[]): number[] {
  return [...new Set(cutMoves(moves).map((move) => Number(move.to.z.toFixed(4))))].sort((a, b) => b - a)
}

function cutBounds(moves: ToolpathMove[]): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const cuts = cutMoves(moves)
  if (cuts.length === 0) {
    return null
  }

  let minX = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY
  for (const move of cuts) {
    for (const point of [move.from, move.to]) {
      minX = Math.min(minX, point.x)
      maxX = Math.max(maxX, point.x)
      minY = Math.min(minY, point.y)
      maxY = Math.max(maxY, point.y)
    }
  }

  return { minX, maxX, minY, maxY }
}

function cutBoundsAtZ(
  moves: ToolpathMove[],
  z: number,
): { minX: number; maxX: number; minY: number; maxY: number } | null {
  const levelCuts = cutMoves(moves).filter((move) => Math.abs(move.to.z - z) < 1e-9)
  return cutBounds(levelCuts)
}

function countInteriorCuts(
  moves: ToolpathMove[],
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
): number {
  return cutMoves(moves).filter((move) => (
    Math.min(move.from.x, move.to.x) > bounds.minX
    && Math.max(move.from.x, move.to.x) < bounds.maxX
    && Math.min(move.from.y, move.to.y) > bounds.minY
    && Math.max(move.from.y, move.to.y) < bounds.maxY
  )).length
}

function testCleanupRejectsDisabledFinishModes(): void {
  console.log('Testing finish_surface_cleanup rejects both finish toggles disabled...')
  const { project, operation } = makePocketBlockProject(['model1'])
  operation.finishWalls = false
  operation.finishFloor = false
  const result = generateFinishSurfaceCleanupToolpath(project, operation)

  assert(result.moves.length === 0, 'expected no cleanup moves')
  assert(result.warnings.includes('Finish operation has both Finish Walls and Finish Floor disabled'), 'expected disabled-finish warning')
}

function testCleanupUsesInternalSamplingStepdown(): void {
  console.log('Testing finish_surface_cleanup uses internal sampling stepdown instead of the stored operation stepdown...')
  const { project, operation } = makePocketBlockProject(['model1'])
  operation.stepdown = 0
  const result = generateFinishSurfaceCleanupToolpath(project, operation)

  assert(cutMoves(result.moves).length > 0, 'expected cleanup moves even when the stored stepdown is zero')
  assert(!result.warnings.includes('Operation stepdown must be greater than zero'), 'expected cleanup to ignore the stored stepdown validation')
}

function testCleanupWarnsOnStockToLeave(): void {
  console.log('Testing finish_surface_cleanup warns when stock-to-leave is non-zero...')
  const { project, operation } = makePocketBlockProject(['model1'])
  operation.stockToLeaveRadial = 0.1
  operation.stockToLeaveAxial = 0.2
  const result = generateFinishSurfaceCleanupToolpath(project, operation)

  assert(result.warnings.some((warning) => warning.includes('stock-to-leave values')), 'expected cleanup stock-to-leave warning')
}

function testCleanupWallsEmitOnlyLowestRetainedLevels(): void {
  console.log('Testing finish_surface_cleanup emits wall cleanup only at deepest retained levels...')
  const { project, operation } = makePocketBlockProject(['model1'])
  operation.finishFloor = false
  const result = generateFinishSurfaceCleanupToolpath(project, operation)
  const zLevels = distinctCutZs(result.moves)

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected cleanup wall moves')
  assert(zLevels.length === 2, `expected exactly two retained wall levels, got ${zLevels.join(', ')}`)
  assert(zLevels[0] === 2 && zLevels[1] === 0, `expected retained wall levels [2, 0], got ${zLevels.join(', ')}`)
}

function testCleanupFloorsEmitOnlyLowestRetainedLevels(): void {
  console.log('Testing finish_surface_cleanup emits floor cleanup only at deepest retained levels...')
  const { project, operation } = makePocketBlockProject(['model1'])
  operation.finishWalls = false
  const result = generateFinishSurfaceCleanupToolpath(project, operation)
  const zLevels = distinctCutZs(result.moves)
  const pocketFloorCuts = cutMoves(result.moves).filter((move) => Math.abs(move.to.z - 2) < 1e-9)

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected cleanup floor moves')
  assert(zLevels.length === 2, `expected exactly two retained floor levels, got ${zLevels.join(', ')}`)
  assert(zLevels[0] === 4 && zLevels[1] === 2, `expected retained floor levels [4, 2], got ${zLevels.join(', ')}`)
  assert(pocketFloorCuts.length > 0, 'expected cleanup cuts at the pocket-floor Z level')
}

function testCleanupOffsetFloorsReachFinishBoundary(): void {
  console.log('Testing finish_surface_cleanup offset floors include the first boundary ring...')
  const { project, operation } = makePocketBlockProject(['model1'])
  operation.finishWalls = false
  operation.finishFloor = true
  operation.pocketPattern = 'offset'
  const result = generateFinishSurfaceCleanupToolpath(project, operation)
  const topFloorBounds = cutBoundsAtZ(result.moves, 4)
  const pocketFloorBounds = cutBoundsAtZ(result.moves, 2)

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(topFloorBounds !== null, 'expected top-floor cleanup cuts at Z=4')
  assert(pocketFloorBounds !== null, 'expected pocket-floor cleanup cuts at Z=2')
  if (!topFloorBounds || !pocketFloorBounds) {
    throw new Error('expected floor cleanup bounds')
  }

  assert(topFloorBounds.minX <= 0.26, `expected top-floor cleanup to reach the finish boundary near X=0.25, got minX ${topFloorBounds.minX}`)
  assert(topFloorBounds.maxX >= 19.74, `expected top-floor cleanup to reach the finish boundary near X=19.75, got maxX ${topFloorBounds.maxX}`)
  assert(pocketFloorBounds.minX <= 6.26, `expected pocket-floor cleanup to reach the pocket wall near X=6.25, got minX ${pocketFloorBounds.minX}`)
  assert(pocketFloorBounds.maxX >= 13.74, `expected pocket-floor cleanup to reach the pocket wall near X=13.75, got maxX ${pocketFloorBounds.maxX}`)
}

function testCleanupSolidBlockOuterWallEmitsSingleContour(): void {
  console.log('Testing finish_surface_cleanup emits a single outer-wall contour for a solid block...')
  const { project, operation } = makeSolidBlockProject(['model1'])
  operation.finishFloor = false
  const result = generateFinishSurfaceCleanupToolpath(project, operation)
  const wallCutsAtBottom = cutMoves(result.moves).filter((move) => Math.abs(move.to.z) < 1e-9)

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(wallCutsAtBottom.length === 4, `expected one rectangular outer-wall contour (4 cut moves), got ${wallCutsAtBottom.length}`)
}

function testCleanupIntersectingOuterWallAvoidsDuplicateReturnLoop(): void {
  console.log('Testing finish_surface_cleanup avoids the duplicate return loop on intersecting outer walls...')
  const { project, operation } = loadTrackedImportedBlockCleanupProject()
  operation.finishWalls = true
  operation.finishFloor = false
  const result = generateFinishSurfaceCleanupToolpath(project, operation)
  const wallCutsAtBottom = cutMoves(result.moves).filter((move) => Math.abs(move.to.z) < 1e-9)
  const lastCut = wallCutsAtBottom.at(-1) ?? null

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(wallCutsAtBottom.length === 6, `expected the intersecting outer wall to collapse to one retained run (6 cut moves), got ${wallCutsAtBottom.length}`)
  assert(lastCut !== null, 'expected a retained intersecting-wall tail segment')
  if (!lastCut) {
    throw new Error('expected a retained intersecting-wall tail segment')
  }
  assert(lastCut.to.x > 3.5 && lastCut.to.y < 1.53, `expected the retained wall run to terminate on the intersecting diagonal, got (${lastCut.to.x}, ${lastCut.to.y})`)
}

function testCleanupRespectsContainingPocketDepth(): void {
  console.log('Testing finish_surface_cleanup respects containing subtract pocket depth...')
  const { project, operation } = makeFrustumProject(['model1'])
  replaceProjectFeatures(project, [makeContainingAddFeature(), makeContainingSubtractFeature(), ...project.features])
  const result = generateFinishSurfaceCleanupToolpath(project, operation)
  const minCutZ = Math.min(...cutMoves(result.moves).map((move) => move.to.z))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected cleanup moves')
  assert(minCutZ >= 3 - 1e-9, `expected no cleanup cuts below containing pocket bottom, got min Z ${minCutZ}`)
}

function testCleanupKeepsOuterWallEnvelopeTight(): void {
  console.log('Testing finish_surface_cleanup keeps outer wall envelope close to the model silhouette...')
  const { project, operation } = makePocketBlockProject(['model1'])
  const result = generateFinishSurfaceCleanupToolpath(project, operation)
  const bounds = cutBounds(result.moves)
  const allowedOvershoot = operation.stockToLeaveRadial + project.tools[0].diameter / 2 + 0.002

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(bounds !== null, 'expected cleanup cut bounds')
  if (!bounds) {
    throw new Error('expected cleanup cut bounds')
  }

  assert(bounds.minX >= -allowedOvershoot, `expected minX >= -${allowedOvershoot}, got ${bounds.minX}`)
  assert(bounds.maxX <= 20 + allowedOvershoot, `expected maxX <= ${20 + allowedOvershoot}, got ${bounds.maxX}`)
  assert(bounds.minY >= -allowedOvershoot, `expected minY >= -${allowedOvershoot}, got ${bounds.minY}`)
  assert(bounds.maxY <= 10 + allowedOvershoot, `expected maxY <= ${10 + allowedOvershoot}, got ${bounds.maxY}`)
}

function testCleanupRespectsRegionMask(): void {
  console.log('Testing finish_surface_cleanup respects region-mask clipping...')
  const { project, operation } = makePocketBlockProject(['model1', 'region-left'])
  replaceProjectFeatures(project, [...project.features, makeRegionFeature('region-left', -2, -2, 12, 14)])
  const result = generateFinishSurfaceCleanupToolpath(project, operation)

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(result.bounds !== null, 'expected cleanup bounds')
  if (!result.bounds) {
    throw new Error('expected cleanup bounds')
  }
  assert(result.bounds.maxX <= 10 + 1e-6, `expected region-clipped cleanup bounds maxX <= 10, got ${result.bounds.maxX}`)
}

function testCleanupWarnsOnOpenSliceFallback(): void {
  console.log('Testing finish_surface_cleanup warns on open-slice fallback...')
  const { project, operation } = makeOpenSliceProject()
  const result = generateFinishSurfaceCleanupToolpath(project, operation)

  assert(result.warnings.some((warning) => warning.includes('open/non-watertight slices')), 'expected open-slice fallback warning')
}

function testCleanupRespectsContainingPocketWallsAndFloor(): void {
  console.log('Testing finish_surface_cleanup respects containing pocket walls and floor...')
  const { project, operation } = loadTrackedModelInPocketCleanupProject()

  const wallOnly = generateFinishSurfaceCleanupToolpath(project, {
    ...operation,
    finishWalls: true,
    finishFloor: false,
  })
  const floorOnly = generateFinishSurfaceCleanupToolpath(project, {
    ...operation,
    finishWalls: false,
    finishFloor: true,
  })

  const wallZs = distinctCutZs(wallOnly.moves)
  const floorZs = distinctCutZs(floorOnly.moves)
  const pocketInteriorBounds = {
    minX: 0.6,
    maxX: 3.4,
    minY: 0.6,
    maxY: 2.4,
  }

  assert(wallOnly.warnings.length === 0, `unexpected wall warnings: ${wallOnly.warnings.join(', ')}`)
  assert(floorOnly.warnings.length === 0, `unexpected floor warnings: ${floorOnly.warnings.join(', ')}`)
  assert(wallZs.length === 1 && wallZs[0] === 0.5, `expected wall cleanup only at the pocket floor Z=0.5, got ${wallZs.join(', ')}`)
  assert(countInteriorCuts(wallOnly.moves, pocketInteriorBounds) > 100, 'expected wall cleanup to include interior island walls inside the pocket')
  assert(floorZs.includes(0.5), `expected floor cleanup to include the containing pocket floor at Z=0.5, got ${floorZs.join(', ')}`)
}

async function run(): Promise<void> {
  testCleanupRejectsDisabledFinishModes()
  testCleanupUsesInternalSamplingStepdown()
  testCleanupWarnsOnStockToLeave()
  testCleanupWallsEmitOnlyLowestRetainedLevels()
  testCleanupFloorsEmitOnlyLowestRetainedLevels()
  testCleanupOffsetFloorsReachFinishBoundary()
  testCleanupSolidBlockOuterWallEmitsSingleContour()
  testCleanupIntersectingOuterWallAvoidsDuplicateReturnLoop()
  testCleanupRespectsContainingPocketDepth()
  testCleanupKeepsOuterWallEnvelopeTight()
  testCleanupRespectsRegionMask()
  testCleanupWarnsOnOpenSliceFallback()
  testCleanupRespectsContainingPocketWallsAndFloor()
  console.log('finishSurfaceCleanup.test.ts: all tests passed')
}

void run()
