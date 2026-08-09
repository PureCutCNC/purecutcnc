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
 * Pure helpers for aggregating common and mixed values across a collection.
 * These are React-free and testable without a DOM or store.
 */

/**
 * Returns the common numeric value across `items` via `accessor`, or `null`
 * when values are mixed or the array is empty.
 */
export function commonNumber<T>(
  items: T[],
  accessor: (item: T) => number | undefined | null,
): number | null {
  if (items.length === 0) return null
  const first = accessor(items[0]!)
  if (first === undefined || first === null) return null
  for (let i = 1; i < items.length; i++) {
    const value = accessor(items[i]!)
    if (value !== first) return null
  }
  return first
}

/**
 * Returns the common boolean value across `items` via `accessor`, or `null`
 * when values are mixed or the array is empty.
 */
export function commonBoolean<T>(
  items: T[],
  accessor: (item: T) => boolean | undefined | null,
): boolean | null {
  if (items.length === 0) return null
  const first = accessor(items[0]!)
  if (first === undefined || first === null) return null
  for (let i = 1; i < items.length; i++) {
    const value = accessor(items[i]!)
    if (value !== first) return null
  }
  return first
}

/**
 * Returns the minimum numeric value from `items` via `accessor`.
 * Returns `null` when the array is empty or every value is null/undefined.
 */
export function minValue<T>(
  items: T[],
  accessor: (item: T) => number | undefined | null,
): number | null {
  let best: number | null = null
  for (const item of items) {
    const value = accessor(item)
    if (value !== null && value !== undefined && Number.isFinite(value)) {
      if (best === null || value < best) best = value
    }
  }
  return best
}

/**
 * Returns the maximum numeric value from `items` via `accessor`.
 * Returns `null` when the array is empty or every value is null/undefined.
 */
export function maxValue<T>(
  items: T[],
  accessor: (item: T) => number | undefined | null,
): number | null {
  let best: number | null = null
  for (const item of items) {
    const value = accessor(item)
    if (value !== null && value !== undefined && Number.isFinite(value)) {
      if (best === null || value > best) best = value
    }
  }
  return best
}

/**
 * Returns the expanded domain max for a group of Z values: the largest value
 * in the collection, or the given floor when the collection is empty.
 * This ensures the slider always includes current values even when they
 * exceed the nominal domain (e.g. stock thickness).
 */
export function zDomainMax(
  values: Array<number | null | undefined>,
  floor: number,
): number {
  let best = floor
  for (const value of values) {
    if (value !== null && value !== undefined && Number.isFinite(value) && value > best) {
      best = value
    }
  }
  return best
}
