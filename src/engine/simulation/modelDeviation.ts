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
 * Deviation of simulated stock from the combined model (issue #1268, slice
 * 2/3 of #1267).
 *
 * The moves come from either source — the internal toolpath or the exported
 * program mapped back to stock space — as plain `SimulationReplayItem`s, so
 * both are verified the same way. They are replayed cumulatively, in cut
 * order, into a fresh grid of one flat setup (Top or Bottom), recording per
 * cell the last item that lowered it; that item's operation supplies the cell's
 * stock-to-leave. The result is compared with the model's top surface
 * (`modelTarget.ts`) and every cell is classified:
 *
 * - **gouge** — the simulated surface is inside the model by more than the
 *   tolerance;
 * - **intendedLeftover** — material above the model, but within the cell's
 *   allowance (plus tolerance);
 * - **unintendedLeftover** — material above the model beyond it;
 * - **ok** — within the tolerance.
 *
 * "Within" is measured as an offset of the model surface, not only straight
 * down: the allowance is the operation's radial stock-to-leave sideways and
 * its axial stock-to-leave vertically (an axis-aligned ellipsoid swept over
 * the model surface), and the tolerance is a ball of its own radius. A wall's
 * radial skin, which is a full-height step in a heightfield, therefore reads as
 * intended leftover, and a wall a fraction of a cell off its true position
 * never reads as a gouge or a leftover.
 *
 * The normal simulation entry points are not touched: attribution replays one
 * item at a time through the same `replayItemsIntoGrid`, so the heights are
 * exactly the batch replay's.
 */

import { getManifoldModule } from '../csg'
import { toolpathInSetupFrame } from '../setupFrameProject'
import { isRotaryOperationKind, isRoundStock, type MachiningSetup, type Project, type RoundStock } from '../../types/project'
import { barCentre, barInscribedRadius, barLength, barPivotZ } from '../../types/barStock'
import { createSimulationGrid } from './grid'
import { modelSetupView, modelTessellationTolerance, rasterModelTargetHeights } from './modelTarget'
import { moveIsMaterialRemoving, replayItemsIntoGrid } from './replay'
import type { FlatRoundBarDescriptor, SimulationBuildOptions, SimulationGrid, SimulationReplayItem } from './types'

// ── Public types (consumed by the Verify view, #1269) ───────────────────────

/** One cell's verdict. */
export type ModelDeviationClass = 'ok' | 'gouge' | 'intendedLeftover' | 'unintendedLeftover'

/**
 * The classes in code order: `cellClasses[i]` holds an index into this list.
 * Stable — the codes are part of the public contract.
 */
export const MODEL_DEVIATION_CLASSES: readonly ModelDeviationClass[] = ['ok', 'gouge', 'intendedLeftover', 'unintendedLeftover']

export const MODEL_DEVIATION_OK = 0
export const MODEL_DEVIATION_GOUGE = 1
export const MODEL_DEVIATION_INTENDED_LEFTOVER = 2
export const MODEL_DEVIATION_UNINTENDED_LEFTOVER = 3

/**
 * Per-cell stock-to-leave, in project units: the radial and axial allowance of
 * the operation that last removed material in the cell, or 0 for a cell no
 * operation touched.
 */
export interface ModelCellAllowances {
  radial: Float32Array
  axial: Float32Array
}

/** The per-cell verdict and its signed size. */
export interface ModelDeviationClassification {
  /** One code per cell (`MODEL_DEVIATION_CLASSES` index), row-major like `grid.topZ`. */
  cellClasses: Uint8Array
  /** Simulated minus target height per cell: negative inside the model, positive above it. */
  deviation: Float32Array
}

/**
 * One connected (4-neighbour) group of cells of the same non-ok class.
 * Coordinates are in the grid's frame: the setup-local project frame the
 * simulation runs in (for Top, the stock frame itself).
 */
export interface ModelDeviationRegion {
  class: Exclude<ModelDeviationClass, 'ok'>
  cellCount: number
  /** Plan area, `cellCount · cellSize²`. */
  area: number
  /** The cells' outer extent. */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** Mean of the cell centres. */
  centroid: { x: number; y: number }
  /** Largest vertical deviation in the region, always positive: depth below the model for a gouge, height above it for a leftover. */
  maxDeviation: number
  /** Where `maxDeviation` occurs. */
  maxDeviationAt: { x: number; y: number; simulatedZ: number; targetZ: number }
  /**
   * The operation responsible: for a gouge, the last operation that cut the
   * deepest cell; for a leftover, the operation that last cut most of the
   * region's cells (whose allowance applies), or — for material no operation
   * touched, such as a corner a round tool cannot reach — the one that last cut
   * most of the cells bordering it. `null` when neither was cut.
   */
  operationId: string | null
}

/** Why a comparison could not be made. Structured codes; the UI words them. */
export type ModelVerificationReason =
  /** The setup is an Around (rotary) setup: the wrapped simulation is not compared yet. */
  | 'aroundSetup'
  /** A replayed operation is a rotary rough/finish. */
  | 'rotaryOperation'
  /** A replayed move turns the rotary axis while cutting. */
  | 'rotaryMotion'
  /** The setup's orientation cannot be machined by this build. */
  | 'unsupportedSetup'
  /** `uptoOperationId` names no replayed item. */
  | 'uptoOperationNotFound'
  /** The project has no model to compare against (no add, no imported model). */
  | 'noModel'

/** A non-fatal observation about the comparison. */
export type ModelVerificationWarning =
  /** A replayed item names an operation the project does not hold; its cells get no allowance. */
  { code: 'unknownOperation'; operationId: string }

export interface ModelDeviationSummary {
  gougeCells: number
  intendedLeftoverCells: number
  unintendedLeftoverCells: number
}

/**
 * The outcome of {@link verifyAgainstModel}. `verified` means the comparison
 * was made — it may still report gouges and leftovers; `unverified` means it
 * could not be, and `reason` says why. Every array is row-major over `grid`.
 */
export type ModelVerificationResult =
  | {
    status: 'verified'
    reason?: undefined
    warnings: ModelVerificationWarning[]
    /** The cumulative simulated stock after the selected operation. */
    grid: SimulationGrid
    /** The model's top surface at each cell centre. */
    target: Float32Array
    cellClasses: Uint8Array
    deviation: Float32Array
    /** Per cell: index into `operationIds` of the last operation that cut it, or -1. */
    cellOperation: Int32Array
    /** The replayed items' operation ids, in cut order (one entry per replayed item). */
    operationIds: string[]
    allowances: ModelCellAllowances
    /** The tolerance actually used (never below the resolution floor). */
    tolerance: number
    regions: ModelDeviationRegion[]
    summary: ModelDeviationSummary
  }
  | {
    status: 'unverified'
    reason: ModelVerificationReason
    warnings: ModelVerificationWarning[]
    grid: null
    target: null
    cellClasses: null
    deviation: null
    cellOperation: null
    operationIds: string[]
    allowances: null
    tolerance: null
    regions: []
    summary: null
  }

export interface VerifyAgainstModelInput {
  /** The canonical (stock-space) project. */
  project: Project
  /**
   * The moves to verify, in cut order, in canonical stock space — the frame the
   * generated toolpath map and `exportOperationMotion` both use. They are
   * turned into the setup's frame here.
   */
  items: readonly SimulationReplayItem[]
  /** Replay up to and including this operation's last item; all items when absent. */
  uptoOperationId?: string
  /** The flat setup to verify; Top when absent. */
  setup?: Pick<MachiningSetup, 'orientation' | 'kind'>
  /** Requested tolerance; raised to the resolution floor when smaller. */
  tolerance?: number
  /** Grid cells along the stock's long axis (the simulation's detail). */
  detailCells?: number
}

// ── Attribution replay ──────────────────────────────────────────────────────

export interface RemovalAttribution {
  /** Per cell: index into the replayed `items` of the last one that lowered it, or -1. */
  lastItem: Int32Array
  processedMoveCount: number
}

/**
 * Replay `items` into `grid` in order, recording per cell the last item that
 * lowered it. Each item goes through the ordinary `replayItemsIntoGrid`, so the
 * final heights equal a batch replay of the same items; only this wrapper pays
 * for the per-item snapshot.
 */
export function replayItemsWithRemovalAttribution(
  grid: SimulationGrid,
  items: readonly SimulationReplayItem[],
): RemovalAttribution {
  const lastItem = new Int32Array(grid.cols * grid.rows).fill(-1)
  const before = new Float32Array(grid.topZ.length)
  let processedMoveCount = 0
  items.forEach((item, itemIndex) => {
    before.set(grid.topZ)
    processedMoveCount += replayItemsIntoGrid(grid, [item]).processedMoveCount
    const topZ = grid.topZ
    for (let cell = 0; cell < topZ.length; cell += 1) {
      if (topZ[cell] < before[cell]) lastItem[cell] = itemIndex
    }
  })
  return { lastItem, processedMoveCount }
}

// ── Classification ──────────────────────────────────────────────────────────

/** Neighbourhood half-width cap, in cells, so a huge allowance cannot stall a check. */
const MAX_NEIGHBOURHOOD_CELLS = 64

/**
 * The model surface offset outward by an ellipsoid of `radial` × `axial` at
 * one cell: the highest point of the offset surface over the cell centre.
 */
function offsetAbove(
  target: Float32Array, cols: number, rows: number, cellSize: number,
  col: number, row: number, radial: number, axial: number,
): number {
  const reach = Math.min(MAX_NEIGHBOURHOOD_CELLS, Math.floor(radial / cellSize))
  const radialSq = radial * radial
  let best = target[row * cols + col] + axial
  for (let dr = -reach; dr <= reach; dr += 1) {
    const r = row + dr
    if (r < 0 || r >= rows) continue
    for (let dc = -reach; dc <= reach; dc += 1) {
      const c = col + dc
      if (c < 0 || c >= cols || (dr === 0 && dc === 0)) continue
      const distSq = (dc * dc + dr * dr) * cellSize * cellSize
      if (distSq > radialSq) continue
      const height = target[r * cols + c] + axial * Math.sqrt(1 - distSq / radialSq)
      if (height > best) best = height
    }
  }
  return best
}

/** The model surface offset inward by a ball of `radius`: the lowest point over the cell centre. */
function offsetBelow(
  target: Float32Array, cols: number, rows: number, cellSize: number,
  col: number, row: number, radius: number,
): number {
  const reach = Math.min(MAX_NEIGHBOURHOOD_CELLS, Math.floor(radius / cellSize))
  const radiusSq = radius * radius
  let best = target[row * cols + col] - radius
  for (let dr = -reach; dr <= reach; dr += 1) {
    const r = row + dr
    if (r < 0 || r >= rows) continue
    for (let dc = -reach; dc <= reach; dc += 1) {
      const c = col + dc
      if (c < 0 || c >= cols || (dr === 0 && dc === 0)) continue
      const distSq = (dc * dc + dr * dr) * cellSize * cellSize
      if (distSq > radiusSq) continue
      const height = target[r * cols + c] - radius * Math.sqrt(1 - distSq / radiusSq)
      if (height < best) best = height
    }
  }
  return best
}

/**
 * Classify each cell of `simulated` against `target` (issue #1268).
 *
 * At a cell centre, with simulated height `s`, model height `t`, tolerance
 * `tol` and the cell's allowance `(radial, axial)`:
 * gouge when `s < t − tol`; intended leftover when the excess is at most the
 * allowance plus `tol`; unintended leftover beyond. Both comparisons are made
 * against the offset model surface, so a neighbour within reach counts too:
 * the tolerance is a ball of radius `tol`, the allowance an ellipsoid of
 * `radial + tol` sideways and `axial + tol` up. Only cells outside the
 * straight-down band pay for the neighbourhood.
 */
export function classifyModelDeviation(
  simulated: Pick<SimulationGrid, 'topZ' | 'cols' | 'rows' | 'cellSize'>,
  target: Float32Array,
  allowances: ModelCellAllowances,
  tolerance: number,
): ModelDeviationClassification {
  const { topZ, cols, rows, cellSize } = simulated
  const count = cols * rows
  if (target.length !== count || allowances.radial.length !== count || allowances.axial.length !== count) {
    throw new RangeError('classifyModelDeviation: every raster must have one value per grid cell')
  }
  const tol = Math.max(0, tolerance)
  const cellClasses = new Uint8Array(count)
  const deviation = new Float32Array(count)
  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const cell = row * cols + col
      const s = topZ[cell]
      const t = target[cell]
      deviation[cell] = s - t
      if (s < t - tol) {
        if (s < offsetBelow(target, cols, rows, cellSize, col, row, tol)) cellClasses[cell] = MODEL_DEVIATION_GOUGE
        continue
      }
      if (s <= t + tol) continue
      if (s <= offsetAbove(target, cols, rows, cellSize, col, row, tol, tol)) continue
      const radial = allowances.radial[cell]
      const axial = allowances.axial[cell]
      if ((radial > 0 || axial > 0)
        && s <= offsetAbove(target, cols, rows, cellSize, col, row, radial + tol, axial + tol)) {
        cellClasses[cell] = MODEL_DEVIATION_INTENDED_LEFTOVER
      } else {
        cellClasses[cell] = MODEL_DEVIATION_UNINTENDED_LEFTOVER
      }
    }
  }
  return { cellClasses, deviation }
}

// ── Regions ─────────────────────────────────────────────────────────────────

/**
 * Connected components (4-neighbour) of each non-ok class. `cellOperation`
 * holds, per cell, an index into `operationIds` (or -1). Ordered by class
 * code, then by area, largest first.
 */
export function modelDeviationRegions(
  grid: Pick<SimulationGrid, 'topZ' | 'cols' | 'rows' | 'cellSize' | 'originX' | 'originY'>,
  target: Float32Array,
  classification: ModelDeviationClassification,
  cellOperation: Int32Array,
  operationIds: readonly string[],
): ModelDeviationRegion[] {
  const { cols, rows, cellSize, originX, originY, topZ } = grid
  const { cellClasses, deviation } = classification
  const visited = new Uint8Array(cols * rows)
  const stack: number[] = []
  const regions: ModelDeviationRegion[] = []
  for (let start = 0; start < cellClasses.length; start += 1) {
    const code = cellClasses[start]
    if (code === MODEL_DEVIATION_OK || visited[start]) continue
    visited[start] = 1
    stack.push(start)
    let cellCount = 0
    let minCol = cols, maxCol = -1, minRow = rows, maxRow = -1
    let sumCol = 0, sumRow = 0
    let maxDeviation = -1
    let maxCell = start
    const votes = new Map<number, number>()
    const borderVotes = new Map<number, number>()
    while (stack.length > 0) {
      const cell = stack.pop()!
      const col = cell % cols
      const row = (cell - col) / cols
      cellCount += 1
      sumCol += col
      sumRow += row
      if (col < minCol) minCol = col
      if (col > maxCol) maxCol = col
      if (row < minRow) minRow = row
      if (row > maxRow) maxRow = row
      const size = Math.abs(deviation[cell])
      if (size > maxDeviation) {
        maxDeviation = size
        maxCell = cell
      }
      const op = cellOperation[cell]
      if (op >= 0) votes.set(op, (votes.get(op) ?? 0) + 1)
      const neighbours = [
        col > 0 ? cell - 1 : -1,
        col < cols - 1 ? cell + 1 : -1,
        row > 0 ? cell - cols : -1,
        row < rows - 1 ? cell + cols : -1,
      ]
      for (const next of neighbours) {
        if (next < 0) continue
        if (cellClasses[next] !== code) {
          const border = cellOperation[next]
          if (border >= 0) borderVotes.set(border, (borderVotes.get(border) ?? 0) + 1)
          continue
        }
        if (visited[next]) continue
        visited[next] = 1
        stack.push(next)
      }
    }
    let operation = -1
    if (code === MODEL_DEVIATION_GOUGE) {
      operation = cellOperation[maxCell]
    } else {
      let bestVotes = 0
      for (const [op, n] of votes.size > 0 ? votes : borderVotes) {
        if (n > bestVotes || (n === bestVotes && op > operation)) {
          bestVotes = n
          operation = op
        }
      }
    }
    const maxCol0 = maxCell % cols
    const maxRow0 = (maxCell - maxCol0) / cols
    regions.push({
      class: MODEL_DEVIATION_CLASSES[code] as ModelDeviationRegion['class'],
      cellCount,
      area: cellCount * cellSize * cellSize,
      bounds: {
        minX: originX + minCol * cellSize,
        minY: originY + minRow * cellSize,
        maxX: originX + (maxCol + 1) * cellSize,
        maxY: originY + (maxRow + 1) * cellSize,
      },
      centroid: {
        x: originX + (sumCol / cellCount + 0.5) * cellSize,
        y: originY + (sumRow / cellCount + 0.5) * cellSize,
      },
      maxDeviation,
      maxDeviationAt: {
        x: originX + (maxCol0 + 0.5) * cellSize,
        y: originY + (maxRow0 + 0.5) * cellSize,
        simulatedZ: topZ[maxCell],
        targetZ: target[maxCell],
      },
      operationId: operation >= 0 ? operationIds[operation] ?? null : null,
    })
  }
  const order = (region: ModelDeviationRegion) => MODEL_DEVIATION_CLASSES.indexOf(region.class)
  regions.sort((a, b) => order(a) - order(b) || b.cellCount - a.cellCount)
  return regions
}

// ── The whole comparison ────────────────────────────────────────────────────

function unverified(reason: ModelVerificationReason, warnings: ModelVerificationWarning[] = [], operationIds: string[] = []): ModelVerificationResult {
  return {
    status: 'unverified', reason, warnings, grid: null, target: null, cellClasses: null, deviation: null,
    cellOperation: null, operationIds, allowances: null, tolerance: null, regions: [], summary: null,
  }
}

/** A flat setup of a round bar seeds the grid with the bar's real profile (issue #1049), as the simulation does. */
function flatRoundBarFor(stock: RoundStock): FlatRoundBarDescriptor {
  return { axis: stock.axis, pivot: barPivotZ(stock), radius: barInscribedRadius(stock), centre: barCentre(stock), length: barLength(stock) }
}

/**
 * The grid options verification builds its fresh grid with, for a flat
 * setup's local project (`modelSetupView(...).localProject`). Exported so the
 * Verify view (issue #1269) can replay other moves into the very same grid.
 */
export function modelVerificationGridOptions(localProject: Project, detailCells?: number): SimulationBuildOptions {
  return {
    ...(detailCells !== undefined ? { targetLongAxisCells: detailCells } : {}),
    ...(isRoundStock(localProject.stock) ? { flatRoundBar: flatRoundBarFor(localProject.stock) } : {}),
  }
}

/** The smallest tolerance the comparison can honestly resolve: one cell plus the mesh tessellation. */
export function modelDeviationToleranceFloor(grid: Pick<SimulationGrid, 'cellSize'>, project: Project): number {
  return grid.cellSize + modelTessellationTolerance(project)
}

/**
 * Verify the cumulative simulated stock after the selected operation against
 * the combined model (issue #1268). Async only because the Manifold module
 * loads asynchronously; the work itself is synchronous.
 *
 * Rotary work — an Around setup, a rotary operation, or a move that turns the
 * A axis while cutting — is reported `unverified`, as is a project without a
 * model. Items naming an operation the project does not hold are replayed
 * with no allowance and reported as warnings.
 */
export async function verifyAgainstModel(input: VerifyAgainstModelInput): Promise<ModelVerificationResult> {
  const { project, setup } = input
  if (setup?.kind === 'around') return unverified('aroundSetup')

  let items = [...input.items]
  if (input.uptoOperationId !== undefined) {
    let last = -1
    items.forEach((item, index) => { if (item.operationId === input.uptoOperationId) last = index })
    if (last < 0) return unverified('uptoOperationNotFound')
    items = items.slice(0, last + 1)
  }
  const operationIds = items.map((item) => item.operationId)

  const operations = new Map(project.operations.map((operation) => [operation.id, operation]))
  const warnings: ModelVerificationWarning[] = []
  for (const id of new Set(operationIds)) {
    const operation = operations.get(id)
    if (!operation) warnings.push({ code: 'unknownOperation', operationId: id })
    else if (isRotaryOperationKind(operation.kind)) return unverified('rotaryOperation', warnings, operationIds)
  }
  for (const item of items) {
    for (const move of item.toolpath.moves) {
      if (moveIsMaterialRemoving(move) && (move.from.a ?? 0) !== (move.to.a ?? 0)) {
        return unverified('rotaryMotion', warnings, operationIds)
      }
    }
  }

  let view: ReturnType<typeof modelSetupView>
  try {
    view = modelSetupView(project, setup)
  } catch {
    return unverified('unsupportedSetup', warnings, operationIds)
  }

  const grid = createSimulationGrid(view.localProject, modelVerificationGridOptions(view.localProject, input.detailCells))
  const module = await getManifoldModule()
  const target = rasterModelTargetHeights(module, grid, project, setup)
  if (!target) return unverified('noModel', warnings, operationIds)

  const localItems = items.map((item) => ({ ...item, toolpath: toolpathInSetupFrame(item.toolpath, view.frame) }))
  const { lastItem } = replayItemsWithRemovalAttribution(grid, localItems)

  const count = grid.cols * grid.rows
  const allowances: ModelCellAllowances = { radial: new Float32Array(count), axial: new Float32Array(count) }
  const itemRadial = items.map((item) => Math.max(0, operations.get(item.operationId)?.stockToLeaveRadial ?? 0))
  const itemAxial = items.map((item) => Math.max(0, operations.get(item.operationId)?.stockToLeaveAxial ?? 0))
  for (let cell = 0; cell < count; cell += 1) {
    const item = lastItem[cell]
    if (item < 0) continue
    allowances.radial[cell] = itemRadial[item]
    allowances.axial[cell] = itemAxial[item]
  }

  const tolerance = Math.max(input.tolerance ?? 0, modelDeviationToleranceFloor(grid, view.localProject))
  const classification = classifyModelDeviation(grid, target, allowances, tolerance)
  const regions = modelDeviationRegions(grid, target, classification, lastItem, operationIds)
  const summary: ModelDeviationSummary = { gougeCells: 0, intendedLeftoverCells: 0, unintendedLeftoverCells: 0 }
  for (const code of classification.cellClasses) {
    if (code === MODEL_DEVIATION_GOUGE) summary.gougeCells += 1
    else if (code === MODEL_DEVIATION_INTENDED_LEFTOVER) summary.intendedLeftoverCells += 1
    else if (code === MODEL_DEVIATION_UNINTENDED_LEFTOVER) summary.unintendedLeftoverCells += 1
  }

  return {
    status: 'verified',
    warnings,
    grid,
    target,
    cellClasses: classification.cellClasses,
    deviation: classification.deviation,
    cellOperation: lastItem,
    operationIds,
    allowances,
    tolerance,
    regions,
    summary,
  }
}
