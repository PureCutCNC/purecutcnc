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
 * The one open Turn/Polygon dialog (issue #1112 slice G).
 *
 * Kept out of the component file so React Fast Refresh sees only components
 * there. The creation drawer's rotary group and the canned-shape editor
 * registry both open the same dialog through this module store; the host in
 * `RotarySolidDialog.tsx` subscribes to it.
 */

import { registerCannedShapeEditor } from '../../../cannedShapes/registry'
import { POLYGON_CANNED_KIND, TURN_CANNED_KIND } from '../../../cannedShapes/generators/kinds'

export type RotarySolidKind = 'turn' | 'polygon'

export interface RotarySolidDialogRequest {
  kind: RotarySolidKind
  /** Present when the Properties button reopened the dialog for an edit. */
  featureId?: string
}

let dialogRequest: RotarySolidDialogRequest | null = null
const dialogListeners = new Set<() => void>()

function emitDialogRequest(): void {
  for (const listener of dialogListeners) listener()
}

export function subscribeDialogRequest(listener: () => void): () => void {
  dialogListeners.add(listener)
  return () => { dialogListeners.delete(listener) }
}

export function dialogRequestSnapshot(): RotarySolidDialogRequest | null {
  return dialogRequest
}

/** Open the create dialog from the creation drawer's rotary group. */
export function openRotarySolidCreate(kind: RotarySolidKind): void {
  dialogRequest = { kind }
  emitDialogRequest()
}

/** Open the same dialog for an existing model, from Properties. */
export function openRotarySolidEdit(kind: RotarySolidKind, featureId: string): void {
  dialogRequest = { kind, featureId }
  emitDialogRequest()
}

/** Close whichever dialog is open. */
export function closeRotarySolidDialog(): void {
  if (dialogRequest === null) return
  dialogRequest = null
  emitDialogRequest()
}

registerCannedShapeEditor(TURN_CANNED_KIND, (featureId) => openRotarySolidEdit('turn', featureId))
registerCannedShapeEditor(POLYGON_CANNED_KIND, (featureId) => openRotarySolidEdit('polygon', featureId))
