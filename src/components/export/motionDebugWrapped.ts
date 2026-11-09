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
 * The 3D wrapped view of the Exported Motion debug dialog (issue #1179).
 *
 * The dialog's plan view is flat: a rotary program's A word is only a line in
 * the sidebar, so a wrong turn cannot be seen. This module turns the parsed
 * exported program back into toolpoint moves in project space — each carrying
 * the angle the parser read — and draws them through the viewport's existing
 * CPU wrap path, `stockSpaceMoves`. That path is the only place a toolpoint is
 * mapped onto the unturned bar, so a machine move that turns the stock draws as
 * the helix it cuts rather than as a chord.
 *
 * Nothing here writes G-code, a toolpath or the simulation: it is a view of the
 * program that was exported.
 */

import type { BarStock, MachineOrigin } from '../../types/project'
import { getStockBounds } from '../../types/project'
import { barCentre, barInscribedRadius, barPivotZ, isSquareStock } from '../../types/barStock'
import type { PinnedMachineDefinition } from '../../engine/gcode/types'
import type { ParsedGcodeMotion } from '../../engine/gcode/gcodeMotionParser'
import type { ParsedArcMove } from '../../engine/gcode/gcodeMotionParser'
import { machineToProjectPoint } from '../../engine/gcode/utils'
import type { ToolpathGenerationTrace, ToolpathMove, ToolpathMoveKind, ToolpathPoint } from '../../engine/toolpaths/types'
import { stockSpaceMoves } from '../viewport3d/toolpathOverlay'

/** Largest arc sweep one tessellated chord may cover, in degrees. */
const MAX_ARC_CHORD_DEGREES = 5
/** Safety cap on the chords a single arc can become (a full circle is 72). */
const MAX_ARC_CHORDS = 720

/** A range of commanded rotary angles, in project degrees. */
export interface AngleRange {
  min: number
  max: number
}

/**
 * One drawn piece of the wrapped path, in the unturned stock's own frame.
 *
 * `aFrom`/`aTo` repeat the commanded angle at the piece's two ends. They are
 * carried beside the stock-space point because that point has no rotary
 * component — it is where the material under the tool tip was before the stock
 * turned — and the readout needs the angle the program commanded there.
 */
export interface WrappedPiece {
  from: { x: number; y: number; z: number }
  to: { x: number; y: number; z: number }
  rapid: boolean
  /**
   * Commanded (project) Z of the move this piece came from. The sidebar's
   * cutting-level filter keys on it, and it is deliberately the pre-wrap Z: the
   * wrapped point has been turned about the bar's axis, so its own z is no
   * longer a cutting level.
   */
  z: number
  /** True for cut/plunge/lead moves; false for rapids, as the 2D layer marks it. */
  cutting: boolean
  aFrom?: number
  aTo?: number
}

/** The wrapped path of one debug layer, plus the program's angle span. */
export interface WrappedMotionModel {
  /** Stock-space pieces per layer, in machine (program) order. */
  layers: Record<'generated' | 'optimized' | 'exported', WrappedPiece[]>
  /** The exported program's A span, or null when the program carries no angle. */
  aRange: AngleRange | null
}

/** The bar the program cuts, as the 3D view draws it. */
export interface BarOutlineGeometry {
  shape: 'round' | 'square'
  axis: 'x' | 'y'
  /** Extent along the bar, in project coordinates. */
  alongMin: number
  alongMax: number
  /** The centreline's across coordinate (project). */
  centre: number
  /** Z of the turning axis: mid-thickness. */
  pivotZ: number
  /** Inscribed radius: half the diameter, or half the square's side. */
  radius: number
  /** Largest radius the blank reaches: the square's corner radius on a blank. */
  maxRadius: number
  /** Physical size across: diameter or side. */
  thickness: number
}

/**
 * The directed sweep of a parsed arc, in radians, signed like the arc's own
 * direction (positive counter-clockwise in machine space). `largeArc` resolves
 * the ambiguity between the two arcs joining the endpoints, exactly as the SVG
 * layer's large-arc flag does.
 */
function directedSweep(move: ParsedArcMove): { startAngle: number; sweep: number } {
  const cx = move.center.x
  const cy = move.center.y
  const startAngle = Math.atan2(move.from.y - cy, move.from.x - cx)
  let delta = Math.atan2(move.to.y - cy, move.to.x - cx) - startAngle
  if (move.clockwise) {
    while (delta > 0) delta -= Math.PI * 2
    while (delta <= -Math.PI * 2) delta += Math.PI * 2
    if (!move.largeArc && delta < -Math.PI) delta += Math.PI * 2
    if (move.largeArc && delta > -Math.PI) delta -= Math.PI * 2
  } else {
    while (delta < 0) delta += Math.PI * 2
    while (delta >= Math.PI * 2) delta -= Math.PI * 2
    if (!move.largeArc && delta > Math.PI) delta -= Math.PI * 2
    if (move.largeArc && delta < Math.PI) delta += Math.PI * 2
  }
  return { startAngle, sweep: delta }
}

/**
 * A parsed arc as chords in **machine** space, so the affine machine→project
 * map can place each endpoint itself. The parser keeps arcs analytic and only
 * the wrap needs points, so the sweep is split at
 * {@link MAX_ARC_CHORD_DEGREES}.
 */
function arcChords(move: ParsedArcMove): Array<{ from: ToolpathPoint; to: ToolpathPoint }> {
  const { startAngle, sweep } = directedSweep(move)
  if (!Number.isFinite(sweep) || Math.abs(sweep) < 1e-12) {
    return [{ from: move.from, to: move.to }]
  }
  const chordCount = Math.min(
    MAX_ARC_CHORDS,
    Math.max(1, Math.ceil((Math.abs(sweep) * 180) / Math.PI / MAX_ARC_CHORD_DEGREES)),
  )
  const chords: Array<{ from: ToolpathPoint; to: ToolpathPoint }> = []
  let previous = move.from
  for (let chord = 1; chord <= chordCount; chord++) {
    const t = chord / chordCount
    let next: ToolpathPoint
    if (chord === chordCount) {
      next = move.to
    } else {
      const angle = startAngle + sweep * t
      next = {
        x: move.center.x + move.radius * Math.cos(angle),
        y: move.center.y + move.radius * Math.sin(angle),
        z: move.from.z + (move.to.z - move.from.z) * t,
      }
      const a = move.from.a === undefined || move.to.a === undefined
        ? move.from.a
        : move.from.a + (move.to.a - move.from.a) * t
      if (a !== undefined) next.a = a
    }
    chords.push({ from: previous, to: next })
    previous = next
  }
  return chords
}

/**
 * The exported program as toolpoint moves in project space (issue #1179).
 *
 * Each parsed move is mapped back through the same machine→project inverse the
 * 2D layer uses, which also un-applies the machine's rotary direction, so the
 * angle on a move is the project angle the stock was turned to. Arcs become
 * chords because the wrap works on points — a machine arc is a straight line in
 * the unrolled sheet only where the angle does not change, and the wrap splits
 * the pieces that do turn whatever this function hands it.
 */
export function exportedMotionMoves(
  parsed: ParsedGcodeMotion,
  origin: MachineOrigin,
  definition: PinnedMachineDefinition,
): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  for (const move of parsed.moves) {
    const kind: ToolpathMoveKind = move.kind === 'rapid' ? 'rapid' : 'cut'
    const chords = move.kind === 'arc'
      ? arcChords(move)
      : [{ from: move.from, to: move.to }]
    for (const chord of chords) {
      moves.push({
        kind,
        from: machineToProjectPoint(chord.from, origin, definition),
        to: machineToProjectPoint(chord.to, origin, definition),
      })
    }
  }
  return moves
}

/** The A span a move list commands, or null when it carries no angle at all. */
export function angleRangeOfMoves(moves: readonly ToolpathMove[]): AngleRange | null {
  let min = Infinity
  let max = -Infinity
  for (const move of moves) {
    for (const point of [move.from, move.to]) {
      if (point.a === undefined) continue
      if (point.a < min) min = point.a
      if (point.a > max) max = point.a
    }
  }
  return Number.isFinite(min) ? { min, max } : null
}

/**
 * Wrap a move list onto the unturned bar through the viewport's own CPU path
 * (`stockSpaceMoves`), keeping each piece's commanded angle.
 *
 * A turning move is split into pieces of at most 5°, so its boundaries fall on
 * equal angle steps: the wrapper interpolates in the flat sheet, where the
 * across coordinate — and so the angle — is linear in the piece's progress.
 * The angle is therefore taken from the piece's own position in the returned
 * run rather than from a second subdivision rule that could drift from it.
 */
export function wrapMoves(moves: readonly ToolpathMove[], stock: BarStock): WrappedPiece[] {
  const pieces: WrappedPiece[] = []
  for (const move of moves) {
    const wrapped = stockSpaceMoves([move], stock)
    const fromA = move.from.a
    const toA = move.to.a
    wrapped.forEach((piece, index) => {
      const hasAngle = fromA !== undefined && toA !== undefined
      const aFrom = hasAngle ? fromA + (toA - fromA) * (index / wrapped.length) : fromA
      const aTo = hasAngle ? fromA + (toA - fromA) * ((index + 1) / wrapped.length) : toA
      pieces.push({
        from: { x: piece.from.x, y: piece.from.y, z: piece.from.z },
        to: { x: piece.to.x, y: piece.to.y, z: piece.to.z },
        rapid: move.kind === 'rapid',
        z: move.from.z,
        cutting: move.kind !== 'rapid',
        aFrom,
        aTo,
      })
    })
  }
  return pieces
}

/**
 * The pieces the dialog's sidebar filters leave visible, with the same rule the
 * 2D plan view applies (`filterSegments`): a cutting piece shows at the selected
 * cutting level (or at every level), and a rapid only with "non-cutting moves"
 * on. A rapid is never filtered by Z — the 2D view does not filter it either.
 */
export function filterWrappedPieces(
  pieces: readonly WrappedPiece[],
  selectedZ: number | 'all',
  showNonCutting: boolean,
): WrappedPiece[] {
  return pieces.filter((piece) => (piece.cutting
    ? selectedZ === 'all' || Math.abs(piece.z - selectedZ) < 1e-6
    : showNonCutting))
}

export interface BuildWrappedMotionArgs {
  parsed: ParsedGcodeMotion
  origin: MachineOrigin
  /** Pinned against the project's stock: the angle letter depends on it (#1153). */
  definition: PinnedMachineDefinition
  stock: BarStock
  /** The generation trace, for the optional Generated and Optimized layers. */
  trace?: ToolpathGenerationTrace
}

/**
 * The whole 3D view's geometry: the exported program wrapped onto the bar, plus
 * the source layers when a trace is supplied.
 *
 * Returns null for a program that carries no rotary angle — a flat operation
 * has nothing to wrap, and the dialog offers no 3D view for it.
 */
export function buildWrappedMotion(args: BuildWrappedMotionArgs): WrappedMotionModel | null {
  const { parsed, origin, definition, stock, trace } = args
  const exported = exportedMotionMoves(parsed, origin, definition)
  const aRange = angleRangeOfMoves(exported)
  if (aRange === null) return null
  return {
    layers: {
      generated: trace ? wrapMoves(trace.raw.moves, stock) : [],
      optimized: trace ? wrapMoves(trace.optimized.moves, stock) : [],
      exported: wrapMoves(exported, stock),
    },
    aRange,
  }
}

/**
 * The bar as the 3D view draws it, in project coordinates. A round bar is a
 * cylinder of {@link BarOutlineGeometry.radius}; a square blank is a box of
 * `thickness`, whose corners reach `maxRadius` but whose turning pivot is the
 * same box centre (#1016 C2-S3).
 */
export function barOutline(stock: BarStock): BarOutlineGeometry {
  const bounds = getStockBounds(stock)
  return {
    shape: isSquareStock(stock) ? 'square' : 'round',
    axis: stock.axis,
    alongMin: stock.axis === 'x' ? bounds.minX : bounds.minY,
    alongMax: stock.axis === 'x' ? bounds.maxX : bounds.maxY,
    centre: barCentre(stock),
    pivotZ: barPivotZ(stock),
    radius: barInscribedRadius(stock),
    maxRadius: isSquareStock(stock) ? stock.thickness * Math.SQRT1_2 : stock.thickness / 2,
    thickness: stock.thickness,
  }
}
