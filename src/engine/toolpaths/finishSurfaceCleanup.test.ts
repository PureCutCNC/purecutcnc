/**
 * Integration tests for 3D surface cleanup toolpath generation.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurfaceCleanup.test.ts
 */

import { defaultTool, newProject, rectProfile, type Operation, type Project, type SketchFeature, type Tool } from '../../types/project'
import { normalizeProject } from '../../store/projectStore'
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

function testCleanupRejectsDisabledFinishModes(): void {
  console.log('Testing finish_surface_cleanup rejects both finish toggles disabled...')
  const { project, operation } = makePocketBlockProject(['model1'])
  operation.finishWalls = false
  operation.finishFloor = false
  const result = generateFinishSurfaceCleanupToolpath(project, operation)

  assert(result.moves.length === 0, 'expected no cleanup moves')
  assert(result.warnings.includes('Finish operation has both Finish Walls and Finish Floor disabled'), 'expected disabled-finish warning')
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

function testCleanupSolidBlockOuterWallEmitsSingleContour(): void {
  console.log('Testing finish_surface_cleanup emits a single outer-wall contour for a solid block...')
  const { project, operation } = makeSolidBlockProject(['model1'])
  operation.finishFloor = false
  const result = generateFinishSurfaceCleanupToolpath(project, operation)
  const wallCutsAtBottom = cutMoves(result.moves).filter((move) => Math.abs(move.to.z) < 1e-9)

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(wallCutsAtBottom.length === 4, `expected one rectangular outer-wall contour (4 cut moves), got ${wallCutsAtBottom.length}`)
}

function testCleanupRespectsContainingPocketDepth(): void {
  console.log('Testing finish_surface_cleanup respects containing subtract pocket depth...')
  const { project, operation } = makeFrustumProject(['model1'])
  project.features = [makeContainingAddFeature(), makeContainingSubtractFeature(), ...project.features]
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
  project.features = [...project.features, makeRegionFeature('region-left', -2, -2, 12, 14)]
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

function run(): void {
  testCleanupRejectsDisabledFinishModes()
  testCleanupWallsEmitOnlyLowestRetainedLevels()
  testCleanupFloorsEmitOnlyLowestRetainedLevels()
  testCleanupSolidBlockOuterWallEmitsSingleContour()
  testCleanupRespectsContainingPocketDepth()
  testCleanupKeepsOuterWallEnvelopeTight()
  testCleanupRespectsRegionMask()
  testCleanupWarnsOnOpenSliceFallback()
  console.log('finishSurfaceCleanup.test.ts: all tests passed')
}

run()
