/**
 * Integration tests for finish surface toolpath generation.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurface.test.ts
 */

import { defaultTool, newProject, rectProfile, type Operation, type Project, type SketchFeature, type Tool } from '../../types/project'
import { generateFinishSurfaceToolpath } from './finishSurface'
import type { ToolpathMove } from './types'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function addBoxFaces(
  lines: string[],
  minX: number,
  minY: number,
  minZ: number,
  maxX: number,
  maxY: number,
  maxZ: number,
): void {
  const vertices = {
    b0: [minX, minY, minZ],
    b1: [maxX, minY, minZ],
    b2: [maxX, maxY, minZ],
    b3: [minX, maxY, minZ],
    t0: [minX, minY, maxZ],
    t1: [maxX, minY, maxZ],
    t2: [maxX, maxY, maxZ],
    t3: [minX, maxY, maxZ],
  } as const

  const faces: Array<[keyof typeof vertices, keyof typeof vertices, keyof typeof vertices]> = [
    ['b0', 'b2', 'b1'], ['b0', 'b3', 'b2'],
    ['t0', 't1', 't2'], ['t0', 't2', 't3'],
    ['b0', 'b1', 't1'], ['b0', 't1', 't0'],
    ['b1', 'b2', 't2'], ['b1', 't2', 't1'],
    ['b2', 'b3', 't3'], ['b2', 't3', 't2'],
    ['b3', 'b0', 't0'], ['b3', 't0', 't3'],
  ]

  for (const face of faces) {
    lines.push('  facet normal 0 0 0')
    lines.push('    outer loop')
    for (const key of face) {
      lines.push(`      vertex ${vertices[key].join(' ')}`)
    }
    lines.push('    endloop')
    lines.push('  endfacet')
  }
}

function makeSteppedStlDataUrl(): string {
  const lines = ['solid stepped']
  addBoxFaces(lines, 0, 0, 0, 20, 10, 1)
  addBoxFaces(lines, 8, 3, 1, 12, 7, 4)
  lines.push('endsolid stepped')
  return `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`
}

function makeTool(): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 'tool1',
    name: '1 mm ball endmill',
    type: 'ball_endmill',
    diameter: 1,
    defaultStepdown: 1,
    defaultStepover: 1,
    maxCutDepth: 10,
  }
}

function makeModelFeature(): SketchFeature {
  return {
    id: 'model1',
    name: 'Stepped STL',
    kind: 'stl',
    stl: {
      format: 'stl',
      fileData: makeSteppedStlDataUrl(),
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
      ]],
    },
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 20, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'model',
    z_top: 4,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeOperation(): Operation {
  return {
    id: 'finish1',
    name: 'Finish Surface',
    kind: 'finish_surface',
    pass: 'finish',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['model1'] },
    toolRef: 'tool1',
    stepdown: 1,
    stepover: 1,
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

function makeProject(): { project: Project; operation: Operation } {
  const project = {
    ...newProject('finish-surface-test', 'mm'),
    tools: [makeTool()],
    features: [makeModelFeature()],
  }
  return { project, operation: makeOperation() }
}

function cutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((move) => move.kind === 'cut')
}

function testFinishSurfaceCoversLowerTopPlateau(): void {
  console.log('Testing finish_surface covers lower top plateau...')
  const { project, operation } = makeProject()
  const result = generateFinishSurfaceToolpath(project, operation)
  const lowPlateauCuts = cutMoves(result.moves).filter((move) => {
    const point = move.to
    return point.x > 1 && point.x < 7 && point.y > 1 && point.y < 9 && point.z <= 1.5
  })

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected finish surface cut moves')
  assert(lowPlateauCuts.length > 0, 'expected finish cuts on lower top plateau outside the high boss')
}

function testFinishSurfaceRepeatGenerationIsStable(): void {
  console.log('Testing finish_surface repeat generation is stable...')
  const { project, operation } = makeProject()
  const first = generateFinishSurfaceToolpath(project, operation)
  const second = generateFinishSurfaceToolpath(project, operation)

  assert(first.warnings.length === 0, `unexpected first warnings: ${first.warnings.join(', ')}`)
  assert(second.warnings.length === 0, `unexpected second warnings: ${second.warnings.join(', ')}`)
  assert(first.moves.length === second.moves.length, `expected repeat move count ${first.moves.length}, got ${second.moves.length}`)
  assert(cutMoves(second.moves).length > 0, 'expected repeated finish surface cut moves')
}

testFinishSurfaceCoversLowerTopPlateau()
testFinishSurfaceRepeatGenerationIsStable()

console.log('finishSurface tests passed')
