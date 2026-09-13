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
 * Generation parity: the extracted pipeline against the pre-extraction one
 * (issue #675, slice 1 — the first gate).
 *
 * `computeOperationToolpath` was moved out of `useToolpathGeneration` so a
 * worker could call the same code the main thread does. The whole point of the
 * move is that it changes nothing, and this suite is what makes that a fact
 * rather than an intention. It replays the corpus through the extracted
 * function and compares against `__baseline__/issue-675-parity.json`, which was
 * captured by rendering the genuine pre-extraction hook — see
 * `scripts/issue-675/capture-baseline.ts`.
 *
 * **The expected values are never regenerated from this implementation.** A
 * failure here means the extraction moved output; recapturing the baseline to
 * make it pass would delete the only evidence that it did not.
 *
 * Once slice 2's worker executor exists, the same corpus and the same goldens
 * are what the worker is checked against, so a worker that disagrees with the
 * main thread also fails here.
 *
 * ## What this gate does and does not cover
 *
 * The corpus was built by mutation, not by inspection: each per-kind chain was
 * deliberately broken and a case added until the break failed the suite.
 * Swapping a generator, dropping a tab stage from any branch, moving the raw
 * capture seam, skipping the optimizer, double-tabbing a trochoidal route, and
 * losing clamp collision data are all caught.
 *
 * One class is not, and it is a property of the code rather than a hole to
 * plug. Since #458 the strategies avoid clamps *during* generation, so by the
 * time `applyClampWarnings` runs there is nothing left inside the keep-out to
 * report — `collidingClampIds` and `collidingMoveIndices` come back empty for
 * every clamp placement tried, including clamps covering the entire toolpath.
 * On those branches removing the clamp stage is invisible here because it is
 * invisible in the product too. The one case that still exercises it is
 * `synthetic/edge_route_clamp_collision`, where a tab constrains the orbits
 * enough that avoidance cannot route clear.
 */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { computeOperationToolpath } from './generateOperation'
import { buildParityCorpus, postParityCase } from './parityCorpus'
import { canonicalize, summarize, type ParityRecord } from './parityRecord'

interface Baseline {
  baseSha: string
  cases: Record<string, ParityRecord>
}

const baseline = JSON.parse(
  readFileSync(new URL('./__baseline__/issue-675-parity.json', import.meta.url), 'utf8'),
) as Baseline

/**
 * Cases whose *output* was re-recorded after the baseline was captured, with
 * the reason and the hashes it replaced (issue #706).
 *
 * This grants nothing. The baseline still holds the expected values, so these
 * cases detect drift exactly as tightly as every other one — that is the
 * difference between re-recording and exempting them. The record exists so a
 * re-record shows up in review as a named decision rather than two silent
 * string edits in a JSON file, and so reverting the change it describes is
 * visible here as the record going stale.
 *
 * #706 is a rounded pocket finish whose island rings were cut in the pocket
 * wall's rotational sense: `buildExpandedIslandContours` offset every island
 * from an outer-wound copy — a hole-wound path would shrink instead of
 * expanding — and never restored hole winding afterwards, so the direction
 * pass read the rings as wall. Measured against the unpatched tree before
 * re-recording: on `fixture/pocket-finish-island-leftover/op0011` 40 of 3844
 * cut segments moved, and every one of them sits 0.062–0.075 units from the
 * island wall (island bbox [1.25, 0.875]–[2.625, 2.0]); on
 * `example/purecutcnc/op0017` no cut segment moved at all, only their order.
 * Every summary counter is unchanged in both. The behavioural guard is
 * `pocketFinishIslandDirection.test.ts`.
 *
 * The two `example/t-style-body` pocket cases are #754. The example dropped
 * `Circle 2` and `Circle 3` — two 3/32" subtract holes no operation machined,
 * and the only non-target subtracts reaching below a pocket floor — so the fold
 * #526 added, and the band it created, are gone. Measured against the pre-#754
 * engine at 46f232d over the same edited example: 21968 and 366 moves with
 * byte-identical counters and no warnings, so the engine change, which only
 * collapses duplicated advisories, contributed nothing to the move. The other
 * five t-style cases and every other case in the corpus are untouched.
 */
const RECORDED_AFTER_BASELINE: ReadonlyMap<
  string,
  { issue: number; replaced: { resultHash: string; rawHash: string; gcodeHash: string } }
> = new Map([
  [
    'fixture/pocket-finish-island-leftover/op0011',
    {
      issue: 706,
      replaced: {
        resultHash: 'ff042b7ec1b71552719d4937fb11c4582e3b7dbacdc9f7483ea0adbb0365dc2c',
        rawHash: '9ab4635b1662083547550fae266ac8281d4ad158281ade3af9c51c6a827f6ada',
        gcodeHash: '88c2bc84f7aef6811ded9bdf69aa149a6541984a8145277b1c14c54cb0a09f0d',
      },
    },
  ],
  [
    'example/purecutcnc/op0017',
    {
      issue: 706,
      replaced: {
        resultHash: '16da807a3ba7fe0457e42f8f8d9c05bf0a5bd7b7c128a505b0cb79073602bafe',
        rawHash: '2077674315e9037c8d4963d8df70c0107a1989fd736d5ed169cb1d0840d1b3ca',
        gcodeHash: 'b38f9c8c54ebb33852deb2a9039ccb55ec0de9882d3beb3b6e0a41bb9cfd0a1a',
      },
    },
  ],
  [
    'example/t-style-body/op0160',
    {
      issue: 754,
      replaced: {
        resultHash: 'd33413ae3a097387550d952326a5607fbec7c7f3c06e1d2cd9e8480673141fc9',
        rawHash: 'ea50016e7c88a0b66e0da60671623d3029d016d45bb2ab56a9048794650a0df9',
        gcodeHash: 'f79311f27e8bbd85406942abcdcc057ad4af51d2115deb83098a7c957c43523d',
      },
    },
  ],
  [
    'example/t-style-body/op0161',
    {
      issue: 754,
      replaced: {
        resultHash: '81bcd1d8afdf0f3165cba7dfe2fb088fb6c3ff62cb26c36a11b8bf4136343da5',
        rawHash: '81bcd1d8afdf0f3165cba7dfe2fb088fb6c3ff62cb26c36a11b8bf4136343da5',
        gcodeHash: 'd0b15fb707ad906d80bd2d589df2260262ade765a1a3e6fd34af4aa67654dbc0',
      },
    },
  ],
])

let passed = 0
let failed = 0

function check(name: string, condition: boolean, detail: string): void {
  if (condition) {
    passed += 1
    return
  }
  failed += 1
  console.log(`   ✗ ${name}: ${detail}`)
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

console.log(`\nGeneration parity against baseline captured at ${baseline.baseSha}`)

const corpus = buildParityCorpus()

// A silently shrinking corpus would turn this suite green by testing nothing.
check(
  'corpus/coverage',
  corpus.length === Object.keys(baseline.cases).length,
  `corpus has ${corpus.length} cases, baseline has ${Object.keys(baseline.cases).length}`,
)
// A record that has stopped matching the baseline is stale: either the case
// moved a second time and needs its own reason, or the change it recorded was
// reverted.
for (const [id, record] of RECORDED_AFTER_BASELINE) {
  const current = baseline.cases[id]
  check(
    id + ' re-record is current',
    current !== undefined
      && current.resultHash !== record.replaced.resultHash
      && current.rawHash !== record.replaced.rawHash
      && current.gcodeHash !== record.replaced.gcodeHash,
    'the baseline still holds the hashes this record replaced for #' + record.issue
    + ' — was it reverted, or has the case moved again?',
  )
}

for (const parityCase of corpus) {
  const expected = baseline.cases[parityCase.id]
  if (!expected) {
    check(parityCase.id, false, 'no baseline record — recapture from a pre-extraction checkout, not from this one')
    continue
  }

  const operation = parityCase.project.operations.find((op) => op.id === parityCase.operationId)
  if (!operation) {
    check(parityCase.id, false, `operation ${parityCase.operationId} missing from project`)
    continue
  }

  const envelope = computeOperationToolpath(parityCase.project, operation, { trace: true })
  if (!envelope || !envelope.raw) {
    check(parityCase.id, false, 'generation returned no envelope')
    continue
  }

  const gcode = postParityCase(parityCase.project, operation, envelope.result)
  const actual: ParityRecord = {
    resultHash: sha256(canonicalize(envelope.result)),
    rawHash: sha256(canonicalize(envelope.raw)),
    gcodeHash: sha256(gcode),
    ...summarize(envelope.result, envelope.raw, gcode),
  }

  // The hashes are the assertion; the summary fields are reported alongside so
  // a mismatch says what moved instead of only that something did.
  const drift: string[] = []
  if (actual.moves !== expected.moves) drift.push(`moves ${expected.moves}→${actual.moves}`)
  if (actual.rawMoves !== expected.rawMoves) drift.push(`rawMoves ${expected.rawMoves}→${actual.rawMoves}`)
  if (actual.gcodeLines !== expected.gcodeLines) drift.push(`gcodeLines ${expected.gcodeLines}→${actual.gcodeLines}`)
  if (actual.bounds !== expected.bounds) drift.push(`bounds ${expected.bounds}→${actual.bounds}`)
  if (actual.warnings.join(',') !== expected.warnings.join(',')) {
    drift.push(`warnings [${expected.warnings.join(',')}]→[${actual.warnings.join(',')}]`)
  }
  if (actual.drillCycles !== expected.drillCycles) drift.push(`drillCycles ${expected.drillCycles}→${actual.drillCycles}`)
  if (actual.collidingClampIds.join(',') !== expected.collidingClampIds.join(',')) {
    drift.push(`collidingClampIds [${expected.collidingClampIds.join(',')}]→[${actual.collidingClampIds.join(',')}]`)
  }
  if (actual.collidingMoveIndices !== expected.collidingMoveIndices) {
    drift.push(`collidingMoveIndices ${expected.collidingMoveIndices}→${actual.collidingMoveIndices}`)
  }
  const context = drift.length > 0 ? ` (${drift.join('; ')})` : ' (summary fields all match — a value moved below the summary)'

  check(`${parityCase.id} result`, actual.resultHash === expected.resultHash, `full result differs${context}`)
  check(`${parityCase.id} raw`, actual.rawHash === expected.rawHash, `pre-optimization result differs${context}`)
  check(`${parityCase.id} gcode`, actual.gcodeHash === expected.gcodeHash, `posted G-code differs${context}`)
}

// Raw capture is opt-in. An ordinary request must not carry a second full path,
// or every worker message would transport one to be discarded.
const sample = corpus[0]
const sampleOperation = sample.project.operations.find((op) => op.id === sample.operationId)!
check(
  'trace/opt-in',
  computeOperationToolpath(sample.project, sampleOperation)?.raw === null,
  'a request without trace still returned a raw path',
)

console.log(`\n${passed} passed, ${failed} failed`)

if (failed > 0) {
  process.exit(1)
}
