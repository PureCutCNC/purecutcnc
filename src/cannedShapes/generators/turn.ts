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
import { polygonProfile, rectProfile, type CannedShapeParams, type SketchProfile } from '../../types/project'
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
  rotarySolidSideViewPoint,
  rotarySolidSideViewRect,
  storedSolidFrameOf,
  type RotarySolidFrame,
} from './rotarySolidParams'
import {
  TURN_PROFILE_TOLERANCE,
  convertTurnCannedProfile,
  normalizeTurnCannedProfile,
  turnProfileBand,
  turnProfileProblem,
  type TurnCannedProfile,
  type TurnProfileContour,
  type TurnProfilePoint,
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

/** `points` with every radius flipped to the other side of the bar's axis. */
function mirroredAcrossAxis(points: readonly TurnProfilePoint[]): TurnProfilePoint[] {
  return points.map((point) => ({ along: point.along, radius: -point.radius }))
}

function samePoint(a: TurnProfilePoint, b: TurnProfilePoint): boolean {
  return Math.abs(a.along - b.along) <= TURN_PROFILE_TOLERANCE
    && Math.abs(a.radius - b.radius) <= TURN_PROFILE_TOLERANCE
}

/** Drop a repeated vertex and a last point that repeats the first. */
function closedLoop(points: readonly TurnProfilePoint[]): TurnProfilePoint[] {
  const loop: TurnProfilePoint[] = []
  for (const point of points) {
    const previous = loop[loop.length - 1]
    if (previous && samePoint(previous, point)) continue
    loop.push(point)
  }
  const first = loop[0]
  const last = loop[loop.length - 1]
  if (loop.length > 1 && first && last && samePoint(first, last)) loop.pop()
  return loop
}

/**
 * A contour's own points as the polygon the side view mirrors: the radius
 * clamped the way the revolve builder clamps it, repeated vertices dropped,
 * and nothing added.
 *
 * In particular an open half-profile is **not** closed onto the axis here. The
 * revolve builder does that because the mesh needs a closed region; on the
 * side view the axis segment is inside the mirrored solid, so joining the two
 * halves would draw it as a centerline through the material.
 */
function contourSideViewPolygon(contour: TurnProfileContour): TurnProfilePoint[] {
  return closedLoop(contour.points.map((point) => ({
    along: point.along,
    radius: point.radius <= TURN_PROFILE_TOLERANCE ? 0 : point.radius,
  })))
}

/** True when `a`→`b` runs along the bar's axis, inside the mirrored solid. */
function isAxisEdge(a: TurnProfilePoint, b: TurnProfilePoint): boolean {
  return Math.abs(a.radius) <= TURN_PROFILE_TOLERANCE
    && Math.abs(b.radius) <= TURN_PROFILE_TOLERANCE
}

/**
 * One chain of a closed outline joined to its own mirror: the drawn chain
 * forward, then the mirrored chain back. Both ends are on the axis, where the
 * chain and its mirror meet, so the chain's own endpoints are not repeated.
 */
function joinedAxisChainLoop(chain: readonly TurnProfilePoint[]): TurnProfilePoint[] {
  const mirrored = mirroredAcrossAxis(chain).reverse()
  return closedLoop([...chain, ...mirrored.slice(1, -1)])
}

/**
 * A closed outline that touches the axis, as the silhouette loops of the
 * region it and its mirror fill.
 *
 * The region and its mirror share every edge that runs along the axis, so
 * joining them vertex for vertex would draw that edge twice — a centerline
 * through the material. Instead the outline's axis edges are cut out and each
 * remaining chain is closed through its mirror image, which is the region's
 * boundary seen from a flat face. Returns no loop when the outline has no axis
 * edge (it only touches the axis at a vertex), leaving the caller its plain
 * join.
 */
function closedContourAxisLoops(polygon: readonly TurnProfilePoint[]): TurnProfilePoint[][] {
  const count = polygon.length
  const onAxis = (point: TurnProfilePoint | undefined): boolean => point !== undefined
    && Math.abs(point.radius) <= TURN_PROFILE_TOLERANCE
  let axisEdge = -1
  for (let index = 0; index < count; index += 1) {
    if (onAxis(polygon[index]) && onAxis(polygon[(index + 1) % count])) {
      axisEdge = index
      break
    }
  }
  if (axisEdge < 0) return []

  const loops: TurnProfilePoint[][] = []
  let chain: TurnProfilePoint[] = []
  // Walk from just after a known axis edge, so every chain starts where an axis
  // edge ends and finishes where the next one begins.
  for (let offset = 0; offset < count; offset += 1) {
    const index = (axisEdge + 1 + offset) % count
    const from = polygon[index]
    const to = polygon[(index + 1) % count]
    if (!from || !to) continue
    if (isAxisEdge(from, to)) {
      chain = []
      continue
    }
    if (chain.length === 0) chain.push(from)
    chain.push(to)
    const after = polygon[(index + 2) % count]
    if (!after || isAxisEdge(to, after)) {
      if (chain.length >= 3) loops.push(joinedAxisChainLoop(chain))
      chain = []
    }
  }
  return loops
}

/**
 * One profile contour as the loops of the Turn's side view: the contour
 * mirrored about the bar's axis.
 *
 * An outline that reaches the axis is the half-profile of a solid of
 * revolution, so it becomes **one** loop — the drawn side, then its mirror
 * back — which is the solid's silhouette seen from a flat face. A closed
 * outline away from the axis (a ring or a groove) keeps its own loop and gets
 * its mirror as a second one. A closed outline that touches the axis shares
 * that edge with its mirror, so the edge is cut out and the halves are joined
 * without it.
 */
function mirroredContourLoops(contour: TurnProfileContour): TurnProfilePoint[][] {
  const polygon = contourSideViewPolygon(contour)
  if (polygon.length < 2) return []
  const touchesAxis = polygon.some((point) => point.radius <= TURN_PROFILE_TOLERANCE)
  if (contour.closed && !touchesAxis) {
    return [polygon, mirroredAcrossAxis(polygon)]
  }
  if (contour.closed) {
    const loops = closedContourAxisLoops(polygon)
    if (loops.length > 0) return loops
  }
  return [closedLoop([...polygon, ...mirroredAcrossAxis(polygon).reverse()])]
}

/**
 * The Turn's side view in stock XY, on Top or Bottom (issue #1112 rt2-d).
 *
 * A turned solid is symmetric about the bar's axis, so its side view is its
 * profile mirrored about that axis over the band it covers — a rectangle for
 * the plain cylinder. This is the exact silhouette, unlike the model's
 * bounding rectangle, which is all a stepped profile would otherwise show.
 */
export function turnSideViewProfiles(params: TurnCannedParams): SketchProfile[] {
  const frame = params.frame
  if (!params.profile) {
    const { alongStart, alongEnd } = rotarySolidAlong(frame, params.start, params.length)
    const rect = rotarySolidSideViewRect(frame, alongStart, alongEnd, params.diameter / 2)
    return [rectProfile(rect.x, rect.y, rect.width, rect.height)]
  }
  const profiles: SketchProfile[] = []
  for (const contour of params.profile.contours) {
    for (const loop of mirroredContourLoops(contour)) {
      if (loop.length < 3) continue
      profiles.push(polygonProfile(loop.map((point) => rotarySolidSideViewPoint(frame, point.along, point.radius))))
    }
  }
  return profiles
}

export const turnCannedShape = defineCannedShape<TurnCannedParams>({
  kind: TURN_CANNED_KIND,
  labelKey: 'canned.turn.name',
  // A model has no sketch outlines: its mesh is the output. The outline is the
  // model's side view — the silhouette a flat face draws (issue #1112 rt2-d) —
  // whose bounds are also the placement frame Properties, selection and export
  // read.
  generate: (params) => {
    try {
      return turnSideViewProfiles(params).map((profile) => ({ profile, name: 'Turn' }))
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

