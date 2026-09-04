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
 * Arc-text placement gesture.
 *
 * An arc layout is placed the way a circle or a gear is: first click sets the
 * centre, the cursor sets the rest, second click commits. The preview and the
 * commit must agree exactly or the text jumps at the moment of the click, so
 * both call the one function here rather than each doing its own trigonometry.
 */

import type { Point, TextLayout } from '../types/project'
import { transformProfile } from '../geometry/profile'
import { normalizeAngleDegrees } from '../store/helpers/normalize'
import type { TextToolConfig } from '../text'

export type TextLayoutKind = TextLayout['kind']

/** Below this the arc degenerates and the run would wrap onto itself. */
export const MIN_ARC_RADIUS = 1e-3

export interface TextArcDrag {
  /** Centre of the circle — where the first click landed. */
  center: Point
  radius: number
  angleDegrees: number
  direction: 'cw' | 'ccw'
}

/**
 * Resolve the live drag state for an arc layout.
 *
 * The cursor sets the radius *and* the angle, so you drag to where the text
 * should sit rather than typing coordinates. Direction follows which side of
 * the centre the cursor is on — above gives `cw` (text over the top, upright),
 * below gives `ccw` (text under the bottom, still upright) — unless the user
 * has touched the panel's direction control, at which point their choice wins
 * and the cursor stops overriding it.
 */
export function resolveTextArcDrag(
  layout: Extract<TextLayout, { kind: 'arc' }>,
  center: Point,
  cursor: Point,
  directionPinned: boolean,
): TextArcDrag {
  const dx = cursor.x - center.x
  const dy = cursor.y - center.y
  const radius = Math.max(MIN_ARC_RADIUS, Math.hypot(dx, dy))
  const angleDegrees = normalizeAngleDegrees((Math.atan2(dy, dx) * 180) / Math.PI)
  const direction = directionPinned ? layout.direction : dy < 0 ? 'cw' : 'ccw'
  return { center, radius, angleDegrees, direction }
}

/**
 * The config and anchor to render (or commit) for an in-progress arc drag.
 *
 * The anchor is the circle's centre: template space puts the arc on the origin,
 * so translating the template by the centre lands the circle exactly where the
 * first click went.
 */
export function textArcDragPlacement(
  config: TextToolConfig,
  center: Point,
  cursor: Point,
  directionPinned: boolean,
): { config: TextToolConfig; anchor: Point } {
  const layout = config.layout
  if (layout?.kind !== 'arc') {
    return { config, anchor: center }
  }

  const drag = resolveTextArcDrag(layout, center, cursor, directionPinned)
  return {
    config: {
      ...config,
      layout: {
        ...layout,
        radius: drag.radius,
        angleDegrees: drag.angleDegrees,
        direction: drag.direction,
      },
    },
    anchor: drag.center,
  }
}

/** Sweep a fresh arc layout aims for, so the first preview reads as an arc. */
const DEFAULT_ARC_SWEEP_DEGREES = 120

/** 12 o'clock, in this app's clockwise-positive, Y-down angle convention. */
const TOP_OF_CIRCLE_DEGREES = 270

/** 6 o'clock, same convention. */
const BOTTOM_OF_CIRCLE_DEGREES = 90

/**
 * Where a run sits by default for each direction: `cw` writes across the top of
 * the circle, `ccw` across the bottom. Both read left to right — that is the
 * whole point of the pair, and it is why direction cannot be a bare travel sign.
 *
 * Reversing travel *without* moving the run leaves it at 12 o'clock reading
 * backwards, i.e. upside down, which is never what anyone wants from a control
 * labelled "counter-clockwise".
 */
export function anchorAngleForDirection(direction: 'cw' | 'ccw'): number {
  return direction === 'cw' ? TOP_OF_CIRCLE_DEGREES : BOTTOM_OF_CIRCLE_DEGREES
}

/**
 * The anchor angle to use when the user flips the direction control.
 *
 * Mirroring about the horizontal axis moves the run to the other half of the
 * circle — 270 (top) becomes 90 (bottom) — while keeping any left/right bias
 * the user dialled in, so a run nudged off-centre stays nudged the same way.
 */
export function mirrorAnchorAngleForDirection(angleDegrees: number): number {
  return normalizeAngleDegrees(-angleDegrees)
}

/**
 * Starting values for a layout the user just switched to.
 *
 * The arc radius is solved backwards from the run's own width so the initial
 * sweep is `DEFAULT_ARC_SWEEP_DEGREES` — a text-sized arc, not a hairline for
 * short text or a full ring for long text. The drag replaces it immediately;
 * this only has to look sane for the instant before the first click.
 */
export function createDefaultTextLayout(kind: TextLayoutKind, runWidth: number): TextLayout {
  if (kind === 'arc') {
    const sweepRadians = (DEFAULT_ARC_SWEEP_DEGREES * Math.PI) / 180
    return {
      kind: 'arc',
      // Placeholder until the centre is picked; the panel refuses to apply
      // without one, so this never reaches geometry.
      center: { x: 0, y: 0 },
      radius: Math.max(MIN_ARC_RADIUS, runWidth / sweepRadians),
      angleDegrees: anchorAngleForDirection('cw'),
      sweepDegrees: DEFAULT_ARC_SWEEP_DEGREES,
      anchor: 'center',
      fit: 'natural',
      direction: 'cw',
      orientation: 'follow',
    }
  }

  return {
    kind: 'path',
    // No guide yet. An empty profile measures to nothing, so the preview shows
    // the straight run until one is picked, rather than failing.
    path: { start: { x: 0, y: 0 }, segments: [], closed: false },
    startOffset: 0,
    endOffset: 0,
    anchor: 'center',
    fit: 'natural',
    reversed: false,
    orientation: 'follow',
  }
}

/**
 * The layout to store for a run, given what the user picked on the canvas.
 *
 * Everything picked on the canvas is world-space; the layout is stored
 * definition-local so the instance transform still places it. Preview and
 * commit both go through here, because when they each did their own version of
 * this conversion they agreed only for an untransformed run and the text jumped
 * on apply.
 */
export function localTextLayout(
  layout: TextLayout | null,
  worldCenter: Point | null,
  toLocal: (point: Point) => Point,
): TextLayout | null {
  if (!layout) return null
  if (layout.kind === 'arc') {
    return worldCenter ? { ...layout, center: toLocal(worldCenter) } : layout
  }
  return {
    ...layout,
    path: transformProfile(layout.path, toLocal),
  }
}

/**
 * The arc radius a picked centre implies for a run.
 *
 * Measured to the edge of the run **facing the centre** — its bottom when the
 * centre is below it, its top when the centre is above — so the radius is the
 * gap the user can already see between the run and whatever it is sitting next
 * to, and the run keeps that gap once it is bent.
 *
 * Deliberately independent of the direction. Measuring to the edge that ends up
 * on the curve seems right and is not: going anticlockwise the run attaches by
 * its top, but a run sitting *above* the circle has its top on the far side, so
 * that measured a full text-height too far and the text hung well below the
 * circle. The near edge is the one that defines the gap, whichever way the run
 * is later wrapped.
 */
export function arcRadiusForCenter(
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
  center: Point,
): number {
  const nearEdgeY = center.y > bounds.maxY
    ? bounds.maxY
    : center.y < bounds.minY
      ? bounds.minY
      : (bounds.minY + bounds.maxY) / 2
  return Math.hypot((bounds.minX + bounds.maxX) / 2 - center.x, nearEdgeY - center.y)
}
