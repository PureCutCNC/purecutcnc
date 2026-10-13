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
 * The Around frame (issue #395): a round bar unrolled for top-down generators.
 * `thickness` is diameter D, radius R = D/2. Along is the bar's project axis;
 * across is Y for an X bar and X for a Y bar. X and Y are never swapped.
 * The sheet keeps the along extent and runs across from the stock's minimum
 * `sheetStart` to `sheetStart + C`, C = π·D. Geometry outside it keeps turning.
 * Around features store Top-like heights: surface z = D, centreline z = R.
 * Flat heights are lowered by R: the sheet's top is R, its bottom is zero.
 * a = 360·(across − sheetStart)/C, never reduced to one turn. Per rotaryFrame,
 * a flat height r cuts stock across = centre + r·sin a, z = R + r·cos a;
 * toolSpacePoint of that stock point at a is the wrapped tool point.
 */

import { getStockBounds, isAroundSetup, isRoundStock, rectProfile, roundStockCentre } from '../types/project'
import type { Operation, Project, RoundStock } from '../types/project'
import { setupForOperation } from './setupOrientation'
import { resolveDimensionRef } from './toolpaths/geometry'
import type { ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './toolpaths/types'

export interface AroundFrame {
  readonly axis: 'x' | 'y'
  /** The centreline's across coordinate (roundStockCentre). */
  readonly centre: number
  readonly radius: number
  /** Across coordinate of the sheet's zero line: the top of the bar at a = 0. */
  readonly sheetStart: number
  readonly circumference: number
}

export function aroundFrame(stock: RoundStock): AroundFrame {
  const bounds = getStockBounds(stock)
  return {
    axis: stock.axis,
    centre: roundStockCentre(stock),
    radius: stock.thickness / 2,
    sheetStart: stock.axis === 'x' ? bounds.minY : bounds.minX,
    circumference: Math.PI * stock.thickness,
  }
}

/** Around requires a round bar and the same axis: never guess a frame. */
export function aroundFrameForOperation(
  project: Pick<Project, 'setups' | 'stock'>,
  operation: Pick<Operation, 'id' | 'setupId'>,
): AroundFrame | undefined {
  const setup = setupForOperation(project, operation)
  if (!setup || !isAroundSetup(setup)) return undefined
  if (!isRoundStock(project.stock)) throw new Error('An Around setup requires round stock.')
  if (setup.orientation.axis !== project.stock.axis) throw new Error('The Around setup axis must match the bar axis.')
  return aroundFrame(project.stock)
}

/** Flat point → tool point on the bar. Always carries `a`. */
export function wrapPoint(flat: { x: number; y: number; z: number }, frame: AroundFrame): ToolpathPoint {
  const across = frame.axis === 'x' ? flat.y : flat.x
  const a = 360 * (across - frame.sheetStart) / frame.circumference
  return frame.axis === 'x'
    ? { x: flat.x, y: frame.centre, z: flat.z + frame.radius, a }
    : { x: frame.centre, y: flat.y, z: flat.z + frame.radius, a }
}

/** Exact inverse of wrapPoint; an unwrapped point has no `a` key. */
export function unwrapPoint(point: ToolpathPoint, frame: AroundFrame): { x: number; y: number; z: number } {
  if (point.a === undefined) throw new Error('Unwrapping an Around point requires a rotary angle.')
  const across = frame.sheetStart + point.a * frame.circumference / 360
  return frame.axis === 'x'
    ? { x: point.x, y: across, z: point.z - frame.radius }
    : { x: across, y: point.y, z: point.z - frame.radius }
}

/** The project as a flat block for the generators. Transient; never stored. */
export function unrolledProject(project: Project, frame: AroundFrame): Project {
  const bounds = getStockBounds(project.stock)
  const { shape: _shape, sourceFeature: _source, ...stock } = project.stock
  void _shape
  void _source
  // A block carries neither the bar axis nor a source feature.
  const { axis: _axis, ...plainStock } = stock as typeof stock & { axis?: 'x' | 'y' }
  void _axis
  return {
    ...project,
    stock: {
      ...plainStock,
      profile: frame.axis === 'x'
        ? rectProfile(bounds.minX, frame.sheetStart, bounds.maxX - bounds.minX, frame.circumference)
        : rectProfile(frame.sheetStart, bounds.minY, frame.circumference, bounds.maxY - bounds.minY),
      thickness: frame.radius,
    },
    features: project.features.filter((feature) => feature.authoringFace === 'around').map((feature) => ({
      ...feature,
      z_top: resolveDimensionRef(project, feature.z_top) - frame.radius,
      z_bottom: resolveDimensionRef(project, feature.z_bottom) - frame.radius,
    })),
    tabs: [],
    clamps: project.clamps.filter((clamp) => clamp.type === 'chuck' || clamp.type === 'tailstock').map((clamp) => ({
      ...clamp,
      ...(frame.axis === 'x'
        ? { y: frame.sheetStart, h: frame.circumference }
        : { x: frame.sheetStart, w: frame.circumference }),
      // Clamp.height is its absolute top Z, measured from the stock's bottom.
      height: clamp.height - frame.radius,
    })),
    origin: { ...project.origin, z: project.origin.z - frame.radius },
    setups: project.setups.map((setup) => {
      if (!isAroundSetup(setup)) return setup
      const { kind: _kind, ...plain } = setup
      void _kind
      return plain
    }),
  }
}

function boundsOf(moves: readonly ToolpathMove[]): ToolpathBounds | null {
  if (moves.length === 0) return null
  const bounds: ToolpathBounds = {
    minX: Infinity, minY: Infinity, minZ: Infinity,
    maxX: -Infinity, maxY: -Infinity, maxZ: -Infinity,
  }
  for (const move of moves) {
    for (const point of [move.from, move.to]) {
      bounds.minX = Math.min(bounds.minX, point.x)
      bounds.minY = Math.min(bounds.minY, point.y)
      bounds.minZ = Math.min(bounds.minZ, point.z)
      bounds.maxX = Math.max(bounds.maxX, point.x)
      bounds.maxY = Math.max(bounds.maxY, point.y)
      bounds.maxZ = Math.max(bounds.maxZ, point.z)
    }
  }
  return bounds
}

function shiftLevels<T extends ToolpathResult>(result: T, offset: number): void {
  const levels = (result as { stepLevels?: number[] }).stepLevels
  if (levels) (result as { stepLevels?: number[] }).stepLevels = levels.map((z) => z + offset)
}

/** A flat toolpath carried onto the bar; ramping turns are split in flat space. */
export function wrapToolpath<T extends ToolpathResult>(result: T, frame: AroundFrame): T {
  const moves: ToolpathMove[] = []
  const collisions = new Set(result.collidingMoveIndices)
  const collidingMoveIndices: number[] = []
  result.moves.forEach((move, index) => {
    const acrossFrom = frame.axis === 'x' ? move.from.y : move.from.x
    const acrossTo = frame.axis === 'x' ? move.to.y : move.to.x
    const dz = move.to.z - move.from.z
    const n = acrossFrom !== acrossTo && dz !== 0
      ? Math.min(64, Math.ceil(Math.abs(dz) / (0.1 * Math.max(Math.min(move.from.z, move.to.z), 1e-9))))
      : 1
    const at = (i: number): ToolpathPoint => i === 0 ? move.from : i === n ? move.to : {
      x: move.from.x + (move.to.x - move.from.x) * i / n,
      y: move.from.y + (move.to.y - move.from.y) * i / n,
      z: move.from.z + dz * i / n,
    }
    for (let i = 0; i < n; i++) {
      if (collisions.has(index)) collidingMoveIndices.push(moves.length)
      moves.push({ ...move, from: wrapPoint(at(i), frame), to: wrapPoint(at(i + 1), frame) })
    }
  })
  const wrapped: T = { ...result, moves, bounds: boundsOf(moves) }
  if (result.collidingMoveIndices) wrapped.collidingMoveIndices = collidingMoveIndices
  delete wrapped.drillCycles
  shiftLevels(wrapped, frame.radius)
  return wrapped
}

/** A wrapped toolpath back on the sheet; pieces stay split. */
export function unwrapToolpath<T extends ToolpathResult>(result: T, frame: AroundFrame): T {
  const moves = result.moves.map((move) => ({ ...move, from: unwrapPoint(move.from, frame), to: unwrapPoint(move.to, frame) }))
  const unwrapped: T = { ...result, moves, bounds: boundsOf(moves) }
  shiftLevels(unwrapped, -frame.radius)
  return unwrapped
}
