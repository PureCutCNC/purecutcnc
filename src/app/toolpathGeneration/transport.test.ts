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
 * Worker transport: protocol validation, cloneability, and value fidelity
 * across the thread boundary (issue #675).
 *
 * The question this suite answers is narrow and load-bearing: **does sending a
 * project to a worker and a result back change anything?** The parity corpus
 * proves the extracted pipeline computes the right answer; this proves the
 * answer survives the trip.
 *
 * It runs `structuredClone` — the exact algorithm `postMessage` uses — rather
 * than simulating transport with JSON. That distinction is the whole point:
 * JSON drops `undefined` keys and turns `NaN`/`Infinity` into `null`, all three
 * of which occur in real toolpath metadata, so a JSON-based test would pass
 * while the real transport corrupted data.
 */

import { computeOperationToolpath } from '../../engine/toolpaths'
import { buildParityCorpus, postParityCase } from '../../engine/toolpaths/parityCorpus'
import { canonicalize } from '../../engine/toolpaths/parityRecord'
import {
  TOOLPATH_PROTOCOL_VERSION,
  completedMatchesTraceMode,
  identityEquals,
  isMainToWorker,
  isRequestIdentity,
  isToolpathResultShape,
  isWorkerToMain,
  resolveOperation,
} from './protocol'
import type { CompletedMessage } from './protocol'
import type { RequestIdentity } from './types'
import type { Project } from '../../types/project'
import { packResult } from './moveTransport'

/** A minimal well-formed transported result, for the protocol shape checks. */
const emptyTransported = packResult({ operationId: 'a', moves: [], warnings: [], bounds: null })

let passed = 0
let failed = 0

function test(name: string, fn: () => void): void {
  try {
    fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (error: unknown) {
    failed += 1
    console.log(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

const identity: RequestIdentity = {
  documentKey: 1,
  workerEpoch: 0,
  requestId: 7,
  snapshotId: 3,
  operationId: 'op1',
  traceMode: false,
}

console.log('\nProtocol validation')

test('a well-formed identity validates', () => {
  assert(isRequestIdentity(identity), 'the reference identity should validate')
})

test('every identity field is required', () => {
  for (const key of Object.keys(identity) as (keyof RequestIdentity)[]) {
    const partial = { ...identity }
    delete partial[key]
    assert(!isRequestIdentity(partial), `a missing ${key} must not validate`)
  }
})

test('non-finite numeric identity fields are rejected', () => {
  assert(!isRequestIdentity({ ...identity, requestId: Number.NaN }), 'NaN must not validate')
  assert(!isRequestIdentity({ ...identity, snapshotId: Number.POSITIVE_INFINITY }), 'Infinity must not validate')
})

test('identityEquals compares every field', () => {
  assert(identityEquals(identity, { ...identity }), 'an identical copy matches')
  for (const [key, value] of [
    ['documentKey', 2], ['workerEpoch', 1], ['requestId', 8],
    ['snapshotId', 4], ['operationId', 'other'], ['traceMode', true],
  ] as [keyof RequestIdentity, unknown][]) {
    assert(!identityEquals(identity, { ...identity, [key]: value } as RequestIdentity), `${key} must be compared`)
  }
})

test('unknown message kinds are rejected at both ends', () => {
  assert(!isWorkerToMain({ kind: 'nonsense' }), 'worker→main rejects an unknown kind')
  assert(!isMainToWorker({ kind: 'nonsense' }), 'main→worker rejects an unknown kind')
  assert(!isWorkerToMain(null), 'null is not a message')
  assert(!isWorkerToMain('completed'), 'a string is not a message')
})

test('a completed message without a valid result shape is rejected', () => {
  assert(!isWorkerToMain({ kind: 'completed', identity, result: {}, raw: null }), 'an empty result is rejected')
  assert(
    !isWorkerToMain({ kind: 'completed', identity, result: emptyTransported, raw: 'x' }),
    'a non-object raw is rejected',
  )
  assert(
    // An unpacked result on the wire is now a protocol violation, not a
    // tolerated older shape: v2 carries packed moves.
    !isWorkerToMain({ kind: 'completed', identity, result: { operationId: 'a', moves: [], warnings: [], bounds: null }, raw: null }),
    'an unpacked result is rejected under protocol v2',
  )
  assert(
    isWorkerToMain({ kind: 'completed', identity, result: emptyTransported, raw: null }),
    'a well-formed completed message validates',
  )
})

test('a result whose trace flag disagrees with its payload is rejected', () => {
  const result = emptyTransported
  const traced: CompletedMessage = { kind: 'completed', identity: { ...identity, traceMode: true }, result, raw: null }
  assert(!completedMatchesTraceMode(traced), 'a trace request answered without a raw path is a mismatch')
  const untraced: CompletedMessage = { kind: 'completed', identity, result, raw: result }
  assert(!completedMatchesTraceMode(untraced), 'a non-trace request answered with a raw path is a mismatch')
  assert(
    completedMatchesTraceMode({ kind: 'completed', identity, result, raw: null }),
    'a matched pair passes',
  )
})

test('loadSnapshot requires a project carrying operations', () => {
  assert(!isMainToWorker({ kind: 'loadSnapshot', documentKey: 1, snapshotId: 1, project: {} }), 'a project without operations is rejected')
  assert(
    isMainToWorker({ kind: 'loadSnapshot', documentKey: 1, snapshotId: 1, project: { operations: [] } }),
    'a project with operations validates',
  )
})

test('the protocol version is a positive integer', () => {
  assert(Number.isInteger(TOOLPATH_PROTOCOL_VERSION) && TOOLPATH_PROTOCOL_VERSION > 0, 'version must be a positive integer')
})

console.log('\nStructured-clone transport')

const corpus = buildParityCorpus()

// Generating from a clone re-runs the whole pipeline, so the round-trip covers
// one case per operation kind rather than all 41 — enough to exercise every
// generator's result shape without tripling the suite's runtime. Cloneability
// itself is checked on every case below, including the million-move ones.
const byKind = new Map<string, typeof corpus[number]>()
for (const parityCase of corpus) {
  const operation = resolveOperation(parityCase.project, parityCase.operationId)
  if (operation && !byKind.has(operation.kind)) byKind.set(operation.kind, parityCase)
}

test(`round-trip covers every operation kind (${[...byKind.keys()].sort().join(', ')})`, () => {
  assert(byKind.size >= 9, `expected every kind represented, got ${byKind.size}`)
})

for (const [kind, parityCase] of byKind) {
  test(`${kind}: a project survives the clone and generates identically`, () => {
    const clonedProject = structuredClone(parityCase.project) as Project
    const original = resolveOperation(parityCase.project, parityCase.operationId)!
    const cloned = resolveOperation(clonedProject, parityCase.operationId)!

    const before = computeOperationToolpath(parityCase.project, original, { trace: true })!
    const after = computeOperationToolpath(clonedProject, cloned, { trace: true })!

    assert(
      canonicalize(before.result) === canonicalize(after.result),
      'generating from a cloned project produced a different result',
    )
    assert(
      canonicalize(before.raw) === canonicalize(after.raw),
      'generating from a cloned project produced a different raw trace',
    )
    assert(
      postParityCase(parityCase.project, original, before.result)
        === postParityCase(clonedProject, cloned, after.result),
      'the posted G-code differs after a project round-trip',
    )
  })

  test(`${kind}: a result survives the clone unchanged`, () => {
    const operation = resolveOperation(parityCase.project, parityCase.operationId)!
    const envelope = computeOperationToolpath(parityCase.project, operation, { trace: true })!
    const cloned = structuredClone(envelope.result)
    assert(canonicalize(envelope.result) === canonicalize(cloned), 'the result changed in transport')
    assert(isToolpathResultShape(cloned), 'the cloned result fails its own shape check')
    const clonedRaw = structuredClone(envelope.raw)
    assert(canonicalize(envelope.raw) === canonicalize(clonedRaw), 'the raw trace changed in transport')
  })
}

test('every corpus project is cloneable, including imported meshes', () => {
  for (const parityCase of corpus) {
    try {
      structuredClone(parityCase.project)
    } catch (error: unknown) {
      throw new Error(`${parityCase.id} is not cloneable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
})

test('generation does not mutate the project it was handed', () => {
  // Deep-freeze rather than compare before/after: a frozen object throws on the
  // write, which names the moment of mutation instead of only proving that one
  // happened somewhere.
  const deepFreeze = (value: unknown, seen = new Set<unknown>()): void => {
    if (value === null || typeof value !== 'object' || seen.has(value)) return
    seen.add(value)
    Object.freeze(value)
    for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry, seen)
  }
  for (const [kind, parityCase] of byKind) {
    const project = structuredClone(parityCase.project) as Project
    deepFreeze(project)
    const operation = resolveOperation(project, parityCase.operationId)!
    try {
      computeOperationToolpath(project, operation, { trace: true })
    } catch (error: unknown) {
      throw new Error(`${kind} mutated its input project: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
