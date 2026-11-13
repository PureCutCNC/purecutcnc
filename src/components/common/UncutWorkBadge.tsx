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
 * The "kept but cannot be cut" marker (issue #1112 slice K, decision 5). One
 * quiet inline glyph after the name, with the reason as its tooltip and its
 * accessible name, used on a feature-tree row and on an operation row. It is
 * status, not an action: no click, no menu, nothing to dismiss. The reason
 * itself is `uncutWork.ts`'s wording, passed in so both rows read the same.
 */

export function UncutWorkBadge({ text }: { text: string }) {
  return (
    <span
      className="tree-uncut-badge"
      role="img"
      aria-label={text}
      title={text}
      data-uncut-work="true"
    >
      <span aria-hidden="true">⚠</span>
    </span>
  )
}
