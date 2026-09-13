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
 * The words behind a blocked G-code export (issue #755).
 *
 * A preparation that comes back `blocked` used to disable the Export button and
 * say nothing, which reads as a bug rather than a refusal. The reason is a
 * value, not a string, so this is where it becomes one — and where the two
 * kinds the dialog already reports from live state are deliberately dropped.
 * Returning a translation key rather than translated text keeps this pure and
 * testable without an i18n provider, matching `exportOperationSelection.ts`.
 */

import type { ExportBlockReason } from '../../app/toolpathGeneration/exportPreparation'
import type { MessageParams } from '../../i18n/catalog'

export type ExportBlockMessageKey =
  | 'dialogs.export.error.generationFailed'
  | 'dialogs.export.error.generationInterrupted'
  | 'dialogs.export.error.missingTool'
  | 'dialogs.export.error.stale'

export interface ExportBlockMessage {
  key: ExportBlockMessageKey
  params?: MessageParams
}

/**
 * The message for a blocked preparation, or null when the dialog says it
 * already.
 *
 * `operationName` resolves an operation id to its name; an id that no longer
 * resolves (the operation was deleted while generation was in flight) falls
 * back to the id itself, because naming the operation is the whole point and a
 * nameless message would send the reader looking for the wrong thing.
 */
export function exportBlockReasonMessage(
  reason: ExportBlockReason,
  operationName: (operationId: string) => string | null,
): ExportBlockMessage | null {
  const nameOf = (operationId: string): string => operationName(operationId) ?? operationId

  switch (reason.kind) {
    // Both are reported by the dialog from live state, without waiting for the
    // preparation debounce. Saying them twice would be noise, not emphasis.
    case 'no-machine':
    case 'no-operations':
      return null

    case 'generation-failed':
      return {
        key: 'dialogs.export.error.generationFailed',
        params: { operation: nameOf(reason.operationId), detail: reason.message },
      }

    // The engine tells cancellation and supersession apart; the operator's
    // recovery is the same for either, so the dialog says it once.
    case 'generation-cancelled':
    case 'generation-superseded':
      return {
        key: 'dialogs.export.error.generationInterrupted',
        params: { operation: nameOf(reason.operationId) },
      }

    case 'missing-tool':
      return {
        key: 'dialogs.export.error.missingTool',
        params: { operation: nameOf(reason.operationId) },
      }

    // Declared in the union but not produced anywhere today. It gets a message
    // anyway: an unreachable branch that falls out of an exhaustive mapping is
    // exactly how a silent refusal comes back.
    case 'stale':
      return { key: 'dialogs.export.error.stale' }
  }
}
