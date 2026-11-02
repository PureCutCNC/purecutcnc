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
 * Flutes as a canned shape (issue #1112 slice F).
 *
 * One feature draws every flute as an open `line`. The dialog keeps its
 * Direction control: `twist` is stored signed, positive right-hand and
 * negative left-hand, and zero is straight. The geometry comes from the same
 * `buildRotaryPatternLines` the pre-canned command used, so a Follow line
 * operation on the feature cuts the lines that command's operation cut.
 */

import type { CannedShapeParams, SketchProfile } from '../../types/project'
import {
  buildRotaryPatternLines,
  rotarySheetPoint,
  type RotaryPatternFrame,
} from '../../engine/rotaryPatterns'
import { defineCannedShape, type CannedShapeOutline } from '../types'
import { FLUTES_CANNED_KIND } from './kinds'
import {
  cloneStoredRotaryPatternFrame,
  convertStoredRotaryPatternFrame,
  hasFiniteNumbers,
  storedFrameOf,
} from './rotaryPatternParams'

/** Stored parameters: the dialog's set plus the frame snapshot. */
export type FlutesCannedParams = CannedShapeParams & {
  start: number
  length: number
  count: number
  /** Signed turns of twist over the length: positive right-hand, negative left. */
  twist: number
  depth: number
  frame: RotaryPatternFrame
}

function isFlutesCannedParams(raw: CannedShapeParams): raw is FlutesCannedParams {
  return hasFiniteNumbers(raw, ['start', 'length', 'count', 'twist', 'depth'])
    && storedFrameOf(raw) !== null
}

/**
 * Validate and normalize stored parameters. Returns `null` for a parameter set
 * the old line builder would have refused, so a corrupt file cannot make the
 * shape silently draw something different.
 */
export function normalizeFlutesCannedParams(raw: CannedShapeParams): FlutesCannedParams | null {
  if (!isFlutesCannedParams(raw)) return null
  const frame = storedFrameOf(raw)
  if (!frame) return null
  const built = buildRotaryPatternLines(frame, {
    kind: 'flutes',
    start: raw.start,
    length: raw.length,
    count: raw.count,
    twist: raw.twist,
    depth: raw.depth,
  })
  if (!built.ok) return null
  return {
    start: raw.start,
    length: raw.length,
    count: raw.count,
    twist: raw.twist,
    depth: raw.depth,
    frame: cloneStoredRotaryPatternFrame(frame),
  } as unknown as FlutesCannedParams
}

function fluteProfiles(params: FlutesCannedParams): CannedShapeOutline[] {
  const built = buildRotaryPatternLines(params.frame, {
    kind: 'flutes',
    start: params.start,
    length: params.length,
    count: params.count,
    twist: params.twist,
    depth: params.depth,
  })
  if (!built.ok) return []
  return built.lines.map((line, index) => {
    const profile: SketchProfile = {
      start: rotarySheetPoint(params.frame, line.alongStart, line.acrossStart),
      segments: [{ type: 'line', to: rotarySheetPoint(params.frame, line.alongEnd, line.acrossEnd) }],
      closed: false,
    }
    return { profile, name: `Flutes Flute ${index + 1}` }
  })
}

export const flutesCannedShape = defineCannedShape<FlutesCannedParams>({
  kind: FLUTES_CANNED_KIND,
  labelKey: 'canned.flutes.name',
  generate: (params) => {
    try {
      return fluteProfiles(params)
    } catch {
      // `normalizeParams` already refuses invalid sets; this keeps a direct
      // call with a corrupt parameter object from becoming a redraw crash.
      return []
    }
  },
  normalizeParams: normalizeFlutesCannedParams,
  convertParams: (params, convertLength): FlutesCannedParams => ({
    ...params,
    start: convertLength(params.start),
    length: convertLength(params.length),
    depth: convertLength(params.depth),
    frame: convertStoredRotaryPatternFrame(params.frame, convertLength),
  }) as unknown as FlutesCannedParams,
  summary: (params) => ({
    key: 'canned.flutes.summary',
    values: {
      count: params.count,
      twist: Math.round(Math.abs(params.twist) * 10000) / 10000,
      length: Math.round(params.length * 10000) / 10000,
    },
  }),
})
