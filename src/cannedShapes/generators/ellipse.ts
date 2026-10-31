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
 * Canned ellipse (issue #1112 slice D).
 *
 * The parameters are the two radii; the definition's instance transform places
 * the ellipse, so moving or rotating the feature never rewrites them. The old
 * one-shot command had no rotation of its own — an ellipse created here is the
 * same four-Bézier outline `ellipseProfile` drew, just regenerated on read.
 */

import { ellipseProfile, type CannedShapeParams } from '../../types/project'
import { defineCannedShape } from '../types'
import { ELLIPSE_CANNED_KIND } from './kinds'
import type { CannedShapeEditorRequest } from './editorRequest'

export type EllipseCannedParams = CannedShapeParams & {
  rx: number
  ry: number
}

/**
 * The one validation path for stored ellipse parameters: the generator, the
 * Edit-ellipse panel and the canvas radius handles all come through here, so a
 * dragged radius is accepted under exactly the same rule as a typed one
 * (issue #1112 slice w3e-a).
 */
export function normalizeEllipseCannedParams(value: CannedShapeParams): EllipseCannedParams | null {
  return typeof value.rx === 'number' && Number.isFinite(value.rx) && value.rx > 0
    && typeof value.ry === 'number' && Number.isFinite(value.ry) && value.ry > 0
    ? value as EllipseCannedParams
    : null
}

export const ellipseCannedShape = defineCannedShape<EllipseCannedParams>({
  kind: ELLIPSE_CANNED_KIND,
  labelKey: 'canned.ellipse.name',
  generate: (params) => [{ profile: ellipseProfile(0, 0, params.rx, params.ry) }],
  normalizeParams: (raw) => normalizeEllipseCannedParams(raw),
  convertParams: (params, convertLength) => ({
    ...params,
    rx: convertLength(params.rx),
    ry: convertLength(params.ry),
  }),
  summary: (params) => ({
    key: 'canned.ellipse.summary',
    values: { rx: params.rx, ry: params.ry },
  }),
})

/** The same fields the creation panel shows, for Edit ellipse…. */
export const ELLIPSE_EDITOR_REQUEST: CannedShapeEditorRequest = {
  kind: ELLIPSE_CANNED_KIND,
  labelKey: 'canned.ellipse.name',
  fields: [
    { key: 'rx', labelKey: 'canvas.field.radiusX' },
    { key: 'ry', labelKey: 'canvas.field.radiusY' },
  ],
  normalize: (params) => normalizeEllipseCannedParams(params),
}
