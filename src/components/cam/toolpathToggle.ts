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
 * The CAM panel's single "toolpaths" eye (issue #1102, proposal 17).
 *
 * Two buttons — "Show all" and "Hide all" — asked the user to work out which
 * one described the current state before they could act on it. One toggle
 * says what the click will do instead: it hides while anything is drawn and
 * shows only once everything is hidden.
 *
 * `anyVisible` is deliberately `some`, not `every`: with one toolpath already
 * showing, the useful action is to hide the rest, not to re-show the ones the
 * user just turned off.
 */

import type { Operation } from '../../types/project'

/** The state the operations toolbar's eye should render, and what a click sets. */
export interface AllToolpathsToggle {
  /** True when at least one operation currently draws its toolpath. */
  anyVisible: boolean
  /** The value every operation's `showToolpath` becomes on click. */
  next: boolean
}

/** Which way the one eye toggles, over the operations the panel is listing. */
export function allToolpathsToggle(
  operations: readonly Pick<Operation, 'showToolpath'>[],
): AllToolpathsToggle {
  const anyVisible = operations.some((operation) => operation.showToolpath)
  return { anyVisible, next: !anyVisible }
}

/**
 * Whether the toggle is offered at all. With no operations there is nothing to
 * show or hide, so the eye is disabled rather than silently doing nothing.
 */
export function allToolpathsToggleEnabled(
  operations: readonly Pick<Operation, 'showToolpath'>[],
): boolean {
  return operations.length > 0
}
