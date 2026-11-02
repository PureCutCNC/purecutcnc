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
 * Canned regular polygon (issue #1112 slice D).
 *
 * Parameters are the three the decisions table names: side count, size (the
 * circumradius the old drag set) and rotation. Rotation is stored in degrees so
 * the edit panel can show what the user sees; the first vertex sits at that
 * angle, exactly as `ngonProfile`'s `firstVertexAngle` did. The instance
 * transform places the centre.
 */

import { ngonProfile, type CannedShapeParams } from '../../types/project'
import { defineCannedShape } from '../types'
import { NGON_CANNED_KIND } from './kinds'
import type { CannedShapeEditorRequest } from './editorRequest'

/** The creation panel and the generator agree on the same 3–50 range. */
export const NGON_MIN_SIDES = 3
export const NGON_MAX_SIDES = 50

export type NgonCannedParams = CannedShapeParams & {
  sides: number
  /** Circumradius: centre to vertex. */
  size: number
  /** Degrees, first vertex. */
  rotation: number
}

function normalizeNgonParams(value: CannedShapeParams): NgonCannedParams | null {
  const sides = Math.round(Number(value.sides))
  const size = Number(value.size)
  const rotation = Number(value.rotation)
  if (!Number.isFinite(sides) || sides < NGON_MIN_SIDES || sides > NGON_MAX_SIDES) return null
  if (!Number.isFinite(size) || size <= 0) return null
  if (!Number.isFinite(rotation)) return null
  return { sides, size, rotation }
}

export const ngonCannedShape = defineCannedShape<NgonCannedParams>({
  kind: NGON_CANNED_KIND,
  labelKey: 'canned.ngon.name',
  generate: (params) => [{
    profile: ngonProfile(0, 0, params.sides, params.size, (params.rotation * Math.PI) / 180),
  }],
  normalizeParams: normalizeNgonParams,
  convertParams: (params, convertLength) => ({ ...params, size: convertLength(params.size) }),
  summary: (params) => ({
    key: 'canned.ngon.summary',
    values: { sides: params.sides, size: params.size, rotation: params.rotation },
  }),
})

/** The same fields the creation panel shows, for Edit regular polygon…. */
export const NGON_EDITOR_REQUEST: CannedShapeEditorRequest = {
  kind: NGON_CANNED_KIND,
  labelKey: 'canned.ngon.name',
  fields: [
    { key: 'sides', labelKey: 'canvas.param.ngonSides', integer: true },
    { key: 'size', labelKey: 'canvas.field.size' },
    { key: 'rotation', labelKey: 'canvas.field.rotation' },
  ],
  normalize: normalizeNgonParams,
}
