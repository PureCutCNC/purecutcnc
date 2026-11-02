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
 * Thread and flute sheet geometry (issue #1016 C1, canned in #1112 F).
 *
 * This is the pure half: the Around frame facts and the open `line`s a Thread
 * or Flutes input draws on the unrolled sheet. It imports only the project
 * types, so a canned-shape generator can use it without pulling in the store,
 * the UI or the text/canned registry (which would cycle).
 *
 * Geometry is built on the unrolled Around sheet from the frozen frame
 * (`engine/aroundFrame.ts`, `engine/rotaryFrame.ts`):
 *
 * - `along` is the bar's project axis. `start` is measured **from the chuck
 *   end**, the same way Turn and Polygon measure it (issue #1112 decision 4),
 *   and `alongDirection` says which way increasing stock coordinates run away
 *   from that end. Nothing is clipped when the band reaches past a bar end —
 *   the cut runs off it.
 * - `across` runs from `frame.zero`, the bar's centreline (the top of the bar,
 *   a = 0). It is never reduced modulo the circumference: one turn is
 *   `frame.circumference` and a multi-turn line keeps counting.
 * - A thread with `n` starts advances `lead = n * pitch` along the bar per full
 *   turn, and its `n` lines start evenly `C / n` apart across. A flute line
 *   spans `twist * C` across over the requested length, `count` of them evenly
 *   `C / count` apart. A thread is right-hand unless `hand` is `left`; a flute's
 *   positive `twist` is right-hand and `0` is straight.
 *
 * Handedness is the frozen rotary sign, not a screen convention. The physical
 * frame is project X and Z, with physical Y = −project Y (the project frame is
 * Y-down; export inverts it). For a bar along X the along direction is
 * physical +X and `across` is physical −Y; for a bar along Y the along
 * direction is physical −Y and `across` is physical +X. Working the frozen
 * angle `a = 360·(across − zero)/C` and the material point
 * `(across, up) = (r·sin a, r·cos a)` into a right-handed helix triple product
 * gives `da/d(along) > 0` on X and `< 0` on Y — the same physical right-hand
 * thread needs the opposite sheet slope on the two axes, because swapping
 * which project axis is "across" is a reflection. `rotaryHandedness` is that
 * sign, and `rotaryPatterns.test.ts` re-derives it from the physical points
 * instead of trusting this constant.
 */

import { getStockBounds, isRoundStock } from '../types/project'
import type { Point, Project } from '../types/project'
import { barCentre } from '../types/barStock'

/** Depth of a 60° thread as a fraction of its pitch (the UI default). */
export const THREAD_DEPTH_PER_PITCH = 0.61

/**
 * The Around sheet facts a pattern is built from. `zero` is
 * `aroundFrame.zero` (the bar's centreline / top line, issue #1026), never the
 * sheet's lower edge.
 */
export interface RotaryPatternFrame {
  axis: 'x' | 'y'
  zero: number
  circumference: number
  radius: number
  /** Absolute stock-space along coordinate of the bar's chuck end. */
  alongOrigin: number
  /** `+1` when increasing stock coordinates run away from the chuck end. */
  alongDirection: 1 | -1
}

/** The pattern frame for a round bar, or null when the stock is not a bar. */
export function rotaryPatternFrame(project: Pick<Project, 'stock'>): RotaryPatternFrame | null {
  if (!isRoundStock(project.stock)) return null
  const stock = project.stock
  const bounds = getStockBounds(stock)
  // The same chuck end Turn/Polygon use: minX along X, maxY along Y
  // (`resizeRoundStock` keeps that end fixed).
  const alongOrigin = stock.axis === 'x' ? bounds.minX : bounds.maxY
  return {
    axis: stock.axis,
    zero: barCentre(stock),
    circumference: Math.PI * stock.thickness,
    radius: stock.thickness / 2,
    alongOrigin,
    alongDirection: stock.axis === 'x' ? 1 : -1,
  }
}

/** `+1` or `-1`: the across direction a right-hand helix takes on this bar axis. */
export function rotaryHandedness(axis: 'x' | 'y'): 1 | -1 {
  return axis === 'x' ? 1 : -1
}

/** A straight line on the unrolled sheet: along the bar, across from the zero line. */
export interface RotarySheetLine {
  alongStart: number
  alongEnd: number
  acrossStart: number
  acrossEnd: number
}

/** The sheet point at an along/across coordinate: `along` is the bar's project axis. */
export function rotarySheetPoint(
  frame: Pick<RotaryPatternFrame, 'axis'>,
  along: number,
  across: number,
): Point {
  return frame.axis === 'x' ? { x: along, y: across } : { x: across, y: along }
}

export interface RotaryThreadGeometryInput {
  kind: 'thread'
  /** Distance from the chuck end along the bar, project units. */
  start: number
  /** Length along the bar, project units. */
  length: number
  /** Physical pitch in project units; the inch dialog converts TPI first. */
  pitch: number
  /** Number of starts; defaults to 1. Lead is `starts * pitch`. */
  starts?: number
  /** Thread hand; `left` reverses the physical helix. Omitted is right. */
  hand?: 'right' | 'left'
  /** Depth below the bar surface, project units. */
  depth: number
}

export interface RotaryFlutesGeometryInput {
  kind: 'flutes'
  start: number
  length: number
  count: number
  /** Turns of twist over the requested length; positive is right-hand, `0` straight. */
  twist: number
  depth: number
}

export type RotaryPatternGeometryInput = RotaryThreadGeometryInput | RotaryFlutesGeometryInput

export type RotaryPatternGeometryRefusal =
  | 'invalidStart'
  | 'invalidLength'
  | 'invalidDepth'
  | 'invalidPitch'
  | 'invalidStarts'
  | 'invalidCount'
  | 'invalidTwist'
  /** Depth reaches or passes the bar's centreline. */
  | 'depthReachesCentreline'

export type RotaryPatternLinesResult =
  | { ok: true; lines: RotarySheetLine[] }
  | { ok: false; reason: RotaryPatternGeometryRefusal }

/**
 * The sheet lines a Thread or Flutes input asks for. Pure: it validates the
 * numbers and the depth against the bar radius, and derives the geometry. It
 * knows nothing about tools, the store or the workspace face.
 */
export function buildRotaryPatternLines(
  frame: RotaryPatternFrame,
  input: RotaryPatternGeometryInput,
): RotaryPatternLinesResult {
  if (!Number.isFinite(input.start) || input.start < 0) return { ok: false, reason: 'invalidStart' }
  if (!Number.isFinite(input.length) || input.length <= 0) return { ok: false, reason: 'invalidLength' }
  if (!Number.isFinite(input.depth) || input.depth <= 0) return { ok: false, reason: 'invalidDepth' }
  // Strictly above the centreline: the bar's surface is at `thickness`, its
  // centreline at `radius`, so a depth reaching the radius is refused.
  if (input.depth >= frame.radius) return { ok: false, reason: 'depthReachesCentreline' }

  // Place the requested band from the chuck end, then draw it in ascending
  // stock coordinates. The endpoints are the same two points either way, but
  // drawing low→high keeps a Y bar's line direction (and so its toolpath and
  // posted arc/helix sign) identical to the pre-canned command, which always
  // drew from the stock minimum. "Start from the chuck end" places the band;
  // it does not reverse the drawing.
  const bandA = frame.alongOrigin + frame.alongDirection * input.start
  const bandB = bandA + frame.alongDirection * input.length
  const alongStart = Math.min(bandA, bandB)
  const alongEnd = Math.max(bandA, bandB)

  if (input.kind === 'thread') {
    const starts = input.starts ?? 1
    if (!Number.isInteger(starts) || starts < 1) return { ok: false, reason: 'invalidStarts' }
    if (!Number.isFinite(input.pitch) || input.pitch <= 0) return { ok: false, reason: 'invalidPitch' }
    const lead = starts * input.pitch
    const hand = input.hand === 'left' ? -1 : 1
    const acrossPerAlong = (hand * rotaryHandedness(frame.axis) * frame.circumference) / lead
    const lines = Array.from({ length: starts }, (_, index) => {
      const acrossStart = frame.zero + (index * frame.circumference) / starts
      return {
        alongStart,
        alongEnd,
        acrossStart,
        acrossEnd: acrossStart + (alongEnd - alongStart) * acrossPerAlong,
      }
    })
    return { ok: true, lines }
  }

  if (!Number.isInteger(input.count) || input.count < 1) return { ok: false, reason: 'invalidCount' }
  if (!Number.isFinite(input.twist)) return { ok: false, reason: 'invalidTwist' }
  const lines = Array.from({ length: input.count }, (_, index) => {
    const acrossStart = frame.zero + (index * frame.circumference) / input.count
    return {
      alongStart,
      alongEnd,
      acrossStart,
      acrossEnd: acrossStart + rotaryHandedness(frame.axis) * input.twist * frame.circumference,
    }
  })
  return { ok: true, lines }
}
