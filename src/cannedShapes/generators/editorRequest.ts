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
 * What a canned shape's "Edit <shape>…" panel needs, without importing any UI
 * (issue #1112 slice D).
 *
 * A generator module is a pure model module: it can describe its editable
 * fields and validate a parameter set, but it must not import React or the
 * canvas. The panel that renders these requests lives in
 * `components/canvas/CreationParameterReferences.tsx`, the same file as the
 * creation-time parameter panels, so one field layout serves create and edit.
 */

import type { CannedShapeParams } from '../../types/project'
import type { MessageKey } from '../../i18n/locales/en'

/** One numeric field in the edit panel. */
export interface CannedShapeEditorField {
  /** Key in the parameter object. */
  key: string
  labelKey: MessageKey
  /** Round to an integer before validation (a side count). */
  integer?: boolean
}

/**
 * The edit request a generator registers with the canvas: what to call the
 * shape, which numbers to show, and the generator's own validation so the panel
 * cannot write a parameter set the generator would refuse.
 */
export interface CannedShapeEditorRequest {
  kind: string
  /** The shape's name ("Ellipse"), used in the dialog title. */
  labelKey: MessageKey
  fields: readonly CannedShapeEditorField[]
  normalize: (params: CannedShapeParams) => CannedShapeParams | null
}
