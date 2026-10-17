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
 * The simulation viewport's DEV-only, on-demand square-material observer
 * (issue #1016 C2).
 *
 * The shipped `data-simulation-square` / `data-simulation-removed-cells` /
 * `data-simulation-min-z` attributes come from the static result props. They
 * can prove what the app *asked* to draw, never what is mounted: they say
 * nothing about playback's starting stock, its actual geometry, reset/back-seek,
 * replacement or disposal.
 *
 * This module is the missing evidence surface. It reads the viewport's own
 * `squareStaticRef` / `squarePlaybackRef` resources and the live
 * `PlaybackController` — never a reconstructed expected result — and offers:
 *
 *   - `snapshot()`: identity/key/mode/bounds/stats/disposed/mounted of the
 *     active resource plus the bounded lifecycle log. Cheap, never hashes.
 *   - `witness()`: an on-demand, targeted geometry witness. It picks a cell
 *     whose authoritative material is two disconnected radial pieces (or the
 *     caller's cell), casts the real cell-centre ray through the actual mounted
 *     triangles, and reports the intervals that ray really crosses, beside the
 *     grid's authoritative intervals and the virgin blank. The full-geometry
 *     digest is computed only when this is called, never per frame.
 *
 * Nothing here is imported in production: `SimulationViewport` and `main.tsx`
 * reach it through `import.meta.env.DEV`-guarded dynamic imports, so the whole
 * module is dead-code-eliminable from the shipped bundle. It is a read-only
 * observer — no simulation state is written through it.
 */

import type * as THREE from 'three'
import type { SimulationGrid } from '../../engine/simulation'
import type { PlaybackController } from '../../engine/simulation/playback'
import { squareMaterialIntervals } from '../../engine/simulation/squareMaterial'
import type { SquarePreviewSurface } from './squarePreview'

export type SimulationObserverMode = 'static' | 'playback'

export interface SquareResourceBounds {
  min: [number, number, number]
  max: [number, number, number]
}

export interface SquareMeshStats {
  chunkCount: number
  triangleCount: number
  geometriesCreated: number
  geometryDisposals: number
  materialDisposals: number
}

export interface SquareGridSummary {
  axis: 'x' | 'y'
  side: number
  cols: number
  rows: number
  cellSize: number
  originX: number
  originY: number
  stockBottomZ: number
  stockTopZ: number
  /** Cells whose material was touched (the interval map's own size). */
  materialCells: number
  /** True when the grid is the immutable virgin baseline (no cut cells). */
  virgin: boolean
}

export interface SquareResourceSummary {
  /** Stable across one mount, assigned when the resource was created. */
  id: number
  mode: SimulationObserverMode
  /** `squarePreviewKey`: frame, shape/side, exact stock ends and grid topology. */
  key: string
  /** Three object identity. */
  uuid: string
  /** Actually attached to the scene (false once disposed). */
  mounted: boolean
  disposed: boolean
  /** Triangle count read from the mounted geometry buffers, not from a result. */
  triangles: number
  stats: SquareMeshStats
  bounds: SquareResourceBounds | null
  grid: SquareGridSummary | null
  createdAtProgress: number
  retiredAtProgress: number | null
}

export interface ObserverLifecycleEvent {
  sequence: number
  kind: 'create' | 'dispose' | 'teardown'
  mode: SimulationObserverMode | null
  id: number | null
  key: string | null
  progress: number
  disposed: boolean
}

export interface SimulationControllerSummary {
  distance: number
  total: number
  fraction: number
  moveIndex: number
  moveCount: number
  finished: boolean
  baseMaterialCells: number
  liveMaterialCells: number
  baseGrid: SquareGridSummary | null
  liveGrid: SquareGridSummary | null
}

export interface SimulationObserverSnapshot {
  registered: boolean
  view: 'flat' | 'bar' | null
  square: boolean
  playbackEnabled: boolean
  playbackReady: boolean
  playing: boolean
  progress: number
  controller: SimulationControllerSummary | null
  active: SquareResourceSummary | null
  mounted: { static: SquareResourceSummary | null; playback: SquareResourceSummary | null }
  retired: SquareResourceSummary[]
  lifecycle: ObserverLifecycleEvent[]
  teardown: boolean
}

export interface MaterialInterval {
  lo: number
  hi: number
}

export interface SquareCellWitness {
  index: number
  col: number
  row: number
  /** Cell-centre along coordinate (project X for an x bar). */
  along: number
  /** Cell-centre angle on the nominal sheet, radians. */
  theta: number
  /** Virgin blank surface at that ray. */
  blankRadius: number
}

export interface SimulationGeometryWitness {
  mode: SimulationObserverMode
  resource: SquareResourceSummary
  controller: SimulationControllerSummary | null
  grid: SquareGridSummary
  cell: SquareCellWitness
  actual: {
    intervals: MaterialInterval[]
    /** Ray/triangle intersections actually crossed. */
    hits: number
    /** Triangles tested by the ray. */
    triangles: number
    /** Air gaps between two material pieces. */
    gaps: number
    /** Widest surviving radial air gap. */
    gapWidth: number
  }
  authoritative: { intervals: MaterialInterval[] }
  virgin: { intervals: MaterialInterval[] }
  /** The actual and authoritative intervals agree within `tolerance`. */
  matches: boolean
  tolerance: number
  /** FNV-1a over every mounted position buffer; null when not requested. */
  digest: string | null
}

export interface SimulationWitnessRequest {
  /** Cell index in the active grid. Omitted -> the widest real radial gap. */
  index?: number
  /** Full position digest (default true; this call is the only hashing path). */
  digest?: boolean
}

export interface SimulationObserverRuntime {
  view: 'flat' | 'bar'
  square: boolean
  playbackEnabled: boolean
  playbackReady: boolean
  playing: boolean
  progress: number
  isActive: boolean
}

export interface SimulationObserverLifecycle {
  nextId: number
  nextSequence: number
  ids: WeakMap<SquarePreviewSurface, number>
  createdProgress: WeakMap<SquarePreviewSurface, number>
  retired: SquareResourceSummary[]
  events: ObserverLifecycleEvent[]
  teardown: boolean
}

export interface SimulationObserverAccess {
  readStatic(): { surface: SquarePreviewSurface; grid: SimulationGrid | null } | null
  readPlayback(): { surface: SquarePreviewSurface; grid: SimulationGrid | null } | null
  readController(): PlaybackController | null
  readRuntime(): SimulationObserverRuntime
  readLifecycle(): SimulationObserverLifecycle
}

export interface SimulationObserverProvider {
  snapshot(): SimulationObserverSnapshot
  witness(request: SimulationWitnessRequest): SimulationGeometryWitness | null
  finalSnapshot(): SimulationObserverSnapshot
}

let currentProvider: SimulationObserverProvider | null = null
let lastSnapshot: SimulationObserverSnapshot | null = null

export function registerSimulationObserver(provider: SimulationObserverProvider): void {
  currentProvider = provider
}

/**
 * Drop the provider and keep only its final serializable snapshot, so no
 * surface, grid or controller reference outlives the viewport. The expected
 * provider guard keeps a late teardown from removing a newer mount's observer.
 */
export function unregisterSimulationObserver(expected?: SimulationObserverProvider): void {
  if (!currentProvider || (expected && currentProvider !== expected)) return
  lastSnapshot = currentProvider.finalSnapshot()
  currentProvider = null
}

export function readSimulationObserverSnapshot(): SimulationObserverSnapshot {
  if (currentProvider) {
    lastSnapshot = currentProvider.snapshot()
    return lastSnapshot
  }
  return lastSnapshot ?? emptySnapshot()
}

export function readSimulationObserverWitness(
  request: SimulationWitnessRequest = {},
): SimulationGeometryWitness | null {
  return currentProvider ? currentProvider.witness(request) : null
}

function emptySnapshot(): SimulationObserverSnapshot {
  return {
    registered: false,
    view: null,
    square: false,
    playbackEnabled: false,
    playbackReady: false,
    playing: false,
    progress: 0,
    controller: null,
    active: null,
    mounted: { static: null, playback: null },
    retired: [],
    lifecycle: [],
    teardown: false,
  }
}

export function createSimulationObserverProvider(access: SimulationObserverAccess): SimulationObserverProvider {
  const snapshot = (): SimulationObserverSnapshot => {
    const runtime = access.readRuntime()
    const lifecycle = access.readLifecycle()
    const playback = access.readPlayback()
    const statics = access.readStatic()
    const controller = access.readController()

    const playbackSummary = playback
      ? summarizeResource(playback.surface, 'playback', playback.grid, lifecycle)
      : null
    const staticSummary = statics
      ? summarizeResource(statics.surface, 'static', statics.grid, lifecycle)
      : null
    const active = runtime.playbackEnabled
      ? playbackSummary ?? staticSummary
      : staticSummary ?? playbackSummary

    return {
      registered: true,
      view: runtime.view,
      square: runtime.square,
      playbackEnabled: runtime.playbackEnabled,
      playbackReady: runtime.playbackReady,
      playing: runtime.playing,
      progress: runtime.progress,
      controller: controller ? summarizeController(controller) : null,
      active,
      mounted: { static: staticSummary, playback: playbackSummary },
      retired: lifecycle.retired.slice(-12),
      lifecycle: lifecycle.events.slice(-24),
      teardown: lifecycle.teardown,
    }
  }

  const witness = (request: SimulationWitnessRequest): SimulationGeometryWitness | null => {
    const runtime = access.readRuntime()
    const lifecycle = access.readLifecycle()
    const playback = access.readPlayback()
    const statics = access.readStatic()
    const controller = access.readController()
    const entry = runtime.playbackEnabled && playback ? playback : statics ?? playback
    if (!entry || !entry.surface.resource.bounds) return null
    // The authoritative grid must be the one that produced this surface. While
    // playback is enabled the controller's live grid is the evolving state; a
    // static surface never borrows it.
    const sourceGrid = runtime.playbackEnabled && controller && entry === playback
      ? controller.liveGrid
      : entry.grid
    if (!sourceGrid || !sourceGrid.squareBar) return null
    const cellCount = sourceGrid.cols * sourceGrid.rows
    if (cellCount <= 0) return null

    const index = clampIndex(
      request.index ?? findWidestGapCell(sourceGrid) ?? findMaterialCell(sourceGrid) ?? 0,
      cellCount,
    )
    const cell = describeCell(sourceGrid, index)
    const gridSummary = summarizeGrid(sourceGrid)
    if (!gridSummary) return null
    const tolerance = Math.max(1e-4, sourceGrid.squareBar.side * 1e-4)
    const actual = rayIntervals(entry.surface, sourceGrid, cell, tolerance)
    const authoritative = pairsOf(squareMaterialIntervals(sourceGrid, index))
    const virgin = pairsOf([
      sourceGrid.stockBottomZ,
      sourceGrid.initialTopZ?.[index] ?? sourceGrid.stockTopZ,
    ])
    const mode: SimulationObserverMode = entry === playback && runtime.playbackEnabled ? 'playback' : 'static'

    return {
      mode,
      resource: summarizeResource(
        entry.surface,
        mode,
        sourceGrid,
        lifecycle,
      ),
      controller: controller ? summarizeController(controller) : null,
      grid: gridSummary,
      cell,
      actual: {
        intervals: actual.intervals,
        hits: actual.hits,
        triangles: actual.triangles,
        gaps: Math.max(0, actual.intervals.length - 1),
        gapWidth: widestGap(actual.intervals),
      },
      authoritative: { intervals: authoritative },
      virgin: { intervals: virgin },
      matches: intervalsAgree(actual.intervals, authoritative, tolerance),
      tolerance,
      digest: request.digest === false ? null : geometryDigest(entry.surface),
    }
  }

  const finalSnapshot = (): SimulationObserverSnapshot => {
    const result = snapshot()
    const lifecycle = access.readLifecycle()
    return {
      ...result,
      registered: false,
      active: null,
      mounted: { static: null, playback: null },
      controller: null,
      teardown: true,
      retired: lifecycle.retired.slice(-12),
      lifecycle: lifecycle.events.slice(-24),
    }
  }

  return { snapshot, witness, finalSnapshot }
}

function summarizeResource(
  surface: SquarePreviewSurface,
  mode: SimulationObserverMode,
  grid: SimulationGrid | null,
  lifecycle: SimulationObserverLifecycle,
): SquareResourceSummary {
  let id = lifecycle.ids.get(surface)
  if (id === undefined) {
    lifecycle.nextId += 1
    id = lifecycle.nextId
    lifecycle.ids.set(surface, id)
  }
  return {
    id,
    mode,
    key: surface.key,
    uuid: surface.object.uuid,
    mounted: surface.object.parent !== null,
    disposed: surface.disposed || surface.resource.disposed,
    triangles: countTriangles(surface),
    stats: { ...surface.resource.stats },
    bounds: boundsOf(surface.resource.bounds),
    grid: grid ? summarizeGrid(grid) : null,
    createdAtProgress: lifecycle.createdProgress.get(surface) ?? 0,
    retiredAtProgress: null,
  }
}

function summarizeGrid(grid: SimulationGrid): SquareGridSummary | null {
  if (!grid.squareBar) return null
  return {
    axis: grid.squareBar.frame.axis,
    side: grid.squareBar.side,
    cols: grid.cols,
    rows: grid.rows,
    cellSize: grid.cellSize,
    originX: grid.originX,
    originY: grid.originY,
    stockBottomZ: grid.stockBottomZ,
    stockTopZ: grid.stockTopZ,
    materialCells: grid.squareMaterial?.size ?? 0,
    virgin: (grid.squareMaterial?.size ?? 0) === 0,
  }
}

function summarizeController(controller: PlaybackController): SimulationControllerSummary {
  const total = controller.totalPathLength
  return {
    distance: controller.getDistanceTraveled(),
    total,
    fraction: total > 0 ? controller.getDistanceTraveled() / total : 0,
    moveIndex: controller.getMoveIndex(),
    moveCount: controller.getMoveCount(),
    finished: controller.isFinished(),
    baseMaterialCells: controller.baseGrid.squareMaterial?.size ?? 0,
    liveMaterialCells: controller.liveGrid.squareMaterial?.size ?? 0,
    baseGrid: summarizeGrid(controller.baseGrid),
    liveGrid: summarizeGrid(controller.liveGrid),
  }
}

function countTriangles(surface: SquarePreviewSurface): number {
  let count = 0
  surface.object.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const index = mesh.geometry.getIndex()
    const position = mesh.geometry.getAttribute('position')
    if (index) count += Math.floor(index.count / 3)
    else if (position) count += Math.floor(position.count / 3)
  })
  return count
}

function boundsOf(bounds: THREE.Box3): SquareResourceBounds | null {
  if (!bounds || bounds.isEmpty()) return null
  return {
    min: [bounds.min.x, bounds.min.y, bounds.min.z],
    max: [bounds.max.x, bounds.max.y, bounds.max.z],
  }
}

function describeCell(grid: SimulationGrid, index: number): SquareCellWitness {
  const bar = grid.squareBar
  if (!bar) throw new RangeError('square observer: the grid has no square descriptor')
  const xAxis = bar.frame.axis === 'x'
  const row = Math.floor(index / grid.cols)
  const col = index % grid.cols
  const along = xAxis
    ? grid.originX + (col + 0.5) * grid.cellSize
    : grid.originY + (row + 0.5) * grid.cellSize
  const across = xAxis
    ? grid.originY + (row + 0.5) * grid.cellSize
    : grid.originX + (col + 0.5) * grid.cellSize
  const theta = (across - bar.frame.zero) / bar.frame.radius
  const blankRadius = grid.initialTopZ?.[index] ?? grid.stockTopZ
  return { index, col, row, along, theta, blankRadius }
}

function clampIndex(index: number, cellCount: number): number {
  if (!Number.isFinite(index)) return 0
  return Math.max(0, Math.min(cellCount - 1, Math.floor(index)))
}

/** The cell with the widest real air gap between two surviving pieces. */
function findWidestGapCell(grid: SimulationGrid): number | null {
  const material = grid.squareMaterial
  if (!material || material.size === 0) return null
  let best = -1
  let bestWidth = 0
  for (const index of material.keys()) {
    const width = widestGap(pairsOf(squareMaterialIntervals(grid, index)))
    if (width > bestWidth) {
      bestWidth = width
      best = index
    }
  }
  return best >= 0 ? best : null
}

/** Any cell with an authored material interval, for a grid with no real gap. */
function findMaterialCell(grid: SimulationGrid): number | null {
  const material = grid.squareMaterial
  if (!material || material.size === 0) return null
  for (const index of material.keys()) return index
  return null
}

function widestGap(intervals: MaterialInterval[]): number {
  let width = 0
  for (let i = 0; i + 1 < intervals.length; i += 1) {
    width = Math.max(width, intervals[i + 1].lo - intervals[i].hi)
  }
  return width
}

function pairsOf(flat: readonly number[]): MaterialInterval[] {
  const pairs: MaterialInterval[] = []
  for (let i = 0; i + 1 < flat.length; i += 2) {
    if (flat[i + 1] > flat[i]) pairs.push({ lo: flat[i], hi: flat[i + 1] })
  }
  return pairs
}

function intervalsAgree(actual: MaterialInterval[], authoritative: MaterialInterval[], tolerance: number): boolean {
  if (actual.length !== authoritative.length) return false
  for (let i = 0; i < actual.length; i += 1) {
    if (Math.abs(actual[i].lo - authoritative[i].lo) > tolerance) return false
    if (Math.abs(actual[i].hi - authoritative[i].hi) > tolerance) return false
  }
  return true
}

/**
 * The actual material intervals on one cell-centre radial ray, obtained by
 * intersecting that ray with the mounted triangles. The ray starts on the
 * pivot (inside the blank) and travels outward; intersections alternate
 * exit/enter, so the first material interval starts at zero.
 */
function rayIntervals(
  surface: SquarePreviewSurface,
  grid: SimulationGrid,
  cell: SquareCellWitness,
  tolerance: number,
): { intervals: MaterialInterval[]; hits: number; triangles: number } {
  const bar = grid.squareBar
  if (!bar) return { intervals: [], hits: 0, triangles: 0 }
  const frame = bar.frame
  const cos = Math.cos(cell.theta)
  const sin = Math.sin(cell.theta)
  // Stock space -> the viewport's (project X, project Z, project Y) axes.
  const origin = frame.axis === 'x'
    ? { x: cell.along, y: frame.radius, z: frame.centre }
    : { x: frame.centre, y: frame.radius, z: cell.along }
  const direction = frame.axis === 'x'
    ? { x: 0, y: cos, z: sin }
    : { x: sin, y: cos, z: 0 }

  const hitValues: number[] = []
  let triangles = 0
  surface.object.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const position = mesh.geometry.getAttribute('position')
    if (!position) return
    const index = mesh.geometry.getIndex()
    const vertexCount = index ? index.count : position.count
    for (let i = 0; i + 2 < vertexCount; i += 3) {
      const ia = index ? index.getX(i) : i
      const ib = index ? index.getX(i + 1) : i + 1
      const ic = index ? index.getX(i + 2) : i + 2
      triangles += 1
      const distance = rayTriangle(
        origin, direction,
        position.getX(ia), position.getY(ia), position.getZ(ia),
        position.getX(ib), position.getY(ib), position.getZ(ib),
        position.getX(ic), position.getY(ic), position.getZ(ic),
      )
      if (distance !== null) hitValues.push(distance)
    }
  })

  hitValues.sort((a, b) => a - b)
  const uniqueHits: number[] = []
  for (const value of hitValues) {
    if (uniqueHits.length === 0 || value - uniqueHits[uniqueHits.length - 1] > tolerance) {
      uniqueHits.push(value)
    }
  }

  // A degenerate face sitting on the pivot is not an exit from material.
  let first = 0
  while (first < uniqueHits.length && uniqueHits[first] <= tolerance) first += 1
  const usableHits = uniqueHits.slice(first)
  const intervals: MaterialInterval[] = []
  if (usableHits.length > 0) {
    intervals.push({ lo: 0, hi: usableHits[0] })
  }
  for (let i = 1; i + 1 < usableHits.length; i += 2) {
    if (usableHits[i + 1] - usableHits[i] > tolerance) {
      intervals.push({ lo: usableHits[i], hi: usableHits[i + 1] })
    }
  }
  return { intervals, hits: usableHits.length, triangles }
}

/** Moller-Trumbore, double-sided; `null` when the ray misses or crosses behind. */
function rayTriangle(
  origin: { x: number; y: number; z: number },
  direction: { x: number; y: number; z: number },
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  cx: number, cy: number, cz: number,
): number | null {
  const e1x = bx - ax
  const e1y = by - ay
  const e1z = bz - az
  const e2x = cx - ax
  const e2y = cy - ay
  const e2z = cz - az
  const hx = direction.y * e2z - direction.z * e2y
  const hy = direction.z * e2x - direction.x * e2z
  const hz = direction.x * e2y - direction.y * e2x
  const determinant = e1x * hx + e1y * hy + e1z * hz
  if (Math.abs(determinant) < 1e-12) return null
  const inverse = 1 / determinant
  const sx = origin.x - ax
  const sy = origin.y - ay
  const sz = origin.z - az
  const u = (sx * hx + sy * hy + sz * hz) * inverse
  if (u < -1e-9 || u > 1 + 1e-9) return null
  const qx = sy * e1z - sz * e1y
  const qy = sz * e1x - sx * e1z
  const qz = sx * e1y - sy * e1x
  const v = (direction.x * qx + direction.y * qy + direction.z * qz) * inverse
  if (v < -1e-9 || u + v > 1 + 1e-9) return null
  const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse
  return distance > 1e-7 ? distance : null
}

/** FNV-1a over the rounded mounted position buffers, on demand only. */
function geometryDigest(surface: SquarePreviewSurface): string {
  let hash = 0x811c9dc5
  const mix = (word: number): void => {
    hash ^= word
    hash = Math.imul(hash, 0x01000193)
  }
  let chunks = 0
  surface.object.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const position = mesh.geometry.getAttribute('position')
    if (!position) return
    chunks += 1
    const values = position.array as ArrayLike<number>
    if (values instanceof Float32Array) {
      const words = new Uint32Array(values.buffer, values.byteOffset, values.length)
      for (let i = 0; i < words.length; i += 1) mix(words[i])
      return
    }
    const single = new Float32Array(1)
    const singleWord = new Uint32Array(single.buffer)
    for (let i = 0; i < values.length; i += 1) {
      single[0] = values[i]
      mix(singleWord[0])
    }
  })
  mix(chunks)
  return (hash >>> 0).toString(16).padStart(8, '0')
}
