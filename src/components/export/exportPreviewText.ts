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
 * What the Export G-code dialog's preview pane says when there is no program to
 * show (issue #1112, item 35).
 *
 * The pane used to have one fallback sentence — "Select a machine in project
 * settings to generate G-code preview" — and it was used for **every** state
 * without a program. So a project with a machine selected that was refused for
 * another reason (no operation ticked, generation failed, the machine cannot
 * turn the bar) told the operator to select a machine they had already
 * selected, and the real reason was somewhere else on screen — or nowhere, when
 * it was the project's own machine selection that was broken. That is the
 * report this module answers: the sentence now names the actual state.
 *
 * Returning a **key** rather than translated text keeps this pure and testable
 * without an i18n provider, matching `exportBlockReason.ts` and
 * `exportDialectLabels.ts`.
 */

import type { ExportBlockReason } from '../../app/toolpathGeneration/exportPreparation'
import type { MessageKey } from '../../i18n/locales/en'

/**
 * Every message this pane can show, taken from the catalog rather than
 * re-listed: a key that does not exist fails to compile at the return site,
 * and a new `dialogs.export.preview*` key joins the set automatically.
 */
export type ExportPreviewMessageKey = Extract<MessageKey, `dialogs.export.preview${string}`>

/** How the dialog's machine read came out. */
export type ExportMachineState =
  /** A definition in the project's own snapshot matches the selected id. */
  | 'resolved'
  /** Nothing is selected: the honest "select a machine" state. */
  | 'none'
  /**
   * An id is selected but the snapshot holds no definition for it — a file
   * written by another build, or a definition this build could not read. The
   * operator selected a machine, so telling them to select one is worse than
   * telling them it is gone.
   */
  | 'missing'

export interface ExportPreviewState {
  /** A program was posted, so the pane shows it and none of this applies. */
  hasPreview: boolean
  machine: ExportMachineState
  /** `null` unless the preparation came back blocked. */
  blockReason: ExportBlockReason['kind'] | null
}

/**
 * The message key for the pane, or `null` when there is a program to show.
 *
 * A blocked preparation is *not* automatically a machine problem: the dialog's
 * Errors list carries the reason (a failing operation, a tool, a rotary axis),
 * and this only has to stop the pane from claiming the wrong one.
 */
export function exportPreviewMessageKey(state: ExportPreviewState): ExportPreviewMessageKey | null {
  if (state.hasPreview) return null
  if (state.machine !== 'resolved') {
    return state.machine === 'missing'
      ? 'dialogs.export.previewMachineMissing'
      : 'dialogs.export.previewPlaceholder'
  }
  if (state.blockReason === 'no-operations') return 'dialogs.export.previewNoOperations'
  // Every other blocked reason — a failed, cancelled or superseded member, a
  // missing tool, a stale token — is spelled out in the Errors list above, so
  // the pane points at it rather than guessing.
  if (state.blockReason !== null) return 'dialogs.export.previewBlocked'
  // A machine is selected and nothing has settled yet: the debounce, or
  // generation in flight. This is the state the old sentence lied about most
  // often, because it is the one a slow machine spends the longest in.
  return 'dialogs.export.previewPreparing'
}
