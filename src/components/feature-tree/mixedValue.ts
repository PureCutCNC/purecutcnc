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
 * in the collection, or the given floor when the collection is empty / every
 * value is below it.
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

/**
 * Returns a clamp Z display domain: the largest current clamp height plus
 * a unit-aware headroom, floored at a useful minimum.
 *
 * Stock thickness is deliberately NOT included — clamp domains are
 * independent of stock, and headroom above the current maximum gives the
 * user room to increase values without re-rendering into a wider domain.
 */
export function clampDomainMax(
  values: Array<number | null | undefined>,
  floor: number,
  headroom: number,
): number {
  let best = floor
  for (const value of values) {
    if (value !== null && value !== undefined && Number.isFinite(value) && value > best) {
      best = value
    }
  }
  return best + headroom
}

/**
 * Pure constraint for a Z-range handle value.
 *
 * - `isTop`: the handle is the Z-top — constrained to [max(opposite, domainMin), domainMax].
 * - `!isTop`: the handle is Z-bottom — constrained to [domainMin, min(opposite, domainMax)].
 *
 * When `oppositeValue` is null (mixed or unknown) only the domain bounds apply.
 * Equality is valid (z_bottom === z_top) — no artificial minimum separation.
 */
export function constrainZ(
  value: number,
  isTop: boolean,
  domainMin: number,
  domainMax: number,
  oppositeValue: number | null,
): number {
  if (isTop) {
    const lower = oppositeValue !== null ? Math.max(oppositeValue, domainMin) : domainMin
    return Math.max(lower, Math.min(domainMax, value))
  }
  const upper = oppositeValue !== null ? Math.min(oppositeValue, domainMax) : domainMax
  return Math.max(domainMin, Math.min(upper, value))
}

/**
 * Validates whether the given Z-ranges patch is valid for every selected item.
 *
 * Returns `true` when the edit would satisfy z_bottom ≤ z_top for all items.
 *
 * When `patch.top` is present, requires `patch.top >= getBottom(item)` for every item.
 * When `patch.bottom` is present, requires `patch.bottom <= getTop(item)` for every item.
 */
export function validateZEdits<T>(
  items: T[],
  getTop: (item: T) => number,
  getBottom: (item: T) => number,
  patch: { top?: number; bottom?: number },
): boolean {
  if (patch.top !== undefined) {
    const top = patch.top
    for (const item of items) {
      if (top < getBottom(item)) return false
    }
  }
  if (patch.bottom !== undefined) {
    const bottom = patch.bottom
    for (const item of items) {
      if (bottom > getTop(item)) return false
    }
  }
  return true
}

/**
 * ARIA value-min/max for a Z-range slider handle, reflecting the opposite
 * handle's committed value when known.  When the opposite handle is mixed
 * (null) the domain bounds are exposed verbatim.
 */
export function zHandleAriaBounds(
  isTop: boolean,
  domainMin: number,
  domainMax: number,
  oppositeValue: number | null,
): { valuemin: number; valuemax: number } {
  if (isTop) {
    const lower = oppositeValue !== null ? Math.max(oppositeValue, domainMin) : domainMin
    return { valuemin: lower, valuemax: domainMax }
  }
  const upper = oppositeValue !== null ? Math.min(oppositeValue, domainMax) : domainMax
  return { valuemin: domainMin, valuemax: upper }
}
