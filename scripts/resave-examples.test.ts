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
 * Guards the two #1192 review findings (correction round 1).
 *
 * 1. `waitForOwnDevServer` must refuse a URL answered by a server this run did
 *    not start. Before the fix the re-save loop accepted the first HTTP 200, so
 *    a port already taken by another server (`--strictPort` stops Vite, the
 *    foreign server answers) could drive that server and write its downloads
 *    over this worktree's examples.
 * 2. `omittedOperations` must name every project operation that produced no
 *    G-code. Before the fix the check filtered disabled, tool-less and
 *    project-type-hidden operations out, so the before/after counts agreed by
 *    omitting them instead of reporting them.
 *
 * Run with: npx tsx scripts/resave-examples.test.ts
 */

import assert from 'node:assert/strict'

import { announcesPort, waitForOwnDevServer } from './resave-examples'
import { emittedOperationIds, omittedOperations, parseArguments } from './resave-examples-check'
import { exportPlasma, PLASMA_EXPORT_SCENARIOS } from '../src/test/plasmaExportFixtures'
import { runPostProcessor } from '../src/engine/gcode/postprocessor'
import type { PostProcessorInput } from '../src/engine/gcode/types'
import { defaultTool } from '../src/types/project'
import { defaultOperationForTarget } from '../src/store/helpers/operationDefaults'
import { normalizeToolForProject } from '../src/engine/toolpaths/geometry'
import type { ExportOperationOption } from '../src/components/export/exportOperationSelection'
import type { Operation, Project } from '../src/types/project'

// ── finding 1: readiness comes from this run's server ────────────────────────

function testAnnouncesPortReadsVitesReadyLine(): void {
  assert.equal(announcesPort('  ➜  Local:   http://localhost:1459/', 1459), true)
  assert.equal(announcesPort('http://127.0.0.1:1459/\n', 1459), true)
  // A different port, and Vite's refusal on a taken one, must not read as ready.
  assert.equal(announcesPort('  ➜  Local:   http://localhost:14590/', 1459), false)
  assert.equal(announcesPort('error when starting dev server:\nError: Port 1459 is already in use\n', 1459), false)
}

async function testForeignServerCannotAnswerForUs(): Promise<void> {
  let probes = 0
  await assert.rejects(
    waitForOwnDevServer({
      url: 'http://localhost:1459',
      port: 1459,
      timeoutMs: 60_000,
      server: {
        // `--strictPort` made Vite exit because someone else holds the port.
        failure: () => 'this run\'s dev server exited with code 1 before http://localhost:1459 was ready; ' +
          'another server may already hold that port (server output above)',
        announcedPort: () => false,
      },
      // The foreign server answers every probe, exactly as it did in the review.
      probe: async () => {
        probes += 1
        return true
      },
    }),
    /another server may already hold that port/,
  )
  assert.equal(probes, 0, 'the foreign server must not be probed once our own process is known dead')
}

async function testAnswerWithoutOurAnnouncementIsNotReady(): Promise<void> {
  let clock = 0
  await assert.rejects(
    waitForOwnDevServer({
      url: 'http://localhost:1459',
      port: 1459,
      timeoutMs: 1_000,
      server: { failure: () => null, announcedPort: () => false },
      probe: async () => true,
      now: () => clock,
      sleep: async (ms) => { clock += ms },
    }),
    /never announced port 1459/,
  )
}

async function testOurOwnAnnouncedServerIsReady(): Promise<void> {
  let announcement = false
  await waitForOwnDevServer({
    url: 'http://localhost:1459',
    port: 1459,
    timeoutMs: 5_000,
    server: { failure: () => null, announcedPort: () => announcement },
    probe: async () => {
      announcement = true
      return true
    },
  })
}

// ── finding 2: every operation is accounted for ───────────────────────────────

function operation(id: string, overrides: Partial<Operation> = {}): Operation {
  return {
    id,
    name: id,
    kind: 'pocket',
    enabled: true,
    toolRef: 'tool-1',
    ...overrides,
  } as unknown as Operation
}

function option(
  forOperation: Operation,
  exportable: boolean,
  reasonKey: ExportOperationOption['reasonKey'] = null,
): ExportOperationOption {
  return { operation: forOperation, exportable, reasonKey, defaultSelected: exportable }
}

function project(
  operations: Operation[],
  setups: Project['setups'] = [],
): Pick<Project, 'operations' | 'tools' | 'meta' | 'stock' | 'setups'> {
  return {
    meta: { projectType: 'milling' },
    stock: {},
    setups,
    operations,
    tools: [{ id: 'tool-1' }],
  } as unknown as Pick<Project, 'operations' | 'tools' | 'meta' | 'stock' | 'setups'>
}

function testDisabledAndToolLessOperationsAreReported(): void {
  const disabled = operation('op-disabled', { enabled: false })
  const toolLess = operation('op-no-tool', { toolRef: null })
  const omitted = omittedOperations(
    project([disabled, toolLess]),
    [option(disabled, false, 'dialogs.export.operationDisabled'), option(toolLess, false, 'dialogs.export.noToolAssigned')],
    [],
  )
  assert.deepEqual(omitted.map(({ id, reason }) => ({ id, reason })), [
    { id: 'op-disabled', reason: 'disabled' },
    { id: 'op-no-tool', reason: 'no-tool' },
  ])
}

function testProjectTypeHiddenOperationIsReported(): void {
  const around = operation('op-around', { setupId: 'setup-around' })
  const omitted = omittedOperations(
    project([around], [{ id: 'setup-around', kind: 'around', name: 'Around' }] as unknown as Project['setups']),
    // `listExportOperationOptions` drops it, so the checklist has no entry.
    [],
    [],
  )
  assert.deepEqual(omitted.map(({ id, reason }) => ({ id, reason })), [
    { id: 'op-around', reason: 'hidden-by-project-type' },
  ])
}

function testExportableButUnpostedOperationIsReported(): void {
  const skipped = operation('op-other-family')
  const omitted = omittedOperations(project([skipped]), [option(skipped, true)], [])
  assert.deepEqual(omitted.map(({ id, reason }) => ({ id, reason })), [
    { id: 'op-other-family', reason: 'not-posted' },
  ])
}

function testFullyPostedProjectHasNoOmissions(): void {
  const first = operation('op-1')
  const second = operation('op-2')
  const omitted = omittedOperations(
    project([first, second]),
    [option(first, true), option(second, true)],
    ['op-1', 'op-2'],
  )
  assert.deepEqual(omitted, [])
}

// The postprocessor can drop an entry it was handed: a plasma cut on a
// non-plasma machine never reaches the emitter (#960). The check must read
// what was emitted, not the input list (#1192 review round 2).
function testPostprocessorSkippedOperationIsReported(): void {
  const { input } = exportPlasma({ ...PLASMA_EXPORT_SCENARIOS['single-outline'](), machineId: 'grbl' })
  const mill = { ...defaultTool('mm'), id: 'mill', name: 'Mill' }
  const withMill = { ...input.project, tools: [...input.project.tools, mill] }
  const millEntry = (id: string): PostProcessorInput['operations'][number] => {
    const milling = {
      ...defaultOperationForTarget(withMill, 'pocket', 'rough', { source: 'features', featureIds: ['plate'] }, 0),
      id, name: id, toolRef: 'mill',
    }
    return {
      operation: milling,
      tool: normalizeToolForProject(mill, withMill),
      toolpath: { operationId: id, moves: [{ kind: 'cut', from: { x: 0, y: 0, z: 0 }, to: { x: 5, y: 5, z: 0 } }], warnings: [], bounds: null },
    }
  }
  const [cut] = input.operations
  const handedIn = [millEntry('mill-1'), cut, millEntry('mill-2')]
  const result = runPostProcessor({
    ...input,
    project: withMill,
    operations: handedIn,
    options: { ...input.options, captureMotionTrace: true },
  })
  const emitted = emittedOperationIds(result, 'plasma-on-grbl')
  assert.deepEqual(emitted, ['mill-1', 'mill-2'], 'the skipped plasma cut is not among the emitted operations')

  const operations = handedIn.map((entry) => entry.operation)
  const omitted = omittedOperations(
    { ...withMill, operations },
    operations.map((entry) => option(entry, true)),
    emitted,
  )
  assert.deepEqual(omitted.map(({ id, reason }) => ({ id, reason })), [
    { id: cut.operation.id, reason: 'not-posted' },
  ], 'and the check reports it as not posted')

  assert.throws(() => emittedOperationIds({}, 'no-traces'), /no motion traces/,
    'a result without traces is an error, not full coverage')
}

// ── the CLI still parses as documented ───────────────────────────────────────

function testParseArguments(): void {
  const before = parseArguments(['before'])
  assert.equal(before.label, 'before')
  assert.ok(before.examplesDir.endsWith('/public/examples'))
  const copied = parseArguments(['after', '--examples-dir', 'work/old-examples'])
  assert.equal(copied.label, 'after')
  assert.ok(copied.examplesDir.endsWith('/work/old-examples'))
  assert.throws(() => parseArguments(['sideways']), /usage:/)
  assert.throws(() => parseArguments(['after', '--examples-dir']), /needs a directory/)
}

testAnnouncesPortReadsVitesReadyLine()
await testForeignServerCannotAnswerForUs()
await testAnswerWithoutOurAnnouncementIsNotReady()
await testOurOwnAnnouncedServerIsReady()
testDisabledAndToolLessOperationsAreReported()
testProjectTypeHiddenOperationIsReported()
testExportableButUnpostedOperationIsReported()
testFullyPostedProjectHasNoOmissions()
testPostprocessorSkippedOperationIsReported()
testParseArguments()

console.log('resave-examples tests: OK')
