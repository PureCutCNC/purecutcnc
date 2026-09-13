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
 * The generation worker, running on a real second thread (issue #675).
 *
 * Everything else in this folder tests the worker's *surroundings* — the
 * protocol shape, the queue, cloneability of the payloads. This runs the
 * shipped worker module itself, on its own thread, and asks the only question
 * that finally matters: **does a toolpath computed in a worker equal the one
 * the main thread produces?**
 *
 * The thread is a Node `worker_threads` worker rather than a browser
 * `Worker` (see `workerThreadAdapter.ts`), which shares the structured-clone
 * transport and the separate-realm module state, but not the bundler or the
 * asset URL resolution. Those need a browser and arrive with the consumer
 * migration; this suite is deliberate about not claiming them.
 */

import { createHash } from 'node:crypto'
import { Worker } from 'node:worker_threads'
import { computeOperationToolpath } from '../../engine/toolpaths/generateOperation'
import { buildParityCorpus, postParityCase } from '../../engine/toolpaths/parityCorpus'
import { canonicalize } from '../../engine/toolpaths/parityRecord'
import { TOOLPATH_PROTOCOL_VERSION, isWorkerToMain, resolveOperation } from './protocol'
import { unpackResult } from './moveTransport'
import type { WorkerToMain } from './protocol'
import type { RequestIdentity } from './types'

const ADAPTER_URL = new URL('./workerThreadAdapter.ts', import.meta.url).href

/**
 * A plain-JavaScript bootstrap, evaluated as the worker's entry.
 *
 * Pointing `new Worker()` straight at the TypeScript adapter works on Node 26
 * but fails on Node 20 — which is what CI runs — with
 * `ERR_UNKNOWN_FILE_EXTENSION`: the worker's *entry* is resolved before the
 * TypeScript hooks that `--import tsx` registers are in effect, so the loader
 * never gets a chance at it. A dynamic `import()` from an already-running
 * plain-JS entry happens after registration, so it does.
 *
 * The catch matters: an unhandled rejection here would surface as a worker that
 * simply never sends `ready`, and the suite would fail on a timeout that says
 * nothing about the cause.
 */
const BOOTSTRAP = `
  import('tsx/esm/api')
    .then((tsx) => tsx.tsImport(${JSON.stringify(ADAPTER_URL)}, ${JSON.stringify(import.meta.url)}))
    .catch((error) => {
      require('node:worker_threads').parentPort.postMessage({
        kind: 'bootstrapFailed',
        message: String(error && error.stack ? error.stack : error),
      })
    })
`

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) { passed += 1; console.log(`   ✓ ${name}`); return }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

/** A minimal main-thread driver: send, and await the message that answers. */
function createDriver(): {
  worker: Worker
  ready: Promise<WorkerToMain & { kind: 'ready' }>
  send: (message: unknown) => void
  await: (predicate: (message: WorkerToMain) => boolean) => Promise<WorkerToMain>
  close: () => Promise<void>
} {
  const worker = new Worker(BOOTSTRAP, { eval: true })
  worker.on('message', (data: unknown) => {
    const message = data as { kind?: string; message?: string }
    if (message?.kind === 'bootstrapFailed') {
      console.log(`   ✗ worker bootstrap failed: ${message.message ?? 'unknown'}`)
      process.exit(1)
    }
  })
  const waiting: { predicate: (message: WorkerToMain) => boolean; resolve: (message: WorkerToMain) => void }[] = []
  const buffered: WorkerToMain[] = []

  worker.on('message', (data: unknown) => {
    if (!isWorkerToMain(data)) return
    const index = waiting.findIndex((entry) => entry.predicate(data))
    if (index >= 0) waiting.splice(index, 1)[0].resolve(data)
    else buffered.push(data)
  })

  const awaitMessage = (predicate: (message: WorkerToMain) => boolean): Promise<WorkerToMain> => {
    const index = buffered.findIndex(predicate)
    if (index >= 0) return Promise.resolve(buffered.splice(index, 1)[0])
    return new Promise((resolve) => { waiting.push({ predicate, resolve }) })
  }

  return {
    worker,
    ready: awaitMessage((message) => message.kind === 'ready') as Promise<WorkerToMain & { kind: 'ready' }>,
    send: (message: unknown) => { worker.postMessage(message) },
    await: awaitMessage,
    close: async () => { await worker.terminate() },
  }
}

async function main(): Promise<void> {
  console.log('\nGeneration worker on a real thread (live engine result)')

  const corpus = buildParityCorpus()
  const byKind = new Map<string, typeof corpus[number]>()
  for (const parityCase of corpus) {
    const operation = resolveOperation(parityCase.project, parityCase.operationId)
    if (operation && !byKind.has(operation.kind)) byKind.set(operation.kind, parityCase)
  }

  const driver = createDriver()
  const ready = await driver.ready
  check(
    'the worker completes its handshake with a matching protocol version',
    ready.protocolVersion === TOOLPATH_PROTOCOL_VERSION,
    `expected ${TOOLPATH_PROTOCOL_VERSION}, got ${ready.protocolVersion}`,
  )

  let requestId = 1
  let snapshotId = 1

  for (const [kind, parityCase] of byKind) {
    const operation = resolveOperation(parityCase.project, parityCase.operationId)!
    const expected = computeOperationToolpath(parityCase.project, operation, { trace: true })
    if (!expected || !expected.raw) {
      check(`${kind} direct engine`, false, 'expected a traced engine result')
      continue
    }

    driver.send({ kind: 'loadSnapshot', documentKey: 1, snapshotId, project: parityCase.project })
    await driver.await((message) => message.kind === 'snapshotReady' && message.snapshotId === snapshotId)

    const identity: RequestIdentity = {
      documentKey: 1, workerEpoch: 0, requestId, snapshotId,
      operationId: parityCase.operationId, traceMode: true,
    }
    driver.send({ kind: 'generate', identity })
    const answer = await driver.await(
      (message) => (message.kind === 'completed' || message.kind === 'failed')
        && message.identity.requestId === requestId,
    )
    requestId += 1
    snapshotId += 1

    if (answer.kind !== 'completed') {
      check(`${kind} on the worker thread`, false, `worker failed: ${JSON.stringify(answer)}`)
      continue
    }

    // Unpacked here rather than compared packed: since slice 6 the moves cross
    // as transferred buffers, so these assertions cover the whole trip —
    // generation, packing, transfer and unpacking — against a main-thread call.
    const result = unpackResult(answer.result)
    const raw = answer.raw ? unpackResult(answer.raw) : null

    check(
      `${kind}: worker result equals the direct engine result`,
      sha256(canonicalize(result)) === sha256(canonicalize(expected.result)),
      'the worker result differs from the engine result',
    )
    check(
      `${kind}: worker raw trace equals the direct engine result`,
      raw !== null && sha256(canonicalize(raw)) === sha256(canonicalize(expected.raw)),
      'the worker raw trace differs from the engine result',
    )
    check(
      `${kind}: G-code posted from the worker result equals the engine result`,
      sha256(postParityCase(parityCase.project, operation, result))
        === sha256(postParityCase(parityCase.project, operation, expected.result)),
      'the posted program differs from the engine result',
    )
  }

  // Order dependence: module-level caches in the worker's realm persist between
  // requests, so a snapshot replaced and an earlier operation re-run must still
  // give the same answer. An A/B/A sequence is what exposes that.
  const kinds = [...byKind.entries()]
  if (kinds.length >= 2) {
    const [firstKind, first] = kinds[0]
    const [, second] = kinds[1]
    const firstOperation = resolveOperation(first.project, first.operationId)!
    const firstExpected = computeOperationToolpath(first.project, firstOperation)
    for (const parityCase of [second, first]) {
      driver.send({ kind: 'loadSnapshot', documentKey: 1, snapshotId, project: parityCase.project })
      await driver.await((message) => message.kind === 'snapshotReady' && message.snapshotId === snapshotId)
      const identity: RequestIdentity = {
        documentKey: 1, workerEpoch: 0, requestId, snapshotId,
        operationId: parityCase.operationId, traceMode: false,
      }
      driver.send({ kind: 'generate', identity })
      const answer = await driver.await(
        (message) => (message.kind === 'completed' || message.kind === 'failed')
          && message.identity.requestId === requestId,
      )
      requestId += 1
      snapshotId += 1
      if (parityCase === first) {
        check(
          `A/B/A: ${firstKind} is unchanged after another snapshot was installed`,
          answer.kind === 'completed'
            && firstExpected !== null
            && sha256(canonicalize(unpackResult(answer.result))) === sha256(canonicalize(firstExpected.result)),
          'a re-run after a snapshot swap produced a different result',
        )
      }
    }
  }

  // Protocol rejection: a generate naming a snapshot the worker does not hold
  // must fail, not compute something from whatever it has installed.
  const stray: RequestIdentity = {
    documentKey: 1, workerEpoch: 0, requestId, snapshotId: 9999,
    operationId: kinds[0][1].operationId, traceMode: false,
  }
  driver.send({ kind: 'generate', identity: stray })
  const rejected = await driver.await(
    (message) => (message.kind === 'failed' || message.kind === 'completed')
      && message.identity.requestId === requestId,
  )
  check(
    'a generate for an uninstalled snapshot is refused',
    rejected.kind === 'failed' && rejected.failure.category === 'protocol',
    `expected a protocol failure, got ${rejected.kind}`,
  )

  await driver.close()

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
