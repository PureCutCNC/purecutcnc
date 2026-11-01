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
 * The pure form half of the Edit <shape>… panel (issue #1112 slice D).
 *
 * Opening the dialog with the stored values and reading the fields back into a
 * parameter set is where the panel can go wrong — a wrong key, a number parsed
 * from an empty field, a value the generator would refuse. Keeping it free of
 * React makes it testable without a DOM; the component only renders and wires
 * Save to one `updateFeature` call.
 */

import type { CannedShapeParams } from '../../types/project'
import type { CannedShapeEditorRequest } from './editorRequest'

/** The shape's stored numbers as editable field text. */
export function editorInitialValues(
  request: CannedShapeEditorRequest,
  params: CannedShapeParams,
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const field of request.fields) {
    const value = params[field.key]
    values[field.key] = typeof value === 'number' ? String(value) : ''
  }
  return values
}

/**
 * Field text back to a parameter set, or `null` when a field is empty or not a
 * number. The request's `normalize` then applies the generator's own rules.
 */
export function editorParamsFromValues(
  request: CannedShapeEditorRequest,
  values: Record<string, string>,
): CannedShapeParams | null {
  const params: CannedShapeParams = {}
  for (const field of request.fields) {
    const text = values[field.key]?.trim() ?? ''
    if (text === '') return null
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) return null
    params[field.key] = field.integer ? Math.round(parsed) : parsed
  }
  return params
}
