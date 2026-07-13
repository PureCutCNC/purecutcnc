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
 * Integration tests for rough surface toolpath generation.
 *
 * Run with: npx tsx src/engine/toolpaths/roughSurface.test.ts
 */

import { defaultTool, newProject, rectProfile, type Operation, type Project, type SketchFeature, type Tool } from '../../types/project'
import { serializeImportedMesh } from '../importedMesh'
import { generateRoughSurfaceToolpath } from './roughSurface'
import { transitionToCutEntry } from './pocket'
import type { ToolpathMove, ToolpathPoint } from './types'
import { projectWithFeatures, replaceProjectFeatures } from '../../test/projectFixtures'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeFrustumStlDataUrl(inverted = false): string {
  const vertices = inverted
    ? {
        b0: [4, 2, 0],
        b1: [8, 2, 0],
        b2: [8, 6, 0],
        b3: [4, 6, 0],
        t0: [0, 0, 6],
        t1: [12, 0, 6],
        t2: [12, 8, 6],
        t3: [0, 8, 6],
      } as const
    : {
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

function makeModelFeature(includeFormat = true, inverted = false): SketchFeature {
  return {
    id: 'model1',
    name: 'Frustum STL',
    kind: 'stl',
    stl: {
      ...(includeFormat ? { format: 'stl' as const } : {}),
      fileData: makeFrustumStlDataUrl(inverted),
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

function makeRegionFeature(): SketchFeature {
  return {
    id: 'region1',
    name: 'Region',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(-2, -2, 16, 12),
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

function makeProtectedAddFeature(): SketchFeature {
  return {
    id: 'fixture1',
    name: 'Protected fixture',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(-0.45, 3, 0.35, 2),
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

function makeTightContainingAddFeature(): SketchFeature {
  return {
    id: 'base-tight',
    name: 'Tight base stock feature',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 12, 8),
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

function makeTightContainingSubtractFeature(): SketchFeature {
  return {
    ...makeContainingSubtractFeature(),
    id: 'pocket-tight',
    name: 'Tight containing pocket',
    sketch: {
      profile: rectProfile(0, 0, 12, 8),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
  }
}

function makeRightHalfSubtractFeature(): SketchFeature {
  return {
    id: 'pocket2',
    name: 'Deeper right pocket',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(6, -2, 8, 12),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 6,
    z_bottom: 2,
    visible: true,
    locked: false,
  }
}

function makeRoughOperation(featureIds: string[]): Operation {
  return {
    id: 'rough1',
    name: 'Rough Surface',
    kind: 'rough_surface',
    pass: 'rough',
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
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 1,
    maxCarveDepth: 1,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
  }
}

// Frustum models in these fixtures occupy Z=0..6. Set stock thickness to
// match the model so the rough op doesn't try to clear 14 mm of dead space
// above the model (which exceeds the 10 mm tool maxCutDepth).
const TEST_STOCK_THICKNESS = 6

function makeProject(featureIds: string[]): { project: Project; operation: Operation } {
  const model = makeModelFeature()
  const region = makeRegionFeature()
  const project = projectWithFeatures({
    ...newProject('rough-surface-test', 'mm'),
    tools: [makeTool()],
  }, [model, region])
  project.stock.thickness = TEST_STOCK_THICKNESS
  return { project, operation: makeRoughOperation(featureIds) }
}

function makeLegacyProject(featureIds: string[]): { project: Project; operation: Operation } {
  const model = makeModelFeature(false)
  const region = makeRegionFeature()
  const project = projectWithFeatures({
    ...newProject('rough-surface-legacy-test', 'mm'),
    tools: [makeTool()],
  }, [model, region])
  project.stock.thickness = TEST_STOCK_THICKNESS
  return { project, operation: makeRoughOperation(featureIds) }
}

function makeInvertedProject(featureIds: string[]): { project: Project; operation: Operation } {
  const model = makeModelFeature(true, true)
  const region = makeRegionFeature()
  const project = projectWithFeatures({
    ...newProject('rough-surface-inverted-test', 'mm'),
    tools: [makeTool()],
  }, [model, region])
  project.stock.thickness = TEST_STOCK_THICKNESS
  return { project, operation: makeRoughOperation(featureIds) }
}

function appendMeshBox(
  vertices: number[],
  indices: number[],
  minX: number,
  maxX: number,
  minY: number,
  maxY: number,
  minZ: number,
  maxZ: number,
): void {
  const offset = vertices.length / 3
  vertices.push(
    minX, minY, minZ,
    maxX, minY, minZ,
    maxX, maxY, minZ,
    minX, maxY, minZ,
    minX, minY, maxZ,
    maxX, minY, maxZ,
    maxX, maxY, maxZ,
    minX, maxY, maxZ,
  )
  const faces = [
    [0, 1, 2], [0, 2, 3],
    [4, 6, 5], [4, 7, 6],
    [0, 4, 5], [0, 5, 1],
    [1, 5, 6], [1, 6, 2],
    [2, 6, 7], [2, 7, 3],
    [3, 7, 4], [3, 4, 0],
  ]
  for (const face of faces) {
    indices.push(offset + face[0], offset + face[1], offset + face[2])
  }
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

function makePocketBlockProject(): { project: Project; operation: Operation } {
  const vertices: number[] = []
  const indices: number[] = []
  const minX = 0, minY = 0, minZ = 0
  const maxX = 20, maxY = 10, maxZ = 4
  const pocketMinX = 6, pocketMinY = 3, pocketMaxX = 14, pocketMaxY = 7, pocketFloorZ = 2

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
    ...makeModelFeature(),
    name: 'Pocket Block STL',
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
    sketch: {
      ...makeModelFeature().sketch,
      profile: rectProfile(minX, minY, maxX - minX, maxY - minY),
    },
    z_top: maxZ,
    z_bottom: minZ,
  }
  const project = projectWithFeatures({
    ...newProject('rough-surface-pocket-block-test', 'mm'),
    tools: [makeTool()],
    modelAssets: { 'pocket-block': mesh },
  }, [model])
  project.stock.thickness = maxZ
  const operation = {
    ...makeRoughOperation(['model1']),
    stepdown: 1,
  }
  return { project, operation }
}

function makeOpenSliceProject(): { project: Project; operation: Operation } {
  const vertices: number[] = []
  const indices: number[] = []
  appendMeshBox(vertices, indices, 4, 8, 2, 6, 3, 6)

  // A non-watertight lower shell: this produces open horizontal slice chains.
  appendVerticalQuad(vertices, indices, [0, 0], [12, 0], 0, 3)
  appendVerticalQuad(vertices, indices, [12, 0], [12, 8], 0, 3)
  appendVerticalQuad(vertices, indices, [12, 8], [0, 8], 0, 3)

  const positions = new Float32Array(vertices)
  const index = new Uint32Array(indices)
  const mesh = serializeImportedMesh({
    positions,
    index,
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
  }
  const project = projectWithFeatures({
    ...newProject('rough-surface-open-shell-test', 'mm'),
    tools: [makeTool()],
    modelAssets: { 'open-shell': mesh },
  }, [model])
  project.stock.thickness = TEST_STOCK_THICKNESS
  const operation = {
    ...makeRoughOperation(['model1']),
    stepdown: 2,
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

function moveTouchesRect(
  move: ToolpathMove,
  rect: { minX: number; maxX: number; minY: number; maxY: number },
): boolean {
  return [move.from, move.to].some((point) => (
    point.x > rect.minX && point.x < rect.maxX &&
    point.y > rect.minY && point.y < rect.maxY
  ))
}

function testRoughSurfaceGeneratesChangingZCuts(): void {
  console.log('Testing rough_surface real generator on synthetic STL...')
  const { project, operation } = makeProject(['model1'])
  const result = generateRoughSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const zLevels = distinctCutZs(result.moves)

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected rough surface cut moves')
  assert(zLevels.length >= 3, `expected cuts at multiple Z levels, got ${zLevels.join(', ')}`)
  assert(result.bounds !== null, 'expected non-null toolpath bounds')
}

function testRoughSurfaceFindsModelWhenRegionIsFirst(): void {
  console.log('Testing rough_surface target order with region before model...')
  const { project, operation } = makeProject(['region1', 'model1'])
  const result = generateRoughSurfaceToolpath(project, operation)

  assert(!result.warnings.includes('Model feature must be an imported mesh model'), 'model lookup should not depend on first target feature')
  assert(cutMoves(result.moves).length > 0, 'expected rough surface moves with region-first target order')
}

function testRoughSurfaceDefaultsLegacyModelFormatToStl(): void {
  console.log('Testing rough_surface legacy STL model format default...')
  const { project, operation } = makeLegacyProject(['model1'])
  const result = generateRoughSurfaceToolpath(project, operation)

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected rough surface moves for legacy STL model data')
}

function testRoughSurfaceCutsVerticalPocketAndOutsideWall(): void {
  console.log('Testing rough_surface cuts vertical-walled imported pocket block...')
  const { project, operation } = makePocketBlockProject()
  const result = generateRoughSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const topDeckCuts = cuts.filter((move) => (
    Math.abs(move.to.z - 4) < 1e-9 &&
    moveTouchesRect(move, {
      minX: 1,
      maxX: 5,
      minY: 1,
      maxY: 2,
    })
  ))
  const pocketCuts = cuts.filter((move) => moveTouchesRect(move, {
    minX: 6.25,
    maxX: 13.75,
    minY: 3.25,
    maxY: 6.75,
  }))
  const outsideWallCuts = cuts.filter((move) => [move.from, move.to].some((point) => (
    point.x < 0 || point.x > 20 || point.y < 0 || point.y > 10
  )))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected rough surface cuts on pocket block')
  assert(topDeckCuts.length > 0, 'expected rough cuts on the top deck')
  assert(pocketCuts.length > 0, 'expected rough cuts inside the vertical-walled pocket')
  assert(outsideWallCuts.length > 0, 'expected rough cuts around the outside wall')
}

function testRoughSurfaceKeepsOuterWallEnvelopeTight(): void {
  console.log('Testing rough_surface keeps outer wall envelope close to the model silhouette...')
  const { project, operation } = makePocketBlockProject()
  const result = generateRoughSurfaceToolpath(project, operation)
  const bounds = cutBounds(result.moves)
  const allowedOvershoot = operation.stockToLeaveRadial + project.tools[0].diameter / 2 + 0.002

  assert(bounds !== null, 'expected rough surface cut bounds')
  if (!bounds) {
    throw new Error('expected rough surface cut bounds')
  }

  assert(bounds.minX >= -allowedOvershoot, `expected minX >= -${allowedOvershoot}, got ${bounds.minX}`)
  assert(bounds.maxX <= 20 + allowedOvershoot, `expected maxX <= ${20 + allowedOvershoot}, got ${bounds.maxX}`)
  assert(bounds.minY >= -allowedOvershoot, `expected minY >= -${allowedOvershoot}, got ${bounds.minY}`)
  assert(bounds.maxY <= 10 + allowedOvershoot, `expected maxY <= ${10 + allowedOvershoot}, got ${bounds.maxY}`)
}

function testRoughSurfaceProtectsOverhangingModelShadow(): void {
  console.log('Testing rough_surface protects upper model shadow on inverted taper...')
  const { project, operation } = makeInvertedProject(['model1'])
  const result = generateRoughSurfaceToolpath(project, operation)
  const destructiveCuts = cutMoves(result.moves).filter((move) => {
    if (move.to.z > 3) return false
    const endpoints = [move.from, move.to]
    return endpoints.some((point) => (
      point.x > 0.25 && point.x < 11.75 &&
      point.y > 0.25 && point.y < 7.75
    ))
  })

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected rough surface moves for inverted taper')
  assert(destructiveCuts.length === 0, `expected no lower-level cuts inside upper model shadow, got ${destructiveCuts.length}`)
}

function testRoughSurfaceProtectsOpenMeshSlicesConservatively(): void {
  console.log('Testing rough_surface protects open mesh slices conservatively...')
  const { project, operation } = makeOpenSliceProject()
  const result = generateRoughSurfaceToolpath(project, operation)
  const destructiveCuts = cutMoves(result.moves).filter((move) => {
    if (move.to.z > 2 + 1e-9) return false
    const endpoints = [move.from, move.to]
    return endpoints.some((point) => (
      point.x > 0.25 && point.x < 11.75 &&
      point.y > 0.25 && point.y < 7.75
    ))
  })

  assert(
    result.warnings.some((warning) => warning.includes('open/non-watertight slices')),
    `expected open-slice warning, got: ${result.warnings.join(', ')}`,
  )
  assert(cutMoves(result.moves).length > 0, 'expected rough surface moves')
  assert(destructiveCuts.length === 0, `expected no rough cuts inside open-slice silhouette, got ${destructiveCuts.length}`)
}

function testRoughSurfaceAvoidsSurroundingAddFeature(): void {
  console.log('Testing rough_surface avoids surrounding add feature footprints...')
  const { project, operation } = makeProject(['model1'])
  replaceProjectFeatures(project, [...project.features, makeProtectedAddFeature()])
  const result = generateRoughSurfaceToolpath(project, operation)
  const protectedCuts = cutMoves(result.moves).filter((move) => {
    const endpoints = [move.from, move.to]
    return endpoints.some((point) => (
      point.x > -0.5 && point.x < 0.05 &&
      point.y > 2.8 && point.y < 5.2
    ))
  })

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected rough surface moves')
  assert(protectedCuts.length === 0, `expected no rough cuts inside protected add feature, got ${protectedCuts.length}`)
}

function testRoughSurfaceIgnoresContainingBaseFeature(): void {
  console.log('Testing rough_surface ignores containing base add feature...')
  const { project, operation } = makeProject(['model1'])
  replaceProjectFeatures(project, [makeContainingAddFeature(), ...project.features])
  const result = generateRoughSurfaceToolpath(project, operation)

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected rough surface moves when a base add feature contains the model envelope')
}

function testRoughSurfaceIgnoresTightBaseWhenPocketLimitsEnvelope(): void {
  console.log('Testing rough_surface ignores tight base when containing pocket limits envelope...')
  const { project, operation } = makeProject(['model1'])
  replaceProjectFeatures(project, [makeTightContainingAddFeature(), makeTightContainingSubtractFeature(), ...project.features])
  const result = generateRoughSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected rough surface moves inside active containing pocket even when base stock is tighter than the expanded rough outline')
}

function testRoughSurfaceRespectsContainingPocketDepth(): void {
  console.log('Testing rough_surface respects containing subtract pocket depth...')
  const { project, operation } = makeProject(['model1'])
  replaceProjectFeatures(project, [makeContainingAddFeature(), makeContainingSubtractFeature(), ...project.features])
  const result = generateRoughSurfaceToolpath(project, operation)
  const minCutZ = Math.min(...cutMoves(result.moves).map((move) => move.to.z))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected rough surface moves')
  assert(minCutZ >= 3 - 1e-9, `expected no rough cuts below containing pocket bottom, got min Z ${minCutZ}`)
}

function testRoughSurfaceRespectsSplitPocketDepths(): void {
  console.log('Testing rough_surface respects split subtract pocket depths...')
  const { project, operation } = makeProject(['model1'])
  replaceProjectFeatures(project, [makeContainingAddFeature(), makeContainingSubtractFeature(), makeRightHalfSubtractFeature(), ...project.features])
  const result = generateRoughSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const belowShallow = cuts.filter((move) => move.to.z < 3 - 1e-9)
  const leftBelowShallow = belowShallow.filter((move) => (
    (move.from.x < 6 - 1e-9) || (move.to.x < 6 - 1e-9)
  ))
  const minCutZ = Math.min(...cuts.map((move) => move.to.z))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected rough surface moves')
  assert(minCutZ >= 2 - 1e-9, `expected no rough cuts below deeper pocket bottom, got min Z ${minCutZ}`)
  assert(belowShallow.length > 0, 'expected rough cuts below shallow pocket bottom in deeper right pocket')
  assert(leftBelowShallow.length === 0, `expected no rough cuts below shallow pocket bottom on left side, got ${leftBelowShallow.length}`)
}

function testRoughSurfaceLinksOffsetRingsAtZ(): void {
  console.log('Testing rough_surface links offset rings at Z instead of retracting...')
  const { project, operation } = makePocketBlockProject()
  const result = generateRoughSurfaceToolpath(project, operation)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)

  // Count every closed cut loop at Z=3 by scanning the cut moves and detecting
  // each return to a previously-seen `from` point. With at-Z linking each ring
  // is still emitted as its own closed loop (returns to its own entry), but
  // the loops are stitched together by cut links instead of retract+plunge
  // pairs — so closedLoops stays high while plunge count drops to roughly one
  // per region.
  const targetZ = 3
  const eps = 1e-6
  const samePoint = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
    Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps

  let closedLoopsAtZ = 0
  let cutRun: Array<{ x: number; y: number }> = []
  const closeAt = (idx: number): boolean => {
    // The current point closes back to some earlier point in this contiguous
    // cut run — that earlier→current span is one closed loop.
    const here = cutRun[idx]
    for (let j = 0; j < idx; j += 1) {
      if (samePoint(cutRun[j], here)) {
        closedLoopsAtZ += 1
        // Drop everything up to and including the loop-start so we can detect
        // the next loop in the same run (loops stitched by at-Z links).
        cutRun = cutRun.slice(idx)
        return true
      }
    }
    return false
  }
  for (const move of result.moves) {
    const isCutAtZ = move.kind === 'cut'
      && Math.abs(move.from.z - targetZ) <= eps
      && Math.abs(move.to.z - targetZ) <= eps
    if (!isCutAtZ) {
      cutRun = []
      continue
    }
    if (cutRun.length === 0) {
      cutRun.push({ x: move.from.x, y: move.from.y })
    }
    cutRun.push({ x: move.to.x, y: move.to.y })
    closeAt(cutRun.length - 1)
  }

  const plungesAtZ = result.moves.filter((m) =>
    m.kind === 'plunge' && Math.abs(m.to.z - targetZ) <= eps
  ).length

  assert(closedLoopsAtZ >= 4,
    `expected at least 4 closed cut loops at Z=${targetZ}, got ${closedLoopsAtZ}`)
  assert(plungesAtZ * 2 <= closedLoopsAtZ,
    `expected plunges (${plungesAtZ}) to be at most half the closed-loop count (${closedLoopsAtZ}) at Z=${targetZ}; at-Z linking does not appear to be firing`)
}

testRoughSurfaceGeneratesChangingZCuts()
testRoughSurfaceFindsModelWhenRegionIsFirst()
  testRoughSurfaceDefaultsLegacyModelFormatToStl()
  testRoughSurfaceCutsVerticalPocketAndOutsideWall()
  testRoughSurfaceKeepsOuterWallEnvelopeTight()
  testRoughSurfaceProtectsOverhangingModelShadow()
testRoughSurfaceProtectsOpenMeshSlicesConservatively()
testRoughSurfaceAvoidsSurroundingAddFeature()
testRoughSurfaceIgnoresContainingBaseFeature()
testRoughSurfaceIgnoresTightBaseWhenPocketLimitsEnvelope()
testRoughSurfaceRespectsContainingPocketDepth()
testRoughSurfaceRespectsSplitPocketDepths()
testRoughSurfaceLinksOffsetRingsAtZ()

function testTransitionToCutEntryPlungesAtAlignedXY(): void {
  console.log('Testing transitionToCutEntry plunges straight down at aligned XY...')
  const moves: ToolpathMove[] = []
  const from: ToolpathPoint = { x: 5, y: 7, z: 5 }
  const to: ToolpathPoint = { x: 5, y: 7, z: 2 }
  const out = transitionToCutEntry(moves, from, to, 10, 0)
  assert(moves.length === 1, `expected 1 move, got ${moves.length}`)
  assert(moves[0].kind === 'plunge', `expected plunge, got ${moves[0].kind}`)
  assert(moves[0].from.z === 5 && moves[0].to.z === 2, 'plunge Z range incorrect')
  assert(out.z === 2 && out.x === 5 && out.y === 7, 'returned position incorrect')
}

function testTransitionToCutEntryRetractsAcrossDifferentXY(): void {
  console.log('Testing transitionToCutEntry retracts when XY differs and no link is allowed...')
  const moves: ToolpathMove[] = []
  const from: ToolpathPoint = { x: 5, y: 7, z: 5 }
  const to: ToolpathPoint = { x: 20, y: 20, z: 5 }
  transitionToCutEntry(moves, from, to, 10, 0)
  // Expect: rapid up to safeZ, rapid across to new XY, plunge down
  const kinds = moves.map((m) => m.kind)
  assert(kinds.includes('rapid'), `expected at least one rapid, got ${kinds.join(',')}`)
  assert(kinds.includes('plunge'), `expected a plunge, got ${kinds.join(',')}`)
}

testTransitionToCutEntryPlungesAtAlignedXY()
testTransitionToCutEntryRetractsAcrossDifferentXY()

console.log('roughSurface tests passed')
