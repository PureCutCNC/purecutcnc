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
 * Setup orientation (issue #944): the one place that knows how a machining
 * setup turns the stock.
 *
 * Two frames, both in project units and both Y-down like the rest of the
 * project model:
 *
 * - **canonical** — stock space, the frame features, `z_top`/`z_bottom` and
 *   generated toolpaths are stored in. Z runs from 0 at the stock's bottom
 *   face to `thickness` at its top face.
 * - **setup-local** — the same stock after the setup's turn, as it sits on the
 *   machine: the cutter approaches along local +Z and cuts toward local -Z,
 *   exactly as it does for Top.
 *
 * A setup's orientation is a rotation about a stock axis through the centre
 * of the stock at mid-thickness. A half turn about X maps
 * `(x, y, z) → (x, 2·cy − y, thickness − z)`: seen from above it is a mirror
 * across the flip axis, and the stock still occupies `[0, thickness]`, so the
 * machine origin's Z (the top of whichever face is up) does not move.
 *
 * The machine origin is one placement shared by every setup: `Project.origin`
 * is read in the setup-local frame, so an origin on the flip centreline stays
 * where it was and an off-centre one mirrors with the stock.
 *
 * Only 0° (Top) and 180° (Bottom) are accepted. The stored type is wider so
 * indexed 3+1 (#394) can add an angle without another format migration; until
 * then every entry point here refuses anything else rather than guess.
 */

import { getStockBounds } from '../types/project'
import type {
  MachineOrigin,
  MachiningSetup,
  Operation,
  Project,
  SetupFace,
  SetupOrientation,
  Stock,
} from '../types/project'

/** A point in either frame. Structurally a `ToolpathPoint`. */
export interface SetupPoint {
  x: number
  y: number
  z: number
}

/** True for the orientations this build can machine: 0° and 180° about X or Y. */
export function isSupportedSetupOrientation(orientation: SetupOrientation): boolean {
  return (orientation.axis === 'x' || orientation.axis === 'y')
    && (orientation.angleDeg === 0 || orientation.angleDeg === 180)
}

function assertSupported(orientation: SetupOrientation): void {
  if (!isSupportedSetupOrientation(orientation)) {
    throw new Error(
      `Unsupported setup orientation: ${orientation.angleDeg}° about ${String(orientation.axis)}. Only 0° and 180° about X or Y are supported.`,
    )
  }
}

/** The stock face a setup turns up. Derived from the orientation, never stored. */
export function setupFace(setup: Pick<MachiningSetup, 'orientation'>): SetupFace {
  assertSupported(setup.orientation)
  return setup.orientation.angleDeg === 0 ? 'top' : 'bottom'
}

/** The orientation that turns `face` up; `axis` is the flip axis for Bottom. */
export function orientationForFace(face: SetupFace, axis: SetupOrientation['axis'] = 'x'): SetupOrientation {
  return { axis, angleDeg: face === 'top' ? 0 : 180 }
}

/**
 * The turn about its pivot, resolved once per stock so transforming a
 * toolpath does not re-measure the stock for every point.
 */
export interface SetupFrame {
  readonly orientation: SetupOrientation
  /** Centre of the stock in XY, at mid-thickness. */
  readonly pivot: SetupPoint
}

/** The point every setup turns about: derived from the stock, not stored. */
export function setupPivot(stock: Stock): SetupPoint {
  const bounds = getStockBounds(stock)
  return {
    x: (bounds.minX + bounds.maxX) / 2,
    y: (bounds.minY + bounds.maxY) / 2,
    z: stock.thickness / 2,
  }
}

export function setupFrame(orientation: SetupOrientation, stock: Stock): SetupFrame {
  assertSupported(orientation)
  return { orientation: { ...orientation }, pivot: setupPivot(stock) }
}

/**
 * A half turn about an axis through the pivot reflects the other two
 * coordinates through it. Written as a reflection rather than with sin/cos so
 * the result is exact, and the coordinate along the axis passes through
 * untouched.
 */
function halfTurn(point: SetupPoint, frame: SetupFrame): SetupPoint {
  const { pivot } = frame
  return frame.orientation.axis === 'x'
    ? { x: point.x, y: 2 * pivot.y - point.y, z: 2 * pivot.z - point.z }
    : { x: 2 * pivot.x - point.x, y: point.y, z: 2 * pivot.z - point.z }
}

/**
 * Canonical stock point → setup-local point. At 0° the point is returned
 * as-is — the same object, no arithmetic — so Top output cannot differ from
 * what it was before setups existed.
 */
export function canonicalToSetupPoint(point: SetupPoint, frame: SetupFrame): SetupPoint {
  assertSupported(frame.orientation)
  return frame.orientation.angleDeg === 0 ? point : halfTurn(point, frame)
}

/** Setup-local point → canonical stock point. The inverse of {@link canonicalToSetupPoint}. */
export function setupToCanonicalPoint(point: SetupPoint, frame: SetupFrame): SetupPoint {
  assertSupported(frame.orientation)
  // A half turn undoes itself.
  return frame.orientation.angleDeg === 0 ? point : halfTurn(point, frame)
}

/**
 * Whether the turn reverses the sense of an XY arc. Seen from above a half
 * turn is a mirror, so a clockwise arc in stock space is counter-clockwise on
 * the machine.
 */
export function setupFlipsArcDirection(orientation: SetupOrientation): boolean {
  assertSupported(orientation)
  return orientation.angleDeg === 180
}

/**
 * Where the shared machine origin lands in stock space for a setup. The
 * origin is placed relative to the face that is up, so this is the setup-local
 * origin position carried back into the canonical frame: unchanged for Top,
 * mirrored across the flip axis for Bottom, and on the opposite stock face.
 */
export function setupOriginInCanonical(origin: MachineOrigin, frame: SetupFrame): SetupPoint {
  return setupToCanonicalPoint({ x: origin.x, y: origin.y, z: origin.z }, frame)
}

/**
 * The setup an operation is cut in. An operation without a `setupId` is a
 * hand-built or pre-setup one and reads as Top (null). A `setupId` that names
 * no setup is an error: exporting it as Top would cut the wrong face.
 */
export function setupForOperation(
  project: Pick<Project, 'setups'>,
  operation: Pick<Operation, 'id' | 'setupId'>,
): MachiningSetup | null {
  if (operation.setupId === undefined) return null
  const setup = project.setups?.find((entry) => entry.id === operation.setupId)
  if (!setup) {
    throw new Error(`Operation ${operation.id} belongs to setup ${operation.setupId}, which does not exist.`)
  }
  return setup
}

/**
 * The frame an operation's canonical toolpath is turned through on its way to
 * machine coordinates, or undefined for a Top operation — callers then take
 * the unturned path.
 */
export function setupFrameForOperation(
  project: Pick<Project, 'setups' | 'stock'>,
  operation: Pick<Operation, 'id' | 'setupId'>,
): SetupFrame | undefined {
  const setup = setupForOperation(project, operation)
  if (!setup) return undefined
  assertSupported(setup.orientation)
  return setup.orientation.angleDeg === 0 ? undefined : setupFrame(setup.orientation, project.stock)
}

// ── Face-local depth ──────────────────────────────────────────

/** A feature's stock-space Z span, with any dimension references resolved. */
export interface StockZSpan {
  z_top: number
  z_bottom: number
}

/**
 * The same span measured inward from a stock face. `start` is the distance to
 * the near side of the feature and `end` to the far side: a feature that
 * opens at the face has `start` 0, one floating inside the stock has
 * `start` > 0, and one standing proud of the face has `start` < 0.
 */
export interface FaceDepthSpan {
  start: number
  end: number
}

/**
 * A stock-space span as depths from `face`. A view only: it returns a new
 * object and the stored `z_top`/`z_bottom` stay the volumetric truth.
 *
 * Converting there and back is exact for Bottom and exact up to
 * floating-point rounding for Top (`thickness − (thickness − z)`), so a
 * caller must write back only a value the user actually changed.
 */
export function depthFromFace(span: StockZSpan, face: SetupFace, stock: Pick<Stock, 'thickness'>): FaceDepthSpan {
  return face === 'top'
    ? { start: stock.thickness - span.z_top, end: stock.thickness - span.z_bottom }
    : { start: span.z_bottom, end: span.z_top }
}

/**
 * Depths from `face` back to the stock-space span. Returns null when the
 * depths are not finite or `end` lies nearer the face than `start`: the two
 * are never swapped to make a span fit.
 */
export function spanFromFaceDepth(
  depth: FaceDepthSpan,
  face: SetupFace,
  stock: Pick<Stock, 'thickness'>,
): StockZSpan | null {
  if (!Number.isFinite(depth.start) || !Number.isFinite(depth.end) || depth.end < depth.start) return null
  return face === 'top'
    ? { z_top: stock.thickness - depth.start, z_bottom: stock.thickness - depth.end }
    : { z_top: depth.end, z_bottom: depth.start }
}
