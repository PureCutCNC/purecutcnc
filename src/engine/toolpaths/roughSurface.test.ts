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

import { defaultTool, newProject, rectProfile, type Operation, type PocketPattern, type Point, type Project, type SketchFeature, type Tool } from '../../types/project'
import { serializeImportedMesh } from '../importedMesh'
import { generateRoughSurfaceToolpath } from './roughSurface'
import { transitionToCutEntry } from './pocket'
import { offsetClipperPaths, segmentInsideClipperPaths } from './modelProtection'
import { resolve3DSurfaceStepdown } from './surfaceStepdown3d'
import { offeredPocketPatterns } from './pocketPatterns'
import type { PocketToolpathResult, ToolpathMove, ToolpathPoint } from './types'
import { projectWithFeatures, replaceProjectFeatures } from '../../test/projectFixtures'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeFrustumStlDataUrl(inverted = false): string {
  return makeOffsetFrustumStlDataUrl(0, 0, inverted)
}

function makeOffsetFrustumStlDataUrl(ox: number, oy: number, inverted = false): string {
  const vertices = inverted
    ? {
        b0: [4 + ox, 2 + oy, 0],
        b1: [8 + ox, 2 + oy, 0],
        b2: [8 + ox, 6 + oy, 0],
        b3: [4 + ox, 6 + oy, 0],
        t0: [0 + ox, 0 + oy, 6],
        t1: [12 + ox, 0 + oy, 6],
        t2: [12 + ox, 8 + oy, 6],
        t3: [0 + ox, 8 + oy, 6],
      } as const
    : {
        b0: [0 + ox, 0 + oy, 0],
        b1: [12 + ox, 0 + oy, 0],
        b2: [12 + ox, 8 + oy, 0],
        b3: [0 + ox, 8 + oy, 0],
        t0: [4 + ox, 2 + oy, 6],
        t1: [8 + ox, 2 + oy, 6],
        t2: [8 + ox, 6 + oy, 6],
        t3: [4 + ox, 6 + oy, 6],
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
    name: 'Rough surface',
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

function makeSplitRegionFeature(id: string, x: number, width: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, -2, width, 12),
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

/**
 * The frustum masked by two region rects separated by a 0.5 mm strip the
 * operation never clears. The coarse stepover (ratio 1) puts maxLinkDistance
 * at 0.75 mm, so raster segments flanking the strip are close enough that a
 * greedy nearest-endpoint link WANTS to cross it — and must be rejected by the
 * per-level safe-link gate instead.
 */
function makeSplitRegionProject(): { project: Project; operation: Operation } {
  const model = makeModelFeature()
  const left = makeSplitRegionFeature('region-l', -2, 9)
  const right = makeSplitRegionFeature('region-r', 7.5, 6.5)
  const project = projectWithFeatures({
    ...newProject('rough-surface-split-region-test', 'mm'),
    tools: [makeTool()],
  }, [left, right, model])
  project.stock.thickness = TEST_STOCK_THICKNESS
  const operation = { ...makeRoughOperation(['model1', 'region-l', 'region-r']), stepover: 1 }
  return { project, operation }
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

function testRoughSurfaceHelixEntryUsesModelSafeRegions(): void {
  console.log('Testing rough_surface helix entry uses model-safe regions...')
  const { project, operation } = makeProject(['model1'])
  operation.entryStrategy = 'helix'
  operation.entryRampAngle = 5
  operation.entryHelixDiameterPercent = 80
  const result = generateRoughSurfaceToolpath(project, operation)
  const descendingLeadIns = result.moves.filter((move) =>
    move.kind === 'lead_in' && move.to.z < move.from.z - 1e-9)

  assert(descendingLeadIns.length > 0, 'expected rough-surface helical lead-in moves')
  assert(
    result.warnings
      .filter((warning) => warning.code === 'entryStrategyFallback')
      .every((warning) => warning.params?.requested === 'helix'),
    'fallback warnings should preserve the requested helix strategy',
  )
}

function testRoughSurfaceRegionMaskAllowsEntry(): void {
  console.log('Testing rough_surface region mask allows helix entry...')
  const { project, operation } = makeProject(['region1', 'model1'])
  operation.entryStrategy = 'helix'
  const result = generateRoughSurfaceToolpath(project, operation)

  assert(
    result.moves.some((move) => move.kind === 'lead_in'),
    'region-masked rough_surface with helix entry should emit lead-in moves',
  )
}

function testRoughSurfaceDefaultEntryMatchesExplicitPlunge(): void {
  console.log('Testing rough_surface default entry matches explicit plunge...')
  const { project, operation } = makeProject(['model1'])
  const implicit = generateRoughSurfaceToolpath(project, operation)
  const explicit = generateRoughSurfaceToolpath(project, { ...operation, entryStrategy: 'plunge' })
  assert(JSON.stringify(implicit) === JSON.stringify(explicit), 'unset and explicit plunge toolpaths must match')
}

function testRoughSurfaceFindsModelWhenRegionIsFirst(): void {
  console.log('Testing rough_surface target order with region before model...')
  const { project, operation } = makeProject(['region1', 'model1'])
  const result = generateRoughSurfaceToolpath(project, operation)

  assert(!result.warnings.some((w) => w.code === 'surface3dNotMesh'), 'model lookup should not depend on first target feature')
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
    result.warnings.some((warning) => warning.code === 'surface3dOpenMesh'),
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

// ── Pattern dispatch: generation matrix + model protection (issue #618) ────
//
// rough_surface offered no pattern control until #618, so its generator
// hard-coded concentric rings no matter what was stored. The matrix proves
// every pattern the table now offers emits motion on a real stream — an empty
// level with no warning is the exact failure #609 shipped three times — and
// the protection assertions prove the per-level safeLinkCheck gate survives on
// the two new patterns. A raster link shortcutting across standing stock a
// shallower level never cut is the failure mode to catch.

/** Consecutive same-Z cut moves that stay connected end to end. */
function connectedCutRuns(moves: ToolpathMove[]): ToolpathMove[][] {
  const runs: ToolpathMove[][] = []
  let current: ToolpathMove[] = []
  for (const move of moves) {
    if (move.kind !== 'cut' || Math.abs(move.from.z - move.to.z) > 1e-9) {
      if (current.length > 0) runs.push(current)
      current = []
      continue
    }
    const previous = current[current.length - 1]
    if (
      previous
      && (Math.hypot(previous.to.x - move.from.x, previous.to.y - move.from.y) > 1e-9
        || Math.abs(previous.to.z - move.to.z) > 1e-9)
    ) {
      runs.push(current)
      current = []
    }
    current.push(move)
  }
  if (current.length > 0) runs.push(current)
  return runs
}

/**
 * Full tessellated circles in a move stream.
 *
 * A seed circle is a regular polygon: every chord the same length, every turn
 * the same angle, and the turns summing to exactly one revolution. Nothing
 * else this generator emits has that shape — an offset ring's chords vary with
 * the geometry it follows, and the radial link into a circle breaks the run on
 * both counts, so the detected run is the circle and only the circle.
 * (Same detector as finishSurfaceCleanup.test.ts.)
 */
function fullCircles(moves: ToolpathMove[]): Array<{ z: number; centre: Point; radius: number }> {
  const chordLength = (move: ToolpathMove): number => Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
  const turnBetween = (a: ToolpathMove, b: ToolpathMove): number => {
    const ax = a.to.x - a.from.x
    const ay = a.to.y - a.from.y
    const bx = b.to.x - b.from.x
    const by = b.to.y - b.from.y
    return Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
  }

  const circles: Array<{ z: number; centre: Point; radius: number }> = []
  for (const run of connectedCutRuns(moves)) {
    let start = 0
    while (start < run.length) {
      const chord = chordLength(run[start])
      let turn: number | null = null
      let end = start
      while (end + 1 < run.length) {
        if (Math.abs(chordLength(run[end + 1]) - chord) > 1e-6 * Math.max(1, chord)) break
        const next = turnBetween(run[end], run[end + 1])
        if (turn === null) turn = next
        else if (Math.abs(next - turn) > 1e-6) break
        end += 1
      }

      const chords = end - start + 1
      // 24 is MIN_SEED_CIRCLE_POINTS; the revolution test is what makes this a
      // circle rather than a merely uniform arc.
      if (turn !== null && chords >= 24 && Math.abs(chords * Math.abs(turn) - 2 * Math.PI) < 1e-6) {
        const points = run.slice(start, end + 1).map((move) => ({ x: move.from.x, y: move.from.y }))
        const centre = {
          x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
          y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
        }
        const radii = points.map((point) => Math.hypot(point.x - centre.x, point.y - centre.y))
        circles.push({ z: run[start].to.z, centre, radius: (Math.min(...radii) + Math.max(...radii)) / 2 })
      }
      start = end + 1
    }
  }
  return circles
}

function generateForPattern(pattern: PocketPattern): PocketToolpathResult {
  const { project, operation } = makeProject(['model1'])
  return generateRoughSurfaceToolpath(project, { ...operation, pocketPattern: pattern })
}

/**
 * Closed cut loops across the whole stream.
 *
 * Tracks contiguous same-Z cut runs; when a run returns to an earlier point of
 * itself that span is one closed loop (loops stitched by at-Z links are still
 * counted individually). Raster scanlines are open serpentine chains and never
 * close, so on a parallel stream this counts exactly what the level-boundary
 * contour pass emits.
 */
function countClosedCutLoops(moves: ToolpathMove[]): number {
  const eps = 1e-6
  const sameXY = (a: { x: number; y: number }, b: { x: number; y: number }): boolean =>
    Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps

  let loops = 0
  let runZ: number | null = null
  let run: Array<{ x: number; y: number }> = []
  for (const move of moves) {
    if (move.kind !== 'cut' || Math.abs(move.from.z - move.to.z) > eps) {
      runZ = null
      run = []
      continue
    }
    if (runZ === null || Math.abs(move.from.z - runZ) > eps) {
      runZ = move.from.z
      run = []
    }
    run.push({ x: move.from.x, y: move.from.y })
    run.push({ x: move.to.x, y: move.to.y })
    const here = run[run.length - 1]
    for (let index = 0; index < run.length - 1; index += 1) {
      if (sameXY(run[index], here)) {
        loops += 1
        // Drop up to the loop start so later stitched loops still count.
        run = run.slice(index)
        break
      }
    }
  }
  return loops
}

function testRoughSurfaceGenerationMatrix(): void {
  console.log('Testing rough_surface generation matrix over the offered patterns...')
  const offered = offeredPocketPatterns('rough_surface')
  assert(
    offered.join(',') === 'offset,seeded_offset,parallel',
    `rough_surface must offer exactly the clearing set, got ${offered.join(',')}`,
  )

  const streams = new Map<PocketPattern, PocketToolpathResult>()
  for (const pattern of offered) {
    const result = generateForPattern(pattern)
    assert(
      result.warnings.length === 0,
      `${pattern}: unexpected warnings ${JSON.stringify(result.warnings)}`,
    )
    assert(
      cutMoves(result.moves).length > 0,
      `${pattern}: emitted no cut moves — an empty floor with no warning is the exact defect #609 shipped three times`,
    )
    streams.set(pattern, result)
  }

  const offset = streams.get('offset')!
  const seeded = streams.get('seeded_offset')!
  const parallel = streams.get('parallel')!

  // Each new pattern must take its own branch, not fall through to the rings:
  // a stream byte-identical to plain offset means the dispatch never fired.
  assert(
    JSON.stringify(seeded.moves) !== JSON.stringify(offset.moves),
    'seeded_offset fell through to the offset stream',
  )
  const seededCircles = fullCircles(seeded.moves)
  assert(seededCircles.length >= 3, `expected seed circles on the seeded_offset stream, detected ${seededCircles.length}`)
  assert(fullCircles(offset.moves).length === 0, 'the plain offset stream must contain no full circles')
  assert(
    JSON.stringify(parallel.moves) !== JSON.stringify(offset.moves),
    'parallel fell through to the offset stream',
  )

  // The raster branch must cut the level boundary before its segments, as the
  // pocket and surface_clean raster branches do: scanlines alone leave a
  // scalloped ridge of standing stock at the silhouette on every level, while
  // the offset pattern's outermost ring is that same contour. One closed loop
  // per level is the signature only the boundary pass leaves — open scanlines
  // never close, and the detector above would count zero without it.
  const parallelLevels = distinctCutZs(parallel.moves).length
  const parallelLoops = countClosedCutLoops(parallel.moves)
  assert(
    parallelLoops >= parallelLevels,
    `parallel emitted ${parallelLoops} closed boundary loops across ${parallelLevels} levels `
      + '— the level-boundary contour pass is missing',
  )
}

/**
 * Every fed move stays inside the clearable region of the deepest level it
 * reaches.
 *
 * Attribution: after the levels down to floor z have run, the material state
 * at depth d is whatever the deepest level with floor <= d left behind, so a
 * move reaching depth d is legal only inside that level's domain. The domain
 * is the generator's own safe-link construction — clearable paths inset by the
 * tool radius — relaxed by 0.0001 mm so geometry lying exactly on the boundary
 * (a raster scanline's endpoints sit on it by design) still passes.
 */
function assertEverySegmentStaysInItsLevel(
  pattern: PocketPattern,
  source: () => { project: Project; operation: Operation } = () => makeProject(['model1']),
): void {
  const { project, operation } = source()
  const subject = { ...operation, pocketPattern: pattern }
  const result = generateRoughSurfaceToolpath(project, subject)
  assert(cutMoves(result.moves).length > 0, `${pattern}: expected motion to protect`)

  const resolvedResult = resolve3DSurfaceStepdown(project, subject, { operationLabel: 'Rough surface' })
  assert(resolvedResult.ok, `${pattern}: expected the stepdown to resolve`)
  if (!resolvedResult.ok) {
    return
  }
  const { resolved } = resolvedResult
  const domains = resolved.levels
    .map((level) => ({
      z: level.z,
      paths: offsetClipperPaths(level.clearablePaths, -(resolved.tool.radius - 1e-4)),
    }))
    .sort((a, b) => b.z - a.z)
  const spacing = Math.max(resolved.tool.radius * 0.25, resolved.effectiveStepover * 0.1)

  let checked = 0
  for (const move of result.moves) {
    // Rapids travel at safe Z, above stock; everything else must be contained.
    if (move.kind === 'rapid') continue
    const zFloor = Math.min(move.from.z, move.to.z)
    const level = domains.find((candidate) => candidate.z <= zFloor + 1e-6)
    if (!level) continue // above the shallowest level: nothing to protect yet
    assert(
      segmentInsideClipperPaths(level.paths, move.from, move.to, spacing),
      `${pattern}: ${move.kind} (${move.from.x},${move.from.y},${move.from.z}) -> `
        + `(${move.to.x},${move.to.y},${move.to.z}) leaves the Z=${level.z} clearable region`,
    )
    checked += 1
  }
  assert(checked >= 50, `${pattern}: expected to check a meaningful number of segments, got ${checked}`)
}

function testRoughSurfaceParallelStaysInClearableRegions(): void {
  console.log('Testing rough_surface parallel raster stays inside each level...')
  assertEverySegmentStaysInItsLevel('parallel')
}

function testRoughSurfaceSeededStaysInClearableRegions(): void {
  console.log('Testing rough_surface seeded_offset stays inside each level...')
  assertEverySegmentStaysInItsLevel('seeded_offset')
}

function testRoughSurfaceRasterNeverLinksAcrossStandingStrip(): void {
  console.log('Testing rough_surface raster rejects the cross-strip link the greedy order wants...')
  // On the plain frustum every nearest-endpoint raster link is contained
  // anyway, so the gate's rejection path never fires there. The split-region
  // fixture dangles links across an uncleared 0.5 mm strip within
  // maxLinkDistance; without the gate they are emitted and leave the region.
  assertEverySegmentStaysInItsLevel('parallel', makeSplitRegionProject)
}

/**
 * Feed reduction on the roughing stream (issue #619).
 *
 * The owner's decision was to take the emitted-output change rather than
 * migrate around it: `pocketSlotFeedPercent` defaults to 60 on every kind and
 * is already live in saved files, so this operation starts reducing feed in
 * its slots the moment the declaration offers the control. What must stay true
 * is that the reduction is driven by the parameter and by nothing else — at
 * 100% the stream carries no `feedScale` at all, which is what makes the
 * change attributable to the stored value rather than to the wiring.
 *
 * Asserted on every offered pattern: a level cleared by the raster branch
 * prices its slots exactly as a ring level does.
 */
function testRoughSurfaceReducesSlotFeed(): void {
  console.log('Testing rough_surface reduces slot feed on every offered pattern...')
  for (const pattern of offeredPocketPatterns('rough_surface')) {
    const { project, operation } = makeProject(['model1'])
    const reduced = generateRoughSurfaceToolpath(project, {
      ...operation, pocketPattern: pattern, pocketSlotFeedPercent: 60,
    })
    const scaled = cutMoves(reduced.moves).filter((move) => move.feedScale !== undefined)
    assert(
      scaled.length > 0,
      `${pattern}: no cut carried a feedScale, so the slot-feed reduction never reached the stream`,
    )
    assert(
      scaled.every((move) => move.feedScale === 0.6),
      `${pattern}: expected every scaled cut at 0.6, got ${[...new Set(scaled.map((move) => move.feedScale))].join(', ')}`,
    )

    const full = generateRoughSurfaceToolpath(project, {
      ...operation, pocketPattern: pattern, pocketSlotFeedPercent: 100,
    })
    assert(
      cutMoves(full.moves).every((move) => move.feedScale === undefined),
      `${pattern}: at 100% no move may carry a feedScale — absent means full feed everywhere else in the engine`,
    )
  }
}

/** Engagement telemetry rides the result only when the mode asks for it (#619). */
function testRoughSurfaceEngagementTelemetry(): void {
  console.log('Testing rough_surface engagement telemetry follows the mode...')
  const { project, operation } = makeProject(['model1'])
  const engagement = generateRoughSurfaceToolpath(project, {
    ...operation, pocketFeedReduction: 'engagement',
  })
  assert(
    engagement.engagementTelemetry !== undefined,
    'engagement mode must publish telemetry, or the mode has nothing to price against',
  )
  const slotsOnly = generateRoughSurfaceToolpath(project, {
    ...operation, pocketFeedReduction: 'slots_only',
  })
  assert(
    slotsOnly.engagementTelemetry === undefined,
    'slots_only must not publish engagement telemetry',
  )
}

testRoughSurfaceGeneratesChangingZCuts()
testRoughSurfaceHelixEntryUsesModelSafeRegions()
testRoughSurfaceRegionMaskAllowsEntry()
testRoughSurfaceDefaultEntryMatchesExplicitPlunge()
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
testRoughSurfaceGenerationMatrix()
testRoughSurfaceParallelStaysInClearableRegions()
testRoughSurfaceSeededStaysInClearableRegions()
testRoughSurfaceRasterNeverLinksAcrossStandingStrip()
testRoughSurfaceReducesSlotFeed()
testRoughSurfaceEngagementTelemetry()

// ── Machining order tests (issue #620) ───────────────────────────────

const serializeMoves = (moves: ToolpathMove[]): string => JSON.stringify(moves)

function makeOffsetModelFeature(id: string, ox: number, oy: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'stl',
    stl: {
      format: 'stl' as const,
      fileData: makeOffsetFrustumStlDataUrl(ox, oy),
      scale: 1,
      axisSwap: 'none',
    },
    folderId: null,
    sketch: {
      profile: rectProfile(ox, oy, 12, 8),
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

function makeOffsetRegionFeature(id: string, ox: number, oy: number): SketchFeature {
  return {
    id,
    name: id,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(ox - 2, oy - 2, 16, 12),
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

function testRoughSurfaceMachiningOrderFeatureFirst(): void {
  console.log('Testing rough_surface machining order feature_first splits per feature...')
  // Two disjoint frustums at different XY positions.
  const modelA = makeOffsetModelFeature('model-a', 0, 0)
  const modelB = makeOffsetModelFeature('model-b', 50, 50)
  const regionA = makeOffsetRegionFeature('region-a', 0, 0)
  const regionB = makeOffsetRegionFeature('region-b', 50, 50)
  const project = projectWithFeatures({
    ...newProject('rough-surface-mo-ff-test', 'mm'),
    tools: [makeTool()],
  }, [modelA, modelB, regionA, regionB])
  project.stock.thickness = TEST_STOCK_THICKNESS

  const featureFirst = generateRoughSurfaceToolpath(project, {
    ...makeRoughOperation(['model-a', 'model-b', 'region-a', 'region-b']),
    machiningOrder: 'feature_first',
  })

  assert(featureFirst.moves.length > 0, 'feature_first should produce moves')
  const cutMoves = featureFirst.moves.filter((m) => m.kind === 'cut')
  assert(cutMoves.length > 0, 'feature_first should produce cut moves')

  // Feature A's frustum is at X ∈ [0, 12], feature B's at X ∈ [50, 62].
  // A cut at X < 25 belongs to feature A; X ≥ 25 belongs to feature B.
  let lastACut = -1
  let firstBCut = cutMoves.length
  for (let i = 0; i < cutMoves.length; i++) {
    if (cutMoves[i]!.to.x < 25) lastACut = i
    if (cutMoves[i]!.to.x >= 25 && firstBCut === cutMoves.length) firstBCut = i
  }
  assert(lastACut >= 0, 'must have cuts for feature A')
  assert(firstBCut < cutMoves.length, 'must have cuts for feature B')
  assert(lastACut < firstBCut,
    `feature_first: all feature-A cuts must precede feature-B cuts (last A at ${lastACut}, first B at ${firstBCut})`)
}

function testRoughSurfaceMachiningOrderLevelFirst(): void {
  console.log('Testing rough_surface machining order level_first produces different stream...')
  const modelA = makeOffsetModelFeature('model-a', 0, 0)
  const modelB = makeOffsetModelFeature('model-b', 50, 50)
  const regionA = makeOffsetRegionFeature('region-a', 0, 0)
  const regionB = makeOffsetRegionFeature('region-b', 50, 50)
  const project = projectWithFeatures({
    ...newProject('rough-surface-mo-lf-test', 'mm'),
    tools: [makeTool()],
  }, [modelA, modelB, regionA, regionB])
  project.stock.thickness = TEST_STOCK_THICKNESS

  const levelFirst = generateRoughSurfaceToolpath(project, {
    ...makeRoughOperation(['model-a', 'model-b', 'region-a', 'region-b']),
    machiningOrder: 'level_first',
  })

  assert(levelFirst.moves.length > 0, 'level_first should produce moves')

  const featureFirst = generateRoughSurfaceToolpath(project, {
    ...makeRoughOperation(['model-a', 'model-b', 'region-a', 'region-b']),
    machiningOrder: 'feature_first',
  })
  assert(serializeMoves(featureFirst.moves) !== serializeMoves(levelFirst.moves),
    'feature_first and level_first must produce different streams')
}

function testRoughSurfaceMachiningOrderSingleFeatureIdentical(): void {
  console.log('Testing rough_surface single-feature operation identical under both settings...')
  const { project, operation } = makeProject(['model1'])

  const levelFirst = generateRoughSurfaceToolpath(project, {
    ...operation, machiningOrder: 'level_first',
  })
  const featureFirst = generateRoughSurfaceToolpath(project, {
    ...operation, machiningOrder: 'feature_first',
  })
  assert(serializeMoves(levelFirst.moves) === serializeMoves(featureFirst.moves),
    'single-feature rough_surface must be byte-identical under both machiningOrder settings')
}

function testRoughSurfaceMachiningOrderTelemetrySurvives(): void {
  console.log('Testing rough_surface engagement telemetry survives feature-first split...')
  const modelA = makeOffsetModelFeature('model-a', 0, 0)
  const modelB = makeOffsetModelFeature('model-b', 50, 50)
  const regionA = makeOffsetRegionFeature('region-a', 0, 0)
  const regionB = makeOffsetRegionFeature('region-b', 50, 50)
  const project = projectWithFeatures({
    ...newProject('rough-surface-mo-tel-test', 'mm'),
    tools: [makeTool()],
  }, [modelA, modelB, regionA, regionB])
  project.stock.thickness = TEST_STOCK_THICKNESS

  const result = generateRoughSurfaceToolpath(project, {
    ...makeRoughOperation(['model-a', 'model-b', 'region-a', 'region-b']),
    machiningOrder: 'feature_first',
    pocketFeedReduction: 'engagement',
  })
  assert(result.engagementTelemetry !== undefined,
    'feature-first engagement mode must attach telemetry')
  assert(result.engagementTelemetry!.totalCutDistance > 0,
    'telemetry must record sampled distance')
}

testRoughSurfaceMachiningOrderFeatureFirst()
testRoughSurfaceMachiningOrderLevelFirst()
testRoughSurfaceMachiningOrderSingleFeatureIdentical()
testRoughSurfaceMachiningOrderTelemetrySurvives()

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

/**
 * A mixed target must not split the mesh away from its own operation (#620).
 *
 * This kind's validity is `.some(model)` among its machining features, so one
 * STL model plus an `add` feature is a legal target that has always roughed as
 * a single operation. A naive per-feature split hands one part the model and
 * the other nothing to slice, and that part reports `surface3dNotMesh` — a
 * "must be an imported mesh" warning on an operation that plainly has a mesh.
 * Saved projects would hit it without touching anything, because
 * `machiningOrder` ships stored as `feature_first`.
 */
function testRoughSurfaceMixedTargetDoesNotSplitAwayTheMesh(): void {
  console.log('Testing rough_surface keeps a mixed target whole...')
  const model = makeOffsetModelFeature('model-a', 0, 0)
  const region = makeOffsetRegionFeature('region-a', 0, 0)
  const addFeature = makeProtectedAddFeature()
  const project = projectWithFeatures({
    ...newProject('rough-surface-mixed-target-test', 'mm'),
    tools: [makeTool()],
  }, [model, region, addFeature])
  project.stock.thickness = TEST_STOCK_THICKNESS

  const targetIds = ['model-a', addFeature.id, 'region-a']
  const featureFirst = generateRoughSurfaceToolpath(project, {
    ...makeRoughOperation(targetIds), machiningOrder: 'feature_first',
  })
  const levelFirst = generateRoughSurfaceToolpath(project, {
    ...makeRoughOperation(targetIds), machiningOrder: 'level_first',
  })

  assert(
    !featureFirst.warnings.some((warning) => warning.code === 'surface3dNotMesh'),
    'splitting a mixed target must not orphan the mesh into a part that cannot slice it',
  )
  assert(
    JSON.stringify(featureFirst.moves) === JSON.stringify(levelFirst.moves),
    'a target with only one mesh among its machining features has one roughing part, so both orders must emit the same stream',
  )
}

testRoughSurfaceMixedTargetDoesNotSplitAwayTheMesh()
testTransitionToCutEntryPlungesAtAlignedXY()
testTransitionToCutEntryRetractsAcrossDifferentXY()

// ── Tangent link tests (issue #621) ────────────────────────────────────

/**
 * Count cut-to-cut junctions with turn ≥ thresholdDeg between consecutive
 * cut moves whose midpoints are NOT on a ring (i.e. they are link moves).
 * A reduction in sharp link junctions when tangent links are enabled is the
 * signature of spliced S-links.
 */
function sharpLinkJunctionCount(moves: ToolpathMove[], thresholdDeg = 60): number {
  const cuts = moves.filter((m) => m.kind === 'cut')
  let count = 0
  for (let i = 0; i + 1 < cuts.length; i += 1) {
    const a = cuts[i]!
    const b = cuts[i + 1]!
    if (Math.abs(a.to.x - b.from.x) > 1e-9 || Math.abs(a.to.y - b.from.y) > 1e-9) continue
    const inX = a.to.x - a.from.x
    const inY = a.to.y - a.from.y
    const outX = b.to.x - b.from.x
    const outY = b.to.y - b.from.y
    const inLen = Math.hypot(inX, inY)
    const outLen = Math.hypot(outX, outY)
    if (inLen < 1e-9 || outLen < 1e-9) continue
    const cos = Math.max(-1, Math.min(1, (inX * outX + inY * outY) / (inLen * outLen)))
    const turn = (Math.acos(cos) * 180) / Math.PI
    if (turn >= thresholdDeg) count += 1
  }
  return count
}

function testRoughSurfaceSplicesTangentLinksOnOffset(): void {
  console.log('Testing rough_surface splices tangent links on offset pattern...')
  const { project, operation } = makeProject(['model1'])
  const enabled = generateRoughSurfaceToolpath(project, {
    ...operation, roundLinkCorners: true,
  })
  const disabled = generateRoughSurfaceToolpath(project, {
    ...operation, roundLinkCorners: false,
  })
  assert(cutMoves(enabled.moves).length > 0, 'enabled stream must have cuts')
  assert(cutMoves(disabled.moves).length > 0, 'disabled stream must have cuts')
  const enabledSharp = sharpLinkJunctionCount(enabled.moves)
  const disabledSharp = sharpLinkJunctionCount(disabled.moves)
  assert(
    enabledSharp < disabledSharp,
    `enabled output must reduce sharp link junctions (enabled ${enabledSharp}, disabled ${disabledSharp})`,
  )
}

function testRoughSurfaceSplicesTangentLinksOnSeededOffset(): void {
  console.log('Testing rough_surface splices tangent links on seeded_offset pattern...')
  const { project, operation } = makeProject(['model1'])
  const enabled = generateRoughSurfaceToolpath(project, {
    ...operation, pocketPattern: 'seeded_offset', roundLinkCorners: true,
  })
  const disabled = generateRoughSurfaceToolpath(project, {
    ...operation, pocketPattern: 'seeded_offset', roundLinkCorners: false,
  })
  assert(cutMoves(enabled.moves).length > 0, 'enabled stream must have cuts')
  assert(cutMoves(disabled.moves).length > 0, 'disabled stream must have cuts')
  const enabledSharp = sharpLinkJunctionCount(enabled.moves)
  const disabledSharp = sharpLinkJunctionCount(disabled.moves)
  assert(
    enabledSharp < disabledSharp,
    `seeded_offset: enabled must reduce sharp link junctions (enabled ${enabledSharp}, disabled ${disabledSharp})`,
  )
}

function testRoughSurfaceParallelSplicesNothing(): void {
  console.log('Testing rough_surface parallel pattern splices no tangent links...')
  const { project, operation } = makeProject(['model1'])
  const enabled = generateRoughSurfaceToolpath(project, {
    ...operation, pocketPattern: 'parallel', roundLinkCorners: true,
  })
  const disabled = generateRoughSurfaceToolpath(project, {
    ...operation, pocketPattern: 'parallel', roundLinkCorners: false,
  })
  assert(
    JSON.stringify(enabled.moves) === JSON.stringify(disabled.moves),
    'parallel pattern must produce byte-identical streams regardless of roundLinkCorners',
  )
}

function testRoughSurfaceTangentLinksContainment(): void {
  console.log('Testing rough_surface tangent links stay inside clearable regions (split-region)...')
  // The split-region fixture has two disjoint regions with a gap. Tangent links
  // must not bulge into the gap — every cut and link segment must stay inside
  // the level's clearable region.
  assertEverySegmentStaysInItsLevel('offset', makeSplitRegionProject)
}

testRoughSurfaceSplicesTangentLinksOnOffset()
testRoughSurfaceSplicesTangentLinksOnSeededOffset()
testRoughSurfaceParallelSplicesNothing()
testRoughSurfaceTangentLinksContainment()

// ── Wall-corner cleanup tests (issue #633) ─────────────────────────────

function pointSegmentDistance(point: Point, from: Point, to: Point): number {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 1e-18) return Math.hypot(point.x - from.x, point.y - from.y)
  const t = Math.max(0, Math.min(1,
    ((point.x - from.x) * dx + (point.y - from.y) * dy) / lengthSquared))
  return Math.hypot(point.x - (from.x + dx * t), point.y - (from.y + dy * t))
}

function cutDistanceToPoint(point: Point, moves: ToolpathMove[]): number {
  const cuts = moves.filter((m) => m.kind === 'cut')
  return Math.min(...cuts.map((move) => Math.min(
    pointSegmentDistance(point, move.from, move.to),
  )))
}

/**
 * Coverage recovery: on the pocket-block fixture (vertical outside walls),
 * cleanWallCorners: true with roundOutsideCorners: true recovers coverage
 * at the rounded corners that cleanWallCorners: false leaves behind.
 *
 * Asserts on where the cutter body reaches, not on move counts.
 */
function testRoughSurfaceWallCleanupRecoversCoverage(): void {
  console.log('Testing rough_surface wall-corner cleanup recovers coverage...')
  const { project, operation } = makePocketBlockProject()
  const off = generateRoughSurfaceToolpath(project, {
    ...operation, roundOutsideCorners: true, cleanWallCorners: false,
  })
  const on = generateRoughSurfaceToolpath(project, {
    ...operation, roundOutsideCorners: true, cleanWallCorners: true,
  })
  assert(cutMoves(off.moves).length > 0, 'cleanup-off stream must have cuts')
  assert(cutMoves(on.moves).length > 0, 'cleanup-on stream must have cuts')
  assert(cutMoves(on.moves).length > cutMoves(off.moves).length,
    'cleanup-on must add motion (cleanup loops at rounded corners)')

  // The pocket block's outside wall is 0,0 to 20,10. At Z=4 (the top deck
  // level), the tool-centre ring rides at one tool radius inside the wall.
  // With rounding, the four outside corners lose coverage. Sample points at
  // the actual wall corners — cleanup-on must reach closer to them.
  const toolRadius = operation.stepover / 2 // 0.25
  const wallCorners: Point[] = [
    { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 10 }, { x: 0, y: 10 },
  ]
  const offCuts = cutMoves(off.moves)
  const onCuts = cutMoves(on.moves)
  for (const corner of wallCorners) {
    const offDist = cutDistanceToPoint(corner, offCuts)
    const onDist = cutDistanceToPoint(corner, onCuts)
    assert(onDist < offDist,
      `cleanup must reach closer to wall corner (${corner.x},${corner.y}): off=${offDist.toFixed(4)}, on=${onDist.toFixed(4)}`)
    // The cleanup loop should reach within one tool radius of the wall.
    assert(onDist <= toolRadius + 0.01,
      `cleanup must reach within tool radius of wall corner (${corner.x},${corner.y}): ${onDist.toFixed(4)}`)
  }
}

/**
 * Off-state identity: with cleanWallCorners absent or false, the stream is
 * byte-identical. And with roundOutsideCorners false, the stream is
 * byte-identical regardless of cleanWallCorners.
 */
function testRoughSurfaceWallCleanupOffStateIdentity(): void {
  console.log('Testing rough_surface wall-corner cleanup off-state identity...')
  const { project, operation } = makePocketBlockProject()

  // Absent vs explicit false
  const { cleanWallCorners: _absent, ...withoutField } = operation
  const absent = generateRoughSurfaceToolpath(project, {
    ...withoutField, roundOutsideCorners: true,
  })
  const explicitlyOff = generateRoughSurfaceToolpath(project, {
    ...operation, roundOutsideCorners: true, cleanWallCorners: false,
  })
  assert(
    serializeMoves(absent.moves) === serializeMoves(explicitlyOff.moves),
    'absent and explicit false must produce byte-identical streams',
  )

  // With rounding off, cleanup flag is inert
  const roundingOffNoCleanup = generateRoughSurfaceToolpath(project, {
    ...operation, roundOutsideCorners: false, cleanWallCorners: false,
  })
  const roundingOffWithCleanup = generateRoughSurfaceToolpath(project, {
    ...operation, roundOutsideCorners: false, cleanWallCorners: true,
  })
  assert(
    serializeMoves(roundingOffNoCleanup.moves) === serializeMoves(roundingOffWithCleanup.moves),
    'with roundOutsideCorners off, cleanWallCorners must be inert',
  )
}

/**
 * Containment: the cleanup contour stays inside the level's clearable region.
 * Extends the existing per-level containment assertion with cleanup enabled.
 */
function testRoughSurfaceWallCleanupStaysInClearableRegions(): void {
  console.log('Testing rough_surface wall-corner cleanup stays inside clearable regions...')
  const { project, operation } = makePocketBlockProject()
  const subject = {
    ...operation,
    roundOutsideCorners: true,
    cleanWallCorners: true,
  }
  const result = generateRoughSurfaceToolpath(project, subject)
  assert(cutMoves(result.moves).length > 0, 'expected motion to protect')

  const resolvedResult = resolve3DSurfaceStepdown(project, subject, { operationLabel: 'Rough surface' })
  assert(resolvedResult.ok, 'expected the stepdown to resolve')
  if (!resolvedResult.ok) return
  const { resolved } = resolvedResult
  const domains = resolved.levels
    .map((level) => ({
      z: level.z,
      paths: offsetClipperPaths(level.clearablePaths, -(resolved.tool.radius - 1e-4)),
    }))
    .sort((a, b) => b.z - a.z)
  const spacing = Math.max(resolved.tool.radius * 0.25, resolved.effectiveStepover * 0.1)

  let checked = 0
  for (const move of result.moves) {
    if (move.kind === 'rapid') continue
    const zFloor = Math.min(move.from.z, move.to.z)
    const level = domains.find((candidate) => candidate.z <= zFloor + 1e-6)
    if (!level) continue
    assert(
      segmentInsideClipperPaths(level.paths, move.from, move.to, spacing),
      `cleanup move (${move.from.x.toFixed(3)},${move.from.y.toFixed(3)},${move.from.z.toFixed(3)}) -> `
        + `(${move.to.x.toFixed(3)},${move.to.y.toFixed(3)},${move.to.z.toFixed(3)}) leaves the Z=${level.z} clearable region`,
    )
    checked += 1
  }
  assert(checked >= 50, `expected to check a meaningful number of segments, got ${checked}`)
}

/**
 * Stock-to-leave: with stockToLeaveRadial > 0, the cleanup contour must not
 * cut inside the leave boundary. The tool-centre region already carries the
 * radial leave — this proves it.
 *
 * The cleanup loops at corners extend outward past the wall to recover
 * coverage, so we check containment against the clearable region (which
 * already accounts for stock-to-leave) rather than a simple distance-to-wall
 * bound.
 */
function testRoughSurfaceWallCleanupRespectsStockToLeave(): void {
  console.log('Testing rough_surface wall-corner cleanup respects stock-to-leave...')
  const { project, operation } = makePocketBlockProject()
  const leave = 0.3
  const subject = {
    ...operation,
    roundOutsideCorners: true,
    cleanWallCorners: true,
    stockToLeaveRadial: leave,
  }
  const result = generateRoughSurfaceToolpath(project, subject)
  assert(cutMoves(result.moves).length > 0, 'expected motion with stock-to-leave')

  // Verify containment: every cut stays inside the clearable region, which
  // already accounts for the radial leave. This is the same approach as
  // assertEverySegmentStaysInItsLevel but with stock-to-leave enabled.
  const resolvedResult = resolve3DSurfaceStepdown(project, subject, { operationLabel: 'Rough surface' })
  assert(resolvedResult.ok, 'expected the stepdown to resolve')
  if (!resolvedResult.ok) return
  const { resolved } = resolvedResult
  const domains = resolved.levels
    .map((level) => ({
      z: level.z,
      paths: offsetClipperPaths(level.clearablePaths, -(resolved.tool.radius - 1e-4)),
    }))
    .sort((a, b) => b.z - a.z)
  const spacing = Math.max(resolved.tool.radius * 0.25, resolved.effectiveStepover * 0.1)

  let checked = 0
  for (const move of result.moves) {
    if (move.kind === 'rapid') continue
    const zFloor = Math.min(move.from.z, move.to.z)
    const level = domains.find((candidate) => candidate.z <= zFloor + 1e-6)
    if (!level) continue
    assert(
      segmentInsideClipperPaths(level.paths, move.from, move.to, spacing),
      `stock-to-leave: ${move.kind} (${move.from.x.toFixed(3)},${move.from.y.toFixed(3)},${move.from.z.toFixed(3)}) -> `
        + `(${move.to.x.toFixed(3)},${move.to.y.toFixed(3)},${move.to.z.toFixed(3)}) leaves the Z=${level.z} clearable region`,
    )
    checked += 1
  }
  assert(checked >= 50, `expected to check a meaningful number of segments, got ${checked}`)
}

testRoughSurfaceWallCleanupRecoversCoverage()
testRoughSurfaceWallCleanupOffStateIdentity()
testRoughSurfaceWallCleanupStaysInClearableRegions()
testRoughSurfaceWallCleanupRespectsStockToLeave()

console.log('roughSurface tests passed')
