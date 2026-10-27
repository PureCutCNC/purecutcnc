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
 * Canned rounded rectangle (issue #1112 slice D).
 *
 * Width, height and corner radius, drawn from the local origin; the instance
 * transform places the corner the old two-point drag defined. The outline is
 * built by the same `roundedRectProfile` helper the one-shot command used, so
 * the radius clamp (never more than half the short side) is unchanged.
 */

import type { CannedShapeParams } from '../../types/project'
import { defineCannedShape } from '../types'
import { roundedRectProfile } from '../../store/helpers/cannedRectProfiles'
import { ROUND_RECT_CANNED_KIND } from './kinds'
import type { CannedShapeEditorRequest } from './editorRequest'

export type RoundRectCannedParams = CannedShapeParams & {
  width: number
  height: number
  radius: number
}

function isRoundRectParams(value: CannedShapeParams): value is RoundRectCannedParams {
  return typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0
    && typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0
    && typeof value.radius === 'number' && Number.isFinite(value.radius) && value.radius >= 0
}

export const roundRectCannedShape = defineCannedShape<RoundRectCannedParams>({
  kind: ROUND_RECT_CANNED_KIND,
  labelKey: 'canned.roundrect.name',
  generate: (params) => [{
    profile: roundedRectProfile(
      { x: 0, y: 0 },
      { x: params.width, y: params.height },
      params.radius,
    ),
  }],
  normalizeParams: (raw) => (isRoundRectParams(raw) ? raw : null),
  convertParams: (params, convertLength) => ({
    ...params,
    width: convertLength(params.width),
    height: convertLength(params.height),
    radius: convertLength(params.radius),
  }),
  summary: (params) => ({
    key: 'canned.roundrect.summary',
    values: { width: params.width, height: params.height, radius: params.radius },
  }),
})

/** The same fields the creation panel shows, for Edit rounded rectangle…. */
export const ROUND_RECT_EDITOR_REQUEST: CannedShapeEditorRequest = {
  kind: ROUND_RECT_CANNED_KIND,
  labelKey: 'canned.roundrect.name',
  fields: [
    { key: 'width', labelKey: 'canvas.field.width' },
    { key: 'height', labelKey: 'canvas.field.height' },
    { key: 'radius', labelKey: 'canvas.param.cornerRadius' },
  ],
  normalize: (params) => (isRoundRectParams(params) ? params : null),
}
