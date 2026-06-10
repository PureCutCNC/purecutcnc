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
 * Pure persistence helpers for `DisclosureSection`'s open/collapsed state.
 *
 * Kept free of React and `localStorage` so the parse/serialize/default logic is
 * unit-testable in the DOM-less test runner; the component owns the actual
 * storage I/O (guarded for environments without `window`).
 */

const DISCLOSURE_STORAGE_PREFIX = 'disclosure:'
const OPEN_VALUE = 'open'
const CLOSED_VALUE = 'closed'

/** Namespaced localStorage key for a disclosure section. */
export function disclosureStorageKey(key: string): string {
  return `${DISCLOSURE_STORAGE_PREFIX}${key}`
}

/**
 * Interprets a stored value into an open/closed boolean. Unknown or missing
 * values fall back to `defaultOpen`, so a first-time user gets the section's
 * intended default and a corrupt value never wedges the UI closed.
 */
export function parseDisclosureOpen(stored: string | null, defaultOpen: boolean): boolean {
  if (stored === OPEN_VALUE) return true
  if (stored === CLOSED_VALUE) return false
  return defaultOpen
}

/** Serializes the open/closed boolean to its stored form. */
export function serializeDisclosureOpen(open: boolean): string {
  return open ? OPEN_VALUE : CLOSED_VALUE
}
