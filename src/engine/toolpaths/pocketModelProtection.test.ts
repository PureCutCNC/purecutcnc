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
 * Imported model protection for Pocket operations (issue #819).
 *
 * The model has a lower ring with a cavity and an upper cap over the cavity's
 * left side. At the pocket floor the cap's current section is empty, but the
 * flat endmill still passes through it. The cumulative protection must retain
 * that cap while clearing the cavity's exposed right side.
 */

import type { Operation, Point, Project, SketchFeature, Tool } from '../../types/project'
import { defaultTool, newProject, rectProfile } from '../../types/project'
import { projectWithFeatures } from '../../test/projectFixtures'
import { serializeImportedMesh } from '../importedMesh'
import { generatePocketToolpath } from './pocket'
import type { ToolpathMove } from './types'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function makeTool(): Tool {
  return {
    ...defaultTool('mm', 1),
    id: 't1',
    name: '1 mm endmill',
    diameter: 1,
    defaultStepdown: 1,
    defaultStepover: 0.4,
  }
}

function makePocketFeature(): SketchFeature {
  return {
    id: 'pocket',
    name: 'pocket',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 12, 8),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 6,
    z_bottom: 1,
    visible: true,
    locked: false,
  }
}

function makeBodyFeature(): SketchFeature {
  return {
    ...makePocketFeature(),
    id: 'body',
    name: 'body',
    sketch: {
      ...makePocketFeature().sketch,
      profile: rectProfile(-2, -2, 16, 12),
    },
    operation: 'add',
    z_bottom: 0,
  }
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

function makeOperation(overrides: Partial<Operation> = {}): Operation {
  return {
    id: 'pocket-model-protection',
    name: 'Pocket model protection',
    kind: 'pocket',
    pass: 'rough',
    enabled: true,
    showToolpath: true,
    debugToolpath: false,
    target: { source: 'features', featureIds: ['pocket'] },
    toolRef: 't1',
    stepdown: 1,
    stepover: 0.4,
    feed: 800,
    plungeFeed: 300,
    rpm: 18000,
    pocketPattern: 'offset',
    pocketAngle: 0,
    stockToLeaveRadial: 0,
    stockToLeaveAxial: 0,
    finishWalls: true,
    finishFloor: true,
    carveDepth: 2,
    maxCarveDepth: 2,
    cutDirection: 'conventional',
    machiningOrder: 'level_first',
    ...overrides,
  }
}

function makeCappedModelPocket(openSlice = false): { project: Project; operation: Operation; floorZ: number } {
  const vertices: number[] = []
  const indices: number[] = []
  const floorZ = 1
  if (openSlice) {
    vertices.push(0, 0, 0, 12, 0, 0, 12, 0, 6, 0, 0, 6)
    indices.push(0, 1, 2, 0, 2, 3)
  } else {
    appendMeshBox(vertices, indices, 2, 4, 1, 7, 0, 2)
    appendMeshBox(vertices, indices, 8, 10, 1, 7, 0, 2)
    appendMeshBox(vertices, indices, 4, 8, 1, 3, 0, 2)
    appendMeshBox(vertices, indices, 4, 8, 5, 7, 0, 2)
    appendMeshBox(vertices, indices, 4, 6, 3, 5, 2, 6)
  }
  const mesh = serializeImportedMesh({
    positions: new Float32Array(vertices),
    index: new Uint32Array(indices),
    bounds: openSlice
      ? { minX: 0, maxX: 12, minY: 0, maxY: 0, minZ: 0, maxZ: 6 }
      : { minX: 2, maxX: 10, minY: 1, maxY: 7, minZ: 0, maxZ: 6 },
  }, 'stl')
  const model: SketchFeature = {
    ...makePocketFeature(),
    id: 'model',
    name: 'embedded model',
    kind: 'stl',
    operation: 'model',
    stl: {
      format: 'stl',
      meshAssetId: 'pocket-capped-model',
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: 0, y: 0 },
        { x: 12, y: 0 },
        { x: 12, y: 8 },
        { x: 0, y: 8 },
      ]],
    },
    z_top: 6,
    z_bottom: 0,
  }
  const operation = makeOperation()
  const project = projectWithFeatures(
    { ...newProject('pocket-model-protection', 'mm'), tools: [makeTool()], operations: [operation] },
    [makeBodyFeature(), makePocketFeature(), model],
  )
  project.modelAssets['pocket-capped-model'] = mesh
  project.stock.thickness = 6
  return { project, operation, floorZ }
}

function distanceToMove(point: Point, move: ToolpathMove): number {
  const dx = move.to.x - move.from.x
  const dy = move.to.y - move.from.y
  const lengthSq = dx * dx + dy * dy
  if (lengthSq <= Number.EPSILON) return Math.hypot(point.x - move.to.x, point.y - move.to.y)
  const t = Math.max(0, Math.min(1, ((point.x - move.from.x) * dx + (point.y - move.from.y) * dy) / lengthSq))
  return Math.hypot(point.x - (move.from.x + t * dx), point.y - (move.from.y + t * dy))
}

function testPocketProtectsCumulativeModelShadow(): void {
  console.log('Testing Pocket protects the cumulative model shadow (issue #819)...')
  const { project, operation, floorZ } = makeCappedModelPocket()
  const toolRadius = project.tools[0]!.diameter / 2
  const capCentre = { x: 5, y: 4 }
  const exposedCavityCentre = { x: 7, y: 4 }
  const passes: Array<[string, Operation]> = [
    ['rough offset', operation],
    ['rough parallel', { ...operation, pocketPattern: 'parallel' }],
    ['finish', { ...operation, pass: 'finish' }],
  ]

  for (const [label, candidate] of passes) {
    const result = generatePocketToolpath(project, candidate)
    const floorCuts = result.moves.filter((move) => move.kind === 'cut'
      && Math.abs(move.from.z - floorZ) < 1e-9
      && Math.abs(move.to.z - floorZ) < 1e-9)
    assert(
      floorCuts.length > 0,
      `${label} must cut the pocket floor; cut Zs are ${[...new Set(result.moves.filter((move) => move.kind === 'cut').map((move) => move.to.z))].join(', ')}, warnings are ${JSON.stringify(result.warnings)}`,
    )
    const capNearestCut = Math.min(...floorCuts.map((move) => distanceToMove(capCentre, move)))
    assert(
      capNearestCut >= toolRadius - 1e-6,
      `${label} must not enter the upper model cap from the lower floor; nearest cut is ${capNearestCut}`,
    )
    const exposedNearestCut = Math.min(...floorCuts.map((move) => distanceToMove(exposedCavityCentre, move)))
    assert(
      exposedNearestCut <= toolRadius + 1e-6,
      `${label} must clear the exposed lower cavity; nearest cut is ${exposedNearestCut}`,
    )
  }
  console.log('   PASSED')
}

function testPocketFallsBackForAnOpenModelSlice(): void {
  console.log('Testing Pocket falls back to the model silhouette for an open slice...')
  const { project, operation } = makeCappedModelPocket(true)
  const result = generatePocketToolpath(project, operation)
  assert(result.warnings.some((warning) => warning.code === 'surface3dOpenMesh'),
    `expected an open-slice warning, got ${JSON.stringify(result.warnings)}`)
  assert(!result.moves.some((move) => move.kind === 'cut'), 'an open-only model slice must leave the pocket silhouette uncut')
  console.log('   PASSED')
}

try {
  testPocketProtectsCumulativeModelShadow()
  testPocketFallsBackForAnOpenModelSlice()
  console.log('\nAll pocketModelProtection tests PASSED.')
} catch (error) {
  console.error(error)
  throw error
}
