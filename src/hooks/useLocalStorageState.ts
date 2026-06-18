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

import { useEffect, useState, type Dispatch, type SetStateAction } from 'react'
import { useStableEvent } from './useStableEvent'

/**
 * Codec for translating a value to/from its stored string form. Defaults to
 * JSON (see {@link jsonStorageCodec}); call sites with a different on-disk format
 * (a bare number, a `'true'`/`'false'` flag, an `'open'`/`'closed'` enum) pass a
 * custom codec so the exact stored representation is preserved.
 */
export interface StorageCodec<T> {
  /** Serialize a value to the string written to `localStorage`. */
  serialize: (value: T) => string
  /**
   * Parse a stored string back into a value. Throw (or return the result of
   * parsing) — a thrown error or a `null` stored value both fall back to the
   * provided default in {@link readStoredValue}.
   */
  deserialize: (raw: string) => T
}

/** Default JSON codec used when a call site does not supply its own. */
export function jsonStorageCodec<T>(): StorageCodec<T> {
  return {
    serialize: (value) => JSON.stringify(value),
    deserialize: (raw) => JSON.parse(raw) as T,
  }
}

/**
 * React-free core: resolve the initial value for a key from a raw stored string.
 *
 * Mirrors the hand-rolled pattern at every migrated call site: a `null` stored
 * value (key absent) yields the default, and a value that fails to
 * deserialize also falls back to the default rather than throwing — so a corrupt
 * or schema-shifted entry can never wedge the UI. This is the piece unit-tested
 * directly (the `useState` initializer just forwards to it).
 */
export function readStoredValue<T>(
  raw: string | null,
  defaultValue: T,
  codec: Pick<StorageCodec<T>, 'deserialize'>,
): T {
  if (raw === null) {
    return defaultValue
  }
  try {
    return codec.deserialize(raw)
  } catch {
    return defaultValue
  }
}

/**
 * React-free core: read the current value for `key` from a storage-like object,
 * SSR-safe. Returns the default when there is no storage (`storage === null`,
 * the `typeof window === 'undefined'` server path) or when a `getItem` throws
 * (storage disabled, e.g. some private-mode configurations).
 */
export function readFromStorage<T>(
  storage: Pick<Storage, 'getItem'> | null,
  key: string,
  defaultValue: T,
  codec: Pick<StorageCodec<T>, 'deserialize'>,
): T {
  if (!storage) {
    return defaultValue
  }
  try {
    return readStoredValue(storage.getItem(key), defaultValue, codec)
  } catch {
    return defaultValue
  }
}

/**
 * React-free core: write a value for `key` to a storage-like object, SSR-safe
 * and best-effort. A missing storage (server render) is a no-op, and a throwing
 * `setItem` (quota exceeded, storage disabled) is swallowed — persistence is
 * never allowed to break the in-session state, matching every call site's
 * existing try/catch (or unconditional, never-throwing) write.
 */
export function writeToStorage<T>(
  storage: Pick<Storage, 'setItem'> | null,
  key: string,
  value: T,
  codec: Pick<StorageCodec<T>, 'serialize'>,
): void {
  if (!storage) {
    return
  }
  try {
    storage.setItem(key, codec.serialize(value))
  } catch {
    // Best-effort: ignore quota/availability errors; in-memory state still holds.
  }
}

/** The browser `localStorage`, or `null` when there is no `window` (SSR). */
function getLocalStorage(): Pick<Storage, 'getItem' | 'setItem'> | null {
  return typeof window === 'undefined' ? null : window.localStorage
}

export interface UseLocalStorageStateOptions<T> {
  /** Custom serialize/deserialize. Defaults to {@link jsonStorageCodec}. */
  codec?: StorageCodec<T>
  /**
   * When `false`, persistence is fully disabled: the hook behaves as plain
   * in-memory `useState(defaultValue)` and never touches storage. Lets a call
   * site with an *optional* storage key (e.g. `PanelSplit`) keep its "no key →
   * in-memory only" branch without a conditional hook. Defaults to `true`.
   */
  enabled?: boolean
}

/**
 * A `useState`-like hook backed by `localStorage`.
 *
 * - **SSR-safe:** with no `window`, it behaves as plain in-memory state seeded
 *   from `defaultValue`; nothing is read or written.
 * - **Lazy initial read:** the stored value is read once in the `useState`
 *   initializer via {@link readFromStorage}; a missing key or a deserialize
 *   error falls back to `defaultValue`.
 * - **Persist on change:** an effect writes the current value (best-effort) on
 *   every change, so the setter API is identical to `useState`'s — callers do
 *   not manage persistence themselves.
 *
 * Storage I/O is concentrated in the React-free cores
 * ({@link readFromStorage} / {@link writeToStorage} / {@link readStoredValue}),
 * which carry the parse-fallback and SSR/no-window contracts and are unit-tested
 * without a DOM.
 *
 * Pass a custom `codec` when the on-disk format is not JSON (a bare number, a
 * `'true'`/`'false'` flag, …) so the stored representation stays byte-identical
 * to the previous hand-rolled site.
 */
export function useLocalStorageState<T>(
  key: string,
  defaultValue: T,
  options?: UseLocalStorageStateOptions<T>,
): [T, Dispatch<SetStateAction<T>>] {
  const codec = options?.codec ?? jsonStorageCodec<T>()
  const enabled = options?.enabled ?? true

  // The codec is commonly a fresh object each render (the default, or an inline
  // literal at the call site). Routing its `serialize` through useStableEvent
  // gives the persist effect a stable dependency, so it runs once per value
  // change (not on every render) without an exhaustive-deps suppression —
  // mirroring how usePortalPosition stabilizes its `measure` callback.
  const serializeStable = useStableEvent(codec.serialize)

  const [value, setValue] = useState<T>(() =>
    enabled ? readFromStorage(getLocalStorage(), key, defaultValue, codec) : defaultValue,
  )

  useEffect(() => {
    if (!enabled) {
      return
    }
    writeToStorage(getLocalStorage(), key, value, { serialize: serializeStable })
  }, [enabled, key, value, serializeStable])

  return [value, setValue]
}

export { useLocalStorageState as default }
