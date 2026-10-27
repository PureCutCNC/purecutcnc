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
 * The "this feature changes nothing in the final shape" marker (issue #1112
 * slice N, decision 12). Warning only: the row keeps every action it had, and
 * the tree keeps folding in its own order. The sentence is the tooltip and the
 * accessible name, and the same wording is used everywhere the warning appears.
 */

export function NoEffectBadge({ text }: { text: string }) {
  return (
    <span
      className="tree-no-effect-badge"
      role="img"
      aria-label={text}
      title={text}
      data-no-effect="true"
    >
      <span aria-hidden="true">⚠</span>
    </span>
  )
}
