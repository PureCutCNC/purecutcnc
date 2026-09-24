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

/** A closed polygon; the closing edge back to the first point is implicit. */
export type NestRing = Point[]

/**
 * One kind of part to place. Every copy is the same rigid shape.
 *
 * `footprint` holds outer boundaries only. Overlapping or nested rings are
 * unioned, and any hole the union leaves is filled.
 */
export interface NestPart {
  id: string
  footprint: NestRing[]
  /**
   * Empty regions inside the footprint that other parts may be placed in
   * (#859), such as the counter of an O. Read with the non-zero rule: a
   * counter-clockwise ring encloses a hole and a clockwise ring inside it is an
   * island of material. Used only with `NestRequest.shrinkHoles`.
   */
  holes?: NestRing[]
  quantity: number
  /** Allowed rotations in degrees, counter-clockwise in the ring's own axes. */
  rotations: number[]
}

/**
 * Grows a footprint so that two grown footprints which merely touch leave at
 * least `minimumGap` between the original shapes. Applied to parts and
 * obstacles alike, never to the sheet.
 */
export type ExpandFootprint = (rings: NestRing[], minimumGap: number) => NestRing[]

/**
 * The mirror of {@link ExpandFootprint} for holes: shrinks hole regions so that
 * a grown footprint lying inside a shrunk hole keeps at least `minimumGap`
 * between the original shape and the hole's edge.
 */
export type ShrinkHoles = (rings: NestRing[], minimumGap: number) => NestRing[]

export type OrderParts = (parts: NestPart[]) => NestPart[]

export interface NestRequest {
  /** Boundary every placed footprint must lie inside. Shrink it for an edge margin. */
  sheet: NestRing
  /** Fixed shapes to keep clear of: clamps, locked parts, originals kept in place. */
  obstacles: NestRing[]
  parts: NestPart[]
  /**
   * The required clearance, supplied by the caller (derived from the cutter).
   * The placer only hands it to `expandFootprint`; it holds no gap of its own.
   */
  minimumGap: number
  expandFootprint: ExpandFootprint
  /** Required when any part has holes; without holes it is never called. */
  shrinkHoles?: ShrinkHoles
  orderParts: OrderParts
  /**
   * The sheet corner parts pack toward: +1 prefers small coordinates, −1
   * large ones. Defaults to the min corner. Callers point it at the machine
   * origin, so the layout starts where the operator zeroes the machine.
   */
  gravity?: NestGravity
}

export interface NestGravity {
  x: 1 | -1
  y: 1 | -1
}

/** Maps a footprint point `p` to `rotate(p, rotation) + translation`. */
export interface NestPlacement {
  partId: string
  copyIndex: number
  rotation: number
  translation: Point
}

export interface NestUnplaced {
  partId: string
  count: number
}

export interface NestResult {
  placements: NestPlacement[]
  unplaced: NestUnplaced[]
}
