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
 * The one open Thread/Flutes dialog (issue #1112 slice F).
 *
 * Kept out of the component file so React Fast Refresh sees only components
 * there. The creation drawer's rotary group and the canned-shape editor
 * registry both open the same dialog through this module store; the host in
 * `RotaryPatternDialog.tsx` subscribes to it.
 */

import { registerCannedShapeEditor } from '../../../cannedShapes/registry'
import { FLUTES_CANNED_KIND, THREAD_CANNED_KIND } from '../../../cannedShapes/generators/kinds'

export type RotaryPatternKind = 'thread' | 'flutes'

export interface RotaryPatternDialogRequest {
  kind: RotaryPatternKind
  /** Present when the Properties button reopened the dialog for an edit. */
  featureId?: string
}

let dialogRequest: RotaryPatternDialogRequest | null = null
const dialogListeners = new Set<() => void>()

function emitDialogRequest(): void {
  for (const listener of dialogListeners) listener()
}

export function subscribeDialogRequest(listener: () => void): () => void {
  dialogListeners.add(listener)
  return () => { dialogListeners.delete(listener) }
}

export function dialogRequestSnapshot(): RotaryPatternDialogRequest | null {
  return dialogRequest
}

/** Open the create dialog from the creation drawer's rotary group. */
export function openRotaryPatternCreate(kind: RotaryPatternKind): void {
  dialogRequest = { kind }
  emitDialogRequest()
}

/** Open the same dialog for an existing feature, from Properties. */
export function openRotaryPatternEdit(kind: RotaryPatternKind, featureId: string): void {
  dialogRequest = { kind, featureId }
  emitDialogRequest()
}

/** Close whichever dialog is open. */
export function closeRotaryPatternDialog(): void {
  if (dialogRequest === null) return
  dialogRequest = null
  emitDialogRequest()
}

registerCannedShapeEditor(THREAD_CANNED_KIND, (featureId) => openRotaryPatternEdit('thread', featureId))
registerCannedShapeEditor(FLUTES_CANNED_KIND, (featureId) => openRotaryPatternEdit('flutes', featureId))
