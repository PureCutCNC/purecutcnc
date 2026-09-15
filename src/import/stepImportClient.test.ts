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
 * The STEP import client's worker lifecycle (issue #784).
 *
 * The real worker needs a browser and Vite, so the import e2e covers it; here a
 * fake worker drives every way an import can end. Two properties matter: each
 * of them terminates the worker — a leaked worker keeps the whole Open CASCADE
 * heap alive — and nothing but a validated `completed` message yields bodies.
 *
 * Run with: npx tsx src/import/stepImportClient.test.ts
 */

import { StepImportError, isStepTessellateRequest, type StepImportErrorCode } from './stepProtocol'
import { MAX_STEP_TRIANGLES, tessellateStepFile, type StepWorkerLike } from './stepImportClient'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

let passed = 0
let failed = 0

async function test(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    passed += 1
    console.log(`   ✓ ${name}`)
  } catch (err: unknown) {
    failed += 1
    const msg = err instanceof Error ? err.message : String(err)
    console.log(`   ✗ ${name}: ${msg}`)
  }
}

class FakeWorker implements StepWorkerLike {
  readonly posted: Array<{ message: unknown, transfer: Transferable[] }> = []
  terminated = 0
  private readonly listeners = new Map<string, Array<(event: never) => void>>()

  postMessage(message: unknown, transfer: Transferable[]): void {
    this.posted.push({ message, transfer })
  }

  terminate(): void {
    this.terminated += 1
  }

  addEventListener(type: string, handler: (event: never) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), handler])
  }

  reply(data: unknown): void {
    this.emit('message', new MessageEvent('message', { data }))
  }

  crash(message: string): void {
    this.emit('error', Object.assign(new Event('error'), { message }))
  }

  private emit(type: string, event: Event): void {
    for (const handler of this.listeners.get(type) ?? []) (handler as (event: Event) => void)(event)
  }
}

const FILE = new TextEncoder().encode('ISO-10303-21;').buffer
const OPTIONS = { outputUnit: 'mm', linearDeflection: 0.01 } as const

async function expectRejection(promise: Promise<unknown>, code: StepImportErrorCode): Promise<StepImportError> {
  try {
    await promise
  } catch (error: unknown) {
    if (error instanceof StepImportError && error.code === code) return error
    throw new Error(`expected ${code}, got ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  throw new Error(`expected ${code}, but the import resolved`)
}

function completedBody() {
  return {
    name: 'Part',
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 2, 3]),
    index: new Uint32Array([0, 1, 2]),
  }
}

console.log('stepImportClient')

await test('a completed reply becomes bounded bodies, and the worker is terminated', async () => {
  const worker = new FakeWorker()
  const pending = tessellateStepFile(FILE, { ...OPTIONS, createWorker: () => worker })

  assert(worker.posted.length === 1, `posted: ${worker.posted.length}`)
  const { message, transfer } = worker.posted[0]
  assert(isStepTessellateRequest(message), 'the request validates')
  assert(message.maxTriangles === MAX_STEP_TRIANGLES, `maxTriangles: ${message.maxTriangles}`)
  assert(message.outputUnit === 'mm' && message.linearDeflection === 0.01, JSON.stringify(message))
  assert(message.bytes !== FILE && transfer[0] === message.bytes, 'a copy is transferred, not the caller buffer')
  assert(FILE.byteLength > 0, "the caller's buffer is still usable")

  worker.reply({ kind: 'completed', bodies: [completedBody()] })
  const bodies = await pending
  assert(bodies.length === 1 && bodies[0].name === 'Part', JSON.stringify(bodies.map((body) => body.name)))
  assert(bodies[0].mesh.bounds.maxY === 2 && bodies[0].mesh.bounds.maxZ === 3, JSON.stringify(bodies[0].mesh.bounds))
  assert(worker.terminated === 1, `terminated: ${worker.terminated}`)
})

await test('a failed reply rejects with its code and limit, and terminates', async () => {
  const worker = new FakeWorker()
  const pending = tessellateStepFile(FILE, { ...OPTIONS, createWorker: () => worker })
  worker.reply({ kind: 'failed', error: { code: 'too-many-triangles', limit: 5 } })
  const error = await expectRejection(pending, 'too-many-triangles')
  assert(error.limit === 5, `limit: ${error.limit}`)
  assert(worker.terminated === 1, `terminated: ${worker.terminated}`)
})

await test('a reply that does not validate is a worker failure, never bodies', async () => {
  const worker = new FakeWorker()
  const pending = tessellateStepFile(FILE, { ...OPTIONS, createWorker: () => worker })
  worker.reply({ kind: 'completed', bodies: [{ name: 'Part', positions: [0, 0, 0], index: [0, 0, 0] }] })
  await expectRejection(pending, 'worker-failed')
  assert(worker.terminated === 1, `terminated: ${worker.terminated}`)
})

await test('a crashed worker rejects with its message, and is terminated', async () => {
  const worker = new FakeWorker()
  const pending = tessellateStepFile(FILE, { ...OPTIONS, createWorker: () => worker })
  worker.crash('boom')
  const error = await expectRejection(pending, 'worker-failed')
  assert(error.detail === 'boom', `detail: ${error.detail}`)
  assert(worker.terminated === 1, `terminated: ${worker.terminated}`)
})

await test('cancelling terminates the worker, and a late reply changes nothing', async () => {
  const worker = new FakeWorker()
  const controller = new AbortController()
  const pending = tessellateStepFile(FILE, { ...OPTIONS, signal: controller.signal, createWorker: () => worker })
  controller.abort()
  await expectRejection(pending, 'cancelled')
  worker.reply({ kind: 'completed', bodies: [completedBody()] })
  assert(worker.terminated === 1, `terminated: ${worker.terminated}`)
})

await test('refusals decided up front never start a worker', async () => {
  let created = 0
  const createWorker = (): StepWorkerLike => {
    created += 1
    return new FakeWorker()
  }
  const aborted = new AbortController()
  aborted.abort()
  await expectRejection(tessellateStepFile(FILE, { ...OPTIONS, signal: aborted.signal, createWorker }), 'cancelled')
  const tooLarge = await expectRejection(
    tessellateStepFile(FILE, { ...OPTIONS, maxBytes: FILE.byteLength - 1, createWorker }),
    'file-too-large',
  )
  assert(tooLarge.limit === FILE.byteLength - 1, `limit: ${tooLarge.limit}`)
  await expectRejection(tessellateStepFile(FILE, { ...OPTIONS, linearDeflection: 0, createWorker }), 'invalid-tolerance')
  assert(created === 0, `workers created: ${created}`)
})

await test('a worker that cannot be constructed is an unavailable runtime', async () => {
  const createWorker = (): StepWorkerLike => {
    throw new Error('Worker is not defined')
  }
  const error = await expectRejection(tessellateStepFile(FILE, { ...OPTIONS, createWorker }), 'runtime-unavailable')
  assert(error.detail === 'Worker is not defined', `detail: ${error.detail}`)
})

console.log(`\n${passed} passed, ${failed} failed${failed > 0 ? ' ❌' : ' ✓'}\n`)

if (failed > 0) throw new Error(`${failed} test(s) failed`)
