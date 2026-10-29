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
 * Polygon as a canned model (issue #1112 slice G).
 *
 * One model on a round bar or a square blank: a regular prism of the requested
 * across-flats size over the requested band, with no operation and no folder.
 * The geometry comes from the same `buildRotaryPolygonPrism` the old
 * Polygon/hex command used, so the canned model cuts what that model cut.
 *
 * The stored parameters are the dialog's numbers plus the bar snapshot the
 * shape was drawn against (`rotarySolidParams.ts`).
 */

import { buildRotaryPolygonPrism, rotaryPolygonCrossSection } from '../../engine/rotaryPrism'
import { rectProfile, type CannedShapeParams, type SketchProfile } from '../../types/project'
import { defineCannedShape } from '../types'
import { POLYGON_CANNED_KIND } from './kinds'
import { hasFiniteNumbers } from './rotaryPatternParams'
import {
  ROTARY_SOLID_TOLERANCE,
  cloneStoredRotarySolidFrame,
  convertStoredRotarySolidFrame,
  rotarySolidAlong,
  rotarySolidBandProblem,
  rotarySolidFrameStock,
  rotarySolidSideViewRect,
  storedSolidFrameOf,
  type RotarySolidFrame,
} from './rotarySolidParams'

/** Most polygon sides the generator accepts, matching `buildRotaryPolygonPrism`. */
export const MAX_POLYGON_SIDES = 64

/** Stored parameters: the dialog's set plus the bar snapshot. */
export type PolygonCannedParams = CannedShapeParams & {
  start: number
  length: number
  sides: number
  /** Twice the polygon's apothem (across-flats). */
  acrossFlats: number
  /** Rotation about the bar's axis in degrees; 0 puts a flat up. */
  rotation: number
  frame: RotarySolidFrame
}

function isPolygonCannedParams(raw: CannedShapeParams): raw is PolygonCannedParams {
  return hasFiniteNumbers(raw, ['start', 'length', 'sides', 'acrossFlats', 'rotation'])
    && storedSolidFrameOf(raw) !== null
}

/**
 * Validate and normalize stored parameters. Returns `null` for a parameter set
 * the old command would have refused, so a corrupt file cannot make the shape
 * silently draw a different solid.
 */
export function normalizePolygonCannedParams(raw: CannedShapeParams): PolygonCannedParams | null {
  if (!isPolygonCannedParams(raw)) return null
  const frame = storedSolidFrameOf(raw)
  if (!frame) return null
  const { start, length, sides, acrossFlats, rotation } = raw
  if (!Number.isInteger(sides) || sides < 3 || sides > MAX_POLYGON_SIDES) return null
  if (acrossFlats <= 0) return null
  const acrossCorners = acrossFlats / Math.cos(Math.PI / sides)
  if (acrossCorners > frame.thickness + ROTARY_SOLID_TOLERANCE) return null
  if (rotarySolidBandProblem(frame, start, length) !== null) return null
  return {
    start,
    length,
    sides,
    acrossFlats,
    rotation,
    frame: cloneStoredRotarySolidFrame(frame),
  } as unknown as PolygonCannedParams
}

function buildPolygonMesh(params: PolygonCannedParams) {
  const { alongStart, alongEnd } = rotarySolidAlong(params.frame, params.start, params.length)
  return buildRotaryPolygonPrism(rotarySolidFrameStock(params.frame), {
    sides: params.sides,
    acrossFlats: params.acrossFlats,
    rotationDeg: params.rotation,
    alongStart,
    alongEnd,
  })
}

/**
 * The Polygon's side view in stock XY, on Top or Bottom (issue #1112 rt2-d).
 *
 * A prism projects onto a rectangle whose width across the bar is the
 * cross-section's own extent on that direction — the across-corners width with
 * a corner across, the across-flats width with a flat across — so the stored
 * rotation decides it. The cross-section is the prism builder's, not a second
 * copy of its rotation convention.
 */
export function polygonSideViewProfiles(params: PolygonCannedParams): SketchProfile[] {
  const frame = params.frame
  const cross = rotaryPolygonCrossSection({
    sides: params.sides,
    acrossFlats: params.acrossFlats,
    rotationDeg: params.rotation,
  })
  const halfWidth = Math.max(...cross.map((point) => Math.abs(point.across)))
  const { alongStart, alongEnd } = rotarySolidAlong(frame, params.start, params.length)
  const rect = rotarySolidSideViewRect(frame, alongStart, alongEnd, halfWidth)
  return [rectProfile(rect.x, rect.y, rect.width, rect.height)]
}

export const polygonCannedShape = defineCannedShape<PolygonCannedParams>({
  kind: POLYGON_CANNED_KIND,
  labelKey: 'canned.polygon.name',
  // A model has no sketch outlines: its mesh is the output. The outline is the
  // model's side view — the silhouette a flat face draws (issue #1112 rt2-d) —
  // whose bounds are also the placement frame Properties, selection and export
  // read.
  generate: (params) => {
    try {
      return polygonSideViewProfiles(params).map((profile) => ({ profile, name: 'Polygon' }))
    } catch {
      return []
    }
  },
  generateMesh: (params) => {
    try {
      const mesh = buildPolygonMesh(params)
      return { positions: mesh.positions, indices: mesh.index }
    } catch {
      return null
    }
  },
  capabilities: { expandable: false },
  // A rotary solid stays centred on the bar's pivot when its size changes.
  modelZAnchor: 'center',
  normalizeParams: normalizePolygonCannedParams,
  convertParams: (params, convertLength): PolygonCannedParams => ({
    ...params,
    start: convertLength(params.start),
    length: convertLength(params.length),
    acrossFlats: convertLength(params.acrossFlats),
    frame: convertStoredRotarySolidFrame(params.frame, convertLength),
  }) as unknown as PolygonCannedParams,
  summary: (params) => ({
    key: 'canned.polygon.summary',
    values: {
      start: Math.round(params.start * 10000) / 10000,
      length: Math.round(params.length * 10000) / 10000,
      sides: params.sides,
      acrossFlats: Math.round(params.acrossFlats * 10000) / 10000,
      rotation: Math.round(params.rotation * 10000) / 10000,
    },
  }),
})
