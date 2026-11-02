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
 * Everything here runs the **shipped** modules on real threads — the harness
 * that boots them and the angle-worker fakes live in
 * `rotaryPoolAppPathHarness.ts`:
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
 *   posts anything. This is the property the generation counter exists for. The
 *   first pool is made to reach a real dispatched batch whose replies are held,
 *   so the cancellation happens mid-batch rather than mid-install, and the
 *   obsolete replies are then answered by hand — with the epoch and batch the
 *   cancelled pool asked for — to prove nothing consumes them.
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

import { BUNDLED_DEFINITIONS } from '../../engine/gcode/definitions'
import { runPostProcessor } from '../../engine/gcode/postprocessor'
import { validateMachineDefinition } from '../../engine/gcode/types'
import type { MachineDefinition } from '../../engine/gcode/types'
import { computeOperationToolpath } from '../../engine/toolpaths/generateOperation'
import type { OperationToolpathEnvelope } from '../../engine/toolpaths/generateOperation'
import { normalizeToolForProject } from '../../engine/toolpaths/geometry'
import { canonicalize } from '../../engine/toolpaths/parityRecord'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import { normalizeProject } from '../../store/helpers/projectFormat'
import { rotaryOperationFixture } from '../../test/rotaryOperationFixture'
import type { Operation, Project } from '../../types/project'
import { unpackResult } from './moveTransport'
import type { WorkerToMain } from './protocol'
import {
  angleWorker,
  brokenWorker,
  createAppPath,
  failingKernelWorker,
  holdingAngleWorker,
  releaseHeldBatch,
  unnameableEpochWorker,
} from './rotaryPoolAppPathHarness'
import type { AppPath, GenerationDriver, HeldBatch } from './rotaryPoolAppPathHarness'

const HERE = dirname(fileURLToPath(import.meta.url))

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
    /** Batches the first request's workers received and never answered. */
    const held: HeldBatch[] = []
    let holding = true
    let created = 0
    const app = createAppPath({
      createAngleWorker: () => {
        created += 1
        return holding ? holdingAngleWorker(held, created) : angleWorker()
      },
    })
    try {
      await app.driver.ready
      await loadSnapshot(app, project, 1)
      // Request 1 gets workers that install for real and then hold their batch
      // replies, so "cancelled mid-batch" means a dispatched batch with replies
      // outstanding — the state holding the `rotaryWorker` requests never
      // reached, because the install never completed and no batch was sent.
      // Sent without awaiting a promise: the cancelled request never answers,
      // and an armed timeout would fire later as an unhandled rejection.
      app.driver.send({
        kind: 'generate',
        identity: {
          documentKey: 1, workerEpoch: 0, requestId: 1, snapshotId: 1, operationId: operation.id, traceMode: false,
        },
        rotary: { availableParallelism: 4 },
      })
      await waitFor(() => held.length >= 2, 'the first generation to dispatch its batches')
      const firstJobs = held.reduce((total, batch) => total + batch.jobs.length, 0)
      check('cancellation: the first generation is mid-batch, not mid-attach',
        firstJobs > 0 && app.host.liveWorkers() >= 2,
        `${held.length} held batch(es), ${firstJobs} job(s), ${app.host.liveWorkers()} worker(s)`)

      // The successor is a different request and a pool of its own, and it
      // starts while the first request's batch is still unanswered.
      holding = false
      const successor = generate(app.driver, {
        documentKey: 1, snapshotId: 1, requestId: 2, operationId: operation.id,
      }, { parallelism: 4 })
      const secondResult = await successor
      compareWithSerial(secondResult, expected, 'cancellation: the successor')
      check('cancellation: the successor really ran the pool',
        secondResult.rotary?.mode === 'parallel' && (secondResult.rotary?.batches ?? 0) >= 1,
        JSON.stringify(secondResult.rotary))

      // Answer the cancelled request's batches *after* the successor finished,
      // with the epoch and batch the first pool asked for and rows no real sample
      // would hold. Nothing may consume them — not in this generation, and not
      // in a later one.
      for (const batch of held) releaseHeldBatch(batch)
      await new Promise((settle) => setTimeout(settle, 100))

      // The first request was disposed while its batch was in flight, so nothing
      // may post for it — and the successor's result is the only terminal
      // message either request produced.
      const firstTerminals = app.terminal.filter(
        (message) => (message.kind === 'completed' || message.kind === 'failed') && message.identity.requestId === 1,
      )
      check('cancellation: no result arrives for the cancelled request',
        firstTerminals.length === 0, `${firstTerminals.length} terminal message(s) for the cancelled request`)
      check('cancellation: the obsolete replies changed nothing',
        app.terminal.length === 1, `${app.terminal.length} terminal message(s)`)
      check('cancellation: every angle worker is stopped, the cancelled request\'s included',
        app.host.liveWorkers() === 0, `${app.host.liveWorkers()} angle worker(s) still live`)
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
      // The slot was retired by the failure, which is exactly the path on which
      // the host's worker used to be orphaned: this side closed its channel,
      // removed the slot, and left the `Worker` running with nothing left able
      // to name it (`terminate()` returns early, disposal walks the live map).
      check('unnameable epoch: the failed slot releases its host worker',
        app.host.liveWorkers() === 0, `${app.host.liveWorkers()} angle worker(s) still live`)
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
