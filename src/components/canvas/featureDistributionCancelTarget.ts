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

import type { PendingFeatureDistribution } from '../../store/types'

/**
 * Shell chrome whose own pointerdown closes a pending Feature Distribution
 * (issue #205): tapping any of it reads as "the user left the canvas", which is
 * the one thing that ends the workflow without a panel action or Escape.
 */
const CANCELLING_CHROME = '.toolbar, .toolbar-popover, .tool-rail, .tool-rail__popover, .app-toolbar'

/**
 * Controls inside those bars that belong to another workflow and must leave
 * the pending distribution alone. The snap controls and the project-panel
 * toggle have always been exempt; the workspace face control joins them
 * because issue #1112 rt5-a moved it into the tablet's top command bar (on the
 * desktop it stays in the centre tab row, which no rule here covers), so
 * without the exemption tapping "Show other side" there ended the workflow on
 * a tablet while the same tap kept it open on a desktop.
 *
 * The menu is exempt as well as the control: it is portalled to the document
 * body, outside the bar it belongs to, and a menu that later renders in flow
 * must not change the answer.
 */
const EXEMPT_CONTROLS = '.toolbar-group--snap, .snap-popover-host--snap, .top-cmd-btn--project-panel, .face-switch, .face-switch__menu'

/**
 * Whether a document `pointerdown` on `target` should end a pending Feature
 * Distribution: only chrome outside the exempt controls, and only the bars
 * themselves — the canvas, a workflow panel and the side panels keep it open.
 */
export function isFeatureDistributionCancelTarget(target: Element): boolean {
  if (target.closest(EXEMPT_CONTROLS) !== null) return false
  return target.closest(CANCELLING_CHROME) !== null
}

/**
 * The document pointerdown handler itself, split out of
 * `useFeatureDistributionWorkflow` so the whole rule — including which taps are
 * ignored — is a pure function with a fake target to test it against.
 * `pending` is only read for its nullness: nothing is cancelled when the
 * workflow is closed.
 */
export function cancelFeatureDistributionOnPointerDown(
  pending: PendingFeatureDistribution | null,
  target: EventTarget | null,
  cancel: () => void,
): void {
  if (pending === null || !(target instanceof Element)) return
  if (isFeatureDistributionCancelTarget(target)) cancel()
}
