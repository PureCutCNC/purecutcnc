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
 * Integration tests for finish surface toolpath generation.
 *
 * Run with: npx tsx src/engine/toolpaths/finishSurface.test.ts
 */

import { readFileSync } from 'fs'
import { defaultTool, newProject, rectProfile, type Operation, type Project, type RegionMaskMode, type SketchFeature, type Tool } from '../../types/project'
import { normalizeProject, useProjectStore } from '../../store/projectStore'
import { convertProjectUnits } from '../../utils/units'
import { generateFinishSurfaceToolpath, maxContourGap } from './finishSurface'
import { snapClosedContourEntryToAnchor } from './finishSurfaceWaterline'
import { generateRoughSurfaceToolpath } from './roughSurface'
import { toClipperPath, normalizeWinding, DEFAULT_CLIPPER_SCALE, applyContourDirectionBySide, isClockwise, normalizeToolForProject } from './geometry'
import { loadSTLTransformedGeometry } from '../csg'
import { chooseHeightMapCellSize, computeXYBounds, getCachedHeightMap, safeToolTipZAt, type FinishSurfaceParallelCacheHost } from './finishSurfaceParallel'
import { getMeshSliceIndex, sliceMeshAtZ } from './meshSlicing'
import type { Point } from '../../types/project'
import type { ClipperPath, PocketToolpathResult, ToolpathMove } from './types'
import { simulateReplayItemsHeightfield } from '../simulation/replay'
import type { SimulationGrid, SimulationReplayItem } from '../simulation/types'
import { applyTabsToEdgeRoute } from './tabs'

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

function addQuad(
  lines: string[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
  d: [number, number, number],
): void {
  lines.push('  facet normal 0 0 0')
  lines.push('    outer loop')
  lines.push(`      vertex ${a.join(' ')}`)
  lines.push(`      vertex ${b.join(' ')}`)
  lines.push(`      vertex ${c.join(' ')}`)
  lines.push('    endloop')
  lines.push('  endfacet')

  lines.push('  facet normal 0 0 0')
  lines.push('    outer loop')
  lines.push(`      vertex ${a.join(' ')}`)
  lines.push(`      vertex ${c.join(' ')}`)
  lines.push(`      vertex ${d.join(' ')}`)
  lines.push('    endloop')
  lines.push('  endfacet')
}

function addTriangle(
  lines: string[],
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
): void {
  lines.push('  facet normal 0 0 0')
  lines.push('    outer loop')
  for (const point of [a, b, c]) {
    lines.push(`      vertex ${point.join(' ')}`)
  }
  lines.push('    endloop')
  lines.push('  endfacet')
}

function makeSteppedStlDataUrl(): string {
  const lines = ['solid stepped']
  addBoxFaces(lines, 0, 0, 0, 20, 10, 1)
  addBoxFaces(lines, 8, 3, 1, 12, 7, 4)
  lines.push('endsolid stepped')
  return `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`
}

function makeTaperedStlDataUrl(): string {
  const lines = ['solid tapered']
  const vertices = {
    b0: [0, 0, 0],
    b1: [20, 0, 0],
    b2: [20, 10, 0],
    b3: [0, 10, 0],
    t0: [8, 3, 4],
    t1: [12, 3, 4],
    t2: [12, 7, 4],
    t3: [8, 7, 4],
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

  lines.push('endsolid tapered')
  return `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`
}

function makeConeStlDataUrl(): string {
  const lines = ['solid cone']
  const cx = 10
  const cy = 5
  const radius = 5
  const baseZ = 0
  const apexZ = 4
  const segments = 64
  const apex: [number, number, number] = [cx, cy, apexZ]
  const center: [number, number, number] = [cx, cy, baseZ]

  for (let i = 0; i < segments; i += 1) {
    const a0 = (i / segments) * Math.PI * 2
    const a1 = ((i + 1) / segments) * Math.PI * 2
    const p0: [number, number, number] = [
      cx + Math.cos(a0) * radius,
      cy + Math.sin(a0) * radius,
      baseZ,
    ]
    const p1: [number, number, number] = [
      cx + Math.cos(a1) * radius,
      cy + Math.sin(a1) * radius,
      baseZ,
    ]
    addTriangle(lines, center, p1, p0)
    addTriangle(lines, p0, p1, apex)
  }

  lines.push('endsolid cone')
  return `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`
}

function makeUnevenTwinConeStlDataUrl(): string {
  const lines = ['solid uneven_twin_cone']
  const segments = 64
  const addCone = (cx: number, cy: number, radius: number, baseZ: number, apexZ: number): void => {
    const apex: [number, number, number] = [cx, cy, apexZ]
    const center: [number, number, number] = [cx, cy, baseZ]
    for (let i = 0; i < segments; i += 1) {
      const a0 = (i / segments) * Math.PI * 2
      const a1 = ((i + 1) / segments) * Math.PI * 2
      const p0: [number, number, number] = [
        cx + Math.cos(a0) * radius,
        cy + Math.sin(a0) * radius,
        baseZ,
      ]
      const p1: [number, number, number] = [
        cx + Math.cos(a1) * radius,
        cy + Math.sin(a1) * radius,
        baseZ,
      ]
      addTriangle(lines, center, p1, p0)
      addTriangle(lines, p0, p1, apex)
    }
  }

  addCone(8.8, 5, 4, 0, 3)
  addCone(11.2, 5, 4, 0, 4)
  lines.push('endsolid uneven_twin_cone')
  return `data:model/stl;base64,${btoa(`${lines.join('\n')}\n`)}`
}

function makePocketBlockStlDataUrl(): string {
  const lines = ['solid pocket_block']
  const minX = 0, minY = 0, minZ = 0
  const maxX = 20, maxY = 10, maxZ = 4
  const pocketMinX = 6, pocketMinY = 3, pocketMaxX = 14, pocketMaxY = 7, pocketFloorZ = 2

  // Bottom face
  addQuad(lines,
    [minX, minY, minZ], [maxX, minY, minZ], [maxX, maxY, minZ], [minX, maxY, minZ],
  )

  // Outer walls
  addQuad(lines,
    [minX, minY, minZ], [maxX, minY, minZ], [maxX, minY, maxZ], [minX, minY, maxZ],
  )
  addQuad(lines,
    [maxX, minY, minZ], [maxX, maxY, minZ], [maxX, maxY, maxZ], [maxX, minY, maxZ],
  )
  addQuad(lines,
    [maxX, maxY, minZ], [minX, maxY, minZ], [minX, maxY, maxZ], [maxX, maxY, maxZ],
  )
  addQuad(lines,
    [minX, maxY, minZ], [minX, minY, minZ], [minX, minY, maxZ], [minX, maxY, maxZ],
  )

  // Top frame around pocket opening (no top over the pocket area)
  addQuad(lines,
    [minX, minY, maxZ], [maxX, minY, maxZ], [maxX, pocketMinY, maxZ], [minX, pocketMinY, maxZ],
  )
  addQuad(lines,
    [minX, pocketMaxY, maxZ], [maxX, pocketMaxY, maxZ], [maxX, maxY, maxZ], [minX, maxY, maxZ],
  )
  addQuad(lines,
    [minX, pocketMinY, maxZ], [pocketMinX, pocketMinY, maxZ], [pocketMinX, pocketMaxY, maxZ], [minX, pocketMaxY, maxZ],
  )
  addQuad(lines,
    [pocketMaxX, pocketMinY, maxZ], [maxX, pocketMinY, maxZ], [maxX, pocketMaxY, maxZ], [pocketMaxX, pocketMaxY, maxZ],
  )

  // Pocket floor
  addQuad(lines,
    [pocketMinX, pocketMinY, pocketFloorZ], [pocketMaxX, pocketMinY, pocketFloorZ],
    [pocketMaxX, pocketMaxY, pocketFloorZ], [pocketMinX, pocketMaxY, pocketFloorZ],
  )

  // Pocket walls
  addQuad(lines,
    [pocketMinX, pocketMinY, maxZ], [pocketMaxX, pocketMinY, maxZ], [pocketMaxX, pocketMinY, pocketFloorZ], [pocketMinX, pocketMinY, pocketFloorZ],
  )
  addQuad(lines,
    [pocketMaxX, pocketMinY, maxZ], [pocketMaxX, pocketMaxY, maxZ], [pocketMaxX, pocketMaxY, pocketFloorZ], [pocketMaxX, pocketMinY, pocketFloorZ],
  )
  addQuad(lines,
    [pocketMaxX, pocketMaxY, maxZ], [pocketMinX, pocketMaxY, maxZ], [pocketMinX, pocketMaxY, pocketFloorZ], [pocketMaxX, pocketMaxY, pocketFloorZ],
  )
  addQuad(lines,
    [pocketMinX, pocketMaxY, maxZ], [pocketMinX, pocketMinY, maxZ], [pocketMinX, pocketMinY, pocketFloorZ], [pocketMinX, pocketMaxY, pocketFloorZ],
  )

  lines.push('endsolid pocket_block')
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

function makeTaperedModelFeature(): SketchFeature {
  return {
    ...makeModelFeature(),
    id: 'model1',
    name: 'Tapered STL',
    stl: {
      format: 'stl',
      fileData: makeTaperedStlDataUrl(),
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
      ]],
    },
  }
}

function makeConeModelFeature(): SketchFeature {
  const silhouette = Array.from({ length: 64 }, (_, i) => {
    const angle = (i / 64) * Math.PI * 2
    return {
      x: 10 + Math.cos(angle) * 5,
      y: 5 + Math.sin(angle) * 5,
    }
  })
  return {
    ...makeModelFeature(),
    id: 'model1',
    name: 'Cone STL',
    stl: {
      format: 'stl',
      fileData: makeConeStlDataUrl(),
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [silhouette],
    },
    sketch: {
      ...makeModelFeature().sketch,
      profile: rectProfile(5, 0, 10, 10),
    },
  }
}

function makeUnevenTwinConeModelFeature(): SketchFeature {
  return {
    ...makeModelFeature(),
    id: 'model1',
    name: 'Uneven Twin Cone STL',
    stl: {
      format: 'stl',
      fileData: makeUnevenTwinConeStlDataUrl(),
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: 4.8, y: 1 },
        { x: 15.2, y: 1 },
        { x: 15.2, y: 9 },
        { x: 4.8, y: 9 },
      ]],
    },
    sketch: {
      ...makeModelFeature().sketch,
      profile: rectProfile(4.8, 1, 10.4, 8),
    },
  }
}

function makePocketBlockModelFeature(): SketchFeature {
  return {
    ...makeModelFeature(),
    id: 'model1',
    name: 'Pocket Block STL',
    stl: {
      format: 'stl',
      fileData: makePocketBlockStlDataUrl(),
      scale: 1,
      axisSwap: 'none',
      silhouettePaths: [[
        { x: 0, y: 0 },
        { x: 20, y: 0 },
        { x: 20, y: 10 },
        { x: 0, y: 10 },
      ]],
    },
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

function makeRoughSurfaceOperation(): Operation {
  return {
    ...makeOperation(),
    id: 'rough1',
    name: 'Rough Surface',
    kind: 'rough_surface',
    pass: 'rough',
    pocketPattern: 'offset',
  }
}

function makeProject(): { project: Project; operation: Operation } {
  const project = {
    ...newProject('finish-surface-test', 'mm'),
    tools: [makeTool()],
    features: [makeModelFeature()],
  }
  return { project: normalizeProject(project), operation: makeOperation() }
}

function loadImportedBlockWaterlineProject(): { project: Project; operation: Operation } {
  const raw = readFileSync(new URL('../test-fixtures/3d-imported-block-test3.camj', import.meta.url), 'utf8')
  const project = normalizeProject(JSON.parse(raw) as Project)
  const operation = project.operations.find(
    (candidate) => candidate.kind === 'finish_surface' && candidate.pocketPattern === 'waterline',
  )
  if (!operation) {
    throw new Error('expected waterline finish operation in 3d-imported-block-test3.camj')
  }
  return { project, operation }
}

function normalizeProjectFeatures(project: Project): void {
  const normalized = normalizeProject(project)
  project.features = normalized.features
  project.modelAssets = normalized.modelAssets
}

function cutMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter((move) => move.kind === 'cut')
}

function projectedWaterlineCuts(result: PocketToolpathResult, source?: 'projectedBand' | 'projectedCap'): ToolpathMove[] {
  return cutMoves(result.moves).filter((move) => (
    source ? move.source === source : move.source === 'projectedBand' || move.source === 'projectedCap'
  ))
}

function distanceToSegment(point: Point, a: Point, b: Point): number {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const wx = point.x - a.x
  const wy = point.y - a.y
  const lenSq = vx * vx + vy * vy
  if (lenSq <= 1e-18) return Math.hypot(point.x - a.x, point.y - a.y)
  const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq))
  return Math.hypot(point.x - (a.x + vx * t), point.y - (a.y + vy * t))
}

function distanceToSliceBoundary(paths: Array<Array<[number, number]>>, point: Point): number {
  let minDistance = Number.POSITIVE_INFINITY
  for (const path of paths) {
    for (let i = 0; i < path.length; i += 1) {
      const current = path[i]
      const next = path[(i + 1) % path.length]
      minDistance = Math.min(minDistance, distanceToSegment(
        point,
        { x: current[0], y: current[1] },
        { x: next[0], y: next[1] },
      ))
    }
  }
  return minDistance
}

function assertNoTargetMeshGougingCuts(project: Project, operation: Operation, result: PocketToolpathResult): void {
  const modelFeature = project.features.find((feature) => feature.kind === 'stl' && feature.operation === 'model')
  if (!modelFeature) throw new Error('expected imported model feature')
  const toolRecord = project.tools.find((tool) => tool.id === operation.toolRef)
  if (!toolRecord) throw new Error('expected operation tool')
  const tool = normalizeToolForProject(toolRecord, project)
  const stlData = loadSTLTransformedGeometry(modelFeature, project)
  if (!stlData) throw new Error('expected transformed STL geometry')
  const bbox = computeXYBounds(stlData.positions)
  const stepoverDistance = Math.max((operation.stepover ?? 0.5) * tool.diameter, 1e-3)
  const cellSize = chooseHeightMapCellSize(bbox, Math.min(tool.radius / 3, stepoverDistance * 0.5), [])
  const heightMap = getCachedHeightMap(stlData as FinishSurfaceParallelCacheHost, stlData.positions, stlData.index, bbox, cellSize)
  const sliceIndex = getMeshSliceIndex(stlData as Parameters<typeof getMeshSliceIndex>[0])
  let modelTopZ = -Infinity
  let modelBottomZ = Infinity
  for (let i = 0; i < stlData.positions.length; i += 3) {
    modelTopZ = Math.max(modelTopZ, stlData.positions[i + 2])
    modelBottomZ = Math.min(modelBottomZ, stlData.positions[i + 2])
  }
  const sliceEpsilon = Math.max(Math.abs(modelTopZ - modelBottomZ) * 1e-6, 1e-6)
  const tolerance = Math.max(1e-5, tool.radius * 0.05)
  const boundaryTolerance = Math.max(stepoverDistance * 1.5, tool.radius * 0.15, 1e-5)
  const toolOffset = tool.radius + Math.max(0, operation.stockToLeaveRadial)

  for (const move of cutMoves(result.moves)) {
    if (move.source === 'projectedBand' || move.source === 'projectedCap') continue
    const length = Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y)
    const steps = Math.max(1, Math.ceil(length / Math.max(tool.radius / 4, 1e-4)))
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps
      const point = {
        x: move.from.x + (move.to.x - move.from.x) * t,
        y: move.from.y + (move.to.y - move.from.y) * t,
        z: move.from.z + (move.to.z - move.from.z) * t,
      }
      const safeZ = safeToolTipZAt(point.x, point.y, heightMap, tool)
      const sliceZ = point.z >= modelTopZ - sliceEpsilon
        ? Math.max(modelBottomZ + sliceEpsilon, modelTopZ - sliceEpsilon)
        : Math.min(modelTopZ - sliceEpsilon, Math.max(modelBottomZ + sliceEpsilon, point.z + sliceEpsilon))
      const slicePaths = Number.isFinite(safeZ) && safeZ > point.z + tolerance
        ? sliceMeshAtZ(sliceIndex, sliceZ)
        : []
      const nearSliceBoundary = slicePaths.length > 0
        && Math.abs(distanceToSliceBoundary(slicePaths, point) - toolOffset) <= boundaryTolerance
      assert(!Number.isFinite(safeZ) || safeZ <= point.z + tolerance || nearSliceBoundary,
        `expected no target mesh gouge; cut z=${point.z}, safe z=${safeZ}, x=${point.x}, y=${point.y}`)
    }
  }
}

function indexFor(grid: SimulationGrid, col: number, row: number): number {
  return row * grid.cols + col
}

function edgeJumpMetric(
  grid: SimulationGrid,
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
): number {
  let totalJump = 0
  let samples = 0
  const cutThreshold = grid.stockTopZ - 1e-6

  for (let row = 0; row < grid.rows - 1; row += 1) {
    const y = grid.originY + (row + 0.5) * grid.cellSize
    if (y < bounds.minY || y > bounds.maxY) continue
    for (let col = 0; col < grid.cols - 1; col += 1) {
      const x = grid.originX + (col + 0.5) * grid.cellSize
      if (x < bounds.minX || x > bounds.maxX) continue

      const z = grid.topZ[indexFor(grid, col, row)]
      const zRight = grid.topZ[indexFor(grid, col + 1, row)]
      const zDown = grid.topZ[indexFor(grid, col, row + 1)]

      if (z < cutThreshold && zRight < cutThreshold) {
        totalJump += Math.abs(z - zRight)
        samples += 1
      }
      if (z < cutThreshold && zDown < cutThreshold) {
        totalJump += Math.abs(z - zDown)
        samples += 1
      }
    }
  }

  return samples > 0 ? totalJump / samples : 0
}

function hasReducibleAdjacentCutPair(moves: ToolpathMove[]): boolean {
  const epsilon = 1e-6
  for (let i = 0; i + 1 < moves.length; i += 1) {
    const a = moves[i]
    const b = moves[i + 1]
    if (a.kind !== 'cut' || b.kind !== 'cut') continue

    const contiguous = Math.hypot(a.to.x - b.from.x, a.to.y - b.from.y, a.to.z - b.from.z) <= epsilon
    if (!contiguous) continue

    const ax = a.to.x - a.from.x
    const ay = a.to.y - a.from.y
    const az = a.to.z - a.from.z
    const bx = b.to.x - b.from.x
    const by = b.to.y - b.from.y
    const bz = b.to.z - b.from.z
    const aLen = Math.hypot(ax, ay, az)
    const bLen = Math.hypot(bx, by, bz)
    if (aLen <= epsilon || bLen <= epsilon) return true

    const crossX = ay * bz - az * by
    const crossY = az * bx - ax * bz
    const crossZ = ax * by - ay * bx
    const crossLenNorm = Math.hypot(crossX, crossY, crossZ) / (aLen * bLen)
    const dot = ax * bx + ay * by + az * bz
    if (crossLenNorm <= 1e-4 && dot >= -epsilon) return true
  }
  return false
}

function makeProtectedAddFeature(): SketchFeature {
  return {
    id: 'boss1',
    name: 'Protected boss',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(2, 2, 4, 6),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 4,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeRegionFeatureRect(
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  regionMaskMode: RegionMaskMode = 'include',
): SketchFeature {
  return {
    id,
    name: `Region ${id}`,
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(x, y, w, h),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'region',
    regionMaskMode,
    z_top: 0,
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
      profile: rectProfile(-1, -1, 22, 12),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 4,
    z_bottom: 2,
    visible: true,
    locked: false,
  }
}

function makeContainingAddFeature(): SketchFeature {
  return {
    id: 'baseAdd1',
    name: 'Containing base add',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(0, 0, 20, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeIntersectingAddFeature(): SketchFeature {
  // Straddles the model's right edge (model is x=0..20). The portion x=18..20
  // overlaps the model footprint; x=20..25 is outside. Waterline must cut the
  // intersecting wall at x=18 but NOT trace the outer perimeter at x=25.
  return {
    id: 'intersectAdd1',
    name: 'Intersecting add straddling model right edge',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(18, 1, 7, 8),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeAddOwnedPocketFeature(): SketchFeature {
  // Subtract pocket fully inside an intersecting add feature (see
  // makeAddWithOwnedPocketParent). Its footprint overlaps the model
  // silhouette, but it is the add's own pocket and must not pull the model
  // operation's bottom Z deeper.
  return {
    id: 'ownedPocket',
    name: 'Add-owned pocket',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(18, 2, 5, 6),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 5,
    z_bottom: -2,
    visible: true,
    locked: false,
  }
}

function makeAddOwnedPocketParent(): SketchFeature {
  // Wide add feature that fully contains makeAddOwnedPocketFeature and
  // partially overlaps the model footprint (x=15..25; model is x=0..20).
  return {
    id: 'addParent',
    name: 'Wide intersecting add (parent of owned pocket)',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(15, 0, 10, 10),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'add',
    z_top: 5,
    z_bottom: 0,
    visible: true,
    locked: false,
  }
}

function makeRightHalfSubtractFeature(): SketchFeature {
  return {
    id: 'pocket2',
    name: 'Deeper right pocket',
    kind: 'rect',
    folderId: null,
    sketch: {
      profile: rectProfile(10, -1, 11, 12),
      origin: { x: 0, y: 0 },
      orientationAngle: 0,
      dimensions: [],
      constraints: [],
    },
    operation: 'subtract',
    z_top: 4,
    z_bottom: 1,
    visible: true,
    locked: false,
  }
}

function pointInsideProtectedBoss(point: { x: number; y: number }): boolean {
  return point.x > 1.55 && point.x < 6.45 && point.y > 1.55 && point.y < 8.45
}

function pointInsideRect(point: { x: number; y: number }, rect: { x: number; y: number; w: number; h: number }): boolean {
  return point.x >= rect.x && point.x <= rect.x + rect.w && point.y >= rect.y && point.y <= rect.y + rect.h
}

function orientation(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): number {
  return (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y)
}

function onSegment(a: { x: number; y: number }, b: { x: number; y: number }, c: { x: number; y: number }): boolean {
  return b.x <= Math.max(a.x, c.x) + 1e-9 && b.x + 1e-9 >= Math.min(a.x, c.x)
    && b.y <= Math.max(a.y, c.y) + 1e-9 && b.y + 1e-9 >= Math.min(a.y, c.y)
}

function segmentsIntersect2D(
  p1: { x: number; y: number },
  q1: { x: number; y: number },
  p2: { x: number; y: number },
  q2: { x: number; y: number },
): boolean {
  const o1 = orientation(p1, q1, p2)
  const o2 = orientation(p1, q1, q2)
  const o3 = orientation(p2, q2, p1)
  const o4 = orientation(p2, q2, q1)

  if ((o1 > 0 && o2 < 0 || o1 < 0 && o2 > 0) && (o3 > 0 && o4 < 0 || o3 < 0 && o4 > 0)) {
    return true
  }

  if (Math.abs(o1) <= 1e-9 && onSegment(p1, p2, q1)) return true
  if (Math.abs(o2) <= 1e-9 && onSegment(p1, q2, q1)) return true
  if (Math.abs(o3) <= 1e-9 && onSegment(p2, p1, q2)) return true
  if (Math.abs(o4) <= 1e-9 && onSegment(p2, q1, q2)) return true
  return false
}

function segmentIntersectsRect2D(
  a: { x: number; y: number },
  b: { x: number; y: number },
  rect: { x: number; y: number; w: number; h: number },
): boolean {
  if (pointInsideRect(a, rect) || pointInsideRect(b, rect)) return true

  const r0 = { x: rect.x, y: rect.y }
  const r1 = { x: rect.x + rect.w, y: rect.y }
  const r2 = { x: rect.x + rect.w, y: rect.y + rect.h }
  const r3 = { x: rect.x, y: rect.y + rect.h }

  return segmentsIntersect2D(a, b, r0, r1)
    || segmentsIntersect2D(a, b, r1, r2)
    || segmentsIntersect2D(a, b, r2, r3)
    || segmentsIntersect2D(a, b, r3, r0)
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

function testFinishSurfaceAvoidsSurroundingAddFeature(): void {
  console.log('Testing finish_surface avoids surrounding add feature footprints...')
  const { project, operation } = makeProject()
  project.features = [...project.features, makeProtectedAddFeature()]
  const result = generateFinishSurfaceToolpath(project, operation)
  const protectedCuts = cutMoves(result.moves).filter((move) => (
    pointInsideProtectedBoss(move.from) || pointInsideProtectedBoss(move.to)
  ))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutMoves(result.moves).length > 0, 'expected finish surface cut moves')
  assert(protectedCuts.length === 0, `expected no finish cuts inside protected add feature, got ${protectedCuts.length}`)
}

function testFinishSurfaceRespectsContainingPocketDepth(): void {
  console.log('Testing finish_surface respects containing subtract pocket depth...')
  const { project, operation } = makeProject()
  project.features = [makeContainingSubtractFeature(), ...project.features]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const minCutZ = Math.min(...cuts.map((move) => move.to.z))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected finish surface cut moves above containing pocket bottom')
  assert(minCutZ >= 2 - 1e-9, `expected no finish cuts below containing pocket bottom, got min Z ${minCutZ}`)
}

function testFinishSurfaceRespectsSplitPocketDepths(): void {
  console.log('Testing finish_surface respects split subtract pocket depths...')
  const { project, operation } = makeProject()
  project.features = [makeContainingSubtractFeature(), makeRightHalfSubtractFeature(), ...project.features]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const leftCutsBelowShallow = cuts.filter((move) => (
    (move.from.x < 10 - 1e-9 || move.to.x < 10 - 1e-9) &&
    (move.from.z < 2 - 1e-9 || move.to.z < 2 - 1e-9)
  ))
  const rightCutsBelowShallow = cuts.filter((move) => (
    move.from.x > 10 + 1e-9 && move.to.x > 10 + 1e-9 &&
    (move.from.z < 2 - 1e-9 || move.to.z < 2 - 1e-9)
  ))
  const minCutZ = Math.min(...cuts.map((move) => move.to.z))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected finish surface cut moves')
  assert(minCutZ >= 1 - 1e-9, `expected no finish cuts below deeper pocket bottom, got min Z ${minCutZ}`)
  assert(rightCutsBelowShallow.length > 0, 'expected finish cuts below shallow pocket bottom in deeper right pocket')
  assert(leftCutsBelowShallow.length === 0, `expected no finish cuts below shallow pocket bottom on left side, got ${leftCutsBelowShallow.length}`)
}

// ── Waterline tests ──────────────────────────────────────────────────────

function makeSquareContour(cx: number, cy: number, halfSize: number): ClipperPath {
  const points = [
    { x: cx - halfSize, y: cy - halfSize },
    { x: cx + halfSize, y: cy - halfSize },
    { x: cx + halfSize, y: cy + halfSize },
    { x: cx - halfSize, y: cy + halfSize },
  ]
  return toClipperPath(normalizeWinding(points, false), DEFAULT_CLIPPER_SCALE)
}

function testMaxContourGapIdenticalContours(): void {
  console.log('Testing maxContourGap with identical contours...')
  const contour = makeSquareContour(10, 10, 5)
  const gap = maxContourGap([contour], [contour])
  assert(gap < 0.01, `expected near-zero gap for identical contours, got ${gap}`)
}

function testMaxContourGapDifferentContours(): void {
  console.log('Testing maxContourGap with offset contours...')
  const contourA = makeSquareContour(10, 10, 5)
  const contourB = makeSquareContour(10, 10, 3)
  const gap = maxContourGap([contourA], [contourB])
  assert(gap > 1, `expected significant gap for different-size contours, got ${gap}`)
}

function testMaxContourGapEmptyReturnsThickness(): void {
  console.log('Testing maxContourGap with one empty path set...')
  const contour = makeSquareContour(10, 10, 5)
  const gap = maxContourGap([], [contour])
  // area = 10*10=100, perimeter = 40. gap = 2*100/40 = 5.
  assert(Math.abs(gap - 5) < 0.1, `expected thickness (~5) for one empty path, got ${gap}`)
}

function testWaterlineCumulativeShadowProtectsUpperLevels(): void {
  console.log('Testing waterline cumulative shadow protects upper levels...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)

  assert(cuts.length > 0, 'expected waterline cut moves')

  for (const move of cuts) {
    const minX = Math.min(move.from.x, move.to.x)
    const maxX = Math.max(move.from.x, move.to.x)
    const minY = Math.min(move.from.y, move.to.y)
    const maxY = Math.max(move.from.y, move.to.y)
    const z = move.to.z

    if (z < 1 - 1e-9) {
      const insideHighBoss = minX > 7.5 && maxX < 12.5 && minY > 2.5 && maxY < 7.5
      assert(!insideHighBoss,
        `waterline at z=${z.toFixed(3)} cuts inside the high boss area — cumulative shadow should prevent this`)
    }
  }
}

function makeWaterlineOperation(): Operation {
  return {
    ...makeOperation(),
    pocketPattern: 'waterline',
    stepover: 0.5,
  }
}

function testWaterlineGeneratesContourMoves(): void {
  console.log('Testing waterline generates contour cut moves...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected waterline contour cut moves')
}

function testWaterlineStepLevelsDescend(): void {
  console.log('Testing waterline step levels are descending...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  assert(result.stepLevels.length > 0, 'expected step levels')
  for (let i = 1; i < result.stepLevels.length; i += 1) {
    assert(result.stepLevels[i] <= result.stepLevels[i - 1],
      `expected descending step levels, got ${result.stepLevels[i - 1]} -> ${result.stepLevels[i]}`)
  }
}

function testWaterlineRepeatIsStable(): void {
  console.log('Testing waterline repeat generation is stable...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const first = generateFinishSurfaceToolpath(project, operation)
  const second = generateFinishSurfaceToolpath(project, operation)
  assert(first.moves.length === second.moves.length,
    `expected stable move count, first=${first.moves.length}, second=${second.moves.length}`)
}

function testWaterlineRespectsContainingPocketDepth(): void {
  console.log('Testing waterline respects containing subtract pocket depth...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  project.features = [makeContainingSubtractFeature(), ...project.features]
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const minCutZ = Math.min(...cuts.map((move) => Math.min(move.from.z, move.to.z)))
  assert(cuts.length > 0, 'expected waterline cut moves')
  assert(minCutZ >= 2 - 1e-9, `expected waterline no lower than containing pocket bottom, got min Z ${minCutZ}`)
}

function testWaterlineRegionActsAsFilterNotBoundaryContour(): void {
  console.log('Testing waterline region is a filter (no boundary contour cuts)...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature(), makeRegionFeatureRect('region1', 9, 0, 4, 10)]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    target: { source: 'features', featureIds: ['model1', 'region1'] },
  }
  project.operations = [operation]

  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'expected waterline cut moves')

  const boundaryXs = [9, 13]
  const onBoundary = (x: number): boolean => boundaryXs.some((bx) => Math.abs(x - bx) <= 1e-6)
  const boundaryRuns = cuts.filter((move) => {
    if (!onBoundary(move.from.x) || !onBoundary(move.to.x)) return false
    return Math.abs(move.to.y - move.from.y) > 0.05
  })

  assert(boundaryRuns.length === 0,
    `expected no region-boundary contour runs, got ${boundaryRuns.length}`)
}

function testWaterlineAdaptivelyRefinesShallowSlope(): void {
  console.log('Testing waterline adaptively refines shallow tapered slope...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepover: 0.3,
    debugToolpath: true,
  }
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const coarseLevelCount = 5 // top + 3 stepdowns + bottom
  const insertedDebug = result.warnings.find((warning) => warning.includes('adaptive waterline inserted')) ?? ''
  const cuts = cutMoves(result.moves)
  const projectedCuts = cuts.filter((move) => move.source === 'projectedBand' || move.source === 'projectedCap')
  const has3DProjectedMove = projectedCuts.some((move) => Math.abs(move.from.z - move.to.z) > 1e-6)
  const maxProjectedZ = Math.max(...projectedCuts.map((move) => Math.max(move.from.z, move.to.z)))

  assert(result.stepLevels.length > coarseLevelCount,
    `expected adaptive waterline to produce projected Z samples beyond ${coarseLevelCount}, got ${result.stepLevels.length} — debug: ${result.warnings.join('; ')}`)
  assert(projectedCuts.length > 0, 'expected projected micro-offset cut moves on shallow slope')
  assert(maxProjectedZ > 3.5, `expected projected top band cuts to blend near model top, got max Z ${maxProjectedZ}`)
  assert(has3DProjectedMove, 'expected projected micro-offset moves to vary Z along the cut')
  assert(insertedDebug.length > 0 && !insertedDebug.includes('inserted 0 projected rings'),
    `expected debug metrics for inserted adaptive levels, got: ${insertedDebug}`)
}

function testWaterlineTipCapSmoothsConePeak(): void {
  console.log('Testing waterline projected cap smooths a cone peak...')
  const { project } = makeProject()
  project.features = [makeConeModelFeature()]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepdown: 1,
    stepover: 0.2,
    waterlineMicroStepover: 0.2,
    waterlineMaxRingsPerBand: 64,
    debugToolpath: true,
  }
  project.operations = [operation]

  const result = generateFinishSurfaceToolpath(project, operation)
  const capCuts = projectedWaterlineCuts(result, 'projectedCap')
  assert(capCuts.length > 0,
    `expected projected cap cuts on cone peak, got none; debug: ${result.warnings.join('; ')}`)

  const cuts = cutMoves(result.moves)
  const firstRealWaterlineIndex = cuts.findIndex((move) => !move.source)
  const firstProjectedCapIndex = cuts.findIndex((move) => move.source === 'projectedCap')
  assert(firstRealWaterlineIndex >= 0 && firstProjectedCapIndex > firstRealWaterlineIndex,
    `expected real cone waterline before projected cap fill, real=${firstRealWaterlineIndex}, cap=${firstProjectedCapIndex}`)
  const firstProjectedCapMoveIndex = result.moves.findIndex((move) => move.kind === 'cut' && move.source === 'projectedCap')
  const moveBeforeFirstCap = result.moves[firstProjectedCapMoveIndex - 1]
  const safeZ = Math.max(...result.moves.flatMap((move) => [move.from.z, move.to.z]))
  assert(
    !moveBeforeFirstCap || moveBeforeFirstCap.kind !== 'plunge' || moveBeforeFirstCap.from.z < safeZ - 1e-6,
    'expected nearby projected cap fill to link from the preceding ring without a safe-Z plunge',
  )

  const capPoints = capCuts.flatMap((move) => [move.from, move.to])
  const capZs = capPoints.map((point) => point.z)
  const capRadii = capPoints.map((point) => Math.hypot(point.x - 10, point.y - 5))
  const maxCapRadius = Math.max(...capRadii)
  const maxCapZ = Math.max(...capZs)
  const minCapZ = Math.min(...capZs)
  assert(maxCapZ > 3.6,
    `expected projected cap to reach near cone peak, got max Z ${maxCapZ}; debug: ${result.warnings.join('; ')}`)
  assert(maxCapZ - minCapZ > 0.4,
    `expected projected cap to form a Z ramp instead of a flat crown, got range ${maxCapZ - minCapZ}`)
  assert(minCapZ >= 2 - 1e-6,
    `expected cone cap projection not to cut below the matched lower step Z=2, got min Z ${minCapZ}`)
  assert(maxCapRadius > 2.5,
    `expected projected cap to absorb the first lower cone boundary, got max radius ${maxCapRadius}`)

  const nonCapInsideCrown = cutMoves(result.moves).filter((move) => (
    move.source !== 'projectedCap'
    && (
      Math.hypot(move.from.x - 10, move.from.y - 5) < maxCapRadius - 0.05
      || Math.hypot(move.to.x - 10, move.to.y - 5) < maxCapRadius - 0.05
    )
  ))
  assert(nonCapInsideCrown.length === 0,
    `expected no coarse/projected-band ring inside the cone cap crown, got ${nonCapInsideCrown.length}`)

  const radii = capRadii
    .sort((a, b) => a - b)
  const innerRadius = radii[Math.floor(radii.length * 0.25)]
  const outerRadius = radii[Math.floor(radii.length * 0.75)]
  const inner = capPoints.filter((point) => Math.hypot(point.x - 10, point.y - 5) <= innerRadius)
  const outer = capPoints.filter((point) => Math.hypot(point.x - 10, point.y - 5) >= outerRadius)
  assert(inner.length > 0 && outer.length > 0,
    `expected inner and outer cone-cap samples, inner=${inner.length}, outer=${outer.length}`)
  const avgZ = (points: typeof capPoints): number => (
    points.reduce((sum, point) => sum + point.z, 0) / points.length
  )
  assert(avgZ(inner) > avgZ(outer) + 0.4,
    `expected cone cap Z to rise smoothly toward center, inner=${avgZ(inner)}, outer=${avgZ(outer)}`)
}

function testWaterlineTipCapFillsCollapsedBranch(): void {
  console.log('Testing waterline projected cap fills a collapsed branch...')
  const { project } = makeProject()
  project.features = [makeUnevenTwinConeModelFeature()]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepdown: 1,
    stepover: 0.2,
    waterlineMicroStepover: 0.2,
    waterlineTipStepdown: 0.5,
    waterlineMaxRingsPerBand: 64,
    debugToolpath: true,
  }
  project.operations = [operation]

  const result = generateFinishSurfaceToolpath(project, operation)
  const capCuts = projectedWaterlineCuts(result, 'projectedCap')
  const lowerPeakCenter = { x: 8.8, y: 5 }
  const lowerPeakInnerCuts = capCuts.filter((move) => (
    Math.max(
      Math.hypot(move.from.x - lowerPeakCenter.x, move.from.y - lowerPeakCenter.y),
      Math.hypot(move.to.x - lowerPeakCenter.x, move.to.y - lowerPeakCenter.y),
    ) < 0.65
    && Math.max(move.from.z, move.to.z) > 2.55
  ))
  const hasRisingInnerMove = lowerPeakInnerCuts.some((move) => Math.abs(move.from.z - move.to.z) > 1e-6)
  const maxLowerPeakInnerZ = lowerPeakInnerCuts.length > 0
    ? Math.max(...lowerPeakInnerCuts.flatMap((move) => [move.from.z, move.to.z]))
    : Number.NEGATIVE_INFINITY

  assert(lowerPeakInnerCuts.length > 0,
    `expected projected cap cuts inside the lower collapsed peak, got none; debug: ${result.warnings.join('; ')}`)
  assert(maxLowerPeakInnerZ > 2.85,
    `expected collapsed peak cap to reach near the lower apex, got max Z ${maxLowerPeakInnerZ}`)
  assert(hasRisingInnerMove,
    'expected collapsed peak cap to use projected Z interpolation instead of a flat fill')
}

function testWaterlineAdaptiveRefinementCanBeDisabled(): void {
  console.log('Testing waterline adaptive refinement can be disabled...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepover: 0.3,
    waterlineAdaptiveRefinement: false,
    debugToolpath: true,
  }
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const projectedCuts = projectedWaterlineCuts(result)

  assert(projectedCuts.length === 0,
    `expected no projected cuts when adaptive refinement is disabled, got ${projectedCuts.length}`)
  assert(result.warnings.some((warning) => warning.includes('adaptive refinement is disabled')),
    `expected disabled adaptive refinement debug warning, got: ${result.warnings.join('; ')}`)
}

function testWaterlineMicroStepoverControlsProjectedDensity(): void {
  console.log('Testing waterline adaptive spacing controls projected pass density...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  const coarseOperation: Operation = {
    ...makeWaterlineOperation(),
    stepover: 0.8,
  }
  const denseOperation: Operation = {
    ...coarseOperation,
    id: 'finish-dense',
    waterlineMicroStepover: 0.2,
  }

  project.operations = [coarseOperation]
  const coarse = generateFinishSurfaceToolpath(project, coarseOperation)
  project.operations = [denseOperation]
  const dense = generateFinishSurfaceToolpath(project, denseOperation)
  const coarseProjected = projectedWaterlineCuts(coarse)
  const denseProjected = projectedWaterlineCuts(dense)

  assert(denseProjected.length > coarseProjected.length,
    `expected smaller adaptive spacing to increase projected cuts, coarse=${coarseProjected.length}, dense=${denseProjected.length}`)
}

function testWaterlineZeroMicroStepoverUsesLegacyRatioFallback(): void {
  console.log('Testing waterline zero adaptive spacing uses legacy stepover-ratio fallback...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  const legacyOperation: Operation = {
    ...makeWaterlineOperation(),
    stepover: 0.25,
    waterlineMicroStepover: 0,
  }
  const explicitOperation: Operation = {
    ...legacyOperation,
    id: 'finish-explicit',
    waterlineMicroStepover: 0.25,
  }

  project.operations = [legacyOperation]
  const legacy = generateFinishSurfaceToolpath(project, legacyOperation)
  project.operations = [explicitOperation]
  const explicit = generateFinishSurfaceToolpath(project, explicitOperation)
  const legacyProjected = projectedWaterlineCuts(legacy)
  const explicitProjected = projectedWaterlineCuts(explicit)

  assert(legacyProjected.length === explicitProjected.length,
    `expected zero adaptive spacing to match legacy ratio fallback, legacy=${legacyProjected.length}, explicit=${explicitProjected.length}`)
}

function testWaterlineRefinementThresholdControlsProjectedBands(): void {
  console.log('Testing waterline trigger gap controls projected band insertion...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  const autoThresholdOperation: Operation = {
    ...makeWaterlineOperation(),
    stepover: 0.3,
  }
  const highThresholdOperation: Operation = {
    ...autoThresholdOperation,
    id: 'finish-high-threshold',
    waterlineRefinementThreshold: 100,
  }

  project.operations = [autoThresholdOperation]
  const autoThreshold = generateFinishSurfaceToolpath(project, autoThresholdOperation)
  project.operations = [highThresholdOperation]
  const highThreshold = generateFinishSurfaceToolpath(project, highThresholdOperation)
  const autoBandCuts = projectedWaterlineCuts(autoThreshold, 'projectedBand')
  const highThresholdBandCuts = projectedWaterlineCuts(highThreshold, 'projectedBand')

  assert(autoBandCuts.length > highThresholdBandCuts.length,
    `expected larger trigger gap to reduce projected bands, auto=${autoBandCuts.length}, high=${highThresholdBandCuts.length}`)
}

function testWaterlineAdaptiveDoesNotRefineSteepVerticalWalls(): void {
  console.log('Testing waterline adaptive refinement avoids 3D micro passes on steep vertical walls...')
  const { project } = makeProject()
  project.features = [makePocketBlockModelFeature()]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepdown: 0.5,
    stepover: 0.2,
    debugToolpath: true,
  }
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const projectedCuts = cutMoves(result.moves).filter((move) => move.source === 'projectedBand' || move.source === 'projectedCap')
  const projected3DCuts = projectedCuts.filter((move) => Math.abs(move.from.z - move.to.z) > 1e-6)

  assert(projected3DCuts.length === 0,
    `expected vertical-wall waterline to avoid sloped projected micro-offset cuts, got ${projected3DCuts.length}`)
}

function testWaterlineAdaptiveSubdivisionIsBounded(): void {
  console.log('Testing waterline adaptive subdivision is bounded...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepover: 0.001,
    debugToolpath: true,
  }
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const projectedCuts = cutMoves(result.moves).filter((move) => move.source === 'projectedBand' || move.source === 'projectedCap')
  assert(projectedCuts.length < 350_000,
    `expected bounded projected micro-offset cuts, got ${projectedCuts.length} — debug: ${result.warnings.join('; ')}`)
  assert(result.warnings.some((warning) => warning.includes('insert cap') || warning.includes('pass limit')),
    `expected projected refinement to report a limit, got: ${result.warnings.join('; ')}`)
}

function testWaterlineMaxRingsPerBandLimitsProjectedRings(): void {
  console.log('Testing waterline max rings per band limits adaptive passes...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  const unrestrictedOperation: Operation = {
    ...makeWaterlineOperation(),
    stepover: 0.2,
  }
  const limitedOperation: Operation = {
    ...unrestrictedOperation,
    id: 'finish-limited',
    waterlineMaxRingsPerBand: 1,
    debugToolpath: true,
  }

  project.operations = [unrestrictedOperation]
  const unrestricted = generateFinishSurfaceToolpath(project, unrestrictedOperation)
  project.operations = [limitedOperation]
  const limited = generateFinishSurfaceToolpath(project, limitedOperation)
  const unrestrictedProjected = projectedWaterlineCuts(unrestricted)
  const limitedProjected = projectedWaterlineCuts(limited)

  assert(limitedProjected.length > 0, 'expected limited adaptive pass to still emit projected cuts')
  assert(limitedProjected.length < unrestrictedProjected.length,
    `expected max rings per band to reduce projected cuts, limited=${limitedProjected.length}, unrestricted=${unrestrictedProjected.length}`)
  assert(limited.warnings.some((warning) => warning.includes('pass limit')),
    `expected pass limit debug warning, got: ${limited.warnings.join('; ')}`)
}

function testWaterlineQualityControlsNormalizeAndConvertUnits(): void {
  console.log('Testing waterline quality controls normalize and convert units...')
  const { project } = makeProject()
  const operation: Operation = {
    ...makeWaterlineOperation(),
    waterlineMicroStepover: 2.54,
    waterlineRefinementThreshold: 5.08,
    waterlineAdaptiveRefinement: false,
    waterlineMaxRingsPerBand: 7,
  }
  project.operations = [operation]
  const normalized = normalizeProject(project)
  const normalizedOperation = normalized.operations[0]

  assert(normalizedOperation.waterlineAdaptiveRefinement === false,
    'expected explicit adaptive refinement setting to survive normalization')
  assert(normalizedOperation.waterlineMaxRingsPerBand === 7,
    'expected max rings per band to survive normalization')

  const converted = convertProjectUnits(normalized, 'inch')
  const convertedOperation = converted.operations[0]
  assert(Math.abs((convertedOperation.waterlineMicroStepover ?? 0) - 0.1) < 1e-9,
    `expected micro stepover to convert to 0.1 in, got ${convertedOperation.waterlineMicroStepover}`)
  assert(Math.abs((convertedOperation.waterlineRefinementThreshold ?? 0) - 0.2) < 1e-9,
    `expected refinement threshold to convert to 0.2 in, got ${convertedOperation.waterlineRefinementThreshold}`)
  assert(convertedOperation.waterlineAdaptiveRefinement === false,
    'expected adaptive refinement setting not to change during unit conversion')
  assert(convertedOperation.waterlineMaxRingsPerBand === 7,
    'expected max rings per band not to change during unit conversion')

  const legacyNormalized = normalizeProject({
    ...project,
    operations: [makeWaterlineOperation()],
  })
  const legacyOperation = legacyNormalized.operations[0]
  assert(legacyOperation.waterlineAdaptiveRefinement === true,
    'expected missing adaptive refinement field to default to true')
  assert(legacyOperation.waterlineMicroStepover === 0,
    'expected missing micro stepover field to default to auto')
  assert(legacyOperation.waterlineRefinementThreshold === 0,
    'expected missing refinement threshold field to default to auto')
  assert(legacyOperation.waterlineMaxRingsPerBand === 0,
    'expected missing max rings per band field to default to auto')
}

function testWaterlineNewOperationGetsToolDerivedAdaptiveSpacing(): void {
  console.log('Testing new waterline-capable operations get tool-derived adaptive spacing...')
  const { project } = makeProject()
  useProjectStore.setState({
    project,
    history: { past: [], future: [], transactionStart: null },
  })

  const operationId = useProjectStore.getState().addOperation(
    'finish_surface',
    'finish',
    { source: 'features', featureIds: ['model1'] },
  )
  assert(operationId !== null, 'expected finish surface operation to be created')

  const operation = useProjectStore.getState().project.operations.find((candidate) => candidate.id === operationId)
  if (!operation) {
    throw new Error('Assertion failed: expected created operation in project')
  }
  assert(operation.waterlineMicroStepover === 1,
    `expected tool-derived adaptive spacing of 1, got ${operation.waterlineMicroStepover}`)
}

function testWaterlineLevelsAreConstantBands(): void {
  console.log('Testing waterline levels are constant Z bands...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const expected = [4, 3, 2, 1, 0]
  for (const z of expected) {
    const has = result.stepLevels.some((level) => Math.abs(level - z) < 1e-6)
    assert(has, `expected constant waterline level near Z=${z}, got ${result.stepLevels.join(', ')}`)
  }
}

function testWaterlineEmitsBandBoundaryLevels(): void {
  console.log('Testing waterline emits current band boundary levels...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepover: 0.3,
  }
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const hasBandBoundaryNear4 = result.stepLevels.some((z) => z < 4.01 && z > 3.99)
  const hasBandBoundaryNear3 = result.stepLevels.some((z) => z < 3.01 && z > 2.99)
  const hasBandBoundaryNear2 = result.stepLevels.some((z) => z < 2.01 && z > 1.99)

  assert(hasBandBoundaryNear4, `expected current-band boundary near Z=4 in ${result.stepLevels.join(', ')}`)
  assert(hasBandBoundaryNear3, `expected current-band boundary near Z=3 in ${result.stepLevels.join(', ')}`)
  assert(hasBandBoundaryNear2, `expected current-band boundary near Z=2 in ${result.stepLevels.join(', ')}`)
}

function testWaterlineBallEndmillUsesSideContactZ(): void {
  console.log('Testing waterline ball-endmill stays on constant slice Z levels...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  const operation = makeWaterlineOperation()
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const stepLevels = result.stepLevels
  const maxCutZ = Math.max(...stepLevels)
  const hasBand3 = stepLevels.some((z) => Math.abs(z - 3) < 1e-6)

  assert(cuts.length > 0, 'expected waterline cut moves')
  assert(Math.abs(maxCutZ - 4) < 1e-6, `expected top waterline at Z=4, got ${maxCutZ}`)
  assert(hasBand3, `expected band level near Z=3, got ${stepLevels.join(', ')}`)
}

function testWaterlineReachesModelTop(): void {
  console.log('Testing waterline reaches model top...')
  const { project } = makeProject()
  const operation = makeWaterlineOperation()
  operation.stepdown = 1
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const maxZ = Math.max(...result.stepLevels)
  const topZ = 4

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(maxZ >= topZ - 1e-6, `expected waterline to reach top ${topZ}, got ${maxZ}`)
}

function testWaterlineBlendsWithRoughInCombinedSimulation(): void {
  console.log('Testing rough + waterline combined replay remains stable...')
  const { project } = makeProject()
  project.features = [makeTaperedModelFeature()]
  normalizeProjectFeatures(project)
  project.stock = {
    ...project.stock,
    profile: rectProfile(0, 0, 20, 10),
    thickness: 4,
  }

  const rough = makeRoughSurfaceOperation()
  rough.target = { source: 'features', featureIds: ['model1'] }
  rough.stepdown = 1
  rough.stepover = 0.5

  const finish = makeWaterlineOperation()
  finish.target = { source: 'features', featureIds: ['model1'] }
  finish.stepdown = 1
  finish.stepover = 0.3

  const roughPath = generateRoughSurfaceToolpath(project, rough)
  const finishPath = generateFinishSurfaceToolpath(project, finish)
  assert(roughPath.warnings.length === 0, `unexpected rough warnings: ${roughPath.warnings.join(', ')}`)
  assert(finishPath.warnings.length === 0, `unexpected finish warnings: ${finishPath.warnings.join(', ')}`)

  const tool = project.tools[0]
  const replayRough: SimulationReplayItem = {
    operationId: rough.id,
    operationName: rough.name,
    toolRef: tool.id,
    toolType: tool.type,
    toolRadius: tool.diameter / 2,
    vBitAngle: null,
    toolpath: roughPath,
  }
  const replayFinish: SimulationReplayItem = {
    operationId: finish.id,
    operationName: finish.name,
    toolRef: tool.id,
    toolType: tool.type,
    toolRadius: tool.diameter / 2,
    vBitAngle: null,
    toolpath: finishPath,
  }

  const roughOnly = simulateReplayItemsHeightfield(project, [replayRough], { targetLongAxisCells: 140 })
  const combined = simulateReplayItemsHeightfield(project, [replayRough, replayFinish], { targetLongAxisCells: 140 })

  const roi = { minX: 1, maxX: 19, minY: 1, maxY: 9 }
  const roughJump = edgeJumpMetric(roughOnly.grid, roi)
  const combinedJump = edgeJumpMetric(combined.grid, roi)

  assert(Number.isFinite(roughJump) && Number.isFinite(combinedJump),
    `expected finite terracing metrics, rough=${roughJump}, combined=${combinedJump}`)
  assert(combinedJump <= roughJump * 1.5,
    `expected waterline finish not to regress terracing catastrophically, rough=${roughJump}, combined=${combinedJump}`)
}

function testWaterlinePocketBlockSimplification(): void {
  console.log('Testing waterline simplification on steep pocket block...')
  const { project } = makeProject()
  project.features = [makePocketBlockModelFeature()]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepdown: 0.5,
    stepover: 0.5,
  }
  project.operations = [operation]

  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const outsideWallCuts = cuts.filter((move) => [move.from, move.to].some((point) => (
    point.x < 0 || point.x > 20 || point.y < 0 || point.y > 10
  )))
  const pocketWallCuts = cuts.filter((move) => [move.from, move.to].some((point) => {
    if (point.z < 2 - 1e-9 || point.z > 4 + 1e-9) return false
    const nearVerticalWall = Math.abs(point.x - 6.5) < 1e-6 || Math.abs(point.x - 13.5) < 1e-6
    const nearHorizontalWall = Math.abs(point.y - 3.5) < 1e-6 || Math.abs(point.y - 6.5) < 1e-6
    return point.x >= 6.5 - 1e-6 && point.x <= 13.5 + 1e-6 &&
      point.y >= 3.5 - 1e-6 && point.y <= 6.5 + 1e-6 &&
      (nearVerticalWall || nearHorizontalWall)
  }))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected waterline cut moves on pocket block')
  assert(outsideWallCuts.length > 0, 'expected waterline cuts around the outside wall')
  assert(pocketWallCuts.length > 0, 'expected waterline cuts around the pocket walls')
  assert(!hasReducibleAdjacentCutPair(result.moves),
    'expected simplifier to remove adjacent reducible collinear cut segments')
}

function testWaterlineIgnoresContainingAddAsIntersectingWall(): void {
  console.log('Testing waterline ignores containing add features as intersecting walls...')
  const { project } = makeProject()
  project.features = [makeContainingAddFeature(), makePocketBlockModelFeature()]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepdown: 0.5,
    stepover: 0.5,
  }
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const cutsAboveModelTop = cuts.filter((move) => move.from.z > 4 + 1e-6 || move.to.z > 4 + 1e-6)

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected waterline cuts for model inside containing add feature')
  assert(cutsAboveModelTop.length === 0,
    `expected containing add not to create above-model waterline cuts, got ${cutsAboveModelTop.length}`)
}

function testWaterlineCutsIntersectingAddFeatureWalls(): void {
  console.log('Testing waterline cuts intersecting add feature walls...')
  const { project } = makeProject()
  project.features = [makePocketBlockModelFeature(), makeIntersectingAddFeature()]
  normalizeProjectFeatures(project)
  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepdown: 0.5,
    stepover: 0.5,
  }
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected waterline cut moves')

  // The intersecting add pokes above the mesh top (4). Waterline must trace
  // the portion of that add wall that intersects the model footprint.
  const cutsAboveMeshTop = cuts.filter((m) => m.from.z > 4 + 1e-6 || m.to.z > 4 + 1e-6)
  assert(cutsAboveMeshTop.length > 0,
    `expected waterline cuts above mesh top tracing intersecting add walls, got ${cutsAboveMeshTop.length}`)

  // The intersecting portion runs from x=18 to x=20 (model right edge). With
  // a 1mm tool the offset contour around that clipped patch sits at x≈17.5
  // (intersecting wall) and x≈20.5 (model-edge wall above the mesh top). The
  // add's outer wall at x=25 must NOT be traced because it lies outside the
  // model silhouette.
  const epsilon = 0.6
  const nearIntersectingWall = cutsAboveMeshTop.some((m) => (
    Math.abs(m.from.x - 17.5) <= epsilon || Math.abs(m.to.x - 17.5) <= epsilon
  ))
  assert(nearIntersectingWall,
    'expected waterline cuts near intersecting add wall (x≈17.5) above mesh top')
  const beyondModel = cutsAboveMeshTop.some((m) => m.from.x > 21 || m.to.x > 21)
  assert(!beyondModel,
    'expected no waterline cuts beyond the model silhouette (x>21) — intersecting feature must be clipped to model footprint')
}

function testWaterlineClipsIntersectingWallToActualModelSpan(): void {
  console.log('Testing waterline clips intersecting wall cuts to the actual model span...')
  const { project, operation } = loadImportedBlockWaterlineProject()
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected waterline cut moves')

  const overlapCuts = cuts.filter((move) => (
    move.to.z >= 0.5 - 1e-9 &&
    [move.from, move.to].some((point) => (
      point.x >= 2.4 && point.x <= 3.65 &&
      point.y >= 0.6 && point.y <= 1.6
    ))
  ))
  assert(overlapCuts.length > 0, 'expected waterline cuts in the imported-model/add overlap zone')

  const touchesDiagonalWall = overlapCuts.some((move) => {
    const dx = Math.abs(move.to.x - move.from.x)
    const dy = Math.abs(move.to.y - move.from.y)
    return dx > 0.5 && dy > 0.5
  })
  const hasUpperRightCornerCap = overlapCuts.some((move) => {
    const endpoints = [move.from, move.to]
    if (!endpoints.every((point) => point.x >= 3.45 && point.y >= 1.5)) return false
    return Math.hypot(move.to.x - move.from.x, move.to.y - move.from.y) < 0.2
  })

  assert(touchesDiagonalWall,
    'expected waterline to keep the actual diagonal intersecting wall segment')
  assert(!hasUpperRightCornerCap,
    'expected no tiny waterline corner cap in the clipped upper-right corner outside the true intersection wall')
  assertNoTargetMeshGougingCuts(project, operation, result)
}

function testFinishSurfaceExcludesAddOwnedPocketFromZRange(): void {
  console.log('Testing finish_surface excludes add-feature-owned pocket from Z range...')
  const { project, operation } = makeProject()
  project.features = [makeAddOwnedPocketParent(), makeAddOwnedPocketFeature(), ...project.features]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected finish surface cut moves')
  const minCutZ = Math.min(...cuts.map((m) => m.to.z))
  // Without the fix, the owned pocket (z_bottom=-2) would pull effectiveBottom
  // down to -2. With it, bottom stays at the model bottom (z=0).
  assert(minCutZ >= 0 - 1e-9,
    `expected no finish cuts below model bottom (z=0); got min ${minCutZ}`)
}

function testWaterlineRespectsTabZRange(): void {
  console.log('Testing waterline respects tab Z range...')
  const { project } = makeProject()
  project.features = [makePocketBlockModelFeature()]
  normalizeProjectFeatures(project)
  const tabRect = { x: 0, y: 0, w: 3, h: 3 }
  project.tabs = [{
    id: 'tab1',
    name: 'Top tab',
    ...tabRect,
    z_top: 4,
    z_bottom: 3.2,
    visible: true,
  }]

  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepdown: 1,
    stepover: 0.5,
  }
  project.operations = [operation]
  const withTabRaw = generateFinishSurfaceToolpath(project, operation)
  const withTab = applyTabsToEdgeRoute(project, operation, withTabRaw)
  const withTabCuts = cutMoves(withTab.moves)

  const baselineProject = {
    ...project,
    tabs: [],
  }
  const withoutTab = generateFinishSurfaceToolpath(baselineProject, operation)
  const withoutTabCuts = cutMoves(withoutTab.moves)

  const topCutsInTab = withTabCuts.filter((move) => (
    move.to.z < 3.2 &&
    segmentIntersectsRect2D(move.from, move.to, tabRect)
  ))
  const lowerCutsInTabWithTab = withTabCuts.filter((move) => (
    move.to.z <= 2.6 &&
    segmentIntersectsRect2D(move.from, move.to, tabRect)
  ))
  const lowerCutsInTabWithoutTab = withoutTabCuts.filter((move) => (
    move.to.z <= 2.6 &&
    segmentIntersectsRect2D(move.from, move.to, tabRect)
  ))

  assert(withTabRaw.warnings.length === 0, `unexpected raw warnings: ${withTabRaw.warnings.join(', ')}`)
  assert(withTab.warnings.length === 0, `unexpected tab-aware warnings: ${withTab.warnings.join(', ')}`)
  assert(withoutTab.warnings.length === 0, `unexpected baseline warnings: ${withoutTab.warnings.join(', ')}`)
  assert(topCutsInTab.length === 0, `expected no below-tab cuts through tab area, got ${topCutsInTab.length}`)
  assert(lowerCutsInTabWithTab.length === lowerCutsInTabWithoutTab.length,
    `expected lower-level tab area cuts to match baseline when tab is inactive, withTab=${lowerCutsInTabWithTab.length}, baseline=${lowerCutsInTabWithoutTab.length}`)
}

function testWaterlineRespectsClampFootprint(): void {
  console.log('Testing waterline respects clamp footprint...')
  const { project } = makeProject()
  project.features = [makePocketBlockModelFeature()]
  normalizeProjectFeatures(project)
  const clampRect = { x: 0, y: 0, w: 3, h: 3 }
  project.clamps = [{
    id: 'clamp1',
    name: 'Corner clamp',
    type: 'step_clamp',
    ...clampRect,
    height: 10,
    visible: true,
  }]

  const operation: Operation = {
    ...makeWaterlineOperation(),
    stepdown: 1,
    stepover: 0.5,
  }
  project.operations = [operation]
  const result = generateFinishSurfaceToolpath(project, operation)
  const cuts = cutMoves(result.moves)
  const cutsInClamp = cuts.filter((move) => (
    segmentIntersectsRect2D(move.from, move.to, clampRect)
  ))

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cutsInClamp.length === 0, `expected no cuts in clamp footprint, got ${cutsInClamp.length}`)
}

// ── Cut direction by ring side ───────────────────────────────────────────

function ccwSquare(): Point[] {
  // 10×10 box at origin, CCW order (Y-up math convention).
  return [
    { x: -5, y: -5 },
    { x: 5, y: -5 },
    { x: 5, y: 5 },
    { x: -5, y: 5 },
    { x: -5, y: -5 },
  ]
}

function cwSquare(): Point[] {
  return [
    { x: -5, y: -5 },
    { x: -5, y: 5 },
    { x: 5, y: 5 },
    { x: 5, y: -5 },
    { x: -5, y: -5 },
  ]
}

function testApplyContourDirectionBySidePocketRole(): void {
  console.log('Testing applyContourDirectionBySide tool-inside (pocket-like) ...')
  const outer = ccwSquare()
  const hole = cwSquare()
  // 'tool-inside' means outer rings have the tool inside (pocket-like).
  // Natural winding (CCW outer, CW hole) is conventional in this role.
  const conv = applyContourDirectionBySide([outer, hole], 'conventional', 'tool-inside')
  assert(!isClockwise(conv[0]), 'pocket-role conventional outer stays CCW')
  assert(isClockwise(conv[1]), 'pocket-role conventional hole stays CW')
  const climb = applyContourDirectionBySide([outer, hole], 'climb', 'tool-inside')
  assert(isClockwise(climb[0]), 'pocket-role climb reverses outer to CW')
  assert(!isClockwise(climb[1]), 'pocket-role climb reverses hole to CCW')
}

function testApplyContourDirectionBySideAroundRole(): void {
  console.log('Testing applyContourDirectionBySide tool-outside (around-the-bump) ...')
  const outer = ccwSquare()
  const hole = cwSquare()
  // 'tool-outside' means outer rings have the tool outside (around-the-bump).
  // Natural winding (CCW outer = climb, CW hole inside pocket = climb) is climb.
  const climb = applyContourDirectionBySide([outer, hole], 'climb', 'tool-outside')
  assert(!isClockwise(climb[0]), 'around-role climb keeps outer CCW')
  assert(isClockwise(climb[1]), 'around-role climb keeps hole CW')
  const conv = applyContourDirectionBySide([outer, hole], 'conventional', 'tool-outside')
  assert(isClockwise(conv[0]), 'around-role conventional reverses outer to CW')
  assert(!isClockwise(conv[1]), 'around-role conventional reverses hole to CCW')
}

function testApplyContourDirectionBySideReversesOpenPolylinesWhenNeeded(): void {
  console.log('Testing applyContourDirectionBySide reverses open polylines to honor direction ...')
  // CCW arc fragment (signed area positive). Natural traversal direction is
  // CCW. For tool-outside topology, CCW = climb naturally.
  const open: Point[] = [
    { x: 0, y: 0 },
    { x: 5, y: 0 },
    { x: 5, y: 5 },
    { x: 0, y: 5 },
  ]
  // Climb requested + tool-outside + natural CCW = match → keep order.
  const keep = applyContourDirectionBySide([open], 'climb', 'tool-outside', [false])
  assert(keep[0][0].x === 0 && keep[0][3].x === 0, 'open polyline kept for climb on outer-style')
  // Conventional requested + tool-outside + natural CCW = mismatch → reverse.
  const flipped = applyContourDirectionBySide([open], 'conventional', 'tool-outside', [false])
  assert(flipped[0][0].x === 0 && flipped[0][0].y === 5, `open polyline reversed; first point should be (0,5), got (${flipped[0][0].x},${flipped[0][0].y})`)
  assert(flipped[0][3].x === 0 && flipped[0][3].y === 0, 'open polyline reversed; last point should be (0,0)')
}

function testApplyContourDirectionBySideAcceptsNaturalWindingHint(): void {
  console.log('Testing applyContourDirectionBySide honors natural-winding hint for ambiguous fragments ...')
  // A nearly-straight open polyline whose signed area is tiny — the source
  // ring's natural winding must come from a hint, not signed-area on the fragment.
  const fragment: Point[] = [
    { x: 0, y: 0 },
    { x: 1, y: 0.001 },
    { x: 2, y: 0 },
  ]
  // Tell the helper this fragment came from a CCW outer ring (tool-outside).
  // Then conventional should reverse it.
  const flipped = applyContourDirectionBySide(
    [fragment], 'conventional', 'tool-outside', [false], [false],
  )
  assert(flipped[0][0].x === 2, 'fragment reversed per the natural-winding hint')
}

function extractClosedLoopsAtZ(moves: ToolpathMove[], z: number, eps = 1e-6): Point[][] {
  const loops: Point[][] = []
  let current: Point[] = []
  let lastTo: { x: number; y: number } | null = null
  const flush = (): void => {
    if (current.length >= 4) {
      const first = current[0]
      const last = current[current.length - 1]
      if (Math.abs(first.x - last.x) <= eps && Math.abs(first.y - last.y) <= eps) {
        loops.push(current)
      }
    }
    current = []
    lastTo = null
  }
  for (const m of moves) {
    if (m.kind !== 'cut'
        || Math.abs(m.from.z - z) > eps
        || Math.abs(m.to.z - z) > eps) {
      flush()
      continue
    }
    if (current.length === 0 || (lastTo && (Math.abs(lastTo.x - m.from.x) > eps || Math.abs(lastTo.y - m.from.y) > eps))) {
      flush()
      current = [{ x: m.from.x, y: m.from.y }]
    }
    current.push({ x: m.to.x, y: m.to.y })
    lastTo = m.to
  }
  flush()
  return loops
}

function loopBounds(loop: Point[]): { minX: number; maxX: number; minY: number; maxY: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity
  for (const p of loop) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { minX, maxX, minY, maxY }
}

function testWaterlineClimbWindsCorrectlyOnBothSides(): void {
  console.log('Testing waterline climb winds CCW around model and CW inside pocket ...')
  const { project } = makeProject()
  project.features = [makePocketBlockModelFeature()]
  normalizeProjectFeatures(project)
  const op: Operation = {
    ...makeWaterlineOperation(),
    target: { source: 'features', featureIds: ['model1'] },
    cutDirection: 'climb',
    stepdown: 0.5,
    stepover: 0.5,
  }
  project.operations = [op]
  const result = generateFinishSurfaceToolpath(project, op)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  const cutsAtZ = result.stepLevels.find((z) => z > 2.5 && z < 3.5) ?? null
  assert(cutsAtZ !== null, 'expected at least one waterline Z between pocket floor (2) and top (4)')

  const loops = extractClosedLoopsAtZ(result.moves, cutsAtZ as number)
  assert(loops.length >= 2,
    `expected outer-wall loop and pocket-wall loop at Z=${cutsAtZ}, got ${loops.length} loops`)

  let sawOuter = false
  let sawPocket = false
  for (const loop of loops) {
    const b = loopBounds(loop)
    const isOuter = b.minX < 0 && b.maxX > 20
    const isPocket = b.minX > 5.5 && b.maxX < 14.5 && b.minY > 2.5 && b.maxY < 7.5
    if (isOuter) {
      sawOuter = true
      assert(!isClockwise(loop),
        `climb around outer wall should be CCW (positive area); got CW loop bounds=${JSON.stringify(b)}`)
    } else if (isPocket) {
      sawPocket = true
      assert(isClockwise(loop),
        `climb inside pocket should be CW (negative area); got CCW loop bounds=${JSON.stringify(b)}`)
    }
  }
  assert(sawOuter, 'expected an outer-wall loop in the waterline output')
  assert(sawPocket, 'expected a pocket-wall loop in the waterline output')
}

function testWaterlineConventionalWindsOppositeOfClimb(): void {
  console.log('Testing waterline conventional winds CW around model and CCW inside pocket ...')
  const { project } = makeProject()
  project.features = [makePocketBlockModelFeature()]
  normalizeProjectFeatures(project)
  const op: Operation = {
    ...makeWaterlineOperation(),
    target: { source: 'features', featureIds: ['model1'] },
    cutDirection: 'conventional',
    stepdown: 0.5,
    stepover: 0.5,
  }
  project.operations = [op]
  const result = generateFinishSurfaceToolpath(project, op)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  const cutsAtZ = result.stepLevels.find((z) => z > 2.5 && z < 3.5) ?? null
  assert(cutsAtZ !== null, 'expected at least one waterline Z')

  const loops = extractClosedLoopsAtZ(result.moves, cutsAtZ as number)
  for (const loop of loops) {
    const b = loopBounds(loop)
    if (b.minX < 0 && b.maxX > 20) {
      assert(isClockwise(loop),
        `conventional around outer wall should be CW; got CCW loop bounds=${JSON.stringify(b)}`)
    } else if (b.minX > 5.5 && b.maxX < 14.5 && b.minY > 2.5 && b.maxY < 7.5) {
      assert(!isClockwise(loop),
        `conventional inside pocket should be CCW; got CW loop bounds=${JSON.stringify(b)}`)
    }
  }
}

function testWaterlineSnapsDriftedClosedRingEntryToPreviousEndpoint(): void {
  console.log('Testing waterline snaps drifted closed-ring entries to previous XY...')
  const previousEndpoint = { x: 6.5, y: 3.5 }
  const contour: Point[] = [
    { x: 6.503, y: 3.498 },
    { x: 13.5, y: 3.5 },
    { x: 13.5, y: 6.5 },
    { x: 6.5, y: 6.5 },
  ]

  const snapped = snapClosedContourEntryToAnchor(contour, previousEndpoint, 0.01)
  assert(snapped.length === contour.length,
    `expected snap to replace the entry point, got ${snapped.length} points`)
  assert(snapped[0].x === previousEndpoint.x && snapped[0].y === previousEndpoint.y,
    `expected snapped entry to equal previous endpoint, got (${snapped[0].x}, ${snapped[0].y})`)
  assert(snapped[1] === contour[1], 'expected snap to preserve the rest of the contour vertices')

  const unsnapped = snapClosedContourEntryToAnchor(contour, previousEndpoint, 0.001)
  assert(unsnapped === contour, 'expected contour outside tolerance to remain unchanged')
}

// ── Run all tests ────────────────────────────────────────────────────────

testFinishSurfaceCoversLowerTopPlateau()
testFinishSurfaceRepeatGenerationIsStable()
testFinishSurfaceAvoidsSurroundingAddFeature()
testFinishSurfaceRespectsContainingPocketDepth()
testFinishSurfaceRespectsSplitPocketDepths()

testMaxContourGapIdenticalContours()
testMaxContourGapDifferentContours()
testMaxContourGapEmptyReturnsThickness()
testWaterlineCumulativeShadowProtectsUpperLevels()

testWaterlineGeneratesContourMoves()
testWaterlineStepLevelsDescend()
testWaterlineRepeatIsStable()
testWaterlineRespectsContainingPocketDepth()
testWaterlineRegionActsAsFilterNotBoundaryContour()
testWaterlineAdaptivelyRefinesShallowSlope()
testWaterlineTipCapSmoothsConePeak()
testWaterlineTipCapFillsCollapsedBranch()
testWaterlineAdaptiveRefinementCanBeDisabled()
testWaterlineMicroStepoverControlsProjectedDensity()
testWaterlineZeroMicroStepoverUsesLegacyRatioFallback()
testWaterlineRefinementThresholdControlsProjectedBands()
testWaterlineAdaptiveDoesNotRefineSteepVerticalWalls()
testWaterlineAdaptiveSubdivisionIsBounded()
testWaterlineMaxRingsPerBandLimitsProjectedRings()
testWaterlineQualityControlsNormalizeAndConvertUnits()
testWaterlineNewOperationGetsToolDerivedAdaptiveSpacing()
testWaterlineLevelsAreConstantBands()
testWaterlineEmitsBandBoundaryLevels()
testWaterlineBallEndmillUsesSideContactZ()
testWaterlineReachesModelTop()
testWaterlineBlendsWithRoughInCombinedSimulation()
testWaterlinePocketBlockSimplification()
testWaterlineIgnoresContainingAddAsIntersectingWall()
testWaterlineCutsIntersectingAddFeatureWalls()
testWaterlineClipsIntersectingWallToActualModelSpan()
testFinishSurfaceExcludesAddOwnedPocketFromZRange()
testWaterlineRespectsTabZRange()
testWaterlineRespectsClampFootprint()

testApplyContourDirectionBySidePocketRole()
testApplyContourDirectionBySideAroundRole()
testApplyContourDirectionBySideReversesOpenPolylinesWhenNeeded()
testApplyContourDirectionBySideAcceptsNaturalWindingHint()
testWaterlineClimbWindsCorrectlyOnBothSides()
testWaterlineConventionalWindsOppositeOfClimb()
testWaterlineSnapsDriftedClosedRingEntryToPreviousEndpoint()

function testWaterlineFinishesOneColumnBeforeNext(): void {
  console.log('Testing waterline finishes one column top-to-bottom before moving to the next...')
  const { project } = makeProject()
  project.features = [makePocketBlockModelFeature()]
  normalizeProjectFeatures(project)
  const op: Operation = {
    ...makeWaterlineOperation(),
    target: { source: 'features', featureIds: ['model1'] },
    cutDirection: 'climb',
    stepdown: 0.5,
    stepover: 0.5,
  }
  project.operations = [op]
  const result = generateFinishSurfaceToolpath(project, op)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)

  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'expected cut moves')

  // Classify each cut by which column it belongs to: outer-wall ring (bbox
  // extends past the model footprint) vs pocket-wall ring (bbox confined
  // within the pocket).
  type Col = 'outer' | 'pocket' | 'other'
  const classify = (move: ToolpathMove): Col => {
    const x = (move.from.x + move.to.x) / 2
    const y = (move.from.y + move.to.y) / 2
    if (x < 0 || x > 20 || y < 0 || y > 10) return 'outer'
    if (x > 5.5 && x < 14.5 && y > 2.5 && y < 7.5) return 'pocket'
    return 'other'
  }

  // Each column should appear as a single contiguous block of cuts (with
  // intra-column plunges allowed, but no other-column cuts in the middle).
  // Count column transitions: should be ≤ number of distinct columns − 1.
  let lastCol: Col | null = null
  const visited = new Set<Col>()
  let transitions = 0
  for (const move of cuts) {
    const col = classify(move)
    if (col === 'other') continue
    if (col !== lastCol) {
      transitions += 1
      visited.add(col)
      lastCol = col
    }
  }
  assert(visited.has('outer'), 'expected outer-wall cuts')
  assert(visited.has('pocket'), 'expected pocket-wall cuts')
  // With column ordering, the first time we see each column counts as a
  // transition (visited.size transitions). Any more means we left a column
  // and came back to it — which the new ordering should not do.
  assert(transitions <= visited.size,
    `expected at most ${visited.size} column transitions (one per column), got ${transitions}; columns are being interleaved instead of finished one at a time`)
}

function testWaterlineColumnDescentReusesSameXYWithPlunge(): void {
  console.log('Testing waterline column descent reuses XY and emits plunge instead of retract...')
  const { project } = makeProject()
  project.features = [makePocketBlockModelFeature()]
  normalizeProjectFeatures(project)
  const op: Operation = {
    ...makeWaterlineOperation(),
    target: { source: 'features', featureIds: ['model1'] },
    cutDirection: 'climb',
    stepdown: 0.5,
    stepover: 0.5,
  }
  project.operations = [op]
  const result = generateFinishSurfaceToolpath(project, op)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)

  // Count plunges that are direct descents from a cut Z to a lower cut Z at
  // the same XY. Each such plunge is one column-step that did not retract to
  // safe Z. With column ordering + ring rotation, most Z transitions inside
  // a column should be of this kind.
  type Col = 'outer' | 'pocket' | 'other'
  const classifyPoint = (point: { x: number; y: number }): Col => {
    if (point.x < 0 || point.x > 20 || point.y < 0 || point.y > 10) return 'outer'
    if (point.x > 5.5 && point.x < 14.5 && point.y > 2.5 && point.y < 7.5) return 'pocket'
    return 'other'
  }
  const safeZ = Math.max(...result.moves.flatMap((move) => [move.from.z, move.to.z]))
  let columnPlunges = 0
  let sameColumnSafeZRoundTrips = 0
  const eps = 1e-3
  for (let i = 0; i < result.moves.length; i += 1) {
    const m = result.moves[i]
    if (m.kind === 'plunge') {
      // A "column plunge" lands directly from a previous cut Z (m.from.z is well
      // below safeZ — i.e., not coming from the safe-Z lane).
      if (m.from.z <= safeZ - eps && m.from.z - m.to.z > 0) {
        columnPlunges += 1
      }
      continue
    }

    if (m.kind !== 'rapid' || m.from.z >= safeZ - eps || m.to.z < safeZ - eps) continue
    const previousCut = result.moves.slice(0, i).findLast((candidate) => candidate.kind === 'cut')
    const nextPlungeIndex = result.moves.findIndex((candidate, index) => (
      index > i && candidate.kind === 'plunge'
    ))
    if (!previousCut || nextPlungeIndex < 0) continue
    const nextPlunge = result.moves[nextPlungeIndex]
    if (nextPlunge.kind !== 'plunge' || nextPlunge.to.z >= previousCut.to.z - eps) continue

    const nextCut = result.moves.slice(nextPlungeIndex + 1).find((candidate) => candidate.kind === 'cut')
    if (!nextCut) continue
    const previousColumn = classifyPoint(previousCut.to)
    const nextColumn = classifyPoint(nextCut.from)
    if (previousColumn !== 'other' && previousColumn === nextColumn) {
      sameColumnSafeZRoundTrips += 1
    }
  }
  assert(columnPlunges >= 1,
    `expected at least one column-descent plunge (cut-Z to cut-Z), got ${columnPlunges}; column ordering is not reusing XY between Z levels`)
  assert(sameColumnSafeZRoundTrips === 0,
    `expected no safe-Z retract/rapid/plunge cycles between adjacent rings in the same column, got ${sameColumnSafeZRoundTrips}`)
}

testWaterlineFinishesOneColumnBeforeNext()
testWaterlineColumnDescentReusesSameXYWithPlunge()

function testParallelFinishLinksScanlinesOnFlatPocket(): void {
  console.log('Testing parallel finish links adjacent scanlines on a flat pocket floor...')
  const { project } = makeProject()
  // Use a region feature to restrict parallel finish to the pocket interior
  // only, so every scanline is entirely on the flat floor (no walls crossing).
  // This isolates the scanline-to-scanline link case the user reported.
  project.features = [
    makePocketBlockModelFeature(),
    makeRegionFeatureRect('region-pocket', 6.5, 3.5, 7, 3),
  ]
  normalizeProjectFeatures(project)
  const op: Operation = {
    ...makeOperation(),
    target: { source: 'features', featureIds: ['model1', 'region-pocket'] },
    pocketPattern: 'parallel',
    pocketAngle: 0,
    stockToLeaveAxial: 0,
    stockToLeaveRadial: 0,
    stepover: 0.4,
  }
  project.operations = [op]
  const result = generateFinishSurfaceToolpath(project, op)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)

  const cuts = cutMoves(result.moves)
  assert(cuts.length > 0, 'expected parallel finish cuts inside the pocket region')

  // Every cut should be at the pocket floor (z≈2). With at-Z linking, the
  // scanline ends should be joined by cut moves, leaving very few plunges and
  // very few contiguous cut runs.
  const floorZ = 2
  const eps = 0.05
  for (const m of cuts) {
    assert(Math.abs(m.to.z - floorZ) <= eps,
      `expected cut at floor Z=${floorZ}, got z=${m.to.z}`)
  }

  let scanlineRuns = 0
  let prevWasCut = false
  for (const m of result.moves) {
    if (m.kind === 'cut') {
      if (!prevWasCut) scanlineRuns += 1
      prevWasCut = true
    } else {
      prevWasCut = false
    }
  }
  const plunges = result.moves.filter((m) => m.kind === 'plunge').length

  assert(plunges <= 2,
    `expected at most 2 plunges into the pocket floor, got ${plunges}; scanlines are not linking at Z`)
  assert(scanlineRuns <= 2,
    `expected pocket-floor scanlines to be stitched into ≤2 contiguous runs, got ${scanlineRuns}; at-Z linking is not merging scanlines`)
}

testParallelFinishLinksScanlinesOnFlatPocket()

function testParallelFinishCutsOverDeepTab(): void {
  console.log('Testing parallel finish cuts over a deep tab in the pocket floor...')
  const { project } = makeProject()
  project.features = [
    makePocketBlockModelFeature(),
    makeRegionFeatureRect('region-pocket', 6.5, 3.5, 7, 3),
  ]
  normalizeProjectFeatures(project)
  // Tab sits inside the pocket footprint with its top well BELOW the pocket
  // floor (floor at z=2, tab top at z=0.5). The cutter never touches the tab,
  // so the toolpath must still cover this XY area.
  const tabRect = { x: 8, y: 4, w: 4, h: 2 }
  project.tabs = [{
    id: 'deep-tab',
    name: 'Deep tab',
    ...tabRect,
    z_top: 0.5,
    z_bottom: 0,
    visible: true,
  }]

  const op: Operation = {
    ...makeOperation(),
    target: { source: 'features', featureIds: ['model1', 'region-pocket'] },
    pocketPattern: 'parallel',
    stepover: 0.4,
    stockToLeaveAxial: 0,
    stockToLeaveRadial: 0,
  }
  project.operations = [op]
  const result = generateFinishSurfaceToolpath(project, op)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)

  const cutsOverTab = cutMoves(result.moves).filter((move) => (
    pointInsideRect(move.to, tabRect) || pointInsideRect(move.from, tabRect)
  ))
  assert(cutsOverTab.length > 0,
    `expected parallel finish cuts above a deep tab (tab top z=0.5, surface z=2), got ${cutsOverTab.length}; tab is being treated as protected at all depths`)
}

function testParallelFinishPreservesTabWhenSurfaceDipsIntoIt(): void {
  console.log('Testing parallel finish clamps Z up to tab.z_top inside tab footprint...')
  const { project } = makeProject()
  project.features = [
    makePocketBlockModelFeature(),
    makeRegionFeatureRect('region-pocket', 6.5, 3.5, 7, 3),
  ]
  normalizeProjectFeatures(project)
  // Tab top sits ABOVE the pocket floor — the natural finish surface dips
  // into the tab. The toolpath must raise its Z to tab.z_top inside the
  // tab footprint so the tab is left standing.
  const tabRect = { x: 8, y: 4, w: 4, h: 2 }
  const tabTopZ = 2.5
  project.tabs = [{
    id: 'shallow-tab',
    name: 'Shallow tab',
    ...tabRect,
    z_top: tabTopZ,
    z_bottom: 0.5,
    visible: true,
  }]

  const op: Operation = {
    ...makeOperation(),
    target: { source: 'features', featureIds: ['model1', 'region-pocket'] },
    pocketPattern: 'parallel',
    stepover: 0.4,
    stockToLeaveAxial: 0,
    stockToLeaveRadial: 0,
  }
  project.operations = [op]
  const result = generateFinishSurfaceToolpath(project, op)
  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)

  const eps = 1e-6
  const cutsBelowTabTopInTab = cutMoves(result.moves).filter((move) => (
    pointInsideRect(move.to, tabRect) && move.to.z < tabTopZ - eps
  ))
  assert(cutsBelowTabTopInTab.length === 0,
    `expected no cut moves below tab.z_top=${tabTopZ} inside tab footprint, got ${cutsBelowTabTopInTab.length}; clamp is not engaging`)

  const cutsInTab = cutMoves(result.moves).filter((move) => (
    pointInsideRect(move.to, tabRect)
  ))
  assert(cutsInTab.length > 0,
    `expected some cut moves inside tab footprint (clamped to z=${tabTopZ}), got none`)
}

function testParallelFinishHonorsOrderedRegionMaskModes(): void {
  console.log('Testing parallel finish honors ordered include/exclude region masks...')
  const { project } = makeProject()
  project.features = [
    makePocketBlockModelFeature(),
    makeRegionFeatureRect('outer-region', 6.5, 3.5, 7, 3, 'include'),
    makeRegionFeatureRect('exclude-region', 8, 4, 4, 2, 'exclude'),
    makeRegionFeatureRect('inner-region', 9.25, 4.6, 1.5, 0.8, 'include'),
  ]
  normalizeProjectFeatures(project)
  const op: Operation = {
    ...makeOperation(),
    target: { source: 'features', featureIds: ['model1', 'outer-region', 'exclude-region', 'inner-region'] },
    pocketPattern: 'parallel',
    stepover: 0.4,
    stockToLeaveAxial: 0,
    stockToLeaveRadial: 0,
  }
  project.operations = [op]

  const result = generateFinishSurfaceToolpath(project, op)
  const cuts = cutMoves(result.moves)
  let hasOuterCut = false
  let hasInnerCut = false

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected parallel finish cuts inside the ordered region mask')
  for (const move of cuts) {
    const samples = [0.1, 0.25, 0.5, 0.75, 0.9].map((t) => ({
      x: move.from.x + (move.to.x - move.from.x) * t,
      y: move.from.y + (move.to.y - move.from.y) * t,
    }))
    hasOuterCut ||= samples.some((point) => pointInsideRect(point, { x: 6.5, y: 3.5, w: 1, h: 1 }))
    hasInnerCut ||= samples.some((point) => pointInsideRect(point, { x: 9.25, y: 4.6, w: 1.5, h: 0.8 }))
    assert(
      samples.every((point) => !pointInsideRect(point, { x: 8, y: 4, w: 4, h: 2 })
        || pointInsideRect(point, { x: 9.25, y: 4.6, w: 1.5, h: 0.8 })),
      `parallel finish should remove excluded area except the later include, got move ${JSON.stringify(move)}`,
    )
  }
  assert(hasOuterCut, 'expected parallel finish cuts in the outer included area')
  assert(hasInnerCut, 'expected parallel finish cuts in the later included inner region')
}

function testParallelFinishExcludeOnlyKeepsOuterCoverage(): void {
  console.log('Testing parallel finish exclude-only mask keeps outer model coverage...')
  const { project } = makeProject()
  project.features = [
    makePocketBlockModelFeature(),
    makeRegionFeatureRect('exclude-region', 6.5, 3.5, 7, 3, 'exclude'),
  ]
  normalizeProjectFeatures(project)
  const op: Operation = {
    ...makeOperation(),
    target: { source: 'features', featureIds: ['model1', 'exclude-region'] },
    pocketPattern: 'parallel',
    stepover: 0.4,
    stockToLeaveAxial: 0,
    stockToLeaveRadial: 0,
  }
  project.operations = [op]

  const result = generateFinishSurfaceToolpath(project, op)
  const cuts = cutMoves(result.moves)
  let hasLeftCoverage = false
  let hasRightCoverage = false

  assert(result.warnings.length === 0, `unexpected warnings: ${result.warnings.join(', ')}`)
  assert(cuts.length > 0, 'expected parallel finish cuts outside the excluded region')
  for (const move of cuts) {
    const samples = [0.1, 0.25, 0.5, 0.75, 0.9].map((t) => ({
      x: move.from.x + (move.to.x - move.from.x) * t,
      y: move.from.y + (move.to.y - move.from.y) * t,
    }))
    hasLeftCoverage ||= samples.some((point) => pointInsideRect(point, { x: 1, y: 3.5, w: 4, h: 3 }))
    hasRightCoverage ||= samples.some((point) => pointInsideRect(point, { x: 15, y: 3.5, w: 4, h: 3 }))
    assert(
      samples.every((point) => !pointInsideRect(point, { x: 6.5, y: 3.5, w: 7, h: 3 })),
      `parallel finish exclude-only mask should remove the excluded rectangle, got move ${JSON.stringify(move)}`,
    )
  }
  assert(hasLeftCoverage, 'expected cuts on the left side outside the excluded region')
  assert(hasRightCoverage, 'expected cuts on the right side outside the excluded region')
}

testParallelFinishCutsOverDeepTab()
testParallelFinishPreservesTabWhenSurfaceDipsIntoIt()
testParallelFinishHonorsOrderedRegionMaskModes()
testParallelFinishExcludeOnlyKeepsOuterCoverage()

console.log('finishSurface tests passed')
