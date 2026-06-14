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
 * Unit tests for the React-free cores of useLocalStorageState.
 * Run with: npx tsx src/hooks/useLocalStorageState.test.ts
 *
 * The hook itself needs a React renderer (not available in this harness), but
 * its load-bearing contracts — read existing value, parse-error fallback to the
 * default, write/serialize, and the SSR/no-storage path — all live in the cores
 * readStoredValue / readFromStorage / writeToStorage / jsonStorageCodec, which
 * are exercised directly here against a fake Storage.
 */

import {
  readStoredValue,
  readFromStorage,
  writeToStorage,
  jsonStorageCodec,
  type StorageCodec,
} from './useLocalStorageState'

function assert(condition: boolean, message: string) {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

/** Minimal in-memory Storage stand-in for getItem/setItem. */
function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map<string, string>(Object.entries(initial))
  return {
    getItem: (key: string): string | null => (map.has(key) ? map.get(key)! : null),
    setItem: (key: string, value: string): void => {
      map.set(key, value)
    },
    snapshot: (): Record<string, string> => Object.fromEntries(map),
  }
}

const json = jsonStorageCodec<unknown>()

// ---- readStoredValue: existing value / parse-error fallback / null → default ----

function testReadStoredValueParsesExisting() {
  console.log('Testing readStoredValue parses an existing stored value...')

  const value = readStoredValue('{"a":1}', { a: 0 }, jsonStorageCodec<{ a: number }>())
  assert(value.a === 1, 'existing JSON value is parsed, not the default')

  console.log('readStoredValue parse existing: PASSED')
}

function testReadStoredValueNullIsDefault() {
  console.log('Testing readStoredValue returns the default when the key is absent...')

  const fallback = { a: 42 }
  assert(readStoredValue(null, fallback, json) === fallback, 'null (absent key) → default (same ref)')

  console.log('readStoredValue null → default: PASSED')
}

function testReadStoredValueParseErrorIsDefault() {
  console.log('Testing readStoredValue falls back to the default on a parse error...')

  const fallback = { a: 7 }
  // Invalid JSON makes the default codec's deserialize throw.
  assert(readStoredValue('}{ not json', fallback, json) === fallback, 'corrupt value → default (same ref)')

  // A custom codec that throws on an unrecognized value (mirrors PanelSplit's
  // range validation) also falls back rather than propagating.
  const numberCodec: StorageCodec<number> = {
    serialize: (n) => String(n),
    deserialize: (raw) => {
      const parsed = Number.parseFloat(raw)
      if (!Number.isFinite(parsed) || parsed <= 0 || parsed >= 1) throw new Error('out of range')
      return parsed
    },
  }
  assert(readStoredValue('5', 0.5, numberCodec) === 0.5, 'out-of-range value → default')
  assert(readStoredValue('0.3', 0.5, numberCodec) === 0.3, 'in-range value → parsed')

  console.log('readStoredValue parse-error → default: PASSED')
}

// ---- readFromStorage: storage read + SSR/no-storage path ----

function testReadFromStorageReadsExisting() {
  console.log('Testing readFromStorage reads an existing key from storage...')

  const storage = fakeStorage({ 'k': '"hello"' })
  assert(readFromStorage(storage, 'k', 'fallback', json) === 'hello', 'reads + deserializes the stored value')
  assert(readFromStorage(storage, 'missing', 'fallback', json) === 'fallback', 'absent key → default')

  console.log('readFromStorage reads existing: PASSED')
}

function testReadFromStorageNoStorageIsDefault() {
  console.log('Testing readFromStorage returns the default when there is no storage (SSR)...')

  const fallback = { mode: 'ssr' }
  assert(readFromStorage(null, 'k', fallback, json) === fallback, 'null storage (no window) → default')

  console.log('readFromStorage no-storage → default: PASSED')
}

function testReadFromStorageGetItemThrowsIsDefault() {
  console.log('Testing readFromStorage falls back when getItem throws (storage disabled)...')

  const throwingStorage = {
    getItem: (): string | null => {
      throw new Error('SecurityError: storage disabled')
    },
  }
  assert(readFromStorage(throwingStorage, 'k', 'fallback', json) === 'fallback', 'throwing getItem → default')

  console.log('readFromStorage getItem-throws → default: PASSED')
}

// ---- writeToStorage: serialize + SSR/no-storage no-op + best-effort ----

function testWriteToStorageSerializes() {
  console.log('Testing writeToStorage serializes through the codec...')

  const storage = fakeStorage()
  writeToStorage(storage, 'k', { a: 1 }, json)
  assert(storage.snapshot()['k'] === '{"a":1}', 'value is JSON-serialized to storage')

  // Custom serializer controls the exact on-disk string (here: a bare boolean,
  // matching the depth-legend flag's `String(bool)` format).
  const boolCodec: StorageCodec<boolean> = {
    serialize: (b) => String(b),
    deserialize: (raw) => raw === 'true',
  }
  writeToStorage(storage, 'flag', true, boolCodec)
  assert(storage.snapshot()['flag'] === 'true', 'custom serializer preserves the exact stored form')

  console.log('writeToStorage serializes: PASSED')
}

function testWriteToStorageNoStorageIsNoop() {
  console.log('Testing writeToStorage is a no-op with no storage (SSR)...')

  // Must not throw when storage is null (server render path).
  writeToStorage(null, 'k', { a: 1 }, json)

  console.log('writeToStorage no-storage no-op: PASSED')
}

function testWriteToStorageSwallowsErrors() {
  console.log('Testing writeToStorage swallows a throwing setItem (quota/availability)...')

  const throwingStorage = {
    setItem: (): void => {
      throw new Error('QuotaExceededError')
    },
  }
  // Best-effort: a failed write must not propagate.
  writeToStorage(throwingStorage, 'k', 'v', { serialize: (s) => s })

  console.log('writeToStorage swallows errors: PASSED')
}

// ---- jsonStorageCodec round-trip ----

function testJsonCodecRoundTrip() {
  console.log('Testing jsonStorageCodec round-trips a value...')

  const codec = jsonStorageCodec<{ modes: string[]; enabled: boolean }>()
  const value = { modes: ['grid', 'point'], enabled: true }
  const restored = codec.deserialize(codec.serialize(value))
  assert(JSON.stringify(restored) === JSON.stringify(value), 'serialize → deserialize is identity')

  console.log('jsonStorageCodec round-trip: PASSED')
}

try {
  testReadStoredValueParsesExisting()
  testReadStoredValueNullIsDefault()
  testReadStoredValueParseErrorIsDefault()
  testReadFromStorageReadsExisting()
  testReadFromStorageNoStorageIsDefault()
  testReadFromStorageGetItemThrowsIsDefault()
  testWriteToStorageSerializes()
  testWriteToStorageNoStorageIsNoop()
  testWriteToStorageSwallowsErrors()
  testJsonCodecRoundTrip()
  console.log('\nAll useLocalStorageState core tests PASSED.')
} catch (e) {
  console.error(e)
  throw e
}
