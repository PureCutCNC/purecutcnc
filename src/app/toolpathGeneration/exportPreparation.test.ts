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
 * Export completeness and token invalidation (issue #675).
 *
 * The defect this suite exists to prevent: a G-code file written with one of
 * the selected operations silently missing. Asynchronous generation makes that
 * reachable — a member can fail, be cancelled, or be superseded by an edit —
 * and the synchronous code this replaces filtered such members out and posted
 * the rest.
 *
 * Every case drives the real service with a hand-released executor, so the
 * failure and cancellation paths are exercised as they actually occur rather
 * than simulated by stubbing the preparation itself.
 */

import { parityMachineDefinition } from '../../engine/toolpaths/parityCorpus'
import { createToolpathGenerationService, type GenerationContext } from './service'
import type { ExecutorRequest, GenerationExecutor } from './executor'
import type { GenerationOutcome } from './types'
import {
  createExportToken,
  exportOptionsKey,
  prepareExport,
  programHasError,
  tokenMatchesContext,
  type ExportPostOptions,
} from './exportPreparation'
import { makeOperation, makeResult, projectWith } from './testSupport'
import type { Operation, Project, Tool } from '../../types/project'
import { defaultTool } from '../../types/project'

let passed = 0
let failed = 0

function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  return Promise.resolve().then(fn).then(
    () => { passed += 1; console.log(`   ✓ ${name}`) },
    (error: unknown) => {
      failed += 1
      console.log(`   ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`)
    },
  )
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

async function flush(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve()
}

const OPTIONS: ExportPostOptions = {
  emitToolChanges: true,
  emitCoolant: false,
  programName: 'part',
  captureMotionTrace: false,
}

const tool: Tool = { ...defaultTool('mm', 1), id: 't1' }

function withTools(operations: Operation[]): Project {
  return { ...projectWith(operations), tools: [tool] }
}

interface Controlled extends GenerationExecutor {
  readonly inFlight: ExecutorRequest[]
  release(outcome: GenerationOutcome): void
}

function controlled(epoch: number): Controlled {
  const inFlight: ExecutorRequest[] = []
  const settles: ((outcome: GenerationOutcome) => void)[] = []
  return {
    kind: 'worker', epoch, supportsHardCancellation: true, inFlight,
    run(request) { inFlight.push(request); return new Promise((resolve) => { settles.push(resolve) }) },
    release(outcome) { inFlight.shift(); settles.shift()?.(outcome) },
    terminate() { while (settles.length > 0) { inFlight.shift(); settles.shift()?.({ status: 'cancelled' }) } },
    dispose() { this.terminate() },
  }
}

function harness(project: Project): {
  service: ReturnType<typeof createToolpathGenerationService>
  executor: () => Controlled
  context: GenerationContext
} {
  const executors: Controlled[] = []
  const context: GenerationContext = { project, documentKey: 1 }
  const service = createToolpathGenerationService({
    getCurrentContext: () => context,
    createExecutor: (_kind, epoch) => { const made = controlled(epoch); executors.push(made); return made },
  })
  return { service, executor: () => executors[executors.length - 1], context }
}

async function main(): Promise<void> {
  console.log('\nExport preparation — completeness')

  const opA = { ...makeOperation('a'), toolRef: 't1' }
  const opB = { ...makeOperation('b'), toolRef: 't1' }
  const project = withTools([opA, opB])
  const definition = parityMachineDefinition()

  await test('a complete set posts one program containing every operation', async () => {
    const h = harness(project)
    const token = createExportToken(1, h.context, ['a', 'b'], definition, OPTIONS)
    const pending = prepareExport(h.service, h.context, token, definition, OPTIONS)
    await flush()
    h.executor().release({ status: 'completed', result: makeResult('a', 4), raw: null })
    await flush()
    h.executor().release({ status: 'completed', result: makeResult('b', 4), raw: null })
    const preparation = await pending
    assert(preparation.status === 'ready', `expected ready, got ${preparation.status}`)
    assert(
      preparation.status === 'ready' && preparation.operations.length === 2,
      'both operations must reach the postprocessor',
    )
    assert(
      preparation.status === 'ready' && preparation.result.gcode.length > 0,
      'a program should be emitted',
    )
  })

  await test('a failed member blocks the whole export and is never filtered out', async () => {
    const h = harness(project)
    const token = createExportToken(1, h.context, ['a', 'b'], definition, OPTIONS)
    const pending = prepareExport(h.service, h.context, token, definition, OPTIONS)
    await flush()
    h.executor().release({ status: 'completed', result: makeResult('a', 4), raw: null })
    await flush()
    h.executor().release({ status: 'failed', failure: { category: 'computation', message: 'bad geometry' } })
    const preparation = await pending
    assert(preparation.status === 'blocked', `expected blocked, got ${preparation.status}`)
    assert(
      preparation.status === 'blocked' && preparation.reason.kind === 'generation-failed',
      'the block reason must name the generation failure',
    )
    assert(
      preparation.status === 'blocked' && preparation.reason.kind === 'generation-failed'
        && preparation.reason.operationId === 'b',
      'the block must say which operation failed',
    )
  })

  await test('a cancelled member blocks the export', async () => {
    const h = harness(project)
    const token = createExportToken(1, h.context, ['a', 'b'], definition, OPTIONS)
    const pending = prepareExport(h.service, h.context, token, definition, OPTIONS)
    await flush()
    h.executor().release({ status: 'completed', result: makeResult('a', 4), raw: null })
    await flush()
    h.executor().release({ status: 'cancelled' })
    const preparation = await pending
    assert(
      preparation.status === 'blocked' && preparation.reason.kind === 'generation-cancelled',
      'a cancelled member must block, not shrink the program',
    )
  })

  await test('an operation without a tool blocks rather than being dropped', async () => {
    const toolless = withTools([opA, { ...opB, toolRef: 'missing' }])
    const h = harness(toolless)
    const token = createExportToken(1, h.context, ['a', 'b'], definition, OPTIONS)
    const pending = prepareExport(h.service, h.context, token, definition, OPTIONS)
    await flush()
    h.executor().release({ status: 'completed', result: makeResult('a', 4), raw: null })
    await flush()
    h.executor().release({ status: 'completed', result: makeResult('b', 4), raw: null })
    const preparation = await pending
    assert(
      preparation.status === 'blocked' && preparation.reason.kind === 'missing-tool',
      'a member with no tool must block the export',
    )
  })

  await test('no machine and no operations each block before any work starts', async () => {
    const h = harness(project)
    const noMachine = await prepareExport(
      h.service, h.context, createExportToken(1, h.context, ['a'], definition, OPTIONS), null, OPTIONS,
    )
    assert(noMachine.status === 'blocked' && noMachine.reason.kind === 'no-machine', 'no machine blocks')
    const empty = await prepareExport(
      h.service, h.context, createExportToken(2, h.context, [], definition, OPTIONS), definition, OPTIONS,
    )
    assert(empty.status === 'blocked' && empty.reason.kind === 'no-operations', 'an empty selection blocks')
    assert(h.executor() === undefined, 'neither case may start generation')
  })

  await test('operations are posted in the order the token names, not completion order', async () => {
    const h = harness(project)
    const token = createExportToken(1, h.context, ['a', 'b'], definition, OPTIONS)
    const pending = prepareExport(h.service, h.context, token, definition, OPTIONS)
    await flush()
    // The service runs them one at a time; whatever order they finish in, the
    // assembled rows follow the token.
    h.executor().release({ status: 'completed', result: makeResult('a', 4), raw: null })
    await flush()
    h.executor().release({ status: 'completed', result: makeResult('b', 9), raw: null })
    const preparation = await pending
    assert(
      preparation.status === 'ready'
        && preparation.operations.map((row) => row.operation.id).join(',') === 'a,b',
      'the posted order must follow the token',
    )
  })

  await test('an error code blocks the export and a warning does not', () => {
    assert(
      programHasError([{ code: 'postToolChangesDisabled' }]),
      'a program that changes tool without emitting the change must not be saveable',
    )
    assert(
      programHasError([{ code: 'tabNoIntersect' }, { code: 'postToolChangesDisabled' }]),
      'one error among warnings is enough to block',
    )
    assert(!programHasError([]), 'a program with nothing to say is exportable')
    assert(
      !programHasError([{ code: 'postNoCoolantCommands' }, { code: 'postWcsNullSelect' }]),
      'warnings annotate a program rather than blocking it',
    )
  })

  console.log('\nExport preparation — token invalidation')

  const context: GenerationContext = { project, documentKey: 1 }
  const token = createExportToken(1, context, ['a', 'b'], definition, OPTIONS)

  await test('an unchanged context keeps the token valid', () => {
    assert(tokenMatchesContext(token, context, ['a', 'b'], definition, OPTIONS), 'nothing changed')
  })

  await test('a project edit invalidates the token', () => {
    const edited: GenerationContext = { project: withTools([{ ...opA, stepdown: 9 }, opB]), documentKey: 1 }
    assert(!tokenMatchesContext(token, edited, ['a', 'b'], definition, OPTIONS), 'an edited project must invalidate')
  })

  await test('opening another document invalidates the token', () => {
    assert(
      !tokenMatchesContext(token, { project, documentKey: 2 }, ['a', 'b'], definition, OPTIONS),
      'a new document session must invalidate',
    )
  })

  await test('a changed selection invalidates the token, order included', () => {
    assert(!tokenMatchesContext(token, context, ['a'], definition, OPTIONS), 'a shorter selection invalidates')
    assert(!tokenMatchesContext(token, context, ['b', 'a'], definition, OPTIONS), 'a reordered selection invalidates')
  })

  await test('a changed machine invalidates the token', () => {
    const other = { ...definition, id: 'other' }
    assert(!tokenMatchesContext(token, context, ['a', 'b'], other, OPTIONS), 'a different machine invalidates')
    assert(!tokenMatchesContext(token, context, ['a', 'b'], null, OPTIONS), 'a removed machine invalidates')
  })

  await test('every postprocessor option participates in the token', () => {
    for (const changed of [
      { ...OPTIONS, emitToolChanges: false },
      { ...OPTIONS, emitCoolant: true },
      { ...OPTIONS, captureMotionTrace: true },
      { ...OPTIONS, programName: 'renamed' },
    ]) {
      assert(
        exportOptionsKey(changed) !== exportOptionsKey(OPTIONS),
        `option change ${JSON.stringify(changed)} must change the key`,
      )
      assert(
        !tokenMatchesContext(token, context, ['a', 'b'], definition, changed),
        'an option change must invalidate the token',
      )
    }
  })

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
