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

import type { Point } from '../../types/project'

export interface ConstantScallopGrid {
  width: number
  height: number
  originX: number
  originY: number
  cellSize: number
  cutterLocationZ: Float64Array
  valid: Uint8Array
}

export interface ConstantDistanceField extends ConstantScallopGrid {
  distance: Float64Array
}

export interface ConstantDistanceContour {
  level: number
  points: Point[]
  closed: boolean
}

interface Segment {
  a: Point
  b: Point
}

const DIJKSTRA_NEIGHBORS: ReadonlyArray<readonly [number, number]> = [
  [-1, 0], [1, 0], [0, -1], [0, 1],
  [-1, -1], [1, -1], [-1, 1], [1, 1],
  [-2, -1], [-2, 1], [2, -1], [2, 1],
  [-1, -2], [1, -2], [-1, 2], [1, 2],
]

class DistanceHeap {
  private readonly distance: Float64Array
  private readonly nodes: Int32Array
  private readonly positions: Int32Array
  private size = 0

  constructor(distance: Float64Array) {
    this.distance = distance
    this.nodes = new Int32Array(distance.length)
    this.positions = new Int32Array(distance.length)
    this.positions.fill(-1)
  }

  get empty(): boolean {
    return this.size === 0
  }

  addOrDecrease(node: number): void {
    const existing = this.positions[node]
    if (existing >= 0) {
      this.siftUp(existing)
      return
    }
    const at = this.size
    this.size += 1
    this.nodes[at] = node
    this.positions[node] = at
    this.siftUp(at)
  }

  pop(): number {
    const root = this.nodes[0]
    this.size -= 1
    this.positions[root] = -1
    if (this.size > 0) {
      const replacement = this.nodes[this.size]
      this.nodes[0] = replacement
      this.positions[replacement] = 0
      this.siftDown(0)
    }
    return root
  }

  private before(left: number, right: number): boolean {
    const leftDistance = this.distance[left]
    const rightDistance = this.distance[right]
    return leftDistance < rightDistance || (leftDistance === rightDistance && left < right)
  }

  private swap(left: number, right: number): void {
    const leftNode = this.nodes[left]
    const rightNode = this.nodes[right]
    this.nodes[left] = rightNode
    this.nodes[right] = leftNode
    this.positions[leftNode] = right
    this.positions[rightNode] = left
  }

  private siftUp(start: number): void {
    let at = start
    while (at > 0) {
      const parent = Math.floor((at - 1) / 2)
      if (!this.before(this.nodes[at], this.nodes[parent])) break
      this.swap(at, parent)
      at = parent
    }
  }

  private siftDown(start: number): void {
    let at = start
    while (true) {
      const left = at * 2 + 1
      if (left >= this.size) return
      const right = left + 1
      const best = right < this.size && this.before(this.nodes[right], this.nodes[left]) ? right : left
      if (!this.before(this.nodes[best], this.nodes[at])) return
      this.swap(at, best)
      at = best
    }
  }
}

function isBoundaryCell(grid: ConstantScallopGrid, col: number, row: number): boolean {
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      if (dx === 0 && dy === 0) continue
      const nextCol = col + dx
      const nextRow = row + dy
      if (nextCol < 0 || nextCol >= grid.width || nextRow < 0 || nextRow >= grid.height) return true
      if (grid.valid[nextRow * grid.width + nextCol] === 0) return true
    }
  }
  return false
}

function seedBoundary(grid: ConstantScallopGrid, distance: Float64Array, heap: DistanceHeap): number {
  let seeds = 0
  for (let row = 0; row < grid.height; row += 1) {
    for (let col = 0; col < grid.width; col += 1) {
      const at = row * grid.width + col
      if (grid.valid[at] === 0 || !isBoundaryCell(grid, col, row)) continue
      distance[at] = 0
      heap.addOrDecrease(at)
      seeds += 1
    }
  }
  return seeds
}

function relaxFrom(
  grid: ConstantScallopGrid,
  distance: Float64Array,
  heap: DistanceHeap,
  from: number,
): void {
  const fromRow = Math.floor(from / grid.width)
  const fromCol = from - fromRow * grid.width
  const fromZ = grid.cutterLocationZ[from]
  for (const [dx, dy] of DIJKSTRA_NEIGHBORS) {
    const col = fromCol + dx
    const row = fromRow + dy
    if (col < 0 || col >= grid.width || row < 0 || row >= grid.height) continue
    const to = row * grid.width + col
    if (grid.valid[to] === 0) continue
    const dz = grid.cutterLocationZ[to] - fromZ
    const xy = grid.cellSize * Math.hypot(dx, dy)
    const candidate = distance[from] + Math.hypot(xy, dz)
    if (candidate + 1e-12 >= distance[to]) continue
    distance[to] = candidate
    heap.addOrDecrease(to)
  }
}

export function buildGeodesicDistanceField(grid: ConstantScallopGrid): ConstantDistanceField | null {
  const cellCount = grid.width * grid.height
  if (grid.valid.length !== cellCount || grid.cutterLocationZ.length !== cellCount) return null
  const distance = new Float64Array(cellCount)
  distance.fill(Infinity)
  const heap = new DistanceHeap(distance)
  if (seedBoundary(grid, distance, heap) === 0) return null
  while (!heap.empty) {
    relaxFrom(grid, distance, heap, heap.pop())
  }
  return { ...grid, distance }
}

function interpolatePoint(
  a: Point,
  b: Point,
  aValue: number,
  bValue: number,
  level: number,
): Point {
  const range = bValue - aValue
  const t = Math.abs(range) <= 1e-12 ? 0.5 : Math.max(0, Math.min(1, (level - aValue) / range))
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

function edgePoint(points: readonly Point[], values: readonly number[], edge: number, level: number): Point {
  switch (edge) {
    case 0: return interpolatePoint(points[0], points[1], values[0], values[1], level)
    case 1: return interpolatePoint(points[1], points[2], values[1], values[2], level)
    case 2: return interpolatePoint(points[2], points[3], values[2], values[3], level)
    case 3: return interpolatePoint(points[3], points[0], values[3], values[0], level)
    default: throw new Error(`invalid marching-squares edge ${edge}`)
  }
}

function edgePairs(mask: number, centreHigh: boolean): ReadonlyArray<readonly [number, number]> {
  switch (mask) {
    case 1: return [[3, 0]]
    case 2: return [[0, 1]]
    case 3: return [[3, 1]]
    case 4: return [[1, 2]]
    case 5: return centreHigh ? [[0, 1], [2, 3]] : [[3, 0], [1, 2]]
    case 6: return [[0, 2]]
    case 7: return [[3, 2]]
    case 8: return [[2, 3]]
    case 9: return [[0, 2]]
    case 10: return centreHigh ? [[3, 0], [1, 2]] : [[0, 1], [2, 3]]
    case 11: return [[1, 2]]
    case 12: return [[1, 3]]
    case 13: return [[0, 1]]
    case 14: return [[3, 0]]
    default: return []
  }
}

function appendCellSegments(
  byLevel: Map<number, Segment[]>,
  field: ConstantDistanceField,
  col: number,
  row: number,
  spacing: number,
): void {
  const topLeft = row * field.width + col
  const indices = [topLeft, topLeft + 1, topLeft + field.width + 1, topLeft + field.width]
  if (indices.some((at) => field.valid[at] === 0 || !Number.isFinite(field.distance[at]))) return
  const values = indices.map((at) => field.distance[at])
  const minimum = Math.min(...values)
  const maximum = Math.max(...values)
  const firstLevel = Math.max(1, Math.ceil(minimum / spacing))
  const lastLevel = Math.floor(maximum / spacing)
  if (lastLevel < firstLevel) return
  const x = field.originX + (col + 0.5) * field.cellSize
  const y = field.originY + (row + 0.5) * field.cellSize
  const points = [
    { x, y },
    { x: x + field.cellSize, y },
    { x: x + field.cellSize, y: y + field.cellSize },
    { x, y: y + field.cellSize },
  ]
  for (let levelIndex = firstLevel; levelIndex <= lastLevel; levelIndex += 1) {
    const level = levelIndex * spacing
    let mask = 0
    for (let corner = 0; corner < 4; corner += 1) {
      if (values[corner] >= level) mask |= 1 << corner
    }
    const centreHigh = (values[0] + values[1] + values[2] + values[3]) / 4 >= level
    const segments = byLevel.get(levelIndex) ?? []
    for (const [aEdge, bEdge] of edgePairs(mask, centreHigh)) {
      segments.push({
        a: edgePoint(points, values, aEdge, level),
        b: edgePoint(points, values, bEdge, level),
      })
    }
    if (segments.length > 0) byLevel.set(levelIndex, segments)
  }
}

function pointKey(point: Point, tolerance: number): string {
  return `${Math.round(point.x / tolerance)}:${Math.round(point.y / tolerance)}`
}

function buildAdjacency(segments: Segment[], tolerance: number): Map<string, number[]> {
  const adjacency = new Map<string, number[]>()
  const append = (point: Point, segmentIndex: number): void => {
    const key = pointKey(point, tolerance)
    const entries = adjacency.get(key) ?? []
    entries.push(segmentIndex)
    adjacency.set(key, entries)
  }
  segments.forEach((segment, index) => {
    append(segment.a, index)
    append(segment.b, index)
  })
  return adjacency
}

function walkSegments(
  segments: Segment[],
  adjacency: Map<string, number[]>,
  used: Uint8Array,
  startSegment: number,
  startAtB: boolean,
  tolerance: number,
): { points: Point[]; closed: boolean } {
  const first = startAtB ? segments[startSegment].b : segments[startSegment].a
  let next = startAtB ? segments[startSegment].a : segments[startSegment].b
  const points = [first, next]
  used[startSegment] = 1
  while (true) {
    const candidates = adjacency.get(pointKey(next, tolerance)) ?? []
    const segmentIndex = candidates.find((candidate) => used[candidate] === 0)
    if (segmentIndex === undefined) break
    used[segmentIndex] = 1
    const segment = segments[segmentIndex]
    next = pointKey(segment.a, tolerance) === pointKey(next, tolerance) ? segment.b : segment.a
    if (pointKey(next, tolerance) === pointKey(first, tolerance)) {
      return { points, closed: true }
    }
    points.push(next)
  }
  return { points, closed: false }
}

function joinSegments(segments: Segment[], tolerance: number): Array<{ points: Point[]; closed: boolean }> {
  const adjacency = buildAdjacency(segments, tolerance)
  const used = new Uint8Array(segments.length)
  const contours: Array<{ points: Point[]; closed: boolean }> = []
  for (let pass = 0; pass < 2; pass += 1) {
    for (let index = 0; index < segments.length; index += 1) {
      if (used[index] !== 0) continue
      const aDegree = adjacency.get(pointKey(segments[index].a, tolerance))?.length ?? 0
      const bDegree = adjacency.get(pointKey(segments[index].b, tolerance))?.length ?? 0
      const isOpenStart = aDegree === 1 || bDegree === 1
      if ((pass === 0) !== isOpenStart) continue
      const contour = walkSegments(segments, adjacency, used, index, bDegree === 1, tolerance)
      if (contour.points.length >= (contour.closed ? 3 : 2)) contours.push(contour)
    }
  }
  return contours
}

function contourSortKey(contour: ConstantDistanceContour): readonly number[] {
  let minX = Infinity
  let minY = Infinity
  for (const point of contour.points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
  }
  return [contour.level, minY, minX, contour.closed ? 0 : 1]
}

function compareContours(left: ConstantDistanceContour, right: ConstantDistanceContour): number {
  const leftKey = contourSortKey(left)
  const rightKey = contourSortKey(right)
  for (let index = 0; index < leftKey.length; index += 1) {
    const difference = leftKey[index] - rightKey[index]
    if (difference !== 0) return difference
  }
  return left.points.length - right.points.length
}

export function extractConstantDistanceContours(
  field: ConstantDistanceField,
  spacing: number,
): ConstantDistanceContour[] {
  if (!(spacing > 0) || !Number.isFinite(spacing)) return []
  const byLevel = new Map<number, Segment[]>()
  for (let row = 0; row + 1 < field.height; row += 1) {
    for (let col = 0; col + 1 < field.width; col += 1) {
      appendCellSegments(byLevel, field, col, row, spacing)
    }
  }
  const contours: ConstantDistanceContour[] = []
  const tolerance = Math.max(field.cellSize * 1e-7, 1e-9)
  for (const [levelIndex, segments] of [...byLevel.entries()].sort((a, b) => a[0] - b[0])) {
    for (const contour of joinSegments(segments, tolerance)) {
      contours.push({ level: levelIndex * spacing, ...contour })
    }
  }
  return contours.sort(compareContours)
}
