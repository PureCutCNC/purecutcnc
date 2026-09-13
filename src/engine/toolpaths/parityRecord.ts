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
 * Canonicalisation for the issue #675 executor seam tests.
 *
 * The direct engine call and the executor result are independently constructed
 * object graphs, so they need one stable value encoding before comparison.
 */

/**
 * Deterministic JSON with recursively sorted object keys.
 *
 * Key order is not semantics, and hashing raw `JSON.stringify` output would
 * turn a harmless change in property construction order into a false parity
 * failure. Sorting compares values, which is what parity actually means.
 *
 * Numbers go through `JSON.stringify`'s own double formatting, which
 * round-trips IEEE-754 exactly — so this is a full-precision comparison, not a
 * rounded one.
 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value))
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value === null || typeof value !== 'object') return value
  const source = value as Record<string, unknown>
  const sorted: Record<string, unknown> = {}
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) sorted[key] = sortKeys(source[key])
  }
  return sorted
}
