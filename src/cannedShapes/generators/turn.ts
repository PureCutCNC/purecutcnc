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
 * Turn as a canned model (issue #1112 slice G).
 *
 * One model on a round bar or a square blank: the finished cylinder of the
 * requested diameter over the requested band, with no operation and no folder.
 * The geometry comes from the same `buildRotaryCylinderMesh` the old
 * square-to-round command used, so a Turn on a square blank cuts what Square to
 * round cut; on a round bar the same builder emits the cylinder inside the bar.
 *
 * The stored parameters are the dialog's numbers plus the bar snapshot the
 * shape was drawn against (`rotarySolidParams.ts`). The segment count is stored
 * too, so a unit conversion keeps the tessellation the diameter was authored
 * with instead of re-deriving it from the new unit's sagitta.
 *
 * A Turn may also carry a copied side profile (decision 11, `turnProfile.ts`).
 * With one, the mesh is the profile revolved about the bar axis instead of the
 * plain cylinder; the profile copy is authoritative, so editing or deleting the
 * drawn source cannot change the Turn. Without one, everything below is
 * exactly the plain-diameter behaviour slice G shipped.
 */

import {
  ROTARY_CYLINDER_MAX_SEGMENTS,
  ROTARY_CYLINDER_MIN_SEGMENTS,
  buildRotaryCylinderMesh,
} from '../../engine/rotaryCylinderMesh'
import { buildRotaryRevolveMesh } from '../../engine/rotaryRevolve'
import { computeMeshBounds } from '../../engine/importedMesh'
import { rectProfile, type CannedShapeParams } from '../../types/project'
import { defineCannedShape } from '../types'
import { TURN_CANNED_KIND } from './kinds'
import { hasFiniteNumbers } from './rotaryPatternParams'
import {
  ROTARY_SOLID_TOLERANCE,
  cloneStoredRotarySolidFrame,
  convertStoredRotarySolidFrame,
  rotarySolidAlong,
  rotarySolidBandProblem,
  rotarySolidFrameStock,
  storedSolidFrameOf,
  type RotarySolidFrame,
} from './rotarySolidParams'
import {
  convertTurnCannedProfile,
  normalizeTurnCannedProfile,
  turnProfileBand,
  turnProfileProblem,
  type TurnCannedProfile,
} from './turnProfile'

/** Stored parameters: the dialog's set plus the bar snapshot. */
export type TurnCannedParams = CannedShapeParams & {
  start: number
  length: number
  diameter: number
  /** Ring vertex count, chosen from the diameter and project units once. */
  segments: number
  frame: RotarySolidFrame
  /** A copied side profile, revolved about the bar axis. Absent = a cylinder. */
  profile?: TurnCannedProfile
}

function isTurnCannedParams(raw: CannedShapeParams): raw is TurnCannedParams {
  return hasFiniteNumbers(raw, ['start', 'length', 'diameter', 'segments'])
    && storedSolidFrameOf(raw) !== null
}

/**
 * Validate and normalize stored parameters. Returns `null` for a parameter set
 * the old command would have refused, so a corrupt file cannot make the shape
 * silently draw a different solid.
 */
export function normalizeTurnCannedParams(raw: CannedShapeParams): TurnCannedParams | null {
  if (!isTurnCannedParams(raw)) return null
  const frame = storedSolidFrameOf(raw)
  if (!frame) return null
  const { segments } = raw
  let { start, length, diameter } = raw

  let profile: TurnCannedProfile | undefined
  if (raw.profile !== undefined && raw.profile !== null) {
    const normalized = normalizeTurnCannedProfile(raw.profile, frame)
    if (!normalized) return null
    profile = normalized
    // The profile is the geometry: its own extent and widest radius are the
    // start/length/diameter the summary and older readers see.
    const band = turnProfileBand(frame, normalized)
    start = band.start
    length = band.length
    diameter = band.diameter
    if (turnProfileProblem(normalized, frame) !== null) return null
  }

  if (diameter <= 0 || diameter > frame.thickness + ROTARY_SOLID_TOLERANCE) return null
  if (!Number.isInteger(segments)
    || segments < ROTARY_CYLINDER_MIN_SEGMENTS
    || segments > ROTARY_CYLINDER_MAX_SEGMENTS) return null
  if (rotarySolidBandProblem(frame, start, length) !== null) return null
  return {
    start,
    length,
    diameter,
    segments,
    frame: cloneStoredRotarySolidFrame(frame),
    ...(profile ? { profile } : {}),
  } as unknown as TurnCannedParams
}

function buildTurnMesh(params: TurnCannedParams) {
  if (params.profile) {
    const mesh = buildRotaryRevolveMesh(
      rotarySolidFrameStock(params.frame),
      params.profile.contours,
      params.segments,
    )
    const bounds = computeMeshBounds(mesh.positions)
    return { positions: mesh.positions, index: mesh.indices, bounds }
  }
  const { alongStart, alongEnd } = rotarySolidAlong(params.frame, params.start, params.length)
  return buildRotaryCylinderMesh(
    rotarySolidFrameStock(params.frame),
    { diameter: params.diameter, alongStart, alongEnd },
    params.segments,
  )
}

export const turnCannedShape = defineCannedShape<TurnCannedParams>({
  kind: TURN_CANNED_KIND,
  labelKey: 'canned.turn.name',
  // A model has no outlines of its own: its mesh is the output. The rectangle
  // is the placement frame Properties, selection bounds and export read.
  generate: (params) => {
    try {
      const mesh = buildTurnMesh(params)
      return [{
        profile: rectProfile(
          mesh.bounds.minX,
          mesh.bounds.minY,
          mesh.bounds.maxX - mesh.bounds.minX,
          mesh.bounds.maxY - mesh.bounds.minY,
        ),
        name: 'Turn',
      }]
    } catch {
      return []
    }
  },
  generateMesh: (params) => {
    try {
      const mesh = buildTurnMesh(params)
      return { positions: mesh.positions, indices: mesh.index }
    } catch {
      return null
    }
  },
  // The mesh is the output; expansion would freeze it and lose the parameters.
  capabilities: { expandable: false },
  // A rotary solid stays centred on the bar's pivot when its size changes.
  modelZAnchor: 'center',
  normalizeParams: normalizeTurnCannedParams,
  convertParams: (params, convertLength): TurnCannedParams => ({
    ...params,
    start: convertLength(params.start),
    length: convertLength(params.length),
    diameter: convertLength(params.diameter),
    frame: convertStoredRotarySolidFrame(params.frame, convertLength),
    ...(params.profile ? { profile: convertTurnCannedProfile(params.profile, convertLength) } : {}),
  }) as unknown as TurnCannedParams,
  summary: (params) => ({
    key: 'canned.turn.summary',
    values: {
      start: Math.round(params.start * 10000) / 10000,
      length: Math.round(params.length * 10000) / 10000,
      diameter: Math.round(params.diameter * 10000) / 10000,
    },
  }),
})

