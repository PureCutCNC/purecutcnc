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
 * A module-level store rather than React state because the canvas draw loop and
 * the pointer handlers read it outside React's render; the panel subscribes
 * with `useSyncExternalStore`. Only one canned-edit session exists at a time
 * (the canvas renders one panel), so there is one draft.
 */

/** The fields of the open flat-shape editor, as text. */
export interface CannedEditDraft {
  /** The row being edited: a drag only ever moves this row's handles. */
  featureId: string
  /** The stored kind, so a handle knows which editor's fields it is holding. */
  kind: string
  /** Field key → the text in its input, exactly as shown. */
  values: Record<string, string>
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
): void {
  replace({ featureId, kind, values: { ...values } })
}

/**
 * Replace every field from stored parameters — a stored change the fields did
 * not produce (an undo while the panel is open). Does nothing when no editor
 * for that row is open, so a late write cannot resurrect a closed session.
 */
export function seedCannedEditDraft(featureId: string, values: Record<string, string>): void {
  if (!draft || draft.featureId !== featureId) return
  replace({ ...draft, values: { ...values } })
}

/** One field's text, from a keystroke or from dragging that radius' handle. */
export function setCannedEditDraftField(featureId: string, key: string, text: string): boolean {
  if (!draft || draft.featureId !== featureId) return false
  if (draft.values[key] === text) return false
  replace({ ...draft, values: { ...draft.values, [key]: text } })
  return true
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
