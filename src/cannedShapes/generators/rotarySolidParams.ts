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
 * Shared parameter validation for the canned rotary models (issue #1112 G).
 *
 * Turn and Polygon store their start/length plus a snapshot of the bar they
 * were drawn on. A generator is not given the project when it runs, so that
 * snapshot is what makes save → load → regenerate exact: the mesh must sit on
 * the same centreline, along the same absolute stretch of the bar, after a
 * reload. Start and length are measured from the **chuck end**, the same as
 * Thread/Flutes and every other rotary shape (decision 4).
 */

import { isBarStock, type RotaryBarGeometry } from '../../types/barStock'
import { getProfileBounds, rectProfile, type CannedShapeParams, type Project } from '../../types/project'

/** The frame fields stored inside a rotary model's parameters. */
export interface RotarySolidFrame {
  axis: 'x' | 'y'
  /** Bar diameter on a round bar, blank side on a square one. */
  thickness: number
  /** Absolute stock coordinate of the bar's low end along its axis. */
  alongMin: number
  /** Absolute stock coordinate of the bar's high end along its axis. */
  alongMax: number
  /** Bar centreline across the axis: a Y value on an X bar, an X value on a Y bar. */
  acrossCentre: number
}

/** Numeric slack for the along-extent and size checks, matching the old dialog. */
export const ROTARY_SOLID_TOLERANCE = 1e-6

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** True when `value` is a complete, usable stored frame. */
export function isStoredRotarySolidFrame(value: unknown): value is RotarySolidFrame {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const frame = value as Record<string, unknown>
  return (frame.axis === 'x' || frame.axis === 'y')
    && isFiniteNumber(frame.thickness)
    && isFiniteNumber(frame.alongMin)
    && isFiniteNumber(frame.alongMax)
    && isFiniteNumber(frame.acrossCentre)
    && frame.thickness > 0
    && frame.alongMax > frame.alongMin
}

/** A deep copy of the frame, so a definition never shares one params object. */
export function cloneStoredRotarySolidFrame(frame: RotarySolidFrame): RotarySolidFrame {
  return {
    axis: frame.axis,
    thickness: frame.thickness,
    alongMin: frame.alongMin,
    alongMax: frame.alongMax,
    acrossCentre: frame.acrossCentre,
  }
}

/** Convert the frame's length fields when the project changes units. */
export function convertStoredRotarySolidFrame(
  frame: RotarySolidFrame,
  convertLength: (value: number) => number,
): RotarySolidFrame {
  return {
    ...frame,
    thickness: convertLength(frame.thickness),
    alongMin: convertLength(frame.alongMin),
    alongMax: convertLength(frame.alongMax),
    acrossCentre: convertLength(frame.acrossCentre),
  }
}

/** The frame if the parameter set carries one, otherwise null. */
export function storedSolidFrameOf(params: CannedShapeParams): RotarySolidFrame | null {
  return isStoredRotarySolidFrame(params.frame) ? params.frame : null
}

/** The bar's length along its axis. */
export function rotarySolidBarLength(frame: RotarySolidFrame): number {
  return frame.alongMax - frame.alongMin
}

/**
 * The absolute stock-space endpoints for a start offset and length measured
 * from the bar's **chuck end**. For a bar along X the chuck end is `alongMin`;
 * for a bar along Y it is `alongMax`. This is the one place a Y sign mistake
 * would silently mirror the band.
 */
export function rotarySolidAlong(
  frame: RotarySolidFrame,
  start: number,
  length: number,
): { alongStart: number; alongEnd: number } {
  return frame.axis === 'x'
    ? { alongStart: frame.alongMin + start, alongEnd: frame.alongMin + start + length }
    : { alongStart: frame.alongMax - start - length, alongEnd: frame.alongMax - start }
}

/**
 * Validate a start/length pair against the stored bar. Returns the reason key
 * suffix used by the dialog and the store, or null when the band is usable.
 */
export function rotarySolidBandProblem(
  frame: RotarySolidFrame,
  start: number,
  length: number,
): 'start' | 'length' | 'range' | null {
  if (!isFiniteNumber(start) || start < 0) return 'start'
  if (!isFiniteNumber(length) || length <= 0) return 'length'
  if (start + length > rotarySolidBarLength(frame) + ROTARY_SOLID_TOLERANCE) return 'range'
  return null
}

/** The bar geometry the mesh builders read, rebuilt from the stored snapshot. */
export function rotarySolidFrameStock(frame: RotarySolidFrame): RotaryBarGeometry {
  const half = frame.thickness / 2
  const acrossMin = frame.acrossCentre - half
  const profile = frame.axis === 'x'
    ? rectProfile(frame.alongMin, acrossMin, frame.alongMax - frame.alongMin, frame.thickness)
    : rectProfile(acrossMin, frame.alongMin, frame.thickness, frame.alongMax - frame.alongMin)
  return { axis: frame.axis, thickness: frame.thickness, profile }
}

/** The frame of the bar the workspace currently holds, or null for a block. */
export function rotarySolidFrame(project: Pick<Project, 'stock'>): RotarySolidFrame | null {
  const stock = project.stock
  if (!isBarStock(stock)) return null
  const bounds = getProfileBounds(stock.profile)
  return {
    axis: stock.axis,
    thickness: stock.thickness,
    alongMin: stock.axis === 'x' ? bounds.minX : bounds.minY,
    alongMax: stock.axis === 'x' ? bounds.maxX : bounds.maxY,
    acrossCentre: stock.axis === 'x' ? (bounds.minY + bounds.maxY) / 2 : (bounds.minX + bounds.maxX) / 2,
  }
}

/**
 * A point of the bar's side view — a distance `along` its axis and a signed
 * distance `radius` from its centreline — as stock XY, where the flat faces'
 * sketch draws it (issue #1112 rt2-d). `across` maps to project Y on an X bar
 * and project X on a Y bar, the same way the mesh builders project it.
 */
export function rotarySolidSideViewPoint(
  frame: RotarySolidFrame,
  along: number,
  radius: number,
): { x: number; y: number } {
  const across = frame.acrossCentre + radius
  return frame.axis === 'x' ? { x: along, y: across } : { x: across, y: along }
}

/**
 * A rectangle of the side view given the band it covers and its **two** across
 * extents about the centreline, as stock XY. The one place the axis decides
 * which project coordinate is the band and which is the width.
 *
 * The extents are signed distances from the centreline, not a half width: a
 * shape need not have the same amount of material on both sides of the axis
 * (an odd-sided polygon with a corner across reaches further one way than the
 * other), and the outline must not gain material it does not have.
 */
export function rotarySolidSideViewSpanRect(
  frame: RotarySolidFrame,
  alongStart: number,
  alongEnd: number,
  acrossLow: number,
  acrossHigh: number,
): { x: number; y: number; width: number; height: number } {
  const acrossMin = frame.acrossCentre + Math.min(acrossLow, acrossHigh)
  const acrossMax = frame.acrossCentre + Math.max(acrossLow, acrossHigh)
  const acrossWidth = acrossMax - acrossMin
  const along = Math.abs(alongEnd - alongStart)
  return frame.axis === 'x'
    ? { x: alongStart, y: acrossMin, width: along, height: acrossWidth }
    : { x: acrossMin, y: alongStart, width: acrossWidth, height: along }
}

/** A side-view rectangle symmetric about the centreline, `halfWidth` each way. */
export function rotarySolidSideViewRect(
  frame: RotarySolidFrame,
  alongStart: number,
  alongEnd: number,
  halfWidth: number,
): { x: number; y: number; width: number; height: number } {
  return rotarySolidSideViewSpanRect(frame, alongStart, alongEnd, -halfWidth, halfWidth)
}
