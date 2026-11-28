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

/// <reference types="node" />

/**
 * The Verify mode's request (issue #1269): the comparison list, which
 * operations a run covers, and when a result is stale.
 *
 * Run with: npx tsx src/app/verify/verifyRequest.test.ts
 */

import { defaultTool, newProject, type Operation, type Project } from '../../types/project'
import {
  comparisonUsesExport,
  comparisonUsesModel,
  VERIFY_COMPARISONS,
  verifyOperations,
  verifyStaleness,
  verifyUptoOperationId,
  type VerifyRequest,
} from './verifyRequest'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

function op(id: string, overrides: Partial<Operation> = {}): Operation {
  return {
    id, name: id, kind: 'pocket', pass: 'rough', enabled: true, showToolpath: true, debugToolpath: false,
    target: { source: 'stock' }, toolRef: 't1', stepdown: 1, stepover: 0.4, feed: 600, plungeFeed: 180, rpm: 12000,
    pocketPattern: 'offset', pocketAngle: 0, stockToLeaveRadial: 0, stockToLeaveAxial: 0,
    finishWalls: false, finishFloor: false, carveDepth: 0, maxCarveDepth: 0,
    ...overrides,
  }
}

function project(): Project {
  const base = newProject('Verify request', 'mm')
  return {
    ...base,
    tools: [defaultTool('mm', 1)],
    operations: [op('a'), op('hidden', { showToolpath: false }), op('off', { enabled: false }), op('b'), op('c')],
  }
}

function testComparisons(): void {
  console.log('Testing the comparison list...')
  assert(VERIFY_COMPARISONS.join() === 'modelInternal,modelExported,internalExported', 'three comparisons, in selector order')
  assert(!comparisonUsesExport('modelInternal') && comparisonUsesExport('modelExported') && comparisonUsesExport('internalExported'), 'which comparisons post the program')
  assert(comparisonUsesModel('modelInternal') && comparisonUsesModel('modelExported') && !comparisonUsesModel('internalExported'), 'which comparisons need the model')
}

function testCoveredOperations(): void {
  console.log('Testing a run covers the visible operations up to the selection...')
  const p = project()
  const ids = (selected: string | null) => verifyOperations(p, p.operations, selected).map((operation) => operation.id).join()
  assert(ids('b') === 'a,b', `up to b: a and b, got ${ids('b')}`)
  assert(ids(null) === 'a,b,c', `no selection: every visible operation, got ${ids(null)}`)
  assert(ids('hidden') === 'a,hidden', `a hidden selection is still verified, got ${ids('hidden')}`)
  assert(ids('off') === 'a', `a disabled selection is not, got ${ids('off')}`)
  assert(ids('elsewhere') === 'a,b,c', 'a selection outside the setup covers the whole setup')
  assert(verifyUptoOperationId(p.operations, 'b') === 'b', 'the selection names the run')
  assert(verifyUptoOperationId(p.operations, 'elsewhere') === null, 'another setup\'s selection does not')
  assert(verifyUptoOperationId(p.operations, null) === null, 'no selection names nothing')
}

function testStaleness(): void {
  console.log('Testing a result goes stale on an edit or another request, never by itself...')
  const p = project()
  const ran: VerifyRequest = { project: p, setupId: 's', comparison: 'modelInternal', uptoOperationId: 'b', detailCells: 280 }
  assert(verifyStaleness(ran, { ...ran }) === 'current', 'the same request is current')
  assert(verifyStaleness(ran, { ...ran, project: { ...p } }) === 'projectEdited', 'an edited project is stale')
  assert(verifyStaleness(ran, { ...ran, comparison: 'internalExported' }) === 'requestChanged', 'another comparison')
  assert(verifyStaleness(ran, { ...ran, uptoOperationId: 'c' }) === 'requestChanged', 'another operation')
  assert(verifyStaleness(ran, { ...ran, setupId: 't' }) === 'requestChanged', 'another setup')
  assert(verifyStaleness(ran, { ...ran, detailCells: 400 }) === 'requestChanged', 'another detail')
  assert(verifyStaleness(ran, { ...ran, project: { ...p }, detailCells: 400 }) === 'projectEdited', 'an edit outranks a request change')
}

testComparisons()
testCoveredOperations()
testStaleness()
console.log('verifyRequest tests passed')
