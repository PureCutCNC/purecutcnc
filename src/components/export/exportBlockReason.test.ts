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
 * Blocked-export messages (issue #755).
 *
 * A blocked preparation used to disable the Export button and say nothing,
 * which reads as a bug rather than a refusal. This holds the mapping to
 * account: every operation-level reason names its operation, the two the
 * dialog reports from live state stay silent, and `stale` has a message even
 * though nothing produces it yet.
 */

import { exportBlockReasonMessage } from './exportBlockReason'
import type { ExportBlockReason } from '../../app/toolpathGeneration/exportPreparation'

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Assertion failed: ${message}`)
}

const NAMES: Record<string, string> = { a: 'Route A', b: 'Route B' }
const nameOf = (operationId: string): string | null => NAMES[operationId] ?? null

// The engine's failure message rides along as detail, the way the generation
// menu already shows it.
const failed = exportBlockReasonMessage(
  { kind: 'generation-failed', operationId: 'b', message: 'bad geometry' },
  nameOf,
)
assert(failed?.key === 'dialogs.export.error.generationFailed', 'a failure uses the failure message')
assert(failed?.params?.operation === 'Route B', 'the failure names the operation')
assert(failed?.params?.detail === 'bad geometry', 'the engine message rides along as detail')

// Cancellation and supersession are different engine outcomes with the same
// recovery, so the operator reads one message rather than two.
for (const kind of ['generation-cancelled', 'generation-superseded'] as const) {
  const interrupted = exportBlockReasonMessage({ kind, operationId: 'a' }, nameOf)
  assert(interrupted?.key === 'dialogs.export.error.generationInterrupted', `${kind} uses the interrupted message`)
  assert(interrupted?.params?.operation === 'Route A', `${kind} names the operation`)
}

const missingTool = exportBlockReasonMessage({ kind: 'missing-tool', operationId: 'a' }, nameOf)
assert(missingTool?.key === 'dialogs.export.error.missingTool', 'a missing tool uses the missing-tool message')
assert(missingTool?.params?.operation === 'Route A', 'the missing tool names the operation')

// The operation can be deleted while generation is in flight; naming the id is
// worse than naming the operation, but far better than naming nothing.
const orphan = exportBlockReasonMessage({ kind: 'missing-tool', operationId: 'gone' }, nameOf)
assert(orphan?.params?.operation === 'gone', 'an unresolvable id falls back to the id')

// Nothing produces this today. It still gets a message: an exhaustive mapping
// with a silent hole is how a blocked export goes back to explaining nothing.
const stale = exportBlockReasonMessage({ kind: 'stale' }, nameOf)
assert(stale?.key === 'dialogs.export.error.stale', 'stale has a message')
assert(stale?.params === undefined, 'stale names no operation')

// Reported by the dialog from live state, without waiting for the debounce.
const liveStateReasons: readonly ExportBlockReason[] = [{ kind: 'no-machine' }, { kind: 'no-operations' }]
for (const reason of liveStateReasons) {
  assert(exportBlockReasonMessage(reason, nameOf) === null, `${reason.kind} is reported from live state`)
}

console.log('export block reason tests passed')
