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
 * Tests for DisclosureSection's pure persistence helpers (A1.1). These cover
 * the parse/serialize/default logic so the collapsible "Advanced" sections
 * restore their state predictably and tolerate missing/corrupt stored values.
 *
 * Run with: npx tsx src/components/common/disclosureState.test.ts
 */

import {
  disclosureStorageKey,
  parseDisclosureOpen,
  serializeDisclosureOpen,
} from './disclosureState'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

// Storage key is namespaced so disclosure state never collides with other keys.
assert(disclosureStorageKey('feature-advanced') === 'disclosure:feature-advanced', 'storage key is namespaced')
assert(disclosureStorageKey('cam-operation-advanced') === 'disclosure:cam-operation-advanced', 'storage key passes through the id')

// Round-trips: a serialized value parses back to the same boolean.
assert(parseDisclosureOpen(serializeDisclosureOpen(true), false) === true, 'open round-trips')
assert(parseDisclosureOpen(serializeDisclosureOpen(false), true) === false, 'closed round-trips')

// Known stored values win over the default.
assert(parseDisclosureOpen('open', false) === true, 'stored "open" overrides a closed default')
assert(parseDisclosureOpen('closed', true) === false, 'stored "closed" overrides an open default')

// Missing or unrecognised values fall back to the supplied default.
assert(parseDisclosureOpen(null, true) === true, 'null falls back to defaultOpen=true')
assert(parseDisclosureOpen(null, false) === false, 'null falls back to defaultOpen=false')
assert(parseDisclosureOpen('garbage', true) === true, 'unknown value falls back to defaultOpen=true')
assert(parseDisclosureOpen('', false) === false, 'empty string falls back to defaultOpen=false')

console.log('disclosureState.test.ts passed')
