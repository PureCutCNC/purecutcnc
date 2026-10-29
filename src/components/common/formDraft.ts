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
 * Does this form have something to save? (issue #1112 F4)
 *
 * Frank: "in the face properties (CAM panel), save button does nothing when
 * there are no changes in the form (but it can still be clicked). we should
 * grey it out if there are no changes."
 *
 * A dialog that edits stored data keeps a draft in React state, so every
 * keystroke rebuilds the arrays and objects it holds. Comparing the draft with
 * the values the dialog opened on must therefore compare **by value**: an
 * identity check would report "changed" after the first render of an untouched
 * form.
 *
 * Callers normalise first, because this comparison is exact and each form's
 * save path normalises in its own way — the setup editor trims a setup name
 * before storing it, the text dialog collapses it to one line and parses its
 * height from the typed string. Comparing the normalised shape on both sides is
 * what makes typing a value back (or "12.0" over a saved 12) leave Save
 * disabled again.
 */

/** Plain data only: the JSON-shaped values a form's draft and its saved copy hold. */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function sameValue(a: unknown, b: unknown): boolean {
  // Identical primitives, the same object, and NaN (which `===` reports as
  // different from itself) all end here.
  if (Object.is(a, b)) return true
  // `Object.is` separates 0 and -0; as form values they are the same number.
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
    return a.every((entry, index) => sameValue(entry, b[index]))
  }
  if (!isPlainRecord(a) || !isPlainRecord(b)) return false
  const keys = Object.keys(a)
  // Key order is not data; an absent key and an `undefined` one are not the same.
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => Object.prototype.hasOwnProperty.call(b, key) && sameValue(a[key], b[key]))
}

/**
 * True when `draft` differs from the values the form was opened with, which is
 * exactly what an explicit Save/Apply button may be enabled by.
 */
export function formHasChanges(saved: unknown, draft: unknown): boolean {
  return !sameValue(saved, draft)
}

/**
 * The name an inline rename would write, or `null` when it would write
 * nothing — which is exactly when its Save is disabled (issue #1112 F4).
 *
 * A saved name is stored trimmed, so a draft that differs only in surrounding
 * whitespace is not an edit, and a blank draft names nothing at all. Comparing
 * the trimmed draft with the saved name is what makes typing the saved name
 * back disable Save again.
 */
export function renameTarget(savedName: string, draft: string): string | null {
  const trimmed = draft.trim()
  if (trimmed === '' || !formHasChanges(savedName, trimmed)) return null
  return trimmed
}
