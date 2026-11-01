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
 * The open "Edit <shape>…" panel's field text (issue #1112 slice rt7-g).
 *
 * The panel's fields are the one draft the whole edit reads: the inputs render
 * this text, the live preview normalizes it, and the canvas radius handles are
 * placed by it. Dragging a handle therefore writes the field text here — the
 * same path a keystroke takes — instead of writing the project, which is why a
 * dragged radius is one undo step on Save and is discarded by Cancel exactly
 * like a typed one.
 *
 * A drag additionally records its field in `heldFields`: the canvas still draws
 * the dragged radius (the outline and the handles read this draft), but the
 * panel keeps that field at its stored value in the project until Save, so a
 * dragged radius is not a stored parameter before the user commits it (issue
 * #1112 rt7-g review). The hold is per field, not per draft: typing another
 * field must not release it, or the typed write would carry the dragged radius
 * into the project with it (`cannedEditPreviewValues`). Typing the dragged field
 * itself makes that field a typed value again, which keeps the live preview a
 * typed value has had since issue #1112 F1.
 *
 * A module-level store rather than React state because the canvas draw loop and
 * the pointer handlers read it outside React's render; the panel subscribes
 * with `useSyncExternalStore`. Only one canned-edit session exists at a time
 * (the canvas renders one panel), so there is one draft.
 */

import type { Units } from '../../utils/units'

/** The fields of the open flat-shape editor, as text. */
export interface CannedEditDraft {
  /** The row being edited: a drag only ever moves this row's handles. */
  featureId: string
  /** The stored kind, so a handle knows which editor's fields it is holding. */
  kind: string
  /** Field key → the text in its input, exactly as shown. */
  values: Record<string, string>
  /**
   * The unit system the text is written in. A unit switch converts the stored
   * parameters but not text a person is already typing, so a draft whose units
   * no longer match the project is replaced instead of previewed — otherwise it
   * would write the old unit's numbers into the new project (issue #1112 rt7-g
   * correction).
   */
  units: Units
  /**
   * The fields a handle dragged, so their text is an edit of the panel until
   * Save. The project previews every *other* field live, which is why this is a
   * set of keys and not one draft-wide flag (issue #1112 rt7-g correction).
   */
  heldFields: readonly string[]
}

/** Options for one field write; a drag holds its preview out of the project. */
export interface CannedEditFieldOptions {
  /**
   * Keep the change in the canvas preview only. The panel's field shows it and
   * the canvas draws it, but the project keeps that field's stored value until
   * Save — the difference between a dragged radius and a typed one (issue #1112
   * rt7-g).
   */
  holdPreview?: boolean
}

let draft: CannedEditDraft | null = null
const listeners = new Set<() => void>()

function emit(): void {
  // Copied first: a listener may unsubscribe while being notified (a panel
  // unmounting while another one is still listening).
  for (const listener of [...listeners]) listener()
}

function replace(next: CannedEditDraft | null): void {
  draft = next
  emit()
}

/** The open draft, or `null` while no flat-shape editor is open. */
export function getCannedEditDraft(): CannedEditDraft | null {
  return draft
}

/** Subscribe to every field change, open and close; returns the unsubscribe. */
export function subscribeCannedEditDraft(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Open the editor's fields, replacing any earlier session. */
export function openCannedEditDraft(
  featureId: string,
  kind: string,
  values: Record<string, string>,
  units: Units,
): void {
  replace({ featureId, kind, values: { ...values }, units, heldFields: [] })
}

/**
 * Replace every field from stored parameters — a stored change the fields did
 * not produce (an undo while the panel is open). Does nothing when no editor
 * for that row is open, so a late write cannot resurrect a closed session. The
 * values are the project's, in the project's units, so nothing is held any more.
 */
export function seedCannedEditDraft(
  featureId: string,
  values: Record<string, string>,
  units: Units,
): void {
  if (!draft || draft.featureId !== featureId) return
  replace({ ...draft, values: { ...values }, units, heldFields: [] })
}

/**
 * One field's text, from a keystroke or from dragging that radius' handle.
 *
 * A drag passes `holdPreview`, which records its field as held: the project
 * keeps that field's stored value until Save. A keystroke makes its own field a
 * typed value again — the live preview every canned editor has had since issue
 * #1112 F1 — but it never releases a *different* field's hold, because the
 * typed write must not carry a dragged radius into the project with it (issue
 * #1112 rt7-g correction). A write of the text a field already holds records a
 * hold only; it never releases one, so a no-op keystroke cannot persist a
 * dragged value either.
 */
export function setCannedEditDraftField(
  featureId: string,
  key: string,
  text: string,
  options?: CannedEditFieldOptions,
): boolean {
  const holdPreview = options?.holdPreview === true
  if (!draft || draft.featureId !== featureId) return false
  if (draft.values[key] === text) {
    // The text already matches — a drag that came back to the stored radius.
    // Nothing to write, but a hold it has not recorded yet still changes which
    // values the project previews.
    if (holdPreview && !draft.heldFields.includes(key)) {
      replace({ ...draft, heldFields: [...draft.heldFields, key] })
    }
    return false
  }
  const heldFields = holdPreview
    ? (draft.heldFields.includes(key) ? draft.heldFields : [...draft.heldFields, key])
    : draft.heldFields.filter((held) => held !== key)
  replace({ ...draft, values: { ...draft.values, [key]: text }, heldFields })
  return true
}

/**
 * The field text the *project* should preview: the draft for every typed field,
 * and the stored text for every field a handle dragged. That is what keeps a
 * dragged radius unpersisted for the rest of the session even after the user
 * types in another field, without taking the typed field's live preview away
 * (issue #1112 rt7-g correction).
 */
export function cannedEditPreviewValues(
  draft: CannedEditDraft,
  storedValues: Record<string, string>,
): Record<string, string> {
  const values = { ...storedValues }
  for (const [key, text] of Object.entries(draft.values)) {
    if (!draft.heldFields.includes(key)) values[key] = text
  }
  return values
}

/**
 * Close the session. Passing the row keeps a stale unmount from closing a newer
 * session for another shape.
 */
export function closeCannedEditDraft(featureId?: string): void {
  if (!draft) return
  if (featureId !== undefined && draft.featureId !== featureId) return
  replace(null)
}
