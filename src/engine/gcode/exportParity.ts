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
 * Does the exported program cut what the internal toolpath says? (issue #1261,
 * slice 1 of #1267.)
 *
 * `compareExportedToInternal` compares the feed moves of the two paths — every
 * non-rapid move; rapids and the moves between operations are out of scope —
 * in the **stock frame**: a rotary point is unturned by its angle about the
 * bar's axis (`stockSpacePoint`), so a turning move is the curve it really cuts
 * on the stock. The geometry check runs both ways:
 *
 * - every exported cut, sampled along its length, must lie within the
 *   tolerance of some internal cut (else `extraCut`), and
 * - every internal cut, sampled the same way, must lie within the tolerance of
 *   some exported cut (else `missingCut`).
 *
 * The distance is point-to-segment, so how either side is segmented — arc
 * fitting, the flattening of an exported arc, merged or split moves — is not a
 * deviation. An internal move's own `arcChordError` (a curve span sampled by
 * its generator) widens the tolerance for that move only, exactly as the arc
 * fitter allows it. A spatial grid keeps the search local.
 *
 * The feed check compares each exported feed move with the feed of the internal
 * cut it lies on: the plunge feed for a plunge, the operation's feed times the
 * move's `feedScale` otherwise. An inverse-time F (a turning move, #393) is
 * compared as the feed divided by the move's stock-frame length.
 *
 * The public types of this file are the contract slices 2 and 3 consume. Keep
 * them stable; add, never rename.
 */

import { isBarStock } from '../../types/barStock'
import type { BarStock, Operation, Project, Stock } from '../../types/project'
import { exportGeometryTolerance } from '../../utils/units'
import { stockSpacePoint } from '../rotaryFrame'
import { findOperationTool } from '../../toolPolicy'
import { normalizeToolForProject } from '../toolpaths/geometry'
import type { NormalizedTool, ToolpathMove, ToolpathPoint, ToolpathResult } from '../toolpaths/types'
import { exportOperationMotion } from './exportedMotion'
import type { ExportedMotionStatus, ExportedOperationMotion, ExportedToolpathMove } from './exportedMotion'
import type { MachineDefinition } from './types'

// ── Public contract ───────────────────────────────────────────

/** `verified`: within tolerance both ways and at the right feed. */
export type ExportParityVerdict = 'verified' | 'deviation' | 'unverified'

/**
 * - `missingCut`: an internal cut the exported program does not make.
 * - `extraCut`: an exported cut the internal toolpath does not have.
 * - `feed`: an exported cut on the internal path, at another feed.
 */
export type ExportDeviationKind = 'missingCut' | 'extraCut' | 'feed'

/** Why a comparison could not reach a verdict. Stable; translated in the UI. */
export type ExportParityUnverifiedReason =
  /** The exported program has a construct the reader cannot reconstruct. */
  | 'exportUnsupported'
  /** The program could not be produced or read (postprocessor refusal, no tool, …). */
  | 'exportFailed'
  /** Neither path has a feed move: there is nothing to compare. */
  | 'noCutMoves'

export interface ExportDeviation {
  kind: ExportDeviationKind
  /** Where, in the stock frame (project units). */
  location: { x: number; y: number; z: number }
  /**
   * For `missingCut`/`extraCut`, the distance to the nearest cut of the other
   * path (project units) — the worst measured over the run of samples this
   * deviation stands for; `Infinity` when the other path has no cut at all.
   * For `feed`, the feed difference (units per minute, or 1/min for an
   * inverse-time feed); `Infinity` when the exported move states no feed.
   */
  distance: number
  operationId: string
  /** For `feed`: what the internal toolpath asks for, and what the program runs. */
  expectedFeed?: number
  actualFeed?: number
  /** For `feed`: true when both are inverse-time words (1/min). */
  inverseTime?: boolean
}

export interface ExportParityResult {
  operationId: string
  verdict: ExportParityVerdict
  /** Present when `verdict` is `unverified`. */
  reason?: ExportParityUnverifiedReason
  /**
   * The deviations found, at most `maxDeviations` of them; one entry per run of
   * consecutive failing samples along one move. Computed even when the verdict
   * is `unverified`, as information.
   */
  deviations: ExportDeviation[]
  /** How many deviations there were in all (≥ `deviations.length`). */
  deviationCount: number
  /** The worst geometric distance measured (0 when every sample is in tolerance). */
  maxDistance: number
  /** How many sample points each side contributed. */
  samples: { internal: number; exported: number }
}

export interface ExportParityOptions {
  operationId: string
  /** How far a cut may sit from the other path, in project units. */
  tolerance: number
  /** Spacing of the sample points along a move; default 25 × `tolerance`. */
  sampleStep?: number
  /** The project's stock: a bar unturns rotary points about its axis. */
  stock?: Stock | null
  /** The operation's feeds; omit or null to skip the feed check. */
  feeds?: { cut: number; plunge: number } | null
  /** Relative feed tolerance; default 0.005. */
  feedTolerance?: number
  /** Absolute feed tolerance: half the last written digit; default 0. */
  feedQuantum?: number
  /**
   * Half the last written digit of a coordinate or angle; default 0. An
   * inverse-time F was computed from the unrounded move, so a short turning
   * move's rounded length may differ by this much at each end.
   */
  coordinateQuantum?: number
  /** The exported read-back's status; anything but `verified` is `unverified`. */
  exportStatus?: ExportedMotionStatus
  /** How many deviations to list; default 20. */
  maxDeviations?: number
  /**
   * Leave plunges out of both sides. A plasma torch's Z is a height above the
   * sheet, not a depth: the program pierces on its own sequence (probe,
   * pierce height, cut height) where the toolpath has one plunge, and the cut
   * is the motion at cut height.
   */
  excludePlunges?: boolean
}

/**
 * A move either side of the comparison: a `ToolpathMove`, with the feed it ran
 * at when it is an exported one (`ExportedToolpathMove` is one).
 */
export type ExportParityMove = ToolpathMove & Partial<Pick<ExportedToolpathMove, 'feed' | 'inverseTimeFeed'>>

/** The tolerance `verifyExportedOperation` uses: twice the export tolerance. */
export function exportParityTolerance(units: Project['meta']['units']): number {
  // The arc fitter's residual (1×), the read-back's arc flattening (½×) and
  // the program's number rounding fit inside 2× the export tolerance.
  return exportGeometryTolerance(units) * 2
}

// ── Stock-frame pieces ────────────────────────────────────────


interface Vec { x: number; y: number; z: number }

interface Piece {
  from: Vec
  to: Vec
  /** Index of the move the piece belongs to. */
  move: number
}

interface PathModel {
  moves: ExportParityMove[]
  pieces: Piece[]
  /** Per move: the extra tolerance its own chord error earns. */
  allowance: number[]
  /** Per move: its stock-frame length. */
  length: number[]
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/** A tool-space point on a move, the way the controller interpolates it. */
function along(move: ToolpathMove, t: number): ToolpathPoint {
  const point: ToolpathPoint = {
    x: lerp(move.from.x, move.to.x, t),
    y: lerp(move.from.y, move.to.y, t),
    z: lerp(move.from.z, move.to.z, t),
  }
  if (move.from.a !== undefined || move.to.a !== undefined) {
    point.a = lerp(move.from.a ?? move.to.a ?? 0, move.to.a ?? move.from.a ?? 0, t)
  }
  return point
}

/** The stock-frame polyline of one move, its chord error at most `chord`. */
function stockFramePoints(move: ToolpathMove, bar: BarStock | null, chord: number): Vec[] {
  const turn = bar !== null && move.from.a !== undefined && move.to.a !== undefined
    ? Math.abs(move.to.a - move.from.a) * Math.PI / 180
    : 0
  const map = (point: ToolpathPoint): Vec => (bar !== null ? stockSpacePoint(point, bar) : { x: point.x, y: point.y, z: point.z })
  if (turn < 1e-12) return [map(move.from), map(move.to)]
  // The turning plane's radius: the larger end's distance from the pivot,
  // measured by unturning a point at the same height by a quarter turn.
  const radius = Math.max(axisDistance(move.from, bar!), axisDistance(move.to, bar!), chord)
  const step = 2 * Math.acos(Math.max(-1, 1 - chord / radius))
  const count = Math.min(4096, Math.max(1, Math.ceil(turn / step)))
  const points: Vec[] = []
  for (let i = 0; i <= count; i += 1) points.push(map(along(move, i / count)))
  return points
}

/** The distance of a tool-space point from the bar's turning axis. */
function axisDistance(point: ToolpathPoint, bar: BarStock): number {
  // Unturned at 0, a point is its own stock point; the axis is where turning
  // it moves it nowhere, so compare it with its half-turn image.
  const here = stockSpacePoint({ ...point, a: 0 }, bar)
  const opposite = stockSpacePoint({ ...point, a: 180 }, bar)
  return Math.hypot(here.x - opposite.x, here.y - opposite.y, here.z - opposite.z) / 2
}

function buildModel(moves: readonly ExportParityMove[], bar: BarStock | null, chord: number, excludePlunges: boolean): PathModel {
  const model: PathModel = { moves: [], pieces: [], allowance: [], length: [] }
  for (const move of moves) {
    if (move.kind === 'rapid') continue
    if (excludePlunges && move.kind === 'plunge') continue
    const index = model.moves.length
    model.moves.push(move)
    const allowance = move.arcChordError
    model.allowance.push(Number.isFinite(allowance) && allowance! > 0 ? allowance! : 0)
    const points = stockFramePoints(move, bar, chord)
    let length = 0
    for (let i = 1; i < points.length; i += 1) {
      model.pieces.push({ from: points[i - 1], to: points[i], move: index })
      length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y, points[i].z - points[i - 1].z)
    }
    model.length.push(length)
  }
  return model
}

function distanceToPiece(p: Vec, piece: Piece): number {
  const dx = piece.to.x - piece.from.x
  const dy = piece.to.y - piece.from.y
  const dz = piece.to.z - piece.from.z
  const lengthSq = dx * dx + dy * dy + dz * dz
  let t = lengthSq < 1e-24 ? 0 : ((p.x - piece.from.x) * dx + (p.y - piece.from.y) * dy + (p.z - piece.from.z) * dz) / lengthSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (piece.from.x + t * dx), p.y - (piece.from.y + t * dy), p.z - (piece.from.z + t * dz))
}

// ── Spatial grid ──────────────────────────────────────────────

/**
 * Pieces bucketed by the cells their samples fall in. With the cell twice the
 * largest threshold and samples a threshold apart, any piece within a threshold
 * of a point has a sample in the point's cell or a neighbour (27 cells).
 */
class PieceGrid {
  private readonly cells = new Map<number, number[]>()
  private readonly stamp: Int32Array
  private query = 0
  private readonly size: number
  private readonly origin: Vec
  private readonly span = 100000

  private readonly model: PathModel

  constructor(model: PathModel, threshold: number, bounds: { min: Vec; max: Vec }) {
    this.model = model
    const extent = Math.max(bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z)
    this.size = Math.max(2 * threshold, extent / (this.span - 4), 1e-9)
    this.origin = { x: bounds.min.x - 2 * this.size, y: bounds.min.y - 2 * this.size, z: bounds.min.z - 2 * this.size }
    this.stamp = new Int32Array(model.pieces.length)
    const step = this.size / 2
    model.pieces.forEach((piece, index) => {
      const length = Math.hypot(piece.to.x - piece.from.x, piece.to.y - piece.from.y, piece.to.z - piece.from.z)
      const count = Math.max(1, Math.ceil(length / step))
      let lastKey = Number.NaN
      for (let i = 0; i <= count; i += 1) {
        const t = i / count
        const key = this.key(lerp(piece.from.x, piece.to.x, t), lerp(piece.from.y, piece.to.y, t), lerp(piece.from.z, piece.to.z, t))
        if (key === lastKey) continue
        lastKey = key
        const bucket = this.cells.get(key)
        if (bucket === undefined) this.cells.set(key, [index])
        else if (bucket[bucket.length - 1] !== index) bucket.push(index)
      }
    })
  }

  private cell(value: number, origin: number): number {
    return Math.floor((value - origin) / this.size)
  }

  private key(x: number, y: number, z: number): number {
    return this.keyOf(this.cell(x, this.origin.x), this.cell(y, this.origin.y), this.cell(z, this.origin.z))
  }

  private keyOf(ix: number, iy: number, iz: number): number {
    return ix + iy * this.span + iz * this.span * this.span
  }

  /** The pieces near `p`, each once. */
  near(p: Vec, visit: (piece: Piece, index: number) => boolean | void): void {
    this.query += 1
    const ix = this.cell(p.x, this.origin.x)
    const iy = this.cell(p.y, this.origin.y)
    const iz = this.cell(p.z, this.origin.z)
    for (let dz = -1; dz <= 1; dz += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const bucket = this.cells.get(this.keyOf(ix + dx, iy + dy, iz + dz))
          if (bucket === undefined) continue
          for (const index of bucket) {
            if (this.stamp[index] === this.query) continue
            this.stamp[index] = this.query
            if (visit(this.model.pieces[index], index) === true) return
          }
        }
      }
    }
  }
}

function boundsOf(models: PathModel[]): { min: Vec; max: Vec } {
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const model of models) {
    for (const piece of model.pieces) {
      for (const p of [piece.from, piece.to]) {
        min.x = Math.min(min.x, p.x); min.y = Math.min(min.y, p.y); min.z = Math.min(min.z, p.z)
        max.x = Math.max(max.x, p.x); max.y = Math.max(max.y, p.y); max.z = Math.max(max.z, p.z)
      }
    }
  }
  return Number.isFinite(min.x) ? { min, max } : { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }
}

// ── Comparison ────────────────────────────────────────────────

interface FailedSample { point: Vec; move: number }

/** Sample every piece of `source` and test it against `target`. */
function sweep(
  source: PathModel,
  grid: PieceGrid,
  tolerance: number,
  sampleStep: number,
  allowanceFor: (sourceMove: number, targetMove: number) => number,
): { samples: number; runs: FailedSample[][] } {
  let samples = 0
  const runs: FailedSample[][] = []
  let current: FailedSample[] | null = null
  let currentMove = -1
  const test = (p: Vec, move: number) => {
    samples += 1
    let inside = false
    grid.near(p, (piece) => {
      if (distanceToPiece(p, piece) <= tolerance + allowanceFor(move, piece.move)) {
        inside = true
        return true
      }
      return false
    })
    if (inside) {
      current = null
      return
    }
    if (current === null || currentMove !== move) {
      current = []
      runs.push(current)
      currentMove = move
    }
    current.push({ point: p, move })
  }
  let previousMove = -1
  for (const piece of source.pieces) {
    const length = Math.hypot(piece.to.x - piece.from.x, piece.to.y - piece.from.y, piece.to.z - piece.from.z)
    const count = Math.max(1, Math.ceil(length / sampleStep))
    // A move's first piece samples its start; every piece samples its end.
    const startAt = piece.move === previousMove ? 1 : 0
    previousMove = piece.move
    for (let i = startAt; i <= count; i += 1) {
      const t = i / count
      test({ x: lerp(piece.from.x, piece.to.x, t), y: lerp(piece.from.y, piece.to.y, t), z: lerp(piece.from.z, piece.to.z, t) }, piece.move)
    }
  }
  return { samples, runs }
}

/** The exact distance from `p` to the nearest piece of `model` (a scan). */
function nearestDistance(p: Vec, model: PathModel): number {
  let best = Infinity
  for (const piece of model.pieces) {
    const d = distanceToPiece(p, piece)
    if (d < best) best = d
  }
  return best
}

/** One deviation per failing run, measured at up to five of its samples. */
function measureRuns(
  runs: FailedSample[][],
  other: PathModel,
  kind: 'missingCut' | 'extraCut',
  operationId: string,
  budget: number,
): ExportDeviation[] {
  const out: ExportDeviation[] = []
  for (const run of runs.slice(0, budget)) {
    const picks = new Set<number>([0, run.length - 1])
    for (let i = 1; i < 4; i += 1) picks.add(Math.floor((run.length - 1) * i / 4))
    let worst: { point: Vec; distance: number } | null = null
    for (const index of picks) {
      const sample = run[index]
      const distance = nearestDistance(sample.point, other)
      if (worst === null || distance > worst.distance) worst = { point: sample.point, distance }
    }
    if (worst !== null) out.push({ kind, location: { ...worst.point }, distance: worst.distance, operationId })
  }
  return out
}

function feedMatches(actual: number, expected: number, relative: number, quantum: number): boolean {
  return Math.abs(actual - expected) <= Math.max(relative * Math.abs(expected), quantum)
}

/** Feed deviations: each exported feed move against the internal cuts it lies on. */
function checkFeeds(
  exported: PathModel,
  internal: PathModel,
  grid: PieceGrid,
  options: ExportParityOptions,
  feeds: { cut: number; plunge: number },
  bar: BarStock | null,
): ExportDeviation[] {
  const out: ExportDeviation[] = []
  const relative = options.feedTolerance ?? 0.005
  const quantum = options.feedQuantum ?? 0
  const coordinateQuantum = options.coordinateQuantum ?? 0
  const lengthFloor = options.tolerance / 2
  const piecesByMove = new Map<number, Piece[]>()
  for (const piece of exported.pieces) {
    const list = piecesByMove.get(piece.move)
    if (list) list.push(piece)
    else piecesByMove.set(piece.move, [piece])
  }
  exported.moves.forEach((move, index) => {
    const pieces = piecesByMove.get(index) ?? []
    if (pieces.length === 0) return
    const middle = pieces[Math.floor(pieces.length / 2)]
    const at = pieces.length % 2 === 1 ? 0.5 : 0
    const p = { x: lerp(middle.from.x, middle.to.x, at), y: lerp(middle.from.y, middle.to.y, at), z: lerp(middle.from.z, middle.to.z, at) }
    const expected = new Set<number>()
    grid.near(p, (piece) => {
      if (distanceToPiece(p, piece) > options.tolerance + internal.allowance[piece.move]) return
      const source = internal.moves[piece.move]
      expected.add(source.kind === 'plunge' ? feeds.plunge : feeds.cut * (source.feedScale ?? 1))
    })
    // Off the internal path: the geometry check reports it already.
    if (expected.size === 0) return
    const vertical = Math.abs(move.from.x - move.to.x) <= 1e-9 && Math.abs(move.from.y - move.to.y) <= 1e-9
    if (move.inverseTimeFeed !== undefined) {
      // Compared as the speed it gives along the move's stock-frame length.
      // The F came from the unrounded move: each end may sit half a digit
      // away in every axis and in the angle (at the move's radius).
      const length = Math.max(exported.length[index], lengthFloor)
      const radius = bar === null ? 0 : Math.max(axisDistance(move.from, bar), axisDistance(move.to, bar))
      const slack = 2 * (Math.sqrt(3) * coordinateQuantum + radius * coordinateQuantum * Math.PI / 180)
      const speed = move.inverseTimeFeed * length
      const allowed = (feed: number) => (options.feedTolerance ?? 0.005) * feed + move.inverseTimeFeed! * slack + quantum * length
      const best = [...expected].reduce((a, b) => Math.abs(speed - a) <= Math.abs(speed - b) ? a : b)
      if (Math.abs(speed - best) <= allowed(best)) return
      out.push({
        kind: 'feed', location: p, distance: Math.abs(move.inverseTimeFeed - best / length), operationId: options.operationId,
        expectedFeed: best / length, actualFeed: move.inverseTimeFeed, inverseTime: true,
      })
      return
    }
    const actual = move.feed
    const candidates = [...expected]
    // A controller with its own Z speed (ShopBot) caps a vertical move at the
    // plunge feed.
    if (vertical) for (const feed of expected) candidates.push(Math.min(feed, feeds.plunge))
    if (actual !== undefined && candidates.some((feed) => feedMatches(actual, feed, relative, quantum))) return
    const best = actual === undefined ? candidates[0] : candidates.reduce((a, b) => Math.abs(actual - a) <= Math.abs(actual - b) ? a : b)
    out.push({
      kind: 'feed', location: p, distance: actual === undefined ? Infinity : Math.abs(actual - best),
      operationId: options.operationId, expectedFeed: best, ...(actual !== undefined ? { actualFeed: actual } : null),
    })
  })
  return out
}

/**
 * Compare an exported read-back with the internal toolpath. Both are
 * project-space moves of one operation; see the file comment for the method.
 */
export function compareExportedToInternal(
  internal: readonly ToolpathMove[],
  exported: readonly ExportParityMove[],
  options: ExportParityOptions,
): ExportParityResult {
  const tolerance = options.tolerance
  const sampleStep = options.sampleStep ?? tolerance * 25
  const budget = options.maxDeviations ?? 20
  const bar = options.stock && isBarStock(options.stock) ? options.stock : null
  const chord = tolerance / 4

  const excludePlunges = options.excludePlunges === true
  const internalModel = buildModel(internal, bar, chord, excludePlunges)
  const exportedModel = buildModel(exported, bar, chord, excludePlunges)
  const maxAllowance = internalModel.allowance.reduce((max, value) => Math.max(max, value), 0)
  const threshold = tolerance + maxAllowance
  const bounds = boundsOf([internalModel, exportedModel])
  const internalGrid = new PieceGrid(internalModel, threshold, bounds)
  const exportedGrid = new PieceGrid(exportedModel, threshold, bounds)

  // Exported → internal: the internal piece's own allowance applies.
  const extra = sweep(exportedModel, internalGrid, tolerance, sampleStep,
    (_source, target) => internalModel.allowance[target])
  // Internal → exported: the sampled internal move's allowance applies.
  const missing = sweep(internalModel, exportedGrid, tolerance, sampleStep,
    (source) => internalModel.allowance[source])

  const deviations: ExportDeviation[] = [
    ...measureRuns(missing.runs, exportedModel, 'missingCut', options.operationId, budget),
  ]
  deviations.push(...measureRuns(extra.runs, internalModel, 'extraCut', options.operationId, Math.max(0, budget - deviations.length)))
  let deviationCount = missing.runs.length + extra.runs.length
  const maxDistance = deviations.reduce((max, deviation) => Math.max(max, deviation.distance), 0)

  if (options.feeds) {
    const feedDeviations = checkFeeds(exportedModel, internalModel, internalGrid, options, options.feeds, bar)
    deviationCount += feedDeviations.length
    deviations.push(...feedDeviations.slice(0, Math.max(0, budget - deviations.length)))
  }

  const base = {
    operationId: options.operationId,
    deviations,
    deviationCount,
    maxDistance,
    samples: { internal: missing.samples, exported: extra.samples },
  }
  if (options.exportStatus === 'failed') return { ...base, verdict: 'unverified', reason: 'exportFailed' }
  if (options.exportStatus === 'unsupported') return { ...base, verdict: 'unverified', reason: 'exportUnsupported' }
  if (internalModel.moves.length === 0 && exportedModel.moves.length === 0) {
    return { ...base, verdict: 'unverified', reason: 'noCutMoves' }
  }
  return { ...base, verdict: deviationCount > 0 ? 'deviation' : 'verified' }
}

// ── One operation, end to end ─────────────────────────────────

export interface VerifyExportedOperationArgs {
  project: Project
  operation: Operation
  /** The operation's generated toolpath, in stock space. */
  toolpath: ToolpathResult
  definition: MachineDefinition
  tool?: NormalizedTool
  /** Overrides {@link exportParityTolerance}. */
  tolerance?: number
}

export interface VerifiedExportedOperation {
  motion: ExportedOperationMotion
  parity: ExportParityResult
}

/**
 * Post, read back and compare one operation: `exportOperationMotion` then
 * `compareExportedToInternal` with the operation's own feeds, the project's
 * stock and {@link exportParityTolerance}.
 */
export function verifyExportedOperation(args: VerifyExportedOperationArgs): VerifiedExportedOperation {
  const { project, operation, toolpath, definition } = args
  const rawTool = args.tool ? null : findOperationTool(project, operation)
  const tool = args.tool ?? (rawTool ? normalizeToolForProject(rawTool, project) : undefined)
  const motion = exportOperationMotion({ project, operation, toolpath, definition, ...(tool ? { tool } : null) })
  const units = project.meta.units
  // A raw bundled definition may still carry the number form of the field.
  const places = definition.numberFormat.decimalPlaces as number | { mm: number; inch: number }
  const decimals = typeof places === 'number' ? places : places[units]
  const parity = compareExportedToInternal(toolpath.moves, motion.moves, {
    operationId: operation.id,
    tolerance: args.tolerance ?? exportParityTolerance(units),
    stock: project.stock,
    feeds: tool ? { cut: operation.feed || tool.defaultFeed, plunge: operation.plungeFeed || tool.defaultPlungeFeed } : null,
    feedQuantum: 0.5 * 10 ** -decimals,
    coordinateQuantum: 0.5 * 10 ** -decimals,
    exportStatus: motion.status,
    excludePlunges: operation.kind === 'plasma_profile',
  })
  return { motion, parity }
}
