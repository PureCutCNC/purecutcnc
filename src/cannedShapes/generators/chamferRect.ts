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
 * Canned chamfered rectangle (issue #1112 slice D).
 *
 * Width, height and chamfer distance, drawn from the local origin; the instance
 * transform places the corner the old two-point drag defined. The outline is
 * the same `chamferedRectProfile` helper the one-shot command used, so the
 * chamfer clamp (never more than half the short side) is unchanged.
 */

import type { CannedShapeParams } from '../../types/project'
import { defineCannedShape } from '../types'
import { chamferedRectProfile } from '../../store/helpers/cannedRectProfiles'
import { CHAMFER_RECT_CANNED_KIND } from './kinds'
import type { CannedShapeEditorRequest } from './editorRequest'

export type ChamferRectCannedParams = CannedShapeParams & {
  width: number
  height: number
  chamfer: number
}

function isChamferRectParams(value: CannedShapeParams): value is ChamferRectCannedParams {
  return typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0
    && typeof value.height === 'number' && Number.isFinite(value.height) && value.height > 0
    && typeof value.chamfer === 'number' && Number.isFinite(value.chamfer) && value.chamfer >= 0
}

export const chamferRectCannedShape = defineCannedShape<ChamferRectCannedParams>({
  kind: CHAMFER_RECT_CANNED_KIND,
  labelKey: 'canned.chamferrect.name',
  generate: (params) => [{
    profile: chamferedRectProfile(
      { x: 0, y: 0 },
      { x: params.width, y: params.height },
      params.chamfer,
    ),
  }],
  normalizeParams: (raw) => (isChamferRectParams(raw) ? raw : null),
  convertParams: (params, convertLength) => ({
    ...params,
    width: convertLength(params.width),
    height: convertLength(params.height),
    chamfer: convertLength(params.chamfer),
  }),
  summary: (params) => ({
    key: 'canned.chamferrect.summary',
    values: { width: params.width, height: params.height, chamfer: params.chamfer },
  }),
})

/** The same fields the creation panel shows, for Edit chamfered rectangle…. */
export const CHAMFER_RECT_EDITOR_REQUEST: CannedShapeEditorRequest = {
  kind: CHAMFER_RECT_CANNED_KIND,
  labelKey: 'canned.chamferrect.name',
  fields: [
    { key: 'width', labelKey: 'canvas.field.width' },
    { key: 'height', labelKey: 'canvas.field.height' },
    { key: 'chamfer', labelKey: 'canvas.param.chamfer' },
  ],
  normalize: (params) => (isChamferRectParams(params) ? params : null),
}
