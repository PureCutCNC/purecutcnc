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
 * The app's rotary generation path, end to end through the angle pool
 * (issue #1115, slice p-d3).
 *
 * Everything here runs the **shipped** modules on real threads:
 *
 * - `toolpath.worker.ts` through `workerThreadAdapter.ts`, exactly as
 *   `workerRuntime.test.ts` runs it;
 * - the main thread's half is the production `createRotaryAnglePoolHost`, so
 *   the `ready` → `attach` handshake and the port transfer are the ones the
 *   browser uses;
 * - the angle workers are `rotaryAngle.worker.ts` through
 *   `rotaryAngleWorkerThreadAdapter.ts` — the browser module on a Node thread.
 *
 * Only the runtime-specific `Worker` construction differs from production, which
 * is exactly the seam `workerRuntime.test.ts` accepts for the generation worker.
 *
 * What is asserted, and why each one would otherwise be a silent regression:
 *
 * - **Output parity.** The same fixture generated through the pool and on the
 *   main thread gives identical moves, bounds, warnings and posted G-code. The
 *   pool changes where an angle runs, never what it computes.
 * - **Cancellation.** A request that arrives while the first is waiting on angle
 *   workers ends it; the second result equals a fresh run and the first never
 *   posts anything. This is the property the generation counter exists for.
 * - **Fallback.** A worker that cannot be created, one that fails to load, and a
 *   computation error: the first two rerun serially with identical output, the
 *   last stays an error. A pool failure is not allowed to hide the operation,
 *   and a kernel fault is not allowed to hide behind a serial retry.
 *
 * The p-a benchmark fixtures are 32 MB `.camj` files in the gitignored `work/`
 * and cost about 35 s of generation per operation, so the full-fixture parity
 * run is off by default: set `ROTARY_PARITY_FIXTURES=1` with
 * `work/busto-rect-stock.camj` and `work/busto-round-stock.camj` present.
 *
 * Run with: npx tsx src/app/toolpathGeneration/rotaryPoolAppPath.test.ts
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'

import { BUNDLED_DEFINITIONS } from '../../engine/gcode/definitions'
import { runPostProcessor } from '../../engine/gcode/postprocessor'
import { validateMachineDefinition } from '../../engine/gcode/types'
import type { MachineDefinition } from '../../engine/gcode/types'
import { computeOperationToolpath } from '../../engine/toolpaths/generateOperation'
import type { OperationToolpathEnvelope } from '../../engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../../engine/toolpaths/geometry'
import { canonicalize } from '../../engine/toolpaths/parityRecord'
import { ROTARY_ANGLE_PROTOCOL_VERSION } from '../../engine/toolpaths/rotaryAngleProtocol'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import { normalizeProject } from '../../store/helpers/projectFormat'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import type { Operation, Project } from '../../types/project'
import { unpackResult } from './moveTransport'
import { isWorkerToMain } from './protocol'
import type { WorkerToMain } from './protocol'
import { createRotaryAnglePoolHost } from './rotaryAngleBrowserTransport'
import type { RotaryAngleHostWorker, RotaryAnglePoolHost } from './rotaryAngleBrowserTransport'

const HERE = dirname(fileURLToPath(import.meta.url))

/** The generation worker on a real thread, through the shipped adapter. */
const GENERATION_ADAPTER_URL = new URL('./workerThreadAdapter.ts', import.meta.url).href
const ANGLE_ADAPTER_URL = new URL('./rotaryAngleWorkerThreadAdapter.ts', import.meta.url).href

/**
 * A plain-JavaScript bootstrap, evaluated as the worker's entry. Pointing
 * `new Worker()` at a TypeScript module fails on Node 20 (the entry resolves
 * before `--import tsx` registers), so the adapter is imported from an
 * already-running plain-JS entry. The catch turns a load failure into a message
 * the test would otherwise have to explain as a bare timeout.
 */
function bootstrap(adapterUrl: string): string {
  return `
    import('tsx/esm/api')
      .then((tsx) => tsx.tsImport(${JSON.stringify(adapterUrl)}, ${JSON.stringify(import.meta.url)}))
      .catch((error) => {
        require('node:worker_threads').parentPort.postMessage({
          kind: 'bootstrapFailed',
          message: String(error && error.stack ? error.stack : error),
        })
      })
  `
}

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) { passed += 1; console.log(`   ✓ ${name}`); return }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

/** A main-thread generation driver: send, and await the message that answers. */
interface GenerationDriver {
  worker: Worker
  ready: Promise<WorkerToMain & { kind: 'ready' }>
  send: (message: unknown) => void
  await: (predicate: (message: WorkerToMain) => boolean) => Promise<WorkerToMain>
  close: () => Promise<void>
}

function createGenerationDriver(): GenerationDriver {
  const worker = new Worker(bootstrap(GENERATION_ADAPTER_URL), { eval: true })
  worker.on('message', (data: unknown) => {
    const message = data as { kind?: string; message?: string }
    if (message?.kind !== 'bootstrapFailed') return
    console.log(`   ✗ generation worker bootstrap failed: ${message.message ?? 'unknown'}`)
    process.exit(1)
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

/** The generation worker plus the main-thread pool host, wired as the app wires them. */
interface AppPath {
  readonly driver: GenerationDriver
  readonly host: RotaryAnglePoolHost
  /** `rotaryWorker` requests the harness is holding instead of attaching. */
  readonly held: { slot: number; port: MessagePort }[]
  /** Every terminal message this worker posted, in arrival order. */
  readonly terminal: WorkerToMain[]
  /**
   * `rotaryWorkerFailed` messages forwarded to the coordinator. A startup
   * failure has to reach the pool as a *failure*, not as a reply that never
   * comes: without this, the test would still pass on the port transport's own
   * 30 s startup backstop and prove nothing about the failure path.
   */
  readonly failures: string[]
  holdRequests(): void
  releaseHeld(): void
  close(): Promise<void>
}

interface AppPathOptions {
  /** Replace the angle worker construction; production uses the module worker. */
  readonly createAngleWorker?: () => RotaryAngleHostWorker
  readonly startupTimeoutMs?: number
  /** Called for every `rotaryWorker` request before it is attached. */
  readonly onWorkerRequest?: () => void
}

/**
 * Adapt a Node `worker_threads` worker to the main thread's `Worker` contract.
 *
 * The one difference that matters is event shape: a browser worker delivers
 * `MessageEvent`s, while `worker_threads` passes the value itself.
 */
function adaptWorker(worker: Worker): RotaryAngleHostWorker {
  return {
    postMessage: (message: unknown, transfer?: Transferable[]) => {
      worker.postMessage(message, transfer as never)
    },
    addEventListener: (type: string, handler: (event: never) => void) => {
      if (type === 'message') {
        worker.on('message', (value: unknown) => { (handler as (event: unknown) => void)({ data: value }) })
      } else if (type === 'error') {
        worker.on('error', (error: Error) => { (handler as (event: unknown) => void)(error) })
      } else if (type === 'messageerror') {
        worker.on('messageerror', (error: Error) => { (handler as (event: unknown) => void)(error) })
      }
    },
    terminate: () => { void worker.terminate() },
  }
}

function createAppPath(options: AppPathOptions = {}): AppPath {
  const driver = createGenerationDriver()
  const held: { slot: number; port: MessagePort }[] = []
  let holding = false
  const createAngleWorker = options.createAngleWorker
  let host: RotaryAnglePoolHost | null = null
  host = createRotaryAnglePoolHost({
    ...(createAngleWorker !== undefined ? { createWorker: createAngleWorker } : {}),
    ...(options.startupTimeoutMs !== undefined ? { startupTimeoutMs: options.startupTimeoutMs } : {}),
    onFailure: (slot, message) => {
      failures.push(message)
      driver.send({ kind: 'rotaryWorkerFailed', slot, message })
    },
  })

  const terminal: WorkerToMain[] = []
  const failures: string[] = []

  driver.worker.on('message', (data: unknown) => {
    if (!isWorkerToMain(data)) return
    if (data.kind === 'completed' || data.kind === 'failed') terminal.push(data)
    if (data.kind === 'rotaryWorker') {
      options.onWorkerRequest?.()
      if (holding) {
        held.push({ slot: data.slot, port: data.port })
        return
      }
      host?.attach(data.slot, data.port)
      return
    }
    if (data.kind === 'rotaryRelease') {
      // A released slot must not be attached afterwards: the coordinator has
      // closed its end, and a worker created for it would sample nothing.
      const index = held.findIndex((entry) => entry.slot === data.slot)
      if (index >= 0) held.splice(index, 1)
      host?.release(data.slot)
    }
  })

  return {
    driver,
    get host() { return host as RotaryAnglePoolHost },
    held,
    terminal,
    failures,
    holdRequests() { holding = true },
    releaseHeld() {
      holding = false
      for (const entry of held.splice(0)) host?.attach(entry.slot, entry.port)
    },
    close: async () => {
      host?.terminate()
      await driver.close()
    },
  }
}

/** A Node angle worker running the shipped browser module. */
function angleWorker(): RotaryAngleHostWorker {
  return adaptWorker(new Worker(bootstrap(ANGLE_ADAPTER_URL), { eval: true }))
}

/** A fake angle worker that answers a batch with a computation error. */
function failingKernelWorker(): RotaryAngleHostWorker {
  const script = `
    const { parentPort } = require('node:worker_threads')
    const VERSION = ${JSON.stringify(ROTARY_ANGLE_PROTOCOL_VERSION)}
    parentPort.postMessage({ kind: 'ready', protocolVersion: VERSION })
    parentPort.on('message', (value) => {
      const port = value && value.port
      if (!port) return
      port.onmessage = (event) => {
        const request = event.data
        if (request.kind === 'install') port.postMessage({ kind: 'installed', protocolVersion: VERSION })
        else if (request.kind === 'plan') port.postMessage({ kind: 'planApplied', revision: request.revision })
        else if (request.kind === 'batch') {
          port.postMessage({
            kind: 'error',
            epoch: request.epoch,
            batchId: request.batchId,
            phase: 'compute',
            message: 'kernel boom',
          })
        }
      }
      port.start && port.start()
    })
  `
  return adaptWorker(new Worker(script, { eval: true }))
}

/**
 * A fake angle worker that answers the install with an error carrying **no
 * epoch** — a reply from a generation the pool cannot name.
 *
 * That is the one reply shape a coordinator must refuse rather than queue: there
 * is no batch it could belong to, and dropping it leaves the install waiting.
 */
function unnameableEpochWorker(): RotaryAngleHostWorker {
  const script = `
    const { parentPort } = require('node:worker_threads')
    const VERSION = ${JSON.stringify(ROTARY_ANGLE_PROTOCOL_VERSION)}
    parentPort.postMessage({ kind: 'ready', protocolVersion: VERSION })
    parentPort.on('message', (value) => {
      const port = value && value.port
      if (!port) return
      port.onmessage = (event) => {
        const request = event.data
        if (request.kind === 'install') {
          port.postMessage({ kind: 'error', epoch: -1, batchId: -1, phase: 'install', message: 'from an older generation' })
        }
      }
      port.start && port.start()
    })
  `
  return adaptWorker(new Worker(script, { eval: true }))
}

/** A worker that fails while its module loads, as a broken bundle would. */
function brokenWorker(): RotaryAngleHostWorker {
  return adaptWorker(new Worker('throw new Error("the angle worker module is missing")', { eval: true }))
}

/** A posted program with only the generation date normalised, so two runs compare. */
function normalizeDate(gcode: string): string {
  return gcode.replace(/Generated by PureCutCNC on \d{4}-\d{2}-\d{2}/g, 'Generated by PureCutCNC on <date>')
}

/** The baseline machine the probe and the parity suites use. */
function rotaryMachine(project: Project): MachineDefinition {
  const base = BUNDLED_DEFINITIONS.find((definition) => definition.id === 'grbl')
  assert.ok(base, 'the bundled definitions must include grbl')
  const axis = project.stock.shape === 'round' || project.stock.shape === 'square' ? project.stock.axis : 'x'
  return validateMachineDefinition({
    ...structuredClone(base),
    rotary: { about: axis ?? 'x', drive: 'own', reversed: false, inverseTimeFeed: { on: 'G93', off: 'G94' } },
  })
}

function postBytes(project: Project, operation: Operation, result: ToolpathResult): string {
  const tool = normalizeToolForProject(
    project.tools.find((candidate) => candidate.id === operation.toolRef) ?? project.tools[0],
    project,
  )
  return normalizeDate(runPostProcessor({
    project,
    operations: [{ operation, tool, toolpath: result }],
    definition: rotaryMachine(project),
    options: { emitToolChanges: true, emitCoolant: false, programName: project.meta.name },
  }).gcode)
}

interface Comparison {
  readonly result: ToolpathResult
  readonly envelope: OperationToolpathEnvelope
}

function direct(project: Project, operation: Operation): Comparison {
  const envelope = computeOperationToolpath(project, operation)
  assert.ok(envelope, `${operation.id}: the synchronous entry generates the fixture`)
  assert.ok(envelope.result.moves.length > 0, `${operation.id}: the fixture emits motion, or the comparison is vacuous`)
  return { result: envelope.result, envelope }
}

interface Generation {
  readonly outcome: 'completed' | 'failed'
  readonly result: ToolpathResult | null
  readonly rotary: { mode: string; workers: number; batches: number; fallback: string } | null
  readonly failure: string | null
}

/** Send one generate and wait for its terminal message. */
async function generate(
  driver: GenerationDriver,
  identity: { documentKey: number; snapshotId: number; requestId: number; operationId: string },
  opts: { parallelism?: number; timeoutMs?: number } = {},
): Promise<Generation> {
  const request = {
    documentKey: identity.documentKey,
    workerEpoch: 0,
    requestId: identity.requestId,
    snapshotId: identity.snapshotId,
    operationId: identity.operationId,
    traceMode: false,
  }
  driver.send({
    kind: 'generate',
    identity: request,
    ...(opts.parallelism !== undefined ? { rotary: { availableParallelism: opts.parallelism } } : {}),
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  let answer: WorkerToMain
  try {
    answer = await Promise.race([
      driver.await((message) => (message.kind === 'completed' || message.kind === 'failed')
        && (message.kind === 'failed' || message.identity.requestId === request.requestId)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no answer for request ${request.requestId} in time`)),
          opts.timeoutMs ?? 180_000,
        )
        ;(timer as unknown as { unref?: () => void }).unref?.()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
  if (answer.kind === 'failed') {
    return { outcome: 'failed', result: null, rotary: null, failure: answer.failure.message }
  }
  if (answer.kind !== 'completed') throw new Error(`unexpected ${answer.kind} while awaiting a generation`)
  return {
    outcome: 'completed',
    result: unpackResult(answer.result),
    rotary: answer.rotary ?? null,
    failure: null,
  }
}

async function loadSnapshot(app: AppPath, project: Project, snapshotId: number): Promise<void> {
  app.driver.send({ kind: 'loadSnapshot', documentKey: 1, snapshotId, project })
  await app.driver.await((message) => message.kind === 'snapshotReady' && message.snapshotId === snapshotId)
}

function compareWithSerial(generation: Generation, expected: Comparison, label: string): void {
  check(`${label}: completed`, generation.outcome === 'completed', `failed: ${generation.failure ?? 'unknown'}`)
  if (generation.result === null) return
  check(
    `${label}: the pool reaches the same moves and bounds`,
    canonicalize(generation.result) === canonicalize(expected.result),
    'the pooled result differs from the serial one',
  )
  check(
    `${label}: the pool reaches the same warnings`,
    JSON.stringify(generation.result.warnings) === JSON.stringify(expected.result.warnings),
    'the pooled warnings differ',
  )
}

async function parallelismParity(name: string, project: Project, operation: Operation): Promise<void> {
  const directStart = Date.now()
  const expected = direct(project, operation)
  const directMs = Date.now() - directStart
  const app = createAppPath({ createAngleWorker: angleWorker })
  try {
    await app.driver.ready
    await loadSnapshot(app, project, 1)
    const pooledStart = Date.now()
    const generation = await generate(app.driver, {
      documentKey: 1, snapshotId: 1, requestId: 1, operationId: operation.id,
    }, { parallelism: 4, timeoutMs: 600_000 })
    console.log(`   · ${name}: direct ${directMs} ms, pooled ${Date.now() - pooledStart} ms`)
    compareWithSerial(generation, expected, name)
    if (generation.result !== null) {
      check(
        `${name}: the posted program is byte-identical`,
        postBytes(project, operation, generation.result) === postBytes(project, operation, expected.result),
        'the posted program differs',
      )
    }
    check(
      `${name}: the pool really ran (${generation.rotary?.workers ?? 0} workers,`
      + ` ${generation.rotary?.batches ?? 0} batches)`,
      generation.rotary?.mode === 'parallel'
        && (generation.rotary?.workers ?? 0) >= 2
        && (generation.rotary?.batches ?? 0) >= 1,
      JSON.stringify(generation.rotary),
    )
    // Released with the operation: no angle worker outlives its request.
    check(`${name}: the angle workers are released after the operation`,
      app.host.liveWorkers() === 0, `${app.host.liveWorkers()} angle worker(s) still live`)
  } finally {
    await app.close()
  }
}

async function main(): Promise<void> {
  console.log('\nRotary generation through the angle pool (app path)')

  const finish = rotaryOperationFixture('x', 'rotary_finish')
  await parallelismParity('canned finish', finish, finish.operations[0])
  const rough = rotaryOperationFixture('x', 'rotary_rough')
  await parallelismParity('canned rough', rough, rough.operations[0])

  // ── cancellation: a second request ends the first, mid-batch ─────────────
  {
    const project = rotaryOperationFixture('x', 'rotary_finish')
    const operation = project.operations[0]
    const expected = direct(project, operation)
    let requests = 0
    const app = createAppPath({ createAngleWorker: angleWorker, onWorkerRequest: () => { requests += 1 } })
    try {
      await app.driver.ready
      await loadSnapshot(app, project, 1)
      // Hold the first pool's ports, so its install is provably still pending
      // when the second request arrives: that is "cancelled mid-batch", not a
      // race with completion.
      app.holdRequests()
      // Sent without awaiting a promise: the cancelled request never answers,
      // and an armed timeout would fire minutes later as an unhandled rejection
      // in the middle of whatever the suite was doing then.
      app.driver.send({
        kind: 'generate',
        identity: {
          documentKey: 1, workerEpoch: 0, requestId: 1, snapshotId: 1, operationId: operation.id, traceMode: false,
        },
        rotary: { availableParallelism: 4 },
      })
      await waitFor(() => requests > 0, 'the first pool to ask for an angle worker')
      const firstRequests = requests
      check('cancellation: the first pool is waiting on angle workers',
        app.held.length > 0, 'the first generation never asked for an angle worker')

      // The second request arrives while the first is still waiting. It ends
      // the first pool and asks for workers of its own.
      const second = generate(app.driver, {
        documentKey: 1, snapshotId: 1, requestId: 2, operationId: operation.id,
      }, { parallelism: 4 })
      await waitFor(() => requests > firstRequests, 'the second pool to ask for an angle worker')
      app.releaseHeld()

      const secondResult = await second
      compareWithSerial(secondResult, expected, 'cancellation: the second request')
      check('cancellation: the second request really ran the pool',
        secondResult.rotary?.mode === 'parallel' && (secondResult.rotary?.batches ?? 0) >= 1,
        JSON.stringify(secondResult.rotary))
      check('cancellation: no angle worker is left running',
        app.host.liveWorkers() === 0, `${app.host.liveWorkers()} angle worker(s) still live`)

      // The first request was disposed before its workers ever attached, so
      // nothing may post for it — and the second result is the only terminal
      // message either request produced.
      const firstTerminals = app.terminal.filter(
        (message) => (message.kind === 'completed' || message.kind === 'failed') && message.identity.requestId === 1,
      )
      check('cancellation: no result arrives for the cancelled request',
        firstTerminals.length === 0, `${firstTerminals.length} terminal message(s) for the cancelled request`)
      check('cancellation: exactly one terminal message was posted',
        app.terminal.length === 1, `${app.terminal.length} terminal message(s)`)
    } finally {
      await app.close()
    }
  }

  // ── fallback: a worker that cannot be created reruns serially ───────────
  {
    const project = rotaryOperationFixture('x', 'rotary_finish')
    const operation = project.operations[0]
    const expected = direct(project, operation)
    const app = createAppPath({
      createAngleWorker: () => { throw new Error('no module workers in this runtime') },
    })
    try {
      await app.driver.ready
      await loadSnapshot(app, project, 2)
      const generation = await generate(app.driver, {
        documentKey: 1, snapshotId: 2, requestId: 3, operationId: operation.id,
      }, { parallelism: 4, timeoutMs: 60_000 })
      compareWithSerial(generation, expected, 'fallback (creation throws)')
      check('fallback (creation throws): the pool reports serial startup fallback',
        generation.rotary?.mode === 'serial' && generation.rotary?.fallback === 'startup',
        JSON.stringify(generation.rotary))
      check('fallback (creation throws): the failure reaches the coordinator',
        app.failures.some((message) => message.includes('could not be created')),
        JSON.stringify(app.failures))
    } finally {
      await app.close()
    }
  }

  // ── fallback: a worker that fails to load reruns serially ───────────────
  {
    const project = rotaryOperationFixture('x', 'rotary_finish')
    const operation = project.operations[0]
    const expected = direct(project, operation)
    const app = createAppPath({ createAngleWorker: brokenWorker })
    try {
      await app.driver.ready
      await loadSnapshot(app, project, 3)
      const generation = await generate(app.driver, {
        documentKey: 1, snapshotId: 3, requestId: 4, operationId: operation.id,
      }, { parallelism: 4, timeoutMs: 60_000 })
      compareWithSerial(generation, expected, 'fallback (module fails)')
      check('fallback (module fails): the pool reports serial startup fallback',
        generation.rotary?.mode === 'serial' && generation.rotary?.fallback === 'startup',
        JSON.stringify(generation.rotary))
      check('fallback (module fails): the failure reaches the coordinator',
        app.failures.some((message) => message.includes('failed to start')),
        JSON.stringify(app.failures))
    } finally {
      await app.close()
    }
  }

  // ── a reply that names no generation fails the slot, not the batch ──────
  {
    const project = rotaryOperationFixture('x', 'rotary_finish')
    const operation = project.operations[0]
    const expected = direct(project, operation)
    const app = createAppPath({ createAngleWorker: unnameableEpochWorker })
    try {
      await app.driver.ready
      await loadSnapshot(app, project, 5)
      const started = Date.now()
      const generation = await generate(app.driver, {
        documentKey: 1, snapshotId: 5, requestId: 5, operationId: operation.id,
      }, { parallelism: 4, timeoutMs: 120_000 })
      const elapsed = Date.now() - started
      compareWithSerial(generation, expected, 'unnameable epoch')
      check('unnameable epoch: the operation falls back to serial execution',
        generation.rotary?.mode === 'serial' && generation.rotary?.fallback === 'startup',
        JSON.stringify(generation.rotary))
      // The distinction the port transport's negative-epoch rule makes: the
      // slot fails at once. Without it the same reply is merely *ignored* and
      // the batch waits for the 30 s startup backstop — a different failure
      // mode, and one the bound below catches. It is a liveness check, not a
      // speed budget: the real path settles in well under a second.
      check('unnameable epoch: the refusal is immediate, not the startup backstop',
        elapsed < 15_000, `took ${elapsed} ms`)
    } finally {
      await app.close()
    }
  }

  // ── a computation error stays an error ──────────────────────────────────
  {
    const project = rotaryOperationFixture('x', 'rotary_finish')
    const operation = project.operations[0]
    const app = createAppPath({ createAngleWorker: failingKernelWorker })
    try {
      await app.driver.ready
      await loadSnapshot(app, project, 4)
      const generation = await generate(app.driver, {
        documentKey: 1, snapshotId: 4, requestId: 5, operationId: operation.id,
      }, { parallelism: 4, timeoutMs: 60_000 })
      check('computation error: the generation fails',
        generation.outcome === 'failed', `completed instead: ${generation.outcome}`)
      check('computation error: the failure names the kernel error',
        (generation.failure ?? '').includes('kernel boom'), String(generation.failure))
    } finally {
      await app.close()
    }
  }

  // ── the p-a benchmark fixtures, when asked for ──────────────────────────
  if (process.env.ROTARY_PARITY_FIXTURES === '1') {
    const root = resolve(HERE, '../../..')
    for (const name of ['busto-rect-stock.camj', 'busto-round-stock.camj']) {
      const path = join(root, 'work', name)
      if (!existsSync(path)) {
        assert.fail(`${path} is missing: copy the p-a work/ fixtures before running ROTARY_PARITY_FIXTURES=1`)
      }
      const project = normalizeProject(JSON.parse(readFileSync(path, 'utf8')))
      for (const operation of project.operations.filter(
        (candidate) => candidate.kind === 'rotary_rough' || candidate.kind === 'rotary_finish')) {
        console.log(`${name} ${operation.id} ${operation.kind}: generating…`)
        await parallelismParity(`${name} ${operation.id}`, project, operation)
      }
    }
  } else {
    console.log('rotaryPoolAppPath: p-a fixture parity skipped (set ROTARY_PARITY_FIXTURES=1 with work/ fixtures present)')
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
