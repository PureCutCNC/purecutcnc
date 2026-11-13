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
 * Generated-outline cache for canned shapes (issue #1112 A2).
 *
 * A resolution runs on every hover, every selection hit test and every redraw,
 * so the same definition must not call its generator each time. The entry key
 * is the kind plus the normalized parameters serialized canonically — a
 * parameter change therefore misses the cache instead of needing an explicit
 * invalidation, and registering a replacement generator clears that kind
 * outright. Parameters are JSON-only (`CannedShapeParams`), so the key is
 * stable across a save/load round trip.
 */

import type { CannedShapeParams } from '../types/project'
import type { CannedShapeOutline, RegisteredCannedShapeGenerator } from './types'

const MAX_CACHE_ENTRIES = 64

const outlinesByKey = new Map<string, CannedShapeOutline[]>()

function stableValueKey(value: CannedShapeParams[string]): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableValueKey).join(',')}]`
  }
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableValueKey(value[key])}`)
      .join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** Canonical serialization of a normalized parameter object. */
export function cannedParamsKey(params: CannedShapeParams): string {
  return stableValueKey(params)
}

/**
 * The generator's outlines for these parameters, generated at most once per
 * (kind, params) pair. Returns the same array on a hit; callers must treat it
 * as read-only.
 */
export function cachedCannedShapeOutlines(
  generator: RegisteredCannedShapeGenerator,
  params: CannedShapeParams,
): CannedShapeOutline[] {
  const key = `${generator.kind}\u0000${cannedParamsKey(params)}`
  const cached = outlinesByKey.get(key)
  if (cached) {
    // Refresh insertion order so the small entries a redraw keeps asking for
    // survive while one-off previews age out.
    outlinesByKey.delete(key)
    outlinesByKey.set(key, cached)
    return cached
  }

  const outlines = generator.generate(params)
  outlinesByKey.set(key, outlines)
  if (outlinesByKey.size > MAX_CACHE_ENTRIES) {
    const oldest = outlinesByKey.keys().next().value
    if (oldest !== undefined) outlinesByKey.delete(oldest)
  }
  return outlines
}

/** Drop cached outlines for one kind, or for every kind when omitted. */
export function clearCannedShapeCache(kind?: string): void {
  if (kind === undefined) {
    outlinesByKey.clear()
    return
  }
  const prefix = `${kind}\u0000`
  for (const key of outlinesByKey.keys()) {
    if (key.startsWith(prefix)) outlinesByKey.delete(key)
  }
}
