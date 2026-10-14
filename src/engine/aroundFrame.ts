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
 * The zero line (a = 0, the top of the bar) is the bar's centreline across
 * coordinate, `zero` (issue #1026). The sheet keeps the along extent and runs
 * across from `sheetStart = zero − C/2` to `zero + C/2`, C = π·D, so the zero
 * line runs through its middle and its two edges are the seam (the bottom of
 * the bar, a = ±180°). Geometry outside it keeps turning.
 * Around features store Top-like heights: surface z = D, centreline z = R.
 * Flat heights are lowered by R: the sheet's top is R, its bottom is zero.
 * a = 360·(across − zero)/C, never reduced to one turn. Per rotaryFrame,
 * a flat height r cuts stock across = centre + r·sin a, z = R + r·cos a;
 * toolSpacePoint of that stock point at a is the wrapped tool point.
 *
 * A chuck or tailstock is a band across the *whole* bar, so it covers every
 * turn the job can reach: `unrolledProject` spreads it from one circumference
 * below the lowest across coordinate on the sheet to one above the highest.
 */

import { getStockBounds, isAroundSetup, isRoundStock, rectProfile, roundStockCentre } from '../types/project'
import type { Operation, Project, RoundStock } from '../types/project'
import { getFeatureGeometryBounds } from '../text'
import { resolveFeatureInstance } from '../store/helpers/resolveFeatures'
import { setupForOperation } from './setupOrientation'
import { resolveDimensionRef } from './toolpaths/geometry'
import type { ToolpathBounds, ToolpathMove, ToolpathPoint, ToolpathResult } from './toolpaths/types'

export interface AroundFrame {
  readonly axis: 'x' | 'y'
  /** The centreline's across coordinate (roundStockCentre); the same as `zero`. */
  readonly centre: number
  readonly radius: number
  /**
   * Across coordinate of the zero line — the top of the bar at a = 0
   * (issue #1026). It is the bar's centreline, `centre`, and every angle is
   * taken from it: `a = 360·(across − zero)/C`.
   */
  readonly zero: number
  /**
   * Across coordinate of the sheet's first edge: `zero − C/2`, one
   * circumference below the zero line. The far edge is `sheetStart + C`; the
   * two edges are the seam (the bottom of the bar, a = ±180°).
   */
  readonly sheetStart: number
  readonly circumference: number
}

export function aroundFrame(stock: RoundStock): AroundFrame {
  const circumference = Math.PI * stock.thickness
  const zero = roundStockCentre(stock)
  return {
    axis: stock.axis,
    centre: zero,
    radius: stock.thickness / 2,
    zero,
    sheetStart: zero - circumference / 2,
    circumference,
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

/**
 * The project as a flat face reads it (issue #395): a feature authored on the
 * Around face stores the unrolled sheet's coordinates, which mean nothing on
 * the bar's own rectangle — a Top or Bottom cut that numerically overlaps one
 * must never fold it into its own region, and a flat setup's simulation must
 * not draw it.
 *
 * Returns the input project **itself** when it holds no Around feature, so a
 * project without Around content takes exactly the path it always did.
 */
export function flatFaceProject(project: Project): Project {
  const features = project.features.filter((feature) => feature.authoringFace !== 'around')
  return features.length === project.features.length ? project : { ...project, features }
}

/** Flat point → tool point on the bar. Always carries `a`. */
export function wrapPoint(flat: { x: number; y: number; z: number }, frame: AroundFrame): ToolpathPoint {
  const across = frame.axis === 'x' ? flat.y : flat.x
  const a = 360 * (across - frame.zero) / frame.circumference
  return frame.axis === 'x'
    ? { x: flat.x, y: frame.centre, z: flat.z + frame.radius, a }
    : { x: frame.centre, y: flat.y, z: flat.z + frame.radius, a }
}

/**
 * Exact inverse of wrapPoint; an unwrapped point has no `a` key. The angle is
 * taken from the frame's zero line, so a point on the sheet comes back in the
 * same one-circumference window the sheet is framed in (`zero − C/2` to
 * `zero + C/2`) and an angle past a full turn keeps turning, never reduced
 * (issue #395).
 */
export function unwrapPoint(point: ToolpathPoint, frame: AroundFrame): { x: number; y: number; z: number } {
  if (point.a === undefined) throw new Error('Unwrapping an Around point requires a rotary angle.')
  const across = frame.zero + point.a * frame.circumference / 360
  return frame.axis === 'x'
    ? { x: point.x, y: across, z: point.z - frame.radius }
    : { x: across, y: point.y, z: point.z - frame.radius }
}

/**
 * The across extent a fixture band must cover: one circumference below the
 * lowest across coordinate of anything on the sheet and one above the highest
 * — the sheet itself and every Around feature's transformed bounds. A cutter
 * clearance or lead move past a feature is therefore inside the band too.
 */
function bandAcrossExtent(project: Project, frame: AroundFrame): { min: number; max: number } {
  let min = frame.sheetStart
  let max = frame.sheetStart + frame.circumference
  for (const feature of project.features) {
    if (feature.authoringFace !== 'around') continue
    const resolved = resolveFeatureInstance(project, feature.id)
    if (!resolved) continue
    const bounds = getFeatureGeometryBounds(resolved)
    const acrossMin = frame.axis === 'x' ? bounds.minY : bounds.minX
    const acrossMax = frame.axis === 'x' ? bounds.maxY : bounds.maxX
    if (Number.isFinite(acrossMin)) min = Math.min(min, acrossMin)
    if (Number.isFinite(acrossMax)) max = Math.max(max, acrossMax)
  }
  return { min: min - frame.circumference, max: max + frame.circumference }
}

/** The project as a flat block for the generators. Transient; never stored. */
export function unrolledProject(project: Project, frame: AroundFrame): Project {
  const bounds = getStockBounds(project.stock)
  const band = bandAcrossExtent(project, frame)
  const { shape: _shape, sourceFeature: _source, ...stock } = project.stock
  void _shape
  void _source
  // A block carries neither the bar axis nor a source feature.
  const { axis: _axis, ...plainStock } = stock as typeof stock & { axis?: 'x' | 'y' }
  void _axis
  return {
    ...project,
    meta: { ...project.meta, maxTravelZ: Math.max(0, project.meta.maxTravelZ - frame.radius) },
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
        ? { y: band.min, h: band.max - band.min }
        : { x: band.min, w: band.max - band.min }),
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
