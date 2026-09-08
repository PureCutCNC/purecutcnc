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
 * The service seam preserves output (issue #675).
 *
 * `generateOperationParity` proves the extracted engine function matches the
 * pre-extraction pipeline. This proves the layers *above* it — executor, queue,
 * cache, commit rules — hand back exactly what that function produced, so a
 * result cannot be altered on its way through the machinery that schedules it.
 *
 * Run through the real service against the same goldens, one operation per
 * kind: the heavy fixtures add minutes and nothing this suite is asking about,
 * since the corpus test already replays all of them.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { buildParityCorpus, postParityCase } from '../../engine/toolpaths/parityCorpus'
import { canonicalize, type ParityRecord } from '../../engine/toolpaths/parityRecord'
import { createToolpathGenerationService } from './service'
import { resolveOperation } from './protocol'

interface Baseline {
  baseSha: string
  cases: Record<string, ParityRecord>
}

const baseline = JSON.parse(
  readFileSync(new URL('../../engine/toolpaths/__baseline__/issue-675-parity.json', import.meta.url), 'utf8'),
) as Baseline

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) { passed += 1; return }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

async function main(): Promise<void> {
  console.log(`\nInline executor parity through the service (baseline ${baseline.baseSha})`)

  const corpus = buildParityCorpus()
  const byKind = new Map<string, typeof corpus[number]>()
  for (const parityCase of corpus) {
    const operation = resolveOperation(parityCase.project, parityCase.operationId)
    if (operation && !byKind.has(operation.kind)) byKind.set(operation.kind, parityCase)
  }

  for (const [kind, parityCase] of byKind) {
    const expected = baseline.cases[parityCase.id]
    const operation = resolveOperation(parityCase.project, parityCase.operationId)!
    const context = { project: parityCase.project, documentKey: 1 }
    const service = createToolpathGenerationService({ getCurrentContext: () => context, executor: 'inline' })

    const outcome = await service.request(context, parityCase.operationId, { purpose: 'export', trace: true })
    if (outcome.status !== 'completed') {
      check(`${kind}`, false, `expected completed, got ${outcome.status}`)
      service.dispose()
      continue
    }

    check(
      `${kind} result`,
      sha256(canonicalize(outcome.result)) === expected.resultHash,
      'the service returned a different result from the baseline',
    )
    check(
      `${kind} raw`,
      outcome.raw !== null && sha256(canonicalize(outcome.raw)) === expected.rawHash,
      'the service returned a different raw trace from the baseline',
    )
    check(
      `${kind} gcode`,
      sha256(postParityCase(parityCase.project, operation, outcome.result)) === expected.gcodeHash,
      'the posted G-code differs from the baseline',
    )

    // A second request must come back from the cache and be the same object —
    // if the cache handed back a copy, an identity-keyed consumer downstream
    // would see a change that never happened.
    const again = await service.request(context, parityCase.operationId, { purpose: 'preview' })
    check(
      `${kind} cache identity`,
      again.status === 'completed' && again.result === outcome.result,
      'a cache hit returned a different object',
    )
    check(
      `${kind} peekCurrent`,
      service.peekCurrent(context, parityCase.operationId) === outcome.result,
      'peekCurrent disagrees with the installed result',
    )

    service.dispose()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
