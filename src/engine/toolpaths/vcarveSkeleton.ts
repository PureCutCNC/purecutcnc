import type { Operation, Point, Project } from '../../types/project'
import type { ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './types'
import { getOperationSafeZ, normalizeToolForProject } from './geometry'
import { pushRapidAndPlunge, retractToSafe, updateBounds } from './pocket'
import { resolvePocketRegions } from './resolver'

interface SkeletonCell {
  x: number
  y: number
  z: number
}

function computeBounds(moves: ToolpathMove[]): ToolpathBounds | null {
  let bounds: ToolpathBounds | null = null
  for (const move of moves) {
    bounds = updateBounds(bounds, move.from)
    bounds = updateBounds(bounds, move.to)
  }
  return bounds
}

function pointInPolygon(x: number, y: number, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const xi = polygon[i].x
    const yi = polygon[i].y
    const xj = polygon[j].x
    const yj = polygon[j].y
    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi)
    if (intersects) {
      inside = !inside
    }
  }
  return inside
}

function pointInRegion(x: number, y: number, outer: Point[], islands: Point[][]): boolean {
  if (!pointInPolygon(x, y, outer)) {
    return false
  }
  for (const island of islands) {
    if (pointInPolygon(x, y, island)) {
      return false
    }
  }
  return true
}

function pointSegmentDistance(x: number, y: number, a: Point, b: Point): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const denom = dx * dx + dy * dy
  if (denom <= 1e-12) {
    return Math.hypot(x - a.x, y - a.y)
  }
  const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / denom))
  const px = a.x + dx * t
  const py = a.y + dy * t
  return Math.hypot(x - px, y - py)
}

function polylineDistance(x: number, y: number, polygon: Point[]): number {
  if (polygon.length < 2) {
    return Infinity
  }
  let best = Infinity
  for (let i = 0; i < polygon.length; i += 1) {
    const a = polygon[i]
    const b = polygon[(i + 1) % polygon.length]
    best = Math.min(best, pointSegmentDistance(x, y, a, b))
  }
  return best
}

function regionDistance(x: number, y: number, outer: Point[], islands: Point[][]): number {
  let best = polylineDistance(x, y, outer)
  for (const island of islands) {
    best = Math.min(best, polylineDistance(x, y, island))
  }
  return best
}

function thinningIteration(grid: number[][], step: 0 | 1): boolean {
  const toRemove: Array<[number, number]> = []
  const height = grid.length
  const width = grid[0]?.length ?? 0
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      if (grid[y][x] !== 1) {
        continue
      }
      const p2 = grid[y - 1][x]
      const p3 = grid[y - 1][x + 1]
      const p4 = grid[y][x + 1]
      const p5 = grid[y + 1][x + 1]
      const p6 = grid[y + 1][x]
      const p7 = grid[y + 1][x - 1]
      const p8 = grid[y][x - 1]
      const p9 = grid[y - 1][x - 1]
      const neighbors = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9
      if (neighbors < 2 || neighbors > 6) {
        continue
      }
      const transitions =
        (p2 === 0 && p3 === 1 ? 1 : 0) +
        (p3 === 0 && p4 === 1 ? 1 : 0) +
        (p4 === 0 && p5 === 1 ? 1 : 0) +
        (p5 === 0 && p6 === 1 ? 1 : 0) +
        (p6 === 0 && p7 === 1 ? 1 : 0) +
        (p7 === 0 && p8 === 1 ? 1 : 0) +
        (p8 === 0 && p9 === 1 ? 1 : 0) +
        (p9 === 0 && p2 === 1 ? 1 : 0)
      if (transitions !== 1) {
        continue
      }
      if (step === 0) {
        if (p2 * p4 * p6 !== 0) {
          continue
        }
        if (p4 * p6 * p8 !== 0) {
          continue
        }
      } else {
        if (p2 * p4 * p8 !== 0) {
          continue
        }
        if (p2 * p6 * p8 !== 0) {
          continue
        }
      }
      toRemove.push([x, y])
    }
  }
  for (const [x, y] of toRemove) {
    grid[y][x] = 0
  }
  return toRemove.length > 0
}

function thinGrid(grid: number[][]): void {
  let changed = true
  while (changed) {
    const changedA = thinningIteration(grid, 0)
    const changedB = thinningIteration(grid, 1)
    changed = changedA || changedB
  }
}

function neighborOffsets(): Array<[number, number]> {
  return [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0],           [1, 0],
    [-1, 1],  [0, 1],  [1, 1],
  ]
}

function traceSkeletonPaths(grid: number[][], points: Array<Array<SkeletonCell | null>>): SkeletonCell[][] {
  const height = grid.length
  const width = grid[0]?.length ?? 0
  const offsets = neighborOffsets()
  const visitedEdges = new Set<string>()

  function neighbors(x: number, y: number): Array<[number, number]> {
    return offsets
      .map(([dx, dy]) => [x + dx, y + dy] as [number, number])
      .filter(([nx, ny]) => nx >= 0 && ny >= 0 && nx < width && ny < height && grid[ny][nx] === 1)
  }

  function edgeKey(ax: number, ay: number, bx: number, by: number): string {
    return ax < bx || (ax === bx && ay <= by)
      ? `${ax},${ay}:${bx},${by}`
      : `${bx},${by}:${ax},${ay}`
  }

  function followPath(startX: number, startY: number, nextX: number, nextY: number): SkeletonCell[] {
    const path: SkeletonCell[] = []
    let px = startX
    let py = startY
    let cx = nextX
    let cy = nextY

    const first = points[py][px]
    if (first) {
      path.push(first)
    }

    while (true) {
      const current = points[cy][cx]
      if (current) {
        path.push(current)
      }
      visitedEdges.add(edgeKey(px, py, cx, cy))
      const nextNeighbors = neighbors(cx, cy).filter(([nx, ny]) => !(nx === px && ny === py))
      if (nextNeighbors.length !== 1) {
        break
      }
      const [nx, ny] = nextNeighbors[0]
      const key = edgeKey(cx, cy, nx, ny)
      if (visitedEdges.has(key)) {
        break
      }
      px = cx
      py = cy
      cx = nx
      cy = ny
    }

    return path
  }

  const paths: SkeletonCell[][] = []
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (grid[y][x] !== 1) {
        continue
      }
      const adjacent = neighbors(x, y)
      if (adjacent.length !== 1 && adjacent.length !== 3 && adjacent.length !== 4) {
        continue
      }
      for (const [nx, ny] of adjacent) {
        const key = edgeKey(x, y, nx, ny)
        if (visitedEdges.has(key)) {
          continue
        }
        const path = followPath(x, y, nx, ny)
        if (path.length >= 2) {
          paths.push(path)
        }
      }
    }
  }

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (grid[y][x] !== 1) {
        continue
      }
      for (const [nx, ny] of neighbors(x, y)) {
        const key = edgeKey(x, y, nx, ny)
        if (visitedEdges.has(key)) {
          continue
        }
        const path = followPath(x, y, nx, ny)
        if (path.length >= 2) {
          paths.push(path)
        }
      }
    }
  }

  return paths
}

function buildSkeletonPaths(
  outer: Point[],
  islands: Point[][],
  topZ: number,
  maxDepth: number,
  slope: number,
  requestedSpacing: number,
  warnings: string[],
): SkeletonCell[][] {
  const allPoints = [...outer, ...islands.flat()]
  const minX = Math.min(...allPoints.map((point) => point.x))
  const maxX = Math.max(...allPoints.map((point) => point.x))
  const minY = Math.min(...allPoints.map((point) => point.y))
  const maxY = Math.max(...allPoints.map((point) => point.y))
  const width = Math.max(1e-6, maxX - minX)
  const height = Math.max(1e-6, maxY - minY)
  const longAxis = Math.max(width, height)
  const maxCells = 280
  const cellSize = Math.max(requestedSpacing, longAxis / maxCells, 1e-3)
  if (cellSize > requestedSpacing + 1e-9) {
    warnings.push('Skeleton resolution was relaxed to keep the raster solve tractable')
  }

  const cols = Math.max(3, Math.ceil(width / cellSize) + 4)
  const rows = Math.max(3, Math.ceil(height / cellSize) + 4)
  const originX = minX - 2 * cellSize
  const originY = minY - 2 * cellSize

  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0))
  const points = Array.from({ length: rows }, () => Array.from({ length: cols }, () => null as SkeletonCell | null))

  for (let row = 0; row < rows; row += 1) {
    const y = originY + (row + 0.5) * cellSize
    for (let col = 0; col < cols; col += 1) {
      const x = originX + (col + 0.5) * cellSize
      if (!pointInRegion(x, y, outer, islands)) {
        continue
      }
      const distance = regionDistance(x, y, outer, islands)
      if (!(distance > cellSize * 0.35)) {
        continue
      }
      const depth = Math.min(maxDepth, distance / slope)
      if (!(depth > 1e-6)) {
        continue
      }
      grid[row][col] = 1
      points[row][col] = { x, y, z: topZ - depth }
    }
  }

  thinGrid(grid)
  return traceSkeletonPaths(grid, points)
}

export function generateVCarveSkeletonToolpath(project: Project, operation: Operation): ToolpathResult {
  if (operation.kind !== 'v_carve_skeleton') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: ['Only V-carve skeleton operations can be resolved by the V-carve skeleton generator'],
      bounds: null,
    }
  }

  const resolved = resolvePocketRegions(project, operation)
  const toolRecord = operation.toolRef
    ? project.tools.find((tool) => tool.id === operation.toolRef) ?? null
    : null

  if (!toolRecord) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'No tool assigned to this operation'],
      bounds: null,
    }
  }

  const tool = normalizeToolForProject(toolRecord, project)
  if (tool.type !== 'v_bit') {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'V-Carve Skeleton requires a V-bit tool'],
      bounds: null,
    }
  }

  if (!(tool.vBitAngle && tool.vBitAngle > 0 && tool.vBitAngle < 180)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'V-bit angle must be between 0 and 180 degrees'],
      bounds: null,
    }
  }

  if (!(operation.maxCarveDepth > 0)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Max carve depth must be greater than zero'],
      bounds: null,
    }
  }

  if (!(operation.stepover > 0 && operation.stepover <= 1)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'Contour spacing ratio must be between 0 and 1'],
      bounds: null,
    }
  }

  const halfAngleRadians = (tool.vBitAngle * Math.PI) / 360
  const slope = Math.tan(halfAngleRadians)
  if (!(slope > 1e-9)) {
    return {
      operationId: operation.id,
      moves: [],
      warnings: [...resolved.warnings, 'V-bit angle produces an invalid carving slope'],
      bounds: null,
    }
  }

  const safeZ = getOperationSafeZ(project)
  const requestedSpacing = Math.max(tool.diameter * operation.stepover, 1e-4)
  const warnings = [...resolved.warnings]
  const moves: ToolpathMove[] = []
  let currentPosition: ToolpathPoint | null = null

  for (const band of resolved.bands) {
    const maxBandDepth = Math.max(0, Math.min(operation.maxCarveDepth, band.topZ - band.bottomZ))
    if (!(maxBandDepth > 0)) {
      warnings.push(`Band ${band.topZ} -> ${band.bottomZ} leaves no usable V-carve depth`)
      continue
    }

    for (const region of band.regions) {
      const skeletonPaths = buildSkeletonPaths(
        region.outer,
        region.islands,
        band.topZ,
        maxBandDepth,
        slope,
        requestedSpacing,
        warnings,
      )
      for (const path of skeletonPaths) {
        const entryPoint = path[0]
        const safePosition = retractToSafe(moves, currentPosition, safeZ)
        currentPosition = pushRapidAndPlunge(moves, safePosition, entryPoint, safeZ)
        for (let index = 0; index < path.length - 1; index += 1) {
          moves.push({
            kind: 'cut',
            from: path[index],
            to: path[index + 1],
          })
        }
        currentPosition = path[path.length - 1]
        currentPosition = retractToSafe(moves, currentPosition, safeZ)
      }
    }
  }

  if (moves.length === 0) {
    warnings.push('V-carve skeleton generator produced no toolpath moves')
  }

  return {
    operationId: operation.id,
    moves,
    warnings,
    bounds: computeBounds(moves),
  }
}
