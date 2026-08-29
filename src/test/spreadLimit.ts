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

/** Ceiling for the search — an engine that spreads this much has no limit worth testing against. */
const SEARCH_CEILING = 1_048_576

/**
 * The largest array this engine can spread into a call, measured by search.
 *
 * `target.push(...source)` passes one *argument* per element and throws
 * `RangeError: Maximum call stack size exceeded` past the engine's argument
 * limit — 124,413 on node v26.0.0 at the default stack size (issue #668).
 *
 * The limit moves with the stack size and the engine, so a test that must
 * exceed it measures it rather than hard-coding it. A fixture that quietly
 * stopped exceeding the real limit would otherwise keep passing while proving
 * nothing; measured, it fails and says so.
 *
 * The value depends slightly on how deep the stack already is at the call, so
 * treat it as approximate and leave real headroom rather than sitting on it.
 */
export function maxSpreadableLength(): number {
  if (cached !== null) return cached

  let low = 1
  let high = 2
  while (high < SEARCH_CEILING && canSpread(high)) {
    low = high
    high *= 2
  }
  if (high >= SEARCH_CEILING && canSpread(SEARCH_CEILING)) {
    cached = SEARCH_CEILING
    return cached
  }
  while (low < high - 1) {
    const mid = Math.floor((low + high) / 2)
    if (canSpread(mid)) low = mid
    else high = mid
  }
  cached = low
  return cached
}

let cached: number | null = null

function canSpread(length: number): boolean {
  const source = new Array<number>(length).fill(0)
  try {
    const target: number[] = []
    target.push(...source)
    return true
  } catch {
    return false
  }
}
