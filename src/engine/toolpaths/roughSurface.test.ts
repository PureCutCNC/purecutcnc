/**
 * Integration tests for rough surface toolpath generation.
 *
 * Run with: npx tsx src/engine/toolpaths/roughSurface.test.ts
 */

import { defaultTool, newProject, rectProfile, type Operation, type Project, type SketchFeature, type Tool } from '../../types/project'
import { generateRoughSurfaceToolpath } from './roughSurface'
import type { ToolpathMove } from './types'

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

function makeProject(featureIds: string[]): { project: Project; operation: Operation } {
  const model = makeModelFeature()
  const region = makeRegionFeature()
  const project = {
    ...newProject('rough-surface-test', 'mm'),
    tools: [makeTool()],
    features: [model, region],
  }
  return { project, operation: makeRoughOperation(featureIds) }
}

function makeLegacyProject(featureIds: string[]): { project: Project; operation: Operation } {
  const model = makeModelFeature(false)
  const region = makeRegionFeature()
  const project = {
    ...newProject('rough-surface-legacy-test', 'mm'),
    tools: [makeTool()],
    features: [model, region],
  }
  return { project, operation: makeRoughOperation(featureIds) }
}

function makeInvertedProject(featureIds: string[]): { project: Project; operation: Operation } {
  const model = makeModelFeature(true, true)
  const region = makeRegionFeature()
  const project = {
    ...newProject('rough-surface-inverted-test', 'mm'),
    tools: [makeTool()],
    features: [model, region],
  }
  return { project, operation: makeRoughOperation(featureIds) }
}

function cutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((move) => move.kind === 'cut')
}

function distinctCutZs(moves: ToolpathMove[]): number[] {
  return [...new Set(cutMoves(moves).map((move) => Number(move.to.z.toFixed(4))))].sort((a, b) => b - a)
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

  assert(!result.warnings.includes('Model feature must be an imported STL model'), 'model lookup should not depend on first target feature')
  assert(cutMoves(result.moves).length > 0, 'expected rough surface moves with region-first target order')
}

function testRoughSurfaceDefaultsLegacyModelFormatToStl(): void {
  console.log('Testing rough_surface legacy STL model format default...')
  const { project, operation } = makeLegacyProject(['model1'])
  const result = generateRoughSurfaceToolpath(project, operation)

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected rough surface moves for legacy STL model data')
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

testRoughSurfaceGeneratesChangingZCuts()
testRoughSurfaceFindsModelWhenRegionIsFirst()
testRoughSurfaceDefaultsLegacyModelFormatToStl()
testRoughSurfaceProtectsOverhangingModelShadow()

console.log('roughSurface tests passed')
