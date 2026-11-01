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
 * Thread as a canned shape (issue #1112 slice F).
 *
 * One feature draws every start's helix as an open `line`. The stored
 * parameters are the dialog's own numbers plus the Around frame the shape was
 * drawn against; the geometry comes from the same
 * `buildRotaryPatternLines` the pre-canned command used, so a Follow line
 * operation on the feature cuts the lines that command's operation cut.
 *
 * Follow line targets the **feature**, not one line per start: the canned
 * model expands open outlines to the feature's operation, and the toolpath
 * resolver expands them back into the same open paths (issue #1112 decision 2).
 */

import type { CannedShapeParams, SketchProfile } from '../../types/project'
import {
  buildRotaryPatternLines,
  rotarySheetPoint,
  type RotaryPatternFrame,
} from '../../engine/rotaryPatterns'
import { defineCannedShape, type CannedShapeOutline } from '../types'
import { THREAD_CANNED_KIND } from './kinds'
import {
  cloneStoredRotaryPatternFrame,
  convertStoredRotaryPatternFrame,
  hasFiniteNumbers,
  storedFrameOf,
} from './rotaryPatternParams'

/** Stored parameters: the dialog's set plus the frame snapshot. */
export type ThreadCannedParams = CannedShapeParams & {
  start: number
  length: number
  pitch: number
  starts: number
  depth: number
  hand: 'right' | 'left'
  frame: RotaryPatternFrame
}

function isThreadCannedParams(raw: CannedShapeParams): raw is ThreadCannedParams {
  return hasFiniteNumbers(raw, ['start', 'length', 'pitch', 'starts', 'depth'])
    && (raw.hand === 'right' || raw.hand === 'left')
    && storedFrameOf(raw) !== null
}

/**
 * Validate and normalize stored parameters. Returns `null` for a parameter set
 * the old line builder would have refused, so a corrupt file cannot make the
 * shape silently draw something different.
 */
export function normalizeThreadCannedParams(raw: CannedShapeParams): ThreadCannedParams | null {
  if (!isThreadCannedParams(raw)) return null
  const frame = storedFrameOf(raw)
  if (!frame) return null
  const built = buildRotaryPatternLines(frame, {
    kind: 'thread',
    start: raw.start,
    length: raw.length,
    pitch: raw.pitch,
    starts: raw.starts,
    hand: raw.hand,
    depth: raw.depth,
  })
  if (!built.ok) return null
  return {
    start: raw.start,
    length: raw.length,
    pitch: raw.pitch,
    starts: raw.starts,
    depth: raw.depth,
    hand: raw.hand,
    frame: cloneStoredRotaryPatternFrame(frame),
  } as unknown as ThreadCannedParams
}

function threadProfiles(params: ThreadCannedParams): CannedShapeOutline[] {
  const built = buildRotaryPatternLines(params.frame, {
    kind: 'thread',
    start: params.start,
    length: params.length,
    pitch: params.pitch,
    starts: params.starts,
    hand: params.hand,
    depth: params.depth,
  })
  if (!built.ok) return []
  return built.lines.map((line, index) => {
    const profile: SketchProfile = {
      start: rotarySheetPoint(params.frame, line.alongStart, line.acrossStart),
      segments: [{ type: 'line', to: rotarySheetPoint(params.frame, line.alongEnd, line.acrossEnd) }],
      closed: false,
    }
    return { profile, name: `Thread Start ${index + 1}` }
  })
}

export const threadCannedShape = defineCannedShape<ThreadCannedParams>({
  kind: THREAD_CANNED_KIND,
  labelKey: 'canned.thread.name',
  generate: (params) => {
    try {
      return threadProfiles(params)
    } catch {
      // `normalizeParams` already refuses invalid sets; this keeps a direct
      // call with a corrupt parameter object from becoming a redraw crash.
      return []
    }
  },
  normalizeParams: normalizeThreadCannedParams,
  convertParams: (params, convertLength): ThreadCannedParams => ({
    ...params,
    start: convertLength(params.start),
    length: convertLength(params.length),
    pitch: convertLength(params.pitch),
    depth: convertLength(params.depth),
    frame: convertStoredRotaryPatternFrame(params.frame, convertLength),
  }) as unknown as ThreadCannedParams,
  summary: (params) => ({
    key: 'canned.thread.summary',
    values: {
      pitch: Math.round(params.pitch * 10000) / 10000,
      starts: params.starts,
      length: Math.round(params.length * 10000) / 10000,
    },
  }),
})
