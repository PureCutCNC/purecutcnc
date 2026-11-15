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
 * From what the detector found to what can be drawn (issue #1206 slices 2 and
 * 3).
 *
 * A candidate is one feature the user may add: an add for a solid, a subtract
 * for a cavity, an add for a boss standing in one. Its numbers are rounded
 * here, once, so the value shown in the list is the value stored in the
 * project.
 *
 * Solids come before the cavities, in the detector's own order: the tree folds
 * its features in order, so an add is in place before the subtracts that carve
 * it.
 *
 * `markAlreadyDrawn` is what makes a second run safe: a candidate that matches
 * a feature already in the project — same face, same operation, same span,
 * same outline — is flagged, and the dialog leaves it unchecked.
 */

import type { FlatFace, Point, Segment, SketchProfile } from '../../types/project'
import { circleProfile } from '../../types/project'
import { flattenProfile } from '../toolpaths/geometry'
import { intersectionArea, pathArea, toPath } from './sections'
import type { CavityBottom, ModelRecognitionResult, RecognizedCircle } from './types'

export type CandidateKind = 'solid' | 'throughHole' | 'blindHole' | 'throughPocket' | 'pocket' | 'island'

export interface RecognitionCandidate {
  /** Stable within one run: `s3` for a solid, `c3`, or `c3.i0` for an island of `c3`. */
  id: string
  /** The cavity an island stands in, or null. An island is only drawn with its parent. */
  parentId: string | null
  face: FlatFace
  kind: CandidateKind
  operation: 'subtract' | 'add'
  profile: SketchProfile
  /** The outline as a polygon, for previews and area comparison. */
  outline: Point[]
  circle: RecognizedCircle | null
  zTop: number
  zBottom: number
  /** What a cavity's walls end on; null for an island. */
  bottom: CavityBottom | null
  flaredAbove: boolean
  alreadyDrawn: boolean
}

/** Stored lengths keep this many decimals: a tenth of a micron, in either unit. */
function roundingStep(units: 'mm' | 'inch'): number {
  return units === 'mm' ? 1e-4 : 1e-5
}

function roundTo(value: number, step: number): number {
  const rounded = Math.round(value / step) * step
  // Clear the binary tail the multiplication leaves (12.000000000000002).
  return Number(rounded.toFixed(6)) + 0
}

function roundPoint(point: Point, step: number): Point {
  return { x: roundTo(point.x, step), y: roundTo(point.y, step) }
}

function roundSegment(segment: Segment, step: number): Segment {
  switch (segment.type) {
    case 'line':
      return { type: 'line', to: roundPoint(segment.to, step) }
    case 'arc':
      return { ...segment, to: roundPoint(segment.to, step), center: roundPoint(segment.center, step) }
    case 'circle':
      return { ...segment, to: roundPoint(segment.to, step), center: roundPoint(segment.center, step) }
    case 'bezier':
      return {
        ...segment,
        to: roundPoint(segment.to, step),
        control1: roundPoint(segment.control1, step),
        control2: roundPoint(segment.control2, step),
      }
  }
}

function roundedShape(
  profile: SketchProfile,
  circle: RecognizedCircle | null,
  step: number,
): { profile: SketchProfile; circle: RecognizedCircle | null } {
  if (circle) {
    const rounded = { center: roundPoint(circle.center, step), radius: roundTo(circle.radius, step) }
    return { profile: circleProfile(rounded.center.x, rounded.center.y, rounded.radius), circle: rounded }
  }
  return {
    profile: {
      start: roundPoint(profile.start, step),
      segments: profile.segments.map((segment) => roundSegment(segment, step)),
      closed: profile.closed,
    },
    circle: null,
  }
}

function cavityKind(round: boolean, bottom: CavityBottom): CandidateKind {
  if (bottom === 'through') return round ? 'throughHole' : 'throughPocket'
  return round ? 'blindHole' : 'pocket'
}

/**
 * Flattens a detector result into drawable candidates, in the order they
 * should sit in the tree: the solids first — the material the cavities are cut
 * out of — then each cavity followed by its islands.
 *
 * `idPrefix` goes in front of every id (issue #1206 slice 4). The look from
 * below is a second run over the same part, so its ids are `b-s0`, `b-c0`,
 * `b-c0.i0`: distinct in one list, and the face readable off the row itself.
 */
export function candidatesFromResult(
  result: ModelRecognitionResult,
  face: FlatFace,
  units: 'mm' | 'inch',
  idPrefix = '',
): RecognitionCandidate[] {
  const step = roundingStep(units)
  const candidates: RecognitionCandidate[] = []
  result.solids.forEach((solid, solidIndex) => {
    candidates.push({
      id: `${idPrefix}s${solidIndex}`,
      parentId: null,
      face,
      kind: 'solid',
      operation: 'add',
      ...roundedShape(solid.profile, solid.circle, step),
      outline: solid.outline,
      zTop: roundTo(solid.zTop, step),
      zBottom: roundTo(solid.zBottom, step),
      bottom: null,
      flaredAbove: false,
      alreadyDrawn: false,
    })
  })
  result.cavities.forEach((cavity, cavityIndex) => {
    const id = `${idPrefix}c${cavityIndex}`
    candidates.push({
      id,
      parentId: null,
      face,
      kind: cavityKind(cavity.circle !== null, cavity.bottom),
      operation: 'subtract',
      ...roundedShape(cavity.profile, cavity.circle, step),
      outline: cavity.outline,
      zTop: roundTo(cavity.zTop, step),
      zBottom: roundTo(cavity.zBottom, step),
      bottom: cavity.bottom,
      flaredAbove: cavity.flaredAbove,
      alreadyDrawn: false,
    })
    cavity.islands.forEach((island, islandIndex) => {
      candidates.push({
        id: `${id}.i${islandIndex}`,
        parentId: id,
        face,
        kind: 'island',
        operation: 'add',
        ...roundedShape(island.profile, island.circle, step),
        outline: island.outline,
        zTop: roundTo(island.zTop, step),
        zBottom: roundTo(island.zBottom, step),
        bottom: null,
        flaredAbove: false,
        alreadyDrawn: false,
      })
    })
  })
  return candidates
}

/** A feature already in the project, as far as the comparison needs it. */
export interface DrawnFeature {
  face: FlatFace | 'around'
  operation: string
  profile: SketchProfile
  zTop: number
  zBottom: number
}

/**
 * Two outlines are the same shape when the area they do not share is under
 * this fraction of the smaller one. Loose enough for a circle flattened two
 * ways, far too tight for a hole a different size.
 */
const SAME_OUTLINE_AREA_FRACTION = 0.01
/** Spans agree within this fraction of the candidate's own depth. */
const SAME_SPAN_FRACTION = 1e-3

export function sameOutline(a: SketchProfile, b: SketchProfile): boolean {
  const pathA = toPath(flattenProfile(a).points)
  const pathB = toPath(flattenProfile(b).points)
  if (pathA.length < 3 || pathB.length < 3) return false
  const areaA = pathArea(pathA)
  const areaB = pathArea(pathB)
  const smaller = Math.min(areaA, areaB)
  if (!(smaller > 0)) return false
  const shared = intersectionArea([pathA], [pathB])
  return areaA + areaB - shared * 2 <= smaller * SAME_OUTLINE_AREA_FRACTION
}

/**
 * Whether two Z spans are the same span. The first argument sets the scale: a
 * depth has to agree to within a fraction of its own size, so the same void
 * found from both faces compares equal and a pocket the user made deeper does
 * not.
 */
export function sameSpan(
  a: { zTop: number; zBottom: number },
  b: { zTop: number; zBottom: number },
): boolean {
  const slack = Math.abs(a.zTop - a.zBottom) * SAME_SPAN_FRACTION
  return Math.abs(a.zTop - b.zTop) <= slack && Math.abs(a.zBottom - b.zBottom) <= slack
}

export function markAlreadyDrawn(
  candidates: readonly RecognitionCandidate[],
  drawn: readonly DrawnFeature[],
): RecognitionCandidate[] {
  return candidates.map((candidate) => {
    const alreadyDrawn = drawn.some((feature) => (
      feature.face === candidate.face
      && feature.operation === candidate.operation
      && sameSpan(candidate, feature)
      && feature.profile.closed
      && sameOutline(feature.profile, candidate.profile)
    ))
    return { ...candidate, alreadyDrawn }
  })
}
