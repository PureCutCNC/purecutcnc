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

import type { Project, Point } from '../../types/project'
import { getStockBounds, getEffectiveStockProfile, sampleProfilePoints } from '../../types/project'
import type { FlatRoundBarDescriptor, SimulationBuildOptions, SimulationGrid, SquareBarDescriptor } from './types'

const DEFAULT_LONG_AXIS_CELLS = 180
const MIN_AXIS_CELLS = 24

/** A grid's dimensions and stock envelope, before its mutable `topZ` exists. */
type SimulationGridSpec = Omit<SimulationGrid, 'topZ' | 'initialTopZ'>

/**
 * Validate a transient square descriptor before it initializes a grid. The
 * frame is the Around unroll's nominal reference cylinder, so a descriptor
 * that disagrees with `side` is a caller bug, not a blank to approximate.
 */
export function validateSquareBar(descriptor: SquareBarDescriptor): void {
  const { side, frame } = descriptor
  if (!Number.isFinite(side) || side <= 0) {
    throw new RangeError(`squareBar: side must be a positive finite number, got ${side}`)
  }
  if (!frame) {
    throw new RangeError('squareBar: frame is required')
  }
  if (frame.axis !== 'x' && frame.axis !== 'y') {
    throw new RangeError(`squareBar: frame.axis must be 'x' or 'y', got ${String(frame.axis)}`)
  }
  const scale = Math.max(1, side)
  const radiusTolerance = 1e-9 * scale
  if (!Number.isFinite(frame.radius) || Math.abs(frame.radius - side / 2) > radiusTolerance) {
    throw new RangeError(`squareBar: frame.radius must be side/2 (${side / 2}), got ${frame.radius}`)
  }
  if (!Number.isFinite(frame.circumference) || Math.abs(frame.circumference - Math.PI * side) > radiusTolerance) {
    throw new RangeError(`squareBar: frame.circumference must be π·side (${Math.PI * side}), got ${frame.circumference}`)
  }
  for (const [name, value] of [['zero', frame.zero], ['centre', frame.centre], ['sheetStart', frame.sheetStart]] as const) {
    if (!Number.isFinite(value)) {
      throw new RangeError(`squareBar: frame.${name} must be finite, got ${value}`)
    }
  }
}

/**
 * Radial distance from the pivot to the surface of a square blank of `side` at
 * `angle` radians: `halfSide / max(|sin|,|cos|)` — half the side on a flat,
 * `side/√2` at a corner. Raw blank geometry: a square grid's starting height
 * per across cell, nothing downstream of initialization.
 */
export function squareSurfaceRadius(side: number, angle: number): number {
  return (side / 2) / Math.max(Math.abs(Math.sin(angle)), Math.abs(Math.cos(angle)))
}

export function resolveSimulationGridSpec(
  project: Project,
  options: SimulationBuildOptions = {},
): SimulationGridSpec {
  const stockBounds = getStockBounds(project.stock)
  const width = Math.max(stockBounds.maxX - stockBounds.minX, 1e-6)
  const height = Math.max(stockBounds.maxY - stockBounds.minY, 1e-6)
  const longAxisCells = Math.max(MIN_AXIS_CELLS, Math.round(options.targetLongAxisCells ?? DEFAULT_LONG_AXIS_CELLS))
  const longestAxis = Math.max(width, height)
  const cellSize = longestAxis / longAxisCells

  const cols = Math.max(MIN_AXIS_CELLS, Math.ceil(width / cellSize))
  const rows = Math.max(MIN_AXIS_CELLS, Math.ceil(height / cellSize))

  // A square blank's corners reach side/√2, so the render envelope must hold
  // them; the true turning pivot stays frame.radius either way.
  const squareBar = options.squareBar
  if (squareBar) validateSquareBar(squareBar)

  // A flat round bar is a different seeding of the same flat grid, not a second
  // stock model: it cannot be a square blank, and it is not the unrolled sheet.
  const flatRoundBar = options.flatRoundBar
  if (flatRoundBar) {
    validateFlatRoundBar(flatRoundBar)
    if (squareBar) {
      throw new RangeError('simulation grid: squareBar and flatRoundBar are mutually exclusive')
    }
    if (options.wrap) {
      throw new RangeError('simulation grid: a flat round bar cannot be wrapped')
    }
  }

  return {
    originX: stockBounds.minX,
    originY: stockBounds.minY,
    cellSize,
    cols,
    rows,
    stockBottomZ: 0,
    stockTopZ: squareBar ? squareBar.side * Math.SQRT1_2 : project.stock.thickness,
  }
}

function pointInPolygon(x: number, y: number, polygon: Point[]): boolean {
  let inside = false
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y
    const xj = polygon[j].x, yj = polygon[j].y
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) {
      inside = !inside
    }
  }
  return inside
}

/**
 * Fill a square grid with the blank's true cross section. Along the bar the
 * section is constant, so the radial height depends only on the across cell's
 * angle from the frame's zero line: `halfSide / max(|sin|,|cos|)`. The caller
 * snapshots the result as the immutable baseline — every later write lowers
 * `topZ` only.
 */
export function seedSquareTopZ(
  topZ: Float32Array,
  spec: SimulationGridSpec,
  squareBar: SquareBarDescriptor,
): void {
  const anglePerAcross = (2 * Math.PI) / squareBar.frame.circumference
  const acrossOrigin = squareBar.frame.axis === 'x' ? spec.originY : spec.originX
  const acrossCount = squareBar.frame.axis === 'x' ? spec.rows : spec.cols
  const acrossHeights = new Float32Array(acrossCount)
  for (let across = 0; across < acrossCount; across += 1) {
    const coordinate = acrossOrigin + (across + 0.5) * spec.cellSize
    acrossHeights[across] = squareSurfaceRadius(squareBar.side, (coordinate - squareBar.frame.zero) * anglePerAcross)
  }
  // The section is constant along the bar, so when across runs along the rows
  // (an X bar) every row is one distance — a native `fill` per row instead of a
  // per-cell write (issue #1112 rt2-e; the square seed was the only
  // square-specific stage of opening the panel and it was several times the
  // round path's uniform `fill`). `fill` stores exactly what the indexed write
  // does, so the seeded heights are byte-identical. Across runs across the
  // columns for a Y bar, where no row is constant; that keeps the loop.
  if (squareBar.frame.axis === 'x') {
    for (let row = 0; row < spec.rows; row += 1) {
      const rowBase = row * spec.cols
      topZ.fill(acrossHeights[row], rowBase, rowBase + spec.cols)
    }
    return
  }
  for (let row = 0; row < spec.rows; row += 1) {
    const rowBase = row * spec.cols
    for (let col = 0; col < spec.cols; col += 1) {
      topZ[rowBase + col] = acrossHeights[col]
    }
  }
}

/**
 * Validate a transient flat round-bar descriptor before it seeds a grid. The
 * values are raw bar geometry, so nothing here may be silently approximated: a
 * non-positive radius or a non-finite centre/pivot is a caller bug.
 */
export function validateFlatRoundBar(descriptor: FlatRoundBarDescriptor): void {
  const { axis, pivot, radius, centre, length } = descriptor
  if (axis !== 'x' && axis !== 'y') {
    throw new RangeError(`flatRoundBar: axis must be 'x' or 'y', got ${String(axis)}`)
  }
  if (!Number.isFinite(radius) || radius <= 0) {
    throw new RangeError(`flatRoundBar: radius must be a positive finite number, got ${radius}`)
  }
  if (!Number.isFinite(pivot) || pivot < 0) {
    throw new RangeError(`flatRoundBar: pivot must be a finite, non-negative number, got ${pivot}`)
  }
  if (!Number.isFinite(centre)) {
    throw new RangeError(`flatRoundBar: centre must be a finite number, got ${centre}`)
  }
  if (!Number.isFinite(length) || length <= 0) {
    throw new RangeError(`flatRoundBar: length must be a positive finite number, got ${length}`)
  }
}

/** The stock-top height of a round bar `distance` across from its centreline. */
function flatRoundBarSurfaceZ(flatRoundBar: FlatRoundBarDescriptor, distance: number, emptyZ: number): number {
  const radiusSquared = flatRoundBar.radius * flatRoundBar.radius
  const distanceSquared = distance * distance
  // Outside the bar there is no material at all: the grid's empty value, never
  // a rounded-down or zero-height surface.
  if (distanceSquared >= radiusSquared) return emptyZ
  return flatRoundBar.pivot + Math.sqrt(radiusSquared - distanceSquared)
}

/**
 * Fill a flat (Top/Bottom) grid from a round bar's real profile as seen from
 * that face: each cell's material top is `pivot + sqrt(radius² − d²)`, where
 * `d` is the cell centre's distance across the bar from its centreline
 * (issue #1049). Along the bar the section is constant, so it depends only on
 * the across cell. Cells with `|d| ≥ radius` start at the grid's empty value,
 * which is how the profile-masked stock above already says "no material here";
 * they are never raised above it.
 *
 * This is a **top-down heightfield**, so it shows the bar's upper half only:
 * nothing below the equator is represented. A cutter approaches along +Z, so it
 * cannot reach that half anyway; the render's boundary wall below the equator
 * is a silhouette, not a modelled surface.
 *
 * The caller snapshots the result as the immutable baseline — every later write
 * lowers `topZ` only.
 */
export function seedFlatRoundBarTopZ(
  topZ: Float32Array,
  spec: SimulationGridSpec,
  flatRoundBar: FlatRoundBarDescriptor,
): void {
  const acrossOrigin = flatRoundBar.axis === 'x' ? spec.originY : spec.originX
  const acrossCount = flatRoundBar.axis === 'x' ? spec.rows : spec.cols
  const acrossHeights = new Float32Array(acrossCount)
  for (let across = 0; across < acrossCount; across += 1) {
    const coordinate = acrossOrigin + (across + 0.5) * spec.cellSize
    acrossHeights[across] = flatRoundBarSurfaceZ(flatRoundBar, coordinate - flatRoundBar.centre, spec.stockBottomZ)
  }
  for (let row = 0; row < spec.rows; row += 1) {
    for (let col = 0; col < spec.cols; col += 1) {
      const across = flatRoundBar.axis === 'x' ? row : col
      topZ[row * spec.cols + col] = acrossHeights[across]
    }
  }
}

export function createSimulationGrid(
  project: Project,
  options: SimulationBuildOptions = {},
): SimulationGrid {
  const spec = resolveSimulationGridSpec(project, options)
  const cellCount = spec.cols * spec.rows
  const topZ = new Float32Array(cellCount)

  const flatRoundBar = options.flatRoundBar
  if (flatRoundBar) {
    // A round bar seen from a Top or Bottom setup enters here and only here:
    // the starting heights are the bar's real upper profile, and the immutable
    // snapshot keeps a virgin bar from reporting its own curvature as removal.
    // Everything downstream is the same flat kernel that cuts a block.
    seedFlatRoundBarTopZ(topZ, spec, flatRoundBar)
    const initialTopZ = new Float32Array(topZ)
    return {
      ...spec,
      ...(options.wrap ? { wrap: options.wrap } : {}),
      initialTopZ,
      topZ,
    }
  }

  const squareBar = options.squareBar
  if (squareBar) {
    // A square blank enters here and only here: the starting heights are its
    // true cross section, and the immutable snapshot is what statistics
    // measure against. Everything downstream is the round bar's path.
    seedSquareTopZ(topZ, spec, squareBar)
    const initialTopZ = new Float32Array(topZ)
    return {
      ...spec,
      ...(options.wrap ? { wrap: options.wrap } : {}),
      initialTopZ,
      topZ,
    }
  }

  topZ.fill(spec.stockTopZ)

  // If stock has a non-rectangular profile (from a source feature), mask cells
  // outside the profile. Use sampleProfilePoints (not profileVertices) so that
  // circle and arc segments are properly tessellated — profileVertices returns
  // a single point for circle-only profiles, which silently skips masking (issue #644).
  const effectiveProfile = getEffectiveStockProfile(project.stock)
  if (effectiveProfile && project.stock.sourceFeatureId) {
    const vertices = sampleProfilePoints(effectiveProfile)
    if (vertices.length >= 3) {
      const halfCell = spec.cellSize / 2
      for (let row = 0; row < spec.rows; row++) {
        for (let col = 0; col < spec.cols; col++) {
          const cx = spec.originX + col * spec.cellSize + halfCell
          const cy = spec.originY + row * spec.cellSize + halfCell
          if (!pointInPolygon(cx, cy, vertices)) {
            topZ[row * spec.cols + col] = 0
          }
        }
      }
    }
  }

  return {
    ...spec,
    ...(options.wrap ? { wrap: options.wrap } : {}),
    topZ,
  }
}
