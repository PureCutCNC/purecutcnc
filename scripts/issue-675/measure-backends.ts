/**
 * Backend cost comparison for the issue #675 rollout decision (slice 5).
 *
 * Reports, per fixture and per backend: generation time, input clone time,
 * output clone/install time, and peak heap. The plan asks for these
 * **separately** rather than as one number, because they behave differently —
 * generation is the same work either way, while the clone costs exist only on
 * the worker path and are what a "just switch it on" decision would be paying
 * for.
 *
 * Node, not a browser. `structuredClone` and `worker_threads` share the
 * browser's transport semantics, and this measures transport and computation,
 * not rendering. Nothing here should be read as a frame-rate or
 * UI-responsiveness measurement; that is what the manual checks are for.
 *
 * Serial by construction: overlapping runs would measure contention rather
 * than cost.
 *
 * **Memory is deliberately not reported.** Peak heap cannot be sampled from
 * this thread — a synchronous generator blocks the event loop, so a sampler
 * never fires while the interesting allocation happens — and before/after
 * deltas straddle collections and come out negative, which is how an earlier
 * version of this script produced a "-316 MB peak". Rather than publish a
 * number that cannot be defended, the transported payload size is reported
 * instead: it is exact, it explains the clone timings directly, and the
 * structural memory claim needs no measurement — the worker path necessarily
 * holds more, because sender and receiver both hold the result during transport
 * and the worker retains its own snapshot besides. Actual peak needs a browser
 * heap profile and is recorded as a rollout limitation.
 *
 * The script enables the GC itself (see `enableGc`), so a plain
 * `npx tsx scripts/issue-675/measure-backends.ts` produces real figures.
 */

import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { buildParityCorpus } from '../../src/engine/toolpaths/parityCorpus'
import { computeOperationToolpath } from '../../src/engine/toolpaths'
import { resolveOperation } from '../../src/app/toolpathGeneration/protocol'
import { packResult, unpackResult } from '../../src/app/toolpathGeneration/moveTransport'
import type { WorkerToMain } from '../../src/app/toolpathGeneration/protocol'
import type { RequestIdentity } from '../../src/app/toolpathGeneration/types'

const ADAPTER = fileURLToPath(new URL('../../src/app/toolpathGeneration/workerThreadAdapter.ts', import.meta.url))

/** Fixtures chosen to span the range the plan names: large trochoidal, imported mesh, ordinary small job. */
const CASES = [
  { id: 'fixture/trochoidal-249k/op0004', label: 'large trochoidal edge route' },
  { id: 'fixture/model-in-pocket/op6792441', label: 'imported-mesh 3D roughing' },
  { id: 'fixture/another-pocket-test/op0036', label: 'ordinary pocket' },
  { id: 'synthetic/drilling_simple', label: 'small drilling job' },
]

const mb = (bytes: number): string => (bytes / 1024 / 1024).toFixed(1)
/** Exact transported size: what structured clone actually has to carry. */
function payloadBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8')
}
const ms = (value: number): string => value.toFixed(0)


async function main(): Promise<void> {
  const corpus = buildParityCorpus()
  const rows: string[] = []

  console.log('\nBackend cost comparison (Node; transport and computation only)\n')
  console.log(
    `${'fixture'.padEnd(28)}${'moves'.padStart(9)}`
    + `${'inline gen'.padStart(12)}${'worker gen'.padStart(12)}`
    + `${'in-clone'.padStart(10)}${'pack'.padStart(7)}${'unpack'.padStart(8)}${'(was clone)'.padStart(12)}`
    + `${'project'.padStart(11)}${'result'.padStart(11)}`,
  )

  for (const { id, label } of CASES) {
    const parityCase = corpus.find((entry) => entry.id === id)
    if (!parityCase) {
      console.log(`${label.padEnd(28)}  (fixture ${id} not in corpus — skipped)`)
      continue
    }
    const operation = resolveOperation(parityCase.project, parityCase.operationId)
    if (!operation) continue

    // ── inline ──────────────────────────────────────────────────────
    // Warm-up pass, discarded: the first generation in a process pays for JIT
    // and lazy module init, which would otherwise be attributed to whichever
    // fixture happened to run first.
    computeOperationToolpath(parityCase.project, operation)

    const inlineStart = performance.now()
    const envelope = computeOperationToolpath(parityCase.project, operation)!
    const inlineGen = performance.now() - inlineStart
    const moves = envelope.result.moves.length

    // ── transport costs, measured on their own ─────────────────────
    // The input still crosses by structured clone; only the result is packed.
    const cloneInStart = performance.now()
    const clonedProject = structuredClone(parityCase.project)
    const cloneIn = performance.now() - cloneInStart
    void clonedProject

    // What the worker path actually does now: pack on the worker side, unpack
    // on the main thread. The old `structuredClone(result)` figure is kept
    // alongside because it is what those two replaced, and the comparison is
    // the justification for having replaced it.
    const packStart = performance.now()
    const packed = packResult(envelope.result)
    const packMs = performance.now() - packStart

    const unpackStart = performance.now()
    void unpackResult(packed)
    const unpackMs = performance.now() - unpackStart

    const cloneOutStart = performance.now()
    const clonedResult = structuredClone(envelope.result)
    const cloneOut = performance.now() - cloneOutStart
    void clonedResult

    // ── worker ─────────────────────────────────────────────────────
    const worker = new Worker(ADAPTER, { execArgv: ['--import', 'tsx'] })
    const workerGen = await new Promise<number>((resolve, reject) => {
      let started = 0
      const identity: RequestIdentity = {
        documentKey: 1, workerEpoch: 0, requestId: 1, snapshotId: 1,
        operationId: parityCase.operationId, traceMode: false,
      }
      worker.on('error', reject)
      worker.on('message', (data: WorkerToMain) => {
        if (data.kind === 'ready') {
          worker.postMessage({ kind: 'loadSnapshot', documentKey: 1, snapshotId: 1, project: parityCase.project })
          return
        }
        if (data.kind === 'snapshotReady') {
          started = performance.now()
          worker.postMessage({ kind: 'generate', identity })
          return
        }
        if (data.kind === 'completed') resolve(performance.now() - started)
        if (data.kind === 'failed') reject(new Error(JSON.stringify(data.failure)))
      })
    })
    await worker.terminate()

    rows.push(
      `${label.padEnd(28)}${String(moves).padStart(9)}`
      + `${ms(inlineGen).padStart(11)}m${ms(workerGen).padStart(11)}m`
      + `${ms(cloneIn).padStart(9)}m${ms(packMs).padStart(6)}m${ms(unpackMs).padStart(7)}m${ms(cloneOut).padStart(11)}m`
      + `${mb(payloadBytes(parityCase.project)).padStart(9)}MB${mb(payloadBytes(envelope.result)).padStart(9)}MB`,
    )
    console.log(rows[rows.length - 1])
  }

  console.log(
    '\nRead with care:'
    + '\n  · "worker gen" is measured from snapshot-installed to completed on the main'
    + '\n    thread, so it includes posting the request and cloning the result back —'
    + '\n    it is the cost of using the worker, not the cost of the geometry.'
    + '\n  · "pack" is paid on the worker thread and "unpack" on the main thread —'
    + '\n    only the second one can block the UI. "(was clone)" is the structured'
    + '\n    clone those two replaced in slice 6, shown for comparison.'
    + '\n  · "project" and "result" are payload sizes as JSON. They indicate scale;'
    + '\n    they are not memory figures, and the packed form is smaller.'
    + '\n  · Peak memory and UI responsiveness need a browser profile. Neither is'
    + '\n    measured here and neither should be inferred from these numbers.',
  )
}

void main()
