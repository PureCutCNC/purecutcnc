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

import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ToolpathResult } from '../../engine/toolpaths/types'
import { defaultOperationForTarget } from '../../store/helpers/operationDefaults'
import { newProject } from '../../types/project'
import { bookletFileName, runBookletExport, type BookletExportSteps } from './bookletExport'

const toolpath: ToolpathResult = { operationId: 'op', moves: [], warnings: [], bounds: null }

/** Steps that log every call, in order, next to the stage announcements. */
function loggingSteps(log: string[], overrides: Partial<BookletExportSteps> = {}): BookletExportSteps {
  return {
    requestToolpath: async () => { log.push('requestToolpath'); return toolpath },
    normalizeTool: () => { log.push('normalizeTool'); return null },
    renderSnapshot: async () => { log.push('renderSnapshot'); return new Uint8Array([1]) },
    buildPdf: async () => { log.push('buildPdf'); return new Uint8Array([2]) },
    save: async () => { log.push('save'); return 'out.pdf' },
    yieldToPaint: async () => { log.push('paint') },
    ...overrides,
  }
}

test('each stage is announced before its step, and blocking steps wait for a paint first', async () => {
  const log: string[] = []
  const outcome = await runBookletExport(loggingSteps(log), (stage) => log.push(`stage:${stage}`))
  assert.deepEqual(outcome, { status: 'exported', path: 'out.pdf' })
  assert.deepEqual(log, [
    'stage:toolpath', 'requestToolpath',
    'stage:snapshot', 'paint', 'renderSnapshot',
    'stage:pdf', 'paint', 'normalizeTool', 'buildPdf',
    'stage:saving', 'save',
  ])
})

test('no toolpath stops the export before any drawing', async () => {
  const log: string[] = []
  const outcome = await runBookletExport(
    loggingSteps(log, { requestToolpath: async () => { log.push('requestToolpath'); return null } }),
    (stage) => log.push(`stage:${stage}`),
  )
  assert.deepEqual(outcome, { status: 'noToolpath' })
  assert.deepEqual(log, ['stage:toolpath', 'requestToolpath'])
})

test('a dismissed save dialog reports a cancelled export', async () => {
  const outcome = await runBookletExport(loggingSteps([], { save: async () => null }), () => undefined)
  assert.deepEqual(outcome, { status: 'cancelled' })
})

test('the file name keeps only safe characters, with fallbacks for empty names', () => {
  const project = newProject(' LP carved/top! ', 'inch')
  const operation = { ...defaultOperationForTarget(project, 'pocket', 'rough', { source: 'stock' }, 0), name: '3D surface: finish' }
  assert.equal(bookletFileName(project, operation), 'LP_carved_top_3D_surface_finish_booklet')
  assert.equal(bookletFileName(newProject('!!!', 'inch'), { ...operation, name: ' ' }), 'project_operation_booklet')
})
