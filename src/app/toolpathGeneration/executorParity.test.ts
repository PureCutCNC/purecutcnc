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
 * This compares a direct engine call to the layers *above* it — executor, queue,
 * cache, commit rules — hand back exactly what that function produced, so a
 * result cannot be altered on its way through the machinery that schedules it.
 *
 * Run through the real service against a live engine result, one operation per
 * kind plus the strategy variants with an implementation seam: the heavy
 * fixtures add minutes and nothing this suite is asking about, since the corpus
 * test already replays all of them.
 */

import { createHash } from 'node:crypto'
import { computeOperationToolpath } from '../../engine/toolpaths/generateOperation'
import { buildParityCorpus, parityCoverageKey, postParityCase } from '../../engine/toolpaths/parityCorpus'
import { canonicalize } from '../../engine/toolpaths/parityRecord'
import { createToolpathGenerationService } from './service'
import { resolveOperation } from './protocol'

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) { passed += 1; return }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

const sha256 = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex')

async function main(): Promise<void> {
  console.log('\nInline executor parity through the service (live engine result)')

  const corpus = buildParityCorpus()
  const byCoverage = new Map<string, typeof corpus[number]>()
  for (const parityCase of corpus) {
    const operation = resolveOperation(parityCase.project, parityCase.operationId)
    if (operation && !byCoverage.has(parityCoverageKey(operation))) {
      byCoverage.set(parityCoverageKey(operation), parityCase)
    }
  }

  for (const [coverage, parityCase] of byCoverage) {
    const operation = resolveOperation(parityCase.project, parityCase.operationId)!
    const expected = computeOperationToolpath(parityCase.project, operation, { trace: true })
    if (!expected || !expected.raw) {
      check(`${coverage} direct engine`, false, 'expected a traced engine result')
      continue
    }
    const context = { project: parityCase.project, documentKey: 1 }
    const service = createToolpathGenerationService({ getCurrentContext: () => context, executor: 'inline' })

    const outcome = await service.request(context, parityCase.operationId, { purpose: 'export', trace: true })
    if (outcome.status !== 'completed') {
      check(`${coverage}`, false, `expected completed, got ${outcome.status}`)
      service.dispose()
      continue
    }

    check(
      `${coverage} result`,
      sha256(canonicalize(outcome.result)) === sha256(canonicalize(expected.result)),
      'the service altered the engine result',
    )
    check(
      `${coverage} raw`,
      outcome.raw !== null && sha256(canonicalize(outcome.raw)) === sha256(canonicalize(expected.raw)),
      'the service altered the engine raw trace',
    )
    check(
      `${coverage} gcode`,
      sha256(postParityCase(parityCase.project, operation, outcome.result))
        === sha256(postParityCase(parityCase.project, operation, expected.result)),
      'the service result posts differently from the engine result',
    )

    // A second request must come back from the cache and be the same object —
    // if the cache handed back a copy, an identity-keyed consumer downstream
    // would see a change that never happened.
    const again = await service.request(context, parityCase.operationId, { purpose: 'preview' })
    check(
      `${coverage} cache identity`,
      again.status === 'completed' && again.result === outcome.result,
      'a cache hit returned a different object',
    )
    check(
      `${coverage} peekCurrent`,
      service.peekCurrent(context, parityCase.operationId) === outcome.result,
      'peekCurrent disagrees with the installed result',
    )

    service.dispose()
  }

  console.log(`\n${passed} passed, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

void main()
