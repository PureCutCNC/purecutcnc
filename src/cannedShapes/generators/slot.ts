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
 * Canned slot (issue #1112 slice D).
 *
 * Parameters are the two the decisions table names — the distance between the
 * end-arc centres (the slot's length) and its width. The outline is drawn along
 * local +X and centred on the origin; the instance transform carries the
 * position and the angle the old drag defined, so a slot created from two
 * points is the same stadium `slotProfile` drew.
 */

import { slotProfile, type CannedShapeParams } from '../../types/project'
import { defineCannedShape } from '../types'
import { SLOT_CANNED_KIND } from './kinds'
import type { CannedShapeEditorRequest } from './editorRequest'

export type SlotCannedParams = CannedShapeParams & {
  /** Centre-to-centre distance between the end arcs. */
  length: number
  width: number
}

function isSlotParams(value: CannedShapeParams): value is SlotCannedParams {
  return typeof value.length === 'number' && Number.isFinite(value.length) && value.length > 0
    && typeof value.width === 'number' && Number.isFinite(value.width) && value.width > 0
}

export const slotCannedShape = defineCannedShape<SlotCannedParams>({
  kind: SLOT_CANNED_KIND,
  labelKey: 'canned.slot.name',
  generate: (params) => [{
    profile: slotProfile(
      { x: -params.length / 2, y: 0 },
      { x: params.length / 2, y: 0 },
      params.width,
    ),
  }],
  normalizeParams: (raw) => (isSlotParams(raw) ? raw : null),
  convertParams: (params, convertLength) => ({
    ...params,
    length: convertLength(params.length),
    width: convertLength(params.width),
  }),
  summary: (params) => ({
    key: 'canned.slot.summary',
    values: { length: params.length, width: params.width },
  }),
})

/** The same fields the creation panel shows, for Edit slot…. */
export const SLOT_EDITOR_REQUEST: CannedShapeEditorRequest = {
  kind: SLOT_CANNED_KIND,
  labelKey: 'canned.slot.name',
  fields: [
    { key: 'length', labelKey: 'canvas.field.length' },
    { key: 'width', labelKey: 'canvas.field.width' },
  ],
  normalize: (params) => (isSlotParams(params) ? params : null),
}
